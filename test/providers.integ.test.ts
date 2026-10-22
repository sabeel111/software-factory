import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { OpenAICompatRunner } from "../src/agents/openai-runner.js";
import { createRunner } from "../src/agents/routing.js";
import { AgentFailed, type AgentActivity, type AgentRunRequest } from "../src/agents/runner.js";
import { loadIssues, toIssueRef } from "../src/bench/benchmark.js";
import { ProviderConfig } from "../src/config.js";
import { runIssue } from "../src/pipeline/issue-pipeline.js";
import { fakeChatServer, submitProps, textReply, toolCall, toolResults } from "./helpers/fake-chat.js";
import { harness } from "./helpers/harness.js";
import { accept, approve, workerDone } from "./helpers/scripts.js";

const Out = z.object({ summary: z.string(), files: z.array(z.string()).min(1) });
type Out = z.infer<typeof Out>;

const servers: { close: () => Promise<void> }[] = [];
afterAll(async () => {
  for (const s of servers) await s.close();
});

async function server(handler: Parameters<typeof fakeChatServer>[0]) {
  const s = await fakeChatServer(handler);
  servers.push(s);
  return s;
}

const provider = (baseUrl: string, extra: Partial<z.input<typeof ProviderConfig>> = {}) =>
  ProviderConfig.parse({
    baseUrl,
    pricing: { "test-model": { inputPerMTok: 2, outputPerMTok: 8 } },
    ...extra,
  });

async function sandboxDir() {
  const dir = await mkdtemp(join(tmpdir(), "oai-sbx-"));
  await writeFile(join(dir, "greet.ts"), 'export const greet = () => "helo";\n');
  return dir;
}

function request(cwd: string, over: Partial<AgentRunRequest<Out>> = {}): AgentRunRequest<Out> {
  return {
    stage: "worker",
    issue: 4,
    attempt: 1,
    playbook: "You are the worker agent. Fix the issue.",
    input: { issue: { title: "Fix the greeting typo" } },
    outputSchema: Out,
    cwd,
    tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
    model: "test-model",
    effort: "high",
    ...over,
  };
}

