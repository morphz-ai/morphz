import { test, expect } from "@playwright/test";
import { openInput } from "./interaction-helpers.js";

test("底栏仅一行；普通范围不弹空菜单，执行设置与媒体菜单保留原草稿", async ({
  page,
}) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.getByRole("button", { name: "工作台", exact: true }).click();
  const input = await openInput(page);
  await input.fill("TEST 单底栏草稿，不发送");
  const row = page.locator(".composer-action-bar");
  await expect(row).toBeVisible();
  await expect(page.locator(".composer-scope-label")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "输入关联", exact: true }),
  ).toHaveCount(0);
  await expect(row).not.toContainText("未归项目");
  await expect(
    page.getByRole("group", { name: "本次输入关联", exact: true }),
  ).toHaveCount(0);
  await expect(input).toHaveValue("TEST 单底栏草稿，不发送");
  await page.getByRole("button", { name: "执行设置", exact: true }).click();
  const settings = page.getByRole("group", {
    name: "执行设置",
    exact: true,
  });
  await expect(settings).toBeVisible();
  await expect(
    settings.getByLabel("本次输入模型", { exact: true }),
  ).toBeVisible();
  await expect(settings.getByText("工作目录", { exact: true })).toBeVisible();
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

test("媒体菜单从加号向右展开，窄窗与缩放时留在窗口内", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const input = await openInput(page);
  await input.fill("TEST 弹框方向，不发送");
  for (const [width, zoom] of [
    [1440, 1],
    [760, 1],
    [390, 1],
    [320, 1],
    [1440, 2],
  ] as const) {
    await page.setViewportSize({ width, height: 960 });
    await page.locator(".app").evaluate((element, zoom) => {
      (element as HTMLElement).style.zoom = String(zoom);
    }, zoom);
    const add = page.getByRole("button", { name: "添加输入内容", exact: true });
    await add.click();
    const media = page.getByRole("group", {
      name: "添加到这条消息",
      exact: true,
    });
    await expect(media).toBeVisible();
    const anchor = (await add.boundingBox())!;
    const menu = (await media.boundingBox())!;
    expect(menu.x).toBeGreaterThanOrEqual(7);
    expect(menu.x + menu.width).toBeLessThanOrEqual(width - 7);
    if (anchor.x + menu.width <= width - 8)
      expect(Math.abs(menu.x - anchor.x)).toBeLessThanOrEqual(2);
    await page.keyboard.press("Escape");
    const settings = page.getByRole("button", {
      name: "执行设置",
      exact: true,
    });
    await settings.click();
    const options = page.getByRole("group", { name: "执行设置", exact: true });
    await expect(options).toBeVisible();
    const settingsAnchor = (await settings.boundingBox())!;
    const settingsMenu = (await options.boundingBox())!;
    if (settingsAnchor.x + settingsAnchor.width - settingsMenu.width >= 8)
      expect(
        Math.abs(
          settingsMenu.x +
            settingsMenu.width -
            settingsAnchor.x -
            settingsAnchor.width,
        ),
      ).toBeLessThanOrEqual(2);
    await page.keyboard.press("Escape");
    await expect(input).toHaveValue("TEST 弹框方向，不发送");
  }
});
