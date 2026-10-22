import { startServer } from "./server.ts";

const server = await startServer({ port: Number(process.env.PORT ?? 3000) });
console.log(`TinyLinks listening on ${server.url}`);
