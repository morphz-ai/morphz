import { expect } from "@playwright/test";
import {
  disconnectedRuntime,
  type ExecutionActivity,
} from "../packages/core/src/conversation.js";
import type { ExecutionSnapshot } from "../packages/core/src/execution.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";
import { openExecutionPanel } from "./interaction-helpers.js";

const stamp = "2026-10-02T12:00:00.000Z";
type Job = ExecutionSnapshot["jobs"][number];

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

test("活动结束保留对勾但不隐藏失败，步骤按真实时间正序且失败回执仍可见", async ({
  page,
}, info) => {
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
  for (const [id, lifecycle] of [
    ["TEST-ended", "completed"],
    ["TEST-failed", "failed"],
    ["TEST-cancelled", "cancelled"],
  ])
    threads.push({
      ...fixture.scope,
      id: id!,
      kind: "execution",
      inputId: null,
      rootId: "TEST-root",
      sessionId: "TEST-session",
      title: `TEST ${id} 环境检查`,
      summary:
        lifecycle === "completed" ? "一项工具失败，活动已结束" : undefined,
      phase: "idle",
      lifecycle: lifecycle!,
      revision: 4,
      updatedAt: stamp,
    });
  const fields: Job = {
    id: "unused",
    revision: 2,
    session_id: "TEST-session",
    context_id: "TEST-context",
    thread_id: "TEST-ended",
    tool_name: "read",
    target_id: "local",
    status: "succeeded",
    request: { path: "TEST-readme.md" },
    result_event_id: "TEST-receipt",
    created_at: stamp,
    updated_at: stamp,
    cancel_requested_at: null,
    error: null,
    exit_code: null,
  };
  const jobs: Job[] = [
    {
      ...fields,
      id: "TEST-last-failed",
      created_at: "2026-10-02T20:00:03+08:00",
      status: "failed",
      error: "连接超时",
      annotation: { intent: "检查依赖来源", result: "真实调用返回连接超时" },
    },
    {
      ...fields,
      id: "TEST-a-nanos-second",
      created_at: "2026-10-02T12:00:02.123456002Z",
      annotation: { intent: "确认处理器架构" },
    },
    {
      ...fields,
      id: "TEST-z-nanos-first",
      created_at: "2026-10-02T12:00:02.123456001Z",
      annotation: { intent: "读取处理器信息" },
    },
    {
      ...fields,
      id: "TEST-system-first",
      created_at: "2026-10-02T12:00:01Z",
      updated_at: "2026-10-02T12:59:00Z",
      annotation: { intent: "读取系统版本" },
    },
  ];
  let newestFirst = true;
  await page.route("**/api/executions?*", (route) =>
    route.fulfill({
      json: {
        jobs: newestFirst ? jobs : [...jobs].reverse(),
        approvals: [],
        limit: 100,
      },
    }),
  );
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await openExecutionPanel(page);
  const panel = page.getByRole("complementary", {
    name: "Morphz 信息",
    exact: true,
  });
  const ended = panel.locator('[data-thread-id="TEST-ended"]');
  const endedIcon = ended.locator(".execution-activity-icon");
  await expect(ended).toHaveAttribute("aria-label", /已结束/);
  await expect(endedIcon).toHaveAttribute("data-status", "ended");
  await expect(endedIcon).toHaveAttribute("title", "已结束");
  await expect(endedIcon.locator("svg.lucide-circle-check")).toHaveCount(1);
  await expect(endedIcon.locator("svg path")).toHaveCount(1);
  await expect(ended).not.toContainText("成功");
  await expect(
    panel.locator(
      '[data-thread-id="TEST-failed"] .execution-activity-icon svg.lucide-circle-x',
    ),
  ).toHaveCount(1);
  await expect(
    panel.locator(
      '[data-thread-id="TEST-cancelled"] .execution-activity-icon svg.lucide-circle-slash',
    ),
  ).toHaveCount(1);
  await panel.screenshot({
    path: info.outputPath("ended-check-overview.png"),
  });
  await ended.click();
  const rows = panel.locator(".execution-job");
  const expected = [
    "TEST-system-first",
    "TEST-z-nanos-first",
    "TEST-a-nanos-second",
    "TEST-last-failed",
  ];
  await expect(rows).toHaveCount(4);
  expect(
    await rows.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-job-id")),
    ),
  ).toEqual(expected);
  await expect(rows.first().locator("header strong")).toHaveText(
    "读取系统版本",
  );
  await expect(rows.last().locator(".job-status")).toHaveText("失败");
  await expect(rows.last().locator(".delivery-error")).toHaveText("连接超时");
  await expect(rows.last().getByLabel("返回结果解读")).toHaveText(
    "真实调用返回连接超时",
  );
  await expect(panel.locator(".execution-history-bound")).toHaveCount(0);
  newestFirst = false;
  jobs[0]!.annotation!.result = "刷新后的回执解读仍然指出连接超时";
  await panel
    .getByRole("button", { name: "刷新执行记录", exact: true })
    .click();
  await expect(rows.last().getByLabel("返回结果解读")).toHaveText(
    "刷新后的回执解读仍然指出连接超时",
  );
  expect(
    await rows.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-job-id")),
    ),
  ).toEqual(expected);
  await panel.screenshot({
    path: info.outputPath("ended-check-chronological-steps.png"),
  });
  const error = rows.last().locator(".delivery-error");
  await error.scrollIntoViewIfNeeded();
  await expect(error).toBeInViewport({ ratio: 1 });
  await panel.screenshot({
    path: info.outputPath("real-job-failure-visible.png"),
  });
});

test("达到最近窗口的读取上限时顺序阅读不冒称完整过程", async ({ page }) => {
  await mockPlatformConversation(page, () => ({
    inputs: [],
    runtime: {
      ...disconnectedRuntime,
      configured: true,
      connected: true,
      activity: { available: true, truncated: false, threads: [] },
      attention: { available: true, approvals: [] },
    },
  }));
  const jobs = Array.from({ length: 3 }, (_, index) => ({
    id: `TEST-recent-${index}`,
    revision: 1,
    session_id: "TEST-session",
    context_id: "TEST-context",
    thread_id: "TEST-thread",
    tool_name: "read",
    target_id: "local",
    status: "succeeded",
    request: { path: `TEST-${index}.md` },
    result_event_id: null,
    created_at: new Date(Date.UTC(2026, 9, 2, 12, 0, 10 + index)).toISOString(),
    updated_at: stamp,
  })).reverse();
  await page.route("**/api/executions?*", (route) =>
    route.fulfill({ json: { jobs, approvals: [], limit: 3 } }),
  );
  await page.goto("/");
  await openExecutionPanel(page);
  const panel = page.getByRole("complementary", {
    name: "Morphz 信息",
    exact: true,
  });
  await panel.getByText("工具执行记录", { exact: true }).click();
  await expect(panel.locator(".execution-history-bound")).toHaveText(
    "当前为最近 3 项执行",
  );
  expect(
    await panel
      .locator(".execution-job")
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-job-id")),
      ),
  ).toEqual(["TEST-recent-0", "TEST-recent-1", "TEST-recent-2"]);
  await expect(panel).not.toContainText("完整执行过程");
});
