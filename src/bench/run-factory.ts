// Runs the whole factory against the TinyLinks benchmark and scores the result with hidden tests
// (specs/02-benchmark.md, T4.15, T5.11). Also the evaluation engine for self-improvement (Phase 6).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAgentRunner } from "../agents/claude-runner.js";
import type { AgentRunner } from "../agents/runner.js";
import {
  applyStageOverrides,
  parseConfig,
  readStageOverrides,
  type FactoryConfig,
  type FactoryConfigInput,
  type StageOverrides,
} from "../config.js";
import { TriageResult } from "../contracts/index.js";
import { ClaimingIssueSource } from "../issues/claims.js";
import { MemoryBackend } from "../issues/memory.js";
import { runBatch, type BatchResult } from "../orchestrator/batch.js";
import { DEFAULT_PLAYBOOK_DIR, DirPlaybooks, type Playbooks } from "../pipeline/playbooks.js";
import { MemoryPrSink } from "../pipeline/pr.js";
import { WorktreeProvider } from "../sandbox/worktree.js";
import { factoryVersion, newId, playbookHash, RunStore } from "../store/run-store.js";
import {
  BENCH_REPO_NAME,
  BENCH_ROOT,
  loadIssues,
  prepareBenchRepo,
  type BenchIssue,
  type PreparedBench,
  type Split,
} from "./benchmark.js";
import { appendResult, noiseBand, scoreCandidate, type BenchScore } from "./score.js";

export interface FactoryBenchOptions {
  bench?: PreparedBench;
  issues: BenchIssue[];
  split: Split;
  repeat: number;
  configPath?: string;
}

export interface BenchRun {
  score: BenchScore;
  triageAccuracy: number | null;
  falsePassRate: number | null;
  costUsd: number;
  costPerResolved: number | null;
  wallClockMs: number;
  batch: BatchResult;
  /** Hidden-test result of each approved change on its own branch. */
  hiddenByIssue: Record<number, boolean>;
  ejected: Set<number>;
  issues: BenchIssue[];
}

export interface EvaluateOptions {
  split?: Split;
  repeat?: number;
  config?: Partial<FactoryConfigInput>;
  playbooks?: Playbooks;
  playbooksDir?: string;
  runner?: AgentRunner;
  runsRoot?: string;
  label?: string;
  record?: boolean;
  log?: (m: string) => void;
}

export function benchConfig(
  overrides: Partial<FactoryConfigInput> = {},
  stageOverrides: StageOverrides = {},
): FactoryConfig {
  const config = parseConfig({
    prMode: "integrated",
    checks: [{ name: "test", command: "npm test" }],
    ...overrides,
    repo: BENCH_REPO_NAME,
    sandbox: { provider: "worktree", setup: [] },
    secretPaths: [join(BENCH_ROOT, "hidden")],
  });
  return applyStageOverrides(config, stageOverrides);
}

