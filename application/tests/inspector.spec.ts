import { expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  composerAction,
  openInput,
  openExecutionPanel,
  openExchangeReading,
} from "./interaction-helpers.js";
import { openLibrary } from "./application-helpers.js";
import { libraryDestination } from "./artifact-fixtures.js";
import {
  disconnectedRuntime,
  type ExecutionActivity,
} from "../packages/core/src/conversation.js";
import type { PlatformClient } from "../apps/web/src/platform-client.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";
import { platformInputState } from "./platform-input-state-fixture.js";

test.afterEach(async ({ page }) => {
  // An interrupted event-driven read can outlive a failed assertion. Wait for
  // those handlers before removing their fixture ownership.
  await page.unrouteAll({ behavior: "wait" });
});

async function enableExecution(page: Page, activity?: ExecutionActivity) {
  const presentation = await mockPlatformConversation(page, () => ({
    inputs: [],
    runtime: {
      ...disconnectedRuntime,
      configured: true,
      connected: true,
      ...(activity ? { activity } : {}),
    },
  }));
  await page.route("**/api/executions?*", (route) =>
    route.fulfill({ json: { jobs: [], approvals: [], limit: 100 } }),
  );
  return presentation;
}

async function preserveReadOnlyState(page: Page, client: PlatformClient) {
  const snapshot = async () => ({
    inputs: await platformInputState(page, client),
    conversations: await client.allNavigationConversations(),
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
      "Inspector inspection must not issue business writes",
    ).toEqual([]);
    expect(await snapshot()).toEqual(before);
  };
}

