import { expect } from "@playwright/test";
import {
  disconnectedRuntime,
  conversationRuntimeSchema,
  type ExecutionActivity,
} from "../packages/core/src/conversation.js";
import {
  LiveConversationProjection,
  type StreamEvent,
} from "../packages/core/src/live-conversation.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";
import { openExecutionPanel, openInput } from "./interaction-helpers.js";

// Production projection and mounted inspector; controlled Runtime transport,
// not a real model call or acceptance of the user's original Electron window.
test("重复等待不显示假工具，原分支状态、停止、失败详情与未发送草稿保留", async ({
  page,
}, info) => {
  await page.addInitScript(() => {
    const Native = window.EventSource;
    const sources = new Set<EventSource>();
    Reflect.set(window, "__waitStreams", sources);
    class ConversationStream extends EventTarget {
      onmessage: EventSource["onmessage"] = null;
      onerror: EventSource["onerror"] = null;
      close() {
        sources.delete(this as unknown as EventSource);
      }
      constructor(readonly url: string) {
        super();
        sources.add(this as unknown as EventSource);
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
  const threads: ExecutionActivity["threads"] = [];
  const fixture = await mockPlatformConversation(page, () => ({
    inputs: [],
    runtime: {
      ...disconnectedRuntime,
      configured: true,
      connected: true,
      activity: { available: true, truncated: false, threads },
      attention: { available: true, approvals: [] },
    },
  }));
  const stamp = "2026-10-09T00:00:00.000Z";
  threads.push({
    ...fixture.scope,
    id: "TEST-wait-thread",
    kind: "execution",
    inputId: null,
    rootId: "TEST-wait-root",
    sessionId: "TEST-session",
    contextId: "TEST-context",
    title: "TEST 核对操作演示",
    phase: "waiting",
    lifecycle: "open",
    revision: 1,
    updatedAt: stamp,
  });
  await page.route("**/api/executions?*", (route) =>
    route.fulfill({
      json: {
        jobs: [
          {
            id: "TEST-real-job",
            revision: 1,
            session_id: "TEST-session",
            context_id: "TEST-context",
            thread_id: "TEST-wait-thread",
            tool_name: "read",
            target_id: "local",
            status: "failed",
            request: { path: "TEST-original.md" },
            error: "TEST 原始读取错误",
            result_event_id: "TEST-receipt",
            created_at: stamp,
            updated_at: stamp,
          },
        ],
        approvals: [],
        limit: 100,
      },
    }),
  );
  await page.goto("/");
  const draft = "TEST 不发送的草稿";
  await (await openInput(page)).fill(draft);
  await openExecutionPanel(page);
  const panel = page.getByRole("complementary", {
    name: "Morphz 信息",
    exact: true,
  });
  await panel.locator('[data-thread-id="TEST-wait-thread"]').click();
  await page.waitForFunction(
    () => Reflect.get(window, "__waitStreams")?.size > 0,
  );
  const projection = new LiveConversationProjection(() => ({
    ...fixture.scope,
    artifactId: null,
    inputId: null,
    rootId: "TEST-wait-root",
  }));
  let sequence = 0;
  const consume = (topic: string, payload: StreamEvent["payload"]) =>
    projection.consume({
      id: `TEST-wait-event-${++sequence}`,
      timestamp: stamp,
      topic,
      payload: {
        root_turn_id: "TEST-wait-root",
        thread_id: "TEST-wait-thread",
        ...payload,
      },
    });
  const publish = async (messages: unknown = projection.snapshot()) =>
    page.evaluate((messages) => {
      for (const source of Reflect.get(
        window,
        "__waitStreams",
      ) as Set<EventSource>) {
        source.onmessage?.call(
          source,
          new MessageEvent("message", {
            data: JSON.stringify({
              connected: true,
              reset: true,
              removed: [],
              messages,
            }),
          }),
        );
      }
    }, messages);
  consume("chat/progress", { text: "TEST 继续核对可信来源" });
  for (let index = 0; index < 8; index++) {
    const attempt_id = `TEST-wait-${index}`;
    consume("runtime/model_stream", {
      attempt_id,
      stream: { kind: "started" },
    });
    consume("runtime/model_stream", {
      attempt_id,
      stream: {
        kind: "tool_call_started",
        index: 0,
        id: `TEST-no-reply-${index}`,
        name: "no_reply",
      },
    });
    consume("runtime/model_stream", {
      attempt_id,
      stream: { kind: "tool_call_completed", index: 0 },
    });
    await publish();
    await expect(panel.locator(".message-tool")).toHaveCount(0);
    consume("runtime/thread_waiting", { attempt_id });
  }
  consume("runtime/response_protocol_error", {
    attempt_id: "TEST-rejected",
    response_state: "invalid_wait",
    reason: "TEST 等待请求被拒绝：当前没有可等待事件",
    response_content_preview: "TEST 私有模型快照",
  });
  // A different thread's diagnostic must not leak into the selected branch.
  consume("runtime/response_protocol_error", {
    attempt_id: "TEST-foreign",
    thread_id: "TEST-other-thread",
    root_turn_id: "TEST-other-root",
    reason: "TEST 其他分支错误",
  });
  await publish();
  await expect(
    panel.getByText("TEST 继续核对可信来源", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("TEST 等待请求被拒绝：当前没有可等待事件", { exact: true }),
  ).toBeVisible();
  await expect(panel).not.toContainText("TEST 其他分支错误");
  await expect(panel).not.toContainText("TEST 私有模型快照");
  await expect(panel.locator(".message-tool")).toHaveCount(0);
  await expect(panel.locator(".execution-origin-status")).toContainText("等待");
  await expect(
    panel.getByRole("button", { name: "停止此分支", exact: true }),
  ).toBeEnabled();
  await expect(panel.locator('[data-job-id="TEST-real-job"]')).toContainText(
    "TEST 原始读取错误",
  );
  await panel
    .locator('[data-job-id="TEST-real-job"]')
    .getByRole("button", { name: "技术详情", exact: true })
    .click();
  await expect(
    panel.locator('[data-job-id="TEST-real-job"] pre'),
  ).toContainText("TEST-original.md");
  await panel.screenshot({
    path: info.outputPath("waiting-with-real-errors.png"),
  });
  await expect(await openInput(page)).toHaveValue(draft);
  const recovered = conversationRuntimeSchema.parse({
    ...disconnectedRuntime,
    messages: projection
      .snapshot()
      .filter((message) => message.kind === "progress"),
  });
  await page.reload();
  // The inspector was already open. Wait for hydration before the helper's
  // visibility branch; otherwise it can search for the wrong toggle name.
  await expect(panel).toBeVisible();
  await openExecutionPanel(page);
  await panel.locator('[data-thread-id="TEST-wait-thread"]').click();
  await page.waitForFunction(
    () => Reflect.get(window, "__waitStreams")?.size > 0,
  );
  await publish(recovered.messages);
  await expect(
    panel.getByText("TEST 继续核对可信来源", { exact: true }),
  ).toBeVisible();
  await expect(panel.locator(".message-tool")).toHaveCount(0);
  await expect(await openInput(page)).toHaveValue(draft);
});
