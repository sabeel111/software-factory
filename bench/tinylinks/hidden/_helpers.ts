// Shared helpers for hidden acceptance tests. Copied into the candidate at hidden/ by the scorer.
import { startServer } from "../src/server.ts";

export interface Harness {
  url: string;
  close: () => Promise<void>;
  clock: { now: number };
}

export async function harness(options: { adminToken?: string } = {}): Promise<Harness> {
  const clock = { now: Date.parse("2026-01-01T00:00:00.000Z") };
  const server = await startServer({ now: () => clock.now, adminToken: options.adminToken });
  return { url: server.url, close: server.close, clock };
}

export async function create(base: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/links`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function visit(base: string, path: string, method = "GET", headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, { method, headers, redirect: "manual" });
}
