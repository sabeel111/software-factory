// A real OpenAI-compatible provider against the benchmark. Costs money: opt in with FACTORY_E2E=1,
// OPENROUTER_API_KEY or OPENAI_API_KEY, and FACTORY_E2E_OPENAI_MODEL (a model id on that provider).
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRunner } from "../src/agents/routing.js";
import { loadIssues, prepareBenchRepo, toIssueRef } from "../src/bench/benchmark.js";
import { benchConfig } from "../src/bench/run-factory.js";
import { scoreCandidate } from "../src/bench/score.js";
import { ClaimingIssueSource } from "../src/issues/claims.js";
import { MemoryBackend } from "../src/issues/memory.js";
import { runIssue } from "../src/pipeline/issue-pipeline.js";
import { DirPlaybooks } from "../src/pipeline/playbooks.js";
import { MemoryPrSink } from "../src/pipeline/pr.js";
import { WorktreeProvider } from "../src/sandbox/worktree.js";
import { RunStore } from "../src/store/run-store.js";

const model = process.env.FACTORY_E2E_OPENAI_MODEL;
const providerName = process.env.OPENROUTER_API_KEY
  ? "openrouter"
  : process.env.OPENAI_API_KEY
    ? "openai"
    : undefined;
const enabled = process.env.FACTORY_E2E === "1" && Boolean(model && providerName);

describe.skipIf(!enabled)("factory on an OpenAI-compatible provider", () => {
  it("T9.8 benchmark issue 1 with every stage on the provider yields a branch whose hidden test passes", async () => {
    const stage = (effort: "low" | "medium" | "high") => ({ provider: providerName!, model: model!, effort });
    const config = benchConfig({
      prMode: "individual",
      // OpenRouter reports cost; for OpenAI we don't hardcode prices, so the run is unpriced.
      providers: providerName === "openai" ? { openai: { allowUnpriced: true } } : {},
      stages: {
        triage: stage("low"),
        worker: stage("high"),
        reviewer: stage("medium"),
        integrator: stage("high"),
        retro: stage("high"),
      },
    });
    const bench = await prepareBenchRepo(await mkdtemp(join(tmpdir(), "e2e-oai-bench-")));
    const provider = new WorktreeProvider({
      root: await mkdtemp(join(tmpdir(), "e2e-oai-sbx-")),
      secretPaths: config.secretPaths,
    });
    const snapshot = await provider.prepareSnapshot({ repoUrl: bench.dir, ref: "main", setup: [] });
    const issues = await loadIssues();
    const issue = issues.find((i) => i.number === 1)!;
    const r = await runIssue(toIssueRef(issue), "e2e-t98", {
      config,
      runner: createRunner(config),
      issues: new ClaimingIssueSource(
        new MemoryBackend(
          "bench/tinylinks",
          issues.map((i) => ({ ...i })),
        ),
      ),
      prs: new MemoryPrSink(),
      provider,
      snapshot,
      baseCommit: bench.baseCommit,
      store: new RunStore(await mkdtemp(join(tmpdir(), "e2e-oai-runs-"))),
      playbooks: new DirPlaybooks(),
      batchId: "e2e-oai",
      factoryVersion: "e2e",
      playbookHash: "e2e",
    });
    expect(r.outcome).toBe("pr_opened");
    const score = await scoreCandidate({ repo: bench.dir, candidateRef: r.record.branch!, issues: [issue] });
    expect(score.perIssue[0]!.passed).toBe(true);
  });
});
