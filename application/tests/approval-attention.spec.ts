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
  const reply = {
    ...parent,
    id: "TEST-reply",
    inputId: "reply-input",
    rootId: "reply-root",
    title: "TEST 确认示例格式",
    controlState: "active",
    waitKinds: ["user_input"],
    continuation: {
      mode: "supplement" as const,
      inputId: "reply-input",
      threadId: "TEST-reply",
      generation: 2,
    },
    userInputRequest: {
      request_id: "TEST-exact-question",
      thread_id: "TEST-reply",
      thread_generation: 2,
      session_id: parent.sessionId,
      context_id: parent.contextId,
      requested_at: stamp,
      questions: [
        {
          id: "format",
          question: "TEST：使用哪种示例格式？",
          multi_select: false,
          options: [],
        },
      ],
    },
  };
  const background = {
    ...parent,
    id: "TEST-background",
    inputId: "background-input",
    rootId: "background-root",
    title: "TEST 等待后台转换",
    summary: "已完成文件准备",
    waitKinds: ["tool_task"],
  };
  runtime.activity!.threads.push(parent, child, reply, background);
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
  const approval = runtime.attention!.approvals[0]!;
  const unrelated = structuredClone(approval);
  unrelated.scope.threadId = "different-thread";
  unrelated.approval.fingerprint = "TEST-other-fingerprint";
  unrelated.approval.request.approval_id = "TEST-other-approval";
  unrelated.approval.request.thread_id = "different-thread";
  unrelated.approval.request.justification = "TEST 另一个审批";
  runtime.attention!.approvals.unshift(unrelated);
  const questionReads: unknown[] = [];
  await page.route("**/api/user-input/read", (route) => {
    questionReads.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        title: reply.title,
        request: reply.userInputRequest,
        continuation: reply.continuation,
        source: {
          ...f.scope,
          inputId: reply.inputId,
          targetActantId: "morphz-agent",
          artifactId: null,
          artifactRevision: null,
        },
      },
    });
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
        approvals: [],
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
  await expect(permission.locator(".subject-approval-count")).toHaveText("2");
  await expect(permission).toHaveAttribute(
    "aria-description",
    "2 项等待你的批准",
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
  const replyRow = panel.locator(`[data-thread-id="${reply.id}"]`);
  const backgroundRow = panel.locator(`[data-thread-id="${background.id}"]`);
  await expect(replyRow.locator(".execution-activity-icon")).toHaveAttribute(
    "data-status",
    "input",
  );
  await expect(replyRow).toContainText("等待你回复");
  await expect(
    backgroundRow.locator(".execution-activity-icon"),
  ).toHaveAttribute("data-status", "waiting");
  await expect(backgroundRow.locator(".execution-activity-summary")).toHaveText(
    "等待工具结果",
  );
  await expect(
    panel.getByRole("button", { name: "补充", exact: true }),
  ).toHaveCount(1);
  expect(questionReads).toEqual([]);
  await replyRow.click();
  const question = page.getByRole("region", { name: "补充问题" });
  await expect(
    question.getByText("TEST：使用哪种示例格式？", { exact: true }),
  ).toBeVisible();
  await expect(panel.locator(".execution-origin-title")).toHaveText(
    reply.title,
  );
  await expect(panel.locator(".execution-origin-status")).toHaveText(
    "等待你回复",
  );
  await expect(
    panel.locator(".execution-origin .execution-activity-summary"),
  ).toHaveCount(0);
  expect(questionReads).toEqual([
    {
      ...f.scope,
      requestId: reply.userInputRequest.request_id,
      continuation: reply.continuation,
    },
  ]);
  await question.getByRole("button", { name: "关闭，稍后回复" }).click();
  await panel.getByRole("button", { name: "返回活动列表" }).click();
  await backgroundRow.click();
  await expect(panel.locator(".execution-origin-title")).toHaveText(
    background.title,
  );
  await expect(panel.locator(".execution-origin-status")).toHaveText(
    "等待工具结果",
  );
  await expect(
    panel.locator(".execution-origin .execution-activity-summary"),
  ).toHaveText(background.summary);
  await panel.getByRole("button", { name: "返回活动列表" }).click();
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await settleTransitions(page);
    await page.screenshot({
      path: info.outputPath(`approval-overview-${theme}.png`),
    });
  }
  await row.click();
  await expect(permission).toHaveAttribute("aria-selected", "true");
  await expect(
    panel.locator('[data-approval-id="TEST-pending-approval"]'),
  ).toBeFocused();
  await expect(panel.getByText("没有待审批请求", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    panel.getByText("TEST 只验证待审批请求的可见性，不执行任何操作。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    panel
      .locator('[data-approval-id="TEST-pending-approval"]')
      .getByRole("button", { name: "仅允许这一次", exact: true }),
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
    panel
      .locator('[data-approval-id="TEST-pending-approval"]')
      .getByRole("button", { name: "仅允许这一次", exact: true }),
  ).toBeDisabled();
  await expect(
    panel.getByText("TEST 只验证待审批请求的可见性，不执行任何操作。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(await openInput(page)).toHaveValue(draft);
  expect(mutations).toEqual([]);
});
