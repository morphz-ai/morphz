import { useConversationStream } from "./useConversationStream.js";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  ArrowUp,
  ChevronDown,
  MessageCircle,
  MessageSquarePlus,
  X,
} from "lucide-react";
import {
  DiscussionMarks,
  discussionRange,
} from "../../../packages/core/src/discussion-marks-dom.js";
import {
  CommentDiscussionController,
  discussionResponseRows,
  type DiscussionCommand,
} from "../../../packages/core/src/comment-discussion-controller.js";
import { ResponseWaiting } from "./ResponseWaiting.js";
import { modelActivityLabels } from "./conversation-presentation.js";
import {
  commentDiscussionSchema,
  commentDiscussionPageSchema,
  commentDiscussionChunkSchema,
  commentDiscussionSourceKey,
  type DiscussionReplyNotices,
} from "../../../packages/core/src/comment-discussions.js";
import {
  quoteSourceKey,
  textQuoteSourceSchema,
  type TextQuote,
} from "../../../packages/core/src/text-quotes.js";
import type { DiscussionReplyLocator } from "../../../packages/core/src/comment-discussion-types.js";
import type { ReasoningEffort } from "../../../packages/core/src/inference.js";
import {
  applicationCall,
  subscribeDiscussionReplies,
} from "./application-transport.js";
import { isoTimeAtMicros } from "../../../packages/application/src/iso-time.js";
import { useTextQuotes } from "./TextQuotes.js";
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
import { observeTextQuoteLayout } from "./text-quote-layout.js";
import "./comment-discussions.css";
import { positionTextPopover } from "../../../packages/core/src/text-popover-layout.js";

const responseLabels = {
  sending: "正在发送…",
  waiting: "等待回复…",
  queued: modelActivityLabels.queued,
  model: modelActivityLabels.streaming,
  reasoning: modelActivityLabels.reasoning,
  final_output: modelActivityLabels.waiting_final_output,
  generating: modelActivityLabels.streaming_text,
  tool_call: modelActivityLabels.generating_tool_call,
  tool: "正在执行工具…",
  settling: modelActivityLabels.settling,
  provider_wait: "模型服务不可用，等待恢复",
  settled: "",
};

function useDiscussionReplyNotices({
  projectId,
  conversationId,
  identity,
  storageScope,
  enabled,
}: {
  projectId: string;
  conversationId: string;
  identity: string;
  storageScope: string;
  enabled: boolean;
}) {
  const key = `morphz:discussion-read:${storageScope}:${draftOwner}:${projectId}:${conversationId}`;
  const owner = useMemo(() => ({ key, identity }), [key, identity]);
  const [snapshot, setSnapshot] = useState<{
    owner: typeof owner;
    replies: DiscussionReplyNotices["replies"];
  }>();
  const read = useMemo(() => {
    const entries = new Map<string, string>();
    try {
      requirePersistentDraftOwner();
      const raw = localStorage.getItem(owner.key);
      if (raw && raw.length < 170_000) {
        const saved: unknown = JSON.parse(raw);
        if (Array.isArray(saved) && saved.length <= 128)
          for (const entry of saved)
            if (
              Array.isArray(entry) &&
              typeof entry[0] === "string" &&
              entry[0].length <= 128 &&
              typeof entry[1] === "string" &&
              entry[1].length <= 512
            )
              entries.set(entry[0], entry[1]);
      }
    } catch {
      // Keep read receipts in memory if the profile cannot persist them.
    }
    return entries;
  }, [owner]);
  const [readVersion, setReadVersion] = useState(0);
  const unread = useMemo(
    () =>
      new Map(
        enabled && snapshot?.owner === owner
          ? snapshot.replies.flatMap(({ discussionId, eventId }) =>
              read.get(discussionId) === eventId
                ? []
                : [[discussionId, eventId] as const],
            )
          : [],
      ),
    [enabled, owner, snapshot, read, readVersion],
  );
  useEffect(() => {
    if (!enabled || !projectId || !conversationId) return;
    return subscribeDiscussionReplies(
      { projectId, conversationId },
      ({ replies }) => setSnapshot({ owner, replies }),
    );
  }, [enabled, owner, projectId, conversationId]);
  const markRead = useCallback(
    (id: string, eventId: string) => {
      if (read.get(id) === eventId) return;
      read.delete(id);
      read.set(id, eventId);
      if (read.size > 128) read.delete(read.keys().next().value!);
      setReadVersion((version) => version + 1);
      try {
        requirePersistentDraftOwner();
        localStorage.setItem(owner.key, JSON.stringify([...read]));
      } catch {
        // Storage failure does not block reading or change discussion state.
      }
    },
    [owner, read],
  );
  return { unread, markRead };
}

