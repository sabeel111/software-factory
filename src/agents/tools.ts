// Factory-implemented agent tools for providers without a built-in agent harness
// (specs/10-model-providers.md R9.3, R9.4). Every path is confined to the sandbox directory.
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { execShell } from "../sandbox/exec.js";
import type { AgentRuntime } from "../sandbox/types.js";
import { globToRegExp } from "../pipeline/verifier.js";
import { agentEnv } from "./claude-runner.js";
import type { ToolName } from "./runner.js";

/** Tools this module implements; anything else in a stage's allowlist is not offered. */
export const IMPLEMENTED_TOOLS: readonly ToolName[] = ["Read", "Write", "Edit", "Glob", "Grep", "Bash"];

export const MAX_TOOL_OUTPUT = 30_000;
const READ_LINES = 2000;
const LIST_LIMIT = 500;
const SKIP_DIRS = new Set([".git", "node_modules"]);
const BASH_TIMEOUT_SEC = 300;

export class ToolError extends Error {
  override name = "ToolError";
}

export interface ToolContext {
  cwd: string;
  runtime?: AgentRuntime;
  /** Extra environment variable names to strip from Bash (configured provider key envs). */
  secretEnvs?: readonly string[];
}

type JsonSchema = Record<string, unknown>;
const str = (description: string): JsonSchema => ({ type: "string", description });
const obj = (properties: Record<string, JsonSchema>, required: string[]): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const SCHEMAS: Record<string, { description: string; parameters: JsonSchema }> = {
  Read: {
    description: `Read a text file. Returns numbered lines (at most ${READ_LINES} per call; use offset to page).`,
    parameters: obj(
      {
        file_path: str("Path relative to the repository root"),
        offset: { type: "integer", minimum: 1, description: "First line to read (1-based)" },
        limit: { type: "integer", minimum: 1, description: "Number of lines" },
      },
      ["file_path"],
    ),
  },
  Write: {
    description: "Create or overwrite a file with the given content.",
    parameters: obj(
      { file_path: str("Path relative to the repository root"), content: str("Full file content") },
      ["file_path", "content"],
    ),
  },
  Edit: {
    description:
      "Replace text in a file. old_string must appear exactly once unless replace_all is true. Read the file first.",
    parameters: obj(
      {
        file_path: str("Path relative to the repository root"),
        old_string: str("Exact text to replace, including whitespace"),
        new_string: str("Replacement text"),
        replace_all: { type: "boolean", description: "Replace every occurrence" },
      },
      ["file_path", "old_string", "new_string"],
    ),
  },
  Glob: {
    description: "List files matching a glob pattern such as src/**/*.ts (skips .git and node_modules).",
    parameters: obj({ pattern: str("Glob pattern"), path: str("Directory to search (default: root)") }, [
      "pattern",
    ]),
  },
  Grep: {
    description: "Search file contents with a JavaScript regular expression. Returns path:line:text matches.",
    parameters: obj(
      {
        pattern: str("Regular expression"),
        path: str("File or directory to search (default: root)"),
        glob: str("Only search files whose path matches this glob"),
      },
      ["pattern"],
    ),
  },
  Bash: {
    description:
      "Run a shell command in the repository root (e.g. tests, build). Returns exit code and output. No interactive commands.",
    parameters: obj(
      {
        command: str("Command to run with bash -c"),
        timeout_sec: { type: "integer", minimum: 1, maximum: 1800, description: "Timeout (default 300)" },
      },
      ["command"],
    ),
  },
};

/** OpenAI-style function tool definitions for the given allowlist. */
export function toolDefinitions(tools: readonly ToolName[]) {
  return tools
    .filter((t) => IMPLEMENTED_TOOLS.includes(t))
    .map((name) => ({ type: "function" as const, function: { name, ...SCHEMAS[name]! } }));
}

export function truncate(s: string, max = MAX_TOOL_OUTPUT): string {
  return s.length > max ? `${s.slice(0, max)}\n… [truncated ${s.length - max} characters]` : s;
}

function within(root: string, p: string): boolean {
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Resolve a tool path inside the sandbox. Rejects `..` escapes, absolute paths elsewhere, and
 * symlinks (anywhere on the path) that lead outside.
 */
export async function confine(cwd: string, path: unknown): Promise<string> {
  if (typeof path !== "string" || !path) throw new ToolError("A path is required.");
  const root = await realpath(cwd);
  const abs = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  if (!within(resolve(cwd), abs) && !within(root, abs)) {
    throw new ToolError(`Path ${path} is outside the repository.`);
  }
  // Follow symlinks: resolve the deepest existing ancestor and check where it really is.
  let probe = abs;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  const real = await realpath(probe);
  if (!within(root, real)) throw new ToolError(`Path ${path} resolves outside the repository.`);
  return abs;
}

async function walk(dir: string, root: string, out: string[]): Promise<void> {
  if (out.length >= LIST_LIMIT * 4) return;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = resolve(dir, e.name);
    if (e.isDirectory()) await walk(full, root, out);
    else if (e.isFile()) out.push(relative(root, full).split(sep).join("/"));
  }
}

const relTo = (cwd: string, abs: string) => relative(cwd, abs).split(sep).join("/") || ".";

