import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAgentRunner } from "../src/agents/fake-runner.js";
import { loadIssues, toIssueRef } from "../src/bench/benchmark.js";
import type { RunRecord, StageRecord, VerifierResult } from "../src/contracts/index.js";
import {
  checkBounds,
  gate,
  type CandidateProposal,
  type EvalScores,
  type RetroOutput,
} from "../src/improve/candidate.js";
import { isVisible } from "../src/improve/collect.js";
import { History } from "../src/improve/history.js";
import { improve, type CollectedRun, type Promoter } from "../src/improve/improve.js";
import { classify } from "../src/improve/taxonomy.js";
import { approve } from "./helpers/scripts.js";

const proposal = (files: string[], extra: Partial<CandidateProposal> = {}): CandidateProposal => ({
  hypothesis: "test boundaries explicitly",
  targets: ["false-pass"],
  playbookChanges: files.map((file) => ({ file, content: "# new\n" })),
  ...extra,
});

const scores = (resolveRate: number, o: Partial<EvalScores> = {}): EvalScores => ({
  resolveRate,
  triageAccuracy: 1,
  falsePassRate: 0.1,
  costPerResolved: 1,
  costUsd: 2,
  ...o,
});

const verifier = (status: "pass" | "fail", sha = "c1", check = "test"): VerifierResult => ({
  status,
  commitSha: sha,
  checks: [
    {
      name: check,
      command: "npm test",
      exitCode: status === "pass" ? 0 : 1,
      durationMs: 1,
      outputTail: "boom",
    },
  ],
  testSummary: null,
});

const stage = (s: StageRecord["stage"], attempt: number, output: unknown): StageRecord => ({
  stage: s,
  attempt,
  startedAt: "2026-01-01T00:00:00Z",
  durationMs: 1,
  costUsd: 0.1,
  tokens: { input: 1, output: 1 },
  output,
});

const record = (
  issue: RunRecord["issue"],
  stages: StageRecord[],
  outcome: RunRecord["outcome"] = "failed",
): RunRecord => ({
  runId: `r-${issue.number}`,
  batchId: "b",
  issue,
  startedAt: "2026-01-01T00:00:00Z",
  factoryVersion: "v",
  playbookHash: "h",
  stages,
  outcome,
});

describe("bounds", () => {
  it("T6.1 candidates touching factory code or hidden tests are out of bounds", () => {
    expect(checkBounds(proposal(["src/agents/runner.ts"]))).toMatchObject({
      ok: false,
      reason: "out-of-bounds",
    });
    expect(checkBounds(proposal(["bench/tinylinks/hidden/h03.test.ts"]))).toMatchObject({ ok: false });
    expect(checkBounds(proposal(["playbooks/../src/cli.ts"]))).toMatchObject({ ok: false });
    expect(checkBounds(proposal(["/abs/playbooks/worker.md"]))).toMatchObject({ ok: false });
    expect(checkBounds(proposal(["playbooks/HISTORY.jsonl"]))).toMatchObject({ ok: false });
    expect(checkBounds(proposal(["playbooks/stages.json"]))).toMatchObject({ ok: false });
    expect(
      checkBounds(proposal([], { stageSettings: [{ stage: "worker", effort: "max", limits: 1 } as never] })),
    ).toMatchObject({
      ok: false,
    });
    expect(
      checkBounds(proposal([], { stageSettings: [{ stage: "verifier", effort: "max" }] })),
    ).toMatchObject({ ok: false });
  });

  it("T6.2 playbook edits and stage settings are in bounds", () => {
    expect(
      checkBounds(
        proposal(["playbooks/worker.md"], { stageSettings: [{ stage: "worker", effort: "xhigh" }] }),
      ),
    ).toEqual({
      ok: true,
    });
  });
});