export function useCommentDiscussions(options: {
  projectId: string;
  conversationId: string;
  identity: string;
  storageScope: string;
  enabled: boolean;
  connected?: boolean;
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
    const readChunk = async (
      id: string,
      reply: DiscussionReplyLocator,
      offset: number,
      signal: AbortSignal,
    ) =>
      commentDiscussionChunkSchema.parse(
        await call(
          "discussions.message",
          { ...scope, id, ...reply, offset },
          signal,
        ),
      );
    return new CommentDiscussionController<TextQuote>(
      {
        list: async (quote, before, signal, limit = 20) =>
          (await call(
            "discussions.list",
            {
              ...scope,
              source: quote.source,
              ...(before ? { before } : {}),
              limit,
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
          const chunk = await readChunk(
            id,
            {
              messageId: message.entryId ?? message.id,
              eventId: message.eventId,
            },
            offset,
            signal,
          );
          return {
            eventId: chunk.event_id,
            text: chunk.text,
            nextOffset: chunk.next_offset,
          };
        },
        readReply: async (id, reply, signal) => {
          const chunk = await readChunk(id, reply, 0, signal);
          const createdAt = isoTimeAtMicros(chunk.created_at_micros);
          if (
            !createdAt ||
            chunk.kind !== "reply" ||
            chunk.id !== reply.messageId ||
            chunk.event_id !== reply.eventId ||
            chunk.next_offset !== null
          )
            throw new Error("这条讨论回复暂时无法定位。");
          return {
            id: chunk.id,
            entryId: chunk.id,
            eventId: chunk.event_id,
            rootId: chunk.root_id,
            createdAt,
            kind: chunk.kind,
            text: chunk.text,
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
  const { unread, markRead } = useDiscussionReplyNotices(options);
  const marks = useMemo(
    () =>
      new DiscussionMarks<TextQuote>({
        selector: "[data-text-source]",
        describe: (root) => {
          let raw: unknown;
          try {
            raw = JSON.parse(root.dataset.textSource ?? "null");
          } catch {
            return null;
          }
          const parsed = textQuoteSourceSchema.safeParse(raw);
          if (!parsed.success) return null;
          const source = parsed.data;
          return {
            key: commentDiscussionSourceKey(source),
            quote: {
              id: "00000000-0000-4000-8000-000000000000",
              source,
              text: "",
              comment: "",
            },
          };
        },
        read: (quote, signal) => controller.sourcePage(quote, signal),
        range: (root, mark) => {
          const source = mark.locator?.source;
          if (source) {
            const parsed = textQuoteSourceSchema.safeParse(source);
            if (
              !parsed.success ||
              quoteSourceKey(parsed.data) !==
                quoteSourceKey(
                  textQuoteSourceSchema.parse(
                    JSON.parse(root.dataset.textSource!),
                  ),
                )
            )
              return null;
          }
          return discussionRange(root, mark);
        },
        open: (id, quote, at) => {
          setPoint(at);
          void controller.select(id, quote);
        },
      }),
    [controller],
  );
  useEffect(() => {
    if (!options.enabled) return;
    marks.start();
    return () => marks.dispose();
  }, [marks, options.enabled]);
  useEffect(
    () => marks.connection(options.connected !== false),
    [marks, options.connected],
  );
  useEffect(() => marks.setUnread(unread.keys()), [marks, unread]);
  const unreadEvent = current && unread.get(current.id);
  useEffect(() => {
    if (
      current?.submitted &&
      unreadEvent &&
      !current.messages.some(
        (message) => message.eventId === unreadEvent && message.entryId,
      )
    )
      controller.invalidate(current.id);
  }, [controller, current, current?.submitted, unreadEvent]);
  useEffect(() => {
    for (const view of controller.views.values())
      if (view.submitted)
        marks.accepted(
          {
            key: commentDiscussionSourceKey(view.quote.source),
            quote: view.quote,
          },
          {
            id: view.id,
            title:
              view.messages.find((m) => m.kind === "input")?.text ?? "讨论",
            preview: Array.from(view.quote.text).slice(0, 160).join(""),
            text: view.quote.text,
            created_at_micros: 0,
            publish_to_session: view.publish,
            locator: { source: view.quote.source, anchor: view.quote.anchor },
          },
        );
  }, [marks, controller, controller.version]);
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
    if (current?.submitted)
      controller.observeResponse(
        current.id,
        stream.connected,
        stream.discussionActivity,
      );
  }, [
    controller,
    current?.id,
    current?.submitted,
    stream.connected,
    stream.discussionActivity,
  ]);
  const liveReplies = useMemo(() => new Set<string>(), [controller]);
  useEffect(() => {
    const grouped = new Map<string, typeof stream.messages>();
    for (const message of stream.messages) {
      const id = message.commentDiscussion?.id;
      if (
        !id ||
        !message.text ||
        message.kind === "tool" ||
        message.kind === "evaluation"
      )
        continue;
      const list = grouped.get(id) ?? [];
      list.push(message);
      grouped.set(id, list);
    }
    for (const [id, messages] of grouped) {
      let needsHistory = false;
      for (const message of messages) {
        if (
          message.kind !== "reply" ||
          message.id.startsWith("stream:") ||
          message.discussionEntry ||
          liveReplies.has(message.id) ||
          controller.views
            .get(id)
            ?.messages.some((entry) => entry.id === message.id && entry.entryId)
        )
          continue;
        liveReplies.add(message.id);
        if (liveReplies.size > 128)
          liveReplies.delete(liveReplies.keys().next().value!);
        needsHistory = true;
      }
      controller.receive(
        id,
        messages.map((message) => ({
          id: message.id,
          eventId: message.discussionEntry?.eventId ?? message.id,
          ...(message.discussionEntry
            ? { entryId: message.discussionEntry.entryId }
            : {}),
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
      if (needsHistory) controller.invalidate(id);
    }
  }, [controller, stream.messages, liveReplies]);
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
    marks,
    unread,
    markRead,
    openReply: (quote: TextQuote) => {
      if (!latest.current.enabled || !quote.discussionReply) return;
      const { discussionId, messageId, eventId } = quote.discussionReply;
      const rect = locateTextQuote(quote)?.getBoundingClientRect();
      if (rect) setPoint({ x: rect.right, y: rect.bottom, rect });
      void controller.select(discussionId, quote, { messageId, eventId });
    },
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

export function CommentDiscussionMarks({
  owner,
}: {
  owner: DiscussionMarks<TextQuote>;
}) {
  const version = useSyncExternalStore(
    owner.subscribe,
    owner.snapshot,
    owner.snapshot,
  );
  const layer = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = layer.current;
    if (!node) return;
    const zoom =
      (node as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom ?? 1;
    [...node.children].forEach((child, index) => {
      const mark = owner.marks[index];
      if (mark && child instanceof HTMLElement) {
        child.style.left = `${mark.x / zoom}px`;
        child.style.top = `${mark.y / zoom}px`;
      }
    });
  }, [owner, version]);
  return (
    <div
      ref={layer}
      className="discussion-mark-layer"
      data-discussion-ui="true"
      data-quote-ui="true"
    >
      {owner.marks.map((mark) => (
        <button
          type="button"
          data-size="icon-xs"
          key={mark.key}
          className="icon-button discussion-source-mark"
          data-unread={mark.unread || undefined}
          title={`${mark.unread ? "有新回复" : "查看讨论"} · ${mark.preview}`}
          aria-label={`查看此处讨论（${mark.count}${mark.more ? "+" : ""}）${mark.unread ? "，有新回复" : ""}`}
          onClick={() => owner.open(mark)}
        >
          <MessageCircle size={14} />
          {(mark.count > 1 || mark.more) && (
            <span>
              {mark.count}
              {mark.more ? "+" : ""}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

export function CommentDiscussionPanel({
  controller,
  point,
  onOpen,
  unread,
  onRead,
  renderMarkdown,
  sendShortcut = "enter",
}: {
  controller: CommentDiscussionController<TextQuote>;
  point: QuotePoint;
  onOpen: (quote: TextQuote) => void;
  unread: ReadonlyMap<string, string>;
  onRead: (id: string, eventId: string) => void;
  renderMarkdown: (text: string, streaming: boolean) => ReactNode;
  sendShortcut?: InterfacePreferences["sendShortcut"];
}) {
  useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  const view = controller.active;
  const quotes = useTextQuotes();
  const panel = useRef<HTMLElement>(null),
    thread = useRef<HTMLDivElement>(null),
    following = useRef(true);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  useLayoutEffect(() => {
    if (!view || !panel.current) return;
    const node = panel.current;
    return observeTextQuoteLayout(node, () => {
      const rect = locateTextQuote(view.quote)?.getBoundingClientRect();
      void positionTextPopover(
        node,
        rect ? { x: rect.right, y: rect.bottom, rect } : point,
        "right-start",
      );
    });
  }, [view?.id, view?.quote, point]);
  const lastMessage = view?.messages.at(-1);
  const responses = view && discussionResponseRows(view);
  const streamingRoots = new Set(
    view?.messages
      .filter((message) => message.streaming && message.text.trim())
      .map((message) => message.rootId),
  );
  const settled = new Set(
    view?.responseActivity?.responses
      .filter((response) => response.phase === "settled")
      .map((response) => response.rootId),
  );
  useLayoutEffect(() => {
    following.current = true;
  }, [view?.id]);
  useLayoutEffect(() => {
    const node = thread.current;
    if (node && following.current) node.scrollTop = node.scrollHeight;
  }, [view?.id, lastMessage?.id, lastMessage?.text, responses?.size]);
  const focusReply = view?.focusReply;
  useLayoutEffect(() => {
    const node = thread.current;
    if (!node || !focusReply || view?.loading || !view?.sourceReady) return;
    const target = node.querySelector<HTMLElement>("[data-quote-target]");
    if (!target) return;
    following.current = false;
    node.scrollTop +=
      target.getBoundingClientRect().top - node.getBoundingClientRect().top - 8;
    target.focus({ preventScroll: true });
  }, [focusReply, view?.loading, view?.sourceReady]);
  const unreadEvent = view && unread.get(view.id);
  const hasUnreadReply = !!view?.messages.some(
    (message) =>
      message.entryId && message.eventId === unreadEvent && message.text,
  );
  useEffect(() => {
    const root = thread.current;
    if (!root || !view || !unreadEvent || !hasUnreadReply) return;
    const reply = root.querySelector<HTMLElement>("[data-unread-reply]");
    if (!reply) return;
    const check = () => {
      const panel = root.getBoundingClientRect(),
        row = reply.getBoundingClientRect();
      if (
        document.visibilityState === "visible" &&
        document.hasFocus() &&
        reply.checkVisibility({ visibilityProperty: true }) &&
        Math.min(row.bottom, panel.bottom) - Math.max(row.top, panel.top) >=
          Math.min(row.height, 24) &&
        row.height > 0
      )
        onRead(view.id, unreadEvent);
    };
    const observer = new IntersectionObserver(check, { root });
    observer.observe(reply);
    root.addEventListener("scroll", check, { passive: true });
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      observer.disconnect();
      root.removeEventListener("scroll", check);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, [view?.id, unreadEvent, hasUnreadReply, onRead]);
  useEffect(() => {
    setDirectoryOpen(false);
  }, [view?.id]);
  useEffect(() => {
    if (!view) return;
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !panel.current?.contains(event.target)
      ) {
        setDirectoryOpen(false);
        controller.close();
      }
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [controller, view?.id]);
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
          setDirectoryOpen(false);
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
          title="关闭讨论"
          aria-label="关闭讨论"
          onClick={() => {
            setDirectoryOpen(false);
            controller.close();
          }}
        >
          <X size={16} />
        </button>
      </header>
      {directoryOpen && (
        <nav className="discussion-directory" aria-label="此来源的讨论">
          <button
            type="button"
            onClick={() => {
              setDirectoryOpen(false);
              controller.open(view.quote, true);
            }}
          >
            新建讨论
          </button>
          {[...known].map(([id, preview]) => (
            <button
              type="button"
              key={id}
              aria-current={view.id === id ? "true" : undefined}
              data-unread={unread.has(id) || undefined}
              aria-label={unread.has(id) ? `${preview}，有新回复` : undefined}
              onClick={() => {
                setDirectoryOpen(false);
                void controller.select(id);
              }}
            >
              <span>{preview}</span>
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
        onScroll={(event) => {
          const node = event.currentTarget;
          following.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 32;
        }}
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
        {view.messages.map((message) => {
          const response =
            message.kind === "input" ? responses?.get(message.id) : undefined;
          const streaming =
            view.responseConnected !== false &&
            message.streaming === true &&
            !settled.has(message.rootId);
          const connected =
            view.responseConnected !== false ||
            response?.phase === "sending" ||
            !view.responseActivity;
          const quoteTarget =
            !!focusReply &&
            focusReply.messageId === message.entryId &&
            focusReply.eventId === message.eventId;
          const join = !!(
            quotes &&
            view.sourceReady &&
            message.kind === "reply" &&
            message.entryId &&
            !streaming &&
            !message.contentOmitted &&
            !message.truncated &&
            message.text.trim()
          );
          return (
            <Fragment key={message.id}>
              <article
                className={`discussion-message ${message.kind}`}
                data-stream-active={streaming || undefined}
                data-quote-target={quoteTarget || undefined}
                data-unread-reply={
                  (!!message.entryId && message.eventId === unreadEvent) ||
                  undefined
                }
                tabIndex={quoteTarget ? -1 : undefined}
              >
                {message.kind === "input" ? (
                  <p>{message.text}</p>
                ) : (
                  <div className="discussion-reply-content">
                    {renderMarkdown(message.text, streaming)}
                  </div>
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
                {join && (
                  <button
                    type="button"
                    className="discussion-join"
                    disabled={!quotes?.joinReply}
                    onClick={() => {
                      if (
                        quotes?.joinReply?.({
                          ...view.quote,
                          id: crypto.randomUUID(),
                          comment: "",
                          discussionReply: {
                            discussionId: view.id,
                            messageId: message.entryId!,
                            eventId: message.eventId,
                            text: message.text,
                          },
                        })
                      )
                        controller.close();
                    }}
                  >
                    <MessageSquarePlus size={14} aria-hidden="true" />
                    加入对话
                  </button>
                )}
              </article>
              {response &&
                (!connected || !streamingRoots.has(response.rootId)) && (
                  <ResponseWaiting
                    inputId={response.inputId}
                    createdAt={response.createdAt}
                    label={
                      connected
                        ? responseLabels[response.phase]
                        : "连接中断，等待恢复"
                    }
                    connected={connected}
                    animated={connected && response.phase !== "provider_wait"}
                    showElapsed={response.phase !== "provider_wait"}
                  />
                )}
            </Fragment>
          );
        })}
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
