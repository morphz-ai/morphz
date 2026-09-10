import { test, expect } from "@playwright/test";
import { openInput, composerAction } from "./interaction-helpers.js";
import { randomUUID } from "node:crypto";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const events: unknown[] = [];
    (window as any).__focusTrace = events;
    const describe = (e: EventTarget | null) =>
      e instanceof Element
        ? e.tagName + ":" + (e.getAttribute("aria-label") ?? e.className)
        : String(e);
    for (const name of [
      "focusin",
      "focusout",
      "pointerdown",
      "click",
      "blur",
      "focus",
    ]) {
      window.addEventListener(
        name,
        (e) => {
          events.push({
            time: performance.now(),
            type: name,
            target: describe(e.target),
            related: describe((e as FocusEvent).relatedTarget),
            active: describe(document.activeElement),
            mode: document
              .querySelector(".primary-panel")
              ?.getAttribute("data-interaction"),
          });
          if (events.length > 160) events.shift();
        },
        true,
      );
    }
  });
});
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus)
    await info.attach("focus-events", {
      body: JSON.stringify(
        await page.evaluate(() => (window as any).__focusTrace),
        null,
        2,
      ),
      contentType: "application/json",
    });
});

test("聚焦展开记录，离开自动收起；固定按空间保存且不影响手动收起", async ({
  page,
}) => {
  await page.goto("/");
  const input = page.getByLabel("AI 输入内容");
  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.getByRole("button", { name: "工作台", exact: true }).click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await openInput(page);
  await input.fill("暂不发送的工作台草稿");
  await expect(page.locator(".primary-panel")).toHaveAttribute(
    "data-interaction",
    "recent",
  );
  await expect(page.getByRole("main", { name: "主工作区" })).toBeVisible();
  await composerAction(page, "固定输入框");
  await page
    .getByRole("main", { name: "主工作区" })
    .click({ position: { x: 650, y: 200 } });
  await expect(input).toBeVisible();
  await expect(page.getByLabel("取消固定输入框")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.reload();
  await expect(page.getByLabel("取消固定输入框")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(input).toHaveValue("暂不发送的工作台草稿");
  await nav.getByRole("button", { name: /^事项/ }).click();
  await expect(page.getByLabel("固定输入框", { exact: true })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await input.fill("事项中的独立草稿");
  await nav.getByRole("button", { name: "工作台", exact: true }).click();
  await expect(input).toHaveValue("暂不发送的工作台草稿");
  await page.getByLabel("取消固定输入框").click();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("暂不发送的工作台草稿");
  await page
    .getByRole("main", { name: "主工作区" })
    .click({ position: { x: 650, y: 200 } });
  await expect(input).toHaveCount(0);
  await page.getByRole("button", { name: /向 Morphz 输入/ }).click();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("暂不发送的工作台草稿");
  await expect(page.locator(".conversation")).toBeVisible();
  await composerAction(page, "固定输入框");
  await page.getByLabel("收起 AI 输入框").click();
  await expect(input).toHaveCount(0);
  await page.keyboard.press("Control+j");
  await expect(input).toBeFocused();
  await expect(page.getByLabel("取消固定输入框")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await nav.getByRole("button", { name: /^事项/ }).click();
  await expect(input).toHaveCount(0);
  await page.getByRole("button", { name: /向 Morphz 输入/ }).click();
  await expect(input).toHaveValue("事项中的独立草稿");
});

test("点击关闭内嵌听写不误收起输入，随后点击画布仍正常收起", async ({
  page,
}) => {
  await page.route("**/api/speech/status", (route) =>
    route.fulfill({ json: { configured: false, provider: null } }),
  );
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  const input = await openInput(page);
  await input.fill("关闭听写后继续写，不发送");
  const trigger = page.getByRole("button", { name: "语音输入", exact: true });
  await trigger.click();
  await page.getByRole("button", { name: "关闭听写", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "听写", exact: true }),
  ).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(input).toHaveValue("关闭听写后继续写，不发送");
  await page
    .getByRole("main", { name: "主工作区" })
    .click({ position: { x: 650, y: 200 } });
  await expect(input).toHaveCount(0);
  await openInput(page);
  await expect(input).toHaveValue("关闭听写后继续写，不发送");
  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(input).toHaveValue("关闭听写后继续写，不发送");
});

test("按钮和弹窗不误收起；键盘离开会收起，工作区动作一次点击生效", async ({
  page,
}) => {
  await page.goto("/");
  const input = page.getByLabel("AI 输入内容");
  await input.fill("在控件与弹窗之间保留输入");
  // This disconnected fixture exposes an actionable connection notice.
  await page.keyboard.press("Tab");
  await expect(
    page
      .locator(".model-status")
      .getByRole("button", { name: "连接详情", exact: true }),
  ).toBeFocused();
  // Text goes straight to common bottom-row actions; keyboard users can also
  // open More and reach every low-frequency action without leaving the input.
  for (const name of ["附加文件", "截图输入", "语音输入", "更多输入选项"]) {
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name, exact: true })).toBeFocused();
    await expect(input).toHaveValue("在控件与弹窗之间保留输入");
  }
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("收起交流记录")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByLabel("展开完整记录")).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.getByLabel("长录音转写", { exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("更多输入选项")).toBeFocused();
  await expect(page.getByRole("group", { name: "输入选项" })).toBeHidden();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("收起 AI 输入框")).toBeFocused();
  await page.getByLabel("更多输入选项").click();
  await input.click();
  await expect(page.getByRole("group", { name: "输入选项" })).toBeHidden();
  await expect(input).toBeFocused();
  await page.getByLabel("更多输入选项").click();
  const composerBounds = (await page.locator(".composer").boundingBox())!;
  await page.mouse.click(composerBounds.x - 20, composerBounds.y + 20);
  await expect(input).toHaveCount(0);
  await openInput(page);
  await page.getByRole("button", { name: "截图输入", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("dialog", { name: "截图输入", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "截图输入", exact: true }),
  ).toBeFocused();
  await expect(input).toHaveValue("在控件与弹窗之间保留输入");
  await page.getByRole("button", { name: "语音输入", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "听写", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "语音输入", exact: true }),
  ).toBeFocused();
  await composerAction(page, "收起交流记录");
  await expect(page.locator(".conversation")).toHaveCount(0);
  await input.focus();
  await expect(page.locator(".conversation")).toBeVisible();
  await composerAction(page, "展开完整记录");
  await expect(page.getByRole("main", { name: "主工作区" })).toBeHidden();
  await composerAction(page, "返回工作内容");
  await expect(page.getByRole("main", { name: "主工作区" })).toBeVisible();
  await page.getByRole("button", { name: "搜索资料", exact: true }).focus();
  await expect(input).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "搜索资料", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Control+j");
  await expect(input).toBeFocused();
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "新建项目", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  // This modal originated outside the composer. Returning focus there may
  // collapse the unpinned input; its draft must still survive reopening.
  await expect(
    page.getByRole("button", { name: "新建项目", exact: true }),
  ).toBeFocused();
  await openInput(page);
  await expect(input).toHaveValue("在控件与弹窗之间保留输入");
});

