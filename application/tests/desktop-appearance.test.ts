import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  DesktopAppearance,
  windowAppearanceOptions,
} = require("../apps/desktop/appearance.cjs");

function fixture(
  platform = "darwin",
  materialNotifiesTheme = false,
  initialized = false,
) {
  const theme = Object.assign(new EventEmitter(), {
    themeSource: "system",
    shouldUseDarkColors: true,
    prefersReducedTransparency: false,
    shouldUseHighContrastColors: false,
  });
  const calls: unknown[][] = [];
  let nativeNotifications = 0;
  const nativeChange = (kind: string, value: unknown) => {
    calls.push([kind, value]);
    // Bound a broken implementation so the regression reports useful counts
    // instead of exhausting the stack when AppKit reports an appearance update.
    if (materialNotifiesTheme && nativeNotifications++ < 100)
      theme.emit("updated");
  };
  let focused = true;
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isFocused: () => focused,
    setVibrancy: (v: unknown) => nativeChange("vibrancy", v),
    setBackgroundColor: (v: unknown) => nativeChange("background", v),
    webContents: {
      isDestroyed: () => false,
      send: (...args: unknown[]) => calls.push(["send", ...args]),
    },
  });
  const appearance = new DesktopAppearance(
    window,
    theme,
    platform,
    initialized ? windowAppearanceOptions(theme, platform) : null,
  );
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

test("窗口在创建时就配置透明原生材质，不先创建不透明绘制表面", () => {
  const { theme, appearance, calls } = fixture("darwin", false, true);
  assert.deepEqual(windowAppearanceOptions(theme, "darwin"), {
    backgroundColor: "#00000000",
    vibrancy: "sidebar",
    visualEffectState: "followWindow",
  });
  assert.equal(appearance.setMode("system").material, "sidebar");
  assert.equal(calls.filter(([kind]) => kind !== "send").length, 0);
  theme.prefersReducedTransparency = true;
  assert.deepEqual(windowAppearanceOptions(theme, "darwin"), {
    backgroundColor: "#202022",
  });
  theme.prefersReducedTransparency = false;
  for (const platform of ["linux", "win32"])
    assert.deepEqual(windowAppearanceOptions(theme, platform), {
      backgroundColor: "#202022",
    });
});

test("重复的原生外观通知不重建侧栏材质或重复发布状态", () => {
  const { appearance, theme, calls } = fixture();
  const initial = appearance.setMode("system");
  calls.length = 0;
  for (let n = 0; n < 1000; n++) theme.emit("updated");
  assert.equal(calls.length, 0);
  assert.deepEqual(appearance.setMode("system"), initial);
  assert.equal(calls.length, 0);
  theme.shouldUseDarkColors = false;
  theme.emit("updated");
  assert.equal(calls.filter(([kind]) => kind === "send").length, 1);
  assert.equal(calls.filter(([kind]) => kind !== "send").length, 0);
});

test("原生材质设置再次触发主题通知时不会形成刷新循环", () => {
  const { appearance, theme, calls } = fixture("darwin", true);
  assert.deepEqual(
    calls.filter(([kind]) => kind !== "send"),
    [
      ["vibrancy", "sidebar"],
      ["background", "#00000000"],
    ],
  );
  assert.equal(calls.filter(([kind]) => kind === "send").length, 1);
  calls.length = 0;
  theme.prefersReducedTransparency = true;
  theme.emit("updated");
  assert.equal(appearance.setMode("system").material, "solid");
  assert.deepEqual(
    calls.filter(([kind]) => kind !== "send"),
    [
      ["vibrancy", null],
      ["background", "#202022"],
    ],
  );
  assert.equal(calls.filter(([kind]) => kind === "send").length, 1);
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
