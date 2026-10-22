import { useMemo, useState } from "preact/hooks";
import {
  FLOW_COLUMNS,
  PARKED_COLUMNS,
  lanes as laneIssues,
  totals,
  type BatchView,
  type Column,
  type FeedItem,
  type IssueView,
  type LiveState,
} from "../events/state.js";
import type { Stage } from "../events/types.js";
import { Sparkline } from "./charts.js";
import { clock, duration, money, OUTCOME_LABEL, outcomeTone, STAGE_LABEL, stageVar } from "./format.js";
import {
  IconAlert,
  IconCheck,
  IconClock,
  IconFlag,
  IconMerge,
  IconPause,
  IconPlay,
  IconPulse,
  IconRetry,
  IconStop,
  IconX,
  toolIcon,
} from "./icons.js";
import type { Running } from "./store.js";

export const COLUMN_LABEL: Record<Column, string> = {
  queued: "Queued",
  triage: "Triage",
  worker: "Build",
  verifier: "Verify",
  reviewer: "Review",
  integration: "Integrate",
  shipped: "Shipped",
  rejected: "Needs info",
  failed: "Failed / ejected",
  cancelled: "Cancelled",
};

const COLUMN_STAGE: Partial<Record<Column, Stage>> = {
  triage: "triage",
  worker: "worker",
  verifier: "verifier",
  reviewer: "reviewer",
  integration: "integrator",
};

export function StatusPill(props: { outcome?: string; active?: boolean }) {
  if (props.active) {
    return (
      <span class="pill pill-run">
        <IconPulse /> Running
      </span>
    );
  }
  const tone = outcomeTone(props.outcome);
  if (!props.outcome) return <span class="pill">Queued</span>;
  const Icon = tone === "good" ? IconCheck : tone === "warn" ? IconFlag : IconX;
  return (
    <span class={`pill pill-${tone === "good" ? "good" : tone === "warn" ? "warn" : "bad"}`}>
      <Icon /> {OUTCOME_LABEL[props.outcome] ?? props.outcome}
    </span>
  );
}

function elapsed(i: IssueView, now: number): number | null {
  if (!i.claimedAt) return null;
  const end = i.finishedAt ? Date.parse(i.finishedAt) : now;
  return end - Date.parse(i.claimedAt);
}

function IssueCard(props: { issue: IssueView; now: number; onOpen: (n: number) => void }) {
  const { issue: i, now } = props;
  const last = i.activity[i.activity.length - 1];
  const stage = i.stage ?? "triage";
  const t = elapsed(i, now);
  return (
    <button
      class="card"
      data-active={i.active ? "true" : "false"}
      style={{ "--stage-c": stageVar(stage) }}
      onClick={() => props.onOpen(i.number)}
      aria-label={`Issue ${i.number}: ${i.title}`}
    >
      <div class="card-top">
        <span class="card-num">#{i.number}</span>
        {i.attempt > 1 && (
          <span class="attempt" title={`Attempt ${i.attempt}`}>
            try {i.attempt}
          </span>
        )}
        {i.integration?.conflicted && (
          <span class="chip" title="Merge conflict resolved by the integrator">
            conflict
          </span>
        )}
        <span style={{ marginLeft: "auto" }}>{i.costUsd > 0 ? money(i.costUsd) : ""}</span>
      </div>
      <div class="card-title">{i.title}</div>
      {i.active && last && (
        <div class="card-act" title={last.detail}>
          {last.tool ? `${last.tool} ` : ""}
          {last.detail}
        </div>
      )}
      {!i.active && (i.outcome || i.reason) && (
        <div class="card-meta">
          {i.reason && !i.integration?.merged ? (
            <span title={i.reason}>{i.reason}</span>
          ) : i.outcome ? (
            <span>{OUTCOME_LABEL[i.outcome] ?? i.outcome}</span>
          ) : null}
        </div>
      )}
      <div class="card-meta">
        {t !== null && (
          <>
            <IconClock style={{ width: 12, height: 12 }} />
            <span>{duration(t)}</span>
          </>
        )}
        <span class="sp" />
        {i.active && <span style={{ color: stageVar(stage), fontWeight: 650 }}>{STAGE_LABEL[stage]}</span>}
      </div>
      {i.active && <div class="progress" />}
    </button>
  );
}

