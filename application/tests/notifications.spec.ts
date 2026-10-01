import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { openSettings } from "./settings-helpers.js";
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});
test("通知只提供全部与不提示，修改携带版本和稳定操作 ID", async ({ page }) => {
  let mode: "all" | "off" = "all",
    revision = 0;
  const commands: { commandId: string; expectedRevision: number }[] = [];
  await page.route("**/api/notifications", (route) => {
    if (route.request().method() === "POST") {
      const command = route.request().postDataJSON();
      commands.push(command);
      mode = command.mode;
      revision++;
    }
    return route.fulfill({ json: { mode, revision, unread: 0, items: [] } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "通知", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "通知", exact: true });
  await expect(dialog.getByRole("radio")).toHaveCount(0);
  await dialog.getByRole("button", { name: "通知设置", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await expect(dialog.getByRole("radio")).toHaveCount(2);
  await dialog.getByRole("radio", { name: "不提示", exact: true }).click();
  await expect(
    dialog.getByRole("radio", { name: "不提示", exact: true }),
  ).toBeChecked();
  expect(commands).toHaveLength(1);
  expect(commands[0]?.expectedRevision).toBe(0);
  expect(commands[0]?.commandId).toMatch(/^[a-f0-9-]{36}$/);
  await page.keyboard.press("Escape");
  await openSettings(page, "通知");
  await expect(
    dialog.getByRole("radio", { name: "不提示", exact: true }),
  ).toBeChecked();
});

test("已读回执遇到一次断线后保留同一操作 ID 重试", async ({ page }) => {
  const { boot } = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const key = `morphz:${boot.centerId}:${boot.principalId}:notification-reads`;
  const current = "b".repeat(64);
  await page.addInitScript(
    ({ key, current }) => localStorage.setItem(key, JSON.stringify([current])),
    { key, current },
  );
  const receipts: {
    ids: string[];
    commandId: string;
    expectedRevision: number;
  }[] = [];
  let read = false;
  await page.route("**/api/notifications", (route) => {
    if (route.request().method() === "POST") {
      const command = route.request().postDataJSON();
      const ids = command.ids;
      receipts.push(command);
      if (receipts.length === 1)
        return route.fulfill({ status: 503, json: { error: "offline" } });
      read = ids.includes(current);
    }
    return route.fulfill({
      json: {
        mode: "all",
        revision: read ? 1 : 0,
        unread: read ? 0 : 1,
        items: [
          {
            id: current,
            artifactId: "test",
            title: "TEST 待确认已读",
            reason: "需要你参与的事项",
            read,
          },
        ],
      },
    });
  });
  await page.goto("/");
  await expect.poll(() => receipts.length, { timeout: 7000 }).toBe(2);
  expect(receipts.map((command) => command.ids)).toEqual([
    [current],
    [current],
  ]);
  expect(receipts[0]?.commandId).toBe(receipts[1]?.commandId);
  expect(receipts[0]?.expectedRevision).toBe(receipts[1]?.expectedRevision);
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
  const source = await PlatformClient.connect(
    new HttpApplicationClient("http://127.0.0.1:65421"),
  );
  const suffix = randomUUID().slice(0, 8);
  const title = `TEST 通知设置验证 ${suffix}`;
  const projectId = randomUUID();
  await source.createProject(
    `TEST 通知项目 ${suffix}`,
    randomUUID(),
    projectId,
  );
  await source.createTask({
    commandId: randomUUID(),
    taskId: randomUUID(),
    projectId,
    title,
    assigneeId: source.boot.actantId,
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: /^通知，/ })).toBeVisible({
    timeout: 6000,
  });
  await page.locator(".notification-trigger").click();
  const dialog = page.locator(".notification-dialog");
  await expect(
    dialog.getByRole("button", { name: new RegExp(title) }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "通知设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await settings.getByRole("radio", { name: "不提示", exact: true }).click();
  await expect(
    settings.getByRole("radio", { name: "不提示", exact: true }),
  ).toBeChecked();
  await page.keyboard.press("Escape");
  await page.locator(".notification-trigger").click();
  await dialog.getByRole("button", { name: new RegExp(title) }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
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
    dialog.getByRole("button", { name: new RegExp(title) }),
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
    "通知设置未确认保存，请重试。",
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
    "通知设置未确认保存，请重试。",
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
