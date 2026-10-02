import type { Locator, Page } from "@playwright/test";
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

async function expectProfilePlacement(
  page: Page,
  trigger: Locator,
  menu: Locator,
  compact: boolean,
  zoom = 1,
) {
  await expect(menu).toBeVisible();
  await expect(menu).toBeInViewport();
  // DOM rects include CSS zoom. The original upper menu is end-aligned to
  // the complete Human button; only the icon rail opens into the canvas.
  await expect
    .poll(async () => {
      const button = (await trigger.boundingBox())!;
      const panel = (await menu.boundingBox())!;
      const viewport = page.viewportSize()!;
      const inset = 8 * zoom;
      const clamp = (value: number, size: number, limit: number) =>
        Math.max(inset, Math.min(value, limit - size - inset));
      const left = clamp(
        compact
          ? button.x + button.width + inset
          : button.x + button.width - panel.width,
        panel.width,
        viewport.width,
      );
      const top = clamp(
        compact
          ? button.y + button.height - panel.height
          : button.y - panel.height - inset,
        panel.height,
        viewport.height,
      );
      return Math.max(Math.abs(panel.x - left), Math.abs(panel.y - top));
    })
    .toBeLessThanOrEqual(1);
  const button = (await trigger.boundingBox())!;
  const panel = (await menu.boundingBox())!;
  const viewport = page.viewportSize()!;
  const inset = 8 * zoom;
  expect(panel.x).toBeGreaterThanOrEqual(inset - 1);
  expect(panel.y).toBeGreaterThanOrEqual(inset - 1);
  expect(panel.x + panel.width).toBeLessThanOrEqual(viewport.width - inset + 1);
  expect(panel.y + panel.height).toBeLessThanOrEqual(
    viewport.height - inset + 1,
  );
  if (compact) {
    expect(panel.x).toBeGreaterThanOrEqual(button.x + button.width + inset - 1);
  } else {
    expect(panel.y + panel.height).toBeLessThanOrEqual(button.y - inset + 1);
    expect(Math.abs(panel.width - button.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(panel.x - button.x)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(panel.x + panel.width - button.x - button.width),
    ).toBeLessThanOrEqual(1);
  }
}

async function savedSidebar(page: Page) {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((key) =>
      key.endsWith(":preferences"),
    );
    const value = key ? JSON.parse(localStorage.getItem(key)!) : {};
    return {
      width: value.sidebarWidth ?? 280,
      compact: value.sidebarCompact ?? false,
    };
  });
}

