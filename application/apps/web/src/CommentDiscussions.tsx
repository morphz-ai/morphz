import { useConversationStream } from "./useConversationStream.js";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ArrowUp, ChevronDown, MessageCircle, Plus, X } from "lucide-react";
import {
  CommentDiscussionController,
  type DiscussionCommand,
} from "../../../packages/core/src/comment-discussion-controller.js";
import {
  commentDiscussionSchema,
  commentDiscussionPageSchema,
  commentDiscussionChunkSchema,
  commentDiscussionSourceKey,
} from "../../../packages/core/src/comment-discussions.js";
import type { TextQuote } from "../../../packages/core/src/text-quotes.js";
import type { ReasoningEffort } from "../../../packages/core/src/inference.js";
import { applicationCall } from "./application-transport.js";
import {
  commandSchema,
  morphzAgentAccess,
} from "../../../packages/core/src/model.js";
import { textQuoteSchema } from "../../../packages/core/src/text-quotes.js";
import {
  canonicalDiscussionSource,
  discussionDraftStore,
  parseDiscussionDraft,
} from "../../../packages/core/src/comment-discussion-drafts.js";
import {
  draftOwner,
  requirePersistentDraftOwner,
} from "./local-preferences.js";
import {
  shouldSubmitInput,
  type InterfacePreferences,
} from "./interface-preferences.js";
import {
  captureTextQuote,
  locateTextQuote,
  type QuotePoint,
  type QuoteSelection,
} from "./text-quote-dom.js";
import {
  observeTextQuoteLayout,
  positionTextQuote,
} from "./text-quote-layout.js";
import "./comment-discussions.css";

