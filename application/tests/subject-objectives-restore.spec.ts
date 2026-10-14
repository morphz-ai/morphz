import { expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import type { PlatformHistory } from "../apps/web/src/platform-client.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";
import { openInput } from "./interaction-helpers.js";
import { openSettings } from "./settings-helpers.js";

// Controlled presentation facts in the production renderer and isolated center.
// No Objective, Schedule, Thread or input is created in the user's original App.
async function prepare(page: Page) {
  const runtime = {
    ...disconnectedRuntime,
    configured: true,
    connected: true,
    activity: {
      available: true,
      truncated: false,
      openWorkComplete: true,
      objectivesTruncated: false,
      threads: [] as NonNullable<
        typeof disconnectedRuntime.activity
      >["threads"],
      objectives: [] as NonNullable<
        NonNullable<typeof disconnectedRuntime.activity>["objectives"]
      >,
    },
    attention: { available: true, approvals: [] },
  };
  const inputs: PlatformHistory["inputs"] = [];
  const fixture = await mockPlatformConversation(page, () => ({
    inputs,
    runtime,
  }));
  const stamp = "2026-10-12T13:00:00Z";
  const projectId = randomUUID();
  const origin =
    "TEST BailingHub 项目评估｜参赛价值、源码成熟度、商业可行性与实现建议";
  await fixture.client.createProject(
    "TEST 窄栏来源与原件完整标题验收项目 " + projectId.slice(0, 8),
    randomUUID(),
    projectId,
  );
  const objectId = randomUUID();
  await fixture.client.createDocument({
    commandId: randomUUID(),
    objectId,
    projectId,
    title: origin,
    markdown: "TEST 仅隔离测试中心的合成报告。",
  });
  const content = await fixture.client.resolveContent({
    appId: "morphz.objects",
    appObjectId: objectId,
  });
  const source = {
    ...fixture.scope,
    projectId,
    conversationId: projectId,
    inputId: "TEST-goal-input",
    rootId: "TEST-goal-root",
    sessionId: "TEST-goal-session",
    contextId: "TEST-goal-context",
  };
  inputs.push({
    ...fixture.input(source.inputId, "TEST 验证原目标入口", stamp),
    projectId,
    conversationId: projectId,
    artifactId: content.id,
    artifactRevision: 1,
  });
  runtime.activity.threads.push({
    ...source,
    id: "TEST-related-thread",
    title: "生成 BailingHub 评估文档并导出 PDF",
    summary:
      "综合评估文档已保存为版本1；8页PDF已在本机导出并完成完整性与排版检查。",
    kind: "execution",
    lifecycle: "completed",
    phase: "idle",
    revision: 1,
    updatedAt: stamp,
  });
  for (const field of ["sessionId", "projectId", "conversationId"] as const)
    runtime.activity.threads.push({
      ...runtime.activity.threads[0]!,
      id: `TEST-unrelated-${field}`,
      title: `TEST 不应关联 ${field}`,
      [field]: "TEST-other-identity",
    });
  runtime.activity.threads.push({
    ...runtime.activity.threads[0]!,
    id: "TEST-dialogue-thread",
    title: "TEST 普通聊天不充当关联执行",
    kind: "dialogue_turn",
  });
  runtime.activity.objectives.push(
    {
      ...source,
      id: "TEST-related-goal",
      title: "TEST 保证报告内容可核对",
      status: "active",
      readiness: "waiting",
      statusReason: "TEST 原始技术原因不应常驻",
      parentId: null,
      threadIds: runtime.activity.threads.map((thread) => thread.id),
      updatedAt: stamp,
    },
    {
      ...source,
      projectId: fixture.spaces.deskId,
      conversationId: fixture.spaces.deskId,
      sessionId: "TEST-other-authorized-session",
      id: "TEST-no-thread-goal",
      title: "TEST 尚无执行的其他工作面目标",
      status: "blocked",
      readiness: "blocked",
      statusReason: null,
      parentId: null,
      threadIds: [],
      updatedAt: stamp,
    },
  );
  for (const lifecycle of ["failed", "cancelled"])
    runtime.activity.threads.push({
      ...runtime.activity.threads[0]!,
      id: `TEST-status-${lifecycle}`,
      rootId: `TEST-root-${lifecycle}`,
      title: `TEST 真实状态 ${lifecycle}`,
      lifecycle,
    });
  const queries: URLSearchParams[] = [];
  await page.route("**/api/executions?*", (route) => {
    queries.push(new URL(route.request().url()).searchParams);
    return route.fulfill({
      json: {
        jobs:
          new URL(route.request().url()).searchParams.get("threadId") ===
          "TEST-related-thread"
            ? [
                {
                  id: "TEST-success-step",
                  revision: 1,
                  session_id: source.sessionId,
                  context_id: source.contextId,
                  thread_id: "TEST-related-thread",
                  tool_name: "read",
                  target_id: "TEST-local",
                  status: "succeeded",
                  request: { path: "TEST-report.md" },
                  result_event_id: "TEST-result",
                  created_at: stamp,
                  updated_at: stamp,
                  cancel_requested_at: null,
                  error: null,
                  exit_code: 0,
                  annotation: { intent: "TEST 校验保存内容" },
                },
                {
                  id: "TEST-failed-step",
                  revision: 1,
                  session_id: source.sessionId,
                  context_id: source.contextId,
                  thread_id: "TEST-related-thread",
                  tool_name: "read",
                  target_id: "TEST-local",
                  status: "failed",
                  request: { path: "TEST-failed.md" },
                  result_event_id: "TEST-failed-result",
                  created_at: stamp,
                  updated_at: stamp,
                  cancel_requested_at: null,
                  error: "TEST 实际返回失败",
                  exit_code: 1,
                  annotation: { intent: "TEST 失败不能被绿色完成覆盖" },
                },
              ]
            : [],
        approvals: [],
        limit: 100,
      },
    });
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const draft = "TEST 查看目标和窄栏不会发送的草稿";
  await (await openInput(page)).fill(draft);
  const panel = page.getByRole("complementary", {
    name: "Morphz 信息",
    exact: true,
  });
  if (!(await panel.isVisible()))
    await page.getByRole("button", { name: "显示右侧栏", exact: true }).click();
  await panel.getByRole("tab", { name: "活动", exact: true }).click();
  const writes: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/(?:platform\/(?:messages|conversations\/start)|executions\/control|objectives|tasks)/.test(
        request.url(),
      )
    )
      writes.push(request.url());
  });
  return { ...fixture, runtime, panel, queries, source, draft, writes, origin };
}

