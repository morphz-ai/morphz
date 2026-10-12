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
  return {
    document: document as unknown as Document,
    root,
    key,
    pointer: () => document.dispatchEvent(new Event("pointerdown")),
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
  const { document, root, key, pointer } = fixture("keyboard");
  const cleanup = installFocusModality(document);
  pointer();
  assert.equal(root.dataset.uiFocus, "pointer");
  cleanup();
  assert.equal(root.dataset.uiFocus, "keyboard");
  pointer();
  assert.equal(root.dataset.uiFocus, "keyboard");
  key("Tab");
  assert.equal(root.dataset.uiFocus, "keyboard");
});
