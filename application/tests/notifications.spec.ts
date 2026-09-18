import { openLibrary } from "./application-helpers.js";
import { seedLibraryArtifact, humanTask } from "./artifact-fixtures.js";
import { test, expect } from "@playwright/test";
import { openSettings } from "./settings-helpers.js";
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});
test("旧提醒范围需要明确选择，不再出现高优先级选项", async ({ page }) => {
  let mode = "off",
    needsReview = true;
  await page.route("**/api/notifications", (route) => {
    if (route.request().method() === "POST") {
      mode = route.request().postDataJSON().mode;
      needsReview = false;
    }
    return route.fulfill({ json: { mode, needsReview, unread: 0, items: [] } });
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "通知，提醒范围待确认", exact: true })
    .click();
  let dialog = page.getByRole("dialog", { name: "通知", exact: true });
  await expect(dialog.getByRole("status")).toContainText(
    "旧提醒范围已停用，请重新选择。",
  );
  await expect(dialog.getByRole("radio")).toHaveCount(0);
  await dialog.getByRole("button", { name: "通知设置", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await expect(dialog.getByRole("radio")).toHaveCount(2);
  await expect(
    dialog.getByRole("radio", { name: "不提示", exact: true }),
  ).not.toBeChecked();
  await dialog.getByRole("radio", { name: "全部提醒", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await openSettings(page, "通知");
  await expect(
    dialog.getByRole("radio", { name: "全部提醒", exact: true }),
  ).toBeChecked();
});

test("旧的待同步已读回执遇到一次断线后，转换成当前通知继续同步", async ({
  page,
}) => {
  const boot = await (await page.request.get("/api/workspace")).json();
  const key = `morphz:${boot.centerId}:${boot.principalId}:notification-reads`;
  const legacy = "a".repeat(64),
    current = "b".repeat(64);
  await page.addInitScript(
    ({ key, legacy }) => localStorage.setItem(key, JSON.stringify([legacy])),
    { key, legacy },
  );
  const receipts: string[][] = [];
  let read = false;
  await page.route("**/api/notifications", (route) => {
    if (route.request().method() === "POST") {
      const ids = route.request().postDataJSON().ids;
      receipts.push(ids);
      if (receipts.length === 1)
        return route.fulfill({ status: 503, json: { error: "offline" } });
      read = ids.includes(current);
    }
    return route.fulfill({
      json: {
        mode: "all",
        unread: read ? 0 : 1,
        items: [
          {
            id: current,
            artifactId: "test",
            title: "TEST 旧已读",
            reason: "需要你参与的事项",
            read,
            readAliases: [legacy],
          },
        ],
      },
    });
  });
  await page.goto("/");
  await expect.poll(() => receipts.length, { timeout: 7000 }).toBe(2);
  expect(receipts).toEqual([[legacy], [current]]);
  await expect(
    page.getByRole("button", { name: "通知", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) ?? "[]"),
      key,
    ),
  ).toEqual([]);
});

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
  await dialog.getByRole("button", { name: "通知设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await settings.getByRole("radio", { name: "不提示", exact: true }).click();
  await expect(
    settings.getByRole("radio", { name: "不提示", exact: true }),
  ).toBeChecked();
  await page.keyboard.press("Escape");
  await page.locator(".notification-trigger").click();
  await dialog.getByRole("button", { name: /通知设置验证/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "通知设置验证", exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "通知", exact: true }).click();
  await dialog.getByRole("button", { name: "通知设置", exact: true }).click();
  await expect(
    settings.getByRole("radio", { name: "不提示", exact: true }),
  ).toBeChecked();
  await page.keyboard.press("Escape");
  await page.locator(".notification-trigger").click();
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
  let dialog = page.getByRole("dialog", { name: "通知", exact: true });
  await expect(
    dialog.getByRole("heading", { name: "通知", exact: true }),
  ).toBeFocused();
  await expect(dialog.getByRole("group", { name: "提醒范围" })).toBeHidden();
  await expect(dialog.getByRole("combobox")).toHaveCount(0);
  await expect(dialog.getByText("暂无通知", { exact: true })).toBeVisible();
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.width).toBeLessThanOrEqual(440);
  expect(bounds.height).toBeLessThan(150);
  const header = (await dialog.locator("header").boundingBox())!;
  expect(header.height).toBeLessThanOrEqual(38);
  const list = (await dialog.locator(".notification-list").boundingBox())!;
  expect(list.y - header.y - header.height).toBeLessThanOrEqual(4);
  await dialog.getByRole("button", { name: "通知设置", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "设置", exact: true });
  const all = dialog.getByRole("radio", { name: "全部提醒", exact: true });
  await all.click();
  await expect(all).toBeChecked();
  await page.keyboard.press("Escape");
  await page.locator(".notification-trigger").click();
  await page.getByRole("button", { name: "通知设置", exact: true }).click();
  await all.focus();
  await expect(all).toBeFocused();
  await all.press("ArrowRight");
  await expect(dialog.getByRole("radio", { name: "不提示" })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: "不提示" })).toBeFocused();
  await expect(dialog.locator("input:checked + span")).toHaveCSS(
    "outline-width",
    "2px",
  );
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("button", { name: "智能体连接", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "通知", exact: true }),
  ).toBeFocused();
  await page.reload();
  await page.getByRole("button", { name: "通知", exact: true }).click();
  await page.getByRole("button", { name: "通知设置", exact: true }).click();
  await expect(dialog.getByRole("radio", { name: "不提示" })).toBeChecked();
  await page.route("**/api/notifications", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":"test unavailable"}',
      });
    } else await route.fallback();
  });
  await all.click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "通知设置未保存，请重试。",
  );
  await expect(dialog.getByRole("radio", { name: "不提示" })).toBeChecked();
  // A successful background GET must not erase a failed setting write.
  await page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/notifications") &&
      response.request().method() === "GET",
    { timeout: 6000 },
  );
  await expect(dialog.getByRole("alert")).toHaveText(
    "通知设置未保存，请重试。",
  );
  await page.setViewportSize({ width: 380, height: 540 });
  // Wait for the responsive layout after the viewport change, not a stale
  // pre-resize bounding box. Keep the same strict containment bound.
  await expect
    .poll(async () => {
      const rect = (await dialog.boundingBox())!;
      return rect.x + rect.width;
    })
    .toBeLessThanOrEqual(361);
  const small = (await dialog.boundingBox())!;
  expect(small.x).toBeGreaterThanOrEqual(19);
  expect(small.x + small.width).toBeLessThanOrEqual(361);
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
});
