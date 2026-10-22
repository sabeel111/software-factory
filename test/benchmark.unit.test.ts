import { describe, expect, it } from "vitest";
import { BenchIssue, loadIssues } from "../src/bench/benchmark.js";
import { noiseBand, triageAccuracy } from "../src/bench/score.js";
import { IssueRef } from "../src/contracts/index.js";

describe("benchmark issues", () => {
  it("T1.5 triage accuracy counts correct accept/reject decisions", async () => {
    const issues = await loadIssues();
    const triage: Record<number, "accept" | "reject"> = {};
    for (let n = 1; n <= 9; n++) triage[n] = "accept";
    triage[10] = "reject";
    expect(triageAccuracy(issues, triage)).toBe(1);
    triage[10] = "accept";
    expect(triageAccuracy(issues, triage)).toBeCloseTo(0.9);
    expect(triageAccuracy(issues, undefined)).toBeNull();
  });

  it("T1.7 every issue validates and the split is 5 train / 5 holdout", async () => {
    const issues = await loadIssues();
    expect(issues).toHaveLength(10);
    for (const i of issues) {
      expect(BenchIssue.safeParse(i).success).toBe(true);
      expect(IssueRef.safeParse({ ...i, repo: "bench/tinylinks" }).success).toBe(true);
      expect(i.hidden === null).toBe(i.expectedTriage === "reject");
    }
    expect(issues.filter((i) => i.split === "train")).toHaveLength(5);
    expect(issues.filter((i) => i.split === "holdout")).toHaveLength(5);
    expect((await loadIssues(undefined, "holdout")).map((i) => i.number)).toEqual([3, 4, 7, 8, 9]);
  });

  it("noise band is the spread of repeated resolve rates", () => {
    expect(noiseBand([0.6, 0.62, 0.58])).toBeCloseTo(0.04);
    expect(noiseBand([0.7])).toBe(0);
  });
});