async function seedInspectorObject(
  page: Page,
  fixture: Awaited<ReturnType<typeof enableExecution>>,
  label: string,
) {
  await openLibrary(page);
  const project = await libraryDestination(page);
  const objectId = randomUUID();
  const title = `${label} ${objectId.slice(0, 8)}`;
  const markdown = "保留正文和当前对象。";
  // This is a real Objects write, not a rendered card or a mocked document.
  const created = (await fixture.client.createDocument({
    commandId: objectId,
    objectId,
    projectId: project.id,
    title,
    markdown,
  })) as { contentId: string; objectId: string; projectId: string };
  expect(created).toMatchObject({ objectId, projectId: project.id });
  const [entry] = await fixture.client.contentByIds([created.contentId]);
  expect(entry).toMatchObject({
    id: created.contentId,
    projectId: project.id,
    title,
    kind: "document",
  });
  const original = await fixture.client.readDocument(created.contentId);
  expect(original).toMatchObject({
    contentId: created.contentId,
    objectId,
    projectId: project.id,
    title,
    markdown,
    revision: 1,
  });
  // mockPlatformConversation owns this page's workspace EventSource. Its real
  // document commit cannot arrive through that synthetic stream on its own.
  // Send the existing typed invalidation after confirming the durable write;
  // do not restore polling, extend a timeout, or fake the missing card.
  await fixture.refresh();
  await page
    .getByRole("button", { name: `打开内容：${title}`, exact: true })
    .click();
  await expect(page.locator(".object-paper")).toBeVisible();
  await expect(
    page
      .locator(".object-paper")
      .getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  return { ...created, original };
}

async function openObjectAnnotations(page: Page) {
  const panel = page.getByRole("complementary", {
    name: "对象批注",
    exact: true,
  });
  if (!(await panel.isVisible()))
    await page.getByRole("button", { name: "展开批注栏", exact: true }).click();
  await expect(panel).toBeVisible();
  return panel;
}

async function geometry(
  page: Page,
  mode: "docked" | "overlay",
  profileSettings = false,
) {
  const panel = page.locator(".workspace-inspector");
  await expect(panel).toHaveCount(1);
  await expect(panel).toHaveAttribute("data-inspector-mode", mode);
  await expect
    .poll(async () => {
      const p = (await panel.boundingBox())!;
      const w = (await page.locator(".workspace").boundingBox())!;
      return (
        Math.abs(p.y - w.y) +
        Math.abs(p.height - w.height) +
        Math.abs(p.x + p.width - w.x - w.width)
      );
    })
    .toBeLessThan(2);
  if (mode === "docked") {
    const canvas = (await page.locator(".workspace-body").boundingBox())!;
    const p = (await panel.boundingBox())!;
    expect(canvas.width).toBeGreaterThanOrEqual(639);
    expect(Math.abs(canvas.x + canvas.width - p.x)).toBeLessThan(2);
  }
  expect(await panel.evaluate((el) => el.parentElement?.className)).toBe(
    "workspace",
  );
  await expect(panel.locator(".inspector-header")).toHaveCSS("height", "48px");
  const header = (await panel.locator(".inspector-header").boundingBox())!;
  const controls = (await page
    .locator(".workspace-inspector-controls")
    .boundingBox())!;
  expect(header.x + header.width).toBeLessThanOrEqual(controls.x);
  await expect(panel.getByLabel("AI 输入内容", { exact: true })).toHaveCount(0);
  await expect(panel.locator("#global-composer, .composer")).toHaveCount(0);
  const customStyle =
    '.personality-profile textarea[aria-label="自定义讲话风格"]';
  await expect(panel.locator(customStyle)).toHaveCount(profileSettings ? 1 : 0);
  await expect(panel.locator("textarea")).toHaveCount(profileSettings ? 1 : 0);
}

test("原生拖动区不覆盖右栏开关，菜单和背景不继承窗口拖动", async ({ page }) => {
  const fixture = await enableExecution(page);
  await page.goto("/");
  // Object creation needs the actual application host, not the pure dialogue
  // canvas. openLibrary also returns any restored immersive app without closing it.
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  const object = await seedInspectorObject(page, fixture, "TEST 右栏菜单原件");
  const finish = await preserveReadOnlyState(page, fixture.client);
  await page.locator(".app").evaluate((element) => {
    (element as HTMLElement).dataset.desktop = "mac";
  });
  const right = page.locator(".inspector-toggle");
  // Default subject tabs no longer have the withdrawn content-switch menu.
  // The actual annotation inspector retains that same popover contract.
  await openObjectAnnotations(page);
  const header = page.locator(".inspector-header");
  const headerBounds = (await header.boundingBox())!;
  const controls = (await page
    .locator(".workspace-inspector-controls")
    .boundingBox())!;
  expect
    .soft(headerBounds.x + headerBounds.width)
    .toBeLessThanOrEqual(controls.x);
  await page.getByRole("button", { name: "切换右栏内容" }).click();
  const menu = page.getByRole("group", { name: "右栏内容" });
  await expect(menu).toBeVisible();
  const regions = await menu.evaluate((element) => ({
    menu: getComputedStyle(element).getPropertyValue("-webkit-app-region"),
    backdrop: getComputedStyle(element, "::backdrop").getPropertyValue(
      "-webkit-app-region",
    ),
    backdropPointerEvents: getComputedStyle(element, "::backdrop")
      .pointerEvents,
  }));
  expect.soft(regions.menu).toBe("no-drag");
  expect.soft(regions.backdrop).toBe("no-drag");
  expect.soft(regions.backdropPointerEvents).toBe("none");
  // The visibility toggle must still work while a real inspector menu is open.
  await right.click();
  await expect(page.locator(".workspace-inspector")).toHaveCount(0);
  await expect(page.locator(".composer-options:popover-open")).toHaveCount(0);
  await openObjectAnnotations(page);
  await page.getByRole("button", { name: "切换右栏内容", exact: true }).click();
  await expect(menu).toBeVisible();
  // Outside clicks must perform the requested action as well as dismiss the menu.
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "工作台", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".composer-options:popover-open")).toHaveCount(0);
  const returnToWorkspace = page.getByRole("button", {
    name: "返回工作空间",
    exact: true,
  });
  if (await returnToWorkspace.isVisible()) await returnToWorkspace.click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await openExecutionPanel(page);
  await expect(
    page.getByRole("tablist", { name: "Morphz 信息分类", exact: true }),
  ).toHaveCSS("-webkit-app-region", "no-drag");
  await right.click();
  await expect(page.locator(".workspace-inspector")).toHaveCount(0);
  expect(await fixture.client.readDocument(object.contentId)).toEqual(
    object.original,
  );
  await finish();
});

