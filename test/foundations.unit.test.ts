import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { FakeAgentRunner } from "../src/agents/fake-runner.js";
import { AgentOutputInvalid } from "../src/agents/runner.js";
import { buildProgram, NOT_IMPLEMENTED_EXIT } from "../src/cli.js";
import { ConfigError, loadConfig, parseConfig } from "../src/config.js";
import {
  IntegrationResult,
  IssueRef,
  ReviewResult,
  RunRecord,
  TriageResult,
  VerifierResult,
  WorkerResult,
  toJsonSchema,
} from "../src/contracts/index.js";
import { playbookHash } from "../src/store/run-store.js";
import { coverage } from "../scripts/spec-coverage.js";

const triage: TriageResult = {
  decision: "accept",
  reason: "clear bug with reproducible steps",
  kind: "bug",
  acceptanceCriteria: ["returns 400 for malformed url"],
  clarifyingQuestions: [],
  estimatedComplexity: "s",
};

const verifier: VerifierResult = {
  status: "pass",
  commitSha: "abc123",
  checks: [{ name: "test", command: "npm test", exitCode: 0, durationMs: 1200, outputTail: "ok" }],
  testSummary: { passed: 10, failed: 0, skipped: 0 },
};

const samples = {
  IssueRef: { repo: "o/r", number: 1, title: "t", body: "b", labels: ["factory:ready"] },
  TriageResult: triage,
  WorkerResult: {
    status: "done",
    branch: "factory/issue-1-abcd1234",
    commitSha: "abc123",
    touchedFiles: ["src/a.ts"],
    testsAdded: ["test/a.test.ts"],
    summary: "fixed",
  },
  VerifierResult: verifier,
  ReviewResult: { verdict: "approve", findings: [], scopeCreep: false },
  IntegrationResult: {
    status: "integrated",
    integrationBranch: "factory/integration-b1",
    merged: [1, 2],
    ejected: [],
    conflictsResolved: 1,
    finalVerification: verifier,
  },
  RunRecord: {
    runId: "r1",
    batchId: "b1",
    issue: { repo: "o/r", number: 1, title: "t", body: "b", labels: [] },
    startedAt: new Date().toISOString(),
    factoryVersion: "sha",
    playbookHash: "h",
    stages: [
      {
        stage: "triage",
        attempt: 1,
        startedAt: new Date().toISOString(),
        durationMs: 5,
        costUsd: 0.01,
        tokens: { input: 1, output: 1 },
        output: triage,
      },
    ],
  },
};

const contracts = {
  IssueRef,
  TriageResult,
  WorkerResult,
  VerifierResult,
  ReviewResult,
  IntegrationResult,
  RunRecord,
};

describe("contracts", () => {
  it("T0.1 TriageResult accepts valid objects and rejects bad decisions with a path", () => {
    expect(TriageResult.safeParse(triage).success).toBe(true);
    const bad = TriageResult.safeParse({ ...triage, decision: "maybe" });
    expect(bad.success).toBe(false);
    expect(bad.error!.issues[0]!.path).toEqual(["decision"]);
  });

  it("T0.2 every contract's JSON Schema validates its sample with ajv", () => {
    const ajv = new Ajv({ strict: false });
    for (const [name, schema] of Object.entries(contracts)) {
      const validate = ajv.compile(toJsonSchema(schema));
      const sample = samples[name as keyof typeof samples];
      expect(schema.safeParse(sample).success, `${name} zod`).toBe(true);
      expect(validate(sample), `${name} ajv: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });
});

describe("config", () => {
  it("T0.3 missing limits are filled with defaults", () => {
    const cfg = parseConfig({ repo: "o/r" });
    expect(cfg.limits).toEqual({
      concurrency: 4,
      maxWorkerAttempts: 2,
      maxOpenPrs: 5,
      maxCostUsdPerIssue: 3,
      maxCostUsdPerRun: 25,
      stageTimeoutSec: 900,
    });
    expect(cfg.stages.worker.model).toBe("claude-opus-5-5");
    expect(cfg.prMode).toBe("integrated");
  });

  it("T0.4 invalid limits fail and name the offending key", async () => {
    expect(() => parseConfig({ repo: "o/r", limits: { concurrency: 0 } })).toThrow(/limits\.concurrency/);
    const dir = await mkdtemp(join(tmpdir(), "cfg-"));
    const path = join(dir, "factory.config.ts");
    await writeFile(path, `export default { repo: "o/r", limits: { concurrency: 0 } };\n`);
    await expect(loadConfig(path)).rejects.toThrow(ConfigError);
    await expect(loadConfig(path)).rejects.toThrow(/limits\.concurrency/);
  });
});

describe("cli", () => {
  it("T0.5 --help lists the commands and unimplemented commands exit 2", async () => {
    const logs: string[] = [];
    const out = { log: (s: string) => logs.push(s), err: (s: string) => logs.push(s) };
    const { program } = buildProgram(out, new Map());
    await expect(program.parseAsync(["--help"], { from: "user" })).rejects.toMatchObject({ exitCode: 0 });
    const help = logs.join("\n");
    for (const cmd of ["run", "bench", "improve", "status"]) expect(help).toContain(cmd);

    const { program: p2, result } = buildProgram(out, new Map());
    await p2.parseAsync(["improve"], { from: "user" });
    expect(result.code).toBe(NOT_IMPLEMENTED_EXIT);
    expect(logs.join("\n")).toContain("not implemented in this phase");
  });
});

describe("fake agent runner", () => {
  const base = {
    stage: "triage" as const,
    issue: 3,
    playbook: "",
    input: {},
    cwd: ".",
    tools: [],
    model: "m",
    effort: "low" as const,
  };

  it("T0.6 output that fails the schema raises AgentOutputInvalid", async () => {
    const runner = new FakeAgentRunner().script("triage", 3, 1, { output: { decision: "accept" } });
    await expect(runner.run({ ...base, attempt: 1, outputSchema: TriageResult })).rejects.toBeInstanceOf(
      AgentOutputInvalid,
    );
  });

  it("T0.7 per-attempt scripts return distinct outputs", async () => {
    const runner = new FakeAgentRunner()
      .script("triage", 3, 1, { output: { ...triage, reason: "first" } })
      .script("triage", 3, 2, { output: { ...triage, reason: "second" } });
    const a = await runner.run({ ...base, attempt: 1, outputSchema: TriageResult });
    const b = await runner.run({ ...base, attempt: 2, outputSchema: TriageResult });
    expect(a.output.reason).toBe("first");
    expect(b.output.reason).toBe("second");
  });
});

describe("spec coverage", () => {
  it("T0.9 a spec ID with no matching test is reported missing", () => {
    const spec = "| T9.99 | unit | something |\n| T9.1 | unit | x |";
    const tests = [`it("T9.1 does x", () => {});`];
    const r = coverage([spec], tests);
    expect(r.missing).toEqual(["T9.99"]);
    expect(r.covered).toEqual(["T9.1"]);
  });
});

describe("playbook hash", () => {
  it("T0.10 differs for different contents and is stable for identical contents", async () => {
    const mk = async (content: string) => {
      const dir = await mkdtemp(join(tmpdir(), "pb-"));
      await mkdir(join(dir, "sub"));
      await writeFile(join(dir, "worker.md"), content);
      await writeFile(join(dir, "sub", "x.md"), "x");
      return dir;
    };
    const a = await mk("one");
    const b = await mk("one");
    const c = await mk("two");
    expect(await playbookHash(a)).toBe(await playbookHash(b));
    expect(await playbookHash(a)).not.toBe(await playbookHash(c));
  });
});
