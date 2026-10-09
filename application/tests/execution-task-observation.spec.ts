import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import { taskRuntimeSchema } from "../packages/core/src/task-runtime.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";
import { openExecutionPanel, openInput } from "./interaction-helpers.js";

// Consumer-layer regression: mounted production UI, actual Platform identity and
// domain reads, with controlled Runtime snapshots and typed invalidation frames.
// Actual Runtime WebSocket/authorization wake coverage belongs to the Host tests;
// these fixtures do not claim a physical job was executed.
async function execution(page: Page) {
  const fixture = await mockPlatformConversation(page, () => ({
    inputs: [],
    runtime: {
      ...disconnectedRuntime,
      configured: true,
      connected: true,
      attention: { available: true, approvals: [] },
    },
  }));
  let reads = 0,
    failures = 0;
  const job = {
    id: "TEST-observed-job",
    revision: 1,
    session_id: "TEST-session",
    context_id: "TEST-context",
    thread_id: "TEST-thread",
    tool_name: "read",
    target_id: "local",
    status: "running",
    request: { path: "TEST-only.md" },
    created_at: "2026-10-02T12:00:00Z",
    updated_at: "2026-10-02T12:00:00Z",
  };
  await page.route("**/api/executions?*", (route) => {
    reads++;
    if (failures-- > 0)
      return route.fulfill({
        status: 503,
        json: { message: "TEST 执行读取暂不可用" },
      });
    return route.fulfill({
      json: { jobs: [{ ...job }], approvals: [], limit: 100 },
    });
  });
  await page.goto("/");
  await openInput(page);
  await page.getByLabel("AI 输入内容").fill("TEST 事件读取不得更改草稿");
  await openExecutionPanel(page);
  const panel = page.getByRole("complementary", {
    name: "Morphz 信息",
    exact: true,
  });
  await panel.getByText("工具执行记录", { exact: true }).click();
  await expect(panel.locator(".execution-job")).toHaveCount(1);
  return {
    fixture,
    panel,
    job,
    get reads() {
      return reads;
    },
    fail(count: number) {
      failures = count;
    },
  };
}

test("执行详情健康idle无周期请求；状态通知与前台恢复读取，草稿不变", async ({
  page,
}) => {
  const state = await execution(page);
  const status = state.panel.locator(".job-status");
  await expect(status).toHaveText("执行中");
  await page.waitForTimeout(400);
  const initial = state.reads;
  await page.waitForTimeout(6500); // crosses the removed 2 s/3 s read periods
  expect(state.reads).toBe(initial);
  state.job.status = "succeeded";
  state.job.revision++;
  await state.fixture.refresh();
  await expect(status).toHaveText("");
  await expect(status).toHaveAttribute("aria-label", "已完成");
  await expect(
    state.panel.getByRole("img", { name: "已完成", exact: true }),
  ).toBeVisible();
  expect(state.reads).toBe(initial + 1);
  state.job.status = "failed";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(status).toHaveText("失败");
  await expect(page.getByLabel("AI 输入内容")).toHaveValue(
    "TEST 事件读取不得更改草稿",
  );
});

test("执行详情失败才重试，读回成功后无持续请求", async ({ page }) => {
  const state = await execution(page);
  await page.waitForTimeout(300);
  state.fail(1);
  const before = state.reads;
  await state.panel
    .getByRole("button", { name: "刷新执行记录", exact: true })
    .click();
  await expect(state.panel.getByRole("alert")).toContainText(
    "TEST 执行读取暂不可用",
  );
  await expect.poll(() => state.reads).toBe(before + 2);
  await expect(state.panel.getByRole("alert")).toHaveCount(0);
  const recovered = state.reads;
  await page.waitForTimeout(3500);
  expect(state.reads).toBe(recovered);
});

