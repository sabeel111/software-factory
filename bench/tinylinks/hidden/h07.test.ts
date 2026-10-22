// Issue 7: link expiry — expired links return 410; exactly at expiresAt counts as expired
import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { create, harness, visit, type Harness } from "./_helpers.ts";

let h: Harness;
before(async () => (h = await harness()));
after(() => h.close());

it("redirects before expiry", async () => {
  const expiresAt = new Date(h.clock.now + 60_000).toISOString();
  const res = await create(h.url, { url: "https://example.com/e1", expiresAt });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.expiresAt, expiresAt);
  assert.equal((await visit(h.url, `/${body.slug}`)).status, 302);
});

it("returns 410 exactly at expiresAt", async () => {
  const at = h.clock.now + 1_000;
  const { slug } = await (await create(h.url, { url: "https://example.com/e2", expiresAt: new Date(at).toISOString() })).json();
  h.clock.now = at;
  assert.equal((await visit(h.url, `/${slug}`)).status, 410);
});

it("returns 410 after expiry", async () => {
  const at = h.clock.now + 1_000;
  const { slug } = await (await create(h.url, { url: "https://example.com/e3", expiresAt: new Date(at).toISOString() })).json();
  h.clock.now = at + 5_000;
  assert.equal((await visit(h.url, `/${slug}`)).status, 410);
});

it("rejects invalid or past expiresAt with 400", async () => {
  assert.equal((await create(h.url, { url: "https://example.com/e4", expiresAt: "not-a-date" })).status, 400);
  const past = new Date(h.clock.now - 1_000).toISOString();
  assert.equal((await create(h.url, { url: "https://example.com/e5", expiresAt: past })).status, 400);
});

it("links without expiresAt never expire", async () => {
  const { slug } = await (await create(h.url, { url: "https://example.com/e6" })).json();
  h.clock.now += 10 * 365 * 24 * 3600 * 1000;
  assert.equal((await visit(h.url, `/${slug}`)).status, 302);
});
