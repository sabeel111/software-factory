// Read-only web dashboard over the run store, benchmark history and improvement history
// (specs/08-team-readiness.md R7.7). It has no write routes by construction.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import type { RunRecord } from "../contracts/index.js";
import type { RunStore } from "../store/run-store.js";

export interface DashboardSources {
  store: RunStore;
  benchResultsFile: string;
  historyFile: string;
}

type Handler = (
  src: DashboardSources,
  params: Record<string, string>,
) => Promise<{ type: string; body: string }>;

interface Route {
  method: "GET";
  pattern: RegExp;
  path: string;
  handler: Handler;
}

const esc = (s: unknown) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

async function jsonl<T>(file: string): Promise<T[]> {
  if (!existsSync(file)) return [];
  return (await readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}

const STYLE = `
:root { --bg:#fbfaf8; --fg:#1f1d1a; --muted:#6b665e; --line:#e4e0d8; --card:#fff; --accent:#2f6f4f;
  --ok:#2f6f4f; --bad:#b3412f; --warn:#9a6a12; --stage-triage:#7a6bb0; --stage-worker:#2f6f9f;
  --stage-verifier:#2f6f4f; --stage-reviewer:#9a6a12; --stage-integrator:#8a4f7d; --stage-retro:#555; }
@media (prefers-color-scheme: dark) { :root { --bg:#161513; --fg:#ece9e3; --muted:#a39e94; --line:#2c2a26;
  --card:#1e1d1a; --accent:#7cc39c; --ok:#7cc39c; --bad:#e58b7a; --warn:#e0b25a; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 ui-sans-serif, system-ui, sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 15px; margin: 32px 0 8px; color: var(--muted); font-weight: 600; }
a { color: var(--accent); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; overflow-x: auto; }
table { width: 100%; border-collapse: collapse; } th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { color: var(--muted); font-weight: 600; font-size: 12px; } tr:last-child td { border-bottom: 0; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
.pill { display:inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; border: 1px solid currentColor; }
.ok { color: var(--ok); } .bad { color: var(--bad); } .warn { color: var(--warn); } .muted { color: var(--muted); }
.timeline { display:flex; gap:2px; min-width: 240px; height: 14px; }
.seg { height: 100%; border-radius: 2px; min-width: 3px; }
.legend span { margin-right: 12px; font-size: 12px; } .legend i { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:4px; vertical-align: -1px; }
`;

const OUTCOME_CLASS: Record<string, string> = {
  pr_opened: "ok",
  ready_to_integrate: "ok",
  rejected: "warn",
  failed: "bad",
  budget_exceeded: "bad",
  cancelled: "muted",
};

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

function timeline(r: RunRecord): string {
  const total = r.stages.reduce((s, x) => s + x.durationMs, 0) || 1;
  return `<div class="timeline">${r.stages
    .map(
      (s) =>
        `<div class="seg" title="${esc(`${s.stage} #${s.attempt} · ${(s.durationMs / 1000).toFixed(1)}s · $${s.costUsd.toFixed(2)}${s.error ? ` · ${s.error}` : ""}`)}" style="flex:${Math.max(s.durationMs / total, 0.02)};background:var(--stage-${s.stage})${s.error ? ";opacity:.45" : ""}"></div>`,
    )
    .join("")}</div>`;
}

export function renderBatch(batchId: string, records: RunRecord[]): string {
  const cost = (r: RunRecord) => r.stages.reduce((s, x) => s + x.costUsd, 0);
  const rows = [...records]
    .sort((a, b) => a.issue.number - b.issue.number)
    .map(
      (r) => `<tr><td>#${r.issue.number}</td><td>${esc(r.issue.title)}</td><td>${timeline(r)}</td>
<td class="num">$${cost(r).toFixed(2)}</td><td><span class="pill ${OUTCOME_CLASS[r.outcome ?? ""] ?? "muted"}">${esc(r.outcome ?? "running")}</span></td>
<td>${r.prUrl ? `<a href="${esc(r.prUrl)}">PR</a>` : ""}</td></tr>`,
    )
    .join("");
  const legend = ["triage", "worker", "verifier", "reviewer", "integrator"]
    .map((s) => `<span><i style="background:var(--stage-${s})"></i>${s}</span>`)
    .join("");
  const total = records.reduce((s, r) => s + cost(r), 0);
  return page(
    `Batch ${batchId}`,
    `<p><a href="/">← All batches</a></p><h1>Batch ${esc(batchId)}</h1><p class="muted">${records.length} issues · $${total.toFixed(2)}</p>
<p class="legend">${legend}</p>
<div class="card"><table><thead><tr><th>Issue</th><th>Title</th><th>Stages</th><th>Cost</th><th>Outcome</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`,
  );
}

interface BenchLine {
  at: string;
  label: string;
  split: string;
  costUsd: number;
  playbookHash: string;
  score: { resolved: number; total: number; resolveRate: number; triageAccuracy: number | null };
}

interface HistoryLine {
  candidateId: string;
  at: string;
  hypothesis: string;
  decision: string;
  accepted: boolean;
  prUrl?: string;
}

async function renderHome(src: DashboardSources): Promise<string> {
  const batches = (await src.store.batches()).reverse();
  const batchRows = (
    await Promise.all(
      batches.slice(0, 50).map(async (b) => {
        const recs = await src.store.latest(b);
        const cost = recs.reduce((s, r) => s + r.stages.reduce((t, x) => t + x.costUsd, 0), 0);
        const ok = recs.filter((r) => r.outcome === "pr_opened" || r.outcome === "ready_to_integrate").length;
        return `<tr><td><a href="/batch/${encodeURIComponent(b)}">${esc(b)}</a></td><td class="num">${recs.length}</td><td class="num">${ok}</td><td class="num">$${cost.toFixed(2)}</td></tr>`;
      }),
    )
  ).join("");
  const bench = (await jsonl<BenchLine>(src.benchResultsFile)).reverse().slice(0, 30);
  const benchRows = bench
    .map(
      (
        b,
      ) => `<tr><td>${esc(b.at.slice(0, 16).replace("T", " "))}</td><td>${esc(b.label)}</td><td>${esc(b.split)}</td>
<td class="num">${b.score.resolved}/${b.score.total} (${Math.round(b.score.resolveRate * 100)}%)</td>
<td class="num">${b.score.triageAccuracy === null ? "—" : `${Math.round(b.score.triageAccuracy * 100)}%`}</td>
<td class="num">$${b.costUsd.toFixed(2)}</td><td class="muted">${esc(b.playbookHash)}</td></tr>`,
    )
    .join("");
  const history = (await jsonl<HistoryLine>(src.historyFile)).reverse().slice(0, 30);
  const historyRows = history
    .map(
      (h) => `<tr><td>${esc(h.at.slice(0, 16).replace("T", " "))}</td><td>${esc(h.hypothesis)}</td>
<td><span class="pill ${h.accepted ? "ok" : "muted"}">${esc(h.decision)}</span></td><td>${h.prUrl ? `<a href="${esc(h.prUrl)}">PR</a>` : ""}</td></tr>`,
    )
    .join("");
  const empty = (cols: number, text: string) => `<tr><td colspan="${cols}" class="muted">${text}</td></tr>`;
  return page(
    "Software Factory",
    `<h1>Software Factory</h1><p class="muted">Read-only view of batches, benchmark scores and self-improvement.</p>
<h2>Batches</h2><div class="card"><table><thead><tr><th>Batch</th><th>Issues</th><th>Succeeded</th><th>Cost</th></tr></thead><tbody>${batchRows || empty(4, "No batches yet.")}</tbody></table></div>
<h2>Benchmark</h2><div class="card"><table><thead><tr><th>When</th><th>Run</th><th>Split</th><th>Resolved</th><th>Triage</th><th>Cost</th><th>Playbooks</th></tr></thead><tbody>${benchRows || empty(7, "No benchmark runs yet.")}</tbody></table></div>
<h2>Self-improvement</h2><div class="card"><table><thead><tr><th>When</th><th>Hypothesis</th><th>Decision</th><th></th></tr></thead><tbody>${historyRows || empty(4, "No candidates yet.")}</tbody></table></div>`,
  );
}

export const ROUTES: Route[] = [
  {
    method: "GET",
    path: "/",
    pattern: /^\/$/,
    handler: async (src) => ({ type: "text/html", body: await renderHome(src) }),
  },
  {
    method: "GET",
    path: "/batch/:id",
    pattern: /^\/batch\/(?<id>[^/]+)$/,
    handler: async (src, p) => ({
      type: "text/html",
      body: renderBatch(p.id!, await src.store.latest(p.id!)),
    }),
  },
  {
    method: "GET",
    path: "/api/batches",
    pattern: /^\/api\/batches$/,
    handler: async (src) => ({ type: "application/json", body: JSON.stringify(await src.store.batches()) }),
  },
  {
    method: "GET",
    path: "/api/batch/:id",
    pattern: /^\/api\/batch\/(?<id>[^/]+)$/,
    handler: async (src, p) => ({
      type: "application/json",
      body: JSON.stringify(await src.store.latest(p.id!)),
    }),
  },
  {
    method: "GET",
    path: "/api/bench",
    pattern: /^\/api\/bench$/,
    handler: async (src) => ({
      type: "application/json",
      body: JSON.stringify(await jsonl(src.benchResultsFile)),
    }),
  },
  {
    method: "GET",
    path: "/api/history",
    pattern: /^\/api\/history$/,
    handler: async (src) => ({
      type: "application/json",
      body: JSON.stringify(await jsonl(src.historyFile)),
    }),
  },
];

export function createDashboard(src: DashboardSources): Server {
  return createServer((req, res) => {
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }).end("Read-only dashboard");
      return;
    }
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    for (const route of ROUTES) {
      const m = route.pattern.exec(path);
      if (!m) continue;
      route
        .handler(src, (m.groups ?? {}) as Record<string, string>)
        .then(({ type, body }) =>
          res
            .writeHead(200, { "Content-Type": `${type}; charset=utf-8` })
            .end(method === "HEAD" ? undefined : body),
        )
        .catch((e: unknown) => res.writeHead(500).end(String(e)));
      return;
    }
    res.writeHead(404).end("Not found");
  });
}

export function defaultSources(store: RunStore, root = process.cwd()): DashboardSources {
  return {
    store,
    benchResultsFile: join(root, "bench", "results.jsonl"),
    historyFile: join(root, "playbooks", "HISTORY.jsonl"),
  };
}
