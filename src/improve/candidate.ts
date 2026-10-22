// Improvement candidates, the mutable-surface bounds check, and the acceptance gate
// (specs/07-self-improvement.md R6.1, R6.3).
import { posix } from "node:path";
import { z } from "zod";

export const STAGES_WITH_SETTINGS = ["triage", "worker", "reviewer", "integrator", "retro"] as const;

export const StageSettingChange = z.object({
  stage: z.string(),
  model: z.string().optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  maxTurns: z.number().int().positive().optional(),
});
export type StageSettingChange = z.infer<typeof StageSettingChange>;

export const CandidateProposal = z.object({
  hypothesis: z.string().min(1),
  targets: z.array(z.string()),
  playbookChanges: z.array(z.object({ file: z.string(), content: z.string() })),
  stageSettings: z.array(StageSettingChange).optional(),
});
export type CandidateProposal = z.infer<typeof CandidateProposal>;

export const RetroOutput = z.object({
  candidates: z.array(CandidateProposal).max(3),
  selfIssues: z.array(z.object({ title: z.string(), body: z.string() })),
});
export type RetroOutput = z.infer<typeof RetroOutput>;

export type BoundsResult = { ok: true } | { ok: false; reason: "out-of-bounds"; detail: string };

/** R6.1: candidates may only touch playbooks/*.md and stages.*.{model,effort,maxTurns}. Enforced here, in code. */
export function checkBounds(c: {
  playbookChanges: { file: string }[];
  stageSettings?: unknown[];
}): BoundsResult {
  for (const { file } of c.playbookChanges) {
    const norm = posix.normalize(file.replace(/\\/g, "/"));
    const ok =
      !posix.isAbsolute(norm) &&
      !norm.startsWith("..") &&
      /^playbooks\/[A-Za-z0-9_-]+\.md$/.test(norm) &&
      norm === file;
    if (!ok) return { ok: false, reason: "out-of-bounds", detail: `file ${file}` };
  }
  for (const raw of c.stageSettings ?? []) {
    const allowed = new Set(["stage", "model", "effort", "maxTurns"]);
    const keys = Object.keys(raw as object);
    const bad = keys.find((k) => !allowed.has(k));
    if (bad) return { ok: false, reason: "out-of-bounds", detail: `stage setting ${bad}` };
    const parsed = StageSettingChange.safeParse(raw);
    if (!parsed.success || !(STAGES_WITH_SETTINGS as readonly string[]).includes(parsed.data.stage)) {
      return { ok: false, reason: "out-of-bounds", detail: `stage setting ${JSON.stringify(raw)}` };
    }
  }
  return { ok: true };
}

export interface EvalScores {
  resolveRate: number;
  triageAccuracy: number | null;
  falsePassRate: number | null;
  costPerResolved: number | null;
  costUsd: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const meanOf = (runs: EvalScores[], f: (s: EvalScores) => number | null): number | null => {
  const vals = runs.map(f).filter((x): x is number => x !== null);
  return vals.length ? mean(vals) : null;
};

export type GateReason =
  "accepted" | "within-noise" | "triage-regression" | "false-pass-regression" | "cost-regression" | "no-data";

export interface GateDecision {
  accepted: boolean;
  reason: GateReason;
  champion: Summary;
  candidate: Summary;
}

export interface Summary {
  resolveRate: number;
  triageAccuracy: number | null;
  falsePassRate: number | null;
  costPerResolved: number | null;
  runs: number;
}

export function summarize(runs: EvalScores[]): Summary {
  return {
    resolveRate: mean(runs.map((r) => r.resolveRate)),
    triageAccuracy: meanOf(runs, (r) => r.triageAccuracy),
    falsePassRate: meanOf(runs, (r) => r.falsePassRate),
    costPerResolved: meanOf(runs, (r) => r.costPerResolved),
    runs: runs.length,
  };
}

const EPS = 1e-9;

/** Step 5 of the improvement loop. */
export function gate(champion: EvalScores[], candidate: EvalScores[], noiseBand: number): GateDecision {
  const ch = summarize(champion);
  const ca = summarize(candidate);
  const decide = (accepted: boolean, reason: GateReason): GateDecision => ({
    accepted,
    reason,
    champion: ch,
    candidate: ca,
  });
  if (!champion.length || !candidate.length) return decide(false, "no-data");
  if (ch.triageAccuracy !== null && (ca.triageAccuracy ?? 0) < ch.triageAccuracy - EPS) {
    return decide(false, "triage-regression");
  }
  if (ch.falsePassRate !== null && ca.falsePassRate !== null && ca.falsePassRate > ch.falsePassRate + EPS) {
    return decide(false, "false-pass-regression");
  }
  if (
    ch.costPerResolved !== null &&
    ca.costPerResolved !== null &&
    ca.costPerResolved > 1.25 * ch.costPerResolved + EPS
  ) {
    return decide(false, "cost-regression");
  }
  if (ca.resolveRate - ch.resolveRate <= noiseBand + EPS) return decide(false, "within-noise");
  return decide(true, "accepted");
}

export function scoreTable(d: GateDecision, noiseBand: number): string {
  const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
  const usd = (x: number | null) => (x === null ? "n/a" : `$${x.toFixed(2)}`);
  return [
    "| Metric | Champion | Candidate |",
    "|---|---|---|",
    `| Resolve rate (holdout) | ${pct(d.champion.resolveRate)} | ${pct(d.candidate.resolveRate)} |`,
    `| Triage accuracy | ${pct(d.champion.triageAccuracy)} | ${pct(d.candidate.triageAccuracy)} |`,
    `| False-pass rate | ${pct(d.champion.falsePassRate)} | ${pct(d.candidate.falsePassRate)} |`,
    `| Cost per resolved | ${usd(d.champion.costPerResolved)} | ${usd(d.candidate.costPerResolved)} |`,
    `| Runs | ${d.champion.runs} | ${d.candidate.runs} |`,
    "",
    `Noise band: ${pct(noiseBand)} · Gate: **${d.reason}**`,
  ].join("\n");
}
