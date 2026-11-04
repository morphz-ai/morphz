import { StrictMode, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  CommentDiscussionPanel,
  CommentDiscussionMarks,
} from "../../../dashboard/src/components/CommentDiscussions";
import { useCommentDiscussions } from "../../../dashboard/src/components/useCommentDiscussions";
import i18n from "../../../dashboard/src/i18n";
void i18n.changeLanguage("zh");
const theme = new URLSearchParams(location.search).get("theme") ?? "light";
document.documentElement.dataset.colorMode = theme;
const ioOwners = new Set<AbortSignal>();
const ioConnections = new Map<
  AbortSignal,
  { id: string; controller: ReadableStreamDefaultController<Uint8Array> }
>();
const prefixes = new Map<
  string,
  { text: string; sequence: number; timestamp: string }
>();
const writePrefix = (
  id: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
  snapshot: boolean,
  delta: string,
) => {
  const value = prefixes.get(id);
  if (!value) return;
  controller.enqueue(
    new TextEncoder().encode(
      "data: " +
        JSON.stringify({
          type: snapshot ? "output.started" : "output.delta",
          snapshot,
          output_id: `io-${id}`,
          session_id: "test-session",
          root_turn_id: id,
          model_attempt_id: id,
          publication_key: id,
          model_output_visibility: "public",
          timestamp: value.timestamp,
          delta_seq: value.sequence,
          text: snapshot ? value.text : delta,
        }) +
        "\n\n",
    ),
  );
};
const requests: any[] = [],
  sockets = new Set<any>(),
  entries = new Map<string, any>(
    JSON.parse(sessionStorage.getItem("test-discussion-entries") ?? "[]"),
  );
const saveEntries = () =>
  sessionStorage.setItem(
    "test-discussion-entries",
    JSON.stringify([...entries]),
  );
class Socket {
  onopen?: () => void;
  onmessage?: (event: any) => void;
  onclose?: () => void;
  onerror?: () => void;
  constructor(readonly url: string) {
    sockets.add(this);
    queueMicrotask(() => this.onopen?.());
  }
  close() {
    sockets.delete(this);
  }
}
Reflect.set(window, "WebSocket", Socket);
const source = (name: string) => ({
  key: `event:source-${name}`,
  title: "TEST 阅读材料",
  text:
    name === "a"
      ? "每个评论都可以独立运行，并在原处继续追问。"
      : "不同段落的讨论可以同时推进，互不打断。",
  locator: { kind: "runtime-event", event_id: `source-${name}` },
});
const native = (id: string, e: any) =>
  e.messages.map((message: any) => ({
    entry_id: message.id,
    root_turn_id: id,
    visible_at: message.createdAt,
    display_kind: message.kind,
    final_event: true,
    event: {
      id: message.id,
      timestamp: message.createdAt,
      topic: message.kind === "input" ? "chat/user_message" : "chat/reply",
      payload: { text: message.text },
    },
    root_event: null,
    input_event: null,
  }));
