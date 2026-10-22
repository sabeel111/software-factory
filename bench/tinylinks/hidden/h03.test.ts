// Issue 3: malformed ?url= on /api/shorten returns 400, not 500
import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { harness, visit, type Harness } from "./_helpers.ts";

let h: Harness;
before(async () => (h = await harness()));
after(() => h.close());

for (const bad of ["http://", "::::", "https://exa mple.com", "javascript:alert(1)"]) {
  it(`returns 400 for ${JSON.stringify(bad)}`, async () => {
    const r = await visit(h.url, `/api/shorten?url=${encodeURIComponent(bad)}`);
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(typeof body.error, "string");
  });
}

it("still shortens valid urls", async () => {
  const r = await visit(h.url, `/api/shorten?url=${encodeURIComponent("https://example.com/x")}`);
  assert.equal(r.status, 201);
  assert.equal((await r.json()).url, "https://example.com/x");
});
