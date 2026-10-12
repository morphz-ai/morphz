import { expect, type Page } from "@playwright/test";
import {
  disconnectedRuntime,
  type ExecutionActivity,
} from "../packages/core/src/conversation.js";
import type { LiveMessage } from "../packages/core/src/live-conversation.js";
import type { PlatformHistory } from "../apps/web/src/platform-client.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";
import {
  openExecutionPanel,
  openInput,
  settleTransitions,
} from "./interaction-helpers.js";
import { openSettings } from "./settings-helpers.js";

// Mounted production inspector, controlled transport and isolated test center.
// No model invocation, task controls or writes to the user's original App.
async function prepare(page: Page) {
  await page.setExtraHTTPHeaders({ Connection: "close" });
  await page.addInitScript(() => {
    const Native = window.EventSource;
    const streams = new Set<EventSource>();
    Reflect.set(window, "__progressStreams", streams);
    class ConversationStream extends EventTarget {
      onmessage: EventSource["onmessage"] = null;
      onerror: EventSource["onerror"] = null;
      constructor(readonly url: string) {
        super();
        streams.add(this as unknown as EventSource);
      }
      close() {
        streams.delete(this as unknown as EventSource);
      }
    }
    window.EventSource = new Proxy(Native, {
      construct(target, args) {
        const url = new URL(String(args[0]), location.href);
        return /^\/api\/platform\/projects\/[^/]+\/conversations\/[^/]+\/stream$/.test(
          url.pathname,
        )
          ? new ConversationStream(url.href)
          : Reflect.construct(target, args);
      },
    });
  });
  const activity: ExecutionActivity = {
    available: true,
    truncated: false,
    openWorkComplete: true,
    threads: [],
    objectives: [],
  };
  const runtime = {
    ...disconnectedRuntime,
    configured: true,
    connected: true,
    activity,
    attention: { available: true, approvals: [] },
  };
  const inputs: PlatformHistory["inputs"] = [];
  const fixture = await mockPlatformConversation(page, () => ({
    inputs,
    runtime,
  }));
  inputs.push(
    fixture.input(
      "TEST-progress-input",
      "TEST 请核对实现与交付证据",
      "2026-10-12T11:59:00Z",
    ),
    fixture.input(
      "TEST-other-input",
      "TEST 另一个独立请求",
      "2026-10-12T11:59:30Z",
    ),
  );
  for (const id of ["TEST-progress-thread", "TEST-other-thread"])
    activity.threads.push({
      ...fixture.scope,
      id,
      inputId:
        id === "TEST-progress-thread"
          ? "TEST-progress-input"
          : "TEST-other-input",
      rootId: `${id}-root`,
      sessionId: "TEST-progress-session",
      contextId: "TEST-progress-context",
      kind: "execution",
      title:
        id === "TEST-progress-thread"
          ? "TEST 核对实现与交付证据"
          : "TEST 另一项工作",
      summary: "核对真实实现，保留未验证部分。",
      phase: "running",
      lifecycle: "open",
      revision: 1,
      updatedAt: "2026-10-12T12:00:00Z",
    });
  await page.route("**/api/executions?*", (route) =>
    route.fulfill({
      json: {
        jobs: [1, 2]
          .map((order) => ({
            id: `TEST-step-${order}`,
            revision: 1,
            session_id: "TEST-progress-session",
            context_id: "TEST-progress-context",
            thread_id: "TEST-progress-thread",
            tool_name: "read",
            target_id: "local",
            status: "succeeded",
            request: { path: `TEST-${order}.md` },
            created_at: `2026-10-12T12:0${order}:00Z`,
            updated_at: "2026-10-12T12:05:00Z",
            annotation: { intent: `TEST 原顺序步骤 ${order}` },
          }))
          .reverse(),
        approvals: [],
        limit: 100,
      },
    }),
  );
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const draft = "TEST 阅读进展时保留的草稿";
  await (await openInput(page)).fill(draft);
  await openExecutionPanel(page);
  const panel = page.getByRole("complementary", {
    name: "Morphz 信息",
    exact: true,
  });
  await panel.locator('[data-thread-id="TEST-progress-thread"]').click();
  await page.waitForFunction(
    () => Reflect.get(window, "__progressStreams")?.size > 0,
  );
  const messages: LiveMessage[] = [];
  let sequence = 0;
  const add = (text: string, changes: Partial<LiveMessage> = {}) => {
    const count = ++sequence;
    const message: LiveMessage = {
      ...fixture.scope,
      id: `TEST-progress-${count}`,
      inputId: "TEST-progress-input",
      artifactId: null,
      rootId: "TEST-progress-thread-root",
      threadId: "TEST-progress-thread",
      createdAt: new Date(Date.UTC(2026, 9, 12, 12, count)).toISOString(),
      text,
      kind: "progress",
      ...changes,
    };
    messages.push(message);
    return message;
  };
  const publish = () =>
    page.evaluate((messages) => {
      for (const stream of Reflect.get(
        window,
        "__progressStreams",
      ) as Set<EventSource>)
        stream.onmessage?.call(
          stream,
          new MessageEvent("message", {
            data: JSON.stringify({
              connected: true,
              reset: true,
              removed: [],
              messages,
            }),
          }),
        );
    }, messages);
  const writes: string[] = [];
  page.on("request", (request) => {
    if (!["GET", "HEAD"].includes(request.method())) writes.push(request.url());
  });
  return {
    ...fixture,
    runtime,
    activity,
    panel,
    messages,
    add,
    publish,
    writes,
    draft,
  };
}