describe("gate", () => {
  it("T6.4 a clear improvement with no regressions is accepted", () => {
    const d = gate(
      [scores(0.6), scores(0.62), scores(0.58)],
      [scores(0.7), scores(0.72), scores(0.68)],
      0.04,
    );
    expect(d).toMatchObject({ accepted: true, reason: "accepted" });
  });

  it("T6.5 an improvement inside the noise band is rejected", () => {
    const d = gate([scores(0.6), scores(0.6), scores(0.6)], [scores(0.63), scores(0.63), scores(0.63)], 0.04);
    expect(d).toMatchObject({ accepted: false, reason: "within-noise" });
  });

  it("T6.6 a triage accuracy drop rejects even a big resolve gain", () => {
    const d = gate([scores(0.6)], [scores(0.7, { triageAccuracy: 0.9 })], 0.04);
    expect(d).toMatchObject({ accepted: false, reason: "triage-regression" });
  });

  it("T6.7 cost per resolved above 1.25× the champion is rejected", () => {
    const d = gate([scores(0.6)], [scores(0.7, { costPerResolved: 1.4 })], 0.04);
    expect(d).toMatchObject({ accepted: false, reason: "cost-regression" });
  });

  it("a false-pass regression is rejected", () => {
    const d = gate([scores(0.6)], [scores(0.7, { falsePassRate: 0.3 })], 0.04);
    expect(d).toMatchObject({ accepted: false, reason: "false-pass-regression" });
  });
});

describe("taxonomy", () => {
  const issue = { repo: "o/r", number: 1, title: "t", body: "b", labels: [] };

  it("T6.8 labels false passes and review misses", () => {
    // Verifier passed, no review happened (budget), hidden test failed.
    const falsePass = record(issue, [stage("verifier", 1, verifier("pass"))], "budget_exceeded");
    expect(classify(falsePass, { hiddenPassed: false }).sort()).toEqual(["budget", "false-pass"]);

    // Verifier passed, reviewer approved, hidden test failed.
    const reviewMiss = record(
      issue,
      [stage("verifier", 1, verifier("pass")), stage("reviewer", 1, approve)],
      "pr_opened",
    );
    expect(classify(reviewMiss, { hiddenPassed: false })).toContain("review-miss");
  });

  it("labels triage mistakes, repeated verify failures, review noise, ejects and timeouts", () => {
    const triageAccept = record(issue, [
      stage("triage", 1, {
        decision: "accept",
        reason: "",
        acceptanceCriteria: ["x"],
        clarifyingQuestions: [],
        estimatedComplexity: "s",
      }),
    ]);
    expect(classify(triageAccept, { expectedTriage: "reject" })).toEqual(["triage-false-accept"]);

    const repeat = record(issue, [
      stage("verifier", 1, verifier("fail", "a")),
      stage("verifier", 2, verifier("fail", "b")),
    ]);
    expect(classify(repeat)).toEqual(["verify-fail-repeat"]);

    const noise = record(issue, [
      stage("verifier", 1, verifier("pass", "good")),
      stage("reviewer", 1, { verdict: "request_changes", findings: [], scopeCreep: false }),
    ]);
    expect(classify(noise, { hiddenPassedByCommit: { good: true } })).toEqual(["review-noise"]);

    const timeout = record(issue, [
      { ...stage("worker", 1, null), error: "AgentTimeout: worker exceeded 900s" },
    ]);
    expect(classify(timeout, { ejected: true }).sort()).toEqual(["integration-eject", "timeout"]);
  });
});

function fixedCollector(runs: CollectedRun[]) {
  return async () => runs;
}

const nullPromoter: Promoter = { promote: async () => "pr://1" };

async function playbooksDir() {
  const dir = await mkdtemp(join(tmpdir(), "pb-"));
  for (const s of ["triage", "worker", "reviewer", "integrator", "retro"])
    await writeFile(join(dir, `${s}.md`), `# ${s}\n`);
  return dir;
}

