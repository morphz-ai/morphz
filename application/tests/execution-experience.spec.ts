import { test, expect, type Page } from "@playwright/test";
import { openInput, openExecutionPanel } from "./interaction-helpers.js";
import type { PlatformHistory } from "../apps/web/src/platform-client.js";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import { mockPlatformConversation } from "./platform-conversation-fixture.js";

async function openAllWork(page: Page) {
  await openExecutionPanel(page);
  await page
    .getByRole("complementary", { name: "执行面板", exact: true })
    .getByRole("button", { name: "全部工作", exact: true })
    .click();
}

test("incomplete or disconnected work snapshots never claim an exact count or idle work", async ({
  page,
}) => {
  let truncated = true,
    connected = true;
  const threads: NonNullable<
    PlatformHistory["runtime"]["activity"]
  >["threads"] = [];
  const fixture = await mockPlatformConversation(page, () => ({
    inputs: [],
    runtime: {
      ...disconnectedRuntime,
      configured: true,
      connected,
      activity: { available: true, truncated, threads },
      attention: { available: true, approvals: [] },
    },
  }));
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await openAllWork(page);
  const execution = page.getByRole("complementary", {
    name: "执行面板",
    exact: true,
  });
  const count = execution.locator(".execution-scope-count");
  const quiet = execution.locator(".execution-quiet");
  await expect(count).toHaveText("工作状态待核对");
  await expect(quiet).toHaveText("尚不能确认是否有工作进行中");
  threads.push({
    id: "incomplete-background",
    inputId: null,
    projectId: fixture.scope.projectId,
    conversationId: fixture.scope.conversationId,
    rootId: "incomplete-root",
    sessionId: "incomplete-session",
    title: "TEST 部分可见的工作",
    kind: "execution",
    lifecycle: "open",
    phase: "running",
    revision: 1,
    updatedAt: "2026-10-01T00:00:00Z",
  });
  await fixture.refresh();
  await expect(count).toHaveText("至少 1 项进行中");
  await expect(quiet).toHaveCount(0);
  connected = false;
  await fixture.refresh();
  await expect(count).toHaveText("工作状态待核对");
  await expect(
    execution.getByText("连接中断，执行状态尚未确认。", { exact: true }),
  ).toBeVisible();
  connected = true;
  truncated = false;
  threads.length = 0;
  await fixture.refresh();
  await expect(count).toHaveText("0 项进行中");
  await expect(quiet).toHaveText("当前没有正在处理的工作");
});

