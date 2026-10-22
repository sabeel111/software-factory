// `factory status` rendering (specs/06-parallel-and-integration.md R5.7).
import type { RunRecord } from "../contracts/index.js";

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

export function renderStatus(records: RunRecord[], now = Date.now()): string {
  const rows = [...records]
    .sort((a, b) => a.issue.number - b.issue.number)
    .map((r) => {
      const last = r.stages[r.stages.length - 1];
      const end = r.finishedAt ? Date.parse(r.finishedAt) : now;
      const cost = r.stages.reduce((s, x) => s + x.costUsd, 0);
      return {
        issue: `#${r.issue.number}`,
        title: r.issue.title.length > 36 ? r.issue.title.slice(0, 35) + "…" : r.issue.title,
        stage: last ? last.stage : "claimed",
        attempt: last ? String(last.attempt) : "-",
        elapsed: fmtDuration(end - Date.parse(r.startedAt)),
        cost: `$${cost.toFixed(2)}`,
        outcome: r.outcome ?? "running",
      };
    });
  const header = {
    issue: "Issue",
    title: "Title",
    stage: "Stage",
    attempt: "Try",
    elapsed: "Elapsed",
    cost: "Cost",
    outcome: "Outcome",
  };
  const cols = Object.keys(header) as (keyof typeof header)[];
  const widths = Object.fromEntries(
    cols.map((c) => [c, Math.max(header[c].length, ...rows.map((r) => r[c].length))]),
  );
  const line = (r: typeof header) =>
    cols
      .map((c) => pad(r[c], widths[c]!))
      .join("  ")
      .trimEnd();
  const total = records.reduce((s, r) => s + r.stages.reduce((t, x) => t + x.costUsd, 0), 0);
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
  const summary = [...counts.entries()].map(([k, v]) => `${v} ${k}`).join(", ");
  return [
    line(header),
    ...rows.map(line),
    "",
    `Total: ${records.length} issues · $${total.toFixed(2)} · ${summary}`,
  ].join("\n");
}
