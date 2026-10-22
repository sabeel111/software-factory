# Phase 7 — Team & Company Readiness

## Goal

Make the factory safe and practical for a team or company: real sandbox
isolation, credentials agents can't see, multiple repos, and visibility for
people who don't use the CLI.

## Scope

- In: container and cloud sandbox providers, egress allowlists, credential
  injection through a proxy, multi-repo config, an audit log, and a read-only
  web dashboard.
- Out: hosted SaaS, billing, SSO (revisit after v1 usage).

## Requirements

| ID | Requirement |
|----|-------------|
| R7.1 | A `docker` SandboxProvider implements the Phase 2 interface. A snapshot is prepared once per `(repo, ref, setup)` — the checkout on the host, with `setup` run *inside* a container behind the gateway — and each sandbox is one container from the configured image with its worktree bind-mounted. The agent process itself runs in the container (Agent SDK `spawnClaudeCodeProcess`). It passes the entire Phase 2 test suite unchanged. |
| R7.2 | An optional cloud provider (Upstash Box or equivalent) implements the same interface, behind a config flag. It passes the Phase 2 suite in an opt-in CI job. |
| R7.3 | **Egress allowlist:** container sandboxes can reach only the configured hosts (default: the package registry, the Anthropic API, Context7, the git remote). Everything else is blocked. |
| R7.4 | **Credential isolation:** API keys (Anthropic, Context7, GitHub) are injected by a host-side proxy at egress. They never appear in the sandbox environment, filesystem, or agent context. |
| R7.5 | **Multi-repo:** one config can list several repos, each with its own checks, limits and playbook overrides; the scheduler shares global limits across them. |
| R7.6 | **Audit log:** every external side effect (comment, label, push, PR) is appended to `runs/audit.jsonl` with the runId, actor, target and timestamp. |
| R7.7 | (Superseded for day-to-day use by the Phase 8 control UI; kept as a read-only view.) **Dashboard:** a read-only web page showing batches, per-issue stage timelines, costs, benchmark history and improvement history, served from the run store. No write actions. |
| R7.8 | **Policy file:** org-level `factory.policy.ts` can lower (never raise) any repo's limits, and can add protected paths and blocked tools. Repo config can't override it. |

## Test cases

| ID | Tier | Given / When / Then |
|----|------|---------------------|
| T7.1 | integ | The full Phase 2 suite (T2.1–T2.9) passes with `provider: "docker"`. |
| T7.2 | integ | Inside a docker sandbox, `curl https://example.com` fails and `npm view left-pad` succeeds (registry allowlisted). |
| T7.3 | integ | Inside a docker sandbox, `env`, a recursive grep of `/` for the Anthropic key prefix, and `cat ~/.config/**` find no credentials, while an agent request to the Anthropic API through the proxy succeeds. |
| T7.4 | unit | Given repo limit `concurrency: 8` and policy limit `concurrency: 4`, then the effective concurrency is 4; given a repo `protectedPaths` list, policy paths are added to it, never replacing them. |
| T7.5 | integ | Given 2 repos with 5 ready issues each and global `concurrency: 4`, then no more than 4 pipelines run at once across both repos. |
| T7.6 | integ | Every GitHub write in a scripted batch has a matching line in `audit.jsonl`, and there are no audit lines without a write. |
| T7.7 | integ | The dashboard renders a batch from fixture RunRecords, and exposes no POST/PUT/DELETE route (route table test). |
| T7.8 | e2e | Opt-in: the cloud provider passes T2.1, T2.2 and T2.3 against the real service. |

## Exit criteria

- All non-e2e tests green; T7.8 run once and recorded.
- `provider: "docker"` becomes the documented default for team use, and the
  worktree startup warning (Phase 2) points to it.
