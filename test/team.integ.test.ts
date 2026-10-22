import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAgentRunner } from "../src/agents/fake-runner.js";
import { parseConfig } from "../src/config.js";
import type { RunRecord } from "../src/contracts/index.js";
import { createDashboard, renderBatch, ROUTES } from "../src/dashboard/server.js";
import { ClaimingIssueSource } from "../src/issues/claims.js";
import { GitHubClient } from "../src/issues/github.js";
import { MemoryBackend } from "../src/issues/memory.js";
import { LABELS } from "../src/issues/types.js";
import { runBatch, runRepos, type BatchDeps } from "../src/orchestrator/batch.js";
import { GitHubPrSink, MemoryPrSink } from "../src/pipeline/pr.js";
import { StaticPlaybooks } from "../src/pipeline/playbooks.js";
import { AuditLog } from "../src/store/audit.js";
import { RunStore } from "../src/store/run-store.js";
import { FakeSandboxProvider } from "./helpers/fake-sandbox.js";
import { fakeGitHub } from "./helpers/fake-github.js";
import { accept, approve, reject, workerDone } from "./helpers/scripts.js";

function scriptedRunner(delayMs = 0) {
  return new FakeAgentRunner()
    .script("triage", "*", "*", { output: accept(), delayMs, costUsd: 0.1 })
    .script("worker", "*", "*", { output: workerDone(), delayMs, costUsd: 0.1 })
    .script("reviewer", "*", "*", { output: approve, delayMs, costUsd: 0.1 });
}

async function batchFor(repo: string, overrides: Partial<BatchDeps> = {}): Promise<BatchDeps> {
  const backend = new MemoryBackend(
    repo,
    Array.from({ length: 5 }, (_, i) => ({ number: i + 1, labels: [LABELS.ready] })),
  );
  return {
    config: parseConfig({ repo, prMode: "individual", limits: { maxOpenPrs: 100 } }),
    runner: scriptedRunner(15),
    issues: new ClaimingIssueSource(backend),
    prs: new MemoryPrSink(),
    provider: new FakeSandboxProvider(),
    snapshot: "s",
    baseCommit: "base000",
    store: new RunStore(await mkdtemp(join(tmpdir(), "team-runs-"))),
    playbooks: new StaticPlaybooks(),
    batchId: `b-${repo.replace("/", "-")}`,
    factoryVersion: "v",
    playbookHash: "h",
    ...overrides,
  };
}

describe("team readiness", () => {
  it("T7.5 global concurrency is shared across repos", async () => {
    let active = 0;
    let max = 0;
    const track = (delta: number) => {
      active += delta;
      max = Math.max(max, active);
    };
    const mk = async (repo: string) => {
      let last = 0;
      return batchFor(repo, {
        onActive: (a) => {
          track(a - last);
          last = a;
        },
      });
    };
    const results = await runRepos([await mk("o/a"), await mk("o/b")], {
      concurrency: 4,
      maxCostUsdPerRun: 100,
    });
    expect(max).toBe(4);
    expect(results.flatMap((r) => r.results)).toHaveLength(10);
  });

  it("T7.6 every GitHub write in a batch has exactly one audit line", async () => {
    const gh = fakeGitHub("acme/app", [
      { number: 1, title: "Fix it", labels: [LABELS.ready] },
      { number: 2, title: "Make it better", labels: [LABELS.ready] },
      { number: 3, title: "Add it", labels: [LABELS.ready] },
    ]);
    const auditFile = join(await mkdtemp(join(tmpdir(), "audit-")), "audit.jsonl");
    const audit = new AuditLog(auditFile);
    const pending: Promise<void>[] = [];
    const client = new GitHubClient({
      token: "t",
      repo: "acme/app",
      fetch: gh.fetch,
      onWrite: (e) => void pending.push(audit.record({ batchId: "b", actor: "factory", ...e })),
    });
    const runner = scriptedRunner().script("triage", 2, 1, { output: reject() });
    await runBatch(
      await batchFor("acme/app", {
        issues: new ClaimingIssueSource(client),
        prs: new GitHubPrSink(client),
        runner,
      }),
    );
    await Promise.all(pending);
    const lines = (await readFile(auditFile, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(gh.writes.length).toBeGreaterThan(10);
    expect(lines.map((l) => `${l.method} ${l.path}`).sort()).toEqual(
      gh.writes.map((w) => `${w.method} ${w.path}`).sort(),
    );
    // And the batch really happened: two PRs and one needs-info.
    expect(gh.writes.filter((w) => w.path.endsWith("/pulls"))).toHaveLength(2);
    expect(gh.store.get(2)!.labels.map((l) => l.name)).toContain(LABELS.needsInfo);
  });

  it("T7.7 the dashboard renders a batch and exposes no write routes", async () => {
    const t = new Date(Date.UTC(2026, 0, 1)).toISOString();
    const rec: RunRecord = {
      runId: "r1",
      batchId: "b1",
      issue: { repo: "o/r", number: 7, title: "Link <expiry>", body: "", labels: [] },
      startedAt: t,
      finishedAt: t,
      factoryVersion: "v",
      playbookHash: "h",
      outcome: "pr_opened",
      prUrl: "https://github.com/o/r/pull/9",
      stages: [
        {
          stage: "triage",
          attempt: 1,
          startedAt: t,
          durationMs: 2000,
          costUsd: 0.05,
          tokens: { input: 1, output: 1 },
          output: null,
        },
        {
          stage: "worker",
          attempt: 1,
          startedAt: t,
          durationMs: 60000,
          costUsd: 0.8,
          tokens: { input: 1, output: 1 },
          output: null,
        },
      ],
    };
    const html = renderBatch("b1", [rec]);
    expect(html).toContain("Link &lt;expiry&gt;");
    expect(html).toContain("$0.85");
    expect(html).toContain('href="https://github.com/o/r/pull/9"');
    expect(ROUTES.every((r) => r.method === "GET")).toBe(true);

    const root = await mkdtemp(join(tmpdir(), "dash-"));
    const store = new RunStore(join(root, "runs"));
    await store.append(rec);
    const server = createDashboard({
      store,
      benchResultsFile: join(root, "none.jsonl"),
      historyFile: join(root, "none.jsonl"),
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    try {
      const home = await fetch(`http://127.0.0.1:${port}/`);
      expect(home.status).toBe(200);
      expect(await home.text()).toContain("b1");
      expect((await fetch(`http://127.0.0.1:${port}/batch/b1`)).status).toBe(200);
      for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
        expect((await fetch(`http://127.0.0.1:${port}/api/batches`, { method })).status).toBe(405);
      }
    } finally {
      server.close();
    }
  });

  it.skip("T7.8 cloud sandbox provider passes T2.1–T2.3 against the real service (no cloud provider implemented yet)", () => {});
});
