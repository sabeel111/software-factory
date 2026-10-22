import { describe, expect, it } from "vitest";
import { Semaphore } from "../src/util/mutex.js";
import { assertPushable, PushRefused } from "../src/sandbox/types.js";
import { WORKTREE_ISOLATION_WARNING, WorktreeProvider } from "../src/sandbox/worktree.js";

describe("sandbox push guard", () => {
  it("T2.5 refuses the default branch and non-factory branches", () => {
    expect(() => assertPushable("main", "main")).toThrow(PushRefused);
    expect(() => assertPushable("refs/heads/main", "main")).toThrow(PushRefused);
    expect(() => assertPushable("develop", "develop")).toThrow(PushRefused);
    expect(() => assertPushable("feature/x", "main")).toThrow(PushRefused);
    expect(() => assertPushable("factory/", "main")).toThrow(PushRefused);
    expect(() => assertPushable("factory/../main", "main")).toThrow(PushRefused);
    expect(() => assertPushable("factory/issue-3-a1b2", "main")).not.toThrow();
  });

  it("the worktree provider always warns about missing egress/credential isolation", () => {
    expect(new WorktreeProvider().warnings()).toEqual([WORKTREE_ISOLATION_WARNING]);
  });

  it("semaphore bounds concurrency", async () => {
    const s = new Semaphore(2);
    let active = 0;
    let max = 0;
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        const release = await s.acquire();
        active++;
        max = Math.max(max, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        release();
      }),
    );
    expect(max).toBe(2);
  });
});
