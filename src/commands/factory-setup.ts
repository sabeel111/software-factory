// Shared wiring for commands that run the factory against a real repository.
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FactoryConfig } from "../config.js";
import type { SandboxProvider } from "../sandbox/types.js";
import { gitHubAuthEnv, WorktreeProvider } from "../sandbox/worktree.js";

export function githubToken(): string | undefined {
  return process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
}

export async function createProvider(
  config: FactoryConfig,
  opts: { token?: string; root?: string; secretPaths?: string[] } = {},
): Promise<SandboxProvider> {
  const common = {
    root: opts.root ?? join(tmpdir(), "software-factory"),
    defaultBranch: config.defaultBranch,
    secretPaths: [...config.secretPaths, ...(opts.secretPaths ?? [])],
    gitAuthEnv: opts.token ? gitHubAuthEnv(opts.token) : undefined,
  };
  if (config.sandbox.provider === "docker") {
    const { DockerProvider } = await import("../sandbox/docker.js");
    return new DockerProvider({
      ...common,
      image: config.sandbox.image,
      egressAllowlist: config.sandbox.egressAllowlist,
    });
  }
  return new WorktreeProvider(common);
}

export function repoUrl(config: FactoryConfig): string {
  return config.remote ?? `https://github.com/${config.repo}.git`;
}
