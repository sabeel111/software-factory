# Phase 9 — Model Providers

## Goal

Run any stage on Claude, on OpenAI, or on any OpenAI-compatible API (OpenRouter, Together, Groq,
vLLM, Ollama, …), chosen per stage in config, with the same guarantees as before: typed outputs,
tool allowlists, sandbox confinement, budgets, timeouts, live activity and transcripts.

## Design

```
stage config ─► provider name ─► RoutingRunner ─┬─► ClaudeAgentRunner   (Claude Agent SDK: built-in tools + loop)
                                                └─► OpenAICompatRunner  (our loop over /chat/completions
                                                                         + factory-implemented tools)
```

- **Claude** keeps using the Claude Agent SDK (`provider: "anthropic"`, the default).
- **OpenAI-compatible** providers get the factory's own agent loop over the Chat Completions API,
  the most widely implemented API shape. Tools are function tools that the factory implements:
  `Read`, `Write`, `Edit`, `Glob`, `Grep` and `Bash`. File tools are confined to the sandbox
  directory. Bash runs in the sandbox (inside the container with the Docker provider).
- **Structured output** comes from a `submit_result` function tool whose parameters are the stage's
  JSON Schema. The factory validates the call against the schema, and an invalid call is answered
  with the validation errors so the model can retry.
- **Keys stay out of sandboxes.** Model calls are made by the factory process, never from the
  sandbox. Provider API keys are read from the host environment and stripped from every agent's
  and every Bash tool's environment.

### Config

```ts
providers: {
  // Presets: "openai" and "openrouter" work without a declaration (base URL + key env).
  openrouter: { usageCost: true },                 // OpenRouter reports cost per request
  openai:     { pricing: { "<model-id>": { inputPerMTok: 2, outputPerMTok: 8 } } },
  local:      { type: "openai-compatible", baseUrl: "http://localhost:11434/v1", allowUnpriced: true },
},
stages: {
  triage: { provider: "openrouter", model: "<vendor>/<model>", effort: "low" },
  worker: { provider: "anthropic",  model: "claude-opus-5-5", effort: "high" },
}
```

## Requirements

| ID | Requirement |
|----|-------------|
| R9.1 | Each stage (`triage`, `worker`, `reviewer`, `integrator`, `retro`) has an optional `provider`, defaulting to `anthropic`. A stage naming an undeclared provider that isn't a preset is a config error that names the stage. |
| R9.2 | The `openai-compatible` runner implements the `AgentRunner` contract: playbook as the system prompt, tool allowlist (blocked tools never offered), structured output validated against the stage schema, `maxTurns`, `maxBudgetUsd`, `timeoutSec`, cancellation, `onActivity` and a JSONL transcript. |
| R9.3 | File tools reject any path that resolves outside the sandbox, including through symlinks. `Edit` requires `old_string` to match exactly once unless `replace_all` is set. Tool output is truncated to a bounded size. |
| R9.4 | Bash runs in the sandbox (`AgentRuntime.exec` for containers) with an environment that has no provider keys, GitHub tokens, or `GIT_CONFIG_*` credentials. |
| R9.5 | Cost per request is the provider-reported cost when available (`usage.cost`, e.g. OpenRouter with `usageCost`), otherwise computed from configured per-model pricing. A provider with neither and without `allowUnpriced: true` is a config error, because budgets couldn't be enforced. |
| R9.6 | Transient failures (429, 5xx, network) are retried with backoff and `Retry-After`; other 4xx fail the stage with the provider's error message. |
| R9.7 | Effort maps to the provider's reasoning parameter only when the provider opts in (`reasoningStyle: "openai"` sends `reasoning_effort`; `"openrouter"` sends `reasoning.effort`); otherwise it isn't sent, since many models reject it. |
| R9.8 | The Settings page and `/api/env` show each stage's provider, and which provider keys are present (never their values). |

## Test cases

| ID | Tier | Given / When / Then |
|----|------|---------------------|
| T9.1 | unit | Config: stages default to `anthropic`; the `openai`/`openrouter` presets resolve without declarations; an undeclared provider fails and names the stage; an unpriced provider without `allowUnpriced` fails and names the provider. |
| T9.2 | integ | Against a scripted local Chat Completions server: the runner sends the playbook as the system message and the auth header, executes `Read` then `Edit` in the sandbox, and returns the validated `submit_result`. Cost comes from pricing × usage, activity is emitted per tool call, and the transcript is written. |
| T9.3 | integ | An invalid `submit_result` is answered with the schema error and the corrected call succeeds; a model that never submits fails after `maxTurns`; spending past `maxBudgetUsd` fails with the cost so far. |
| T9.4 | unit | File tools reject `../`, absolute paths outside the sandbox, and symlinks pointing outside it; `Edit` fails on zero or multiple matches; Bash sees no provider/GitHub keys. |
| T9.5 | integ | A 500 then a 200 succeeds after one retry; a 401 fails at once with the provider's message; provider-reported `usage.cost` is used when present. |
| T9.6 | unit | The routing runner sends each stage to the runner for its provider, and blocked tools are not offered to an OpenAI-compatible model. |
| T9.7 | integ | The whole single-issue pipeline runs on TinyLinks with every stage on a scripted OpenAI-compatible server: triage accepts, the worker fixes the bug with `Edit`, the verifier's real `npm test` passes, the reviewer approves, and a draft PR is opened. |
| T9.8 | e2e | Opt-in (`FACTORY_E2E=1` plus `OPENAI_API_KEY` or `OPENROUTER_API_KEY` plus `FACTORY_E2E_OPENAI_MODEL`): benchmark issue 1 with every stage on that provider produces a branch whose hidden test passes. |

## Exit criteria

- All non-e2e T9.x tests green; `factory serve` Settings shows per-stage providers.
- README documents configuring OpenAI, OpenRouter and a local server.
