import { test, expect } from "@playwright/test";
import { readerApplication } from "../packages/core/src/applications.js";
import {
  openInput,
  composerAction,
  openComposerMedia,
  openComposerSettings,
} from "./interaction-helpers.js";

test("应用 Dock 与单底栏分工清楚；内部菜单保留草稿，外部点击正常收起", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  const input = await openInput(page);
  await input.fill("TEST Dock 和输入边界，不发送");
  await input.evaluate((element) => (element.dataset.dockMount = "original"));
  const submissions: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/platform\/messages(?:\?|$)/.test(request.url())
    )
      submissions.push(request.url());
  });
  const dock = page.locator(".application-dock-slot");
  const footer = page.locator(".composer-action-bar");
  const canvas = page.locator(".primary-panel > main");
  const canvasBounds = await canvas.boundingBox();
  await expect(
    dock.getByRole("button", { name: "全部应用", exact: true }),
  ).toBeVisible();
  expect(
    (await dock.boundingBox())!.y + (await dock.boundingBox())!.height,
  ).toBeLessThanOrEqual((await page.locator(".composer").boundingBox())!.y);
  for (const name of ["新建或添加", "执行设置", "语音输入"])
    await expect(dock.getByRole("button", { name, exact: true })).toHaveCount(
      0,
    );
  await expect(
    footer.getByRole("button", { name: "全部应用", exact: true }),
  ).toHaveCount(0);
  await dock.getByRole("button", { name: "全部应用", exact: true }).click();
  const launcher = page.getByRole("group", { name: "选择应用", exact: true });
  await expect(launcher).toBeVisible();
  await launcher
    .getByRole("button", { name: "在工作台管理应用", exact: true })
    .focus();
  await expect(input).toHaveAttribute("data-dock-mount", "original");
  await expect(input).toHaveValue("TEST Dock 和输入边界，不发送");
  expect(await canvas.boundingBox()).toEqual(canvasBounds);
  await page.keyboard.press("Escape");
  await expect(
    dock.getByRole("button", { name: "全部应用", exact: true }),
  ).toBeFocused();
  for (const open of [openComposerMedia, openComposerSettings]) {
    await open(page);
    await expect(input).toHaveAttribute("data-dock-mount", "original");
    await expect(input).toHaveValue("TEST Dock 和输入边界，不发送");
    await page.keyboard.press("Escape");
  }
  await expect(page.locator(".composer-scope-label")).toHaveCount(0);
  await expect(
    page.getByRole("group", { name: "本次输入关联", exact: true }),
  ).toHaveCount(0);
  await expect(input).toHaveValue("TEST Dock 和输入边界，不发送");
  await page
    .getByRole("main", { name: "主工作区" })
    .click({ position: { x: 600, y: 200 } });
  await expect(input).toHaveCount(0);
  await expect(dock).toBeHidden();
  await openInput(page);
  await expect(input).toHaveValue("TEST Dock 和输入边界，不发送");
  await composerAction(page, "固定输入框");
  await page
    .getByRole("main", { name: "主工作区" })
    .click({ position: { x: 600, y: 200 } });
  await expect(input).toBeVisible();
  await expect(dock).toBeVisible();
  expect(await canvas.boundingBox()).toEqual(canvasBounds);
  expect(submissions).toEqual([]);
});

test("当前目录不可见的应用固定偏好，在增删可见快捷入口时保持", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await openInput(page);
  const unavailable = "app-in-another-work-scene@1";
  await page.evaluate((unavailable) => {
    const key = Object.keys(localStorage).find((key) =>
      key.endsWith(":preferences"),
    );
    if (!key) throw new Error("Missing actual scoped preference record");
    const prefs = JSON.parse(localStorage.getItem(key)!);
    localStorage.setItem(
      key,
      JSON.stringify({ ...prefs, dockApplications: [unavailable] }),
    );
  }, unavailable);
  await page.reload();
  await openInput(page);
  await page.getByRole("button", { name: "全部应用", exact: true }).click();
  const launcher = page.getByRole("group", { name: "选择应用", exact: true });
  await launcher
    .getByRole("listitem")
    .filter({
      has: page.getByRole("button", { name: "打开阅读", exact: true }),
    })
    .hover();
  await launcher
    .getByRole("button", { name: "固定到 Dock：阅读", exact: true })
    .click();
  const pins = () =>
    page.evaluate(() => {
      const key = Object.keys(localStorage).find((key) =>
        key.endsWith(":preferences"),
      );
      return JSON.parse(localStorage.getItem(key!)!).dockApplications;
    });
  await expect
    .poll(pins)
    .toEqual([
      unavailable,
      `${readerApplication.id}@${readerApplication.version}`,
    ]);
  await launcher
    .getByRole("button", { name: "从 Dock 移除：阅读", exact: true })
    .click();
  await expect.poll(pins).toEqual([unavailable]);
  await page.keyboard.press("Escape");
  await expect(page.locator(".application-dock-shortcut")).toHaveCount(1);
});

test("窄窗应用 Dock 不挤正文或制造第二条输入操作栏", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const input = await openInput(page);
  await input.fill("TEST 窄窗 Dock，保留原草稿");
  for (const width of [1440, 760, 390, 320]) {
    await page.setViewportSize({ width, height: 540 });
    const footer = page.locator(".composer-action-bar");
    await expect(footer).toBeInViewport();
    await expect(page.locator(".application-dock-slot")).toBeInViewport();
    const controls = await footer.evaluate((element) =>
      Array.from(element.querySelectorAll("button"))
        .filter((button) => !button.closest("[popover]"))
        .map((button) => {
          const box = button.getBoundingClientRect();
          return {
            top: box.top,
            bottom: box.bottom,
            left: box.left,
            right: box.right,
          };
        }),
    );
    const row = (await footer.boundingBox())!;
    for (const button of controls) {
      expect(button.top).toBeGreaterThanOrEqual(row.y - 1);
      expect(button.bottom).toBeLessThanOrEqual(row.y + row.height + 1);
      expect(button.left).toBeGreaterThanOrEqual(row.x - 1);
      expect(button.right).toBeLessThanOrEqual(row.x + row.width + 1);
    }
    expect(row.height).toBeLessThanOrEqual(46);
    await expect(input).toHaveValue("TEST 窄窗 Dock，保留原草稿");
  }
});
