// The control server against a fast demo environment: real repo, sandboxes, verifier and merges.
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readEvents, EventBus } from "../src/events/bus.js";
import { replay } from "../src/events/state.js";
import type { FactoryEvent } from "../src/events/types.js";
import { LABELS } from "../src/issues/types.js";
import { Controller } from "../src/server/controller.js";
import { DemoEnvironment } from "../src/server/env-demo.js";
import { startControlServer, type ControlServer } from "../src/server/http.js";

// Chromium for the UI test: the preinstalled Playwright build, or FACTORY_CHROMIUM.
const CHROMIUM = process.env.FACTORY_CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const HAS_CHROMIUM = existsSync(CHROMIUM);

let env: DemoEnvironment;
let bus: EventBus;
let controller: Controller;
let server: ControlServer;

beforeAll(async () => {
  env = await DemoEnvironment.create({ speed: 0.02 });
  bus = new EventBus(env.runsRoot);
  controller = new Controller(env, bus);
  server = await startControlServer(0, { controller, bus, token: "test-token" });
});

afterAll(async () => {
  await server.close();
  await env.dispose();
});

const post = (
  path: string,
  body: unknown = {},
  headers: Record<string, string> = { "X-Factory-Token": "test-token" },
) =>
  fetch(server.url + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

async function waitFor(pred: (e: FactoryEvent) => boolean, timeoutMs = 60_000): Promise<FactoryEvent> {
  const found = bus.since(0)?.find(pred);
  if (found) return found;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => (stop(), reject(new Error("timed out waiting for event"))), timeoutMs);
    const stop = bus.subscribe((e) => {
      if (pred(e)) {
        clearTimeout(t);
        stop();
        resolve(e);
      }
    });
  });
}

/** Minimal SSE client over fetch: collects events until `until` returns true. */
async function sse(
  after: number | null,
  until: (events: FactoryEvent[]) => boolean,
  headers: Record<string, string> = {},
) {
  const ctl = new AbortController();
  const res = await fetch(`${server.url}/api/events${after !== null ? `?after=${after}` : ""}`, {
    headers,
    signal: ctl.signal,
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: FactoryEvent[] = [];
  let buf = "";
  try {
    while (!until(events)) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block.split("\n").find((l) => l.startsWith("data: "));
        if (block.includes("event: factory") && data) events.push(JSON.parse(data.slice(6)));
      }
    }
  } finally {
    ctl.abort();
  }
  return events;
}

