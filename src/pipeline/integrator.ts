// Integrator: merge approved branches one at a time, re-verifying after every merge
// (specs/06-parallel-and-integration.md "Integrator").
import { join } from "node:path";
import { errorCost, type AgentRunner } from "../agents/runner.js";
import type { FactoryConfig } from "../config.js";
import {
  ConflictResolution,
  type IntegrationResult,
  type IssueRef,
  type TestSummary,
  type TriageResult,
  type VerifierResult,
} from "../contracts/index.js";
import { LABELS, type IssueSource } from "../issues/types.js";
import type { Sandbox, SandboxProvider, SnapshotId } from "../sandbox/types.js";
import type { RunStore } from "../store/run-store.js";
import { Budget } from "./budget.js";
import { WORKER_TOOLS } from "./issue-pipeline.js";
import type { Playbooks } from "./playbooks.js";
import { checkTable, type PrSink } from "./pr.js";
import { verify } from "./verifier.js";

export interface ApprovedChange {
  issue: IssueRef;
  branch: string;
  commitSha: string;
  triage: TriageResult;
  verification: VerifierResult;
}

export interface IntegratorDeps {
  config: FactoryConfig;
  runner: AgentRunner;
  issues: IssueSource;
  prs: PrSink;
  provider: SandboxProvider;
  snapshot: SnapshotId;
  baseCommit: string;
  store: RunStore;
  playbooks: Playbooks;
  batchId: string;
  budget?: Budget;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

export interface MergeStep {
  issue: number;
  merged: boolean;
  conflicted: boolean;
  repaired: boolean;
  reason?: string;
  verification?: VerifierResult;
  costUsd: number;
}

export interface IntegrationOutcome {
  result: IntegrationResult;
  steps: MergeStep[];
  prUrl?: string;
  costUsd: number;
}

export function totalTests(s: TestSummary | null | undefined): number | null {
  return s ? s.passed + s.failed + s.skipped : null;
}

function priority(labels: string[]): number {
  if (labels.includes("P0")) return 0;
  if (labels.includes("P1")) return 1;
  return 2;
}

async function touchedCount(box: Sandbox, base: string, sha: string): Promise<number> {
  const r = await box.exec(`git diff --name-only ${base} ${sha}`);
  return r.stdout.split("\n").filter(Boolean).length;
}

export async function integrate(
  changes: ApprovedChange[],
  deps: IntegratorDeps,
): Promise<IntegrationOutcome> {
  const { config } = deps;
  const log = deps.log ?? (() => undefined);
  const budget = deps.budget ?? new Budget(config.limits.maxCostUsdPerRun);
  const branch = `factory/integration-${deps.batchId}`;
  const steps: MergeStep[] = [];
  let conflictsResolved = 0;
  let costUsd = 0;

  const box = await deps.provider.create({ snapshot: deps.snapshot, label: "integration" });
  try {
    await box.checkout(deps.baseCommit);

    // Fewest touched files first, then issue priority, then issue number.
    const sized = await Promise.all(
      changes.map(async (c) => ({ c, files: await touchedCount(box, deps.baseCommit, c.commitSha) })),
    );
    sized.sort(
      (a, b) =>
        a.files - b.files ||
        priority(a.c.issue.labels) - priority(b.c.issue.labels) ||
        a.c.issue.number - b.c.issue.number,
    );

    // Baseline test count: the integration branch starts at the base commit.
    const baseline = await verify({
      provider: deps.provider,
      snapshot: deps.snapshot,
      commitSha: deps.baseCommit,
      baseCommit: deps.baseCommit,
      checks: config.checks,
      protectedPaths: config.protectedPaths,
      label: "integration-baseline",
    });
    await baseline.sandbox.destroy();
    let headVerification: VerifierResult = baseline.result;

    const agent = async (
      issue: number,
      attempt: number,
      input: unknown,
    ): Promise<{ output: ConflictResolution | null; cost: number }> => {
      if (budget.exhausted || deps.signal?.aborted) return { output: null, cost: 0 };
      try {
        const r = await deps.runner.run({
          stage: "integrator",
          issue,
          attempt,
          playbook: await deps.playbooks.get("integrator"),
          input,
          outputSchema: ConflictResolution,
          cwd: box.path,
          tools: WORKER_TOOLS,
          model: config.stages.integrator.model,
          effort: config.stages.integrator.effort,
          maxTurns: config.stages.integrator.maxTurns,
          maxBudgetUsd: budget.remaining,
          timeoutSec: config.limits.stageTimeoutSec,
          transcriptPath: join(
            deps.store.artifactDir(deps.batchId, "integration"),
            `integrator-${issue}-${attempt}.jsonl`,
          ),
          signal: deps.signal,
        });
        budget.charge(r.costUsd);
        return { output: r.output, cost: r.costUsd };
      } catch (e) {
        const cost = errorCost(e);
        budget.charge(cost);
        log(`integrator #${issue}: ${(e as Error).message}`);
        return { output: null, cost };
      }
    };

    const conflictMarkers = async () =>
      (await box.exec("git grep -lE '^(<<<<<<<|>>>>>>>)( |$)' -- . ':!node_modules'")).stdout.trim();

    for (const { c } of sized) {
      const step: MergeStep = {
        issue: c.issue.number,
        merged: false,
        conflicted: false,
        repaired: false,
        costUsd: 0,
      };
      steps.push(step);
      const preMerge = (await box.exec("git rev-parse HEAD")).stdout.trim();
      const eject = async (reason: string) => {
        await box.exec("git merge --abort");
        await box.exec(`git reset -q --hard ${preMerge} && git clean -fdq -e node_modules`);
        step.reason = reason;
        log(`integrator: ejected #${c.issue.number} (${reason})`);
      };

      const merge = await box.exec(
        `git -c user.name=software-factory -c user.email=factory@localhost merge --no-ff --no-edit -m "Integrate #${c.issue.number}: ${c.issue.title.replace(/"/g, "'")}" ${c.commitSha}`,
      );
      if (merge.exitCode !== 0) {
        step.conflicted = true;
        const conflicted = (await box.exec("git diff --name-only --diff-filter=U")).stdout
          .split("\n")
          .filter(Boolean);
        const diff = await box.exec(`git diff ${deps.baseCommit} ${c.commitSha}`);
        const { output, cost } = await agent(c.issue.number, 1, {
          task: "resolve-conflicts",
          incoming: {
            issue: c.issue,
            acceptanceCriteria: c.triage.acceptanceCriteria,
            diff: diff.stdout.slice(0, 100_000),
          },
          conflictedFiles: conflicted,
          checks: config.checks,
        });
        step.costUsd += cost;
        if (!output?.resolved || (await conflictMarkers())) {
          await eject("conflict-unresolved");
          continue;
        }
        const commit = await box.exec(
          "git add -A && git -c user.name=software-factory -c user.email=factory@localhost commit -q --no-edit",
        );
        if (commit.exitCode !== 0) {
          await eject("conflict-unresolved");
          continue;
        }
        conflictsResolved++;
      }

      const verifyHead = async () => {
        const sha = (await box.exec("git rev-parse HEAD")).stdout.trim();
        const v = await verify({
          provider: deps.provider,
          snapshot: deps.snapshot,
          commitSha: sha,
          baseCommit: deps.baseCommit,
          checks: config.checks,
          protectedPaths: config.protectedPaths,
          timeoutSec: config.limits.stageTimeoutSec,
          label: `integration-${c.issue.number}`,
        });
        await v.sandbox.destroy();
        return v.result;
      };

      let v = await verifyHead();
      if (v.status !== "pass") {
        const { output, cost } = await agent(c.issue.number, 2, {
          task: "repair-after-merge",
          issue: c.issue,
          acceptanceCriteria: c.triage.acceptanceCriteria,
          failingChecks: v.checks.filter((x) => x.exitCode !== 0),
        });
        step.costUsd += cost;
        if (output) {
          await box.exec(
            "git add -A && git -c user.name=software-factory -c user.email=factory@localhost commit -q -m 'Integrator repair'",
          );
          step.repaired = true;
          v = await verifyHead();
        }
      }
      step.verification = v;
      if (v.status !== "pass") {
        await eject("checks-failed");
        continue;
      }

      // R5.6: conflict resolution must never silently drop tests from either side.
      // Floor: every test already on the integration branch plus every test the branch added.
      const after = totalTests(v.testSummary);
      const head = totalTests(headVerification.testSummary) ?? 0;
      const incoming = totalTests(c.verification.testSummary) ?? 0;
      const base = totalTests(baseline.result.testSummary) ?? 0;
      const floor = Math.max(head, incoming, head + incoming - base);
      if (after !== null && after < floor) {
        await eject("tests-dropped");
        continue;
      }
      step.merged = true;
      headVerification = v;
    }
    costUsd = steps.reduce((sum, s) => sum + s.costUsd, 0);

    const merged = steps.filter((s) => s.merged).map((s) => s.issue);
    const ejected = steps
      .filter((s) => !s.merged)
      .map((s) => ({ issue: s.issue, reason: s.reason ?? "unknown" }));

    for (const e of ejected) {
      await deps.issues.comment(
        e.issue,
        `🏭 This issue's change passed verification and review on its own, but couldn't be integrated with the rest of batch \`${deps.batchId}\` (${e.reason}). It's back in the queue and will be retried on a fresh base.`,
      );
      await deps.issues.addLabels(e.issue, [LABELS.ready]);
    }

    let prUrl: string | undefined;
    if (merged.length > 0) {
      await box.push(branch);
      const byIssue = new Map(changes.map((c) => [c.issue.number, c]));
      const body = [
        "## Integrated issues",
        ...merged.map((n) => `- Closes #${n} — ${byIssue.get(n)!.issue.title}`),
        ...(ejected.length
          ? ["", "## Ejected (re-queued)", ...ejected.map((e) => `- #${e.issue}: ${e.reason}`)]
          : []),
        "",
        "## Per-merge verification",
        ...steps
          .filter((s) => s.merged)
          .map(
            (s) =>
              `<details><summary>#${s.issue}${s.conflicted ? " (conflict resolved)" : ""}${s.repaired ? " (repaired)" : ""}</summary>\n\n${checkTable(s.verification!)}\n\n</details>`,
          ),
        "",
        "---",
        `🏭 Software factory batch \`${deps.batchId}\` · integration cost $${costUsd.toFixed(2)} · draft for human review — the factory never merges.`,
      ].join("\n");
      const pr = await deps.prs.createDraft({
        head: branch,
        base: config.defaultBranch,
        title: `Factory batch ${deps.batchId}: ${merged.map((n) => `#${n}`).join(", ")}`,
        body,
      });
      await deps.prs.label(pr.number, [LABELS.pr]);
      for (const n of merged) await deps.issues.addLabels(n, [LABELS.pr]);
      prUrl = pr.url;
    }

    const result: IntegrationResult = {
      status: ejected.length === 0 ? "integrated" : merged.length > 0 ? "partial" : "failed",
      integrationBranch: branch,
      merged,
      ejected,
      conflictsResolved,
      finalVerification: headVerification,
    };
    return { result, steps, prUrl, costUsd };
  } finally {
    await box.destroy();
  }
}
