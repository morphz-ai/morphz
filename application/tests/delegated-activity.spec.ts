import { expect } from "@playwright/test";
import {
  test,
  mockPlatformConversation,
} from "./platform-conversation-fixture.js";
import { openExecutionPanel, openInput } from "./interaction-helpers.js";
import {
  disconnectedRuntime,
  type ExecutionActivity,
} from "../packages/core/src/conversation.js";
import type { PlatformHistory } from "../apps/web/src/platform-client.js";

test("委派期间原消息保持运行反馈、主活动显示子任务且可只读查看准确命令；结束和失联不残留运行态", async ({
  page,
}, info) => {
  const inputs: PlatformHistory["inputs"] = [];
  const threads: ExecutionActivity["threads"] = [];
  let connected = true;
  const fixture = await mockPlatformConversation(page, () => ({
    inputs,
    runtime: {
      ...disconnectedRuntime,
      configured: true,
      connected,
      deliveries: inputs.map((input) => ({
        inputId: input.id,
        state: "running",
        error: null,
        retryable: false,
      })),
      activity: {
        available: connected,
        truncated: false,
        delegationsAvailable: true,
        delegationsTruncated: true,
        threads,
      },
    },
  }));
  inputs.push(
    fixture.input(
      "TEST-delegate-input",
      "TEST 使用子任务核对开发服务器，不修改原件。",
      "2026-10-23T00:00:00Z",
    ),
  );
  const parent: ExecutionActivity["threads"][number] = {
    ...fixture.scope,
    inputId: inputs[0]!.id,
    id: "TEST-parent",
    kind: "execution",
    rootId: "TEST-parent-root",
    sessionId: "TEST-parent-session",
    contextId: "TEST-parent-context",
    title: "TEST 核对开发服务器",
    phase: "waiting",
    waitKinds: ["delegation"],
    lifecycle: "open",
    revision: 1,
    updatedAt: inputs[0]!.createdAt,
  };
  const child: ExecutionActivity["threads"][number] = {
    ...parent,
    id: "TEST-child",
    rootId: "TEST-child-root",
    sessionId: "TEST-child-session",
    contextId: "TEST-child-context",
    title: "TEST 子任务执行构建检查",
    phase: "running",
    waitKinds: [],
    delegation: {
      id: "TEST-delegation",
      requestEventId: "TEST-request",
      parentThreadId: parent.id,
      parentSessionId: parent.sessionId,
      parentContextId: parent.contextId!,
    },
  };
  threads.push(parent, child);
  let childReads = 0;
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/executions") && request.method() !== "GET")
      writes.push(request.url());
  });
  await page.route("**/api/executions?*", (route) => {
    const query = new URL(route.request().url()).searchParams;
    const selected = query.get("threadId") === child.id ? child : parent;
    if (selected === child) {
      childReads++;
      expect(JSON.parse(query.get("runtime")!)).toEqual({
        sessionId: child.sessionId,
        contextId: child.contextId,
        delegation: child.delegation,
      });
      expect(query.has("projectId")).toBe(false);
      expect(query.has("inputId")).toBe(false);
    }
    return route.fulfill({
      json: {
        limit: 100,
        approvals: [],
        threads: [{ ...selected, parentThreadId: null }],
        jobs:
          selected === child
            ? [
                {
                  id: "TEST-child-job",
                  revision: 1,
                  session_id: child.sessionId,
                  context_id: child.contextId,
                  thread_id: child.id,
                  tool_name: "exec",
                  target_id: "local",
                  status: "running",
                  created_at: child.updatedAt,
                  updated_at: child.updatedAt,
                  request: { command: "npm run build" },
                },
              ]
            : [],
      },
    });
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await openInput(page);
  const card = page.locator(
    '.human-message[data-input-id="TEST-delegate-input"]',
  );
  await expect(card).toHaveAttribute("data-background-execution", "true");
  await expect(
    page.getByText("正在执行子任务…", { exact: true }),
  ).toBeVisible();
  await openExecutionPanel(page);
  const panel = page.getByRole("complementary", {
    name: "Morphz 信息",
    exact: true,
  });
  await expect(panel.locator(".execution-activity-row")).toHaveCount(1);
  await expect(panel.locator(".execution-activity-row")).toContainText(
    "1 个子任务",
  );
  await expect(
    panel.getByText("当前仅显示已核验的部分子任务。", { exact: true }),
  ).toHaveCount(0);
  await panel.locator(`[data-thread-id="${parent.id}"]`).click();
  const children = panel.getByRole("region", { name: "委派子任务" });
  // A section without a heading remains a named region through aria-label.
  await expect(children).toContainText(child.title);
  await expect(
    panel.getByText("当前仅显示已核验的部分子任务。", { exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("delegated-parent-running.png"),
  });
  await children.locator(`[data-thread-id="${child.id}"]`).click();
  await expect(panel).toContainText("npm run build");
  expect(childReads).toBeGreaterThan(0);
  // Delegation cancellation is now explicit and separately confirmed; Job,
  // approval, supplement and ordinary Thread controls stay unavailable here.
  await expect(
    panel.getByRole("button", { name: "停止子智能体", exact: true }),
  ).toHaveCount(1);
  await expect(
    panel.getByRole("button", {
      name: /补充|批准|拒绝|暂停此执行|继续此执行|更多执行操作|停止此执行/,
    }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 760, height: 600 });
  await page.screenshot({
    path: info.outputPath("delegated-child-narrow.png"),
  });
  connected = false;
  await fixture.refresh();
  await expect(card).not.toHaveAttribute("data-background-execution", "true");
  await expect(
    page.getByText("连接中断，等待恢复", { exact: true }),
  ).toBeVisible();
  connected = true;
  child.lifecycle = "completed";
  child.phase = "idle";
  parent.lifecycle = "completed";
  parent.phase = "idle";
  await fixture.refresh();
  await expect(card).not.toHaveAttribute("data-background-execution", "true");
  await expect(panel).toContainText("已结束");
  child.lifecycle = "failed";
  await fixture.refresh();
  await expect(panel).toContainText("执行失败");
  await page.screenshot({
    path: info.outputPath("delegated-child-failed.png"),
  });
  expect(writes).toEqual([]);
});
