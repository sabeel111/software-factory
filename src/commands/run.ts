// `factory run`: pull ready issues from GitHub and run a batch.
import { createInterface } from "node:readline/promises";
import { context7Server, ClaudeAgentRunner } from "../agents/claude-runner.js";
import { registerCommand } from "../cli.js";
import { loadConfig, resolveRepos } from "../config.js";
import type { RunRecord } from "../contracts/index.js";
import { ClaimingIssueSource } from "../issues/claims.js";
import { GitHubClient } from "../issues/github.js";
import { installSignalHandlers, runRepos, type BatchDeps } from "../orchestrator/batch.js";
import { AuditLog } from "../store/audit.js";
import { renderStatus } from "../orchestrator/status.js";
import { DirPlaybooks } from "../pipeline/playbooks.js";
import { GitHubPrSink } from "../pipeline/pr.js";
import { factoryVersion, newId, playbookHash, RunStore } from "../store/run-store.js";
import { createProvider, githubToken, repoUrl } from "./factory-setup.js";

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

registerCommand("run", async (opts) => {
  const top = await loadConfig(String(opts.config));
  if (opts.concurrency) top.limits.concurrency = Number(opts.concurrency);
  const repos = resolveRepos(top);
  const only = opts.issue
    ? String(opts.issue)
        .split(",")
        .map((n) => Number(n.trim()))
    : undefined;

  const token = githubToken();
  if (!token) {
    console.error("factory run: set GITHUB_TOKEN (needs issues:write and pull_requests:write on the repo).");
    return 1;
  }
  const audit = new AuditLog();
  const batchId = newId("b");

  // Intake for every repo first, so the user confirms one combined plan.
  const plans = [];
  for (const config of repos) {
    const gh = new GitHubClient({
      token,
      repo: config.repo,
      onWrite: (e) => void audit.record({ batchId, actor: "factory", ...e }),
    });
    await gh.checkAccess();
    const issues = new ClaimingIssueSource(gh);
    const ready = (await issues.listReady()).filter((i) => !only || only.includes(i.number));
    plans.push({ config, gh, issues, ready });
  }
  const total = plans.reduce((n, p) => n + p.ready.length, 0);
  if (total === 0) {
    console.log("No issues labeled factory:ready.");
    return 0;
  }
  console.log(`Batch ${batchId}: ${total} ready issue(s)`);
  for (const p of plans) for (const i of p.ready) console.log(`  ${p.config.repo}#${i.number} ${i.title}`);
  console.log(
    `Limits: concurrency ${top.limits.concurrency}, $${top.limits.maxCostUsdPerIssue}/issue, $${top.limits.maxCostUsdPerRun}/batch, PR mode ${top.prMode}`,
  );
  if (!opts.yes && !(await confirm("Start? [y/N] "))) {
    console.log("Not started. Pass --yes to skip this prompt.");
    return 0;
  }

  const store = new RunStore();
  const signals = installSignalHandlers();
  try {
    const batches = [];
    for (const p of plans.filter((x) => x.ready.length > 0)) {
      const { config } = p;
      const provider = await createProvider(config, {
        token,
        onPush: (branch) =>
          void audit.record({
            batchId,
            actor: "factory",
            method: "PUSH",
            path: `${config.repo}:${branch}`,
            status: 0,
          }),
      });
      for (const w of provider.warnings()) console.warn(`⚠ ${w}`);
      const swept = await provider.sweep();
      if (swept.length) console.log(`Cleaned up ${swept.length} sandbox(es) left by a previous crash.`);
      const snapshot = await provider.prepareSnapshot({
        repoUrl: repoUrl(config),
        ref: config.defaultBranch,
        setup: config.sandbox.setup,
      });
      batches.push({
        config,
        runner: new ClaudeAgentRunner(),
        issues: p.issues,
        prs: new GitHubPrSink(p.gh),
        provider,
        snapshot,
        baseCommit: await provider.snapshotCommit(snapshot),
        store,
        playbooks: new DirPlaybooks(),
        batchId: repos.length > 1 ? `${batchId}-${config.repo.replace("/", "-")}` : batchId,
        factoryVersion: factoryVersion(),
        playbookHash: await playbookHash(),
        workerMcpServers: config.docs.context7 ? context7Server() : undefined,
        only,
        drain: signals.drain.signal,
        cancel: signals.cancel.signal,
        log: (m: string) => console.log(m),
        onProgress: (r: RunRecord, stage: string, attempt: number) =>
          console.log(
            `  ${r.issue.repo}#${r.issue.number} ${stage === "done" ? `→ ${r.outcome}` : `${stage}${attempt > 1 ? ` (attempt ${attempt})` : ""}`}`,
          ),
      } satisfies BatchDeps);
    }
    const results = await runRepos(batches, top.limits);
    for (const [i, result] of results.entries()) {
      console.log(`\n${batches[i]!.config.repo}\n` + renderStatus(await store.latest(result.batchId)));
      if (result.integration?.prUrl) console.log(`Integration PR: ${result.integration.prUrl}`);
      for (const r of result.results)
        if (r.record.prUrl) console.log(`PR for #${r.record.issue.number}: ${r.record.prUrl}`);
      if (result.unstarted.length) {
        console.log(`Not started: ${result.unstarted.map((u) => `#${u.issue} (${u.reason})`).join(", ")}`);
      }
    }
    return 0;
  } finally {
    signals.dispose();
  }
});

registerCommand("status", async (opts, positional) => {
  const store = new RunStore(String(opts.runs ?? "runs"));
  const batchId = positional[0] ?? (await store.batches()).at(-1);
  if (!batchId) {
    console.log("No batches yet.");
    return 0;
  }
  console.log(`Batch ${batchId}\n`);
  console.log(renderStatus(await store.latest(batchId)));
  return 0;
});
