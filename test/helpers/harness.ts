// Real pipeline wiring (worktree sandboxes, TinyLinks repo, memory tracker) with a scripted runner.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agents/fake-runner.js";
import { BENCH_ROOT, loadIssues, prepareBenchRepo, type PreparedBench } from "../../src/bench/benchmark.js";
import { parseConfig, type FactoryConfigInput } from "../../src/config.js";
import { ClaimingIssueSource } from "../../src/issues/claims.js";
import { MemoryBackend } from "../../src/issues/memory.js";
import type { PipelineDeps } from "../../src/pipeline/issue-pipeline.js";
import { MemoryPrSink } from "../../src/pipeline/pr.js";
import { StaticPlaybooks } from "../../src/pipeline/playbooks.js";
import { WorktreeProvider } from "../../src/sandbox/worktree.js";
import { RunStore } from "../../src/store/run-store.js";

export interface Harness {
  bench: PreparedBench;
  backend: MemoryBackend;
  runner: FakeAgentRunner;
  prs: MemoryPrSink;
  store: RunStore;
  provider: WorktreeProvider;
  deps: PipelineDeps;
}

let shared: { bench: PreparedBench; provider: WorktreeProvider; snapshot: string } | undefined;

/** One bench repo + snapshot per test file; everything else is fresh per call. */
export async function harness(config: Partial<FactoryConfigInput> = {}): Promise<Harness> {
  if (!shared) {
    const bench = await prepareBenchRepo(await mkdtemp(join(tmpdir(), "h-bench-")));
    const provider = new WorktreeProvider({
      root: await mkdtemp(join(tmpdir(), "h-sbx-")),
      secretPaths: [join(BENCH_ROOT, "hidden")],
    });
    const snapshot = await provider.prepareSnapshot({ repoUrl: bench.dir, ref: "main", setup: [] });
    shared = { bench, provider, snapshot };
  }
  const issues = await loadIssues();
  const backend = new MemoryBackend(
    "bench/tinylinks",
    issues.map((i) => ({ number: i.number, title: i.title, body: i.body, labels: i.labels })),
  );
  const runner = new FakeAgentRunner();
  const prs = new MemoryPrSink();
  const store = new RunStore(await mkdtemp(join(tmpdir(), "h-runs-")));
  const cfg = parseConfig({
    repo: "bench/tinylinks",
    checks: [{ name: "test", command: "npm test" }],
    prMode: "individual",
    ...config,
  });
  const deps: PipelineDeps = {
    config: cfg,
    runner,
    issues: new ClaimingIssueSource(backend),
    prs,
    provider: shared.provider,
    snapshot: shared.snapshot,
    baseCommit: shared.bench.baseCommit,
    store,
    playbooks: new StaticPlaybooks(),
    batchId: "batch-test",
    factoryVersion: "test",
    playbookHash: "test",
  };
  return { bench: shared.bench, backend, runner, prs, store, provider: shared.provider, deps };
}
