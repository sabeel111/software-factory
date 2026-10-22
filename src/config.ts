// Factory configuration: schema, defaults and loading (specs/00-overview.md §6).
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

export const DEFAULT_MODEL = "claude-opus-5-5";

const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);

const StageConfig = z.object({
  /** Which model provider runs this stage (specs/10-model-providers.md); unset means "anthropic". */
  provider: z.string().optional(),
  model: z.string().default(DEFAULT_MODEL),
  effort: Effort.default("medium"),
  maxTurns: z.number().int().positive().optional(),
});
export type StageConfig = z.infer<typeof StageConfig>;

const stageDefault = (effort: z.infer<typeof Effort>) =>
  StageConfig.default({ model: DEFAULT_MODEL, effort });

// ── Model providers (specs/10-model-providers.md) ──────────────────────────────

export const ModelPricing = z.object({
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
});
export type ModelPricing = z.infer<typeof ModelPricing>;

export const ProviderConfig = z.object({
  type: z.enum(["anthropic", "openai-compatible"]).default("openai-compatible"),
  /** Chat Completions base URL, e.g. https://api.openai.com/v1 */
  baseUrl: z.string().url().optional(),
  /** Host environment variable holding the API key (never passed to agents). */
  apiKeyEnv: z.string().optional(),
  /** Extra request headers (e.g. OpenRouter's HTTP-Referer / X-Title). */
  headers: z.record(z.string(), z.string()).default({}),
  /** USD per million tokens, per model id. */
  pricing: z.record(z.string(), ModelPricing).default({}),
  /** The provider reports the cost of each request (OpenRouter `usage.cost`). */
  usageCost: z.boolean().default(false),
  /** Run without cost data (local models): budgets can't be enforced. */
  allowUnpriced: z.boolean().default(false),
  /** How effort is sent: OpenAI `reasoning_effort`, OpenRouter `reasoning.effort`, or not at all. */
  reasoningStyle: z.enum(["openai", "openrouter", "none"]).default("none"),
});
export type ProviderConfig = z.infer<typeof ProviderConfig>;

/** A provider as written in config: no defaults, so a partial declaration never resets a preset. */
const ProviderDeclaration = z
  .object({
    type: ProviderConfig.shape.type.unwrap(),
    baseUrl: z.string().url(),
    apiKeyEnv: z.string(),
    headers: z.record(z.string(), z.string()),
    pricing: z.record(z.string(), ModelPricing),
    usageCost: z.boolean(),
    allowUnpriced: z.boolean(),
    reasoningStyle: ProviderConfig.shape.reasoningStyle.unwrap(),
  })
  .partial();

/** Providers that work without a declaration; a declaration with the same name is merged over these. */
export const PROVIDER_PRESETS: Record<string, z.input<typeof ProviderConfig>> = {
  anthropic: { type: "anthropic" },
  openai: { type: "openai-compatible", baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" },
  openrouter: {
    type: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    usageCost: true,
    headers: { "X-Title": "software-factory" },
  },
};

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
  /** Model providers by name; "anthropic", "openai" and "openrouter" are presets. */
  providers: z.record(z.string(), ProviderDeclaration).default({}),
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
  validateProviders(result.data);
  return result.data;
}

/** A provider's effective settings: preset merged with the config's declaration. */
export function resolveProvider(config: Pick<FactoryConfig, "providers">, name: string): ProviderConfig {
  const preset = PROVIDER_PRESETS[name];
  const declared = config.providers[name];
  if (!preset && !declared) {
    throw new ConfigError(
      `Unknown model provider "${name}". Declare it under providers (presets: ${Object.keys(PROVIDER_PRESETS).join(", ")}).`,
    );
  }
  return ProviderConfig.parse({
    ...preset,
    ...declared,
    headers: { ...preset?.headers, ...declared?.headers },
    pricing: { ...preset?.pricing, ...declared?.pricing },
  });
}

export const stageProvider = (s: Pick<StageConfig, "provider">): string => s.provider ?? "anthropic";

/** R9.1 / R9.5: every stage's provider exists, can reach an API, and can be priced. */
export function validateProviders(config: FactoryConfig): void {
  for (const [stage, s] of Object.entries(config.stages) as [string, StageConfig][]) {
    const name = stageProvider(s);
    let p: ProviderConfig;
    try {
      p = resolveProvider(config, name);
    } catch (e) {
      throw new ConfigError(`stages.${stage}.provider: ${(e as Error).message}`);
    }
    if (p.type !== "openai-compatible") continue;
    if (!p.baseUrl) throw new ConfigError(`providers.${name}.baseUrl is required (used by stages.${stage})`);
    if (!p.usageCost && !p.allowUnpriced && !p.pricing[s.model]) {
      throw new ConfigError(
        `providers.${name}: no pricing for model "${s.model}" (used by stages.${stage}). ` +
          `Add providers.${name}.pricing["${s.model}"] = { inputPerMTok, outputPerMTok }, ` +
          `or set allowUnpriced: true (budgets can't then be enforced).`,
      );
    }
  }
}

/** Environment variables that hold provider keys (stripped from every agent and tool environment). */
export function providerKeyEnvs(config: Pick<FactoryConfig, "providers">): string[] {
  const names = new Set<string>();
  for (const n of new Set([...Object.keys(PROVIDER_PRESETS), ...Object.keys(config.providers)])) {
    const env = resolveProvider(config, n).apiKeyEnv;
    if (env) names.add(env);
  }
  return [...names];
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
  validateProviders(config);
  // The org policy sits next to the config and always wins (repo config can't override it).
  const policyPath = resolve(dirname(abs), "factory.policy.ts");
  if (existsSync(policyPath))
    config = applyPolicy(config, (await importDefault(policyPath)) as z.input<typeof Policy>);
  return config;
}
