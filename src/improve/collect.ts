// Gathering labeled runs for the retrospective, with the train/holdout wall (R6.2).
import { BENCH_REPO_NAME, type BenchIssue } from "../bench/benchmark.js";
import type { BenchRun } from "../bench/run-factory.js";
import type { RunRecord } from "../contracts/index.js";
import type { CollectedRun } from "./improve.js";

/** Benchmark holdout runs are never shown to the retrospective; everything else is. */
export function isVisible(record: RunRecord, benchIssues: BenchIssue[]): boolean {
  if (record.issue.repo !== BENCH_REPO_NAME) return true;
  return benchIssues.find((i) => i.number === record.issue.number)?.split === "train";
}

export function fromBenchRun(run: BenchRun): CollectedRun[] {
  return run.batch.results
    .filter((r) => r.outcome !== "lost_claim")
    .map((r) => {
      const issue = run.issues.find((i) => i.number === r.record.issue.number);
      return {
        record: r.record,
        ctx: {
          expectedTriage: issue?.expectedTriage,
          hiddenPassed: r.approved ? run.hiddenByIssue[r.record.issue.number] : undefined,
          ejected: run.ejected.has(r.record.issue.number),
        },
        visible: isVisible(r.record, run.issues),
      };
    });
}
