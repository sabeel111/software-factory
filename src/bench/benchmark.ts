// TinyLinks benchmark: fixture repo preparation and issue loading (specs/02-benchmark.md).
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { IssueRef } from "../contracts/index.js";

const exec = promisify(execFile);

export const BENCH_ROOT = resolve(import.meta.dirname, "../../bench/tinylinks");
export const BENCH_REPO_NAME = "bench/tinylinks";

export const BenchIssue = IssueRef.omit({ repo: true }).extend({
  kind: z.enum(["bug", "feature", "vague"]),
  split: z.enum(["train", "holdout"]),
  expectedTriage: z.enum(["accept", "reject"]),
  hidden: z.string().nullable(),
});
export type BenchIssue = z.infer<typeof BenchIssue>;

export type Split = "train" | "holdout" | "all";

export async function loadIssues(root = BENCH_ROOT, split: Split = "all"): Promise<BenchIssue[]> {
  const dir = join(root, "issues");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  const issues = await Promise.all(
    files.map(async (f) => BenchIssue.parse(JSON.parse(await readFile(join(dir, f), "utf8")))),
  );
  return split === "all" ? issues : issues.filter((i) => i.split === split);
}

export function toIssueRef(issue: BenchIssue, repo = BENCH_REPO_NAME): IssueRef {
  return { repo, number: issue.number, title: issue.title, body: issue.body, labels: issue.labels };
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

const GIT_IDENTITY = ["-c", "user.name=factory", "-c", "user.email=factory@localhost"];

export async function commitAll(cwd: string, message: string): Promise<string> {
  await git(cwd, "add", "-A");
  await git(cwd, ...GIT_IDENTITY, "commit", "-q", "--allow-empty", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

export interface PreparedBench {
  dir: string;
  baseCommit: string;
  /** Branch name of each reference solution: ref/01 … ref/09, plus ref/all. */
  referenceBranches: Record<string, string>;
}

/**
 * Materialize the fixture as a git repo at `dir`: baseline on `main`, and one branch per
 * reference solution. Hidden tests are never copied here.
 */
export async function prepareBenchRepo(dir: string, root = BENCH_ROOT): Promise<PreparedBench> {
  await mkdir(dir, { recursive: true });
  await cp(join(root, "repo"), dir, {
    recursive: true,
    filter: (src) => !src.includes("node_modules"),
  });
  await git(dir, "init", "-q", "-b", "main");
  const baseCommit = await commitAll(dir, "TinyLinks baseline");

  const referenceBranches: Record<string, string> = {};
  const refDir = join(root, "reference");
  if (existsSync(refDir)) {
    for (const patch of (await readdir(refDir)).filter((f) => f.endsWith(".patch")).sort()) {
      const name = patch.replace(/\.patch$/, "");
      const branch = `ref/${name}`;
      await git(dir, "checkout", "-q", "-b", branch, baseCommit);
      await git(dir, "apply", "--whitespace=nowarn", join(refDir, patch));
      await commitAll(dir, `Reference solution ${name}`);
      referenceBranches[name] = branch;
    }
    await git(dir, "checkout", "-q", "main");
  }
  return { dir, baseCommit, referenceBranches };
}

/** Apply a patch file on a new branch from `from`; returns the branch's head commit. */
export async function branchWithPatch(
  dir: string,
  branch: string,
  from: string,
  patchPath: string,
): Promise<string> {
  await git(dir, "checkout", "-q", "-B", branch, from);
  await git(dir, "apply", "--whitespace=nowarn", patchPath);
  const sha = await commitAll(dir, `Apply ${patchPath}`);
  await git(dir, "checkout", "-q", "main");
  return sha;
}
