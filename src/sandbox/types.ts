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
  /** The commit a snapshot was prepared at. */
  snapshotCommit(id: SnapshotId): Promise<string>;
  create(opts: { snapshot: SnapshotId; label: string }): Promise<Sandbox>;
  /** Destroy sandboxes left behind by crashed processes. Returns the ids destroyed. */
  sweep(): Promise<string[]>;
  /** Isolation caveats to print at startup (empty when the provider is fully isolated). */
  warnings(): string[];
}

/** How to run an agent *inside* a sandbox (container providers); absent means "on the host". */
export interface AgentRuntime {
  /** Spawns the Claude Code process (Agent SDK `spawnClaudeCodeProcess`). */
  spawn: (options: {
    command: string;
    args: string[];
    cwd?: string;
    env: Record<string, string | undefined>;
    signal?: AbortSignal;
  }) => unknown;
  /** The complete environment for the agent process (replaces the host environment). */
  env: Record<string, string>;
  /** Rewrites MCP server configs so they route through the sandbox's gateway. */
  rewriteMcp: (servers: Record<string, unknown>) => Record<string, unknown>;
  /** Runs an agent's shell command inside the sandbox (factory-implemented Bash tool). */
  exec?: (cmd: string, opts?: ExecOptions) => Promise<ExecResult>;
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
  /** Present when agents must run inside the sandbox rather than on the host. */
  agentRuntime?(): AgentRuntime;
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
