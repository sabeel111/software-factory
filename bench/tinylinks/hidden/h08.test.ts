// Issue 8: support HEAD on redirect routes
import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { create, harness, visit, type Harness } from "./_helpers.ts";

let h: Harness;
before(async () => (h = await harness()));
after(() => h.close());

it("answers HEAD with the same redirect and no body", async () => {
  const { slug } = await (await create(h.url, { url: "https://example.com/h" })).json();
  const r = await visit(h.url, `/${slug}`, "HEAD");
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "https://example.com/h");
  assert.equal((await r.text()).length, 0);
});

it("answers HEAD on unknown slugs with 404", async () => {
  assert.equal((await visit(h.url, "/nothere", "HEAD")).status, 404);
});
