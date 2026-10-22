// Worktree sandbox provider (specs/03-sandboxes.md).
// A snapshot is a bare clone plus a prepared base worktree; each sandbox is a fresh worktree with a
// copy-on-write copy of the base's untracked/ignored files (node_modules, build output).
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { KeyedMutex } from "../util/mutex.js";
import { execShell } from "./exec.js";
import { Ledger } from "./ledger.js";
import {
  assertPushable,
  type ExecOptions,
  type ExecResult,
  type Sandbox,
  type SandboxProvider,
  type SnapshotId,
  type SnapshotOptions,
} from "./types.js";

const execFileP = promisify(execFile);
const GIT_IDENTITY = ["-c", "user.name=software-factory", "-c", "user.email=factory@localhost"];

export async function gitIn(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

/** git with extra environment (used for credentials that must never be written to disk). */
async function gitEnv(cwd: string, env: Record<string, string>, ...args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, {
    cwd,
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.trim();
}

/**
 * Per-command git auth for GitHub over HTTPS, passed through GIT_CONFIG_* environment variables so
 * the token never lands in a git config file an agent could read.
 */
export function gitHubAuthEnv(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_TERMINAL_PROMPT: "0",
  };
}

export const WORKTREE_ISOLATION_WARNING =
  "Sandbox provider 'worktree' isolates files only: agents can reach the network and the host's " +
  "environment. Use provider 'docker' for egress allowlisting and credential isolation (Phase 7).";

export interface WorktreeProviderOptions {
  /** Where snapshots and sandboxes live. Defaults to a directory under the OS temp dir. */
  root?: string;
  defaultBranch?: string;
  /** Files/directories that must never appear inside a sandbox (e.g. hidden tests). */
  secretPaths?: string[];
  /** Environment for the factory's own clone/fetch/push (e.g. gitHubAuthEnv(token)). Never given to agents. */
  gitAuthEnv?: Record<string, string>;
  /** Called after every successful push (audit log). */
  onPush?: (branch: string) => void;
}

interface SnapshotMeta {
  id: string;
  repoUrl: string;
  ref: string;
  setup: string[];
  commit: string;
  carry: string[];
}

async function walkFiles(dir: string, skip: Set<string>): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkFiles(p, skip)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

async function hashFile(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

export class SecretLeak extends Error {
  override name = "SecretLeak";
}

export class WorktreeProvider implements SandboxProvider {
  readonly kind: string = "worktree";
  readonly root: string;
  readonly ledger: Ledger;
  private readonly defaultBranch: string;
  private readonly secretPaths: string[];
  /** @internal */
  readonly gitAuthEnv: Record<string, string>;
  /** @internal */
  readonly onPush?: (branch: string) => void;
  private readonly locks = new KeyedMutex();
  private secretHashes?: Promise<Set<string>>;

  constructor(opts: WorktreeProviderOptions = {}) {
    this.root = resolve(opts.root ?? join(tmpdir(), "software-factory"));
    this.defaultBranch = opts.defaultBranch ?? "main";
    this.secretPaths = (opts.secretPaths ?? []).map((p) => resolve(p));
    this.gitAuthEnv = opts.gitAuthEnv ?? {};
    this.onPush = opts.onPush;
    this.ledger = new Ledger(join(this.root, "ledger.json"));
  }

  warnings(): string[] {
    return [WORKTREE_ISOLATION_WARNING];
  }

  private snapshotDir(id: SnapshotId): string {
    return join(this.root, "snapshots", id);
  }

  static snapshotId(opts: SnapshotOptions): SnapshotId {
    return createHash("sha256")
      .update(JSON.stringify([opts.repoUrl, opts.ref, opts.setup]))
      .digest("hex")
      .slice(0, 16);
  }

  async prepareSnapshot(opts: SnapshotOptions): Promise<SnapshotId> {
    const id = WorktreeProvider.snapshotId(opts);
    return this.locks.run(`snapshot:${id}`, async () => {
      const dir = this.snapshotDir(id);
      if (existsSync(join(dir, "snapshot.json"))) return id;
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      const mirror = join(dir, "repo.git");
      const repoUrl =
        isAbsolute(opts.repoUrl) || !/^[a-z]+:/i.test(opts.repoUrl) ? resolve(opts.repoUrl) : opts.repoUrl;
      await gitEnv(dir, this.gitAuthEnv, "clone", "-q", "--bare", repoUrl, mirror);
      // Bare clones don't map remote branches; fetch them so worktrees can see every ref.
      await gitIn(mirror, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
      await gitEnv(mirror, this.gitAuthEnv, "fetch", "-q", "origin");
      const commit = await gitIn(mirror, "rev-parse", "--verify", `${opts.ref}^{commit}`);
      const base = join(dir, "base");
      await gitIn(mirror, "worktree", "add", "-q", "--detach", base, commit);
      for (const cmd of opts.setup) {
        const r = await this.runSetup(cmd, base);
        if (r.exitCode !== 0) {
          throw new Error(`Snapshot setup failed (${cmd}), exit ${r.exitCode}:\n${r.stderr.slice(-2000)}`);
        }
      }
      // Everything setup produced that git doesn't track is carried into each sandbox.
      const status = await gitIn(base, "status", "--porcelain=v1", "--ignored", "--untracked-files=normal");
      const carry = status
        .split("\n")
        .filter((l) => l.startsWith("!! ") || l.startsWith("?? "))
        .map((l) => l.slice(3).replace(/\/$/, ""));
      const meta: SnapshotMeta = { id, repoUrl, ref: opts.ref, setup: opts.setup, commit, carry };
      await writeFile(join(dir, "snapshot.json"), JSON.stringify(meta, null, 2));
      return id;
    });
  }

  /** Runs one snapshot setup command (overridden by providers that run setup elsewhere). */
  protected runSetup(cmd: string, cwd: string): Promise<ExecResult> {
    return execShell(cmd, cwd, { timeoutSec: 1800 });
  }

  /** @internal Path of a snapshot's prepared directory. */
  snapshotPath(id: SnapshotId): string {
    return this.snapshotDir(id);
  }

  private async snapshotMeta(id: SnapshotId): Promise<SnapshotMeta> {
    const file = join(this.snapshotDir(id), "snapshot.json");
    if (!existsSync(file)) throw new Error(`Unknown snapshot ${id}; call prepareSnapshot first`);
    return JSON.parse(await readFile(file, "utf8")) as SnapshotMeta;
  }

  async snapshotCommit(id: SnapshotId): Promise<string> {
    return (await this.snapshotMeta(id)).commit;
  }

  async create(opts: { snapshot: SnapshotId; label: string }): Promise<Sandbox> {
    const meta = await this.snapshotMeta(opts.snapshot);
    const dir = this.snapshotDir(opts.snapshot);
    const mirror = join(dir, "repo.git");
    const safeLabel = opts.label.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 40) || "sbx";
    const id = `${safeLabel}-${randomUUID().slice(0, 8)}`;
    const path = join(this.root, "sandboxes", id);
    const branch = `factory/sandbox/${id}`;

    // git takes repo-wide locks while adding worktrees; serialize per snapshot (R2.8).
    await this.locks.run(`snapshot:${opts.snapshot}`, () =>
      gitIn(mirror, "worktree", "add", "-q", "-b", branch, path, meta.commit),
    );
    await this.ledger.add({
      id,
      provider: this.kind,
      path,
      branch,
      snapshot: opts.snapshot,
      pid: process.pid,
      createdAt: new Date().toISOString(),
    });
    for (const rel of meta.carry) {
      await cp(join(dir, "base", rel), join(path, rel), {
        recursive: true,
        mode: constants.COPYFILE_FICLONE,
        verbatimSymlinks: true,
      });
    }
    const sandbox = new WorktreeSandbox(id, path, branch, mirror, this.defaultBranch, this);
    try {
      await this.assertNoSecrets(path);
    } catch (e) {
      await sandbox.destroy();
      throw e;
    }
    return sandbox;
  }

  /** R2.7: no secret path may be inside the sandbox, and no secret file's content may be present. */
  async assertNoSecrets(path: string): Promise<void> {
    if (this.secretPaths.length === 0) return;
    for (const secret of this.secretPaths) {
      const rel = relative(path, secret);
      if (!rel.startsWith("..") && !isAbsolute(rel))
        throw new SecretLeak(`Secret path ${secret} is inside sandbox ${path}`);
    }
    this.secretHashes ??= (async () => {
      const hashes = new Set<string>();
      for (const secret of this.secretPaths) {
        if (!existsSync(secret)) continue;
        const files = (await stat(secret)).isDirectory() ? await walkFiles(secret, new Set()) : [secret];
        for (const f of files) hashes.add(await hashFile(f));
      }
      return hashes;
    })();
    const secretHashes = await this.secretHashes;
    for (const f of await walkFiles(path, new Set([".git", "node_modules"]))) {
      if (secretHashes.has(await hashFile(f)))
        throw new SecretLeak(`Sandbox file ${f} matches a secret file`);
    }
  }

  /** @internal */
  async release(id: string, path: string, branch: string, mirror: string): Promise<void> {
    const snapshot = relative(join(this.root, "snapshots"), mirror).split("/")[0]!;
    await this.locks.run(`snapshot:${snapshot}`, async () => {
      await gitIn(mirror, "worktree", "remove", "--force", path).catch(() => undefined);
      await gitIn(mirror, "worktree", "prune").catch(() => undefined);
      await gitIn(mirror, "branch", "-D", branch).catch(() => undefined);
    });
    await rm(path, { recursive: true, force: true });
    await this.ledger.remove(id);
  }

  async sweep(): Promise<string[]> {
    const swept: string[] = [];
    for (const e of await this.ledger.orphans()) {
      if (e.provider !== this.kind) continue;
      await this.release(e.id, e.path, e.branch, join(this.snapshotDir(e.snapshot), "repo.git"));
      swept.push(e.id);
    }
    return swept;
  }
}

class WorktreeSandbox implements Sandbox {
  private destroyed = false;

  constructor(
    readonly id: string,
    readonly path: string,
    readonly branch: string,
    private readonly mirror: string,
    private readonly defaultBranch: string,
    private readonly provider: WorktreeProvider,
  ) {}

  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult> {
    return execShell(cmd, this.path, opts);
  }

  async checkout(ref: string): Promise<void> {
    const commit = await gitIn(this.path, "rev-parse", "--verify", `${ref}^{commit}`).catch(() =>
      gitIn(this.path, "rev-parse", "--verify", `refs/remotes/origin/${ref}^{commit}`),
    );
    await gitIn(this.path, "checkout", "-q", "-B", this.branch, commit);
    await gitIn(this.path, "clean", "-fdq", "-e", "node_modules");
  }

  async commit(message: string): Promise<string> {
    await gitIn(this.path, "add", "-A");
    const staged = await gitIn(this.path, "diff", "--cached", "--name-only");
    if (staged) await gitIn(this.path, ...GIT_IDENTITY, "commit", "-q", "-m", message);
    return gitIn(this.path, "rev-parse", "HEAD");
  }

  async push(branch: string): Promise<void> {
    assertPushable(branch, this.defaultBranch);
    await gitEnv(
      this.path,
      this.provider.gitAuthEnv,
      "push",
      "-q",
      "--force",
      "origin",
      `HEAD:refs/heads/${branch}`,
    );
    this.provider.onPush?.(branch);
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    await this.provider.release(this.id, this.path, this.branch, this.mirror);
  }
}
