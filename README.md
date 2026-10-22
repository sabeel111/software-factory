# Software Factory

A self-improving AI software factory. It turns GitHub issues into verified, reviewed,
integration-ready pull requests, and gets measurably better at it over time. Humans always make the
merge decision.

```
GitHub issues ──► Triage ──► Worker ──► Verifier ──► Reviewer ──► Integrator ──► draft PR ──► human merges
 factory:ready   reject      own        clean         reads        merges +
                 vague       sandbox    sandbox,      the diff     re-verifies
                 issues                 exit codes                 each branch
                                          ▲                │
                                          └── retry ◄──────┘
Run records ──► Retrospective ──► candidate playbook change ──► hidden benchmark gate ──► PR
```

Built spec-first: see [`specs/00-overview.md`](./specs/00-overview.md) and
[`specs/STATUS.md`](./specs/STATUS.md).

## How it stays honest

| Failure mode | What the factory does |
|---|---|
| Parallel agents trampling each other | One isolated sandbox per agent run, created from a cached snapshot in about 1 s |
| Two runs grabbing the same issue | Comment-ordered claim protocol with leases and heartbeats (property-tested) |
| Agents grading their own work | The **Verifier is code**: it checks out the exact commit in a fresh sandbox and trusts only exit codes. A separate Reviewer agent reads the diff. |
| Stale model knowledge | Workers get live docs through the Context7 MCP server |
| PR floods and runaway cost | Limits on concurrency, open PRs, retries, and per-issue and per-batch budgets. PRs are drafts. The factory never merges. |
| Merge conflicts between parallel PRs | The Integrator merges branches one at a time, re-runs every check after each merge, and ejects anything it can't make green or that drops tests |
| "Self-improvement" that drifts | Changes are judged on held-out hidden tests the improver never sees, must beat the measured noise band, and are proposed as PRs |

## Quick start

```bash
npm ci
cp factory.config.example.ts factory.config.ts   # set `repo`, checks, limits
export GITHUB_TOKEN=...        # issues:write + pull_requests:write on the target repo
export ANTHROPIC_API_KEY=...   # or a Claude Code login
export CONTEXT7_API_KEY=...    # optional, for live docs
export OPENAI_API_KEY=...      # optional, for stages on OpenAI
export OPENROUTER_API_KEY=...  # optional, for stages on OpenRouter

# Label issues `factory:ready` on GitHub, then:
./bin/factory.js run            # shows the plan, asks to confirm, runs the batch
./bin/factory.js status         # per-issue stage, attempt, time, cost
./bin/factory.js serve          # control UI at http://127.0.0.1:4173
```

Ctrl-C once stops new issues from starting and lets in-flight work finish. Ctrl-C twice cancels,
releases every claim, and cleans up every sandbox.

## Control UI

```bash
./bin/factory.js serve --demo   # zero-cost demo: scripted agents, real repo/sandboxes/tests/merges
./bin/factory.js serve          # the real factory (same env vars as `factory run`)
```

Open the printed URL (`http://127.0.0.1:4173`). The UI has these views:

- **Live:** a factory floor where issues move through Triage → Build → Verify → Review → Integrate → Shipped. It also shows concurrency lanes, a live feed of every agent's tool calls, spend against budget, and Start / Drain / Cancel controls.
- **Issue drawer:** a stage timeline (Gantt chart), acceptance criteria, the verifier's real check output, reviewer findings, merge outcome, and per-issue cancel.
- **History:** every batch, benchmark and improvement run, replayed exactly from its event log.
- **Benchmark:** resolve rate per run, a table view, and reference / factory runs.
- **Improvement:** candidates with hypothesis, gate decision, champion vs candidate scores, PR and revert.
- **Settings:** the effective config after policy is applied, credential presence, and isolation warnings.

The server binds to 127.0.0.1. Write actions need a per-session token embedded in the page, and requests from any
other host or origin are rejected. Everything is driven by one typed event stream (`runs/<batch>/events.jsonl`)
and one reducer shared by the server and the browser.

## Model providers

Each stage can run on a different provider. Claude (`anthropic`) is the default and runs through
the Claude Agent SDK. OpenAI, OpenRouter, and any other server with an OpenAI-compatible
`/chat/completions` endpoint (Together, Groq, vLLM, Ollama, LM Studio and so on) run through the
factory's own agent loop. It uses the same typed outputs, tool allowlists, budgets, timeouts, live
activity and transcripts.

```ts
stages: {
  triage:   { provider: "openrouter", model: "<vendor>/<model>", effort: "low" },
  worker:   { provider: "anthropic",  model: "claude-opus-5-5",  effort: "high" },
  reviewer: { provider: "openai",     model: "<model-id>",       effort: "medium" },
},
providers: {
  // "openai" and "openrouter" are presets; declare only what you want to add or change.
  openai: { pricing: { "<model-id>": { inputPerMTok: 0, outputPerMTok: 0 } }, reasoningStyle: "openai" },
  openrouter: { reasoningStyle: "openrouter" },          // cost comes from OpenRouter's usage.cost
  local: { type: "openai-compatible", baseUrl: "http://localhost:11434/v1", allowUnpriced: true },
  together: { type: "openai-compatible", baseUrl: "https://api.together.xyz/v1", apiKeyEnv: "TOGETHER_API_KEY",
              pricing: { "<model-id>": { inputPerMTok: 0, outputPerMTok: 0 } } },
},
```

