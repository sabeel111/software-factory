// Issue 2: a trailing slash on a slug should still redirect
import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { create, harness, visit, type Harness } from "./_helpers.ts";

let h: Harness;
before(async () => (h = await harness()));
after(() => h.close());

it("redirects /slug/ the same as /slug", async () => {
  const { slug } = await (await create(h.url, { url: "https://example.com/a" })).json();
  const r = await visit(h.url, `/${slug}/`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "https://example.com/a");
});

it("still 404s for unknown slugs with a trailing slash", async () => {
  const r = await visit(h.url, "/zzzzzz/");
  assert.equal(r.status, 404);
});