export function Floor(props: { batch: BatchView; now: number; onOpen: (n: number) => void }) {
  const { batch, now } = props;
  const byCol = useMemo(() => {
    const m = new Map<Column, IssueView[]>();
    for (const n of batch.order) {
      const i = batch.issues[n]!;
      m.set(i.column, [...(m.get(i.column) ?? []), i]);
    }
    return m;
  }, [batch]);
  const parked = PARKED_COLUMNS.filter((c) => (byCol.get(c)?.length ?? 0) > 0);
  return (
    <section class="panel" aria-label="Factory floor">
      <div class="panel-head">
        <h2>Factory floor</h2>
        <span class="muted" style={{ fontSize: 12 }}>
          {batch.repo} · {batch.mode === "integrated" ? "one integrated PR" : "one PR per issue"}
        </span>
      </div>
      <div class="floor">
        {FLOW_COLUMNS.map((c) => {
          const items = byCol.get(c) ?? [];
          const stage = COLUMN_STAGE[c];
          return (
            <div class="col" data-col={c} key={c}>
              <div class="col-head">
                {stage ? (
                  <span class="stage-dot" style={{ background: stageVar(stage) }} />
                ) : c === "shipped" ? (
                  <IconCheck style={{ width: 13, height: 13, color: "var(--good-ink)" }} />
                ) : null}
                {COLUMN_LABEL[c]}
                <span class="count">{items.length}</span>
              </div>
              {items.map((i) => (
                <IssueCard key={`${i.number}-${c}`} issue={i} now={now} onOpen={props.onOpen} />
              ))}
            </div>
          );
        })}
      </div>
      {parked.length > 0 && (
        <div class="parked">
          {parked.map((c) => (
            <div class="col" key={c}>
              <div class="col-head">
                {c === "rejected" ? (
                  <IconFlag style={{ width: 13, height: 13 }} />
                ) : c === "cancelled" ? (
                  <IconStop style={{ width: 13, height: 13 }} />
                ) : (
                  <IconAlert style={{ width: 13, height: 13, color: "var(--critical-ink)" }} />
                )}
                {COLUMN_LABEL[c]}
                <span class="count">{byCol.get(c)!.length}</span>
              </div>
              {byCol.get(c)!.map((i) => (
                <IssueCard key={`${i.number}-${c}`} issue={i} now={now} onOpen={props.onOpen} />
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function Metrics(props: { batch: BatchView; now: number }) {
  const { batch, now } = props;
  const t = totals(batch);
  const spentPct = batch.limits.maxCostUsdPerRun ? batch.costUsd / batch.limits.maxCostUsdPerRun : 0;
  const start = Date.parse(batch.startedAt);
  const end = batch.finishedAt ? Date.parse(batch.finishedAt) : now;
  const series = batch.costSeries.map((p) => ({ x: Date.parse(p.at) - start, y: p.usd }));
  if (!batch.finishedAt) series.push({ x: end - start, y: batch.costUsd });
  return (
    <div class="metrics">
      <div class="panel tile">
        <div class="tile-label">
          <IconCheck style={{ width: 14, height: 14 }} /> Shipped
        </div>
        <div class="tile-value num">
          {t.shipped}
          <span class="muted" style={{ fontSize: 16 }}>
            {" "}
            / {t.total}
          </span>
        </div>
        <div class="tile-sub">
          {t.rejected} need info · {t.failed} failed · {t.queued} queued
        </div>
      </div>
      <div class="panel tile">
        <div class="tile-label">
          <IconPulse style={{ width: 14, height: 14 }} /> In flight
        </div>
        <div class="tile-value num">
          {t.inFlight}
          <span class="muted" style={{ fontSize: 16 }}>
            {" "}
            / {batch.limits.concurrency} slots
          </span>
        </div>
        <div class="tile-sub">
          {batch.integration?.running
            ? "Integrating approved branches…"
            : `Up to ${batch.limits.maxWorkerAttempts} attempts per issue`}
        </div>
      </div>
      <div class="panel tile">
        <div class="tile-label">Spend</div>
        <div class="tile-value num">{money(batch.costUsd)}</div>
        <div
          class="meter"
          data-level={spentPct > 0.9 ? "high" : spentPct > 0.75 ? "warn" : "ok"}
          title={`${Math.round(spentPct * 100)}% of the batch budget`}
        >
          <div style={{ width: `${Math.min(100, spentPct * 100)}%` }} />
        </div>
        <div class="tile-sub">
          of {money(batch.limits.maxCostUsdPerRun, 0)} batch budget ·{" "}
          {money(batch.limits.maxCostUsdPerIssue, 0)}/issue cap
        </div>
      </div>
      <div class="panel tile">
        <div class="tile-label">
          <IconClock style={{ width: 14, height: 14 }} /> Elapsed
        </div>
        <div class="tile-value num">{duration(end - start)}</div>
        <Sparkline
          points={series}
          color="var(--accent)"
          label={`Cumulative spend: ${money(batch.costUsd)}`}
        />
      </div>
    </div>
  );
}

export function Lanes(props: { batch: BatchView; now: number; onOpen: (n: number) => void }) {
  const { batch, now } = props;
  const busy = laneIssues(batch);
  const slots = Math.max(batch.limits.concurrency, busy.length);
  return (
    <section class="panel" aria-label="Concurrency lanes">
      <div class="panel-head">
        <h2>Lanes</h2>
        <span class="muted" style={{ fontSize: 12 }}>
          {busy.length} of {batch.limits.concurrency} busy
        </span>
      </div>
      <div class="lanes">
        {Array.from({ length: slots }, (_, k) => {
          const i = busy[k];
          if (!i) {
            return (
              <div class="lane" key={k} data-busy="false">
                <span class="lane-idx">{k + 1}</span>
                <span class="lane-idle">
                  {batch.finishedAt ? "Done" : batch.control ? "Draining — no new work" : "Idle"}
                </span>
                <span />
              </div>
            );
          }
          const stage = i.stage ?? "triage";
          return (
            <button
              key={k}
              onClick={() => props.onOpen(i.number)}
              aria-label={`Open issue ${i.number}`}
              style={{ all: "unset", cursor: "pointer" }}
            >
              <div class="lane" data-busy="true" style={{ "--stage-c": stageVar(stage) }}>
                <span class="lane-idx">{k + 1}</span>
                <span class="lane-main">
                  <span class="lane-title">
                    #{i.number} {i.title}
                  </span>
                  <span class="lane-sub">
                    <span class="stage-dot" style={{ background: stageVar(stage) }} />
                    {STAGE_LABEL[stage]}
                    {i.attempt > 1 ? ` · attempt ${i.attempt}` : ""}
                    {i.stageStartedAt ? ` · ${duration(now - Date.parse(i.stageStartedAt))}` : ""}
                  </span>
                </span>
                <span class="num muted" style={{ fontSize: 12 }}>
                  {money(i.costUsd)}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function feedLine(f: FeedItem): {
  icon: preact.JSX.Element;
  text: preact.JSX.Element;
  tone?: "good" | "bad";
  stage?: Stage;
} {
  switch (f.item) {
    case "activity":
      return {
        icon: toolIcon(f.tool, f.kind),
        stage: f.stage,
        tone: f.isError ? "bad" : undefined,
        text: f.tool ? (
          <>
            <b>{f.tool}</b> <code>{f.detail}</code>
          </>
        ) : (
          <>{f.detail}</>
        ),
      };
    case "stage":
      return f.phase === "start"
        ? {
            icon: <IconPlay />,
            stage: f.stage,
            text: (
              <>
                <b>{STAGE_LABEL[f.stage]}</b> started{f.attempt > 1 ? ` (attempt ${f.attempt})` : ""}
              </>
            ),
          }
        : {
            icon: f.ok ? <IconCheck /> : <IconX />,
            stage: f.stage,
            tone: f.ok ? undefined : "bad",
            text: (
              <>
                <b>{STAGE_LABEL[f.stage]}</b> {f.ok ? "finished" : "failed"}
                {f.costUsd ? ` · ${money(f.costUsd)}` : ""}
                {f.error ? ` · ${f.error}` : ""}
              </>
            ),
          };
    case "check":
      return {
        icon: f.exitCode === 0 ? <IconCheck /> : <IconX />,
        stage: "verifier",
        tone: f.exitCode === 0 ? "good" : "bad",
        text: (
          <>
            <b>{f.name}</b> exited {f.exitCode}
            {f.tests ? ` · ${f.tests.passed} passed, ${f.tests.failed} failed` : ""}
          </>
        ),
      };
    case "issue":
      return {
        icon:
          outcomeTone(f.outcome) === "good" ? (
            <IconCheck />
          ) : outcomeTone(f.outcome) === "warn" ? (
            <IconFlag />
          ) : (
            <IconX />
          ),
        tone:
          outcomeTone(f.outcome) === "good" ? "good" : outcomeTone(f.outcome) === "bad" ? "bad" : undefined,
        text: (
          <>
            <b>{OUTCOME_LABEL[f.outcome] ?? f.outcome}</b>
          </>
        ),
      };
    case "merge":
      return {
        icon: <IconMerge />,
        stage: "integrator",
        tone: f.merged ? "good" : "bad",
        text: (
          <>
            {f.merged ? (
              <>
                <b>Merged</b>
                {f.conflicted ? " after resolving a conflict" : " cleanly"}
              </>
            ) : (
              <>
                <b>Ejected</b> · {f.reason}
              </>
            )}
          </>
        ),
      };
    case "log":
      return {
        icon: f.level === "info" ? <IconRetry /> : <IconAlert />,
        tone: f.level === "error" ? "bad" : undefined,
        text: <>{f.message}</>,
      };
    case "control":
      return {
        icon: f.action === "draining" ? <IconPause /> : <IconStop />,
        tone: "bad",
        text: (
          <>
            <b>{f.action === "draining" ? "Draining" : "Cancelling"}</b> — requested from the UI
          </>
        ),
      };
  }
}

export function Feed(props: { state: LiveState; onOpen: (n: number) => void }) {
  const [stageFilter, setStageFilter] = useState<Stage | "all">("all");
  const items = props.state.feed
    .filter((f) => stageFilter === "all" || ("stage" in f && f.stage === stageFilter))
    .slice(-250)
    .reverse();
  const stages: Stage[] = ["triage", "worker", "verifier", "reviewer", "integrator"];
  return (
    <section class="panel" aria-label="Activity feed">
      <div class="panel-head" style={{ flexWrap: "wrap" }}>
        <h2>Live activity</h2>
        <div class="filters" style={{ marginLeft: "auto" }} role="group" aria-label="Filter by stage">
          <button class="filter" aria-pressed={stageFilter === "all"} onClick={() => setStageFilter("all")}>
            All
          </button>
          {stages.map((s) => (
            <button class="filter" key={s} aria-pressed={stageFilter === s} onClick={() => setStageFilter(s)}>
              <span class="stage-dot" style={{ background: stageVar(s) }} />
              {STAGE_LABEL[s]}
            </button>
          ))}
        </div>
      </div>
      <div class="feed" aria-live="polite">
        {items.length === 0 && <div class="empty">Activity from every agent will stream here.</div>}
        {items.map((f) => {
          const l = feedLine(f);
          const issue = "issue" in f ? f.issue : undefined;
          return (
            <div class="feed-row" key={f.seq} data-tone={l.tone}>
              <span class="feed-time">{clock(f.at)}</span>
              <span class="feed-issue">
                {issue ? (
                  <a href="#" onClick={(e) => (e.preventDefault(), props.onOpen(issue))}>
                    #{issue}
                  </a>
                ) : (
                  <span class="muted">—</span>
                )}
              </span>
              <span class="feed-icon" style={l.stage ? { color: stageVar(l.stage) } : undefined}>
                {l.icon}
              </span>
              <span class="feed-text">{l.text}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function JobBar(props: {
  state: LiveState;
  running: Running | null;
  now: number;
  onDrain: () => void;
  onCancel: () => void;
  onStart: () => void;
}) {
  const { state, running, now } = props;
  const job = state.job;
  if (!job) return null;
  const b = state.batch;
  const finished = Boolean(job.finishedAt);
  const status = running
    ? b?.control === "cancelling"
      ? { cls: "pill-bad", icon: <IconStop />, text: "Cancelling" }
      : b?.control === "draining"
        ? { cls: "pill-warn", icon: <IconPause />, text: "Draining" }
        : { cls: "pill-run", icon: <IconPulse />, text: "Running" }
    : job.ok
      ? { cls: "pill-good", icon: <IconCheck />, text: "Finished" }
      : { cls: "pill-bad", icon: <IconX />, text: "Failed" };
  const end = job.finishedAt ? Date.parse(job.finishedAt) : now;
  return (
    <div class="panel jobbar">
      <span class={`pill ${status.cls}`}>
        {status.icon} {status.text}
      </span>
      <h1>{job.label}</h1>
      <span class="muted num">{duration(end - Date.parse(job.startedAt))}</span>
      {finished && job.summary && (
        <span class="ink2" style={{ fontSize: 13 }}>
          {job.summary}
        </span>
      )}
      <span class="grow" />
      <div class="jobbar-actions">
        {running && job.kind === "batch" && !b?.control && (
          <button class="btn" onClick={props.onDrain} title="Start nothing new; let in-flight issues finish">
            <IconPause /> Drain
          </button>
        )}
        {running && b?.control !== "cancelling" && (
          <button
            class="btn btn-danger"
            onClick={props.onCancel}
            title="Cancel everything in flight and release every claim"
          >
            <IconStop /> Cancel
          </button>
        )}
        {!running && (
          <button class="btn btn-primary" onClick={props.onStart}>
            <IconPlay /> New batch
          </button>
        )}
      </div>
    </div>
  );
}
