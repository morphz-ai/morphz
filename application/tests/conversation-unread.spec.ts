import { test, expect, type Page } from "@playwright/test";
import type { Boot } from "../apps/web/src/client.js";
import { openInput, composerAction } from "./interaction-helpers.js";
import { seedCenter } from "./center-fixtures.js";
import {
  LiveConversationProjection,
  type StreamEvent,
} from "../packages/core/src/live-conversation.js";

type Reply = {
  id: string;
  text: string;
  kind: "reply" | "progress" | "error";
  inputId?: string;
  sequence?: number;
};
async function setup(page: Page, artifactId: string | null = null) {
  let messages: Reply[] = [
    { id: "read-one", text: "TEST 已读的第一条回复", kind: "reply" },
    { id: "read-two", text: "TEST 已读的第二条回复", kind: "reply" },
  ];
  let generation = 0;
  await page.addInitScript(() => {
    const sources = new Set<any>();
    (window as any).__readStreams = sources;
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
    const projectId = boot.workspace.projects.find(
      (p) => p.kind === "desk",
    )!.id;
    const conversationId = boot.workspace.projects.find(
      (p) => p.kind === "dialogue",
    )!.id;
    boot.workspace.inputs = [
      {
        id: "unread-input",
        projectId,
        conversationId,
        artifactId,
        artifactRevision: null,
        selection: "",
        body: "TEST 未读验收输入",
        author: { actantId: boot.actantId, principalId: boot.principalId },
        targetActantId: "morphz-agent",
        status: "recorded",
        createdAt: "2026-09-20T00:00:00Z",
      },
    ];
    boot.workspace.inputs.push({
      ...boot.workspace.inputs[0]!,
      id: "other-input",
      artifactId: null,
    });
    boot.runtime = {
      ...boot.runtime,
      configured: true,
      connected: true,
      model: `read-fixture-${generation}`,
      deliveries: [],
      messages: messages.map((m, index) => ({
        ...m,
        projectId,
        conversationId,
        inputId: m.inputId ?? "unread-input",
        rootId: null,
        artifactId: null,
        createdAt: `2026-09-20T00:00:${String(index + 1).padStart(2, "0")}Z`,
      })),
    };
    boot.outputs = [];
    await route.fulfill({ response, json: boot });
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "工作台", exact: true })
    .click();
  await page.getByRole("button", { name: "应用启动台", exact: true }).click();
  const input = await openInput(page);
  await input.fill("TEST 保留未发送草稿");
  await expect(
    page.getByText("TEST 已读的第二条回复", { exact: true }),
  ).toBeVisible();
  return {
    input,
    async update(next: Reply[]) {
      messages = next;
      generation++;
      const response = page.waitForResponse(
        async (r) =>
          r.url().endsWith("/api/workspace") &&
          (await r.json()).runtime?.model === `read-fixture-${generation}`,
      );
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await response;
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
    },
    messages: () => messages,
  };
}
const badge = (page: Page) =>
  page.locator(".composer-reopen .unread-label, .composer-unread");
async function hide(page: Page) {
  await composerAction(page, "收起 AI 输入框");
  await expect(page.locator(".composer-reopen")).toBeVisible();
}

test("已读回复刷新后不重报，真正未读跨刷新保留，读完后再次收起没有提示", async ({
  page,
}) => {
  const fixture = await setup(page);
  await hide(page);
  await page.reload();
  await expect(page.locator(".composer-reopen")).toBeVisible();
  await expect(badge(page)).toHaveCount(0);
  await fixture.update([
    ...fixture.messages(),
    { id: "new-reply", text: "TEST 真正新到的回复", kind: "reply" },
  ]);
  await expect(badge(page)).toBeVisible();
  await page.reload();
  await expect(badge(page)).toBeVisible();
  await openInput(page);
  await expect(fixture.input).toHaveValue("TEST 保留未发送草稿");
  await expect(
    page.getByText("TEST 真正新到的回复", { exact: true }),
  ).toBeVisible();
  await hide(page);
  await expect(badge(page)).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".composer-reopen")).toBeVisible();
  await expect(badge(page)).toHaveCount(0);
});

test("后台进度、空回复、快照重排或暂时缺项不会产生新回复提示", async ({
  page,
}) => {
  const fixture = await setup(page);
  await hide(page);
  const old = fixture.messages();
  for (const messages of [
    [
      ...old,
      { id: "progress", text: "TEST 后台进度变化", kind: "progress" as const },
    ],
    [...old, { id: "empty", text: "", kind: "reply" as const }],
    old.toReversed(),
    old.slice(1),
    old,
  ]) {
    await fixture.update(messages);
    await expect(badge(page)).toHaveCount(0);
  }
  await fixture.update([
    ...old,
    { id: "error", text: "TEST 真实错误仍需提醒", kind: "error" },
  ]);
  await expect(badge(page)).toBeVisible();
});

