import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { BENCH_ROOT, prepareBenchRepo, type PreparedBench } from "../../src/bench/benchmark.js";
import type { Sandbox } from "../../src/sandbox/types.js";
import {
  gitIn,
  SecretLeak,
  WorktreeProvider,
  type WorktreeProviderOptions,
} from "../../src/sandbox/worktree.js";

export type MakeProvider = (opts: WorktreeProviderOptions & { root: string }) => WorktreeProvider;

/** The Phase 2 contract; every sandbox provider must pass it unchanged (T7.1). */
export function sandboxSuite(name: string, make: MakeProvider) {
  let bench: PreparedBench;
  let root: string;

  beforeAll(async () => {
    bench = await prepareBenchRepo(await mkdtemp(join(tmpdir(), "sbx-bench-")));
    root = await mkdtemp(join(tmpdir(), "sbx-root-"));
  });

  async function provider(extra: { secretPaths?: string[] } = {}) {
    return make({ root, ...extra });
  }

  async function walk(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...(await walk(p)));
      else out.push(p);
    }
    return out;
  }

  describe(`${name} sandboxes`, () => {
    it("T2.1 sandboxes from one snapshot are isolated from each other", async () => {
      const p = await provider();
      const snap = await p.prepareSnapshot({ repoUrl: bench.dir, ref: "main", setup: [] });
      const a = await p.create({ snapshot: snap, label: "a" });
      const b = await p.create({ snapshot: snap, label: "b" });
      await writeFile(join(a.path, "x.txt"), "from a");
      const aSha = await a.commit("add x");
      expect(existsSync(join(b.path, "x.txt"))).toBe(false);
      expect(await gitIn(b.path, "log", "--format=%H")).not.toContain(aSha);
      expect(existsSync(join(p.root, "snapshots", snap, "base", "x.txt"))).toBe(false);
      await Promise.all([a.destroy(), b.destroy()]);
    });

    it("T2.2 ten concurrent creates succeed with distinct paths and branches", async () => {
      const p = await provider();
      const snap = await p.prepareSnapshot({ repoUrl: bench.dir, ref: "main", setup: [] });
      const boxes = await Promise.all(
        Array.from({ length: 10 }, (_, i) => p.create({ snapshot: snap, label: `c${i}` })),
      );
      expect(new Set(boxes.map((b) => b.path)).size).toBe(10);
      expect(new Set(boxes.map((b) => b.branch)).size).toBe(10);
      await Promise.all(boxes.map((b) => b.destroy()));
    });

    it("T2.3 p95 create time is under 10s and tests run without reinstalling", async () => {
      const p = await provider();
      const snap = await p.prepareSnapshot({ repoUrl: bench.dir, ref: "main", setup: ["npm ci"] });
      const times: number[] = [];
      const boxes: Sandbox[] = [];
      for (let i = 0; i < 10; i++) {
        const t0 = Date.now();
        boxes.push(await p.create({ snapshot: snap, label: `t${i}` }));
        times.push(Date.now() - t0);
      }
      times.sort((x, y) => x - y);
      expect(times[Math.ceil(0.95 * times.length) - 1]!).toBeLessThan(10_000);
      const r = await boxes[0]!.exec("npm test --offline");
      expect(r.exitCode, r.stdout + r.stderr).toBe(0);
      await Promise.all(boxes.map((b) => b.destroy()));
    });

    it("T2.4 snapshots are cached by setup; a changed setup builds a new snapshot", async () => {
      const p = await provider();
      const counter = join(root, "setup-count.txt");
      await writeFile(counter, "");
      const count = async () => (await readFile(counter, "utf8")).length;
      const setupA = [`printf x >> ${counter}`];
      const setupB = [`printf x >> ${counter}`, "true"];
      const s1 = await p.prepareSnapshot({ repoUrl: bench.dir, ref: "main", setup: setupA });
      expect(await count()).toBe(1);
      const s2 = await p.prepareSnapshot({ repoUrl: bench.dir, ref: "main", setup: setupA });
      expect(s2).toBe(s1);
      expect(await count()).toBe(1);
      const s3 = await p.prepareSnapshot({ repoUrl: bench.dir, ref: "main", setup: setupB });
      expect(s3).not.toBe(s1);
      expect(await count()).toBe(2);
    });

    it("T2.6 exec timeouts kill the whole process group and report 124", async () => {
      const p = await provider();
      const snap = await p.prepareSnapshot({ repoUrl: bench.dir, ref: "main", setup: [] });
      const box = await p.create({ snapshot: snap, label: "timeout" });
      const t0 = Date.now();
      const r = await box.exec("sleep 31.37 & sleep 31.37; wait", { timeoutSec: 1 });
      expect(r.exitCode).toBe(124);
      expect(Date.now() - t0).toBeLessThan(3_000);
      await new Promise((res) => setTimeout(res, 200));
      const ps = execFileSync("ps", ["-eo", "args"]).toString();
      expect(ps).not.toContain("sleep 31.37");
      await box.destroy();
    });

    it("T2.7 a restarted orchestrator sweeps sandboxes orphaned by a crash", async () => {
      const p = await provider();
      const snap = await p.prepareSnapshot({ repoUrl: bench.dir, ref: "main", setup: [] });
      const box = await p.create({ snapshot: snap, label: "orphan" });
      // Simulate the owning process having crashed: rewrite its ledger entry with a dead pid.
      const entries = await p.ledger.entries();
      const deadPid = 2 ** 22 + 12345;
      await writeFile(
        p.ledger.file,
        JSON.stringify(entries.map((e) => (e.id === box.id ? { ...e, pid: deadPid } : e))),
      );
      const restarted = await provider();
      const swept = await restarted.sweep();
      expect(swept).toContain(box.id);
      expect(existsSync(box.path)).toBe(false);
      expect((await restarted.ledger.entries()).map((e) => e.id)).not.toContain(box.id);
    });

    it("T2.8 hidden benchmark tests never appear inside a sandbox", async () => {
      const hiddenDir = join(BENCH_ROOT, "hidden");
      const p = await provider({ secretPaths: [hiddenDir] });
      const snap = await p.prepareSnapshot({ repoUrl: bench.dir, ref: "main", setup: [] });
      const box = await p.create({ snapshot: snap, label: "secret" });
      const files = await walk(box.path);
      const hiddenNames = new Set(await readdir(hiddenDir));
      for (const f of files) expect(hiddenNames.has(relative(box.path, f).split("/").pop()!)).toBe(false);
      const factoryBench = join(BENCH_ROOT, "..");
      expect(relative(box.path, factoryBench).startsWith("..")).toBe(true);
      await box.destroy();

      // A repo that does contain a hidden test file is refused.
      await gitIn(bench.dir, "checkout", "-q", "-b", "leaky", "main");
      await writeFile(join(bench.dir, "leak.test.ts"), await readFile(join(hiddenDir, "h01.test.ts")));
      await gitIn(bench.dir, "add", "-A");
      await gitIn(bench.dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "leak");
      await gitIn(bench.dir, "checkout", "-q", "main");
      const leakySnap = await p.prepareSnapshot({ repoUrl: bench.dir, ref: "leaky", setup: [] });
      await expect(p.create({ snapshot: leakySnap, label: "leaky" })).rejects.toBeInstanceOf(SecretLeak);
    });

    it("T2.9 destroy removes the path and the worktree registration", async () => {
      const p = await provider();
      const snap = await p.prepareSnapshot({ repoUrl: bench.dir, ref: "main", setup: [] });
      const box = await p.create({ snapshot: snap, label: "gone" });
      const mirror = join(p.root, "snapshots", snap, "repo.git");
      expect(await gitIn(mirror, "worktree", "list")).toContain(box.path);
      await box.destroy();
      expect(existsSync(box.path)).toBe(false);
      expect(await gitIn(mirror, "worktree", "list")).not.toContain(box.path);
      expect(await gitIn(mirror, "branch", "--list", box.branch)).toBe("");
    });

    it("pushes factory branches to the remote", async () => {
      const p = await provider();
      const snap = await p.prepareSnapshot({ repoUrl: bench.dir, ref: "main", setup: [] });
      const box = await p.create({ snapshot: snap, label: "push" });
      await writeFile(join(box.path, "pushed.txt"), "hi");
      const sha = await box.commit("push me");
      await box.push("factory/issue-1-test");
      expect(await gitIn(bench.dir, "rev-parse", "factory/issue-1-test")).toBe(sha);
      await expect(box.push("main")).rejects.toThrow(/default branch/);
      await box.destroy();
    });
  });
}
