import { _electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Production IPC/protocol and real Electron layout, always in disposable data.
const fixture = mkdtempSync(join(tmpdir(), "morphz-embedded-electron-"));
const env = {
  ...process.env,
  MORPHZ_APP_EMBEDDED_FIXTURE: fixture,
  MORPHZ_APP_ENV_FILE: "",
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await _electron.launch({
    args: ["tests/fixtures/production-desktop-entry.cjs"],
    env,
  });
  await expect
    .poll(() => app.windows().some((p) => p.url() === "morphz://app/"), {
      timeout: 20000,
    })
    .toBe(true);
  const page = app.windows().find((p) => p.url() === "morphz://app/");
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "项目", exact: true })
    .click();
  mkdirSync("test-results", { recursive: true });
  for (const [width, height, zoom] of [
    [1380, 920, 1],
    [760, 540, 1],
    [1380, 920, 2],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, [w, h, z]) => {
        const win = BrowserWindow.getAllWindows().find(
          (w) => w.webContents.getURL() === "morphz://app/",
        );
        win.setSize(w, h);
        win.webContents.setZoomFactor(z);
      },
      [width, height, zoom],
    );
    await page.getByRole("button", { name: "创建项目", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建项目", exact: true });
    const input = dialog.getByRole("textbox", {
      name: "项目名称",
      exact: true,
    });
    await expect(input).toBeFocused();
    await input.fill("项目界面验收");
    const bounds = await dialog.boundingBox(),
      viewport = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    assert.ok(
      bounds.x >= 0 &&
        bounds.y >= 0 &&
        bounds.x + bounds.width <= viewport.w &&
        bounds.y + bounds.height <= viewport.h,
    );
    assert.ok(bounds.width <= 420 && bounds.height < 190);
    // Hit-test the actual compact confirm/close controls, not just CSS dimensions.
    for (const label of ["创建", "关闭新建窗口"]) {
      const button = dialog.getByRole("button", { name: label, exact: true });
      await expect(button).toBeVisible();
      assert.ok(
        await button.evaluate((el) => {
          const b = el.getBoundingClientRect();
          return el.contains(
            document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2),
          );
        }),
      );
    }
    await page.screenshot({
      path: `test-results/projects-dialog-${width}-${zoom}.png`,
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  }
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(
      (w) => w.webContents.getURL() === "morphz://app/",
    );
    win.webContents.setZoomFactor(1);
    win.setSize(1380, 920);
  });
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  await page
    .getByRole("textbox", { name: "项目名称", exact: true })
    .fill("TEST 原生项目管理");
  await page
    .getByRole("textbox", { name: "项目名称", exact: true })
    .press("Enter");
  const group = page.getByRole("group", {
    name: "TEST 原生项目管理的会话",
    exact: true,
  });
  await expect(group).toBeVisible();
  await group
    .getByLabel("项目操作：TEST 原生项目管理", { exact: true })
    .click();
  await page
    .getByRole("button", { name: "重命名项目：TEST 原生项目管理", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "项目名称", exact: true })
    .fill("TEST 原生项目已改名");
  await page
    .getByRole("textbox", { name: "项目名称", exact: true })
    .press("Enter");
  await expect(
    page.getByRole("group", { name: "TEST 原生项目已改名的会话", exact: true }),
  ).toBeVisible();
  const renamed = page.getByRole("group", {
    name: "TEST 原生项目已改名的会话",
    exact: true,
  });
  await renamed
    .getByLabel("项目操作：TEST 原生项目已改名", { exact: true })
    .click();
  await page
    .getByRole("button", { name: "归档项目：TEST 原生项目已改名", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "归档项目", exact: true })
    .click();
  await expect(renamed).toHaveCount(0);
  await page.getByLabel("项目范围", { exact: true }).selectOption("archived");
  await page.reload();
  await expect(page.getByLabel("项目范围", { exact: true })).toHaveValue(
    "archived",
  );
  const card = page.locator(".project-card").filter({
    has: page.getByRole("heading", {
      name: "TEST 原生项目已改名",
      exact: true,
    }),
  });
  await card
    .getByLabel("项目操作：TEST 原生项目已改名", { exact: true })
    .click();
  await page
    .getByRole("button", { name: "恢复项目：TEST 原生项目已改名", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "恢复项目", exact: true })
    .click();
  await expect(renamed).toBeVisible();
  await page.getByLabel("项目范围", { exact: true }).selectOption("active");
  await page.screenshot({ path: "test-results/projects-desktop.png" });
  assert.deepEqual(errors, []);
  console.log(
    "PASS production Electron: project create/rename/archive/restore, IPC persistence, real control hit tests, compact modal at 760×540 and 200% zoom.",
  );
} finally {
  if (app) await app.close();
  rmSync(fixture, { recursive: true, force: true });
}
