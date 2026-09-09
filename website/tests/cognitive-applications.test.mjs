import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const slug = "cognitive-applications";

test("cognitive application articles share a downloadable package and localized reading links", async () => {
  const example = (await readFile(new URL("../public/examples/file-review.hns", import.meta.url), "utf8")).trimEnd();
  const commands = [];
  for (const locale of ["zh", "en"]) {
    const markdown = await readFile(new URL(`../content/blog/${locale}/${slug}.md`, import.meta.url), "utf8");
    assert.equal(markdown.match(/```lisp\n([\s\S]*?)\n```/)?.[1], example);
    assert.ok(markdown.includes("](/examples/file-review.hns)"));
    commands.push([...markdown.matchAll(/```bash\n([\s\S]*?)\n```/g)].map((match) => match[1]));
    const prefix = locale === "zh" ? "" : "/en";
    for (const related of ["/docs/cognitive-applications", "/blog/maintaining-context-without-compaction", "/blog/one-agent-multiple-threads"]) {
      assert.ok(markdown.includes(`](${prefix}${related})`));
    }
    if (locale === "zh") {
      assert.match(markdown, /GUI 是可选、按平台适配的部分/);
      assert.match(markdown, /UI 规范及对应支持尚未在 Morphz 底层实现/);
      assert.match(markdown, /目前只有 Desktop 的临时实现/);
    } else {
      assert.match(markdown, /design calls for an optional, platform-specific GUI/);
      assert.match(markdown, /Morphz core has not yet implemented a UI specification/);
      assert.match(markdown, /desktop client currently has a provisional implementation of its own/);
    }
  }
  assert.equal(commands[0].length, 2);
  assert.deepEqual(commands[0], commands[1]);
});

test("application figures preserve the checked static SVGs and accessible localized captions", async () => {
  for (const locale of ["zh", "en"]) {
    const markdown = await readFile(new URL(`../content/blog/${locale}/${slug}.md`, import.meta.url), "utf8");
    const src = `/images/articles/${slug}-${locale}-v1.svg`;
    const figure = markdown.match(/<figure class="article-figure">([\s\S]*?)<\/figure>/)?.[1];
    assert.ok(figure);
    assert.ok(figure.includes(`href="${src}"`));
    assert.ok(figure.includes(`src="${src}"`));
    assert.match(figure, /width="600" height="470"/);
    assert.match(figure, /loading="lazy" decoding="async"/);
    assert.match(figure, /target="_blank" rel="noopener noreferrer" aria-label="[^"]+"/);
    assert.match(figure, /alt="[^"]{50,}"/);
    assert.match(figure, /<figcaption>[^<]+/);
    const svg = await readFile(new URL(`../public${src}`, import.meta.url), "utf8");
    assert.match(svg, /viewBox="0 0 600 470"/);
    assert.ok(svg.includes(`lang="${locale === "zh" ? "zh-CN" : "en"}"`));
    assert.match(svg, /role="img"/);
    assert.match(svg, /aria-labelledby="archify-diagram-title archify-diagram-description"/);
    assert.match(svg, /<title id="archify-diagram-title">[^<]+<\/title>/);
    assert.doesNotMatch(svg, /<(?:script|foreignObject|image|animate|set)\b|(?:href|src)=|@import|url\(["']?https?:/i);
    assert.ok(Buffer.byteLength(svg) < 60_000);
  }
});

test("application articles render in both languages with their actual figure and code sample", async () => {
  const { default: worker } = await import("../dist/server/index.js");
  for (const [locale, prefix] of [["zh", ""], ["en", "/en"]]) {
    const response = await worker.fetch(
      new Request(`https://morphz.ai${prefix}/blog/${slug}`, { headers: { accept: "text/html" } }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
      { waitUntil() {}, passThroughOnException() {} },
    );
    assert.equal(response.status, 200);
    const html = await response.text();
    const prose = html.match(/<div class="doc-prose blog-prose">([\s\S]*?)<\/div>/)?.[1] ?? "";
    assert.ok(prose.includes(`/images/articles/${slug}-${locale}-v1.svg`));
    assert.ok(prose.includes("file-review.hns"));
    assert.match(prose, /<h2 id=/);
  }
});
