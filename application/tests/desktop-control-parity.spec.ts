import { expect, type Page } from "@playwright/test";
import {
  disconnectedRuntime,
  activitySchema,
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

const stamp = "2026-10-26T00:00:00Z";
async function fixture(page: Page) {
  const runtime: ConversationRuntime = {
    ...disconnectedRuntime,
    configured: true,
    connected: true,
    activity: activitySchema.parse({
      available: true,
      truncated: false,
      openWorkComplete: true,
      schedulesAvailable: true,
      schedulesTruncated: false,
      schedules: [],
      objectives: [],
      threads: [],
    }),
    attention: { available: true, approvals: [] },
  };
  const f = await mockPlatformConversation(page, () => ({
    inputs: [],
    runtime,
  }));
  await page.route("**/api/platform/bootstrap", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.capabilities.directedInput = true;
    await route.fulfill({ response, json: body });
  });
  const thread = {
    ...f.scope,
    id: "TEST-control-thread",
    inputId: "TEST-input",
    rootId: "TEST-root",
    sessionId: "TEST-session",
    contextId: "TEST-context",
    kind: "execution",
    title: "TEST 精确执行控制",
    summary: "TEST 仅验证界面与原始控制指令",
    phase: "running",
    lifecycle: "open",
    controlState: "active",
    continuation: {
      mode: "supplement" as const,
      inputId: "TEST-input",
      threadId: "TEST-control-thread",
      generation: 1,
    },
    continuationSource: {
      inputId: "TEST-input",
      ...f.scope,
      targetActantId: "TEST-agent",
      artifactId: null,
      artifactRevision: null,
    },
    parentThreadId: null,
    revision: 7,
    updatedAt: stamp,
  };
  runtime.activity!.threads = [thread];
  runtime.activity!.objectives = [
    {
      ...f.scope,
      inputId: thread.inputId,
      rootId: thread.rootId,
      id: "TEST-goal",
      sessionId: thread.sessionId,
      contextId: thread.contextId,
      title: "TEST 紧凑目标控制",
      status: "active",
      revision: 3,
      controlAllowed: true,
      readiness: "runnable",
      statusReason: null,
      parentId: null,
      threadIds: [thread.id],
      updatedAt: stamp,
    },
  ];
  const calls: Array<{ method: string; command: any }> = [];
  await page.route("**/api/executions?*", (route) => {
    const selected =
      runtime.activity!.threads.find(
        (value) =>
          value.id ===
          new URL(route.request().url()).searchParams.get("threadId"),
      ) ?? thread;
    return route.fulfill({
      json: {
        jobs: [],
        approvals: [],
        limit: 100,
        threads: [{ ...selected, parentThreadId: null }],
      },
    });
  });
  await page.route("**/api/executions/control", (route) => {
    const command = route.request().postDataJSON();
    calls.push({ method: "execution", command });
    if (command.action.type === "pause-thread") thread.controlState = "paused";
    if (command.action.type === "resume-thread") thread.controlState = "active";
    thread.revision++;
    return route.fulfill({ json: { accepted: true } });
  });
  await page.route("**/api/objectives/control", (route) => {
    const command = route.request().postDataJSON();
    calls.push({ method: "objective", command });
    const goal = runtime.activity!.objectives![0]!;
    goal.status = command.action === "pause" ? "paused" : "active";
    goal.revision!++;
    return route.fulfill({ json: { accepted: true } });
  });
  return { f, runtime, thread, calls };
}

