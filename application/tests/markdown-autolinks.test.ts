import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { markdownRemarkPlugins } from "../apps/web/src/markdown-parsing.js";
import { streamingTextPlugin } from "../apps/web/src/streaming-text.js";

const href = (url: string) => encodeURI(url).replaceAll("&", "&amp;");

function render(source: string, streaming = false) {
  return renderToStaticMarkup(
    createElement(Markdown, {
      children: source,
      skipHtml: true,
      remarkPlugins: markdownRemarkPlugins,
      rehypePlugins: streaming
        ? [
            [
              streamingTextPlugin,
              { source, ranges: [{ start: 0, end: source.length, at: 100 }] },
            ],
          ]
        : [],
    }),
  );
}

test("a bold URL ends before its closing emphasis and Chinese explanation", () => {
  const source =
    "**https://github.com/shafreeck/24frames**：public，默认分支 `main`，远端 HEAD。";
  assert.equal(
    render(source),
    '<p><strong><a href="https://github.com/shafreeck/24frames">https://github.com/shafreeck/24frames</a></strong>：public，默认分支 <code>main</code>，远端 HEAD。</p>',
  );
});

test("Unicode link detection keeps Chinese paths but not following prose punctuation", () => {
  for (const punctuation of [
    "，",
    "。",
    "：",
    "；",
    "！",
    "？",
    "、",
    "（",
    "【",
    "《",
    "「",
    "“",
  ]) {
    const source = `https://example.org/中文路径${punctuation}这里不是链接`;
    assert.equal(
      render(source),
      `<p><a href="${href("https://example.org/中文路径")}">https://example.org/中文路径</a>${punctuation}这里不是链接</p>`,
      punctuation,
    );
  }
});

test("emphasis is parsed before automatic links, including CJK and adjacent code", () => {
  assert.equal(
    render(
      "**仓库 https://example.org/repo**：说明；*https://example.org/other*。`main`",
    ),
    '<p><strong>仓库 <a href="https://example.org/repo">https://example.org/repo</a></strong>：说明；<em><a href="https://example.org/other">https://example.org/other</a></em>。<code>main</code></p>',
  );
});

test("explicit and reference links retain intentional punctuation and nested formatting", () => {
  const source =
    "[**显式链接**](https://example.org/中文，路径) 和 [原文][ref]。\n\n[ref]: https://example.org/中文：路径";
  assert.equal(
    render(source),
    `<p><a href="${href("https://example.org/中文，路径")}"><strong>显式链接</strong></a> 和 <a href="${href("https://example.org/中文：路径")}">原文</a>。</p>`,
  );
  assert.equal(
    render("<https://example.org/中文，路径>"),
    `<p><a href="${href("https://example.org/中文，路径")}">https://example.org/中文，路径</a></p>`,
  );
});

test("query strings, fragments, balanced URL parentheses and www links survive", () => {
  assert.equal(
    render(
      "https://example.org/a_(b)?q=中文&x=2#标题，说明；www.example.org/path。说明",
    ),
    `<p><a href="${href("https://example.org/a_(b)?q=中文&x=2#标题")}">https://example.org/a_(b)?q=中文&amp;x=2#标题</a>，说明；<a href="http://www.example.org/path">www.example.org/path</a>。说明</p>`,
  );
  assert.equal(
    render("README.md 和 example.org 不是显式网址"),
    "<p>README.md 和 example.org 不是显式网址</p>",
  );
});

test("code, escaped emphasis and raw HTML are not repaired or executed", () => {
  assert.equal(
    render("`**https://example.org/repo**：原文`"),
    "<p><code>**https://example.org/repo**：原文</code></p>",
  );
  assert.equal(
    render("```txt\nhttps://example.org/repo，原文\n```"),
    '<pre><code class="language-txt">https://example.org/repo，原文\n</code></pre>',
  );
  assert.doesNotMatch(render("\\*\\*原文\\*\\*"), /<strong>/);
  assert.doesNotMatch(
    render('<script src="https://example.org/script.js">alert(1)</script>'),
    /<script|<a /,
  );
});

test("tables, task lists, strikethrough and footnotes remain GFM", () => {
  const result = render(
    "| 地址 | 说明 |\n| --- | --- |\n| **https://example.org/repo**：说明 | ~~旧版~~ |\n\n- [x] 完成\n\n注释[^one]\n\n[^one]: 原文",
  );
  assert.match(result, /<table>/);
  assert.match(result, /<strong><a href="https:\/\/example.org\/repo">/);
  assert.match(result, /<del>旧版<\/del>/);
  assert.match(result, /type="checkbox"[^>]*checked/);
  assert.match(result, /data-footnotes/);
});

test("stream decoration keeps exact source offsets without replaying transformed text", async () => {
  const source = "开头\n**https://example.org/路径**：说明 &amp; 文字。";
  const processor = unified().use(remarkParse).use(markdownRemarkPlugins);
  const tree = await processor.run(processor.parse(source), source);
  const inspect = (node: {
    type: string;
    value?: string;
    position?: { start: { offset?: number }; end: { offset?: number } };
    children?: unknown[];
  }) => {
    if (node.type === "link") {
      assert.equal(
        source.slice(node.position?.start.offset, node.position?.end.offset),
        "https://example.org/路径",
      );
      const child = node.children?.[0] as Parameters<typeof inspect>[0];
      assert.equal(
        source.slice(child.position?.start.offset, child.position?.end.offset),
        child.value,
      );
    }
    for (const child of node.children ?? [])
      inspect(child as Parameters<typeof inspect>[0]);
  };
  inspect(tree);
  const result = render(source, true);
  assert.match(result, /data-stream-at="100"/);
  assert.ok(result.includes(`href="${href("https://example.org/路径")}"`));
  assert.doesNotMatch(result, /href="[^"]*说明/);
  assert.match(result, /说明 &amp; 文字。/);
});
