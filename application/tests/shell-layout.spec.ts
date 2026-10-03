import { openSettings } from "./settings-helpers.js";
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { openLibrary } from "./application-helpers.js";
import { randomUUID } from "node:crypto";
import { conversationClient } from "./project-conversation-fixture.js";

test("折叠按钮位于侧栏右缘，搜索始终按内容区居中", async ({ page }) => {
  await page.goto("/");
  // A preceding test may leave the browser selected in the shared center.
  // This case measures the ordinary shell, not its browser-specific toolbar.
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const toggle = page.locator(".sidebar-toggle");
  await expect(toggle).toBeVisible();
  const sidebar = (await page.locator(".sidebar").boundingBox())!;
  const button = (await toggle.boundingBox())!;
  const bar = (await page.locator(".topbar").boundingBox())!;
  expect(sidebar.x + sidebar.width - button.x - button.width).toBeCloseTo(
    16,
    0,
  );
  expect(
    Math.abs(button.y + button.height / 2 - bar.y - bar.height / 2),
  ).toBeLessThanOrEqual(1);
  const assertCentered = async () => {
    const panel = (await page
      .getByRole("dialog", { name: "搜索资料" })
      .boundingBox())!;
    const content = (await page.locator(".workspace").boundingBox())!;
    expect(panel.x + panel.width / 2).toBeCloseTo(
      content.x + content.width / 2,
      0,
    );
    expect(panel.x).toBeGreaterThanOrEqual(content.x + 12);
    expect(panel.x + panel.width).toBeLessThanOrEqual(
      content.x + content.width - 12,
    );
    expect(panel.y + panel.height).toBeLessThanOrEqual(
      page.viewportSize()!.height,
    );
    await expect(page.getByLabel("全文搜索")).toBeFocused();
  };
  // The same operation also exists in closed user menus. Use the existing
  // visible sidebar entry rather than matching their hidden menu rows.
  await page
    .locator(".sidebar-navigation")
    .getByRole("button", { name: "搜索资料", exact: true })
    .click();
  await assertCentered();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 760, height: 540 });
  await page.keyboard.press("Control+k");
  await assertCentered();
  await page.screenshot({
    path: "test-results/search-content-centered-760.png",
  });
  await page.keyboard.press("Escape");
  await toggle.click();
  await expect(toggle).toBeFocused();
  await expect(page.locator(".sidebar")).toBeHidden();
  await page.keyboard.press("Control+k");
  await assertCentered();
  await page.keyboard.press("Escape");
  await expect(toggle).toBeFocused();
  await toggle.press("Enter");
  await expect(page.locator(".sidebar")).toBeVisible();
  await page.keyboard.press("Control+k");
  await page.setViewportSize({ width: 420, height: 740 });
  await assertCentered();
});

test("单行应用标签、固定资料工具区与侧栏全局操作", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("新建项目", { exact: true }).click();
  await page.getByLabel("项目名称", { exact: true }).fill("紧凑工作空间验收");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page).toHaveTitle("紧凑工作空间验收 — Morphz");
  await openLibrary(page);
  await page.getByLabel("收起 AI 输入框").click();
  const toolbar = page.locator(".topbar");
  const tabs = toolbar.getByRole("tablist", { name: "已打开的应用" });
  await expect(
    tabs.getByRole("tab", { name: "内容", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".application-host .application-strip"),
  ).toHaveCount(0);
  await expect(page.locator(".topbar .input-toggle")).toHaveCount(0);
  await expect(page.locator(".library-collection h1")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "设置", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".sidebar-header").getByRole("button", { name: /^通知/ }),
  ).toBeVisible();
  await expect(
    page.locator(".sidebar-bottom .notification-trigger"),
  ).toHaveCount(0);
  const top = (await toolbar.boundingBox())!;
  expect(top.height).toBe(48);
  const chrome = page.locator(".library-chrome");
  const before = (await chrome.boundingBox())!;
  await page.screenshot({ path: "test-results/project-content-chrome.png" });
  const actions = (await page.locator(".content-actions").boundingBox())!;
  expect(actions.y).toBe(top.y + top.height);
  expect(before.y).toBe(actions.y + actions.height);
  expect(before.height).toBeLessThan(110);

  // Fixture writes use this page's authenticated Host, not a fixed shared
  // center or a separate service authority.
  const source = await conversationClient(page);
  const projectId = (await source.allProjects()).find(
    (project) => project.title === "紧凑工作空间验收",
  )!.id;
  for (let i = 0; i < 25; i++) {
    await source.importDocument({
      commandId: randomUUID(),
      objectId: randomUUID(),
      projectId,
      relativePath: `资料-${i}.md`,
      text: `第 ${i} 份本地测试资料。`,
    });
  }
  await page.reload();
  await expect(page.locator(".artifact-card")).toHaveCount(25);
  const results = page.getByRole("region", { name: "内容列表", exact: true });
  await results.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  expect(await results.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect((await chrome.boundingBox())!.y).toBe(before.y);
  expect((await tabs.boundingBox())!.y).toBeGreaterThanOrEqual(top.y);
  await page.screenshot({ path: "test-results/compact-library.png" });

  await openSettings(page, "外观");
  const appearance = page.getByRole("region", { name: "外观设置面板" });
  expect((await appearance.boundingBox())!.x).toBeGreaterThanOrEqual(0);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "设置", exact: true }),
  ).toBeFocused();
  await page.locator(".sidebar-header .notification-trigger").click();
  await expect(
    page.getByRole("dialog", { name: "通知", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.locator(".sidebar-header .notification-trigger"),
  ).toBeFocused();

  const manifest = JSON.parse(
    readFileSync("examples/applications/scratchpad.json", "utf8"),
  );
  for (let i = 0; i < 5; i++) {
    const app = {
      ...manifest,
      id: `test.compact-${i}`,
      title: `多标签工作便笺 ${i}`,
    };
    await source.installUiPackage(randomUUID(), app);
    await source.launchAppView({
      commandId: randomUUID(),
      projectId,
      appId: app.id,
      packageVersion: app.version,
      state: {},
    });
  }
  await page.reload();
  await expect(tabs.getByRole("tab")).toHaveCount(6);
  await page.setViewportSize({ width: 760, height: 540 });
  await page.getByLabel("隐藏侧边栏", { exact: true }).click();
  await tabs
    .getByRole("tab", { name: "多标签工作便笺 4", exact: true })
    .click();
  await expect(
    tabs.getByRole("tab", { name: "多标签工作便笺 4", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  const frame = page.locator('iframe[title="多标签工作便笺 4应用界面"]');
  const bounds = (await frame.boundingBox())!;
  expect(bounds.y).toBe(48);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(540);
  expect((await toolbar.boundingBox())!.height).toBe(48);
  expect(
    await page
      .locator(".app")
      .evaluate((el) => el.scrollWidth > el.clientWidth + 1),
  ).toBe(false);
  await page.getByLabel("显示侧边栏", { exact: true }).click();
  await expect(
    page.getByRole("button", { name: "设置", exact: true }),
  ).toBeVisible();
  await tabs.getByRole("tab", { name: "内容", exact: true }).click();
  await page.locator(".composer-reopen").click();
  await page.getByLabel("AI 输入内容").fill("紧凑界面仍保留草稿");
  await page.getByLabel("AI 输入内容").press("Control+j");
  await expect(page.locator(".composer-reopen")).toBeFocused();
  await page.keyboard.press("Control+j");
  await expect(page.getByLabel("AI 输入内容")).toHaveValue(
    "紧凑界面仍保留草稿",
  );
});
