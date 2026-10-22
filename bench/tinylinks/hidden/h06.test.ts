// Issue 6: GET /links/:slug/stats
import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { create, harness, visit, type Harness } from "./_helpers.ts";

let h: Harness;
before(async () => (h = await harness()));
after(() => h.close());

it("reports zero clicks for a new link", async () => {
  const { slug } = await (await create(h.url, { url: "https://example.com/s0" })).json();
  const r = await visit(h.url, `/links/${slug}/stats`);
  assert.equal(r.status, 200);
  const stats = await r.json();
  assert.equal(stats.slug, slug);
  assert.equal(stats.clicks, 0);
  assert.equal(stats.lastClickedAt, null);
});

it("counts clicks and records the last click time", async () => {
  const { slug } = await (await create(h.url, { url: "https://example.com/s1" })).json();
  await visit(h.url, `/${slug}`);
  h.clock.now += 60_000;
  await visit(h.url, `/${slug}`);
  const stats = await (await visit(h.url, `/links/${slug}/stats`)).json();
  assert.equal(stats.clicks, 2);
  assert.equal(stats.lastClickedAt, new Date(h.clock.now).toISOString());
});

it("returns 404 for unknown slugs", async () => {
  const r = await visit(h.url, "/links/unknown/stats");
  assert.equal(r.status, 404);
});
