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
import { openExecutionPanel, openInput } from "./interaction-helpers.js";

type Thread = ExecutionActivity["threads"][number];
const stamp = "2026-10-02T12:00:00.000Z";
const panelName = { name: "Morphz 信息", exact: true };

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

function job(overrides: Partial<ExecutionSnapshot["jobs"][number]> = {}) {
  return {
    id: "TEST-annotation-job-one",
    revision: 2,
    session_id: "TEST-session",
    context_id: "TEST-context",
    thread_id: "TEST-annotation-thread",
    tool_name: "read",
    target_id: "local",
    status: "succeeded" as const,
    request: { path: "TEST-readme.md" },
    result_event_id: "TEST-receipt-one",
    created_at: stamp,
    updated_at: stamp,
    cancel_requested_at: null,
    error: null,
    exit_code: null,
    ...overrides,
  };
}

test("活动按同一Execution更新语义标题与一行摘要，不改真实状态、时刻或草稿", async ({
  page,
}) => {
  const threads: Thread[] = [];
  let connected = true;
  const fixture = await mockPlatformConversation(page, () => ({
    inputs: [],
    runtime: {
      ...disconnectedRuntime,
      configured: true,
      connected,
      activity: { available: true, truncated: false, threads },
      attention: { available: true, approvals: [] },
    },
  }));
  threads.push(
    {
      ...fixture.scope,
      id: "TEST-annotation-thread",
      kind: "execution",
      inputId: null,
      rootId: "TEST-root",
      sessionId: "TEST-session",
      title: "核对运行环境",
      summary: "已读取系统版本，继续核对架构",
      annotationProtocol: "v1",
      phase: "running",
      lifecycle: "open",
      revision: 3,
      updatedAt: stamp,
    },
    {
      ...fixture.scope,
      id: "TEST-legacy-thread",
      kind: "execution",
      inputId: null,
      rootId: "TEST-legacy-root",
      sessionId: "TEST-session",
      title: "旧执行保留原意图",
      phase: "running",
      lifecycle: "completed",
      revision: 1,
      updatedAt: stamp,
    },
  );
  await page.route("**/api/executions?*", (route) =>
    route.fulfill({ json: { jobs: [], approvals: [], limit: 100 } }),
  );
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const draft = "TEST 不发送的原草稿";
  await (await openInput(page)).fill(draft);
  await openExecutionPanel(page);
  const panel = page.getByRole("complementary", panelName);
  const current = panel.locator('[data-thread-id="TEST-annotation-thread"]');
  await expect(panel.locator(".execution-activity-row")).toHaveCount(2);
  await expect(current.locator("strong")).toHaveText("核对运行环境");
  await expect(current.locator(".execution-activity-summary")).toHaveText(
    "已读取系统版本，继续核对架构",
  );
  await expect(current.locator(".execution-activity-icon")).toHaveAttribute(
    "data-status",
    "running",
  );
  await expect(current.locator("time")).toHaveAttribute("dateTime", stamp);
  await expect(
    panel.locator(
      '[data-thread-id="TEST-legacy-thread"] .execution-activity-summary',
    ),
  ).toHaveCount(0);

  // This is a changed projection of the same real Thread, not a new activity.
  threads[0]!.title = "核对环境并确认启动要求";
  threads[0]!.summary = "架构已确认，正在核对新增的启动要求";
  await fixture.refresh();
  await expect(panel.locator(".execution-activity-row")).toHaveCount(2);
  await expect(current.locator("strong")).toHaveText("核对环境并确认启动要求");
  await expect(current.locator("time")).toHaveAttribute("dateTime", stamp);
  await current.click();
  await expect(panel.locator(".execution-origin")).toContainText(
    "架构已确认，正在核对新增的启动要求",
  );
  await panel
    .getByRole("button", { name: "返回活动列表", exact: true })
    .click();

  connected = false;
  await fixture.refresh();
  await expect(current.locator(".execution-activity-summary")).toHaveCount(0);
  await expect(current.locator(".execution-activity-icon")).toHaveAttribute(
    "data-status",
    "unknown",
  );
  connected = true;
  threads[0]!.lifecycle = "completed";
  threads[0]!.summary = "只完成了环境读取，新增启动检查未执行";
  threads[0]!.outcome = {
    terminalKind: "completed",
    disposition: "ended",
    summary: null,
    createdAt: "2026-10-02T12:02:00.000Z",
  };
  await fixture.refresh();
  await expect(current).toHaveAttribute("aria-label", /已结束/);
  await expect(current.locator(".execution-activity-icon")).toHaveAttribute(
    "data-status",
    "ended",
  );
  await expect(current.locator(".execution-activity-summary")).toHaveText(
    "只完成了环境读取，新增启动检查未执行",
  );
  await expect(current.locator("time")).toHaveAttribute(
    "dateTime",
    "2026-10-02T12:02:00.000Z",
  );
  await expect(current).not.toContainText("成功");
  await expect(await openInput(page)).toHaveValue(draft);
});

