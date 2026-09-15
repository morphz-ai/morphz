import { test, expect } from "@playwright/test";
import { composerAction, openInput } from "./interaction-helpers.js";

test("全宽输入、悬浮 Dock 与常驻模型在明暗和窄窗口中可用", async ({ page }) => {
  await page.route("**/api/workspace", async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), "if-none-match": "" },
    });
    const body = await response.json();
    body.runtime = {
      ...body.runtime,
      configured: true,
      connected: true,
      model: "fixture-model",
    };
    await route.fulfill({ response, json: body });
  });
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
  const input = page.getByLabel("AI 输入内容");
  const composer = page.locator(".composer");
  await input.fill(
    "整理下一阶段的工作安排，先形成草稿。\n确认之后再决定负责人和时间。",
  );
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
      expect(text.width).toBe(writing.width);
      expect(text.y + text.height).toBeLessThanOrEqual(
        (await composer.locator(".composer-actions").boundingBox())!.y,
      );
      expect(
        await composer.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      const model = composer.getByLabel("本次输入模型");
      await expect(model).toBeVisible();
      await expect(model).toBeEnabled();
      await expect(model).toHaveValue("");
      await expect(model).toContainText("fixture-model");
      const preferences = (await composer
        .locator(".composer-preferences")
        .boundingBox())!;
      const send = (await composer.locator(".send").boundingBox())!;
      expect(send.x - preferences.x - preferences.width).toBeCloseTo(8, 0);
      expect(
        Math.abs(
          send.y + send.height / 2 - preferences.y - preferences.height / 2,
        ),
      ).toBeLessThan(1);
      const tools = composer.getByRole("group", {
        name: "输入工具",
        exact: true,
      });
      const toolBounds = (await tools.boundingBox())!;
      const composerBounds = (await composer.boundingBox())!;
      expect(toolBounds.y + toolBounds.height).toBeLessThanOrEqual(
        composerBounds.y,
      );
      await expect(composer.locator(".composer-floating-tools")).toHaveCSS(
        "position",
        "absolute",
      );
      expect(toolBounds.x).toBeGreaterThanOrEqual(0);
      expect(toolBounds.x + toolBounds.width).toBeLessThanOrEqual(width);
      await expect(tools).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(tools).toHaveCSS("box-shadow", "none");
      expect((await model.boundingBox())!.y).toBeGreaterThanOrEqual(
        text.y + text.height,
      );
      // This deliberately old catalog cannot enable a non-functional selector.
      await expect(composer.getByLabel("本次输入推理强度")).toBeDisabled();
      await expect(composer.locator(".brand-mark")).toHaveCount(0);
      expect(
        await composer.evaluate((el) => getComputedStyle(el).boxShadow),
      ).toBe("none");
      // Include the floating controls outside the in-flow composer bounds.
      await page.screenshot({
        path: `test-results/composer-clean-${theme}-${width}.png`,
      });
      await expect(page.getByLabel("更多输入选项")).toHaveCount(0);
      await expect(
        tools.getByLabel("执行记录与审批", { exact: true }),
      ).toHaveCount(0);
      await expect(page.locator(".inspector-toggle")).toBeVisible();
      await expect(tools.getByLabel("长录音转写", { exact: true })).toHaveCount(
        0,
      );
      await expect(model).toBeVisible();
    }
  }
  await expect(input).toHaveValue(
    "整理下一阶段的工作安排，先形成草稿。\n确认之后再决定负责人和时间。",
  );
  await page.getByLabel("移除输入意图").click();
  await expect(input).toBeFocused();
  await expect(composer.locator(".composer-intent")).toHaveCount(0);
});

