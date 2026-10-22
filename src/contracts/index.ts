// Typed contracts exchanged between pipeline stages (specs/00-overview.md §4).
// Every stage boundary validates against these schemas; nothing parses free-form text.
import { z } from "zod";

export const StageName = z.enum(["triage", "worker", "verifier", "reviewer", "integrator", "retro"]);
export type StageName = z.infer<typeof StageName>;

export const IssueRef = z.object({
  repo: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  labels: z.array(z.string()),
});
export type IssueRef = z.infer<typeof IssueRef>;

export const TriageResult = z.object({
  decision: z.enum(["accept", "reject"]),
  reason: z.string(),
  kind: z.enum(["bug", "feature", "chore"]).optional(),
  acceptanceCriteria: z.array(z.string()),
  clarifyingQuestions: z.array(z.string()),
  estimatedComplexity: z.enum(["s", "m", "l"]),
});
export type TriageResult = z.infer<typeof TriageResult>;

export const WorkerResult = z.object({
  status: z.enum(["done", "blocked"]),
  branch: z.string(),
  commitSha: z.string(),
  touchedFiles: z.array(z.string()),
  testsAdded: z.array(z.string()),
  summary: z.string(),
  blockedReason: z.string().optional(),
});
export type WorkerResult = z.infer<typeof WorkerResult>;

/** What the worker agent itself reports; branch and commit are filled in by the factory. */
export const WorkerAgentOutput = WorkerResult.omit({ branch: true, commitSha: true });
export type WorkerAgentOutput = z.infer<typeof WorkerAgentOutput>;

export const CheckResult = z.object({
  name: z.string(),
  command: z.string(),
  exitCode: z.number().int(),
  durationMs: z.number().nonnegative(),
  outputTail: z.string(),
});
export type CheckResult = z.infer<typeof CheckResult>;

export const TestSummary = z.object({
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export type TestSummary = z.infer<typeof TestSummary>;

export const VerifierResult = z.object({
  status: z.enum(["pass", "fail", "error"]),
  commitSha: z.string(),
  checks: z.array(CheckResult),
  testSummary: TestSummary.nullable(),
});
export type VerifierResult = z.infer<typeof VerifierResult>;

export const ReviewFinding = z.object({
  severity: z.enum(["blocker", "major", "minor"]),
  file: z.string(),
  line: z.number().int().positive().optional(),
  message: z.string(),
});
export type ReviewFinding = z.infer<typeof ReviewFinding>;

export const ReviewResult = z.object({
  verdict: z.enum(["approve", "request_changes"]),
  findings: z.array(ReviewFinding),
  scopeCreep: z.boolean(),
});
export type ReviewResult = z.infer<typeof ReviewResult>;

export const IntegrationResult = z.object({
  status: z.enum(["integrated", "partial", "failed"]),
  integrationBranch: z.string(),
  merged: z.array(z.number().int()),
  ejected: z.array(z.object({ issue: z.number().int(), reason: z.string() })),
  conflictsResolved: z.number().int().nonnegative(),
  finalVerification: VerifierResult,
});
export type IntegrationResult = z.infer<typeof IntegrationResult>;

/** What the integrator agent reports after resolving one conflicted merge. */
export const ConflictResolution = z.object({
  resolved: z.boolean(),
  filesChanged: z.array(z.string()),
  notes: z.string(),
});
export type ConflictResolution = z.infer<typeof ConflictResolution>;

export const Usage = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
});
export type Usage = z.infer<typeof Usage>;

export const StageRecord = z.object({
  stage: StageName,
  attempt: z.number().int().positive(),
  startedAt: z.string(),
  durationMs: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
  tokens: Usage,
  output: z.unknown(),
  error: z.string().optional(),
});
export type StageRecord = z.infer<typeof StageRecord>;

export const RunOutcome = z.enum([
  "pr_opened",
  "ready_to_integrate",
  "rejected",
  "failed",
  "budget_exceeded",
  "cancelled",
]);
export type RunOutcome = z.infer<typeof RunOutcome>;

export const RunRecord = z.object({
  runId: z.string(),
  batchId: z.string(),
  issue: IssueRef,
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  factoryVersion: z.string(),
  playbookHash: z.string(),
  stages: z.array(StageRecord),
  outcome: RunOutcome.optional(),
  /** Set when the run ended on an unexpected (non-agent) error. */
  error: z.string().optional(),
  branch: z.string().optional(),
  commitSha: z.string().optional(),
  prUrl: z.string().optional(),
});
export type RunRecord = z.infer<typeof RunRecord>;

export const schemas = {
  IssueRef,
  TriageResult,
  WorkerResult,
  WorkerAgentOutput,
  VerifierResult,
  ReviewResult,
  IntegrationResult,
  ConflictResolution,
  RunRecord,
} as const;

/** JSON Schema for a contract, used as the agent's structured-output format. */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7", io: "output", unrepresentable: "any" }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  return json;
}
