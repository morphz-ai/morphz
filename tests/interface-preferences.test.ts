import test from "node:test";
import assert from "node:assert/strict";
import {
  interfacePreferences,
  shouldSubmitInput,
} from "../apps/web/src/interface-preferences.js";

test("interface settings normalize absent and invalid stored values without changing defaults", () => {
  const defaults = {
    appearance: "system",
    accent: "cyan",
    textSize: "standard",
    motion: "system",
    sendShortcut: "enter",
  };
  for (const stored of [
    undefined,
    null,
    false,
    [],
    { appearance: "invalid", textSize: 99, motion: true, sendShortcut: "auto" },
  ])
    assert.deepEqual(interfacePreferences(stored), defaults);
  assert.deepEqual(
    interfacePreferences({
      appearance: "dark",
      accent: "iris",
      textSize: "larger",
      motion: "reduce",
      sendShortcut: "mod-enter",
      view: "projects",
    }),
    {
      appearance: "dark",
      accent: "iris",
      textSize: "larger",
      motion: "reduce",
      sendShortcut: "mod-enter",
    },
  );
});

test("send shortcut preserves multiline, IME and key-repeat guards on both platforms", () => {
  const enter = {
    key: "Enter",
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    repeat: false,
    isComposing: false,
    keyCode: 13,
  };
  assert.equal(shouldSubmitInput(enter, "enter"), true);
  assert.equal(shouldSubmitInput(enter, "mod-enter"), false);
  for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
    assert.equal(
      shouldSubmitInput({ ...enter, ...modifier }, "mod-enter"),
      true,
    );
    assert.equal(shouldSubmitInput({ ...enter, ...modifier }, "enter"), true);
  }
  for (const guard of [
    { shiftKey: true },
    { altKey: true },
    { repeat: true },
    { isComposing: true },
    { keyCode: 229 },
    { key: "a" },
  ])
    for (const shortcut of ["enter", "mod-enter"] as const)
      assert.equal(
        shouldSubmitInput({ ...enter, metaKey: true, ...guard }, shortcut),
        false,
      );
});
