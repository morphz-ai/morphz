import { test, expect, type Page } from "@playwright/test";
import { openInput, openExecutionPanel } from "./interaction-helpers.js";
import type { ConversationRuntime } from "../packages/core/src/conversation.js";

type Delivery = ConversationRuntime["deliveries"][number];
test.afterEach(async ({ page }) => {
  // Drain snapshot fixtures before Playwright closes their request context.
  // Keep genuine request errors visible instead of ignoring route exceptions.
  await page.unrouteAll({ behavior: "wait" });
});
async function fixture(page: Page) {
  const entries = new Map<
    string,
    { delivery: Omit<Delivery, "inputId">; replies: string[] }
  >();
  const ids = new Map<string, string>();
  let configured = true;
  await page.route("**/api/workspace", async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), "if-none-match": "" },
    });
    const body = await response.json();
    body.runtime = {
      ...body.runtime,
      configured,
      connected: true,
      model: "fixture-model",
      deliveries: [],
      messages: [],
    };
    body.workspace.inputs = body.workspace.inputs.filter(
      (input: { body: string }) => entries.has(input.body),
    );
    for (const input of body.workspace.inputs) {
      const entry = entries.get(input.body);
      if (!entry) continue;
      ids.set(input.body, input.id);
      body.runtime.deliveries.push({ ...entry.delivery, inputId: input.id });
      body.runtime.messages.push(
        ...entry.replies.map((text, index) => ({
          id: `${input.id}-reply-${index}`,
          inputId: input.id,
          projectId: input.projectId,
          conversationId: input.conversationId,
          artifactId: null,
          kind: "reply",
          text,
          createdAt: new Date(
            Date.parse(input.createdAt) + index + 1,
          ).toISOString(),
        })),
      );
    }
    // No source input in this conversation: it must not acquire a stop control.
    body.runtime.deliveries.push({
      inputId: "elsewhere",
      state: "running",
      error: null,
      cancellable: true,
    });
    await route.fulfill({ response, json: body });
  });
  // Presentation fixture only: no real model dispatch or cancellation.
  await page.route("**/api/inputs/*/send", (route) =>
    route.fulfill({ json: { accepted: true } }),
  );
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const input = await openInput(page);
  async function add(
    text: string,
    state: Delivery["state"],
    replies: string[] = [],
  ) {
    entries.set(text, {
      delivery: {
        state,
        error: null,
        retryable: false,
        cancellable: state === "queued" || state === "running",
      },
      replies,
    });
    // Save through the actual center command path without a Runtime; only the
    // returned delivery presentation is simulated for the following assertions.
    configured = false;
    await expect(
      page.getByRole("button", { name: "保存输入", exact: true }),
    ).toBeVisible();
    await input.fill(text);
    await page.getByRole("button", { name: "保存输入", exact: true }).click();
    await expect(
      page.locator(".human-message").filter({ hasText: text }),
    ).toBeVisible();
    await expect.poll(() => ids.get(text)).toBeTruthy();
    configured = true;
    await expect(
      page.getByRole("button", { name: "发送消息", exact: true }),
    ).toBeVisible();
    return page.locator(`[data-response-input-id="${ids.get(text)}"]`);
  }
  return { entries, ids, input, add };
}

test("中间投递状态不占气泡空间，停止仅在对应的回复区域", async ({ page }) => {
  const { input, add } = await fixture(page);
  for (const state of ["queued", "sending", "running", "completed"] as const) {
    await add(
      `状态布局 ${state}`,
      state,
      state === "running" ? ["正在整理文档，接下来核对相关引用。"] : [],
    );
  }
  await expect(
    page.locator(".human-message .retry-input, .execution-status"),
  ).toHaveCount(0);
  await expect(
    page.locator(".human-message .message-meta > span:not(.message-peek)"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "停止这次处理", exact: true }),
  ).toHaveCount(2);
  await expect(page.locator(".response-placeholder")).toHaveCount(2);
  for (const theme of ["dark", "light"]) {
    await page
      .locator(".app")
      .evaluate(
        (el, value) => el.setAttribute("data-appearance", value),
        theme,
      );
    for (const width of [1440, 760]) {
      await page.setViewportSize({ width, height: 960 });
      await input.focus();
      for (const message of await page.locator(".human-message").all()) {
        const bubble = (await message.boundingBox())!;
        const text = (await message.locator(":scope > p").boundingBox())!;
        expect(bubble.height - text.height).toBeLessThanOrEqual(21);
      }
      for (const control of await page.locator(".response-controls").all()) {
        expect((await control.boundingBox())!.height).toBe(28);
        expect(await control.textContent()).toBe("停止");
        expect(
          await control.evaluate(
            (el) => !!el.closest(".human-message, .composer"),
          ),
        ).toBe(false);
        expect(
          await control.evaluate((el) => {
            const owner =
              el.closest(".agent-reply") ??
              el.closest(".response-placeholder")?.previousElementSibling;
            return (
              owner?.getAttribute("data-input-id") ===
              el.getAttribute("data-response-input-id")
            );
          }),
        ).toBe(true);
      }
      await page.screenshot({
        path: `test-results/response-controls-${theme}-${width}.png`,
      });
    }
  }
});

