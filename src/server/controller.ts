// The control plane behind the UI (specs/09-control-ui.md R8.4, R8.5): at most one job at a time,
// every action mapped onto the same code paths, limits and budgets as the CLI.
import type { EventBus } from "../events/bus.js";
import type { EventSink, JobKind } from "../events/types.js";
import { runBatch, type BatchDeps } from "../orchestrator/batch.js";
import { newId } from "../store/run-store.js";
import type { RunStore } from "../store/run-store.js";

export interface StartBatchOptions {
  issues?: number[];
  concurrency?: number;
  maxCostUsdPerRun?: number;
}

export interface BenchOptions {
  kind: "reference" | "factory";
  split: "train" | "holdout" | "all";
}

export interface JobContext {
  batchId: string;
  events: EventSink;
  log: (message: string, level?: "info" | "warn" | "error") => void;
  drain: AbortSignal;
  cancel: AbortSignal;
  onRunStarted: (issue: number, cancel: () => void) => void;
}

export interface EnvInfo {
  mode: "demo" | "live";
  repo: string;
  provider: string;
  prMode: string;
  checks: { name: string; command: string }[];
  limits: Record<string, number>;
  stages: Record<string, { model: string; effort: string; maxTurns?: number }>;
  protectedPaths: string[];
  blockedTools: string[];
  warnings: string[];
  credentials: Record<string, boolean>;
  /** What clicking "Start" can cost, in words, for the confirmation dialog. */
  costNote: string;
}

/** Everything that differs between demo mode and the real thing. */
export interface Environment {
  readonly mode: "demo" | "live";
  readonly store: RunStore;
  readonly runsRoot: string;
  readonly benchResultsFile: string;
  readonly historyFile: string;
  describe(): Promise<EnvInfo>;
  readyIssues(): Promise<{ number: number; title: string; labels: string[] }[]>;
  prepareBatch(opts: StartBatchOptions, ctx: JobContext): Promise<BatchDeps>;
  benchmark(opts: BenchOptions, ctx: JobContext): Promise<string>;
  improve(opts: { maxUsd: number }, ctx: JobContext): Promise<string>;
  revert(candidateId: string): Promise<string>;
}

export class Busy extends Error {
  override name = "Busy";
  constructor(readonly job: { kind: JobKind; batchId: string; label: string }) {
    super(`A ${job.kind} job is already running (${job.label})`);
  }
}

export class NothingRunning extends Error {
  override name = "NothingRunning";
}

interface RunningJob {
  kind: JobKind;
  batchId: string;
  label: string;
  drain: AbortController;
  cancel: AbortController;
  runs: Map<number, () => void>;
  done: Promise<void>;
}

export class Controller {
  private job?: RunningJob;

  constructor(
    readonly env: Environment,
    readonly bus: EventBus,
  ) {}

  get running(): { kind: JobKind; batchId: string; label: string } | undefined {
    return this.job && { kind: this.job.kind, batchId: this.job.batchId, label: this.job.label };
  }

  /** Resolves when the current job (if any) finishes. */
  async idle(): Promise<void> {
    await this.job?.done;
  }

  private start(
    kind: JobKind,
    label: string,
    prefix: string,
    work: (ctx: JobContext) => Promise<string>,
  ): string {
    if (this.job) throw new Busy(this.running!);
    const batchId = newId(prefix);
    const drain = new AbortController();
    const cancel = new AbortController();
    const runs = new Map<number, () => void>();
    const events = this.bus.sink(batchId);
    const ctx: JobContext = {
      batchId,
      events,
      log: (message, level = "info") => events({ type: "job.log", message, level }),
      drain: drain.signal,
      cancel: cancel.signal,
      onRunStarted: (issue, stop) => runs.set(issue, stop),
    };
    events({ type: "job.started", job: kind, label, demo: this.env.mode === "demo" });
    const done = (async () => {
      try {
        const summary = await work(ctx);
        events({ type: "job.finished", job: kind, ok: true, summary });
      } catch (e) {
        ctx.log(`${kind} failed: ${(e as Error).message}`, "error");
        events({ type: "job.finished", job: kind, ok: false, summary: (e as Error).message });
      } finally {
        this.job = undefined;
      }
    })();
    this.job = { kind, batchId, label, drain, cancel, runs, done };
    return batchId;
  }

  startBatch(opts: StartBatchOptions = {}): string {
    const label = opts.issues?.length
      ? `Batch: ${opts.issues.map((n) => `#${n}`).join(", ")}`
      : "Batch: all ready issues";
    return this.start("batch", label, "b", async (ctx) => {
      const deps = await this.env.prepareBatch(opts, ctx);
      const r = await runBatch({
        ...deps,
        batchId: ctx.batchId,
        events: ctx.events,
        drain: ctx.drain,
        cancel: ctx.cancel,
        onRunStarted: ctx.onRunStarted,
        log: (m) => ctx.log(m),
      });
      const shipped = r.integration
        ? r.integration.result.merged.length
        : r.results.filter((x) => x.outcome === "pr_opened").length;
      return `${shipped} of ${r.results.length} issue(s) shipped · $${r.costUsd.toFixed(2)}${r.integration?.prUrl?.startsWith("http") ? ` · ${r.integration.prUrl}` : ""}`;
    });
  }

  startBench(opts: BenchOptions): string {
    const label = `Benchmark: ${opts.kind === "reference" ? "reference solutions" : `factory on ${opts.split}`}`;
    return this.start("bench", label, "bench-", (ctx) => this.env.benchmark(opts, ctx));
  }

  startImprove(opts: { maxUsd: number }): string {
    return this.start("improve", `Self-improvement (max $${opts.maxUsd})`, "improve-", (ctx) =>
      this.env.improve(opts, ctx),
    );
  }

  revert(candidateId: string): Promise<string> {
    return this.env.revert(candidateId);
  }

  drain(): void {
    if (!this.job) throw new NothingRunning("Nothing is running");
    if (!this.job.drain.signal.aborted) {
      this.job.drain.abort();
      this.bus.emit(this.job.batchId, { type: "batch.control", action: "draining" });
    }
  }

  cancel(): void {
    if (!this.job) throw new NothingRunning("Nothing is running");
    this.job.drain.abort();
    if (!this.job.cancel.signal.aborted) {
      this.job.cancel.abort();
      this.bus.emit(this.job.batchId, { type: "batch.control", action: "cancelling" });
    }
  }

  cancelIssue(issue: number): void {
    const stop = this.job?.runs.get(issue);
    if (!stop) throw new NothingRunning(`Issue #${issue} isn't running`);
    stop();
    this.bus.emit(this.job!.batchId, {
      type: "job.log",
      message: `Cancelling #${issue} (other issues keep running)`,
      level: "warn",
    });
  }
}
