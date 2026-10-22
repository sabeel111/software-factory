// Issue 5: custom slugs with validation and conflict handling
import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { create, harness, visit, type Harness } from "./_helpers.ts";

let h: Harness;
before(async () => (h = await harness()));
after(() => h.close());

it("uses a valid custom slug", async () => {
  const res = await create(h.url, { url: "https://example.com/c", slug: "my-link_1" });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).slug, "my-link_1");
  const r = await visit(h.url, "/my-link_1");
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "https://example.com/c");
});

it("rejects invalid custom slugs with 400", async () => {
  for (const slug of ["ab", "has space", "x".repeat(33), "bad/slug", "api"]) {
    const res = await create(h.url, { url: "https://example.com/v", slug });
    assert.equal(res.status, 400, `slug ${JSON.stringify(slug)}`);
  }
});

it("returns 409 when the custom slug is taken", async () => {
  await create(h.url, { url: "https://example.com/1", slug: "taken" });
  const res = await create(h.url, { url: "https://example.com/2", slug: "taken" });
  assert.equal(res.status, 409);
});
