import { useEffect, useState } from "preact/hooks";
import type { IssueView, StageRun } from "../events/state.js";
import type { Stage } from "../events/types.js";
import { clock, duration, money, STAGE_LABEL, stageVar } from "./format.js";
import { IconCheck, IconLink, IconStop, IconX, toolIcon } from "./icons.js";
import { COLUMN_LABEL, StatusPill } from "./live.js";

interface Finding {
  severity: "blocker" | "major" | "minor";
  file: string;
  line?: number;
  message: string;
}

function asTriage(r: unknown): {
  decision?: string;
  reason?: string;
  acceptanceCriteria?: string[];
  clarifyingQuestions?: string[];
} | null {
  return r && typeof r === "object" && "decision" in r ? (r as never) : null;
}
function asReview(r: unknown): { verdict?: string; findings?: Finding[] } | null {
  return r && typeof r === "object" && "verdict" in r ? (r as never) : null;
}
function asWorker(r: unknown): { summary?: string; touchedFiles?: string[]; testsAdded?: string[] } | null {
  return r && typeof r === "object" && "touchedFiles" in r ? (r as never) : null;
}

function Timeline(props: { issue: IssueView; now: number }) {
  const { issue, now } = props;
  if (!issue.stages.length) return <div class="muted">Not started yet.</div>;
  const t0 = Date.parse(issue.stages[0]!.startedAt);
  const endOf = (s: StageRun) => (s.durationMs !== undefined ? Date.parse(s.startedAt) + s.durationMs : now);
  const t1 = Math.max(...issue.stages.map(endOf), t0 + 1);
  const span = t1 - t0;
  return (
    <div class="gantt" role="list" aria-label="Stage timeline">
      {issue.stages.map((s, k) => {
        const left = ((Date.parse(s.startedAt) - t0) / span) * 100;
        const width = Math.max(0.8, ((endOf(s) - Date.parse(s.startedAt)) / span) * 100);
        const running = s.durationMs === undefined;
        return (
          <div class="gantt-row" role="listitem" key={k}>
            <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span class="stage-dot" style={{ background: stageVar(s.stage) }} />
              {STAGE_LABEL[s.stage]}
              {s.attempt > 1 ? <span class="muted">#{s.attempt}</span> : null}
            </span>
            <span class="gantt-track">
              <span
                class="gantt-bar"
                data-running={running ? "true" : "false"}
                data-ok={s.ok === false ? "false" : "true"}
                style={{
                  left: `${left}%`,
                  width: `${Math.min(width, 100 - left)}%`,
                  background: stageVar(s.stage),
                }}
                title={`${STAGE_LABEL[s.stage]} attempt ${s.attempt} · ${duration(s.durationMs ?? now - Date.parse(s.startedAt))}${s.costUsd ? ` · ${money(s.costUsd)}` : ""}${s.ok === false ? " · failed" : ""}`}
              />
            </span>
            <span class="num muted" style={{ textAlign: "right" }}>
              {s.ok === false ? (
                <IconX style={{ width: 12, height: 12, color: "var(--critical-ink)", verticalAlign: -2 }} />
              ) : null}{" "}
              {duration(s.durationMs ?? now - Date.parse(s.startedAt))}
            </span>
          </div>
        );
      })}
      <div class="muted" style={{ fontSize: 11.5, display: "flex", justifyContent: "space-between" }}>
        <span>{clock(issue.stages[0]!.startedAt)}</span>
        <span>{duration(span)} total</span>
      </div>
    </div>
  );
}

export function IssueDrawer(props: {
  issue: IssueView;
  now: number;
  canCancel: boolean;
  onCancel: (n: number) => void;
  onClose: () => void;
}) {
  const { issue: i, now } = props;
  const [stage, setStage] = useState<Stage | "all">("all");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const triage = i.stages.map((s) => asTriage(s.result)).find(Boolean);
  const reviews = i.stages
    .filter((s) => s.stage === "reviewer" && s.result)
    .map((s) => ({ attempt: s.attempt, r: asReview(s.result)! }))
    .filter((x) => x.r);
  const workers = i.stages
    .filter((s) => s.stage === "worker" && s.result)
    .map((s) => ({ attempt: s.attempt, w: asWorker(s.result)!, error: s.error }))
    .filter((x) => x.w);
  const errors = i.stages.filter((s) => s.error);
  const activity = i.activity
    .filter((a) => stage === "all" || a.stage === stage)
    .slice()
    .reverse();
  const stagesSeen = [...new Set(i.activity.map((a) => a.stage))];

  return (
    <>
      <div class="scrim" onClick={props.onClose} />
      <aside class="drawer" role="dialog" aria-modal="true" aria-label={`Issue ${i.number}`}>
        <div class="drawer-head">
          <div class="drawer-row">
            <span class="muted" style={{ fontWeight: 650 }}>
              #{i.number}
            </span>
            <StatusPill outcome={i.outcome} active={i.active} />
            <span class="chip">{COLUMN_LABEL[i.column]}</span>
            {i.attempt > 1 && <span class="attempt">attempt {i.attempt}</span>}
            <span style={{ marginLeft: "auto" }} />
            <button class="btn btn-ghost icon-btn" onClick={props.onClose} aria-label="Close">
              <IconX />
            </button>
          </div>
          <h2>{i.title}</h2>
          <div class="drawer-row" style={{ fontSize: 13 }}>
            <span class="num">{money(i.costUsd)}</span>
            {i.claimedAt && <span class="muted">· claimed {clock(i.claimedAt)}</span>}
            {i.branch && <code class="muted">{i.branch}</code>}
            {i.prUrl && (
              <a
                href={i.prUrl.startsWith("http") ? i.prUrl : undefined}
                target="_blank"
                rel="noreferrer"
                class="pill"
              >
                <IconLink /> {i.prUrl.startsWith("http") ? "Pull request" : "Draft PR (demo, not published)"}
              </a>
            )}
            {props.canCancel && i.active && (
              <button
                class="btn btn-sm btn-danger"
                style={{ marginLeft: "auto" }}
                onClick={() => props.onCancel(i.number)}
              >
                <IconStop /> Cancel this issue
              </button>
            )}
          </div>
        </div>
        <div class="drawer-body">
          <div class="section">
            <h3>Timeline</h3>
            <Timeline issue={i} now={now} />
          </div>

          {triage && (
            <div class="section">
              <h3>
                {triage.decision === "reject" ? "Triage: needs more information" : "Acceptance criteria"}
              </h3>
              {triage.reason && (
                <p class="ink2" style={{ margin: "0 0 8px" }}>
                  {triage.reason}
                </p>
              )}
              <ul class="criteria">
                {(triage.decision === "reject" ? triage.clarifyingQuestions : triage.acceptanceCriteria)?.map(
                  (c) => (
                    <li>{c}</li>
                  ),
                )}
              </ul>
            </div>
          )}

          {workers.length > 0 && (
            <div class="section">
              <h3>Changes</h3>
              {workers.map(({ attempt, w }) => (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 13 }}>
                    <span class="muted">Attempt {attempt}:</span> {w.summary}
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                    {w.touchedFiles?.map((f) => (
                      <code class="chip">{f}</code>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {i.checks.length > 0 && (
            <div class="section">
              <h3>Independent verification</h3>
              {i.checks.map((c) => (
                <details class="check" open={c.exitCode !== 0}>
                  <summary>
                    {c.exitCode === 0 ? (
                      <IconCheck style={{ width: 15, height: 15, color: "var(--good-ink)" }} />
                    ) : (
                      <IconX style={{ width: 15, height: 15, color: "var(--critical-ink)" }} />
                    )}
                    <b>{c.name}</b>
                    <span class="muted">attempt {c.attempt}</span>
                    <span class="muted num" style={{ marginLeft: "auto" }}>
                      {c.tests ? `${c.tests.passed} passed · ${c.tests.failed} failed · ` : ""}exit{" "}
                      {c.exitCode} · {duration(c.durationMs)}
                    </span>
                  </summary>
                  <pre>{c.outputTail || "(no output)"}</pre>
                </details>
              ))}
            </div>
          )}

          {reviews.length > 0 && (
            <div class="section">
              <h3>Review</h3>
              {reviews.map(({ attempt, r }) => (
                <div style={{ marginBottom: 10 }}>
                  <div class="drawer-row" style={{ fontSize: 13, marginBottom: 4 }}>
                    <span class="muted">Attempt {attempt}</span>
                    {r.verdict === "approve" ? (
                      <span class="pill pill-good">
                        <IconCheck /> Approved
                      </span>
                    ) : (
                      <span class="pill pill-bad">
                        <IconX /> Changes requested
                      </span>
                    )}
                  </div>
                  {r.findings?.map((f) => (
                    <div class="finding">
                      <span
                        class={`pill ${f.severity === "blocker" ? "pill-bad" : f.severity === "major" ? "pill-warn" : ""}`}
                      >
                        {f.severity}
                      </span>
                      <span>
                        <code>
                          {f.file}
                          {f.line ? `:${f.line}` : ""}
                        </code>{" "}
                        {f.message}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {i.integration && (
            <div class="section">
              <h3>Integration</h3>
              <div style={{ fontSize: 13 }}>
                {i.integration.merged
                  ? "Merged into the integration branch"
                  : `Ejected: ${i.integration.reason}`}
                {i.integration.conflicted ? " after the integrator resolved a merge conflict." : "."}
              </div>
            </div>
          )}

          {errors.length > 0 && (
            <div class="section">
              <h3>Errors</h3>
              {errors.map((s) => (
                <div class="note note-warn" style={{ marginBottom: 6 }}>
                  <span>
                    <b>{STAGE_LABEL[s.stage]}</b> attempt {s.attempt}: {s.error}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div class="section">
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
              <h3 style={{ margin: 0 }}>Agent activity</h3>
              <div class="filters" style={{ marginLeft: "auto" }}>
                <button class="filter" aria-pressed={stage === "all"} onClick={() => setStage("all")}>
                  All
                </button>
                {stagesSeen.map((s) => (
                  <button class="filter" aria-pressed={stage === s} onClick={() => setStage(s)}>
                    <span class="stage-dot" style={{ background: stageVar(s) }} />
                    {STAGE_LABEL[s]}
                  </button>
                ))}
              </div>
            </div>
            {activity.length === 0 && <div class="muted">No agent activity yet.</div>}
            {activity.map((a) => (
              <div
                class="feed-row"
                key={a.seq}
                data-tone={a.isError ? "bad" : undefined}
                style={{ gridTemplateColumns: "62px 22px minmax(0,1fr)", padding: "3px 0" }}
              >
                <span class="feed-time">{clock(a.at)}</span>
                <span class="feed-icon" style={{ color: stageVar(a.stage) }}>
                  {toolIcon(a.tool, a.kind)}
                </span>
                <span class="feed-text" title={a.detail}>
                  {a.tool ? (
                    <>
                      <b>{a.tool}</b> <code>{a.detail}</code>
                    </>
                  ) : (
                    a.detail
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      </aside>
    </>
  );
}
