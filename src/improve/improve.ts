// The self-improvement loop (specs/07-self-improvement.md): collect → classify → retro → evaluate
// on holdout → gate → promote via PR (a human merges) → record.
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentActivity, AgentRunner } from "../agents/runner.js";
import { noiseBand as spread } from "../bench/score.js";
import type { StageConfig, StageOverrides } from "../config.js";
import type { RunRecord } from "../contracts/index.js";
import { Budget } from "../pipeline/budget.js";
import { newId, playbookHash } from "../store/run-store.js";
import {
  checkBounds,
  gate,
  RetroOutput,
  scoreTable,
  type CandidateProposal,
  type EvalScores,
  type GateDecision,
  type StageSettingChange,
} from "./candidate.js";
import { History, type FileChange, type HistoryEntry } from "./history.js";
import { classify, cluster, type FailureCluster, type RunContext } from "./taxonomy.js";

export interface CollectedRun {
  record: RunRecord;
  ctx: RunContext;
  /** False for anything the retrospective must not see (holdout benchmark issues). */
  visible: boolean;
}

export interface EvaluateArgs {
  playbooksDir: string;
  repeatIndex: number;
}

export interface Promotion {
  candidateId: string;
  title: string;
  body: string;
  changes: FileChange[];
}

export interface Promoter {
  promote(p: Promotion): Promise<string>;
}

export interface ImproveDeps {
  runner: AgentRunner;
  retro: StageConfig;
  playbooksDir: string;
  history: History;
  promoter: Promoter;
  maxUsd: number;
  /** Gathers labeled runs (e.g. a train-split benchmark run). Charged to the budget via its returned cost. */
  collect: (budget: Budget) => Promise<CollectedRun[]>;
  /** One holdout evaluation of a playbook directory. */
  evaluate: (args: EvaluateArgs) => Promise<EvalScores>;
  repeat?: number;
  /** Measured noise band; default: spread of the champion's runs, or 0.05 with a single run. */
  noiseBand?: number;
  /** Cached champion scores for the current playbooks (skips re-evaluating the champion). */
  championScores?: EvalScores[];
  fileSelfIssue?: (title: string, body: string) => Promise<void>;
  log?: (m: string) => void;
  /** Live retrospective activity for the control UI. */
  onActivity?: (a: AgentActivity) => void;
}

export interface CandidateReport {
  candidateId: string;
  hypothesis: string;
  decision: HistoryEntry["decision"] | "superseded";
  gate?: GateDecision;
  prUrl?: string;
}

export interface ImproveReport {
  clusters: FailureCluster[];
  candidates: CandidateReport[];
  selfIssues: number;
  spentUsd: number;
}

async function readPlaybooks(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of (await readdir(dir)).filter((x) => x.endsWith(".md") || x === "stages.json")) {
    out[`playbooks/${f}`] = await readFile(join(dir, f), "utf8");
  }
  return out;
}

/** The candidate as concrete file changes inside playbooks/ (stage settings land in playbooks/stages.json). */
export async function candidateChanges(c: CandidateProposal, playbooksDir: string): Promise<FileChange[]> {
  const current = await readPlaybooks(playbooksDir);
  const changes: FileChange[] = c.playbookChanges.map((p) => ({
    file: p.file,
    before: current[p.file] ?? null,
    after: p.content.endsWith("\n") ? p.content : p.content + "\n",
  }));
  if (c.stageSettings?.length) {
    const before = current["playbooks/stages.json"] ?? null;
    const overrides: StageOverrides = before ? JSON.parse(before) : {};
    for (const s of c.stageSettings as StageSettingChange[]) {
      const { stage, ...rest } = s;
      overrides[stage] = { ...overrides[stage], ...rest };
    }
    changes.push({ file: "playbooks/stages.json", before, after: JSON.stringify(overrides, null, 2) + "\n" });
  }
  return changes.filter((ch) => ch.before !== ch.after);
}