describe("control server", () => {
  it("T8.3 writes need the token and a loopback host/origin; reads don't need the token", async () => {
    expect((await post("/api/batch/drain", {}, {})).status).toBe(401);
    expect((await post("/api/batch/drain", {}, { "X-Factory-Token": "wrong-token" })).status).toBe(401);
    expect(
      (
        await post(
          "/api/batch/drain",
          {},
          { "X-Factory-Token": "test-token", Origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
    // A DNS-rebinding page reaches us under its own host name.
    const port = new URL(server.url).port;
    const rebound = await new Promise<number>((resolve) => {
      import("node:http").then(({ request }) => {
        request(
          { host: "127.0.0.1", port, path: "/api/state", headers: { Host: `evil.example:${port}` } },
          (r) => resolve(r.statusCode!),
        ).end();
      });
    });
    expect(rebound).toBe(403);
    const state = await fetch(`${server.url}/api/state`);
    expect(state.status).toBe(200);
    expect((await state.json()).mode).toBe("demo");
    // With the token, a control call gets past auth (409: nothing is running).
    expect((await post("/api/batch/drain")).status).toBe(409);
  });

  it("T8.8 a demo batch runs end to end through the API and matches the run store", async () => {
    const start = await post("/api/batch", { issues: [1, 2, 6, 9, 10], concurrency: 3 });
    expect(start.status).toBe(202);
    const { batchId } = (await start.json()) as { batchId: string };
    await waitFor((e) => e.type === "job.finished" && e.batchId === batchId, 120_000);
    await bus.flush();

    const state = (await (await fetch(`${server.url}/api/state`)).json()).state;
    const b = state.batch;
    expect(b.batchId).toBe(batchId);
    expect(b.issues[10].column).toBe("rejected");
    expect(b.issues[1].column).toBe("failed"); // scripted: the same check fails on both attempts
    for (const n of [2, 6, 9]) expect(b.issues[n].column, `#${n}`).toBe("shipped");
    expect(b.integration.prUrl).toBeTruthy();

    const records = await env.store.latest(batchId);
    expect(records).toHaveLength(5);
    for (const r of records) {
      const view = b.issues[r.issue.number];
      expect(view.outcome === "integrated" ? "ready_to_integrate" : view.outcome, `#${r.issue.number}`).toBe(
        r.outcome,
      );
      const recordCost = r.stages.reduce((s, x) => s + x.costUsd, 0);
      const viewCost = view.stages
        .filter((s: { stage: string }) => s.stage !== "integrator")
        .reduce((s: number, x: { costUsd: number }) => s + x.costUsd, 0);
      expect(viewCost).toBeCloseTo(recordCost);
    }

    // History shows the same totals, including integration cost.
    const list = (await (await fetch(`${server.url}/api/batches`)).json()) as {
      batchId: string;
      costUsd: number;
      shipped: number;
    }[];
    const row = list.find((x) => x.batchId === batchId)!;
    expect(row.shipped).toBe(3);
    expect(row.costUsd).toBeCloseTo(b.costUsd);
  });

  it("T8.2 a finished batch replays from events.jsonl into the live state", async () => {
    await bus.flush();
    const batchId = bus.state.batch!.batchId;
    const events = await readEvents(env.runsRoot, batchId);
    expect(existsSync(`${env.runsRoot}/${batchId}/events.jsonl`)).toBe(true);
    // The bus state since startup covers exactly this batch's job (T8.3 started nothing).
    expect(replay(events)).toEqual(bus.state);
    const api = (await (await fetch(`${server.url}/api/batches/${batchId}`)).json()) as { state: unknown };
    expect(api.state).toEqual(bus.state);
  });

  it("T8.6 SSE delivers events in seq order and resumes after Last-Event-ID", async () => {
    const all = bus.since(0)!;
    const target = all[all.length - 1]!.seq;
    const first = await sse(0, (ev) => ev.some((e) => e.seq === target));
    const seqs = first.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs[0]).toBe(1);
    const cut = Math.floor(target / 2);
    const resumed = await sse(null, (ev) => ev.some((e) => e.seq === target), {
      "Last-Event-ID": String(cut),
    });
    expect(resumed.map((e) => e.seq)).toEqual(all.filter((e) => e.seq > cut).map((e) => e.seq));
  });

  it("T8.7 a second job while one is running gets 409 naming the running job", async () => {
    const a = await post("/api/batch", { issues: [5, 6], concurrency: 1 });
    expect(a.status).toBe(202);
    const b = await post("/api/bench", { kind: "reference" });
    expect(b.status).toBe(409);
    const body = (await b.json()) as { running: { kind: string } };
    expect(body.running.kind).toBe("batch");
    expect((await post("/api/batch/cancel")).status).toBe(202);
    await controller.idle();
  });

  it("T8.5 cancelling one issue stops only that issue and releases its claim", async () => {
    const start = await post("/api/batch", { issues: [4, 6, 8], concurrency: 3 });
    const { batchId } = (await start.json()) as { batchId: string };
    await waitFor(
      (e) => e.batchId === batchId && e.type === "stage.started" && e.issue === 6 && e.stage === "worker",
    );
    expect((await post("/api/issues/6/cancel")).status).toBe(202);
    await waitFor((e) => e.type === "job.finished" && e.batchId === batchId, 120_000);
    const b = bus.state.batch!;
    expect(b.issues[6]!.outcome).toBe("cancelled");
    for (const n of [4, 8]) expect(b.issues[n]!.column, `#${n}`).toBe("shipped");
    const labels = (await env.lastBackend!.getIssue(6)).labels;
    expect(labels).not.toContain(LABELS.claimed);
    expect(labels).toContain(LABELS.ready);
  });

  it.skipIf(!HAS_CHROMIUM)(
    "T8.9 the UI renders the floor, moves cards live, opens the drawer, with no console errors",
    async () => {
      const { chromium } = await import("playwright-core");
      const browser = await chromium.launch({
        executablePath: CHROMIUM,
      });
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(String(e)));
        page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
        await page.goto(server.url);
        await page.waitForSelector(".conn[data-state=live]");
        await page.click('button:has-text("New batch")');
        await page.waitForSelector(".issue-pick label");
        await page.click('button:has-text("Start demo batch")');
        await page.waitForSelector('.col[data-col="worker"] .card, .col[data-col="verifier"] .card', {
          timeout: 60_000,
        });
        await page.waitForSelector('.col[data-col="shipped"] .card', { timeout: 120_000 });
        await page.click('.col[data-col="shipped"] .card >> nth=0');
        await page.waitForSelector(".drawer h2");
        expect(await page.locator(".drawer .gantt-row").count()).toBeGreaterThan(2);
        await page.keyboard.press("Escape");
        await controller.idle();
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
      }
    },
  );
});
