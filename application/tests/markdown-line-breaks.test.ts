import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import { preserveMarkdownLineBreaks } from "../apps/web/src/markdown-line-breaks.js";
import { streamingTextPlugin } from "../apps/web/src/streaming-text.js";
import { omitRepeatedDocumentTitle } from "../apps/web/src/document-presentation.js";

const render = (source: string, streaming = false, title?: string) =>
  renderToStaticMarkup(
    createElement(Markdown, {
      children: source,
      skipHtml: true,
      remarkPlugins: [
        remarkGfm,
        remarkCjkFriendly,
        [omitRepeatedDocumentTitle, { title }],
      ],
      rehypePlugins: [
        [
          streamingTextPlugin,
          {
            source,
            ranges: streaming
              ? [{ start: 0, end: source.length, at: 100 }]
              : [],
          },
        ],
        preserveMarkdownLineBreaks,
      ],
    }),
  );

for (const newline of ["\n", "\r\n", "\r"]) {
  test(`Markdown preserves source soft breaks (${JSON.stringify(newline)})`, () => {
    const source = ["问题：第一行", "复现：第二行", "验收：第三行"].join(
      newline,
    );
    assert.equal(
      render(source),
      "<p>问题：第一行<br/>复现：第二行<br/>验收：第三行</p>",
    );
    assert.equal(source.split(newline).length, 3);
  });
}

test("breaks survive inline markup, links, CJK and entity decoding", () => {
  assert.equal(
    render("**第一行**\n*第二行*\n[链接](https://example.org)\nA &amp; B"),
    '<p><strong>第一行</strong><br/><em>第二行</em><br/><a href="https://example.org">链接</a><br/>A &amp; B</p>',
  );
});

test("Markdown hard breaks stay single, including consecutive hard and soft breaks", () => {
  for (const source of ["A  \nB\nC", "A\\\nB\nC"])
    assert.equal(render(source), "<p>A<br/>B<br/>C</p>");
});

test("paragraph and heading separators do not manufacture blank lines", () => {
  assert.equal(
    render("# 标题\n\n第一段\n后半段\n\n第二段"),
    "<h1>标题</h1>\n<p>第一段<br/>后半段</p>\n<p>第二段</p>",
  );
});

test("tight and loose lists keep soft breaks without adding nested-list spacers", () => {
  assert.equal(
    render("- A\n  B\n  - C\n    D\n- E"),
    "<ul>\n<li>A<br/>B\n<ul>\n<li>C<br/>D</li>\n</ul>\n</li>\n<li>E</li>\n</ul>",
  );
  const loose = render("- A\n  B\n\n- C\n  D");
  assert.equal((loose.match(/<br\/>/g) ?? []).length, 2);
  assert.equal((loose.match(/<p>/g) ?? []).length, 2);
});

test("blockquote soft breaks render while block boundaries remain block boundaries", () => {
  assert.equal(
    render("> A\n> B\n>\n> C"),
    "<blockquote>\n<p>A<br/>B</p>\n<p>C</p>\n</blockquote>",
  );
});

test("code remains literal: fenced, indented and inline whitespace is not rewritten", () => {
  assert.equal(
    render("```txt\nA\n  B\n\nC\n```"),
    '<pre><code class="language-txt">A\n  B\n\nC\n</code></pre>',
  );
  assert.equal(render("    A\n      B"), "<pre><code>A\n  B\n</code></pre>");
  assert.equal(render("`A\nB`\nC"), "<p><code>A B</code><br/>C</p>");
});

test("table formatting and skipped raw HTML are unaffected", () => {
  assert.equal(
    (render("| A | B |\n| - | - |\n| C | D |").match(/<br\/>/g) ?? []).length,
    0,
  );
  const html = render("A\n<script>alert(1)</script>\nB");
  assert.ok(!html.includes("script"));
  assert.ok(!html.includes("alert"));
});

test("title omission and streaming decoration use the same line-break rule", () => {
  const html = render("# 标题\n\n第一行\n第二行\n第三行", true, "标题");
  assert.equal((html.match(/<br\/>/g) ?? []).length, 2);
  assert.ok(!html.includes("<h1>"));
  assert.ok(html.includes('data-stream-at="100"'));
  assert.equal(html.replace(/<[^>]*>/g, ""), "第一行第二行第三行");
});

test("line-break rendering is idempotent and skips literal SVG/math/textarea content", () => {
  const tree = {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "p",
        children: [{ type: "text", value: "A\nB" }],
      },
      ...["svg", "math", "textarea"].map((tagName) => ({
        type: "element",
        tagName,
        children: [{ type: "text", value: "A\nB" }],
      })),
    ],
  };
  const plugin = preserveMarkdownLineBreaks();
  plugin(tree);
  const first = structuredClone(tree);
  plugin(tree);
  assert.deepEqual(tree, first);
  assert.equal(tree.children[0]!.children.length, 3);
  for (const node of tree.children.slice(1))
    assert.equal(node.children[0]!.value, "A\nB");
});
