import { describe, expect, it } from "vitest";
import { ClaimingIssueSource } from "../src/issues/claims.js";
import { GitHubClient, GitHubError } from "../src/issues/github.js";
import { fixtureFetch } from "./helpers/fixture-fetch.js";

const NOW = Date.parse("2026-01-01T00:00:05Z");

describe("GitHub adapter (recorded fixtures)", () => {
  it("T3.7 claim makes exactly POST comment, GET comments, then POST label (winner) or DELETE comment (loser)", async () => {
    const win = fixtureFetch("claim-winner");
    const winner = new ClaimingIssueSource(
      new GitHubClient({ token: "t", repo: "acme/app", fetch: win.fetch }),
      {
        now: () => NOW,
      },
    );
    expect(await winner.claim(7, "run-a")).toEqual({ won: true, holder: "run-a" });
    expect(win.calls.map((c) => c.method)).toEqual(["POST", "GET", "POST"]);
    expect(win.calls[2]!.path).toBe("/repos/acme/app/issues/7/labels");

    const lose = fixtureFetch("claim-loser");
    const loser = new ClaimingIssueSource(
      new GitHubClient({ token: "t", repo: "acme/app", fetch: lose.fetch }),
      {
        now: () => NOW,
      },
    );
    expect(await loser.claim(7, "run-b")).toEqual({ won: false, holder: "run-a" });
    expect(lose.calls.map((c) => c.method)).toEqual(["POST", "GET", "DELETE"]);
    expect(lose.calls[2]!.path).toBe("/repos/acme/app/issues/comments/9002");
  });

  it("T3.8 retries a 502 once then succeeds; does not retry a 404", async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => void sleeps.push(ms);
    const ok = fixtureFetch("retry-502");
    const client = new GitHubClient({ token: "t", repo: "acme/app", fetch: ok.fetch, sleep });
    const issue = await client.getIssue(7);
    expect(issue.labels).toEqual(["factory:ready"]);
    expect(ok.calls).toHaveLength(2);
    expect(sleeps).toHaveLength(1);

    const nf = fixtureFetch("no-retry-404");
    const c2 = new GitHubClient({ token: "t", repo: "acme/app", fetch: nf.fetch, sleep });
    await expect(c2.getIssue(404)).rejects.toMatchObject({ status: 404 });
    expect(nf.calls).toHaveLength(1);
  });

  it("checkAccess explains missing write permissions", async () => {
    const fetch = async () => new Response(JSON.stringify({ permissions: { push: false } }), { status: 200 });
    const client = new GitHubClient({ token: "t", repo: "acme/app", fetch });
    await expect(client.checkAccess()).rejects.toThrow(/issues:write and pull_requests:write/);
    const unauthorized = new GitHubClient({
      token: "t",
      repo: "acme/app",
      fetch: async () => new Response("{}", { status: 401 }),
    });
    await expect(unauthorized.checkAccess()).rejects.toBeInstanceOf(GitHubError);
  });
});
