import { expect, test, type Page } from "@playwright/test";

async function checkRightRegion(page: Page, selector: string) {
  await expect(page.locator(selector)).toBeVisible();
  await expect(page.locator(".workspace-inspector-controls")).toBeVisible();
  const toolbar = (await page.locator(selector).boundingBox())!;
  const controls = (await page
    .locator(".workspace-inspector-controls")
    .boundingBox())!;
  // macOS drag rectangles do not respect sibling z-index. DOM/AX clicks can
  // pass while a real mouse click is intercepted by the underlying toolbar.
  expect(toolbar.x + toolbar.width).toBeLessThanOrEqual(controls.x);
}

test("普通标题栏的拖动矩形避开收起状态的右栏按钮", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await page.locator(".app").evaluate((el) => {
    (el as HTMLElement).dataset.desktop = "mac";
  });
  const toggle = page.locator(".inspector-toggle");
  if ((await toggle.getAttribute("aria-expanded")) === "true")
    await toggle.click();
  for (const width of [1440, 1000, 760]) {
    await page.setViewportSize({ width, height: 850 });
    await checkRightRegion(page, ".topbar");
    await toggle.click();
    await expect(page.locator(".inspector-header")).toBeVisible();
    await checkRightRegion(page, ".inspector-header");
    await toggle.click();
  }
});

test("浏览器拖动矩形避开左右独立开关，停靠与覆盖模式均可开合", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  const exit = page.getByRole("button", { name: "返回工作空间", exact: true });
  if (await exit.isVisible()) await exit.click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page.getByRole("button", { name: "浏览器 1.0.0", exact: true }).click();
  // Launch is asynchronous. Measure the active toolbar, not the still-visible
  // launcher during its persisted launch request.
  await expect(page.locator(".browser-toolbar")).toBeVisible();
  await page.locator(".app").evaluate((el) => {
    (el as HTMLElement).dataset.desktop = "mac";
  });
  const toggle = page.locator(".inspector-toggle");
  if ((await toggle.getAttribute("aria-expanded")) === "true")
    await toggle.click();
  try {
    for (const width of [1440, 1000, 760]) {
      await page.setViewportSize({ width, height: 850 });
      await checkRightRegion(page, ".browser-toolbar");
      const hide = page.getByRole("button", {
        name: "隐藏侧边栏",
        exact: true,
      });
      if (await hide.isVisible()) await hide.click();
      await checkRightRegion(page, ".browser-toolbar");
      const restore = page.getByRole("button", {
        name: "显示侧边栏",
        exact: true,
      });
      const left = (await restore.boundingBox())!;
      const toolbar = (await page.locator(".browser-toolbar").boundingBox())!;
      expect(toolbar.x).toBeGreaterThanOrEqual(left.x + left.width);
      await expect(page.locator(".browser-toolbar")).toHaveCSS(
        "height",
        "52px",
      );
      await toggle.click();
      await expect(page.locator(".inspector-header")).toBeVisible();
      await checkRightRegion(page, ".browser-toolbar");
      await checkRightRegion(page, ".inspector-header");
      await toggle.click();
      await restore.click();
    }
  } finally {
    if (await exit.isVisible()) await exit.click();
    const close = page.getByRole("button", {
      name: "关闭应用 浏览器",
      exact: true,
    });
    if (await close.isVisible()) await close.click();
  }
});
