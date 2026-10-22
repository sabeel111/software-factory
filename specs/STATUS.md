# Phase Status

Updated at the end of each phase (see Overview §10, Definition of done).
Last update: 2026-10-22 (Phase 8).

| Phase | Spec | Status | Tests (run here) | Gated tests (need a real service) |
|-------|------|--------|------------------|-----------------------------------|
| 0 | [Foundations](./01-foundations.md) | ✅ Done | 10 / 10 | — |
| 1 | [Benchmark](./02-benchmark.md) | ✅ Done | 8 / 8 | — |
| 2 | [Sandboxes](./03-sandboxes.md) | ✅ Done | 9 / 9 | — |
| 3 | [Intake & claims](./04-intake-and-claims.md) | ✅ Done (T3.10 pending) | 9 / 10 | T3.10 (real GitHub repo) |
| 4 | [Single-issue pipeline](./05-single-issue-pipeline.md) | ✅ Built; benchmark baseline pending | 11 / 15 | T4.12–T4.15 (real Claude) |
| 5 | [Parallel & integration](./06-parallel-and-integration.md) | ✅ Built; benchmark run pending | 10 / 11 | T5.11 (real Claude) |
| 6 | [Self-improvement](./07-self-improvement.md) | ✅ Built; first real improvement pending | 11 / 12 | T6.12 (real Claude) |
| 7 | [Team readiness](./08-team-readiness.md) | ✅ Built; Docker isolation unverified | 4 / 8 | T7.1–T7.3 (Docker daemon), T7.8 (not implemented) |
| 8 | [Control UI](./09-control-ui.md) | ✅ Done | 9 / 9 | T8.9 needs Chromium (ran here; CI skips it) |

`npm run spec:coverage` → 92 spec test IDs: 80 covered and passing, 12 gated (T8.9 ran here too), 0 missing.

## Exit-criteria notes

- **Phase 1:** `factory bench --reference` → 9/9 resolved, 100% triage accuracy; first entry in
  `bench/results.jsonl`.
- **Phase 4/5/6 benchmark numbers are not measured yet.** The build environment had no Claude
  credentials, so no real-model benchmark has run. The whole loop *is* exercised offline with
  scripted "oracle" agents (`test/bench-offline.integ.test.ts`: 10 issues, 4-way parallel, real
  merge conflicts, hidden-test scoring → 9/9). Run the gated suite to record the real baseline:
  `FACTORY_E2E=1 npx vitest run --project e2e`, or the **E2E** GitHub workflow.
- **Phase 7 Docker provider** is implemented and typechecks against the Agent SDK, and the
  egress/credential gateway it depends on is tested on the host (`test/gateway.integ.test.ts`), but
  no Docker daemon was available, so the container suite (T7.1–T7.3) has not run yet. The `docker`
  CI job runs it on GitHub's Ubuntu runners.
- **T7.8 / R7.2 (cloud sandbox provider)** is not implemented: there was no account or API access to
  build it against. The `SandboxProvider` interface and shared sandbox suite are ready for it.

## Spec changes made during implementation

- Phase 1: issue 8 moved to the holdout split, so the split is 5/5 as R1.7 requires (the table had
  6/4).
- Phase 5, R5.6: the dropped-tests floor is `max(head, incoming, head + incoming − base)`. The
  original "≥ max of both parents" missed a resolution that deletes one side's test while the other
  side adds one.
- Phase 7, R7.1: snapshots are prepared host directories (setup runs inside a container behind the
  gateway) rather than images, and the agent process itself runs in the container.

## Bugs the specs' tests caught while building

- Crash handler recorded `attempt: 0`, which failed RunRecord validation, so a crash crashed the
  crash handler (T4.9).
- Two factory processes could process one issue twice: the second listed it while the first held
  it, then claimed it after the first finished. Fixed with a post-claim eligibility check and
  releasing labels before freeing the claim (T5.2).
- Agents inherited `GITHUB_TOKEN` and other factory credentials through the environment; git auth
  is now per-command and never written where an agent could read it.
- Reverting a candidate that created a file left an empty file instead of deleting it (T6.11).
- The claim property test initially couldn't fail (fast-check delayed resolution, not execution);
  it now catches a newest-claim-wins mutant.

## Phase 8 notes

- The UI was reviewed in headless Chromium at 1440px and 390px, light and dark, against a live demo
  server, with no console errors and no horizontal overflow on a phone. The review caught and fixed: SSE headers
  not flushed until the first event, the Live floor showing a previous batch under a new job,
  History omitting integration cost, distorted chart text from viewBox stretching, cards shrinking
  in capped columns on phones, and demo-script bugs (a retry that couldn't undo a committed
  attempt; a demo integrator that carried another issue's fix in through whole-file resolution).
- Demo mode is honest about what's simulated: agents and costs are scripted; the repo, sandboxes,
  verifier (`npm test`), merges and hidden-test scoring are real. The demo includes a repeated
  verifier failure (#1), a verifier-caught retry (#3), a reviewer-caught retry (#7), a rejected
  vague issue (#10), and real merge conflicts. Its improvement run proposes a candidate that the
  gate correctly rejects as within-noise, because scripted agents ignore playbooks.
- R7.7's read-only dashboard is kept (`factory dashboard`) for sharing a view without controls.
