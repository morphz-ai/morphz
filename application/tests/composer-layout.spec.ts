import { test, expect, type Page } from "@playwright/test";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { platformInputState } from "./platform-input-state-fixture.js";
import {
  composerAction,
  openInput,
  openExchangeReading,
  openComposerMedia,
  openComposerSettings,
} from "./interaction-helpers.js";

async function preserveReadOnlyState(page: Page) {
  const source = await PlatformClient.connect(
    new HttpApplicationClient(new URL(page.url()).origin),
  );
  const snapshot = async () => ({
    inputs: await platformInputState(page, source),
    conversations: await source.allNavigationConversations(),
  });
  const before = await snapshot();
  const writes: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (
      !["GET", "HEAD"].includes(request.method()) &&
      path.startsWith("/api/") &&
      path !== "/api/platform/spaces/ensure"
    )
      writes.push(request.method() + " " + path);
  });
  return async () => {
    expect(
      writes,
      "Layout/menu inspection must not issue business writes",
    ).toEqual([]);
    expect(await snapshot()).toEqual(before);
  };
}

test("全宽输入、单底栏与执行设置在明暗和窄窗口中可用", async ({ page }) => {
  await page.route(
    /\/api\/platform\/runtime-navigation(?:\?.*)?$/,
    async (route) => {
      const response = await route.fetch({
        headers: { ...route.request().headers(), "if-none-match": "" },
      });
      const navigation = await response.json();
      await route.fulfill({
        response,
        json: {
          ...navigation,
          runtime: {
            ...navigation.runtime,
            configured: true,
            connected: true,
            model: "fixture-model",
          },
        },
      });
    },
  );
  await page.route(
    /\/api\/platform\/projects\/[^/]+\/conversations\/[^/]+\/history$/,
    (route) =>
      route.fulfill({
        json: {
          inputs: [],
          nextCursor: null,
          runtime: {
            configured: true,
            connected: true,
            model: "fixture-model",
            error: "",
            messages: [],
            deliveries: [],
          },
        },
      }),
  );
  await page.route("**/api/models", (route) =>
    route.fulfill({
      json: {
        current: "fixture-model",
        options: [{ id: "fixture-model", label: "fixture-model" }],
      },
    }),
  );
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: /^事项/ })
    .click();
  await page.getByRole("button", { name: "新建事项", exact: true }).click();
  const input = await openInput(page);
  const composer = page.locator(".composer");
  const finish = await preserveReadOnlyState(page);
  const draft =
    "整理下一阶段的工作安排，先形成草稿。\n确认之后再决定负责人和时间。";
  await input.fill(draft);
  await composerAction(page, "固定输入框");
  for (const theme of ["dark", "light"]) {
    // Appearance is a renderer-only setting in this isolated fixture.
    await page
      .locator(".app")
      .evaluate(
        (el, appearance) => el.setAttribute("data-appearance", appearance),
        theme,
      );
    for (const width of [1440, 760, 390, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await input.focus();
      const text = (await input.boundingBox())!;
      const writing = (await composer
        .locator(".composer-writing")
        .boundingBox())!;
      const actions = composer.locator(".composer-action-bar");
      expect(text.width).toBe(writing.width);
      expect(text.y + text.height).toBeLessThanOrEqual(
        (await actions.boundingBox())!.y,
      );
      expect(
        await composer.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      // d7516961 replaced the inline model/preferences row with one persistent
      // summary trigger; the actual model and reasoning controls remain in its menu.
      const settings = composer.getByRole("button", {
        name: "执行设置",
        exact: true,
      });
      const microphone = composer.getByRole("button", {
        name: "语音输入",
        exact: true,
      });
      const send = composer.locator(".send");
      await expect(settings).toBeVisible();
      await expect(settings).toContainText("fixture-model");
      const settingBounds = (await settings.boundingBox())!;
      const micBounds = (await microphone.boundingBox())!;
      const sendBounds = (await send.boundingBox())!;
      expect(micBounds.x - settingBounds.x - settingBounds.width).toBeCloseTo(
        4,
        0,
      );
      expect(sendBounds.x - micBounds.x - micBounds.width).toBeCloseTo(4, 0);
      for (const box of [settingBounds, micBounds])
        expect(
          Math.abs(
            sendBounds.y + sendBounds.height / 2 - box.y - box.height / 2,
          ),
        ).toBeLessThan(1);
      const row = (await actions.boundingBox())!;
      for (const box of [settingBounds, micBounds, sendBounds]) {
        expect(box.x).toBeGreaterThanOrEqual(row.x);
        expect(box.x + box.width).toBeLessThanOrEqual(row.x + row.width + 1);
        expect(box.y).toBeGreaterThanOrEqual(row.y);
        expect(box.y + box.height).toBeLessThanOrEqual(row.y + row.height + 1);
      }
      // Exchange operations still float above input-only mode, independently of
      // the removed media-tool Dock and of the in-flow action row.
      const tools = page.getByRole("group", {
        name: "交流面板操作",
        exact: true,
      });
      const toolBounds = (await tools.boundingBox())!;
      const composerBounds = (await composer.boundingBox())!;
      expect(toolBounds.y + toolBounds.height).toBeLessThanOrEqual(
        composerBounds.y,
      );
      await expect(page.locator(".exchange-controls-slot")).toHaveCSS(
        "position",
        "absolute",
      );
      expect(toolBounds.x).toBeGreaterThanOrEqual(0);
      expect(toolBounds.x + toolBounds.width).toBeLessThanOrEqual(width);
      await expect(tools).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(tools).toHaveCSS("box-shadow", "none");
      const menu = await openComposerSettings(page);
      const model = menu.getByLabel("本次输入模型", { exact: true });
      await expect(model).toBeVisible();
      await expect(model).toBeEnabled();
      await expect(model).toHaveValue("");
      await expect(model).toContainText("fixture-model");
      expect((await model.boundingBox())!.y).toBeLessThanOrEqual(
        settingBounds.y,
      );
      // The old catalog has no reasoning capability; its current range, not the
      // retired select, must stay disabled rather than inventing supported levels.
      await expect(
        menu.getByLabel("本次输入推理强度", { exact: true }),
      ).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(settings).toBeFocused();
      await expect(composer.locator(".brand-mark")).toHaveCount(0);
      expect(
        await composer.evaluate((el) => getComputedStyle(el).boxShadow),
      ).toBe("none");
      await page.screenshot({
        path: `test-results/composer-clean-${theme}-${width}.png`,
      });
      await expect(page.getByLabel("更多输入选项")).toHaveCount(0);
      await expect(
        composer.getByLabel("执行记录与审批", { exact: true }),
      ).toHaveCount(0);
      await expect(page.locator(".inspector-toggle")).toBeVisible();
      await expect(
        composer.getByLabel("长录音转写", { exact: true }),
      ).toHaveCount(0);
      await expect(settings).toBeVisible();
      await expect(input).toHaveValue(draft);
    }
  }
  await expect(input).toHaveValue(draft);
  // Intent details are preserved in the actual input-association popover.
  await composer.getByRole("button", { name: "输入关联", exact: true }).click();
  const association = page.getByRole("group", {
    name: "本次输入关联",
    exact: true,
  });
  await expect(association).toBeVisible();
  await association.getByLabel("移除输入意图").click();
  await expect(association).not.toBeVisible();
  await expect(input).toBeFocused();
  await expect(composer.locator(".composer-intent")).toHaveCount(0);
  await expect(input).toHaveValue(draft);
  await finish();
});

