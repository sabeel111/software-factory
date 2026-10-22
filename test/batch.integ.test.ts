import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAgentRunner, type ScriptStep } from "../src/agents/fake-runner.js";
import { parseConfig } from "../src/config.js";
import type { ConflictResolution } from "../src/contracts/index.js";
import { ClaimingIssueSource } from "../src/issues/claims.js";
import { MemoryBackend } from "../src/issues/memory.js";
import { LABELS } from "../src/issues/types.js";
import { installSignalHandlers, runBatch, type BatchDeps } from "../src/orchestrator/batch.js";
import { MemoryPrSink } from "../src/pipeline/pr.js";
import { StaticPlaybooks } from "../src/pipeline/playbooks.js";
import { RunStore } from "../src/store/run-store.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { FakeSandboxProvider } from "./helpers/fake-sandbox.js";
import { harness } from "./helpers/harness.js";
import { accept, applies, approve, refPatch, workerDone } from "./helpers/scripts.js";

/** Scheduler-level deps on fakes: N ready issues, scripted agents with random delays. */
async function fakeBatch(
  n: number,
  limits: Record<string, number> = {},
  step?: Partial<Record<string, ScriptStep>>,
) {
  const backend = new MemoryBackend(
    "o/r",
    Array.from({ length: n }, (_, i) => ({ number: i + 1, labels: [LABELS.ready] })),
  );
  const runner = new FakeAgentRunner();
  const delay = () => 5 + Math.floor(Math.random() * 25);
  runner
    .script("triage", "*", "*", step?.triage ?? { output: accept(), delayMs: delay() })
    .script("worker", "*", "*", step?.worker ?? { output: workerDone(), delayMs: delay() })
    .script("reviewer", "*", "*", step?.reviewer ?? { output: approve, delayMs: delay() });
  const provider = new FakeSandboxProvider();
  const prs = new MemoryPrSink();
  const deps: BatchDeps = {
    config: parseConfig({ repo: "o/r", prMode: "individual", limits: { maxOpenPrs: 100, ...limits } }),
    runner,
    issues: new ClaimingIssueSource(backend),
    prs,
    provider,
    snapshot: "snap",
    baseCommit: "base000",
    store: new RunStore(await mkdtemp(join(tmpdir(), "b-runs-"))),
    playbooks: new StaticPlaybooks(),
    batchId: "batch",
    factoryVersion: "v",
    playbookHash: "h",
  };
  return { deps, backend, runner, provider, prs };
}

/**
 * Scripted stand-in for a correct agent resolution of two route blocks inserted at the same spot:
 * keep both, closing the first block (git attributes the shared closing brace to common context).
 */
function unionResolve(text: string): string {
  return text.replace(/<<<<<<< [^\n]*\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>> [^\n]*\n/g, "$1  }\n\n$2");
}

const resolveByUnion = (dropTestFile?: string): ScriptStep => ({
  act: async ({ req }) => {
    const files = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: req.cwd })
      .toString()
      .split("\n")
      .filter(Boolean);
    for (const f of files) {
      const p = join(req.cwd, f);
      await writeFile(p, unionResolve(await readFile(p, "utf8")));
    }
    if (dropTestFile) execFileSync("git", ["rm", "-q", dropTestFile], { cwd: req.cwd });
    const out: ConflictResolution = { resolved: true, filesChanged: files, notes: "kept both sides" };
    return out;
  },
});

const withTest = (issue: number, name: string): ScriptStep => ({
  act: async ({ req }) => {
    execFileSync("git", ["apply", refPatch(issue)], { cwd: req.cwd });
    await writeFile(
      join(req.cwd, "test", `${name}.test.ts`),
      `import { it } from "node:test";\nit("${name} works", () => {});\n`,
    );
    return workerDone();
  },
});

