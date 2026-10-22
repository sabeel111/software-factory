import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchLike } from "../../src/issues/github.js";

export interface Exchange {
  request: { method: string; path: string };
  response: { status: number; body: unknown; headers?: Record<string, string> };
}

/** A fetch that replays recorded GitHub exchanges in order and records what was requested. */
export function fixtureFetch(...names: string[]): {
  fetch: FetchLike;
  calls: { method: string; path: string }[];
} {
  const queue: Exchange[] = names.flatMap(
    (n) =>
      JSON.parse(
        readFileSync(join(import.meta.dirname, "..", "fixtures", "github", `${n}.json`), "utf8"),
      ) as Exchange[],
  );
  const calls: { method: string; path: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const path = url.replace("https://api.github.com", "");
    const method = init.method ?? "GET";
    calls.push({ method, path });
    const next = queue.shift();
    if (!next) throw new Error(`Unexpected request ${method} ${path}`);
    if (next.request.method !== method || next.request.path !== path) {
      throw new Error(`Expected ${next.request.method} ${next.request.path}, got ${method} ${path}`);
    }
    const body = next.response.body === null ? null : JSON.stringify(next.response.body);
    return new Response(body, { status: next.response.status, headers: next.response.headers });
  };
  return { fetch, calls };
}