test.describe("触控侧栏开关", () => {
  test.use({ hasTouch: true });
  test("左右保持同尺寸，命中区至少 44px", async ({ page }) => {
    await page.goto("/");
    const left = page.getByRole("button", { name: "隐藏侧边栏", exact: true });
    const right = page.locator(".inspector-toggle");
    const l = (await left.boundingBox())!;
    const r = (await right.boundingBox())!;
    expect(r.width).toBe(l.width);
    expect(r.height).toBe(l.height);
    expect(r.width).toBeGreaterThanOrEqual(44);
    expect(r.height).toBeGreaterThanOrEqual(44);
    await right.click();
    expect(await right.boundingBox()).toEqual(r);
    await expect(right).toHaveAttribute("aria-expanded", "true");
  });
});

test("三栏通用开关保持同形同位，收起再展开恢复原内容", async ({ page }) => {
  const { client } = await enableExecution(page);
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const finish = await preserveReadOnlyState(page, client);
  const left = page.getByRole("button", { name: "隐藏侧边栏", exact: true });
  const right = page.locator(".inspector-toggle");
  await expect(left.locator(".lucide-panel-left")).toHaveCount(1);
  await expect(right.locator(".lucide-panel-right")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "执行记录与审批" }),
  ).toHaveCount(0);
  const before = await right.boundingBox();
  const leftBounds = (await left.boundingBox())!;
  expect(before!.width).toBe(leftBounds.width);
  expect(before!.height).toBe(leftBounds.height);
  await expect(right).toHaveAttribute("aria-expanded", "false");
  await right.click();
  await expect(right).toHaveCount(1);
  expect(await right.boundingBox()).toEqual(before);
  await expect(page.getByRole("button", { name: "隐藏右侧栏" })).toHaveCount(1);
  // The default is the subject activity tab, not the retired understanding view.
  const panel = page.getByRole("complementary", {
    name: "Morphz 信息",
    exact: true,
  });
  const activity = panel.getByRole("tab", { name: "活动", exact: true });
  const permissions = panel.getByRole("tab", { name: "授权", exact: true });
  await expect(panel).toBeVisible();
  await expect(activity).toHaveAttribute("aria-selected", "true");
  await expect(panel.locator(".execution-sidebar-scroll")).toBeVisible();
  // This subject header intentionally keeps focus on the clicked shell toggle.
  await expect(right).toBeFocused();
  await expect(right).toHaveAttribute("aria-expanded", "true");
  await expect(right).toHaveAttribute("aria-controls", "workspace-inspector");
  await right.click();
  await expect(page.locator(".workspace-inspector")).toHaveCount(0);
  await expect(right).toHaveAttribute("aria-expanded", "false");
  await right.click();
  await expect(panel).toBeVisible();
  await expect(activity).toHaveAttribute("aria-selected", "true");
  await activity.focus();
  await activity.press("ArrowRight");
  await expect(permissions).toBeFocused();
  await expect(permissions).toHaveAttribute("aria-selected", "true");
  await expect(
    panel.getByRole("tabpanel", { name: "授权", exact: true }),
  ).toBeVisible();
  await right.click();
  await right.click();
  await expect(panel).toBeVisible();
  await expect(permissions).toHaveAttribute("aria-selected", "true");
  await expect(right).toBeFocused();
  await permissions.focus();
  await permissions.press("Home");
  await expect(activity).toBeFocused();
  await expect(activity).toHaveAttribute("aria-selected", "true");
  await expect(panel.locator(".execution-sidebar-scroll")).toBeVisible();
  await expect(right.locator(".lucide-panel-right")).toHaveCount(1);
  expect(await right.boundingBox()).toEqual(before);
  await page.keyboard.press("Escape");
  await expect(right).toBeFocused();
  await page.screenshot({ path: "test-results/sidebar-toggle-pair.png" });
  await finish();
});

