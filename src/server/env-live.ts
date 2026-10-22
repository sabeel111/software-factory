// Live environment: the real factory (GitHub + Claude), exactly the CLI's code paths.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { context7Server, ClaudeAgentRunner } from "../agents/claude-runner.js";
import { BENCH_ROOT, loadIssues, prepareBenchRepo } from "../bench/benchmark.js";
import { benchmarkOnce } from "../bench/run-factory.js";
import { appendResult, scoreCandidate } from "../bench/score.js";
import { createProvider, githubToken, repoUrl } from "../commands/factory-setup.js";
import { revertImprovement, runImprove } from "../commands/improve.js";
import { resolveRepos, type FactoryConfig } from "../config.js";
import { ClaimingIssueSource } from "../issues/claims.js";
import { GitHubClient } from "../issues/github.js";
import { DirPlaybooks } from "../pipeline/playbooks.js";
import { GitHubPrSink } from "../pipeline/pr.js";
import { AuditLog } from "../store/audit.js";
import { factoryVersion, playbookHash, RunStore } from "../store/run-store.js";
import type { BenchOptions, EnvInfo, Environment, JobContext, StartBatchOptions } from "./controller.js";

export class LiveEnvironment implements Environment {
  readonly mode = "live" as const;
  readonly runsRoot = "runs";
  readonly store = new RunStore(this.runsRoot);
  readonly benchResultsFile = join(BENCH_ROOT, "..", "results.jsonl");
  readonly historyFile = join(BENCH_ROOT, "..", "..", "playbooks", "HISTORY.jsonl");
  private readonly config: FactoryConfig;
  private readonly extraRepos: number;

  constructor(top: FactoryConfig) {
    const repos = resolveRepos(top);
    this.config = repos[0]!;
    this.extraRepos = repos.length - 1;
  }

  private github(onWrite?: (e: { method: string; path: string; status: number }) => void): GitHubClient {
    const token = githubToken();
    if (!token)
      throw new Error("Set GITHUB_TOKEN (issues:write and pull_requests:write on the repo) and restart.");
    return new GitHubClient({ token, repo: this.config.repo, onWrite });
  }

  async describe(): Promise<EnvInfo> {
    const c = this.config;
    const provider = await createProvider(c);
    const warnings = [...provider.warnings()];
    if (this.extraRepos > 0)
      warnings.push(
        `The UI runs ${c.repo} only; ${this.extraRepos} more repo(s) in the config run from the CLI.`,
      );
    if (!githubToken()) warnings.push("GITHUB_TOKEN is not set: batches can't start.");
    if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      warnings.push(
        "No ANTHROPIC_API_KEY in the environment: agents rely on a Claude Code login on this machine.",
      );
    }
    return {
      mode: "live",
      repo: c.repo,
      provider: c.sandbox.provider,
      prMode: c.prMode,
      checks: c.checks,
      limits: { ...c.limits },
      stages: c.stages,
      protectedPaths: c.protectedPaths,
      blockedTools: c.blockedTools,
      warnings,
      credentials: {
        github: Boolean(githubToken()),
        anthropic: Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN),
        context7: Boolean(process.env.CONTEXT7_API_KEY),
      },
      costNote: `Real Claude usage: up to $${c.limits.maxCostUsdPerIssue} per issue and $${c.limits.maxCostUsdPerRun} per batch.`,
    };
  }

  async readyIssues() {
    const issues = new ClaimingIssueSource(this.github());
    return (await issues.listReady()).map((i) => ({ number: i.number, title: i.title, labels: i.labels }));
  }

  async prepareBatch(opts: StartBatchOptions, ctx: JobContext) {
    const config = structuredClone(this.config);
    if (opts.concurrency) config.limits.concurrency = opts.concurrency;
    if (opts.maxCostUsdPerRun)
      config.limits.maxCostUsdPerRun = Math.min(opts.maxCostUsdPerRun, this.config.limits.maxCostUsdPerRun);
    const audit = new AuditLog();
    const gh = this.github((e) => void audit.record({ batchId: ctx.batchId, actor: "factory", ...e }));
    await gh.checkAccess();
    const provider = await createProvider(config, {
      token: githubToken(),
      onPush: (branch) =>
        void audit.record({
          batchId: ctx.batchId,
          actor: "factory",
          method: "PUSH",
          path: `${config.repo}:${branch}`,
          status: 0,
        }),
    });
    for (const w of provider.warnings()) ctx.log(w, "warn");
    const swept = await provider.sweep();
    if (swept.length) ctx.log(`Cleaned up ${swept.length} sandbox(es) left by a previous crash`);
    ctx.log("Preparing the repository snapshot…");
    const snapshot = await provider.prepareSnapshot({
      repoUrl: repoUrl(config),
      ref: config.defaultBranch,
      setup: config.sandbox.setup,
    });
    return {
      config,
      runner: new ClaudeAgentRunner(),
      issues: new ClaimingIssueSource(gh),
      prs: new GitHubPrSink(gh),
      provider,
      snapshot,
      baseCommit: await provider.snapshotCommit(snapshot),
      store: this.store,
      playbooks: new DirPlaybooks(),
      batchId: ctx.batchId,
      factoryVersion: factoryVersion(),
      playbookHash: await playbookHash(),
      workerMcpServers: config.docs.context7 ? context7Server() : undefined,
      only: opts.issues?.length ? opts.issues : undefined,
    };
  }

  async benchmark(opts: BenchOptions, ctx: JobContext): Promise<string> {
    const issues = await loadIssues(undefined, opts.split);
    if (opts.kind === "reference") {
      const work = await mkdtemp(join(tmpdir(), "factory-ref-"));
      try {
        const bench = await prepareBenchRepo(join(work, "repo"));
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
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    }
    const run = await benchmarkOnce({
      split: opts.split,
      config: { stages: this.config.stages, limits: this.config.limits },
      label: `ui:${opts.split}`,
      events: ctx.events,
      batchId: ctx.batchId,
      signal: ctx.cancel,
      log: (m) => ctx.log(m),
    });
    return `Factory: ${run.score.resolved}/${run.score.total} resolved · $${run.costUsd.toFixed(2)}`;
  }

  async improve(opts: { maxUsd: number }, ctx: JobContext): Promise<string> {
    const report = await runImprove(this.config, {
      maxUsd: opts.maxUsd,
      log: (m) => ctx.log(m),
      events: ctx.events,
      batchId: ctx.batchId,
      signal: ctx.cancel,
    });
    const accepted = report.candidates.find((c) => c.prUrl);
    return accepted
      ? `Accepted ${accepted.candidateId} → ${accepted.prUrl}`
      : `${report.candidates.length} candidate(s), none accepted · $${report.spentUsd.toFixed(2)}`;
  }

  revert(candidateId: string): Promise<string> {
    return revertImprovement(this.config, candidateId);
  }
}
