// Dispatches each agent run to the runner for its stage's provider (specs/10-model-providers.md).
import { type FactoryConfig, providerKeyEnvs, resolveProvider } from "../config.js";
import { ClaudeAgentRunner, type ClaudeRunnerOptions } from "./claude-runner.js";
import { OpenAICompatRunner, type OpenAICompatOptions } from "./openai-runner.js";
import type { AgentRunner, AgentRunRequest, AgentRunResult } from "./runner.js";

export class RoutingRunner implements AgentRunner {
  private readonly cache = new Map<string, AgentRunner>();

  constructor(private readonly resolve: (provider: string) => AgentRunner) {}

  run<T>(req: AgentRunRequest<T>): Promise<AgentRunResult<T>> {
    const name = req.provider ?? "anthropic";
    let runner = this.cache.get(name);
    if (!runner) {
      runner = this.resolve(name);
      this.cache.set(name, runner);
    }
    return runner.run(req);
  }
}

export interface CreateRunnerOptions {
  claude?: ClaudeRunnerOptions;
  /** Overrides for OpenAI-compatible runners (tests: fetchFn, retry timing). */
  openai?: Partial<Omit<OpenAICompatOptions, "name" | "provider">>;
}

/** The production runner: Claude through the Agent SDK, everything else through the factory's own loop. */
export function createRunner(
  config: Pick<FactoryConfig, "providers">,
  opts: CreateRunnerOptions = {},
): AgentRunner {
  const secretEnvs = providerKeyEnvs(config);
  return new RoutingRunner((name) => {
    const provider = resolveProvider(config, name);
    if (provider.type === "anthropic") return new ClaudeAgentRunner({ secretEnvs, ...opts.claude });
    return new OpenAICompatRunner({ name, provider, secretEnvs, ...opts.openai });
  });
}
