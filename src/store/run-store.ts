// Append-only run store with crash-safe writes (specs/01-foundations.md R0.7, R0.8).
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { RunRecord } from "../contracts/index.js";

export class RunStore {
  constructor(readonly root = "runs") {}

  batchDir(batchId: string): string {
    return join(this.root, batchId);
  }

  artifactDir(batchId: string, runId: string): string {
    return join(this.root, batchId, runId);
  }

  async append(record: RunRecord, hooks: { beforeRename?: () => void } = {}): Promise<void> {
    RunRecord.parse(record);
    const file = join(this.batchDir(record.batchId), "records.jsonl");
    await mkdir(dirname(file), { recursive: true });
    const existing = existsSync(file) ? await readFile(file, "utf8") : "";
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, existing + JSON.stringify(record) + "\n");
    hooks.beforeRename?.();
    await rename(tmp, file);
  }

  async writeArtifact(batchId: string, runId: string, name: string, content: string): Promise<string> {
    const path = join(this.artifactDir(batchId, runId), name);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, content);
    await rename(tmp, path);
    return path;
  }

  async read(batchId: string): Promise<RunRecord[]> {
    const file = join(this.batchDir(batchId), "records.jsonl");
    if (!existsSync(file)) return [];
    const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
    return lines.map((l) => RunRecord.parse(JSON.parse(l)));
  }

  /** Latest record per runId (records are appended on every state change). */
  async latest(batchId: string): Promise<RunRecord[]> {
    const byRun = new Map<string, RunRecord>();
    for (const r of await this.read(batchId)) byRun.set(r.runId, r);
    return [...byRun.values()];
  }

  async batches(): Promise<string[]> {
    if (!existsSync(this.root)) return [];
    const entries = await readdir(this.root, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && existsSync(join(this.root, e.name, "records.jsonl")))
      .map((e) => e.name)
      .sort();
  }

  async all(): Promise<RunRecord[]> {
    const out: RunRecord[] = [];
    for (const b of await this.batches()) out.push(...(await this.latest(b)));
    return out;
  }
}

export function newId(prefix = ""): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `${prefix}${stamp}-${randomUUID().slice(0, 8)}`;
}

/** Git SHA of the factory checkout, or "unknown" outside git. */
export function factoryVersion(cwd = process.cwd()): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

async function listFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** Stable hash over the contents (and relative paths) of a playbooks directory. */
export async function playbookHash(dir = "playbooks"): Promise<string> {
  const files = (await listFiles(dir)).filter((f) => !f.endsWith("HISTORY.jsonl")).sort();
  const h = createHash("sha256");
  for (const f of files) {
    h.update(relative(dir, f));
    h.update("\0");
    h.update(await readFile(f));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}
