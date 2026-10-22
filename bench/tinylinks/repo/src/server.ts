import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { send } from "./http.ts";
import { route, type Context } from "./router.ts";
import { Store } from "./store.ts";

export interface ServerOptions {
  /** Clock in epoch milliseconds; injectable for tests. */
  now?: () => number;
  /** Token for admin endpoints; defaults to $ADMIN_TOKEN. */
  adminToken?: string;
  port?: number;
}

export interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const ctx: Context = {
    store: new Store(),
    now: options.now ?? Date.now,
    adminToken: options.adminToken ?? process.env.ADMIN_TOKEN ?? "",
  };
  const server = createServer((req, res) => {
    route(ctx, req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { error: "internal error" });
      else res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
