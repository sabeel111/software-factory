import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { activityFromMessage } from "../src/agents/claude-runner.js";
import { initialState, lanes, replay, totals } from "../src/events/state.js";
import type { EventBody, FactoryEvent } from "../src/events/types.js";

function stamp(bodies: EventBody[], batchId = "b1"): FactoryEvent[] {
  return bodies.map(
    (b, i) =>
      ({
        ...b,
        seq: i + 1,
        at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        batchId,
      }) as FactoryEvent,
  );
}

const limits = { concurrency: 2, maxCostUsdPerRun: 10, maxCostUsdPerIssue: 3, maxWorkerAttempts: 2 };

describe("live state reducer", () => {
  it("T8.1 reduces a batch with a retry, a rejection and an integration eject", () => {
    const events = stamp([
      { type: "job.started", job: "batch", label: "Batch", demo: true },
      {
        type: "batch.started",
        repo: "o/r",
        mode: "integrated",
        limits,
        queued: [
          { number: 1, title: "Retry me", labels: [] },
          { number: 2, title: "Vague", labels: [] },
          { number: 3, title: "Conflicts", labels: [] },
        ],
      },
      { type: "issue.claimed", issue: 1, title: "Retry me", runId: "r1" },
      { type: "issue.claimed", issue: 2, title: "Vague", runId: "r2" },
      { type: "stage.started", issue: 1, stage: "triage", attempt: 1 },
      {
        type: "stage.finished",
        issue: 1,
        stage: "triage",
        attempt: 1,
        durationMs: 1000,
        costUsd: 0.05,
        ok: true,
      },
      { type: "stage.started", issue: 2, stage: "triage", attempt: 1 },
      {
        type: "stage.finished",
        issue: 2,
        stage: "triage",
        attempt: 1,
        durationMs: 900,
        costUsd: 0.04,
        ok: true,
      },
      { type: "issue.finished", issue: 2, outcome: "rejected", costUsd: 0.04 },
      { type: "stage.started", issue: 1, stage: "worker", attempt: 1 },
      {
        type: "agent.activity",
        issue: 1,
        stage: "worker",
        attempt: 1,
        kind: "tool",
        tool: "Edit",
        detail: "src/a.ts",
      },
      {
        type: "stage.finished",
        issue: 1,
        stage: "worker",
        attempt: 1,
        durationMs: 5000,
        costUsd: 0.5,
        ok: true,
      },
      { type: "stage.started", issue: 1, stage: "verifier", attempt: 1 },
      {
        type: "verifier.check",
        issue: 1,
        attempt: 1,
        name: "test",
        exitCode: 1,
        durationMs: 300,
        tests: { passed: 3, failed: 1, skipped: 0 },
        outputTail: "not ok",
      },
      {
        type: "stage.finished",
        issue: 1,
        stage: "verifier",
        attempt: 1,
        durationMs: 300,
        costUsd: 0,
        ok: false,
      },
      { type: "stage.started", issue: 1, stage: "worker", attempt: 2 },
      { type: "issue.claimed", issue: 3, title: "Conflicts", runId: "r3" },
      {
        type: "stage.finished",
        issue: 1,
        stage: "worker",
        attempt: 2,
        durationMs: 4000,
        costUsd: 0.4,
        ok: true,
      },
      {
        type: "issue.finished",
        issue: 1,
        outcome: "ready_to_integrate",
        costUsd: 0.95,
        branch: "factory/issue-1-x",
      },
      { type: "issue.finished", issue: 3, outcome: "ready_to_integrate", costUsd: 0.6 },
      { type: "integration.started", issues: [1, 3] },
      { type: "stage.started", issue: 3, stage: "integrator", attempt: 1 },
      {
        type: "stage.finished",
        issue: 3,
        stage: "integrator",
        attempt: 1,
        durationMs: 2000,
        costUsd: 0.2,
        ok: true,
      },
      { type: "integration.merge", issue: 1, conflicted: false, merged: true },
      { type: "integration.merge", issue: 3, conflicted: true, merged: false, reason: "tests-dropped" },
      {
        type: "integration.finished",
        merged: [1],
        ejected: [{ issue: 3, reason: "tests-dropped" }],
        prUrl: "https://x/pr/1",
        costUsd: 0.2,
      },
      { type: "batch.finished", costUsd: 1.19, unstarted: [] },
    ]);
    const live = replay(events);
    const b = live.batch!;
    expect(b.issues[1]).toMatchObject({
      column: "shipped",
      attempt: 2,
      outcome: "integrated",
      prUrl: "https://x/pr/1",
    });
    expect(b.issues[1]!.costUsd).toBeCloseTo(0.95);
    expect(b.issues[1]!.checks).toHaveLength(1);
    expect(b.issues[1]!.activity[0]).toMatchObject({ tool: "Edit", detail: "src/a.ts" });
    expect(b.issues[2]).toMatchObject({ column: "rejected", outcome: "rejected" });
    expect(b.issues[3]).toMatchObject({ column: "failed", outcome: "ejected", reason: "tests-dropped" });
    // Integration cost counted once (from the integrator's stage events), not twice.
    expect(b.costUsd).toBeCloseTo(0.05 + 0.04 + 0.5 + 0.4 + 0.2);
    expect(totals(b)).toMatchObject({ total: 3, shipped: 1, rejected: 1, failed: 1, inFlight: 0 });
    expect(lanes(b)).toEqual([]);
    expect(b.finishedAt).toBeDefined();
    expect(b.integration).toMatchObject({ running: false, merged: [1] });

    // Mid-batch: issue 1 holds a lane while building attempt 2.
    const mid = replay(events.slice(0, 16));
    expect(lanes(mid.batch!).map((i) => i.number)).toEqual([1]);
    expect(mid.batch!.issues[1]).toMatchObject({ column: "worker", attempt: 2, active: true });

    // Duplicated events after a reconnect change nothing.
    expect(replay([...events, ...events.slice(5, 10)])).toEqual(live);
    expect(replay([], initialState())).toEqual(initialState());
  });
});

