// Loads stage playbooks (the prompts the Improver is allowed to change).
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { StageName } from "../contracts/index.js";

export const DEFAULT_PLAYBOOK_DIR = resolve(import.meta.dirname, "../../playbooks");

export interface Playbooks {
  get(stage: StageName): Promise<string>;
}

export class DirPlaybooks implements Playbooks {
  private readonly cache = new Map<string, string>();

  constructor(readonly dir = DEFAULT_PLAYBOOK_DIR) {}

  async get(stage: StageName): Promise<string> {
    let text = this.cache.get(stage);
    if (text === undefined) {
      text = await readFile(join(this.dir, `${stage}.md`), "utf8");
      this.cache.set(stage, text);
    }
    return text;
  }
}

export class StaticPlaybooks implements Playbooks {
  constructor(private readonly texts: Partial<Record<StageName, string>> = {}) {}

  async get(stage: StageName): Promise<string> {
    return this.texts[stage] ?? `# ${stage}`;
  }
}