test("最新进展完整显示、历史默认收起且倒序；错误独立可见，主对话和步骤仍正序", async ({
  page,
}, info) => {
  const f = await prepare(page);
  const first = f.add("TEST 先读取实际资料");
  f.add("TEST 第一条正式回复", { kind: "reply" });
  const second = f.add("TEST 随后核对真实回执");
  f.add("TEST 第二条正式回复", { kind: "reply" });
  const text =
    "TEST 最新进展\n" +
    Array.from(
      { length: 8 },
      (_, i) => `第 ${i + 1} 段保持完整，不裁剪成前三行。`,
    ).join("\n");
  const latest = f.add(text);
  f.add("TEST 真实失败，不是旧进展", { kind: "error" });
  f.add("TEST 无关工作不泄漏", {
    threadId: "TEST-other-thread",
    rootId: "TEST-other-thread-root",
  });
  await f.publish();
  const progress = f.panel.getByRole("region", { name: "工作进展" });
  const history = progress.locator("details");
  await expect(progress.locator("[data-latest] p")).toHaveText(text);
  await expect(
    progress.locator(`[data-progress-id="${first.id}"]`),
  ).not.toBeVisible();
  await expect(history).not.toHaveAttribute("open");
  await expect(history.locator("summary")).toHaveText("此前进展 · 2 条");
  await expect(
    f.panel.getByText("TEST 真实失败，不是旧进展", { exact: true }),
  ).toBeVisible();
  await expect(progress).not.toContainText("无关工作");
  await expect(progress).not.toContainText("真实失败");
  await history.locator("summary").click();
  await expect(history).toHaveAttribute("open");
  expect(
    await history
      .locator("article")
      .evaluateAll((rows) =>
        rows.map((row) => row.getAttribute("data-progress-id")),
      ),
  ).toEqual([second.id, first.id]);
  await expect(progress.locator("[data-latest] time")).toHaveAttribute(
    "datetime",
    latest.createdAt,
  );
  expect(
    await f.panel
      .locator(".execution-job")
      .evaluateAll((rows) =>
        rows.map((row) => row.getAttribute("data-job-id")),
      ),
  ).toEqual(["TEST-step-1", "TEST-step-2"]);
  // Progress already belongs to the inspector, not the main dialogue. Formal
  // replies from the same shared stream keep their chronological publications.
  const conversation = page.getByRole("region", {
    name: "当前对话",
    exact: true,
  });
  const texts = await conversation
    .locator(".conversation-message")
    .allTextContents();
  const reply1 = texts.findIndex((value) =>
    value.includes("TEST 第一条正式回复"),
  );
  const reply2 = texts.findIndex((value) =>
    value.includes("TEST 第二条正式回复"),
  );
  expect(reply1).toBeGreaterThanOrEqual(0);
  expect(reply2).toBeGreaterThanOrEqual(0);
  expect(reply1).toBeLessThan(reply2);
  expect(
    texts.some(
      (value) =>
        value.includes("TEST 最新进展") ||
        value.includes(first.text) ||
        value.includes(second.text),
    ),
  ).toBe(false);
  await history.locator("summary").press("Enter");
  await expect(history).not.toHaveAttribute("open");
  await history.locator("summary").press("Space");
  await expect(history).toHaveAttribute("open");
  await progress.screenshot({ path: info.outputPath("expanded-progress.png") });
  await expect(await openInput(page)).toHaveValue(f.draft);
  expect(f.writes).toEqual([]);
});

