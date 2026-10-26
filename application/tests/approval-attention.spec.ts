import { expect } from "@playwright/test";
import {
  disconnectedRuntime,
  type ConversationRuntime,
} from "../packages/core/src/conversation.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";
import {
  openExecutionPanel,
  openInput,
  settleTransitions,
} from "./interaction-helpers.js";

test("审批在外层和授权页可见，旧消息不必在当前页；状态读取失败保留原请求且禁止提交", async ({
  page,
}, info) => {
  const stamp = "2026-10-25T06:04:21Z";
  const runtime: ConversationRuntime = {
    ...disconnectedRuntime,
    configured: true,
    connected: true,
    activity: { available: true, truncated: false, threads: [] },
    attention: { available: true, approvals: [] },
  };
  const f = await mockPlatformConversation(page, () => ({
    inputs: [],
    runtime,
  }));
  const parent = {
    ...f.scope,
    id: "TEST-approval-parent",
    kind: "execution",
    inputId: "old-input",
    rootId: "original-root",
    sessionId: "TEST-session",
    contextId: "TEST-context",
    title: "TEST 原有邮箱监听任务",
    phase: "waiting",
    waitKinds: ["thread"],
    lifecycle: "open",
    revision: 1,
    updatedAt: stamp,
  };
  const child = {
    ...parent,
    id: "TEST-approval-child",
    parentThreadId: parent.id,
    rootId: "scheduled-root",
    title: "TEST 恢复监听",
    phase: "runnable",
    waitKinds: [],
  };
  runtime.activity!.threads.push(parent, child);
  runtime.activity!.objectives = [
    {
      ...f.scope,
      id: "TEST-original-goal",
      inputId: parent.inputId,
      rootId: parent.rootId,
      sessionId: parent.sessionId,
      contextId: parent.contextId,
      title: "TEST 持续监听原目标",
      status: "active",
      readiness: "waiting",
      revision: 1,
      generation: 1,
      controlAllowed: false,
      statusReason: null,
      parentId: null,
      threadIds: [parent.id],
      waitKinds: ["thread"],
      updatedAt: stamp,
    },
  ];
  runtime.attention!.approvals.push({
    scope: {
      ...f.scope,
      artifactId: null,
      inputId: "old-input",
      threadId: child.id,
    },
    approval: {
      fingerprint: "TEST-fingerprint",
      requested_at: stamp,
      request: {
        approval_id: "TEST-pending-approval",
        session_id: child.sessionId,
        context_id: child.contextId,
        thread_id: child.id,
        root_turn_id: child.rootId,
        justification: "TEST 只验证待审批请求的可见性，不执行任何操作。",
        action: { command: "TEST synthetic command" },
        requested: { filesystem_write: ["/TEST"] },
      },
    },
  });
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) &&
      /execution.*control|approvals/.test(request.url())
    )
      mutations.push(request.url());
  });
  await page.route("**/api/executions?*", (route) =>
    route.fulfill({
      json: {
        jobs: [],
        approvals: [runtime.attention!.approvals[0]!.approval],
        limit: 100,
      },
    }),
  );
  await page.goto("/");
  const draft = "TEST 保留的未发送草稿";
  await (await openInput(page)).fill(draft);
  await openExecutionPanel(page);
  const panel = page.getByRole("complementary", {
    name: "Morphz 信息",
    exact: true,
  });
  const permission = panel.getByRole("tab", { name: "授权", exact: true });
  await expect(panel.locator(".execution-attention")).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "仅允许这一次", exact: true }),
  ).toHaveCount(0);
  await expect(permission.locator(".subject-approval-count")).toHaveText("1");
  await expect(permission).toHaveAttribute(
    "aria-description",
    "1 项等待你的批准",
  );
  const row = panel.locator(`[data-thread-id="${parent.id}"]`);
  await expect(row.locator(".execution-activity-summary")).toHaveText(
    "子任务等待你的批准",
  );
  await expect(row.locator(".execution-activity-icon")).toHaveAttribute(
    "data-status",
    "approval",
  );
  await expect(
    panel.locator(
      '[data-objective-id="TEST-original-goal"] .subject-objective-heading',
    ),
  ).toContainText("等待你的批准");
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await settleTransitions(page);
    await page.screenshot({
      path: info.outputPath(`approval-overview-${theme}.png`),
    });
  }
  await permission.click();
  await expect(panel.getByText("没有待审批请求", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    panel.getByText("TEST 只验证待审批请求的可见性，不执行任何操作。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "仅允许这一次", exact: true }),
  ).toBeEnabled();
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await settleTransitions(page);
    await page.screenshot({
      path: info.outputPath(`approval-attention-${theme}.png`),
    });
    const badge = await permission
      .locator(".subject-approval-count")
      .boundingBox();
    const tab = (await permission.boundingBox())!;
    expect(badge!.x).toBeGreaterThanOrEqual(tab.x);
    expect(badge!.x + badge!.width).toBeLessThanOrEqual(tab.x + tab.width);
  }
  runtime.attention!.available = false;
  await f.refresh();
  await expect(
    panel.getByText("审批状态待核对", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "仅允许这一次", exact: true }),
  ).toBeDisabled();
  await expect(
    panel.getByText("TEST 只验证待审批请求的可见性，不执行任何操作。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(await openInput(page)).toHaveValue(draft);
  expect(mutations).toEqual([]);
});