export function useCommentDiscussions(options: {
  projectId: string;
  conversationId: string;
  identity: string;
  storageScope: string;
  enabled: boolean;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
}) {
  const latest = useRef(options);
  latest.current = options;
  const [point, setPoint] = useState<QuotePoint>({ x: 400, y: 180 });
  const controller = useMemo(() => {
    const scope = {
      projectId: options.projectId,
      conversationId: options.conversationId,
    };
    const identityGeneration = options.identity;
    const envelope = (
      command: DiscussionCommand<TextQuote>,
      model?: string | null,
      reasoningEffort?: ReasoningEffort | null,
    ) =>
      commandSchema.parse({
        commandId: command.commandId,
        operation: {
          type: "record-input",
          ...scope,
          body: command.body,
          artifactId: null,
          artifactRevision: null,
          selection: "",
          targetActantId: morphzAgentAccess.actantId,
          textQuotes: [{ ...command.quote, comment: "" }],
          dispatchMode: "parallel",
          commentDiscussion: {
            id: command.discussionId,
            ...(command.first
              ? { publishToConversation: command.publish }
              : {}),
          },
          ...(model ? { model } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
        },
      });
    const journal = discussionDraftStore<TextQuote>(
      `morphz:discussion:${options.storageScope}:${draftOwner}:${scope.projectId}:${scope.conversationId}`,
      (quote) => ({
        source: quote.source,
        text: quote.text,
        anchor: quote.anchor,
        draft: quote.draft,
      }),
      (value) =>
        parseDiscussionDraft(
          value,
          (raw) => textQuoteSchema.parse(raw),
          (raw, draft) => {
            const saved = commandSchema.parse(raw),
              op = saved.operation;
            if (
              op.type !== "record-input" ||
              canonicalDiscussionSource(saved) !==
                canonicalDiscussionSource(
                  envelope(draft.pending!, op.model, op.reasoningEffort),
                )
            )
              throw new Error(
                "Saved discussion request no longer matches its source or scope",
              );
          },
        ),
      () => {
        requirePersistentDraftOwner();
      },
    );
    const call = (
      method:
        | "discussions.list"
        | "discussions.read"
        | "discussions.history"
        | "discussions.message",
      params: unknown,
      signal: AbortSignal,
    ) => applicationCall(method, params, { identityGeneration, signal });
    return new CommentDiscussionController<TextQuote>(
      {
        list: async (quote, before, signal) =>
          (await call(
            "discussions.list",
            {
              ...scope,
              source: quote.source,
              ...(before ? { before } : {}),
              limit: 20,
            },
            signal,
          )) as { items: []; nextCursor: null },
        read: async (id, signal) => {
          const value = commentDiscussionSchema.parse(
            await call("discussions.read", { ...scope, id }, signal),
          );
          return {
            quote: value.quote,
            publish: value.descriptor.publish_to_session,
          };
        },
        history: async (id, before, signal) =>
          commentDiscussionPageSchema.parse(
            await call(
              "discussions.history",
              { ...scope, id, ...(before ? { before } : {}), limit: 20 },
              signal,
            ),
          ),
        readMessage: async (id, message, offset, signal) => {
          const chunk = commentDiscussionChunkSchema.parse(
            await call(
              "discussions.message",
              {
                ...scope,
                id,
                messageId: message.entryId ?? message.id,
                eventId: message.eventId,
                offset,
              },
              signal,
            ),
          );
          return {
            eventId: chunk.event_id,
            text: chunk.text,
            nextOffset: chunk.next_offset,
          };
        },
        prepare: (command) =>
          envelope(
            command,
            latest.current.model,
            latest.current.reasoningEffort,
          ),
        send: async (command: DiscussionCommand<TextQuote>) => {
          if (
            latest.current.identity !== identityGeneration ||
            !latest.current.enabled
          )
            throw new Error("当前身份或会话已变化，草稿已保留。");
          await applicationCall("platform.message", command.envelope, {
            identityGeneration,
            signal: AbortSignal.timeout(12000),
          });
        },
      },
      undefined,
      journal,
    );
  }, [
    options.projectId,
    options.conversationId,
    options.identity,
    options.storageScope,
  ]);
  useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  const current = controller.active;
  const stream = useConversationStream(
    options.projectId,
    options.conversationId,
    options.enabled && !!current?.submitted,
    current?.id,
  );
  useEffect(() => {
    controller.start();
    return () => controller.dispose();
  }, [controller]);
  useEffect(() => {
    const grouped = new Map<string, typeof stream.messages>();
    for (const message of stream.messages) {
      const id = message.commentDiscussion?.id;
      if (!id || message.kind === "tool" || message.kind === "evaluation")
        continue;
      const list = grouped.get(id) ?? [];
      list.push(message);
      grouped.set(id, list);
    }
    for (const [id, messages] of grouped)
      controller.receive(
        id,
        messages.map((message) => ({
          id: message.id,
          eventId: message.id,
          rootId: message.rootId ?? "",
          createdAt: message.createdAt,
          kind: message.kind as "reply" | "progress" | "error",
          text: message.text,
          streaming: message.streaming,
          replace: true,
          truncated: message.truncated,
          ...(message.threadId ? { threadId: message.threadId } : {}),
        })),
      );
  }, [controller, stream.messages]);
  const connected = useRef(false);
  useEffect(() => {
    if (stream.connected && !connected.current && controller.activeId)
      controller.invalidate(controller.activeId);
    connected.current = stream.connected;
  }, [controller, stream.connected]);
  return {
    controller,
    point,
    enabled: options.enabled,
    open: (selection?: QuoteSelection | null) => {
      if (!latest.current.enabled) return;
      const selected = selection ?? captureTextQuote();
      if (!selected) return;
      setPoint(selected.point);
      const previous = [...controller.views.values()].find(
        (view) =>
          view.quote.text === selected.quote.text &&
          JSON.stringify(view.quote.source) ===
            JSON.stringify(selected.quote.source) &&
          JSON.stringify(view.quote.anchor) ===
            JSON.stringify(selected.quote.anchor),
      );
      if (previous) controller.reopen(previous.id);
      else controller.open({ ...selected.quote, comment: "" });
      window.getSelection()?.removeAllRanges();
    },
  };
}

export function CommentDiscussionPanel({
  controller,
  point,
  onOpen,
  renderMarkdown,
  sendShortcut = "enter",
}: {
  controller: CommentDiscussionController<TextQuote>;
  point: QuotePoint;
  onOpen: (quote: TextQuote) => void;
  renderMarkdown: (text: string, streaming: boolean) => ReactNode;
  sendShortcut?: InterfacePreferences["sendShortcut"];
}) {
  useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  const view = controller.active;
  const panel = useRef<HTMLElement>(null),
    thread = useRef<HTMLDivElement>(null);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  useLayoutEffect(() => {
    if (!view || !panel.current) return;
    const node = panel.current;
    return observeTextQuoteLayout(node, () => {
      const rect = locateTextQuote(view.quote)?.getBoundingClientRect();
      positionTextQuote(node, rect ? { x: rect.right, y: rect.bottom } : point);
    });
  }, [view?.id, point]);
  const lastMessage = view?.messages.at(-1);
  useLayoutEffect(() => {
    const node = thread.current;
    if (!node) return;
    if (node.scrollHeight - node.scrollTop - node.clientHeight < 100)
      node.scrollTop = node.scrollHeight;
  }, [view?.id, lastMessage?.id, lastMessage?.text]);
  useEffect(() => {
    setDirectoryOpen(false);
  }, [view?.id]);
  if (!view) return null;
  const known = new Map(
    view.directory.map((item) => [item.id, item.title || item.preview]),
  );
  for (const item of controller.views.values())
    if (
      commentDiscussionSourceKey(item.quote.source) ===
      commentDiscussionSourceKey(view.quote.source)
    )
      known.set(
        item.id,
        item.messages.find((message) => message.kind === "input")?.text ??
          item.quote.text,
      );
  return (
    <section
      ref={panel}
      className="comment-discussion"
      data-quote-ui="true"
      role="region"
      aria-label="讨论"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          controller.close();
        }
      }}
    >
      <header className="comment-discussion-header">
        <button
          type="button"
          className="discussion-heading"
          aria-expanded={directoryOpen}
          onClick={() => setDirectoryOpen(!directoryOpen)}
        >
          <MessageCircle size={15} />
          <span>讨论</span>
          <ChevronDown size={13} />
        </button>
        <span className="discussion-header-spacer" />
        <button
          type="button"
          title="开始新的讨论"
          aria-label="开始新的讨论"
          onClick={() => controller.open(view.quote, true)}
        >
          <Plus size={16} />
        </button>
        <button
          type="button"
          title="关闭讨论"
          aria-label="关闭讨论"
          onClick={() => controller.close()}
        >
          <X size={16} />
        </button>
      </header>
      {directoryOpen && (
        <nav className="discussion-directory" aria-label="此来源的讨论">
          {[...known].map(([id, preview]) => (
            <button
              type="button"
              key={id}
              aria-current={view.id === id ? "true" : undefined}
              onClick={() => {
                setDirectoryOpen(false);
                void controller.select(id);
              }}
            >
              {preview}
            </button>
          ))}
          {view.directoryCursor && (
            <button
              type="button"
              disabled={view.directoryLoading}
              onClick={() => controller.olderDiscussions()}
            >
              更早的讨论
            </button>
          )}
        </nav>
      )}
      <button
        className="discussion-source"
        type="button"
        onClick={() => onOpen(view.quote)}
        title={view.quote.text}
      >
        {view.quote.text}
      </button>
      <div
        className="discussion-messages"
        ref={thread}
        aria-live="polite"
        aria-relevant="additions text"
      >
        {view.nextCursor && (
          <button
            className="discussion-earlier"
            type="button"
            disabled={view.loading}
            onClick={() => void controller.older()}
          >
            查看更早消息
          </button>
        )}
        {view.messages.map((message) => (
          <article
            key={message.id}
            className={`discussion-message ${message.kind}`}
          >
            {message.kind === "input" ? (
              <p>{message.text}</p>
            ) : (
              renderMarkdown(message.text, message.streaming === true)
            )}
            {message.contentOmitted && (
              <button
                type="button"
                disabled={view.loading}
                onClick={() => void controller.openMessage(message.id)}
              >
                {message.text ? "继续读取" : "展开消息"}
              </button>
            )}
            {message.truncated && (
              <small>内容较长，完整内容可在执行记录中打开。</small>
            )}
          </article>
        ))}
        {view.loading && (
          <div className="discussion-read-state" role="status">
            正在读取讨论…
          </div>
        )}
      </div>
      {view.error && (
        <div className="discussion-error" role="alert">
          {view.error}
          <button
            type="button"
            onClick={() =>
              view.pending ? void controller.send() : controller.retryRead()
            }
          >
            重试
          </button>
        </div>
      )}
      <form
        className="discussion-compose"
        onSubmit={(event) => {
          event.preventDefault();
          void controller.send();
        }}
      >
        <textarea
          key={view.id}
          autoFocus
          rows={2}
          maxLength={10000}
          placeholder={view.submitted ? "继续讨论…" : "写下你的问题…"}
          aria-label="讨论消息"
          value={view.draft}
          disabled={!!view.pending}
          onChange={(event) => controller.draft(event.target.value)}
          onKeyDown={(event) => {
            if (shouldSubmitInput(event.nativeEvent, sendShortcut)) {
              event.preventDefault();
              void controller.send();
            }
          }}
        />
        <div className="discussion-compose-footer">
          {!view.submitted && (
            <label>
              <input
                type="checkbox"
                checked={view.publish}
                disabled={!!view.pending}
                onChange={(event) => controller.publish(event.target.checked)}
              />
              同时显示在对话中
            </label>
          )}
          {view.submitted && (
            <span className="discussion-submit-state">
              {view.sending ? "发送中…" : ""}
            </span>
          )}
          <button
            type="submit"
            className="discussion-send"
            disabled={
              view.sending ||
              !!view.pending ||
              !view.sourceReady ||
              !view.draft.trim()
            }
            title="发送"
            aria-label="发送讨论消息"
          >
            <ArrowUp size={17} />
          </button>
        </div>
      </form>
    </section>
  );
}
