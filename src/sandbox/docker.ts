// Docker sandbox provider — implemented in Phase 7.
import type { WorktreeProviderOptions } from "./worktree.js";
import { WorktreeProvider } from "./worktree.js";

export interface DockerProviderOptions extends WorktreeProviderOptions {
  image: string;
  egressAllowlist: string[];
}

export class DockerProvider extends WorktreeProvider {
  constructor(_opts: DockerProviderOptions) {
    super(_opts);
    throw new Error("The docker sandbox provider arrives in Phase 7");
  }
}
