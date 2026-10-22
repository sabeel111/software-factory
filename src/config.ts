// Factory configuration: schema, defaults and loading (specs/00-overview.md §6).
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

export const DEFAULT_MODEL = "claude-opus-5-5";

const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);

const StageConfig = z.object({
  model: z.string().default(DEFAULT_MODEL),
  effort: Effort.default("medium"),
  maxTurns: z.number().int().positive().optional(),
});
export type StageConfig = z.infer<typeof StageConfig>;

const stageDefault = (effort: z.infer<typeof Effort>) =>
  StageConfig.default({ model: DEFAULT_MODEL, effort });

export const Limits = z.object({
  concurrency: z.number().int().positive().default(4),
  maxWorkerAttempts: z.number().int().positive().default(2),
  maxOpenPrs: z.number().int().positive().default(5),
  maxCostUsdPerIssue: z.number().positive().default(3),
  maxCostUsdPerRun: z.number().positive().default(25),
  stageTimeoutSec: z.number().int().positive().default(900),
});
export type Limits = z.infer<typeof Limits>;

export const Check = z.object({ name: z.string().min(1), command: z.string().min(1) });
export type Check = z.infer<typeof Check>;

export const RepoConfig = z.object({
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "must be owner/name"),
  /** Clone URL or local path; defaults to https://github.com/<repo>.git */
  remote: z.string().optional(),
  defaultBranch: z.string().default("main"),
  sandbox: z
    .object({
      provider: z.enum(["worktree", "docker"]).default("worktree"),
      setup: z.array(z.string()).default(["npm ci"]),
      image: z.string().default("node:22"),
      egressAllowlist: z
        .array(z.string())
        .default(["registry.npmjs.org", "api.anthropic.com", "mcp.context7.com", "github.com"]),
    })
    .default({
      provider: "worktree",
      setup: ["npm ci"],
      image: "node:22",
      egressAllowlist: ["registry.npmjs.org", "api.anthropic.com", "mcp.context7.com", "github.com"],
    }),
  checks: z
    .array(Check)
    .min(1)
    .default([{ name: "test", command: "npm test" }]),
  protectedPaths: z.array(z.string()).default([".github/**"]),
  limits: Limits.default(Limits.parse({})),
  stages: z
    .object({
      triage: stageDefault("low"),
      worker: stageDefault("high"),
      reviewer: stageDefault("medium"),
      integrator: stageDefault("high"),
      retro: stageDefault("high"),
    })
    .default({
      triage: { model: DEFAULT_MODEL, effort: "low" },
      worker: { model: DEFAULT_MODEL, effort: "high" },
      reviewer: { model: DEFAULT_MODEL, effort: "medium" },
      integrator: { model: DEFAULT_MODEL, effort: "high" },
      retro: { model: DEFAULT_MODEL, effort: "high" },
    }),
  prMode: z.enum(["individual", "integrated"]).default("integrated"),
  docs: z.object({ context7: z.boolean().default(true) }).default({ context7: true }),
});

export const FactoryConfig = RepoConfig.extend({
  /** The factory's own GitHub repo (owner/name), where self-improvement PRs and issues go. */
  selfRepo: z.string().optional(),
  /** Additional repos for multi-repo operation (Phase 7); each inherits top-level settings it doesn't set. */
  repos: z.array(z.record(z.string(), z.unknown())).optional(),
  /** Paths that must never appear inside a sandbox (hidden tests, secrets). */
  secretPaths: z.array(z.string()).default([]),
});
export type FactoryConfig = z.infer<typeof FactoryConfig>;
export type FactoryConfigInput = z.input<typeof FactoryConfig>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function defineConfig(config: FactoryConfigInput): FactoryConfigInput {
  return config;
}

export function parseConfig(raw: unknown): FactoryConfig {
  const result = FactoryConfig.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new ConfigError(`Invalid factory config:\n${lines.join("\n")}`);
  }
  return result.data;
}

/** Stage-setting overrides owned by the Improver; they live with the playbooks (its only mutable surface). */
export const StageOverrides = z.record(
  z.string(),
  z.object({
    model: z.string().optional(),
    effort: Effort.optional(),
    maxTurns: z.number().int().positive().optional(),
  }),
);
export type StageOverrides = z.infer<typeof StageOverrides>;

export function applyStageOverrides(config: FactoryConfig, overrides: StageOverrides): FactoryConfig {
  const stages = { ...config.stages } as Record<string, StageConfig>;
  for (const [stage, o] of Object.entries(overrides)) {
    if (!stages[stage]) continue;
    stages[stage] = {
      ...stages[stage]!,
      ...Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)),
    };
  }
  return { ...config, stages: stages as FactoryConfig["stages"] };
}

export async function readStageOverrides(playbooksDir: string): Promise<StageOverrides> {
  const file = resolve(playbooksDir, "stages.json");
  if (!existsSync(file)) return {};
  return StageOverrides.parse(JSON.parse(await readFile(file, "utf8")));
}

export async function loadConfig(
  path = "factory.config.ts",
  playbooksDir = resolve(import.meta.dirname, "../playbooks"),
): Promise<FactoryConfig> {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new ConfigError(`Config file not found: ${abs}`);
  let raw: unknown;
  if (abs.endsWith(".json")) {
    raw = JSON.parse(await readFile(abs, "utf8"));
  } else {
    const { tsImport } = await import("tsx/esm/api");
    const mod = (await tsImport(pathToFileURL(abs).href, import.meta.url)) as { default?: unknown };
    raw = mod.default;
    // tsImport may wrap the module once more depending on how the file is classified (CJS vs ESM).
    if (raw && typeof raw === "object" && "default" in raw && !("repo" in raw))
      raw = (raw as { default: unknown }).default;
  }
  return applyStageOverrides(parseConfig(raw), await readStageOverrides(playbooksDir));
}
