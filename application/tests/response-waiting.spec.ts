import { test, expect, type Page } from "@playwright/test";
import {
  disconnectedRuntime,
  type ConversationRuntime,
} from "../packages/core/src/conversation.js";
import type { PlatformHistory } from "../apps/web/src/platform-client.js";
import { openInput } from "./interaction-helpers.js";
import { mockPlatformConversation } from "./platform-conversation-fixture.js";

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

async function setup(page: Page) {
  let connected = true;
  let generation = 0;
  const deliveries: ConversationRuntime["deliveries"] = [
    { inputId: "waiting-a", state: "running", error: null, retryable: false },
  ];
  const replies: ConversationRuntime["messages"] = [];
  const threads: NonNullable<ConversationRuntime["activity"]>["threads"] = [];
  const inputs: PlatformHistory["inputs"] = [];
  await page.addInitScript(() => {
    const sources = new Set<any>();
    (window as any).__waitingStreams = sources;
    (window as any).EventSource = class {
      onmessage: ((e: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public url: string) {
        sources.add(this);
      }
      close() {
        sources.delete(this);
      }
    };
  });
  const presentation = await mockPlatformConversation(page, () => ({
    inputs,
    runtime: {
      ...disconnectedRuntime,
      configured: true,
      connected,
      model: `waiting-fixture-${generation}`,
      error: "",
      deliveries,
      messages: replies,
      activity: { available: true, threads, truncated: false },
      attention: { available: true, approvals: [] },
    },
  }));
  const scope = presentation.scope;
  inputs.push(
    ...["waiting-a", "waiting-b"].map((id, i) =>
      presentation.input(
        id,
        `TEST 首字反馈 ${i + 1}`,
        `2026-09-22T00:00:0${i}Z`,
      ),
    ),
  );
  // This presentation fixture models a connected Runtime with directed input.
  // The isolated service itself deliberately has no Runtime connection.
  await page.route("**/api/platform/bootstrap", async (route) => {
    const response = await route.fetch();
    const bootstrap = await response.json();
    await route.fulfill({
      response,
      json: {
        ...bootstrap,
        capabilities: { ...bootstrap.capabilities, directedInput: true },
      },
    });
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const composer = await openInput(page);
  await composer.fill("TEST 保留未发送草稿");
  return {
    composer,
    deliveries,
    threads,
    scope: () => scope,
    async update(online = connected) {
      connected = online;
      generation++;
      await presentation.refresh();
    },
    async stream(text: string, streaming = true, streamConnected = true) {
      await expect
        .poll(() => page.evaluate(() => (window as any).__waitingStreams.size))
        .toBeGreaterThan(0);
      await page.evaluate(
        ({ text, streaming, streamConnected, scope }) => {
          for (const source of (window as any).__waitingStreams) {
            source.onmessage?.({
              data: JSON.stringify({
                connected: streamConnected,
                reset: true,
                removed: [],
                messages: [
                  {
                    id: "waiting-reply",
                    publicationKey: "waiting-attempt",
                    kind: "reply",
                    text,
                    streaming,
                    ...scope,
                    artifactId: null,
                    inputId: "waiting-a",
                    rootId: "waiting-root",
                    createdAt: "2026-09-22T00:01:00Z",
                  },
                ],
              }),
            });
          }
        },
        { text, streaming, streamConnected, scope },
      );
    },
  };
}

const waiting = (page: Page, id = "waiting-a") =>
  page.locator(`[data-waiting-input-id="${id}"]`);

test("首字前有反馈，不依赖停止权限；首字接替提示，增量不缓冲、不清空草稿", async ({
  page,
}) => {
  const f = await setup(page);
  await expect(waiting(page)).toBeVisible();
  await expect(waiting(page).getByRole("status")).toHaveText("正在处理…");
  await expect(waiting(page).getByRole("button")).toHaveCount(0);
  await expect(page.locator(".agent-reply")).toHaveCount(0);
  await f.stream("");
  await expect(waiting(page)).toBeVisible();
  await expect(page.locator(".agent-reply")).toHaveCount(0);
  await f.stream("首字");
  await expect(waiting(page)).toHaveCount(0);
  const reply = page.locator('[data-message-id="waiting-reply"]');
  await expect(reply).toHaveAttribute("data-streaming", "true");
  await expect(reply).toContainText("首字");
  await f.stream("首字已经显示，后续文字继续到达。");
  await expect(reply).toContainText("后续文字继续到达");
  await f.stream("首字已经显示，后续文字继续到达。", false);
  f.deliveries[0]!.state = "completed";
  await f.update();
  await expect(waiting(page)).toHaveCount(0);
  await expect(reply).toContainText("首字已经显示");
  await expect(f.composer).toHaveValue("TEST 保留未发送草稿");
});

test("等待、发送、断线、停止确认与终态不混淆，亮暗和减少动态均可读", async ({
  page,
}) => {
  const f = await setup(page);
  const delivery = f.deliveries[0]!;
  for (const [state, label] of [
    ["queued", "等待处理…"],
    ["sending", "正在发送…"],
    ["running", "正在处理…"],
  ] as const) {
    delivery.state = state;
    await f.update();
    await expect(waiting(page)).toContainText(label);
  }
  delivery.cancellable = true;
  await f.update();
  const stop = page
    .locator('[data-message-id="waiting-a"]')
    .getByRole("button", { name: "停止这次处理" });
  await expect(stop).toBeEnabled();
  for (const theme of ["light", "dark"]) {
    await page
      .locator(".app")
      .evaluate(
        (el, value) => el.setAttribute("data-appearance", value),
        theme,
      );
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 960 });
      await expect(waiting(page)).toBeInViewport();
      expect((await waiting(page).boundingBox())!.height).toBeLessThanOrEqual(
        56,
      );
      await page.screenshot({
        path: `test-results/response-waiting-${theme}-${width}.png`,
      });
    }
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(waiting(page).locator(".response-dots i").first()).toHaveCSS(
    "animation-name",
    "none",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(waiting(page).locator(".response-dots i").first()).toHaveCSS(
    "animation-name",
    "response-waiting-pulse",
  );
  await f.update(false);
  await expect(waiting(page)).toContainText("连接中断，等待恢复");
  await expect(waiting(page).locator(".response-dots i").first()).toHaveCSS(
    "animation-name",
    "none",
  );
  await expect(stop).toBeDisabled();
  delivery.cancelRequested = true;
  await f.update(true);
  await expect(waiting(page)).toContainText("已请求停止，等待确认");
  await expect(
    page
      .locator('[data-message-id="waiting-a"]')
      .getByRole("button", { name: "已请求停止，等待确认" }),
  ).toBeDisabled();
  for (const state of ["cancelled", "failed", "completed"] as const) {
    delivery.state = state;
    await f.update();
    await expect(waiting(page)).toHaveCount(0);
  }
  await expect(f.composer).toHaveValue("TEST 保留未发送草稿");
});

test("输出间歇末尾三点继续运动，结束与断线撤下；减少动态保留清晰静态提示", async ({
  page,
}) => {
  const f = await setup(page);
  await f.stream("已收到的正文，正在继续生成。");
  const reply = page.locator('[data-message-id="waiting-reply"]');
  const tail = reply.locator(".reply-content > p:last-child");
  const style = () =>
    tail.evaluate((el) => {
      const css = getComputedStyle(el, "::after");
      return {
        content: css.content,
        animation: css.animationName,
        position: css.backgroundPosition,
        width: css.width,
        height: css.height,
        background: css.backgroundImage,
      };
    });
  for (const theme of ["light", "dark"]) {
    await page
      .locator(".app")
      .evaluate(
        (el, value) => el.setAttribute("data-appearance", value),
        theme,
      );
    const before = await style();
    expect(before).toMatchObject({
      content: '""',
      animation: "stream-activity",
      width: "27px",
      height: "14px",
    });
    expect(before.background.match(/radial-gradient/g)).toHaveLength(3);
    // No new stream event: CSS motion must continue without a React update.
    await expect
      .poll(async () => (await style()).position)
      .not.toBe(before.position);
    await expect(tail).toHaveText("已收到的正文，正在继续生成。");
    await page.screenshot({
      path: `test-results/stream-activity-${theme}.png`,
    });
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await style()).toMatchObject({ content: '""', animation: "none" });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page
    .locator("html")
    .evaluate((el) => el.setAttribute("data-app-motion", "reduce"));
  expect(await style()).toMatchObject({ content: '""', animation: "none" });
  await page
    .locator("html")
    .evaluate((el) => el.removeAttribute("data-app-motion"));
  await f.stream("已收到的正文，正在继续生成。", true, false);
  await f.update(false);
  await expect(reply).not.toHaveAttribute("data-stream-active", "true");
  expect((await style()).content).toBe("none");
  await expect(tail).toHaveText("已收到的正文，正在继续生成。");
  await f.update(true);
  await f.stream("已收到的正文，正在继续生成。", true, true);
  await expect(reply).toHaveAttribute("data-stream-active", "true");
  for (const [source, selector] of [
    ["- 列表末尾", ".reply-content > ul:last-child > li:last-child"],
    ["> 引用末尾", ".reply-content > blockquote:last-child > p:last-child"],
    ["```txt\n代码末尾\n```", ".reply-content > pre:last-child > code"],
    [
      "| 列 |\n| --- |\n| 表格末尾 |",
      ".reply-content > .markdown-table-scroll:last-child",
    ],
  ]) {
    await f.stream(source!);
    await expect
      .poll(() =>
        reply
          .locator(selector!)
          .evaluate((el) => getComputedStyle(el, "::after").animationName),
      )
      .toBe("stream-activity");
  }
  await f.stream("生成已经结束。", false);
  await expect(reply).not.toHaveAttribute("data-stream-active", "true");
  expect((await style()).content).toBe("none");
  await expect(f.composer).toHaveValue("TEST 保留未发送草稿");
});

test("并发等待各自归属，补充送达不冒充新回复，结束线程没有补充入口", async ({
  page,
}) => {
  const f = await setup(page);
  f.deliveries.push({
    inputId: "waiting-b",
    state: "queued",
    error: null,
    retryable: false,
  });
  f.threads.push({
    ...f.scope(),
    id: "waiting-thread",
    kind: "dialogue_turn",
    inputId: "waiting-a",
    rootId: "waiting-root",
    sessionId: "fixture-session",
    title: "TEST 首字反馈 1",
    phase: "running",
    lifecycle: "open",
    revision: 1,
    updatedAt: "2026-09-22T00:00:00Z",
    continuation: {
      mode: "supplement",
      inputId: "waiting-a",
      threadId: "waiting-thread",
      generation: 1,
    },
  });
  await f.update();
  await expect(page.locator(".response-placeholder")).toHaveCount(2);
  const supplement = page
    .locator('[data-message-id="waiting-a"]')
    .getByRole("button", { name: "补充要求", exact: true });
  await expect(supplement).toHaveCount(0);
  f.threads[0]!.kind = "execution";
  await f.update();
  await expect(supplement).toHaveAttribute("title", "给这项后台工作追加要求");
  await supplement.click();
  await expect(page.getByRole("group", { name: "补充目标" })).toContainText(
    "TEST 首字反馈 1",
  );
  await expect(f.composer).toHaveValue("TEST 保留未发送草稿");
  await page.getByRole("button", { name: "取消补充，改为普通输入" }).click();
  f.deliveries[1]!.supplement = "delivered";
  f.threads[0]!.lifecycle = "closed";
  await f.update();
  await expect(supplement).toHaveCount(0);
  await expect(waiting(page, "waiting-b")).toHaveCount(0);
  await expect(waiting(page)).toBeVisible();
  // Only A's real text ends A's waiting; this is not a global spinner.
  await f.stream("A 的回复");
  await expect(waiting(page)).toHaveCount(0);
});
