// Promotes a candidate as a draft PR on the factory's own repo, using a throwaway worktree so the
// user's checkout is never touched.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { PrSink } from "../pipeline/pr.js";
import type { Promoter, Promotion } from "./improve.js";

const exec = promisify(execFile);
const IDENTITY = ["-c", "user.name=software-factory", "-c", "user.email=factory@localhost"];

export class GitPromoter implements Promoter {
  constructor(
    private readonly opts: {
      repoDir: string;
      /** PR base branch on the code host. */
      baseBranch: string;
      /** Commit-ish the improvement branch starts from (default: baseBranch). */
      from?: string;
      prs: PrSink;
      /** Push the branch to origin before opening the PR (default: when an origin exists). */
      push?: boolean;
      gitEnv?: Record<string, string>;
    },
  ) {}

  private git(cwd: string, ...args: string[]) {
    return exec("git", args, { cwd, env: { ...process.env, ...this.opts.gitEnv } }).then((r) =>
      r.stdout.trim(),
    );
  }

  async promote(p: Promotion): Promise<string> {
    const branch = `factory/improve-${p.candidateId}`;
    const wt = join(await mkdtemp(join(tmpdir(), "factory-promote-")), "wt");
    await this.git(
      this.opts.repoDir,
      "worktree",
      "add",
      "-q",
      "-b",
      branch,
      wt,
      this.opts.from ?? this.opts.baseBranch,
    );
    try {
      for (const ch of p.changes) {
        const path = join(wt, ch.file);
        if (ch.after === null) {
          await rm(path, { force: true });
          continue;
        }
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, ch.after);
      }
      await this.git(wt, "add", "-A");
      await this.git(wt, ...IDENTITY, "commit", "-q", "-m", `${p.title}\n\n${p.candidateId}`);
      const hasOrigin = (await this.git(this.opts.repoDir, "remote")).split("\n").includes("origin");
      if (this.opts.push ?? hasOrigin)
        await this.git(wt, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
      const pr = await this.opts.prs.createDraft({
        head: branch,
        base: this.opts.baseBranch,
        title: p.title,
        body: p.body,
      });
      return pr.url;
    } finally {
      await this.git(this.opts.repoDir, "worktree", "remove", "--force", wt).catch(() => undefined);
      await rm(dirname(wt), { recursive: true, force: true });
    }
  }
}
