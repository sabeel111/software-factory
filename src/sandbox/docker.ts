// Docker sandbox provider (specs/08-team-readiness.md R7.1, R7.3, R7.4).
//
// Files come from the worktree provider (host worktree + snapshot carry), bind-mounted into one
// container per sandbox. Containers sit on an --internal network whose only way out is the
// gateway container: an egress allowlist plus credential injection. Commands *and the agent
// itself* (via the Agent SDK's spawnClaudeCodeProcess) run inside the container, so agent tools
// can't touch the host, can't reach unlisted hosts, and never see real API keys.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { TIMEOUT_EXIT_CODE } from "./exec.js";
import { injectRoutesFromEnv, type InjectRoute } from "./gateway.js";
import type { AgentRuntime, ExecOptions, ExecResult, Sandbox, SnapshotId } from "./types.js";
import { WorktreeProvider, type WorktreeProviderOptions } from "./worktree.js";

const execFileP = promisify(execFile);
const GATEWAY_PORT = 3128;
const GATEWAY_SCRIPT = resolve(import.meta.dirname, "gateway.ts");
const FACTORY_NODE_MODULES = resolve(import.meta.dirname, "../../node_modules");
const PLACEHOLDER_KEY = "sk-ant-gateway-placeholder";
const CONTAINER_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export interface DockerProviderOptions extends WorktreeProviderOptions {
  image: string;
  egressAllowlist: string[];
  docker?: string;
  /** Credentials the gateway injects; defaults to the host's ANTHROPIC_API_KEY / CONTEXT7_API_KEY. */
  inject?: Record<string, InjectRoute>;
  /** Host paths mounted read-only so Claude Code can run inside the container. */
  toolMounts?: string[];
}

