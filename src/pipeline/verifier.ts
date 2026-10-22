// The Verifier is code, not an agent (specs/05-single-issue-pipeline.md R4.3, R4.8).
// It checks out the exact commit in a fresh sandbox and decides only from exit codes.
import type { Check } from "../config.js";
import type { CheckResult, TestSummary, VerifierResult } from "../contracts/index.js";
import type { Sandbox, SandboxProvider, SnapshotId } from "../sandbox/types.js";

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

/** Parse pass/fail/skip counts from node:test (TAP), vitest or jest output. */
export function parseTestSummary(output: string): TestSummary | null {
  const tap = {
    pass: /^# pass (\d+)/m.exec(output),
    fail: /^# fail (\d+)/m.exec(output),
    skip: /^# skipped (\d+)/m.exec(output),
  };
  if (tap.pass && tap.fail) {
    return { passed: Number(tap.pass[1]), failed: Number(tap.fail[1]), skipped: Number(tap.skip?.[1] ?? 0) };
  }
  // Vitest prints a line like "Tests  3 failed | 40 passed | 2 skipped (45)".
  const vitestLine = /^\s*Tests\s+(.*\(\d+\))\s*$/m.exec(output)?.[1];
  if (vitestLine) {
    const n = (label: string) => Number(new RegExp(`(\\d+) ${label}`).exec(vitestLine)?.[1] ?? 0);
    return { passed: n("passed"), failed: n("failed"), skipped: n("skipped") };
  }
  // Jest prints "Tests:       1 failed, 2 skipped, 40 passed, 43 total".
  const jest = /^Tests:\s+(.*total)/m.exec(output)?.[1];
  if (jest) {
    const n = (label: string) => Number(new RegExp(`(\\d+) ${label}`).exec(jest)?.[1] ?? 0);
    return { passed: n("passed"), failed: n("failed"), skipped: n("skipped") };
  }
  return null;
}

function addSummaries(a: TestSummary | null, b: TestSummary | null): TestSummary | null {
  if (!a) return b;
  if (!b) return a;
  return { passed: a.passed + b.passed, failed: a.failed + b.failed, skipped: a.skipped + b.skipped };
}

/** npm scripts that the configured checks invoke (e.g. `npm test` → test). */
export function checkScripts(checks: Check[]): string[] {
  const out: string[] = [];
  for (const c of checks) {
    const m = /\bnpm\s+(?:run(?:-script)?\s+)?([\w:-]+)/.exec(c.command);
    if (m) out.push(m[1] === "t" ? "test" : m[1]!);
  }
  return out;
}

async function readScripts(sandbox: Sandbox, ref: string): Promise<Record<string, string>> {
  const r = await sandbox.exec(`git show ${ref}:package.json`);
  if (r.exitCode !== 0) return {};
  try {
    return (JSON.parse(r.stdout) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    return {};
  }
}

export interface VerifyOptions {
  provider: SandboxProvider;
  snapshot: SnapshotId;
  commitSha: string;
  baseCommit: string;
  checks: Check[];
  protectedPaths: string[];
  timeoutSec?: number;
  label?: string;
}

export interface Verification {
  result: VerifierResult;
  /** The clean sandbox at `commitSha`; the caller reuses it (read-only) for review and destroys it. */
  sandbox: Sandbox;
}

function tail(s: string, n = 4000): string {
  return s.length > n ? s.slice(s.length - n) : s;
}

export async function verify(opts: VerifyOptions): Promise<Verification> {
  const sandbox = await opts.provider.create({ snapshot: opts.snapshot, label: opts.label ?? "verify" });
  try {
    await sandbox.checkout(opts.commitSha);
    const checks: CheckResult[] = [];
    let summary: TestSummary | null = null;

    // Protected paths: the worker may not change CI config or the commands that grade it.
    const changed = await sandbox.exec(`git diff --name-only ${opts.baseCommit} ${opts.commitSha}`);
    const violations = changed.stdout
      .split("\n")
      .filter(Boolean)
      .filter((p) => matchesAny(p, opts.protectedPaths));
    const before = await readScripts(sandbox, opts.baseCommit);
    const after = await readScripts(sandbox, opts.commitSha);
    for (const s of checkScripts(opts.checks)) {
      if (before[s] !== after[s]) violations.push(`package.json#scripts.${s}`);
    }
    if (violations.length > 0) {
      checks.push({
        name: "protected-paths",
        command: "git diff --name-only",
        exitCode: 1,
        durationMs: 0,
        outputTail: `Protected paths changed:\n${violations.join("\n")}`,
      });
      return { result: { status: "fail", commitSha: opts.commitSha, checks, testSummary: null }, sandbox };
    }

    for (const check of opts.checks) {
      const r = await sandbox.exec(check.command, { timeoutSec: opts.timeoutSec ?? 900, env: { CI: "1" } });
      const output = `${r.stdout}\n${r.stderr}`;
      summary = addSummaries(summary, parseTestSummary(output));
      checks.push({
        name: check.name,
        command: check.command,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        outputTail: tail(output),
      });
    }
    const status = checks.every((c) => c.exitCode === 0) ? "pass" : "fail";
    return { result: { status, commitSha: opts.commitSha, checks, testSummary: summary }, sandbox };
  } catch (e) {
    const result: VerifierResult = {
      status: "error",
      commitSha: opts.commitSha,
      checks: [{ name: "verifier", command: "", exitCode: 1, durationMs: 0, outputTail: String(e) }],
      testSummary: null,
    };
    return { result, sandbox };
  }
}
