// An in-memory GitHub REST API (just the endpoints the factory uses), as a FetchLike.
import type { FetchLike } from "../../src/issues/github.js";

interface Issue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  created_at: string;
  labels: { name: string }[];
  pull_request?: object;
  html_url: string;
}

export function fakeGitHub(
  repo: string,
  issues: { number: number; title: string; body?: string; labels: string[] }[],
) {
  const store = new Map<number, Issue>();
  const comments = new Map<number, { id: number; body: string; created_at: string; issue: number }>();
  let nextComment = 1;
  let nextNumber = 1000;
  const writes: { method: string; path: string }[] = [];
  for (const i of issues) {
    store.set(i.number, {
      number: i.number,
      title: i.title,
      body: i.body ?? "",
      state: "open",
      created_at: new Date(Date.UTC(2026, 0, 1, 0, i.number)).toISOString(),
      labels: i.labels.map((name) => ({ name })),
      html_url: `https://github.com/${repo}/issues/${i.number}`,
    });
  }
  const json = (status: number, body: unknown) =>
    new Response(body === null ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname;
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== "GET") writes.push({ method, path });
    const base = `/repos/${repo}`;
    let m: RegExpExecArray | null;

    if (method === "GET" && path === base) return json(200, { permissions: { push: true } });
    if (method === "GET" && path === `${base}/issues`) {
      const label = u.searchParams.get("labels");
      return json(
        200,
        [...store.values()].filter(
          (i) => i.state === "open" && (!label || i.labels.some((l) => l.name === label)),
        ),
      );
    }
    if (method === "POST" && path === `${base}/issues`) {
      const n = nextNumber++;
      store.set(n, {
        number: n,
        title: body.title,
        body: body.body,
        state: "open",
        created_at: new Date().toISOString(),
        labels: [],
        html_url: "",
      });
      return json(201, { number: n, html_url: `https://github.com/${repo}/issues/${n}` });
    }
    if ((m = new RegExp(`^${base}/issues/(\\d+)$`).exec(path)) && method === "GET") {
      const i = store.get(Number(m[1]));
      return i ? json(200, i) : json(404, { message: "Not Found" });
    }
    if ((m = new RegExp(`^${base}/issues/(\\d+)/comments$`).exec(path))) {
      const n = Number(m[1]);
      if (method === "GET")
        return json(
          200,
          [...comments.values()].filter((c) => c.issue === n).sort((a, b) => a.id - b.id),
        );
      const c = { id: nextComment++, body: body.body, created_at: new Date().toISOString(), issue: n };
      comments.set(c.id, c);
      return json(201, c);
    }
    if ((m = new RegExp(`^${base}/issues/comments/(\\d+)$`).exec(path))) {
      const id = Number(m[1]);
      if (method === "PATCH") {
        const c = comments.get(id);
        if (!c) return json(404, { message: "Not Found" });
        c.body = body.body;
        return json(200, c);
      }
      if (method === "DELETE")
        return comments.delete(id) ? json(204, null) : json(404, { message: "Not Found" });
    }
    if ((m = new RegExp(`^${base}/issues/(\\d+)/labels$`).exec(path)) && method === "POST") {
      const i = store.get(Number(m[1]))!;
      for (const name of body.labels as string[])
        if (!i.labels.some((l) => l.name === name)) i.labels.push({ name });
      return json(200, i.labels);
    }
    if ((m = new RegExp(`^${base}/issues/(\\d+)/labels/(.+)$`).exec(path)) && method === "DELETE") {
      const i = store.get(Number(m[1]))!;
      const name = decodeURIComponent(m[2]!);
      if (!i.labels.some((l) => l.name === name)) return json(404, { message: "Label does not exist" });
      i.labels = i.labels.filter((l) => l.name !== name);
      return json(200, i.labels);
    }
    if (method === "POST" && path === `${base}/pulls`) {
      const n = nextNumber++;
      store.set(n, {
        number: n,
        title: body.title,
        body: body.body,
        state: "open",
        created_at: new Date().toISOString(),
        labels: [],
        pull_request: {},
        html_url: `https://github.com/${repo}/pull/${n}`,
      });
      return json(201, { number: n, html_url: `https://github.com/${repo}/pull/${n}`, draft: body.draft });
    }
    return json(404, { message: `fake GitHub: no route for ${method} ${path}` });
  };
  return { fetch, writes, store };
}
