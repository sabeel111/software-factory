# Phase 1 — Benchmark: TinyLinks + Hidden Scorer

## Goal

A fixed, reproducible yardstick for the whole factory, available **before**
the pipeline exists. Every later phase, and every self-improvement proposal,
is judged against it.

## Scope

- In: the TinyLinks fixture repo, a 10-issue set, hidden tests, a scorer and a
  noise-band measurement.
- Out: running the pipeline against it (that starts in Phase 4).

## Design

```
bench/
  tinylinks/
    repo/                 # the fixture app at its baseline commit (Node + TS + vitest)
    issues/*.json         # IssueRef bodies + metadata (kind, split, expected triage)
    hidden/h01.test.ts …  # hidden acceptance tests, one file per issue
    seeded-defects/       # Phase 4: known-bad patches for measuring reviewer catch rate
  score.ts                # applies a branch, copies hidden tests in, runs them, emits BenchScore
  results.jsonl           # append-only history of scores
```

### Issue set (10)

| # | Kind | Summary | Split | Expected triage |
|---|------|---------|-------|-----------------|
| 1 | bug | Shortening a URL without a scheme (`example.com`) should default to `https://` | train | accept |
| 2 | bug | Redirect for a slug with a trailing slash returns 404 | train | accept |
| 3 | bug | Malformed `?url=` parameter crashes the server (500) instead of returning 400 | holdout | accept |
| 4 | bug | Duplicate URLs create duplicate slugs; should return the existing slug | holdout | accept |
| 5 | feature | Custom slugs via `POST /links { slug }` with validation and conflict handling (409) | train | accept |
| 6 | feature | `GET /links/:slug/stats` returns the click count and the last-clicked time | train | accept |
| 7 | feature | Link expiry: `expiresAt`; expired links return 410 (boundary: exactly at `expiresAt` is expired) | holdout | accept |
| 8 | feature | Support `HEAD` on redirect routes | train | accept |
| 9 | feature | `DELETE /links/:slug` with a simple bearer-token check | holdout | accept |
| 10 | vague | "Make the links better and faster, users are complaining" | train | **reject** |

Issues 5, 6 and 7 deliberately touch the shared router and test files, so that
integration produces real merge conflicts (Phase 5).

A **train/holdout split** prevents the Improver (Phase 6) from overfitting:
it may read train-split run records, and acceptance decisions are made on
holdout.

## Requirements

| ID | Requirement |
|----|-------------|
| R1.1 | The baseline TinyLinks repo passes its own (visible) test suite and fails **every** hidden test file h01–h09. |
| R1.2 | Each hidden test file maps to exactly one issue and tests behavior only through the HTTP API (no imports of internal modules), so any reasonable implementation can pass. |
| R1.3 | A reference solution branch exists for each accepted issue, and it passes its own hidden test file. |
| R1.4 | `score.ts` takes `(baseCommit, candidateRef)` and runs in a **fresh** sandbox. It copies hidden tests in only after the candidate is checked out, runs them, and emits a `BenchScore`: per-issue pass/fail, resolve rate, triage accuracy (when given triage results), and duration. |
| R1.5 | Hidden tests are never present in, or reachable from, any agent sandbox. In Phase 2 and later this is asserted by test, not convention. |
| R1.6 | A noise band is measured: with the pipeline fixed, run the benchmark 3 times and record the resolve-rate spread. A change counts as an improvement only above this band. |
| R1.7 | Results are appended to `bench/results.jsonl` with `factoryVersion`, `playbookHash`, models, cost and the score. |

## Test cases

| ID | Tier | Given / When / Then |
|----|------|---------------------|
| T1.1 | integ | Given the baseline repo, when its visible tests run, then all pass. |
| T1.2 | integ | Given the baseline repo, when each hidden test file h01–h09 runs, then every one fails (each issue really is unsolved). |
| T1.3 | integ | Given reference solution branch *k*, when scored, then hidden test *k* passes. |
| T1.4 | integ | Given all reference branches merged, when scored, then the resolve rate is 9/9. |
| T1.5 | unit | Given triage results with issue 10 rejected and 1–9 accepted, then triage accuracy is 100%; with issue 10 accepted, it is 90%. |
| T1.6 | integ | Given a candidate branch that adds a file `hidden/h01.test.ts` with trivial passing content, when scored, then the scorer overwrites it with the real hidden test (candidates cannot shadow hidden tests). |
| T1.7 | unit | Every issue JSON validates against `IssueRef` plus the benchmark metadata schema, and the splits are exactly 5 train and 5 holdout. |
| T1.8 | integ | Scoring the same candidate twice yields an identical per-issue result (the scorer is deterministic). |

## Exit criteria

- `factory bench --reference` scores 9/9 resolved and 100% triage accuracy
  (with a scripted triage).
- `bench/results.jsonl` has its first entry (the reference baseline).
