// Issue 4: shortening the same url twice returns the existing slug
import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { create, harness, type Harness } from "./_helpers.ts";

let h: Harness;
before(async () => (h = await harness()));
after(() => h.close());

it("returns the same slug for the same url", async () => {
  const a = await (await create(h.url, { url: "https://example.com/same" })).json();
  const res = await create(h.url, { url: "https://example.com/same" });
  assert.ok(res.status === 200 || res.status === 201, `unexpected status ${res.status}`);
  const b = await res.json();
  assert.equal(b.slug, a.slug);
});

it("treats urls that normalize identically as the same", async () => {
  const a = await (await create(h.url, { url: "https://Example.com/n" })).json();
  const b = await (await create(h.url, { url: "https://example.com/n" })).json();
  assert.equal(b.slug, a.slug);
});

it("gives different urls different slugs", async () => {
  const a = await (await create(h.url, { url: "https://example.com/1" })).json();
  const b = await (await create(h.url, { url: "https://example.com/2" })).json();
  assert.notEqual(a.slug, b.slug);
});
