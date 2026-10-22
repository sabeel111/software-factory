import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAgentRunner } from "../src/agents/fake-runner.js";
import { applyPolicy, loadConfig, parseConfig, resolveRepos } from "../src/config.js";
import { ClaimingIssueSource } from "../src/issues/claims.js";
import { MemoryBackend } from "../src/issues/memory.js";
import { LABELS } from "../src/issues/types.js";
import { runIssue, type PipelineDeps } from "../src/pipeline/issue-pipeline.js";
import { MemoryPrSink } from "../src/pipeline/pr.js";
import { StaticPlaybooks } from "../src/pipeline/playbooks.js";
import { RunStore } from "../src/store/run-store.js";
import { FakeSandboxProvider } from "./helpers/fake-sandbox.js";
import { accept, approve, workerDone } from "./helpers/scripts.js";

describe("org policy", () => {
  it("T7.4 policy limits only lower repo limits; protected paths are added, never replaced", () => {
    const repo = parseConfig({
      repo: "o/r",
      limits: { concurrency: 8, maxOpenPrs: 2 },
      protectedPaths: ["infra/**"],
    });
    const eff = applyPolicy(repo, {
      limits: { concurrency: 4, maxOpenPrs: 10 },
      protectedPaths: [".github/**", "secrets/**"],
    });
    expect(eff.limits.concurrency).toBe(4);
    expect(eff.limits.maxOpenPrs).toBe(2);
    expect(eff.protectedPaths.sort()).toEqual([".github/**", "infra/**", "secrets/**"]);
  });

  it("a policy file next to the config is always applied", async () => {
    const dir = await mkdtemp(join(tmpdir(), "policy-"));
    await writeFile(
      join(dir, "factory.config.ts"),
      `export default { repo: "o/r", limits: { concurrency: 16 } };\n`,
    );
    await writeFile(
      join(dir, "factory.policy.ts"),
      `export default { limits: { concurrency: 2 }, blockedTools: ["Bash"] };\n`,
    );
    const cfg = await loadConfig(join(dir, "factory.config.ts"), join(dir, "no-playbooks"));
    expect(cfg.limits.concurrency).toBe(2);
    expect(cfg.blockedTools).toEqual(["Bash"]);
  });

  it("blocked tools are never granted to agents", async () => {
    const backend = new MemoryBackend("o/r", [{ number: 1, labels: [LABELS.ready] }]);
    const runner = new FakeAgentRunner()
      .script("triage", 1, 1, { output: accept() })
      .script("worker", 1, 1, { output: workerDone() })
      .script("reviewer", 1, 1, { output: approve });
    const deps: PipelineDeps = {
      config: applyPolicy(parseConfig({ repo: "o/r", prMode: "individual" }), {
        blockedTools: ["Bash", "Write"],
      }),
      runner,
      issues: new ClaimingIssueSource(backend),
      prs: new MemoryPrSink(),
      provider: new FakeSandboxProvider(),
      snapshot: "s",
      baseCommit: "base000",
      store: new RunStore(await mkdtemp(join(tmpdir(), "pol-runs-"))),
      playbooks: new StaticPlaybooks(),
      batchId: "b",
      factoryVersion: "v",
      playbookHash: "h",
    };
    await runIssue({ repo: "o/r", number: 1, title: "t", body: "", labels: [] }, "r", deps);
    const worker = runner.calls.find((c) => c.stage === "worker")!;
    expect(worker.tools).toEqual(["Read", "Edit", "Glob", "Grep"]);
  });
});

describe("multi-repo config", () => {
  it("repos inherit top-level settings they don't set", () => {
    const [a, b] = resolveRepos(
      parseConfig({
        repo: "o/main",
        checks: [{ name: "test", command: "npm test" }],
        limits: { maxCostUsdPerIssue: 2 },
        repos: [
          { repo: "o/a" },
          { repo: "o/b", checks: [{ name: "py", command: "pytest" }], limits: { maxWorkerAttempts: 3 } },
        ],
      }),
    );
    expect(a!.repo).toBe("o/a");
    expect(a!.checks).toEqual([{ name: "test", command: "npm test" }]);
    expect(b!.checks).toEqual([{ name: "py", command: "pytest" }]);
    expect(b!.limits.maxWorkerAttempts).toBe(3);
    expect(b!.limits.maxCostUsdPerIssue).toBe(2);
  });
});