test("已经看见的流式回复转为正式回执不重复提示，收起后的新续写仍提醒", async ({
  page,
}) => {
  const fixture = await setup(page);
  const emit = async (id: string, text: string, streaming: boolean) =>
    page.evaluate(
      ({ id, text, streaming }) => {
        for (const source of (window as any).__readStreams) {
          const params = new URL(source.url, location.origin).searchParams;
          source.onmessage?.({
            data: JSON.stringify({
              connected: true,
              reset: true,
              removed: [],
              messages: [
                {
                  id,
                  text,
                  streaming,
                  kind: "reply",
                  publicationKey: "read-attempt",
                  projectId: params.get("projectId"),
                  conversationId: params.get("conversationId"),
                  artifactId: null,
                  inputId: "unread-input",
                  rootId: null,
                  createdAt: "2026-09-20T00:02:00Z",
                },
              ],
            }),
          });
        }
      },
      { id, text, streaming },
    );
  await emit("stream:read-attempt", "TEST 已经看见的流式正文", true);
  await expect(
    page.getByText("TEST 已经看见的流式正文", { exact: true }),
  ).toBeVisible();
  await hide(page);
  await emit("read-durable", "TEST 已经看见的流式正文", false);
  await fixture.update([
    ...fixture.messages(),
    { id: "read-durable", text: "TEST 已经看见的流式正文", kind: "reply" },
  ]);
  await expect(badge(page)).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".composer-reopen")).toBeVisible();
  await expect(badge(page)).toHaveCount(0);
  await emit("read-durable", "TEST 已经看见的流式正文，新的续写", true);
  await expect(badge(page)).toBeVisible();
});

test("原生历史错误重放：早期错误不覆盖已读终态，刷新与重连不重新亮提示", async ({
  page,
}) => {
  const fixture = await setup(page);
  const final: Reply = {
    id: "publication:failed-attempt",
    kind: "error",
    sequence: 471,
    text: "TEST 最终失败说明",
  };
  await fixture.update([...fixture.messages(), final]);
  await expect(page.getByText(final.text, { exact: true })).toBeVisible();
  await hide(page);
  await page.reload();
  await expect(page.locator(".composer-reopen")).toBeVisible();
  await expect(badge(page)).toHaveCount(0);
  const emit = async (reply: Reply) => {
    await expect
      .poll(() => page.evaluate(() => (window as any).__readStreams.size))
      .toBeGreaterThan(0);
    await page.evaluate((reply) => {
      for (const source of (window as any).__readStreams) {
        const params = new URL(source.url, location.origin).searchParams;
        source.onmessage?.({
          data: JSON.stringify({
            connected: true,
            reset: true,
            removed: [],
            messages: [
              {
                ...reply,
                publicationKey: "failed-attempt",
                projectId: params.get("projectId"),
                conversationId: params.get("conversationId"),
                inputId: "unread-input",
                rootId: null,
                artifactId: null,
                createdAt: "2026-09-20T00:02:00Z",
              },
            ],
          }),
        });
      }
    }, reply);
  };
  await emit({ ...final, sequence: 470, text: "TEST 早期底层错误" });
  await expect(badge(page)).toHaveCount(0);
  await openInput(page);
  await expect(page.getByText(final.text, { exact: true })).toBeVisible();
  await expect(
    page.getByText("TEST 早期底层错误", { exact: true }),
  ).toHaveCount(0);
  await hide(page);
  await emit(final);
  await expect(badge(page)).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".composer-reopen")).toBeVisible();
  await expect(badge(page)).toHaveCount(0);
  await emit({ ...final, sequence: 472, text: "TEST 真正更新的错误说明" });
  await expect(badge(page)).toBeVisible();
});

