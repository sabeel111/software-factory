// Control server: REST + Server-Sent Events + the web UI (specs/09-control-ui.md R8.3, R8.6, R8.10).
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { readEvents, type EventBus } from "../events/bus.js";
import { replay } from "../events/state.js";
import type { FactoryEvent } from "../events/types.js";
import { Busy, NothingRunning, type Controller } from "./controller.js";
import { buildUi, type UiBundle } from "./ui-build.js";

export interface ControlServerOptions {
  controller: Controller;
  bus: EventBus;
  token?: string;
  host?: string;
  /** Close an SSE client whose unsent backlog exceeds this many bytes (it reconnects and resyncs). */
  maxClientBacklog?: number;
  heartbeatMs?: number;
}

export interface ControlServer {
  server: Server;
  token: string;
  url: string;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function jsonl<T>(file: string): Promise<T[]> {
  if (!existsSync(file)) return [];
  return (await readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new HttpError(413, "Request body too large");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
}

const num = (v: unknown, min: number, max: number): number | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max)
    throw new HttpError(400, `Value ${String(v)} must be between ${min} and ${max}`);
  return n;
};

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function html(token: string, mode: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Software Factory</title>
<meta name="color-scheme" content="light dark">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#2a78d6"/><path d="M7 23V13l6 4v-4l6 4V9h6v14z" fill="#fff"/></svg>')}">
<link rel="stylesheet" href="/assets/app.css">
<script>window.__FACTORY__ = ${JSON.stringify({ token, mode })};</script>
<script>try{var t=localStorage.getItem("factory.theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}</script>
</head>
<body>
<div id="app"></div>
<script type="module" src="/assets/app.js"></script>
</body>
</html>`;
}

export async function startControlServer(port: number, opts: ControlServerOptions): Promise<ControlServer> {
  const { controller, bus } = opts;
  const env = controller.env;
  const token = opts.token ?? randomBytes(24).toString("base64url");
  const host = opts.host ?? "127.0.0.1";
  const maxBacklog = opts.maxClientBacklog ?? 4 * 1024 * 1024;
  let ui: UiBundle | undefined;
  let actualPort = port;
  const clients = new Set<ServerResponse>();

  const allowedHosts = () =>
    new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`, `[::1]:${actualPort}`]);
  const allowedOrigins = () => new Set([...allowedHosts()].map((h) => `http://${h}`));

  const send = (res: ServerResponse, status: number, data: unknown) => {
    const text = JSON.stringify(data);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(text);
  };

  const sse = (req: IncomingMessage, res: ServerResponse, url: URL) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    // Flush headers now so the browser sees the stream open before the first event.
    res.write(": connected\n\n");
    const after = Number(req.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0) || 0;
    const write = (e: FactoryEvent) => {
      res.write(`id: ${e.seq}\nevent: factory\ndata: ${JSON.stringify(e)}\n\n`);
      // A slow client never holds the factory up: past the backlog limit we drop it (R8.3).
      if (res.writableLength > maxBacklog) res.destroy();
    };
    const missed = bus.since(after);
    if (missed === null) res.write(`event: reset\ndata: {}\n\n`);
    else for (const e of missed) write(e);
    const unsubscribe = bus.subscribe(write);
    const ping = setInterval(() => res.write(`: ping\n\n`), opts.heartbeatMs ?? 15_000);
    clients.add(res);
    const done = () => {
      clearInterval(ping);
      unsubscribe();
      clients.delete(res);
    };
    req.on("close", done);
    res.on("error", done);
  };

  const batchSummaries = async () => {
    const root = env.runsRoot;
    if (!existsSync(root)) return [];
    const dirs = (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    const out = [];
    for (const id of dirs) {
      const hasRecords = existsSync(join(root, id, "records.jsonl"));
      const hasEvents = existsSync(join(root, id, "events.jsonl"));
      if (!hasRecords && !hasEvents) continue;
      const records = hasRecords ? await env.store.latest(id) : [];
      const events = hasEvents ? await readEvents(root, id) : [];
      const job = events.find((e) => e.type === "job.started");
      const startedAt = events[0]?.at ?? records.map((r) => r.startedAt).sort()[0] ?? "";
      const replayed = hasEvents ? replay(events).batch : undefined;
      // The event log includes integration costs, which per-issue records don't.
      const costUsd = replayed
        ? replayed.costUsd
        : records.reduce((s, r) => s + r.stages.reduce((t, x) => t + x.costUsd, 0), 0);
      const finished = events.find((e) => e.type === "job.finished");
      out.push({
        batchId: id,
        kind: job && job.type === "job.started" ? job.job : "batch",
        label: job && job.type === "job.started" ? job.label : id,
        demo: job && job.type === "job.started" ? job.demo : false,
        startedAt,
        finishedAt: finished?.at,
        ok: finished && finished.type === "job.finished" ? finished.ok : undefined,
        summary: finished && finished.type === "job.finished" ? finished.summary : undefined,
        issues: replayed ? replayed.order.length : records.length,
        shipped: replayed
          ? replayed.order.filter((n) => replayed.issues[n]!.column === "shipped").length
          : records.filter((r) => r.outcome === "pr_opened").length,
        costUsd,
        hasEvents,
      });
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  };

  const route = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const method = req.method ?? "GET";
    const path = url.pathname;

    // DNS-rebinding guard: only answer to the loopback name we serve on (R8.6).
    if (!allowedHosts().has(String(req.headers.host ?? ""))) throw new HttpError(403, "Forbidden host");
    if (method !== "GET" && method !== "HEAD") {
      const origin = req.headers.origin;
      if (origin && !allowedOrigins().has(origin)) throw new HttpError(403, "Forbidden origin");
      const given = String(req.headers["x-factory-token"] ?? "");
      if (!given || !safeEqual(given, token)) throw new HttpError(401, "Missing or invalid X-Factory-Token");
    }

    if (method === "GET" && (path === "/" || path === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return void res.end(html(token, env.mode));
    }
    if (method === "GET" && (path === "/assets/app.js" || path === "/assets/app.css")) {
      ui ??= await buildUi();
      const isJs = path.endsWith(".js");
      res.writeHead(200, {
        "Content-Type": isJs ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      return void res.end(isJs ? ui.js : ui.css);
    }
    if (method === "GET" && path === "/api/events") return sse(req, res, url);
    if (method === "GET" && path === "/api/state") {
      return send(res, 200, { state: bus.state, running: controller.running ?? null, mode: env.mode });
    }
    if (method === "GET" && path === "/api/env") return send(res, 200, await env.describe());
    if (method === "GET" && path === "/api/ready") return send(res, 200, await env.readyIssues());
    if (method === "GET" && path === "/api/batches") return send(res, 200, await batchSummaries());
    const batchMatch = /^\/api\/batches\/([A-Za-z0-9_.-]+)$/.exec(path);
    if (method === "GET" && batchMatch) {
      const id = batchMatch[1]!;
      const [records, events] = await Promise.all([env.store.latest(id), readEvents(env.runsRoot, id)]);
      if (!records.length && !events.length) throw new HttpError(404, "No such batch");
      return send(res, 200, { batchId: id, records, state: replay(events), eventCount: events.length });
    }
    if (method === "GET" && path === "/api/bench") {
      const entries = await jsonl<
        Record<string, unknown> & { score: { perIssue: { outputTail?: string }[] } }
      >(env.benchResultsFile);
      for (const e of entries) for (const p of e.score?.perIssue ?? []) delete p.outputTail;
      return send(res, 200, entries);
    }
    if (method === "GET" && path === "/api/history") {
      const entries = await jsonl<
        Record<string, unknown> & { patch?: { file: string; after: string | null }[] }
      >(env.historyFile);
      return send(
        res,
        200,
        entries.map((e) => ({
          ...e,
          patch: (e.patch ?? []).map((p) => ({ file: p.file, removed: p.after === null })),
        })),
      );
    }

    // ── Controls ────────────────────────────────────────────────────────────
    if (method === "POST" && path === "/api/batch") {
      const b = await body(req);
      const issues = Array.isArray(b.issues)
        ? b.issues.map((n) => num(n, 1, 1e9)!).filter(Boolean)
        : undefined;
      const batchId = controller.startBatch({
        issues,
        concurrency: num(b.concurrency, 1, 64),
        maxCostUsdPerRun: num(b.maxCostUsdPerRun, 0.01, 100_000),
      });
      return send(res, 202, { batchId });
    }
    if (method === "POST" && path === "/api/batch/drain") {
      controller.drain();
      return send(res, 202, { ok: true });
    }
    if (method === "POST" && path === "/api/batch/cancel") {
      controller.cancel();
      return send(res, 202, { ok: true });
    }
    const cancelIssue = /^\/api\/issues\/(\d+)\/cancel$/.exec(path);
    if (method === "POST" && cancelIssue) {
      controller.cancelIssue(Number(cancelIssue[1]));
      return send(res, 202, { ok: true });
    }
    if (method === "POST" && path === "/api/bench") {
      const b = await body(req);
      const kind = b.kind === "factory" ? "factory" : "reference";
      const split = b.split === "train" || b.split === "holdout" ? b.split : "all";
      return send(res, 202, { batchId: controller.startBench({ kind, split }) });
    }
    if (method === "POST" && path === "/api/improve") {
      const b = await body(req);
      return send(res, 202, {
        batchId: controller.startImprove({ maxUsd: num(b.maxUsd, 0.5, 10_000) ?? 30 }),
      });
    }
    if (method === "POST" && path === "/api/improve/revert") {
      const b = await body(req);
      if (typeof b.candidateId !== "string") throw new HttpError(400, "candidateId is required");
      return send(res, 200, { url: await controller.revert(b.candidateId) });
    }
    throw new HttpError(404, "Not found");
  };

  const server = createServer((req, res) => {
    route(req, res).catch((e: unknown) => {
      if (res.headersSent) return void res.end();
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      if (e instanceof Busy) return send(res, 409, { error: e.message, running: e.job });
      if (e instanceof NothingRunning) return send(res, 409, { error: e.message });
      send(res, 500, { error: (e as Error).message });
    });
  });
  await new Promise<void>((r) => server.listen(port, host, r));
  const addr = server.address();
  actualPort = typeof addr === "object" && addr ? addr.port : port;
  return {
    server,
    token,
    url: `http://127.0.0.1:${actualPort}`,
    close: async () => {
      for (const c of clients) c.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
