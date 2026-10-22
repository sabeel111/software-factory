// Demo environment: zero cost, no credentials (specs/09-control-ui.md R8.7).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BENCH_REPO_NAME, BENCH_ROOT, loadIssues, prepareBenchRepo } from "../bench/benchmark.js";
import { benchConfig, benchmarkOnce } from "../bench/run-factory.js";
import { appendResult, scoreCandidate } from "../bench/score.js";
import { toScores } from "../commands/improve.js";
import { fromBenchRun } from "../improve/collect.js";
import { History } from "../improve/history.js";
import { improve, revertCandidate, type Promoter } from "../improve/improve.js";
import { ClaimingIssueSource } from "../issues/claims.js";
import { MemoryBackend } from "../issues/memory.js";
import { LABELS } from "../issues/types.js";
import { MemoryPrSink } from "../pipeline/pr.js";
import { DirPlaybooks } from "../pipeline/playbooks.js";
import { WorktreeProvider } from "../sandbox/worktree.js";
import { factoryVersion, playbookHash, RunStore } from "../store/run-store.js";
import type { BenchOptions, EnvInfo, Environment, JobContext, StartBatchOptions } from "./controller.js";
import { demoRetro, demoRunner, type DemoSpeed } from "./demo-agents.js";

const demoPromoter: Promoter = {
  async promote(p) {
    return `demo://pull/${p.candidateId}`;
  },
};

export class DemoEnvironment implements Environment {
  readonly mode = "demo" as const;
  readonly store: RunStore;
  readonly runsRoot: string;
  readonly benchResultsFile: string;
  readonly historyFile: string;
  /** The tracker of the most recent demo batch (tests inspect claims and labels). */
  lastBackend?: MemoryBackend;

  private constructor(
    private readonly work: string,
    private readonly speed: DemoSpeed,
  ) {
    this.runsRoot = join(work, "runs");
    this.store = new RunStore(this.runsRoot);
    this.benchResultsFile = join(work, "results.jsonl");
    this.historyFile = join(work, "HISTORY.jsonl");
  }

  static async create(opts: { speed?: number; dir?: string } = {}): Promise<DemoEnvironment> {
    const work = opts.dir ?? (await mkdtemp(join(tmpdir(), "factory-demo-")));
    return new DemoEnvironment(work, { factor: opts.speed ?? 1 });
  }

  async dispose(): Promise<void> {
    await rm(this.work, { recursive: true, force: true });
  }

  async describe(): Promise<EnvInfo> {
    const c = benchConfig({ prMode: "integrated" });
    return {
      mode: "demo",
      repo: `${BENCH_REPO_NAME} (demo)`,
      provider: c.sandbox.provider,
      prMode: c.prMode,
      checks: c.checks,
      limits: { ...c.limits },
      stages: c.stages,
      protectedPaths: c.protectedPaths,
      blockedTools: c.blockedTools,
      warnings: [
        "Demo mode: agents are scripted, costs are simulated, and PRs are not opened anywhere. The repo, sandboxes, verifier, merges and hidden-test scoring are real.",
      ],
      credentials: { github: false, anthropic: false, context7: false },
      costNote: "Free: demo agents are scripted.",
    };
  }

  async readyIssues() {
    return (await loadIssues()).map((i) => ({ number: i.number, title: i.title, labels: i.labels }));
  }

  private async fixture(ctx: JobContext) {
    const dir = join(this.work, ctx.batchId);
    const bench = await prepareBenchRepo(join(dir, "repo"));
    const config = benchConfig({ prMode: "integrated" });
    const provider = new WorktreeProvider({ root: join(dir, "sandboxes"), secretPaths: config.secretPaths });
    const snapshot = await provider.prepareSnapshot({ repoUrl: bench.dir, ref: "main", setup: [] });
    return { bench, config, provider, snapshot };
  }