test("输入按钮悬停不移动命中区域；键盘、减少动态和弹窗返回仍可用", async ({
  page,
}) => {
  await page.goto("/");
  const input = await openInput(page);
  const finish = await preserveReadOnlyState(page);
  await input.fill("浮动工具验收草稿");
  // The single action row keeps + and microphone mounted. File/capture actions
  // now belong to the explicit + menu, not the withdrawn input-tool group.
  const add = page.getByRole("button", { name: "添加输入内容", exact: true });
  const microphone = page.getByRole("button", {
    name: "语音输入",
    exact: true,
  });
  const first = (await add.boundingBox())!;
  const next = (await microphone.boundingBox())!;
  for (const box of [first, next]) {
    expect(box.width).toBe(32);
    expect(box.height).toBe(32);
  }
  await add.hover();
  await expect(add.locator("svg")).toHaveCSS("transform", "none");
  expect(await add.boundingBox()).toEqual(first);
  expect(await microphone.boundingBox()).toEqual(next);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(add.locator("svg")).toHaveCSS("transform", "none");
  await expect(add.locator("svg")).toHaveCSS("transition-duration", "0s");
  await input.focus();
  await page.keyboard.press("Tab");
  await expect(add).toBeFocused();
  await add.press("Enter");
  const media = page.getByRole("group", {
    name: "添加到这条消息",
    exact: true,
  });
  const attach = media.getByRole("button", { name: "附加文件", exact: true });
  const capture = media.getByRole("button", { name: "截图输入", exact: true });
  await expect(attach).toBeVisible();
  await expect(capture).toBeVisible();
  // Persistent capture content precedes the file option in the real menu.
  await expect(capture).toBeFocused();
  await capture.press("ArrowDown");
  await expect(attach).toBeFocused();
  await attach.press("ArrowUp");
  await expect(capture).toBeFocused();
  await capture.press("Enter");
  await expect(
    page.getByRole("dialog", { name: "截图输入", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  // Capture deliberately focuses the persistent + before mounting the modal;
  // the removed menu item cannot be its restoration target.
  await expect(add).toBeFocused();
  await expect(input).toHaveValue("浮动工具验收草稿");
  expect(await add.boundingBox()).toEqual(first);
  expect(await microphone.boundingBox()).toEqual(next);
  await finish();
});

test("应用悬浮 Dock 在入口悬停或键盘聚焦时显示，不增加占位或挤动输入", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  // A prior case can legitimately leave an immersive app open in this Host.
  // Return through the real entry instead of assuming/resetting an empty desk.
  const returnToWorkspace = page.getByRole("button", {
    name: "返回工作空间",
    exact: true,
  });
  if (await returnToWorkspace.isVisible()) await returnToWorkspace.click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  const input = await openInput(page);
  await input.fill("TEST 悬浮应用入口，不发送");
  const finish = await preserveReadOnlyState(page);
  const composer = page.locator(".composer");
  const tools = page.locator(".application-dock-slot");
  const title = page.getByRole("heading", { name: "工作台", exact: true });
  const canvas = page.getByRole("main", { name: "主工作区", exact: true });
  const composerBounds = (await composer.boundingBox())!;
  const canvasBounds = (await canvas.boundingBox())!;
  // Unlike the removed media floating-tools wrapper, the actual application
  // Dock is explicitly expanded while writing is open, even without hover.
  await expect(tools).toHaveCSS("position", "absolute");
  await expect(tools).toHaveAttribute("data-expanded", "true");
  await title.hover();
  await expect(tools).toHaveCSS("opacity", "1");
  await expect(tools).toHaveCSS("pointer-events", "auto");
  expect(await composer.boundingBox()).toEqual(composerBounds);
  expect(await canvas.boundingBox()).toEqual(canvasBounds);
  await page
    .getByRole("button", { name: "收起 AI 输入框", exact: true })
    .click();
  const reopen = page.locator(".composer-reopen");
  await expect(reopen).toBeVisible();
  await title.click();
  await title.hover();
  await expect(tools).not.toHaveAttribute("data-expanded", "true");
  await expect(tools).toHaveCSS("opacity", "0");
  await expect(tools).toHaveCSS("visibility", "hidden");
  await expect(tools).toHaveCSS("pointer-events", "none");
  const entryBounds = (await reopen.boundingBox())!;
  await reopen.hover();
  await expect(tools).toHaveCSS("opacity", "1");
  await expect(tools).toHaveCSS("pointer-events", "auto");
  await expect(input).toHaveCount(0);
  // Only the real group's padding bridge keeps the reachable Dock open.
  const dock = (await tools.locator(".application-dock").boundingBox())!;
  await page.mouse.move(dock.x + dock.width / 2, dock.y + dock.height - 2);
  await expect(tools).toHaveCSS("opacity", "1");
  expect(await reopen.boundingBox()).toEqual(entryBounds);
  expect(await canvas.boundingBox()).toEqual(canvasBounds);
  await title.hover();
  await expect(tools).toHaveCSS("opacity", "0");
  await reopen.focus();
  await expect(tools).toHaveCSS("opacity", "1");
  const launcher = tools.getByRole("button", { name: "全部应用", exact: true });
  await launcher.focus();
  await title.hover();
  await expect(tools).toHaveCSS("opacity", "1");
  await launcher.press("Enter");
  const launcherMenu = page.locator(".application-dock-menu");
  await expect(launcherMenu).toBeVisible();
  await expect(launcherMenu).toBeFocused();
  expect(
    await launcherMenu.evaluate((element) => ({
      open: element.matches(":popover-open"),
      inert: (element as HTMLElement).inert,
    })),
  ).toEqual({ open: true, inert: false });
  await expect(tools).toHaveCSS("visibility", "visible");
  await expect(tools).toHaveCSS("pointer-events", "auto");
  await page.keyboard.press("Escape");
  await expect(launcher).toBeFocused();
  await expect(launcherMenu).not.toBeVisible();
  expect(await reopen.boundingBox()).toEqual(entryBounds);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await reopen.focus();
  await expect(tools).toHaveCSS("opacity", "1");
  await expect(tools).toHaveCSS("transition-duration", "0s");
  await reopen.press("Enter");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("TEST 悬浮应用入口，不发送");
  expect(await composer.boundingBox()).toEqual(composerBounds);
  expect(await canvas.boundingBox()).toEqual(canvasBounds);
  await finish();
});

test("查看、收起和展开记录时，常用按钮位置保持稳定", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  const input = await openInput(page);
  const finish = await preserveReadOnlyState(page);
  await input.fill("TEST 记录操作保持底栏，不发送");
  await composerAction(page, "固定输入框");
  // Focus opens writing only. Explicitly choose reading before its close action.
  await openExchangeReading(page);
  const buttons = page.locator(
    ".composer-action-leading > button, .composer-action-trailing > button, .application-dock-shortcut",
  );
  const positions = () =>
    buttons.evaluateAll((elements) =>
      elements.map((button) => {
        const box = button.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      }),
    );
  const initial = await positions();
  expect(initial.length).toBeGreaterThanOrEqual(4);
  await composerAction(page, "收起交流记录");
  expect(await positions()).toEqual(initial);
  await expect(
    page
      .getByRole("group", { name: "交流面板操作", exact: true })
      .getByLabel("展开完整记录", { exact: true }),
  ).toBeVisible();
  await composerAction(page, "展开完整记录");
  expect(await positions()).toEqual(initial);
  await composerAction(page, "返回工作内容");
  expect(await positions()).toEqual(initial);
  await expect(input).toHaveValue("TEST 记录操作保持底栏，不发送");
  await finish();
});

test.describe("触控输入工具", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 320, height: 800 },
  });
  test("常驻图标与工作台控件保留 44px 点击区，现有菜单可达", async ({
    page,
  }) => {
    await page.goto("/");
    const finish = await preserveReadOnlyState(page);
    for (const name of ["对话", "工作台"]) {
      await page
        .getByRole("navigation", { name: "主导航" })
        .getByRole("button", { name, exact: true })
        .click();
      if (name === "工作台") {
        const contents = page.getByRole("button", {
          name: /^查看(?:内容库|项目内容)$/,
          exact: true,
        });
        if (await contents.isVisible()) await contents.click();
      }
      const input = await openInput(page);
      await input.fill("TEST 触控输入草稿，不发送");
      if (name === "工作台") await composerAction(page, "固定输入框");
      const row = page.locator(".composer-action-bar");
      const add = row.getByRole("button", {
        name: "添加输入内容",
        exact: true,
      });
      const microphone = row.getByRole("button", {
        name: "语音输入",
        exact: true,
      });
      const send = row.locator(".send");
      const settings = row.getByRole("button", {
        name: "执行设置",
        exact: true,
      });
      const boxes = [];
      for (const button of [add, microphone, send, settings]) {
        const box = (await button.boundingBox())!;
        expect(box.height).toBe(44);
        if (button !== settings) expect(box.width).toBe(44);
        // The original coarse rule fixes glyph buttons at 44px. Settings is a
        // shrinkable text summary (min-width:0), not another square glyph target.
        // Keep its actual tap/keyboard behavior, without inventing a new width.
        else expect(box.width).toBeGreaterThan(0);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(320);
        boxes.push(box);
      }
      for (let a = 0; a < boxes.length; a++)
        for (let b = a + 1; b < boxes.length; b++) {
          const first = boxes[a]!,
            second = boxes[b]!;
          expect(
            Math.min(first.x + first.width, second.x + second.width) -
              Math.max(first.x, second.x),
          ).toBeLessThanOrEqual(0);
        }
      await expect(row).toBeInViewport();
      await expect(row).toHaveCSS("opacity", "1");
      await expect(row.getByLabel("执行记录与审批")).toHaveCount(0);
      await settings.tap();
      await expect(
        page.getByRole("group", { name: "执行设置", exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(settings).toBeFocused();
      // Dedicated dialogue deliberately has no separate ExchangeControls.
      // Workbench at 320px uses the existing overflow trigger, not four buttons.
      const controls = page.getByRole("group", {
        name: "交流面板操作",
        exact: true,
      });
      if (name === "工作台") {
        await expect(controls).toHaveAttribute("data-compact", "true");
        const direct = controls.locator(":scope > button");
        await expect(direct).toHaveCount(3);
        let previousRight = 0;
        for (const button of await direct.all()) {
          const box = (await button.boundingBox())!;
          expect(box.width).toBe(44);
          expect(box.height).toBe(44);
          expect(box.x).toBeGreaterThanOrEqual(previousRight);
          expect(box.x + box.width).toBeLessThanOrEqual(320);
          previousRight = box.x + box.width;
        }
        await expect(controls).toBeInViewport();
        await controls
          .getByRole("button", { name: "更多交流选项", exact: true })
          .tap();
        const menu = page.getByRole("group", { name: "交流选项", exact: true });
        let previousBottom = 0;
        for (const label of ["展开完整记录", "取消固定输入框"]) {
          const action = menu.getByRole("button", { name: label, exact: true });
          await expect(action).toBeVisible();
          const bounds = (await action.boundingBox())!;
          // Existing popover rows use ui.css's 32px minimum, not the 44px
          // coarse-pointer contract of the persistent/direct controls above.
          expect(bounds.height).toBeGreaterThanOrEqual(32);
          expect(bounds.y).toBeGreaterThanOrEqual(previousBottom);
          expect(bounds.x).toBeGreaterThanOrEqual(0);
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
          await expect(action).toBeInViewport();
          previousBottom = bounds.y + bounds.height;
        }
        await page.keyboard.press("Escape");
        await expect(
          controls.getByRole("button", { name: "更多交流选项", exact: true }),
        ).toBeFocused();
      } else await expect(controls).toHaveCount(0);
      const media = await openComposerMedia(page);
      const attach = media.getByRole("button", {
        name: "附加文件",
        exact: true,
      });
      const capture = media.getByRole("button", {
        name: "截图输入",
        exact: true,
      });
      for (const button of [attach, capture]) {
        await expect(button).toBeVisible();
        const box = (await button.boundingBox())!;
        // These media actions moved from the old inline 44px tools into the
        // existing 32px popover. Larger touch-menu rows remain a separate UI
        // improvement debt; this behavior-preserving refactor cannot invent them.
        expect(box.height).toBeGreaterThanOrEqual(32);
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(320);
        await expect(button).toBeInViewport();
      }
      const fileBox = (await attach.boundingBox())!,
        captureBox = (await capture.boundingBox())!;
      expect(captureBox.y + captureBox.height).toBeLessThanOrEqual(fileBox.y);
      await page.keyboard.press("Escape");
      await expect(add).toBeFocused();
      await expect(input).toHaveValue("TEST 触控输入草稿，不发送");
    }
    await finish();
  });
});