for (const colorScheme of ["light", "dark"] as const)
  test(`目标下直接看见四条并行执行及等待协调线程，分段详情独立且刷新不改展开 ${colorScheme}`, async ({
    page,
  }, info) => {
    await page.emulateMedia({ colorScheme });
    const f = await prepare(page);
    const original = f.runtime.activity.threads[0]!;
    original.lifecycle = "open";
    original.phase = "running";
    original.title = "TEST 原写作线程";
    const goal = f.runtime.activity.objectives[0]!;
    const branches = ["coordinator", "D", "E", "F"].map((id) => ({
      ...original,
      id: `TEST-parallel-${id}`,
      rootId: `TEST-synthetic-root-${id}`,
      parentThreadId: id === "coordinator" ? null : "TEST-parallel-coordinator",
      objectiveId: goal.id,
      title: id === "coordinator" ? "TEST 统稿协调线程" : `TEST 分段写作 ${id}`,
      phase: id === "coordinator" ? "waiting" : "running",
      summary:
        id === "coordinator" ? "TEST 等待分段交付" : "TEST 正在写作并保存正文",
    }));
    f.runtime.activity.threads.push(...branches, {
      ...original,
      id: "TEST-unrelated-running",
      title: "TEST 同会话无关执行",
      objectiveId: "different-goal",
    });
    goal.threadIds = [original.id, ...branches.map((thread) => thread.id)];
    await page.route("**/api/executions?*", (route) => {
      const selectedId = new URL(route.request().url()).searchParams.get(
        "threadId",
      );
      const selected = f.runtime.activity.threads.find(
        (thread) => thread.id === selectedId,
      )!;
      const threads =
        selectedId === "TEST-parallel-coordinator" ? branches : [selected];
      return route.fulfill({
        json: {
          jobs: [],
          approvals: [],
          limit: 100,
          threadsTruncated: false,
          threads: threads.map((thread) => ({
            id: thread.id,
            sessionId: thread.sessionId,
            contextId: thread.contextId,
            rootId: thread.rootId,
            parentThreadId: thread.parentThreadId ?? null,
            title: thread.title,
            phase: thread.phase,
            lifecycle: thread.lifecycle,
            revision: thread.revision,
            updatedAt: thread.updatedAt,
          })),
        },
      });
    });
    await f.refresh();
    await f.panel
      .locator(`.execution-activity-row[data-thread-id="${original.id}"]`)
      .click();
    const related = f.panel.getByRole("region", {
      name: "关联目标",
      exact: true,
    });
    const heading = related.locator(".subject-objective-heading");
    await expect(heading).toContainText("5 个关联执行 · 4 条执行中");
    await heading.click();
    const rows = related.locator(".subject-objective-execution");
    await expect(rows).toHaveCount(5);
    await expect(
      related.getByRole("button", {
        name: "TEST 统稿协调线程 · 等待条件（原因待核对）",
        exact: true,
      }),
    ).toBeVisible();
    for (const id of ["D", "E", "F"])
      await expect(
        related.getByRole("button", {
          name: `TEST 分段写作 ${id} · 执行中`,
          exact: true,
        }),
      ).toBeVisible();
    await expect(
      related.getByText("TEST 同会话无关执行", { exact: true }),
    ).toHaveCount(0);
    await f.panel.screenshot({
      path: info.outputPath(`four-parallel-${colorScheme}.png`),
    });
    branches[3]!.lifecycle = "completed";
    branches[3]!.phase = "idle";
    await f.refresh();
    await expect(heading).toHaveAttribute("aria-expanded", "true");
    await expect(heading).toContainText("5 个关联执行 · 3 条执行中");
    await expect(
      related.getByRole("button", {
        name: "TEST 分段写作 F · 已结束",
        exact: true,
      }),
    ).toBeVisible();
    const completedGlyph = related
      .getByRole("button", { name: "TEST 分段写作 F · 已结束", exact: true })
      .locator('.execution-thread-state[data-status="ended"]');
    const colours = await completedGlyph.evaluate((element) => {
      const actual = getComputedStyle(element).color;
      const token = document.createElement("span");
      token.style.color = "var(--success-ink)";
      element.append(token);
      const expected = getComputedStyle(token).color;
      token.remove();
      return { actual, expected };
    });
    expect(colours.actual).toBe(colours.expected);
    await related
      .getByRole("button", { name: "TEST 分段写作 E · 执行中", exact: true })
      .click();
    await expect(f.panel.locator(".execution-origin-title")).toHaveText(
      "TEST 分段写作 E",
    );
    await expect(f.panel.locator(".execution-origin-status")).toHaveAttribute(
      "data-status",
      "running",
    );
    await expect(
      f.panel.locator("[data-execution-thread='TEST-parallel-E']"),
    ).toHaveCount(1);
    await expect(
      f.panel.locator("[data-execution-thread='TEST-parallel-D']"),
    ).toHaveCount(0);
    await expect(await openInput(page)).toHaveValue(f.draft);
    expect(f.writes).toEqual([]);
  });

