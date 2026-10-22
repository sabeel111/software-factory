// AgentRunner: the one seam through which every LLM call passes (specs/01-foundations.md R0.5).
import type { z } from "zod";
import type { StageName, Usage } from "../contracts/index.js";

export type ToolName = "Read" | "Write" | "Edit" | "Glob" | "Grep" | "Bash" | "WebFetch";

export const READ_ONLY_TOOLS: readonly ToolName[] = ["Read", "Glob", "Grep"];
export const WRITE_TOOLS: readonly ToolName[] = ["Write", "Edit", "Bash"];

export interface AgentRunRequest<T> {
  stage: StageName;
  /** Issue number (or 0 for batch-level stages); used for logging and by the fake runner. */
  issue: number;
  attempt: number;
  playbook: string;
  input: unknown;
  outputSchema: z.ZodType<T>;
  cwd: string;
  tools: readonly ToolName[];
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  maxTurns?: number;
  maxBudgetUsd?: number;
  timeoutSec?: number;
  mcpServers?: Record<string, unknown>;
  transcriptPath?: string;
}

export interface AgentRunResult<T> {
  output: T;
  usage: Usage;
  costUsd: number;
  durationMs: number;
  transcriptPath?: string;
}

export interface AgentRunner {
  run<T>(req: AgentRunRequest<T>): Promise<AgentRunResult<T>>;
}

export class AgentOutputInvalid extends Error {
  override name = "AgentOutputInvalid";
  constructor(
    message: string,
    readonly raw: unknown,
    readonly costUsd = 0,
  ) {
    super(message);
  }
}

export class AgentTimeout extends Error {
  override name = "AgentTimeout";
  constructor(
    message: string,
    readonly costUsd = 0,
  ) {
    super(message);
  }
}

export class AgentFailed extends Error {
  override name = "AgentFailed";
  constructor(
    message: string,
    readonly costUsd = 0,
  ) {
    super(message);
  }
}

/** Validate an agent's raw output against the stage schema, raising AgentOutputInvalid on mismatch. */
export function validateOutput<T>(schema: z.ZodType<T>, raw: unknown, costUsd = 0): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new AgentOutputInvalid(`Agent output failed schema validation: ${detail}`, raw, costUsd);
  }
  return parsed.data;
}

/** Cost carried by any agent error, so budgets account for failed attempts too. */
export function errorCost(err: unknown): number {
  if (err instanceof AgentOutputInvalid || err instanceof AgentTimeout || err instanceof AgentFailed) {
    return err.costUsd;
  }
  return 0;
}