test("执行详情读取中再次收到状态变化，会补读最后状态而不漏通知", async ({
  page,
}) => {
  const state = await execution(page);
  let release!: () => void,
    started!: () => void,
    reads = 0;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/executions?*", async (route) => {
    const job = { ...state.job };
    if (++reads === 1) {
      started();
      await held;
    }
    await route.fulfill({ json: { jobs: [job], approvals: [], limit: 100 } });
  });
  try {
    await state.panel.locator(".execution-list").evaluate((root) => {
      const values: string[] = [];
      Reflect.set(window, "observedJobStatuses", values);
      new MutationObserver(() => {
        for (const node of root.querySelectorAll(".job-status"))
          values.push(
            node.getAttribute("aria-label") ?? node.textContent ?? "",
          );
      }).observe(root, {
        subtree: true,
        characterData: true,
        childList: true,
        attributes: true,
        attributeFilter: ["aria-label"],
      });
    });
    state.job.status = "failed"; // this response will become stale before release
    await state.fixture.refresh();
    await seen;
    state.job.status = "succeeded";
    await state.fixture.refresh();
    release();
    await expect(state.panel.locator(".job-status")).toHaveText("");
    await expect(
      state.panel.getByRole("img", { name: "已完成", exact: true }),
    ).toBeVisible();
    expect(reads).toBe(2);
    expect(
      await page.evaluate(() => Reflect.get(window, "observedJobStatuses")),
    ).not.toContain("失败");
  } finally {
    release();
  }
});

async function task(page: Page) {
  const fixture = await mockPlatformConversation(page, () => ({
    inputs: [],
    runtime: {
      ...disconnectedRuntime,
      configured: true,
      connected: true,
      attention: { available: true, approvals: [] },
    },
  }));
  const projectId = randomUUID(),
    taskId = randomUUID(),
    title = `TEST 事件事项 ${randomUUID().slice(0, 6)}`;
  await fixture.client.createProject(
    "TEST 事项观察项目",
    randomUUID(),
    projectId,
  );
  await fixture.client.createTask({
    commandId: randomUUID(),
    taskId,
    projectId,
    title,
    assigneeId: "morphz-agent",
  });
  let phase: "open" | "completed" = "open",
    approvalCount = 0,
    reads = 0;
  await page.route(/\/api\/platform\/bootstrap(?:\?.*)?$/, async (route) => {
    const response = await route.fetch(),
      data = await response.json();
    await route.fulfill({
      response,
      json: { ...data, capabilities: { ...data.capabilities, runtime: true } },
    });
  });
  await page.route(/\/api\/platform\/tasks(?:\?|\/|$)/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch(),
      data = await response.json();
    const apply = (value: any) => {
      if (value?.id === taskId && value.headVersion)
        return {
          ...value,
          headVersion: { ...value.headVersion, runRequested: 1 },
        };
      if (value?.taskId === taskId && "runRequested" in value)
        return { ...value, runRequested: 1 };
      return value;
    };
    await route.fulfill({
      response,
      json: Array.isArray(data) ? data.map(apply) : apply(data),
    });
  });
  await page.route(`**/api/tasks/${taskId}/runtime`, (route) => {
    expect(route.request().method()).toBe("GET");
    reads++;
    return route.fulfill({
      json: taskRuntimeSchema.parse({
        approvalCount,
        runs: [
          {
            run: 1,
            artifactRevision: 1,
            controlRevision: 1,
            threadState: phase,
            record: {
              revision: 1,
              thread_id: "TEST-observed-task-thread",
              status: phase === "open" ? "dispatched" : "completed",
              interval_seconds: null,
            },
          },
        ],
      }),
    });
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: /^事项/ })
    .click();
  await page
    .getByRole("group", { name: "事项负责人", exact: true })
    .getByRole("button", { name: "智能体", exact: true })
    .click();
  await page.getByLabel("搜索事项").filter({ visible: true }).fill(title);
  await expect.poll(() => reads).toBeGreaterThan(0);
  return {
    fixture,
    taskId,
    title,
    view: () =>
      taskRuntimeSchema.parse({
        approvalCount,
        runs: [
          {
            run: 1,
            artifactRevision: 1,
            controlRevision: 1,
            threadState: phase,
            record: {
              revision: 1,
              thread_id: "TEST-observed-task-thread",
              status: phase === "open" ? "dispatched" : "completed",
              interval_seconds: null,
            },
          },
        ],
      }),
    get reads() {
      return reads;
    },
    change(next: "open" | "completed", approvals = 0) {
      phase = next;
      approvalCount = approvals;
    },
  };
}

