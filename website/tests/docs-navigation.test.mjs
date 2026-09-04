import assert from "node:assert/strict";
import test from "node:test";

async function render(path) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${path}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("keeps documentation language switches on the current article", async () => {
  const [zhResponse, enResponse] = await Promise.all([
    render("/docs/core-concepts"),
    render("/en/docs/core-concepts"),
  ]);
  assert.equal(zhResponse.status, 200);
  assert.equal(enResponse.status, 200);

  const [zh, en] = await Promise.all([zhResponse.text(), enResponse.text()]);
  assert.match(zh, /href="\/en\/docs\/core-concepts"[^>]*class="language-switch"/);
  assert.match(en, /href="\/docs\/core-concepts"[^>]*class="language-switch"/);
  assert.doesNotMatch(zh, /docs-toolbar__language/);
  assert.doesNotMatch(en, /docs-toolbar__language/);
  assert.doesNotMatch(zh, /status-badge--current/);
});
