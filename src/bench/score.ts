// Hidden-test scorer (specs/02-benchmark.md R1.4–R1.7).
import { execFile } from "node:child_process";
import { appendFile, cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { BENCH_ROOT, git, type BenchIssue } from "./benchmark.js";

const exec = promisify(execFile);

export const IssueScore = z.object({
  issue: z.number().int(),
  passed: z.boolean(),
  durationMs: z.number(),
  outputTail: z.string(),
});
export type IssueScore = z.infer<typeof IssueScore>;

export const BenchScore = z.object({
  candidateRef: z.string(),
  candidateSha: z.string(),
  perIssue: z.array(IssueScore),
  resolved: z.number().int(),
  total: z.number().int(),
  resolveRate: z.number(),
  triageAccuracy: z.number().nullable(),
  durationMs: z.number(),
});
export type BenchScore = z.infer<typeof BenchScore>;

export interface ScoreOptions {
  /** Git repo (or URL) containing the candidate ref. */
  repo: string;
  candidateRef: string;
  issues: BenchIssue[];
  /** Triage decisions keyed by issue number, if the run produced them. */
  triage?: Record<number, "accept" | "reject">;
  root?: string;
  timeoutSec?: number;
}

/** Accuracy of triage decisions against the benchmark's expected decisions (null if none given). */
export function triageAccuracy(
  issues: BenchIssue[],
  triage: Record<number, "accept" | "reject"> | undefined,
): number | null {
  if (!triage) return null;
  const judged = issues.filter((i) => triage[i.number] !== undefined);
  if (judged.length === 0) return null;
  const correct = judged.filter((i) => triage[i.number] === i.expectedTriage).length;
  return correct / judged.length;
}

/**
 * Score a candidate: fresh clone, checkout, copy hidden tests in last (overwriting anything the
 * candidate put at hidden/), then run each issue's hidden test file in isolation.
 */
export async function scoreCandidate(opts: ScoreOptions): Promise<BenchScore> {
  const root = opts.root ?? BENCH_ROOT;
  const started = Date.now();
  const work = await mkdtemp(join(tmpdir(), "factory-score-"));
  try {
    await exec("git", ["clone", "-q", "--no-hardlinks", opts.repo, work]);
    await git(work, "checkout", "-q", "--detach", await resolveRef(work, opts.candidateRef));
    const candidateSha = await git(work, "rev-parse", "HEAD");
    await rm(join(work, "hidden"), { recursive: true, force: true });
    await cp(join(root, "hidden"), join(work, "hidden"), { recursive: true });

    const perIssue: IssueScore[] = [];
    for (const issue of opts.issues.filter((i) => i.hidden)) {
      const t0 = Date.now();
      let passed = false;
      let output = "";
      try {
        const r = await exec(
          process.execPath,
          ["--test", "--test-reporter=tap", join("hidden", issue.hidden!)],
          {
            cwd: work,
            timeout: (opts.timeoutSec ?? 60) * 1000,
            env: { ...process.env, NODE_OPTIONS: "" },
            maxBuffer: 16 * 1024 * 1024,
          },
        );
        passed = true;
        output = r.stdout;
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; message: string };
        output = `${err.stdout ?? ""}\n${err.stderr ?? ""}` || err.message;
      }
      perIssue.push({
        issue: issue.number,
        passed,
        durationMs: Date.now() - t0,
        outputTail: output.slice(-2000),
      });
    }

    const resolved = perIssue.filter((p) => p.passed).length;
    return {
      candidateRef: opts.candidateRef,
      candidateSha,
      perIssue,
      resolved,
      total: perIssue.length,
      resolveRate: perIssue.length ? resolved / perIssue.length : 0,
      triageAccuracy: triageAccuracy(opts.issues, opts.triage),
      durationMs: Date.now() - started,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Resolve a branch name (as a remote-tracking ref in the clone), tag or SHA to a commit. */
async function resolveRef(clone: string, ref: string): Promise<string> {
  for (const candidate of [`refs/remotes/origin/${ref}`, ref]) {
    try {
      return await git(clone, "rev-parse", "--verify", "-q", `${candidate}^{commit}`);
    } catch {
      // try the next form
    }
  }
  throw new Error(`Unknown candidate ref: ${ref}`);
}

export interface BenchResultEntry {
  at: string;
  label: string;
  factoryVersion: string;
  playbookHash: string;
  models: Record<string, string>;
  costUsd: number;
  split: string;
  score: BenchScore;
  falsePassRate?: number | null;
  wallClockMs?: number;
}

export async function appendResult(entry: BenchResultEntry, file = join(BENCH_ROOT, "..", "results.jsonl")) {
  await appendFile(file, JSON.stringify(entry) + "\n");
}

/** Spread of resolve rates across repeated runs of an unchanged factory (R1.6). */
export function noiseBand(rates: number[]): number {
  if (rates.length < 2) return 0;
  return Math.max(...rates) - Math.min(...rates);
}
