import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startServer, type RunningServer } from "../src/server.ts";

describe("tinylinks", () => {
  let server: RunningServer;
  before(async () => {
    server = await startServer();
  });
  after(() => server.close());

  it("creates a short link", async () => {
    const res = await fetch(`${server.url}/links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/page" }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.url, "https://example.com/page");
    assert.match(body.slug, /^[A-Za-z0-9]{6}$/);
    assert.equal(body.shortUrl, `/${body.slug}`);
  });

  it("redirects a slug to its url", async () => {
    const created = await (
      await fetch(`${server.url}/links`, { method: "POST", body: JSON.stringify({ url: "https://example.org/" }) })
    ).json();
    const res = await fetch(`${server.url}/${created.slug}`, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "https://example.org/");
  });

  it("returns 404 for unknown slugs", async () => {
    const res = await fetch(`${server.url}/nope00`, { redirect: "manual" });
    assert.equal(res.status, 404);
  });

  it("rejects a missing url", async () => {
    const res = await fetch(`${server.url}/links`, { method: "POST", body: "{}" });
    assert.equal(res.status, 400);
  });
});
