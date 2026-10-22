// The egress/credential gateway, exercised on the host (no Docker needed).
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { connect, createServer as createTcpServer, type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hostAllowed, injectRoutesFromEnv, startGateway } from "../src/sandbox/gateway.js";

let upstream: Server;
let upstreamPort: number;
let seen: IncomingHttpHeaders[] = [];
let gateway: Server;
let gatewayPort: number;
let tcp: ReturnType<typeof createTcpServer>;
let tcpPort: number;

beforeAll(async () => {
  upstream = createServer((req, res) => {
    seen.push(req.headers);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ path: req.url }));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamPort = (upstream.address() as AddressInfo).port;

  tcp = createTcpServer((s) => s.end("hello from upstream"));
  await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", r));
  tcpPort = (tcp.address() as AddressInfo).port;

  const g = await startGateway({
    port: 0,
    host: "127.0.0.1",
    allowlist: ["127.0.0.1", "registry.npmjs.org"],
    inject: {
      anthropic: { upstream: `http://127.0.0.1:${upstreamPort}`, headers: { "x-api-key": "sk-ant-REAL" } },
    },
  });
  gateway = g.server;
  gatewayPort = g.port;
});

afterAll(() => {
  upstream.close();
  gateway.close();
  tcp.close();
});

function connectThrough(host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(gatewayPort, "127.0.0.1", () =>
      s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}\r\n\r\n`),
    );
    let data = "";
    s.on("data", (d) => (data += d.toString()));
    s.on("end", () => resolve(data));
    s.on("error", reject);
  });
}

describe("gateway", () => {
  it("matches hosts and subdomains on the allowlist only", () => {
    expect(hostAllowed("registry.npmjs.org", ["registry.npmjs.org"])).toBe(true);
    expect(hostAllowed("api.github.com", ["github.com"])).toBe(true);
    expect(hostAllowed("evilgithub.com", ["github.com"])).toBe(false);
    expect(hostAllowed("example.com", ["registry.npmjs.org"])).toBe(false);
  });

  it("refuses CONNECT tunnels to hosts off the allowlist", async () => {
    const reply = await connectThrough("example.com", 443);
    expect(reply).toMatch(/^HTTP\/1\.1 403/);
  });

  it("tunnels CONNECT to allowlisted hosts", async () => {
    const reply = await connectThrough("127.0.0.1", tcpPort);
    expect(reply).toMatch(/^HTTP\/1\.1 200 Connection Established/);
    expect(reply).toContain("hello from upstream");
  });

  it("replaces placeholder credentials with the real key on injection routes", async () => {
    seen = [];
    const body = await new Promise<string>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: gatewayPort,
          path: "/__inject/anthropic/v1/messages",
          method: "POST",
          headers: { "x-api-key": "sk-ant-placeholder", authorization: "Bearer stolen?" },
        },
        (res) => {
          let d = "";
          res.on("data", (c) => (d += c));
          res.on("end", () => resolve(d));
        },
      );
      req.on("error", reject);
      req.end("{}");
    });
    expect(JSON.parse(body)).toEqual({ path: "/v1/messages" });
    expect(seen[0]!["x-api-key"]).toBe("sk-ant-REAL");
    expect(seen[0]!.authorization).toBeUndefined();
  });

  it("refuses plain-HTTP proxying to hosts off the allowlist", async () => {
    const status = await new Promise<number>((resolve) => {
      request({ host: "127.0.0.1", port: gatewayPort, path: "http://example.com/" }, (res) =>
        resolve(res.statusCode!),
      ).end();
    });
    expect(status).toBe(403);
  });

  it("builds injection routes from the host environment", () => {
    expect(injectRoutesFromEnv({ ANTHROPIC_API_KEY: "k", CONTEXT7_API_KEY: "c" })).toEqual({
      anthropic: { upstream: "https://api.anthropic.com", headers: { "x-api-key": "k" } },
      context7: { upstream: "https://mcp.context7.com", headers: { CONTEXT7_API_KEY: "c" } },
    });
    expect(injectRoutesFromEnv({ CLAUDE_CODE_OAUTH_TOKEN: "o" }).anthropic!.headers).toEqual({
      authorization: "Bearer o",
    });
  });
});
