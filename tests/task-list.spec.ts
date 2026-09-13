import { test, expect, type Page } from "@playwright/test";
import { humanTask } from "./artifact-fixtures.js";
import { localDay } from "../apps/web/src/task-list.js";

async function seed(page: Page) {
  const boot = await (await page.request.get("/api/workspace")).json();
  const prefix = `TEST 清单 ${crypto.randomUUID().slice(0, 6)}`;
  const create = async (title: string, extra = {}) => {
    const response = await page.request.post("/api/commands", {
      headers: {
        "X-Morphz-Token": boot.csrfToken,
        Origin: "http://127.0.0.1:65421",
      },
      data: {
        commandId: crypto.randomUUID(),
        operation: {
          type: "create-artifact",
          projectId: "first-project",
          title: `${prefix} ${title}`,
          content: { ...humanTask("合成事项，不执行外部工作"), ...extra },
        },
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).entityId as string;
  };
  const today = localDay();
  const mine = await create("今天核对", { dueDate: today });
  await create("已逾期", { dueDate: "2020-01-01", priority: "high" });
  await create("稍后处理", { dueDate: "2099-01-01" });
  await create("没有日期");
  const agent = await create("Agent 工作", {
    assigneeId: "morphz-agent",
    execution: "waiting",
  });
  await create("已经完成", { execution: "completed" });
  const handoff = await create("等待交接");
  await create("后续工作", {
    assigneeId: "morphz-agent",
    dependsOnIds: [handoff],
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: /^事项/ })
    .click();
  await page.getByLabel("搜索事项").filter({ visible: true }).fill(prefix);
  return { prefix, mine, agent };
}

test("负责人、状态、日期与搜索分开；详情返回及刷新保留清单位置", async ({
  page,
}) => {
  const { prefix } = await seed(page);
  const list = page.getByLabel("事项列表", { exact: true });
  await expect(list.locator(".task-row")).toHaveCount(5);
  await expect(list.getByRole("heading", { name: /^已逾期/ })).toBeVisible();
  await expect(list.getByRole("heading", { name: /^今天到期/ })).toBeVisible();
  await expect(list.getByRole("heading", { name: /^之后到期/ })).toBeVisible();
  await expect(
    list.getByRole("heading", { name: /^未设截止日期/ }),
  ).toBeVisible();
  await expect(list.locator(".task-inline-properties:visible")).toHaveCount(0);
  await expect(list.locator(".task-due[data-overdue=true]")).toContainText(
    "2020-01-01",
  );
  await expect(
    list.getByRole("button", { name: `提交结果：${prefix} 等待交接` }),
  ).toBeVisible();
  await expect(list.getByRole("checkbox", { name: /等待交接/ })).toHaveCount(0);
  await page
    .getByRole("group", { name: "事项负责人", exact: true })
    .getByRole("button", { name: "Agent", exact: true })
    .click();
  await expect(list.locator(".task-row")).toHaveCount(2);
  await expect(list.getByRole("checkbox")).toHaveCount(0);
  await page
    .getByLabel("事项状态筛选")
    .filter({ visible: true })
    .selectOption("waiting");
  await expect(list.locator(".task-row")).toHaveCount(1);
  await list
    .getByRole("button", { name: `打开事项：${prefix} Agent 工作` })
    .click();
  await page
    .locator(".task-breadcrumb")
    .getByRole("button", { name: "事项", exact: true })
    .click();
  await expect(
    page.getByLabel("搜索事项").filter({ visible: true }),
  ).toHaveValue(prefix);
  await expect(list.locator(".task-row")).toHaveCount(1);
  await page.reload();
  await expect(list.locator(".task-row")).toHaveCount(1);
  await expect(
    page.getByLabel("事项状态筛选").filter({ visible: true }),
  ).toHaveValue("waiting");
});

test("勾选本人事项、撤销、已完成列表均使用持久版本，不发消息且不改原草稿", async ({
  page,
}) => {
  const { prefix, mine } = await seed(page);
  const before = await (await page.request.get("/api/workspace")).json();
  if (!(await page.getByLabel("AI 输入内容").isVisible()))
    await page.getByRole("button", { name: /向 Morphz 输入/ }).click();
  await page.getByLabel("AI 输入内容").fill("原事项页草稿，不发送");
  await page
    .getByRole("checkbox", { name: `标记完成：${prefix} 今天核对` })
    .click();
  await expect(
    page.getByRole("checkbox", { name: `标记完成：${prefix} 今天核对` }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("status").filter({ hasText: `已完成：${prefix} 今天核对` }),
  ).toBeVisible();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: `标记完成：${prefix} 今天核对` }),
  ).toBeVisible();
  await page
    .getByRole("checkbox", { name: `标记完成：${prefix} 今天核对` })
    .click();
  await page
    .getByLabel("事项状态筛选")
    .filter({ visible: true })
    .selectOption("completed");
  await expect(
    page.getByRole("checkbox", { name: `重新打开：${prefix} 今天核对` }),
  ).toBeChecked();
  await page.reload();
  await expect(
    page.getByRole("checkbox", { name: `重新打开：${prefix} 今天核对` }),
  ).toBeChecked();
  if (!(await page.getByLabel("AI 输入内容").isVisible()))
    await page.getByRole("button", { name: /向 Morphz 输入/ }).click();
  await expect(page.getByLabel("AI 输入内容")).toHaveValue(
    "原事项页草稿，不发送",
  );
  const after = await (await page.request.get("/api/workspace")).json();
  expect(after.workspace.inputs).toEqual(before.workspace.inputs);
  expect(after.workspace.taskResponses).toEqual(before.workspace.taskResponses);
  expect(
    after.workspace.artifacts.find((a: { id: string }) => a.id === mine)
      .revision,
  ).toBe(4);
});

