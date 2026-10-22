// Scripted agents for demo mode (specs/09-control-ui.md R8.7). The agents are fake; everything
// they touch is real: a TinyLinks git repo, worktree sandboxes, the verifier's actual `npm test`,
// real merges, and hidden-test scoring.
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeAgentRunner, type ActivityScript, type ScriptStep } from "../agents/fake-runner.js";
import { BENCH_ROOT, type BenchIssue } from "../bench/benchmark.js";
import type {
  ConflictResolution,
  ReviewResult,
  TriageResult,
  WorkerAgentOutput,
} from "../contracts/index.js";
import type { RetroOutput } from "../improve/candidate.js";

/** Deterministic per-issue jitter so demo runs look alive but repeatable. */
function jitter(seed: number, min: number, max: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return min + (x - Math.floor(x)) * (max - min);
}

const patch = (dir: "reference" | "seeded-defects", name: string) => join(BENCH_ROOT, dir, `${name}.patch`);
const ref = (n: number) => patch("reference", String(n).padStart(2, "0"));

const TOUCHES: Record<number, string[]> = {
  1: ["src/url.ts"],
  2: ["src/router.ts"],
  3: ["src/router.ts"],
  4: ["src/store.ts"],
  5: ["src/store.ts", "src/router.ts"],
  6: ["src/router.ts"],
  7: ["src/store.ts", "src/router.ts"],
  8: ["src/router.ts"],
  9: ["src/store.ts", "src/router.ts"],
};

