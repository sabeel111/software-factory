// `factory bench`: score the factory (or reference solutions) against hidden tests.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIssues, prepareBenchRepo, type Split } from "../bench/benchmark.js";
import { appendResult, scoreCandidate, type BenchScore } from "../bench/score.js";
import { registerCommand } from "../cli.js";
import { factoryVersion, playbookHash } from "../store/run-store.js";

export function formatScore(score: BenchScore): string {
  const rows = score.perIssue.map((p) => `  #${String(p.issue).padEnd(3)} ${p.passed ? "PASS" : "fail"}`);
  const triage = score.triageAccuracy === null ? "n/a" : `${Math.round(score.triageAccuracy * 100)}%`;
  return [
    ...rows,
    `Resolved ${score.resolved}/${score.total} (${Math.round(score.resolveRate * 100)}%) · triage accuracy ${triage} · ${(score.durationMs / 1000).toFixed(1)}s`,
  ].join("\n");
}

registerCommand("bench", async (opts) => {
  const split = (opts.split as Split) ?? "all";
  const issues = await loadIssues(undefined, split);
  const work = await mkdtemp(join(tmpdir(), "factory-bench-"));
  try {
    const bench = await prepareBenchRepo(work);
    if (opts.reference || opts.candidate) {
      const candidateRef = opts.reference ? bench.referenceBranches.all! : String(opts.candidate);
      // Reference runs use the expected triage decisions (a scripted triage).
      const triage = opts.reference
        ? Object.fromEntries(issues.map((i) => [i.number, i.expectedTriage]))
        : undefined;
      const score = await scoreCandidate({ repo: bench.dir, candidateRef, issues, triage });
      console.log(formatScore(score));
      await appendResult({
        at: new Date().toISOString(),
        label: opts.reference ? "reference" : `candidate:${candidateRef}`,
        factoryVersion: factoryVersion(),
        playbookHash: await playbookHash(),
        models: {},
        costUsd: 0,
        split,
        score,
      });
      return score.resolved === score.total ? 0 : 1;
    }
    const { runFactoryBenchmark } = await import("../bench/run-factory.js");
    return runFactoryBenchmark({
      bench,
      issues,
      split,
      repeat: Number(opts.repeat ?? 1),
      configPath: opts.config as string | undefined,
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
