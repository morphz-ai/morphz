import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { DesktopAppearance } = require("../apps/desktop/appearance.cjs");

function fixture(platform = "darwin") {
  const theme = Object.assign(new EventEmitter(), {
    themeSource: "system",
    shouldUseDarkColors: true,
    prefersReducedTransparency: false,
    shouldUseHighContrastColors: false,
  });
  const calls: unknown[][] = [];
  let focused = true;
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isFocused: () => focused,
    setVibrancy: (v: unknown) => calls.push(["vibrancy", v]),
    setBackgroundColor: (v: unknown) => calls.push(["background", v]),
    webContents: {
      isDestroyed: () => false,
      send: (...args: unknown[]) => calls.push(["send", ...args]),
    },
  });
  const appearance = new DesktopAppearance(window, theme, platform);
  return {
    theme,
    window,
    appearance,
    calls,
    blur: () => {
      focused = false;
      window.emit("blur");
    },
  };
}

test("原生侧栏材质跟随外观与窗口焦点，不开放任意原生参数", () => {
  const { appearance, theme, calls, blur } = fixture();
  const first = appearance.setMode("dark");
  assert.equal(theme.themeSource, "dark");
  assert.equal(first.material, "sidebar");
  assert.ok(calls.some((c) => c[0] === "background" && c[1] === "#00000000"));
  blur();
  const last = calls.at(-1)!;
  assert.equal(last[1], "appearance:changed");
  assert.equal((last[2] as any).active, false);
  assert.ok((last[2] as any).revision > first.revision);
  for (const value of ["menu", "transparent", {}, null, undefined])
    assert.throws(() => appearance.setMode(value), /外观模式无效/);
  assert.equal(theme.themeSource, "dark");
});

test("减少透明和增强对比度关闭原生模糊，关闭窗口解除监听", () => {
  const { appearance, theme, calls, window } = fixture();
  theme.prefersReducedTransparency = true;
  theme.emit("updated");
  assert.equal(appearance.setMode("system").material, "solid");
  assert.ok(calls.some((c) => c[0] === "vibrancy" && c[1] === null));
  assert.ok(calls.some((c) => c[0] === "background" && c[1] === "#202022"));
  theme.prefersReducedTransparency = false;
  theme.shouldUseHighContrastColors = true;
  theme.shouldUseDarkColors = false;
  const high = appearance.setMode("light");
  assert.equal(high.highContrast, true);
  assert.equal(high.material, "solid");
  assert.ok(calls.some((c) => c[0] === "background" && c[1] === "#fdfdfd"));
  theme.shouldUseHighContrastColors = false;
  assert.equal(appearance.setMode("light").material, "sidebar");
  window.emit("closed");
  const count = calls.length;
  theme.emit("updated");
  window.emit("focus");
  assert.equal(calls.length, count);
  assert.equal(theme.listenerCount("updated"), 0);
  assert.equal(window.listenerCount("focus"), 0);
});

test("其他平台保留实色，不调用 macOS 材质 API", () => {
  for (const platform of ["linux", "win32"]) {
    const { appearance, calls } = fixture(platform);
    assert.equal(appearance.setMode("system").material, "solid");
    assert.ok(!calls.some((c) => c[0] === "vibrancy"));
  }
});
