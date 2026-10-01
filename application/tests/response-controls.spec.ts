import { test, expect, type Page } from "@playwright/test";
import { openInput, openExecutionPanel } from "./interaction-helpers.js";
import type { ConversationRuntime } from "../packages/core/src/conversation.js";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import type { PlatformHistory } from "../apps/web/src/platform-client.js";
import { mockPlatformConversation } from "./platform-conversation-fixture.js";

type Delivery = ConversationRuntime["deliveries"][number];
test.afterEach(async ({ page }) => {
  // Drain transport fixtures before Playwright closes their request context.
  // Keep genuine request errors visible instead of ignoring route exceptions.
  await page.unrouteAll({ behavior: "wait" });
});
async function fixture(page: Page) {
  const entries = new Map<
    string,
    { delivery: Omit<Delivery, "inputId">; replies: string[] }
  >();
  const ids = new Map<string, string>();
  const inputs: PlatformHistory["inputs"] = [];
  const presentation = await mockPlatformConversation(page, () => {
    const runtime: ConversationRuntime = {
      ...disconnectedRuntime,
      configured: true,
      connected: true,
      model: "fixture-model",
      deliveries: [],
      messages: [],
    };
    for (const input of inputs) {
      const entry = entries.get(input.body);
      if (!entry) continue;
      runtime.deliveries.push({ ...entry.delivery, inputId: input.id });
      runtime.messages.push(
        ...entry.replies.map((text, index) => ({
          id: `${input.id}-reply-${index}`,
          inputId: input.id,
          projectId: input.projectId,
          conversationId: input.conversationId,
          artifactId: null,
          kind: "reply" as const,
          text,
          createdAt: new Date(
            Date.parse(input.createdAt) + index + 1,
          ).toISOString(),
        })),
      );
    }
    // No source input in this conversation: it must not acquire a stop control.
    runtime.deliveries.push({
      inputId: "elsewhere",
      state: "running",
      error: null,
      cancellable: true,
      retryable: false,
    });
    return { inputs, runtime };
  });
  // Exercise the real composer and current message request shape. Only the
  // transport receipt/delivery presentation is synthetic; no model is called.
  await page.route("**/api/platform/messages", (route) => {
    const command = route.request().postDataJSON();
    const operation = command.operation;
    if (!entries.has(operation.body))
      throw new Error("Unexpected input in the response-control fixture");
    ids.set(operation.body, command.commandId);
    if (!inputs.some((input) => input.id === command.commandId))
      inputs.push({
        ...presentation.input(
          command.commandId,
          operation.body,
          new Date().toISOString(),
        ),
        projectId: operation.projectId,
        conversationId: operation.conversationId,
      });
    return route.fulfill({
      status: 202,
      json: { commandId: command.commandId, entityId: command.commandId },
    });
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
    await input.fill(text);
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(
      page.locator(".human-message").filter({ hasText: text }),
    ).toBeVisible();
    await expect.poll(() => ids.get(text)).toBeTruthy();
    await expect(
      page.getByRole("button", { name: "发送消息", exact: true }),
    ).toBeVisible();
    return page.locator(`[data-response-input-id="${ids.get(text)}"]`);
  }
  return { entries, ids, inputs, input, add, refresh: presentation.refresh };
}

test("本人气泡使用清透主题面色，四主题明暗可读且不增加立体装饰", async ({
  page,
}) => {
  const { add, input, inputs, refresh } = await fixture(page);
  await add("TEST 消息配色回归：正文与操作保持原位。", "completed");
  inputs[0]!.textQuotes = [
    {
      id: "8bb526f1-5f62-4920-9a60-a07f8f786cba",
      source: {
        kind: "surface",
        projectId: inputs[0]!.projectId,
        title: "来源：测试原文",
      },
      text: "带有来源的小字也必须清楚可读。",
      comment: "",
    },
  ];
  await refresh();
  const message = page.locator(".human-message").last();
  await expect(message.locator(".sent-text-quote small")).toHaveText(
    "来源：测试原文",
  );
  const initial = await message.boundingBox();
  await input.fill("配色切换后保留的未发送草稿");
  for (const appearance of ["light", "dark"]) {
    for (const accent of ["cyan", "iris", "coral", "mono"]) {
      await page.locator(".app").evaluate(
        (element, theme) => {
          element.setAttribute("data-appearance", theme.appearance);
          element.setAttribute("data-accent", theme.accent);
        },
        { appearance, accent },
      );
      const paint = await message.evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((a) => a.finished));
        const canvas = document.createElement("canvas").getContext("2d")!;
        const rgb = (color: string) => {
          canvas.clearRect(0, 0, 1, 1);
          canvas.fillStyle = color;
          canvas.fillRect(0, 0, 1, 1);
          return [...canvas.getImageData(0, 0, 1, 1).data];
        };
        const probe = document.createElement("span");
        probe.style.color = "var(--accent)";
        element.append(probe);
        const accent = rgb(getComputedStyle(probe).color);
        probe.remove();
        const style = getComputedStyle(element);
        // The quote's translucent inner fill composites over the real bubble,
        // not over white. Check the source label on that effective surface.
        const quote = element.querySelector(".sent-text-quote")!;
        canvas.clearRect(0, 0, 1, 1);
        canvas.fillStyle = style.backgroundColor;
        canvas.fillRect(0, 0, 1, 1);
        canvas.fillStyle = getComputedStyle(quote).backgroundColor;
        canvas.fillRect(0, 0, 1, 1);
        const quoteFill = [...canvas.getImageData(0, 0, 1, 1).data];
        return {
          ink: rgb(style.color),
          fill: rgb(style.backgroundColor),
          paper: rgb(
            getComputedStyle(document.querySelector(".workspace")!)
              .backgroundColor,
          ),
          accent,
          shadow: style.boxShadow,
          quoteFill,
          quoteInk: rgb(getComputedStyle(quote.querySelector("small")!).color),
        };
      });
      expect(paint.shadow).toBe("none");
      expect(paint.fill[3]).toBe(255);
      if (appearance === "light")
        expect(paint.paper).toEqual([255, 255, 255, 255]);
      if (appearance === "light") {
        // A dark, readable foreground diluted with white looked dusty. Large
        // surfaces retain the theme's hue but use a clear high-chroma pastel.
        const expected = {
          cyan: [197, 245, 252],
          iris: [208, 197, 252],
          coral: [252, 203, 197],
          mono: [240, 240, 240],
        }[accent]!;
        for (let channel = 0; channel < 3; channel++)
          expect(
            Math.abs(paint.fill[channel]! - expected[channel]!),
          ).toBeLessThanOrEqual(1);
        if (accent !== "mono") {
          const channels = paint.fill.slice(0, 3);
          expect(
            Math.max(...channels) - Math.min(...channels),
          ).toBeGreaterThanOrEqual(50);
        }
      } else {
        for (let channel = 0; channel < 3; channel++) {
          expect(
            Math.abs(
              paint.fill[channel]! -
                (paint.accent[channel]! * 0.25 + paint.paper[channel]! * 0.75),
            ),
          ).toBeLessThanOrEqual(1);
        }
      }
      const luminance = (rgb: number[]) => {
        const linear = rgb.slice(0, 3).map((v) => {
          const c = v / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
      };
      const ink = luminance(paint.ink),
        fill = luminance(paint.fill);
      expect(
        (Math.max(ink, fill) + 0.05) / (Math.min(ink, fill) + 0.05),
      ).toBeGreaterThanOrEqual(4.5);
      const quoteInk = luminance(paint.quoteInk),
        quoteFill = luminance(paint.quoteFill);
      expect(
        (Math.max(quoteInk, quoteFill) + 0.05) /
          (Math.min(quoteInk, quoteFill) + 0.05),
      ).toBeGreaterThanOrEqual(4.5);
      expect(await message.boundingBox()).toEqual(initial);
      await expect(input).toHaveValue("配色切换后保留的未发送草稿");
    }
  }
});