test("输入按钮悬停不移动命中区域；键盘、减少动态和弹窗返回仍可用", async ({
  page,
}) => {
  await page.goto("/");
  const input = page.getByLabel("AI 输入内容");
  await input.fill("浮动工具验收草稿");
  const tools = page.getByRole("group", { name: "输入工具", exact: true });
  const attach = tools.getByLabel("附加文件", { exact: true });
  const capture = tools.getByLabel("截图输入", { exact: true });
  const first = (await attach.boundingBox())!;
  const next = (await capture.boundingBox())!;
  expect(first.width).toBe(32);
  expect(first.height).toBe(32);
  expect(next.x - first.x - first.width).toBe(4);
  await attach.hover();
  await expect(attach.locator("svg")).toHaveCSS("transform", "none");
  expect(await attach.boundingBox()).toEqual(first);
  expect(await capture.boundingBox()).toEqual(next);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(attach.locator("svg")).toHaveCSS("transform", "none");
  await expect(attach.locator("svg")).toHaveCSS("transition-duration", "0s");
  await input.focus();
  await page.keyboard.press("Tab");
  // The disconnected fixture skips its disabled model selection.
  for (
    let index = 0;
    index < 8 &&
    !(await attach.evaluate((el) => el === document.activeElement));
    index++
  ) {
    await page.keyboard.press("Tab");
  }
  await expect(attach).toBeFocused();
  await capture.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("dialog", { name: "截图输入", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(capture).toBeFocused();
  await expect(input).toHaveValue("浮动工具验收草稿");
});

test("悬浮 Dock 在悬停或键盘聚焦时显示，不增加占位或挤动输入", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const input = page.getByLabel("AI 输入内容");
  const composer = page.locator(".composer");
  const tools = composer.locator(".composer-floating-tools");
  const title = page.getByRole("heading", { name: "对话", exact: true });
  await title.click();
  await expect(tools).toHaveCSS("opacity", "0");
  await expect(tools).toHaveCSS("pointer-events", "auto");
  await expect(composer.getByLabel("本次输入模型")).toBeVisible();
  const baseline = (await composer.boundingBox())!;
  await input.focus();
  await expect(tools).toHaveCSS("opacity", "1");
  await expect(tools).toHaveCSS("pointer-events", "auto");
  await title.click();
  await expect(tools).toHaveCSS("opacity", "0");
  // Hovering the controls or their bridge keeps them reachable without focus.
  const hiddenBounds = (await tools.boundingBox())!;
  await page.mouse.move(
    hiddenBounds.x + hiddenBounds.width / 2,
    hiddenBounds.y + hiddenBounds.height / 2,
  );
  await expect(input).not.toBeFocused();
  await expect(tools).toHaveCSS("opacity", "1");
  await title.hover();
  await expect(tools).toHaveCSS("opacity", "0");
  await composer.hover();
  await expect(input).not.toBeFocused();
  await expect(tools).toHaveCSS("opacity", "1");
  const toolBounds = (await tools.boundingBox())!;
  await page.mouse.move(
    toolBounds.x + toolBounds.width / 2,
    toolBounds.y + toolBounds.height + 3,
  );
  await expect(tools).toHaveCSS("opacity", "1");
  const capture = tools.getByLabel("截图输入", { exact: true });
  await capture.focus();
  await title.hover();
  await expect(tools).toHaveCSS("opacity", "1");
  await title.click();
  await expect(tools).toHaveCSS("opacity", "0");
  expect(await composer.boundingBox()).toEqual(baseline);
  await expect(input).toBeVisible();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await input.focus();
  await expect(tools).toHaveCSS("opacity", "1");
  await expect(tools).toHaveCSS("transition-duration", "0s");
});

test("查看、收起和展开记录时，常用按钮位置保持稳定", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  const input = await openInput(page);
  await input.focus();
  await composerAction(page, "固定输入框");
  const tools = page.getByRole("group", { name: "输入工具", exact: true });
  const positions = () =>
    tools.getByRole("button").evaluateAll((buttons) =>
      buttons.map((button) => {
        const box = button.getBoundingClientRect();
        return { x: box.x, width: box.width };
      }),
    );
  const initial = await positions();
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
});

test.describe("触控输入工具", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 320, height: 800 },
  });
  test("面板与输入工具分别保留互不重叠的 44px 点击区", async ({ page }) => {
    await page.goto("/");
    for (const name of ["对话", "工作台"]) {
      await page
        .getByRole("navigation", { name: "主导航" })
        .getByRole("button", { name, exact: true })
        .click();
      // Earlier capture tests may leave a workbench object open in the center.
      // This baseline measures plain workbench tools, not an object's reserved
      // annotation slot; explicitly return to its content list first.
      if (name === "工作台") {
        const contents = page.getByRole("button", {
          name: "所有内容",
          exact: true,
        });
        if (await contents.isVisible()) await contents.click();
      }
      await openInput(page);
      if (name === "工作台") await composerAction(page, "固定输入框");
      const tools = page.getByRole("group", { name: "输入工具", exact: true });
      const buttons = tools.locator(":scope > button");
      await expect(buttons).toHaveCount(3);
      if (name === "工作台")
        await expect(
          page
            .getByRole("group", { name: "交流面板操作", exact: true })
            .getByRole("button"),
        ).toHaveCount(4);
      await expect(tools.getByLabel("执行记录与审批")).toHaveCount(0);
      let previousRight = 0;
      let previousY = -1;
      for (const button of await buttons.all()) {
        const box = (await button.boundingBox())!;
        expect(box.width).toBe(44);
        expect(box.height).toBe(44);
        if (box.y === previousY)
          expect(box.x).toBeGreaterThanOrEqual(previousRight);
        else expect(box.y).toBeGreaterThanOrEqual(previousY + 44);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(320);
        previousRight = box.x + box.width;
        previousY = box.y;
      }
      await expect(tools).toBeInViewport();
      await expect(tools).toHaveCSS("opacity", "1");
    }
  });
});
