// AgentRunner for OpenAI and OpenAI-compatible Chat Completions APIs (OpenRouter, vLLM, Ollama, …)
// (specs/10-model-providers.md R9.2–R9.7). The factory runs the agent loop itself: model calls
// happen in this process (keys never enter a sandbox) and tools run in the sandbox.
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProviderConfig } from "../config.js";
import { toJsonSchema } from "../contracts/index.js";
import { firstLine, renderPrompt, summarizeToolInput } from "./claude-runner.js";
import {
  AgentFailed,
  AgentTimeout,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRunner,
} from "./runner.js";
import { IMPLEMENTED_TOOLS, runTool, ToolError, toolDefinitions } from "./tools.js";

export const SUBMIT_TOOL = "submit_result";
export const DEFAULT_MAX_TURNS = 50;

export interface OpenAICompatOptions {
  /** Provider name from config (used in messages). */
  name: string;
  provider: ProviderConfig;
  /** Defaults to process.env[provider.apiKeyEnv]. */
  apiKey?: string;
  fetchFn?: typeof fetch;
  /** Extra env var names stripped from the Bash tool's environment. */
  secretEnvs?: readonly string[];
  maxRetries?: number;
  retryBaseMs?: number;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
interface ChatResponse {
  choices?: { message?: ChatMessage; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string };
}

const TOOL_GUIDE = `

## How to work in this environment

You are running as a non-interactive agent. Use the provided tools to inspect and change the
repository; paths are relative to the repository root. Nobody will answer questions mid-task.
When you are finished, call the \`${SUBMIT_TOOL}\` tool exactly once with your final result. Its
arguments are your structured output and must match its schema. Do not reply with plain text
instead of calling a tool.`;

const EFFORT: Record<AgentRunRequest<unknown>["effort"], "low" | "medium" | "high"> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((res) => {
    const t = setTimeout(res, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), res()), { once: true });
  });

export class OpenAICompatRunner implements AgentRunner {
  constructor(private readonly opts: OpenAICompatOptions) {}

