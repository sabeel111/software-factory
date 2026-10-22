// `factory improve`: propose, evaluate and promote playbook improvements; or revert one.
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ClaudeAgentRunner } from "../agents/claude-runner.js";
import { BENCH_ROOT, loadIssues } from "../bench/benchmark.js";
import { benchmarkOnce, type BenchRun } from "../bench/run-factory.js";
import type { BenchResultEntry } from "../bench/score.js";
import { registerCommand } from "../cli.js";
import { loadConfig } from "../config.js";
import type { EvalScores } from "../improve/candidate.js";
import { fromBenchRun, isVisible } from "../improve/collect.js";
import { History } from "../improve/history.js";
import { improve, revertCandidate, type Promoter } from "../improve/improve.js";
import { GitPromoter } from "../improve/promoter.js";
import { GitHubClient } from "../issues/github.js";
import { LABELS } from "../issues/types.js";
import { DEFAULT_PLAYBOOK_DIR } from "../pipeline/playbooks.js";
import { GitHubPrSink, LocalBranchPrSink } from "../pipeline/pr.js";
import { gitHubAuthEnv } from "../sandbox/worktree.js";
import { playbookHash, RunStore } from "../store/run-store.js";
import { githubToken } from "./factory-setup.js";

export function toScores(run: BenchRun): EvalScores {
  return {
    resolveRate: run.score.resolveRate,
    triageAccuracy: run.triageAccuracy,
    falsePassRate: run.falsePassRate,
    costPerResolved: run.costPerResolved,
    costUsd: run.costUsd,
  };
}

/** Holdout scores already recorded for the current playbooks, newest last. */
async function cachedChampion(hash: string): Promise<EvalScores[]> {
  const file = join(BENCH_ROOT, "..", "results.jsonl");
  if (!existsSync(file)) return [];
  const entries = (await readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as BenchResultEntry)
    .filter((e) => e.playbookHash === hash && e.split === "holdout" && e.label.startsWith("improve:"));
  return entries.map((e) => ({
    resolveRate: e.score.resolveRate,
    triageAccuracy: e.score.triageAccuracy,
    falsePassRate: e.falsePassRate ?? null,
    costPerResolved: e.score.resolved ? e.costUsd / e.score.resolved : null,
    costUsd: e.costUsd,
  }));
}

registerCommand("improve", async (opts) => {
  const config = await loadConfig(String(opts.config));
  const token = githubToken();
  const gh = config.selfRepo && token ? new GitHubClient({ token, repo: config.selfRepo }) : undefined;
  const promoter: Promoter = new GitPromoter({
    repoDir: join(DEFAULT_PLAYBOOK_DIR, ".."),
    baseBranch: "main",
    from: "HEAD",
    prs: gh ? new GitHubPrSink(gh) : new LocalBranchPrSink(),
    gitEnv: token ? gitHubAuthEnv(token) : undefined,
  });
  const history = new History(join(DEFAULT_PLAYBOOK_DIR, "HISTORY.jsonl"));

  if (opts.revert) {
    const url = await revertCandidate(String(opts.revert), history, promoter);
    console.log(`Revert proposed: ${url}`);
    return 0;
  }

  const repeat = 3;
  const hash = await playbookHash();
  const champion = (await cachedChampion(hash)).slice(-repeat);
  const benchIssues = await loadIssues();
  const report = await improve({
    runner: new ClaudeAgentRunner(),
    retro: config.stages.retro,
    playbooksDir: DEFAULT_PLAYBOOK_DIR,
    history,
    promoter,
    maxUsd: Number(opts.maxUsd ?? 30),
    repeat,
    championScores: champion.length ? champion : undefined,
    log: (m) => console.log(m),
    collect: async (budget) => {
      console.log("Collecting: train-split benchmark run with the current playbooks…");
      const run = await benchmarkOnce({ split: "train", label: "improve:collect" });
      budget.charge(run.costUsd);
      const real = (await new RunStore().all())
        .filter((r) => r.issue.repo !== "bench/tinylinks")
        .map((record) => ({ record, ctx: {}, visible: isVisible(record, benchIssues) }));
      return [...fromBenchRun(run), ...real];
    },
    evaluate: async ({ playbooksDir }) => {
      console.log("Evaluating on holdout…");
      return toScores(await benchmarkOnce({ split: "holdout", playbooksDir, label: "improve:eval" }));
    },
    fileSelfIssue: gh
      ? async (title, body) => void (await gh.createIssue({ title, body, labels: [LABELS.self] }))
      : async (title) => console.log(`Suggested factory issue (no selfRepo configured): ${title}`),
  });

  console.log(
    `\nFailure clusters: ${report.clusters.map((c) => `${c.code}×${c.count}`).join(", ") || "none"}`,
  );
  for (const c of report.candidates) {
    console.log(`- ${c.candidateId}: ${c.decision}${c.prUrl ? ` → ${c.prUrl}` : ""}\n  ${c.hypothesis}`);
  }
  console.log(`Spent $${report.spentUsd.toFixed(2)} of $${Number(opts.maxUsd ?? 30).toFixed(2)}`);
  return 0;
});