test("失败不假装完成；窄窗筛选可操作且无溢出", async ({ page }) => {
  const { prefix } = await seed(page);
  await page.route("**/api/commands", (route) =>
    route.fulfill({ status: 503, json: { message: "TEST 状态写入失败" } }),
  );
  const checkbox = page.getByRole("checkbox", {
    name: `标记完成：${prefix} 今天核对`,
  });
  await checkbox.click();
  await expect(page.getByRole("alert")).toContainText("TEST 状态写入失败");
  await expect(checkbox).not.toBeChecked();
  await page.unroute("**/api/commands");
  for (const width of [760, 390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    const trigger = page.getByRole("button", { name: /^筛选事项：/ });
    await expect(trigger).toBeVisible();
    await trigger.click();
    const panel = page.getByRole("group", { name: "筛选事项", exact: true });
    await panel.getByLabel("事项负责人筛选").selectOption("all");
    await panel.getByLabel("事项状态筛选").selectOption("open");
    await expect(panel.getByLabel("搜索事项")).toHaveValue(prefix);
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    expect(
      await page
        .locator(".topbar")
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    expect(
      await page
        .locator(".task-list")
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page
    .getByRole("group", { name: "事项负责人", exact: true })
    .getByRole("button", { name: "全部", exact: true })
    .click();
  await page.screenshot({ path: "test-results/task-list-light.png" });
  await page.getByRole("button", { name: "外观设置", exact: true }).click();
  await page.getByRole("button", { name: "暗色", exact: true }).click();
  await page.keyboard.press("Escape");
  // Color transitions finish after the menu closes. Do not capture a mixed
  // light/dark frame and mistake it for the final rendered theme.
  await expect
    .poll(() =>
      page
        .locator(".task-row-copy h3")
        .first()
        .evaluate((el) => {
          const rgb = getComputedStyle(el)
            .color.match(/\d+/g)!
            .slice(0, 3)
            .map(Number);
          return rgb.every((channel) => channel > 200);
        }),
    )
    .toBe(true);
  await page.screenshot({ path: "test-results/task-list-dark.png" });
});

test("等待明确指向前置事项；失败与未完成交付不混入等待；成果直达且不默认重新执行", async ({
  page,
}) => {
  const { prefix, agent } = await seed(page);
  const boot = await (await page.request.get("/api/workspace")).json();
  const saved = await page.request.post("/api/commands", {
    headers: {
      "X-Morphz-Token": boot.csrfToken,
      Origin: "http://127.0.0.1:65421",
    },
    data: {
      commandId: crypto.randomUUID(),
      operation: {
        type: "create-artifact",
        projectId: "first-project",
        title: `${prefix} 真实保存的结果`,
        content: { kind: "document", markdown: "合成回归成果正文" },
      },
    },
  });
  expect(saved.ok()).toBe(true);
  const resultId = (await saved.json()).entityId;
  let phase: "waiting" | "failed" | "ended" | "done" = "waiting";
  await page.route("**/api/workspace", async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), "if-none-match": "" },
    });
    const body = await response.json();
    const task = body.workspace.artifacts.find(
      (a: { id: string }) => a.id === agent,
    );
    const prerequisite = body.workspace.artifacts.find(
      (a: { title: string }) => a.title === `${prefix} 等待交接`,
    );
    task.content.runRequested = 1;
    task.content.execution = phase === "done" ? "completed" : "planned";
    task.content.resultIds =
      phase === "done" || phase === "ended" ? [resultId] : [];
    body.capabilities.runtime = true;
    body.taskRuns[agent] = {
      error: "",
      blockers:
        phase === "waiting"
          ? [
              {
                taskId: prerequisite.id,
                title: prerequisite.title,
                assigneeName: "我",
                reason: "response",
              },
            ]
          : [],
      runs:
        phase === "waiting"
          ? []
          : [
              {
                run: 1,
                artifactRevision: 1,
                controlRevision: 1,
                threadState: phase === "failed" ? "failed" : "completed",
                record: {
                  revision: 1,
                  thread_id: "synthetic-status-thread",
                  status: "completed",
                  interval_seconds: null,
                },
              },
            ],
    };
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  await page
    .getByRole("group", { name: "事项负责人", exact: true })
    .getByRole("button", { name: "Agent", exact: true })
    .click();
  await page
    .getByLabel("事项状态筛选")
    .filter({ visible: true })
    .selectOption("all");
  await page.getByRole("button", { name: "看板视图", exact: true }).click();
  const row = page.locator(`[data-task-id="${agent}"]`);
  await expect(row).toContainText(`等我提交结果：${prefix} 等待交接`);
  await expect(page.locator('[data-task-group="等待"]')).toContainText(
    `${prefix} Agent 工作`,
  );
  await row.getByRole("button", { name: "查看前置事项", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "提交结果并完成", exact: true }),
  ).toBeVisible();
  await page
    .locator(".task-breadcrumb")
    .getByRole("button", { name: "事项", exact: true })
    .click();
  phase = "failed";
  await page.reload();
  await expect(page.locator('[data-task-group="待处理"]')).toContainText(
    `${prefix} Agent 工作`,
  );
  await expect(
    row.getByRole("button", { name: "重试", exact: true }),
  ).toBeVisible();
  await expect(
    row.getByRole("button", { name: "取消事项", exact: true }),
  ).toHaveCount(0);
  phase = "ended";
  await page.reload();
  await expect(row).toContainText("执行结束 · 事项未完成");
  await expect(page.locator('[data-task-group="待处理"]')).toContainText(
    `${prefix} Agent 工作`,
  );
  await expect(
    row.getByRole("button", { name: "查看结果", exact: true }),
  ).toBeVisible();
  phase = "done";
  await page.reload();
  await expect(page.locator('[data-task-group="已完成"]')).toContainText(
    `${prefix} Agent 工作`,
  );
  await expect(page.locator(".task-board-column")).toHaveCount(4);
  await expect(
    row.getByRole("button", { name: "重新执行", exact: true }),
  ).toHaveCount(0);
  await row
    .getByRole("button", {
      name: `更多操作：${prefix} Agent 工作`,
      exact: true,
    })
    .click();
  await expect(
    page
      .getByRole("group", { name: "事项操作", exact: true })
      .getByRole("button", { name: "重新执行", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(
    row.getByRole("button", {
      name: `更多操作：${prefix} Agent 工作`,
      exact: true,
    }),
  ).toBeFocused();
  await row.getByRole("button", { name: "查看结果", exact: true }).click();
  await expect(
    page.getByText("合成回归成果正文", { exact: true }),
  ).toBeVisible();
});

test("Agent 待确认卡片突出审批且保留停止，打开记录不自动授权", async ({
  page,
}) => {
  const { agent } = await seed(page);
  const approval = {
    requested_at: "2026-09-13T00:00:00Z",
    fingerprint: "b".repeat(64),
    request: {
      approval_id: "task-approval",
      session_id: "task-session",
      context_id: "task-context",
      root_turn_id: "task-root",
      thread_id: "task-thread",
      justification: "读取合成测试素材",
      action: {
        kind: "tool_operation",
        tool: "read_file",
        target: "/fixture/material.txt",
      },
      requested: { network: false, read_roots: ["/fixture"], write_roots: [] },
    },
  };
  await page.route("**/api/workspace", async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), "if-none-match": "" },
    });
    const body = await response.json();
    const task = body.workspace.artifacts.find(
      (a: { id: string }) => a.id === agent,
    );
    task.content.runRequested = 1;
    task.content.execution = "active";
    body.capabilities.runtime = true;
    body.taskRuns[agent] = {
      approvalCount: 1,
      runs: [
        {
          run: 1,
          artifactRevision: 1,
          controlRevision: 1,
          threadState: "open",
          record: {
            revision: 1,
            thread_id: "task-thread",
            status: "dispatched",
            interval_seconds: null,
          },
        },
      ],
    };
    body.runtime.attention = {
      available: true,
      approvals: [
        {
          scope: {
            projectId: task.projectId,
            artifactId: agent,
            threadId: "task-thread",
          },
          approval,
        },
      ],
    };
    await route.fulfill({ response, json: body });
  });
  let decisions = 0;
  await page.route("**/api/executions?*", async (route) => {
    expect(new URL(route.request().url()).searchParams.get("threadId")).toBe(
      "task-thread",
    );
    expect(new URL(route.request().url()).searchParams.get("artifactId")).toBe(
      agent,
    );
    await route.fulfill({
      json: { jobs: [], approvals: [approval], limit: 100 },
    });
  });
  await page.route("**/api/executions/control", async (route) => {
    decisions++;
    await route.fulfill({ status: 500 });
  });
  await page.reload();
  await page
    .getByRole("group", { name: "事项负责人", exact: true })
    .getByRole("button", { name: "Agent", exact: true })
    .click();
  await page.getByRole("button", { name: "看板视图", exact: true }).click();
  const row = page.locator(`[data-task-id="${agent}"]`);
  await expect(page.locator('[data-task-group="等待"]')).toContainText(
    "等待你的确认",
  );
  await expect(
    row.getByRole("button", { name: "停止", exact: true }),
  ).toBeEnabled();
  await expect(
    row.getByRole("button", { name: "开始", exact: true }),
  ).toHaveCount(0);
  await row.getByRole("button", { name: "处理确认 (1)", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "仅允许这一次", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("读取合成测试素材", { exact: true }),
  ).toBeVisible();
  expect(decisions).toBe(0);
});

