// Tracks live sandboxes so a restarted orchestrator can sweep orphans (specs/03-sandboxes.md R2.6).
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Mutex } from "../util/mutex.js";

export interface LedgerEntry {
  id: string;
  provider: string;
  path: string;
  branch: string;
  snapshot: string;
  pid: number;
  createdAt: string;
  /** Provider-specific data (e.g. docker container id). */
  meta?: Record<string, string>;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class Ledger {
  private readonly mutex = new Mutex();

  constructor(readonly file: string) {}

  async entries(): Promise<LedgerEntry[]> {
    if (!existsSync(this.file)) return [];
    return JSON.parse(await readFile(this.file, "utf8")) as LedgerEntry[];
  }

  private async write(entries: LedgerEntry[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(entries, null, 2));
    await rename(tmp, this.file);
  }

  add(entry: LedgerEntry): Promise<void> {
    return this.mutex.run(async () => this.write([...(await this.entries()), entry]));
  }

  remove(id: string): Promise<void> {
    return this.mutex.run(async () => this.write((await this.entries()).filter((e) => e.id !== id)));
  }

  /** Entries owned by processes that are no longer running. */
  async orphans(): Promise<LedgerEntry[]> {
    return (await this.entries()).filter((e) => e.pid !== process.pid && !pidAlive(e.pid));
  }
}
