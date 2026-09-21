import test from "node:test";
import assert from "node:assert/strict";
import {
  exchangeResizeLimits,
  preferredExchangeHeight,
  resolveExchangeSize,
  stepExchangeSize,
} from "../apps/web/src/exchange-resize.js";

test("拖动消息区以实际可用空间吸附，短窗口不会使两个阈值重叠", () => {
  assert.deepEqual(exchangeResizeLimits(600), {
    max: 600,
    collapse: 64,
    expand: 552,
  });
  for (const max of [40, 120, 300, 600, 1200]) {
    const { collapse, expand } = exchangeResizeLimits(max);
    assert.ok(collapse < expand);
    assert.equal(resolveExchangeSize(-10, max).mode, "input");
    assert.equal(resolveExchangeSize(collapse, max).mode, "input");
    assert.equal(resolveExchangeSize(collapse + 1, max).mode, "recent");
    assert.equal(resolveExchangeSize(expand - 1, max).mode, "recent");
    assert.equal(resolveExchangeSize(expand, max).mode, "history");
    assert.deepEqual(resolveExchangeSize(max + 900, max), {
      mode: "history",
      height: max,
    });
  }
});

test("异常存储值与没有可用空间不会生成负高度或不可退出的状态", () => {
  for (const value of [undefined, null, "240", NaN, Infinity, -1, 0])
    assert.equal(preferredExchangeHeight(value), undefined);
  assert.equal(preferredExchangeHeight(180.5), 180.5);
  for (const max of [0, -30, NaN, Infinity])
    assert.deepEqual(resolveExchangeSize(300, max), {
      mode: "input",
      height: 0,
    });
  assert.deepEqual(resolveExchangeSize(NaN, 600), { mode: "input", height: 0 });
});

test("键盘上下调整高度，Home/End 收起或展开，吸附端点一次按键即可离开", () => {
  assert.deepEqual(stepExchangeSize("recent", 200, 600, "ArrowUp"), {
    mode: "recent",
    height: 224,
  });
  assert.deepEqual(stepExchangeSize("recent", 200, 600, "ArrowDown", true), {
    mode: "recent",
    height: 136,
  });
  assert.deepEqual(stepExchangeSize("recent", 200, 600, "Home"), {
    mode: "input",
    height: 0,
  });
  assert.deepEqual(stepExchangeSize("recent", 200, 600, "End"), {
    mode: "history",
    height: 600,
  });
  for (const max of [40, 120, 600]) {
    assert.equal(stepExchangeSize("input", 0, max, "ArrowUp")?.mode, "recent");
    assert.equal(
      stepExchangeSize("history", max, max, "ArrowDown")?.mode,
      "recent",
    );
  }
  assert.equal(stepExchangeSize("recent", 200, 600, "Enter"), null);
});
