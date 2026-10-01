import { test, expect, type Page } from "@playwright/test";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import type { PlatformHistory } from "../apps/web/src/platform-client.js";
import { mockPlatformConversation } from "./platform-conversation-fixture.js";
import { openInput } from "./interaction-helpers.js";

async function openSubject(page: Page) {
  const panel = page.getByRole("complementary", {
    name: "Morphz 信息",
    exact: true,
  });
  if (!(await panel.isVisible()))
    await page.getByRole("button", { name: "显示右侧栏", exact: true }).click();
  await expect(panel).toBeVisible();
  return panel;
}

test("主体栏默认活动，四个图标分类支持键盘并记住选择，后台更新不切换视图", async ({
  page,
}) => {
  let connected = true;
  const fixture = await mockPlatformConversation(page, () => ({
    inputs: [],
    runtime: {
      ...disconnectedRuntime,
      configured: true,
      connected,
      activity: { available: true, truncated: false, threads: [] },
      attention: { available: true, approvals: [] },
    },
  }));
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const panel = await openSubject(page);
  const tabs = panel.getByRole("tablist", { name: "Morphz 信息分类" });
  await expect(
    panel.getByRole("heading", { name: "Morphz", exact: true }),
  ).toHaveCount(0);
  await expect(panel.locator(".subject-presence")).toHaveCount(0);
  await expect(tabs.getByRole("tab")).toHaveCount(4);
  await expect(
    tabs.getByRole("tab", { name: "活动", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  for (const name of ["活动", "授权", "安排", "设定"]) {
    const tab = tabs.getByRole("tab", { name, exact: true });
    await expect(tab.locator("svg")).toHaveCount(1);
    await expect(tab).toHaveText("");
  }
  await expect(
    panel.getByRole("button", { name: "切换右栏内容", exact: true }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "当前理解", exact: true }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "录音转文字", exact: true }),
  ).toHaveCount(0);
  await tabs.getByRole("tab", { name: "活动", exact: true }).focus();
  await page.keyboard.press("End");
  await expect(
    tabs.getByRole("tab", { name: "设定", exact: true }),
  ).toBeFocused();
  await expect(
    tabs.getByRole("tab", { name: "设定", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "隐藏右侧栏", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await openSubject(page);
  await expect(
    tabs.getByRole("tab", { name: "设定", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  connected = false;
  await fixture.refresh();
  await expect(
    tabs.getByRole("tab", { name: "设定", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  const preferenceKey = `morphz:${fixture.client.boot.centerId}:${fixture.client.boot.principalId}:preferences`;
  await page.evaluate((key) => {
    const saved = JSON.parse(localStorage.getItem(key) ?? "{}");
    localStorage.setItem(
      key,
      JSON.stringify({
        ...saved,
        executionPinned: true,
        inspectorWidth: 356,
        dockApplications: ["preserve-dock-pin@1"],
        pinnedInputs: { "preserve-input-pin": true },
      }),
    );
  }, preferenceKey);
  await page.reload();
  // A retired sidebar pin must not reopen an activity scope over the user's
  // remembered settings view. Other pin preferences remain independent.
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "显示右侧栏", exact: true }),
  ).toBeVisible();
  await expect(panel).toHaveCount(0);
  await openSubject(page);
  await expect(
    tabs.getByRole("tab", { name: "设定", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  const saved = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    preferenceKey,
  );
  expect(saved.inspectorWidth).toBe(356);
  expect(saved.dockApplications).toEqual(["preserve-dock-pin@1"]);
  expect(saved.pinnedInputs).toEqual({ "preserve-input-pin": true });
  await expect(
    panel.getByRole("button", { name: /固定信息栏|固定活动面板/ }),
  ).toHaveCount(0);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 850 });
    await expect(tabs).toBeInViewport();
    const tabBounds = (await tabs
      .getByRole("tab", { name: "活动", exact: true })
      .boundingBox())!;
    const toggleBounds = (await page
      .getByRole("button", { name: "隐藏右侧栏", exact: true })
      .boundingBox())!;
    expect(
      Math.abs(
        tabBounds.y +
          tabBounds.height / 2 -
          toggleBounds.y -
          toggleBounds.height / 2,
      ),
    ).toBeLessThanOrEqual(1);
    const tabsBounds = (await tabs.boundingBox())!;
    expect(tabsBounds.x + tabsBounds.width).toBeLessThanOrEqual(toggleBounds.x);
    expect(
      await panel.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/subject-sidebar-${width}.png`,
    });
  }
});

test("活动列表使用真实线程身份与终态，目标仅展开其关联执行且不改变输入范围", async ({
  page,
}) => {
  const inputs: PlatformHistory["inputs"] = [];
  const threads: NonNullable<
    PlatformHistory["runtime"]["activity"]
  >["threads"] = [];
  const objectives: NonNullable<
    NonNullable<PlatformHistory["runtime"]["activity"]>["objectives"]
  > = [];
  const fixture = await mockPlatformConversation(page, () => ({
    inputs,
    runtime: {
      ...disconnectedRuntime,
      configured: true,
      connected: true,
      activity: {
        available: true,
        truncated: false,
        objectivesTruncated: false,
        threads,
        objectives,
      },
      attention: { available: true, approvals: [] },
    },
  }));
  inputs.push(
    fixture.input(
      "subject-input",
      "TEST 原消息不是工作事项标题",
      "2026-10-01T12:00:00.000Z",
    ),
  );
  for (const [id, title, lifecycle] of [
    ["subject-open", "检查下载进度", "open"],
    ["subject-ended", "核对环境版本", "completed"],
    ["subject-failed", "安装依赖失败", "failed"],
    ["subject-cancelled", "取消试听任务", "cancelled"],
  ])
    threads.push({
      id: id!,
      title: title!,
      lifecycle: lifecycle!,
      kind: "execution",
      ...fixture.scope,
      inputId: "subject-input",
      rootId: "subject-root",
      sessionId: "subject-session",
      phase: "running",
      revision: 1,
      updatedAt: "2026-10-01T12:00:00.000Z",
    });
  threads.push({
    ...threads[0]!,
    id: "subject-dialogue",
    kind: "dialogue_turn",
    title: "普通聊天不冒充执行任务",
  });
  objectives.push({
    id: "subject-objective",
    title: "验证语音环境",
    ...fixture.scope,
    inputId: "subject-input",
    rootId: "subject-root",
    sessionId: "subject-session",
    status: "active",
    statusReason: "正在检查下载和依赖",
    readiness: "ready",
    parentId: null,
    threadIds: ["subject-open", "subject-ended"],
    updatedAt: "2026-10-01T12:00:00.000Z",
  });
  const queries: URLSearchParams[] = [];
  await page.route("**/api/executions?*", (route) => {
    queries.push(new URL(route.request().url()).searchParams);
    return route.fulfill({ json: { jobs: [], approvals: [], limit: 100 } });
  });
  await page.addInitScript(({ centerId, principalId }) => {
    localStorage.setItem(
      `morphz:${centerId}:${principalId}:preferences`,
      JSON.stringify({ view: "dialogue", executionPinned: true }),
    );
  }, fixture.client.boot);
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const draft = "TEST 查看目标和线程不发送的草稿";
  await (await openInput(page)).fill(draft);
  const panel = await openSubject(page);
  await expect(
    panel.getByRole("button", { name: "当前工作", exact: true }),
  ).toHaveCount(1);
  await expect(
    panel.getByRole("button", { name: "全部工作", exact: true }),
  ).toHaveCount(1);
  await expect(panel.locator(".execution-activity-row")).toHaveCount(4);
  await expect(panel.locator(".execution-activity-row").first()).toContainText(
    "检查下载进度",
  );
  await expect(
    panel.locator('[data-thread-id="subject-ended"]'),
  ).toHaveAttribute("aria-label", /已结束/);
  await expect(
    panel.locator('[data-thread-id="subject-ended"] .execution-activity-icon'),
  ).toHaveAttribute("data-status", "ended");
  await expect(
    panel.locator('[data-thread-id="subject-ended"]'),
  ).not.toContainText("已结束");
  await expect(
    panel.locator('[data-thread-id="subject-ended"]'),
  ).not.toContainText("成功");
  await expect(
    panel.locator('[data-thread-id="subject-failed"]'),
  ).toHaveAttribute("aria-label", /执行失败/);
  await expect(
    panel.locator('[data-thread-id="subject-failed"] .execution-activity-icon'),
  ).toHaveAttribute("data-status", "failed");
  await expect(
    panel.locator('[data-thread-id="subject-cancelled"]'),
  ).toHaveAttribute("aria-label", /已取消/);
  await expect(
    panel.locator(
      '[data-thread-id="subject-cancelled"] .execution-activity-icon',
    ),
  ).toHaveAttribute("data-status", "cancelled");
  await expect(panel).not.toContainText("普通聊天不冒充执行任务");
  const goal = panel.locator('[data-objective-id="subject-objective"]');
  await goal.getByRole("button", { name: /验证语音环境/ }).click();
  await expect(
    goal.getByRole("button", { name: "检查下载进度", exact: true }),
  ).toBeVisible();
  await expect(
    goal.getByRole("button", { name: "核对环境版本", exact: true }),
  ).toBeVisible();
  await expect(
    goal.getByRole("button", { name: "安装依赖失败", exact: true }),
  ).toHaveCount(0);
  await goal.getByRole("button", { name: "检查下载进度", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "返回活动列表", exact: true }),
  ).toBeVisible();
  await expect.poll(() => queries.at(-1)?.get("threadId")).toBe("subject-open");
  expect(queries.at(-1)?.get("inputId")).toBe("subject-input");
  expect(queries.at(-1)?.get("conversationId")).toBe(
    fixture.scope.conversationId,
  );
  await expect(await openInput(page)).toHaveValue(draft);
  // Navigation clears an exact execution selection even if old storage
  // contains executionPinned=true. The subject sidebar stays available.
  await panel
    .getByRole("button", { name: "返回活动列表", exact: true })
    .click();
  await expect(panel.locator(".execution-activity-row")).toHaveCount(4);
  await panel.locator('[data-thread-id="subject-open"]').click();
  await expect(
    panel.getByRole("button", { name: "返回活动列表", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await expect(panel).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "返回活动列表", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await expect(await openInput(page)).toHaveValue(draft);
  await expect(page.locator(".human-message")).toHaveCount(1);
  threads[0]!.lifecycle = "completed";
  await fixture.refresh();
  await expect(panel.locator(".execution-quiet")).toHaveCount(0);
  await expect(panel.locator(".execution-activity-row")).toHaveCount(4);
});

test("应用 Dock 固定可刷新恢复，真实启动不发消息或新建 Session，各工作现场草稿独立可恢复", async ({
  page,
}) => {
  const errors: string[] = [],
    writes: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/platform\/messages(?:\?|$)/.test(request.url())
    )
      writes.push(request.url());
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const sessionsBefore = await (
    await page.request.get("/api/platform/conversations/navigation?limit=100")
  ).json();
  const draft = "TEST Dock 切换应用仍保留的未发送草稿";
  await (await openInput(page)).fill(draft);
  const dock = page.getByLabel("应用 Dock", { exact: true });
  await expect(
    dock.getByRole("button", { name: "打开浏览器", exact: true }),
  ).toBeVisible();
  const floatingGeometry = await dock.evaluate((element) => {
    const group = element.querySelector<HTMLElement>(
      ".application-dock-buttons",
    )!;
    const style = getComputedStyle(group);
    return {
      group: {
        background: style.backgroundColor,
        border: style.borderWidth,
        shadow: style.boxShadow,
        padding: style.padding,
      },
      buttons: [
        ...group.querySelectorAll<HTMLElement>(".application-dock-shortcut"),
      ].map((button) => {
        const bounds = button.getBoundingClientRect();
        const icon = button.querySelector("svg,img")!.getBoundingClientRect();
        const appearance = getComputedStyle(button);
        return {
          width: bounds.width,
          height: bounds.height,
          radius: appearance.borderRadius,
          shadow: appearance.boxShadow,
          iconWidth: icon.width,
          iconHeight: icon.height,
        };
      }),
    };
  });
  expect(floatingGeometry.group).toEqual({
    background: "rgba(0, 0, 0, 0)",
    border: "0px",
    shadow: "none",
    padding: "0px",
  });
  for (const button of floatingGeometry.buttons) {
    expect(button.width).toBe(32);
    expect(button.height).toBe(32);
    expect(button.radius).toBe("9px");
    expect(button.shadow).toContain("inset");
    expect(button.iconWidth).toBe(16);
    expect(button.iconHeight).toBe(16);
  }
  await dock.getByRole("button", { name: "全部应用", exact: true }).click();
  const catalog = page.getByRole("group", { name: "选择应用", exact: true });
  await expect(
    catalog.getByRole("button", { name: "在工作台管理应用", exact: true }),
  ).toBeVisible();
  // Inspect rendered geometry, not just the presence of a Grid icon.
  for (const [width, columns] of [
    [1440, 4],
    [390, 3],
    [320, 2],
  ]) {
    await page.setViewportSize({ width: width!, height: 850 });
    await expect(catalog).toBeInViewport();
    const geometry = await catalog.evaluate((element) => {
      const grid = element.querySelector<HTMLElement>(
        ".application-dock-catalog",
      )!;
      const entries = [
        ...grid.querySelectorAll<HTMLElement>(".application-dock-entry"),
      ];
      return {
        columns: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
        overflows: element.scrollWidth > element.clientWidth + 1,
        tiles: entries.map((entry) => {
          const launch = entry
            .querySelector<HTMLElement>(".application-dock-launch")!
            .getBoundingClientRect();
          const icon = entry
            .querySelector<HTMLElement>(".application-dock-app-icon")!
            .getBoundingClientRect();
          const name = entry
            .querySelector<HTMLElement>(".application-dock-app-name")!
            .getBoundingClientRect();
          return {
            x: launch.x,
            y: launch.y,
            width: launch.width,
            iconBottom: icon.bottom,
            iconCenter: icon.x + icon.width / 2,
            nameTop: name.top,
            nameCenter: name.x + name.width / 2,
          };
        }),
      };
    });
    expect(geometry.columns).toBe(Math.min(columns!, geometry.tiles.length));
    expect(geometry.overflows).toBe(false);
    expect(geometry.tiles.length).toBeGreaterThanOrEqual(3);
    for (const tile of geometry.tiles) {
      expect(tile.nameTop - tile.iconBottom).toBeGreaterThanOrEqual(8);
      expect(Math.abs(tile.nameCenter - tile.iconCenter)).toBeLessThanOrEqual(
        1,
      );
      expect(tile.width).toBeGreaterThanOrEqual(80);
    }
    expect(geometry.tiles[1]!.x).toBeGreaterThan(geometry.tiles[0]!.x);
    expect(geometry.tiles[1]!.y).toBe(geometry.tiles[0]!.y);
    if (width === 320)
      expect(geometry.tiles[2]!.y).toBeGreaterThan(geometry.tiles[0]!.y);
    await page.screenshot({
      path: `test-results/application-launcher-${width}.png`,
    });
  }
  await page.setViewportSize({ width: 1440, height: 850 });
  // Pin stays unobtrusive at rest, but keyboard focus reveals it before action.
  const readerPin = catalog.getByRole("button", {
    name: "固定到 Dock：阅读",
    exact: true,
  });
  await page.mouse.move(1, 1);
  await catalog
    .getByRole("button", { name: "打开浏览器", exact: true })
    .focus();
  await expect(readerPin).toHaveCSS("opacity", "0");
  await catalog.getByRole("button", { name: "打开阅读", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(readerPin).toBeFocused();
  await expect(readerPin).toHaveCSS("opacity", "1");
  await page.keyboard.press("Space");
  await expect(
    catalog.getByRole("button", { name: "从 Dock 移除：阅读", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(
    dock.getByRole("button", { name: "全部应用", exact: true }),
  ).toBeFocused();
  await expect(
    dock.getByRole("button", { name: "打开阅读", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(await openInput(page)).toHaveValue(draft);
  await expect(
    dock.getByRole("button", { name: "打开阅读", exact: true }),
  ).toBeVisible();
  await dock.getByRole("button", { name: "全部应用", exact: true }).click();
  await catalog
    .getByRole("button", { name: "从 Dock 移除：浏览器", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(
    dock.getByRole("button", { name: "打开浏览器", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(await openInput(page)).toHaveValue(draft);
  await expect(
    dock.getByRole("button", { name: "打开浏览器", exact: true }),
  ).toHaveCount(0);
  const launched = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/platform/app-views/launch") &&
      response.ok(),
  );
  await dock.getByRole("button", { name: "全部应用", exact: true }).click();
  await catalog.getByRole("button", { name: "打开阅读", exact: true }).focus();
  await page.keyboard.press("Enter");
  await launched;
  await expect(
    page.getByRole("tab", { name: "阅读", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("region", { name: "阅读书库", exact: true }),
  ).toBeVisible();
  // A new application has its own input scene. Do not carry another scene's
  // attachments, directory authorization or unsent text into it implicitly.
  await expect(await openInput(page)).toHaveValue("");
  const readerDraft = "TEST 阅读现场独立保存的草稿";
  await (await openInput(page)).fill(readerDraft);
  const navigation = page.getByRole("navigation", { name: "主导航" });
  await navigation.getByRole("button", { name: "对话", exact: true }).click();
  await expect(await openInput(page)).toHaveValue(draft);
  await navigation.getByRole("button", { name: "工作台", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "阅读", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(await openInput(page)).toHaveValue(readerDraft);
  await page.reload();
  await expect(await openInput(page)).toHaveValue(readerDraft);
  expect(
    await (
      await page.request.get("/api/platform/conversations/navigation?limit=100")
    ).json(),
  ).toEqual(sessionsBefore);
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
  await page.setViewportSize({ width: 390, height: 850 });
  await openInput(page);
  await dock.getByRole("button", { name: "全部应用", exact: true }).click();
  await expect(catalog).toBeInViewport();
  expect(
    await catalog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({ path: "test-results/application-dock-390.png" });
  await catalog
    .getByRole("button", { name: "在工作台管理应用", exact: true })
    .click();
  await expect(catalog).not.toBeVisible();
  await expect(
    page.getByRole("region", { name: "应用", exact: true }),
  ).toBeVisible();
  expect(writes).toEqual([]);
});
