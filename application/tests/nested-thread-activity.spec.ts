import { expect } from "@playwright/test";
import {
  disconnectedRuntime,
  type ExecutionActivity,
} from "../packages/core/src/conversation.js";
import type {
  ExecutionSnapshot,
  ExecutionControl,
} from "../packages/core/src/execution.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";
import { openExecutionPanel } from "./interaction-helpers.js";

test("embedded 逻辑 family 没有 Jobs 或审批时仍展示真实截断提示，完整回读后移除", async ({
  page,
}, info) => {
  const threads: ExecutionActivity["threads"] = [];
  let truncated = true;
  const fixture = await mockPlatformConversation(page, () => ({
    inputs: [],
    runtime: {
      ...disconnectedRuntime,
      configured: true,
      connected: true,
      activity: { available: true, truncated, threads },
      attention: { available: true, approvals: [] },
    },
  }));
  for (const [id, parentThreadId, lifecycle] of [
    ["TEST-logical-main", null, "completed"],
    ["TEST-logical-child", "TEST-logical-main", "open"],
  ] as const)
    threads.push({
      ...fixture.scope,
      id,
      parentThreadId,
      lifecycle,
      phase: "waiting",
      kind: "execution",
      inputId: null,
      rootId: id + "-root",
      sessionId: "TEST-session",
      contextId: "TEST-context",
      title: id,
      revision: 1,
      updatedAt: "2026-10-03T00:00:00Z",
    });
  await page.route("**/api/executions?*", (route) =>
    route.fulfill({
      json: {
        jobs: [],
        approvals: [],
        limit: 100,
        threadsTruncated: truncated,
        threads: threads.map((thread) => ({
          id: thread.id,
          parentThreadId: thread.parentThreadId ?? null,
          sessionId: thread.sessionId,
          contextId: thread.contextId!,
          rootId: thread.rootId,
          title: thread.title,
          lifecycle: thread.lifecycle,
          phase: thread.phase,
          revision: thread.revision,
          updatedAt: thread.updatedAt,
        })),
      },
    }),
  );
  await page.goto("/");
  await openExecutionPanel(page);
  const panel = page.getByRole("complementary", {
    name: "Morphz 信息",
    exact: true,
  });
  await panel.locator('[data-thread-id="TEST-logical-main"]').click();
  await expect(panel.locator(".execution-thread-group")).toHaveCount(2);
  await expect(panel.locator(".execution-job")).toHaveCount(0);
  await expect(panel.locator(".approval-card")).toHaveCount(0);
  const hint = panel.locator(
    ".execution-dialog-toolbar .execution-history-bound",
  );
  await expect(hint).toHaveText("部分子任务记录尚未载入");
  await expect(hint).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "刷新执行记录", exact: true }),
  ).toBeVisible();
  await panel.screenshot({
    path: info.outputPath("logical-family-no-jobs-truncated.png"),
  });
  truncated = false;
  threads[0]!.revision++;
  await fixture.refresh();
  await expect(hint).toHaveCount(0);
  await expect(panel.locator(".execution-dialog-toolbar")).toHaveCount(0);
  await expect(panel.locator(".execution-thread-group")).toHaveCount(2);
});

