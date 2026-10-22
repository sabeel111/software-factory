// A scripted local Chat Completions server, and a matching in-process fetch, for provider tests.
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export interface ChatReply {
  status?: number;
  json?: unknown;
  headers?: Record<string, string>;
}

export interface ChatRequest {
  body: {
    model: string;
    messages: { role: string; content: string | null; tool_call_id?: string; tool_calls?: unknown[] }[];
    tools: { function: { name: string; parameters: Record<string, unknown> } }[];
    [k: string]: unknown;
  };
  headers: IncomingHttpHeaders | Record<string, string>;
}

export type ChatHandler = (req: ChatRequest, index: number) => ChatReply | Promise<ChatReply>;

let ids = 0;
/** An assistant turn that calls one tool. */
export function toolCall(
  name: string,
  args: unknown,
  usage = { prompt_tokens: 1000, completion_tokens: 100 },
) {
  return {
    json: {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: `call_${++ids}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage,
    },
  };
}

export function textReply(content: string) {
  return {
    json: {
      choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    },
  };
}

/** Tool results the model has received so far in this conversation. */
export const toolResults = (req: ChatRequest) =>
  req.body.messages.filter((m) => m.role === "tool").map((m) => m.content ?? "");

/** The submit_result schema's top-level property names (identifies the stage). */
export const submitProps = (req: ChatRequest) =>
  Object.keys(
    (req.body.tools.find((t) => t.function.name === "submit_result")?.function.parameters.properties ??
      {}) as object,
  );

export async function fakeChatServer(handler: ChatHandler) {
  const requests: ChatRequest[] = [];
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", async () => {
      const r: ChatRequest = { body: JSON.parse(data), headers: req.headers };
      requests.push(r);
      try {
        const reply = await handler(r, requests.length - 1);
        res.writeHead(reply.status ?? 200, { "content-type": "application/json", ...reply.headers });
        res.end(JSON.stringify(reply.json ?? {}));
      } catch (e) {
        res.writeHead(599);
        res.end(String(e));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** The same scripting as fakeChatServer, without a socket (unit tests). */
export function fakeChatFetch(handler: ChatHandler) {
  const requests: ChatRequest[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const r: ChatRequest = {
      body: JSON.parse(String(init.body)),
      headers: init.headers as Record<string, string>,
    };
    requests.push(r);
    const reply = await handler(r, requests.length - 1);
    return new Response(JSON.stringify(reply.json ?? {}), {
      status: reply.status ?? 200,
      headers: reply.headers,
    });
  }) as typeof fetch;
  return { fetchFn, requests };
}
