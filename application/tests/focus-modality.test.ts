import assert from "node:assert/strict";
import test from "node:test";
import { installFocusModality } from "../apps/web/src/ui/focus-modality.js";

function fixture(initial?: string) {
  const events = new EventTarget();
  const dataset: { uiFocus?: string } = {};
  if (initial) dataset.uiFocus = initial;
  const root = {
    dataset,
    getAttribute: () => dataset.uiFocus ?? null,
    setAttribute: (_: string, value: string) => {
      dataset.uiFocus = value;
    },
    removeAttribute: () => {
      delete dataset.uiFocus;
    },
  };
  const document = Object.assign(events, { documentElement: root });
  const key = (key: string) => {
    const event = new Event("keydown");
    Object.defineProperty(event, "key", { value: key });
    document.dispatchEvent(event);
  };
  const point = (type: string, screenX = 10, screenY = 10, pointerId = 1) => {
    const event = new Event(type);
    Object.defineProperties(event, {
      screenX: { value: screenX },
      screenY: { value: screenY },
      pointerId: { value: pointerId },
    });
    document.dispatchEvent(event);
  };
  return {
    document: document as unknown as Document,
    root,
    key,
    pointer: (x?: number, y?: number) => point("pointerdown", x, y),
    move: (x: number, y: number, id?: number) => point("pointermove", x, y, id),
  };
}

test("焦点展示以实际鼠标/键盘输入为准，不调用 focus/blur 或持久化", () => {
  const { document, root, key, pointer } = fixture();
  const cleanup = installFocusModality(document);
  assert.equal(root.dataset.uiFocus, "pointer");
  key("Shift");
  assert.equal(root.dataset.uiFocus, "pointer");
  for (const value of ["Tab", "ArrowDown", "Enter", " ", "Escape", "j"]) {
    key(value);
    assert.equal(root.dataset.uiFocus, "keyboard");
    pointer();
    assert.equal(root.dataset.uiFocus, "pointer");
  }
  cleanup();
  assert.equal(root.dataset.uiFocus, undefined);
  key("Tab");
  pointer();
  assert.equal(root.dataset.uiFocus, undefined);
});

test("卸载清理捕获监听并恢复原展示属性", () => {
  const { document, root, key, pointer, move } = fixture("keyboard");
  const cleanup = installFocusModality(document);
  pointer();
  assert.equal(root.dataset.uiFocus, "pointer");
  cleanup();
  assert.equal(root.dataset.uiFocus, "keyboard");
  pointer();
  assert.equal(root.dataset.uiFocus, "keyboard");
  key("Tab");
  assert.equal(root.dataset.uiFocus, "keyboard");
  move(50, 80);
  assert.equal(root.dataset.uiFocus, "keyboard");
  document.dispatchEvent(new Event("wheel"));
  assert.equal(root.dataset.uiFocus, "keyboard");
});

test("真实鼠标移动清除键盘提示，静止指针与布局变化不清除", () => {
  const { document, root, key, pointer, move } = fixture();
  const cleanup = installFocusModality(document);
  pointer(30, 40);
  key("Tab");
  move(30, 40);
  assert.equal(root.dataset.uiFocus, "keyboard");
  move(31, 40);
  assert.equal(root.dataset.uiFocus, "pointer");
  key("ArrowDown");
  assert.equal(root.dataset.uiFocus, "keyboard");
  move(31, 40);
  assert.equal(root.dataset.uiFocus, "keyboard");
  move(31, 41);
  assert.equal(root.dataset.uiFocus, "pointer");
  key("Tab");
  move(31, 41, 2);
  assert.equal(root.dataset.uiFocus, "pointer");
  key("Tab");
  document.dispatchEvent(new Event("scroll"));
  assert.equal(root.dataset.uiFocus, "keyboard");
  document.dispatchEvent(new Event("wheel"));
  assert.equal(root.dataset.uiFocus, "pointer");
  cleanup();
});