/** Execute one tool call. Errors the model can fix are thrown as ToolError. */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  switch (name) {
    case "Read": {
      const p = await confine(ctx.cwd, args.file_path);
      if (!existsSync(p)) throw new ToolError(`File not found: ${args.file_path}`);
      if ((await stat(p)).isDirectory()) throw new ToolError(`${args.file_path} is a directory; use Glob.`);
      const lines = (await readFile(p, "utf8")).split("\n");
      const start = Math.max(1, Number(args.offset ?? 1));
      const count = Math.min(READ_LINES, Number(args.limit ?? READ_LINES));
      const body = lines
        .slice(start - 1, start - 1 + count)
        .map((l, i) => `${String(start + i).padStart(6)}\t${l}`)
        .join("\n");
      const more =
        start - 1 + count < lines.length ? `\n… ${lines.length - (start - 1 + count)} more lines` : "";
      return truncate(body + more);
    }
    case "Write": {
      const p = await confine(ctx.cwd, args.file_path);
      if (typeof args.content !== "string") throw new ToolError("content must be a string.");
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, args.content);
      return `Wrote ${relTo(ctx.cwd, p)} (${args.content.split("\n").length} lines).`;
    }
    case "Edit": {
      const p = await confine(ctx.cwd, args.file_path);
      if (!existsSync(p)) throw new ToolError(`File not found: ${args.file_path}`);
      const { old_string: from, new_string: to } = args;
      if (typeof from !== "string" || typeof to !== "string" || !from) {
        throw new ToolError("old_string (non-empty) and new_string must be strings.");
      }
      if (from === to) throw new ToolError("old_string and new_string are identical.");
      const text = await readFile(p, "utf8");
      const count = text.split(from).length - 1;
      if (count === 0)
        throw new ToolError(`old_string not found in ${args.file_path}. Read the file and copy it exactly.`);
      if (count > 1 && args.replace_all !== true) {
        throw new ToolError(
          `old_string appears ${count} times in ${args.file_path}; include more context or set replace_all.`,
        );
      }
      await writeFile(
        p,
        args.replace_all === true ? text.split(from).join(to) : text.replace(from, () => to),
      );
      return `Edited ${relTo(ctx.cwd, p)} (${args.replace_all === true ? count : 1} replacement${count > 1 && args.replace_all ? "s" : ""}).`;
    }
    case "Glob": {
      const base = await confine(ctx.cwd, args.path ?? ".");
      if (typeof args.pattern !== "string") throw new ToolError("pattern must be a string.");
      const re = globToRegExp(args.pattern);
      const files: string[] = [];
      await walk(base, base, files);
      const hits = files.filter((f) => re.test(f)).sort();
      if (!hits.length) return "No files matched.";
      const prefix = relTo(ctx.cwd, base);
      const shown = hits.slice(0, LIST_LIMIT).map((f) => (prefix === "." ? f : `${prefix}/${f}`));
      return shown.join("\n") + (hits.length > LIST_LIMIT ? `\n… ${hits.length - LIST_LIMIT} more` : "");
    }
    case "Grep": {
      const base = await confine(ctx.cwd, args.path ?? ".");
      let re: RegExp;
      try {
        re = new RegExp(String(args.pattern ?? ""));
      } catch (e) {
        throw new ToolError(`Invalid regular expression: ${(e as Error).message}`);
      }
      const only = typeof args.glob === "string" ? globToRegExp(args.glob) : undefined;
      const files: string[] = [];
      if ((await stat(base)).isFile()) files.push(relTo(ctx.cwd, base));
      else {
        await walk(base, ctx.cwd, files);
      }
      const out: string[] = [];
      for (const f of files) {
        if (only && !only.test(f) && !only.test(f.split("/").pop()!)) continue;
        const text = await readFile(resolve(ctx.cwd, f), "utf8").catch(() => "");
        if (text.includes("\u0000")) continue; // binary
        text.split("\n").forEach((line, i) => {
          if (out.length < LIST_LIMIT && re.test(line)) out.push(`${f}:${i + 1}:${line.slice(0, 300)}`);
        });
        if (out.length >= LIST_LIMIT) break;
      }
      return out.length ? truncate(out.join("\n")) : "No matches.";
    }
    case "Bash": {
      if (typeof args.command !== "string" || !args.command.trim())
        throw new ToolError("command is required.");
      const timeoutSec = Math.min(1800, Number(args.timeout_sec ?? BASH_TIMEOUT_SEC));
      const r = ctx.runtime?.exec
        ? await ctx.runtime.exec(args.command, { timeoutSec })
        : await execShell(args.command, ctx.cwd, {
            timeoutSec,
            inheritEnv: false,
            env: bashEnv(ctx.secretEnvs),
          });
      const half = MAX_TOOL_OUTPUT / 2;
      const tail = (s: string) =>
        s.length > half ? `… [${s.length - half} characters cut]\n${s.slice(-half)}` : s;
      return [
        `exit code: ${r.exitCode}${r.exitCode === 124 ? " (timed out)" : ""}`,
        r.stdout && `stdout:\n${tail(r.stdout)}`,
        r.stderr && `stderr:\n${tail(r.stderr)}`,
      ]
        .filter(Boolean)
        .join("\n");
    }
    default:
      throw new ToolError(`Unknown tool ${name}.`);
  }
}

/** Host environment minus every credential the factory knows about (R9.4). */
export function bashEnv(secretEnvs: readonly string[] = []): Record<string, string> {
  const env = agentEnv(process.env, ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", ...secretEnvs]);
  return Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>;
}
