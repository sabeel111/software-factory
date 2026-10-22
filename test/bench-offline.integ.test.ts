// The whole factory against the benchmark, offline: oracle agents stand in for Claude.
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAgentRunner } from "../src/agents/fake-runner.js";
import { benchmarkOnce } from "../src/bench/run-factory.js";
import type { ConflictResolution } from "../src/contracts/index.js";
import { accept, applies, approve, refPatch, reject } from "./helpers/scripts.js";

function oracleRunner(): FakeAgentRunner {
  const runner = new FakeAgentRunner();
  for (let n = 1; n <= 9; n++) {
    runner.script("triage", n, 1, { output: accept(), costUsd: 0.01 });
    runner.script("worker", n, 1, applies(refPatch(n)));
  }
  runner.script("triage", 10, 1, { output: reject(), costUsd: 0.01 });
  runner.script("reviewer", "*", "*", { output: approve, costUsd: 0.02 });
  // Resolve each conflicted file to its fully-integrated reference version.
  runner.script("integrator", "*", "*", {
    act: async ({ req }) => {
      const files = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: req.cwd })
        .toString()
        .split("\n")
        .filter(Boolean);
      for (const f of files) {
        const text = execFileSync("git", ["show", `refs/remotes/origin/ref/all:${f}`], { cwd: req.cwd });
        await writeFile(join(req.cwd, f), text);
      }
      const out: ConflictResolution = { resolved: true, filesChanged: files, notes: "oracle" };
      return out;
    },
    costUsd: 0.05,
  });
  return runner;
}

describe("benchmark, end to end with oracle agents", () => {
  it("resolves 9/9 through triage, parallel workers, integration and hidden-test scoring", async () => {
    const run = await benchmarkOnce({
      runner: oracleRunner(),
      config: { limits: { concurrency: 4 } },
      runsRoot: await mkdtemp(join(tmpdir(), "bench-runs-")),
      record: false,
    });
    expect(run.triageAccuracy).toBe(1);
    expect(run.batch.integration!.result.merged.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(run.batch.integration!.result.conflictsResolved).toBeGreaterThanOrEqual(2);
    expect(run.score.resolved).toBe(9);
    expect(run.falsePassRate).toBe(0);
    expect(run.costUsd).toBeGreaterThan(0);
  });
});
