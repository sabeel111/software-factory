// In-memory tracker backend for tests and the benchmark (specs/04-intake-and-claims.md).
import type { BackendComment, BackendIssue, IssueBackend } from "./types.js";

export interface MemoryIssueInit {
  number: number;
  title?: string;
  body?: string;
  labels?: string[];
  state?: "open" | "closed";
  createdAt?: string;
}

export class MemoryBackend implements IssueBackend {
  private readonly issues = new Map<number, BackendIssue>();
  private readonly comments = new Map<number, BackendComment[]>();
  private nextCommentId = 1;
  /** Every mutating call, for assertions. */
  readonly log: { op: string; issue?: number; detail?: string }[] = [];

  constructor(
    readonly repo = "memory/repo",
    issues: MemoryIssueInit[] = [],
  ) {
    for (const i of issues) this.addIssue(i);
  }

  addIssue(i: MemoryIssueInit): void {
    this.issues.set(i.number, {
      repo: this.repo,
      number: i.number,
      title: i.title ?? `Issue ${i.number}`,
      body: i.body ?? "",
      labels: [...(i.labels ?? [])],
      state: i.state ?? "open",
      createdAt: i.createdAt ?? new Date(Date.UTC(2026, 0, 1) + i.number * 1000).toISOString(),
    });
  }

  private issue(n: number): BackendIssue {
    const i = this.issues.get(n);
    if (!i) throw new Error(`No issue #${n}`);
    return i;
  }

  async listOpenIssues(label: string): Promise<BackendIssue[]> {
    return [...this.issues.values()]
      .filter((i) => i.state === "open" && i.labels.includes(label))
      .map((i) => ({ ...i, labels: [...i.labels] }));
  }

  async getIssue(n: number): Promise<BackendIssue> {
    const i = this.issue(n);
    return { ...i, labels: [...i.labels] };
  }

  async listComments(n: number): Promise<BackendComment[]> {
    this.issue(n);
    return (this.comments.get(n) ?? []).map((c) => ({ ...c }));
  }

  async createComment(n: number, body: string): Promise<BackendComment> {
    this.issue(n);
    const c = { id: this.nextCommentId++, body, createdAt: new Date().toISOString() };
    this.comments.set(n, [...(this.comments.get(n) ?? []), c]);
    this.log.push({ op: "createComment", issue: n, detail: body });
    return { ...c };
  }

  async updateComment(id: number, body: string): Promise<void> {
    for (const list of this.comments.values()) {
      const c = list.find((x) => x.id === id);
      if (c) {
        c.body = body;
        this.log.push({ op: "updateComment", detail: body });
        return;
      }
    }
    throw new Error(`No comment ${id}`);
  }

  async deleteComment(id: number): Promise<void> {
    for (const [n, list] of this.comments) {
      if (list.some((c) => c.id === id)) {
        this.comments.set(
          n,
          list.filter((c) => c.id !== id),
        );
        this.log.push({ op: "deleteComment", issue: n });
        return;
      }
    }
  }

  async addLabels(n: number, labels: string[]): Promise<void> {
    const i = this.issue(n);
    for (const l of labels) if (!i.labels.includes(l)) i.labels.push(l);
    this.log.push({ op: "addLabels", issue: n, detail: labels.join(",") });
  }

  async removeLabel(n: number, label: string): Promise<void> {
    const i = this.issue(n);
    i.labels = i.labels.filter((l) => l !== label);
    this.log.push({ op: "removeLabel", issue: n, detail: label });
  }

  /** Test helper: a comment's raw body list. */
  commentBodies(n: number): string[] {
    return (this.comments.get(n) ?? []).map((c) => c.body);
  }
}
