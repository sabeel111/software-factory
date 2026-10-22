// The factory's event stream (specs/09-control-ui.md). Small, typed, secret-free; shared by the
// server and the browser, so this file must not import Node modules.

export type JobKind = "batch" | "bench" | "improve";
export type Stage = "triage" | "worker" | "verifier" | "reviewer" | "integrator" | "retro";
export type ActivityKind = "text" | "tool" | "result";

export interface Tests {
  passed: number;
  failed: number;
  skipped: number;
}

export interface EventBase {
  seq: number;
  at: string;
  batchId: string;
}

export type EventBody =
  | { type: "job.started"; job: JobKind; label: string; demo: boolean }
  | { type: "job.finished"; job: JobKind; ok: boolean; summary: string }
  | { type: "job.log"; message: string; level: "info" | "warn" | "error" }
  | {
      type: "batch.started";
      repo: string;
      mode: "individual" | "integrated";
      limits: {
        concurrency: number;
        maxCostUsdPerRun: number;
        maxCostUsdPerIssue: number;
        maxWorkerAttempts: number;
      };
      queued: { number: number; title: string; labels: string[] }[];
    }
  | { type: "issue.claimed"; issue: number; title: string; runId: string }
  | { type: "issue.skipped"; issue: number; reason: string }
  | { type: "stage.started"; issue: number; stage: Stage; attempt: number }
  | {
      type: "stage.finished";
      issue: number;
      stage: Stage;
      attempt: number;
      durationMs: number;
      costUsd: number;
      ok: boolean;
      /** Small structured result (triage criteria, review findings, worker summary). */
      result?: unknown;
      error?: string;
    }
  | {
      type: "agent.activity";
      issue: number;
      stage: Stage;
      attempt: number;
      kind: ActivityKind;
      tool?: string;
      detail: string;
      isError?: boolean;
    }
  | {
      type: "verifier.check";
      issue: number;
      attempt: number;
      name: string;
      exitCode: number;
      durationMs: number;
      tests: Tests | null;
      outputTail: string;
    }
  | {
      type: "issue.finished";
      issue: number;
      outcome: string;
      costUsd: number;
      prUrl?: string;
      branch?: string;
    }
  | { type: "integration.started"; issues: number[] }
  | { type: "integration.merge"; issue: number; conflicted: boolean; merged: boolean; reason?: string }
  | {
      type: "integration.finished";
      merged: number[];
      ejected: { issue: number; reason: string }[];
      prUrl?: string;
      costUsd: number;
    }
  | { type: "batch.control"; action: "draining" | "cancelling" }
  | { type: "batch.finished"; costUsd: number; unstarted: { issue: number; reason: string }[] };

export type FactoryEvent = EventBase & EventBody;
export type EventType = EventBody["type"];

/** What emitters hand to a sink; the bus stamps seq, time and batch. */
export type EventSink = (e: EventBody) => void;

const MAX_DETAIL = 240;

export function clip(s: string, n = MAX_DETAIL): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

/** Keep structured results small on the wire. */
export function compactResult(value: unknown, maxChars = 4000): unknown {
  if (value === undefined || value === null) return undefined;
  const json = JSON.stringify(value);
  if (json.length <= maxChars) return value;
  return { truncated: true, preview: json.slice(0, maxChars) };
}
