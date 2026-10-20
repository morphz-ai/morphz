import { expect } from "@playwright/test";
import {
  openInput,
  openExecutionPanel,
  openExchangeReading,
} from "./interaction-helpers.js";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import type { ConversationRuntime } from "../packages/core/src/conversation.js";
import type { PlatformHistory } from "../apps/web/src/platform-client.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";

test("并发交付按时间追加，运行入口打开精确线程详情，调宽不改会话且导航清除选择", async ({
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
      if (a && (!finished || backgroundRunning))
        runtime.activity = {
          available: true,
          truncated: false,
          threads: [
            {
              id: backgroundRunning ? "background-thread" : "primary-thread",
              kind: "execution",
              inputId: input.id,
              rootId: "root-a",
              sessionId: "session-a",
              projectId: input.projectId,
              conversationId: input.conversationId,
              title: backgroundRunning ? "核对剩余材料" : inputA,
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
  const queries: URLSearchParams[] = [];
  await page.route("**/api/executions?*", (route) => {
    queries.push(new URL(route.request().url()).searchParams);
    return route.fulfill({ json: { jobs: [], approvals: [], limit: 100 } });
  });
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
  await page
    .locator('.execution-activity-row[data-thread-id="primary-thread"]')
    .click();
  const panel = page.getByRole("complementary", {
    name: "Morphz 信息",
    exact: true,
  });
  await expect(panel.locator(".execution-origin-title")).toHaveText(inputA);
  await expect(
    panel.getByRole("button", { name: "停止", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("AI 输入内容")).toHaveValue("");
  await expect
    .poll(() => queries.at(-1)?.get("threadId"))
    .toBe("primary-thread");
  expect(queries.at(-1)?.get("inputId")).toBe(inputs[0]!.id);
  expect(queries.at(-1)?.get("conversationId")).toBe(
    fixture.scope.conversationId,
  );
  await expect(
    panel.getByRole("button", { name: "固定执行面板", exact: true }),
  ).toHaveCount(0);
  const resize = panel.getByRole("separator");
  await resize.focus();
  await resize.press("ArrowLeft");
  await expect(resize).toHaveAttribute("aria-valuenow", "356");
  finished = true;
  backgroundRunning = true;
  await fixture.refresh();
  await expect(page.getByText("材料已创建完成", { exact: true })).toBeVisible();
  await expect(marker).toHaveCount(0);
  await panel
    .getByRole("button", { name: "返回活动列表", exact: true })
    .click();
  await panel.locator('[data-thread-id="background-thread"]').click();
  await expect
    .poll(() => queries.at(-1)?.get("threadId"))
    .toBe("background-thread");
  const controls: unknown[] = [];
  await page.route("**/api/executions/control", (route) => {
    controls.push(route.request().postDataJSON());
    return route.fulfill({ json: { accepted: true, status: "cancelled" } });
  });
  await panel.getByRole("button", { name: "停止", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "停止", exact: true }),
  ).toBeDisabled();
  await expect(panel.getByRole("status")).toHaveText("停止请求已发送");
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
  // A missing snapshot is not evidence of completion. Retain the exact
  // inspected branch, but remove control and mark its current state unknown.
  await expect(panel.locator(".execution-origin-status")).toHaveText(
    "状态待核对",
  );
  await expect(
    panel.getByRole("button", { name: "停止", exact: true }),
  ).toHaveCount(0);
  await panel
    .getByRole("button", { name: "返回活动列表", exact: true })
    .click();
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
  await expect(
    panel.getByRole("button", { name: "返回活动列表", exact: true }),
  ).toHaveCount(0);
  await openExchangeReading(page);
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
