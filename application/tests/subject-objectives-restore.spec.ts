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
import { arrangementTime } from "../apps/web/src/subject-schedules-model.js";

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
      revision: 1,
      controlAllowed: true,
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
      revision: 1,
      controlAllowed: true,
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

test("目标行的展开与查看紧邻，密度有上界而不是只检查按钮不越界", async ({
  page,
}, info) => {
  const f = await prepare(page);
  const target = f.runtime.activity.objectives[0]!;
  target.title =
    "TEST 完整目标保持两行摘要，查看与展开紧邻，不用大片空白挤走可读内容。".repeat(
      4,
    );
  target.waitKinds = ["thread_group"];
  await f.refresh();
  const goal = f.panel.locator('[data-objective-id="TEST-related-goal"]');
  const heading = goal.locator(".subject-objective-heading");
  const view = goal.getByRole("button", { name: "查看目标", exact: true });
  await expect(heading.locator("strong")).toHaveText(target.title);
  for (const [width, zoom] of [
    [1440, 1],
    [760, 1],
    [390, 1],
    [760, 2],
  ] as const) {
    await page.setViewportSize({ width, height: 960 });
    await page.evaluate(
      (value) => (document.body.style.zoom = String(value)),
      zoom,
    );
    const geometry = await goal.evaluate((element) => {
      const scale =
        Number.parseFloat(getComputedStyle(document.body).zoom) || 1;
      const trigger = element.querySelector<HTMLElement>(
        ".subject-objective-heading",
      )!;
      const arrow = trigger
        .querySelector(":scope > svg:last-child")!
        .getBoundingClientRect();
      const action = element
        .querySelector<HTMLElement>(".subject-objective-view")!
        .getBoundingClientRect();
      const row = element
        .querySelector(".subject-objective-row")!
        .getBoundingClientRect();
      const text = trigger.querySelector("strong")!.getBoundingClientRect();
      const metadata = trigger.querySelector("small")!.getBoundingClientRect();
      const css = getComputedStyle(trigger);
      return {
        centerGap:
          (action.left + action.right - arrow.left - arrow.right) / 2 / scale,
        actionWidth: action.width / scale,
        actionHeight: action.height / scale,
        rowHeight: row.height / scale,
        metadataGap: (metadata.top - text.bottom) / scale,
        padding:
          Number.parseFloat(css.paddingTop) +
          Number.parseFloat(css.paddingBottom),
        overflow: element.scrollWidth > element.clientWidth + 1,
      };
    });
    expect(geometry.centerGap).toBeGreaterThan(0);
    expect(geometry.centerGap).toBeLessThanOrEqual(26);
    expect(geometry.actionWidth).toBeCloseTo(24, 0);
    expect(geometry.actionHeight).toBeCloseTo(24, 0);
    expect(geometry.padding).toBeLessThanOrEqual(8);
    expect(geometry.metadataGap).toBeLessThanOrEqual(3);
    expect(geometry.overflow).toBe(false);
    if (width === 1440 && zoom === 1)
      expect(geometry.rowHeight).toBeLessThanOrEqual(72);
    await f.panel.screenshot({
      path: info.outputPath(`objective-row-compact-${width}-${zoom}.png`),
    });
  }
  await view.click();
  await expect(
    page.getByRole("dialog", { name: "目标", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(view).toBeFocused();
  await expect(await openInput(page)).toHaveValue(f.draft);
  expect(f.writes).toEqual([]);
});

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
        name: "TEST 统稿协调线程 · 等待中（未提供具体原因）",
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
  await empty.locator(".subject-objective-heading").click();
  await expect(empty).toContainText("当前概览中没有关联执行");
  await related.getByRole("button", { name: /TEST 保证报告/ }).click();
  await expect(related.getByRole("status")).toHaveText(
    "等待中（未提供具体原因）",
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

for (const colorScheme of ["light", "dark"] as const)
  test(`目标全文悬停与独立查看弹窗可读，展开不铺长文且窄窗不越界 ${colorScheme}`, async ({
    page,
  }, info) => {
    await page.emulateMedia({ colorScheme });
    const f = await prepare(page);
    await openSettings(page, "外观");
    await page
      .getByRole("button", {
        name: colorScheme === "dark" ? "暗色" : "亮色",
        exact: true,
      })
      .click();
    await page.keyboard.press("Escape");
    const full =
      Array.from(
        { length: 16 },
        (_, index) =>
          `TEST 第 ${index + 1} 段完整目标：持续核查真实资料、资格与付款条件，保留既有工作，不发送、不重跑。`,
      ).join("\n\n") +
      "\nTEST 全文尾句 " +
      "long-unbroken-source-".repeat(18);
    f.runtime.activity.objectives[0]!.title = full;
    await f.refresh();
    const goal = f.panel.locator('[data-objective-id="TEST-related-goal"]');
    const heading = goal.locator(".subject-objective-heading");
    const title = heading.locator("strong");
    await expect(title).toHaveText(full);
    const clipped = await title.evaluate(
      (node) => node.scrollHeight > node.clientHeight,
    );
    expect(clipped).toBe(true);
    const before = await heading.boundingBox();
    await heading.hover();
    const preview = page.getByRole("tooltip");
    await expect(preview).toBeVisible();
    await expect(preview).toHaveText(full);
    expect(await heading.boundingBox()).toEqual(before);
    await preview.hover();
    await page.mouse.wheel(0, 240);
    await expect
      .poll(() => preview.evaluate((node) => node.scrollTop))
      .toBeGreaterThan(0);
    await expect(preview).toBeVisible();
    await page.screenshot({
      path: info.outputPath(`objective-full-text-${colorScheme}.png`),
    });
    await page.keyboard.press("Escape");
    await expect(preview).toHaveCount(0);
    await heading.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(heading).toBeFocused();
    await expect(preview).toHaveText(full);
    await page.keyboard.press("Escape");
    await expect(heading).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(heading).toHaveAttribute("aria-expanded", "true");
    expect(
      await title.evaluate((node) => node.scrollHeight > node.clientHeight),
    ).toBe(true);
    await expect(goal.locator(".subject-objective-statement")).toHaveCount(0);
    const view = goal.getByRole("button", { name: "查看目标", exact: true });
    await view.click();
    const dialog = page.getByRole("dialog", { name: "目标", exact: true });
    await expect(dialog).toBeVisible();
    const statement = dialog.getByRole("region", {
      name: "完整目标",
      exact: true,
    });
    await expect(statement).toHaveText(full);
    await statement.focus();
    await page.keyboard.press("End");
    await expect
      .poll(() => statement.evaluate((node) => node.scrollTop))
      .toBeGreaterThan(0);
    await page.screenshot({
      path: info.outputPath(`objective-view-${colorScheme}.png`),
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(view).toBeFocused();
    await heading.focus();
    await page.keyboard.press("Space");
    await expect(heading).toHaveAttribute("aria-expanded", "false");
    for (const [width, zoom] of [
      [760, 1],
      [390, 1],
      [390, 2],
    ] as const) {
      await page.setViewportSize({ width, height: 820 });
      await page.evaluate(
        (value) => (document.body.style.zoom = String(value)),
        zoom,
      );
      await heading.hover();
      await expect(preview).toHaveText(full);
      const bounds = await preview.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(821);
      expect(
        await preview.evaluate(
          (node) => node.scrollWidth <= node.clientWidth + 1,
        ),
      ).toBe(true);
      await page.keyboard.press("Escape");
      await view.click();
      await expect(
        dialog.getByRole("region", { name: "完整目标", exact: true }),
      ).toHaveText(full);
      const modal = await dialog.boundingBox();
      expect(modal!.x).toBeGreaterThanOrEqual(0);
      expect(modal!.y).toBeGreaterThanOrEqual(0);
      expect(modal!.x + modal!.width).toBeLessThanOrEqual(width + 1);
      expect(modal!.y + modal!.height).toBeLessThanOrEqual(821);
      await page.keyboard.press("Escape");
    }
    await page.evaluate(() => (document.body.style.zoom = "1"));
    await expect(await openInput(page)).toHaveValue(f.draft);
    expect(f.writes).toEqual([]);
  });

test("目标子任务展示自己的等待类别和确切定时时间，刷新或断线不伪称等待用户", async ({
  page,
}) => {
  const f = await prepare(page);
  const child = f.runtime.activity.threads[0]!;
  Object.assign(child, {
    lifecycle: "open",
    phase: "waiting",
    waitKinds: ["timer"],
    waitUntil: "2026-10-23T01:00:00Z",
  });
  f.runtime.activity.objectives[0]!.waitKinds = ["thread_group"];
  await f.refresh();
  const goal = f.panel.locator('[data-objective-id="TEST-related-goal"]');
  await goal.locator(".subject-objective-heading").click();
  const reason = goal.locator(".subject-objective-execution-copy > small");
  await expect(reason).toHaveText(
    `等待定时触发 · ${arrangementTime(child.waitUntil)}`,
  );
  await expect(goal).not.toContainText("原因待核对");
  Object.assign(child, { waitKinds: ["permission"], waitUntil: undefined });
  await f.refresh();
  await expect(reason).toHaveText("等待你批准");
  Object.assign(child, { waitKinds: ["user_input"] });
  await f.refresh();
  await expect(reason).toHaveText("等待你回复");
  Object.assign(child, { phase: "running" });
  await f.refresh();
  await expect(reason).toHaveText("执行中");
  Object.assign(f.runtime, { connected: false });
  await f.refresh();
  await expect(reason).toHaveText("状态待核对");
  await expect(await openInput(page)).toHaveValue(f.draft);
  expect(f.writes).toEqual([]);
});

for (const appearance of ["light", "dark"] as const)
  test(`目标弹窗按阅读与确认分层，动作不分散，窄窗缩放保留全文与焦点 ${appearance}`, async ({
    page,
  }, info) => {
    const f = await prepare(page);
    const target = f.runtime.activity.objectives[0]!;
    target.title = [
      "TEST 持续核查公开资料与真实条件，把可追溯、可行动的结果留在同一份记录中。",
      "每轮优先阅读原始材料，区分已经核实的事实、仍待确认的条件和暂不可访问的来源。记录核验时间与适用范围，不把搜索摘要、推测或第三方陈述当成已完成的结果。",
      "沿用既有工作范围和检查安排，不重复创建任务，不自动对外发送消息。出现重要变化时说明变化、依据和下一步；没有新增信息时保留本轮记录，不重复通知。",
      "保留已有内容、原始引用与执行历史。遇到资格、权限、付款条件或访问限制时如实说明，不绕过限制，也不以局部失败推断所有来源不可用。",
      "TEST 最后一段仍可完整阅读与复制；暂停目标只停止后续自动推进，不撤回已经发生的操作。",
    ].join("\n\n");
    target.waitKinds = ["thread_group"];
    await f.refresh();
    const view = f.panel
      .locator('[data-objective-id="TEST-related-goal"]')
      .getByRole("button", { name: "查看目标", exact: true });
    await page
      .locator(".app")
      .evaluate(
        (node, value) => node.setAttribute("data-appearance", value),
        appearance,
      );
    await view.click();
    const dialog = page.getByRole("dialog", { name: "目标", exact: true });
    const body = dialog.getByRole("region", { name: "完整目标" });
    const remove = dialog.getByRole("button", { name: "删除", exact: true });
    for (const [width, zoom] of [
      [1440, 1],
      [760, 1],
      [390, 1],
      [760, 2],
    ] as const) {
      await page.setViewportSize({ width, height: 820 });
      await page.evaluate(
        (value) => (document.body.style.zoom = String(value)),
        zoom,
      );
      for (const accent of ["cyan", "iris", "coral", "mono"]) {
        await page
          .locator(".app")
          .evaluate(
            (node, value) => node.setAttribute("data-accent", value),
            accent,
          );
        await expect(body).toHaveText(target.title);
        const layout = await dialog.evaluate((node) => {
          const scale =
            Number.parseFloat(getComputedStyle(document.body).zoom) || 1;
          const actions = [
            ...node.querySelectorAll<HTMLElement>("footer > button"),
          ];
          const a = actions[0]!.getBoundingClientRect(),
            b = actions[1]!.getBoundingClientRect();
          const body = node.querySelector<HTMLElement>(
            ".subject-objective-dialog-text",
          )!;
          const footer = node.querySelector("footer")!.getBoundingClientRect();
          const header = node.querySelector("header")!.getBoundingClientRect();
          const rect = node.getBoundingClientRect();
          const css = getComputedStyle(body);
          return {
            gap:
              (Math.abs(b.top - a.top) < 1
                ? b.left - a.right
                : b.top - a.bottom) / scale,
            heights: actions.map(
              (action) => action.getBoundingClientRect().height / scale,
            ),
            headerHasStatus: !!node.querySelector("header [role=status]"),
            statusWhiteSpace: getComputedStyle(
              node.querySelector("header [role=status]")!,
            ).whiteSpace,
            bodyFont: css.fontSize,
            bodyLine: css.lineHeight,
            bodyPadding: css.paddingLeft,
            footerGap:
              (footer.top - body.getBoundingClientRect().bottom) / scale,
            horizontalOverflow: node.scrollWidth > node.clientWidth + 1,
            bounded:
              rect.top >= 0 &&
              rect.bottom <= innerHeight + 1 &&
              rect.left >= 0 &&
              rect.right <= innerWidth + 1,
            readableWidth:
              rect.width / scale >= Math.min(280, innerWidth / scale - 32) - 1,
            headerVisible: header.top >= 0,
            footerVisible: footer.bottom <= innerHeight + 1,
          };
        });
        expect(layout.gap).toBeGreaterThanOrEqual(6);
        expect(layout.gap).toBeLessThanOrEqual(12);
        for (const height of layout.heights) expect(height).toBeCloseTo(32, 2);
        expect(layout.headerHasStatus).toBe(true);
        expect(layout.statusWhiteSpace).toBe("normal");
        expect(layout.bodyFont).toBe("14px");
        expect(layout.bodyLine).toBe("24.5px");
        expect(layout.bodyPadding).toBe("8px");
        // Fractional dialog centering can differ by <0.001 CSS px.
        expect(Math.round(layout.footerGap * 1000) / 1000).toBeLessThanOrEqual(
          12,
        );
        expect(layout.horizontalOverflow).toBe(false);
        expect(layout.bounded).toBe(true);
        expect(layout.readableWidth).toBe(true);
        expect(layout.headerVisible && layout.footerVisible).toBe(true);
        await expect(remove).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
        if (accent === "cyan")
          await dialog.screenshot({
            path: info.outputPath(
              `goal-reading-${appearance}-${width}-${zoom}.png`,
            ),
          });
      }
    }
    await remove.click();
    const confirmation = page.getByRole("dialog", {
      name: "删除这个目标？",
      exact: true,
    });
    const keep = confirmation.getByRole("button", {
      name: "保留目标",
      exact: true,
    });
    await expect(keep).toBeFocused();
    const warning = confirmation.locator(".subject-objective-delete-warning");
    expect(
      await warning.evaluate(
        (node) =>
          !!(
            node.compareDocumentPosition(
              node.parentElement!.querySelector(
                ".subject-objective-dialog-text",
              )!,
            ) & Node.DOCUMENT_POSITION_FOLLOWING
          ),
      ),
    ).toBe(true);
    await expect(confirmation).toHaveAttribute(
      "aria-describedby",
      (await warning.getAttribute("id")) ?? "",
    );
    await expect(
      confirmation.getByRole("button", { name: "确认删除", exact: true }),
    ).toHaveClass(/\bdanger\b/);
    await confirmation.screenshot({
      path: info.outputPath(`goal-confirm-${appearance}-zoom.png`),
    });
    // A short, zoomed window may scroll the modal as a whole, but must not
    // shrink the original goal to an empty padding-only scroll region.
    await page.setViewportSize({ width: 760, height: 400 });
    // ResizeObserver updates the shared native-modal frame after viewport
    // reflow; observe its settled geometry rather than racing the first frame.
    await expect
      .poll(() =>
        confirmation.evaluate((node) => {
          const body = node.querySelector<HTMLElement>(
            ".subject-objective-dialog-text",
          )!;
          const css = getComputedStyle(body);
          const rect = node.getBoundingClientRect();
          return {
            readable:
              body.clientHeight -
                Number.parseFloat(css.paddingTop) -
                Number.parseFloat(css.paddingBottom) >=
              Number.parseFloat(css.lineHeight) - 1,
            bounded: rect.top >= 0 && rect.bottom <= innerHeight + 1,
          };
        }),
      )
      .toEqual({ readable: true, bounded: true });
    await keep.scrollIntoViewIfNeeded();
    await expect(keep).toBeInViewport();
    await confirmation.screenshot({
      path: info.outputPath(`goal-confirm-${appearance}-short-window.png`),
    });
    await keep.click();
    await expect(remove).toBeFocused();
    await page.evaluate(() => (document.body.style.zoom = "1"));
    await page.setViewportSize({ width: 1440, height: 960 });
    target.title = "TEST 只核验一次并保存结果。";
    await f.refresh();
    await expect(body).toHaveText(target.title);
    const short = await dialog.boundingBox();
    expect(short!.height).toBeLessThanOrEqual(180);
    await dialog.screenshot({
      path: info.outputPath(`goal-short-${appearance}.png`),
    });
    await page.keyboard.press("Escape");
    await expect(view).toBeFocused();
    await expect(await openInput(page)).toHaveValue(f.draft);
    expect(f.writes).toEqual([]);
  });

test("查看不发送，暂停恢复沿同一目标修订号；删除须确认，冲突不覆盖，历史及草稿保留", async ({
  page,
}, info) => {
  const f = await prepare(page);
  const target = f.runtime.activity.objectives[0]!;
  const originalOther = structuredClone(f.runtime.activity.objectives[1]);
  const attempts: any[] = [];
  let accepted = 0;
  await page.route("**/api/objectives/control", async (route) => {
    const command = route.request().postDataJSON();
    attempts.push(command);
    expect(command.objectiveId).toBe(target.id);
    expect(command.projectId).toBe(target.projectId);
    expect(command.conversationId).toBe(target.conversationId);
    if (command.revision !== target.revision)
      return route.fulfill({
        status: 409,
        json: {
          message: "目标已发生变化，请核对最新状态后再操作。",
          code: "conflict",
        },
      });
    accepted++;
    target.status =
      command.action === "pause"
        ? "paused"
        : command.action === "resume"
          ? "active"
          : "cancelled";
    target.revision!++;
    return route.fulfill({
      json: { objectiveId: target.id, action: command.action },
    });
  });
  const row = f.panel.locator('[data-objective-id="TEST-related-goal"]');
  await row.getByRole("button", { name: "查看目标", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "目标", exact: true });
  await expect(dialog.getByRole("region", { name: "完整目标" })).toHaveText(
    target.title,
  );
  await expect(row.locator(".subject-objective-heading")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(attempts).toEqual([]);
  await expect(
    dialog.getByRole("button", { name: "删除", exact: true }),
  ).toHaveCSS("color", "rgb(167, 42, 50)");
  await dialog.getByRole("button", { name: "暂停", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("已暂停");
  await dialog.screenshot({ path: info.outputPath("goal-paused.png") });
  await dialog.getByRole("button", { name: "恢复", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "暂停", exact: true }),
  ).toBeEnabled();
  expect(attempts.map((command) => [command.action, command.revision])).toEqual(
    [
      ["pause", 1],
      ["resume", 2],
    ],
  );
  await dialog.getByRole("button", { name: "删除", exact: true }).click();
  const confirmation = page.getByRole("dialog", {
    name: "删除这个目标？",
    exact: true,
  });
  await expect(
    confirmation.getByRole("button", { name: "保留目标", exact: true }),
  ).toBeFocused();
  await expect(confirmation).toContainText("保留已有内容和执行记录");
  await confirmation.screenshot({
    path: info.outputPath("goal-delete-confirmation.png"),
  });
  expect(accepted).toBe(2);
  await confirmation
    .getByRole("button", { name: "保留目标", exact: true })
    .click();
  expect(accepted).toBe(2);
  await expect(
    dialog.getByRole("button", { name: "删除", exact: true }),
  ).toBeFocused();
  await dialog.getByRole("button", { name: "删除", exact: true }).click();
  target.revision = 9;
  target.title = "TEST 目标内容已在别处修订，不能按旧确认删除";
  await f.refresh();
  await expect(
    confirmation.getByRole("region", { name: "完整目标" }),
  ).not.toHaveText(target.title);
  await confirmation
    .getByRole("button", { name: "确认删除", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("目标已发生变化");
  await dialog.screenshot({
    path: info.outputPath("goal-revision-conflict.png"),
  });
  await expect(dialog.getByRole("region", { name: "完整目标" })).toHaveText(
    target.title,
  );
  expect(attempts.at(-1).revision).toBe(3);
  expect(accepted).toBe(2);
  await dialog.getByRole("button", { name: "删除", exact: true }).click();
  await confirmation
    .getByRole("button", { name: "确认删除", exact: true })
    .click();
  await expect(confirmation).toHaveCount(0);
  expect(attempts.at(-1).revision).toBe(9);
  expect(accepted).toBe(3);
  expect(f.runtime.activity.objectives[1]).toEqual(originalOther);
  await expect(f.panel.locator(".subject-objective-history")).toBeVisible();
  await expect(await openInput(page)).toHaveValue(f.draft);
  expect(f.runtime.activity.threads[0]!.lifecycle).toBe("completed");
  expect(f.writes.every((url) => url.endsWith("/api/objectives/control"))).toBe(
    true,
  );
});

test("只读或断线仍能查看完整目标，但不能暂停恢复或删除", async ({
  page,
}, info) => {
  const f = await prepare(page);
  const target = f.runtime.activity.objectives[0]!;
  target.controlAllowed = false;
  await f.refresh();
  await f.panel
    .locator('[data-objective-id="TEST-related-goal"]')
    .getByRole("button", { name: "查看目标", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "目标", exact: true });
  await expect(
    dialog.getByRole("button", { name: "暂停", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "删除", exact: true }),
  ).toBeDisabled();
  await expect(dialog.getByRole("region", { name: "完整目标" })).toHaveText(
    target.title,
  );
  await dialog.screenshot({ path: info.outputPath("goal-readonly.png") });
  target.controlAllowed = true;
  f.runtime.connected = false;
  await f.refresh();
  await expect(
    dialog.getByRole("button", { name: "暂停", exact: true }),
  ).toBeDisabled();
  await expect(dialog.getByRole("status")).toHaveText("目标状态暂时无法读取");
  await dialog.screenshot({ path: info.outputPath("goal-offline.png") });
  await page.keyboard.press("Escape");
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
    const view = goal.getByRole("button", { name: "查看目标", exact: true });
    const hit = await view.boundingBox();
    expect(hit!.width).toBeGreaterThanOrEqual(44);
    expect(hit!.height).toBeGreaterThanOrEqual(44);
    await view.tap();
    await expect(
      page.getByRole("dialog", { name: "目标", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "关闭目标", exact: true }).tap();
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
