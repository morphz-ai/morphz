import { test, expect } from "@playwright/test";
import {
  conversationRuntimeSchema,
  type ConversationRuntime,
  type ExecutionActivity,
} from "../packages/core/src/conversation.js";
import { subjectLogoState } from "../apps/web/src/subject-sidebar-model.js";
import { mockPlatformConversation } from "./platform-conversation-fixture.js";
import { openInput } from "./interaction-helpers.js";

const stamp = "2026-10-01T12:00:00.000Z";
const baseRuntime = (): ConversationRuntime =>
  conversationRuntimeSchema.parse({
    configured: true,
    connected: true,
    model: "test-model",
    error: "",
    messages: [],
    deliveries: [],
    activity: { available: true, truncated: false, threads: [] },
    attention: { available: true, approvals: [] },
  });
type Thread = ExecutionActivity["threads"][number];

test("Logo真实状态更新不抢导航与焦点，点击只打开活动或授权且不发送或建会话", async ({
  page,
}, testInfo) => {
  const runtime = baseRuntime();
  const fixture = await mockPlatformConversation(page, () => ({
    inputs: [],
    runtime,
  }));
  const initialConversations =
    await fixture.client.allNavigationConversations();
  let messageWrites = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/platform\/(messages|conversations\/start)$/.test(request.url())
    )
      messageWrites++;
  });
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.getByRole("button", { name: "对话", exact: true }).click();
  const logo = page.locator(".sidebar .wordmark.agent-presence");
  const mark = logo.locator(".brand-mark");
  const originalPath = await mark.locator("path").getAttribute("d");
  await expect(logo).toHaveAttribute("data-state", "idle");
  await expect(logo.locator(".agent-presence-status")).toHaveCount(0);
  await logo.click();
  const panel = page.getByRole("complementary", {
    name: "Morphz 信息",
    exact: true,
  });
  const tabs = panel.getByRole("tablist", { name: "Morphz 信息分类" });
  await expect(
    tabs.getByRole("tab", { name: "活动", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await tabs.getByRole("tab", { name: "设定", exact: true }).click();
  const input = await openInput(page);
  const draft = "TEST Logo状态更新不改变当前草稿";
  await input.fill(draft);
  const title = await page.title();
  const running: Thread = {
    id: "logo-working",
    kind: "dialogue_turn",
    ...fixture.scope,
    inputId: null,
    rootId: "logo-root",
    sessionId: "logo-session",
    title: "TEST 当前对话输出",
    phase: "running",
    lifecycle: "open",
    controlState: "active",
    revision: 1,
    updatedAt: stamp,
  };
  runtime.activity!.threads = [running];
  await fixture.refresh();
  await expect(logo).toHaveAttribute("data-state", "working");
  await expect(logo).toHaveAttribute("data-working", "true");
  await logo.screenshot({ path: testInfo.outputPath("working-logo.png") });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue(draft);
  await expect(
    tabs.getByRole("tab", { name: "设定", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  runtime.attention!.approvals = [
    {
      scope: {
        projectId: fixture.scope.projectId,
        artifactId: null,
        inputId: "logo-approval-input",
      },
      approval: {
        fingerprint: "a".repeat(64),
        requested_at: stamp,
        request: {
          approval_id: "logo-approval",
          session_id: "logo-session",
          context_id: "logo-context",
          justification: "TEST 待授权呈现",
          action: {},
          requested: {},
        },
      },
    },
  ];
  await fixture.refresh();
  await expect(logo).toHaveAttribute("data-state", "approval");
  await expect(logo).toHaveAttribute("data-working", "true");
  await logo.screenshot({ path: testInfo.outputPath("approval-logo.png") });
  const presence = subjectLogoState(runtime, true);
  await expect(logo).toHaveAccessibleName(
    `Morphz · ${presence.label} · 查看授权`,
  );
  await expect(input).toBeFocused();
  await expect(
    tabs.getByRole("tab", { name: "设定", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await logo.click();
  await expect(
    tabs.getByRole("tab", { name: "授权", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  runtime.attention!.approvals = [];
  runtime.activity!.threads = [
    { ...running, phase: "waiting", controlState: "paused" },
  ];
  await fixture.refresh();
  await expect(logo).toHaveAttribute("data-state", "paused");
  await expect(logo).toHaveAttribute("data-working", "false");
  await logo.screenshot({ path: testInfo.outputPath("paused-logo.png") });
  runtime.activity!.threads = [{ ...running, phase: "waiting" }];
  await fixture.refresh();
  await expect(logo).toHaveAttribute("data-state", "waiting");
  await expect(
    tabs.getByRole("tab", { name: "授权", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await logo.click();
  await expect(
    tabs.getByRole("tab", { name: "活动", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    panel.getByRole("button", { name: "全部工作", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveTitle(title);
  await expect(
    nav.getByRole("button", { name: "对话", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(await openInput(page)).toHaveValue(draft);
  await expect(mark.locator("path")).toHaveAttribute("d", originalPath!);
  expect(messageWrites).toBe(0);
  expect(await fixture.client.allNavigationConversations()).toEqual(
    initialConversations,
  );
  runtime.connected = false;
  await fixture.refresh();
  await expect(logo).toHaveAttribute("data-state", "unknown");
  await expect(logo).toHaveAttribute("data-working", "false");
  await expect(
    tabs.getByRole("tab", { name: "活动", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
});

test("灵动遵守系统与本机减少动画，原Logo轮廓和展开／80图标栏／390窄屏布局不变", async ({
  page,
}) => {
  const runtime = baseRuntime();
  const fixture = await mockPlatformConversation(page, () => ({
    inputs: [],
    runtime,
  }));
  runtime.activity!.threads = [
    {
      id: "logo-execution",
      kind: "execution",
      ...fixture.scope,
      inputId: null,
      rootId: "logo-root",
      sessionId: "logo-session",
      title: "TEST 动效样本",
      phase: "running",
      lifecycle: "open",
      revision: 1,
      updatedAt: stamp,
    },
  ];
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const logo = page.locator(".sidebar .wordmark.agent-presence");
  const mark = logo.locator(".brand-mark");
  const glint = mark.locator("rect.brand-mark-glint");
  await expect(logo).toHaveAttribute("data-working", "true");
  await expect(glint).toHaveCount(1);
  await expect(glint).toHaveCSS("animation-name", "subject-mark-glint");
  await expect(mark).toHaveCSS("animation-name", "subject-mark-breathe");
  await expect(mark.locator("path")).toHaveAttribute(
    "d",
    "M8 4 48 40 38 40 38 70 8 92Z M88 4 48 40 58 40 58 70 88 92Z",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(glint).toHaveCSS("animation-name", "none");
  await expect(mark).toHaveCSS("animation-name", "none");
  await logo.hover();
  await expect(mark).toHaveCSS("transform", "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => {
    document.documentElement.dataset.appMotion = "reduce";
  });
  await expect(glint).toHaveCSS("animation-name", "none");
  await expect(mark).toHaveCSS("animation-name", "none");
  await expect(mark).toHaveCSS("transform", "none");
  const handle = page.getByRole("separator", {
    name: "调整左侧栏宽度",
    exact: true,
  });
  for (const compact of [false, true]) {
    await handle.focus();
    await page.keyboard.press(compact ? "Home" : "End");
    await expect(mark).toHaveCSS("width", compact ? "32px" : "23px");
    await expect(mark).toHaveCSS("height", compact ? "32px" : "25px");
    if (compact)
      await expect(page.locator(".sidebar")).toHaveCSS("width", "80px");
    const before = await logo.boundingBox();
    await logo.hover();
    expect(await logo.boundingBox()).toEqual(before);
    const first = page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button")
      .first();
    const bounds = (await logo.boundingBox())!;
    const navigation = (await first.boundingBox())!;
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(navigation.y);
    expect(
      await logo.evaluate((element) => {
        const r = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
        );
      }),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 850 });
  await expect(logo).toBeInViewport();
  await expect(handle).toBeHidden();
  const bounds = (await logo.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  expect(
    await page
      .locator(".app")
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true);
  await expect(mark).toHaveCSS("animation-name", "none");
});