test("右栏按工作现场记住内容，关闭与导航不串用选择", async ({ page }) => {
  // Controlled Runtime presentation, but real authorized Platform space IDs.
  // Two details, not one global subjectTab, must restore independently.
  const activity: ExecutionActivity = {
    available: true,
    truncated: false,
    threads: [],
  };
  const fixture = await enableExecution(page, activity);
  const threads = [
    { projectId: fixture.spaces.dialogueId, title: "TEST 对话现场执行" },
    { projectId: fixture.spaces.deskId, title: "TEST 工作台现场执行" },
  ].map(({ projectId, title }, index) => ({
    id: `TEST-inspector-scope-${index}`,
    kind: "execution",
    projectId,
    conversationId: fixture.spaces.dialogueId,
    inputId: null,
    rootId: `TEST-inspector-root-${index}`,
    sessionId: `TEST-inspector-session-${index}`,
    contextId: `TEST-inspector-context-${index}`,
    title,
    phase: "idle",
    lifecycle: "completed",
    revision: 1,
    updatedAt: "2026-10-02T12:00:00Z",
  }));
  activity.threads = threads;
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const finish = await preserveReadOnlyState(page, fixture.client);
  const right = page.locator(".inspector-toggle");
  const title = page.locator(".execution-origin-title");
  const dialogueDraft = "TEST 对话现场草稿，不发送";
  const deskDraft = "TEST 工作台现场草稿，不发送";
  await (await openInput(page)).fill(dialogueDraft);
  await openExecutionPanel(page);
  await page.locator(`[data-thread-id="${threads[0]!.id}"]`).click();
  await expect(title).toHaveText(threads[0]!.title);
  await expect(title).toHaveAttribute("title", threads[0]!.title);
  await expect(
    page.getByRole("button", { name: "返回活动列表", exact: true }),
  ).toBeVisible();
  await right.click();
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  const returnToWorkspace = page.getByRole("button", {
    name: "返回工作空间",
    exact: true,
  });
  if (await returnToWorkspace.isVisible()) await returnToWorkspace.click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await (await openInput(page)).fill(deskDraft);
  await openExecutionPanel(page);
  await page.locator(`[data-thread-id="${threads[1]!.id}"]`).click();
  await expect(title).toHaveText(threads[1]!.title);
  await expect(title).toHaveAttribute("title", threads[1]!.title);
  await expect(
    page.getByRole("button", { name: "返回活动列表", exact: true }),
  ).toBeVisible();
  await right.click();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await right.click();
  await expect(title).toHaveText(threads[0]!.title);
  await expect(title).toHaveAttribute("title", threads[0]!.title);
  await expect(
    page.getByRole("button", { name: "返回活动列表", exact: true }),
  ).toBeVisible();
  await expect(await openInput(page)).toHaveValue(dialogueDraft);
  await right.click();
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  await right.click();
  await expect(title).toHaveText(threads[1]!.title);
  await expect(title).toHaveAttribute("title", threads[1]!.title);
  await expect(
    page.getByRole("button", { name: "返回活动列表", exact: true }),
  ).toBeVisible();
  await expect(await openInput(page)).toHaveValue(deskDraft);
  await finish();
});

