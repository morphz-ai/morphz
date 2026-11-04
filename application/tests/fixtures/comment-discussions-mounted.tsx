import { StrictMode, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  useCommentDiscussions,
  CommentDiscussionPanel,
} from "../../apps/web/src/CommentDiscussions.js";
import { TextQuoteProvider } from "../../apps/web/src/TextQuotes.js";
import { quoteSource } from "../../apps/web/src/text-quote-dom.js";
import { SafeMarkdown } from "../../apps/web/src/SafeMarkdown.js";
import { applicationCall } from "../../apps/web/src/application-transport.js";
import {
  commandSchema,
  initialWorkspace,
} from "../../packages/core/src/model.js";
import { commentDiscussionSourceKey } from "../../packages/core/src/comment-discussions.js";
import type { TextQuote } from "../../packages/core/src/text-quotes.js";

const requests: any[] = [],
  subscriptions = new Map<string, any>(),
  listeners = new Set<any>(),
  entries = new Map<string, any>();
const source = (name: string) => ({
  kind: "message" as const,
  projectId: "test-project",
  conversationId: "test-chat",
  title: "TEST 阅读材料",
  messageId: `event-${name}`,
  inputId: null,
  createdAt: "2026-11-04T08:00:00Z",
});
const response = (value: unknown) => ({ ok: true, value });
const bridge = {
  cancel: () => {},
  async invoke(request: any) {
    requests.push({
      method: request.method,
      params: structuredClone(request.params),
    });
    const p = request.params;
    if (request.method === "platform.bootstrap")
      return response({
        csrfToken: "test-identity",
        centerId: "test-center",
        principalId: "test-human",
      });
    if (request.method === "discussions.list")
      return response({
        items: [...entries]
          .filter(
            ([, e]) =>
              commentDiscussionSourceKey(e.quote.source) ===
              commentDiscussionSourceKey(p.source),
          )
          .map(([id, e]) => ({
            id,
            title: e.messages[0].text,
            preview: e.quote.text,
            created_at_micros: 1793779200000000,
            publish_to_session: e.publish,
          })),
        nextCursor: null,
      });
    if (request.method === "discussions.read") {
      const e = entries.get(p.id);
      return response({
        descriptor: {
          id: p.id,
          session_id: "session",
          principal_id: "test-human",
          source_event_id: p.id,
          source_key: commentDiscussionSourceKey(e.quote.source),
          title: "TEST",
          preview: e.quote.text,
          locator: {},
          publish_to_session: e.publish,
          created_at_micros: 1793779200000000,
        },
        quote: e.quote,
      });
    }
    if (request.method === "discussions.history")
      return response({
        id: p.id,
        messages: entries.get(p.id)?.messages ?? [],
        nextCursor: null,
      });
    if (request.method === "platform.message") {
      const command = commandSchema.parse(p),
        op = command.operation;
      if (op.type !== "record-input" || !op.commentDiscussion)
        throw new Error("Invalid discussion input");
      const id = op.commentDiscussion.id;
      const entry = entries.get(id) ?? {
        quote: op.textQuotes![0],
        publish: op.commentDiscussion.publishToConversation === true,
        messages: [],
      };
      if (!entry.messages.some((m: any) => m.id === command.commandId))
        entry.messages.push({
          id: command.commandId,
          eventId: command.commandId,
          rootId: command.commandId,
          kind: "input",
          text: op.body,
          createdAt: new Date().toISOString(),
        });
      entries.set(id, entry);
      return response({
        commandId: command.commandId,
        entityId: command.commandId,
      });
    }
    throw new Error("Unexpected logical operation: " + request.method);
  },
  onStream(listener: any) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  async subscribe(id: string, scope: any) {
    subscriptions.set(id, scope);
    queueMicrotask(() => {
      for (const listener of listeners)
        listener({ id, value: { connected: true, messages: [] } });
    });
  },
  unsubscribe(id: string) {
    subscriptions.delete(id);
  },
};
Reflect.set(window, "morphzDesktop", { application: bridge });

