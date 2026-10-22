// Draft pull requests (specs/05-single-issue-pipeline.md "PR").
import type { IssueRef, ReviewResult, TriageResult, VerifierResult } from "../contracts/index.js";
import type { GitHubClient } from "../issues/github.js";
import { LABELS } from "../issues/types.js";

export interface OpenedPr {
  number: number;
  url: string;
}

export interface PrSink {
  createDraft(pr: { head: string; base: string; title: string; body: string }): Promise<OpenedPr>;
  countOpenFactoryPrs(): Promise<number>;
  label(prNumber: number, labels: string[]): Promise<void>;
}

export class GitHubPrSink implements PrSink {
  constructor(private readonly gh: GitHubClient) {}

  async createDraft(pr: { head: string; base: string; title: string; body: string }): Promise<OpenedPr> {
    const opened = await this.gh.createPullRequest({ ...pr, draft: true });
    return { number: opened.number, url: opened.url };
  }

  async countOpenFactoryPrs(): Promise<number> {
    return (await this.gh.listOpenPullRequests(LABELS.pr)).length;
  }

  label(prNumber: number, labels: string[]): Promise<void> {
    return this.gh.addLabels(prNumber, labels);
  }
}

export class MemoryPrSink implements PrSink {
  readonly prs: (OpenedPr & { head: string; base: string; title: string; body: string; labels: string[] })[] =
    [];
  constructor(private openFactoryPrs = 0) {}

  async createDraft(pr: { head: string; base: string; title: string; body: string }): Promise<OpenedPr> {
    const opened = { number: 1000 + this.prs.length, url: `memory://pr/${1000 + this.prs.length}` };
    this.prs.push({ ...opened, ...pr, labels: [] });
    this.openFactoryPrs++;
    return opened;
  }

  async countOpenFactoryPrs(): Promise<number> {
    return this.openFactoryPrs;
  }

  async label(prNumber: number, labels: string[]): Promise<void> {
    this.prs.find((p) => p.number === prNumber)?.labels.push(...labels);
  }
}

/** No code host configured: the branch is the deliverable; print it instead of opening a PR. */
export class LocalBranchPrSink implements PrSink {
  async createDraft(pr: { head: string; base: string; title: string; body: string }): Promise<OpenedPr> {
    return { number: 0, url: `branch ${pr.head} (open a PR into ${pr.base} to review it)` };
  }
  async countOpenFactoryPrs(): Promise<number> {
    return 0;
  }
  async label(): Promise<void> {}
}

export function checkTable(v: VerifierResult): string {
  const rows = v.checks.map(
    (c) =>
      `| ${c.name} | \`${c.command}\` | ${c.exitCode === 0 ? "✅" : "❌"} ${c.exitCode} | ${(c.durationMs / 1000).toFixed(1)}s |`,
  );
  const tests = v.testSummary
    ? `\n\nTests: ${v.testSummary.passed} passed, ${v.testSummary.failed} failed, ${v.testSummary.skipped} skipped`
    : "";
  return `| Check | Command | Result | Time |\n|---|---|---|---|\n${rows.join("\n")}${tests}`;
}

export function issuePrBody(args: {
  issue: IssueRef;
  triage: TriageResult;
  verification: VerifierResult;
  review: ReviewResult;
  costUsd: number;
  runId: string;
}): string {
  const findings = args.review.findings.length
    ? args.review.findings
        .map((f) => `- **${f.severity}** \`${f.file}${f.line ? `:${f.line}` : ""}\` — ${f.message}`)
        .join("\n")
    : "_No findings._";
  return [
    `Closes #${args.issue.number}`,
    "",
    "## Acceptance criteria",
    ...args.triage.acceptanceCriteria.map((c) => `- [ ] ${c}`),
    "",
    "## Verification (independent, clean checkout)",
    checkTable(args.verification),
    "",
    `## Review: ${args.review.verdict === "approve" ? "approved" : "changes requested"}`,
    findings,
    "",
    "---",
    `🏭 Software factory run \`${args.runId}\` · cost $${args.costUsd.toFixed(2)} · draft for human review — the factory never merges.`,
  ].join("\n");
}
