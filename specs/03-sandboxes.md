# Phase 2 — Sandboxes

## Goal

Every agent run gets its own isolated workspace, created fast from a prepared
snapshot, behind an interface that can later be backed by containers or cloud
sandboxes (Upstash Box, etc.).

## Scope

- In: the `SandboxProvider` interface, the `worktree` provider, snapshot
  preparation, lifecycle, cleanup, and the hidden-test exclusion guarantee.
- Out: network egress control and credential isolation. A local worktree
  cannot enforce these; they arrive with the container provider in Phase 7.
  Until then, this limitation is documented in the README and printed as a
  warning at startup.

## Interface

```ts
interface SandboxProvider {
  prepareSnapshot(opts: { repoUrl: string; ref: string; setup: string[] }): Promise<SnapshotId>;
  create(opts: { snapshot: SnapshotId; label: string }): Promise<Sandbox>;
}
interface Sandbox {
  id: string;
  path: string;                 // absolute working directory
  exec(cmd: string, opts?: { timeoutSec?: number; env?: Record<string,string> }):
    Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }>;
  checkout(ref: string): Promise<void>;
  push(branch: string): Promise<void>;     // to the configured remote, never the default branch
  destroy(): Promise<void>;
}
```

### Worktree provider design

- A snapshot is a bare mirror plus a base worktree at `ref` with `setup`
  already run (for example `npm ci`). It is stored under
  `.factory/snapshots/<hash(repo, ref, setup)>/`.
- `create()` adds a new git worktree on a new branch from the snapshot commit
  and **copies** the installed dependency directory using copy-on-write where
  the filesystem supports it (`cp --reflink=auto`), else a plain copy.
- Every sandbox has its own path, branch and dependency directory. Nothing is
  shared and writable.

## Requirements

| ID | Requirement |
|----|-------------|
| R2.1 | Sandboxes are fully isolated: a file written in sandbox A is not visible in sandbox B or in the snapshot. |
| R2.2 | `create()` from a prepared snapshot completes in **< 10 s** for TinyLinks (p95, local SSD). |
| R2.3 | Snapshots are cached by `(repo, ref, setup)` and reused; a changed `setup` produces a new snapshot. |
| R2.4 | `push()` refuses to push to the default branch, and refuses any branch not prefixed `factory/`. |
| R2.5 | `exec()` enforces `timeoutSec`, killing the whole process group on timeout, and reports `exitCode: 124`. |
| R2.6 | `destroy()` removes the worktree and its branch reference; the orchestrator destroys every sandbox on success, failure or crash (tracked in a ledger and swept on next start). |
| R2.7 | The benchmark's `hidden/` directory, and any path configured as `secretPaths`, never exists inside a sandbox path. |
| R2.8 | Concurrent `create()` calls (N = 10) succeed without git lock errors (creation is serialized per snapshot with a mutex where git requires it). |

## Test cases

| ID | Tier | Given / When / Then |
|----|------|---------------------|
| T2.1 | integ | Given two sandboxes from one snapshot, when A writes `x.txt` and commits, then B has no `x.txt` and B's `git log` doesn't contain A's commit. |
| T2.2 | integ | Given a prepared snapshot, when 10 sandboxes are created concurrently, then all 10 succeed with distinct paths and branches. |
| T2.3 | integ | Given a prepared TinyLinks snapshot, then the p95 `create()` time over 10 runs is < 10 s and `npm test` runs without reinstalling. |
| T2.4 | integ | Given `setup` changes from `["npm ci"]` to `["npm ci","npm run build"]`, then a new snapshot is prepared; with the same setup, the cached snapshot is reused (no `npm ci` invoked). |
| T2.5 | unit | `push("main")` and `push("feature/x")` both throw; `push("factory/issue-3-a1b2")` is allowed. |
| T2.6 | integ | Given `exec("sleep 30", {timeoutSec: 1})`, then it returns exitCode 124 within 3 s and no `sleep` process survives. |
| T2.7 | integ | Given a crash after create (simulated), when the orchestrator restarts, then the ledger sweep destroys the orphaned sandbox. |
| T2.8 | integ | Given the benchmark is configured, when a sandbox is created, then a recursive search of its path finds no file from `bench/tinylinks/hidden/`, and the factory's own `bench/` directory is not inside the sandbox path. |
| T2.9 | integ | After `destroy()`, the path no longer exists and `git worktree list` doesn't list it. |

## Exit criteria

- All T2.x pass on Linux and macOS in CI.
- The startup warning about missing egress/credential isolation is shown
  whenever `provider: "worktree"`.
