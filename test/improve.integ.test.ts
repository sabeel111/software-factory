import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAgentRunner } from "../src/agents/fake-runner.js";
import type { RunRecord, VerifierResult } from "../src/contracts/index.js";
import type { EvalScores, RetroOutput } from "../src/improve/candidate.js";
import { History } from "../src/improve/history.js";
import { improve, revertCandidate } from "../src/improve/improve.js";
import { GitPromoter } from "../src/improve/promoter.js";
import { MemoryPrSink } from "../src/pipeline/pr.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd }).toString().trim();

async function factoryRepo() {
  const dir = await mkdtemp(join(tmpdir(), "self-"));
  await mkdir(join(dir, "playbooks"));
  for (const s of ["triage", "worker", "reviewer", "integrator", "retro"]) {
    await writeFile(join(dir, "playbooks", `${s}.md`), `# ${s}\n\nOriginal ${s} guidance.\n`);
  }
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  return dir;
}

const failingRecord: RunRecord = {
  runId: "r1",
  batchId: "b",
  issue: { repo: "o/r", number: 1, title: "t", body: "b", labels: [] },
  startedAt: "2026-01-01T00:00:00Z",
  factoryVersion: "v",
  playbookHash: "h",
  outcome: "failed",
  stages: [1, 2].map((attempt) => ({
    stage: "verifier" as const,
    attempt,
    startedAt: "2026-01-01T00:00:00Z",
    durationMs: 1,
    costUsd: 0,
    tokens: { input: 0, output: 0 },
    output: {
      status: "fail",
      commitSha: `c${attempt}`,
      checks: [{ name: "test", command: "npm test", exitCode: 1, durationMs: 1, outputTail: "boundary" }],
      testSummary: null,
    } satisfies VerifierResult,
  })),
};

const s = (resolveRate: number): EvalScores => ({
  resolveRate,
  triageAccuracy: 1,
  falsePassRate: 0,
  costPerResolved: 1,
  costUsd: 1,
});

async function acceptedRun() {
  const repo = await factoryRepo();
  const prs = new MemoryPrSink();
  const promoter = new GitPromoter({ repoDir: repo, baseBranch: "main", prs });
  const history = new History(join(repo, "playbooks", "HISTORY.jsonl"));
  const retro: RetroOutput = {
    candidates: [
      {
        hypothesis:
          "Workers skip exact-boundary cases; asking for a boundary test fixes expiry-style failures",
        targets: ["verify-fail-repeat"],
        playbookChanges: [
          { file: "playbooks/worker.md", content: "# worker\n\nAlways test the exact boundary.\n" },
        ],
        stageSettings: [{ stage: "worker", effort: "xhigh" }],
      },
    ],
    selfIssues: [],
  };
  const report = await improve({
    runner: new FakeAgentRunner().script("retro", 0, 1, { output: retro }),
    retro: { model: "m", effort: "high" },
    playbooksDir: join(repo, "playbooks"),
    history,
    promoter,
    maxUsd: 100,
    repeat: 3,
    collect: async () => [{ record: failingRecord, ctx: {}, visible: true }],
    evaluate: async ({ playbooksDir }) => {
      const worker = await readFile(join(playbooksDir, "worker.md"), "utf8");
      return worker.includes("exact boundary") ? s(0.8) : s(0.6);
    },
  });
  return { repo, prs, promoter, history, report };
}

describe("promotion and revert (real git)", () => {
  it("T6.10 an accepted candidate opens a PR with hypothesis and score table, and HISTORY gains a line", async () => {
    const { repo, prs, history, report } = await acceptedRun();
    expect(report.candidates[0]).toMatchObject({ decision: "accepted" });
    expect(prs.prs).toHaveLength(1);
    const pr = prs.prs[0]!;
    expect(pr.body).toContain("Workers skip exact-boundary cases");
    expect(pr.body).toContain("| Resolve rate (holdout) | 60.0% | 80.0% |");
    const entries = await history.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.accepted).toBe(true);
    // The PR branch carries exactly the candidate's files; the user's checkout is untouched.
    const changed = git(repo, "diff", "--name-only", "main", pr.head).split("\n").sort();
    expect(changed).toEqual(["playbooks/stages.json", "playbooks/worker.md"]);
    expect(JSON.parse(git(repo, "show", `${pr.head}:playbooks/stages.json`))).toEqual({
      worker: { effort: "xhigh" },
    });
    expect(git(repo, "status", "--porcelain")).toBe("?? playbooks/HISTORY.jsonl");
  });

  it("T6.11 revert produces a PR whose diff exactly inverts the candidate", async () => {
    const { repo, prs, promoter, history, report } = await acceptedRun();
    const candidateId = report.candidates[0]!.candidateId;
    // Pretend the human merged the improvement.
    git(repo, "merge", "-q", "--ff-only", prs.prs[0]!.head);
    await revertCandidate(candidateId, history, promoter);
    const revert = prs.prs[1]!;
    expect(revert.title).toContain(candidateId);
    expect(git(repo, "diff", "--stat", `${prs.prs[0]!.head}~1`, revert.head)).toBe("");
    expect((await history.entries()).at(-1)!.revertOf).toBe(candidateId);
  });
});
