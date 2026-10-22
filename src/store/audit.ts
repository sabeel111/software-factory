// Append-only audit log of every external side effect (specs/08-team-readiness.md R7.6).
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface AuditEvent {
  at: string;
  batchId?: string;
  runId?: string;
  actor: string;
  method: string;
  path: string;
  status: number;
}

export class AuditLog {
  constructor(readonly file = join("runs", "audit.jsonl")) {}

  async record(event: Omit<AuditEvent, "at">): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await appendFile(this.file, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
  }
}
