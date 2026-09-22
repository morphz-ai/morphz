import { test, expect, type Page } from "@playwright/test";
import type { Boot } from "../apps/web/src/client.js";
import type { ConversationRuntime } from "../packages/core/src/conversation.js";
import { openInput } from "./interaction-helpers.js";

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
  let scope = { projectId: "", conversationId: "" };
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
  await page.route("**/api/workspace", async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), "if-none-match": "" },
    });
    const boot: Boot = await response.json();
    boot.capabilities.directedInput = true;
    const dialogue = boot.workspace.projects.find(
      (p) => p.kind === "dialogue",
    )!;
    scope = { projectId: dialogue.id, conversationId: dialogue.id };
    boot.workspace.inputs = ["waiting-a", "waiting-b"].map((id, i) => ({
      id,
      ...scope,
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body: `TEST 首字反馈 ${i + 1}`,
      author: { actantId: boot.actantId, principalId: boot.principalId },
      targetActantId: "morphz-agent",
      status: "recorded",
      createdAt: `2026-09-22T00:00:0${i}Z`,
    }));
    // A real conversation is required for the shared streaming subscription.
    if (!boot.workspace.conversations.some((c) => c.id === dialogue.id))
      boot.workspace.conversations.push({
        id: dialogue.id,
        projectId: dialogue.id,
        title: "对话",
        revision: 1,
        archivedAt: null,
        createdAt: "2026-09-22T00:00:00Z",
        updatedAt: "2026-09-22T00:00:00Z",
      });
    boot.runtime = {
      configured: true,
      connected,
      model: `waiting-fixture-${generation}`,
      error: "",
      deliveries,
      messages: replies,
      activity: { available: true, threads, truncated: false },
      attention: { available: true, approvals: [] },
    };
    boot.outputs = [];
    await route.fulfill({ response, json: boot });
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
      const response = page.waitForResponse(
        async (r) =>
          r.url().endsWith("/api/workspace") &&
          (await r.json()).runtime?.model === `waiting-fixture-${generation}`,
      );
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await response;
    },
    async stream(text: string, streaming = true) {
      await expect
        .poll(() => page.evaluate(() => (window as any).__waitingStreams.size))
        .toBeGreaterThan(0);
      await page.evaluate(
        ({ text, streaming, scope }) => {
          for (const source of (window as any).__waitingStreams) {
            source.onmessage?.({
              data: JSON.stringify({
                connected: true,
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
        { text, streaming, scope },
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
  await expect(
    waiting(page).getByRole("button", { name: "停止这次处理" }),
  ).toBeEnabled();
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
  await expect(waiting(page).getByRole("button")).toBeDisabled();
  delivery.cancelRequested = true;
  await f.update(true);
  await expect(waiting(page)).toContainText("已请求停止，等待确认");
  await expect(waiting(page).getByRole("button")).toBeDisabled();
  for (const state of ["cancelled", "failed", "completed"] as const) {
    delivery.state = state;
    await f.update();
    await expect(waiting(page)).toHaveCount(0);
  }
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