describe("batch scheduler", () => {
  it("T5.1 never runs more than `concurrency` pipelines and completes every issue", async () => {
    const { deps } = await fakeBatch(10, { concurrency: 3 });
    let max = 0;
    const r = await runBatch({ ...deps, onActive: (a) => (max = Math.max(max, a)) });
    expect(max).toBe(3);
    expect(r.results).toHaveLength(10);
    expect(r.results.every((x) => x.outcome === "pr_opened")).toBe(true);
  });

  it("T5.2 two factory processes on one tracker process each issue exactly once", async () => {
    const a = await fakeBatch(10, { concurrency: 3 });
    const sharedIssues = a.deps.issues;
    const b = await fakeBatch(0, { concurrency: 3 });
    const [ra, rb] = await Promise.all([
      runBatch(a.deps),
      runBatch({ ...b.deps, issues: sharedIssues, batchId: "batch-b" }),
    ]);
    const processed = [...ra.results, ...rb.results].filter((r) => r.outcome !== "lost_claim");
    expect(processed.map((r) => r.record.issue.number).sort((x, y) => x - y)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    const triaged = [...a.runner.calls, ...b.runner.calls]
      .filter((c) => c.stage === "triage")
      .map((c) => c.issue);
    expect(new Set(triaged).size).toBe(triaged.length);
  });

  it("T5.8/T5.9 first SIGINT drains: nothing new starts, in-flight runs finish", async () => {
    const { deps } = await fakeBatch(
      10,
      { concurrency: 3 },
      { worker: { output: workerDone(), delayMs: 80 } },
    );
    const signals = installSignalHandlers(() => undefined);
    try {
      let fired = false;
      const r = await runBatch({
        ...deps,
        drain: signals.drain.signal,
        cancel: signals.cancel.signal,
        onActive: (a) => {
          if (a === 3 && !fired) {
            fired = true;
            process.emit("SIGINT");
          }
        },
      });
      expect(r.results).toHaveLength(3);
      expect(r.results.every((x) => x.outcome === "pr_opened")).toBe(true);
      expect(r.unstarted.map((u) => u.reason)).toEqual(Array(7).fill("drained"));
    } finally {
      signals.dispose();
    }
  });

  it("T5.9 second SIGINT cancels in-flight runs, releases every claim and destroys every sandbox", async () => {
    const { deps, backend, provider } = await fakeBatch(
      10,
      { concurrency: 3 },
      { worker: { output: workerDone(), delayMs: 5_000 } },
    );
    const signals = installSignalHandlers(() => undefined);
    try {
      let workers = 0;
      deps.onProgress = (_r, stage) => {
        if (stage === "worker" && ++workers === 3) {
          process.emit("SIGINT");
          process.emit("SIGINT");
        }
      };
      const t0 = Date.now();
      const r = await runBatch({ ...deps, drain: signals.drain.signal, cancel: signals.cancel.signal });
      expect(Date.now() - t0).toBeLessThan(4_000);
      expect(r.results.map((x) => x.outcome)).toEqual(["cancelled", "cancelled", "cancelled"]);
      for (let n = 1; n <= 10; n++) {
        const labels = (await backend.getIssue(n)).labels;
        expect(labels).not.toContain(LABELS.claimed);
        expect(labels).toContain(LABELS.ready);
      }
      expect(provider.live).toHaveLength(0);
    } finally {
      signals.dispose();
    }
  });
});

describe("integrator (real git)", () => {
  async function integratedHarness(numbers: number[]) {
    const h = await harness({ prMode: "integrated", limits: { concurrency: 3 } });
    // Only the issues under test are ready.
    for (let n = 1; n <= 10; n++) if (!numbers.includes(n)) await h.backend.removeLabel(n, LABELS.ready);
    h.runner.script("triage", "*", 1, { output: accept() }).script("reviewer", "*", "*", { output: approve });
    for (const n of numbers) h.runner.script("worker", n, 1, applies(refPatch(n)));
    return h;
  }

  it("T5.5 conflicting branches are resolved and every merge is re-verified", async () => {
    const h = await integratedHarness([2, 6, 9]);
    h.runner.script("integrator", 9, 1, resolveByUnion());
    const r = await runBatch(h.deps);
    const integ = r.integration!;
    expect(integ.result.status).toBe("integrated");
    expect(integ.result.merged.sort()).toEqual([2, 6, 9]);
    expect(integ.result.conflictsResolved).toBe(1);
    expect(integ.steps.find((s) => s.issue === 9)!.conflicted).toBe(true);
    for (const s of integ.steps) expect(s.verification!.status).toBe("pass");
    expect(h.prs.prs).toHaveLength(1);
    expect(h.prs.prs[0]!.head).toBe(integ.result.integrationBranch);
    expect(h.prs.prs[0]!.body).toContain("Closes #9");
  });

  it("T5.6/T5.8 an unresolvable merge is ejected, rolled back and re-queued; later branches still integrate", async () => {
    const h = await integratedHarness([2, 8, 9]);
    h.runner.script("integrator", 8, 1, {
      output: { resolved: false, filesChanged: [], notes: "can't tell which side wins" },
    });
    const r = await runBatch(h.deps);
    const integ = r.integration!;
    expect(integ.result.status).toBe("partial");
    expect(integ.result.merged.sort()).toEqual([2, 9]);
    expect(integ.result.ejected).toEqual([{ issue: 8, reason: "conflict-unresolved" }]);
    // The integration branch has no trace of #8's change.
    const router = execFileSync("git", ["show", `${integ.result.integrationBranch}:src/router.ts`], {
      cwd: h.bench.dir,
    }).toString();
    expect(router).not.toContain('req.method === "HEAD"');
    expect(router).toContain('req.method === "DELETE"');
    // T5.8: ejected issue is told why and re-queued.
    expect(h.backend.commentBodies(8).some((b) => b.includes("couldn't be integrated"))).toBe(true);
    expect((await h.backend.getIssue(8)).labels).toContain(LABELS.ready);
  });

  it("T5.7 a resolution that drops a test is ejected as tests-dropped", async () => {
    const h = await integratedHarness([6, 9]);
    h.runner.script("worker", 6, 1, withTest(6, "stats")).script("worker", 9, 1, withTest(9, "delete"));
    h.runner.script("integrator", 9, 1, resolveByUnion("test/stats.test.ts"));
    const r = await runBatch(h.deps);
    expect(r.integration!.result.ejected).toEqual([{ issue: 9, reason: "tests-dropped" }]);
    expect(r.integration!.result.merged).toEqual([6]);
  });
});