- **Cost and budgets.** Cost comes from the provider when it reports it (OpenRouter), otherwise from
  your `pricing` table (USD per million tokens). The factory doesn't ship prices, because they
  change. A stage on a provider with neither is a config error unless you set `allowUnpriced: true`,
  which turns off budget enforcement for that provider.
- **Effort** is sent only if you opt in with `reasoningStyle` (`"openai"` sends `reasoning_effort`,
  `"openrouter"` sends `reasoning.effort`), since many models reject it.
- **Tools.** Non-Claude stages get factory-implemented `Read`, `Write`, `Edit`, `Glob`, `Grep` and
  `Bash` tools. File tools can't leave the sandbox, even through symlinks. Bash runs in the sandbox
  (inside the container with `docker`) with every provider and GitHub key removed.
- **Keys** are read by the factory process and never passed to agents or sandboxes. Model calls
  come from the host, so the Docker egress allowlist doesn't need the provider's host.
- **Limitation:** Context7 live docs (MCP) are available to Claude stages only for now.
- The improver can tune a stage's model, effort and turn limit, but never its provider.
- The Settings page shows each stage's provider and whether its key is set.

## Commands

| Command | What it does |
|---|---|
| `factory run [--issue 3,7] [--concurrency N] [--yes]` | Runs a batch over the ready issues |
| `factory status [batchId]` | Shows the latest (or named) batch |
| `factory bench --reference` | Scores the reference solutions (a sanity check on the benchmark itself) |
| `factory bench [--split holdout] [--repeat 3]` | Runs the whole factory on the TinyLinks benchmark and scores it with hidden tests |
| `factory improve [--max-usd 30]` | Collects failures, has the retrospective propose playbook changes, evaluates them on holdout, and opens a PR for the best one if it clears the gate |
| `factory improve --revert <candidateId>` | Opens a PR that exactly undoes an accepted improvement |
| `factory serve [--demo] [--port 4173]` | Serves the control UI (see above) |
| `factory dashboard` | Serves the older read-only dashboard |

## Self-improvement

The factory's behaviour lives in `playbooks/*.md` (one prompt per stage) and
`playbooks/stages.json` (per-stage model, effort and turn limits). That directory is the
**only** thing the improver may change, and the limit is enforced in code. `factory improve`:

1. Runs the train half of the benchmark and classifies each failure, deterministically: false
   pass, review miss, repeated verify failure, triage mistake, and so on.
2. Shows the failure clusters (train split only) to a retrospective agent, which proposes up to
   three playbook changes, each with a hypothesis.
3. Evaluates each change on the **holdout** half, several times.
4. Accepts a change only if the resolve rate rises by more than the measured noise band, with no
   regression in triage accuracy or false-pass rate, and cost per resolved issue at most 1.25×
   the current playbooks' (the champion's).
5. Opens a draft PR with the score table and records every candidate in `playbooks/HISTORY.jsonl`.

## The benchmark

`bench/tinylinks` is a small URL shortener with 10 real-shaped issues: 4 bugs, 5 features, and 1
deliberately vague issue that should be rejected. The hidden acceptance tests live outside the
fixture repo and never enter a sandbox. There are also reference solutions and seeded-defect
patches for measuring the reviewer. Results append to `bench/results.jsonl`.

## Sandboxes

- **`worktree`** (default): fast, local git worktrees. It isolates files only, so agents can
  still reach the network and the host. Good for personal use. The factory prints a warning.
- **`docker`**: one container per sandbox on an internal network. Its only route out is a gateway
  that enforces a hostname allowlist and injects API keys, so sandboxes hold only placeholders. The
  agent process itself runs inside the container. Recommended for teams.

For teams there's also `factory.policy.ts` next to the config. It can lower limits, add protected
paths and block tools, and repo config can't override it. A config can list several `repos` under
shared global limits, and every GitHub write and push is logged to `runs/audit.jsonl`.

## Development

```bash
npm test                     # unit + integ + contract (free; ~45 s)
npm run lint && npm run typecheck
npm run spec:coverage        # every spec test ID must have a test
FACTORY_E2E=1 npx vitest run --project e2e   # real Claude; costs money
# Real OpenAI / OpenRouter run of benchmark issue 1 (T9.8):
FACTORY_E2E=1 OPENROUTER_API_KEY=... FACTORY_E2E_OPENAI_MODEL=<vendor>/<model> npx vitest run --project e2e test/providers.e2e.test.ts
```

Test tiers: **unit** (fakes only), **integ** (real git and sandboxes, scripted agents),
**contract** (recorded GitHub API exchanges), **e2e** (real Claude, opt-in). The offline benchmark
test runs the whole loop with scripted agents: 10 issues, 4 in parallel, real merge conflicts, and
hidden-test scoring.

Architecture reference: "How to Build a Self-Improving AI Software Factory That Actually Ships"
(Prompt Engineering, YouTube).
