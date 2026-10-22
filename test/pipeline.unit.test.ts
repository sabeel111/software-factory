import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAgentRunner } from "../src/agents/fake-runner.js";
import { READ_ONLY_TOOLS } from "../src/agents/runner.js";
import { parseConfig } from "../src/config.js";
import { ClaimingIssueSource } from "../src/issues/claims.js";
import { MemoryBackend } from "../src/issues/memory.js";
import { LABELS } from "../src/issues/types.js";
import { runIssue, type PipelineDeps } from "../src/pipeline/issue-pipeline.js";
import { MemoryPrSink } from "../src/pipeline/pr.js";
import { StaticPlaybooks } from "../src/pipeline/playbooks.js";
import { parseTestSummary, globToRegExp, checkScripts } from "../src/pipeline/verifier.js";
import { RunStore } from "../src/store/run-store.js";
import { FakeSandboxProvider } from "./helpers/fake-sandbox.js";
import { accept, approve, reject, workerDone } from "./helpers/scripts.js";

const ISSUE = { repo: "o/r", number: 5, title: "Do the thing", body: "details", labels: [LABELS.ready] };

async function unitDeps(limits: Record<string, number> = {}) {
  const backend = new MemoryBackend("o/r", [{ number: 5, title: ISSUE.title, labels: [LABELS.ready] }]);
  const runner = new FakeAgentRunner();
  const provider = new FakeSandboxProvider();
  const deps: PipelineDeps = {
    config: parseConfig({ repo: "o/r", prMode: "individual", limits }),
    runner,
    issues: new ClaimingIssueSource(backend),
    prs: new MemoryPrSink(),
    provider,
    snapshot: "snap",
    baseCommit: "base000",
    store: new RunStore(await mkdtemp(join(tmpdir(), "u-runs-"))),
    playbooks: new StaticPlaybooks(),
    batchId: "b",
    factoryVersion: "v",
    playbookHash: "h",
  };
  return { deps, backend, runner, provider };
}

