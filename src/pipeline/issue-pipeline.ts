// One issue end to end: Triage → Worker → Verifier → Reviewer → PR (specs/05-single-issue-pipeline.md).
import { join } from "node:path";
import type { z } from "zod";
import { READ_ONLY_TOOLS, errorCost, type AgentRunner, type ToolName } from "../agents/runner.js";
import type { FactoryConfig, StageConfig } from "../config.js";
import {
  ReviewResult,
  TriageResult,
  WorkerAgentOutput,
  type IssueRef,
  type RunOutcome,
  type RunRecord,
  type StageName,
  type StageRecord,
  type VerifierResult,
  type WorkerResult,
} from "../contracts/index.js";
import { ClaimLost, LABELS, type IssueSource, type ReleaseOutcome } from "../issues/types.js";
import type { Sandbox, SandboxProvider, SnapshotId } from "../sandbox/types.js";
import type { RunStore } from "../store/run-store.js";
import { Budget, BudgetExceeded } from "./budget.js";
import type { Playbooks } from "./playbooks.js";
import { clip, compactResult, type EventSink } from "../events/types.js";
import { issuePrBody, type PrSink } from "./pr.js";
import { verify } from "./verifier.js";

export const WORKER_TOOLS: readonly ToolName[] = ["Read", "Write", "Edit", "Glob", "Grep", "Bash"];
const MAX_DIFF_CHARS = 150_000;

export interface PipelineDeps {
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
  factoryVersion: string;
  playbookHash: string;
  batchBudget?: Budget;
  /** MCP servers given to the worker (docs grounding). */
  workerMcpServers?: Record<string, unknown>;
  heartbeatMs?: number;
  signal?: AbortSignal;
  log?: (message: string) => void;
  /** Structured event stream for the control UI (specs/09-control-ui.md). */
  events?: EventSink;
  /** Progress callback for `factory status` / live display. */
  onProgress?: (record: RunRecord, stage: StageName | "done", attempt: number) => void;
}

export interface IssueRunResult {
  record: RunRecord;
  outcome: RunOutcome | "lost_claim";
  /** Present when the change passed verification and review. */
  approved?: {
    branch: string;
    commitSha: string;
    triage: TriageResult;
    verification: VerifierResult;
    review: ReviewResult;
  };
}

class Cancelled extends Error {
  override name = "Cancelled";
}

function shortId(runId: string): string {
  return runId.replace(/[^A-Za-z0-9]/g, "").slice(-8);
}

export function issueBranch(issue: number, runId: string): string {
  return `factory/issue-${issue}-${shortId(runId)}`;
}

function verifierFeedback(v: VerifierResult) {
  return {
    status: v.status,
    failingChecks: v.checks
      .filter((c) => c.exitCode !== 0)
      .map((c) => ({ name: c.name, command: c.command, exitCode: c.exitCode, outputTail: c.outputTail })),
    testSummary: v.testSummary,
  };
}

