// Opt-in: FACTORY_E2E=1 GITHUB_TOKEN=... FACTORY_E2E_REPO=owner/name FACTORY_E2E_ISSUE=<n>
import { describe, expect, it } from "vitest";
import { ClaimingIssueSource } from "../src/issues/claims.js";
import { GitHubClient } from "../src/issues/github.js";

const enabled = Boolean(
  process.env.FACTORY_E2E &&
  process.env.GITHUB_TOKEN &&
  process.env.FACTORY_E2E_REPO &&
  process.env.FACTORY_E2E_ISSUE,
);

describe("claims against a real GitHub repo", () => {
  it.skipIf(!enabled)("T3.10 two simultaneous claimers: exactly one proceeds", async () => {
    const issue = Number(process.env.FACTORY_E2E_ISSUE);
    const mk = () =>
      new ClaimingIssueSource(
        new GitHubClient({ token: process.env.GITHUB_TOKEN!, repo: process.env.FACTORY_E2E_REPO! }),
      );
    const [a, b] = [mk(), mk()];
    const results = await Promise.all([a.claim(issue, "e2e-a"), b.claim(issue, "e2e-b")]);
    expect(results.filter((r) => r.won)).toHaveLength(1);
    const winner = results[0]!.won ? "e2e-a" : "e2e-b";
    await (winner === "e2e-a" ? a : b).release(issue, winner, "abandoned");
  });
});
