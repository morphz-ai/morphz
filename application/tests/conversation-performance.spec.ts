import { test, expect } from "@playwright/test";
import type { Boot } from "../apps/web/src/client.js";
import { seedCenter } from "./center-fixtures.js";

test("长消息历史下输入和流式续写不反复阻塞主线程", async ({ page }, info) => {
  await page.addInitScript(() => {
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
  await page.route("**/api/workspace", async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), "if-none-match": "" },
    });
    const boot: Boot = await response.json();
    const projectId = boot.workspace.projects.find(
      (p) => p.kind === "dialogue",
    )!.id;
    boot.workspace.inputs = Array.from({ length: 64 }, (_, i) => ({
      id: `performance-input-${i}`,
      projectId,
      conversationId: projectId,
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body: `TEST 性能回归问题 ${i}`,
      author: { actantId: boot.actantId, principalId: boot.principalId },
      targetActantId: "morphz-agent",
      status: "recorded",
      createdAt: new Date(Date.UTC(2026, 8, 21, 0, i)).toISOString(),
    }));
    boot.runtime = {
      ...boot.runtime,
      configured: true,
      connected: true,
      messages: boot.workspace.inputs.map((input, i) => ({
        id: `performance-reply-${i}`,
        projectId,
        conversationId: projectId,
        inputId: input.id,
        rootId: null,
        artifactId: null,
        kind: "reply",
        createdAt: new Date(Date.parse(input.createdAt) + 1000).toISOString(),
        text:
          `## TEST 历史回复 ${i}\n\n` +
          Array.from(
            { length: 10 },
            (_, n) =>
              `段落 ${n}：**人物与场景**保持一致。这里是用于测量的合成文字，不发送模型、不写入用户中心。\n\n| 人物 | 行动 |\n| --- | --- |\n| 甲 | 等待 |\n| 乙 | 返回 |\n\n`,
          ).join(""),
      })),
      deliveries: boot.workspace.inputs.map((input) => ({
        inputId: input.id,
        state: "completed",
        error: null,
        retryable: false,
      })),
    };
    boot.outputs = [];
    await route.fulfill({ response, json: boot });
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const input = page.getByLabel("AI 输入内容");
  await expect(page.locator(".conversation-message")).toHaveCount(128);
  await input.focus();
  const metrics = await page.evaluate(async () => {
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
    const observer = new PerformanceObserver((list) => {
      longTasks.push(...list.getEntries().map((entry) => entry.duration));
    });
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
        const params = new URL(source.url, location.origin).searchParams;
        source.onmessage?.({
          data: JSON.stringify({
            connected: true,
            reset: true,
            removed: [],
            messages: [
              {
                id: "performance-live",
                projectId: params.get("projectId"),
                conversationId: params.get("conversationId"),
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
    };
  });
  console.log("MESSAGE_PERFORMANCE", JSON.stringify(metrics));
  await info.attach("message-performance", {
    body: JSON.stringify(metrics, null, 2),
    contentType: "application/json",
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

test("缓存正文解析不缓存对象访问权限，原文不变时链接仍随快照更新", async ({
  page,
}) => {
  const targetId = await seedCenter(page, {
    type: "create-artifact",
    projectId: "first-project",
    title: "TEST 性能链接目标",
    content: { kind: "document", markdown: "TEST 对象正文" },
  });
  let visible = true,
    revision = 0;
  await page.route("**/api/workspace", async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), "if-none-match": "" },
    });
    const boot: Boot = await response.json();
    const projectId = boot.workspace.projects.find(
      (p) => p.kind === "dialogue",
    )!.id;
    if (!visible)
      boot.workspace.artifacts = boot.workspace.artifacts.filter(
        (a) => a.id !== targetId,
      );
    boot.workspace.inputs = [];
    boot.runtime = {
      ...boot.runtime,
      configured: true,
      connected: true,
      model: `permission-${revision}`,
      deliveries: [],
      messages: [
        {
          id: "permission-reply",
          projectId,
          conversationId: projectId,
          inputId: null,
          rootId: null,
          artifactId: null,
          kind: "reply",
          createdAt: "2026-09-21T00:00:00Z",
          text: `TEST 相同正文 [TEST 打开对象](artifact:${targetId})\n\n![TEST 外部图](https://invalid.example/performance.png)`,
        },
      ],
    };
    boot.outputs = [];
    await route.fulfill({ response, json: boot });
  });
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
  const change = async (next: boolean) => {
    visible = next;
    revision++;
    const updated = page.waitForResponse(
      async (r) =>
        r.url().endsWith("/api/workspace") &&
        (await r.json()).runtime?.model === `permission-${revision}`,
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await updated;
  };
  await change(false);
  await expect(link).toHaveCount(0);
  await expect(message).toContainText("TEST 打开对象（不可用）");
  await change(true);
  await expect(link).toBeVisible();
  await expect(message.locator("img")).toHaveCount(0);
  await expect(
    message.getByRole("link", { name: "查看外部图片：TEST 外部图" }),
  ).toBeVisible();
  await link.click();
  await expect(page.locator(".object-paper")).toContainText("TEST 对象正文");
});