test("失败执行保留记录和重试，重试请求失败不伪装成功；终态记录不依赖活动列表", async ({
  page,
}) => {
  const { prefix, agent } = await seed(page);
  const calls: unknown[] = [];
  await page.route("**/api/workspace", async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), "if-none-match": "" },
    });
    const body = await response.json();
    const task = body.workspace.artifacts.find(
      (a: { id: string }) => a.id === agent,
    );
    task.content.runRequested = 1;
    task.content.execution = "planned";
    body.capabilities.runtime = true;
    body.taskRuns[agent] = {
      error: "",
      runs: [
        {
          run: 1,
          artifactRevision: 1,
          record: {
            revision: 1,
            thread_id: "failed-task-thread",
            status: "dispatched",
            interval_seconds: null,
          },
          controlRevision: 1,
          threadState: "failed",
        },
      ],
    };
    body.runtime.activity = { available: true, threads: [] };
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/executions?*", async (route) => {
    expect(new URL(route.request().url()).searchParams.get("threadId")).toBe(
      "failed-task-thread",
    );
    await route.fulfill({
      json: {
        jobs: [
          {
            id: "failed-job",
            revision: 2,
            thread_id: "failed-task-thread",
            session_id: "test-session",
            context_id: "test-context",
            tool_name: "test-read",
            target_id: "测试",
            status: "failed",
            created_at: "2026-09-13T00:00:00Z",
            updated_at: "2026-09-13T00:00:01Z",
            error: "测试资料不存在",
            request: {},
          },
        ],
        approvals: [],
        limit: 100,
      },
    });
  });
  await page.route("**/api/commands", async (route) => {
    calls.push(route.request().postDataJSON());
    await route.fulfill({ status: 503, json: { message: "模拟重试连接中断" } });
  });
  await page.reload();
  await page
    .getByRole("group", { name: "事项负责人", exact: true })
    .getByRole("button", { name: "Agent", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: `打开事项：${prefix} Agent 工作`,
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", { name: "重试", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "执行记录", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", {
      name: `更多操作：${prefix} Agent 工作`,
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "执行记录", exact: true }).click();
  await expect(page.getByText(/本次执行 · 最近/)).toBeVisible();
  await expect(page.getByText("测试资料不存在", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "模拟重试连接中断" }),
  ).toBeVisible();
  expect(calls).toMatchObject([
    {
      operation: {
        type: "request-task-run",
        taskId: agent,
        expectedRevision: 1,
      },
    },
  ]);
  await expect(
    page.getByRole("status").filter({ hasText: "执行失败" }),
  ).toBeVisible();
});