test("工具集中在输入框；相机与语音紧邻，窄窗口和空记录不过度占位", async ({
  page,
}) => {
  await page.goto("/");
  // Other tests legitimately leave messages in the shared test center.
  // Create an empty workspace instead of assuming the workbench is empty.
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  const projectName = "空记录布局验收-" + randomUUID();
  await page.getByLabel("新对象标题", { exact: true }).fill(projectName);
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page
    .getByLabel("新建项目对话：" + projectName, { exact: true })
    .click();
  await expect(
    page
      .getByLabel(projectName + "的会话")
      .getByLabel("打开对话：对话 2", { exact: true }),
  ).toHaveAttribute("aria-current", "true");
  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 800 });
    await page.getByLabel("AI 输入内容").focus();
    await expect(page.locator(".exchange-header, .exchange-space")).toHaveCount(
      0,
    );
    const composer = page.getByRole("region", { name: "AI 输入", exact: true });
    await expect(composer.locator(".composer-heading")).toHaveCount(0);
    const tools = (await composer
      .locator(".composer-input-tools")
      .boundingBox())!;
    await expect(composer.locator(".composer-tools")).toHaveCount(0);
    const textBounds = (await composer
      .getByLabel("AI 输入内容")
      .boundingBox())!;
    expect(textBounds.height).toBeGreaterThanOrEqual(60);
    expect(textBounds.y + textBounds.height).toBeLessThanOrEqual(tools.y);
    const writing = (await composer
      .locator(".composer-writing")
      .boundingBox())!;
    expect(textBounds.width).toBe(writing.width);
    const outer = (await composer.boundingBox())!;
    expect(textBounds.y - outer.y).toBeLessThanOrEqual(11);
    expect(outer.height).toBeLessThanOrEqual(144);
    expect(
      await composer.evaluate((el) => getComputedStyle(el).boxShadow),
    ).toBe("none");
    const executions = composer.getByLabel("执行记录与审批", { exact: true });
    await expect(executions).toBeDisabled();
    await expect(executions).toBeHidden();
    await expect(
      composer.locator(".lucide-square-bottom-dashed-scissors"),
    ).toHaveCount(1);
    await expect(composer.locator(".lucide-camera")).toHaveCount(0);
    await expect(composer.locator(".lucide-scan")).toHaveCount(0);
    const camera = (await composer
      .getByLabel("截图输入", { exact: true })
      .boundingBox())!;
    const mic = (await composer
      .getByLabel("语音输入", { exact: true })
      .boundingBox())!;
    expect(mic.x - camera.x - camera.width).toBeLessThanOrEqual(4);
    expect(mic.y).toBe(camera.y);
    const more = (await composer.getByLabel("更多输入选项").boundingBox())!;
    const collapse = (await composer
      .getByLabel("收起 AI 输入框")
      .boundingBox())!;
    expect(collapse.x - more.x - more.width).toBeLessThanOrEqual(4);
    expect(collapse.y).toBe(more.y);
    expect(collapse.y).toBe(camera.y);
    expect(
      await composer.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    const bounds = (await composer.boundingBox())!;
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(800);
    // The disconnected test center still shows its real status, not a fake ready state.
    expect(
      (await page.locator(".conversation").boundingBox())!.height,
    ).toBeLessThan(210);
    await page.screenshot({
      path: `test-results/composer-refined-${width}.png`,
    });
    const text = composer.getByLabel("AI 输入内容");
    await text.fill("第一行\n第二行\n第三行\n第四行\n第五行");
    const grown = (await text.boundingBox())!;
    expect(grown.height).toBeGreaterThan(textBounds.height);
    expect(grown.width).toBe(writing.width);
    expect(grown.y + grown.height).toBeLessThanOrEqual(
      (await composer.locator(".composer-actions").boundingBox())!.y,
    );
    await expect(text).toHaveValue("第一行\n第二行\n第三行\n第四行\n第五行");
    await text.fill("");
  }
});

test("输入框和历史左右留白属于外部区域；固定时不收起", async ({ page }) => {
  await page.goto("/");
  const input = page.getByLabel("AI 输入内容");
  await input.fill("点击两侧留白也保留草稿");
  for (const side of ["left", "right"] as const) {
    const bounds = (await page.locator(".composer").boundingBox())!;
    const x = side === "left" ? bounds.x - 20 : bounds.x + bounds.width + 20;
    await page.mouse.click(x, bounds.y + bounds.height / 2);
    await expect(input).toHaveCount(0);
    await page.getByRole("button", { name: /向 Morphz 输入/ }).click();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("点击两侧留白也保留草稿");
  }
  const history = (await page.locator(".conversation").boundingBox())!;
  await page.mouse.click(history.x - 20, history.y + 10);
  await expect(input).toHaveCount(0);
  await page.getByRole("button", { name: /向 Morphz 输入/ }).click();
  await composerAction(page, "固定输入框");
  const fixed = (await page.locator(".composer").boundingBox())!;
  await page.mouse.click(fixed.x - 20, fixed.y + 20);
  await expect(input).toBeVisible();
  await expect(page.getByLabel("取消固定输入框")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