const state = initialWorkspace();
function Fixture() {
  const discussions = useCommentDiscussions({
    projectId: "test-project",
    conversationId: "test-chat",
    identity: "test-identity",
    storageScope: "test-center:test-human",
    enabled: true,
    model: "test-model",
    reasoningEffort: "max",
  });
  const [quotes, setQuotes] = useState<TextQuote[]>([]);
  useLayoutEffect(() => {
    Reflect.set(window, "discussionFixture", {
      report: () => ({
        requests,
        subscriptions: [...subscriptions.values()],
        draft:
          document.querySelector<HTMLTextAreaElement>("#main-draft")!.value,
        model: document.querySelector("#main-model")!.textContent,
        active: discussions.controller.activeId,
      }),
      finish(id: string) {
        const entry = entries.get(id);
        entry.messages.push({
          id: `publication:${id}`,
          eventId: `reply-${id}`,
          rootId: id,
          kind: "reply",
          text: "可以，保留原段落的主线。\n\n- **并行讨论**各自推进\n- 结果始终回到对应选文\n\n[查看来源](https://example.com/source)",
          createdAt: new Date().toISOString(),
        });
        discussions.controller.invalidate(id);
      },
      open(name: string) {
        discussions.open({
          quote: {
            id: crypto.randomUUID(),
            source: source(name),
            text:
              name === "a"
                ? "每个评论都可以独立运行，并在原处继续追问。"
                : "不同段落的讨论可以同时推进，互不打断。",
            comment: "",
          },
          point: { x: 520, y: 160 },
        });
      },
    });
  });
  return (
    <div
      className="app"
      data-appearance={
        new URLSearchParams(location.search).get("theme") ?? "light"
      }
      data-accent="cyan"
      data-text-size="standard"
      style={{
        display: "block",
        height: "100vh",
        padding: "32px",
        overflow: "auto",
      }}
    >
      <TextQuoteProvider
        quotes={quotes}
        scope="test-chat"
        disabled={false}
        onChange={setQuotes}
        onEngage={() => {}}
        onFocusComposer={() => {}}
        onOpen={() => {}}
        onNotice={() => {}}
        onSubmit={() => {}}
        onDiscuss={discussions.open}
        discussionDisabled={false}
        discussionPanel={
          <CommentDiscussionPanel
            controller={discussions.controller}
            point={discussions.point}
            onOpen={() => {}}
            renderMarkdown={(text, streaming) => (
              <SafeMarkdown
                state={state}
                onOpen={() => {}}
                streaming={streaming}
              >
                {text}
              </SafeMarkdown>
            )}
          />
        }
      >
        <main style={{ maxWidth: 760, margin: "0 auto", paddingTop: 24 }}>
          <p style={{ color: "var(--muted)", fontSize: 12 }}>
            TEST · 真实组件隔离验收
          </p>
          <h1 style={{ fontSize: 22, margin: "12px 0 28px" }}>
            让讨论留在内容旁
          </h1>
          <p
            {...quoteSource(source("a"))}
            id="source-a"
            style={{ fontSize: 16, lineHeight: 1.9 }}
          >
            每个评论都可以独立运行，并在原处继续追问。
          </p>
          <p
            {...quoteSource(source("b"))}
            id="source-b"
            style={{ fontSize: 16, lineHeight: 1.9 }}
          >
            不同段落的讨论可以同时推进，互不打断。
          </p>
          <div
            style={{
              marginTop: 80,
              paddingTop: 20,
              borderTop: "1px solid var(--line)",
            }}
          >
            <span id="main-model">test-main-model · max</span>
            <textarea
              id="main-draft"
              aria-label="主对话草稿"
              defaultValue="TEST：这段主聊天草稿必须保留。"
              style={{ display: "block", width: "100%", marginTop: 12 }}
            />
          </div>
        </main>
      </TextQuoteProvider>
    </div>
  );
}
void applicationCall("platform.bootstrap").then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  ),
);
