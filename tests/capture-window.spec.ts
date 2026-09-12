import {
  _electron,
  test,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openInput } from "./interaction-helpers.js";

async function mainVisible(app: ElectronApplication) {
  return app.evaluate(
    ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "morphz://app/")
        ?.isVisible() ?? false,
  );
}

async function picker(app: ElectronApplication): Promise<Page> {
  await expect
    .poll(() =>
      app.windows().some((page) => page.url().endsWith("/region-picker.html")),
    )
    .toBe(true);
  const page = app
    .windows()
    .find((page) => page.url().endsWith("/region-picker.html"))!;
  await expect(page.getByRole("status")).toBeVisible();
  return page;
}

async function selectRegion(page: Page) {
  await page.mouse.move(160, 160);
  await page.mouse.down();
  await page.mouse.move(340, 290);
  await page.mouse.up();
}

test("真实 Electron：Option 截图仅隐藏主窗口，选完、取消、失败恢复，关窗不复活", async () => {
  test.skip(process.platform !== "darwin", "原生截图后端当前仅接入 macOS");
  test.setTimeout(45000);
  const fixture = await mkdtemp(join(tmpdir(), "morphz-embedded-electron-"));
  const env: Record<string, string> = Object.fromEntries(
    Object.entries({
      ...process.env,
      MORPHZ_APP_EMBEDDED_FIXTURE: fixture,
      MORPHZ_APP_ENV_FILE: "",
    }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | undefined;
  try {
    app = await _electron.launch({
      args: ["tests/fixtures/capture-desktop-entry.cjs"],
      env,
    });
    await expect
      .poll(() => app!.windows().some((page) => page.url() === "morphz://app/"))
      .toBe(true);
    const page = app.windows().find((page) => page.url() === "morphz://app/")!;
    await app.evaluate(({ app, BrowserWindow }) => {
      app.focus({ steal: true });
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "morphz://app/")!
        .focus();
    });
    const input = await openInput(page);
    await input.fill("Electron 截图隔离回归：保留草稿");
    const trigger = page.getByRole("button", { name: "截图输入", exact: true });
    await trigger.click({ modifiers: ["Alt"] });
    const firstPicker = await picker(app);
    expect(await mainVisible(app)).toBe(false);
    // Auxiliary-window activation must not restore the main window into the shot.
    await app.evaluate(({ app }) => app.emit("activate"));
    expect(await mainVisible(app)).toBe(false);
    await selectRegion(firstPicker);
    const dialog = page.getByRole("dialog", { name: "截图输入", exact: true });
    await expect(dialog.getByAltText("待确认的截图")).toBeVisible();
    expect(await mainVisible(app)).toBe(true);
    const reads = () =>
      app!.evaluate(() => (globalThis as any).__captureWindowFixture.reads);
    expect(await reads()).toEqual([{ visible: false }]);

    // Real Chromium zoom changes the CSS viewport, not just the screenshot size.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "morphz://app/")!
        .webContents.setZoomFactor(2);
    });
    await expect
      .poll(() =>
        dialog.evaluate((el) => {
          const box = el.getBoundingClientRect();
          return (
            box.left >= 0 &&
            box.right <= innerWidth &&
            box.top >= 0 &&
            box.bottom <= innerHeight &&
            el.scrollWidth <= el.clientWidth
          );
        }),
      )
      .toBe(true);
    await expect(
      dialog.getByRole("button", { name: "添加到消息", exact: true }),
    ).toBeInViewport();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "morphz://app/")!
        .webContents.setZoomFactor(1);
    });

    const retry = dialog.getByRole("button", { name: "重新划区", exact: true });
    await retry.click();
    const normalPicker = await picker(app);
    expect(await mainVisible(app)).toBe(true);
    await selectRegion(normalPicker);
    await expect(dialog.getByAltText("待确认的截图")).toBeVisible();
    expect(await reads()).toEqual([{ visible: false }, { visible: true }]);

    await retry.click({ modifiers: ["Alt"] });
    const cancelledPicker = await picker(app);
    expect(await mainVisible(app)).toBe(false);
    await cancelledPicker.keyboard.press("Escape").catch((error) => {
      // Escape destroys the native picker on keydown, before Playwright sends keyup.
      if (!cancelledPicker.isClosed()) throw error;
    });
    await expect(dialog.getByAltText("待确认的截图")).toBeVisible();
    expect(await mainVisible(app)).toBe(true);
    expect(await reads()).toHaveLength(2);

    await app.evaluate(() => {
      (globalThis as any).__captureWindowFixture.fail = true;
    });
    await retry.click({ modifiers: ["Alt"] });
    await selectRegion(await picker(app));
    await expect(dialog.getByRole("alert")).toContainText("截图未成功");
    expect(await mainVisible(app)).toBe(true);
    await expect(dialog.getByAltText("待确认的截图")).toBeVisible();
    await dialog.getByRole("button", { name: "关闭截图输入" }).click();
    await expect(input).toHaveValue("Electron 截图隔离回归：保留草稿");
    await expect(trigger).toBeFocused();

    await trigger.click({ modifiers: ["Alt"] });
    await picker(app);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "morphz://app/")!
        .close();
    });
    await expect.poll(() => app!.windows().length).toBe(0);
  } finally {
    await app?.close();
    await rm(fixture, { recursive: true, force: true });
  }
});