test("对象批注和主体活动、设定共用全高列、调宽、焦点和草稿规则", async ({
  page,
}) => {
  const fixture = await enableExecution(page);
  const { client } = fixture;
  await page.goto("/");
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  const object = await seedInspectorObject(
    page,
    fixture,
    "TEST 检查器布局原件",
  );
  const box = await openInput(page);
  await box.fill("检查器验收草稿，不发送");
  const finish = await preserveReadOnlyState(page, client);
  // Visibility now restores the subject, not an implicit annotation/understanding
  // feature. Choose the existing object annotation action explicitly.
  await openObjectAnnotations(page);
  await page.getByRole("button", { name: "隐藏右侧栏" }).click();
  await openObjectAnnotations(page);
  await geometry(page, "docked");
  await expect(page.locator(".inspector-header h2")).toBeFocused();
  await page
    .locator(".workspace-inspector")
    .getByRole("separator", { name: "调整批注栏宽度" })
    .press("ArrowLeft");
  await expect(
    page.locator(".workspace-inspector").getByRole("separator"),
  ).toHaveAttribute("aria-valuenow", "356");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "显示右侧栏" })).toBeFocused();
  // The understanding entrance was removed before the icon-owner change. Use
  // the current activity/settings presentations, without claiming it still exists.
  await openExecutionPanel(page);
  const subject = page.getByRole("complementary", {
    name: "Morphz 信息",
    exact: true,
  });
  const activityTab = subject.getByRole("tab", { name: "活动", exact: true });
  const settingsTab = subject.getByRole("tab", { name: "设定", exact: true });
  await expect(activityTab).toHaveAttribute("aria-selected", "true");
  await expect(activityTab).toBeFocused();
  await expect(subject.locator(".execution-sidebar-scroll")).toBeVisible();
  await geometry(page, "docked");
  await expect(
    page.locator(".workspace-inspector").getByRole("separator"),
  ).toHaveAttribute("aria-valuenow", "356");
  await settingsTab.click();
  await expect(settingsTab).toHaveAttribute("aria-selected", "true");
  await expect(settingsTab).toBeFocused();
  await expect(
    subject.getByRole("tabpanel", { name: "设定", exact: true }),
  ).toBeVisible();
  await geometry(page, "docked", true);
  await expect(
    page.locator(".workspace-inspector").getByRole("separator"),
  ).toHaveAttribute("aria-valuenow", "356");
  await page.screenshot({ path: "test-results/inspector-docked-light.png" });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.getByRole("button", { name: "隐藏右侧栏" })).toHaveCSS(
    "color",
    "rgb(244, 244, 246)",
  );
  await page.screenshot({ path: "test-results/inspector-docked-dark.png" });
  await page.setViewportSize({ width: 1220, height: 760 });
  await geometry(page, "docked", true);
  await expect(
    page.locator(".workspace-inspector").getByRole("separator"),
  ).toHaveAttribute("aria-valuenow", "300");
  await page.setViewportSize({ width: 1000, height: 700 });
  await geometry(page, "overlay", true);
  await expect(
    page.locator(".workspace-inspector").getByRole("separator"),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "隐藏侧边栏", exact: true }).click();
  await geometry(page, "docked", true);
  await expect(
    page.locator(".workspace-inspector").getByRole("separator"),
  ).toHaveAttribute("aria-valuenow", "356");
  for (const width of [760, 390, 320]) {
    await page.setViewportSize({ width, height: 540 });
    await geometry(page, "overlay", true);
    const bounds = (await page.locator(".workspace-inspector").boundingBox())!;
    expect(bounds.width).toBeCloseTo(Math.min(340, width), 1);
    await expect(
      page.getByRole("button", { name: "隐藏右侧栏" }),
    ).toBeInViewport();
  }
  await page.getByRole("button", { name: "隐藏右侧栏" }).click();
  await expect(page.locator(".workspace-inspector")).toHaveCount(0);
  await openInput(page);
  await expect(box).toHaveValue("检查器验收草稿，不发送");
  await page.setViewportSize({ width: 1440, height: 960 });
  await openObjectAnnotations(page);
  // This remaining annotation menu performs the real switch to activity.
  await page.getByRole("button", { name: "切换右栏内容", exact: true }).click();
  await page
    .getByRole("group", { name: "右栏内容", exact: true })
    .getByRole("button", { name: "执行记录", exact: true })
    .click();
  await expect(activityTab).toHaveAttribute("aria-selected", "true");
  await activityTab.focus();
  await page.keyboard.press("Escape");
  await expect(page.locator(".workspace-inspector")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "显示右侧栏", exact: true }),
  ).toBeFocused();
  await expect(await openInput(page)).toHaveValue("检查器验收草稿，不发送");
  expect(await client.readDocument(object.contentId)).toEqual(object.original);
  await finish();
});