// Synthetic transport verifies production mounted UI only. The corresponding
// node test separately runs real Rust schedule_tx, distinct roots and Host Jobs.
test("一项活动包含真实父子层级，各自步骤结果状态独立，子停止精确指定且事件更新无需轮询", async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const threads: ExecutionActivity["threads"] = [];
  const fixture = await mockPlatformConversation(page, () => ({
    inputs: [],
    runtime: {
      ...disconnectedRuntime,
      configured: true,
      connected: true,
      activity: { available: true, truncated: false, threads },
      attention: { available: true, approvals: [] },
    },
  }));
  const stamp = "2026-10-03T00:00:00Z";
  for (const [id, parentId, title, lifecycle, phase] of [
    ["TEST-main", null, "TEST 导出小说并生成封面", "completed", "idle"],
    ["TEST-one", "TEST-main", "TEST 整理正文", "completed", "idle"],
    ["TEST-grand", "TEST-one", "TEST 核对章节", "completed", "idle"],
    ["TEST-two", "TEST-main", "TEST 生成封面", "open", "running"],
  ] as const)
    threads.push({
      ...fixture.scope,
      id,
      parentThreadId: parentId,
      title,
      lifecycle,
      phase,
      kind: "execution",
      inputId: null,
      sessionId: "TEST-session",
      contextId: "TEST-context",
      rootId: id + "-root",
      revision: 7,
      updatedAt: stamp,
      summary:
        lifecycle === "completed" ? title + "已完成" : title + "正在执行",
    });
  const jobs: ExecutionSnapshot["jobs"] = threads.map((thread, index) => ({
    id: thread.id + "-job",
    revision: 3,
    session_id: thread.sessionId,
    context_id: "TEST-context",
    thread_id: thread.id,
    tool_name: "read",
    target_id: "local",
    status: thread.lifecycle === "open" ? "running" : "succeeded",
    created_at: `2026-10-03T00:00:0${index}Z`,
    updated_at: stamp,
    request: { path: thread.id + ".md" },
    result_event_id: thread.id + "-receipt",
    cancel_requested_at: null,
    error: null,
    exit_code: null,
    annotation: {
      intent: thread.title + "：读取文件",
      result: thread.title + "：已读文件",
    },
  }));
  let snapshotReads = 0;
  const snapshot = () => ({
    jobs,
    approvals: [],
    limit: 100,
    threadsTruncated: false,
    threads: threads.map((thread) => ({
      id: thread.id,
      parentThreadId: thread.parentThreadId ?? null,
      sessionId: thread.sessionId,
      contextId: thread.contextId!,
      rootId: thread.rootId,
      title: thread.title,
      summary: thread.summary,
      lifecycle: thread.lifecycle,
      phase: thread.phase,
      revision: thread.revision,
      updatedAt: thread.updatedAt,
    })),
  });
  await page.route("**/api/executions?*", (route) => {
    snapshotReads++;
    return route.fulfill({ json: snapshot() });
  });
  const controls: ExecutionControl[] = [];
  await page.route("**/api/executions/control", (route) => {
    controls.push(route.request().postDataJSON());
    return route.fulfill({ json: snapshot() });
  });
  await page.goto("/");
  await openExecutionPanel(page);
  const panel = page.getByRole("complementary", {
    name: "Morphz 信息",
    exact: true,
  });
  await expect(panel.locator(".execution-activity-row")).toHaveCount(1);
  const row = panel.locator('[data-thread-id="TEST-main"]');
  await expect(row).toContainText("3 个子任务");
  await expect(row.locator(".execution-activity-icon")).toHaveAttribute(
    "data-status",
    "running",
  );
  await row.click();
  await expect(panel.locator(".execution-origin small")).toHaveText(
    "子任务执行中",
  );
  const groups = panel.locator(".execution-thread-group");
  await expect(groups).toHaveCount(4);
  expect(
    await groups.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-execution-thread")),
    ),
  ).toEqual(["TEST-main", "TEST-one", "TEST-grand", "TEST-two"]);
  await expect(groups.nth(2)).toHaveAttribute("data-thread-depth", "2");
  for (const thread of threads) {
    const group = panel.locator(`[data-execution-thread="${thread.id}"]`);
    await expect(group.locator(".execution-job")).toHaveCount(1);
    await expect(group.getByLabel("返回结果解读")).toHaveText(
      thread.title + "：已读文件",
    );
    await expect(group.locator(".execution-thread-state")).toHaveAttribute(
      "data-status",
      thread.lifecycle === "open" ? "running" : "ended",
    );
  }
  const child = panel.locator('[data-execution-thread="TEST-two"]');
  await expect(child.locator(".execution-signal-flow")).toHaveCSS(
    "animation-name",
    "execution-signal-travel",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(child.locator(".execution-signal-flow")).toHaveCSS(
    "animation-name",
    "none",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await child
    .getByRole("button", { name: "停止此子任务", exact: true })
    .click();
  expect(controls).toHaveLength(1);
  expect(controls[0]!.scope.threadId).toBe("TEST-two");
  expect(controls[0]!.action).toEqual({
    type: "cancel-thread",
    threadId: "TEST-two",
    revision: 7,
  });
  await panel.screenshot({
    path: info.outputPath("nested-thread-timelines.png"),
  });
  // An actual workspace invalidation updates this observed read immediately.
  threads[3]!.lifecycle = "failed";
  threads[3]!.revision++;
  jobs[3]!.status = "failed";
  jobs[3]!.error = "TEST 无可用生成节点";
  const before = snapshotReads;
  await fixture.refresh();
  await expect(child.locator(".execution-thread-state")).toHaveAttribute(
    "data-status",
    "failed",
  );
  await expect(panel.locator(".execution-origin small")).toHaveText(
    "子任务执行失败",
  );
  await expect(child.locator(".delivery-error")).toHaveText(
    "TEST 无可用生成节点",
  );
  expect(snapshotReads).toBeGreaterThan(before);
  await expect(
    child.getByRole("button", { name: "停止此子任务", exact: true }),
  ).toHaveCount(0);
  for (const width of [1040, 760]) {
    await page.setViewportSize({ width, height: 960 });
    expect(
      await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  expect(
    await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
  ).toBe(true);
  await panel.screenshot({
    path: info.outputPath("nested-thread-200-percent.png"),
  });
});
