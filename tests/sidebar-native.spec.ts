import { openSettings } from "./settings-helpers.js";
import { test, expect, _electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("真实 Electron 外观桥接与原生材质只作用于受信主窗口", async ({
  request,
}) => {
  test.skip(process.platform !== "darwin", "macOS 原生材质专项");
  const directory = await mkdtemp(join(tmpdir(), "morphz-sidebar-native-"));
  const before = await (await request.get("/api/workspace")).json();
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && entry[0] !== "ELECTRON_RUN_AS_NODE",
    ),
  );
  env.MORPHZ_APP_PROFILE = directory;
  const desktop = await _electron.launch({
    args: [
      "tests/fixtures/remote-desktop-entry.cjs",
      "--center=http://127.0.0.1:65421",
    ],
    env,
  });
  try {
    const page = await desktop.firstWindow();
    await expect(page.locator(".app")).toBeVisible();
    // Inspect Chromium's actual native-region CSS as well as DOM clicks:
    // Playwright's renderer input alone does not exercise macOS hit-testing.
    for (const [width, zoom] of [
      [1440, 1],
      [1000, 1],
      [1440, 2],
    ]) {
      await desktop.evaluate(
        ({ BrowserWindow }, { width, zoom }) => {
          const window = BrowserWindow.getAllWindows()[0]!;
          window.setSize(width, 900);
          window.webContents.setZoomFactor(zoom);
        },
        { width: width!, zoom: zoom! },
      );
      const toggle = page.locator(".inspector-toggle");
      await toggle.click();
      await expect(page.locator(".inspector-header")).toBeVisible();
      await expect
        .poll(async () => {
          const header = (await page
            .locator(".inspector-header")
            .boundingBox())!;
          const controls = (await page
            .locator(".workspace-inspector-controls")
            .boundingBox())!;
          return header.x + header.width <= controls.x;
        })
        .toBe(true);
      await page.getByRole("button", { name: "切换右栏内容" }).click();
      const menu = page.getByRole("group", { name: "右栏内容" });
      const regions = await menu.evaluate((element) => [
        getComputedStyle(element).getPropertyValue("-webkit-app-region"),
        getComputedStyle(element, "::backdrop").getPropertyValue(
          "-webkit-app-region",
        ),
      ]);
      expect(regions).toEqual(["no-drag", "no-drag"]);
      await toggle.click();
      await expect(page.locator(".workspace-inspector")).toHaveCount(0);
    }
    await desktop.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.webContents.setZoomFactor(1);
      window.setSize(1440, 960);
    });
    await expect(page.locator("html")).toHaveAttribute(
      "data-native-material",
      /sidebar|solid/,
    );
    const reduced = await desktop.evaluate(
      ({ nativeTheme }) =>
        nativeTheme.prefersReducedTransparency ||
        nativeTheme.shouldUseHighContrastColors,
    );
    await expect(page.locator("html")).toHaveAttribute(
      "data-native-material",
      reduced ? "solid" : "sidebar",
    );
    for (const [label, value] of [
      ["亮色", "light"],
      ["暗色", "dark"],
      ["跟随系统", "system"],
    ]) {
      await openSettings(page, "外观");
      await page.getByRole("button", { name: label, exact: true }).click();
      await expect
        .poll(() =>
          desktop.evaluate(({ nativeTheme }) => nativeTheme.themeSource),
        )
        .toBe(value);
      await page.keyboard.press("Escape");
      expect(
        await page
          .locator(".workspace")
          .evaluate((el) => getComputedStyle(el).backgroundColor),
      ).not.toContain("rgba");
    }
    const bridge = await page.evaluate(async () => {
      const native = window.morphzDesktop!.appearance!;
      let changed = 0;
      const off = native.onChange(() => changed++);
      await native.setMode("dark");
      await new Promise((resolve) => setTimeout(resolve, 50));
      off();
      const previous = changed;
      await native.setMode("light");
      await new Promise((resolve) => setTimeout(resolve, 50));
      let invalidRejected = false;
      try {
        await native.setMode("menu" as "light");
      } catch {
        invalidRejected = true;
      }
      await native.setMode("system");
      return {
        previous,
        changed,
        invalidRejected,
        node: typeof (window as any).require,
      };
    });
    expect(bridge.previous).toBeGreaterThan(0);
    expect(bridge.changed).toBe(bridge.previous);
    expect(bridge.invalidRejected).toBe(true);
    expect(bridge.node).toBe("undefined");
    const unchanged = await desktop.evaluate(
      async ({ BrowserWindow, nativeTheme }) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        const vibrancy = window.setVibrancy.bind(window);
        const background = window.setBackgroundColor.bind(window);
        const send = window.webContents.send.bind(window.webContents);
        let materialWrites = 0;
        let backgroundWrites = 0;
        let appearanceMessages = 0;
        window.setVibrancy = (...args) => {
          materialWrites++;
          return vibrancy(...args);
        };
        window.setBackgroundColor = (...args) => {
          backgroundWrites++;
          return background(...args);
        };
        window.webContents.send = (channel, ...args) => {
          if (channel === "appearance:changed") appearanceMessages++;
          return send(channel, ...args);
        };
        try {
          for (let n = 0; n < 100; n++) nativeTheme.emit("updated");
          await new Promise((resolve) => setTimeout(resolve, 250));
          return { materialWrites, backgroundWrites, appearanceMessages };
        } finally {
          window.setVibrancy = vibrancy;
          window.setBackgroundColor = background;
          window.webContents.send = send;
        }
      },
    );
    expect(unchanged).toEqual({
      materialWrites: 0,
      backgroundWrites: 0,
      appearanceMessages: 0,
    });
    await page.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.id = "untrusted-material-frame";
      frame.srcdoc =
        "<!doctype html><title>权限隔离验收</title><p>独立子页面</p>";
      document.body.append(frame);
    });
    const frame = page.frameLocator("#untrusted-material-frame");
    await expect(frame.locator("body")).toBeVisible();
    expect(
      await frame.locator("body").evaluate(() => typeof window.morphzDesktop),
    ).toBe("undefined");
    const after = await (await request.get("/api/workspace")).json();
    expect(after.workspace.inputs).toHaveLength(before.workspace.inputs.length);
    expect(after.workspace.artifacts).toHaveLength(
      before.workspace.artifacts.length,
    );
  } finally {
    await desktop.close();
    await rm(directory, { recursive: true, force: true });
  }
});
