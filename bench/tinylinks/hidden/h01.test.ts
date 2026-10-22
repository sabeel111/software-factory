// Issue 1: URLs without a scheme default to https://
import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { create, harness, visit, type Harness } from "./_helpers.ts";

let h: Harness;
before(async () => (h = await harness()));
after(() => h.close());

it("defaults a bare domain to https", async () => {
  const res = await create(h.url, { url: "example.com" });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.url, "https://example.com/");
  const r = await visit(h.url, `/${body.slug}`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "https://example.com/");
});

it("keeps a path when defaulting the scheme", async () => {
  const body = await (await create(h.url, { url: "example.com/docs?x=1" })).json();
  assert.equal(body.url, "https://example.com/docs?x=1");
});

it("does not change explicit http urls", async () => {
  const body = await (await create(h.url, { url: "http://example.com/" })).json();
  assert.equal(body.url, "http://example.com/");
});

it("still rejects non-http schemes", async () => {
  const res = await create(h.url, { url: "ftp://example.com/file" });
  assert.equal(res.status, 400);
});