test("回复不闪退：内部 infer 不进入主消息，工具切换、断线和最终回执保留正文与节点", async ({
  page,
}) => {
  await setup(page);
  let sequence = 0;
  const projection = new LiveConversationProjection((event) => ({
    projectId: "desk",
    conversationId: "conversation",
    artifactId: null,
    inputId: event.payload.root_turn_id === "user-root" ? "unread-input" : null,
    rootId: String(event.payload.root_turn_id),
  }));
  const emit = async (topic: string, payload: StreamEvent["payload"]) => {
    projection.consume({
      id: `flicker-${++sequence}`,
      sequence,
      timestamp: "2026-09-20T00:03:00Z",
      topic,
      payload,
    });
    await page.evaluate((messages) => {
      for (const source of (window as any).__readStreams) {
        const params = new URL(source.url, location.origin).searchParams;
        source.onmessage?.({
          data: JSON.stringify({
            reset: true,
            removed: [],
            connected: true,
            messages: messages.map((m) => ({
              ...m,
              // Same first-visible publication identity as RuntimeBridge.
              id:
                m.kind !== "tool" && m.kind !== "progress" && m.publicationKey
                  ? `publication:${m.publicationKey}`
                  : m.id,
              projectId: params.get("projectId"),
              conversationId: params.get("conversationId"),
            })),
          }),
        });
      }
    }, projection.snapshot());
  };
  const child = {
    attempt_id: "child",
    activation_id: "child",
    root_turn_id: "infer-root",
  };
  await emit("runtime/model_stream", { ...child, stream: { kind: "started" } });
  await emit("runtime/model_stream", {
    ...child,
    stream: { kind: "text_delta", text: "TEST 内部工作结果不冒充答复" },
  });
  await expect(
    page.getByText("TEST 内部工作结果不冒充答复", { exact: true }),
  ).toHaveCount(0);
  await emit("chat/assistant_call", child);
  const root = {
    attempt_id: "root",
    activation_id: "root",
    root_turn_id: "user-root",
  };
  await emit("runtime/model_stream", { ...root, stream: { kind: "started" } });
  await emit("runtime/model_stream", {
    ...root,
    stream: { kind: "text_delta", text: "TEST 已经显示的正文不能消失。" },
  });
  const reply = page.locator(
    '.conversation [data-message-id="publication:root"]',
  );
  await expect(reply).toContainText("TEST 已经显示的正文不能消失。");
  await reply.evaluate((node) => {
    (window as any).__stableReply = node;
    (window as any).__removedReply = false;
    const observer = new MutationObserver((records) => {
      if (
        records.some((record) =>
          [...record.removedNodes].some(
            (removed) => removed === node || removed.contains(node),
          ),
        )
      )
        (window as any).__removedReply = true;
    });
    observer.observe(node.parentElement!, { childList: true });
    (window as any).__replyObserver = observer;
  });
  for (const topic of [
    "chat/assistant_call",
    "runtime/tool_calls_selected",
    "chat/progress",
  ]) {
    await emit(topic, {
      ...root,
      text: "TEST 工具处理中",
      tool_calls: [{ id: "call", name: "read", arguments: "{}" }],
    });
    await expect(reply).toContainText("TEST 已经显示的正文不能消失。");
  }
  await page.evaluate(() => {
    for (const source of (window as any).__readStreams) source.onerror?.();
  });
  await expect(reply).toContainText("TEST 已经显示的正文不能消失。");
  await expect(reply).not.toHaveAttribute("data-stream-active", "true");
  await emit("chat/reply", {
    ...root,
    text: "TEST 已经显示的正文不能消失。最终回执已到达。",
  });
  await expect(reply).toHaveCount(1);
  await expect(reply).toContainText("最终回执已到达。");
  expect(
    await reply.evaluate(
      (node) =>
        node === (window as any).__stableReply &&
        !(window as any).__removedReply,
    ),
  ).toBe(true);
  await page.evaluate(() => (window as any).__replyObserver.disconnect());
});

test("只打开旧消息阅读位置不清除新回复，返回最新后才清除", async ({ page }) => {
  const fixture = await setup(page);
  const old = Array.from({ length: 20 }, (_, index) => ({
    id: `long-${index}`,
    text: `TEST 第 ${index} 条长回复。` + "合成阅读正文。".repeat(80),
    kind: "reply" as const,
  }));
  await fixture.update(old);
  const scroll = page.locator(".conversation");
  await expect(page.locator('[data-message-id="long-19"]')).toBeVisible();
  await scroll.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(
    page.getByRole("button", { name: "返回最新", exact: true }),
  ).toBeVisible();
  await hide(page);
  await fixture.update([
    ...old,
    { id: "long-new", text: "TEST 在旧消息下方的新回复", kind: "reply" },
  ]);
  await expect(badge(page)).toBeVisible();
  await openInput(page);
  await expect(
    page.getByRole("button", { name: "有新内容 · 返回最新", exact: true }),
  ).toBeVisible();
  await hide(page);
  await expect(badge(page)).toBeVisible();
  await openInput(page);
  await page
    .getByRole("button", { name: "有新内容 · 返回最新", exact: true })
    .click();
  await hide(page);
  await expect(badge(page)).toHaveCount(0);
});

test("当前对象的提示与展开的局部交流一致，不用别处回复制造空提示", async ({
  page,
}) => {
  const boot: Boot = await (await page.request.get("/api/workspace")).json();
  const projectId = boot.workspace.projects.find((p) => p.kind === "desk")!.id;
  const title = "TEST 未读范围验收文档";
  const artifactId = await seedCenter(page, {
    type: "create-artifact",
    projectId,
    title,
    content: { kind: "document", markdown: "TEST 保留原文。" },
  });
  const fixture = await setup(page, artifactId);
  await page
    .getByRole("button", { name: /^查看(?:全部|项目)内容$/, exact: true })
    .click();
  await page.locator(".artifact-card").filter({ hasText: title }).click();
  await openInput(page);
  await expect(
    page.getByText("TEST 已读的第二条回复", { exact: true }),
  ).toBeVisible();
  await hide(page);
  await fixture.update([
    ...fixture.messages(),
    {
      id: "elsewhere",
      text: "TEST 别的工作的新回复",
      inputId: "other-input",
      kind: "reply",
    },
  ]);
  await expect(badge(page)).toHaveCount(0);
  await openInput(page);
  await expect(
    page.getByText("TEST 别的工作的新回复", { exact: true }),
  ).toHaveCount(0);
  await composerAction(page, "展开完整记录");
  await expect(
    page.getByText("TEST 别的工作的新回复", { exact: true }),
  ).toBeVisible();
});
