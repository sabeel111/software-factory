import { sandboxSuite } from "./helpers/sandbox-suite.js";
import { WorktreeProvider } from "../src/sandbox/worktree.js";

sandboxSuite("worktree", (opts) => new WorktreeProvider(opts));