test("活动首页直接显示真实目标，跨工作面及无执行目标不丢，关联仍核对完整原身份", async ({
  page,
}) => {
  const f = await prepare(page);
  const goals = f.panel.getByRole("region", { name: "目标", exact: true });
  const related = goals.locator('[data-objective-id="TEST-related-goal"]');
  const empty = goals.locator('[data-objective-id="TEST-no-thread-goal"]');
  await expect(goals).toBeVisible();
  await expect(empty).toBeVisible();
  await empty.getByRole("button").click();
  await expect(empty).toContainText("当前概览中没有关联执行");
  await related.getByRole("button", { name: /TEST 保证报告/ }).click();
  await expect(related.getByRole("status")).toHaveText(
    "等待条件（原因待核对）",
  );
  f.runtime.activity.objectives[0]!.waitKinds = ["user_input"];
  await f.refresh();
  await expect(related.getByRole("status")).toHaveText("等待你回复");
  await expect(related.locator(".subject-objective-heading")).toContainText(
    "等待你回复",
  );
  await expect(
    related.locator(".subject-objective-detail > button"),
  ).toHaveCount(1);
  await expect(related).not.toContainText("TEST 不应关联");
  await expect(related).not.toContainText("TEST 普通聊天");
  const heading = related.locator(".subject-objective-heading");
  await expect(heading).toHaveAttribute("aria-expanded", "true");
  f.runtime.activity.objectives[0]!.readiness = "runnable";
  await f.refresh();
  await expect(heading).toHaveAttribute("aria-expanded", "true");
  await expect(related.getByRole("status")).toHaveText("等待推进");
  await heading.click();
  await expect(heading).toHaveAttribute("aria-expanded", "false");
  await heading.focus();
  await page.keyboard.press("Enter");
  await expect(heading).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Space");
  await expect(heading).toHaveAttribute("aria-expanded", "false");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await expect(related).toBeVisible();
  await expect(empty).toBeVisible();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await heading.click();
  await related
    .getByRole("button", {
      name: "生成 BailingHub 评估文档并导出 PDF · 已结束",
      exact: true,
    })
    .click();
  await expect(
    f.panel.getByRole("region", { name: "关联目标", exact: true }),
  ).toBeVisible();
  await expect(
    f.panel.locator('[data-objective-id="TEST-no-thread-goal"]'),
  ).toHaveCount(0);
  await expect
    .poll(() => f.queries.at(-1)?.get("threadId"))
    .toBe("TEST-related-thread");
  expect(f.queries.at(-1)?.get("conversationId")).toBe(f.source.conversationId);
  expect(f.queries.at(-1)?.get("inputId")).toBe(f.source.inputId);
  await expect(await openInput(page)).toHaveValue(f.draft);
  await f.panel
    .getByRole("button", { name: "返回活动列表", exact: true })
    .click();
  await expect(goals).toBeVisible();
  await page.reload();
  await expect(goals).toBeVisible();
  await expect(empty).toBeVisible();
  await expect(await openInput(page)).toHaveValue(f.draft);
  expect(f.writes).toEqual([]);
});

