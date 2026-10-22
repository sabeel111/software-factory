import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createRunner, RoutingRunner } from "../src/agents/routing.js";
import type { AgentRunner, AgentRunRequest } from "../src/agents/runner.js";
import { bashEnv, runTool, ToolError } from "../src/agents/tools.js";
import { ConfigError, parseConfig, providerKeyEnvs, resolveProvider } from "../src/config.js";
import { fakeChatFetch, toolCall } from "./helpers/fake-chat.js";

const Out = z.object({ ok: z.boolean() });

function req(over: Partial<AgentRunRequest<{ ok: boolean }>> = {}): AgentRunRequest<{ ok: boolean }> {
  return {
    stage: "triage",
    issue: 1,
    attempt: 1,
    playbook: "You are the triage agent.",
    input: { hello: "world" },
    outputSchema: Out,
    cwd: process.cwd(),
    tools: ["Read", "Glob", "Grep"],
    model: "test-model",
    effort: "low",
    ...over,
  };
}

describe("model provider config", () => {
  it("T9.1 stages default to anthropic; presets resolve; undeclared and unpriced providers fail with names", () => {
    const base = parseConfig({ repo: "o/r" });
    for (const s of Object.values(base.stages)) expect(s.provider ?? "anthropic").toBe("anthropic");

    const openai = resolveProvider(base, "openai");
    expect(openai).toMatchObject({
      type: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
    });
    const or = resolveProvider(base, "openrouter");
    expect(or).toMatchObject({
      baseUrl: "https://openrouter.ai/api/v1",
      apiKeyEnv: "OPENROUTER_API_KEY",
      usageCost: true,
    });

    // OpenRouter reports cost per request, so it needs no pricing table.
    const ok = parseConfig({
      repo: "o/r",
      stages: { triage: { provider: "openrouter", model: "vendor/model", effort: "low" } },
    });
    expect(ok.stages.triage.provider).toBe("openrouter");

    expect(() =>
      parseConfig({ repo: "o/r", stages: { reviewer: { provider: "nope", model: "m", effort: "medium" } } }),
    ).toThrow(/stages\.reviewer\.provider: Unknown model provider "nope"/);

    expect(() =>
      parseConfig({
        repo: "o/r",
        stages: { worker: { provider: "openai", model: "some-model", effort: "high" } },
      }),
    ).toThrow(ConfigError);
    expect(() =>
      parseConfig({
        repo: "o/r",
        stages: { worker: { provider: "openai", model: "some-model", effort: "high" } },
      }),
    ).toThrow(/providers\.openai: no pricing for model "some-model"/);

    // A declaration merges over the preset; a custom provider can opt out of pricing.
    const priced = parseConfig({
      repo: "o/r",
      providers: {
        openai: { pricing: { "some-model": { inputPerMTok: 1, outputPerMTok: 2 } } },
        local: { type: "openai-compatible", baseUrl: "http://localhost:11434/v1", allowUnpriced: true },
      },
      stages: {
        worker: { provider: "openai", model: "some-model", effort: "high" },
        triage: { provider: "local", model: "llama", effort: "low" },
      },
    });
    expect(resolveProvider(priced, "openai").baseUrl).toBe("https://api.openai.com/v1");
    // A partial declaration of a preset keeps the preset's other settings.
    const tweaked = parseConfig({
      repo: "o/r",
      providers: { openrouter: { headers: { "HTTP-Referer": "x" } }, anthropic: {} },
    });
    expect(resolveProvider(tweaked, "openrouter")).toMatchObject({
      usageCost: true,
      headers: { "X-Title": "software-factory", "HTTP-Referer": "x" },
    });
    expect(resolveProvider(tweaked, "anthropic").type).toBe("anthropic");
    expect(providerKeyEnvs(priced)).toEqual(expect.arrayContaining(["OPENAI_API_KEY", "OPENROUTER_API_KEY"]));
    expect(() =>
      parseConfig({
        repo: "o/r",
        providers: { local: { type: "openai-compatible" } },
        stages: { triage: { provider: "local", model: "m", effort: "low" } },
      }),
    ).toThrow(/providers\.local\.baseUrl is required/);
  });
});