test("手动折叠状态在新进展、终态及刷新中保留；切换执行不串内容或展开状态", async ({
  page,
}) => {
  const f = await prepare(page);
  f.add("TEST 初始进展");
  f.add("TEST 第二条进展");
  await f.publish();
  const progress = f.panel.locator(".execution-progress");
  const history = progress.locator("details");
  await expect(progress).toHaveAttribute("data-running");
  f.add("TEST 运行中第三条");
  await f.publish();
  await expect(history).not.toHaveAttribute("open");
  await expect(progress.locator("[data-latest] p")).toHaveText(
    "TEST 运行中第三条",
  );
  await history.locator("summary").click();
  await expect(history).toHaveAttribute("open");
  f.add("TEST 运行中第四条");
  await f.publish();
  await expect(history).toHaveAttribute("open");
  f.activity.threads[0]!.lifecycle = "completed";
  f.activity.threads[0]!.phase = "idle";
  await f.refresh();
  await expect(progress).not.toHaveAttribute("data-running");
  await expect(history).toHaveAttribute("open");
  await history.locator("summary").click();
  await expect(history).not.toHaveAttribute("open");
  f.activity.threads[0]!.summary = "TEST 终态刷新不改变阅读选择";
  await f.refresh();
  await expect(history).not.toHaveAttribute("open");
  f.add("TEST 其他任务第一条", { threadId: "TEST-other-thread" });
  f.add("TEST 其他任务最新条", { threadId: "TEST-other-thread" });
  await f.publish();
  await history.locator("summary").click();
  await f.panel
    .getByRole("button", { name: "返回活动列表", exact: true })
    .click();
  await f.panel.locator('[data-thread-id="TEST-other-thread"]').click();
  await expect(progress.locator("[data-latest] p")).toHaveText(
    "TEST 其他任务最新条",
  );
  await expect(history).not.toHaveAttribute("open");
  await expect(progress).not.toContainText("运行中第四条");
  await expect(await openInput(page)).toHaveValue(f.draft);
  expect(f.writes).toEqual([]);
});

test("阅读较早进展时新消息不抢滚动位置、选文和焦点", async ({ page }) => {
  const f = await prepare(page);
  for (let index = 0; index < 20; index++)
    f.add(
      `TEST 进展 ${index}\n` +
        "这是可完整阅读的过程内容，保留读者位置与选文。".repeat(8),
    );
  await f.publish();
  const history = f.panel.locator(".execution-progress-history");
  await history.locator("summary").click();
  const anchor = history.locator(`[data-progress-id="${f.messages[8]!.id}"] p`);
  await anchor.scrollIntoViewIfNeeded();
  const before = (await anchor.boundingBox())!;
  await anchor.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  const selection = await page.evaluate(() =>
    window.getSelection()?.toString(),
  );
  await page.evaluate(() =>
    Reflect.set(window, "__progressFocus", document.activeElement),
  );
  f.add(
    "TEST 新消息更长\n" + "新内容只更新最新进展，不打断旧内容阅读。".repeat(24),
  );
  await f.publish();
  await expect(history).toHaveAttribute("open");
  await expect(f.panel.locator("[data-latest] p")).toContainText(
    "TEST 新消息更长",
  );
  const after = (await anchor.boundingBox())!;
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(2);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
    selection,
  );
  expect(
    await page.evaluate(
      () => document.activeElement === Reflect.get(window, "__progressFocus"),
    ),
  ).toBe(true);
  expect(f.writes).toEqual([]);
});

