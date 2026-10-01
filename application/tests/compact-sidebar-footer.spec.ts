import type { Locator } from "@playwright/test";
import {
  test,
  expect,
  conversationClient,
} from "./project-conversation-fixture.js";
import { openInput } from "./interaction-helpers.js";
import { platformInputState } from "./platform-input-state-fixture.js";

async function centerHit(control: Locator) {
  return control.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    return Boolean(hit && element.contains(hit));
  });
}

for (const appearance of ["light", "dark"] as const) {
  for (const viewport of [
    { width: 760, height: 540 },
    { width: 1440, height: 960 },
  ]) {
    test(`个人入口合并侧栏更多；两种宽度共用功能与焦点：${appearance} ${viewport.width}×${viewport.height}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.goto("/");
      const nav = page.getByRole("navigation", { name: "主导航", exact: true });
      await nav.getByRole("button", { name: "对话", exact: true }).click();
      const input = await openInput(page);
      const draft = `TEST 合并个人菜单保留草稿 ${appearance} ${viewport.width}`;
      await input.fill(draft);
      const source = await conversationClient(page);
      const conversationIds = (await source.allNavigationConversations()).map(
        (item) => item.id,
      );
      const inputState = await platformInputState(page, source);
      const handle = page.getByRole("separator", {
        name: "调整左侧栏宽度",
        exact: true,
      });
      const sidebar = page.getByRole("complementary", {
        name: "工作空间导航",
        exact: true,
      });
      await page.evaluate((appearance) => {
        document.documentElement.dataset.appearance = appearance;
        document.querySelector<HTMLElement>(".app")!.dataset.appearance =
          appearance;
      }, appearance);

      for (const mode of ["Home", "End"] as const) {
        await handle.focus();
        await handle.press(mode);
        const compact = mode === "Home";
        await expect
          .poll(async () => Math.round((await sidebar.boundingBox())!.width))
          .toBe(compact ? 80 : viewport.width === 760 ? 280 : 360);
        expect(await page.locator(".app").getAttribute("class")).toMatch(
          compact ? /sidebar-compact/ : /^(?!.*sidebar-compact)/,
        );
        await expect(
          sidebar.getByRole("button", { name: "更多", exact: true }),
        ).toHaveCount(0);
        await expect(sidebar.locator(".compact-sidebar-controls")).toHaveCount(
          0,
        );
        await expect(sidebar.locator(".profile-settings")).toHaveCount(0);
        const account = sidebar.locator(".sidebar-bottom .profile-trigger");
        await expect(account).toHaveAccessibleName("用户菜单");
        await expect(account).toBeVisible();
        await expect(account).toBeInViewport();
        expect(await centerHit(account)).toBe(true);
        const bounds = (await account.boundingBox())!;
        const sidebarBounds = (await sidebar.boundingBox())!;
        expect(bounds.x).toBeGreaterThanOrEqual(sidebarBounds.x);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(
          sidebarBounds.x + sidebarBounds.width,
        );
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
        await testInfo.attach(`profile-${mode}-geometry`, {
          contentType: "application/json",
          body: JSON.stringify({ viewport, appearance, bounds, sidebarBounds }),
        });
        for (const button of await nav.getByRole("button").all()) {
          const navBounds = (await button.boundingBox())!;
          expect(navBounds.y + navBounds.height).toBeLessThanOrEqual(bounds.y);
        }

        // Use coordinates on the visible Human entry, not a hidden More button.
        await page.mouse.click(
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height / 2,
        );
        const menu = page.locator(
          `[id="${await account.getAttribute("aria-controls")}"]`,
        );
        await expect(menu).toBeVisible();
        await expect(menu).toHaveAttribute("aria-label", "用户菜单");
        await expect(menu).toBeInViewport();
        for (const name of ["搜索资料", "外观设置", "通知", "设置"]) {
          await expect(
            menu.getByRole("button", { name, exact: true }),
          ).toBeVisible();
        }
        await expect(
          menu.getByRole("button", { name: "退出当前身份", exact: true }),
        ).toHaveCount(Number(source.boot!.capabilities.teamAuthentication));
        // Human/client settings never become a second Morphz configuration menu.
        for (const name of ["活动", "授权", "安排", "设定", "SOUL", "记忆"]) {
          await expect(
            menu.getByRole("button", { name, exact: true }),
          ).toHaveCount(0);
        }
        await page.keyboard.press("Escape");
        await expect(menu).toBeHidden();
        await expect(account).toBeFocused();

        for (const action of [
          { name: "搜索资料", dialog: "搜索资料" },
          { name: "外观设置", dialog: "设置" },
          { name: "通知", dialog: "通知" },
          { name: "设置", dialog: "设置" },
        ]) {
          await account.press("Enter");
          await expect(menu).toBeVisible();
          await menu
            .getByRole("button", { name: action.name, exact: true })
            .click();
          const dialog = page.getByRole("dialog", {
            name: action.dialog,
            exact: true,
          });
          await expect(dialog).toBeVisible();
          await expect(dialog).toBeInViewport();
          if (action.name === "外观设置") {
            await expect(dialog.getByLabel("阅读字号")).toBeVisible();
          }
          await page.keyboard.press("Escape");
          await expect(dialog).toBeHidden();
          await expect(account).toBeFocused();
          await expect(input).toHaveValue(draft);
        }
        await account.press("Enter");
        await expect(menu).toBeVisible();
        await nav.getByRole("button", { name: "对话", exact: true }).click();
        await expect(menu).toBeHidden();
        await expect(input).toHaveValue(draft);
      }
      const after = await conversationClient(page);
      expect(
        (await after.allNavigationConversations()).map((item) => item.id),
      ).toEqual(conversationIds);
      expect(await platformInputState(page, after)).toEqual(inputState);
      await expect(input).toHaveValue(draft);
      await expect(page.locator(".human-message")).toHaveCount(0);
      await page.screenshot({
        path: `test-results/profile-merged-${appearance}-${viewport.width}.png`,
      });
    });
  }
}

test("手机和展开侧栏共用个人菜单；搜索通知设置跨宽度关闭后返回可见入口", async ({
  page,
}) => {
  await page.goto("/");
  const input = await openInput(page);
  await input.fill("TEST 切换尺寸后个人菜单焦点不丢失");
  const sidebar = page.getByRole("complementary", {
    name: "工作空间导航",
    exact: true,
  });
  const desktop = sidebar.locator(".sidebar-bottom .profile-trigger");
  const menu = page.locator(
    `[id="${await desktop.getAttribute("aria-controls")}"]`,
  );
  const mobile = sidebar.locator(".sidebar-tools .profile-compact");
  const mobileMenu = page.locator(
    `[id="${await mobile.getAttribute("aria-controls")}"]`,
  );
  for (const name of ["设置", "搜索资料", "通知"]) {
    await page.setViewportSize({ width: 1440, height: 960 });
    await expect(desktop).toBeVisible();
    await desktop.click();
    await menu.getByRole("button", { name, exact: true }).click();
    const dialog = page.getByRole("dialog", { name, exact: true });
    await expect(dialog).toBeVisible();
    await page.setViewportSize({ width: 390, height: 540 });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(mobile).toBeVisible();
    await expect(mobile).toBeFocused();
    await mobile.press("Enter");
    for (const action of ["搜索资料", "外观设置", "通知", "设置"]) {
      await expect(
        mobileMenu.getByRole("button", { name: action, exact: true }),
      ).toBeVisible();
    }
    await page.keyboard.press("Escape");
    await expect(mobile).toBeFocused();
  }
  await openInput(page);
  await expect(input).toHaveValue("TEST 切换尺寸后个人菜单焦点不丢失");
});
