import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const slug = "context-and-memory";
const report = "https://github.com/morphz-ai/morphz/blob/77f05e1eb16c49c758c0d7f595b8cda16c689a58/docs/research/paper_evaluation/artifacts/me07_public_agent_systems_formal_one_run_20260827/README.md";
const editions = [
  { locale: "zh", prefix: "", title: "Morphz 如何管理上下文与记忆？", extension: "png", sha256: "8784469d883719f36ab2f33e5fbc86a2cf333f66657c3092652211794e1a6782" },
  { locale: "en", prefix: "/en", title: "How Morphz Manages Context and Memory", extension: "jpeg", sha256: "8dc6de1e60387f9528a348064575b3d8b9f76275c4ea5fb63ecf4b25d363a66d" },
];

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

test("both memory articles preserve the approved mechanism, examples, and evaluation scope", async () => {
  const sources = await Promise.all(editions.map(({ locale }) => readFile(new URL(`../content/blog/${locale}/${slug}.md`, import.meta.url), "utf8")));
  for (const [index, edition] of editions.entries()) {
    const source = sources[index];
    assert.ok(source.startsWith(`---\ntitle: ${edition.title}\n`));
    assert.match(source, /\npublished: 2026-10-01\n/);
    assert.equal((source.match(/^## /gm) ?? []).length, 8);
    assert.equal((source.match(/^```lisp$/gm) ?? []).length, 2);
    for (const content of ["(base-version 12)", "(retire @e42)", "(revise release (goal ship-v1) (stage packaging))", "(from release-case-a release-case-b)", "(relate release-procedure supersedes release-case-b)", '"direction": "ancestors"', '"include_events": false', "cognitive_tick", "ICU4X", "122/150", "81.33%", "93/150", "62.00%", "96/150", "64.00%", report]) {
      assert.ok(source.includes(content), `${edition.locale}: ${content}`);
    }
    assert.doesNotMatch(source, /\]\(assets\//);
    assert.match(source, /<figure class="article-figure">/);
    assert.match(source, /width="1448" height="1086"/);
    assert.match(source, /target="_blank" rel="noopener noreferrer"/);
    assert.match(source, edition.locale === "zh" ? /独立人工校准尚未完成/ : /independent human calibration is still pending/);
    assert.match(source, edition.locale === "zh" ? /使用了更多 token/ : /used more tokens/);
    const asset = await readFile(new URL(`../public/images/articles/morphz-context-memory-${edition.locale}-v2.${edition.extension}`, import.meta.url));
    assert.equal(createHash("sha256").update(asset).digest("hex"), edition.sha256, "the approved original image is published without recompression");
  }
  const code = (source) => [...source.matchAll(/^```(?:lisp|json)\n([\s\S]*?)\n```/gm)].map((match) => match[1].replace(/\(reason "[^"]*"\)/g, "(reason localized)").replace(/\(steps "[^"]*"\)/g, "(steps localized)").replace(/\(applicability "[^"]*"\)/g, "(applicability localized)"));
  assert.deepEqual(code(sources[0]), code(sources[1]), "localized prose leaves code structure unchanged");
});

test("memory pages render headings, diagrams, code, results, and language switches", async () => {
  for (const edition of editions) {
    const response = await render(`${edition.prefix}/blog/${slug}`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes(edition.title));
    assert.match(html, /<figure class="article-figure">/);
    assert.ok(html.includes(`/images/articles/morphz-context-memory-${edition.locale}-v2.${edition.extension}`));
    assert.match(html, /width="1448" height="1086"/);
    assert.match(html, /<code class="language-lisp">/);
    assert.match(html, /<code class="language-json">/);
    assert.match(html, /<table>/);
    assert.ok(html.includes("81.33%"));
    assert.ok(html.includes(report));
    assert.ok(html.includes(`href="${edition.prefix === "" ? "/en" : ""}/blog/${slug}"`));
    assert.ok(html.includes(`https://morphz.ai${edition.prefix}/blog/${slug}`));
    assert.doesNotMatch(html, /src="assets\//);
  }
});

test("both blog indexes and sitemap expose the new bilingual article", async () => {
  for (const edition of editions) {
    const response = await render(`${edition.prefix}/blog`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes(edition.title));
    assert.ok(html.includes(`href="${edition.prefix}/blog/${slug}"`));
  }
  const response = await render("/sitemap.xml");
  assert.equal(response.status, 200);
  const sitemap = await response.text();
  for (const { prefix } of editions) assert.ok(sitemap.includes(`https://morphz.ai${prefix}/blog/${slug}`));
});