/** One full benchmark run on a fresh fixture repo. */
export async function benchmarkOnce(opts: EvaluateOptions = {}): Promise<BenchRun> {
  const split = opts.split ?? "all";
  const issues = await loadIssues(undefined, split);
  const config = benchConfig(
    opts.config,
    await readStageOverrides(opts.playbooksDir ?? DEFAULT_PLAYBOOK_DIR),
  );
  const work = await mkdtemp(join(tmpdir(), "factory-benchrun-"));
  try {
    const bench = await prepareBenchRepo(join(work, "repo"));
    const provider = new WorktreeProvider({ root: join(work, "sandboxes"), secretPaths: config.secretPaths });
    const snapshot = await provider.prepareSnapshot({ repoUrl: bench.dir, ref: "main", setup: [] });
    const backend = new MemoryBackend(
      BENCH_REPO_NAME,
      issues.map((i) => ({ number: i.number, title: i.title, body: i.body, labels: i.labels })),
    );
    const batchId = newId("bench-");
    const store = new RunStore(opts.runsRoot ?? "runs");
    const playbooks = opts.playbooks ?? new DirPlaybooks(opts.playbooksDir);
    const batch = await runBatch({
      config,
      runner: opts.runner ?? new ClaudeAgentRunner(),
      issues: new ClaimingIssueSource(backend),
      prs: new MemoryPrSink(),
      provider,
      snapshot,
      baseCommit: bench.baseCommit,
      store,
      playbooks,
      batchId,
      factoryVersion: factoryVersion(),
      playbookHash: await playbookHash(opts.playbooksDir),
      heartbeatMs: 60_000,
      log: opts.log,
    });

    const triage: Record<number, "accept" | "reject"> = {};
    for (const r of batch.results) {
      const t = r.record.stages.find((s) => s.stage === "triage" && !s.error);
      const parsed = TriageResult.safeParse(t?.output);
      if (parsed.success) triage[r.record.issue.number] = parsed.data.decision;
    }
    const integrated = batch.integration?.result.merged.length
      ? batch.integration.result.integrationBranch
      : undefined;
    const individual = batch.results.find((r) => r.outcome === "pr_opened")?.record.branch;
    const candidateRef = integrated ?? individual ?? "main";
    const score = await scoreCandidate({ repo: bench.dir, candidateRef, issues, triage });

    // False passes: changes the verifier passed whose own hidden test fails.
    const approved = batch.results.filter((r) => r.approved);
    let falsePasses = 0;
    const hiddenByIssue: Record<number, boolean> = {};
    for (const r of approved) {
      const issue = issues.find((i) => i.number === r.record.issue.number);
      if (!issue?.hidden) continue;
      const own = await scoreCandidate({
        repo: bench.dir,
        candidateRef: r.approved!.branch,
        issues: [issue],
      });
      hiddenByIssue[issue.number] = own.perIssue[0]?.passed ?? false;
      if (!own.perIssue[0]?.passed) falsePasses++;
    }
    const falsePassRate = approved.length ? falsePasses / approved.length : null;
    const ejected = new Set(batch.integration?.result.ejected.map((e) => e.issue) ?? []);
    const run: BenchRun = {
      score,
      triageAccuracy: score.triageAccuracy,
      falsePassRate,
      costUsd: batch.costUsd,
      costPerResolved: score.resolved ? batch.costUsd / score.resolved : null,
      wallClockMs: batch.wallClockMs,
      batch,
      hiddenByIssue,
      ejected,
      issues,
    };
    if (opts.record ?? true) {
      await appendResult({
        at: new Date().toISOString(),
        label: opts.label ?? "factory",
        factoryVersion: factoryVersion(),
        playbookHash: await playbookHash(opts.playbooksDir),
        models: Object.fromEntries(
          Object.entries(config.stages).map(([k, v]) => [k, `${v.model}@${v.effort}`]),
        ),
        costUsd: batch.costUsd,
        split,
        score,
        falsePassRate,
        wallClockMs: batch.wallClockMs,
      });
    }
    return run;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function benchmark(opts: EvaluateOptions = {}): Promise<BenchRun[]> {
  const runs: BenchRun[] = [];
  for (let i = 0; i < (opts.repeat ?? 1); i++) runs.push(await benchmarkOnce(opts));
  return runs;
}

export async function runFactoryBenchmark(opts: FactoryBenchOptions): Promise<number> {
  const config = opts.configPath ? (await import("../config.js")).loadConfig(opts.configPath) : undefined;
  const overrides = config ? { stages: (await config).stages, limits: (await config).limits } : {};
  const runs = await benchmark({
    split: opts.split,
    repeat: opts.repeat,
    config: overrides,
    log: (m) => console.log(m),
  });
  for (const [i, r] of runs.entries()) {
    console.log(
      `Run ${i + 1}: resolved ${r.score.resolved}/${r.score.total} (${Math.round(r.score.resolveRate * 100)}%) · triage ${r.triageAccuracy === null ? "n/a" : `${Math.round(r.triageAccuracy * 100)}%`} · false-pass ${r.falsePassRate === null ? "n/a" : `${Math.round(r.falsePassRate * 100)}%`} · $${r.costUsd.toFixed(2)} · ${(r.wallClockMs / 1000).toFixed(0)}s`,
    );
  }
  if (runs.length > 1)
    console.log(
      `Noise band (resolve rate spread): ${noiseBand(runs.map((r) => r.score.resolveRate)).toFixed(3)}`,
    );
  return 0;
}
