// Canned agent outputs for scripting FakeAgentRunner.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { ScriptStep } from "../../src/agents/fake-runner.js";
import { BENCH_ROOT } from "../../src/bench/benchmark.js";
import type { ReviewResult, TriageResult, WorkerAgentOutput } from "../../src/contracts/index.js";

export const accept = (criteria = ["it works"]): TriageResult => ({
  decision: "accept",
  reason: "clear",
  kind: "bug",
  acceptanceCriteria: criteria,
  clarifyingQuestions: [],
  estimatedComplexity: "s",
});

export const reject = (questions = ["What does 'better' mean?"]): TriageResult => ({
  decision: "reject",
  reason: "too vague to verify",
  acceptanceCriteria: [],
  clarifyingQuestions: questions,
  estimatedComplexity: "m",
});

export const workerDone = (files: string[] = ["src/router.ts"]): WorkerAgentOutput => ({
  status: "done",
  touchedFiles: files,
  testsAdded: ["test/app.test.ts"],
  summary: "implemented",
});

export const approve: ReviewResult = { verdict: "approve", findings: [], scopeCreep: false };

export const blocker = (message = "off by one at the expiry boundary"): ReviewResult => ({
  verdict: "request_changes",
  findings: [{ severity: "blocker", file: "src/router.ts", line: 40, message }],
  scopeCreep: false,
});

/** A worker that applies a patch file to its working directory. */
export function applies(patch: string, out: WorkerAgentOutput = workerDone()): ScriptStep {
  return {
    act: ({ req }) => {
      execFileSync("git", ["apply", "--whitespace=nowarn", patch], { cwd: req.cwd });
      return out;
    },
    costUsd: 0.1,
  };
}

/** A worker that writes arbitrary files. */
export function writes(files: Record<string, string>, out: WorkerAgentOutput = workerDone()): ScriptStep {
  return {
    act: async ({ req }) => {
      const { writeFile, mkdir } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      for (const [rel, content] of Object.entries(files)) {
        await mkdir(dirname(join(req.cwd, rel)), { recursive: true });
        await writeFile(join(req.cwd, rel), content);
      }
      return out;
    },
    costUsd: 0.1,
  };
}

export const refPatch = (n: number | "all") =>
  join(BENCH_ROOT, "reference", `${typeof n === "number" ? String(n).padStart(2, "0") : n}.patch`);
export const defectPatch = (id: string) => join(BENCH_ROOT, "seeded-defects", `${id}.patch`);