function criteria(issue: BenchIssue): string[] {
  const bullets = issue.body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).replace(/`/g, ""));
  return bullets.length ? bullets : [issue.title];
}

async function addTest(cwd: string, n: number) {
  await mkdir(join(cwd, "test"), { recursive: true });
  await writeFile(
    join(cwd, "test", `issue-${n}.test.ts`),
    `import assert from "node:assert/strict";\nimport { it } from "node:test";\nimport { startServer } from "../src/server.ts";\n\nit("issue #${n}: server starts with the change", async () => {\n  const s = await startServer();\n  const res = await fetch(\`\${s.url}/links\`, { method: "POST", body: JSON.stringify({ url: "https://example.com/${n}" }) });\n  assert.ok(res.status < 500);\n  await s.close();\n});\n`,
  );
}

function workerActivity(n: number, files: string[], attempt: number): ActivityScript {
  return [
    {
      kind: "text",
      detail:
        attempt > 1 ? "Reading the feedback from the previous attempt" : "Reading the code the issue touches",
    },
    ...files.map((f) => ({ kind: "tool" as const, tool: "Read", detail: f })),
    { kind: "tool", tool: "Read", detail: "test/app.test.ts" },
    { kind: "tool", tool: "Grep", detail: "/startServer/ in test" },
    ...files.map((f) => ({ kind: "tool" as const, tool: "Edit", detail: f })),
    { kind: "tool", tool: "Write", detail: `test/issue-${n}.test.ts` },
    { kind: "tool", tool: "Bash", detail: "npm test" },
    { kind: "text", detail: "All tests pass; summarising the change" },
  ];
}

export interface DemoSpeed {
  /** Multiplier on every scripted delay (1 = demo pace, 0.1 = fast). */
  factor: number;
}

export function demoRunner(issues: BenchIssue[], speed: DemoSpeed = { factor: 1 }): FakeAgentRunner {
  const r = new FakeAgentRunner();
  const d = (n: number, min: number, max: number) => Math.round(jitter(n, min, max) * speed.factor);

  for (const issue of issues) {
    const n = issue.number;
    const files = TOUCHES[n] ?? ["src/router.ts"];
    const triageActivity: ActivityScript = [
      { kind: "tool", tool: "Read", detail: "README.md" },
      { kind: "tool", tool: "Glob", detail: "src/**/*.ts" },
      {
        kind: "tool",
        tool: "Grep",
        detail: `/${issue.kind === "vague" ? "fast" : (files[0] ?? "").replace(/^src\/|\.ts$/g, "")}/ in src`,
      },
      ...files.map((f) => ({ kind: "tool" as const, tool: "Read", detail: f })),
    ];

    if (issue.expectedTriage === "reject") {
      const out: TriageResult = {
        decision: "reject",
        reason: "No measurable target: 'better' and 'faster' can't be turned into checkable behaviour.",
        acceptanceCriteria: [],
        clarifyingQuestions: [
          "Which part is slow — creating links, redirects, or something else?",
          "What latency or throughput should we hit, measured how?",
          "What does 'better' mean for users: new features, reliability, UI?",
        ],
        estimatedComplexity: "m",
      };
      r.script("triage", n, 1, {
        output: out,
        costUsd: 0.04,
        delayMs: d(n, 2500, 4000),
        activity: [
          ...triageActivity,
          { kind: "text", detail: "The issue has no checkable target; asking for clarification" },
        ],
      });
      continue;
    }

    const triage: TriageResult = {
      decision: "accept",
      reason: "Clear, testable behaviour change.",
      kind: issue.kind === "bug" ? "bug" : "feature",
      acceptanceCriteria: criteria(issue),
      clarifyingQuestions: [],
      estimatedComplexity: files.length > 1 ? "m" : "s",
    };
    r.script("triage", n, 1, {
      output: triage,
      costUsd: Number(jitter(n, 0.02, 0.06).toFixed(3)),
      delayMs: d(n, 1800, 3500),
      activity: [
        ...triageActivity,
        { kind: "text", detail: `Accepting with ${triage.acceptanceCriteria.length} acceptance criteria` },
      ],
    });

    const done = (attempt: number): WorkerAgentOutput => ({
      status: "done",
      touchedFiles: [...files, `test/issue-${n}.test.ts`],
      testsAdded: [`test/issue-${n}.test.ts`],
      summary: attempt > 1 ? "Addressed the feedback from attempt 1" : `Implemented: ${issue.title}`,
    });
    const workerCost = (attempt: number) => Number(jitter(n * 7 + attempt, 0.35, 0.9).toFixed(3));
    const step = (attempt: number, act: (cwd: string) => Promise<void> | void): ScriptStep => ({
      act: async ({ req }) => {
        await act(req.cwd);
        return done(attempt);
      },
      costUsd: workerCost(attempt),
      delayMs: d(n * 3 + attempt, 7000, 13000),
      activity: workerActivity(n, files, attempt),
    });

    if (n === 1) {
      // Both attempts assert the wrong scheme default (http instead of https): the same check fails
      // twice — a train-split "verify-fail-repeat" the improvement loop can learn from. src/url.ts
      // never conflicts, so the demo integrator can't carry the reference fix in by accident.
      const wrongTest = (cwd: string, attempt: number) =>
        writeFile(
          join(cwd, "test", "issue-1.test.ts"),
          `import assert from "node:assert/strict";\nimport { it } from "node:test";\nimport { startServer } from "../src/server.ts";\n\nit("bare domains get a scheme (attempt ${attempt})", async () => {\n  const s = await startServer();\n  const res = await fetch(\`\${s.url}/links\`, { method: "POST", body: JSON.stringify({ url: "example.com" }) });\n  const body = await res.json();\n  await s.close();\n  assert.equal(body.url, "http://example.com/");\n});\n`,
        );
      for (const attempt of [1, 2]) {
        r.script(
          "worker",
          n,
          attempt,
          step(attempt, async (cwd) => {
            if (attempt === 1) execFileSync("git", ["apply", ref(n)], { cwd });
            await mkdir(join(cwd, "test"), { recursive: true });
            await wrongTest(cwd, attempt);
          }),
        );
      }
    } else if (n === 3) {
      // Attempt 1 ships a test that fails; the independent verifier catches it.
      r.script(
        "worker",
        n,
        1,
        step(1, async (cwd) => {
          execFileSync("git", ["apply", ref(n)], { cwd });
          await mkdir(join(cwd, "test"), { recursive: true });
          await writeFile(
            join(cwd, "test", "issue-3.test.ts"),
            `import assert from "node:assert/strict";\nimport { it } from "node:test";\nit("malformed url is rejected with 422", () => assert.equal(400, 422));\n`,
          );
        }),
      );
      r.script(
        "worker",
        n,
        2,
        step(2, async (cwd) => void (await addTest(cwd, n))),
      );
    } else if (n === 7) {
      // Attempt 1 has an off-by-one at the expiry boundary; tests pass, the reviewer catches it.
      r.script(
        "worker",
        n,
        1,
        step(1, async (cwd) => {
          execFileSync("git", ["apply", patch("seeded-defects", "07-expiry-boundary")], { cwd });
          await addTest(cwd, n);
        }),
      );
      r.script(
        "worker",
        n,
        2,
        step(2, async (cwd) => {
          // Attempt 1 was committed by the factory, so undo its change explicitly.
          execFileSync("git", ["apply", "-R", patch("seeded-defects", "07-expiry-boundary")], { cwd });
          execFileSync("git", ["apply", ref(n)], { cwd });
          await addTest(cwd, n);
        }),
      );
    } else {
      r.script(
        "worker",
        n,
        1,
        step(1, async (cwd) => {
          execFileSync("git", ["apply", ref(n)], { cwd });
          await addTest(cwd, n);
        }),
      );
    }

    const reviewActivity: ActivityScript = [
      { kind: "text", detail: "Reviewing the diff against the acceptance criteria" },
      ...files.map((f) => ({ kind: "tool" as const, tool: "Read", detail: f })),
      { kind: "tool", tool: "Grep", detail: "/expiresAt|now\\(\\)/ in src" },
    ];
    const approve: ReviewResult = { verdict: "approve", findings: [], scopeCreep: false };
    if (n === 7) {
      const blocker: ReviewResult = {
        verdict: "request_changes",
        findings: [
          {
            severity: "blocker",
            file: "src/router.ts",
            line: 47,
            message:
              "Uses `now > expiresAt`: a link is still served at exactly expiresAt, but the issue requires 410 at or after it.",
          },
        ],
        scopeCreep: false,
      };
      r.script("reviewer", n, 1, {
        output: blocker,
        costUsd: 0.12,
        delayMs: d(n, 3000, 5000),
        activity: [...reviewActivity, { kind: "text", detail: "Found an off-by-one at the expiry boundary" }],
      });
      r.script("reviewer", n, 2, {
        output: approve,
        costUsd: 0.09,
        delayMs: d(n + 1, 2500, 4000),
        activity: reviewActivity,
      });
    } else {
      r.script("reviewer", n, "*", {
        output: approve,
        costUsd: Number(jitter(n * 11, 0.07, 0.15).toFixed(3)),
        delayMs: d(n * 5, 2500, 4500),
        activity: [...reviewActivity, { kind: "text", detail: "No blocking findings" }],
      });
    }
  }

  // Integrator: resolve each conflicted file to its fully-integrated reference version.
  r.script("integrator", "*", "*", {
    act: async ({ req }) => {
      const conflicted = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: req.cwd })
        .toString()
        .split("\n")
        .filter(Boolean);
      for (const f of conflicted) {
        await writeFile(
          join(req.cwd, f),
          execFileSync("git", ["show", `refs/remotes/origin/ref/all:${f}`], { cwd: req.cwd }),
        );
      }
      const out: ConflictResolution = {
        resolved: true,
        filesChanged: conflicted,
        notes: "Kept both sides' routes and tests",
      };
      return out;
    },
    costUsd: 0.18,
    delayMs: Math.round(4000 * speed.factor),
    activity: [
      { kind: "tool", tool: "Bash", detail: "git diff --name-only --diff-filter=U" },
      { kind: "tool", tool: "Read", detail: "src/router.ts" },
      { kind: "text", detail: "Both branches add routes before the 404 fallback; keeping both" },
      { kind: "tool", tool: "Edit", detail: "src/router.ts" },
      { kind: "tool", tool: "Bash", detail: "npm test" },
    ],
  });
  return r;
}

/** A scripted retrospective for demo self-improvement runs. */
export function demoRetro(speed: DemoSpeed = { factor: 1 }): FakeAgentRunner {
  const out: RetroOutput = {
    candidates: [
      {
        hypothesis:
          "Workers write tests asserting values the issue never specified (e.g. an http default where the issue says https), then repeat the same failing check on retry; asking them to derive every expected value from the acceptance criteria and to re-read the failing check output should stop repeat failures.",
        targets: ["verify-fail-repeat"],
        playbookChanges: [
          {
            file: "playbooks/worker.md",
            content:
              "# Worker\n\n(demo candidate) Derive every expected value in your tests from the acceptance criteria; on a retry, start from the failing check's output.\n",
          },
        ],
      },
    ],
    selfIssues: [],
  };
  return new FakeAgentRunner().script("retro", 0, 1, {
    output: out,
    costUsd: 0.21,
    delayMs: Math.round(5000 * speed.factor),
    activity: [
      { kind: "text", detail: "Clustering failures from the train split" },
      { kind: "text", detail: "Top cluster: verify-fail-repeat (worker stage)" },
    ],
  });
}
