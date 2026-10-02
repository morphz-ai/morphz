import { _electron, type Locator, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  test,
  expect,
  conversationClient,
} from "./project-conversation-fixture.js";
import { openInput } from "./interaction-helpers.js";
import { openSettings } from "./settings-helpers.js";

const sidebar = (page: Page) =>
  page.getByRole("complementary", { name: "工作空间导航", exact: true });
const resizer = (page: Page) =>
  page.getByRole("separator", {
    name: "调整左侧栏宽度",
    exact: true,
  });

async function railMenu(page: Page) {
  const trigger = sidebar(page)
    .getByRole("button", { name: "用户菜单", exact: true })
    .filter({ visible: true });
  await trigger.press("Enter");
  const id = await trigger.getAttribute("aria-controls");
  expect(id).toBeTruthy();
  const menu = page.locator(`[id="${id}"]`);
  await expect(menu).toBeVisible();
  await expect(menu).toBeInViewport();
  return { trigger, menu };
}

async function expectWidth(page: Page, width: number) {
  await expect
    .poll(async () => Math.round((await sidebar(page).boundingBox())!.width))
    .toBe(width);
}

async function separatorPaint(handle: Locator) {
  return handle.evaluate((element) => {
    const line = getComputedStyle(element, "::after");
    const control = getComputedStyle(element);
    const token = document.createElement("span");
    token.hidden = true;
    token.style.backgroundColor = "var(--line-strong)";
    element.append(token);
    const expectedColor = getComputedStyle(token).backgroundColor;
    token.remove();
    return {
      width: line.width,
      color: line.backgroundColor,
      opacity: Number(line.opacity),
      expectedColor,
      outline: control.outlineStyle,
      shadow: control.boxShadow,
    };
  });
}

