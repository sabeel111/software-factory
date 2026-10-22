// Real Claude against the benchmark. Costs money: opt in with FACTORY_E2E=1 and Claude credentials
// (ANTHROPIC_API_KEY or a Claude Code login). Results are appended to bench/results.jsonl.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeAgentRunner } from "../src/agents/claude-runner.js";
import { BENCH_ROOT, loadIssues, prepareBenchRepo, toIssueRef } from "../src/bench/benchmark.js";
import { reviewerCatchRate } from "../src/bench/reviewer-catch.js";
import { benchConfig, benchmarkOnce } from "../src/bench/run-factory.js";
import { scoreCandidate } from "../src/bench/score.js";
import { ClaimingIssueSource } from "../src/issues/claims.js";
import { MemoryBackend } from "../src/issues/memory.js";
import { runIssue, type PipelineDeps } from "../src/pipeline/issue-pipeline.js";
import { DirPlaybooks } from "../src/pipeline/playbooks.js";
import { MemoryPrSink } from "../src/pipeline/pr.js";
import { WorktreeProvider } from "../src/sandbox/worktree.js";
import { RunStore } from "../src/store/run-store.js";

const enabled = process.env.FACTORY_E2E === "1";

async function realDeps() {
  const bench = await prepareBenchRepo(await mkdtemp(join(tmpdir(), "e2e-bench-")));
  const config = benchConfig({ prMode: "individual" });
  const provider = new WorktreeProvider({
    root: await mkdtemp(join(tmpdir(), "e2e-sbx-")),
    secretPaths: config.secretPaths,
  });
  const snapshot = await provider.prepareSnapshot({ repoUrl: bench.dir, ref: "main", setup: [] });
  const issues = await loadIssues();
  const backend = new MemoryBackend(
    "bench/tinylinks",
    issues.map((i) => ({ ...i })),
  );
  const deps: PipelineDeps = {
    config,
    runner: new ClaudeAgentRunner(),
    issues: new ClaimingIssueSource(backend),
    prs: new MemoryPrSink(),
    provider,
    snapshot,
    baseCommit: bench.baseCommit,
    store: new RunStore(await mkdtemp(join(tmpdir(), "e2e-runs-"))),
    playbooks: new DirPlaybooks(),
    batchId: "e2e",
    factoryVersion: "e2e",
    playbookHash: "e2e",
  };
  return { bench, deps, issues, backend, provider, snapshot };
}

describe.skipIf(!enabled)("factory with real Claude", () => {
  it("T4.12 issue 1 produces a passing branch whose hidden test passes", async () => {
    const { bench, deps, issues } = await realDeps();
    const issue = issues.find((i) => i.number === 1)!;
    const r = await runIssue(toIssueRef(issue), "e2e-t412", deps);
    expect(r.outcome).toBe("pr_opened");
    const score = await scoreCandidate({ repo: bench.dir, candidateRef: r.record.branch!, issues: [issue] });
    expect(score.perIssue[0]!.passed).toBe(true);
  });

  it("T4.13 the vague issue is rejected with at least one clarifying question", async () => {
    const { deps, issues, backend } = await realDeps();
    const r = await runIssue(toIssueRef(issues.find((i) => i.number === 10)!), "e2e-t413", deps);
    expect(r.outcome).toBe("rejected");
    expect(backend.commentBodies(10).some((b) => /\n- .+\?/.test(b))).toBe(true);
  });

  it("T4.14 the reviewer catches at least half of the seeded defects", async () => {
    const { bench, deps, provider, snapshot } = await realDeps();
    const { rate, results } = await reviewerCatchRate({
      bench,
      provider,
      snapshot,
      runner: deps.runner,
      playbooks: deps.playbooks,
      reviewer: deps.config.stages.reviewer,
      root: BENCH_ROOT,
    });
    console.log("reviewer catch results", results);
    expect(rate).toBeGreaterThanOrEqual(0.5);
  });

  it("T4.15 sequential benchmark run is recorded", async () => {
    const run = await benchmarkOnce({
      config: { prMode: "integrated", limits: { concurrency: 1 } },
      label: "T4.15 sequential",
    });
    console.log("T4.15", {
      resolveRate: run.score.resolveRate,
      triage: run.triageAccuracy,
      falsePass: run.falsePassRate,
      cost: run.costUsd,
    });
    expect(run.triageAccuracy).toBe(1);
    expect(run.score.resolveRate).toBeGreaterThanOrEqual(0.6);
  });

  it("T5.11 parallel benchmark (concurrency 4, integrated) meets the v1 targets", async () => {
    const run = await benchmarkOnce({
      config: { prMode: "integrated", limits: { concurrency: 4 } },
      label: "T5.11 parallel",
    });
    console.log("T5.11", {
      resolveRate: run.score.resolveRate,
      cost: run.costUsd,
      wallClockMs: run.wallClockMs,
    });
    expect(run.score.resolveRate).toBeGreaterThanOrEqual(0.7);
    expect(run.wallClockMs).toBeLessThanOrEqual(10 * 60_000);
  });
});
