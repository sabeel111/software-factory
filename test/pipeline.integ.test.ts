import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { VerifierResult } from "../src/contracts/index.js";
import { toIssueRef, loadIssues } from "../src/bench/benchmark.js";
import { LABELS } from "../src/issues/types.js";
import { runIssue } from "../src/pipeline/issue-pipeline.js";
import { harness } from "./helpers/harness.js";
import { accept, applies, approve, blocker, refPatch, workerDone, writes } from "./helpers/scripts.js";

const issue = async (n: number) => toIssueRef((await loadIssues()).find((i) => i.number === n)!);

describe("single-issue pipeline (real sandboxes, scripted agents)", () => {
  it("T4.2 accept → correct fix → verifier pass → approve → draft PR with check table", async () => {
    const h = await harness();
    h.runner
      .script("triage", 1, 1, { output: accept(["bare domains default to https"]) })
      .script("worker", 1, 1, applies(refPatch(1)))
      .script("reviewer", 1, 1, { output: approve });
    const r = await runIssue(await issue(1), "run-t42", h.deps);
    expect(r.outcome).toBe("pr_opened");
    expect(h.prs.prs).toHaveLength(1);
    const pr = h.prs.prs[0]!;
    expect(pr.title).toContain("#1");
    expect(pr.body).toContain("| Check | Command | Result | Time |");
    expect(pr.body).toContain("bare domains default to https");
    expect(pr.labels).toContain(LABELS.pr);
    expect(execFileSync("git", ["rev-parse", r.record.branch!], { cwd: h.bench.dir }).toString().trim()).toBe(
      r.record.commitSha,
    );
    const issueLabels = (await h.backend.getIssue(1)).labels;
    expect(issueLabels).toContain(LABELS.pr);
    expect(issueLabels).not.toContain(LABELS.claimed);
  });

  it("T4.3 a worker that claims success with a failing test is caught; attempt 2 gets the verifier result", async () => {
    const h = await harness();
    const failing = `import { it } from "node:test";\nimport assert from "node:assert/strict";\nit("new behavior", () => assert.equal(1, 2));\n`;
    h.runner
      .script("triage", 2, 1, { output: accept() })
      .script("worker", 2, 1, writes({ "test/new.test.ts": failing }, workerDone()))
      .script("worker", 2, 2, {
        act: ({ req }) => {
          execFileSync("rm", ["test/new.test.ts"], { cwd: req.cwd });
          execFileSync("git", ["apply", refPatch(2)], { cwd: req.cwd });
          return workerDone();
        },
      })
      .script("reviewer", 2, 2, { output: approve });
    const r = await runIssue(await issue(2), "run-t43", h.deps);
    const verifierRuns = r.record.stages.filter((s) => s.stage === "verifier");
    expect((verifierRuns[0]!.output as VerifierResult).status).toBe("fail");
    const attempt2 = h.runner.calls.find((c) => c.stage === "worker" && c.attempt === 2)!;
    expect((attempt2.input as { feedback: { verifier: { status: string } } }).feedback.verifier.status).toBe(
      "fail",
    );
    expect(r.outcome).toBe("pr_opened");
  });

  it("T4.4 two failed attempts end the run as failed with a summary and factory:failed", async () => {
    const h = await harness();
    const failing = `import { it } from "node:test";\nit("x", () => { throw new Error("no"); });\n`;
    h.runner
      .script("triage", 3, 1, { output: accept() })
      .script("worker", 3, "*", writes({ "test/fail.test.ts": failing }));
    const r = await runIssue(await issue(3), "run-t44", h.deps);
    expect(r.outcome).toBe("failed");
    expect(h.runner.calls.filter((c) => c.stage === "worker")).toHaveLength(2);
    expect(h.backend.commentBodies(3).some((b) => b.includes("gave up on this issue after 2 attempt"))).toBe(
      true,
    );
    expect((await h.backend.getIssue(3)).labels).toContain(LABELS.failed);
  });

  it("T4.5 a reviewer blocker sends the findings to attempt 2; an approved attempt 2 opens a PR", async () => {
    const h = await harness();
    h.runner
      .script("triage", 7, 1, { output: accept() })
      .script("worker", 7, 1, applies(refPatch(7)))
      .script("reviewer", 7, 1, { output: blocker() })
      .script("worker", 7, 2, { output: workerDone() })
      .script("reviewer", 7, 2, { output: approve });
    const r = await runIssue(await issue(7), "run-t45", h.deps);
    const attempt2 = h.runner.calls.find((c) => c.stage === "worker" && c.attempt === 2)!;
    expect(
      (attempt2.input as { feedback: { review: { findings: unknown[] } } }).feedback.review.findings,
    ).toHaveLength(1);
    expect(r.outcome).toBe("pr_opened");
  });

  it("T4.6 editing CI config fails the protected-paths check", async () => {
    const h = await harness();
    h.runner
      .script("triage", 8, 1, { output: accept() })
      .script("worker", 8, "*", writes({ ".github/workflows/ci.yml": "on: push\n" }));
    const r = await runIssue(await issue(8), "run-t46", h.deps);
    const v = r.record.stages.find((s) => s.stage === "verifier")!.output as VerifierResult;
    expect(v.status).toBe("fail");
    expect(v.checks[0]!.name).toBe("protected-paths");
    expect(v.checks[0]!.outputTail).toContain(".github/workflows/ci.yml");
  });

  it("T4.6b weakening the graded test script also fails protected-paths", async () => {
    const h = await harness();
    h.runner.script("triage", 8, 1, { output: accept() }).script("worker", 8, "*", {
      act: async ({ req }) => {
        const { readFile, writeFile } = await import("node:fs/promises");
        const pkg = JSON.parse(await readFile(`${req.cwd}/package.json`, "utf8"));
        pkg.scripts.test = "true";
        await writeFile(`${req.cwd}/package.json`, JSON.stringify(pkg));
        return workerDone();
      },
    });
    const r = await runIssue(await issue(8), "run-t46b", h.deps);
    const v = r.record.stages.find((s) => s.stage === "verifier")!.output as VerifierResult;
    expect(v.checks[0]!.outputTail).toContain("package.json#scripts.test");
  });

  it("T4.7 the verifier uses its own sandbox and checks out the worker's exact commit", async () => {
    const h = await harness();
    h.runner
      .script("triage", 6, 1, { output: accept() })
      .script("worker", 6, 1, applies(refPatch(6)))
      .script("reviewer", 6, 1, { output: approve });
    const r = await runIssue(await issue(6), "run-t47", h.deps);
    const workerCwd = h.runner.calls.find((c) => c.stage === "worker")!.cwd;
    const reviewerCwd = h.runner.calls.find((c) => c.stage === "reviewer")!.cwd;
    expect(reviewerCwd).not.toBe(workerCwd);
    const v = r.record.stages.find((s) => s.stage === "verifier")!.output as VerifierResult;
    expect(v.commitSha).toBe(r.record.commitSha);
    expect(v.status).toBe("pass");
    expect(v.testSummary?.failed).toBe(0);
  });
});
