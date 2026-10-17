import { expect } from "@playwright/test";
import type { PlatformHistory } from "../apps/web/src/platform-client.js";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";
import { openInput } from "./interaction-helpers.js";

test("讨论正文直接流式可读，无内部术语和重复行，复制正文且刷新窄窗不溢出", async ({
  page,
}, info) => {
  await page.addInitScript(() => {
    Reflect.set(window, "copiedDiscussionText", "");
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string) => {
          Reflect.set(window, "copiedDiscussionText", text);
        },
      },
    });
    const sources = new Set<unknown>();
    Reflect.set(window, "evaluationStreams", sources);
    Reflect.set(
      window,
      "EventSource",
      class extends EventTarget {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSED = 2;
        onmessage: ((event: { data: string }) => void) | null = null;
        onerror: (() => void) | null = null;
        constructor(public url: string) {
          super();
          sources.add(this);
        }
        close() {
          sources.delete(this);
        }
      },
    );
  });
  const inputs: PlatformHistory["inputs"] = [];
  const runtime: PlatformHistory["runtime"] = {
    ...disconnectedRuntime,
    configured: true,
    connected: true,
    messages: [],
    deliveries: [],
  };
  const fixture = await mockPlatformConversation(page, () => ({
    inputs,
    runtime,
  }));
  const input = fixture.input(
    "TEST-evaluation-input",
    "TEST 讨论创意，不执行创作。",
    "2026-10-16T08:00:00Z",
  );
  inputs.push(input);
  runtime.deliveries.push({
    inputId: input.id,
    state: "running",
    error: null,
    retryable: false,
  });
  const source = { plan_execution_id: "TEST-plan", effect_sequence: 2 };
  const evaluation = {
    ...fixture.scope,
    id: "evaluation:TEST-infer",
    inputId: input.id,
    rootId: "TEST-infer-root",
    artifactId: null,
    kind: "evaluation" as const,
    text: '{"execute":false,"reply":"讨论正文第一行\\n第二行持续生成',
    createdAt: "2026-10-16T08:00:01Z",
    streaming: true,
    evaluation: {
      activationId: "TEST-infer",
      validation: "pending" as const,
      source,
      textPath: ["reply"],
    },
  };
  const writes: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/(platform\/messages|executions\/)/.test(request.url())
    )
      writes.push(request.url());
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  await (await openInput(page)).fill("TEST 未发送草稿保持原样");
  const streamPath =
    "/api/platform/projects/" +
    encodeURIComponent(fixture.scope.projectId) +
    "/conversations/" +
    encodeURIComponent(fixture.scope.conversationId) +
    "/stream";
  await expect
    .poll(() =>
      page.evaluate(
        (path) =>
          [...Reflect.get(window, "evaluationStreams")].filter(
            (source) => new URL(source.url, location.origin).pathname === path,
          ).length,
        streamPath,
      ),
    )
    .toBe(1);
  const emit = (messages: unknown[], connected = true) =>
    page.evaluate(
      ({ path, messages, connected }) => {
        for (const source of Reflect.get(window, "evaluationStreams"))
          if (new URL(source.url, location.origin).pathname === path)
            source.onmessage?.({
              data: JSON.stringify({
                reset: true,
                removed: [],
                connected,
                messages,
              }),
            });
      },
      { path: streamPath, messages, connected },
    );
  await emit([{ ...evaluation, text: '{"execute":false,' }]);
  await expect(
    page.locator('[data-message-id="evaluation:TEST-infer"]'),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-waiting-input-id="TEST-evaluation-input"]'),
  ).toBeVisible();
  await emit([evaluation]);
  const result = page.locator('[data-message-id="evaluation:TEST-infer"]');
  await expect(result).not.toContainText("求值结果");
  await expect(result).not.toContainText("execute");
  await expect(result.locator(".response-dots i").first()).toHaveCSS(
    "animation-name",
    "response-waiting-pulse",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(result.locator(".response-dots i").first()).toHaveCSS(
    "animation-name",
    "none",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(
    page.locator('[data-waiting-input-id="TEST-evaluation-input"]'),
  ).toHaveCount(0);
  await expect(result).toContainText("讨论正文第一行");
  await expect(result).toContainText("第二行持续生成");
  await expect(result).not.toContainText("\\n");
  await expect(result).not.toContainText('{"execute"');
  await result.hover();
  await result.getByRole("button", { name: "复制消息", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => Reflect.get(window, "copiedDiscussionText")),
    )
    .toBe("讨论正文第一行\n第二行持续生成");
  await emit([evaluation], false);
  await expect(result).toContainText("第二行持续生成");
  await expect(result.locator(".response-dots")).toHaveCount(0);
  await emit([evaluation]);
  await page.screenshot({ path: info.outputPath("evaluation-stream.png") });
  const acceptedValue = {
    ...evaluation,
    streaming: false,
    text: JSON.stringify({
      execute: false,
      reply: "讨论正文第一行\n第二行持续生成",
    }),
    evaluation: { ...evaluation.evaluation, validation: "accepted" as const },
  };
  runtime.messages[0] = acceptedValue;
  await emit([]);
  await fixture.refresh();
  await expect(result).toContainText("第二行持续生成");
  await expect(result).not.toContainText("已校验");
  await expect(
    page.locator('[data-message-id="TEST-final-reply"]'),
  ).toHaveCount(0);
  runtime.messages.push({
    ...fixture.scope,
    id: "TEST-final-reply",
    inputId: input.id,
    rootId: "TEST-root",
    artifactId: null,
    kind: "reply",
    text: "讨论正文第一行\n第二行持续生成",
    resultSource: { ...source, path: ["reply"] },
    createdAt: "2026-10-16T08:00:02Z",
  });
  runtime.deliveries[0]!.state = "completed";
  await fixture.refresh();
  await expect(result).toHaveCount(0);
  await expect(
    page.locator('[data-message-id="TEST-final-reply"]'),
  ).toContainText("讨论正文第一行");
  const final = page.locator('[data-message-id="TEST-final-reply"]');
  await expect(page.getByText("已用于回复", { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 720, height: 850 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await expect(final).toBeVisible();
  expect(
    await final.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("evaluation-final-dark-narrow.png"),
  });
  await page.reload();
  await expect(result).toHaveCount(0);
  await expect(final).toHaveCount(1);
  await expect(await openInput(page)).toHaveValue("TEST 未发送草稿保持原样");
  expect(writes).toEqual([]);
});
