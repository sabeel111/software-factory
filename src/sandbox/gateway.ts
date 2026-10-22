// Egress + credential gateway for container sandboxes (specs/08-team-readiness.md R7.3, R7.4).
//
// Runs on the sandbox network as the only route out:
//   • HTTP CONNECT / absolute-URL proxying, allowed only to hosts on the allowlist.
//   • /__inject/<name>/<path> reverse-proxies to a configured upstream and *replaces* auth headers
//     with real credentials, so sandboxes only ever hold placeholders.
//
// Dependency-free and type-strippable, so a stock `node` image can run it directly:
//   GATEWAY_CONFIG='{"port":3128,"allowlist":[...],"inject":{...}}' node gateway.ts
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { connect, type Socket } from "node:net";

export interface InjectRoute {
  /** Upstream base URL, e.g. https://api.anthropic.com */
  upstream: string;
  /** Headers set on every forwarded request (credentials). */
  headers: Record<string, string>;
}

export interface GatewayConfig {
  port: number;
  host?: string;
  /** Hostnames sandboxes may reach; "example.com" also allows its subdomains. */
  allowlist: string[];
  inject: Record<string, InjectRoute>;
}

/** Auth headers a sandbox might send; always stripped before injection. */
const AUTH_HEADERS = [
  "authorization",
  "x-api-key",
  "proxy-authorization",
  "context7_api_key",
  "context7-api-key",
];
const HOP_HEADERS = ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "host"];

export function hostAllowed(host: string, allowlist: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return allowlist.some((entry) => {
    const a = entry.toLowerCase().replace(/^\*\./, "");
    return h === a || h.endsWith(`.${a}`);
  });
}

function deny(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "text/plain" });
  res.end(message);
}

function forward(
  req: IncomingMessage,
  res: ServerResponse,
  target: URL,
  extraHeaders: Record<string, string>,
  stripAuth: boolean,
) {
  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (v === undefined || HOP_HEADERS.includes(key)) continue;
    if (stripAuth && AUTH_HEADERS.includes(key)) continue;
    headers[k] = v;
  }
  for (const [k, v] of Object.entries(extraHeaders)) headers[k] = v;
  headers.host = target.host;
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  const upstream = send(target, { method: req.method, headers }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on("error", (e) => {
    if (!res.headersSent) deny(res, 502, `Upstream error: ${e.message}`);
    else res.destroy();
  });
  req.pipe(upstream);
}

export function createGateway(config: GatewayConfig): Server {
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    // Credential-injecting reverse proxy.
    const m = /^\/__inject\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(url);
    if (m) {
      const route = config.inject[m[1]!];
      if (!route) return deny(res, 404, `No injection route ${m[1]}`);
      const target = new URL(route.upstream.replace(/\/$/, "") + (m[2] ?? "/"));
      return forward(req, res, target, route.headers, true);
    }
    // Plain HTTP forward proxy (absolute-form request line).
    if (/^https?:\/\//.test(url)) {
      const target = new URL(url);
      if (!hostAllowed(target.hostname, config.allowlist))
        return deny(res, 403, `Egress to ${target.hostname} is not allowed`);
      return forward(req, res, target, {}, false);
    }
    deny(res, 400, "Not a proxy request");
  });

  // HTTPS tunnelling.
  server.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
    const [host, portStr] = (req.url ?? "").split(":");
    const port = Number(portStr || 443);
    if (!host || !hostAllowed(host, config.allowlist)) {
      client.end(
        `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nEgress to ${host} is not allowed\n`,
      );
      return;
    }
    const upstream = connect(port, host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
    client.on("error", () => upstream.destroy());
  });
  return server;
}

export async function startGateway(config: GatewayConfig): Promise<{ server: Server; port: number }> {
  const server = createGateway(config);
  await new Promise<void>((resolve) => server.listen(config.port, config.host ?? "0.0.0.0", resolve));
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : config.port };
}

/** Credentials the gateway injects, read from the host environment (never passed to sandboxes). */
export function injectRoutesFromEnv(env: NodeJS.ProcessEnv = process.env): Record<string, InjectRoute> {
  const routes: Record<string, InjectRoute> = {};
  if (env.ANTHROPIC_API_KEY) {
    routes.anthropic = {
      upstream: "https://api.anthropic.com",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY },
    };
  } else if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    routes.anthropic = {
      upstream: "https://api.anthropic.com",
      headers: { authorization: `Bearer ${env.CLAUDE_CODE_OAUTH_TOKEN}` },
    };
  }
  routes.context7 = {
    upstream: "https://mcp.context7.com",
    headers: env.CONTEXT7_API_KEY ? { CONTEXT7_API_KEY: env.CONTEXT7_API_KEY } : {},
  };
  return routes;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const config = JSON.parse(process.env.GATEWAY_CONFIG ?? "{}") as Partial<GatewayConfig>;
  const { port } = await startGateway({
    port: config.port ?? 3128,
    host: config.host,
    allowlist: config.allowlist ?? [],
    inject: config.inject ?? {},
  });
  console.log(`gateway listening on ${port}; allowlist: ${config.allowlist?.join(", ")}`);
}
