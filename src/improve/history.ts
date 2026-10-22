// playbooks/HISTORY.jsonl: every candidate, accepted or not (specs/07-self-improvement.md R6.6).
import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { StageSettingChange } from "./candidate.js";
import type { EvalScores, GateReason } from "./candidate.js";

/** A file's content before/after a change; null means the file doesn't exist. */
export interface FileChange {
  file: string;
  before: string | null;
  after: string | null;
}

export interface HistoryEntry {
  candidateId: string;
  at: string;
  parentHash: string;
  hypothesis: string;
  targets: string[];
  patch: FileChange[];
  stageSettings: { change: StageSettingChange; before: Record<string, unknown> }[];
  scores: { champion: EvalScores[]; candidate: EvalScores[] };
  noiseBand: number;
  decision: GateReason | "out-of-bounds" | "not-evaluated: budget" | "evaluation-failed";
  accepted: boolean;
  prUrl?: string;
  revertOf?: string;
}

export class History {
  constructor(readonly file = join("playbooks", "HISTORY.jsonl")) {}

  async append(entry: HistoryEntry): Promise<void> {
    await appendFile(this.file, JSON.stringify(entry) + "\n");
  }

  async entries(): Promise<HistoryEntry[]> {
    if (!existsSync(this.file)) return [];
    return (await readFile(this.file, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as HistoryEntry);
  }

  async find(candidateId: string): Promise<HistoryEntry | undefined> {
    return (await this.entries()).find((e) => e.candidateId === candidateId);
  }
}