export async function runIssue(issue: IssueRef, runId: string, deps: PipelineDeps): Promise<IssueRunResult> {
  const { config, store } = deps;
  const log = deps.log ?? (() => undefined);
  const record: RunRecord = {
    runId,
    batchId: deps.batchId,
    issue,
    startedAt: new Date().toISOString(),
    factoryVersion: deps.factoryVersion,
    playbookHash: deps.playbookHash,
    stages: [],
  };

  const emit = deps.events ?? (() => undefined);
  const claim = await deps.issues.claim(issue.number, runId);
  if (!claim.won) {
    log(`#${issue.number}: lost claim to ${claim.holder ?? "another run"}`);
    emit({
      type: "issue.skipped",
      issue: issue.number,
      reason: `claimed by ${claim.holder ?? "another run"}`,
    });
    return { record, outcome: "lost_claim" };
  }
  if (!(await deps.issues.isEligible(issue.number))) {
    // Another run finished it between our listing and our claim.
    await deps.issues.release(issue.number, runId, "abandoned");
    log(`#${issue.number}: no longer ready; skipping`);
    emit({ type: "issue.skipped", issue: issue.number, reason: "no longer ready" });
    return { record, outcome: "lost_claim" };
  }
  emit({ type: "issue.claimed", issue: issue.number, title: issue.title, runId });

  const budget = deps.batchBudget
    ? deps.batchBudget.child(config.limits.maxCostUsdPerIssue)
    : new Budget(config.limits.maxCostUsdPerIssue);
  const sandboxes: Sandbox[] = [];
  let released = false;
  let claimLost = false;
  const heartbeat = setInterval(
    () => {
      deps.issues.heartbeat(issue.number, runId).catch((e) => {
        if (e instanceof ClaimLost) claimLost = true;
      });
    },
    deps.heartbeatMs ?? 5 * 60_000,
  );
  heartbeat.unref?.();

  const persist = () => store.append(record);
  const release = async (outcome: ReleaseOutcome) => {
    released = true;
    await deps.issues.release(issue.number, runId, outcome);
  };
  const checkpoint = (what: string) => {
    if (deps.signal?.aborted) throw new Cancelled(`cancelled before ${what}`);
    if (claimLost) throw new Cancelled(`claim lost before ${what}`);
    budget.ensure(what);
  };
  const newSandbox = async (label: string) => {
    const s = await deps.provider.create({ snapshot: deps.snapshot, label: `${issue.number}-${label}` });
    sandboxes.push(s);
    return s;
  };

  async function agentStage<T>(
    stage: StageName,
    attempt: number,
    schema: z.ZodType<T>,
    input: unknown,
    box: Sandbox,
    tools: readonly ToolName[],
    mcpServers?: Record<string, unknown>,
  ): Promise<T> {
    const cwd = box.path;
    checkpoint(`${stage} attempt ${attempt}`);
    deps.onProgress?.(record, stage, attempt);
    emit({ type: "stage.started", issue: issue.number, stage, attempt });
    const settings = (config.stages as Record<string, StageConfig>)[stage]!;
    const allowedTools = tools.filter((t) => !config.blockedTools.includes(t));
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const entry: StageRecord = {
      stage,
      attempt,
      startedAt,
      durationMs: 0,
      costUsd: 0,
      tokens: { input: 0, output: 0 },
      output: null,
    };
    try {
      const r = await deps.runner.run({
        stage,
        issue: issue.number,
        attempt,
        playbook: await deps.playbooks.get(stage),
        input,
        outputSchema: schema,
        cwd,
        tools: allowedTools,
        provider: settings.provider,
        model: settings.model,
        effort: settings.effort,
        maxTurns: settings.maxTurns,
        maxBudgetUsd: budget.remaining,
        timeoutSec: config.limits.stageTimeoutSec,
        mcpServers,
        transcriptPath: join(store.artifactDir(deps.batchId, runId), `${stage}-${attempt}.jsonl`),
        signal: deps.signal,
        runtime: box.agentRuntime?.(),
        onActivity: (a) =>
          emit({ type: "agent.activity", issue: issue.number, stage, attempt, ...a, detail: clip(a.detail) }),
      });
      budget.charge(r.costUsd);
      Object.assign(entry, { costUsd: r.costUsd, tokens: r.usage, output: r.output });
      return r.output;
    } catch (e) {
      const cost = errorCost(e);
      budget.charge(cost);
      entry.costUsd = cost;
      entry.error = `${(e as Error).name}: ${(e as Error).message}`;
      throw e;
    } finally {
      entry.durationMs = Date.now() - t0;
      record.stages.push(entry);
      emit({
        type: "stage.finished",
        issue: issue.number,
        stage,
        attempt,
        durationMs: entry.durationMs,
        costUsd: entry.costUsd,
        ok: !entry.error,
        result: compactResult(entry.output),
        error: entry.error ? clip(entry.error, 400) : undefined,
      });
      await persist();
    }
  }

  function codeStage(stage: StageName, attempt: number, output: unknown, durationMs: number) {
    record.stages.push({
      stage,
      attempt,
      startedAt: new Date(Date.now() - durationMs).toISOString(),
      durationMs,
      costUsd: 0,
      tokens: { input: 0, output: 0 },
      output,
    });
    return persist();
  }

  const finish = async (outcome: RunOutcome, releaseAs: ReleaseOutcome): Promise<IssueRunResult> => {
    record.outcome = outcome;
    record.finishedAt = new Date().toISOString();
    await persist();
    if (!released) await release(releaseAs);
    deps.onProgress?.(record, "done", 0);
    emit({
      type: "issue.finished",
      issue: issue.number,
      outcome,
      costUsd: budget.spent,
      prUrl: record.prUrl,
      branch: record.branch,
    });
    return { record, outcome };
  };

  try {
    // ── Triage ────────────────────────────────────────────────────────────────
    const triageBox = await newSandbox("triage");
    const triage = await agentStage(
      "triage",
      1,
      TriageResult,
      { issue, repository: { defaultBranch: config.defaultBranch, checks: config.checks } },
      triageBox,
      READ_ONLY_TOOLS,
    );
    await triageBox.destroy();
    if (triage.decision === "reject") {
      const questions = triage.clarifyingQuestions.map((q) => `- ${q}`).join("\n");
      await deps.issues.comment(
        issue.number,
        `🏭 The software factory needs more information before it can work on this issue.\n\n${triage.reason}\n\n${questions}\n\nRemove the \`${LABELS.needsInfo}\` label once the issue is updated.`,
      );
      return await finish("rejected", "needs-info");
    }

    // ── Worker ⇄ Verifier ⇄ Reviewer ─────────────────────────────────────────
    const branch = issueBranch(issue.number, runId);
    record.branch = branch;
    const workBox = await newSandbox("worker");
    let feedback: Record<string, unknown> | undefined;
    let lastFailure = "";

    for (let attempt = 1; attempt <= config.limits.maxWorkerAttempts; attempt++) {
      let worker: WorkerResult;
      try {
        const out = await agentStage(
          "worker",
          attempt,
          WorkerAgentOutput,
          {
            issue,
            acceptanceCriteria: triage.acceptanceCriteria,
            kind: triage.kind,
            attempt,
            maxAttempts: config.limits.maxWorkerAttempts,
            checks: config.checks,
            ...(feedback ? { feedback } : {}),
          },
          workBox,
          WORKER_TOOLS,
          deps.workerMcpServers,
        );
        const commitSha = await workBox.commit(
          `factory: #${issue.number} ${issue.title} (attempt ${attempt})`,
        );
        await workBox.push(branch);
        worker = { ...out, branch, commitSha };
        record.commitSha = commitSha;
      } catch (e) {
        if (e instanceof BudgetExceeded || e instanceof Cancelled) throw e;
        if (deps.signal?.aborted) throw new Cancelled("cancelled during worker");
        lastFailure = `worker attempt ${attempt} failed: ${(e as Error).message}`;
        log(`#${issue.number}: ${lastFailure}`);
        feedback = { error: lastFailure };
        continue;
      }

      if (worker.status === "blocked") {
        lastFailure = `worker blocked: ${worker.blockedReason ?? worker.summary}`;
        break;
      }

      checkpoint(`verifier attempt ${attempt}`);
      deps.onProgress?.(record, "verifier", attempt);
      emit({ type: "stage.started", issue: issue.number, stage: "verifier", attempt });
      const t0 = Date.now();
      const { result: verification, sandbox: cleanBox } = await verify({
        provider: deps.provider,
        snapshot: deps.snapshot,
        commitSha: worker.commitSha,
        baseCommit: deps.baseCommit,
        checks: config.checks,
        protectedPaths: config.protectedPaths,
        timeoutSec: config.limits.stageTimeoutSec,
        label: `${issue.number}-verify-${attempt}`,
      });
      sandboxes.push(cleanBox);
      for (const c of verification.checks) {
        emit({
          type: "verifier.check",
          issue: issue.number,
          attempt,
          name: c.name,
          exitCode: c.exitCode,
          durationMs: c.durationMs,
          tests: verification.testSummary,
          outputTail: c.outputTail.slice(-1500),
        });
      }
      emit({
        type: "stage.finished",
        issue: issue.number,
        stage: "verifier",
        attempt,
        durationMs: Date.now() - t0,
        costUsd: 0,
        ok: verification.status === "pass",
        result: {
          status: verification.status,
          testSummary: verification.testSummary,
          commitSha: verification.commitSha,
        },
      });
      await codeStage("verifier", attempt, verification, Date.now() - t0);
      if (verification.status !== "pass") {
        lastFailure = `verification ${verification.status}: ${verification.checks
          .filter((c) => c.exitCode !== 0)
          .map((c) => c.name)
          .join(", ")}`;
        feedback = { verifier: verifierFeedback(verification) };
        await cleanBox.destroy();
        continue;
      }

      const diff = await cleanBox.exec(`git diff ${deps.baseCommit} ${worker.commitSha}`);
      const reviewOut = await agentStage(
        "reviewer",
        attempt,
        ReviewResult,
        {
          issue,
          acceptanceCriteria: triage.acceptanceCriteria,
          diff:
            diff.stdout.length > MAX_DIFF_CHARS
              ? diff.stdout.slice(0, MAX_DIFF_CHARS) + "\n…(diff truncated)"
              : diff.stdout,
          verification: {
            status: verification.status,
            testSummary: verification.testSummary,
            checks: verification.checks.map((c) => ({ name: c.name, exitCode: c.exitCode })),
          },
        },
        cleanBox,
        READ_ONLY_TOOLS,
      );
      await cleanBox.destroy();
      // Any blocker forces request_changes, whatever verdict the agent wrote.
      const review: ReviewResult = reviewOut.findings.some((f) => f.severity === "blocker")
        ? { ...reviewOut, verdict: "request_changes" }
        : reviewOut;
      if (review.verdict === "request_changes") {
        lastFailure = `review requested changes (${review.findings.length} findings)`;
        feedback = { review };
        continue;
      }

      // ── Approved ─────────────────────────────────────────────────────────────
      const approved = { branch, commitSha: worker.commitSha, triage, verification, review };
      if (config.prMode === "individual") {
        const pr = await deps.prs.createDraft({
          head: branch,
          base: config.defaultBranch,
          title: `#${issue.number}: ${issue.title}`,
          body: issuePrBody({ issue, triage, verification, review, costUsd: budget.spent, runId }),
        });
        await deps.prs.label(pr.number, [LABELS.pr]);
        await deps.issues.addLabels(issue.number, [LABELS.pr]);
        record.prUrl = pr.url;
        const result = await finish("pr_opened", "done");
        return { ...result, approved };
      }
      const result = await finish("ready_to_integrate", "done");
      return { ...result, approved };
    }

    await deps.issues.comment(
      issue.number,
      `🏭 The software factory gave up on this issue after ${config.limits.maxWorkerAttempts} attempt(s).\n\nLast failure: ${lastFailure}\n\nRun \`${runId}\`; details are in the factory's run records.`,
    );
    return await finish("failed", "failed");
  } catch (e) {
    if (e instanceof BudgetExceeded) {
      const batchOut = deps.batchBudget?.exhausted ?? false;
      log(`#${issue.number}: ${e.message}`);
      return await finish("budget_exceeded", batchOut ? "abandoned" : "failed");
    }
    if (e instanceof Cancelled || deps.signal?.aborted) {
      log(`#${issue.number}: ${(e as Error).message}`);
      return await finish("cancelled", "abandoned");
    }
    log(`#${issue.number}: run crashed: ${(e as Error).stack ?? e}`);
    record.error = `crash: ${(e as Error).message}`;
    return await finish("failed", "abandoned");
  } finally {
    clearInterval(heartbeat);
    await Promise.allSettled(sandboxes.map((s) => s.destroy()));
    if (!released) await deps.issues.release(issue.number, runId, "abandoned").catch(() => undefined);
  }
}