describe("OpenAI-compatible runner (scripted Chat Completions server)", () => {
  it("T9.2 sends playbook and auth, runs Read then Edit in the sandbox, returns the validated result", async () => {
    const s = await server(
      (_r, i) =>
        [
          toolCall("Read", { file_path: "greet.ts" }),
          toolCall("Edit", { file_path: "greet.ts", old_string: '"helo"', new_string: '"hello"' }),
          toolCall("submit_result", { summary: "fixed typo", files: ["greet.ts"] }),
        ][i]!,
    );
    const cwd = await sandboxDir();
    const transcriptPath = join(cwd, "..", `${Date.now()}-t92.jsonl`);
    const activity: AgentActivity[] = [];
    const runner = new OpenAICompatRunner({
      name: "fakeai",
      provider: provider(s.url, { reasoningStyle: "openai" }),
      apiKey: "sk-test-key",
    });
    const r = await runner.run(request(cwd, { transcriptPath, onActivity: (a) => activity.push(a) }));

    expect(r.output).toEqual({ summary: "fixed typo", files: ["greet.ts"] });
    expect(await readFile(join(cwd, "greet.ts"), "utf8")).toBe('export const greet = () => "hello";\n');

    const first = s.requests[0]!;
    expect(first.headers.authorization).toBe("Bearer sk-test-key");
    expect(first.body.model).toBe("test-model");
    expect(first.body.reasoning_effort).toBe("high");
    expect(first.body.messages[0]!.role).toBe("system");
    expect(first.body.messages[0]!.content).toMatch(/^You are the worker agent\. Fix the issue\./);
    expect(first.body.messages[1]!.content).toContain("Fix the greeting typo");
    expect(first.body.tools.map((t) => t.function.name)).toEqual([
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "Bash",
      "submit_result",
    ]);
    // The model saw the file it read, then the edit's confirmation.
    expect(toolResults(s.requests[2]!)).toEqual([
      '     1\texport const greet = () => "helo";\n     2\t',
      "Edited greet.ts (1 replacement).",
    ]);

    // 3 calls × (1000 input × $2/M + 100 output × $8/M)
    expect(r.costUsd).toBeCloseTo(3 * 0.0028, 10);
    expect(r.usage).toEqual({ input: 3000, output: 300 });
    expect(activity.filter((a) => a.kind === "tool").map((a) => `${a.tool} ${a.detail}`)).toEqual([
      "Read greet.ts",
      "Edit greet.ts",
      "Submit structured result",
    ]);
    const lines = (await readFile(transcriptPath, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(["request", "response", "response", "response", "result"]);
  });

  it("T9.3 schema errors go back to the model; maxTurns and maxBudgetUsd stop the run with its cost", async () => {
    const s = await server((r) => {
      if (toolResults(r).length === 0) return toolCall("submit_result", { summary: "done", files: [] });
      return toolCall("submit_result", { summary: "done", files: ["greet.ts"] });
    });
    const cwd = await sandboxDir();
    const runner = new OpenAICompatRunner({ name: "fakeai", provider: provider(s.url) });
    const r = await runner.run(request(cwd));
    expect(r.output.files).toEqual(["greet.ts"]);
    const feedback = toolResults(s.requests[1]!)[0]!;
    expect(feedback).toMatch(/does not match the schema/);
    expect(feedback).toMatch(/files/);

    // Never submits: plain text, then tool calls forever.
    const chatty = await server((_r, i) =>
      i % 2 ? toolCall("Glob", { pattern: "*.ts" }) : textReply("Thinking…"),
    );
    const err = await new OpenAICompatRunner({ name: "fakeai", provider: provider(chatty.url) })
      .run(request(cwd, { maxTurns: 4 }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentFailed);
    expect((err as AgentFailed).message).toMatch(/error_max_turns/);
    expect(chatty.requests).toHaveLength(4);
    expect(chatty.requests[1]!.body.messages.at(-1)!.content).toMatch(/call submit_result/);

    const spender = await server(() => toolCall("Glob", { pattern: "*" }));
    const over = await new OpenAICompatRunner({ name: "fakeai", provider: provider(spender.url) })
      .run(request(cwd, { maxBudgetUsd: 0.005 }))
      .catch((e: unknown) => e);
    expect(over).toBeInstanceOf(AgentFailed);
    expect((over as AgentFailed).message).toMatch(/exceeded its budget/);
    expect((over as AgentFailed).costUsd).toBeCloseTo(2 * 0.0028, 10);
    expect(spender.requests).toHaveLength(2);
  });

  it("T9.5 retries a 500, fails fast on a 401 with the provider's message, prefers reported usage.cost", async () => {
    const cwd = await sandboxDir();
    const flaky = await server((_r, i) =>
      i === 0
        ? { status: 500, json: { error: { message: "upstream overloaded" } } }
        : {
            json: {
              ...toolCall("submit_result", { summary: "ok", files: ["greet.ts"] }).json,
              usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.42 },
            },
          },
    );
    const r = await new OpenAICompatRunner({
      name: "openrouter",
      provider: provider(flaky.url, { usageCost: true, reasoningStyle: "openrouter" }),
      retryBaseMs: 1,
    }).run(request(cwd));
    expect(flaky.requests).toHaveLength(2);
    expect(r.costUsd).toBe(0.42);
    expect(flaky.requests[0]!.body.reasoning).toEqual({ effort: "high" });
    expect(flaky.requests[0]!.body.usage).toEqual({ include: true });

    const denied = await server(() => ({
      status: 401,
      json: { error: { message: "Invalid API key provided" } },
    }));
    const err = await new OpenAICompatRunner({
      name: "fakeai",
      provider: provider(denied.url),
      retryBaseMs: 1,
    })
      .run(request(cwd))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentFailed);
    expect((err as Error).message).toMatch(/HTTP 401: Invalid API key provided/);
    expect(denied.requests).toHaveLength(1);

    const limited = await server((_r, i) =>
      i === 0
        ? { status: 429, headers: { "retry-after": "0.01" }, json: {} }
        : toolCall("submit_result", { summary: "ok", files: ["greet.ts"] }),
    );
    await new OpenAICompatRunner({ name: "fakeai", provider: provider(limited.url) }).run(request(cwd));
    expect(limited.requests).toHaveLength(2);
  });
});

describe("pipeline on an OpenAI-compatible provider", () => {
  it("T9.7 TinyLinks issue 1 end to end: triage, Edit fix, real npm test, review, draft PR", async () => {
    const s = await server((r) => {
      const props = submitProps(r);
      const step = toolResults(r).length;
      if (props.includes("decision")) return toolCall("submit_result", accept(["bare domains get https://"]));
      if (props.includes("verdict")) {
        return step === 0
          ? toolCall("Grep", { pattern: "https://", path: "src" })
          : toolCall("submit_result", approve);
      }
      if (props.includes("touchedFiles")) {
        return [
          toolCall("Read", { file_path: "src/url.ts" }),
          toolCall("Edit", {
            file_path: "src/url.ts",
            old_string: "    parsed = new URL(raw.trim());",
            new_string:
              "    const trimmed = raw.trim();\n    parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);",
          }),
          toolCall("Bash", { command: "npm test" }),
          toolCall("submit_result", workerDone(["src/url.ts"])),
        ][step]!;
      }
      throw new Error(`unexpected stage: ${props.join(",")}`);
    });
    const stage = (effort: string) => ({ provider: "fakeai", model: "test-model", effort });
    const h = await harness({
      providers: {
        fakeai: {
          type: "openai-compatible",
          baseUrl: s.url,
          apiKeyEnv: "FAKEAI_API_KEY",
          pricing: { "test-model": { inputPerMTok: 2, outputPerMTok: 8 } },
        },
      },
      stages: { triage: stage("low"), worker: stage("high"), reviewer: stage("medium") } as never,
    });
    process.env.FAKEAI_API_KEY = "sk-fakeai";
    h.deps.runner = createRunner(h.deps.config);
    const issue = toIssueRef((await loadIssues()).find((i) => i.number === 1)!);
    const r = await runIssue(issue, "run-t97", h.deps);

    expect(r.outcome).toBe("pr_opened");
    expect(h.prs.prs).toHaveLength(1);
    const worker = s.requests.filter((q) => submitProps(q).includes("touchedFiles"));
    expect(toolResults(worker.at(-1)!).at(-1)).toMatch(/^exit code: 0/); // the worker's own npm test
    expect(s.requests.every((q) => q.headers.authorization === "Bearer sk-fakeai")).toBe(true);
    const stages = r.record.stages.map((x) => x.stage);
    expect(stages).toEqual(expect.arrayContaining(["triage", "worker", "verifier", "reviewer"]));
    expect(r.record.stages.reduce((n, x) => n + x.costUsd, 0)).toBeGreaterThan(0);
    delete process.env.FAKEAI_API_KEY;
  });
});
