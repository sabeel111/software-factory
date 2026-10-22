// Reviewer catch rate on seeded defects (specs/05-single-issue-pipeline.md T4.14).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { READ_ONLY_TOOLS, type AgentRunner } from "../agents/runner.js";
import type { StageConfig } from "../config.js";
import { ReviewResult } from "../contracts/index.js";
import type { Playbooks } from "../pipeline/playbooks.js";
import type { SandboxProvider, SnapshotId } from "../sandbox/types.js";
import { BENCH_ROOT, branchWithPatch, loadIssues, toIssueRef, type PreparedBench } from "./benchmark.js";

const DefectIndex = z.array(
  z.object({ id: z.string(), issue: z.number(), defect: z.string(), patch: z.string() }),
);

export interface CatchResult {
  id: string;
  issue: number;
  caught: boolean;
  findings: number;
}

export async function reviewerCatchRate(opts: {
  bench: PreparedBench;
  provider: SandboxProvider;
  snapshot: SnapshotId;
  runner: AgentRunner;
  playbooks: Playbooks;
  reviewer: StageConfig;
  root?: string;
}): Promise<{ rate: number; results: CatchResult[] }> {
  const root = opts.root ?? BENCH_ROOT;
  const defects = DefectIndex.parse(
    JSON.parse(await readFile(join(root, "seeded-defects", "index.json"), "utf8")),
  );
  const issues = await loadIssues(root);
  const results: CatchResult[] = [];
  for (const d of defects) {
    const issue = issues.find((i) => i.number === d.issue)!;
    const sha = await branchWithPatch(
      opts.bench.dir,
      `factory/defect-${d.id}`,
      opts.bench.baseCommit,
      join(root, "seeded-defects", d.patch),
    );
    const box = await opts.provider.create({ snapshot: opts.snapshot, label: `defect-${d.id}` });
    try {
      await box.exec("git fetch -q origin");
      await box.checkout(sha);
      const diff = await box.exec(`git diff ${opts.bench.baseCommit} ${sha}`);
      const r = await opts.runner.run({
        stage: "reviewer",
        issue: d.issue,
        attempt: 1,
        playbook: await opts.playbooks.get("reviewer"),
        input: {
          issue: toIssueRef(issue),
          acceptanceCriteria: [issue.body],
          diff: diff.stdout,
          verification: { status: "pass", testSummary: null, checks: [{ name: "test", exitCode: 0 }] },
        },
        outputSchema: ReviewResult,
        cwd: box.path,
        tools: READ_ONLY_TOOLS,
        model: opts.reviewer.model,
        effort: opts.reviewer.effort,
      });
      const caught =
        r.output.verdict === "request_changes" || r.output.findings.some((f) => f.severity === "blocker");
      results.push({ id: d.id, issue: d.issue, caught, findings: r.output.findings.length });
    } finally {
      await box.destroy();
    }
  }
  return { rate: results.filter((r) => r.caught).length / results.length, results };
}
