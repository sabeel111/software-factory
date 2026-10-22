// LiveState: the one reducer shared by the server and the browser (specs/09-control-ui.md).
// Pure and deterministic — time comes from events, never from the clock — so a replayed batch
// reduces to exactly the state it had live.
import type { ActivityKind, FactoryEvent, JobKind, Stage, Tests } from "./types.js";

/** Where an issue sits on the factory floor. */
export type Column =
  | "queued"
  | "triage"
  | "worker"
  | "verifier"
  | "reviewer"
  | "integration"
  | "shipped"
  | "rejected"
  | "failed"
  | "cancelled";

export const FLOW_COLUMNS: Column[] = [
  "queued",
  "triage",
  "worker",
  "verifier",
  "reviewer",
  "integration",
  "shipped",
];
export const PARKED_COLUMNS: Column[] = ["rejected", "failed", "cancelled"];

export interface StageRun {
  stage: Stage;
  attempt: number;
  startedAt: string;
  durationMs?: number;
  costUsd: number;
  ok?: boolean;
  result?: unknown;
  error?: string;
}

export interface CheckRun {
  attempt: number;
  name: string;
  exitCode: number;
  durationMs: number;
  tests: Tests | null;
  outputTail: string;
  at: string;
}

export interface Activity {
  seq: number;
  at: string;
  issue: number;
  stage: Stage;
  attempt: number;
  kind: ActivityKind;
  tool?: string;
  detail: string;
  isError?: boolean;
}

export interface IssueView {
  number: number;
  title: string;
  labels: string[];
  column: Column;
  stage?: Stage;
  attempt: number;
  active: boolean;
  costUsd: number;
  claimedAt?: string;
  stageStartedAt?: string;
  finishedAt?: string;
  outcome?: string;
  reason?: string;
  prUrl?: string;
  branch?: string;
  runId?: string;
  stages: StageRun[];
  checks: CheckRun[];
  activity: Activity[];
  integration?: { conflicted: boolean; merged: boolean; reason?: string };
}

export type FeedItem =
  | (Activity & { item: "activity" })
  | {
      item: "stage";
      seq: number;
      at: string;
      issue: number;
      stage: Stage;
      attempt: number;
      phase: "start" | "end";
      ok?: boolean;
      costUsd?: number;
      error?: string;
    }
  | {
      item: "check";
      seq: number;
      at: string;
      issue: number;
      attempt: number;
      name: string;
      exitCode: number;
      tests: Tests | null;
    }
  | { item: "issue"; seq: number; at: string; issue: number; outcome: string; prUrl?: string }
  | {
      item: "merge";
      seq: number;
      at: string;
      issue: number;
      conflicted: boolean;
      merged: boolean;
      reason?: string;
    }
  | { item: "log"; seq: number; at: string; message: string; level: "info" | "warn" | "error" }
  | { item: "control"; seq: number; at: string; action: string };

export interface CostPoint {
  at: string;
  usd: number;
}

export interface BatchView {
  batchId: string;
  repo: string;
  mode: "individual" | "integrated";
  limits: {
    concurrency: number;
    maxCostUsdPerRun: number;
    maxCostUsdPerIssue: number;
    maxWorkerAttempts: number;
  };
  startedAt: string;
  finishedAt?: string;
  control?: "draining" | "cancelling";
  costUsd: number;
  costSeries: CostPoint[];
  issues: Record<number, IssueView>;
  order: number[];
  integration?: {
    running: boolean;
    issues: number[];
    merged: number[];
    ejected: { issue: number; reason: string }[];
    prUrl?: string;
  };
  unstarted: { issue: number; reason: string }[];
}

export interface JobView {
  kind: JobKind;
  label: string;
  demo: boolean;
  startedAt: string;
  finishedAt?: string;
  ok?: boolean;
  summary?: string;
  batchId: string;
}

export interface LiveState {
  lastSeq: number;
  job?: JobView;
  batch?: BatchView;
  feed: FeedItem[];
  logs: { at: string; message: string; level: "info" | "warn" | "error" }[];
}

export const FEED_LIMIT = 400;
export const ACTIVITY_LIMIT = 150;
const LOG_LIMIT = 200;

export function initialState(): LiveState {
  return { lastSeq: 0, feed: [], logs: [] };
}

const STAGE_COLUMN: Partial<Record<Stage, Column>> = {
  triage: "triage",
  worker: "worker",
  verifier: "verifier",
  reviewer: "reviewer",
};

function outcomeColumn(outcome: string): Column {
  switch (outcome) {
    case "pr_opened":
      return "shipped";
    case "ready_to_integrate":
      return "integration";
    case "rejected":
      return "rejected";
    case "cancelled":
      return "cancelled";
    default:
      return "failed";
  }
}

function pushCapped<T>(list: T[], item: T, cap: number): T[] {
  const next = list.length >= cap ? list.slice(list.length - cap + 1) : list.slice();
  next.push(item);
  return next;
}

