// Sandbox abstraction (specs/03-sandboxes.md). Providers: worktree (local), docker (Phase 7).

export type SnapshotId = string;

export interface ExecOptions {
  timeoutSec?: number;
  env?: Record<string, string>;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface SnapshotOptions {
  /** Clone URL or local path of the target repo. */
  repoUrl: string;
  ref: string;
  /** Commands run once in the snapshot (e.g. `npm ci`). */
  setup: string[];
}

export interface SandboxProvider {
  readonly kind: string;
  prepareSnapshot(opts: SnapshotOptions): Promise<SnapshotId>;
  create(opts: { snapshot: SnapshotId; label: string }): Promise<Sandbox>;
  /** Destroy sandboxes left behind by crashed processes. Returns the ids destroyed. */
  sweep(): Promise<string[]>;
  /** Isolation caveats to print at startup (empty when the provider is fully isolated). */
  warnings(): string[];
}

export interface Sandbox {
  readonly id: string;
  /** Absolute working directory. */
  readonly path: string;
  /** The sandbox's own working branch. */
  readonly branch: string;
  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>;
  /** Point the working tree at `ref` (branch, tag or commit). */
  checkout(ref: string): Promise<void>;
  /** Stage and commit everything; returns the new HEAD sha (or the current one if nothing changed). */
  commit(message: string): Promise<string>;
  /** Push HEAD to `branch` on the remote. Only `factory/*` branches, never the default branch. */
  push(branch: string): Promise<void>;
  destroy(): Promise<void>;
}

export const PUSH_PREFIX = "factory/";

export class PushRefused extends Error {
  override name = "PushRefused";
}

export function assertPushable(branch: string, defaultBranch: string): void {
  const name = branch.replace(/^refs\/heads\//, "");
  if (name === defaultBranch || name === "main" || name === "master") {
    throw new PushRefused(`Refusing to push to the default branch (${name})`);
  }
  if (!name.startsWith(PUSH_PREFIX) || name.length === PUSH_PREFIX.length || name.includes("..")) {
    throw new PushRefused(`Refusing to push branch ${name}: factory branches must start with ${PUSH_PREFIX}`);
  }
}