test("步骤显示对应Job的意图与回执解读，旧步骤回退且原返回和技术信息仍可核对", async ({
  page,
}) => {
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
  const jobs = [
    job({
      annotation: {
        intent: "确认项目的运行要求",
        result: "项目要求 Node 24",
      },
    }),
    job({
      id: "TEST-annotation-job-two",
      status: "failed",
      error: "读取权限不足",
      annotation: {
        intent: "核对受限资料",
        result: "返回回执明确指出读取权限不足",
      },
      result_event_id: "TEST-receipt-two",
    }),
    job({
      id: "TEST-annotation-job-three",
      status: "running",
      result_event_id: null,
      annotation: {
        intent: "等待当前资料读取",
        result: "没有真实返回，不得显示这个候选结果",
      },
    }),
    job({
      id: "TEST-legacy-job",
      tool_name: "exec",
      request: { command: "SECRET=hidden command", cwd: "/TEST-workspace" },
      result_event_id: null,
    }),
  ];
  await page.route("**/api/executions?*", (route) =>
    route.fulfill({ json: { jobs, approvals: [], limit: 100 } }),
  );
  await page.route("**/api/executions/result?*", (route) =>
    route.fulfill({
      json: {
        available: true,
        truncated: false,
        text: '{"ok":true,"runtime":"Node 24","exactReceipt":"TEST-receipt-one"}',
      },
    }),
  );
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await openExecutionPanel(page);
  const panel = page.getByRole("complementary", panelName);
  await panel.getByText("工具执行记录", { exact: true }).click();
  const first = panel.locator('[data-job-id="TEST-annotation-job-one"]');
  const failed = panel.locator('[data-job-id="TEST-annotation-job-two"]');
  const running = panel.locator('[data-job-id="TEST-annotation-job-three"]');
  const legacy = panel.locator('[data-job-id="TEST-legacy-job"]');
  await expect(first.locator("header strong")).toHaveText("确认项目的运行要求");
  await expect(first.getByLabel("返回结果解读")).toHaveText("项目要求 Node 24");
  await expect(failed.locator(".job-status")).toHaveText("失败");
  await expect(failed.locator(".delivery-error")).toHaveText("读取权限不足");
  await expect(failed.getByLabel("返回结果解读")).toHaveText(
    "返回回执明确指出读取权限不足",
  );
  await expect(running.locator(".job-status")).toHaveText("执行中");
  await expect(running.getByLabel("返回结果解读")).toHaveCount(0);
  await expect(
    running.getByRole("button", { name: "停止此项执行" }),
  ).toBeVisible();
  await expect(legacy.locator("header strong")).toHaveText("执行命令");
  await expect(legacy.locator(".execution-object")).toHaveText(
    "/TEST-workspace",
  );
  await expect(legacy.getByLabel("返回结果解读")).toHaveCount(0);
  await expect(legacy.locator("pre")).not.toBeVisible();
  await legacy.getByRole("button", { name: "技术详情", exact: true }).click();
  await expect(legacy.locator("pre")).toContainText("SECRET=hidden command");
  await first.getByRole("button", { name: "查看结果", exact: true }).click();
  await expect(first.locator(".execution-result pre")).not.toBeVisible();
  await first.getByText("完整返回内容", { exact: true }).click();
  await expect(first.locator(".execution-result pre")).toContainText(
    '"exactReceipt":"TEST-receipt-one"',
  );
});

test("长注解在明暗窄窗与CSS缩放保持简洁，普通文本不执行HTML", async ({
  page,
}, info) => {
  const threads: Thread[] = [];
  const title = "核对运行环境与新增要求".repeat(12);
  const summary =
    '只读检查 <img src="bad" onerror="alert(1)"> 不作为HTML执行。'.repeat(6);
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
  threads.push({
    ...fixture.scope,
    id: "TEST-long-annotation-thread",
    kind: "execution",
    inputId: null,
    rootId: "TEST-root",
    sessionId: "TEST-session",
    title,
    summary,
    phase: "running",
    lifecycle: "open",
    revision: 1,
    updatedAt: stamp,
  });
  await page.route("**/api/executions?*", (route) =>
    route.fulfill({
      json: {
        jobs: [job({ annotation: { intent: title, result: summary } })],
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
  const panel = page.getByRole("complementary", panelName);
  const row = panel.locator('[data-thread-id="TEST-long-annotation-thread"]');
  const prose = row.locator(".execution-activity-summary");
  await expect(row.locator("img")).toHaveCount(0);
  await expect(prose).toHaveAttribute("title", summary);
  for (const appearance of ["light", "dark"]) {
    await page.locator(".app").evaluate((element, value) => {
      element.setAttribute("data-appearance", value);
    }, appearance);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 960 });
      await expect(row).toBeInViewport();
      expect(
        await row.evaluate(
          (element) => element.scrollWidth <= element.clientWidth + 1,
        ),
      ).toBe(true);
      const lines = await prose.evaluate((element) => {
        const style = getComputedStyle(element);
        return element.clientHeight / parseFloat(style.lineHeight);
      });
      expect(lines).toBeLessThanOrEqual(1.05);
      await panel.screenshot({
        path: info.outputPath(`activity-${appearance}-${width}.png`),
      });
    }
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  await expect(row).toBeInViewport();
  expect(
    await row.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  await panel.screenshot({
    path: info.outputPath("activity-css-200-percent.png"),
  });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "";
  });
  await panel.getByText("工具执行记录", { exact: true }).click();
  const step = panel.locator('[data-job-id="TEST-annotation-job-one"]');
  const interpretation = step.getByLabel("返回结果解读");
  await expect(interpretation).toHaveAttribute("title", summary);
  await expect(step.locator("img")).toHaveCount(0);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    await step.scrollIntoViewIfNeeded();
    await expect(step.locator(".job-status")).toBeVisible();
    expect(
      await step.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true);
    expect(
      await interpretation.evaluate(
        (element) =>
          element.clientHeight /
          parseFloat(getComputedStyle(element).lineHeight),
      ),
    ).toBeLessThanOrEqual(2.05);
    const titleBounds = (await step.locator("header strong").boundingBox())!;
    const statusBounds = (await step.locator(".job-status").boundingBox())!;
    expect(titleBounds.x + titleBounds.width).toBeLessThanOrEqual(
      statusBounds.x,
    );
    await panel.screenshot({
      path: info.outputPath(`steps-dark-${width}.png`),
    });
  }
});
