// Scripted AgentRunner for tokenless tests (specs/01-foundations.md R0.6).
import type { StageName } from "../contracts/index.js";
import {
  AgentFailed,
  AgentTimeout,
  validateOutput,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRunner,
} from "./runner.js";

export interface ScriptContext {
  req: AgentRunRequest<unknown>;
}

export type ScriptStep =
  | { output: unknown; costUsd?: number; delayMs?: number }
  | { throw: string; costUsd?: number }
  | { timeout: true; costUsd?: number }
  /** Run arbitrary side effects (e.g. edit files in req.cwd) and return the output. */
  | { act: (ctx: ScriptContext) => unknown | Promise<unknown>; costUsd?: number; delayMs?: number };

type Key = `${StageName}:${number}:${number}`;

export class FakeAgentRunner implements AgentRunner {
  private readonly scripts = new Map<string, ScriptStep>();
  readonly calls: AgentRunRequest<unknown>[] = [];

  /** Script (stage, issue, attempt). Use attempt "*" to match any attempt, issue "*" to match any issue. */
  script(stage: StageName, issue: number | "*", attempt: number | "*", step: ScriptStep): this {
    this.scripts.set(`${stage}:${issue}:${attempt}`, step);
    return this;
  }

  private lookup(stage: StageName, issue: number, attempt: number): ScriptStep | undefined {
    const keys: string[] = [
      `${stage}:${issue}:${attempt}` satisfies Key,
      `${stage}:${issue}:*`,
      `${stage}:*:${attempt}`,
      `${stage}:*:*`,
    ];
    for (const k of keys) {
      const step = this.scripts.get(k);
      if (step) return step;
    }
    return undefined;
  }

  async run<T>(req: AgentRunRequest<T>): Promise<AgentRunResult<T>> {
    this.calls.push(req as AgentRunRequest<unknown>);
    const step = this.lookup(req.stage, req.issue, req.attempt);
    if (!step)
      throw new AgentFailed(
        `FakeAgentRunner: no script for ${req.stage}#${req.issue} attempt ${req.attempt}`,
      );
    const costUsd = step.costUsd ?? 0;
    const started = Date.now();
    if ("throw" in step) throw new AgentFailed(step.throw, costUsd);
    if ("timeout" in step) throw new AgentTimeout(`${req.stage} timed out`, costUsd);
    if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
    const raw = "act" in step ? await step.act({ req: req as AgentRunRequest<unknown> }) : step.output;
    const output = validateOutput(req.outputSchema, raw, costUsd);
    return {
      output,
      usage: { input: 100, output: 50 },
      costUsd,
      durationMs: Date.now() - started,
      transcriptPath: req.transcriptPath,
    };
  }
}