async function materialize(playbooksDir: string, changes: FileChange[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "factory-candidate-"));
  await cp(playbooksDir, dir, { recursive: true });
  for (const ch of changes) {
    const path = join(dir, ch.file.replace(/^playbooks\//, ""));
    if (ch.after === null) await rm(path, { force: true });
    else await writeFile(path, ch.after);
  }
  return dir;
}

export async function improve(deps: ImproveDeps): Promise<ImproveReport> {
  const log = deps.log ?? (() => undefined);
  const budget = new Budget(deps.maxUsd);
  const repeat = deps.repeat ?? 3;
  const report: ImproveReport = { clusters: [], candidates: [], selfIssues: 0, spentUsd: 0 };
  const parentHash = await playbookHash(deps.playbooksDir);

  // 1–2. Collect and classify. Only visible (train-split / real) runs reach the retrospective (R6.2).
  const runs = (await deps.collect(budget)).filter((r) => r.visible);
  const classified = runs.map((r) => ({ record: r.record, codes: classify(r.record, r.ctx) }));
  report.clusters = cluster(classified.filter((c) => c.codes.length > 0));
  if (report.clusters.length === 0) {
    log("No failures to learn from.");
    report.spentUsd = budget.spent;
    return report;
  }

  // 3. Retrospective.
  if (budget.exhausted) {
    report.spentUsd = budget.spent;
    return report;
  }
  const workDir = await mkdtemp(join(tmpdir(), "factory-retro-"));
  let retro: RetroOutput;
  try {
    const r = await deps.runner.run({
      stage: "retro",
      issue: 0,
      attempt: 1,
      playbook: (await readPlaybooks(deps.playbooksDir))["playbooks/retro.md"] ?? "# retro",
      input: {
        failureClusters: report.clusters,
        playbooks: await readPlaybooks(deps.playbooksDir),
        mutableSurface: "playbooks/*.md and stage settings (model, effort, maxTurns) only",
      },
      outputSchema: RetroOutput,
      cwd: workDir,
      tools: [],
      provider: deps.retro.provider,
      model: deps.retro.model,
      effort: deps.retro.effort,
      maxBudgetUsd: budget.remaining,
      onActivity: deps.onActivity,
    });
    budget.charge(r.costUsd);
    retro = r.output;
    log(`Retrospective proposed ${retro.candidates.length} candidate(s)`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  for (const issue of retro.selfIssues.slice(0, 3)) {
    await deps.fileSelfIssue?.(issue.title, issue.body);
    report.selfIssues++;
  }

  // 4. Champion baseline on holdout.
  const champion = deps.championScores ? [...deps.championScores] : [];
  let lastEvalCost = 0;
  const runEval = async (dir: string, i: number) => {
    const s = await deps.evaluate({ playbooksDir: dir, repeatIndex: i });
    budget.charge(s.costUsd);
    lastEvalCost = s.costUsd;
    return s;
  };
  const canAffordEval = () => budget.remaining > 0 && budget.remaining >= lastEvalCost;
  while (champion.length < repeat && canAffordEval())
    champion.push(await runEval(deps.playbooksDir, champion.length));
  const band = deps.noiseBand ?? (champion.length > 1 ? spread(champion.map((c) => c.resolveRate)) : 0.05);

  // 5. Evaluate each candidate and gate it.
  const accepted: { report: CandidateReport; entry: HistoryEntry; changes: FileChange[] }[] = [];
  for (const proposal of retro.candidates) {
    const candidateId = newId("cand-");
    const base = {
      candidateId,
      at: new Date().toISOString(),
      parentHash,
      hypothesis: proposal.hypothesis,
      targets: proposal.targets,
      noiseBand: band,
    };
    const bounds = checkBounds(proposal);
    if (!bounds.ok) {
      await deps.history.append({
        ...base,
        patch: [],
        stageSettings: [],
        scores: { champion, candidate: [] },
        decision: "out-of-bounds",
        accepted: false,
      });
      report.candidates.push({ candidateId, hypothesis: proposal.hypothesis, decision: "out-of-bounds" });
      continue;
    }
    const changes = await candidateChanges(proposal, deps.playbooksDir);
    const stageSettings = (proposal.stageSettings ?? []).map((change) => ({ change, before: {} }));
    const scores: EvalScores[] = [];
    const dir = await materialize(deps.playbooksDir, changes);
    try {
      while (scores.length < repeat && canAffordEval()) scores.push(await runEval(dir, scores.length));
    } catch (e) {
      log(`candidate ${candidateId}: evaluation failed: ${(e as Error).message}`);
      await deps.history.append({
        ...base,
        patch: changes,
        stageSettings,
        scores: { champion, candidate: scores },
        decision: "evaluation-failed",
        accepted: false,
      });
      report.candidates.push({ candidateId, hypothesis: proposal.hypothesis, decision: "evaluation-failed" });
      continue;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    if (scores.length < repeat || champion.length < repeat) {
      await deps.history.append({
        ...base,
        patch: changes,
        stageSettings,
        scores: { champion, candidate: scores },
        decision: "not-evaluated: budget",
        accepted: false,
      });
      report.candidates.push({
        candidateId,
        hypothesis: proposal.hypothesis,
        decision: "not-evaluated: budget",
      });
      continue;
    }
    const decision = gate(champion, scores, band);
    const entry: HistoryEntry = {
      ...base,
      patch: changes,
      stageSettings,
      scores: { champion, candidate: scores },
      decision: decision.reason,
      accepted: decision.accepted,
    };
    const rep: CandidateReport = {
      candidateId,
      hypothesis: proposal.hypothesis,
      decision: decision.reason,
      gate: decision,
    };
    report.candidates.push(rep);
    if (decision.accepted) accepted.push({ report: rep, entry, changes });
    else await deps.history.append(entry);
  }

  // 6. Promote the best accepted candidate as a PR; a human merges it (R6.5).
  accepted.sort((a, b) => b.report.gate!.candidate.resolveRate - a.report.gate!.candidate.resolveRate);
  for (const [i, a] of accepted.entries()) {
    if (i === 0) {
      a.entry.prUrl = await deps.promoter.promote({
        candidateId: a.entry.candidateId,
        title: `Factory self-improvement: ${a.entry.hypothesis.slice(0, 80)}`,
        body: promotionBody(a.entry, a.report.gate!),
        changes: a.changes,
      });
      a.report.prUrl = a.entry.prUrl;
    } else {
      a.report.decision = "superseded";
    }
    await deps.history.append(a.entry);
  }
  report.spentUsd = budget.spent;
  return report;
}

export function promotionBody(entry: HistoryEntry, decision: GateDecision): string {
  return [
    `## Hypothesis`,
    entry.hypothesis,
    "",
    `Targets: ${entry.targets.map((t) => `\`${t}\``).join(", ") || "n/a"}`,
    "",
    "## Holdout evaluation",
    scoreTable(decision, entry.noiseBand),
    "",
    "## Changed files",
    ...entry.patch.map((p) => `- \`${p.file}\``),
    "",
    "---",
    `🏭 Candidate \`${entry.candidateId}\` (parent playbooks \`${entry.parentHash}\`). Revert with \`factory improve --revert ${entry.candidateId}\`.`,
  ].join("\n");
}

/** R6.7: open a PR that exactly inverts an accepted candidate. */
export async function revertCandidate(
  candidateId: string,
  history: History,
  promoter: Promoter,
): Promise<string> {
  const entry = await history.find(candidateId);
  if (!entry) throw new Error(`No candidate ${candidateId} in ${history.file}`);
  if (!entry.accepted)
    throw new Error(`Candidate ${candidateId} was not accepted (${entry.decision}); nothing to revert`);
  const changes = entry.patch.map((p) => ({ file: p.file, before: p.after, after: p.before }));
  const revertId = newId("revert-");
  const url = await promoter.promote({
    candidateId: revertId,
    title: `Revert factory self-improvement ${candidateId}`,
    body: `Reverts candidate \`${candidateId}\`:\n\n> ${entry.hypothesis}\n\n${changes.map((c) => `- \`${c.file}\``).join("\n")}`,
    changes,
  });
  await history.append({
    ...entry,
    candidateId: revertId,
    at: new Date().toISOString(),
    hypothesis: `Revert ${candidateId}`,
    patch: changes,
    decision: "accepted",
    accepted: true,
    prUrl: url,
    revertOf: candidateId,
  });
  return url;
}
