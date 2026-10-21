# Phase 3 — Issue Intake & Atomic Claims

## Goal

Reliably decide which issues the factory works on, and guarantee that **no two
runs ever work on the same issue**, even across machines.

## Scope

- In: the `IssueSource` interface, the GitHub adapter, the in-memory adapter,
  the claim protocol, leases and heartbeats, and release.
- Out: what happens after a claim (Phase 4).

## Interface

```ts
interface IssueSource {
  listReady(): Promise<IssueRef[]>;                    // open + labeled factory:ready, not claimed, not needs-info
  claim(issue: number, runId: string): Promise<ClaimResult>;   // { won: boolean; holder?: string }
  heartbeat(issue: number, runId: string): Promise<void>;
  release(issue: number, runId: string, outcome: "done" | "needs-info" | "failed" | "abandoned"): Promise<void>;
  comment(issue: number, body: string): Promise<void>;
}
```

## Claim protocol

GitHub labels are not a compare-and-swap primitive: two clients can add the
same label at once and both "succeed". The protocol therefore uses comments,
which are totally ordered, as the source of truth:

1. Skip the issue if it has `factory:claimed` and a non-expired lease.
2. Post a claim comment: `<!-- factory-claim run=<runId> lease=<ISO-expiry> -->`.
3. Re-read the issue's comments. Among the **unexpired** claim comments, the one
   with the lowest comment ID wins.
4. The winner adds the `factory:claimed` label (a human-visible hint). Losers
   delete their own claim comment and back off.
5. The winner posts heartbeat comments that edit its claim comment's lease
   (default lease 15 min, heartbeat every 5 min).
6. A claim whose lease has expired may be taken over through the same protocol.
   The new winner posts a takeover note.
7. `release()` removes the label, marks the claim comment released, and
   applies the outcome label (`factory:needs-info`, `factory:failed`, or none).

## Requirements

| ID | Requirement |
|----|-------------|
| R3.1 | Only issues labeled `factory:ready` are eligible. Issues labeled `factory:needs-info` are skipped until a human removes that label. |
| R3.2 | Under any interleaving of concurrent `claim()` calls for one issue, exactly one returns `won: true`. |
| R3.3 | Expired leases can be taken over; live leases cannot. |
| R3.4 | `release()` is idempotent. |
| R3.5 | The GitHub adapter retries 5xx and secondary-rate-limit responses with backoff, and never retries 4xx except 409/422 where it re-reads state. |
| R3.6 | Ordering of `listReady()` is deterministic: by priority label (`P0` > `P1` > none), then oldest first. |
| R3.7 | The GitHub token needs only `issues:write` and `pull_requests:write` on the target repo. The adapter fails fast at startup with a clear message if scopes are missing. |

## Test cases

| ID | Tier | Given / When / Then |
|----|------|---------------------|
| T3.1 | unit | Given 5 issues where 2 are `factory:ready`, 1 is ready + `needs-info`, then `listReady()` returns exactly the 2. |
| T3.2 | unit | Given MemoryIssueSource and 20 concurrent `claim(7, runId_i)`, then exactly 1 returns won and 19 return `won:false` with the winner as `holder`. |
| T3.3 | unit | Property test: for random interleavings of claim-comment posts and reads (fast-check, 500 cases), at most one winner ever exists. |
| T3.4 | unit | Given a claim with a lease expiring at t, when another run claims at t+1s, then it wins and a takeover note is posted; at t-1s, it loses. |
| T3.5 | unit | Given a winner that heartbeats every 5 min, then after 60 min it still holds the claim. |
| T3.6 | unit | Calling `release()` twice leaves the issue in the same state as calling it once. |
| T3.7 | contract | Using recorded GitHub API fixtures, the adapter's claim sequence makes exactly: 1 POST comment, 1 GET comments, then (winner) 1 POST label or (loser) 1 DELETE comment. |
| T3.8 | contract | Given a recorded 502 then 200, the adapter retries once and succeeds; given a 404, it does not retry. |
| T3.9 | unit | `listReady()` ordering: P0-old, P0-new, P1-old, none-old. |
| T3.10 | e2e | Against a real test repo, two `factory run --issue N` processes started simultaneously: exactly one proceeds; the other logs "lost claim" and exits 0. |

## Exit criteria

- T3.1–T3.9 green in CI; T3.10 passes manually once against the test repo
  and is recorded in `specs/STATUS.md`.