test("就地安排与撤销、项目/负责人不复制事项；看板拖动和清单共用持久状态与筛选", async ({
  page,
}) => {
  const { prefix, mine } = await seed(page);
  await page
    .getByRole("group", { name: "事项负责人", exact: true })
    .getByRole("button", { name: "全部", exact: true })
    .click();
  await page
    .getByLabel("事项状态筛选")
    .filter({ visible: true })
    .selectOption("all");
  const row = page.locator(`.task-row[data-task-id="${mine}"]`);
  const before = await (await page.request.get("/api/workspace")).json();
  const arrange = async () => {
    const trigger = row.getByRole("button", {
      name: `安排事项：${prefix} 今天核对`,
      exact: true,
    });
    if ((await trigger.getAttribute("aria-expanded")) !== "true")
      await trigger.click();
  };
  // Status is directly available on the compact row, without opening Arrange.
  await expect(row.getByLabel("事项状态", { exact: true })).toBeVisible();
  await row.getByLabel("事项状态", { exact: true }).selectOption("active");
  await expect(
    page.getByRole("status").filter({ hasText: "已修改" }),
  ).toBeVisible();
  await page
    .getByRole("status")
    .filter({ hasText: "已修改" })
    .getByRole("button", { name: "撤销", exact: true })
    .click();
  await expect(row.getByLabel("事项状态", { exact: true })).toHaveValue(
    "planned",
  );
  await expect(page.getByLabel("优先级", { exact: true })).toHaveCount(0);
  await arrange();
  await expect(
    row
      .locator(".task-arrange-popover")
      .getByLabel("事项状态", { exact: true }),
  ).toHaveCount(0);
  await row.getByRole("button", { name: "修改截止日期" }).click();
  await page.getByRole("button", { name: "明天", exact: true }).click();
  await expect(
    page
      .locator(".task-date-group")
      .filter({ has: row })
      .getByRole("heading", { level: 2 }),
  ).toContainText("之后到期");
  await arrange();
  await row.getByRole("button", { name: "修改截止日期" }).click();
  await page.getByRole("button", { name: "今天", exact: true }).click();
  await expect(row.locator(".task-due")).toHaveText("今天");
  await arrange();
  await row.getByRole("button", { name: "修改截止日期" }).click();
  await page.getByLabel("截止日期", { exact: true }).fill("2099-09-16");
  await expect(row.locator(".task-due")).toHaveText("2099-09-16");
  await page.keyboard.press("Escape");
  const inbox = before.workspace.projects.find(
    (p: { kind: string; ownerPrincipalId: string }) =>
      p.kind === "inbox" && p.ownerPrincipalId === before.principalId,
  ).id;
  await arrange();
  await row.getByLabel("项目", { exact: true }).selectOption(inbox);
  await expect(row.getByLabel("项目", { exact: true })).toHaveValue(inbox);
  await row.getByLabel("负责人", { exact: true }).selectOption("morphz-agent");
  await expect(
    row.getByRole("button", { name: "开始", exact: true }),
  ).toBeVisible();
  await expect(row.getByLabel("事项状态", { exact: true })).toHaveCount(0);
  let current = await (await page.request.get("/api/workspace")).json();
  expect(current.workspace.inputs).toHaveLength(before.workspace.inputs.length);
  expect(current.workspace.artifacts).toHaveLength(
    before.workspace.artifacts.length,
  );
  expect(
    current.workspace.artifacts.find((a: { id: string }) => a.id === mine)
      .content.runRequested,
  ).toBe(0);
  await row.getByLabel("负责人", { exact: true }).selectOption("local-human");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "看板视图" }).click();
  await expect(page.locator(".task-board-column")).toHaveCount(4);
  await expect(
    page.locator(".task-board").getByLabel("事项状态", { exact: true }),
  ).toHaveCount(0);
  const grip = row.getByRole("button", {
    name: `排序：${prefix} 今天核对`,
    exact: true,
  });
  // dragTo waits for geometry, not enabled state. Finish the preceding save
  // before beginning a pointer gesture on the temporarily disabled handle.
  await expect(grip).toBeEnabled();
  await grip.dragTo(page.locator('.task-board-column[aria-label="进行中"]'));
  await expect(
    page
      .locator('.task-board-column[aria-label="进行中"]')
      .locator(`[data-task-id="${mine}"]`),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/task-board-light.png" });
  await page.reload();
  await expect(page.getByRole("button", { name: "看板视图" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    page
      .locator('.task-board-column[aria-label="进行中"]')
      .locator(`[data-task-id="${mine}"]`),
  ).toBeVisible();
  // Non-drag/keyboard access remains in the existing task details, with no
  // second state selector on the board card.
  const open = row.getByRole("button", {
    name: `打开事项：${prefix} 今天核对`,
    exact: true,
  });
  await open.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("事项状态", { exact: true })).toHaveValue(
    "active",
  );
  await page.getByLabel("事项状态", { exact: true }).selectOption("waiting");
  await expect(page.getByLabel("事项状态", { exact: true })).toHaveValue(
    "waiting",
  );
  await page
    .locator(".task-breadcrumb")
    .getByRole("button", { name: "事项", exact: true })
    .click();
  await expect(
    page
      .locator('.task-board-column[aria-label="等待"]')
      .locator(`[data-task-id="${mine}"]`),
  ).toBeVisible();
  await page.getByRole("button", { name: "清单视图" }).click();
  await expect(row.getByLabel("事项状态", { exact: true })).toHaveValue(
    "waiting",
  );
  await row.getByLabel("事项状态", { exact: true }).selectOption("active");
  await expect(row.getByLabel("事项状态", { exact: true })).toHaveValue(
    "active",
  );
  await expect(
    page.getByLabel("搜索事项").filter({ visible: true }),
  ).toHaveValue(prefix);
  const other = page.locator(".task-row").filter({
    has: page.getByRole("button", {
      name: `打开事项：${prefix} 稍后处理`,
      exact: true,
    }),
  });
  await expect(grip).toBeEnabled();
  await grip.dragTo(other, { targetPosition: { x: 30, y: 1 } });
  await expect
    .poll(async () => {
      const w = await (await page.request.get("/api/workspace")).json();
      const order = w.workspace.taskOrder;
      return (
        order.indexOf(mine) <
        order.indexOf(await other.getAttribute("data-task-id"))
      );
    })
    .toBe(true);
  await page.reload();
  await expect(page.getByLabel("优先级", { exact: true })).toHaveCount(0);
  current = await (await page.request.get("/api/workspace")).json();
  expect(
    current.workspace.artifacts.find((a: { id: string }) => a.id === mine)
      .content.dueDate,
  ).toBe("2099-09-16");
  await row.getByLabel("事项状态", { exact: true }).selectOption("cancelled");
  await expect(
    page
      .locator('.task-date-group[aria-label="已取消"]')
      .locator(`[data-task-id="${mine}"]`),
  ).toBeVisible();
  await page.getByRole("button", { name: "看板视图", exact: true }).click();
  await expect(page.locator(".task-board-column")).toHaveCount(4);
  await expect(
    page.locator(".task-cancelled-group").locator(`[data-task-id="${mine}"]`),
  ).toBeVisible();
  await expect(
    page.locator(".task-cancelled-group .task-due[data-overdue=true]"),
  ).toHaveCount(0);
});
