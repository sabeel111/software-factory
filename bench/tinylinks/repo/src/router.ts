import type { IncomingMessage, ServerResponse } from "node:http";
import { readJson, send } from "./http.ts";
import type { Link, Store } from "./store.ts";
import { normalizeUrl } from "./url.ts";

export interface Context {
  store: Store;
  now: () => number;
  adminToken: string;
}

export function toJson(link: Link): Record<string, unknown> {
  return {
    slug: link.slug,
    url: link.url,
    shortUrl: `/${link.slug}`,
    createdAt: new Date(link.createdAt).toISOString(),
  };
}

export async function route(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (req.method === "POST" && path === "/links") {
    const body = await readJson(req);
    if (!body || typeof body.url !== "string") return send(res, 400, { error: "url is required" });
    const target = normalizeUrl(body.url);
    if (!target) return send(res, 400, { error: "invalid url" });
    const link = ctx.store.create(target, ctx.now());
    return send(res, 201, toJson(link));
  }

  if (req.method === "GET" && path === "/api/shorten") {
    const raw = url.searchParams.get("url");
    if (!raw) return send(res, 400, { error: "url is required" });
    const link = ctx.store.create(new URL(raw).toString(), ctx.now());
    return send(res, 201, toJson(link));
  }

  const match = /^\/([A-Za-z0-9_-]+)$/.exec(path);
  if (req.method === "GET" && match) {
    const link = ctx.store.get(match[1]!);
    if (!link) return send(res, 404, { error: "not found" });
    ctx.store.recordClick(link, ctx.now());
    res.writeHead(302, { Location: link.url });
    return void res.end();
  }

  return send(res, 404, { error: "not found" });
}
