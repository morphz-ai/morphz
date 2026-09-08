import { openLibrary } from "./application-helpers.js";
import { test, expect } from "@playwright/test";
test("通知可打开事项，已读与提醒范围刷新后保留", async ({ page }) => {
  await page.goto("/");
  await openLibrary(page);
  await page
    .locator(".creation-actions")
    .getByRole("button", { name: "新建事项" })
    .click();
  await page.getByLabel("新对象标题", { exact: true }).fill("通知设置验证");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.getByRole("button", { name: /^通知，/ })).toBeVisible({
    timeout: 6000,
  });
  await page.locator(".notification-trigger").click();
  const dialog = page.locator(".notification-dialog");
  await expect(
    dialog.getByRole("button", { name: /通知设置验证/ }),
  ).toBeVisible();
  await dialog.getByLabel("通知提醒范围").selectOption("off");
  await expect(dialog.getByLabel("通知提醒范围")).toHaveValue("off");
  await dialog.getByRole("button", { name: /通知设置验证/ }).click();
  await expect(page.locator(".object-paper > h1")).toHaveText("通知设置验证");
  await page.reload();
  await page.getByRole("button", { name: "通知", exact: true }).click();
  await expect(dialog.getByLabel("通知提醒范围")).toHaveValue("off");
  await expect(
    dialog.getByRole("button", { name: /通知设置验证/ }),
  ).toHaveAttribute("data-unread", "false");
  await page.screenshot({ path: "test-results/notifications.png" });
});
