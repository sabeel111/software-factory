// GitHub REST adapter (specs/04-intake-and-claims.md R3.5, R3.7) plus pull-request operations.
import type { BackendComment, BackendIssue, IssueBackend } from "./types.js";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class GitHubError extends Error {
  override name = "GitHubError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface GitHubClientOptions {
  token: string;
  repo: string;
  apiUrl?: string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  /** Called after every external write (for the audit log). */
  onWrite?: (event: { method: string; path: string; status: number }) => void;
}

interface RawIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  created_at: string;
  labels: ({ name: string } | string)[];
  pull_request?: unknown;
}

interface RawComment {
  id: number;
  body: string;
  created_at: string;
}

export interface PullRequest {
  number: number;
  url: string;
  head: string;
  draft: boolean;
}

export class GitHubClient implements IssueBackend {
  readonly repo: string;
  private readonly api: string;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(private readonly opts: GitHubClientOptions) {
    this.repo = opts.repo;
    this.api = (opts.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = opts.maxRetries ?? 4;
  }

  private static retryable(status: number, body: string): boolean {
    if (status >= 500 || status === 429) return true;
    return status === 403 && /secondary rate limit|abuse/i.test(body);
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<{ data: T; headers: Headers }> {
    const url = path.startsWith("http") ? path : `${this.api}${path}`;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.opts.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "software-factory",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      if (res.ok) {
        if (method !== "GET") this.opts.onWrite?.({ method, path, status: res.status });
        return { data: (text ? JSON.parse(text) : null) as T, headers: res.headers };
      }
      if (attempt < this.maxRetries && GitHubClient.retryable(res.status, text)) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await this.sleep(
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt,
        );
        continue;
      }
      throw new GitHubError(`GitHub ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`, res.status);
    }
  }

  private async paginate<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    while (next) {
      const page: { data: T[]; headers: Headers } = await this.request<T[]>("GET", next);
      out.push(...page.data);
      const link: string = page.headers.get("link") ?? "";
      next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] ?? null;
    }
    return out;
  }

  private toIssue(raw: RawIssue): BackendIssue {
    return {
      repo: this.repo,
      number: raw.number,
      title: raw.title,
      body: raw.body ?? "",
      state: raw.state,
      createdAt: raw.created_at,
      labels: raw.labels.map((l) => (typeof l === "string" ? l : l.name)),
    };
  }

  /** R3.7: fail fast with a clear message if the token can't write issues and PRs. */
  async checkAccess(): Promise<void> {
    let repo: { permissions?: { push?: boolean; triage?: boolean } };
    try {
      repo = (await this.request<typeof repo>("GET", `/repos/${this.repo}`)).data;
    } catch (e) {
      const status = (e as GitHubError).status;
      throw new GitHubError(
        status === 401
          ? "GitHub token is invalid or expired (401). Set GITHUB_TOKEN to a token with issues:write and pull_requests:write."
          : `Cannot access ${this.repo} (${status}). The token needs issues:write and pull_requests:write on this repo.`,
        status,
      );
    }
    if (repo.permissions && !repo.permissions.push) {
      throw new GitHubError(
        `Token lacks write access to ${this.repo}. It needs issues:write and pull_requests:write.`,
        403,
      );
    }
  }

  async listOpenIssues(label: string): Promise<BackendIssue[]> {
    const raw = await this.paginate<RawIssue>(
      `/repos/${this.repo}/issues?state=open&labels=${encodeURIComponent(label)}`,
    );
    return raw.filter((i) => !i.pull_request).map((i) => this.toIssue(i));
  }

  async getIssue(issue: number): Promise<BackendIssue> {
    return this.toIssue((await this.request<RawIssue>("GET", `/repos/${this.repo}/issues/${issue}`)).data);
  }

  async listComments(issue: number): Promise<BackendComment[]> {
    const raw = await this.paginate<RawComment>(`/repos/${this.repo}/issues/${issue}/comments`);
    return raw.map((c) => ({ id: c.id, body: c.body, createdAt: c.created_at }));
  }

  async createComment(issue: number, body: string): Promise<BackendComment> {
    const { data } = await this.request<RawComment>("POST", `/repos/${this.repo}/issues/${issue}/comments`, {
      body,
    });
    return { id: data.id, body: data.body, createdAt: data.created_at };
  }

  async updateComment(commentId: number, body: string): Promise<void> {
    await this.request("PATCH", `/repos/${this.repo}/issues/comments/${commentId}`, { body });
  }

  async deleteComment(commentId: number): Promise<void> {
    try {
      await this.request("DELETE", `/repos/${this.repo}/issues/comments/${commentId}`);
    } catch (e) {
      if ((e as GitHubError).status !== 404) throw e;
    }
  }

  async addLabels(issue: number, labels: string[]): Promise<void> {
    await this.request("POST", `/repos/${this.repo}/issues/${issue}/labels`, { labels });
  }

  async removeLabel(issue: number, label: string): Promise<void> {
    try {
      await this.request("DELETE", `/repos/${this.repo}/issues/${issue}/labels/${encodeURIComponent(label)}`);
    } catch (e) {
      if ((e as GitHubError).status !== 404) throw e;
    }
  }

  async createIssue(issue: {
    title: string;
    body: string;
    labels: string[];
  }): Promise<{ number: number; url: string }> {
    const { data } = await this.request<{ number: number; html_url: string }>(
      "POST",
      `/repos/${this.repo}/issues`,
      issue,
    );
    return { number: data.number, url: data.html_url };
  }

  async createPullRequest(pr: {
    head: string;
    base: string;
    title: string;
    body: string;
    draft: boolean;
  }): Promise<PullRequest> {
    const { data } = await this.request<{ number: number; html_url: string; draft: boolean }>(
      "POST",
      `/repos/${this.repo}/pulls`,
      pr,
    );
    return { number: data.number, url: data.html_url, head: pr.head, draft: data.draft };
  }

  async listOpenPullRequests(label: string): Promise<PullRequest[]> {
    const raw = await this.paginate<RawIssue & { html_url: string }>(
      `/repos/${this.repo}/issues?state=open&labels=${encodeURIComponent(label)}`,
    );
    return raw
      .filter((i) => i.pull_request)
      .map((i) => ({ number: i.number, url: i.html_url, head: "", draft: true }));
  }
}