describe("improvement loop", () => {
  it("T6.3 the retrospective sees only train-split benchmark runs", async () => {
    const issues = await loadIssues();
    const runs: CollectedRun[] = issues.map((i) => {
      const r = record(toIssueRef(i), [
        stage("verifier", 1, verifier("fail", "a")),
        stage("verifier", 2, verifier("fail", "b")),
      ]);
      return { record: r, ctx: {}, visible: isVisible(r, issues) };
    });
    const runner = new FakeAgentRunner().script("retro", 0, 1, {
      output: { candidates: [], selfIssues: [] } satisfies RetroOutput,
    });
    const dir = await playbooksDir();
    await improve({
      runner,
      retro: { model: "m", effort: "high" },
      playbooksDir: dir,
      history: new History(join(dir, "HISTORY.jsonl")),
      promoter: nullPromoter,
      maxUsd: 10,
      collect: fixedCollector(runs),
      evaluate: async () => scores(0.5),
    });
    const input = JSON.stringify(runner.calls[0]!.input);
    const shown = new Set(
      (
        runner.calls[0]!.input as { failureClusters: { excerpts: { issue: number }[] }[] }
      ).failureClusters.flatMap((c) => c.excerpts.map((e) => e.issue)),
    );
    const train = new Set(issues.filter((i) => i.split === "train").map((i) => i.number));
    expect(shown.size).toBeGreaterThan(0);
    for (const n of shown) expect(train.has(n)).toBe(true);
    for (const h of issues.filter((i) => i.split === "holdout")) {
      expect(input).not.toContain(h.title);
      expect(input).not.toContain(h.body.slice(0, 40));
    }
  });

  it("T6.9 the hard budget caps evaluations; the rest are recorded as not-evaluated", async () => {
    const issue = { repo: "o/r", number: 1, title: "t", body: "b", labels: [] };
    const failing = record(issue, [
      stage("verifier", 1, verifier("fail", "a")),
      stage("verifier", 2, verifier("fail", "b")),
    ]);
    const retro: RetroOutput = {
      candidates: [
        proposal(["playbooks/worker.md"]),
        proposal(["playbooks/reviewer.md"]),
        proposal(["playbooks/triage.md"]),
      ],
      selfIssues: [],
    };
    const runner = new FakeAgentRunner().script("retro", 0, 1, { output: retro, costUsd: 0 });
    const dir = await playbooksDir();
    const history = new History(join(dir, "HISTORY.jsonl"));
    let evaluations = 0;
    const report = await improve({
      runner,
      retro: { model: "m", effort: "high" },
      playbooksDir: dir,
      history,
      promoter: nullPromoter,
      maxUsd: 5,
      repeat: 1,
      championScores: [scores(0.5)],
      collect: fixedCollector([{ record: failing, ctx: {}, visible: true }]),
      evaluate: async () => {
        evaluations++;
        return scores(0.5, { costUsd: 2 });
      },
    });
    expect(evaluations).toBe(2);
    expect(report.candidates.map((c) => c.decision)).toEqual([
      "within-noise",
      "within-noise",
      "not-evaluated: budget",
    ]);
    const entries = await history.entries();
    expect(entries.map((e) => e.decision)).toEqual(["within-noise", "within-noise", "not-evaluated: budget"]);
    expect(report.spentUsd).toBe(4);
  });

  it("out-of-bounds candidates are rejected before evaluation", async () => {
    const issue = { repo: "o/r", number: 1, title: "t", body: "b", labels: [] };
    const failing = record(issue, [
      stage("verifier", 1, verifier("fail", "a")),
      stage("verifier", 2, verifier("fail", "b")),
    ]);
    const runner = new FakeAgentRunner().script("retro", 0, 1, {
      output: { candidates: [proposal(["src/pipeline/verifier.ts"])], selfIssues: [] } satisfies RetroOutput,
    });
    const dir = await playbooksDir();
    let evaluations = 0;
    const report = await improve({
      runner,
      retro: { model: "m", effort: "high" },
      playbooksDir: dir,
      history: new History(join(dir, "HISTORY.jsonl")),
      promoter: nullPromoter,
      maxUsd: 10,
      repeat: 1,
      championScores: [scores(0.5)],
      collect: fixedCollector([{ record: failing, ctx: {}, visible: true }]),
      evaluate: async () => {
        evaluations++;
        return scores(0.9);
      },
    });
    expect(evaluations).toBe(0);
    expect(report.candidates[0]!.decision).toBe("out-of-bounds");
  });
});
