// Docker provider: the full Phase 2 contract plus egress and credential isolation.
// Runs only where a Docker daemon is available (CI job with Docker, or a developer machine).
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareBenchRepo } from "../src/bench/benchmark.js";
import { DockerProvider, dockerAvailable } from "../src/sandbox/docker.js";
import { sandboxSuite } from "./helpers/sandbox-suite.js";

const available = await dockerAvailable();
const IMAGE = process.env.FACTORY_DOCKER_IMAGE ?? "node:22";
const REAL_KEY = "sk-ant-test-REAL-KEY-should-never-be-visible";

const make = (opts: { root: string; secretPaths?: string[] }) =>
  new DockerProvider({
    ...opts,
    image: IMAGE,
    egressAllowlist: ["registry.npmjs.org"],
    inject: { anthropic: { upstream: "https://api.anthropic.com", headers: { "x-api-key": REAL_KEY } } },
  });

describe.skipIf(!available)("docker provider", () => {
  it("T7.1 runs the full Phase 2 sandbox suite", () => {
    expect(make({ root: tmpdir() }).kind).toBe("docker");
  });

  sandboxSuite("docker", make);

  it("T7.2 egress is limited to the allowlist", async () => {
    const bench = await prepareBenchRepo(await mkdtemp(join(tmpdir(), "egress-")));
    const p = make({ root: await mkdtemp(join(tmpdir(), "egress-root-")) });
    const snap = await p.prepareSnapshot({ repoUrl: bench.dir, ref: "main", setup: [] });
    const box = await p.create({ snapshot: snap, label: "egress" });
    try {
      const blocked = await box.exec("curl -sS -m 10 https://example.com -o /dev/null", { timeoutSec: 30 });
      expect(blocked.exitCode).not.toBe(0);
      const direct = await box.exec("curl -sS -m 10 --noproxy '*' https://registry.npmjs.org -o /dev/null", {
        timeoutSec: 30,
      });
      expect(direct.exitCode).not.toBe(0);
      const allowed = await box.exec("npm view left-pad version", { timeoutSec: 60 });
      expect(allowed.exitCode, allowed.stderr).toBe(0);
    } finally {
      await box.destroy();
    }
  });

  it("T7.3 credentials never enter the sandbox, but requests through the gateway carry them", async () => {
    const bench = await prepareBenchRepo(await mkdtemp(join(tmpdir(), "cred-")));
    const p = make({ root: await mkdtemp(join(tmpdir(), "cred-root-")) });
    const snap = await p.prepareSnapshot({ repoUrl: bench.dir, ref: "main", setup: [] });
    const box = await p.create({ snapshot: snap, label: "cred" });
    try {
      const env = await box.exec("env");
      expect(env.stdout).not.toContain(REAL_KEY);
      const grep = await box.exec(
        `grep -rIl --exclude-dir=proc --exclude-dir=sys -s '${REAL_KEY}' / || true`,
        { timeoutSec: 120 },
      );
      expect(grep.stdout.trim()).toBe("");
      const runtime = box.agentRuntime!();
      expect(JSON.stringify(runtime.env)).not.toContain(REAL_KEY);
      // The gateway answers on the injection route (Anthropic rejects the fake key, proving it was sent upstream).
      const r = await box.exec(
        `curl -s -o /dev/null -w '%{http_code}' -X POST ${runtime.env.ANTHROPIC_BASE_URL}/v1/messages -H 'content-type: application/json' -d '{}'`,
        { timeoutSec: 30 },
      );
      expect(["400", "401"]).toContain(r.stdout.trim());
    } finally {
      await box.destroy();
    }
  });
});
