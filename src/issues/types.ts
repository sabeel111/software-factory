// Issue intake abstractions (specs/04-intake-and-claims.md).
import type { IssueRef } from "../contracts/index.js";

export const LABELS = {
  ready: "factory:ready",
  claimed: "factory:claimed",
  needsInfo: "factory:needs-info",
  failed: "factory:failed",
  pr: "factory:pr",
  self: "factory:self",
} as const;

export type ReleaseOutcome = "done" | "needs-info" | "failed" | "abandoned";

export interface ClaimResult {
  won: boolean;
  /** Run that holds the claim (the winner). */
  holder?: string;
}

export interface IssueSource {
  listReady(): Promise<IssueRef[]>;
  claim(issue: number, runId: string): Promise<ClaimResult>;
  /** Extends the lease; throws ClaimLost if another run now holds the issue. */
  heartbeat(issue: number, runId: string): Promise<void>;
  release(issue: number, runId: string, outcome: ReleaseOutcome): Promise<void>;
  comment(issue: number, body: string): Promise<void>;
  addLabels(issue: number, labels: string[]): Promise<void>;
  removeLabel(issue: number, label: string): Promise<void>;
}

/** Raw issue as stored by a tracker backend. */
export interface BackendIssue extends IssueRef {
  state: "open" | "closed";
  createdAt: string;
}

export interface BackendComment {
  id: number;
  body: string;
  createdAt: string;
}

/** The minimal tracker operations the claim protocol is built on. */
export interface IssueBackend {
  readonly repo: string;
  listOpenIssues(label: string): Promise<BackendIssue[]>;
  getIssue(issue: number): Promise<BackendIssue>;
  listComments(issue: number): Promise<BackendComment[]>;
  createComment(issue: number, body: string): Promise<BackendComment>;
  updateComment(commentId: number, body: string): Promise<void>;
  deleteComment(commentId: number): Promise<void>;
  addLabels(issue: number, labels: string[]): Promise<void>;
  removeLabel(issue: number, label: string): Promise<void>;
}

export class ClaimLost extends Error {
  override name = "ClaimLost";
}
