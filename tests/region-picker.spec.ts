import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).selected = [];
    (window as any).cancelled = 0;
    (window as any).regionPicker = {
      select: (rectangle: unknown) => (window as any).selected.push(rectangle),
      cancel: () => (window as any).cancelled++,
    };
  });
  await page.route("http://picker.test/**", async (route) => {
    const filename =
      new URL(route.request().url()).pathname.split("/").at(-1) ||
      "region-picker.html";
    if (
      !["region-picker.html", "region-picker.css", "region-picker.js"].includes(
        filename,
      )
    )
      return route.abort();
    await route.fulfill({
      body: await readFile(
        new URL(`../apps/desktop/${filename}`, import.meta.url),
      ),
      contentType: filename.endsWith("html")
        ? "text/html"
        : filename.endsWith("css")
          ? "text/css"
          : "text/javascript",
    });
  });
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto("http://picker.test/");
});

test("点击即有暗幕和截图状态，没有预设矩形；按下拖出矩形，松手直接确认", async ({
  page,
}) => {
  await expect(page.getByText("截图", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).not.toContainText("拖动划区");
  await expect(page.getByRole("status")).not.toContainText("松开截图");
  await expect(page.locator("#selection")).toBeHidden();
  expect(
    await page
      .locator("#shade")
      .evaluate((path) => getComputedStyle(path).fill),
  ).toBe("rgba(0, 0, 0, 0.34)");
  await page.mouse.move(220, 180);
  await page.mouse.down();
  await page.mouse.move(680, 420, { steps: 8 });
  await expect(page.locator("#selection")).toHaveCSS("width", "460px");
  await expect(page.locator("#selection")).toHaveCSS("height", "240px");
  await expect(page.locator("#shade")).toHaveAttribute(
    "d",
    /M220 180h460v240h-460Z/,
  );
  await expect(page.locator("#size")).toHaveText("460 × 240");
  expect(await page.evaluate(() => (window as any).selected)).toEqual([]);
  await page.screenshot({ path: "test-results/free-region-drag.png" });
  await page.mouse.up();
  expect(await page.evaluate(() => (window as any).selected)).toEqual([
    { x: 220, y: 180, width: 460, height: 240 },
  ]);
});

test("反向划区有效，单击不截屏且可重新划区", async ({ page }) => {
  await page.mouse.click(300, 220);
  expect(await page.evaluate(() => (window as any).selected)).toEqual([]);
  await expect(page.locator("#selection")).toBeHidden();
  await page.mouse.move(680, 420);
  await page.mouse.down();
  await page.mouse.move(220, 180);
  await page.mouse.up();
  expect(await page.evaluate(() => (window as any).selected)).toEqual([
    { x: 220, y: 180, width: 460, height: 240 },
  ]);
});

test("Esc 和可见取消按钮都取消，不选取默认区域", async ({ page }) => {
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => (window as any).cancelled)).toBe(1);
  expect(await page.evaluate(() => (window as any).selected)).toEqual([]);
  await page.reload();
  await page.getByRole("button", { name: "取消截图" }).click();
  expect(await page.evaluate(() => (window as any).cancelled)).toBe(1);
  expect(await page.evaluate(() => (window as any).selected)).toEqual([]);
});