test("Thread header keeps navigation and status together, preserves drafts and exposes only supplement/pause/stop", async ({
  page,
}) => {
  const x = await fixture(page);
  await page.goto("/");
  await (await openInput(page)).fill("TEST 必须保留的输入草稿");
  await openExecutionPanel(page);
  await page
    .locator(`[data-thread-id="${x.thread.id}"].execution-activity-row`)
    .click();
  const header = page.locator(".execution-detail-header");
  const actions = header.locator(".execution-control-actions");
  await expect(
    header.getByRole("button", { name: "更多执行操作", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "纠正并继续", exact: true }),
  ).toHaveCount(0);
  await expect(actions.getByRole("button")).toHaveCount(2);
  await expect(
    header.getByRole("button", { name: "补充", exact: true }),
  ).toBeVisible();
  await expect(
    header.locator(".execution-origin-actions").getByRole("button"),
  ).toHaveCount(3);
  const back = header.getByRole("button", {
    name: "返回活动列表",
    exact: true,
  });
  const status = header.locator(".execution-origin-status");
  for (const [appearance, viewport, width, zoom] of [
    ["light", 1440, 280, 1],
    ["dark", 520, 248, 1],
    ["light", 1050, 248, 2],
  ] as const) {
    await page.setViewportSize({ width: viewport, height: 960 });
    await page.evaluate(
      ({ appearance, width, zoom }) => {
        const app = document.querySelector<HTMLElement>(".app")!;
        document.documentElement.dataset.appearance = appearance;
        app.dataset.appearance = appearance;
        app.style.zoom = String(zoom);
        document.querySelector<HTMLElement>(
          ".execution-detail-header",
        )!.style.width = `${width}px`;
      },
      { appearance, width, zoom },
    );
    await settleTransitions(page);
    const top = await header.boundingBox(),
      nav = await back.boundingBox(),
      state = await status.boundingBox();
    expect(top!.height / zoom).toBeLessThanOrEqual(32);
    expect(
      Math.abs(nav!.y + nav!.height / 2 - (state!.y + state!.height / 2)),
    ).toBeLessThan(1);
    expect(state!.x).toBeGreaterThanOrEqual(nav!.x + nav!.width);
    for (const button of await header
      .locator(".execution-origin-actions")
      .getByRole("button")
      .all()) {
      const box = await button.boundingBox();
      expect(
        Math.abs(box!.y + box!.height / 2 - (nav!.y + nav!.height / 2)),
      ).toBeLessThan(1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(top!.x + top!.width + 1);
    }
    expect(
      await header.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/execution-header-${appearance}-${viewport}-${zoom}.png`,
    });
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.evaluate(() => {
    document.querySelector<HTMLElement>(".app")!.style.zoom = "1";
  });
  await settleTransitions(page);
  await actions
    .getByRole("button", { name: "暂停此执行", exact: true })
    .click();
  await expect(
    actions.getByRole("button", { name: "继续此执行", exact: true }),
  ).toBeVisible();
  expect(x.calls[0]!.command.action).toEqual({
    type: "pause-thread",
    threadId: x.thread.id,
    revision: 7,
  });
  await actions
    .getByRole("button", { name: "继续此执行", exact: true })
    .click();
  await expect(
    actions.getByRole("button", { name: "暂停此执行", exact: true }),
  ).toBeVisible();
  expect(x.calls[1]!.command.action).toEqual({
    type: "resume-thread",
    threadId: x.thread.id,
    revision: 8,
  });
  expect(x.calls).toHaveLength(2);
  await expect(await openInput(page)).toHaveValue("TEST 必须保留的输入草稿");
});

test("a rejected control cannot displace header hit targets; supplement works without its old message being loaded", async ({
  page,
}) => {
  const x = await fixture(page);
  const error = "执行状态已变化，请刷新后重新决定。";
  const messages: any[] = [],
    reads: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/history")) reads.push(request.url());
  });
  await page.route("**/api/executions/control", (route) => {
    x.calls.push({
      method: "execution",
      command: route.request().postDataJSON(),
    });
    x.thread.revision++;
    return route.fulfill({
      status: 409,
      json: { code: "conflict", message: error },
    });
  });
  await page.route("**/api/platform/messages", (route) => {
    const command = route.request().postDataJSON();
    messages.push(command);
    return route.fulfill({
      json: {
        commandId: command.commandId,
        entityId: "TEST-supplement-receipt",
        workspaceRevision: 1,
      },
    });
  });
  await page.goto("/");
  const input = await openInput(page);
  await input.fill("TEST 只补充这一条原线程");
  await openExecutionPanel(page);
  await page
    .locator(`[data-thread-id="${x.thread.id}"].execution-activity-row`)
    .click();
  const header = page.locator(".execution-detail-header");
  await header.getByRole("button", { name: "暂停此执行", exact: true }).click();
  const feedback = page.locator(".execution-control-feedback");
  await expect(feedback.getByRole("alert")).toHaveText(error);
  for (const appearance of ["light", "dark"]) {
    await page.evaluate((appearance) => {
      document.documentElement.dataset.appearance = appearance;
      const app = document.querySelector<HTMLElement>(".app")!;
      app.dataset.appearance = appearance;
      document.querySelector<HTMLElement>(
        ".execution-detail-header",
      )!.style.width = "248px";
    }, appearance);
    await settleTransitions(page);
    const top = (await header.boundingBox())!;
    const boxes = await Promise.all(
      (await header.getByRole("button").all()).map((button) =>
        button.boundingBox(),
      ),
    );
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i]!;
      expect(box.x).toBeGreaterThanOrEqual(top.x);
      expect(box.x + box.width).toBeLessThanOrEqual(top.x + top.width + 1);
      if (i)
        expect(box.x).toBeGreaterThanOrEqual(
          boxes[i - 1]!.x + boxes[i - 1]!.width,
        );
    }
    expect((await feedback.boundingBox())!.y).toBeGreaterThanOrEqual(
      top.y + top.height,
    );
    expect(
      await feedback.evaluate(
        (node) => node.scrollWidth <= node.clientWidth + 1,
      ),
    ).toBe(true);
    const supplement = header.getByRole("button", {
      name: "补充",
      exact: true,
    });
    expect(
      await supplement.evaluate((node) => {
        const box = node.getBoundingClientRect();
        return node.contains(
          document.elementFromPoint(
            box.x + box.width / 2,
            box.y + box.height / 2,
          ),
        );
      }),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/execution-header-rejected-${appearance}.png`,
    });
  }
  const before = reads.length;
  await header.getByRole("button", { name: "补充", exact: true }).click();
  await expect(page.getByRole("group", { name: "补充目标" })).toContainText(
    x.thread.title,
  );
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("TEST 只补充这一条原线程");
  expect(messages).toHaveLength(0);
  expect(x.calls).toHaveLength(1);
  expect(reads).toHaveLength(before);
  await page.getByRole("button", { name: "发送补充", exact: true }).click();
  await expect.poll(() => messages.length).toBe(1);
  const { inputId: _inputId, ...routing } = x.thread.continuationSource;
  expect(messages[0].operation).toMatchObject({
    ...routing,
    type: "record-input",
    body: "TEST 只补充这一条原线程",
    continuation: x.thread.continuation,
  });
});