describe("pipeline (fakes only)", () => {
  it("T4.1 a rejected issue posts questions, runs no worker, and is released as needs-info", async () => {
    const { deps, backend, runner } = await unitDeps();
    runner.script("triage", 5, 1, { output: reject(["Which metric?", "What target?"]) });
    const r = await runIssue(ISSUE, "run-1", deps);
    expect(r.outcome).toBe("rejected");
    expect(runner.calls.map((c) => c.stage)).toEqual(["triage"]);
    const comment = backend.commentBodies(5).find((b) => b.includes("needs more information"))!;
    expect(comment).toContain("- Which metric?");
    expect(comment).toContain("- What target?");
    const labels = (await backend.getIssue(5)).labels;
    expect(labels).toContain(LABELS.needsInfo);
    expect(labels).not.toContain(LABELS.claimed);
  });

  it("T4.8 exceeding the per-issue budget stops the run before the next stage", async () => {
    const { deps, runner } = await unitDeps({ maxCostUsdPerIssue: 1 });
    runner
      .script("triage", 5, 1, { output: accept(), costUsd: 0.4 })
      .script("worker", 5, 1, { output: workerDone(), costUsd: 0.7 });
    const r = await runIssue(ISSUE, "run-2", deps);
    expect(r.outcome).toBe("budget_exceeded");
    expect(runner.calls.map((c) => c.stage)).toEqual(["triage", "worker"]);
    expect(r.record.stages.find((s) => s.stage === "verifier")).toBeUndefined();
    const worker = runner.calls.find((c) => c.stage === "worker")!;
    expect(worker.maxBudgetUsd).toBeCloseTo(0.6);
  });

  it("T4.9 a worker crash still releases the claim and destroys every sandbox", async () => {
    const { deps, backend, runner, provider } = await unitDeps();
    runner.script("triage", 5, 1, { output: accept() }).script("worker", 5, "*", { throw: "segfault" });
    const r = await runIssue(ISSUE, "run-3", deps);
    expect(r.outcome).toBe("failed");
    expect((await backend.getIssue(5)).labels).not.toContain(LABELS.claimed);
    expect(provider.created.length).toBeGreaterThan(0);
    expect(provider.live).toHaveLength(0);

    // An unexpected (non-agent) crash is released as abandoned so the issue can be retried.
    const second = await unitDeps();
    second.runner.script("triage", 5, 1, { output: accept() });
    second.provider.create = async () => {
      throw new Error("disk full");
    };
    const crashed = await runIssue(ISSUE, "run-3b", second.deps);
    expect(crashed.outcome).toBe("failed");
    const labels = (await second.backend.getIssue(5)).labels;
    expect(labels).toContain(LABELS.ready);
    expect(labels).not.toContain(LABELS.claimed);
  });

  it("T4.10 triage and reviewer get read-only tools only", async () => {
    const { deps, runner } = await unitDeps();
    runner
      .script("triage", 5, 1, { output: accept() })
      .script("worker", 5, 1, { output: workerDone() })
      .script("reviewer", 5, 1, { output: approve });
    await runIssue(ISSUE, "run-4", deps);
    for (const stage of ["triage", "reviewer"] as const) {
      const call = runner.calls.find((c) => c.stage === stage)!;
      expect([...call.tools].sort()).toEqual([...READ_ONLY_TOOLS].sort());
      for (const t of ["Write", "Edit", "Bash"]) expect(call.tools).not.toContain(t);
    }
  });

  it("T4.11 invalid worker output is a failed attempt, not a crash", async () => {
    const { deps, runner } = await unitDeps();
    runner
      .script("triage", 5, 1, { output: accept() })
      .script("worker", 5, 1, { output: { status: "done" } })
      .script("worker", 5, 2, { output: workerDone() })
      .script("reviewer", 5, 2, { output: approve });
    const r = await runIssue(ISSUE, "run-5", deps);
    const w1 = r.record.stages.find((s) => s.stage === "worker" && s.attempt === 1)!;
    expect(w1.error).toMatch(/AgentOutputInvalid/);
    expect(r.outcome).toBe("pr_opened");
  });

  it("a timed-out stage counts as a failed attempt", async () => {
    const { deps, runner } = await unitDeps({ maxWorkerAttempts: 1 });
    runner.script("triage", 5, 1, { output: accept() }).script("worker", 5, 1, { timeout: true });
    const r = await runIssue(ISSUE, "run-6", deps);
    expect(r.outcome).toBe("failed");
    expect(r.record.stages.find((s) => s.stage === "worker")!.error).toMatch(/AgentTimeout/);
  });
});

describe("verifier helpers", () => {
  it("parses node:test, vitest and jest summaries", () => {
    expect(parseTestSummary("# tests 5\n# pass 4\n# fail 1\n# skipped 0\n")).toEqual({
      passed: 4,
      failed: 1,
      skipped: 0,
    });
    expect(parseTestSummary(" Tests  2 failed | 40 passed | 1 skipped (43)\n")).toEqual({
      passed: 40,
      failed: 2,
      skipped: 1,
    });
    expect(parseTestSummary("Tests:       1 failed, 41 passed, 42 total")).toEqual({
      passed: 41,
      failed: 1,
      skipped: 0,
    });
    expect(parseTestSummary("nothing here")).toBeNull();
  });

  it("matches protected-path globs", () => {
    expect(globToRegExp(".github/**").test(".github/workflows/ci.yml")).toBe(true);
    expect(globToRegExp(".github/**").test("src/.github")).toBe(false);
    expect(globToRegExp("*.lock").test("yarn.lock")).toBe(true);
    expect(globToRegExp("*.lock").test("a/yarn.lock")).toBe(false);
  });

  it("finds the npm scripts that checks run", () => {
    expect(
      checkScripts([
        { name: "t", command: "npm test" },
        { name: "l", command: "npm run lint -- --max-warnings 0" },
      ]),
    ).toEqual(["test", "lint"]);
  });
});