test("网页与窄窗检查器、悬浮 Dock 叠放，不改变网页尺寸或协助权限", async ({
  page,
}) => {
  const { client } = await enableExecution(page);
  await page.addInitScript(() => {
    const state = {
      pageId: "inspector-browser",
      surface: { partition: "fixture", src: "https://example.com/" },
      projectId: "fixture",
      artifactId: null,
      url: "https://example.com/",
      title: "Example",
      epoch: 1,
      granted: false,
      canGoBack: false,
      canGoForward: false,
      pending: null,
    };
    Reflect.set(window, "browserOpenCount", 0);
    Reflect.set(window, "browserCloseCount", 0);
    Reflect.set(window, "morphzDesktop", {
      browser: {
        open: async () => {
          Reflect.set(
            window,
            "browserOpenCount",
            Reflect.get(window, "browserOpenCount") + 1,
          );
          return state;
        },
        state: async () => state,
        close: async () =>
          Reflect.set(
            window,
            "browserCloseCount",
            Reflect.get(window, "browserCloseCount") + 1,
          ),
        visibility: async (_id: string, visible: boolean) =>
          Reflect.set(window, "inspectorBrowserVisible", visible),
        control: async () => {
          throw new Error("Inspector must not grant control");
        },
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  const returnToWorkspace = page.getByRole("button", {
    name: "返回工作空间",
    exact: true,
  });
  if (await returnToWorkspace.isVisible()) await returnToWorkspace.click();
  await expect(
    page.getByRole("button", { name: "应用启动台", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  await page.locator(".application-launcher").screenshot();
  await page.getByRole("button", { name: "浏览器 1.0.0", exact: true }).click();
  await page
    .getByRole("textbox", { name: "网站地址" })
    .fill("https://example.com/");
  await page.getByRole("textbox", { name: "网站地址" }).press("Enter");
  await expect(page.locator(".browser-slot")).toBeVisible();
  const finish = await preserveReadOnlyState(page, client);
  await page.setViewportSize({ width: 1000, height: 700 });
  const slot = page.locator(".browser-slot");
  const before = (await slot.boundingBox())!;
  await openInput(page);
  await openExecutionPanel(page);
  const panel = page.locator(".workspace-inspector");
  await expect(panel).toHaveAttribute("data-inspector-mode", "overlay");
  await expect(panel.locator(".inspector-header")).toHaveCSS("height", "52px");
  await expect
    .poll(async () => {
      const bounds = (await slot.boundingBox())!;
      return Math.abs(bounds.width - before.width);
    })
    .toBeLessThan(2);
  await page.getByRole("button", { name: "隐藏右侧栏" }).click();
  await expect
    .poll(async () => {
      return Math.abs((await slot.boundingBox())!.width - before.width);
    })
    .toBeLessThan(2);
  await openInput(page);
  const draft = "TEST 网页右栏与记录检查，不发送";
  await page.getByLabel("AI 输入内容").fill(draft);
  await composerAction(page, "固定输入框");
  // Writing focus does not open reading. Choose it before the collapse action.
  await openExchangeReading(page);
  await composerAction(page, "收起交流记录");
  await expect(page.locator(".conversation")).toHaveCount(0);
  await expect(page.locator(".browser-slot")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await expect(page.locator(".browser-slot")).toHaveCSS("border-width", "0px");
  await expect
    .poll(async () => {
      return Math.abs((await slot.boundingBox())!.height - before.height);
    })
    .toBeLessThan(2);
  await page
    .getByRole("button", { name: "收起 AI 输入框", exact: true })
    .click();
  await expect
    .poll(async () => {
      return Math.abs((await slot.boundingBox())!.height - before.height);
    })
    .toBeLessThan(2);
  expect(
    await page.evaluate(() => [
      Reflect.get(window, "browserOpenCount"),
      Reflect.get(window, "browserCloseCount"),
    ]),
  ).toEqual([1, 0]);
  await expect(
    page.getByRole("button", { name: "允许 Agent 协助" }),
  ).toBeVisible();
  await expect(await openInput(page)).toHaveValue(draft);
  await finish();
});
