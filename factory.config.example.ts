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

  // Where self-improvement PRs and factory issues go (optional).
  // selfRepo: "your-org/software-factory",
});
