# Software Factory — Overview Spec

Status: Draft v1 · Owner: @sabeel111 · Last updated: 2026-10-21

## 1. Purpose

A **self-improving AI software factory**: an operating loop that turns GitHub
issues into verified, reviewed, integration-ready pull requests, and that
measurably gets better at doing so over time.

It is built for personal use first, but every design choice must allow a team
or company to run it later without a rewrite.

## 2. Principles (non-negotiable)

| # | Principle | Consequence in the design |
|---|-----------|---------------------------|
| P1 | **Never trust self-reporting** | Worker output is checked by a separate Verifier (deterministic code) and Reviewer (separate agent, separate context). |
| P2 | **Isolation for parallelism** | One sandbox per agent run. No two runs ever share a working tree. |
| P3 | **Structured contracts over chat** | Stages exchange typed, schema-validated JSON. Nothing parses free-form text. |
| P4 | **Humans own the merge** | The factory never merges to the default branch and never pushes to it. |
| P5 | **Measure before you improve** | Every change to the factory (human or self-proposed) is judged against a hidden benchmark it cannot see or edit. |
| P6 | **Ground in live docs** | Agents get current library docs, not just their training data. |
| P7 | **Bounded by default** | Every run has limits on concurrency, retries, open PRs, tokens and dollars. |

## 3. Architecture

```
                 ┌──────────────────────── Orchestrator ─────────────────────────┐
GitHub issues ──►│ Intake/Claim ─► Triage ─► Worker ─► Verifier ─► Reviewer ─┐   │
                 │                  │          ▲           │          │     │   │
                 │             needs-info      └─ retry ◄──┴──────────┘     │   │
                 │                                                          ▼   │
                 │                                                    Integrator│──► Draft PR ──► Human merge
                 └───────────────┬──────────────────────────────────────────────┘
                                 │ RunRecords
                                 ▼
                 Run store ──► Retrospective ──► Candidate playbook change
                                                       │
                                     Benchmark (hidden tests) gate ──► accepted / rejected
```

### Components

| Component | Kind | Responsibility |
|-----------|------|----------------|
| **CLI** | code | `factory run`, `factory bench`, `factory improve`, `factory status`. |
| **Orchestrator** | code | Schedules issues, enforces limits, moves work between stages. |
| **Issue source** | code (adapter) | Lists, claims and comments on issues. GitHub plus an in-memory fake. |
| **Sandbox provider** | code (adapter) | Creates isolated workspaces from a base snapshot. Worktree first; Docker/Upstash later. |
| **Agent runner** | code (adapter) | Runs a stage agent with a playbook, tools and an output schema. Claude Agent SDK plus a scripted fake. |
| **Triage** | agent | Accepts or rejects an issue; produces an acceptance checklist. |
| **Worker** | agent | Implements the change and its tests on a feature branch. |
| **Verifier** | **code** | Runs the configured checks in a *fresh* sandbox. Not an LLM. |
| **Reviewer** | agent | Reads the diff and decides `approve` or `request_changes`. |
| **Integrator** | agent + code | Merges approved branches sequentially and resolves conflicts, re-verifying after each merge. |
| **Run store** | code | Persists RunRecords (JSONL plus artifacts) for metrics and learning. |
| **Benchmark** | data + code | Fixture repo, issues and hidden tests that score the factory. |
| **Improver** | agent + code | Proposes playbook changes; keeps them only if the benchmark improves. |

### Mutable vs. immutable surface (self-improvement boundary)

- **Mutable by the Improver:** `playbooks/**` (stage prompts), and the per-stage
  `model`, `effort` and `maxTurns` in `factory.config.*`.
- **Immutable by any agent:** `src/**`, `bench/**` (especially hidden tests),
  the Verifier's check commands, and the limits and safety gates.
  This is enforced in code (see Phase 6), not by prompt.

## 4. Shared contracts

All contracts are defined once with `zod` in `src/contracts/` and exported as
both TypeScript types and JSON Schema (JSON Schema is used for agent structured
output).

```ts
type IssueRef = { repo: string; number: number; title: string; body: string; labels: string[] };

type TriageResult = {
  decision: "accept" | "reject";
  reason: string;
  kind?: "bug" | "feature" | "chore";
  acceptanceCriteria: string[];      // empty when rejected
  clarifyingQuestions: string[];     // non-empty when rejected for vagueness
  estimatedComplexity: "s" | "m" | "l";
};

type WorkerResult = {
  status: "done" | "blocked";
  branch: string;
  commitSha: string;
  touchedFiles: string[];
  testsAdded: string[];
  summary: string;
  blockedReason?: string;
};

type VerifierResult = {                 // produced by code, never by an LLM
  status: "pass" | "fail" | "error";
  commitSha: string;
  checks: { name: string; command: string; exitCode: number; durationMs: number; outputTail: string }[];
  testSummary: { passed: number; failed: number; skipped: number } | null;
};

type ReviewResult = {
  verdict: "approve" | "request_changes";
  findings: { severity: "blocker" | "major" | "minor"; file: string; line?: number; message: string }[];
  scopeCreep: boolean;                  // diff touches things unrelated to the issue
};

type IntegrationResult = {
  status: "integrated" | "partial" | "failed";
  integrationBranch: string;
  merged: number[];                     // issue numbers
  ejected: { issue: number; reason: string }[];
  conflictsResolved: number;
  finalVerification: VerifierResult;
};

type RunRecord = {
  runId: string; issue: IssueRef; startedAt: string; finishedAt?: string;
  factoryVersion: string; playbookHash: string;
  stages: { stage: StageName; attempt: number; startedAt: string; durationMs: number;
            costUsd: number; tokens: { input: number; output: number };
            output: unknown; error?: string }[];
  outcome: "pr_opened" | "rejected" | "failed" | "budget_exceeded" | "cancelled";
};
```

