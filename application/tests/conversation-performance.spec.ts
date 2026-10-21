import { expect, type Page, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { PlatformHistory } from "../apps/web/src/platform-client.js";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

async function profileMeasurement<T>(
  page: Page,
  info: TestInfo,
  measure: () => Promise<T>,
): Promise<T> {
  if (process.env.MORPHZ_TEST_CONVERSATION_CPU_PROFILE !== "1")
    return measure();
  // Explicit diagnosis only: normal budget verification has no profiler
  // overhead. Keep the original workload, assertions and failure result.
  const session = await page.context().newCDPSession(page);
  const timeline: unknown[] = [];
  session.on("Tracing.dataCollected", ({ value }) => timeline.push(...value));
  const traced = new Promise<void>((resolve) =>
    session.once("Tracing.tracingComplete", () => resolve()),
  );
  await session.send("Tracing.start", {
    categories:
      process.env.MORPHZ_TEST_CONVERSATION_INVALIDATION_TRACE === "1"
        ? "devtools.timeline,disabled-by-default-devtools.timeline.invalidationTracking"
        : "devtools.timeline",
  });
  await session.send("Profiler.enable");
  await session.send("Profiler.start");
  try {
    return await measure();
  } finally {
    const { profile } = await session.send("Profiler.stop");
    await info.attach("conversation-render.cpuprofile", {
      body: JSON.stringify(profile),
      contentType: "application/json",
    });
    await session.send("Tracing.end");
    await Promise.race([
      traced,
      new Promise<never>((_resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Browser timeline did not complete")),
          5000,
        );
        timeout.unref();
      }),
    ]);
    await info.attach("conversation-render.timeline.json", {
      body: JSON.stringify({ traceEvents: timeline }),
      contentType: "application/json",
    });
    await session.detach();
  }
}