test("分别停止并发回复，等待确认不冒充取消，失败可重试且不丢草稿", async ({
  page,
}) => {
  const { entries, ids, input, add } = await fixture(page);
  await add("并发工作 A", "queued");
  const second = await add("并发工作 B", "running", ["B 的部分回复"]);
  await input.fill("继续讨论的草稿");
  await page.route("**/api/executions?*", (route) =>
    route.fulfill({ json: { jobs: [], approvals: [], limit: 100 } }),
  );
  await openExecutionPanel(page);
  await page
    .locator(".execution-work-row")
    .filter({ hasText: "并发工作 A" })
    .click();
  const first = page
    .getByRole("complementary", { name: "执行面板" })
    .locator(".response-controls");
  const calls: string[] = [];
  let release: (() => void) | undefined;
  let fail = true;
  await page.route("**/api/inputs/*/cancel", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-2)!;
    calls.push(id);
    if (fail) {
      await route.fulfill({
        status: 503,
        json: { message: "停止请求未送达，请重试" },
      });
      return;
    }
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    entries.get("并发工作 A")!.delivery = {
      state: "running",
      error: null,
      cancellable: false,
      retryable: false,
      cancelRequested: true,
    };
    await route.fulfill({ json: { accepted: true } });
  });
  await first.getByRole("button").click();
  await expect(first.getByRole("alert")).toContainText("停止请求未送达");
  await expect(first.getByRole("button")).toBeEnabled();
  fail = false;
  await first.getByRole("button").click();
  await expect(first.getByRole("button")).toBeDisabled();
  await expect.poll(() => release).toBeTruthy();
  // The first response arrives while cancellation is in flight. Its new
  // position must not reset the pending action or enable a duplicate request.
  entries.get("并发工作 A")!.replies.push("A 的迟到回复");
  await expect(
    page.locator(".agent-reply").filter({ hasText: "A 的迟到回复" }),
  ).toBeVisible();
  await expect(first.getByRole("button")).toBeDisabled();
  release!();
  await expect(first.getByRole("button")).toHaveAccessibleName(
    "已请求停止，等待确认",
  );
  await expect(first.getByRole("button")).toBeDisabled();
  await expect(page.getByText("已取消", { exact: true })).toHaveCount(0);
  await expect(second.getByRole("button")).toBeEnabled();
  expect(calls).toEqual([ids.get("并发工作 A"), ids.get("并发工作 A")]);
  await expect(input).toHaveValue("继续讨论的草稿");
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeEnabled();
  entries.get("并发工作 A")!.delivery = {
    state: "cancelled",
    error: null,
    cancellable: false,
    retryable: false,
  };
  await expect(first).toHaveCount(0);
  await expect(page.getByText("已取消", { exact: true })).toBeVisible();
  const failed = await add("失败工作", "failed");
  entries.get("失败工作")!.delivery = {
    state: "failed",
    error: "请求失败",
    retryable: true,
  };
  await expect(failed).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "重试发送", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("执行失败", { exact: true })).toBeVisible();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await openInput(page);
  await expect(
    page.getByRole("complementary", { name: "执行面板" }),
  ).toHaveCount(0);
  // A persisted workbench application can focus its own object history.
  // Inspect the shared conversation before asserting cross-surface controls.
  const allHistory = page.getByRole("button", {
    name: "查看全部交流",
    exact: true,
  });
  if (await allHistory.isVisible()) await allHistory.click();
  await expect(page.locator(".response-controls")).toHaveCount(1);
  expect(calls).toHaveLength(2);
});