test("Objective shortcut and native Schedule actions operate on original objects; opening/cancelling editors never writes", async ({
  page,
}) => {
  const x = await fixture(page);
  const timer = {
    ...x.f.scope,
    scheduleId: "TEST-timer",
    threadId: "TEST-timer-thread",
    sessionId: x.thread.sessionId,
    contextId: x.thread.contextId,
    rootId: "TEST-timer-root",
    inputId: x.thread.inputId,
    sourceTurnId: "TEST-root",
    sourceRootId: "TEST-root",
    status: "queued" as const,
    revision: 4,
    notBefore: "2099-01-01T10:00:00Z",
    intervalSeconds: null,
    dependencyThreadIds: [],
    intent:
      "TEST 原生未来安排：" +
      "保留原始工作来源与既有执行记录，不执行外部操作。".repeat(60),
    updatedAt: stamp,
  };
  x.runtime.activity!.schedules = [timer];
  await page.route("**/api/schedules/control", (route) => {
    const command = route.request().postDataJSON();
    x.calls.push({ method: "schedule", command });
    Object.assign(timer, {
      status:
        command.action === "pause"
          ? "paused"
          : command.action === "reschedule"
            ? timer.status
            : command.action === "cancel"
              ? "cancelled"
              : "queued",
      revision: timer.revision + 1,
      ...(command.action === "reschedule"
        ? {
            notBefore: command.notBefore,
            intervalSeconds: command.intervalSeconds,
          }
        : {}),
    });
    return route.fulfill({ json: { accepted: true } });
  });
  await page.goto("/");
  await openExecutionPanel(page);
  const goal = page.locator('[data-objective-id="TEST-goal"]');
  await goal.getByRole("button", { name: "暂停目标", exact: true }).click();
  await expect(
    goal.getByRole("button", { name: "继续目标", exact: true }),
  ).toBeVisible();
  expect(x.calls[0]!.command).toMatchObject({
    objectiveId: "TEST-goal",
    revision: 3,
    action: "pause",
  });
  await goal.getByRole("button", { name: "继续目标", exact: true }).click();
  await expect(
    goal.getByRole("button", { name: "暂停目标", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "定时任务", exact: true }).click();
  const row = page.locator(".subject-schedule-row").filter({
    has: page.locator('[data-schedule-id="TEST-timer"]'),
  });
  await row.getByRole("button", { name: "调整定时任务", exact: true }).click();
  await page
    .getByRole("group", { name: "定时任务操作", exact: true })
    .getByRole("button", { name: "暂停定时任务", exact: true })
    .click();
  await expect(row).toContainText("已暂停");
  expect(x.calls[2]!.command).toMatchObject({
    scheduleId: "TEST-timer",
    revision: 4,
    action: "pause",
    scope: { inputId: x.thread.inputId, threadId: timer.threadId },
  });
  await row.getByRole("button", { name: "调整定时任务", exact: true }).click();
  await page
    .getByRole("group", { name: "定时任务操作", exact: true })
    .getByRole("button", { name: "调整时间…", exact: true })
    .click();
  const editor = page.getByRole("dialog", {
    name: "调整定时任务",
    exact: true,
  });
  await expect(editor).toBeVisible();
  expect(
    await editor.evaluate((node) => node.getBoundingClientRect().height),
  ).toBeLessThanOrEqual(420);
  await expect(editor.locator(".execution-control-intent")).not.toHaveAttribute(
    "open",
  );
  await editor.getByRole("button", { name: "返回", exact: true }).click();
  expect(x.calls).toHaveLength(3);
  await expect(editor).not.toBeVisible();
  await row.getByRole("button", { name: "调整定时任务", exact: true }).click();
  await page
    .getByRole("group", { name: "定时任务操作", exact: true })
    .getByRole("button", { name: "调整时间…", exact: true })
    .click();
  await editor.getByLabel("执行时间", { exact: true }).fill("2099-02-01T12:30");
  await editor.getByLabel("重复间隔（秒）", { exact: true }).fill("3600");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(x.calls[3]!.command).toMatchObject({
    scheduleId: "TEST-timer",
    revision: 5,
    action: "reschedule",
    intervalSeconds: 3600,
  });
  expect(Number.isFinite(Date.parse(x.calls[3]!.command.notBefore))).toBe(true);
  await expect(row).toContainText("已暂停");
  await row.getByRole("button", { name: "调整定时任务", exact: true }).click();
  await page
    .getByRole("group", { name: "定时任务操作", exact: true })
    .getByRole("button", { name: "继续定时任务", exact: true })
    .click();
  await expect(row).not.toContainText("已暂停");
  await row.getByRole("button", { name: "调整定时任务", exact: true }).click();
  await page
    .getByRole("group", { name: "定时任务操作", exact: true })
    .getByRole("button", { name: "取消安排…", exact: true })
    .click();
  const cancel = page.getByRole("dialog", { name: "取消安排", exact: true });
  expect(x.calls).toHaveLength(5);
  await cancel.getByRole("button", { name: "取消安排", exact: true }).click();
  await expect(cancel).not.toBeVisible();
  expect(x.calls[5]!.command).toMatchObject({
    scheduleId: "TEST-timer",
    revision: 7,
    action: "cancel",
  });
});

test("scoped approval requires explicit scope review; delegated Agent stop uses a distinct confirmation and cancellation edge", async ({
  page,
}) => {
  const x = await fixture(page);
  const requested = {
    network: false,
    write_roots: ["/Users/fixture/Library/Application Support/agently-cli"],
  };
  const approval = {
    requested_at: stamp,
    fingerprint: "a".repeat(64),
    request: {
      approval_id: "TEST-approval",
      session_id: x.thread.sessionId,
      context_id: x.thread.contextId,
      root_turn_id: x.thread.rootId,
      thread_id: x.thread.id,
      justification: "TEST 明确权限边界",
      action: { kind: "shell", command: "TEST read-only command" },
      requested,
      lease_offer: {
        principal_id: "TEST-human",
        agent_id: "TEST-agent",
        session_id: x.thread.sessionId,
        thread_id: x.thread.id,
        scope: "objective" as const,
        scope_id: "TEST-goal",
        target_id: "TEST-node",
        capability: "shell",
        capabilities: ["filesystem.write"],
        requested,
        policy_digest: "TEST-policy",
        duration_secs: 8 * 60 * 60,
      },
    },
  };
  x.runtime.attention!.approvals = [
    {
      scope: {
        ...x.f.scope,
        artifactId: null,
        inputId: x.thread.inputId,
        threadId: x.thread.id,
      },
      approval,
    },
  ];
  const child = {
    ...x.thread,
    id: "TEST-delegated-child",
    title: "TEST 真正的子智能体",
    sessionId: "TEST-child-session",
    contextId: "TEST-child-context",
    delegation: {
      id: "TEST-edge",
      requestEventId: "TEST-delegate-request",
      parentSessionId: x.thread.sessionId,
      parentContextId: x.thread.contextId,
      parentThreadId: x.thread.id,
    },
  };
  x.runtime.activity!.threads.push(child);
  await page.goto("/");
  await openExecutionPanel(page);
  await page.getByRole("tab", { name: "授权", exact: true }).click();
  const card = page.locator('[data-approval-id="TEST-approval"]');
  await expect(
    card.getByRole("button", { name: "查看执行", exact: true }),
  ).toHaveText("查看执行");
  await expect(
    card
      .locator(".approval-actions")
      .getByRole("button", { name: "查看执行", exact: true }),
  ).toHaveCount(0);
  const once = card.getByRole("button", { name: "仅允许这一次", exact: true });
  const more = card.getByRole("button", { name: "更多授权范围", exact: true });
  for (const appearance of ["light", "dark"]) {
    await page.evaluate((appearance) => {
      document.documentElement.dataset.appearance = appearance;
      document.querySelector<HTMLElement>(".app")!.dataset.appearance =
        appearance;
    }, appearance);
    await settleTransitions(page);
    const first = await once.boundingBox(),
      second = await more.boundingBox();
    expect(first!.height).toBe(32);
    expect(second!.height).toBe(32);
    expect(first!.y).toBe(second!.y);
    expect(second!.x).toBeCloseTo(first!.x + first!.width, 0);
    const write = card.locator(".approval-capability > span").first();
    expect(await write.textContent()).toBe("写入：");
    const label = await write.boundingBox();
    expect(label!.height).toBeLessThan(22);
    await more.click();
    const menu = page.getByRole("group", { name: "授权范围", exact: true });
    await settleTransitions(page);
    for (const option of await menu.getByRole("button").all())
      await expect(option).toHaveCSS("opacity", "1");
    expect((await menu.boundingBox())!.width).toBeLessThanOrEqual(182);
    await page.screenshot({
      path: `test-results/approval-compact-${appearance}.png`,
    });
    await page.keyboard.press("Escape");
  }
  expect(x.calls).toHaveLength(0);
  await card.getByRole("button", { name: "更多授权范围", exact: true }).click();
  await page
    .getByRole("group", { name: "授权范围", exact: true })
    .getByRole("button", { name: "在此会话内允许…", exact: true })
    .click();
  const confirm = page.getByRole("dialog", {
    name: "确认授权范围",
    exact: true,
  });
  await expect(confirm).toContainText("TEST-node");
  await expect(confirm).toContainText("批准后 8 小时内有效");
  await expect(confirm).toHaveCSS("opacity", "1");
  expect(x.calls).toHaveLength(0);
  await page.screenshot({
    path: "test-results/desktop-controls-scope-confirmation.png",
  });
  await confirm.getByRole("button", { name: "确认允许", exact: true }).click();
  await expect(confirm).not.toBeVisible();
  expect(x.calls[0]!.command.action).toEqual({
    type: "allow-session",
    approvalId: "TEST-approval",
    fingerprint: approval.fingerprint,
  });
  await page.getByRole("tab", { name: "活动", exact: true }).click();
  await page
    .locator(`[data-thread-id="${x.thread.id}"].execution-activity-row`)
    .click();
  await page
    .getByRole("region", { name: "委派子任务", exact: true })
    .locator(`[data-thread-id="${child.id}"]`)
    .click();
  const actions = page.locator(
    ".execution-detail-header .execution-control-actions",
  );
  await expect(
    actions.getByRole("button", { name: "暂停此执行", exact: true }),
  ).toHaveCount(0);
  await actions
    .getByRole("button", { name: "停止子智能体", exact: true })
    .click();
  const stop = page.getByRole("dialog", { name: "停止子智能体", exact: true });
  await expect(stop).toContainText("下属子智能体");
  expect(x.calls).toHaveLength(1);
  await stop.getByRole("button", { name: "停止子智能体", exact: true }).click();
  await expect(stop).not.toBeVisible();
  expect(x.calls[1]!.command.action).toEqual({ type: "cancel-delegation" });
  expect(x.calls[1]!.command.scope.runtime.delegation.id).toBe("TEST-edge");
});

test.describe("shared control metrics with simulated coarse pointer", () => {
  test.use({ hasTouch: true, viewport: { width: 760, height: 960 } });
  test("new actions retain 44px targets, all palettes and no healthy idle fetches", async ({
    page,
  }) => {
    const x = await fixture(page);
    const reads: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "GET" &&
        /\/api\/executions\?/.test(request.url())
      )
        reads.push(request.url());
    });
    await page.goto("/");
    await openExecutionPanel(page);
    await page
      .locator(`[data-thread-id="${x.thread.id}"].execution-activity-row`)
      .click();
    const actions = page.locator(
      ".execution-detail-header .execution-control-actions",
    );
    await expect(actions.getByRole("button")).toHaveCount(2);
    expect(
      await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
    ).toBe(true);
    for (const appearance of ["light", "dark"])
      for (const accent of ["cyan", "iris", "coral", "mono"]) {
        await page.evaluate(
          ({ appearance, accent }) => {
            const app = document.querySelector<HTMLElement>(".app")!;
            document.documentElement.dataset.appearance = appearance;
            app.dataset.appearance = appearance;
            app.dataset.accent = accent;
          },
          { appearance, accent },
        );
        await settleTransitions(page);
        const rectangles = [];
        for (const button of await actions.getByRole("button").all()) {
          const box = await button.boundingBox();
          expect(box).not.toBeNull();
          expect(box!.width).toBeGreaterThanOrEqual(44);
          expect(box!.height).toBeGreaterThanOrEqual(44);
          rectangles.push(box!);
        }
        for (let i = 1; i < rectangles.length; i++)
          expect(rectangles[i]!.x).toBeGreaterThanOrEqual(
            rectangles[i - 1]!.x + rectangles[i - 1]!.width,
          );
        const red = await actions
          .getByRole("button", { name: "停止", exact: true })
          .evaluate((node) =>
            getComputedStyle(node)
              .color.match(/[\d.]+/g)!
              .map(Number),
          );
        expect(red).toEqual(
          appearance === "light" ? [229, 83, 94] : [255, 141, 152],
        );
      }
    await expect.poll(() => reads.length).toBeGreaterThan(0);
    const before = reads.length;
    // One bounded observation window proves absence of healthy polling; this
    // does not add a timer, retry or scan to the product.
    await page.waitForTimeout(1200);
    expect(reads).toHaveLength(before);
    expect(x.calls).toHaveLength(0);
    await actions
      .getByRole("button", { name: "暂停此执行", exact: true })
      .focus();
    await page.keyboard.press("Tab");
    await expect(
      actions.getByRole("button", { name: "停止", exact: true }),
    ).toBeFocused();
    expect(x.calls).toHaveLength(0);
  });
});