test("中间投递状态不占气泡空间，红色停止图标悬停显示在对应用户消息", async ({
  page,
}) => {
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
        expect((await control.boundingBox())!.height).toBe(24);
        expect(await control.textContent()).toBe("");
        expect(
          await control.evaluate(
            (el) => !!el.closest(".human-message, .composer"),
          ),
        ).toBe(true);
        expect(
          await control.evaluate((el) => {
            const owner = el.closest(".human-message");
            return (
              owner?.getAttribute("data-input-id") ===
              el.getAttribute("data-response-input-id")
            );
          }),
        ).toBe(true);
        await input.focus();
        await page.mouse.move(0, 0);
        const actions = control.locator("..");
        await expect(actions).toHaveClass("message-peek");
        await expect(actions).toHaveCSS("opacity", "0");
        await control.locator("xpath=ancestor::article").hover();
        await expect(actions).toHaveCSS("opacity", "1");
        await expect(control.getByRole("button")).toHaveCSS(
          "color",
          theme === "dark" ? "rgb(255, 180, 184)" : "rgb(229, 72, 77)",
        );
        const copy = (await actions
          .getByRole("button", { name: "复制消息" })
          .boundingBox())!;
        const button = (await control.getByRole("button").boundingBox())!;
        expect(button.x).toBeGreaterThanOrEqual(copy.x + copy.width);
        expect(Math.abs(button.y - copy.y)).toBeLessThan(1);
      }
      await expect(
        page.locator(
          ".agent-reply .response-controls, .response-placeholder .response-controls",
        ),
      ).toHaveCount(0);
      await page.screenshot({
        path: `test-results/response-controls-${theme}-${width}.png`,
      });
    }
  }
});

test("分别停止并发回复，等待确认不冒充取消，失败可重试且不丢草稿", async ({
  page,
}) => {
  const { entries, ids, input, add, refresh } = await fixture(page);
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
  await refresh();
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
  await refresh();
  await expect(first).toHaveCount(0);
  await expect(page.getByText("已取消", { exact: true })).toBeVisible();
  const failed = await add("失败工作", "failed");
  entries.get("失败工作")!.delivery = {
    state: "failed",
    error: "请求失败",
    retryable: true,
  };
  await refresh();
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
