import type { query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { ClaudeAgentRunner, context7Server } from "../src/agents/claude-runner.js";
import { AgentFailed, AgentOutputInvalid, READ_ONLY_TOOLS } from "../src/agents/runner.js";
import { TriageResult } from "../src/contracts/index.js";
import { accept } from "./helpers/scripts.js";

type QueryParams = Parameters<typeof query>[0];

function fakeQuery(messages: unknown[], seen: QueryParams[] = []): typeof query {
  return ((params: QueryParams) => {
    seen.push(params);
    return (async function* () {
      for (const m of messages) yield m;
    })();
  }) as unknown as typeof query;
}

const success = (structured: unknown, cost = 0.12) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  total_cost_usd: cost,
  usage: { input_tokens: 1200, output_tokens: 300 },
  structured_output: structured,
  result: "",
});

const req = {
  stage: "triage" as const,
  issue: 1,
  attempt: 1,
  playbook: "# Triage playbook",
  input: { issue: { number: 1 } },
  outputSchema: TriageResult,
  cwd: "/tmp",
  tools: READ_ONLY_TOOLS,
  model: "claude-opus-5-5",
  effort: "low" as const,
  maxBudgetUsd: 2,
};

describe("ClaudeAgentRunner", () => {
  it("maps a stage request onto SDK options and validates structured output", async () => {
    const seen: QueryParams[] = [];
    const runner = new ClaudeAgentRunner({ queryFn: fakeQuery([success(accept())], seen) });
    const r = await runner.run({ ...req, mcpServers: context7Server("k") });
    expect(r.output.decision).toBe("accept");
    expect(r.costUsd).toBe(0.12);
    expect(r.usage).toEqual({ input: 1200, output: 300 });

    const o = seen[0]!.options!;
    expect(o.systemPrompt).toBe("# Triage playbook");
    expect(o.cwd).toBe("/tmp");
    expect(o.model).toBe("claude-opus-5-5");
    expect(o.effort).toBe("low");
    expect(o.tools).toEqual(["Read", "Glob", "Grep"]);
    expect(o.allowedTools).toEqual(["Read", "Glob", "Grep", "mcp__context7"]);
    expect(o.permissionMode).toBe("dontAsk");
    expect(o.persistSession).toBe(false);
    expect(o.settingSources).toEqual([]);
    expect(o.maxBudgetUsd).toBe(2);
    expect(o.outputFormat?.type).toBe("json_schema");
    expect((o.outputFormat?.schema as { properties: Record<string, unknown> }).properties).toHaveProperty(
      "decision",
    );
    expect(seen[0]!.prompt as string).toContain('"number": 1');
  });

  it("raises AgentOutputInvalid (with cost) when structured output doesn't match", async () => {
    const runner = new ClaudeAgentRunner({ queryFn: fakeQuery([success({ decision: "maybe" }, 0.3)]) });
    const err = await runner.run(req).catch((e) => e);
    expect(err).toBeInstanceOf(AgentOutputInvalid);
    expect(err.costUsd).toBe(0.3);
  });

  it("maps SDK error results to AgentFailed with the cost so far", async () => {
    const runner = new ClaudeAgentRunner({
      queryFn: fakeQuery([
        {
          type: "result",
          subtype: "error_max_budget_usd",
          total_cost_usd: 2.01,
          errors: ["budget"],
          usage: {},
        },
      ]),
    });
    const err = await runner.run(req).catch((e) => e);
    expect(err).toBeInstanceOf(AgentFailed);
    expect(err.message).toContain("error_max_budget_usd");
    expect(err.costUsd).toBe(2.01);
  });

  it("context7 credentials stay in the host-side MCP config", () => {
    expect(context7Server("secret")).toEqual({
      context7: {
        type: "http",
        url: "https://mcp.context7.com/mcp",
        headers: { CONTEXT7_API_KEY: "secret" },
      },
    });
    expect(context7Server("")).toEqual({ context7: { type: "http", url: "https://mcp.context7.com/mcp" } });
  });
});
