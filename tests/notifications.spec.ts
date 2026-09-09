import { openLibrary } from "./application-helpers.js";
import { seedLibraryArtifact, humanTask } from "./artifact-fixtures.js";
import { test, expect } from "@playwright/test";
test("通知可打开事项，已读与提醒范围刷新后保留", async ({ page }) => {
  await page.goto("/");
  await openLibrary(page);
  await seedLibraryArtifact(page, "通知设置验证", humanTask());
  await expect(page.getByRole("button", { name: /^通知，/ })).toBeVisible({
    timeout: 6000,
  });
  await page.locator(".notification-trigger").click();
  const dialog = page.locator(".notification-dialog");
  await expect(
    dialog.getByRole("button", { name: /通知设置验证/ }),
  ).toBeVisible();
  await dialog.getByRole("radio", { name: "不提示", exact: true }).click();
  await expect(
    dialog.getByRole("radio", { name: "不提示", exact: true }),
  ).toBeChecked();
  await dialog.getByRole("button", { name: /通知设置验证/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "通知设置验证", exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "通知", exact: true }).click();
  await expect(
    dialog.getByRole("radio", { name: "不提示", exact: true }),
  ).toBeChecked();
  await expect(
    dialog.getByRole("button", { name: /通知设置验证/ }),
  ).toHaveAttribute("data-unread", "false");
  await page.screenshot({ path: "test-results/notifications.png" });
});

test("通知比例紧凑，提醒范围支持键盘且失败不显示为已保存", async ({ page }) => {
  // Keep real settings persistence while isolating the empty list from other tests' tasks.
  await page.route("**/api/notifications", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const state = await response.json();
    await route.fulfill({ response, json: { ...state, items: [], unread: 0 } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "通知", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "通知", exact: true });
  await expect(
    dialog.getByRole("heading", { name: "通知", exact: true }),
  ).toBeFocused();
  await expect(dialog.getByRole("group", { name: "提醒范围" })).toBeVisible();
  await expect(dialog.getByRole("combobox")).toHaveCount(0);
  await expect(dialog.getByText("暂无通知", { exact: true })).toBeVisible();
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.width).toBeLessThanOrEqual(440);
  expect(bounds.height).toBeLessThan(150);
  const header = (await dialog.locator("header").boundingBox())!;
  expect(header.height).toBeLessThanOrEqual(38);
  const list = (await dialog.locator(".notification-list").boundingBox())!;
  expect(list.y - header.y - header.height).toBeLessThanOrEqual(4);
  const all = dialog.getByRole("radio", { name: "全部事项", exact: true });
  await all.click();
  await expect(all).toBeChecked();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "通知", exact: true }).click();
  await page.keyboard.press("Tab");
  await expect(all).toBeFocused();
  await all.press("ArrowRight");
  await expect(dialog.getByRole("radio", { name: "仅高优先级" })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: "仅高优先级" })).toBeFocused();
  await expect(dialog.locator("input:checked + span")).toHaveCSS(
    "outline-width",
    "2px",
  );
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "关闭通知" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "通知", exact: true }),
  ).toBeFocused();
  await page.reload();
  await page.getByRole("button", { name: "通知", exact: true }).click();
  await expect(dialog.getByRole("radio", { name: "仅高优先级" })).toBeChecked();
  await page.route("**/api/notifications", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":"test unavailable"}',
      });
    } else await route.fallback();
  });
  await dialog.getByRole("radio", { name: "不提示", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "通知设置未保存，请重试。",
  );
  await expect(dialog.getByRole("radio", { name: "仅高优先级" })).toBeChecked();
  await page.setViewportSize({ width: 380, height: 540 });
  const small = (await dialog.boundingBox())!;
  expect(small.x).toBeGreaterThanOrEqual(19);
  expect(small.x + small.width).toBeLessThanOrEqual(361);
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
});