describe("agent activity mapping", () => {
  it("T8.4 maps tool calls, text and tool errors to short, content-free activity", () => {
    const cwd = "/sbx/work";
    const assistant = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Let me look at the router.\nThen fix it." },
          { type: "tool_use", name: "Read", input: { file_path: "/sbx/work/src/router.ts" } },
          {
            type: "tool_use",
            name: "Edit",
            input: {
              file_path: "/sbx/work/src/router.ts",
              old_string: "SECRET OLD",
              new_string: "SECRET NEW",
            },
          },
          { type: "tool_use", name: "Bash", input: { command: "npm test\necho done" } },
          { type: "tool_use", name: "Grep", input: { pattern: "expiresAt", path: "/sbx/work/src" } },
          { type: "tool_use", name: "mcp__context7__get-library-docs", input: { libraryID: "/node/node" } },
        ],
      },
    } as unknown as SDKMessage;
    const out = activityFromMessage(assistant, cwd);
    expect(out).toEqual([
      { kind: "text", detail: "Let me look at the router." },
      { kind: "tool", tool: "Read", detail: "src/router.ts" },
      { kind: "tool", tool: "Edit", detail: "src/router.ts" },
      { kind: "tool", tool: "Bash", detail: "npm test" },
      { kind: "tool", tool: "Grep", detail: "/expiresAt/ in src" },
      { kind: "tool", tool: "context7 › get-library-docs", detail: "/node/node" },
    ]);
    expect(JSON.stringify(out)).not.toContain("SECRET");

    const results = {
      type: "user",
      message: {
        content: [
          { type: "tool_result", is_error: false, content: "FILE CONTENTS line 1\nline 2" },
          { type: "tool_result", is_error: true, content: "Error: ENOENT no such file\nstack…" },
        ],
      },
    } as unknown as SDKMessage;
    expect(activityFromMessage(results, cwd)).toEqual([
      { kind: "result", detail: "Error: ENOENT no such file", isError: true },
    ]);
  });
});