test("无目标不造空块，截断与旧状态如实说明，不用新状态抢走展开选择", async ({
  page,
}) => {
  const f = await prepare(page);
  const goals = f.panel.getByRole("region", { name: "目标", exact: true });
  const related = f.panel.locator('[data-objective-id="TEST-related-goal"]');
  const heading = related.locator(".subject-objective-heading");
  await heading.click();
  f.runtime.connected = false;
  f.runtime.activity.available = false;
  await f.refresh();
  await expect(related.getByRole("status")).toHaveText("目标状态待核对");
  await expect(heading).toHaveAttribute("aria-expanded", "true");
  f.runtime.connected = true;
  f.runtime.activity.available = true;
  for (const status of [
    "paused",
    "blocked",
    "completed",
    "cancelled",
    "failed",
    "TEST-unknown",
  ]) {
    f.runtime.activity.objectives[0]!.status = status;
    await f.refresh();
    await expect(heading).toHaveAttribute("aria-expanded", "true");
    await expect(related.getByRole("status")).toHaveText(
      {
        paused: "已暂停",
        blocked: "需要处理",
        completed: "已完成",
        cancelled: "已停止",
        failed: "失败",
      }[status] ?? "状态待核对",
    );
  }
  f.runtime.activity.objectives.length = 0;
  await f.refresh();
  await expect(goals).toHaveCount(0);
  f.runtime.activity.objectivesTruncated = true;
  await f.refresh();
  await expect(goals).toContainText("目标概览尚不完整");
  await expect(goals.locator(".subject-objective")).toHaveCount(0);
  await expect(await openInput(page)).toHaveValue(f.draft);
  expect(f.writes).toEqual([]);
});

