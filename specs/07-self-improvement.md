# Phase 6 — Self-Improvement

## Goal

The factory proposes changes to its own playbooks and stage settings, tests
them on the benchmark, and keeps a change only when the improvement is real,
measured on data it didn't learn from.

## Scope

- In: the failure taxonomy, the Retrospective agent, candidate generation, the
  benchmark gate, the promotion flow, and the playbook version history.
- Out: changing factory source code (`src/**`). That stays human-authored; the
  Improver may *suggest* code changes as issues, never apply them.

## Loop

```
1. Collect   RunRecords for train-split benchmark runs + real (non-benchmark) runs
2. Classify  each failed or costly run into the failure taxonomy (code, not LLM, where possible)
3. Retro     Retrospective agent reads the top failure clusters + current playbooks
             → proposes ≤ 3 candidate changes, each a patch to playbooks/** or stage settings,
               with a hypothesis ("Worker misses boundary conditions → add a boundary checklist")
4. Evaluate  for each candidate: run the benchmark n=3 on HOLDOUT, compare with the current champion
5. Gate      accept iff  meanResolve(candidate) − meanResolve(champion) > noiseBand
                    AND  triageAccuracy(candidate) ≥ champion
                    AND  falsePassRate(candidate) ≤ champion
                    AND  costPerResolved(candidate) ≤ 1.25 × champion
6. Promote   open a PR with the playbook diff, the hypothesis and the score table; a HUMAN merges it
7. Record    every candidate (accepted or not) goes to playbooks/HISTORY.jsonl with its scores
```

### Failure taxonomy (initial)

| Code | Signal |
|------|--------|
| `triage-false-accept` | Accepted, and later failed for missing/unclear requirements, or the issue is labeled vague in the benchmark. |
| `triage-false-reject` | Rejected, but the benchmark expects accept. |
| `verify-fail-repeat` | Same failing check on all attempts. |
| `false-pass` | Verifier passed, hidden test failed (benchmark only). |
| `review-miss` | Reviewer approved, hidden test failed. |
| `review-noise` | Reviewer requested changes, and the hidden tests passed on the earlier attempt anyway. |
| `integration-eject` | Ejected by the Integrator. |
| `budget` / `timeout` | Hit a limit. |

## Requirements

| ID | Requirement |
|----|-------------|
| R6.1 | The Improver's writes are restricted, **in code**, to `playbooks/**` and the `stages.*.{model,effort,maxTurns}` keys of the config. Any other path in a candidate patch rejects the candidate before evaluation. |
| R6.2 | The Retrospective agent can read train-split records only. Holdout issue bodies, transcripts and hidden tests are never in its input. |
| R6.3 | Acceptance uses the gate in step 5. The noise band comes from Phase 1 (R1.6) and is re-measured whenever the champion changes. |
| R6.4 | `factory improve` has a hard budget (`--max-usd`, default $30) covering retrospective plus all evaluations, and stops cleanly when it's reached. |
| R6.5 | Promotion is always a PR for a human to merge. Nothing auto-applies. |
| R6.6 | `playbooks/HISTORY.jsonl` records: candidate id, parent hash, hypothesis, patch, scores (all n runs), gate decision and reason. |
| R6.7 | Any accepted change can be reverted with `factory improve --revert <candidateId>`, which opens a revert PR. |
| R6.8 | The Improver may also file GitHub issues on the factory's own repo for problems that need code changes (labeled `factory:self`), capped at 3 per run. |

## Test cases

| ID | Tier | Given / When / Then |
|----|------|---------------------|
| T6.1 | unit | Given a candidate patch that touches `src/agents/runner.ts`, then it is rejected before evaluation with reason `out-of-bounds`; same for `bench/tinylinks/hidden/h03.test.ts`. |
| T6.2 | unit | Given a candidate patch to `playbooks/worker.md` and `stages.worker.effort`, then it passes the bounds check. |
| T6.3 | unit | Given RunRecords from both splits, then the retrospective input contains only train-split issue numbers (assert no holdout number, title or body substring appears). |
| T6.4 | unit | Gate: champion resolve [0.60, 0.62, 0.58], candidate [0.70, 0.72, 0.68], noise band 0.04, equal triage, false-pass and cost → accepted. |
| T6.5 | unit | Gate: candidate +0.03 over the champion with noise band 0.04 → rejected (`within-noise`). |
| T6.6 | unit | Gate: candidate +0.10 resolve but triage accuracy drops 100% → 90% → rejected (`triage-regression`). |
| T6.7 | unit | Gate: candidate +0.10 resolve but cost per resolved is 1.4× → rejected (`cost-regression`). |
| T6.8 | unit | The taxonomy classifier labels a scripted false-pass record as `false-pass` and a reviewer-approved, hidden-failed record as `review-miss`. |
| T6.9 | unit | Given `--max-usd 5` and evaluations costing $2 each, then at most 2 evaluations run, and HISTORY records the remaining candidates as `not-evaluated: budget`. |
| T6.10 | integ | An accepted candidate produces a PR whose body contains the hypothesis and the score table, and HISTORY gains one line. |
| T6.11 | integ | `--revert <id>` produces a PR whose diff exactly inverts that candidate's patch. |
| T6.12 | bench | End to end: starting from a deliberately weakened worker playbook (boundary-check guidance removed), one `factory improve` run proposes a change that is accepted by the gate and raises the holdout resolve rate (proves the loop can recover a known regression). |

## Exit criteria

- All unit and integ tests green; T6.12 passes once and is recorded.
- At least one real (not seeded) accepted improvement in `HISTORY.jsonl`, or a
  written analysis in `specs/STATUS.md` of why none cleared the gate.
