// Issue 9: DELETE /links/:slug protected by a bearer token
import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { create, harness, visit, type Harness } from "./_helpers.ts";

let h: Harness;
before(async () => (h = await harness({ adminToken: "s3cret" })));
after(() => h.close());

it("deletes a link with the admin token", async () => {
  const { slug } = await (await create(h.url, { url: "https://example.com/d" })).json();
  const r = await visit(h.url, `/links/${slug}`, "DELETE", { Authorization: "Bearer s3cret" });
  assert.equal(r.status, 204);
  assert.equal((await visit(h.url, `/${slug}`)).status, 404);
});

it("rejects missing or wrong tokens with 401", async () => {
  const { slug } = await (await create(h.url, { url: "https://example.com/d2" })).json();
  assert.equal((await visit(h.url, `/links/${slug}`, "DELETE")).status, 401);
  assert.equal((await visit(h.url, `/links/${slug}`, "DELETE", { Authorization: "Bearer nope" })).status, 401);
  assert.equal((await visit(h.url, `/${slug}`)).status, 302);
});

it("returns 404 when deleting an unknown slug", async () => {
  const r = await visit(h.url, "/links/unknown", "DELETE", { Authorization: "Bearer s3cret" });
  assert.equal(r.status, 404);
});
