// Scripted AgentRunner for tokenless tests (specs/01-foundations.md R0.6).
import type { StageName } from "../contracts/index.js";
import {
  AgentFailed,
  AgentTimeout,
  validateOutput,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRunner,
} from "./runner.js";

export interface ScriptContext {
  req: AgentRunRequest<unknown>;
}

/** Scripted live activity, emitted (spread over the step's delay) before the output. */
export type ActivityScript = {
  kind: "text" | "tool" | "result";
  tool?: string;
  detail: string;
  isError?: boolean;
}[];

export type ScriptStep = (
  | { output: unknown; costUsd?: number; delayMs?: number }
  | { throw: string; costUsd?: number }
  | { timeout: true; costUsd?: number }
  /** Run arbitrary side effects (e.g. edit files in req.cwd) and return the output. */
  | { act: (ctx: ScriptContext) => unknown | Promise<unknown>; costUsd?: number; delayMs?: number }
) & { activity?: ActivityScript };

type Key = `${StageName}:${number}:${number}`;

export class FakeAgentRunner implements AgentRunner {
  private readonly scripts = new Map<string, ScriptStep>();
  readonly calls: AgentRunRequest<unknown>[] = [];

  /** Script (stage, issue, attempt). Use attempt "*" to match any attempt, issue "*" to match any issue. */
  script(stage: StageName, issue: number | "*", attempt: number | "*", step: ScriptStep): this {
    this.scripts.set(`${stage}:${issue}:${attempt}`, step);
    return this;
  }

  private lookup(stage: StageName, issue: number, attempt: number): ScriptStep | undefined {
    const keys: string[] = [
      `${stage}:${issue}:${attempt}` satisfies Key,
      `${stage}:${issue}:*`,
      `${stage}:*:${attempt}`,
      `${stage}:*:*`,
    ];
    for (const k of keys) {
      const step = this.scripts.get(k);
      if (step) return step;
    }
    return undefined;
  }

  async run<T>(req: AgentRunRequest<T>): Promise<AgentRunResult<T>> {
    this.calls.push(req as AgentRunRequest<unknown>);
    const step = this.lookup(req.stage, req.issue, req.attempt);
    if (!step)
      throw new AgentFailed(
        `FakeAgentRunner: no script for ${req.stage}#${req.issue} attempt ${req.attempt}`,
      );
    const costUsd = step.costUsd ?? 0;
    const started = Date.now();
    if ("throw" in step) throw new AgentFailed(step.throw, costUsd);
    if ("timeout" in step) throw new AgentTimeout(`${req.stage} timed out`, costUsd);
    if (req.signal?.aborted) throw new AgentFailed(`${req.stage} cancelled`, costUsd);
    const delayMs = "delayMs" in step ? (step.delayMs ?? 0) : 0;
    const activity = step.activity ?? [];
    const slice = activity.length ? delayMs / (activity.length + 1) : delayMs;
    const wait = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        if (req.signal?.aborted) return reject(new AgentFailed(`${req.stage} cancelled`, costUsd));
        const timer = setTimeout(resolve, ms);
        req.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new AgentFailed(`${req.stage} cancelled`, costUsd));
          },
          { once: true },
        );
      });
    for (const a of activity) {
      await wait(slice);
      req.onActivity?.(a);
    }
    if (delayMs) await wait(slice);
    const raw = "act" in step ? await step.act({ req: req as AgentRunRequest<unknown> }) : step.output;
    const output = validateOutput(req.outputSchema, raw, costUsd);
    return {
      output,
      usage: { input: 100, output: 50 },
      costUsd,
      durationMs: Date.now() - started,
      transcriptPath: req.transcriptPath,
    };
  }
}