describe("factory-implemented agent tools", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("T9.4 file tools stay in the sandbox, Edit needs exactly one match, Bash sees no keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "tools-"));
    const outside = await mkdtemp(join(tmpdir(), "outside-"));
    await writeFile(join(outside, "secret.txt"), "top secret");
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/a.ts"), "const x = 1;\nconst y = 1;\n");
    await symlink(outside, join(root, "escape"));
    const ctx = { cwd: root, secretEnvs: ["MY_LOCAL_KEY"] };

    for (const p of ["../outside/secret.txt", join(outside, "secret.txt"), "escape/secret.txt"]) {
      await expect(runTool("Read", { file_path: p }, ctx)).rejects.toThrow(ToolError);
      await expect(runTool("Write", { file_path: p, content: "x" }, ctx)).rejects.toThrow(
        /outside the repository/,
      );
    }
    await expect(runTool("Write", { file_path: "escape/new.txt", content: "x" }, ctx)).rejects.toThrow(
      ToolError,
    );
    await expect(runTool("Glob", { pattern: "*", path: "escape" }, ctx)).rejects.toThrow(ToolError);
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("top secret");

    expect(await runTool("Read", { file_path: "src/a.ts" }, ctx)).toContain("     1\tconst x = 1;");
    expect(await runTool("Glob", { pattern: "**/*.ts" }, ctx)).toBe("src/a.ts");
    expect(await runTool("Grep", { pattern: "const y" }, ctx)).toBe("src/a.ts:2:const y = 1;");

    await expect(
      runTool("Edit", { file_path: "src/a.ts", old_string: "nope", new_string: "z" }, ctx),
    ).rejects.toThrow(/not found/);
    await expect(
      runTool("Edit", { file_path: "src/a.ts", old_string: " = 1;", new_string: " = 2;" }, ctx),
    ).rejects.toThrow(/appears 2 times/);
    await runTool(
      "Edit",
      { file_path: "src/a.ts", old_string: "const x = 1;", new_string: "const x = $&2;" },
      ctx,
    );
    expect(await readFile(join(root, "src/a.ts"), "utf8")).toBe("const x = $&2;\nconst y = 1;\n");
    await runTool(
      "Edit",
      { file_path: "src/a.ts", old_string: "const", new_string: "let", replace_all: true },
      ctx,
    );
    expect(await readFile(join(root, "src/a.ts"), "utf8")).toBe("let x = $&2;\nlet y = 1;\n");

    Object.assign(process.env, {
      OPENAI_API_KEY: "sk-openai-test",
      OPENROUTER_API_KEY: "sk-or-test",
      ANTHROPIC_API_KEY: "sk-ant-test",
      GITHUB_TOKEN: "ghp_test",
      MY_LOCAL_KEY: "local-test",
      GIT_CONFIG_KEY_0: "http.extraheader",
      HARMLESS: "visible",
    });
    const out = await runTool("Bash", { command: "env" }, ctx);
    expect(out).toContain("exit code: 0");
    expect(out).toContain("HARMLESS=visible");
    for (const leaked of [
      "sk-openai-test",
      "sk-or-test",
      "sk-ant-test",
      "ghp_test",
      "local-test",
      "GIT_CONFIG_KEY_0",
    ]) {
      expect(out).not.toContain(leaked);
    }
    expect(bashEnv()).not.toHaveProperty("OPENAI_API_KEY");
  });
});

describe("routing", () => {
  it("T9.6 each stage goes to its provider's runner; blocked tools are never offered", async () => {
    const calls: string[] = [];
    const fake = (name: string): AgentRunner => ({
      run: async <T>(r: AgentRunRequest<T>) => {
        calls.push(`${name}:${r.stage}`);
        return { output: { ok: true } as T, usage: { input: 0, output: 0 }, costUsd: 0, durationMs: 0 };
      },
    });
    const made: string[] = [];
    const routing = new RoutingRunner((p) => (made.push(p), fake(p)));
    await routing.run(req({ stage: "triage", provider: "openrouter" }));
    await routing.run(req({ stage: "worker" }));
    await routing.run(req({ stage: "reviewer", provider: "openrouter" }));
    expect(calls).toEqual(["openrouter:triage", "anthropic:worker", "openrouter:reviewer"]);
    expect(made).toEqual(["openrouter", "anthropic"]); // one runner per provider

    // createRunner picks the OpenAI-compatible loop for non-Anthropic providers.
    const chat = fakeChatFetch((r, i) => {
      if (i === 0) return toolCall("Bash", { command: "cat ~/.ssh/id_rsa" });
      return toolCall("submit_result", { ok: true });
    });
    const runner = createRunner(
      { providers: { local: { type: "openai-compatible", baseUrl: "http://x/v1", allowUnpriced: true } } },
      { openai: { fetchFn: chat.fetchFn } },
    );
    // The pipeline removes blocked tools (here: Bash) before the request reaches the runner.
    const r = await runner.run(req({ provider: "local", tools: ["Read", "Glob"] }));
    expect(r.output).toEqual({ ok: true });
    const offered = chat.requests[0]!.body.tools.map((t) => t.function.name);
    expect(offered).toEqual(["Read", "Glob", "submit_result"]);
    const refusal = chat.requests[1]!.body.messages.at(-1)!;
    expect(refusal).toMatchObject({
      role: "tool",
      content: "Error: tool Bash is not available in this stage.",
    });
  });
});
