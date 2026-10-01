import assert from "node:assert/strict";
import test from "node:test";
import { readerMarksAtSourceSpan } from "../apps/web/src/reader-dom.js";

const mark = (id: string, start: number, end: number, revision = 1) => ({
  id,
  revision,
  location: { start, end },
});

test("标注点击绑定精确原文字，不把同一长高亮远端的标注当作点击重叠", () => {
  const rows = [
    mark("long", 0, 10_000),
    mark("far", 8_000, 8_004),
    mark("clicked", 22, 27),
    mark("overlap", 20, 30),
    mark("bookmark", 23, 23),
    mark("ends-before", 0, 23),
    mark("starts-after", 24, 32),
  ];
  assert.deepEqual(
    readerMarksAtSourceSpan(rows, { start: 23, end: 24 }).map((row) => row.id),
    ["clicked", "overlap", "long"],
  );
  assert.deepEqual(readerMarksAtSourceSpan(rows, { start: 23, end: 23 }), []);
  // DOM may omit the two paragraph newlines in source "甲\n\n乙". The
  // clicked 甲 glyph [0,1) must not select the legal quote "\n\n乙" [1,4).
  assert.deepEqual(
    readerMarksAtSourceSpan([mark("next-paragraph", 1, 4)], {
      start: 0,
      end: 1,
    }),
    [],
  );
});

test("分页刷新只从最新授权标注页恢复点击身份，删除项和旧对象不能回填", () => {
  const anchor = { start: 23, end: 24 };
  const original = mark("clicked", 22, 27);
  const changed = mark("clicked", 22, 27, 2);
  const late = mark("late-overlap", 23, 25);
  assert.deepEqual(readerMarksAtSourceSpan([original], anchor), [original]);
  assert.deepEqual(readerMarksAtSourceSpan([changed, late], anchor), [
    late,
    changed,
  ]);
  assert.deepEqual(readerMarksAtSourceSpan([], anchor), []);
  assert.deepEqual(readerMarksAtSourceSpan([late], anchor), [late]);
});