test("all-work overview includes authorized work whose source message is not loaded, without changing the input scope", async ({
  page,
}) => {
  const inputs: PlatformHistory["inputs"] = [];
  const threads: NonNullable<
    PlatformHistory["runtime"]["activity"]
  >["threads"] = [];
  const fixture = await mockPlatformConversation(page, () => ({
    inputs,
    runtime: {
      ...disconnectedRuntime,
      configured: true,
      connected: true,
      deliveries: inputs.map((input) => ({
        inputId: input.id,
        state: "running" as const,
        error: null,
        retryable: false,
      })),
      activity: { available: true, truncated: false, threads },
      attention: { available: true, approvals: [] },
    },
  }));
  const projectId = crypto.randomUUID();
  await fixture.client.createProject(
    "TEST 尚未加载输入的工作",
    crypto.randomUUID(),
    projectId,
  );
  inputs.push(
    fixture.input(
      "subject-loaded",
      "TEST 当前对话输入",
      "2026-10-01T00:00:00Z",
    ),
  );
  for (const [id, inputId, owner, title] of [
    [
      "subject-local",
      "subject-loaded",
      fixture.scope.projectId,
      "TEST 当前工作",
    ],
    ["subject-other", "subject-unloaded", projectId, "TEST 其他项目中的工作"],
  ])
    threads.push({
      id: id!,
      inputId: inputId!,
      projectId: owner!,
      conversationId: owner!,
      rootId: id! + "-root",
      sessionId: id! + "-session",
      title: title!,
      kind: "execution",
      lifecycle: "open",
      phase: "running",
      revision: 1,
      updatedAt: "2026-10-01T00:00:00Z",
    });
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.getByRole("button", { name: "对话", exact: true }).click();
  const composer = await openInput(page);
  await composer.fill("TEST 当前输入范围不能被活动概览改变");
  await expect(
    page.getByRole("button", { name: "执行记录与审批", exact: true }),
  ).toContainText("2 进行中");
  await openAllWork(page);
  const execution = page.getByRole("complementary", {
    name: "执行面板",
    exact: true,
  });
  await expect(
    execution.getByRole("button", { name: "全部工作", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(execution.locator(".execution-scope-count")).toHaveText(
    "2 项进行中",
  );
  await expect(
    execution.getByRole("button", { name: /TEST 其他项目中的工作/ }),
  ).toBeVisible();
  await expect(
    nav.getByRole("button", { name: "对话", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(composer).toHaveValue("TEST 当前输入范围不能被活动概览改变");
  await expect(page.locator(".human-message")).toHaveCount(1);
});

test("whole-message halo requires a live execution thread; status navigation stays separate from the fixed sidebar toggle", async ({
  page,
}) => {
  let kind: string | undefined = "dialogue_turn";
  let available = true,
    connected = true,
    lifecycle = "open";
  const inputs: PlatformHistory["inputs"] = [];
  const fixture = await mockPlatformConversation(page, () => ({
    inputs,
    runtime: {
      ...disconnectedRuntime,
      configured: true,
      connected,
      model: "fixture",
      error: "",
      messages: [],
      deliveries: inputs.map((input) => ({
        inputId: input.id,
        state: "running" as const,
        error: null,
        retryable: false,
      })),
      activity: {
        available,
        truncated: false,
        threads: inputs.map((input) => ({
          id: "halo-thread",
          kind,
          inputId: input.id,
          projectId: input.projectId,
          conversationId: input.conversationId,
          rootId: "halo-root",
          sessionId: "halo-session",
          title: "整理测试资料",
          phase: "running",
          lifecycle,
          revision: 1,
          updatedAt: input.createdAt,
        })),
      },
      attention: { available: true, approvals: [] },
    },
  }));
  inputs.push(
    fixture.input(
      "halo-fixture",
      "后台执行光效验收：整理测试资料",
      "2026-09-13T00:00:00Z",
    ),
  );
  await page.route("**/api/executions?*", (route) =>
    route.fulfill({ json: { jobs: [], approvals: [], limit: 100 } }),
  );
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const composer = await openInput(page);
  await composer.fill("未发送的原草稿");
  const message = page.locator('[data-message-id="halo-fixture"]');
  const control = page.getByRole("button", {
    name: "执行记录与审批",
    exact: true,
  });
  await expect(message).toBeVisible();
  await expect(message).not.toHaveAttribute(
    "data-background-execution",
    "true",
  );
  await expect(page.locator(".message-run-indicator")).toHaveCount(0);
  await expect(
    page.locator(".composer").getByLabel("执行记录与审批"),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "显示右侧栏" }).click();
  const understanding = page.getByRole("complementary", {
    name: "当前理解",
    exact: true,
  });
  await expect(understanding).toBeVisible();
  kind = "execution";
  await fixture.refresh();
  await expect(message).toHaveAttribute("data-background-execution", "true");
  await expect(understanding).toBeVisible();
  await page.getByRole("button", { name: "隐藏右侧栏" }).click();
  await expect(control).toContainText("1");
  const haloBefore = await message.evaluate(
    (el) => getComputedStyle(el, "::before").backgroundImage,
  );
  await page.waitForTimeout(130);
  const haloAfter = await message.evaluate(
    (el) => getComputedStyle(el, "::before").backgroundImage,
  );
  expect(haloBefore).not.toBe(haloAfter);
  await page.screenshot({ path: "test-results/execution-halo-light.png" });
  const toggle = page.locator(".inspector-toggle");
  for (const width of [1440, 1000, 760, 390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    const before = (await control.boundingBox())!;
    await control.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(control).toBeFocused();
    await expect(control).toBeInViewport();
    expect(await control.boundingBox()).toEqual(before);
    const statusBounds = (await control.boundingBox())!;
    const toggleBounds = (await toggle.boundingBox())!;
    expect(statusBounds.x + statusBounds.width).toBeLessThanOrEqual(
      toggleBounds.x,
    );
    await expect(
      page.getByRole("complementary", { name: "执行面板" }),
    ).toBeVisible();
    await expect(composer).toHaveValue("未发送的原草稿");
    await control.click();
    await expect(
      page.getByRole("complementary", { name: "执行面板" }),
    ).toBeVisible();
    await toggle.click();
    await expect(page.locator(".workspace-inspector")).toHaveCount(0);
    expect(await control.boundingBox()).toEqual(before);
    await expect(toggle).toBeInViewport();
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await expect
    .poll(() =>
      message.evaluate((el) => getComputedStyle(el, "::before").animationName),
    )
    .toBe("none");
  await expect(message).toHaveAttribute("data-background-execution", "true");
  await page.screenshot({
    path: "test-results/execution-halo-dark-reduced-motion.png",
  });
  available = false;
  await fixture.refresh();
  await expect(message).not.toHaveAttribute(
    "data-background-execution",
    "true",
  );
  available = true;
  connected = false;
  await fixture.refresh();
  await expect(message).not.toHaveAttribute(
    "data-background-execution",
    "true",
  );
  connected = true;
  lifecycle = "cancelled";
  await fixture.refresh();
  await expect(message).not.toHaveAttribute(
    "data-background-execution",
    "true",
  );
  lifecycle = "open";
  kind = undefined;
  await fixture.refresh();
  await expect(message).not.toHaveAttribute(
    "data-background-execution",
    "true",
  );
  // A running delivery still warrants a status entry, never an execution halo.
  await expect(control).toContainText("1 进行中");
});

test("pending approvals remain visible across work surfaces; inline decisions use exact scope and stay locked on an uncertain response", async ({
  page,
}) => {
  let pending = true,
    available = true;
  const calls: any[] = [];
  let release: (() => void) | undefined;
  const inputs: PlatformHistory["inputs"] = [];
  const fixture = await mockPlatformConversation(page, () => {
    const approval = {
      requested_at: "2026-09-13T00:00:00Z",
      fingerprint: "a".repeat(64),
      request: {
        approval_id: "inline-approval",
        session_id: "approval-session",
        context_id: "approval-context",
        root_turn_id: "approval-root",
        thread_id: "approval-thread",
        justification: "读取测试目录中的本次资料",
        action: {
          kind: "tool_operation",
          tool: "read_file",
          operation: "read",
          target: "/fixture/private/report.md",
        },
        requested: {
          network: false,
          read_roots: ["/fixture/private"],
          write_roots: [],
        },
      },
    };
    return {
      inputs,
      runtime: {
        ...disconnectedRuntime,
        configured: true,
        connected: true,
        model: "fixture",
        error: "",
        messages: [],
        deliveries: [],
        attention: {
          available,
          approvals: pending
            ? inputs.map((input) => ({
                scope: {
                  projectId: input.projectId,
                  conversationId: input.conversationId,
                  artifactId: null,
                  inputId: input.id,
                  threadId: "approval-thread",
                },
                approval,
              }))
            : [],
        },
      },
    };
  });
  inputs.push(
    fixture.input("approval-input", "测试一次受限读取", "2026-09-13T00:00:00Z"),
  );
  await page.route("**/api/executions/control", async (route) => {
    calls.push(route.request().postDataJSON());
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({
      status: 503,
      json: { message: "Runtime 未确认操作，请核对最新状态，不要重复批准。" },
    });
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const composer = await openInput(page);
  await composer.fill("保持我的输入草稿");
  const control = page.getByRole("button", {
    name: "执行记录与审批",
    exact: true,
  });
  const card = page.locator(
    '.conversation [data-approval-id="inline-approval"]',
  );
  await expect(control).toContainText("1 待审批");
  await expect(page.locator(".workspace-inspector")).toHaveCount(0);
  await expect(composer).toBeFocused();
  await expect(card).toContainText("读取：/fixture/private");
  await expect(card).toContainText("不额外授权联网");
  available = false;
  await fixture.refresh();
  await expect(
    card.getByRole("button", { name: "仅允许这一次" }),
  ).toBeDisabled();
  await expect(control).toContainText("待确认");
  available = true;
  await fixture.refresh();
  await expect(
    card.getByRole("button", { name: "仅允许这一次" }),
  ).toBeEnabled();
  await control.click();
  const panel = page.getByRole("complementary", { name: "执行面板" });
  await expect(panel.getByLabel("待审批操作")).toBeVisible();
  await expect(
    panel.getByText("读取：/fixture/private", { exact: false }),
  ).toBeVisible();
  for (const width of [390, 320, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(control).toBeInViewport();
    const header = panel.locator(".inspector-header");
    const toggle = (await control.boundingBox())!;
    const pin = (await header
      .getByLabel("固定执行面板", { exact: true })
      .boundingBox())!;
    expect(
      pin.x + pin.width <= toggle.x || toggle.x + toggle.width <= pin.x,
    ).toBe(true);
    expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    );
    await expect(
      panel.getByRole("button", { name: "仅允许这一次" }),
    ).toBeVisible();
  }
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  await expect(control).toBeInViewport();
  await expect(
    panel.getByRole("button", { name: "仅允许这一次" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/execution-approval-200-percent.png",
  });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "";
  });
  await control.click();
  await expect(panel).toBeVisible();
  await page.getByRole("button", { name: "隐藏右侧栏" }).click();
  await card.getByRole("button", { name: "仅允许这一次" }).click();
  await expect(
    card.getByRole("button", { name: "仅允许这一次" }),
  ).toBeDisabled();
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0]).toEqual({
    scope: {
      ...fixture.scope,
      artifactId: null,
      inputId: "approval-input",
      threadId: "approval-thread",
    },
    action: {
      type: "allow-once",
      approvalId: "inline-approval",
      fingerprint: "a".repeat(64),
    },
  });
  release!();
  await expect(card.getByRole("status")).toContainText("未确认");
  await expect(
    card.getByRole("button", { name: "仅允许这一次" }),
  ).toBeDisabled();
  await expect(composer).toHaveValue("保持我的输入草稿");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await expect(control).toContainText("1 待审批");
  await control.click();
  await expect(panel.getByLabel("待审批操作")).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "仅允许这一次" }),
  ).toBeDisabled();
  pending = false;
  await fixture.refresh();
  await expect(control).toHaveCount(0);
  await expect(panel.getByLabel("待审批操作")).toHaveCount(0);
  expect(calls).toHaveLength(1);
});