export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export async function dockerAvailable(docker = "docker"): Promise<boolean> {
  try {
    await execFileP(docker, ["info", "--format", "{{.ServerVersion}}"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export class DockerProvider extends WorktreeProvider {
  override readonly kind = "docker";
  readonly network: string;
  readonly gateway: string;
  private readonly docker: string;
  private readonly image: string;
  private readonly allowlist: string[];
  private readonly inject: Record<string, InjectRoute>;
  private readonly toolMounts: string[];
  private infra?: Promise<void>;

  constructor(opts: DockerProviderOptions) {
    super(opts);
    const tag = createHash("sha256").update(this.root).digest("hex").slice(0, 10);
    this.network = `sf-net-${tag}`;
    this.gateway = `sf-gw-${tag}`;
    this.docker = opts.docker ?? "docker";
    this.image = opts.image;
    this.allowlist = opts.egressAllowlist;
    this.inject = opts.inject ?? injectRoutesFromEnv();
    this.toolMounts = opts.toolMounts ?? [FACTORY_NODE_MODULES];
  }

  override warnings(): string[] {
    return this.inject.anthropic
      ? []
      : [
          "No ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN on the host: agents in containers can't reach Claude.",
        ];
  }

  private async run(...args: string[]): Promise<string> {
    const { stdout } = await execFileP(this.docker, args, { maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  }

  private get proxyEnv(): Record<string, string> {
    const url = `http://${this.gateway}:${GATEWAY_PORT}`;
    return {
      HTTPS_PROXY: url,
      HTTP_PROXY: url,
      https_proxy: url,
      http_proxy: url,
      NO_PROXY: this.gateway,
      no_proxy: this.gateway,
    };
  }

  /** The internal network and the gateway container (idempotent). */
  ensureInfra(): Promise<void> {
    this.infra ??= (async () => {
      const nets = await this.run("network", "ls", "--format", "{{.Name}}");
      if (!nets.split("\n").includes(this.network))
        await this.run("network", "create", "--internal", this.network);
      const running = await this.run("inspect", "-f", "{{.State.Running}}", this.gateway).catch(() => "");
      if (running === "true") return;
      await this.run("rm", "-f", this.gateway).catch(() => "");
      // Secrets go through an env file (mode 0600, deleted right after) — never on a command line.
      const dir = await mkdtemp(join(tmpdir(), "sf-gw-"));
      const envFile = join(dir, "env");
      try {
        const config = { port: GATEWAY_PORT, allowlist: this.allowlist, inject: this.inject };
        await writeFile(envFile, `GATEWAY_CONFIG=${JSON.stringify(config)}\n`, { mode: 0o600 });
        await chmod(envFile, 0o600);
        await this.run(
          "run",
          "-d",
          "--name",
          this.gateway,
          "--restart",
          "unless-stopped",
          "--env-file",
          envFile,
          "-v",
          `${dirname(GATEWAY_SCRIPT)}:/gateway:ro`,
          this.image,
          "node",
          "/gateway/gateway.ts",
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      await this.run("network", "connect", this.network, this.gateway);
    })();
    return this.infra;
  }

  private userFlags(): string[] {
    return typeof process.getuid === "function" ? ["--user", `${process.getuid()}:${process.getgid!()}`] : [];
  }

  /** Setup commands (e.g. npm ci) run in a throwaway container behind the gateway. */
  protected override async runSetup(cmd: string, cwd: string): Promise<ExecResult> {
    await this.ensureInfra();
    const started = Date.now();
    const env = Object.entries({ ...this.proxyEnv, HOME: "/tmp" }).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    try {
      const { stdout, stderr } = await execFileP(
        this.docker,
        [
          "run",
          "--rm",
          "--network",
          this.network,
          ...this.userFlags(),
          ...env,
          "-v",
          `${cwd}:${cwd}`,
          "-w",
          cwd,
          this.image,
          "bash",
          "-c",
          cmd,
        ],
        { maxBuffer: 64 * 1024 * 1024, timeout: 1800_000 },
      );
      return { exitCode: 0, stdout, stderr, durationMs: Date.now() - started };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      return {
        exitCode: typeof err.code === "number" ? err.code : 1,
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? String(e),
        durationMs: Date.now() - started,
      };
    }
  }

  override async create(opts: { snapshot: SnapshotId; label: string }): Promise<Sandbox> {
    await this.ensureInfra();
    const inner = await super.create(opts);
    const container = `sf-sbx-${inner.id}`.slice(0, 63);
    const snapshotDir = this.snapshotPath(opts.snapshot);
    const mounts = [
      "-v",
      `${inner.path}:${inner.path}`,
      // The worktree's git metadata lives in the snapshot's bare repo.
      "-v",
      `${snapshotDir}/repo.git:${snapshotDir}/repo.git`,
      ...this.toolMounts.flatMap((m) => ["-v", `${m}:${m}:ro`]),
    ];
    const env = Object.entries({ ...this.proxyEnv, HOME: "/tmp", PATH: CONTAINER_PATH }).flatMap(([k, v]) => [
      "-e",
      `${k}=${v}`,
    ]);
    try {
      await this.run(
        "run",
        "-d",
        "--name",
        container,
        "--network",
        this.network,
        "--security-opt",
        "no-new-privileges",
        "--cap-drop",
        "ALL",
        ...this.userFlags(),
        ...env,
        ...mounts,
        "-w",
        inner.path,
        this.image,
        "sleep",
        "infinity",
      );
    } catch (e) {
      await inner.destroy();
      throw e;
    }
    const entry = (await this.ledger.entries()).find((x) => x.id === inner.id);
    if (entry) {
      await this.ledger.remove(inner.id);
      await this.ledger.add({ ...entry, provider: this.kind, meta: { container } });
    }
    return new DockerSandbox(inner, container, this);
  }

  override async sweep(): Promise<string[]> {
    for (const e of await this.ledger.orphans()) {
      if (e.provider === this.kind && e.meta?.container)
        await this.run("rm", "-f", e.meta.container).catch(() => "");
    }
    // The base provider then removes the worktree half of every orphan of this.kind ("docker").
    return super.sweep();
  }

  /** @internal */
  dockerBin(): string {
    return this.docker;
  }

  /** @internal Environment for an agent running inside a sandbox container. */
  agentEnv(): Record<string, string> {
    const usesOAuth = Boolean(this.inject.anthropic?.headers.authorization);
    return {
      PATH: CONTAINER_PATH,
      HOME: "/tmp",
      ...this.proxyEnv,
      ANTHROPIC_BASE_URL: `http://${this.gateway}:${GATEWAY_PORT}/__inject/anthropic`,
      ...(usesOAuth ? { CLAUDE_CODE_OAUTH_TOKEN: PLACEHOLDER_KEY } : { ANTHROPIC_API_KEY: PLACEHOLDER_KEY }),
    };
  }

  /** @internal */
  gatewayUrl(): string {
    return `http://${this.gateway}:${GATEWAY_PORT}`;
  }
}

class DockerSandbox implements Sandbox {
  constructor(
    private readonly inner: Sandbox,
    readonly container: string,
    private readonly provider: DockerProvider,
  ) {}

  get id() {
    return this.inner.id;
  }
  get path() {
    return this.inner.path;
  }
  get branch() {
    return this.inner.branch;
  }

  exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const started = Date.now();
    const envFlags = Object.entries(opts.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    // `timeout` runs inside the container so the whole process tree dies there, not just docker exec.
    const inner = opts.timeoutSec
      ? ["timeout", "-k", "2", String(opts.timeoutSec), "bash", "-c", cmd]
      : ["bash", "-c", cmd];
    return new Promise((resolveExec) => {
      execFile(
        this.provider.dockerBin(),
        ["exec", "-w", this.path, ...envFlags, this.container, ...inner],
        { maxBuffer: 16 * 1024 * 1024, timeout: opts.timeoutSec ? (opts.timeoutSec + 10) * 1000 : 0 },
        (err, stdout, stderr) => {
          const code = err ? ((err as { code?: number }).code ?? 1) : 0;
          resolveExec({
            exitCode:
              typeof code === "number" ? (code === 137 || code === 124 ? TIMEOUT_EXIT_CODE : code) : 1,
            stdout,
            stderr,
            durationMs: Date.now() - started,
          });
        },
      );
    });
  }

  checkout(ref: string) {
    return this.inner.checkout(ref);
  }
  commit(message: string) {
    return this.inner.commit(message);
  }
  push(branch: string) {
    return this.inner.push(branch);
  }

  async destroy(): Promise<void> {
    await execFileP(this.provider.dockerBin(), ["rm", "-f", this.container]).catch(() => undefined);
    await this.inner.destroy();
  }

  agentRuntime(): AgentRuntime {
    const env = this.provider.agentEnv();
    const gatewayUrl = this.provider.gatewayUrl();
    return {
      env,
      exec: (cmd, o) => this.exec(cmd, o),
      spawn: (o) => {
        // `-e NAME` (no value) copies the variable from the docker client's environment, which we
        // set to the agent env — so values never appear on a command line.
        const agentVars = Object.entries(o.env).filter(([, v]) => v !== undefined) as [string, string][];
        return spawn(
          this.provider.dockerBin(),
          [
            "exec",
            "-i",
            "-w",
            o.cwd ?? this.path,
            ...agentVars.flatMap(([k]) => ["-e", k]),
            this.container,
            o.command,
            ...o.args,
          ],
          {
            env: { PATH: process.env.PATH, ...Object.fromEntries(agentVars) },
            stdio: ["pipe", "pipe", "pipe"],
            signal: o.signal,
          },
        );
      },
      rewriteMcp: (servers) =>
        Object.fromEntries(
          Object.entries(servers).map(([name, cfg]) => {
            const c = cfg as { type?: string; url?: string };
            if (c.type === "http" && c.url && new URL(c.url).hostname === "mcp.context7.com") {
              return [
                name,
                { type: "http", url: `${gatewayUrl}/__inject/context7${new URL(c.url).pathname}` },
              ];
            }
            return [name, cfg];
          }),
        ),
    };
  }
}
