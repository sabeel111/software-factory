# Phase 8 — Control UI & Observation Layer

## Goal

A local web app for running and watching the factory. You can start, drain and cancel batches; run
benchmarks and self-improvement; and see, live, what every agent is doing, where every issue is in
the pipeline, and what it's costing.

This supersedes the read-only dashboard of Phase 7 (R7.7). Write actions now exist, so they are
guarded (R8.6) and always go through the same code paths, limits and budgets as the CLI.

## Scope

- In: a structured event stream from the whole pipeline; a control server (`factory serve`); the
  web UI; a zero-cost **demo mode** with scripted agents against the TinyLinks benchmark.
- Out: multi-user accounts, remote hosting, and editing playbooks in the browser (playbook changes
  still go through `factory improve` and PRs).

## Design

```
 pipeline / integrator / runners ──emit──► EventBus ──► runs/<batch>/events.jsonl   (replay)
                                              │
                                              ├──► reduce(state, event) ──► LiveState  (GET /api/state)
                                              └──► SSE  /api/events  ──► browser ──► same reduce()
 browser ──POST (token)──► Controller ──► runBatch / benchmark / improve   (one job at a time)
```

- **One reducer, two places.** `reduce(state, event)` is a pure function shared by the server and
  the browser, so the UI after a reload, or a replayed old batch, is identical to the live one.
- **Events are small and typed.** No transcripts, no file contents and no secrets on the wire:
  agent activity is summarised (tool name plus a short target, such as a file path or a command's
  first line).

### Event types (all carry `seq`, `at`, `batchId`)

| Event | Payload |
|---|---|
| `job.started` / `job.finished` | kind (`batch`, `bench`, `improve`), label, result summary |
| `batch.started` | repo, mode, limits, queued issues |
| `issue.claimed` / `issue.skipped` | issue, reason |
| `stage.started` / `stage.finished` | issue, stage, attempt, durationMs, costUsd, ok, summary, error |
| `agent.activity` | issue, stage, attempt, kind (`text`, `tool`, `result`), tool, detail, isError |
| `verifier.check` | issue, attempt, name, exitCode, durationMs, tests |
| `issue.finished` | issue, outcome, costUsd, prUrl |
| `integration.merge` | issue, conflicted, merged, reason |
| `integration.finished` | merged, ejected, prUrl |
| `batch.control` | `draining` / `cancelling` |
| `batch.finished` | costUsd, unstarted |
| `job.log` | message |

## Requirements

| ID | Requirement |
|----|-------------|
| R8.1 | Pipeline, integrator and both agent runners emit the events above through an optional sink. Without a sink, behavior is unchanged. |
| R8.2 | Every event is appended to `runs/<batchId>/events.jsonl`, and a batch can be replayed from that file into the same state as when it ran live. |
| R8.3 | `GET /api/events` is Server-Sent Events. It resends missed events after a reconnect (`Last-Event-ID`), and a slow client never blocks the factory. |
| R8.4 | The controller runs at most one job at a time. A second start returns 409 with the running job. |
| R8.5 | Controls: start a batch (issue selection, concurrency, budget), drain, cancel, cancel one issue, run the benchmark (reference or factory, split), run improve (max USD), revert a candidate. Each maps onto the existing CLI code paths. |
| R8.6 | Write endpoints require the session token generated at startup (`X-Factory-Token` header), and the server rejects requests whose `Host` or `Origin` isn't the loopback address it serves (DNS-rebinding and CSRF protection). It binds to 127.0.0.1 by default. |
| R8.7 | Demo mode (`factory serve --demo`) costs nothing: scripted agents with realistic timing and activity, working against a real TinyLinks repo with real sandboxes and a real verifier. The UI labels it as a demo everywhere. |
| R8.8 | The UI has: a live **floor** (issues moving through stage columns), concurrency **lanes**, a live **activity feed**, an **issue drawer** (stage timeline, checks, findings, agent activity), a **batches** history with replay, **benchmark** history with a chart, **improvement** candidates with champion-vs-candidate scores, and an effective-**config** view with isolation warnings. |
| R8.9 | The UI works in light and dark mode, down to 360px wide. Status is never shown by color alone (icon or label too). Charts follow the dataviz rules: one axis, hover tooltip, a table view. |
| R8.10 | The UI is built from source on server start (esbuild), so there are no committed build artifacts and it needs no network at runtime. |

## Test cases

| ID | Tier | Given / When / Then |
|----|------|---------------------|
| T8.1 | unit | Given a scripted event sequence for a 3-issue batch (with a retry, a rejection and an integration eject), when it is reduced, then the state shows each issue's final column, attempts, costs, the lanes, and the batch totals. |
| T8.2 | integ | Given a finished batch's events.jsonl, when it is replayed, then the replayed state deep-equals the live state captured at the end of the batch. |
| T8.3 | integ | POST without a token → 401; with a wrong token → 401; with a foreign `Host` or `Origin` → 403; GET of state is allowed without a token. |
| T8.4 | unit | ClaudeAgentRunner maps SDK assistant `tool_use` / `text` blocks and user `tool_result` blocks to `agent.activity` events with summarised details (path, command head), and never includes file contents. |
| T8.5 | integ | Cancelling one issue mid-run aborts only that issue (outcome `cancelled`, claim released); the other issues finish. |
| T8.6 | integ | An SSE client receives events in `seq` order; after reconnecting with `Last-Event-ID: n`, it receives exactly the events after n. |
| T8.7 | integ | Starting a job while one is running returns 409 and names the running job. |
| T8.8 | integ | Demo mode end to end through the HTTP API: start a batch, stream events until `batch.finished`, then the final state matches the run store's records (outcomes and costs) and the integration PR is reported. |
| T8.9 | integ | The UI loads in headless Chromium against a demo server: the floor renders issue cards, a live batch moves cards between columns, the issue drawer opens, and there are no console errors. |

## Exit criteria

- All T8.x tests green.
- `factory serve --demo` runs a full visible batch from a single click, with no credentials.
- Screenshots of the main views in light and dark mode reviewed for layout problems.
