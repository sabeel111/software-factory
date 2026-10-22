# Phase 5 — Parallelism, Limits & the Integrator

## Goal

Clear a backlog in parallel without collisions, floods or runaway cost, and
merge the resulting branches into one integration branch that a human can
review and merge.

## Scope

- In: the scheduler, concurrency, global limits, PR-flood control, the
  Integrator stage, `factory status`, and graceful cancellation.
- Out: self-improvement (Phase 6).

## Scheduler

- Pulls from `listReady()` and runs up to `limits.concurrency` issue pipelines
  at once, each with its own claim and sandboxes.
- Stops starting new issues when any of these is true: the batch budget
  (`maxCostUsdPerRun`) is ≥ 90% spent; open factory PRs ≥ `maxOpenPrs`; or
  the user sends SIGINT. In-flight runs are allowed to finish (a second SIGINT
  cancels them and releases their claims as `abandoned`).

## Integrator

Runs after all issue pipelines in the batch finish, over the branches that are
**verified and approved**.

```
integration = new sandbox at main → branch factory/integration-<batchId>
order branches by (fewest touched files first, then issue priority)
for each branch b:
  git merge --no-ff b
  if conflict: Integrator agent resolves (tools: Read/Edit/Bash in sandbox; input: both diffs + both issues' criteria)
  run Verifier on integration HEAD (all checks)
  if fail: Integrator agent gets one repair attempt → re-verify
  if still fail: git merge --abort / reset to pre-merge; eject b with reason
open ONE draft PR: integration branch → main, listing merged issues, ejected issues, and per-merge verification
```

- Ejected issues get a comment explaining why, and are relabeled
  `factory:ready` for the next batch (they are re-attempted on a fresh `main`).
- The Integrator may only change files that conflict, or files that the
  failing checks implicate. It must not drop tests from either side.

## Requirements

| ID | Requirement |
|----|-------------|
| R5.1 | At most `limits.concurrency` issue pipelines run at once. |
| R5.2 | No two pipelines share an issue (Phase 3) or a sandbox (Phase 2), at any concurrency level. |
| R5.3 | The batch budget is enforced globally: cost is aggregated across concurrent runs, and no new stage starts once the budget is exhausted. |
| R5.4 | The number of open factory PRs never exceeds `maxOpenPrs`. |
| R5.5 | The Integrator re-runs **all** checks after **each** merge. A merge that can't be made green is ejected without affecting already-merged branches. |
| R5.6 | Test counts never decrease across integration: after each merge, the number of tests ≥ max(head, incoming, head + incoming − base), i.e. every test already integrated plus every test the incoming branch added (no tests silently dropped during conflict resolution). |
| R5.7 | `factory status` shows each issue in the batch with its stage, attempt, elapsed time and cost, and the batch totals. |
| R5.8 | First SIGINT drains; second SIGINT cancels, releases all claims, and destroys all sandboxes. |

## Test cases

| ID | Tier | Given / When / Then |
|----|------|---------------------|
| T5.1 | integ | Given 10 ready issues, `concurrency: 3`, and fake agents with random delays, then the max simultaneously active pipelines observed is exactly 3 and all 10 complete. |
| T5.2 | integ | Given 2 factory processes against the same MemoryIssueSource with 10 issues, then each issue is processed exactly once in total. |
| T5.3 | unit | Given `maxCostUsdPerRun: 5` and fake stages costing $1 each, then no stage starts after the cumulative cost reaches $5, and the batch outcome reports `budget_exceeded` for unstarted issues. |
| T5.4 | unit | Given `maxOpenPrs: 2` with 2 open factory PRs already, then the scheduler starts no new issue (in `individual` mode). |
| T5.5 | integ | Given 3 approved branches where branches 2 and 3 conflict in `src/routes.ts`, and a scripted integrator resolution, then all 3 are merged and every per-merge verification passes. |
| T5.6 | integ | Given a branch whose merge can't be made green (scripted integrator repair fails), then it is ejected, the integration branch equals the state before that merge, and the next branch still integrates. |
| T5.7 | integ | Given an integrator resolution that deletes a test from one side, then the R5.6 check fails that merge and the branch is ejected with reason `tests-dropped`. |
| T5.8 | integ | Ejected issues receive a comment and are relabeled `factory:ready`. |
| T5.9 | integ | First SIGINT during a 10-issue batch: no new issues start; in-flight ones finish. Second SIGINT: all claims are released and no sandbox paths remain. |
| T5.10 | unit | `factory status` renders the per-issue and total rows from a RunRecord stream (snapshot test). |
| T5.11 | bench | Full benchmark at `concurrency: 4` in `integrated` mode: resolve rate (scored on the **integration branch**) ≥ the Phase 4 baseline minus the noise band; wall-clock ≤ 10 min; cost recorded. |

## Exit criteria

- All unit and integ tests green.
- T5.11 recorded; it meets the Overview §7 v1 targets (resolve rate ≥ 70%,
  wall-clock ≤ 10 min), or the gap is written up in `specs/STATUS.md` with the
  failing issues and causes.