test("完成、停止、失败目标退出当前区，历史默认折叠且仍可查看原执行；未知目标不隐藏", async ({
  page,
}) => {
  const f = await prepare(page);
  const original = f.runtime.activity.objectives[0]!;
  original.status = "completed";
  for (const status of ["cancelled", "failed", "TEST-unknown"])
    f.runtime.activity.objectives.push({
      ...original,
      id: `TEST-goal-${status}`,
      title: `TEST 目标状态 ${status}`,
      status,
    });
  await f.refresh();
  const current = f.panel.getByRole("region", { name: "目标", exact: true });
  const history = f.panel.locator(".subject-objective-history");
  const ended = f.panel.getByRole("region", {
    name: "已结束目标",
    exact: true,
  });
  await expect(current.locator(".subject-objective")).toHaveCount(2);
  await expect(current).toContainText("TEST 尚无执行的其他工作面目标");
  await expect(current).toContainText("TEST 目标状态 TEST-unknown");
  await expect(history).not.toHaveAttribute("open");
  await expect(history.locator(":scope > summary")).toHaveText("已结束目标3");
  await expect(ended).not.toBeVisible();
  await history.locator(":scope > summary").click();
  await expect(ended.locator(".subject-objective")).toHaveCount(3);
  for (const label of ["已完成", "已停止", "失败"])
    await expect(ended).toContainText(label);
  const goal = ended.locator('[data-objective-id="TEST-related-goal"]');
  await goal.locator(".subject-objective-heading").click();
  await goal
    .getByRole("button", {
      name: "生成 BailingHub 评估文档并导出 PDF · 已结束",
      exact: true,
    })
    .click();
  const scoped = f.panel.getByRole("region", { name: "关联目标", exact: true });
  await expect(scoped).toContainText("TEST 保证报告内容可核对");
  await expect(scoped).toContainText("已完成");
  await expect(f.panel.locator(".subject-objective-history")).toHaveCount(0);
  await f.panel
    .getByRole("button", { name: "返回活动列表", exact: true })
    .click();
  await expect(history).toHaveAttribute("open");
  await page.reload();
  await expect(history).toHaveAttribute("open");
  await history.locator(":scope > summary").focus();
  await page.keyboard.press("Enter");
  await expect(history).not.toHaveAttribute("open");
  original.updatedAt = "2026-10-13T12:00:00Z";
  await f.refresh();
  await expect(history).not.toHaveAttribute("open");
  await page.reload();
  await expect(history).not.toHaveAttribute("open");
  await expect(await openInput(page)).toHaveValue(f.draft);
  expect(f.writes).toEqual([]);
});

