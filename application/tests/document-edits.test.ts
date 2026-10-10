import test from "node:test";
import assert from "node:assert/strict";
import {
  applyDocumentEdits,
  documentRevisionBodySchema,
} from "../packages/core/src/document-edits.js";
import { maxDocumentCharacters } from "../packages/core/src/sources.js";

test("精确修订保留 Unicode、换行和未选内容，全部片段针对同一原文而非级联", () => {
  const original = "# 文档\r\n\r\n🍜菜叶落在筐边。\n结尾保留。";
  assert.equal(
    applyDocumentEdits(original, [
      { old_text: "菜叶", new_text: "嫩叶" },
      { old_text: "结尾保留。", new_text: "结尾仍保留。" },
    ]),
    "# 文档\r\n\r\n🍜嫩叶落在筐边。\n结尾仍保留。",
  );
  assert.throws(
    () =>
      applyDocumentEdits("原文", [
        { old_text: "原文", new_text: "中间" },
        { old_text: "中间", new_text: "结尾" },
      ]),
    /未找到/,
  );
  assert.equal(
    applyDocumentEdits("A B", [
      { old_text: "A", new_text: "B" },
      { old_text: "B", new_text: "C" },
    ]),
    "B C",
  );
});

test("匹配缺失／多处／重叠／无变化整批拒绝，replace_all 仅按明确请求", () => {
  assert.throws(
    () =>
      applyDocumentEdits("重复 重复", [{ old_text: "重复", new_text: "修改" }]),
    /多处/,
  );
  assert.equal(
    applyDocumentEdits("重复 重复", [
      { old_text: "重复", new_text: "修改", replace_all: true },
    ]),
    "修改 修改",
  );
  assert.throws(
    () =>
      applyDocumentEdits("保留", [{ old_text: "不存在", new_text: "修改" }]),
    /未找到/,
  );
  assert.throws(
    () =>
      applyDocumentEdits("重叠片段", [
        { old_text: "重叠", new_text: "修改" },
        { old_text: "叠片", new_text: "别的" },
      ]),
    /重叠/,
  );
  assert.throws(
    () => applyDocumentEdits("不变", [{ old_text: "不变", new_text: "不变" }]),
    /未改变/,
  );
  assert.equal(
    applyDocumentEdits("删掉尾部", [{ old_text: "尾部", new_text: "" }]),
    "删掉",
  );
  // Match-index semantics are non-overlapping, like Runtime's file edit.
  assert.equal(
    applyDocumentEdits("aaaaa", [
      { old_text: "aa", new_text: "b", replace_all: true },
    ]),
    "bba",
  );
  assert.throws(
    () =>
      applyDocumentEdits("aaaa", [
        { old_text: "a", new_text: "b", replace_all: true },
        { old_text: "a", new_text: "c", replace_all: true },
      ]),
    /重叠/,
  );
});

test("修订协议保留全文保存但不混用，拒绝空片段、超量参数和超长最终正文", () => {
  assert.deepEqual(
    documentRevisionBodySchema.parse({
      edits: [{ old_text: "旧", new_text: "新" }],
    }),
    { edits: [{ old_text: "旧", new_text: "新", replace_all: false }] },
  );
  assert.ok(
    documentRevisionBodySchema.safeParse({
      title: "正文",
      markdown: "完整正文",
    }).success,
  );
  for (const raw of [
    {},
    { markdown: "全文" },
    { edits: [] },
    { markdown: "全文", edits: [{ old_text: "旧", new_text: "新" }] },
    { edits: [{ old_text: "", new_text: "新" }] },
    {
      edits: Array.from({ length: 101 }, () => ({
        old_text: "旧",
        new_text: "新",
      })),
    },
    {
      edits: [{ old_text: "a".repeat(250_001), new_text: "b".repeat(250_000) }],
    },
  ])
    assert.equal(documentRevisionBodySchema.safeParse(raw).success, false);
  assert.throws(
    () =>
      applyDocumentEdits("a".repeat(maxDocumentCharacters), [
        { old_text: "a", new_text: "aa", replace_all: true },
      ]),
    /长度限制/,
  );
  const longOriginal = "a".repeat(600_000) + "末尾";
  assert.equal(
    applyDocumentEdits(longOriginal, [{ old_text: "末尾", new_text: "尾部" }]),
    longOriginal.replace("末尾", "尾部"),
  );
});
