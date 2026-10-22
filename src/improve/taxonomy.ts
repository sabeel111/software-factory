// Failure taxonomy (specs/07-self-improvement.md). Deterministic: code, not an LLM.
import {
  ReviewResult,
  TriageResult,
  VerifierResult,
  type RunRecord,
  type StageName,
} from "../contracts/index.js";

export type FailureCode =
  | "triage-false-accept"
  | "triage-false-reject"
  | "verify-fail-repeat"
  | "false-pass"
  | "review-miss"
  | "review-noise"
  | "integration-eject"
  | "budget"
  | "timeout";

export const FAILURE_STAGE: Record<FailureCode, StageName> = {
  "triage-false-accept": "triage",
  "triage-false-reject": "triage",
  "verify-fail-repeat": "worker",
  "false-pass": "worker",
  "review-miss": "reviewer",
  "review-noise": "reviewer",
  "integration-eject": "integrator",
  budget: "worker",
  timeout: "worker",
};

/** What the benchmark knows about a run that the run record itself can't. */
export interface RunContext {
  expectedTriage?: "accept" | "reject";
  /** Did the issue's hidden test pass on the run's final (approved) commit? */
  hiddenPassed?: boolean;
  /** Hidden test result per commit sha, to detect review noise on earlier attempts. */
  hiddenPassedByCommit?: Record<string, boolean>;
  ejected?: boolean;
}

function outputs<T>(
  record: RunRecord,
  stage: StageName,
  parse: (x: unknown) => { success: boolean; data?: T },
) {
  return record.stages
    .filter((s) => s.stage === stage && !s.error)
    .map((s) => ({ attempt: s.attempt, out: parse(s.output) }))
    .filter((x) => x.out.success)
    .map((x) => ({ attempt: x.attempt, out: x.out.data as T }));
}

export function classify(record: RunRecord, ctx: RunContext = {}): FailureCode[] {
  const codes = new Set<FailureCode>();
  const triage = outputs(record, "triage", (x) => TriageResult.safeParse(x))[0]?.out;
  const verifications = outputs(record, "verifier", (x) => VerifierResult.safeParse(x));
  const reviews = outputs(record, "reviewer", (x) => ReviewResult.safeParse(x));

  if (triage && ctx.expectedTriage) {
    if (triage.decision === "accept" && ctx.expectedTriage === "reject") codes.add("triage-false-accept");
    if (triage.decision === "reject" && ctx.expectedTriage === "accept") codes.add("triage-false-reject");
  }

  if (verifications.length >= 2 && verifications.every((v) => v.out.status !== "pass")) {
    const failing = verifications.map((v) =>
      v.out.checks
        .filter((c) => c.exitCode !== 0)
        .map((c) => c.name)
        .sort()
        .join(","),
    );
    if (new Set(failing).size === 1) codes.add("verify-fail-repeat");
  }

  const lastPass = [...verifications].reverse().find((v) => v.out.status === "pass");
  if (lastPass && ctx.hiddenPassed === false) {
    codes.add("false-pass");
    const approved = reviews.find((r) => r.attempt === lastPass.attempt && r.out.verdict === "approve");
    if (approved) codes.add("review-miss");
  }

  if (ctx.hiddenPassedByCommit) {
    for (const r of reviews.filter((x) => x.out.verdict === "request_changes")) {
      const v = verifications.find((x) => x.attempt === r.attempt);
      if (v && ctx.hiddenPassedByCommit[v.out.commitSha] === true) codes.add("review-noise");
    }
  }

  if (ctx.ejected) codes.add("integration-eject");
  if (record.outcome === "budget_exceeded") codes.add("budget");
  if (record.stages.some((s) => s.error?.startsWith("AgentTimeout"))) codes.add("timeout");
  return [...codes];
}

export interface FailureCluster {
  code: FailureCode;
  stage: StageName;
  count: number;
  excerpts: Excerpt[];
}

export interface Excerpt {
  issue: number;
  title: string;
  outcome?: string;
  details: string[];
}

function excerpt(record: RunRecord): Excerpt {
  const details: string[] = [];
  for (const s of record.stages) {
    if (s.error) details.push(`${s.stage}#${s.attempt} error: ${s.error.slice(0, 300)}`);
    const v = VerifierResult.safeParse(s.output);
    if (s.stage === "verifier" && v.success && v.data.status !== "pass") {
      for (const c of v.data.checks.filter((x) => x.exitCode !== 0)) {
        details.push(`verifier#${s.attempt} ${c.name} failed: …${c.outputTail.slice(-300)}`);
      }
    }
    const r = ReviewResult.safeParse(s.output);
    if (s.stage === "reviewer" && r.success) {
      for (const f of r.data.findings)
        details.push(`review#${s.attempt} ${f.severity}: ${f.message.slice(0, 200)}`);
    }
  }
  return {
    issue: record.issue.number,
    title: record.issue.title,
    outcome: record.outcome,
    details: details.slice(0, 8),
  };
}

export function cluster(
  items: { record: RunRecord; codes: FailureCode[] }[],
  maxClusters = 5,
  maxExcerpts = 3,
): FailureCluster[] {
  const byCode = new Map<FailureCode, RunRecord[]>();
  for (const { record, codes } of items) {
    for (const c of codes) byCode.set(c, [...(byCode.get(c) ?? []), record]);
  }
  return [...byCode.entries()]
    .map(([code, records]) => ({
      code,
      stage: FAILURE_STAGE[code],
      count: records.length,
      excerpts: records.slice(0, maxExcerpts).map(excerpt),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, maxClusters);
}
