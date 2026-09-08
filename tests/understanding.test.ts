import test from "node:test";
import assert from "node:assert/strict";
import { publicSummary } from "../packages/core/src/understanding.js";
test("公开摘要解码兼容 Runtime 原样换行，同时拒绝其他帧和拼接内容", () => {
  assert.equal(
    publicSummary('(public-summary "目标\n约束\t资料")'),
    "目标\n约束\t资料",
  );
  assert.equal(
    publicSummary('(public-summary "文本\\n\\\"引号\\\" C:\\\\work")'),
    '文本\n"引号" C:\\work',
  );
  for (const body of [
    '"普通帧"',
    '(internal "hidden")',
    '(public-summary "ok" "extra")',
    '(public-summary "ok") (private "x")',
  ])
    assert.throws(() => publicSummary(body));
});