## 5. Labels and states on GitHub

| Label | Meaning |
|-------|---------|
| `factory:ready` | Issue may be picked up (opt-in; the factory ignores unlabeled issues). |
| `factory:claimed` | A run owns the issue (see claim protocol in Phase 3). |
| `factory:needs-info` | Triage rejected it; questions were posted. |
| `factory:failed` | Gave up after max attempts; summary posted. |
| `factory:pr` | A factory PR exists for this issue. |

## 6. Configuration (`factory.config.ts`)

```ts
export default {
  repo: "owner/name",
  defaultBranch: "main",
  sandbox: { provider: "worktree", setup: ["npm ci"] },
  checks: [ { name: "test", command: "npm test" }, { name: "typecheck", command: "npx tsc --noEmit" } ],
  limits: { concurrency: 4, maxWorkerAttempts: 2, maxOpenPrs: 5,
            maxCostUsdPerIssue: 3, maxCostUsdPerRun: 25, stageTimeoutSec: 900 },
  stages: {
    triage:     { model: "claude-opus-5-5", effort: "low" },
    worker:     { model: "claude-opus-5-5", effort: "high" },
    reviewer:   { model: "claude-opus-5-5", effort: "medium" },
    integrator: { model: "claude-opus-5-5", effort: "high" },
  },
  prMode: "integrated",        // "individual" | "integrated"
  docs: { context7: true },
};
```

## 7. Metrics (computed from RunRecords and the benchmark)

| Metric | Definition | Initial target |
|--------|------------|----------------|
| **Resolve rate** | Accepted benchmark issues whose hidden tests pass after integration | ≥ 70% at v1, ≥ 90% at v2 |
| **Triage accuracy** | Correct accept/reject over the labeled benchmark | 100% on the vague-issue set |
| **False-pass rate** | Verifier `pass` but hidden tests fail | ≤ 10% |
| **Reviewer catch rate** | Seeded defects caught by the Reviewer | ≥ 50% |
| **Cost per resolved issue** | Total USD / resolved | ≤ $2 |
| **Wall-clock** | 10-issue benchmark end to end | ≤ 10 min at concurrency 4 |

## 8. Phase map

| Phase | Spec | Goal | Depends on |
|-------|------|------|------------|
| 0 | [01-foundations](./01-foundations.md) | Repo, tooling, contracts, CLI shell, fakes | — |
| 1 | [02-benchmark](./02-benchmark.md) | TinyLinks fixture, 10 issues, hidden scorer | 0 |
| 2 | [03-sandboxes](./03-sandboxes.md) | Isolated workspaces from a snapshot | 0 |
| 3 | [04-intake-and-claims](./04-intake-and-claims.md) | Issue source, atomic claiming, leases | 0 |
| 4 | [05-single-issue-pipeline](./05-single-issue-pipeline.md) | Triage → Worker → Verifier → Reviewer → PR | 1, 2, 3 |
| 5 | [06-parallel-and-integration](./06-parallel-and-integration.md) | Concurrency, limits, Integrator | 4 |
| 6 | [07-self-improvement](./07-self-improvement.md) | Retrospective plus benchmark-gated playbook evolution | 1, 5 |
| 7 | [08-team-readiness](./08-team-readiness.md) | Container sandboxes, secrets, multi-repo, dashboard | 5 |
| 8 | [09-control-ui](./09-control-ui.md) | Control UI with live observation layer | 5, 6 |

The benchmark comes in Phase 1 on purpose. Every later phase reports its
numbers against it, so progress is measured from day one.

## 9. Test strategy

| Tier | Tag | Uses | Runs | Cost |
|------|-----|------|------|------|
| **Unit** | `unit` | Fakes only (FakeAgentRunner, MemoryIssueSource) | Every commit, CI | Free |
| **Integration** | `integ` | Real git, real sandboxes, fake agents | Every commit, CI | Free |
| **Contract** | `contract` | Recorded GitHub API fixtures | Every commit, CI | Free |
| **E2E** | `e2e` | Real Claude, real (test) GitHub repo | Manual or nightly, opt-in via `FACTORY_E2E=1` | $ (budgeted) |
| **Benchmark** | `bench` | Full pipeline plus hidden scorer | Before every playbook/model change | $$ (budgeted) |

Test IDs use the form `T<phase>.<n>` and are named in the test title
(for example `it("T4.7 verifier ignores worker's claimed pass", ...)`), so the
spec and the suite can be cross-checked automatically (see T0.9).

## 10. Definition of done (every phase)

1. All of the phase's test cases exist, are tagged, and pass in CI.
2. The phase's exit criteria are met and recorded in `specs/STATUS.md`.
3. No new `any` types in `src/contracts/`; lint and typecheck are clean.
4. From Phase 4 on: the benchmark is run and its scores are appended to
   `bench/results.jsonl`, with no regression larger than the noise band
   defined in Phase 1.

## 11. Non-goals (v1)

- Auto-merging to the default branch, under any circumstances.
- Non-GitHub trackers (Jira, Linear). The issue source interface allows them later.
- Languages other than TypeScript/JavaScript target repos (the design is
  language-agnostic; only the benchmark and default checks are JS).
- A hosted multi-tenant SaaS. Phase 7 makes it team-ready, not a product.

## 12. Glossary

- **Run:** one pass of one issue through the pipeline.
- **Batch:** one `factory run` invocation covering N issues.
- **Playbook:** the versioned prompt and instructions for one stage (`playbooks/<stage>.md`).
- **Snapshot:** a prepared base workspace (repo plus installed dependencies) that sandboxes are cloned from.
- **Hidden tests:** benchmark tests that never enter any agent's sandbox or context.