async function savedInputDrafts(page: Page) {
  return page.evaluate(() =>
    Object.fromEntries(
      Object.keys(localStorage)
        .filter((key) => key.includes(":draft:") && key.endsWith(":inputs"))
        .sort()
        .map((key) => [key, JSON.parse(localStorage.getItem(key)!)]),
    ),
  );
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
        await expect(menu).toHaveAttribute("aria-label", "用户菜单");
        await expectProfilePlacement(page, account, menu, compact);
        const search = menu.getByRole("button", {
          name: "搜索资料",
          exact: true,
        });
        const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
        await expect(search.locator("kbd")).toHaveText(mac ? "⌘K" : "Ctrl+K");
        await expect(search).toHaveAttribute(
          "aria-keyshortcuts",
          mac ? "Meta+K" : "Control+K",
        );
        for (const name of ["搜索资料", "外观设置", "通知", "设置"]) {
          await expect(
            menu.getByRole("button", { name, exact: true }),
          ).toBeVisible();
        }
        await expect(
          menu.getByRole("button", { name: "退出当前身份", exact: true }),
        ).toHaveCount(Number(source.boot!.capabilities.teamAuthentication));
        // Human/client settings never become a second Morphz configuration menu.
        for (const name of [
          "活动",
          "授权",
          "定时任务",
          "设定",
          "SOUL",
          "记忆",
        ]) {
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

test("个人菜单打开时随窗口临时收缩向侧面、恢复后回到上方，不覆盖侧栏偏好或草稿", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");
  const input = await openInput(page);
  const draft = "TEST 已打开个人菜单跨侧栏收缩保留草稿";
  await input.fill(draft);
  const persistedDrafts = await savedInputDrafts(page);
  expect(
    Object.values(persistedDrafts).flatMap((inputs) => Object.values(inputs)),
  ).toEqual(expect.arrayContaining([expect.objectContaining({ body: draft })]));
  const source = await conversationClient(page);
  const conversationIds = (await source.allNavigationConversations()).map(
    (item) => item.id,
  );
  const inputState = await platformInputState(page, source);
  const handle = page.getByRole("separator", {
    name: "调整左侧栏宽度",
    exact: true,
  });
  await handle.focus();
  await handle.press("End");
  const preferred = await savedSidebar(page);
  const sidebar = page.getByRole("complementary", {
    name: "工作空间导航",
    exact: true,
  });
  const account = sidebar.locator(".sidebar-bottom .profile-trigger");
  await account.click();
  const menu = page.locator(
    `[id="${await account.getAttribute("aria-controls")}"]`,
  );
  const controlId = await account.getAttribute("aria-controls");
  for (const viewport of [
    { width: 1440, height: 960 },
    { width: 640, height: 540 },
    { width: 1440, height: 960 },
  ]) {
    await page.setViewportSize(viewport);
    const compact = viewport.width === 640;
    await expect(page.locator(".app")).toHaveClass(
      compact ? /sidebar-compact/ : /^(?!.*sidebar-compact)/,
    );
    await expect(account).toHaveAttribute("aria-controls", controlId!);
    await expect(account).toHaveAttribute("aria-expanded", "true");
    await expectProfilePlacement(page, account, menu, compact);
    await expect(
      menu.getByRole("button", { name: "个人资料", exact: true }),
    ).toBeFocused();
    // At 640px the unpinned composer may legitimately unmount after the
    // outside click. Verify its real saved draft without stealing menu focus.
    expect(await savedInputDrafts(page)).toEqual(persistedDrafts);
    expect(await savedSidebar(page)).toEqual(preferred);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(viewport.width);
    await testInfo.attach(`profile-open-reanchor-${viewport.width}`, {
      contentType: "application/json",
      body: JSON.stringify({
        viewport,
        compact,
        button: await account.boundingBox(),
        menu: await menu.boundingBox(),
        preferred,
      }),
    });
  }
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(account).toBeFocused();
  const after = await conversationClient(page);
  expect(
    (await after.allNavigationConversations()).map((item) => item.id),
  ).toEqual(conversationIds);
  expect(await platformInputState(page, after)).toEqual(inputState);
  await expect(await openInput(page)).toHaveValue(draft);
  await expect(page.locator(".human-message")).toHaveCount(0);
});

test("个人菜单在真实 200% CSS 缩放保留展开上方与图标栏右侧锚点，并限制到视口", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.goto("/");
  const input = await openInput(page);
  const draft = "TEST 个人菜单真实缩放不改输入";
  await input.fill(draft);
  const persistedDrafts = await savedInputDrafts(page);
  const source = await conversationClient(page);
  const inputState = await platformInputState(page, source);
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
    // CSS zoom really doubles every control. Keep the fixture's 100dvh
    // desktop shell within the real viewport, as browser page zoom does;
    // changing deviceScaleFactor alone would not exercise menu coordinates.
    document.querySelector<HTMLElement>(".app")!.style.height =
      "calc(100dvh / 2)";
  });
  const handle = page.getByRole("separator", {
    name: "调整左侧栏宽度",
    exact: true,
  });
  const sidebar = page.getByRole("complementary", {
    name: "工作空间导航",
    exact: true,
  });
  const account = sidebar.locator(".sidebar-bottom .profile-trigger");
  for (const mode of ["End", "Home"] as const) {
    await handle.focus();
    await handle.press(mode);
    const compact = mode === "Home";
    await expect(page.locator(".app")).toHaveClass(
      compact ? /sidebar-compact/ : /^(?!.*sidebar-compact)/,
    );
    await expect(account).toBeInViewport();
    const bounds = (await account.boundingBox())!;
    await page.mouse.click(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    const menu = page.locator(
      `[id="${await account.getAttribute("aria-controls")}"]`,
    );
    await expectProfilePlacement(page, account, menu, compact, 2);
    for (const name of ["搜索资料", "外观设置", "通知", "设置"]) {
      await expect(
        menu.getByRole("button", { name, exact: true }),
      ).toBeInViewport();
    }
    await testInfo.attach(`profile-${mode}-200-percent-geometry`, {
      contentType: "application/json",
      body: JSON.stringify({
        zoom: 2,
        compact,
        button: await account.boundingBox(),
        menu: await menu.boundingBox(),
      }),
    });
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(account).toBeFocused();
    expect(await savedInputDrafts(page)).toEqual(persistedDrafts);
  }
  expect(
    await platformInputState(page, await conversationClient(page)),
  ).toEqual(inputState);
  await expect(await openInput(page)).toHaveValue(draft);
  await expect(page.locator(".human-message")).toHaveCount(0);
});

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