async function expectNeutralLine(handle: Locator) {
  await expect
    .poll(async () => {
      const paint = await separatorPaint(handle);
      return {
        width: paint.width,
        correctColor: paint.color === paint.expectedColor,
        visible: paint.opacity > 0.5,
        outline: paint.outline,
        shadow: paint.shadow,
      };
    })
    .toEqual({
      width: "1px",
      correctColor: true,
      visible: true,
      outline: "none",
      shadow: "none",
    });
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

async function beginDrag(page: Page) {
  const handle = resizer(page);
  await expect(handle).toBeVisible();
  const rect = (await handle.boundingBox())!;
  const y = rect.y + rect.height / 2;
  await page.mouse.move(rect.x + rect.width / 2, y);
  await page.mouse.down();
  return { handle, y };
}

async function moveToWidth(page: Page, width: number, y: number) {
  const app = (await page.locator(".app").boundingBox())!;
  await page.mouse.move(app.x + width, y, { steps: 12 });
}

async function dragToWidth(page: Page, width: number) {
  const { y } = await beginDrag(page);
  await moveToWidth(page, width, y);
  await page.mouse.up();
}

async function dialogue(page: Page) {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航", exact: true })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await expectWidth(page, 280);
}

test("左侧栏连续拖动，阈值收为图标，再展开不丢草稿且刷新恢复", async ({
  page,
}) => {
  await dialogue(page);
  const input = await openInput(page);
  await input.fill("TEST 侧栏伸缩时保留的未发送草稿");
  const before = await savedSidebar(page);
  const { handle, y } = await beginDrag(page);
  await expect(handle).toHaveAttribute("aria-orientation", "vertical");
  await moveToWidth(page, 320, y);
  await expectWidth(page, 320);
  // Live preview is not a persisted preference for an unfinished gesture.
  expect(await savedSidebar(page)).toEqual(before);
  await page.mouse.up();
  await expect
    .poll(() => savedSidebar(page))
    .toEqual({
      width: 320,
      compact: false,
    });
  await expect(input).toHaveValue("TEST 侧栏伸缩时保留的未发送草稿");
  await expect(
    page
      .getByRole("navigation", { name: "主导航", exact: true })
      .getByRole("button", { name: "对话", exact: true }),
  ).toHaveAttribute("aria-current", "page");

  await dragToWidth(page, 140);
  await expect(page.locator(".app")).toHaveClass(/sidebar-compact/);
  await expectWidth(page, 80);
  await expect
    .poll(() => savedSidebar(page))
    .toEqual({
      width: 320,
      compact: true,
    });
  await page.reload();
  await expect(page.locator(".app")).toHaveClass(/sidebar-compact/);
  await expectWidth(page, 80);
  await expect(input).toHaveValue("TEST 侧栏伸缩时保留的未发送草稿");

  await dragToWidth(page, 304);
  await expect(page.locator(".app")).not.toHaveClass(/sidebar-compact/);
  await expectWidth(page, 304);
  await expect
    .poll(() => savedSidebar(page))
    .toEqual({
      width: 304,
      compact: false,
    });
  await page.reload();
  await expectWidth(page, 304);
  await expect(input).toHaveValue("TEST 侧栏伸缩时保留的未发送草稿");
  await expect(page.locator(".human-message")).toHaveCount(0);
});

test("Escape、失焦与指针取消恢复手势前宽度，不遗留拖动或写入偏好", async ({
  page,
}) => {
  await dialogue(page);
  await dragToWidth(page, 312);
  const before = await savedSidebar(page);
  for (const reason of ["escape", "blur", "pointercancel"] as const) {
    const { handle, y } = await beginDrag(page);
    await moveToWidth(page, 140, y);
    await expectWidth(page, 80);
    expect(await savedSidebar(page)).toEqual(before);
    if (reason === "escape") await page.keyboard.press("Escape");
    else if (reason === "blur")
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    else
      await handle.dispatchEvent("pointercancel", {
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        bubbles: true,
      });
    await expectWidth(page, 312);
    await expect(page.locator(".app")).not.toHaveClass(/sidebar-compact/);
    // Releasing or moving the old pointer must not finish a cancelled gesture.
    await page.mouse.up();
    await page.mouse.move(350, y);
    await expectWidth(page, 312);
    expect(await savedSidebar(page)).toEqual(before);
  }
  await dragToWidth(page, 288);
  await expectWidth(page, 288);
  await page.reload();
  await expectWidth(page, 288);
});

test("分隔条可键盘调整，图标导航仍可辨认并打开项目、搜索、外观与设置", async ({
  page,
}) => {
  await dialogue(page);
  const source = await conversationClient(page);
  const title = `TEST 图标导航 ${crypto.randomUUID().slice(0, 8)}`;
  await source.createProject(title, crypto.randomUUID(), crypto.randomUUID());
  await page.reload();
  const input = await openInput(page);
  await input.fill("TEST 图标导航未发送草稿");
  const handle = resizer(page);
  await page.keyboard.press("Tab");
  await handle.focus();
  await expect(handle).toBeFocused();
  await expectNeutralLine(handle);
  await page.keyboard.press("ArrowRight");
  await expectWidth(page, 296);
  await page.keyboard.press("Shift+ArrowLeft");
  await expectWidth(page, 264);
  await page.keyboard.press("Home");
  await expectWidth(page, 80);
  await expect(page.locator(".app")).toHaveClass(/sidebar-compact/);
  await expect(page.locator('.sidebar nav[aria-label="主导航"]')).toHaveCount(
    1,
  );
  const nav = page.getByRole("navigation", { name: "主导航", exact: true });
  await expect(nav.getByRole("button")).toHaveCount(5);
  const logo = sidebar(page).locator(".wordmark .brand-mark");
  await expect(logo).toHaveCount(1);
  await expect(logo).toHaveCSS("width", "32px");
  await expect(logo).toHaveCSS("height", "32px");
  const railBounds = (await sidebar(page).boundingBox())!;
  const railCenter = railBounds.x + railBounds.width / 2;
  await expect(logo).toBeInViewport();
  const logoBounds = (await logo.boundingBox())!;
  expect(
    Math.abs(logoBounds.x + logoBounds.width / 2 - railCenter),
  ).toBeLessThanOrEqual(1);
  for (const name of ["对话", /^事项(?: \d+)?$/, "内容库", "工作台", "项目"]) {
    const button = nav.getByRole("button", { name, exact: true });
    await expect(button).toBeInViewport();
    const icon = button.locator("svg");
    await expect(icon).toBeVisible();
    await expect(icon).toHaveCSS("width", "24px");
    await expect(icon).toHaveCSS("height", "24px");
    const buttonBounds = (await button.boundingBox())!;
    const iconBounds = (await icon.boundingBox())!;
    expect(buttonBounds.height).toBeGreaterThanOrEqual(44);
    const iconCenter = iconBounds.x + iconBounds.width / 2;
    expect(Math.abs(iconCenter - railCenter)).toBeLessThanOrEqual(1);
    await button.focus();
    await expect(button).toBeFocused();
  }
  await expect(
    sidebar(page).getByRole("button", { name: "更多", exact: true }),
  ).toHaveCount(0);
  const accountIcon = sidebar(page).locator(
    ".sidebar-bottom .profile-trigger .avatar svg",
  );
  await expect(accountIcon).toHaveCSS("width", "16px");
  await expect(accountIcon).toHaveCSS("height", "16px");
  // Reuse the original five navigation entries and their existing behavior.
  // Utilities share the Human menu; the rail adds no second navigation model.
  await expect(
    nav.getByRole("button", { name: "搜索资料", exact: true }),
  ).toHaveCount(0);
  for (const name of ["搜索资料", "外观设置", "设置", "新建项目"])
    await expect(
      sidebar(page).getByRole("button", { name, exact: true }),
    ).toHaveCount(0);
  const projects = nav.getByRole("button", { name: "项目", exact: true });
  await projects.press("Enter");
  const directory = page.getByRole("region", { name: "项目目录", exact: true });
  await expect(directory).toBeVisible();
  await expect(projects).toHaveAttribute("aria-current", "page");
  await directory
    .getByRole("button", { name: `打开项目：${title}`, exact: true })
    .press("Enter");
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  await projects.click();
  await expect(directory).toBeVisible();
  const projectCreation = page.getByRole("button", {
    name: "创建项目",
    exact: true,
  });
  await projectCreation.click();
  await expect(page.getByLabel("项目名称", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(projectCreation).toBeFocused();
  await expect(directory).toBeVisible();

  const search = await railMenu(page);
  await expect(search.menu).toHaveAttribute("aria-label", "用户菜单");
  await expect(search.menu.getByRole("button")).toHaveCount(
    5 +
      Number(
        (await conversationClient(page)).boot!.capabilities.teamAuthentication,
      ),
  );
  await expect(search.menu.getByRole("button").first()).toHaveAccessibleName(
    "个人资料",
  );
  await expect(search.menu.getByRole("button").nth(1)).toHaveAccessibleName(
    "搜索资料",
  );
  await search.menu
    .getByRole("button", { name: "搜索资料", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "搜索资料", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(search.trigger).toBeFocused();

  for (const name of ["事项", "内容库"]) {
    const button = nav.getByRole("button", {
      name: name === "事项" ? /^事项(?: \d+)?$/ : name,
      exact: true,
    });
    await button.click();
    await expect(button).toHaveAttribute("aria-current", "page");
    await expect(page.locator(".topbar")).toHaveAttribute(
      "aria-label",
      name + "工具栏",
    );
  }
  const appearance = await railMenu(page);
  await appearance.menu
    .getByRole("button", { name: "外观设置", exact: true })
    .click();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await expect(settings).toBeInViewport();
  await expect(settings.getByLabel("阅读字号")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(appearance.trigger).toBeFocused();
  const notifications = await railMenu(page);
  await notifications.menu
    .getByRole("button", { name: "通知", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "通知", exact: true }),
  ).toBeInViewport();
  await page.keyboard.press("Escape");
  await expect(notifications.trigger).toBeFocused();
  const generalSettings = await railMenu(page);
  await generalSettings.menu
    .getByRole("button", { name: "设置", exact: true })
    .click();
  await expect(settings).toBeInViewport();
  await page.keyboard.press("Escape");
  await expect(generalSettings.trigger).toBeFocused();
  await nav.getByRole("button", { name: "对话", exact: true }).click();
  await openInput(page);
  await expect(input).toHaveValue("TEST 图标导航未发送草稿");
  await expect(page.locator(".human-message")).toHaveCount(0);

  await handle.focus();
  await page.keyboard.press("End");
  await expectWidth(page, 360);
  await expect(page.locator(".app")).not.toHaveClass(/sidebar-compact/);
  for (const button of await nav.getByRole("button").all()) {
    await expect(button.locator("svg")).toHaveCSS("width", "17px");
    await expect(button.locator("svg")).toHaveCSS("height", "17px");
  }
  await expect(logo).toHaveCSS("width", "23px");
  await expect(logo).toHaveCSS("height", "25px");
  await handle.dblclick();
  await expectWidth(page, 280);
  await expect
    .poll(() => savedSidebar(page))
    .toEqual({
      width: 280,
      compact: false,
    });
});

test("真实 Electron 图标栏隐藏再恢复与刷新保持80，Mac系统按钮安全区和宿主工具仍可用", async ({
  messageHost,
}) => {
  test.skip(process.platform !== "darwin", "macOS 原生窗口专项");
  const directory = await mkdtemp(join(tmpdir(), "morphz-sidebar-native-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && entry[0] !== "ELECTRON_RUN_AS_NODE",
    ),
  );
  env.MORPHZ_APP_PROFILE = directory;
  const desktop = await _electron.launch({
    args: [
      "tests/fixtures/remote-desktop-entry.cjs",
      `--center=${messageHost.origin}`,
    ],
    env,
  });
  try {
    const page = await desktop.firstWindow();
    if (messageHost.loginToken) {
      const response = await page.request.post(
        `${messageHost.origin}/api/identity/login`,
        {
          headers: { Origin: messageHost.origin },
          data: { token: messageHost.loginToken },
        },
      );
      expect(response.ok(), await response.text()).toBe(true);
      await page.reload();
    }
    await expect(page.locator(".app")).toHaveAttribute("data-desktop", "mac");
    await page
      .getByRole("navigation", { name: "主导航", exact: true })
      .getByRole("button", { name: "对话", exact: true })
      .click();
    const input = await openInput(page);
    await input.fill("TEST Electron 图标栏原草稿");
    await resizer(page).focus();
    await page.keyboard.press("Home");
    await expectWidth(page, 80);
    const preferred = await savedSidebar(page);
    const traffic = await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.getWindowButtonPosition(),
    );
    expect(traffic).toEqual({ x: 8, y: 16 });
    for (const zoom of [1, 2]) {
      await desktop.evaluate(({ BrowserWindow }, zoom) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        window.setSize(1440, 960);
        window.webContents.setZoomFactor(zoom);
      }, zoom);
      await expectWidth(page, 80);
      const railBounds = (await sidebar(page).boundingBox())!;
      const resizeBounds = (await resizer(page).boundingBox())!;
      // This isolated Electron fixture verifies the configured safe envelope
      // and renderer geometry, not the original app's actual OS button edges.
      // Native positions use window logical pixels; DOM bounds use CSS pixels.
      const conservativeNativeRight = 68;
      expect((railBounds.x + railBounds.width) * zoom).toBeGreaterThanOrEqual(
        conservativeNativeRight + 12,
      );
      expect(Math.round(resizeBounds.x - railBounds.x)).toBe(76);
      expect(resizeBounds.x * zoom).toBeGreaterThanOrEqual(
        conservativeNativeRight + 8,
      );
      const hide = page.getByRole("button", {
        name: "隐藏侧边栏",
        exact: true,
      });
      const hideBounds = (await hide.boundingBox())!;
      expect(hideBounds.x).toBeGreaterThanOrEqual(94 / zoom);
      await hide.click();
      await expect(sidebar(page)).toBeHidden();
      await expect(resizer(page)).toBeHidden();
      await expect(page.locator(".app")).not.toHaveClass(/sidebar-compact/);
      const show = page.getByRole("button", {
        name: "显示侧边栏",
        exact: true,
      });
      const showBounds = (await show.boundingBox())!;
      expect(showBounds.x).toBeGreaterThanOrEqual(94 / zoom);
      const nativeRegions = await show.evaluate((element) => ({
        control:
          getComputedStyle(element).getPropertyValue("-webkit-app-region"),
        dragHeight: parseFloat(
          getComputedStyle(element.closest(".topbar")!, "::before").height,
        ),
        controlY: element.getBoundingClientRect().y,
      }));
      expect(nativeRegions.control).toBe("no-drag");
      expect(nativeRegions.controlY).toBeGreaterThanOrEqual(
        nativeRegions.dragHeight,
      );
      await page
        .getByRole("button", { name: "显示右侧栏", exact: true })
        .click();
      await expect(page.locator(".workspace-inspector")).toBeVisible();
      const subjectTabs = page.getByRole("tablist", {
        name: "Morphz 信息分类",
        exact: true,
      });
      await expect(subjectTabs.getByRole("tab")).toHaveCount(4);
      const permissions = subjectTabs.getByRole("tab", {
        name: "授权",
        exact: true,
      });
      await permissions.click();
      await expect(permissions).toHaveAttribute("aria-selected", "true");
      await permissions.press("End");
      await expect(
        subjectTabs.getByRole("tab", { name: "设定", exact: true }),
      ).toBeFocused();
      await page
        .getByRole("button", { name: "隐藏右侧栏", exact: true })
        .click();
      await expect(page.locator(".workspace-inspector")).toHaveCount(0);
      await show.click();
      await expect(page.locator(".app")).toHaveClass(/sidebar-compact/);
      await expectWidth(page, 80);
      expect(await savedSidebar(page)).toEqual(preferred);
      await page.reload();
      await expectWidth(page, 80);
      await expect(input).toHaveValue("TEST Electron 图标栏原草稿");
      await expect(page.locator(".human-message")).toHaveCount(0);
    }
  } finally {
    await desktop.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("左右伸缩边缘共用一像素中性细线，悬停、键盘焦点与拖动不变成粗色框", async ({
  page,
}) => {
  await dialogue(page);
  await page.getByRole("button", { name: "显示右侧栏", exact: true }).click();
  const left = resizer(page);
  const right = page.locator(".workspace-inspector").getByRole("separator");
  await expect(right).toBeVisible();
  for (const [mode, modeName] of [
    ["light", "亮色"],
    ["dark", "暗色"],
  ] as const) {
    for (const [accent, accentName] of [
      ["cyan", "电光青"],
      ["iris", "鸢尾紫"],
      ["coral", "暖珊瑚"],
      ["mono", "纯单色"],
    ] as const) {
      // Persist through the real preferences UI so resizing cannot replace a
      // test-only DOM attribute with the previous saved appearance mid-drag.
      const settings = await openSettings(page, "外观");
      await settings
        .getByRole("button", { name: modeName, exact: true })
        .click();
      await settings
        .getByRole("button", { name: accentName, exact: true })
        .click();
      await page.keyboard.press("Escape");
      await expect(page.locator(".app")).toHaveAttribute(
        "data-appearance",
        mode,
      );
      await expect(page.locator(".app")).toHaveAttribute("data-accent", accent);
      for (const [handle, direction] of [
        [left, 1],
        [right, -1],
      ] as const) {
        await handle.hover();
        await expectNeutralLine(handle);
        const hovered = await separatorPaint(handle);
        await page.keyboard.press("Tab");
        await handle.focus();
        await expect(handle).toBeFocused();
        await expectNeutralLine(handle);
        expect((await separatorPaint(handle)).color).toBe(hovered.color);
        const rect = (await handle.boundingBox())!;
        const x = rect.x + rect.width / 2;
        const y = rect.y + rect.height / 2;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + direction * 12, y, { steps: 3 });
        await expectNeutralLine(handle);
        expect((await separatorPaint(handle)).color).toBe(hovered.color);
        await page.mouse.up();
      }
    }
  }
});

test("小窗临时收窄不覆盖首选宽度，手机沿用顶部导航并保留草稿与设置", async ({
  page,
}) => {
  await dialogue(page);
  const input = await openInput(page);
  await input.fill("TEST 窄窗恢复首选宽度与草稿");
  await resizer(page).focus();
  await page.keyboard.press("End");
  await expectWidth(page, 360);
  const preferred = await savedSidebar(page);
  await page.setViewportSize({ width: 640, height: 540 });
  await expect
    .poll(async () => (await sidebar(page).boundingBox())!.width)
    .toBeLessThanOrEqual(280);
  expect(await savedSidebar(page)).toEqual(preferred);
  await page.reload();
  await expect
    .poll(async () => (await sidebar(page).boundingBox())!.width)
    .toBeLessThanOrEqual(280);
  expect(await savedSidebar(page)).toEqual(preferred);

  for (const width of [560, 390, 320]) {
    await page.setViewportSize({ width, height: 640 });
    await expect(resizer(page)).toBeHidden();
    await expect(
      page
        .getByRole("navigation", { name: "主导航", exact: true })
        .getByRole("button", { name: "对话", exact: true }),
    ).toBeInViewport();
    await expect(input).toHaveValue("TEST 窄窗恢复首选宽度与草稿");
    await expect(
      sidebar(page).getByRole("button", { name: "外观设置", exact: true }),
    ).toBeInViewport();
    const settings = await openSettings(page, "外观");
    await expect(settings).toBeInViewport();
    await page.keyboard.press("Escape");
    expect(await savedSidebar(page)).toEqual(preferred);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await expectWidth(page, 360);
  await expect(page.locator(".app")).not.toHaveClass(/sidebar-compact/);
  await expect(input).toHaveValue("TEST 窄窗恢复首选宽度与草稿");
  expect(await savedSidebar(page)).toEqual(preferred);
  await expect(page.locator(".human-message")).toHaveCount(0);
});
