// Factory configuration: schema, defaults and loading (specs/00-overview.md §6).
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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
  /** Agent tools that must never be granted (set by org policy). */
  blockedTools: z.array(z.string()).default([]),
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

/** Each repo of a multi-repo config, with top-level settings inherited where the repo doesn't set them. */
export function resolveRepos(config: FactoryConfig): FactoryConfig[] {
  if (!config.repos?.length) return [config];
  const { repos, ...top } = config;
  return repos.map((r, i) => {
    const merged = { ...top, ...r, limits: { ...top.limits, ...((r.limits as object) ?? {}) } };
    const parsed = FactoryConfig.safeParse(merged);
    if (!parsed.success) {
      const lines = parsed.error.issues.map((x) => `  repos.${i}.${x.path.join(".")}: ${x.message}`);
      throw new ConfigError(`Invalid factory config:\n${lines.join("\n")}`);
    }
    return parsed.data;
  });
}

// ── Org policy (specs/08-team-readiness.md R7.8) ─────────────────────────────

export const Policy = z.object({
  /** Upper bounds: a repo may set lower limits, never higher. */
  limits: Limits.partial().default({}),
  /** Added to every repo's protected paths. */
  protectedPaths: z.array(z.string()).default([]),
  /** Tools no agent may use. */
  blockedTools: z.array(z.string()).default([]),
});
export type Policy = z.infer<typeof Policy>;

export function definePolicy(policy: z.input<typeof Policy>): z.input<typeof Policy> {
  return policy;
}

export function applyPolicy(config: FactoryConfig, policyInput: z.input<typeof Policy>): FactoryConfig {
  const policy = Policy.parse(policyInput);
  const limits = { ...config.limits };
  for (const [k, cap] of Object.entries(policy.limits) as [keyof Limits, number][]) {
    if (cap !== undefined) limits[k] = Math.min(limits[k], cap);
  }
  return {
    ...config,
    limits,
    protectedPaths: [...new Set([...config.protectedPaths, ...policy.protectedPaths])],
    blockedTools: [...new Set([...config.blockedTools, ...policy.blockedTools])],
  };
}

async function importDefault(abs: string): Promise<unknown> {
  const { tsImport } = await import("tsx/esm/api");
  const mod = (await tsImport(pathToFileURL(abs).href, import.meta.url)) as { default?: unknown };
  let raw = mod.default;
  if (raw && typeof raw === "object" && "default" in raw && Object.keys(raw).length === 1) {
    raw = (raw as { default: unknown }).default;
  }
  return raw;
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
  let config = applyStageOverrides(parseConfig(raw), await readStageOverrides(playbooksDir));
  // The org policy sits next to the config and always wins (repo config can't override it).
  const policyPath = resolve(dirname(abs), "factory.policy.ts");
  if (existsSync(policyPath))
    config = applyPolicy(config, (await importDefault(policyPath)) as z.input<typeof Policy>);
  return config;
}
