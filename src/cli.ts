// `factory` command-line entry point (specs/01-foundations.md R0.4).
import { Command, CommanderError } from "commander";

export const NOT_IMPLEMENTED_EXIT = 2;

export type CommandHandler = (args: Record<string, unknown>, positional: string[]) => Promise<number>;

/** Handlers are registered by later phases; an unregistered command exits 2. */
const handlers = new Map<string, CommandHandler>();

export function registerCommand(name: string, handler: CommandHandler): void {
  handlers.set(name, handler);
}

interface CommandSpec {
  name: string;
  description: string;
  args?: string;
  options: [flags: string, description: string, defaultValue?: string | boolean][];
}

const COMMANDS: CommandSpec[] = [
  {
    name: "run",
    description: "Pull ready issues and run them through the pipeline",
    options: [
      ["-c, --config <path>", "config file", "factory.config.ts"],
      ["-i, --issue <numbers>", "only these issue numbers (comma-separated)"],
      ["--concurrency <n>", "override limits.concurrency"],
      ["--yes", "skip the plan confirmation prompt", false],
    ],
  },
  {
    name: "bench",
    description: "Run the TinyLinks benchmark and score it with hidden tests",
    options: [
      ["--reference", "score the reference solutions instead of running the factory", false],
      ["--split <split>", "train | holdout | all", "all"],
      ["--repeat <n>", "repeat runs to measure noise", "1"],
      ["--candidate <ref>", "score an existing git ref of the benchmark repo"],
      ["-c, --config <path>", "factory config used for the benchmark run"],
    ],
  },
  {
    name: "improve",
    description: "Propose, evaluate and promote playbook improvements",
    options: [
      ["-c, --config <path>", "config file", "factory.config.ts"],
      ["--max-usd <usd>", "hard budget for the whole improvement run", "30"],
      ["--revert <candidateId>", "open a PR reverting an accepted candidate"],
    ],
  },
  {
    name: "status",
    description: "Show per-issue progress and totals for a batch",
    args: "[batchId]",
    options: [["--runs <dir>", "run store directory", "runs"]],
  },
  {
    name: "serve",
    description: "Serve the control UI (start/drain/cancel batches, live observation)",
    options: [
      ["-c, --config <path>", "config file", "factory.config.ts"],
      ["--port <port>", "port", "4173"],
      ["--demo", "zero-cost demo: scripted agents on the TinyLinks benchmark", false],
      ["--speed <factor>", "demo pace multiplier (1 = normal, 0.2 = fast)", "1"],
    ],
  },
  {
    name: "dashboard",
    description: "Serve the read-only web dashboard",
    options: [
      ["--runs <dir>", "run store directory", "runs"],
      ["--port <port>", "port", "4173"],
    ],
  },
];

export function buildProgram(
  out: { log: (s: string) => void; err: (s: string) => void },
  registry: ReadonlyMap<string, CommandHandler> = handlers,
): {
  program: Command;
  result: { code: number };
} {
  const result = { code: 0 };
  const program = new Command("factory")
    .description("Self-improving AI software factory")
    .exitOverride()
    .configureOutput({ writeOut: (s) => out.log(s.trimEnd()), writeErr: (s) => out.err(s.trimEnd()) });

  for (const spec of COMMANDS) {
    const cmd = program
      .command(spec.args ? `${spec.name} ${spec.args}` : spec.name)
      .description(spec.description);
    for (const [flags, desc, def] of spec.options) cmd.option(flags, desc, def);
    cmd.action(async (...actionArgs: unknown[]) => {
      const command = actionArgs[actionArgs.length - 1] as Command;
      const opts = command.opts();
      const positional = command.args;
      const handler = registry.get(spec.name);
      if (!handler) {
        out.err(`factory ${spec.name}: not implemented in this phase`);
        result.code = NOT_IMPLEMENTED_EXIT;
        return;
      }
      result.code = await handler(opts, positional);
    });
  }
  return { program, result };
}

export async function main(
  argv: string[],
  out = { log: (s: string) => console.log(s), err: (s: string) => console.error(s) },
): Promise<number> {
  await import("./commands/index.js");
  const { program, result } = buildProgram(out);
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode;
    // Expected failures (bad config, missing access) get a clean one-line message.
    const name = (e as Error).name;
    if (name === "ConfigError" || name === "GitHubError") {
      out.err(`factory: ${(e as Error).message}`);
      return 1;
    }
    throw e;
  }
  return result.code;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2));
}