const api = {
  currentToken: () => "",
  async get(path: string) {
    requests.push({ method: "GET", path });
    const url = new URL(path, location.origin),
      id = url.pathname.split("/discussions/")[1];
    if (url.searchParams.get("head_only") === "true")
      return { latest_sequence: 0 };
    if (url.pathname.endsWith("/discussions"))
      return {
        items: [...entries]
          .filter(([, e]) => e.quote.key === url.searchParams.get("source_key"))
          .map(([id, e]) => ({
            id,
            title: e.messages[0].text,
            preview: e.quote.text,
            created_at_micros: 1793779200000000,
            publish_to_session: e.publish,
            source_key: e.quote.key,
            locator: e.quote.locator,
          })),
        next_before: null,
      };
    if (url.pathname.endsWith("/timeline")) {
      const id = url.searchParams.get("discussion_id")!;
      return { entries: native(id, entries.get(id)), next_before: null };
    }
    if (id) {
      const e = entries.get(id);
      return { source: e.quote, discussion: { publish_to_session: e.publish } };
    }
    throw new Error("Unexpected read " + path);
  },
  async response(path: string, options: { signal: AbortSignal }) {
    requests.push({ method: "STREAM", path });
    ioOwners.add(options.signal);
    const id = new URL(path, location.origin).searchParams.get(
      "discussion_id",
    )!;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        ioConnections.set(options.signal, { id, controller });
        controller.enqueue(
          new TextEncoder().encode('data: {"type":"stream.opened"}\n\n'),
        );
        writePrefix(id, controller, true, "");
        options.signal.addEventListener(
          "abort",
          () => {
            ioOwners.delete(options.signal);
            ioConnections.delete(options.signal);
            try {
              controller.close();
            } catch {}
          },
          { once: true },
        );
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream" },
    });
  },
  async command(path: string, method: string, body: any) {
    requests.push({ method, path, body: structuredClone(body) });
    const id = body.discussion.id;
    const e = entries.get(id) ?? {
      quote: body.discussion.source,
      publish: body.discussion.publish_to_session === true,
      messages: [],
    };
    if (!e.messages.some((m: any) => m.id === body.client_message_id))
      e.messages.push({
        id: body.client_message_id,
        kind: "input",
        text: body.client_metadata.body,
        createdAt: new Date().toISOString(),
      });
    entries.set(id, e);
    saveEntries();
    return { status: "accepted", event_id: body.client_message_id };
  },
};
function Fixture() {
  const [connected, setConnected] = useState(true);
  const discussions = useCommentDiscussions({
    api: api as any,
    sessionId: "test-session",
    actorIdentity: "test-human",
    readOnly: false,
    connected,
    model: "test-model",
    reasoning: "max",
  });
  useLayoutEffect(() => {
    Reflect.set(window, "discussionFixture", {
      report: () => ({
        connected,
        requests,
        subscriptions: [
          ...[...sockets].map((socket) => ({ url: socket.url })),
          ...[...ioOwners].map(() => ({ url: "Session IO" })),
        ],
        draft:
          document.querySelector<HTMLTextAreaElement>("#main-draft")!.value,
        model: document.querySelector("#main-model")!.textContent,
        active: discussions.controller.activeId,
      }),
      connection: setConnected,
      long(id: string) {
        const e = entries.get(id);
        const reply = e.messages.find((m: any) => m.kind === "reply");
        if (reply)
          reply.text +=
            "\n\n" +
            Array.from(
              { length: 40 },
              (_, i) =>
                `长回复 ${i + 1}：保持上下文，正文仅在讨论内滚动，不遮挡选文或主输入区。`,
            ).join("\n\n");
        saveEntries();
        for (const socket of sockets)
          socket.onmessage?.({
            data: JSON.stringify({
              topic: "chat/reply",
              payload: { session_id: "test-session", root_turn_id: id },
            }),
          });
      },
      open: (name: string) =>
        discussions.open(source(name), { x: 520, y: 160 }),
      prefix: (id: string, delta: string) => {
        const previous = prefixes.get(id);
        prefixes.set(id, {
          text: (previous?.text ?? "") + delta,
          sequence: (previous?.sequence ?? 0) + 1,
          timestamp: previous?.timestamp ?? new Date().toISOString(),
        });
        for (const connection of ioConnections.values())
          if (connection.id === id)
            writePrefix(id, connection.controller, !previous, delta);
      },
      finish: (id: string) => {
        prefixes.delete(id);
        const e = entries.get(id);
        e.messages.push({
          id: `publication:${id}`,
          kind: "reply",
          text: "可以，保留原段落的主线。\n\n- **并行讨论**各自推进\n- 结果始终回到对应选文\n\n[查看来源](https://example.com/source)",
          createdAt: new Date().toISOString(),
        });
        saveEntries();
        for (const socket of sockets)
          socket.onmessage?.({
            data: JSON.stringify({
              topic: "chat/reply",
              timestamp: new Date().toISOString(),
              payload: { session_id: "test-session", root_turn_id: id },
            }),
          });
      },
    });
  });
  return (
    <main
      className="page-shell"
      data-color-mode={theme}
      data-accent="cyan"
      style={{
        height: "100vh",
        padding: 32,
        background: "var(--bg)",
        color: "var(--text)",
      }}
    >
      <div style={{ maxWidth: 760, margin: "24px auto" }}>
        <p style={{ color: "var(--text-secondary)", fontSize: 12 }}>
          TEST · 真实组件隔离验收
        </p>
        <h1 style={{ fontSize: 22, margin: "12px 0 28px" }}>
          让讨论留在内容旁
        </h1>
        <article data-event-id="source-a">
          <p
            className="message-body"
            id="source-a"
            style={{ fontSize: 16, lineHeight: 1.9 }}
          >
            {source("a").text}
          </p>
        </article>
        <article data-event-id="source-b">
          <p
            className="message-body"
            id="source-b"
            style={{ fontSize: 16, lineHeight: 1.9 }}
          >
            {source("b").text}
          </p>
        </article>
        <div
          data-text-popover-blocker="true"
          style={{
            position: "fixed",
            bottom: 16,
            left: 32,
            right: 32,
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
      </div>
      <CommentDiscussionMarks owner={discussions.marks} />
      <CommentDiscussionPanel
        controller={discussions.controller}
        point={discussions.point}
        readOnly={false}
      />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
