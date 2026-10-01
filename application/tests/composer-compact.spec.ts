import { test, expect } from "@playwright/test";
import { openInput } from "./interaction-helpers.js";

test("底栏仅一行；范围与执行设置按需展开，菜单内交互不收起原草稿", async ({
  page,
}) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.getByRole("button", { name: "工作台", exact: true }).click();
  const input = await openInput(page);
  await input.fill("TEST 单底栏草稿，不发送");
  const row = page.locator(".composer-action-bar");
  await expect(row).toBeVisible();
  await page.getByRole("button", { name: "输入关联", exact: true }).click();
  await expect(
    page.getByRole("group", { name: "本次输入关联", exact: true }),
  ).toBeVisible();
  await expect(input).toHaveValue("TEST 单底栏草稿，不发送");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "输入关联", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "执行设置", exact: true }).click();
  const settings = page.getByRole("group", {
    name: "本次输入执行设置",
    exact: true,
  });
  await expect(settings).toBeVisible();
  await expect(
    settings.getByLabel("本次输入模型", { exact: true }),
  ).toBeVisible();
  await expect(settings.getByText("目录权限", { exact: true })).toBeVisible();
  await expect(input).toBeVisible();
  await expect(input).toHaveValue("TEST 单底栏草稿，不发送");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "执行设置", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "添加输入内容", exact: true }).click();
  const media = page.getByRole("group", {
    name: "添加到这条消息",
    exact: true,
  });
  await expect(
    media.getByRole("button", { name: "附加文件", exact: true }),
  ).toBeVisible();
  await expect(
    media.getByRole("button", { name: "截图输入", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(input).toHaveValue("TEST 单底栏草稿，不发送");
});

test("长模型和场景在窄窗省略，不将底栏拆成第二行或挤走发送", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await openInput(page);
  for (const width of [1440, 760, 390]) {
    await page.setViewportSize({ width, height: 960 });
    const row = page.locator(".composer-action-bar");
    await expect(row).toBeVisible();
    const geometry = await row.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const buttons = Array.from(element.querySelectorAll("button"))
        .filter(
          (button) =>
            button.getBoundingClientRect().height > 0 &&
            !button.closest("[popover]"),
        )
        .map((button) => {
          const rect = button.getBoundingClientRect();
          return {
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
          };
        });
      return {
        top: bounds.top,
        bottom: bounds.bottom,
        left: bounds.left,
        right: bounds.right,
        buttons,
      };
    });
    expect(geometry.buttons.length).toBeGreaterThanOrEqual(4);
    for (const button of geometry.buttons) {
      expect(button.top).toBeGreaterThanOrEqual(geometry.top - 1);
      expect(button.bottom).toBeLessThanOrEqual(geometry.bottom + 1);
      expect(button.left).toBeGreaterThanOrEqual(geometry.left - 1);
      expect(button.right).toBeLessThanOrEqual(geometry.right + 1);
    }
    expect(geometry.bottom - geometry.top).toBeLessThanOrEqual(46);
    await expect(
      page.getByRole("button", { name: /^(发送消息|保存输入)$/ }),
    ).toBeVisible();
  }
});