  async prepareBatch(opts: StartBatchOptions, ctx: JobContext) {
    const issues = await loadIssues();
    const { bench, config, provider, snapshot } = await this.fixture(ctx);
    if (opts.concurrency) config.limits.concurrency = opts.concurrency;
    if (opts.maxCostUsdPerRun) config.limits.maxCostUsdPerRun = opts.maxCostUsdPerRun;
    const selected = opts.issues?.length ? issues.filter((i) => opts.issues!.includes(i.number)) : issues;
    const backend = new MemoryBackend(
      BENCH_REPO_NAME,
      selected.map((i) => ({ number: i.number, title: i.title, body: i.body, labels: [LABELS.ready] })),
    );
    this.lastBackend = backend;
    ctx.log(`Demo fixture ready: ${selected.length} TinyLinks issue(s), real sandboxes and verifier`);
    return {
      config,
      runner: demoRunner(issues, this.speed),
      issues: new ClaimingIssueSource(backend),
      prs: new MemoryPrSink(),
      provider,
      snapshot,
      baseCommit: bench.baseCommit,
      store: this.store,
      playbooks: new DirPlaybooks(),
      batchId: ctx.batchId,
      factoryVersion: factoryVersion(),
      playbookHash: await playbookHash(),
      heartbeatMs: 60_000,
    };
  }

  async benchmark(opts: BenchOptions, ctx: JobContext): Promise<string> {
    const issues = await loadIssues(undefined, opts.split);
    if (opts.kind === "reference") {
      const { bench } = await this.fixture(ctx);
      ctx.log("Scoring the reference solutions with the hidden tests…");
      const score = await scoreCandidate({
        repo: bench.dir,
        candidateRef: bench.referenceBranches.all!,
        issues,
        triage: Object.fromEntries(issues.map((i) => [i.number, i.expectedTriage])),
      });
      await appendResult(
        {
          at: new Date().toISOString(),
          label: "reference",
          factoryVersion: factoryVersion(),
          playbookHash: await playbookHash(),
          models: {},
          costUsd: 0,
          split: opts.split,
          score,
        },
        this.benchResultsFile,
      );
      return `Reference: ${score.resolved}/${score.total} resolved`;
    }
    const all = await loadIssues();
    const run = await benchmarkOnce({
      split: opts.split,
      runner: demoRunner(all, { factor: this.speed.factor * 0.5 }),
      runsRoot: this.runsRoot,
      resultsFile: this.benchResultsFile,
      label: "demo factory",
      events: ctx.events,
      batchId: ctx.batchId,
      signal: ctx.cancel,
      log: (m) => ctx.log(m),
    });
    return `Factory: ${run.score.resolved}/${run.score.total} resolved · triage ${Math.round((run.triageAccuracy ?? 0) * 100)}% · $${run.costUsd.toFixed(2)} (simulated)`;
  }

  async improve(opts: { maxUsd: number }, ctx: JobContext): Promise<string> {
    const all = await loadIssues();
    const fast = { factor: this.speed.factor * 0.3 };
    const report = await improve({
      runner: demoRetro(fast),
      retro: benchConfig().stages.retro,
      playbooksDir: join(BENCH_ROOT, "..", "..", "playbooks"),
      history: new History(this.historyFile),
      promoter: demoPromoter,
      maxUsd: opts.maxUsd,
      repeat: 1,
      noiseBand: 0.05,
      log: (m) => ctx.log(m),
      onActivity: (a) => ctx.events({ type: "agent.activity", issue: 0, stage: "retro", attempt: 1, ...a }),
      collect: async (budget) => {
        ctx.log("Collecting failures: train-split benchmark run");
        const run = await benchmarkOnce({
          split: "train",
          runner: demoRunner(all, fast),
          runsRoot: this.runsRoot,
          record: false,
          events: ctx.events,
          batchId: ctx.batchId,
          signal: ctx.cancel,
        });
        budget.charge(run.costUsd);
        return fromBenchRun(run);
      },
      evaluate: async ({ playbooksDir }) => {
        ctx.log(
          `Evaluating ${playbooksDir.includes("candidate") ? "candidate" : "current playbooks"} on holdout`,
        );
        return toScores(
          await benchmarkOnce({
            split: "holdout",
            playbooksDir,
            runner: demoRunner(all, fast),
            runsRoot: this.runsRoot,
            resultsFile: this.benchResultsFile,
            label: "improve:eval (demo)",
            events: ctx.events,
            batchId: ctx.batchId,
            signal: ctx.cancel,
          }),
        );
      },
    });
    const c = report.candidates[0];
    return c ? `Candidate ${c.decision}${c.prUrl ? ` → ${c.prUrl}` : ""}` : "No failures to learn from";
  }

  revert(candidateId: string): Promise<string> {
    return revertCandidate(candidateId, new History(this.historyFile), demoPromoter);
  }
}
