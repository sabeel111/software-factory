# Phase 0 — Foundations

## Goal

A typed, tested TypeScript skeleton: the contracts, CLI shell, config loader,
run store and **fake adapters** that let every later phase be tested without
spending tokens.

## Scope

- In: repo tooling, `src/contracts`, config loading and validation, CLI command
  shell, run store, `AgentRunner` interface plus `FakeAgentRunner`, CI.
- Out: any real LLM call, GitHub call or sandbox.

## Requirements

| ID | Requirement |
|----|-------------|
| R0.1 | Node 22+, TypeScript strict mode, ESM. Test runner: `vitest`. Lint: `eslint` + `prettier`. |
| R0.2 | `src/contracts/` defines every type in Overview §4 with `zod`, and exports a JSON Schema for each (`zod-to-json-schema`). |
| R0.3 | `loadConfig(path)` validates `factory.config.ts` and returns a typed `FactoryConfig`. Invalid config fails with a message that names the offending key. Defaults fill unspecified limits. |
| R0.4 | CLI (`factory`) exposes `run`, `bench`, `improve`, `status` and `--help`. Commands not yet built exit with code 2 and the message "not implemented in this phase". |
| R0.5 | `AgentRunner` interface: `run({ stage, playbook, input, outputSchema, cwd, tools, limits }) → { output, usage, transcriptPath }`. The output **must** validate against `outputSchema`, or the call fails with `AgentOutputInvalid`. |
| R0.6 | `FakeAgentRunner` returns scripted outputs keyed by `(stage, issueNumber, attempt)` and can be scripted to throw, time out or return invalid output. |
| R0.7 | `RunStore` appends RunRecords to `runs/<batchId>/records.jsonl` and stores artifacts (transcripts, diffs, check output) under `runs/<batchId>/<runId>/`. Writes are crash-safe (write to a temp file, then rename). |
| R0.8 | Every RunRecord includes `factoryVersion` (git SHA) and `playbookHash` (hash of `playbooks/**`), so results are attributable to an exact factory state. |
| R0.9 | A spec-coverage script lists every `T<phase>.<n>` ID in `specs/*.md` and fails if any ID has no matching test title (skipped/todo tests count as "present but pending" and are reported). |
| R0.10 | GitHub Actions CI runs lint, typecheck, `unit`, `integ` and `contract` on every push. |

## Test cases

| ID | Tier | Given / When / Then |
|----|------|---------------------|
| T0.1 | unit | Given a valid `TriageResult` object, when it is parsed by its schema, then it passes; given `decision: "maybe"`, then it fails with a path of `decision`. |
| T0.2 | unit | Every contract's exported JSON Schema round-trips: a sample valid object validates against the JSON Schema with `ajv`. |
| T0.3 | unit | Given a config missing `limits`, when loaded, then all limit defaults from Overview §6 are applied. |
| T0.4 | unit | Given `limits.concurrency: 0`, when loaded, then loading fails and the error mentions `limits.concurrency`. |
| T0.5 | unit | `factory --help` lists the four commands; `factory improve` (unimplemented) exits with code 2. |
| T0.6 | unit | Given a FakeAgentRunner scripted to return `{decision:"accept"}` (missing required fields), when run with the TriageResult schema, then it throws `AgentOutputInvalid`. |
| T0.7 | unit | Given a FakeAgentRunner scripted per attempt, when the same stage is called twice for one issue, then attempt 1 and attempt 2 return their distinct scripted outputs. |
| T0.8 | integ | Given a RunStore, when a process is killed mid-write (simulated by throwing between the temp write and the rename), then `records.jsonl` contains no partial line. |
| T0.9 | unit | Given a spec containing `T9.99` and no matching test, when the coverage script runs, then it exits non-zero and names `T9.99`. |
| T0.10 | unit | Given two different `playbooks/` contents, then `playbookHash` differs; given identical contents, it is stable across runs. |

## Exit criteria

- `npm test` is green; CI is green on the branch.
- The spec-coverage script reports all T0.x as present and passing.
- `factory --help` works from a clean clone after `npm ci`.

## Deliverables

```
package.json  tsconfig.json  vitest.config.ts  .github/workflows/ci.yml
src/cli.ts
src/config.ts
src/contracts/*.ts
src/agents/runner.ts  src/agents/fake-runner.ts
src/store/run-store.ts
scripts/spec-coverage.ts
playbooks/{triage,worker,reviewer,integrator}.md   (initial drafts)
```
