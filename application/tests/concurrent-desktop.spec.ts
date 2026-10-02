import { expect } from "@playwright/test";
import { openInput, openExecutionPanel } from "./interaction-helpers.js";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import type { ConversationRuntime } from "../packages/core/src/conversation.js";
import type { PlatformHistory } from "../apps/web/src/platform-client.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";

test("并发交付按时间追加，运行入口打开精确详情，固定与调宽不改变会话", async ({
  page,
}) => {
  let finished = false;
  let backgroundRunning = false;
  const inputA = "请整理签约材料-并发验收",
    inputB = "现在在做什么-并发验收";
  const inputs: PlatformHistory["inputs"] = [];
  const fixture = await mockPlatformConversation(page, () => {
    const runtime: ConversationRuntime = {
      ...structuredClone(disconnectedRuntime),
      configured: true,
      connected: true,
      model: "test",
    };
    for (const input of inputs) {
      const a = input.body === inputA;
      runtime.deliveries.push({
        inputId: input.id,
        state: a && !finished ? "running" : "completed",
        error: null,
        cancellable: a && !finished,
        retryable: false,
      });
      if (!a || finished)
        runtime.messages.push({
          id: input.id + "-reply",
          inputId: input.id,
          projectId: input.projectId,
          conversationId: input.conversationId,
          artifactId: null,
          kind: "reply",
          text: a ? "材料已创建完成" : "材料还在整理中",
          createdAt: a
            ? "2099-01-01T10:00:02.000Z"
            : "2099-01-01T10:00:01.000Z",
        });
      if (a && backgroundRunning)
        runtime.activity = {
          available: true,
          truncated: false,
          threads: [
            {
              id: "background-thread",
              kind: "execution",
              inputId: input.id,
              rootId: "root-a",
              sessionId: "session-a",
              projectId: input.projectId,
              conversationId: input.conversationId,
              title: "核对剩余材料",
              phase: "running",
              lifecycle: "open",
              revision: 7,
              updatedAt: input.createdAt,
            },
          ],
        };
    }
    return { inputs, runtime };
  });
  // Submit through the real composer and current request contract. Only
  // Runtime receipt/history presentation is synthetic, not model execution.
  await page.route("**/api/platform/messages", async (route) => {
    const command = route.request().postDataJSON();
    expect([inputA, inputB]).toContain(command.operation.body);
    // Ordinary dialogue keeps the personal Session, while unassigned input
    // and any resulting content belong to the user's desk.
    expect(command.operation.projectId).toBe(fixture.spaces.deskId);
    expect(command.operation.conversationId).toBe(fixture.scope.conversationId);
    if (!inputs.some((input) => input.id === command.commandId))
      inputs.push({
        ...fixture.input(
          command.commandId,
          command.operation.body,
          new Date().toISOString(),
        ),
        projectId: command.operation.projectId,
      });
    await route.fulfill({
      status: 202,
      json: { commandId: command.commandId, entityId: command.commandId },
    });
  });
  await page.route("**/api/executions?*", (route) =>
    route.fulfill({ json: { jobs: [], approvals: [], limit: 100 } }),
  );
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const box = await openInput(page);
  await box.fill(inputA);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.locator(".human-message")).toHaveCount(1);
  await box.fill(inputB);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByText("材料还在整理中", { exact: true })).toBeVisible();
  const marker = page.getByRole("button", {
    name: "后台执行中",
    exact: true,
  });
  await expect(marker).toHaveCount(0);
  await openExecutionPanel(page);
  await page.locator(".execution-work-row").filter({ hasText: inputA }).click();
  const panel = page.getByRole("complementary", { name: "执行面板" });
  await expect(panel.getByText(inputA, { exact: true })).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "停止这次处理", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("AI 输入内容")).toHaveValue("");
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/executions?")) requests.push(r.url());
  });
  await expect
    .poll(() => requests.some((u) => new URL(u).searchParams.has("inputId")))
    .toBe(true);
  await panel
    .getByRole("button", { name: "固定执行面板", exact: true })
    .click();
  const resize = panel.getByRole("separator");
  await resize.focus();
  await resize.press("ArrowLeft");
  await expect(resize).toHaveAttribute("aria-valuenow", "356");
  finished = true;
  backgroundRunning = true;
  await fixture.refresh();
  await expect(page.getByText("材料已创建完成", { exact: true })).toBeVisible();
  await expect(marker).toBeVisible();
  await panel.getByRole("button", { name: /核对剩余材料/ }).click();
  const controls: unknown[] = [];
  await page.route("**/api/executions/control", (route) => {
    controls.push(route.request().postDataJSON());
    return route.fulfill({ json: { accepted: true, status: "cancelled" } });
  });
  await panel.getByRole("button", { name: "停止此分支", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "停止请求已发送" }),
  ).toBeDisabled();
  expect(controls[0]).toMatchObject({
    scope: { threadId: "background-thread" },
    action: {
      type: "cancel-thread",
      threadId: "background-thread",
      revision: 7,
    },
  });
  backgroundRunning = false;
  await fixture.refresh();
  await expect(
    panel.getByText("此分支已不在进行中", { exact: true }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "返回执行概览" }).click();
  const texts = await page
    .locator(".conversation-message > p, .conversation-message .reply-content")
    .allTextContents();
  expect(texts.findIndex((x) => x.includes("材料还在整理中"))).toBeLessThan(
    texts.findIndex((x) => x.includes("材料已创建完成")),
  );
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: /^事项/ })
    .click();
  await expect(panel).toBeVisible();
  await openInput(page);
  await expect(page.getByText("材料已创建完成", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "test-results/concurrent-execution-light.png",
  });
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: "test-results/concurrent-execution-dark.png" });
  await page.setViewportSize({ width: 760, height: 540 });
  await expect(panel).toHaveAttribute("data-inspector-mode", "overlay");
  await expect(page.getByRole("button", { name: "隐藏右侧栏" })).toBeVisible();
  // DOMRect can report 340.00003 CSS px after the panel transition.
  await expect
    .poll(async () => (await panel.boundingBox())!.width)
    .toBeCloseTo(340, 2);
  await page.screenshot({
    path: "test-results/concurrent-execution-narrow.png",
  });
  await page.getByRole("button", { name: "隐藏右侧栏" }).click();
  await expect(panel).toHaveCount(0);
});
