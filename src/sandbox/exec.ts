// Process execution with process-group timeouts (specs/03-sandboxes.md R2.5).
import { spawn } from "node:child_process";
import type { ExecOptions, ExecResult } from "./types.js";

export const TIMEOUT_EXIT_CODE = 124;
const MAX_CAPTURE = 1024 * 1024;

function capped(buf: string, chunk: string): string {
  const next = buf + chunk;
  return next.length > MAX_CAPTURE ? next.slice(next.length - MAX_CAPTURE) : next;
}

/** Run a shell command in its own process group; on timeout the whole group is killed. */
export function execShell(cmd: string, cwd: string, opts: ExecOptions = {}): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", cmd], {
      cwd,
      env: { ...process.env, ...opts.env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout = capped(stdout, d)));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr = capped(stderr, d)));
    const timer = opts.timeoutSec
      ? setTimeout(() => {
          timedOut = true;
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            // group already gone
          }
        }, opts.timeoutSec * 1000)
      : undefined;
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 127, stdout, stderr: stderr + String(err), durationMs: Date.now() - started });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const exitCode = timedOut ? TIMEOUT_EXIT_CODE : (code ?? (signal ? 128 : 1));
      resolve({ exitCode, stdout, stderr, durationMs: Date.now() - started });
    });
  });
}
