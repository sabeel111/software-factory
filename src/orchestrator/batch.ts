// Batch scheduler: bounded concurrency, global limits, drain/cancel, then integration
// (specs/06-parallel-and-integration.md).
import type { IssueRef } from "../contracts/index.js";
import { Budget } from "../pipeline/budget.js";
import { integrate, type ApprovedChange, type IntegrationOutcome } from "../pipeline/integrator.js";
import { runIssue, type IssueRunResult, type PipelineDeps } from "../pipeline/issue-pipeline.js";
import { newId } from "../store/run-store.js";
import { Semaphore } from "../util/mutex.js";

export interface BatchDeps extends Omit<PipelineDeps, "batchBudget" | "signal"> {
  /** First SIGINT: start nothing new, let in-flight runs finish. */
  drain?: AbortSignal;
  /** Second SIGINT: cancel in-flight runs. */
  cancel?: AbortSignal;
  /** Only these issue numbers. */
  only?: number[];
  /** Fraction of the batch budget after which no new issue starts (default 0.9). */
  stopAtBudgetFraction?: number;
  /** Observed by tests: called with the number of active pipelines whenever it changes. */
  onActive?: (active: number) => void;
}

export interface Unstarted {
  issue: number;
  reason: "budget_exceeded" | "max_open_prs" | "drained";
}

export interface BatchResult {
  batchId: string;
  results: IssueRunResult[];
  unstarted: Unstarted[];
  integration?: IntegrationOutcome;
  costUsd: number;
  wallClockMs: number;
}

export async function runBatch(deps: BatchDeps): Promise<BatchResult> {
  const started = Date.now();
  const { config } = deps;
  const log = deps.log ?? (() => undefined);
  const budget = new Budget(config.limits.maxCostUsdPerRun);
  const stopAt = (deps.stopAtBudgetFraction ?? 0.9) * config.limits.maxCostUsdPerRun;
  const semaphore = new Semaphore(config.limits.concurrency);
  const results: IssueRunResult[] = [];
  const unstarted: Unstarted[] = [];
  const attempted = new Set<number>();
  const running = new Set<Promise<void>>();
  let active = 0;

  // PR-flood control (R5.4): open factory PRs plus PRs this batch may still open.
  let prSlots = Infinity;
  if (config.prMode === "individual") {
    prSlots = config.limits.maxOpenPrs - (await deps.prs.countOpenFactoryPrs());
  }

  const stopReason = (): Unstarted["reason"] | null => {
    if (deps.drain?.aborted || deps.cancel?.aborted) return "drained";
    if (budget.spent >= stopAt) return "budget_exceeded";
    if (prSlots <= 0) return "max_open_prs";
    return null;
  };

  const nextIssue = async (): Promise<IssueRef | undefined> => {
    const ready = await deps.issues.listReady();
    return ready.find((i) => !attempted.has(i.number) && (!deps.only || deps.only.includes(i.number)));
  };

  for (;;) {
    const release = await semaphore.acquire();
    const reason = stopReason();
    const issue = await nextIssue();
    if (!issue) {
      release();
      break;
    }
    if (reason) {
      release();
      // Record everything that is still waiting, then stop pulling.
      for (let i: IssueRef | undefined = issue; i; i = await nextIssue()) {
        attempted.add(i.number);
        unstarted.push({ issue: i.number, reason });
      }
      break;
    }
    attempted.add(issue.number);
    if (config.prMode === "individual") prSlots--;
    active++;
    deps.onActive?.(active);
    const runId = newId(`r${issue.number}-`);
    const p = runIssue(issue, runId, { ...deps, batchBudget: budget, signal: deps.cancel })
      .then((r) => {
        results.push(r);
        // A run that didn't open a PR gives its slot back.
        if (config.prMode === "individual" && r.outcome !== "pr_opened") prSlots++;
      })
      .catch((e: unknown) => log(`#${issue.number}: unexpected error ${(e as Error).stack ?? e}`))
      .finally(() => {
        active--;
        deps.onActive?.(active);
        release();
        running.delete(p);
      });
    running.add(p);
  }
  await Promise.all([...running]);

  let integration: IntegrationOutcome | undefined;
  const approved: ApprovedChange[] = results
    .filter((r) => r.outcome === "ready_to_integrate" && r.approved)
    .map((r) => ({
      issue: r.record.issue,
      branch: r.approved!.branch,
      commitSha: r.approved!.commitSha,
      triage: r.approved!.triage,
      verification: r.approved!.verification,
    }));
  if (config.prMode === "integrated" && approved.length > 0 && !deps.cancel?.aborted) {
    integration = await integrate(approved, { ...deps, budget, signal: deps.cancel });
  }

  return {
    batchId: deps.batchId,
    results,
    unstarted,
    integration,
    costUsd: budget.spent,
    wallClockMs: Date.now() - started,
  };
}

/** First SIGINT drains, second cancels (R5.8). Returns a disposer. */
export function installSignalHandlers(log: (m: string) => void = console.error): {
  drain: AbortController;
  cancel: AbortController;
  dispose: () => void;
} {
  const drain = new AbortController();
  const cancel = new AbortController();
  const onSigint = () => {
    if (!drain.signal.aborted) {
      drain.abort();
      log("\nDraining: no new issues will start. Press Ctrl-C again to cancel in-flight runs.");
    } else if (!cancel.signal.aborted) {
      cancel.abort();
      log("\nCancelling in-flight runs and releasing claims…");
    }
  };
  process.on("SIGINT", onSigint);
  return { drain, cancel, dispose: () => process.off("SIGINT", onSigint) };
}

export { newId };
