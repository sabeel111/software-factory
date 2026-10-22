import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ClaimingIssueSource, claimBody, currentHolder } from "../src/issues/claims.js";
import { MemoryBackend } from "../src/issues/memory.js";
import { ClaimLost, LABELS, type BackendComment } from "../src/issues/types.js";

const T0 = Date.parse("2026-01-01T00:00:00Z");

function source(backend: MemoryBackend, clock = { now: T0 }) {
  return { src: new ClaimingIssueSource(backend, { now: () => clock.now, leaseMs: 15 * 60_000 }), clock };
}

describe("intake", () => {
  it("T3.1 only ready issues without needs-info are listed", async () => {
    const backend = new MemoryBackend("o/r", [
      { number: 1, labels: [LABELS.ready] },
      { number: 2, labels: [] },
      { number: 3, labels: [LABELS.ready, LABELS.needsInfo] },
      { number: 4, labels: [LABELS.ready] },
      { number: 5, labels: ["bug"] },
    ]);
    const { src } = source(backend);
    expect((await src.listReady()).map((i) => i.number)).toEqual([1, 4]);
  });

  it("T3.9 ordering is P0, then P1, then unprioritized; oldest first within each", async () => {
    const at = (m: number) => new Date(T0 + m * 60_000).toISOString();
    const backend = new MemoryBackend("o/r", [
      { number: 10, labels: [LABELS.ready], createdAt: at(1) },
      { number: 11, labels: [LABELS.ready, "P1"], createdAt: at(2) },
      { number: 12, labels: [LABELS.ready, "P0"], createdAt: at(5) },
      { number: 13, labels: [LABELS.ready, "P0"], createdAt: at(3) },
    ]);
    const { src } = source(backend);
    expect((await src.listReady()).map((i) => i.number)).toEqual([13, 12, 11, 10]);
  });
});

describe("claims", () => {
  it("T3.2 twenty concurrent claims produce exactly one winner", async () => {
    const backend = new MemoryBackend("o/r", [{ number: 7, labels: [LABELS.ready] }]);
    const { src } = source(backend);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => src.claim(7, `run-${i}`)));
    const winners = results.filter((r) => r.won);
    expect(winners).toHaveLength(1);
    const winner = winners[0]!.holder;
    for (const r of results.filter((x) => !x.won)) expect(r.holder).toBe(winner);
    expect((await backend.getIssue(7)).labels).toContain(LABELS.claimed);
    // Losers cleaned up their claim comments.
    expect(backend.commentBodies(7).filter((b) => b.includes("factory-claim run="))).toHaveLength(1);
  });

  it("T3.3 property: any interleaving of posts and reads yields at most one winner", async () => {
    await fc.assert(
      fc.asyncProperty(fc.scheduler(), fc.integer({ min: 2, max: 6 }), async (s, n) => {
        const backend = new MemoryBackend("o/r", [{ number: 1, labels: [LABELS.ready] }]);
        // Every backend call *executes* at a point chosen by the scheduler, so posts and reads
        // from different runs interleave arbitrarily.
        const scheduled = new Proxy(backend, {
          get(target, prop, receiver) {
            const v = Reflect.get(target, prop, receiver);
            if (typeof v !== "function") return v;
            return async (...args: unknown[]) => {
              await s.schedule(Promise.resolve(String(prop)));
              return (v as (...a: unknown[]) => unknown).apply(target, args);
            };
          },
        });
        const src = new ClaimingIssueSource(scheduled, { now: () => T0 });
        const claims = Array.from({ length: n }, (_, i) => src.claim(1, `r${i}`));
        const results = await s.waitFor(Promise.all(claims));
        return results.filter((r) => r.won).length <= 1;
      }),
      { numRuns: 500 },
    );
  });

  it("T3.4 expired leases can be taken over; live leases cannot", async () => {
    const backend = new MemoryBackend("o/r", [{ number: 7, labels: [LABELS.ready] }]);
    const { src, clock } = source(backend);
    expect((await src.claim(7, "first")).won).toBe(true);
    const expiry = T0 + src.leaseMs;

    clock.now = expiry - 1_000;
    const early = await src.claim(7, "second");
    expect(early).toEqual({ won: false, holder: "first" });

    clock.now = expiry + 1_000;
    const late = await src.claim(7, "third");
    expect(late.won).toBe(true);
    expect(backend.commentBodies(7).some((b) => b.includes("Taking over from run `first`"))).toBe(true);
  });

  it("T3.5 a winner that heartbeats every 5 minutes keeps its claim for an hour", async () => {
    const backend = new MemoryBackend("o/r", [{ number: 7, labels: [LABELS.ready] }]);
    const { src, clock } = source(backend);
    await src.claim(7, "worker");
    for (let m = 5; m <= 60; m += 5) {
      clock.now = T0 + m * 60_000;
      await src.heartbeat(7, "worker");
      expect((await src.claim(7, `intruder-${m}`)).won).toBe(false);
    }
    // Once someone else holds it, heartbeat reports the loss.
    clock.now += 60 * 60_000;
    await src.claim(7, "newcomer");
    await expect(src.heartbeat(7, "worker")).rejects.toBeInstanceOf(ClaimLost);
  });

  it("T3.6 release is idempotent", async () => {
    const backend = new MemoryBackend("o/r", [{ number: 7, labels: [LABELS.ready] }]);
    const { src } = source(backend);
    await src.claim(7, "r");
    await src.release(7, "r", "needs-info");
    const once = { labels: (await backend.getIssue(7)).labels, comments: backend.commentBodies(7) };
    await src.release(7, "r", "needs-info");
    const twice = { labels: (await backend.getIssue(7)).labels, comments: backend.commentBodies(7) };
    expect(twice).toEqual(once);
    expect(once.labels).toContain(LABELS.needsInfo);
    expect(once.labels).not.toContain(LABELS.claimed);
    expect(await src.listReady()).toEqual([]);
  });

  it("failed releases drop the ready label so the issue is not retried forever", async () => {
    const backend = new MemoryBackend("o/r", [{ number: 7, labels: [LABELS.ready] }]);
    const { src } = source(backend);
    await src.claim(7, "r");
    await src.release(7, "r", "failed");
    expect((await backend.getIssue(7)).labels).toEqual([LABELS.failed]);
  });

  it("released claims don't block new claims", async () => {
    const backend = new MemoryBackend("o/r", [{ number: 7, labels: [LABELS.ready] }]);
    const { src } = source(backend);
    await src.claim(7, "a");
    await src.release(7, "a", "abandoned");
    expect((await src.listReady()).map((i) => i.number)).toEqual([7]);
    expect((await src.claim(7, "b")).won).toBe(true);
  });

  it("currentHolder picks the lowest-id live claim", () => {
    const c = (id: number, run: string, lease: number): BackendComment => ({
      id,
      body: claimBody(run, lease),
      createdAt: "",
    });
    expect(currentHolder([c(3, "x", T0 + 10), c(2, "y", T0 - 10), c(5, "z", T0 + 10)], T0)?.runId).toBe("x");
    expect(currentHolder([c(2, "y", T0 - 10)], T0)).toBeNull();
  });
});