test("长消息历史下输入和流式续写不反复阻塞主线程", async ({ page }, info) => {
  await page.addInitScript(() => {
    const timeFormats = new Map<number, number>();
    const format = Date.prototype.toLocaleString;
    Date.prototype.toLocaleString = function (...args) {
      const timestamp = this.getTime();
      timeFormats.set(timestamp, (timeFormats.get(timestamp) ?? 0) + 1);
      return Reflect.apply(format, this, args);
    };
    (window as any).__messageTimeFormats = timeFormats;
    const geometryWrites = { total: 0, redundant: 0 };
    const setProperty = CSSStyleDeclaration.prototype.setProperty;
    CSSStyleDeclaration.prototype.setProperty = function (
      name,
      value,
      priority,
    ) {
      if (
        name === "--composer-tools-height" ||
        name === "--exchange-overlay-height"
      ) {
        geometryWrites.total++;
        if (this.getPropertyValue(name) === value) geometryWrites.redundant++;
      }
      return Reflect.apply(setProperty, this, [name, value, priority]);
    };
    (window as any).__exchangeGeometryWrites = geometryWrites;
    const heightReads = { total: 0 };
    const height = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetHeight",
    )!;
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      ...height,
      get() {
        if (
          this.classList.contains("exchange-panel") ||
          this.classList.contains("application-dock") ||
          this.classList.contains("exchange-controls-slot")
        )
          heightReads.total++;
        return height.get!.call(this);
      },
    });
    (window as any).__exchangeHeightReads = heightReads;
    const streams = new Set<any>();
    (window as any).__performanceStreams = streams;
    (window as any).EventSource = class {
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror = null;
      constructor(public url: string) {
        streams.add(this);
      }
      close() {
        streams.delete(this);
      }
    };
  });
  const inputs: PlatformHistory["inputs"] = [];
  const presentation = await mockPlatformConversation(page, () => ({
    inputs,
    runtime: {
      ...disconnectedRuntime,
      configured: true,
      connected: true,
      messages: inputs.map((input, i) => ({
        id: `performance-reply-${i}`,
        ...presentation.scope,
        inputId: input.id,
        rootId: null,
        artifactId: null,
        kind: "reply" as const,
        createdAt: new Date(Date.parse(input.createdAt) + 1000).toISOString(),
        text:
          `## TEST 历史回复 ${i}\n\n` +
          Array.from(
            { length: 10 },
            (_, n) =>
              `段落 ${n}：**人物与场景**保持一致。这里是用于测量的合成文字，不发送模型、不写入用户中心。\n\n| 人物 | 行动 |\n| --- | --- |\n| 甲 | 等待 |\n| 乙 | 返回 |\n\n`,
          ).join(""),
      })),
      deliveries: inputs.map((input) => ({
        inputId: input.id,
        state: "completed" as const,
        error: null,
        retryable: false,
      })),
    },
  }));
  // Explicit diagnosis only: compare a fresh test center with the unrelated
  // project rows accumulated before this case in the complete CI inventory.
  // Ordinary validation keeps its original workload and <50ms assertions.
  const extraProjects = process.env.MORPHZ_TEST_CONVERSATION_EXTRA_PROJECTS;
  if (extraProjects !== undefined) {
    expect(process.env.MORPHZ_TEST_CONVERSATION_CPU_PROFILE).toBe("1");
    expect(["0", "21"]).toContain(extraProjects);
    for (let index = 0; index < Number(extraProjects); index++)
      await presentation.client.createProject(
        `TEST 性能诊断项目 ${index}`,
        randomUUID(),
        randomUUID(),
      );
  }
  inputs.push(
    ...Array.from({ length: 64 }, (_, i) =>
      presentation.input(
        `performance-input-${i}`,
        `TEST 性能回归问题 ${i}`,
        new Date(Date.UTC(2026, 8, 21, 0, i)).toISOString(),
      ),
    ),
  );
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const input = page.getByLabel("AI 输入内容");
  await expect(page.locator(".conversation-message")).toHaveCount(128);
  if (extraProjects !== undefined)
    console.log(
      "MESSAGE_PERFORMANCE_PROJECT_ROWS",
      await page.locator(".sidebar-project").count(),
    );
  await input.focus();
  const metrics = await profileMeasurement(page, info, () =>
    page.evaluate(async (scope) => {
      const field = document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="AI 输入内容"]',
      )!;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      const frame = () =>
        new Promise<void>((done) => requestAnimationFrame(() => done()));
      const typing: number[] = [],
        streaming: number[] = [];
      const longTasks: number[] = [];
      const timeFormats = (window as any).__messageTimeFormats as Map<
        number,
        number
      >;
      const historyTimes = [
        ...document.querySelectorAll<HTMLTimeElement>(
          ".conversation-message .message-peek time[datetime]",
        ),
      ].map((time) => new Date(time.dateTime).getTime());
      const beforeFormats = new Map(
        historyTimes.map((time) => [time, timeFormats.get(time) ?? 0]),
      );
      const observer = new PerformanceObserver((list) => {
        longTasks.push(...list.getEntries().map((entry) => entry.duration));
      });
      const geometryWrites = (window as any).__exchangeGeometryWrites as {
        total: number;
        redundant: number;
      };
      const beforeGeometry = { ...geometryWrites };
      const heightReads = (window as any).__exchangeHeightReads as {
        total: number;
      };
      const beforeHeightReads = heightReads.total;
      observer.observe({ type: "longtask" });
      for (let n = 0; n < 12; n++) {
        await frame();
        const start = performance.now();
        setter.call(field, `TEST 保留草稿 ${"字".repeat(n + 1)}`);
        field.dispatchEvent(new Event("input", { bubbles: true }));
        await frame();
        typing.push(performance.now() - start);
      }
      for (let n = 0; n < 12; n++) {
        await frame();
        const start = performance.now();
        for (const source of (window as any).__performanceStreams) {
          source.onmessage?.({
            data: JSON.stringify({
              connected: true,
              reset: true,
              removed: [],
              messages: [
                {
                  id: "performance-live",
                  ...scope,
                  artifactId: null,
                  inputId: "performance-input-63",
                  rootId: "root",
                  kind: "reply",
                  text: "TEST 实时新回复" + "继续。".repeat(n + 1),
                  streaming: true,
                  createdAt: "2026-09-21T03:00:00Z",
                },
              ],
            }),
          });
        }
        await frame();
        streaming.push(performance.now() - start);
      }
      await frame();
      observer.disconnect();
      const median = (xs: number[]) =>
        xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)]!;
      return {
        typingMedianMs: median(typing),
        streamingMedianMs: median(streaming),
        typing,
        streaming,
        longTasks,
        exchangeGeometryWrites: geometryWrites.total - beforeGeometry.total,
        redundantExchangeGeometryWrites:
          geometryWrites.redundant - beforeGeometry.redundant,
        exchangeHeightReads: heightReads.total - beforeHeightReads,
        historyTimeCount: historyTimes.length,
        historyTimeReformats: historyTimes.reduce(
          (sum, time) =>
            sum + (timeFormats.get(time) ?? 0) - beforeFormats.get(time)!,
          0,
        ),
      };
    }, presentation.scope),
  );
  console.log("MESSAGE_PERFORMANCE", JSON.stringify(metrics));
  await info.attach("message-performance", {
    body: JSON.stringify(metrics, null, 2),
    contentType: "application/json",
  });
  await page.screenshot({
    path: info.outputPath("long-history-after-stream.png"),
  });
  expect(metrics.historyTimeCount).toBe(128);
  expect(metrics.historyTimeReformats).toBe(0);
  expect(metrics.redundantExchangeGeometryWrites).toBe(0);
  expect(metrics.exchangeHeightReads).toBe(0);
  const historyTime = page.locator(
    ".conversation-message .message-peek time[datetime]",
  );
  expect(
    await historyTime.evaluateAll((times) =>
      times.every(
        (time) =>
          time.textContent ===
          new Date(time.getAttribute("datetime")!).toLocaleString("zh-CN", {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          }),
      ),
    ),
  ).toBe(true);
  await historyTime.last().scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath("history-timestamp-after-stream.png"),
  });
  await expect(input).toHaveValue("TEST 保留草稿 " + "字".repeat(12));
  await expect(
    page.locator('[data-message-id="performance-live"]'),
  ).toContainText("继续。".repeat(12));
  // Frame-inclusive medians avoid noisy one-off CI scheduling, but a historical
  // Markdown reparse on every keystroke/stream delta must fail this budget.
  expect(metrics.typingMedianMs).toBeLessThan(50);
  expect(metrics.streamingMedianMs).toBeLessThan(50);
});