test("正在查看的目标结束时保留展开阅读，手动收起后新状态不再展开历史", async ({
  page,
}) => {
  const f = await prepare(page);
  const goal = f.panel.locator('[data-objective-id="TEST-related-goal"]');
  await goal.locator(".subject-objective-heading").click();
  f.runtime.activity.objectives[0]!.status = "completed";
  await f.refresh();
  const history = f.panel.locator(".subject-objective-history");
  await expect(history).toHaveAttribute("open");
  await expect(goal.getByRole("status")).toHaveText("已完成");
  await history.locator(":scope > summary").click();
  await expect(history).not.toHaveAttribute("open");
  f.runtime.activity.objectives[0]!.status = "failed";
  await f.refresh();
  await expect(history).not.toHaveAttribute("open");
  await history.locator(":scope > summary").click();
  await expect(goal.locator(".subject-objective-heading")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(await openInput(page)).toHaveValue(f.draft);
  expect(f.writes).toEqual([]);
});

test("窄侧栏标题、摘要和来源在本行宽度内换行或省略，明暗四主题的正常结束对勾与成功步骤同绿", async ({
  page,
}, info) => {
  const f = await prepare(page);
  const row = f.panel.locator('[data-thread-id="TEST-related-thread"]');
  await expect(row.locator(".execution-activity-project")).toContainText(
    f.origin,
  );
  for (const mode of ["亮色", "暗色"])
    for (const accent of ["电光青", "鸢尾紫", "暖珊瑚", "纯单色"]) {
      await openSettings(page, "外观");
      await page.getByRole("button", { name: mode, exact: true }).click();
      await page.getByRole("button", { name: accent, exact: true }).click();
      await page.keyboard.press("Escape");
      await page.evaluate(() => {
        const sidebar =
          document.querySelector<HTMLElement>(".subject-sidebar")!;
        sidebar.style.width = "280px";
        sidebar.style.flexBasis = "280px";
      });
      const bounds = await row.evaluate((element) => {
        const body = element.querySelector<HTMLElement>(
          ".execution-activity-body",
        )!;
        const b = body.getBoundingClientRect(),
          r = element.getBoundingClientRect();
        return {
          row: [r.left, r.right],
          body: [b.left, b.right],
          children: [...body.children].map((child) => {
            const box = child.getBoundingClientRect();
            return [box.left, box.right];
          }),
          scroll: body.scrollWidth,
          width: body.clientWidth,
          icon: getComputedStyle(
            element.querySelector(".execution-activity-icon")!,
          ).color,
        };
      });
      expect(bounds.body[1]).toBeLessThanOrEqual(bounds.row[1]!);
      for (const [left, right] of bounds.children) {
        expect(left).toBeGreaterThanOrEqual(bounds.body[0]! - 1);
        expect(right).toBeLessThanOrEqual(bounds.body[1]! + 1);
      }
      expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1);
      expect(bounds.icon).toBe(
        mode === "亮色" ? "rgb(24, 125, 61)" : "rgb(131, 217, 155)",
      );
      await expect(row.locator("strong")).toHaveCSS("-webkit-line-clamp", "2");
      await expect(row.locator(".execution-activity-summary")).toHaveCSS(
        "text-overflow",
        "ellipsis",
      );
      const failure =
        mode === "亮色" ? "rgb(167, 42, 50)" : "rgb(248, 169, 173)";
      await expect(
        f.panel.locator(
          '[data-thread-id="TEST-status-failed"] .execution-activity-icon',
        ),
      ).toHaveCSS("color", failure);
      await expect(
        f.panel.locator(
          '[data-thread-id="TEST-status-cancelled"] .execution-activity-icon',
        ),
      ).not.toHaveCSS("color", bounds.icon);
      await f.panel.screenshot({
        path: info.outputPath(`goals-narrow-${mode}-${accent}.png`),
      });
      await row.click();
      await expect(
        f.panel.locator(".execution-origin-status[data-status=ended] > svg"),
      ).toHaveCSS("color", bounds.icon);
      await expect(f.panel.locator(".job-status.succeeded")).toHaveCSS(
        "color",
        bounds.icon,
      );
      await expect(f.panel.locator(".job-status.failed")).toHaveCSS(
        "color",
        failure,
      );
      await f.panel
        .getByRole("button", { name: "返回活动列表", exact: true })
        .click();
      await f.panel.locator('[data-thread-id="TEST-status-failed"]').click();
      await expect(
        f.panel.locator('.execution-origin-status[data-status="failed"]'),
      ).toHaveCSS("color", failure);
      await f.panel
        .getByRole("button", { name: "返回活动列表", exact: true })
        .click();
    }
  await page.setViewportSize({ width: 390, height: 820 });
  await page.evaluate(() => {
    const sidebar = document.querySelector<HTMLElement>(".subject-sidebar")!;
    sidebar.style.width = "";
    sidebar.style.flexBasis = "";
  });
  await page.evaluate(() => (document.body.style.zoom = "2"));
  const overview = await f.panel.evaluate((element) => ({
    scroll: element.scrollWidth,
    width: element.clientWidth,
  }));
  expect(overview.scroll).toBeLessThanOrEqual(overview.width + 1);
  await expect(await openInput(page)).toHaveValue(f.draft);
  expect(f.writes).toEqual([]);
});

test.describe("目标入口触控", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 820 },
  });
  test("目标及关联执行有完整触控命中高度，不创建或控制工作", async ({
    page,
  }) => {
    const f = await prepare(page);
    const goal = f.panel.locator('[data-objective-id="TEST-related-goal"]');
    const heading = goal.locator(".subject-objective-heading");
    await heading.tap();
    const child = goal.locator(".subject-objective-detail > button");
    for (const button of [heading, child]) {
      const b = await button.boundingBox();
      expect(b!.height).toBeGreaterThanOrEqual(44);
    }
    await child.tap();
    await expect(
      f.panel.getByRole("region", { name: "关联目标", exact: true }),
    ).toBeVisible();
    await expect(await openInput(page)).toHaveValue(f.draft);
    expect(f.writes).toEqual([]);
  });
});
