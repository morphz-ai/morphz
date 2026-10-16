import { expect } from "@playwright/test";
import {
  test,
  mockPlatformConversation,
} from "./platform-conversation-fixture.js";
import { openInput } from "./interaction-helpers.js";
import { conversationRuntimeSchema } from "../packages/core/src/conversation.js";

const stamp = "2026-10-16T04:00:00Z";
test("收起入口跟随真实形状的运行、并行、等待、重试、审批和终态，后台更新不展开或丢稿", async ({
  page,
}, info) => {
  const runtime = conversationRuntimeSchema.parse({
    configured: true,
    connected: true,
    model: "TEST",
    error: "",
    deliveries: [],
    messages: [],
    activity: { available: true, openWorkComplete: true, threads: [] },
    attention: { available: true, approvals: [] },
  });
  const inputs: ReturnType<
    Awaited<ReturnType<typeof mockPlatformConversation>>["input"]
  >[] = [];
  const f = await mockPlatformConversation(page, () => ({ inputs, runtime }));
  inputs.push(f.input("collapsed-current", "TEST 检查终端", stamp));
  let writes = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/platform\/(messages|conversations\/start)$/.test(request.url())
    )
      writes++;
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  const input = await openInput(page);
  await input.fill("TEST 原草稿仍在，不要发送");
  await page.getByRole("heading", { name: "应用", exact: true }).click();
  const entry = page.locator(".composer-reopen");
  await expect(input).toHaveCount(0);
  await expect(entry).toHaveAttribute("data-state", "idle");
  const mainBox = await page
    .getByRole("main", { name: "主工作区" })
    .boundingBox();
  runtime.deliveries = [
    {
      inputId: "collapsed-current",
      state: "queued",
      error: null,
      retryable: false,
    },
  ];
  await f.refresh();
  await expect(entry).toHaveAttribute("data-state", "queued");
  await expect(entry).toContainText("排队等待");
  await expect(entry).not.toHaveAttribute("data-animated", "true");
  runtime.deliveries[0]!.state = "running";
  await f.refresh();
  await expect(entry).toHaveAttribute("data-state", "processing");
  await expect(entry).toHaveAttribute("data-animated", "true");
  runtime.activity!.threads = Array.from({ length: 4 }, (_, index) => ({
    id: `collapsed-thread-${index}`,
    kind: "execution",
    ...f.scope,
    inputId: "collapsed-current",
    rootId: "root-current",
    sessionId: "session-current",
    contextId: "context-current",
    title: "TEST 终端并行校验",
    phase: "running",
    lifecycle: "open",
    controlState: "active",
    revision: 1,
    updatedAt: stamp,
  }));
  runtime.messages = [
    {
      id: "progress-current",
      ...f.scope,
      inputId: "collapsed-current",
      rootId: "root-current",
      artifactId: null,
      kind: "progress",
      createdAt: stamp,
      text: "已启动检查，正在收集终端结果。",
    },
  ];
  await f.refresh();
  await expect(entry).toHaveAttribute("data-state", "running");
  await expect(entry).toContainText("4 路并行");
  await expect(entry).toContainText("已启动检查，正在收集终端结果。");
  await expect(input).toHaveCount(0);
  expect(
    await page.getByRole("main", { name: "主工作区" }).boundingBox(),
  ).toEqual(mainBox);
  for (const appearance of ["light", "dark"]) {
    await page.locator(".app").evaluate((el, value) => {
      el.setAttribute("data-appearance", value);
      (el as HTMLElement).style.colorScheme = value;
    }, appearance);
    for (const width of [1440, 760, 420]) {
      await page.setViewportSize({ width, height: 900 });
      const box = await entry.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
      expect(box!.height).toBeLessThan(65);
      await entry.screenshot({
        path: info.outputPath(`collapsed-${appearance}-${width}.png`),
      });
    }
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await entry
      .locator(".composer-entry-pulse i")
      .first()
      .evaluate((el) => getComputedStyle(el).animationName),
  ).toBe("none");
  runtime.activity!.threads = [
    {
      ...runtime.activity!.threads[0]!,
      phase: "waiting",
      waitKinds: ["user_input"],
    },
  ];
  await f.refresh();
  await expect(entry).toContainText("等待你回复");
  await expect(entry).not.toHaveAttribute("data-animated", "true");
  runtime.activity!.threads = [];
  runtime.messages = [
    {
      id: "recovery-current",
      ...f.scope,
      inputId: "collapsed-current",
      rootId: "root-current",
      artifactId: null,
      kind: "progress",
      createdAt: stamp,
      text: "private recovery diagnostic",
      providerRecovery: {
        phase: "waiting",
        reason: "credentials",
        startedAt: stamp,
      },
    },
  ];
  await f.refresh();
  await expect(entry).toContainText("模型认证失败，等待修复");
  await expect(entry).not.toContainText("private recovery diagnostic");
  await expect(entry).not.toHaveAttribute("data-animated", "true");
  runtime.attention!.approvals = [
    {
      scope: { ...f.scope, artifactId: null, inputId: "collapsed-current" },
      approval: {
        requested_at: stamp,
        fingerprint: "f".repeat(64),
        request: {
          approval_id: "approval-current",
          session_id: "session-current",
          context_id: "context-current",
          justification: "TEST 需要确认",
          action: {},
          requested: {},
        },
      },
    },
  ];
  await f.refresh();
  await expect(entry).toContainText("等待你批准");
  runtime.connected = false;
  await f.refresh();
  await expect(entry).toHaveAttribute("data-state", "offline");
  runtime.connected = true;
  runtime.attention!.approvals = [];
  runtime.deliveries[0]!.state = "completed";
  runtime.messages = [
    {
      id: "reply-current",
      ...f.scope,
      inputId: "collapsed-current",
      rootId: "root-current",
      artifactId: null,
      kind: "reply",
      createdAt: stamp,
      text: "检查已完成，结果已保存。",
    },
  ];
  await f.refresh();
  await expect(entry).toHaveAttribute("data-state", "unread");
  await expect(entry).toContainText("有新回复");
  await expect(entry).toContainText("检查已完成，结果已保存。");
  await expect(input).toHaveCount(0);
  await entry.click();
  await expect(input).toHaveValue("TEST 原草稿仍在，不要发送");
  await expect(input).toBeFocused();
  expect(writes).toBe(0);
});
