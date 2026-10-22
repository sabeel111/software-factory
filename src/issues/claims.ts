// Comment-ordered claim protocol (specs/04-intake-and-claims.md "Claim protocol").
// Labels are not compare-and-swap, so ownership is decided by the lowest-id live claim comment.
import type { IssueRef } from "../contracts/index.js";
import {
  ClaimLost,
  LABELS,
  type BackendComment,
  type BackendIssue,
  type ClaimResult,
  type IssueBackend,
  type IssueSource,
  type ReleaseOutcome,
} from "./types.js";

const CLAIM_RE = /<!-- factory-claim run=(\S+) lease=(\S+) -->/;
const RELEASED_RE = /<!-- factory-claim-released run=(\S+) -->/;

export interface ClaimComment {
  id: number;
  runId: string;
  leaseUntil: number;
}

export function claimBody(runId: string, leaseUntil: number): string {
  return `<!-- factory-claim run=${runId} lease=${new Date(leaseUntil).toISOString()} -->\n🏭 Software factory run \`${runId}\` is working on this issue.`;
}

export function parseClaim(c: BackendComment): ClaimComment | null {
  const m = CLAIM_RE.exec(c.body);
  if (!m) return null;
  return { id: c.id, runId: m[1]!, leaseUntil: Date.parse(m[2]!) };
}

export function isReleased(c: BackendComment): boolean {
  return RELEASED_RE.test(c.body);
}

/** The live claim with the lowest comment id, if any. */
export function currentHolder(comments: BackendComment[], now: number): ClaimComment | null {
  const live = comments
    .map(parseClaim)
    .filter((c): c is ClaimComment => c !== null && c.leaseUntil > now)
    .sort((a, b) => a.id - b.id);
  return live[0] ?? null;
}

function priority(labels: string[]): number {
  if (labels.includes("P0")) return 0;
  if (labels.includes("P1")) return 1;
  return 2;
}

export function orderIssues<T extends { labels: string[]; createdAt: string; number: number }>(
  issues: T[],
): T[] {
  return [...issues].sort(
    (a, b) =>
      priority(a.labels) - priority(b.labels) ||
      Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
      a.number - b.number,
  );
}

function toRef(i: BackendIssue): IssueRef {
  return { repo: i.repo, number: i.number, title: i.title, body: i.body, labels: i.labels };
}

export interface ClaimOptions {
  leaseMs?: number;
  now?: () => number;
}

export class ClaimingIssueSource implements IssueSource {
  readonly leaseMs: number;
  private readonly now: () => number;

  constructor(
    readonly backend: IssueBackend,
    opts: ClaimOptions = {},
  ) {
    this.leaseMs = opts.leaseMs ?? 15 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  async listReady(): Promise<IssueRef[]> {
    const open = await this.backend.listOpenIssues(LABELS.ready);
    const eligible: BackendIssue[] = [];
    for (const issue of open) {
      if (issue.state !== "open" || issue.labels.includes(LABELS.needsInfo)) continue;
      if (issue.labels.includes(LABELS.claimed)) {
        const holder = currentHolder(await this.backend.listComments(issue.number), this.now());
        if (holder) continue; // live lease: someone is working on it
      }
      eligible.push(issue);
    }
    return orderIssues(eligible).map(toRef);
  }

  async isEligible(issue: number): Promise<boolean> {
    const i = await this.backend.getIssue(issue);
    return (
      i.state === "open" &&
      i.labels.includes(LABELS.ready) &&
      !i.labels.includes(LABELS.needsInfo) &&
      !i.labels.includes(LABELS.failed)
    );
  }

  async claim(issue: number, runId: string): Promise<ClaimResult> {
    const mine = await this.backend.createComment(issue, claimBody(runId, this.now() + this.leaseMs));
    const comments = await this.backend.listComments(issue);
    const now = this.now();
    const holder = currentHolder(comments, now);
    if (!holder || holder.id !== mine.id) {
      await this.backend.deleteComment(mine.id);
      return { won: false, holder: holder?.runId };
    }
    const expired = comments
      .map(parseClaim)
      .filter(
        (c): c is ClaimComment => c !== null && c.id < mine.id && c.leaseUntil <= now && c.runId !== runId,
      );
    await this.backend.addLabels(issue, [LABELS.claimed]);
    if (expired.length > 0) {
      const prev = expired[expired.length - 1]!;
      await this.backend.createComment(
        issue,
        `🏭 Taking over from run \`${prev.runId}\`, whose claim expired at ${new Date(prev.leaseUntil).toISOString()}.`,
      );
    }
    return { won: true, holder: runId };
  }

  private async ownClaim(issue: number, runId: string): Promise<BackendComment | undefined> {
    const comments = await this.backend.listComments(issue);
    return comments.find((c) => parseClaim(c)?.runId === runId);
  }

  async heartbeat(issue: number, runId: string): Promise<void> {
    const comments = await this.backend.listComments(issue);
    const holder = currentHolder(comments, this.now());
    const mine = comments.find((c) => parseClaim(c)?.runId === runId);
    if (!mine || (holder && holder.runId !== runId)) {
      throw new ClaimLost(
        `Run ${runId} no longer holds issue #${issue}${holder ? ` (held by ${holder.runId})` : ""}`,
      );
    }
    await this.backend.updateComment(mine.id, claimBody(runId, this.now() + this.leaseMs));
  }

  async release(issue: number, runId: string, outcome: ReleaseOutcome): Promise<void> {
    // Labels first: once the claim comment stops being live, another run may claim the issue, and
    // it must already see the final labels (isEligible) — otherwise a finished issue runs twice.
    const labels = (await this.backend.getIssue(issue)).labels;
    const remove = async (label: string) => {
      if (labels.includes(label)) await this.backend.removeLabel(issue, label);
    };
    const add = async (label: string) => {
      if (!labels.includes(label)) await this.backend.addLabels(issue, [label]);
    };
    if (outcome === "needs-info") await add(LABELS.needsInfo);
    if (outcome === "failed") {
      await add(LABELS.failed);
      await remove(LABELS.ready);
    }
    if (outcome === "done") await remove(LABELS.ready);
    await remove(LABELS.claimed);

    const mine = await this.ownClaim(issue, runId);
    if (mine && !isReleased(mine)) {
      await this.backend.updateComment(
        mine.id,
        `<!-- factory-claim-released run=${runId} -->\n🏭 Software factory run \`${runId}\` finished: ${outcome}.`,
      );
    }
  }

  async comment(issue: number, body: string): Promise<void> {
    await this.backend.createComment(issue, body);
  }

  addLabels(issue: number, labels: string[]): Promise<void> {
    return this.backend.addLabels(issue, labels);
  }

  removeLabel(issue: number, label: string): Promise<void> {
    return this.backend.removeLabel(issue, label);
  }
}

export { ClaimLost };
