// Copy to factory.config.ts and adjust. Every field except `repo` has a default.
import { defineConfig } from "./src/config.js";

export default defineConfig({
  repo: "your-org/your-repo",
  defaultBranch: "main",

  // "worktree" isolates files only (fine for personal use); "docker" adds an egress allowlist and
  // keeps API keys out of the sandbox entirely (recommended for teams).
  sandbox: { provider: "worktree", setup: ["npm ci"] },

  // The verifier runs these in a clean checkout; pass/fail comes only from exit codes.
  checks: [
    { name: "test", command: "npm test" },
    { name: "typecheck", command: "npx tsc --noEmit" },
  ],
  protectedPaths: [".github/**"],

  limits: {
    concurrency: 4,
    maxWorkerAttempts: 2,
    maxOpenPrs: 5,
    maxCostUsdPerIssue: 3,
    maxCostUsdPerRun: 25,
    stageTimeoutSec: 900,
  },

  // "integrated": one draft PR per batch with every verified change merged and re-verified.
  // "individual": one draft PR per issue.
  prMode: "integrated",

  // Model providers per stage. Unset stages use Claude ("anthropic"). "openai" and "openrouter" are
  // presets (keys from OPENAI_API_KEY / OPENROUTER_API_KEY); any OpenAI-compatible API can be added.
  // stages: {
  //   triage: { provider: "openrouter", model: "<vendor>/<model>", effort: "low" },
  //   reviewer: { provider: "openai", model: "<model-id>", effort: "medium" },
  // },
  // providers: {
  //   openai: { pricing: { "<model-id>": { inputPerMTok: 0, outputPerMTok: 0 } } }, // USD per 1M tokens
  //   local: { type: "openai-compatible", baseUrl: "http://localhost:11434/v1", allowUnpriced: true },
  // },

  // Where self-improvement PRs and factory issues go (optional).
  // selfRepo: "your-org/software-factory",
});
