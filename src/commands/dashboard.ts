// `factory dashboard`: serve the read-only web dashboard.
import { registerCommand } from "../cli.js";
import { createDashboard, defaultSources } from "../dashboard/server.js";
import { RunStore } from "../store/run-store.js";

registerCommand("dashboard", async (opts) => {
  const port = Number(opts.port ?? 4173);
  const server = createDashboard(defaultSources(new RunStore(String(opts.runs ?? "runs"))));
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  console.log(`Dashboard: http://127.0.0.1:${port}  (read-only; Ctrl-C to stop)`);
  await new Promise<void>((resolve) => process.once("SIGINT", resolve));
  server.close();
  return 0;
});
