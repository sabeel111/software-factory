import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAgentRunner } from "../src/agents/fake-runner.js";
import { parseConfig } from "../src/config.js";
import type { RunRecord } from "../src/contracts/index.js";
import { ClaimingIssueSource } from "../src/issues/claims.js";
import { MemoryBackend } from "../src/issues/memory.js";
import { LABELS } from "../src/issues/types.js";
import { runBatch, type BatchDeps } from "../src/orchestrator/batch.js";
import { renderStatus } from "../src/orchestrator/status.js";
import { MemoryPrSink } from "../src/pipeline/pr.js";
import { StaticPlaybooks } from "../src/pipeline/playbooks.js";
import { RunStore } from "../src/store/run-store.js";
import { FakeSandboxProvider } from "./helpers/fake-sandbox.js";
import { accept, approve, workerDone } from "./helpers/scripts.js";

async function deps(n: number, config: Record<string, unknown>, prs = new MemoryPrSink()) {
  const backend = new MemoryBackend(
    "o/r",
    Array.from({ length: n }, (_, i) => ({ number: i + 1, labels: [LABELS.ready] })),
  );
  const runner = new FakeAgentRunner();
  const d: BatchDeps = {
    config: parseConfig({ repo: "o/r", ...config }),
    runner,
    issues: new ClaimingIssueSource(backend),
    prs,
    provider: new FakeSandboxProvider(),
    snapshot: "snap",
    baseCommit: "base000",
    store: new RunStore(await mkdtemp(join(tmpdir(), "bu-runs-"))),
    playbooks: new StaticPlaybooks(),
    batchId: "b",
    factoryVersion: "v",
    playbookHash: "h",
  };
  return { d, runner, backend };
}

describe("batch limits", () => {
  it("T5.3 the batch budget is global: no stage starts once it is spent", async () => {
    const { d, runner } = await deps(5, {
      prMode: "individual",
      limits: { concurrency: 1, maxCostUsdPerRun: 5, maxCostUsdPerIssue: 10 },
    });
    runner
      .script("triage", "*", "*", { output: accept(), costUsd: 1 })
      .script("worker", "*", "*", { output: workerDone(), costUsd: 1 })
      .script("reviewer", "*", "*", { output: approve, costUsd: 1 });
    const r = await runBatch(d);
    expect(r.costUsd).toBe(5);
    expect(runner.calls).toHaveLength(5);
    expect(r.results.map((x) => x.outcome)).toEqual(["pr_opened", "budget_exceeded"]);
    expect(r.unstarted.map((u) => u.issue)).toEqual([3, 4, 5]);
    expect(r.unstarted.every((u) => u.reason === "budget_exceeded")).toBe(true);
  });

  it("T5.4 no new issue starts when open factory PRs are at the limit", async () => {
    const { d, runner } = await deps(
      3,
      { prMode: "individual", limits: { maxOpenPrs: 2 } },
      new MemoryPrSink(2),
    );
    const r = await runBatch(d);
    expect(runner.calls).toHaveLength(0);
    expect(r.results).toHaveLength(0);
    expect(r.unstarted.map((u) => u.reason)).toEqual(["max_open_prs", "max_open_prs", "max_open_prs"]);
  });

  it("PR slots fill up during a batch as PRs are opened", async () => {
    const { d, runner } = await deps(4, { prMode: "individual", limits: { maxOpenPrs: 2, concurrency: 1 } });
    runner
      .script("triage", "*", "*", { output: accept() })
      .script("worker", "*", "*", { output: workerDone() })
      .script("reviewer", "*", "*", { output: approve });
    const r = await runBatch(d);
    expect(r.results.filter((x) => x.outcome === "pr_opened")).toHaveLength(2);
    expect(r.unstarted.map((u) => u.reason)).toEqual(["max_open_prs", "max_open_prs"]);
  });
});

describe("status", () => {
  it("T5.10 renders per-issue rows and totals", () => {
    const t = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
    const stage = (stage: "triage" | "worker" | "verifier", attempt: number, cost: number) => ({
      stage,
      attempt,
      startedAt: t(0),
      durationMs: 1000,
      costUsd: cost,
      tokens: { input: 1, output: 1 },
      output: null,
    });
    const rec = (
      n: number,
      title: string,
      stages: RunRecord["stages"],
      outcome?: RunRecord["outcome"],
    ): RunRecord => ({
      runId: `r${n}`,
      batchId: "b",
      issue: { repo: "o/r", number: n, title, body: "", labels: [] },
      startedAt: t(0),
      ...(outcome ? { finishedAt: t(95), outcome } : {}),
      factoryVersion: "v",
      playbookHash: "h",
      stages,
    });
    const out = renderStatus(
      [
        rec(7, "Link expiration", [stage("triage", 1, 0.05), stage("worker", 2, 0.9)]),
        rec(
          3,
          "Malformed ?url= crashes with 500 instead of 400 Bad Request",
          [stage("triage", 1, 0.04), stage("verifier", 1, 0)],
          "pr_opened",
        ),
        rec(10, "Make the links better", [stage("triage", 1, 0.03)], "rejected"),
      ],
      Date.parse(t(42)),
    );
    expect(out).toBe(
      [
        "Issue  Title                                 Stage     Try  Elapsed  Cost   Outcome",
        "#3     Malformed ?url= crashes with 500 in…  verifier  1    1m35s    $0.04  pr_opened",
        "#7     Link expiration                       worker    2    42s      $0.95  running",
        "#10    Make the links better                 triage    1    1m35s    $0.03  rejected",
        "",
        "Total: 3 issues · $1.02 · 1 pr_opened, 1 running, 1 rejected",
      ].join("\n"),
    );
  });
});