function newIssue(number: number, title: string, labels: string[] = []): IssueView {
  return {
    number,
    title,
    labels,
    column: "queued",
    attempt: 0,
    active: false,
    costUsd: 0,
    stages: [],
    checks: [],
    activity: [],
  };
}

/** Immutable update of one issue in the batch (creating it if a late event names it). */
function withIssue(batch: BatchView, n: number, f: (i: IssueView) => IssueView): BatchView {
  const prev = batch.issues[n] ?? newIssue(n, `Issue #${n}`);
  const order = batch.issues[n] ? batch.order : [...batch.order, n];
  return { ...batch, order, issues: { ...batch.issues, [n]: f(prev) } };
}

function addCost(batch: BatchView, at: string, usd: number): BatchView {
  if (!usd) return batch;
  const costUsd = batch.costUsd + usd;
  return { ...batch, costUsd, costSeries: [...batch.costSeries, { at, usd: costUsd }] };
}

export function reduce(state: LiveState, e: FactoryEvent): LiveState {
  if (e.seq <= state.lastSeq) return state; // duplicates after a reconnect are harmless
  let s: LiveState = { ...state, lastSeq: e.seq };
  const feed = (item: FeedItem) => (s = { ...s, feed: pushCapped(s.feed, item, FEED_LIMIT) });
  const batch = (f: (b: BatchView) => BatchView) => {
    if (s.batch && s.batch.batchId === e.batchId) s = { ...s, batch: f(s.batch) };
  };

  switch (e.type) {
    case "job.started":
      s = {
        ...s,
        job: { kind: e.job, label: e.label, demo: e.demo, startedAt: e.at, batchId: e.batchId },
        // Every job starts with a clean floor; benchmark runs bring their own batch.started.
        logs: [],
        feed: [],
        batch: undefined,
      };
      break;
    case "job.finished":
      if (s.job) s = { ...s, job: { ...s.job, finishedAt: e.at, ok: e.ok, summary: e.summary } };
      break;
    case "job.log":
      s = { ...s, logs: pushCapped(s.logs, { at: e.at, message: e.message, level: e.level }, LOG_LIMIT) };
      feed({ item: "log", seq: e.seq, at: e.at, message: e.message, level: e.level });
      break;
    case "batch.started": {
      const issues: Record<number, IssueView> = {};
      for (const q of e.queued) issues[q.number] = newIssue(q.number, q.title, q.labels);
      s = {
        ...s,
        batch: {
          batchId: e.batchId,
          repo: e.repo,
          mode: e.mode,
          limits: e.limits,
          startedAt: e.at,
          costUsd: 0,
          costSeries: [{ at: e.at, usd: 0 }],
          issues,
          order: e.queued.map((q) => q.number),
          unstarted: [],
        },
      };
      break;
    }
    case "issue.claimed":
      batch((b) =>
        withIssue(b, e.issue, (i) => ({ ...i, title: e.title || i.title, runId: e.runId, claimedAt: e.at })),
      );
      break;
    case "issue.skipped":
      batch((b) => withIssue(b, e.issue, (i) => ({ ...i, reason: e.reason, active: false })));
      break;
    case "stage.started":
      batch((b) =>
        withIssue(b, e.issue, (i) => ({
          ...i,
          column: STAGE_COLUMN[e.stage] ?? i.column,
          stage: e.stage,
          attempt: Math.max(i.attempt, e.attempt),
          active: true,
          stageStartedAt: e.at,
          stages: [...i.stages, { stage: e.stage, attempt: e.attempt, startedAt: e.at, costUsd: 0 }],
        })),
      );
      feed({
        item: "stage",
        seq: e.seq,
        at: e.at,
        issue: e.issue,
        stage: e.stage,
        attempt: e.attempt,
        phase: "start",
      });
      break;
    case "stage.finished":
      batch((b) =>
        addCost(
          withIssue(b, e.issue, (i) => {
            const stages = i.stages.slice();
            let idx = -1;
            for (let k = stages.length - 1; k >= 0; k--) {
              if (
                stages[k]!.stage === e.stage &&
                stages[k]!.attempt === e.attempt &&
                stages[k]!.durationMs === undefined
              ) {
                idx = k;
                break;
              }
            }
            const done: StageRun = {
              stage: e.stage,
              attempt: e.attempt,
              startedAt: idx >= 0 ? stages[idx]!.startedAt : e.at,
              durationMs: e.durationMs,
              costUsd: e.costUsd,
              ok: e.ok,
              result: e.result,
              error: e.error,
            };
            if (idx >= 0) stages[idx] = done;
            else stages.push(done);
            return {
              ...i,
              stages,
              costUsd: i.costUsd + e.costUsd,
              active: e.stage === "integrator" ? i.active : false,
            };
          }),
          e.at,
          e.costUsd,
        ),
      );
      feed({
        item: "stage",
        seq: e.seq,
        at: e.at,
        issue: e.issue,
        stage: e.stage,
        attempt: e.attempt,
        phase: "end",
        ok: e.ok,
        costUsd: e.costUsd,
        error: e.error,
      });
      break;
    case "agent.activity": {
      const a: Activity = {
        seq: e.seq,
        at: e.at,
        issue: e.issue,
        stage: e.stage,
        attempt: e.attempt,
        kind: e.kind,
        tool: e.tool,
        detail: e.detail,
        isError: e.isError,
      };
      batch((b) =>
        withIssue(b, e.issue, (i) => ({ ...i, activity: pushCapped(i.activity, a, ACTIVITY_LIMIT) })),
      );
      feed({ ...a, item: "activity" });
      break;
    }
    case "verifier.check":
      batch((b) =>
        withIssue(b, e.issue, (i) => ({
          ...i,
          checks: [
            ...i.checks,
            {
              attempt: e.attempt,
              name: e.name,
              exitCode: e.exitCode,
              durationMs: e.durationMs,
              tests: e.tests,
              outputTail: e.outputTail,
              at: e.at,
            },
          ],
        })),
      );
      feed({
        item: "check",
        seq: e.seq,
        at: e.at,
        issue: e.issue,
        attempt: e.attempt,
        name: e.name,
        exitCode: e.exitCode,
        tests: e.tests,
      });
      break;
    case "issue.finished":
      batch((b) =>
        withIssue(b, e.issue, (i) => ({
          ...i,
          column: outcomeColumn(e.outcome),
          outcome: e.outcome,
          active: false,
          finishedAt: e.at,
          prUrl: e.prUrl ?? i.prUrl,
          branch: e.branch ?? i.branch,
        })),
      );
      feed({ item: "issue", seq: e.seq, at: e.at, issue: e.issue, outcome: e.outcome, prUrl: e.prUrl });
      break;
    case "integration.started":
      batch((b) => ({ ...b, integration: { running: true, issues: e.issues, merged: [], ejected: [] } }));
      break;
    case "integration.merge":
      batch((b) => {
        const integ = b.integration ?? { running: true, issues: [], merged: [], ejected: [] };
        const next = withIssue(b, e.issue, (i) => ({
          ...i,
          integration: { conflicted: e.conflicted, merged: e.merged, reason: e.reason },
          column: e.merged ? "shipped" : "failed",
          outcome: e.merged ? "integrated" : "ejected",
          reason: e.merged ? i.reason : e.reason,
          active: false,
        }));
        return {
          ...next,
          integration: {
            ...integ,
            merged: e.merged ? [...integ.merged, e.issue] : integ.merged,
            ejected: e.merged
              ? integ.ejected
              : [...integ.ejected, { issue: e.issue, reason: e.reason ?? "unknown" }],
          },
        };
      });
      feed({
        item: "merge",
        seq: e.seq,
        at: e.at,
        issue: e.issue,
        conflicted: e.conflicted,
        merged: e.merged,
        reason: e.reason,
      });
      break;
    case "integration.finished":
      batch((b) => {
        // Integrator costs already arrived through its stage.finished events.
        let next = b;
        if (e.prUrl) {
          for (const n of e.merged) next = withIssue(next, n, (i) => ({ ...i, prUrl: e.prUrl }));
        }
        return {
          ...next,
          integration: {
            running: false,
            issues: b.integration?.issues ?? [...e.merged, ...e.ejected.map((x) => x.issue)],
            merged: e.merged,
            ejected: e.ejected,
            prUrl: e.prUrl,
          },
        };
      });
      break;
    case "batch.control":
      batch((b) => ({ ...b, control: e.action }));
      feed({ item: "control", seq: e.seq, at: e.at, action: e.action });
      break;
    case "batch.finished":
      batch((b) => ({ ...b, finishedAt: e.at, unstarted: e.unstarted }));
      break;
  }
  return s;
}

export function replay(events: FactoryEvent[], from: LiveState = initialState()): LiveState {
  return events.reduce(reduce, from);
}

// ── Derived views ───────────────────────────────────────────────────────────

export interface BatchTotals {
  total: number;
  shipped: number;
  inFlight: number;
  rejected: number;
  failed: number;
  queued: number;
}

export function totals(b: BatchView): BatchTotals {
  const issues = b.order.map((n) => b.issues[n]!);
  const count = (f: (i: IssueView) => boolean) => issues.filter(f).length;
  return {
    total: issues.length,
    shipped: count((i) => i.column === "shipped"),
    inFlight: count((i) => i.active),
    rejected: count((i) => i.column === "rejected"),
    failed: count((i) => i.column === "failed" || i.column === "cancelled"),
    queued: count((i) => i.column === "queued"),
  };
}

/** Issues currently holding a concurrency slot, oldest first. */
export function lanes(b: BatchView): IssueView[] {
  return b.order
    .map((n) => b.issues[n]!)
    .filter((i) => i.active && i.column !== "integration")
    .sort((x, y) => (x.claimedAt ?? "").localeCompare(y.claimedAt ?? ""));
}
