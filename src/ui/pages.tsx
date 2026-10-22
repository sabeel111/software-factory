import { useState } from "preact/hooks";
import type { LiveState } from "../events/state.js";
import type { EnvInfo } from "../server/controller.js";
import { LineChart } from "./charts.js";
import { ConfirmDialog } from "./dialogs.js";
import { IssueDrawer } from "./drawer.js";
import { duration, money, pct, when } from "./format.js";
import {
  IconAlert,
  IconBeaker,
  IconCheck,
  IconFlag,
  IconInfo,
  IconLink,
  IconPlay,
  IconRetry,
  IconSpark,
  IconX,
} from "./icons.js";
import { Floor, Metrics } from "./live.js";
import { api, toast, useResource } from "./store.js";

// ── History ─────────────────────────────────────────────────────────────────

interface BatchSummary {
  batchId: string;
  kind: string;
  label: string;
  demo: boolean;
  startedAt: string;
  finishedAt?: string;
  ok?: boolean;
  summary?: string;
  issues: number;
  shipped: number;
  costUsd: number;
}

export function HistoryPage(props: { version: number }) {
  const list = useResource<BatchSummary[]>("/api/batches", props.version);
  return (
    <section class="panel">
      <div class="panel-head">
        <h2>Runs</h2>
        <span class="muted" style={{ fontSize: 12 }}>
          Every batch, benchmark and improvement run, replayable from its event log
        </span>
      </div>
      {list.loading && <div class="empty">Loading…</div>}
      {list.data?.length === 0 && <div class="empty">No runs yet. Start a batch from the Live view.</div>}
      {!!list.data?.length && (
        <div class="scroll-x">
          <table class="table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Run</th>
                <th>Status</th>
                <th class="r">Issues</th>
                <th class="r">Shipped</th>
                <th class="r">Cost</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((b) => (
                <tr
                  class="clickable"
                  key={b.batchId}
                  onClick={() => (location.hash = `#/history/${b.batchId}`)}
                >
                  <td style={{ whiteSpace: "nowrap" }}>{when(b.startedAt)}</td>
                  <td>
                    <div style={{ fontWeight: 560 }}>{b.label}</div>
                    <div class="muted mono" style={{ fontSize: 11 }}>
                      {b.batchId}
                      {b.demo ? " · demo" : ""}
                    </div>
                  </td>
                  <td>
                    {b.ok === undefined ? (
                      <span class="pill pill-run">Running</span>
                    ) : b.ok ? (
                      <span class="pill pill-good">
                        <IconCheck /> Done
                      </span>
                    ) : (
                      <span class="pill pill-bad">
                        <IconX /> Failed
                      </span>
                    )}
                  </td>
                  <td class="r num">{b.issues || "—"}</td>
                  <td class="r num">{b.issues ? b.shipped : "—"}</td>
                  <td class="r num">{money(b.costUsd)}</td>
                  <td class="num">
                    {b.finishedAt ? duration(Date.parse(b.finishedAt) - Date.parse(b.startedAt)) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function BatchReplayPage(props: { batchId: string }) {
  const r = useResource<{ batchId: string; state: LiveState; eventCount: number }>(
    `/api/batches/${encodeURIComponent(props.batchId)}`,
  );
  const [open, setOpen] = useState<number | null>(null);
  if (r.loading) return <div class="empty">Loading…</div>;
  if (r.error || !r.data) return <div class="empty">{r.error}</div>;
  const s = r.data.state;
  const b = s.batch;
  const end = b?.finishedAt
    ? Date.parse(b.finishedAt)
    : s.job?.finishedAt
      ? Date.parse(s.job.finishedAt)
      : Date.now();
  return (
    <>
      <div class="panel jobbar">
        <a href="#/history" class="btn btn-sm">
          ← Runs
        </a>
        <h1>{s.job?.label ?? props.batchId}</h1>
        <span class="muted">
          Replayed from {r.data.eventCount} events · {s.job ? when(s.job.startedAt) : ""}
        </span>
        <span class="grow" />
        {s.job?.summary && <span class="ink2">{s.job.summary}</span>}
      </div>
      {b ? (
        <>
          <Metrics batch={b} now={end} />
          <Floor batch={b} now={end} onOpen={setOpen} />
        </>
      ) : (
        <section class="panel">
          <div class="panel-head">
            <h2>Log</h2>
          </div>
          <div class="panel-body">
            {s.logs.length === 0 && <div class="muted">No log lines.</div>}
            {s.logs.map((l) => (
              <div class="mono" style={{ fontSize: 12 }}>
                {l.message}
              </div>
            ))}
          </div>
        </section>
      )}
      {open !== null && b?.issues[open] && (
        <IssueDrawer
          issue={b.issues[open]!}
          now={end}
          canCancel={false}
          onCancel={() => undefined}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

// ── Benchmark ───────────────────────────────────────────────────────────────

interface BenchEntry {
  at: string;
  label: string;
  split: string;
  costUsd: number;
  playbookHash: string;
  falsePassRate?: number | null;
  wallClockMs?: number;
  score: { resolved: number; total: number; resolveRate: number; triageAccuracy: number | null };
}

const SPLIT_COLOR: Record<string, string> = {
  all: "var(--stage-triage)",
  holdout: "var(--stage-worker)",
  train: "var(--stage-verifier)",
};

export function BenchPage(props: { env?: EnvInfo; busy: boolean; version: number }) {
  const data = useResource<BenchEntry[]>("/api/bench", props.version);
  const [view, setView] = useState<"chart" | "table">("chart");
  const [split, setSplit] = useState<"all" | "train" | "holdout">("all");
  const [confirm, setConfirm] = useState(false);
  const entries = (data.data ?? []).filter((e) => !e.label.startsWith("reference"));
  const refs = (data.data ?? []).filter((e) => e.label.startsWith("reference"));
  const run = async (kind: "reference" | "factory") => {
    try {
      await api("/api/bench", { method: "POST", body: { kind, split } });
      location.hash = "#/live";
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const splits = [...new Set(entries.map((e) => e.split))].filter((s) => SPLIT_COLOR[s]);
  // One x position per run, in order; each split is its own series (null where it has no run).
  const series = splits.map((sp) => ({
    name: sp === "all" ? "All issues" : sp === "holdout" ? "Holdout" : "Train",
    color: SPLIT_COLOR[sp]!,
    values: entries.map((e) => (e.split === sp ? e.score.resolveRate : null)),
  }));
  const xLabels = entries.map(
    (e, i) =>
      `Run ${i + 1} · ${new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`,
  );
  const live = props.env?.mode === "live";
  return (
    <>
      <section class="panel">
        <div class="panel-head" style={{ flexWrap: "wrap" }}>
          <h2>TinyLinks benchmark</h2>
          <span class="muted" style={{ fontSize: 12 }}>
            10 issues · hidden tests the agents never see
          </span>
          <span style={{ flex: 1 }} />
          <div class="toolbar">
            <div class="seg" role="group" aria-label="Split">
              {(["all", "train", "holdout"] as const).map((s) => (
                <button aria-pressed={split === s} onClick={() => setSplit(s)}>
                  {s}
                </button>
              ))}
            </div>
            <button
              class="btn"
              disabled={props.busy}
              onClick={() => run("reference")}
              title="Score the hand-written reference solutions (free)"
            >
              <IconBeaker /> Check reference
            </button>
            <button
              class="btn btn-primary"
              disabled={props.busy}
              onClick={() => (live ? setConfirm(true) : run("factory"))}
            >
              <IconPlay /> Run factory
            </button>
          </div>
        </div>
        <div class="panel-body">
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
            <div style={{ fontWeight: 600 }}>Resolve rate over time</div>
            <span style={{ flex: 1 }} />
            <div class="seg" role="group" aria-label="View">
              <button aria-pressed={view === "chart"} onClick={() => setView("chart")}>
                Chart
              </button>
              <button aria-pressed={view === "table"} onClick={() => setView("table")}>
                Table
              </button>
            </div>
          </div>
          {data.loading && <div class="empty">Loading…</div>}
          {!data.loading && entries.length === 0 && (
            <div class="empty">No factory benchmark runs yet. “Run factory” records the first one.</div>
          )}
          {entries.length > 0 && view === "chart" && (
            <LineChart
              series={series}
              xLabels={xLabels}
              yMax={1}
              yFormat={(v) => pct(v)}
              ariaLabel="Benchmark resolve rate per run"
            />
          )}
          {entries.length > 0 && view === "table" && (
            <div class="scroll-x">
              <table class="table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Run</th>
                    <th>Split</th>
                    <th class="r">Resolved</th>
                    <th class="r">Triage</th>
                    <th class="r">False pass</th>
                    <th class="r">Cost</th>
                    <th class="r">Wall clock</th>
                    <th>Playbooks</th>
                  </tr>
                </thead>
                <tbody>
                  {entries
                    .slice()
                    .reverse()
                    .map((e) => (
                      <tr>
                        <td style={{ whiteSpace: "nowrap" }}>{when(e.at)}</td>
                        <td>{e.label}</td>
                        <td>{e.split}</td>
                        <td class="r num">
                          {e.score.resolved}/{e.score.total} ({pct(e.score.resolveRate)})
                        </td>
                        <td class="r num">{pct(e.score.triageAccuracy)}</td>
                        <td class="r num">{pct(e.falsePassRate ?? null)}</td>
                        <td class="r num">{money(e.costUsd)}</td>
                        <td class="r num">{e.wallClockMs ? duration(e.wallClockMs) : "—"}</td>
                        <td class="mono muted">{e.playbookHash}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
      <section class="panel">
        <div class="panel-head">
          <h2>Reference checks</h2>
          <span class="muted" style={{ fontSize: 12 }}>
            Sanity check on the benchmark itself: hand-written solutions should score 100%
          </span>
        </div>
        <div class="panel-body">
          {refs.length === 0 ? (
            <div class="muted">Not run yet.</div>
          ) : (
            refs
              .slice(-3)
              .reverse()
              .map((r) => (
                <div
                  style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 13, padding: "3px 0" }}
                >
                  {r.score.resolved === r.score.total ? (
                    <span class="pill pill-good">
                      <IconCheck /> {r.score.resolved}/{r.score.total}
                    </span>
                  ) : (
                    <span class="pill pill-bad">
                      <IconX /> {r.score.resolved}/{r.score.total}
                    </span>
                  )}
                  <span class="muted">{when(r.at)}</span>
                </div>
              ))
          )}
        </div>
      </section>
      {confirm && (
        <ConfirmDialog
          title="Run the benchmark with real Claude?"
          confirm="Run benchmark"
          body={
            <>
              This runs the full factory on the {split} split of TinyLinks. {props.env?.costNote}
            </>
          }
          onConfirm={() => run("factory")}
          onClose={() => setConfirm(false)}
        />
      )}
    </>
  );
}

// ── Self-improvement ─────────────────────────────────────────────────────────

interface Scores {
  resolveRate: number;
  triageAccuracy: number | null;
  falsePassRate: number | null;
  costPerResolved: number | null;
}
interface Candidate {
  candidateId: string;
  at: string;
  hypothesis: string;
  targets: string[];
  patch: { file: string; removed: boolean }[];
  scores: { champion: Scores[]; candidate: Scores[] };
  noiseBand: number;
  decision: string;
  accepted: boolean;
  prUrl?: string;
  revertOf?: string;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function Compare(props: { champion: number | null; candidate: number | null; noise: number }) {
  const { champion, candidate, noise } = props;
  const row = (label: string, v: number | null, color: string) => (
    <div class="compare-row">
      <span class="ink2">{label}</span>
      <span class="compare-track">
        {v !== null && (
          <span
            class="compare-bar"
            style={{ width: `${Math.max(1, v * 100)}%`, background: color }}
            title={`${label}: ${pct(v, 1)}`}
          />
        )}
        {label === "Candidate" && champion !== null && (
          <span
            class="compare-noise"
            title={`Must beat the champion by more than the noise band (${pct(noise, 1)})`}
            style={{ left: `${champion * 100}%`, width: `${Math.max(0.5, noise * 100)}%` }}
          />
        )}
      </span>
      <span class="num" style={{ textAlign: "right", fontWeight: 600 }}>
        {pct(v, 1)}
      </span>
    </div>
  );
  return (
    <div class="compare" aria-label="Holdout resolve rate, champion vs candidate">
      {row("Champion", champion, "var(--stage-triage)")}
      {row("Candidate", candidate, "var(--stage-worker)")}
      <div class="muted" style={{ fontSize: 11.5 }}>
        Holdout resolve rate · dashed band = noise ({pct(noise, 1)})
      </div>
    </div>
  );
}

export function ImprovePage(props: { env?: EnvInfo; busy: boolean; version: number }) {
  const data = useResource<Candidate[]>("/api/history", props.version);
  const [maxUsd, setMaxUsd] = useState("30");
  const [confirm, setConfirm] = useState<"run" | Candidate | null>(null);
  const reverted = new Set((data.data ?? []).map((c) => c.revertOf).filter(Boolean));
  const list = (data.data ?? []).slice().reverse();
  const start = async () => {
    await api("/api/improve", { method: "POST", body: { maxUsd: Number(maxUsd) } });
    location.hash = "#/live";
  };
  return (
    <>
      <section class="panel">
        <div class="panel-head" style={{ flexWrap: "wrap" }}>
          <h2>Self-improvement</h2>
          <span class="muted" style={{ fontSize: 12 }}>
            Proposals to the stage playbooks, judged on held-out hidden tests
          </span>
          <span style={{ flex: 1 }} />
          <div class="toolbar">
            <label class="muted" for="maxusd" style={{ fontSize: 12 }}>
              Max spend
            </label>
            <input
              id="maxusd"
              class="input"
              style={{ width: 90, height: 30 }}
              type="number"
              min={1}
              value={maxUsd}
              onInput={(e) => setMaxUsd((e.target as HTMLInputElement).value)}
            />
            <button class="btn btn-primary" disabled={props.busy} onClick={() => setConfirm("run")}>
              <IconSpark /> Run improvement
            </button>
          </div>
        </div>
        <div class="panel-body">
          <div class="note">
            <IconInfo />
            <span>
              A candidate is accepted only if it beats the current playbooks on the holdout split by more than
              the noise band, with no drop in triage accuracy or false-pass rate and at most 1.25× the cost
              per resolved issue. Accepted changes become a PR — a human merges them.
            </span>
          </div>
        </div>
      </section>
      {data.loading && <div class="empty">Loading…</div>}
      {!data.loading && list.length === 0 && (
        <section class="panel">
          <div class="empty">No candidates yet.</div>
        </section>
      )}
      <div class="stack">
        {list.map((c) => {
          const champ = mean(c.scores.champion.map((s) => s.resolveRate));
          const cand = mean(c.scores.candidate.map((s) => s.resolveRate));
          const isRevert = Boolean(c.revertOf);
          return (
            <section class="panel cand" key={c.candidateId}>
              <div>
                <div class="drawer-row" style={{ marginBottom: 8 }}>
                  {c.accepted ? (
                    <span class="pill pill-good">
                      <IconCheck /> {isRevert ? "Revert" : "Accepted"}
                    </span>
                  ) : c.decision.startsWith("not-evaluated") ? (
                    <span class="pill pill-warn">
                      <IconFlag /> {c.decision}
                    </span>
                  ) : (
                    <span class="pill pill-bad">
                      <IconX /> Rejected: {c.decision}
                    </span>
                  )}
                  <span class="muted" style={{ fontSize: 12 }}>
                    {when(c.at)}
                  </span>
                  {reverted.has(c.candidateId) && <span class="pill">Reverted</span>}
                </div>
                <h3>{c.hypothesis}</h3>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "8px 0" }}>
                  {c.targets.map((t) => (
                    <span class="chip">{t}</span>
                  ))}
                  {c.patch.map((p) => (
                    <code class="chip">{p.file}</code>
                  ))}
                </div>
                <div class="drawer-row">
                  {c.prUrl && (
                    <a
                      class="btn btn-sm"
                      href={c.prUrl.startsWith("http") ? c.prUrl : undefined}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <IconLink /> {c.prUrl.startsWith("http") ? "Pull request" : c.prUrl}
                    </a>
                  )}
                  {c.accepted && !isRevert && !reverted.has(c.candidateId) && (
                    <button class="btn btn-sm" onClick={() => setConfirm(c)}>
                      <IconRetry /> Revert
                    </button>
                  )}
                  <span class="muted mono" style={{ fontSize: 11 }}>
                    {c.candidateId}
                  </span>
                </div>
              </div>
              {!isRevert && <Compare champion={champ} candidate={cand} noise={c.noiseBand} />}
            </section>
          );
        })}
      </div>
      {confirm === "run" && (
        <ConfirmDialog
          title="Run self-improvement?"
          confirm="Run"
          body={
            <>
              Runs the train split to collect failures, asks the retrospective agent for playbook changes,
              then evaluates each on the holdout split. Hard budget: <b>{money(Number(maxUsd))}</b>.{" "}
              {props.env?.costNote}
            </>
          }
          onConfirm={start}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm && confirm !== "run" && (
        <ConfirmDialog
          title="Revert this improvement?"
          confirm="Open revert PR"
          body={<>Opens a PR that exactly undoes candidate {confirm.candidateId}.</>}
          onConfirm={async () => {
            const r = await api<{ url: string }>("/api/improve/revert", {
              method: "POST",
              body: { candidateId: confirm.candidateId },
            });
            toast(`Revert proposed: ${r.url}`);
          }}
          onClose={() => setConfirm(null)}
        />
      )}
    </>
  );
}

// ── Settings ────────────────────────────────────────────────────────────────

export function SettingsPage(props: { env?: EnvInfo }) {
  const e = props.env;
  if (!e) return <div class="empty">Loading…</div>;
  return (
    <>
      {e.warnings.length > 0 && (
        <section class="panel">
          <div class="panel-body stack" style={{ gap: 8 }}>
            {e.warnings.map((w) => (
              <div class="note note-warn">
                <IconAlert /> <span>{w}</span>
              </div>
            ))}
          </div>
        </section>
      )}
      <section class="panel">
        <div class="panel-head">
          <h2>Effective configuration</h2>
          <span class="muted" style={{ fontSize: 12 }}>
            After the org policy is applied · edit factory.config.ts to change
          </span>
        </div>
        <div class="panel-body">
          <dl class="kv">
            <dt>Mode</dt>
            <dd>{e.mode === "demo" ? "Demo (scripted agents, zero cost)" : "Live"}</dd>
            <dt>Repository</dt>
            <dd>{e.repo}</dd>
            <dt>Sandbox provider</dt>
            <dd>{e.provider}</dd>
            <dt>PR mode</dt>
            <dd>
              {e.prMode === "integrated" ? "One integrated draft PR per batch" : "One draft PR per issue"}
            </dd>
            <dt>Checks (verifier)</dt>
            <dd>
              {e.checks.map((c) => (
                <div>
                  <b>{c.name}</b> <code>{c.command}</code>
                </div>
              ))}
            </dd>
            <dt>Protected paths</dt>
            <dd>
              {e.protectedPaths.map((p) => (
                <code class="chip" style={{ marginRight: 4 }}>
                  {p}
                </code>
              ))}
            </dd>
            <dt>Blocked tools</dt>
            <dd>{e.blockedTools.length ? e.blockedTools.join(", ") : <span class="muted">none</span>}</dd>
            <dt>Credentials</dt>
            <dd style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {Object.entries(e.credentials).map(([k, ok]) => (
                <span class={`pill ${ok ? "pill-good" : ""}`}>
                  {ok ? <IconCheck /> : <IconX />} {k}
                </span>
              ))}
            </dd>
          </dl>
        </div>
      </section>
      <div class="split" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)" }}>
        <section class="panel">
          <div class="panel-head">
            <h2>Limits</h2>
          </div>
          <table class="table">
            <tbody>
              {Object.entries(e.limits).map(([k, v]) => (
                <tr>
                  <td>{k}</td>
                  <td class="r num">{k.toLowerCase().includes("usd") ? money(v, 0) : v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section class="panel">
          <div class="panel-head">
            <h2>Stages</h2>
          </div>
          <table class="table">
            <thead>
              <tr>
                <th>Stage</th>
                <th>Provider</th>
                <th>Model</th>
                <th>Effort</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(e.stages).map(([k, v]) => (
                <tr>
                  <td>
                    <span class="stage-dot" style={{ background: `var(--stage-${k})`, marginRight: 6 }} />
                    {k}
                  </td>
                  <td>{v.provider ?? "anthropic"}</td>
                  <td class="mono">{v.model}</td>
                  <td>{v.effort}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </>
  );
}