test("没有进展不留空区；原文安全可选、无效时间不伪造，截断信息如实显示", async ({
  page,
}) => {
  const f = await prepare(page);
  f.add("TEST 普通回复不是进展", { kind: "reply" });
  await f.publish();
  await expect(f.panel.locator(".execution-progress")).toHaveCount(0);
  f.add("<script>window.__injected = true</script>\n**TEST 不擅自改变原文**", {
    createdAt: "invalid",
    truncated: true,
  });
  await f.publish();
  const entry = f.panel.locator(".execution-progress-entry");
  await expect(entry.locator("p")).toHaveText(
    "<script>window.__injected = true</script>\n**TEST 不擅自改变原文**",
  );
  await expect(entry.locator("script")).toHaveCount(0);
  await expect(entry.locator("time")).toHaveCount(0);
  await expect(
    entry.getByText("此条进展未完整接收", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => Reflect.get(window, "__injected")),
  ).toBeUndefined();
  expect(
    await entry.locator("p").evaluate((e) => getComputedStyle(e).userSelect),
  ).not.toBe("none");
});

test("不可用快照不冒充运行，新鲜状态恢复不自动展开历史", async ({ page }) => {
  const f = await prepare(page);
  f.add("TEST 第一条");
  f.add("TEST 最新条");
  await f.publish();
  const progress = f.panel.locator(".execution-progress");
  const history = progress.locator("details");
  await expect(progress).toHaveAttribute("data-running");
  f.activity.available = false;
  await f.refresh();
  await expect(progress).not.toHaveAttribute("data-running");
  await expect(history).not.toHaveAttribute("open");
  f.activity.available = true;
  await f.refresh();
  await expect(progress).toHaveAttribute("data-running");
  await expect(history).not.toHaveAttribute("open");
});

test("四种主题明暗下进展保持平面层级，无额外光圈，窄窗与两倍布局不溢出", async ({
  page,
}, info) => {
  const f = await prepare(page);
  f.add("已读取项目说明，接下来核对实际执行记录。");
  f.add(
    "已核对两个关键实现，正在检查公开测试的失败记录。\n未验证的部分仍单独保留，不能把静态审阅当成运行验收。",
  );
  await f.publish();
  const progress = f.panel.locator(".execution-progress");
  for (const appearance of ["亮色", "暗色"])
    for (const color of ["电光青", "鸢尾紫", "暖珊瑚", "纯单色"]) {
      await openSettings(page, "外观");
      await page.getByRole("button", { name: appearance, exact: true }).click();
      await page.getByRole("button", { name: color, exact: true }).click();
      await page.keyboard.press("Escape");
      await settleTransitions(page);
      const style = await progress.evaluate((element) => {
        const p = element.querySelector("[data-latest] p")!;
        const label = element.querySelector("[data-latest] header > span")!;
        return {
          background: getComputedStyle(element).backgroundColor,
          shadow: getComputedStyle(element).boxShadow,
          bodyColor: getComputedStyle(p).color,
          labelColor: getComputedStyle(label).color,
          clamp: getComputedStyle(p).webkitLineClamp,
          overflow: element.scrollWidth > element.clientWidth + 1,
          animations: element.getAnimations({ subtree: true }).length,
        };
      });
      expect(style.background).toBe("rgba(0, 0, 0, 0)");
      expect(style.shadow).toBe("none");
      expect(style.clamp).toBe("none");
      expect(style.overflow).toBe(false);
      expect(style.animations).toBe(0);
      expect(style.labelColor).not.toBe(style.bodyColor);
      await f.panel.screenshot({
        path: info.outputPath(`progress-${appearance}-${color}.png`),
      });
    }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(progress).toBeVisible();
  expect(
    await f.panel.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  await f.panel.screenshot({ path: info.outputPath("progress-narrow.png") });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.evaluate(() => {
    document.body.style.zoom = "2";
  });
  expect(
    await progress.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  await f.panel.screenshot({ path: info.outputPath("progress-css-200.png") });
});

test("触控有44px历史入口，减少动态不增加动画", async ({ browser }, info) => {
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 820, height: 1000 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  try {
    const f = await prepare(page);
    f.add("TEST 触控历史");
    f.add("TEST 触控最新");
    await f.publish();
    const history = f.panel.locator(".execution-progress-history");
    const summary = history.locator("summary");
    expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await summary.tap();
    await expect(history).toHaveAttribute("open");
    await summary.tap();
    await expect(history).not.toHaveAttribute("open");
    expect(
      await f.panel
        .locator(".execution-progress")
        .evaluate((e) => e.getAnimations({ subtree: true }).length),
    ).toBe(0);
    await f.panel.screenshot({ path: info.outputPath("progress-touch.png") });
    expect(f.writes).toEqual([]);
    await page.unrouteAll({ behavior: "wait" });
  } finally {
    await context.close();
  }
});
