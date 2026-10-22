// Unit-tier sandbox provider: no git, no processes. Exec results are scripted.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, Sandbox, SandboxProvider } from "../../src/sandbox/types.js";
import { assertPushable } from "../../src/sandbox/types.js";

export type ExecHandler = (cmd: string, box: FakeSandbox) => Partial<ExecResult> | undefined;

export class FakeSandbox implements Sandbox {
  destroyed = false;
  head = "base000";
  commits = 0;
  pushed: string[] = [];

  constructor(
    readonly id: string,
    readonly path: string,
    readonly branch: string,
    private readonly provider: FakeSandboxProvider,
  ) {}

  async exec(cmd: string): Promise<ExecResult> {
    const r = this.provider.execHandler(cmd, this) ?? {};
    return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, ...r };
  }

  async checkout(ref: string): Promise<void> {
    this.head = ref;
  }

  async commit(): Promise<string> {
    this.commits++;
    this.head = `sha-${this.id}-${this.commits}`;
    return this.head;
  }

  async push(branch: string): Promise<void> {
    assertPushable(branch, "main");
    this.pushed.push(branch);
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    await rm(this.path, { recursive: true, force: true });
  }
}

export class FakeSandboxProvider implements SandboxProvider {
  readonly kind = "fake";
  readonly created: FakeSandbox[] = [];
  execHandler: ExecHandler = () => undefined;

  async prepareSnapshot(): Promise<string> {
    return "snap";
  }

  async create(opts: { snapshot: string; label: string }): Promise<Sandbox> {
    const path = await mkdtemp(join(tmpdir(), `fake-${opts.label}-`));
    const box = new FakeSandbox(
      `${opts.label}-${this.created.length}`,
      path,
      `factory/sandbox/${opts.label}`,
      this,
    );
    this.created.push(box);
    return box;
  }

  async snapshotCommit(): Promise<string> {
    return "base000";
  }

  async sweep(): Promise<string[]> {
    return [];
  }

  warnings(): string[] {
    return [];
  }

  get live(): FakeSandbox[] {
    return this.created.filter((b) => !b.destroyed);
  }
}
