import { _electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceStore } from "../dist/service/packages/application/src/store.js";
const directory = mkdtempSync(join(tmpdir(), "morphz-embedded-electron-"));
const site = createServer((_req, res) =>
  res.end(
    "<!doctype html><meta charset=utf-8><title>TEST 浏览器收藏</title><h1>TEST 浏览器收藏</h1>",
  ),
);
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${site.address().port}/`;
const env = {
  ...process.env,
  MORPHZ_APP_EMBEDDED_FIXTURE: directory,
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
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page.getByRole("button", { name: "浏览器 1.0.0", exact: true }).click();
  const address = page.getByRole("textbox", { name: "网站地址" });
  await address.fill(url);
  await address.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.morphzDesktop.browser.state().then((p) => p?.title),
      ),
    )
    .toBe("TEST 浏览器收藏");
  await page.getByRole("button", { name: "收藏此页", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "编辑当前收藏" }),
  ).toHaveAttribute("aria-pressed", "true");
  const windowHandle = await app.browserWindow(page);
  const dialog = page.getByRole("dialog", { name: "浏览器收藏" });
  mkdirSync("test-results", { recursive: true });
  for (const [width, height, zoom] of [
    [1380, 920, 1],
    [760, 540, 1],
    [1380, 920, 2],
  ]) {
    await windowHandle.evaluate(
      (w, s) => {
        w.webContents.setZoomFactor(s.zoom);
        w.setBounds({ width: s.width, height: s.height });
      },
      { width, height, zoom },
    );
    await page.getByRole("button", { name: "浏览器收藏", exact: true }).click();
    await expect(
      page.getByRole("button", {
        name: "打开收藏：TEST 浏览器收藏",
        exact: true,
      }),
    ).toBeInViewport();
    await expect
      .poll(() =>
        dialog.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return (
            r.x >= 0 &&
            r.right <= innerWidth &&
            el.scrollWidth <= el.clientWidth
          );
        }),
      )
      .toBe(true);
    // A real native page must yield while the DOM dialog is open.
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.morphzDesktop.browser.state().then((p) => p?.visible),
        ),
      )
      .toBe(false);
    await page
      .getByRole("button", { name: "编辑收藏：TEST 浏览器收藏" })
      .click();
    await expect(
      page.getByRole("button", { name: "保存", exact: true }),
    ).toBeInViewport();
    await page.screenshot({
      path: `test-results/bookmarks-electron-${width}-${zoom}.png`,
    });
    await page.keyboard.press("Escape");
  }
  await page.getByRole("button", { name: "浏览器收藏", exact: true }).click();
  await page.getByRole("button", { name: "移除收藏：TEST 浏览器收藏" }).click();
  await expect(
    dialog.getByRole("button", {
      name: "打开收藏：TEST 浏览器收藏",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page
    .getByRole("button", { name: "打开收藏：TEST 浏览器收藏", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "编辑当前收藏" }),
  ).toBeVisible();
  const store = new WorkspaceStore(join(directory, "data/workspace.sqlite"));
  assert.equal(store.snapshot().artifacts.length, 0);
  assert.equal(
    store.snapshot().bookmarks.filter((b) => !b.deletedAt).length,
    1,
  );
  store.close();
  console.log(
    "PASS production Electron bookmarks: native page, IPC persistence, edit/delete/undo, reload, 760px and 200% zoom",
  );
} finally {
  await app?.close();
  await new Promise((resolve) => site.close(resolve));
}
