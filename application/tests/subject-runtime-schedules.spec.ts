import { test, expect, type Page } from "@playwright/test";
import {
  disconnectedRuntime,
  activitySchema,
  runtimeScheduleSchema,
  type ConversationRuntime,
} from "../packages/core/src/conversation.js";
import { platformTaskSchema } from "../apps/web/src/platform-client.js";
import { mockPlatformConversation } from "./platform-conversation-fixture.js";

const stamp = "2026-10-01T12:00:00.000Z";
async function fixture(page: Page) {
  const runtime: ConversationRuntime = {
    ...disconnectedRuntime,
    configured: true,
    connected: true,
    attention: { available: true, approvals: [] },
    activity: activitySchema.parse({
      available: true,
      truncated: false,
      schedulesAvailable: true,
      schedulesTruncated: false,
      schedules: [],
      threads: [],
    }),
  };
  const platform = await mockPlatformConversation(page, () => ({
    inputs: [],
    runtime,
  }));
  const row = runtimeScheduleSchema.parse({
    scheduleId: "TEST-native-reminder",
    threadId: "TEST-native-thread",
    sessionId: "TEST-session",
    contextId: "TEST-context",
    rootId: "TEST-scheduled-root",
    inputId: "TEST-input",
    sourceTurnId: "TEST-human-root",
    sourceRootId: "TEST-human-root",
    ...platform.scope,
    status: "queued",
    revision: 1,
    notBefore: "2026-10-03T05:30:00.000Z",
    intervalSeconds: null,
    dependencyThreadIds: [],
    intent: "TEST 原生提醒没有事项",
    updatedAt: stamp,
  });
  runtime.activity!.schedules = [row];
  runtime.activity!.threads = [
    {
      id: row.threadId,
      kind: "execution",
      ...platform.scope,
      inputId: row.inputId,
      rootId: row.rootId,
      sessionId: row.sessionId,
      title: row.intent,
      phase: "waiting",
      lifecycle: "open",
      revision: 1,
      updatedAt: stamp,
    },
  ];
  const task = platformTaskSchema.parse({
    id: "TEST-platform-task",
    projectId: platform.scope.projectId,
    title: "TEST 真实平台事项",
    description: "TEST 仅受控只读投影",
    assigneeId: "morphz-agent",
    execution: "planned",
    dueDate: null,
    orderRank: 0,
    revision: 1,
    updatedAt: stamp,
    createdAt: stamp,
    createdByPrincipalId: platform.client.boot.principalId,
    createdByActantId: platform.client.boot.actantId,
    headVersion: {
      taskId: "TEST-platform-task",
      revision: 1,
      ...platform.scope,
      title: "TEST 真实平台事项",
      description: "TEST",
      assigneeId: "morphz-agent",
      modelId: null,
      reasoningEffort: null,
      dueDate: null,
      assignment: "agent",
      execution: "planned",
      delivery: "none",
      runRequested: 1,
      notBefore: null,
      everySeconds: null,
      authorPrincipalId: platform.client.boot.principalId,
      authorActantId: platform.client.boot.actantId,
      createdAt: stamp,
      resultIds: [],
      dependsOnIds: [],
      watchSourceIds: [],
    },
  });
  let listFailure = false,
    listTasks = false,
    scheduleId = row.scheduleId;
  await page.route(/\/api\/platform\/tasks(?:\?.*)?$/, async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get("owner") !== "agent" || query.get("limit") !== "50")
      return route.fallback();
    await route.fulfill(
      listFailure
        ? {
            status: 503,
            json: { code: "unavailable", message: "TEST 事项目录失败" },
          }
        : { json: listTasks ? [task] : [] },
    );
  });
  await page.route(/\/api\/tasks\/TEST-platform-task\/runtime$/, (route) =>
    route.fulfill({
      json: {
        runs: [
          {
            run: 1,
            artifactRevision: 1,
            record: {
              id: scheduleId,
              revision: 1,
              status: "queued",
              interval_seconds: null,
              not_before: row.notBefore,
            },
            controlRevision: 1,
            threadState: null,
          },
        ],
      },
    }),
  );
  async function open() {
    await page.goto("/");
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "对话", exact: true })
      .click();
    const panel = page.getByRole("complementary", {
      name: "Morphz 信息",
      exact: true,
    });
    if (!(await panel.isVisible()))
      await page
        .getByRole("button", { name: "显示右侧栏", exact: true })
        .click();
    await panel.getByRole("tab", { name: "安排", exact: true }).click();
    return panel.getByRole("region", { name: "事项安排", exact: true });
  }
  return {
    platform,
    runtime,
    row,
    open,
    failList() {
      listFailure = true;
    },
    useTask(id = row.scheduleId) {
      listTasks = true;
      scheduleId = id;
    },
  };
}

test("无事项的原生提醒显示实际时间与等待，事项读取失败不抹掉原生提醒", async ({
  page,
}) => {
  const f = await fixture(page);
  const section = await f.open();
  const row = section.locator(`[data-schedule-id="${f.row.scheduleId}"]`);
  await expect(row).toContainText(f.row.intent);
  const writes: string[] = [];
  const explicitReads: string[] = [];
  page.on("request", (request) => {
    if (["POST", "PATCH", "DELETE"].includes(request.method()))
      writes.push(request.url());
    if (
      request.url().includes("runtime-navigation") &&
      new URL(request.url()).searchParams.get("refreshActivity") === "true"
    )
      explicitReads.push(request.url());
  });
  await expect(row).toContainText("等待触发");
  await expect(row).toContainText(/2026.*10.*3/);
  await expect(row).not.toContainText(/正在执行|进行中/);
  f.failList();
  await section
    .getByRole("button", { name: "刷新事项安排", exact: true })
    .click();
  await expect(section.getByRole("alert")).toContainText("TEST 事项目录失败");
  await expect(row).toBeVisible();
  await expect(
    section.getByText("暂无可确认的事项安排", { exact: true }),
  ).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(explicitReads).toHaveLength(1);
});

test("平台安排仅以真实scheduleId去重，标题或Thread相同不能合并不同安排", async ({
  page,
}) => {
  const f = await fixture(page);
  f.useTask();
  const section = await f.open();
  await expect(
    section.getByRole("button", { name: /TEST 真实平台事项/ }),
  ).toBeVisible();
  await expect(section.locator("[data-schedule-id]")).toHaveCount(0);
  f.useTask("TEST-another-schedule");
  await section
    .getByRole("button", { name: "刷新事项安排", exact: true })
    .click();
  await expect(section.locator("[data-schedule-id]")).toHaveCount(1);
  await expect(section.locator(".subject-record")).toHaveCount(2);
});

test("Runtime读取失败及有界空安排不伪报暂无", async ({ page }) => {
  const f = await fixture(page);
  f.runtime.activity!.available = false;
  const section = await f.open();
  await expect(section.getByRole("alert")).toContainText(
    "原生安排暂时无法读取",
  );
  await expect(section.locator("[data-schedule-id]")).toHaveCount(0);
  await expect(
    section.getByText("暂无可确认的事项安排", { exact: true }),
  ).toHaveCount(0);
  f.runtime.activity!.available = true;
  f.runtime.activity!.schedules = [];
  f.runtime.activity!.schedulesTruncated = true;
  await f.platform.refresh();
  await expect(
    section.getByText("安排概览有界，部分来源尚未核验。", { exact: true }),
  ).toBeVisible();
  await expect(
    section.getByText("暂无可确认的事项安排", { exact: true }),
  ).toHaveCount(0);
});
