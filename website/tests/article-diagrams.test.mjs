import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const articles = [
  ["from-chat-completion-to-structured-context-evaluation", [["structured-context-evaluation", 800]]],
  ["maintaining-context-without-compaction", [["context-transactions", 735], ["cross-task-memory", 825]]],
  ["one-agent-multiple-threads", [["concurrent-threads", 725]]],
];

test("article diagrams are localized, accessible, self-contained static SVGs", async () => {
  for (const locale of ["zh", "en"]) {
    for (const [slug, diagrams] of articles) {
      const markdown = await readFile(new URL(`../content/blog/${locale}/${slug}.md`, import.meta.url), "utf8");
      const figures = [...markdown.matchAll(/<figure class="article-figure">([\s\S]*?)<\/figure>/g)];
      assert.equal(figures.length, diagrams.length, `${locale}/${slug} figure count`);
      for (const [index, [name, height]] of diagrams.entries()) {
        const src = `/images/articles/${name}-${locale}-v1.svg`;
        const figure = figures[index][1];
        assert.ok(figure.includes(`href="${src}"`), "full-size image is available as a link");
        assert.ok(figure.includes(`src="${src}"`));
        assert.ok(figure.includes(`width="1200" height="${height}"`), "reserve image space before it loads");
        assert.match(figure, /loading="lazy" decoding="async"/);
        assert.match(figure, /target="_blank" rel="noopener noreferrer" aria-label="[^"]+"/);
        const alt = figure.match(/\balt="([^"]+)"/)?.[1] ?? "";
        assert.ok(alt.length > 50, "mechanism has a useful text alternative");
        if (locale === "zh") assert.match(alt, /[\u4e00-\u9fff]/);
        else assert.doesNotMatch(alt, /[\u4e00-\u9fff]/);
        assert.match(figure, /<figcaption>[^<]+/);
        assert.doesNotMatch(figure, /motion-reveal|opacity|visibility|onload|onerror/);

        const svg = await readFile(new URL(`../public${src}`, import.meta.url), "utf8");
        assert.ok(svg.includes(`viewBox="0 0 1200 ${height}"`));
        assert.ok(svg.includes(`lang="${locale === "zh" ? "zh-CN" : "en"}"`));
        assert.match(svg, /role="img" aria-labelledby="title desc"/);
        assert.match(svg, /<title id="title">[^<]+<\/title><desc id="desc">[^<]+<\/desc>/);
        assert.doesNotMatch(svg, /<(?:script|image|foreignObject|animate|set)\b|(?:href|src)=|@import|@font-face|url\(https?:/i);
        assert.ok(Buffer.byteLength(svg) < 40_000, "article diagrams stay lightweight");
        if (name === "cross-task-memory") {
          for (const score of ["81.33%", "62.00%", "64.00%", "122 / 150"]) assert.ok(svg.includes(score));
          assert.doesNotMatch(svg, /more tokens|equal.cost|更多.*token/i);
        }
      }
    }
  }
});

test("all six article pages include real figures in server-rendered HTML", async () => {
  const { default: worker } = await import("../dist/server/index.js");
  for (const [locale, prefix] of [["zh", ""], ["en", "/en"]]) {
    for (const [slug, diagrams] of articles) {
      const response = await worker.fetch(
        new Request(`https://morphz.ai${prefix}/blog/${slug}`, { headers: { accept: "text/html" } }),
        { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
        { waitUntil() {}, passThroughOnException() {} },
      );
      assert.equal(response.status, 200);
      const html = await response.text();
      const prose = html.match(/<div class="doc-prose blog-prose">([\s\S]*?)<\/div>/)?.[1] ?? "";
      const figures = [...prose.matchAll(/<figure class="article-figure">([\s\S]*?)<\/figure>/g)];
      assert.equal(figures.length, diagrams.length, `${locale}/${slug}: visible HTML, not just hydration data`);
      for (const [name] of diagrams) assert.ok(prose.includes(`/images/articles/${name}-${locale}-v1.svg`));
      assert.match(prose, /<h2 id=/, "article content remains present");
    }
  }
});

test("article figures scale to the reading column without a JavaScript reveal", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const rule = css.match(/\.blog-prose \.article-figure img\s*\{([^}]+)\}/)?.[1] ?? "";
  assert.match(rule, /width:\s*100%/);
  assert.match(rule, /height:\s*auto/);
  assert.doesNotMatch(rule, /opacity:\s*0|visibility:\s*hidden|display:\s*none/);
  assert.match(css, /\.blog-prose \.article-figure > a:focus-visible/);
});