test("隐藏的事项仍消费事件更新状态筛选，清单健康时不轮询", async ({ page }) => {
  const state = await task(page);
  const row = page.locator(`[data-task-id="${state.taskId}"]`);
  await expect(row).toContainText("正在执行");
  await page
    .getByLabel("事项状态筛选")
    .filter({ visible: true })
    .selectOption("waiting");
  await expect(row).toHaveCount(0);
  await page.waitForTimeout(400);
  const initial = state.reads;
  await page.waitForTimeout(6500);
  expect(state.reads).toBe(initial);
  state.change("open", 1);
  await state.fixture.refresh();
  await expect(row).toContainText("等待你的确认");
  expect(state.reads).toBe(initial + 1);
  state.change("completed");
  await state.fixture.refresh();
  await expect(row).toHaveCount(0);
  await page
    .getByLabel("事项状态筛选")
    .filter({ visible: true })
    .selectOption("all");
  await expect(row).toContainText("执行结束 · 事项未完成");
});

test("清单的全局taskRuns投影拒绝已失效的旧终态，不只守住局部组件", async ({
  page,
}) => {
  const state = await task(page);
  const row = page.locator(`[data-task-id="${state.taskId}"]`);
  await expect(row).toContainText("正在执行");
  let release!: () => void,
    started!: () => void,
    reads = 0;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen = new Promise<void>((resolve) => {
    started = resolve;
  });
  await row.evaluate((root) => {
    const values: string[] = [];
    Reflect.set(window, "observedTaskStates", values);
    new MutationObserver(() => values.push(root.textContent ?? "")).observe(
      root,
      { subtree: true, characterData: true, childList: true },
    );
  });
  await page.route(`**/api/tasks/${state.taskId}/runtime`, async (route) => {
    const view = state.view();
    if (++reads === 1) {
      started();
      await held;
    }
    await route.fulfill({ json: view });
  });
  try {
    state.change("completed");
    await state.fixture.refresh();
    await seen;
    state.change("open", 1);
    await state.fixture.refresh();
    // A new hint aborts only the old snapshot query. No Runtime control is sent.
    await expect(row).toContainText("等待你的确认");
    release();
    await page.waitForTimeout(100);
    expect(reads).toBe(2);
    expect(
      (await page.evaluate(() =>
        Reflect.get(window, "observedTaskStates"),
      )) as string[],
    ).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("执行结束 · 事项未完成"),
      ]),
    );
    expect((await state.fixture.client.taskHead(state.taskId)).revision).toBe(
      1,
    );
    expect(
      (await state.fixture.client.taskVersion(state.taskId)).runRequested,
    ).toBe(0);
  } finally {
    release();
  }
});

test("事项详情独立观察相同版本的Runtime变化，不修改事项或发起执行", async ({
  page,
}) => {
  const state = await task(page);
  await page
    .getByRole("button", { name: `打开事项：${state.title}`, exact: true })
    .click();
  const panel = page.getByRole("region", {
    name: "实际执行与回应",
    exact: true,
  });
  await expect(panel).toContainText("正在执行");
  await page.waitForTimeout(400);
  const initial = state.reads;
  await page.waitForTimeout(6500);
  expect(state.reads).toBe(initial);
  state.change("completed");
  await state.fixture.refresh();
  await expect(panel).toContainText("执行结束 · 事项未完成");
  expect(state.reads).toBe(initial + 1);
  expect((await state.fixture.client.taskHead(state.taskId)).revision).toBe(1);
  expect(
    (await state.fixture.client.taskVersion(state.taskId)).runRequested,
  ).toBe(0);
});
