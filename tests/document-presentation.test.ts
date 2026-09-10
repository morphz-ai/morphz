import { test } from "node:test";
import assert from "node:assert/strict";
import {
  documentExcerpt,
  omitRepeatedDocumentTitle,
} from "../apps/web/src/document-presentation.js";

test("catalog excerpt omits only a matching leading title and bounds long content", () => {
  assert.equal(documentExcerpt("# **标题**\n\n正文。", "标题"), "正文。");
  assert.equal(
    documentExcerpt("# 不同标题\n\n正文。", "标题"),
    "不同标题 正文。",
  );
  assert.equal(documentExcerpt("", "标题"), "");
  assert.equal(documentExcerpt("长".repeat(1000000), "标题").length, 160);
});

test("document title deduplication is exact, first-block-only and preserves other content", () => {
  const heading = {
    type: "heading",
    depth: 1,
    children: [{ type: "strong", children: [{ type: "text", value: "标题" }] }],
  };
  const paragraph = {
    type: "paragraph",
    children: [{ type: "text", value: "正文" }],
  };
  const tree = {
    type: "root",
    children: [structuredClone(heading), structuredClone(paragraph)],
  };
  omitRepeatedDocumentTitle({ title: "标题" })(tree);
  assert.deepEqual(tree.children, [paragraph]);
  for (const children of [
    [paragraph, heading],
    [{ ...heading, depth: 2 }],
    [heading],
  ]) {
    const root = { type: "root", children: structuredClone(children) };
    const before = structuredClone(root);
    omitRepeatedDocumentTitle({
      title:
        children.length === 1 && children[0] === heading ? "不同标题" : "标题",
    })(root);
    assert.deepEqual(root, before);
  }
});
