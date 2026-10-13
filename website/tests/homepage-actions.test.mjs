import assert from "node:assert/strict";
import test from "node:test";

test("homepage hero actions retain their links and styling without decorative arrows", async () => {
  const { default: worker } = await import("../dist/server/index.js");
  for (const [path, demo, run, source, download] of [
    ["/", "观看演示", "运行 Morphz", "查看源码", "/download"],
    ["/en", "Watch the demo", "Run Morphz", "Inspect the source", "/en/download"],
  ]) {
    const response = await worker.fetch(
      new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
      { waitUntil() {}, passThroughOnException() {} },
    );
    assert.equal(response.status, 200);
    const html = await response.text();
    const actions = html.match(/<div class="home-actions">([\s\S]*?)<\/div>/)?.[1];
    assert.ok(actions);
    assert.equal(actions, `<a class="home-button home-button--primary" href="#demo">${demo}</a><a href="${download}" class="home-button">${run}</a><a class="home-link" href="https://github.com/morphz-ai/morphz">${source}</a>`);
    assert.doesNotMatch(actions, /[↓→↗]|<span/);
    // Other arrows are outside the requested edit and must remain untouched.
    const header = html.match(/<header class="site-header">[\s\S]*?<\/header>/)?.[0];
    assert.match(header, /↗/);
  }
});
