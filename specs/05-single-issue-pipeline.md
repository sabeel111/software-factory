# Phase 4 — Single-Issue Pipeline

## Goal

One issue goes end to end: **Triage → Worker → Verifier → Reviewer → Draft PR**.
Every handoff is typed, every judgment of the Worker's output is independent,
and agents are grounded in current docs.

## Scope

- In: the Claude Agent SDK runner, the four stages, the retry loop, Context7
  docs grounding, PR creation, and the first real benchmark score.
- Out: concurrency and integration (Phase 5).

## Stage specs

### Triage (agent, read-only)
- **Input:** `IssueRef` plus a read-only repo snapshot (file tree, README, test layout).
- **Tools:** Read, Glob, Grep. No writes, no shell.
- **Output:** `TriageResult`.
- **Effects:** if rejected, post `clarifyingQuestions` as a comment and release
  with `needs-info`.
- **Rule:** reject when the acceptance criteria can't be stated as checkable
  behavior. Don't guess at intent.

### Worker (agent, own sandbox)
- **Input:** `IssueRef`, `TriageResult.acceptanceCriteria`, and on retry the
  previous `VerifierResult` and/or `ReviewResult`.
- **Tools:** Read, Write, Edit, Glob, Grep, Bash (inside the sandbox only), and
  Context7 docs.
- **Output:** `WorkerResult`. The factory, not the agent, creates the commit and
  pushes the branch `factory/issue-<n>-<runId8>`.
- **Rule:** must add or adjust tests covering every acceptance criterion; must
  not edit CI config, lockfiles (unless the issue requires a dependency), or
  files outside the repo.

### Verifier (code, fresh sandbox)
- Creates a **new** sandbox from the snapshot, checks out the Worker's commit
  SHA, runs `config.checks` in order, and builds a `VerifierResult`.
- **Never reads `WorkerResult.status` or `summary`.** Pass/fail comes only from
  exit codes.
- Rejects the change outright if it modifies a protected path
  (`config.protectedPaths`, default: `.github/**`, the check scripts in
  `package.json`).

### Reviewer (agent, fresh context, read-only)
- **Input:** `IssueRef`, acceptance criteria, `git diff base...head`,
  `VerifierResult`.
- **Tools:** Read, Glob, Grep on a read-only checkout of the head commit. No
  writes.
- **Output:** `ReviewResult`. Any `blocker` finding forces `request_changes`.
- **Focus:** logic errors, missed edge cases or boundaries, security issues,
  unrelated changes (`scopeCreep`), and weakened or deleted tests.

### Retry loop
```
attempt = 1
loop:
  worker(attempt) → verifier
  if verifier.fail  → if attempt < maxWorkerAttempts: attempt++ (feed VerifierResult) else FAIL
  reviewer
  if request_changes → if attempt < maxWorkerAttempts: attempt++ (feed ReviewResult) else FAIL
  → PR
```

### PR (code)
- Opens a **draft** PR from the factory branch with: a link to the issue, the
  acceptance criteria as a checklist, the verifier check table, the reviewer
  verdict and findings, cost, and runId. Labels: `factory:pr`.
- In `prMode: "integrated"`, per-issue PRs are skipped, and branches are handed
  to the Integrator instead (Phase 5).

## Requirements

| ID | Requirement |
|----|-------------|
| R4.1 | `ClaudeAgentRunner` implements `AgentRunner` using `@anthropic-ai/claude-agent-sdk`, passing the stage playbook as the system prompt, the tool allowlist, `cwd` = sandbox path, model/effort from config, and requesting structured output with the stage's JSON Schema. |
| R4.2 | Each stage is a **separate agent session**. No transcript is shared across stages; only typed results cross. |
| R4.3 | The Verifier is pure code and decides pass/fail only from check exit codes. |
| R4.4 | A per-issue budget (`maxCostUsdPerIssue`) is enforced across all stages and attempts; when exceeded, the run stops with `budget_exceeded`. |
| R4.5 | Context7 is available to the Worker as an MCP server. Its API key is read from the host environment and not written into the sandbox filesystem. (Full credential isolation comes in Phase 7.) |
| R4.6 | Stage timeouts (`stageTimeoutSec`) abort the agent session and count as a failed attempt. |
| R4.7 | Every stage's input, output, usage, cost, duration and transcript path is written to the RunRecord. |
| R4.8 | Protected-path edits by the Worker cause a verifier `fail` with check name `protected-paths`. |
| R4.9 | The claim is released on every exit path (success, failure, budget, timeout, crash via `finally`). |

## Test cases

| ID | Tier | Given / When / Then |
|----|------|---------------------|
| T4.1 | unit | Given triage `reject`, then no worker runs, the clarifying questions are posted as a comment, and the claim is released with `needs-info`. |
| T4.2 | integ | Given triage `accept` and a scripted worker that commits a correct fix, then verifier `pass`, reviewer `approve`, and a draft PR is opened containing the check table. |
| T4.3 | integ | Given a worker that reports `status: "done"` but leaves a failing test, then the verifier returns `fail` (self-report ignored) and attempt 2 is started with the `VerifierResult` in its input. |
| T4.4 | integ | Given a worker that fails twice (`maxWorkerAttempts: 2`), then the outcome is `failed`, a summary comment is posted, and the label is `factory:failed`. |
| T4.5 | integ | Given a reviewer that returns a `blocker`, then attempt 2 receives the `ReviewResult`; if attempt 2 is approved, a PR is opened. |
| T4.6 | integ | Given a worker that edits `.github/workflows/ci.yml`, then the verifier fails with check `protected-paths`. |
| T4.7 | integ | The verifier sandbox path differs from the worker sandbox path, and the verifier checks out the exact `commitSha` from `WorkerResult`. |
| T4.8 | unit | Given scripted usage costs that exceed `maxCostUsdPerIssue` mid-attempt, then the run stops with `budget_exceeded` and no further stage starts. |
| T4.9 | unit | Given a worker that throws mid-run, then the claim is released and the worker sandbox is destroyed. |
| T4.10 | unit | The reviewer's tool allowlist contains no write or shell tool, and the triage allowlist likewise. |
| T4.11 | unit | Given a worker output that fails schema validation, then it counts as a failed attempt with error `AgentOutputInvalid` (not a crash). |
| T4.12 | e2e | Real Claude on benchmark issue 1: produces a passing branch, and its hidden test h01 passes. |
| T4.13 | e2e | Real Claude on benchmark issue 10 (vague): triage rejects it with at least one clarifying question. |
| T4.14 | bench | Reviewer catch rate: apply each patch in `bench/tinylinks/seeded-defects/` (passes visible tests, contains a real bug, e.g. the issue 7 off-by-one at the `expiresAt` boundary). Then the reviewer returns `request_changes` for ≥ 50% of them. |
| T4.15 | bench | Sequential benchmark run over all 10 issues: resolve rate, triage accuracy, false-pass rate and cost are recorded in `bench/results.jsonl`. |

## Exit criteria

- All unit and integ tests green; T4.12 and T4.13 pass.
- First real benchmark result recorded (T4.15). **Target: resolve rate ≥ 60%,
  triage accuracy 100%.** This becomes the baseline that Phases 5 and 6 must
  beat or hold.
