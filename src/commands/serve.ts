// `factory serve`: the control UI (specs/09-control-ui.md).
import { registerCommand } from "../cli.js";
import { loadConfig } from "../config.js";
import { EventBus } from "../events/bus.js";
import { Controller, type Environment } from "../server/controller.js";
import { startControlServer } from "../server/http.js";

registerCommand("serve", async (opts) => {
  let env: Environment;
  if (opts.demo) {
    const { DemoEnvironment } = await import("../server/env-demo.js");
    env = await DemoEnvironment.create({ speed: opts.speed ? Number(opts.speed) : 1 });
  } else {
    const { LiveEnvironment } = await import("../server/env-live.js");
    env = new LiveEnvironment(await loadConfig(String(opts.config)));
  }
  const bus = new EventBus(env.runsRoot);
  const controller = new Controller(env, bus);
  const server = await startControlServer(Number(opts.port ?? 4173), { controller, bus });
  console.log(
    `Software Factory control UI${env.mode === "demo" ? " (demo mode: scripted agents, zero cost)" : ""}`,
  );
  console.log(`  ${server.url}`);
  console.log("Ctrl-C to stop. Running jobs are cancelled and their claims released.");
  await new Promise<void>((resolve) => process.once("SIGINT", resolve));
  try {
    controller.cancel();
  } catch {
    // nothing running
  }
  await Promise.race([controller.idle(), new Promise((r) => setTimeout(r, 15_000))]);
  await bus.flush();
  await server.close();
  return 0;
});