test("缓存正文解析不缓存对象访问权限，打开原文仍核对当前目录授权", async ({
  page,
}) => {
  let denied = true;
  let targetId = "";
  const presentation = await mockPlatformConversation(page, () => ({
    inputs: [],
    runtime: {
      ...disconnectedRuntime,
      configured: true,
      connected: true,
      model: "permission-fixture",
      deliveries: [],
      messages: [
        {
          id: "permission-reply",
          ...presentation.scope,
          inputId: null,
          rootId: null,
          artifactId: null,
          kind: "reply" as const,
          createdAt: "2026-09-21T00:00:00Z",
          text: `TEST 相同正文 [TEST 打开对象](artifact:${targetId})\n\n![TEST 外部图](https://invalid.example/performance.png)`,
        },
      ],
    },
  }));
  const created = (await presentation.client.createDocument({
    commandId: randomUUID(),
    objectId: randomUUID(),
    projectId: presentation.spaces.deskId,
    title: "TEST 性能链接目标",
    markdown: "TEST 对象正文",
  })) as { contentId: string };
  targetId = created.contentId;
  let reads = 0;
  await page.route(
    new RegExp(`/api/platform/content/${targetId}(?:\\?.*)?$`),
    async (route) => {
      reads++;
      if (denied)
        await route.fulfill({
          status: 403,
          json: { message: "TEST 当前访问权限已撤销" },
        });
      else await route.continue();
    },
  );
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const message = page.locator('[data-message-id="permission-reply"]');
  const link = message.getByRole("button", {
    name: "TEST 打开对象",
    exact: true,
  });
  await expect(link).toBeVisible();
  await link.click();
  await expect(
    page.locator(".workspace-notice").getByRole("alert"),
  ).toContainText("TEST 当前访问权限已撤销");
  await expect(page.locator(".object-paper")).toHaveCount(0);
  expect(reads).toBeGreaterThan(0);
  denied = false;
  await expect(link).toBeVisible();
  await expect(message.locator("img")).toHaveCount(0);
  await expect(
    message.getByRole("link", { name: "查看外部图片：TEST 外部图" }),
  ).toBeVisible();
  await link.click();
  await expect(page.locator(".object-paper")).toContainText("TEST 对象正文");
});
