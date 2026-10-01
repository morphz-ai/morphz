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

test("真实 Electron：Option 截图仅隐藏主窗口，选完、取消、失败恢复，关窗不复活", async ({}, testInfo) => {
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
  let page: Page | undefined;
  let rendererEvents: unknown;
  const snapshots: unknown[] = [];
  const diagnosticErrors: string[] = [];
  const recordState = async (stage: string) => {
    try {
      const native = await app!.evaluate(({ BrowserWindow }) => ({
        at: Date.now(),
        windows: BrowserWindow.getAllWindows().map((window) => ({
          id: window.id,
          url: window.webContents.getURL(),
          visible: window.isVisible(),
          focused: window.isFocused(),
        })),
      }));
      const renderer = await page!.evaluate(() => ({
        at: Date.now(),
        focused: document.hasFocus(),
        activeElement: document.activeElement?.outerHTML,
        capturing: document
          .querySelector(".capture-dialog")
          ?.getAttribute("data-capturing"),
        alerts: Array.from(
          document.querySelectorAll(".capture-dialog [role='alert']"),
          (element) => element.textContent,
        ),
      }));
      snapshots.push({ stage, native, renderer });
    } catch (error) {
      diagnosticErrors.push(`${stage}: ${String(error)}`);
    }
  };
  try {
    app = await _electron.launch({
      args: ["tests/fixtures/capture-desktop-entry.cjs"],
      env,
    });
    await expect
      .poll(() => app!.windows().some((page) => page.url() === "morphz://app/"))
      .toBe(true);
    page = app.windows().find((page) => page.url() === "morphz://app/")!;
    // Observe native focus and the existing renderer error presentation only.
    // Do not wrap capture.select, change focus, or repair the tested gesture.
    await app.evaluate(({ app, BrowserWindow }) => {
      const events: unknown[] = [];
      (globalThis as any).__captureWindowDiagnostic = events;
      const observe = (window: InstanceType<typeof BrowserWindow>) => {
        const record = (type: string, detail?: unknown) => {
          events.push({
            at: Date.now(),
            type,
            id: window.id,
            url: window.isDestroyed() ? null : window.webContents.getURL(),
            visible: window.isDestroyed() ? null : window.isVisible(),
            focused: window.isDestroyed() ? null : window.isFocused(),
            detail,
          });
        };
        for (const type of ["focus", "blur", "show", "hide", "closed"])
          window.on(type as "focus", () => record(type));
        window.webContents.on("before-input-event", (_event, input) => {
          if (input.key === "Escape" || input.key === "Alt")
            record("key", input);
        });
        record("observed");
      };
      BrowserWindow.getAllWindows().forEach(observe);
      app.on("browser-window-created", (_event, window) => observe(window));
    });
    await page.evaluate(() => {
      const events: unknown[] = [];
      (window as any).__captureWindowDiagnostic = events;
      const record = (type: string, detail?: unknown) => {
        events.push({
          at: Date.now(),
          type,
          focused: document.hasFocus(),
          activeElement: document.activeElement?.outerHTML,
          detail,
        });
      };
      for (const type of ["focus", "blur", "focusin", "focusout"])
        window.addEventListener(type, () => record(type), { capture: true });
      for (const type of ["keydown", "keyup"])
        window.addEventListener(
          type,
          (event) => {
            const key = event as KeyboardEvent;
            if (key.key === "Escape" || key.key === "Alt")
              record(type, { key: key.key, alt: key.altKey });
          },
          { capture: true },
        );
      let previousAlerts = "";
      new MutationObserver(() => {
        const alerts = Array.from(
          document.querySelectorAll(".capture-dialog [role='alert']"),
          (element) => element.textContent,
        );
        const current = JSON.stringify(alerts);
        if (current !== previousAlerts) {
          previousAlerts = current;
          // CaptureDialog presents the actual capture.select rejection message.
          record("capture-select-alerts", alerts);
        }
      }).observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
      });
      record("observed");
    });
    await app.evaluate(({ app, BrowserWindow }) => {
      app.focus({ steal: true });
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "morphz://app/")!
        .focus();
    });
    await expect
      .poll(
        () =>
          app!.evaluate(
            ({ BrowserWindow }) =>
              BrowserWindow.getAllWindows()
                .find(
                  (window) => window.webContents.getURL() === "morphz://app/",
                )
                ?.isFocused() ?? false,
          ),
        { message: "原生截图回归需要已解锁的 macOS 前台窗口" },
      )
      .toBe(true);
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
      diagnosticErrors.push(`picker Escape: ${String(error)}`);
      if (!cancelledPicker.isClosed()) throw error;
    });
    await recordState("after-picker-cancel");
    await expect(dialog.getByAltText("待确认的截图")).toBeVisible();
    expect(await mainVisible(app)).toBe(true);
    expect(await reads()).toHaveLength(2);
    await recordState("after-cancel-preview-restored");

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
    await recordState("before-intentional-main-close");
    rendererEvents = await page
      .evaluate(() => (window as any).__captureWindowDiagnostic)
      .catch((error) => ({ error: String(error) }));
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "morphz://app/")!
        .close();
    });
    await expect.poll(() => app!.windows().length).toBe(0);
  } finally {
    if (app && page) {
      if (!page.isClosed()) await recordState("before-fixture-cleanup");
      const nativeEvents = await app
        .evaluate(() => (globalThis as any).__captureWindowDiagnostic)
        .catch((error) => ({ error: String(error) }));
      if (!page.isClosed()) {
        rendererEvents = await page
          .evaluate(() => (window as any).__captureWindowDiagnostic)
          .catch((error) => ({ error: String(error) }));
      }
      await testInfo.attach("capture-window-focus-diagnostic", {
        body: Buffer.from(
          JSON.stringify(
            { snapshots, nativeEvents, rendererEvents, diagnosticErrors },
            null,
            2,
          ),
        ),
        contentType: "application/json",
      });
    }
    await app?.close();
    await rm(fixture, { recursive: true, force: true });
  }
});