  async run<T>(req: AgentRunRequest<T>): Promise<AgentRunResult<T>> {
    const started = Date.now();
    const { provider, name } = this.opts;
    const abort = new AbortController();
    let timedOut = false;
    const timer = req.timeoutSec
      ? setTimeout(() => {
          timedOut = true;
          abort.abort();
        }, req.timeoutSec * 1000)
      : undefined;
    if (req.signal?.aborted) throw new AgentFailed(`${req.stage} cancelled before start`);
    const onCancel = () => abort.abort();
    req.signal?.addEventListener("abort", onCancel, { once: true });

    let transcript: NodeJS.WritableStream | undefined;
    if (req.transcriptPath) {
      await mkdir(dirname(req.transcriptPath), { recursive: true });
      transcript = createWriteStream(req.transcriptPath, { flags: "a" });
    }
    const log = (entry: unknown) => transcript?.write(JSON.stringify(entry) + "\n");

    let costUsd = 0;
    const usage = { input: 0, output: 0 };
    const stopped = () =>
      timedOut
        ? new AgentTimeout(`${req.stage} exceeded ${req.timeoutSec}s`, costUsd)
        : new AgentFailed(`${req.stage} cancelled`, costUsd);

    // Function parameters must be an object; wrap any other root schema.
    const schema = toJsonSchema(req.outputSchema);
    const wrapped = schema.type !== "object";
    const tools = req.tools.filter((t) => IMPLEMENTED_TOOLS.includes(t));
    const body: Record<string, unknown> = {
      model: req.model,
      tools: [
        ...toolDefinitions(tools),
        {
          type: "function",
          function: {
            name: SUBMIT_TOOL,
            description: "Submit your final structured result. Call exactly once, when done.",
            parameters: wrapped
              ? { type: "object", properties: { result: schema }, required: ["result"] }
              : schema,
          },
        },
      ],
      tool_choice: "auto",
    };
    if (provider.reasoningStyle === "openai") body.reasoning_effort = EFFORT[req.effort];
    if (provider.reasoningStyle === "openrouter") body.reasoning = { effort: EFFORT[req.effort] };
    if (provider.usageCost) body.usage = { include: true };

    const messages: ChatMessage[] = [
      { role: "system", content: req.playbook + TOOL_GUIDE },
      { role: "user", content: renderPrompt(req.input) },
    ];
    log({ type: "request", provider: name, model: req.model, tools: tools, messages });

    const maxTurns = req.maxTurns ?? DEFAULT_MAX_TURNS;
    try {
      for (let turn = 0; turn < maxTurns; turn++) {
        if (abort.signal.aborted) throw stopped();
        let res: ChatResponse;
        try {
          res = await this.chat({ ...body, messages }, abort.signal);
        } catch (e) {
          if (abort.signal.aborted) throw stopped();
          throw new AgentFailed(
            `${req.stage} model call to ${name} failed: ${(e as Error).message}`,
            costUsd,
          );
        }
        usage.input += res.usage?.prompt_tokens ?? 0;
        usage.output += res.usage?.completion_tokens ?? 0;
        costUsd += this.cost(req.model, res.usage);
        log({ type: "response", turn, response: res, costUsd });

        const msg = res.choices?.[0]?.message;
        if (!msg) throw new AgentFailed(`${req.stage}: ${name} returned no message`, costUsd);
        const calls = msg.tool_calls ?? [];
        messages.push({
          role: "assistant",
          content: msg.content ?? null,
          ...(calls.length ? { tool_calls: calls } : {}),
        });
        if (msg.content?.trim()) req.onActivity?.({ kind: "text", detail: firstLine(msg.content, 200) });

        if (req.maxBudgetUsd !== undefined && costUsd > req.maxBudgetUsd) {
          throw new AgentFailed(
            `${req.stage} exceeded its budget ($${costUsd.toFixed(4)} > $${req.maxBudgetUsd})`,
            costUsd,
          );
        }

        if (!calls.length) {
          messages.push({
            role: "user",
            content: `Continue using the tools. When you are done, call ${SUBMIT_TOOL} with your result.`,
          });
          continue;
        }

        for (const call of calls) {
          const toolName = call.function.name;
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
          } catch {
            this.reply(messages, call, `Error: arguments are not valid JSON.`);
            req.onActivity?.({
              kind: "result",
              detail: `${toolName}: invalid JSON arguments`,
              isError: true,
            });
            continue;
          }

          if (toolName === SUBMIT_TOOL) {
            req.onActivity?.({ kind: "tool", tool: "Submit", detail: "structured result" });
            const parsed = req.outputSchema.safeParse(wrapped ? args.result : args);
            if (parsed.success) {
              log({ type: "result", output: parsed.data, costUsd, usage });
              return {
                output: parsed.data,
                usage,
                costUsd,
                durationMs: Date.now() - started,
                transcriptPath: req.transcriptPath,
              };
            }
            const errors = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
            this.reply(
              messages,
              call,
              `Error: the result does not match the schema:\n${errors.join("\n")}\nFix it and call ${SUBMIT_TOOL} again.`,
            );
            req.onActivity?.({ kind: "result", detail: `result rejected: ${errors[0]}`, isError: true });
            continue;
          }

          req.onActivity?.({
            kind: "tool",
            tool: toolName,
            detail: summarizeToolInput(toolName, args, req.cwd),
          });
          if (!tools.includes(toolName as never)) {
            this.reply(messages, call, `Error: tool ${toolName} is not available in this stage.`);
            req.onActivity?.({ kind: "result", detail: `${toolName} is not allowed`, isError: true });
            continue;
          }
          try {
            const out = await runTool(toolName, args, {
              cwd: req.cwd,
              runtime: req.runtime,
              secretEnvs: this.opts.secretEnvs,
            });
            this.reply(messages, call, out);
          } catch (e) {
            const message = e instanceof ToolError ? e.message : `Tool failed: ${(e as Error).message}`;
            this.reply(messages, call, `Error: ${message}`);
            req.onActivity?.({ kind: "result", detail: firstLine(message), isError: true });
          }
          if (abort.signal.aborted) throw stopped();
        }
      }
      throw new AgentFailed(
        `${req.stage} agent stopped (error_max_turns): no result after ${maxTurns} turns`,
        costUsd,
      );
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onCancel);
      transcript?.end();
    }
  }

  private reply(messages: ChatMessage[], call: ToolCall, content: string) {
    messages.push({ role: "tool", tool_call_id: call.id, content });
  }

  /** R9.5: provider-reported cost when present, else configured pricing, else 0 (allowUnpriced). */
  private cost(model: string, u: ChatResponse["usage"]): number {
    if (!u) return 0;
    if (typeof u.cost === "number") return u.cost;
    const p = this.opts.provider.pricing[model];
    if (!p) return 0;
    return ((u.prompt_tokens ?? 0) * p.inputPerMTok + (u.completion_tokens ?? 0) * p.outputPerMTok) / 1e6;
  }

  /** One Chat Completions request with retries on 429 / 5xx / network errors (R9.6). */
  private async chat(body: unknown, signal: AbortSignal): Promise<ChatResponse> {
    const { provider, name } = this.opts;
    const fetchFn = this.opts.fetchFn ?? fetch;
    const apiKey = this.opts.apiKey ?? (provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined);
    const maxRetries = this.opts.maxRetries ?? 4;
    const base = this.opts.retryBaseMs ?? 1000;
    const url = `${provider.baseUrl!.replace(/\/+$/, "")}/chat/completions`;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetchFn(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
            ...provider.headers,
          },
          body: JSON.stringify(body),
          signal,
        });
        const text = await res.text();
        let json: ChatResponse = {};
        try {
          json = JSON.parse(text) as ChatResponse;
        } catch {
          // non-JSON error body
        }
        if (res.ok && !json.error) return json;
        const detail = json.error?.message ?? (text.slice(0, 300) || res.statusText);
        const retryAfter = Number(res.headers.get("retry-after"));
        throw new HttpError(
          res.ok ? 502 : res.status,
          `${name} API ${res.ok ? "error" : `HTTP ${res.status}`}: ${detail}`,
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
        );
      } catch (e) {
        if (signal.aborted) throw e;
        const transient = !(e instanceof HttpError) || e.status === 429 || e.status >= 500;
        if (!transient || attempt >= maxRetries) throw e;
        const wait =
          e instanceof HttpError && e.retryAfterMs !== undefined
            ? Math.min(e.retryAfterMs, 60_000)
            : base * 2 ** attempt;
        await sleep(wait, signal);
      }
    }
  }
}
