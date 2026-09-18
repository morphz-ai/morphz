import { test } from "node:test";
import assert from "node:assert/strict";
import {
  documentExcerpt,
  omitRepeatedDocumentTitle,
  searchPreview,
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

test("search preview starts at a matching sentence and omits redundant PDF page furniture", () => {
  const source =
    "…IGN NOTES A source stays intact when a reader adds an annotation. 这是一份合成测试资料，不包含个人信息。 Page 1 / 2";
  assert.equal(
    searchPreview(source, "reader", "测试", { kind: "pdf", page: 1 }),
    "…这是一份合成测试资料，不包含个人信息。",
  );
  assert.equal(
    searchPreview(source, "reader", "Page", { kind: "pdf", page: 1 }),
    "…Page 1 / 2",
  );
  assert.match(
    searchPreview("测试资料 Page 2 / 3", "reader", "测试", {
      kind: "pdf",
      page: 1,
    }),
    /Page 2 \/ 3$/,
  );
  assert.match(
    searchPreview("测试资料 Page 1 / 2", "reader", "测试", {
      kind: "document",
    }),
    /Page 1 \/ 2$/,
  );
});

test("search preview preserves matching terms, bounded display and source strings", () => {
  const original = "前言。交互先出现。接着验收。还有一些说明。";
  assert.equal(
    searchPreview(original, "笔记", "交互 验收", { kind: "document" }),
    "…交互先出现。接着验收。还有一些说明。",
  );
  assert.equal(original, "前言。交互先出现。接着验收。还有一些说明。");
  assert.equal(searchPreview("", "标题", "内容", { kind: "document" }), "");
  const long = searchPreview("段".repeat(158) + "😀".repeat(100), "标题", "", {
    kind: "document",
  });
  assert.ok(long.length <= 160);
  assert.equal(long, "段".repeat(158) + "…");
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
