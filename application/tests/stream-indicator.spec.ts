import { test, expect } from "@playwright/test";
import { openInput, openExecutionPanel } from "./interaction-helpers.js";
import { openSettings } from "./settings-helpers.js";

test("流式标记跟随真实帧状态，结束、断线与参数生成完毕即停止动效", async ({
  page,
}) => {
  // Mock only the stream transport; frames still go through the production
  // parser, scope filtering and message renderer. No model request is made.
  await page.addInitScript(() => {
    const sources = new Set<any>();
    (window as any).__streamSources = sources;
    (window as any).EventSource = class {
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public url: string) {
        sources.add(this);
      }
      close() {
        sources.delete(this);
      }
    };
  });
  await page.route("**/api/workspace", async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), "if-none-match": "" },
    });
    const body = await response.json();
    body.runtime = {
      ...body.runtime,
      configured: true,
      connected: true,
      model: "fixture-model",
      messages: [],
      deliveries: [],
    };
    body.workspace.inputs = [
      {
        id: "fixture-input",
        projectId: body.workspace.projects.find(
          (p: { kind: string }) => p.kind === "desk",
        ).id,
        conversationId: "local-dialogue",
        artifactId: null,
        artifactRevision: null,
        author: { actantId: "local-human", principalId: "local-owner" },
        selection: "",
        body: "流式交互验收",
        status: "recorded",
        targetActantId: "morphz-agent",
        createdAt: "2026-09-09T00:00:00Z",
      },
    ];
    body.runtime.deliveries = [
      {
        inputId: "fixture-input",
        state: "running",
        cancellable: true,
        error: null,
      },
    ];
    await route.fulfill({ response, json: body });
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await openInput(page);
  async function emit(
    options: {
      text?: string;
      streaming?: boolean;
      connected?: boolean;
      toolStatus?: string;
    } = {},
  ) {
    await page.evaluate((options) => {
      for (const source of (window as any).__streamSources) {
        const params = new URL(source.url, location.origin).searchParams;
        source.onmessage?.({
          data: JSON.stringify({
            reset: true,
            connected: options.connected ?? true,
            removed: [],
            messages: [
              {
                id: "stream:fixture",
                projectId: params.get("projectId"),
                conversationId: params.get("conversationId"),
                inputId: "fixture-input",
                rootId: null,
                artifactId: null,
                createdAt: "2026-09-09T00:00:00Z",
                text: options.text ?? "这一段正在逐步输出",
                streaming: options.streaming ?? true,
                kind: options.toolStatus ? "tool" : "reply",
                ...(options.toolStatus
                  ? {
                      tool: {
                        name: "read_file",
                        arguments: '{"path":',
                        status: options.toolStatus,
                      },
                    }
                  : {}),
              },
            ],
          }),
        });
      }
    }, options);
  }
  const message = page.locator('[data-message-id="stream:fixture"]');
  await expect
    .poll(() => page.evaluate(() => (window as any).__streamSources.size))
    .toBe(1);
  await emit();
  await expect(message.locator(".stream-text-reveal")).toHaveCount(0);
  await expect(message).toHaveAttribute("data-stream-active", "true");
  const paragraph = message.locator(".reply-content > p");
  await expect
    .poll(() =>
      paragraph.evaluate((el) => getComputedStyle(el, "::after").animationName),
    )
    .toBe("stream-caret");
  await emit({ text: "这一段正在逐步输出，新的内容已到达。" });
  await expect(paragraph).toHaveText("这一段正在逐步输出，新的内容已到达。");
  const fresh = paragraph.locator(".stream-text-reveal");
  await expect(fresh.first()).toBeVisible();
  const animation = await fresh.first().evaluate((el) => {
    const animation = el.getAnimations()[0]!;
    animation.pause();
    animation.currentTime = 80;
    const before = {
      opacity: getComputedStyle(el).opacity,
      filter: getComputedStyle(el).filter,
    };
    animation.currentTime = 400;
    const after = {
      opacity: getComputedStyle(el).opacity,
      filter: getComputedStyle(el).filter,
    };
    animation.play();
    return { before, after, duration: animation.effect!.getTiming().duration };
  });
  expect(Number(animation.after.opacity)).toBeGreaterThan(
    Number(animation.before.opacity) + 0.2,
  );
  expect(animation.after.filter).not.toBe(animation.before.filter);
  expect(animation.duration).toBe(520);
  expect(await fresh.allTextContents()).not.toContain("这一段正在逐步输出");
  for (const time of [60, 460]) {
    await fresh.evaluateAll((elements, time) => {
      for (const el of elements)
        for (const animation of el.getAnimations()) {
          animation.pause();
          animation.currentTime = time;
        }
    }, time);
    await paragraph.screenshot({
      path: `test-results/stream-text-frame-${time}.png`,
    });
  }
  await expect(message).toHaveCount(1);
  const before = await message.boundingBox();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect
    .poll(() =>
      fresh.evaluateAll(
        (elements) => elements.flatMap((el) => el.getAnimations()).length,
      ),
    )
    .toBe(0);
  await expect
    .poll(() =>
      paragraph.evaluate((el) => getComputedStyle(el, "::after").animationName),
    )
    .toBe("none");
  expect(await message.boundingBox()).toEqual(before);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await emit({
    text: "这一段正在逐步输出，新的内容已到达。继续验证本机动画偏好。",
  });
  const localFresh = paragraph.locator(".stream-text-reveal");
  await expect(localFresh.first()).toBeVisible();
  await localFresh.evaluateAll((elements) => {
    for (const element of elements)
      for (const animation of element.getAnimations()) animation.pause();
  });
  const settings = await openSettings(page, "外观");
  await settings.getByLabel("动画效果").selectOption("reduce");
  await expect
    .poll(() =>
      localFresh.evaluateAll(
        (elements) => elements.flatMap((el) => el.getAnimations()).length,
      ),
    )
    .toBe(0);
  await page.keyboard.press("Escape");
  await emit({
    text: "这一段正在逐步输出，新的内容已到达。继续验证本机动画偏好。此时直接展示正文。",
  });
  await expect(paragraph).toContainText("此时直接展示正文。");
  expect(
    await localFresh.evaluateAll(
      (elements) => elements.flatMap((el) => el.getAnimations()).length,
    ),
  ).toBe(0);
  await expect
    .poll(() =>
      paragraph.evaluate((el) => getComputedStyle(el, "::after").animationName),
    )
    .toBe("none");
  await openSettings(page, "外观");
  await settings.getByLabel("动画效果").selectOption("system");
  await page.keyboard.press("Escape");
  await page.screenshot({ path: "test-results/stream-indicator.png" });
  await emit({ streaming: false });
  await expect(message.locator(".stream-text-reveal")).toHaveCount(0);
  await expect(message).not.toHaveAttribute("data-stream-active", "true");
  await expect
    .poll(() =>
      paragraph.evaluate((el) => getComputedStyle(el, "::after").content),
    )
    .toBe("none");
  await page.route("**/api/executions?*", (route) =>
    route.fulfill({ json: { jobs: [], approvals: [], limit: 100 } }),
  );
  await openExecutionPanel(page);
  await page
    .locator(".execution-work-row")
    .filter({ hasText: "流式交互验收" })
    .click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__streamSources.size))
    .toBe(1);
  await emit({ toolStatus: "generating" });
  await expect(message).toHaveAttribute("data-stream-active", "true");
  await expect
    .poll(() =>
      message
        .locator(".tool-name")
        .evaluate((el) => getComputedStyle(el, "::after").animationName),
    )
    .toBe("stream-caret");
  await emit({ toolStatus: "pending" });
  await expect(message).not.toHaveAttribute("data-stream-active", "true");
  await emit({ connected: false });
  await expect(message).not.toHaveAttribute("data-stream-active", "true");
  await emit({ text: "- 第一项\n- 第二项" });
  await expect
    .poll(() =>
      message
        .locator("li")
        .last()
        .evaluate((el) => getComputedStyle(el, "::after").animationName),
    )
    .toBe("stream-caret");
  await page.evaluate(() => {
    for (const source of (window as any).__streamSources) source.onerror?.();
  });
  await expect(message).toHaveCount(1);
  await expect(message).toContainText("第一项");
  await expect(message).not.toHaveAttribute("data-stream-active", "true");
});
