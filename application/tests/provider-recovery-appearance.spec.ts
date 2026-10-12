import { expect } from "@playwright/test";
import {
  LiveConversationProjection,
  type StreamEvent,
} from "../packages/core/src/live-conversation.js";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import type { PlatformHistory } from "../apps/web/src/platform-client.js";
import {
  mockPlatformConversation,
  test,
} from "./platform-conversation-fixture.js";
import { openInput } from "./interaction-helpers.js";

test("真实投影的恢复记录按输入显示状态；并发、断线、刷新与正常／失败终态不串线", async ({
  page,
}, info) => {
  await page.addInitScript(() => {
    (window as any).__recoverySources = new Set();
    window.EventSource = class {
      onmessage: ((event: { data: string }) => void) | null = null;
      constructor(public url: string) {
        (window as any).__recoverySources.add(this);
      }
      close() {
        (window as any).__recoverySources.delete(this);
      }
    } as any;
  });
  const inputs: PlatformHistory["inputs"] = [];
  const runtime: PlatformHistory["runtime"] = {
    ...disconnectedRuntime,
    configured: true,
    connected: true,
    messages: [],
    deliveries: ["a", "b"].map((id) => ({
      inputId: `TEST-recovery-${id}`,
      state: "running",
      error: null,
      retryable: false,
      cancellable: true,
    })),
  };
  const f = await mockPlatformConversation(page, () => ({ inputs, runtime }));
  for (const id of ["a", "b"])
    inputs.push(
      f.input(
        `TEST-recovery-${id}`,
        `TEST 并发请求 ${id}。`,
        "2026-10-13T00:00:00Z",
      ),
    );
  const projection = new LiveConversationProjection((e) => ({
    ...f.scope,
    artifactId: null,
    inputId: `TEST-recovery-${e.payload.root_turn_id}`,
    rootId: String(e.payload.root_turn_id),
  }));
  let sequence = 0;
  function event(
    topic: string,
    root: string,
    payload: Record<string, unknown>,
  ): StreamEvent {
    return {
      id: `TEST-event-${++sequence}`,
      timestamp: `2026-10-13T00:00:${String(sequence).padStart(2, "0")}Z`,
      topic,
      payload: {
        root_turn_id: root,
        thread_id: `TEST-thread-${root}`,
        ...payload,
      },
    };
  }
  async function emit(connected = true) {
    const messages = projection.snapshot();
    await page.evaluate(
      ({ scope, messages, connected }) => {
        const path = `/api/platform/projects/${encodeURIComponent(scope.projectId)}/conversations/${encodeURIComponent(scope.conversationId)}/stream`;
        for (const source of (window as any).__recoverySources) {
          if (new URL(source.url, location.origin).pathname !== path)
            throw new Error("Unexpected recovery subscription");
          source.onmessage?.({
            data: JSON.stringify({
              connected,
              messages,
              reset: true,
              removed: [],
            }),
          });
        }
      },
      { scope: f.scope, messages, connected },
    );
  }
  const writes: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/(platform\/messages|executions\/(cancel|continue))/.test(
        request.url(),
      )
    )
      writes.push(request.url());
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "对话", exact: true })
    .click();
  const composer = await openInput(page);
  await composer.fill("TEST 恢复过程保留草稿");
  await expect
    .poll(() => page.evaluate(() => (window as any).__recoverySources.size))
    .toBe(1);
  const a = page.locator('[data-waiting-input-id="TEST-recovery-a"]');
  const b = page.locator('[data-waiting-input-id="TEST-recovery-b"]');
  await expect(a).toContainText("等待回复");
  projection.consume(
    event("runtime/model_stream", "a", {
      attempt_id: "a",
      stream: { kind: "started" },
    }),
  );
  projection.consume(
    event("runtime/model_stream", "a", {
      attempt_id: "a",
      stream: {
        kind: "failed",
        message: '{"error":{"code":"request_timeout"}}',
      },
    }),
  );
  await emit();
  await expect(page.locator(".conversation")).not.toContainText(
    "request_timeout",
  );
  const wait = event("chat/progress", "a", {
    attempt_id: "a",
    disposition: "provider_wait",
    text: "等待模型服务恢复",
  });
  projection.consume(wait);
  await emit();
  await expect(a).toContainText("自动重试中");
  await expect(b).toContainText("等待回复");
  runtime.connected = false;
  await f.refresh();
  await emit(false);
  await expect(a).toContainText("连接中断，等待恢复");
  runtime.connected = true;
  await f.refresh();
  await emit();
  await expect(a).toContainText("自动重试中");
  // The production schema preserves the Runtime's durable recovery metadata
  // in a history refresh as well as a live frame; no fake database mutation.
  runtime.messages = projection
    .snapshot()
    .filter((m) => m.kind !== "tool") as PlatformHistory["runtime"]["messages"];
  await f.refresh();
  await expect(a).toContainText("自动重试中");
  await page.screenshot({
    path: info.outputPath("provider-recovery-two-inputs.png"),
  });
  projection.consume(
    event("runtime/model_stream", "a", {
      attempt_id: "retry-a",
      stream: { kind: "started" },
    }),
  );
  projection.consume(
    event("runtime/model_stream", "a", {
      attempt_id: "retry-a",
      stream: { kind: "text_delta", text: "TEST 重试后的正常正文" },
    }),
  );
  projection.consume(
    event("chat/reply", "a", {
      attempt_id: "retry-a",
      text: "TEST 重试后的正常正文",
    }),
  );
  await emit();
  await expect(a).toHaveCount(0);
  await expect(page.locator(".conversation")).toContainText(
    "TEST 重试后的正常正文",
  );
  await expect(b).toContainText("等待回复");
  projection.consume(
    event("chat/runtime_error", "b", {
      attempt_id: "b",
      text: "TEST 模型配置需要修正，此请求已终止。",
    }),
  );
  await emit();
  await expect(b).toHaveCount(0);
  await expect(page.locator(".conversation")).toContainText(
    "TEST 模型配置需要修正，此请求已终止。",
  );
  await expect(page.locator(".conversation")).not.toContainText(
    "request_timeout",
  );
  await expect(composer).toHaveValue("TEST 恢复过程保留草稿");
  expect(writes).toEqual([]);
});
