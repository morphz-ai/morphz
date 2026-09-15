import { test, expect } from "@playwright/test";
import { openInput } from "./interaction-helpers.js";

test("whole-message halo requires a live execution thread; status navigation stays separate from the fixed sidebar toggle", async ({
  page,
}) => {
  let kind: string | undefined = "dialogue_turn";
  let available = true,
    connected = true,
    lifecycle = "open";
  await page.route("**/api/workspace", async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), "if-none-match": "" },
    });
    const body = await response.json();
    const input = {
      id: "halo-fixture",
      projectId: "first-project",
      conversationId: "local-dialogue",
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body: "后台执行光效验收：整理测试资料",
      status: "recorded",
      targetActantId: "morphz-agent",
      author: { principalId: "local-owner", actantId: "local-human" },
      createdAt: "2026-09-13T00:00:00Z",
    };
    body.workspace.inputs = [input];
    body.runtime = {
      configured: false,
      connected,
      model: "fixture",
      error: "",
      messages: [],
      deliveries: [{ inputId: input.id, state: "running", error: null }],
      activity: {
        available,
        truncated: false,
        threads: [
          {
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
          },
        ],
      },
      attention: { available: true, approvals: [] },
    };
    await route.fulfill({ response, json: body });
  });
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
  await expect(message).not.toHaveAttribute(
    "data-background-execution",
    "true",
  );
  available = true;
  connected = false;
  await expect(message).not.toHaveAttribute(
    "data-background-execution",
    "true",
  );
  connected = true;
  lifecycle = "cancelled";
  await expect(message).not.toHaveAttribute(
    "data-background-execution",
    "true",
  );
  lifecycle = "open";
  kind = undefined;
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
  await page.route("**/api/workspace", async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), "if-none-match": "" },
    });
    const body = await response.json();
    const input = {
      id: "approval-input",
      projectId: "first-project",
      conversationId: "local-dialogue",
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body: "测试一次受限读取",
      status: "recorded",
      targetActantId: "morphz-agent",
      author: { principalId: "local-owner", actantId: "local-human" },
      createdAt: "2026-09-13T00:00:00Z",
    };
    body.workspace.inputs = [input];
    const approval = {
      requested_at: input.createdAt,
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
    body.runtime = {
      configured: false,
      connected: true,
      model: "fixture",
      error: "",
      messages: [],
      deliveries: [],
      attention: {
        available,
        approvals: pending
          ? [
              {
                scope: {
                  projectId: input.projectId,
                  conversationId: input.conversationId,
                  artifactId: null,
                  inputId: input.id,
                  threadId: "approval-thread",
                },
                approval,
              },
            ]
          : [],
      },
    };
    await route.fulfill({ response, json: body });
  });
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
  await expect(
    card.getByRole("button", { name: "仅允许这一次" }),
  ).toBeDisabled();
  await expect(control).toContainText("待确认");
  available = true;
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
    expect(pin.x + pin.width).toBeLessThanOrEqual(toggle.x);
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
      projectId: "first-project",
      conversationId: "local-dialogue",
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
  await expect(control).toHaveCount(0);
  await expect(panel.getByLabel("待审批操作")).toHaveCount(0);
  expect(calls).toHaveLength(1);
});
