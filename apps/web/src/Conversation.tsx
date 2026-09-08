import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { inputIntents } from "../../../packages/core/src/input-intent.js";
import type { Workspace } from "../../../packages/core/src/model.js";
import { discussionId } from "../../../packages/core/src/model.js";
import {
  conversationGroups,
  type ConversationRuntime,
} from "../../../packages/core/src/conversation.js";
import { shouldFollow } from "./interaction.js";
import { actorName } from "./client.js";
import { useConversationStream } from "./useConversationStream.js";
import type { LiveMessage } from "../../../packages/core/src/live-conversation.js";
import { Wrench, ChevronRight, Copy, Check, Square } from "lucide-react";
import type { WorkspaceClient } from "./client.js";

export type ExchangePosition = {
  top: number;
  following: boolean;
  version: string;
  revealed: string | null;
};

/** The conversation shares the primary column with objects and the global composer. */
export function Conversation({
  inputs,
  state,
  runtime,
  projectId,
  conversationId,
  onRetry,
  client,
  onOpen,
  positions,
  revealInputId,
}: {
  inputs: Workspace["inputs"];
  state: Workspace;
  runtime: ConversationRuntime;
  projectId: string;
  conversationId: string;
  onRetry: (id: string) => Promise<void>;
  client: WorkspaceClient;
  onOpen: (id: string) => void;
  positions: Map<string, ExchangePosition>;
  revealInputId: string | null;
}) {
  const [stopStates, setStopStates] = useState<
    Record<string, { pending: boolean; error: string }>
  >({});
  async function stopResponse(inputId: string) {
    setStopStates((states) => ({
      ...states,
      [inputId]: { pending: true, error: "" },
    }));
    try {
      await client.cancelInput(inputId);
      setStopStates((states) => ({
        ...states,
        [inputId]: { pending: false, error: "" },
      }));
    } catch (cause) {
      setStopStates((states) => ({
        ...states,
        [inputId]: {
          pending: false,
          error:
            cause instanceof Error ? cause.message : "未能确认停止，请重试。",
        },
      }));
    }
  }
  const scroller = useRef<HTMLElement>(null);
  const saved = positions.get(conversationId);
  const following = useRef(saved?.following ?? true);
  const initialized = useRef(false);
  const revealed = useRef(saved?.revealed ?? revealInputId);
  const [unread, setUnread] = useState(false);
  const stream = useConversationStream(
    projectId,
    conversationId,
    runtime.configured,
  );
  const messages = new Map<string, LiveMessage>();
  for (const m of runtime.messages)
    if (m.projectId === projectId && discussionId(m) === conversationId)
      messages.set(m.id, {
        ...m,
        conversationId,
        inputId: m.inputId ?? null,
        rootId: m.rootId ?? null,
      });
  for (const m of stream.messages)
    if (m.projectId === projectId && m.conversationId === conversationId)
      messages.set(m.id, m);
  const groups = conversationGroups(inputs, [...messages.values()]);
  // Keep cancellation with the corresponding response, including before its
  // first token arrives. Only authoritative input IDs establish ownership.
  const responseControls = new Map(
    groups.flatMap((group) => {
      const delivery = runtime.deliveries.find(
        (d) => d.inputId === group.inputId,
      );
      if (
        !delivery ||
        !["queued", "sending", "running"].includes(delivery.state) ||
        !(delivery.cancellable || delivery.cancelRequested)
      )
        return [];
      return [[group.messages.at(-1)?.id ?? group.id, delivery] as const];
    }),
  );
  const items = groups.flatMap((group) => [
    ...inputs
      .filter((input) => input.id === group.inputId)
      .map((input) => ({
        id: input.id,
        createdAt: input.createdAt,
        input,
        reply: null,
      })),
    ...group.messages.map((reply) => ({
      id: reply.id,
      createdAt: reply.createdAt,
      input: null,
      reply,
    })),
  ]);
  const contentVersion = items
    .map(
      (item) =>
        item.id +
        ":" +
        (item.reply?.text.length ?? 0) +
        ":" +
        (item.reply?.tool?.arguments.length ?? 0) +
        ":" +
        (item.reply?.tool?.result?.length ?? 0) +
        ":" +
        (item.reply?.tool?.status ?? "") +
        ":" +
        item.reply?.streaming,
    )
    .join("|");
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (!initialized.current && saved) el.scrollTop = saved.top;
    if (revealInputId && revealed.current !== revealInputId)
      following.current = true;
    if (following.current) {
      el.scrollTop = el.scrollHeight;
      setUnread(false);
    } else if (initialized.current || saved?.version !== contentVersion)
      setUnread(true);
    revealed.current = revealInputId;
    initialized.current = true;
    positions.set(conversationId, {
      top: el.scrollTop,
      following: following.current,
      version: contentVersion,
      revealed: revealed.current,
    });
  }, [contentVersion, revealInputId]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (following.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <section
      className="conversation"
      aria-label="当前对话"
      ref={scroller}
      onScroll={() => {
        const el = scroller.current;
        if (!el) return;
        following.current = shouldFollow(
          el.scrollHeight - el.clientHeight - el.scrollTop,
        );
        positions.set(conversationId, {
          top: el.scrollTop,
          following: following.current,
          version: contentVersion,
          revealed: revealed.current,
        });
        if (following.current) setUnread(false);
      }}
    >
      {(!runtime.connected || runtime.error) && (
        <div className="runtime-notice" role="note">
          <span className="connection-dot" />
          <div>
            <strong>
              {runtime.configured ? "正在重新连接 Morphz" : "Agent 尚未连接"}
            </strong>
            <p>
              {runtime.error ||
                (runtime.configured
                  ? "消息已保留，连接恢复后将继续发送。"
                  : "输入会保存在这里，但目前不会发送给 Morphz，也不会收到回复。")}
            </p>
          </div>
        </div>
      )}
      {items.length ? (
        <div
          className="conversation-messages"
          role="log"
          aria-label="对话消息"
          aria-live="polite"
          aria-relevant="additions"
        >
          {items.map(({ input: item, reply, id, createdAt }) => {
            const delivery = item
              ? runtime.deliveries.find((d) => d.inputId === item.id)
              : undefined;
            const status = !delivery
              ? "已保存 · 未发送"
              : {
                  queued: "",
                  sending: "",
                  running: "",
                  completed: "",
                  failed: "执行失败",
                  cancelled: "已取消",
                }[delivery.state];
            const control = responseControls.get(id);
            const stopControl = control && (
              <StopResponse
                key={control.inputId}
                delivery={control}
                stopping={stopStates[control.inputId]?.pending ?? false}
                error={stopStates[control.inputId]?.error ?? ""}
                onStop={stopResponse}
              />
            );
            return (
              <Fragment key={id}>
                <article
                  className={
                    "message conversation-message" +
                    (reply ? " agent-reply " + reply.kind : " human-message")
                  }
                  key={id}
                  data-input-id={item?.id ?? reply?.inputId ?? undefined}
                  data-message-id={id}
                  data-streaming={reply?.streaming || undefined}
                  data-stream-active={
                    (stream.connected &&
                      reply?.streaming &&
                      (!reply.tool || reply.tool.status === "generating")) ||
                    undefined
                  }
                >
                  {item?.intent && (
                    <small className="message-intent">
                      {inputIntents[item.intent].label}
                    </small>
                  )}
                  {item?.selection && <blockquote>{item.selection}</blockquote>}
                  {item?.artifactId && (
                    <button
                      className="message-object-link"
                      onClick={() => onOpen(item.artifactId!)}
                    >
                      {state.artifacts.find((a) => a.id === item.artifactId)
                        ?.title ?? "关联对象"}{" "}
                      · v{item.artifactRevision}
                    </button>
                  )}
                  {item ? (
                    <p>{item.body}</p>
                  ) : (
                    <div className="reply-content">
                      {reply?.tool ? (
                        <ToolMessage message={reply} />
                      ) : reply?.kind === "progress" ? (
                        <details className="message-progress">
                          <summary>执行进度</summary>
                          <p>{reply.text}</p>
                        </details>
                      ) : (
                        <>
                          <Markdown
                            skipHtml
                            components={{
                              a: ({ children }) => <span>{children}</span>,
                              img: ({ alt }) => <span>{alt || "图片"}</span>,
                            }}
                          >
                            {reply!.text}
                          </Markdown>
                        </>
                      )}
                    </div>
                  )}
                  {(reply?.kind !== "tool" || stopControl) && (
                    <div className="message-meta">
                      {reply && stopControl}
                      {item &&
                        item.author.actantId !== client.boot?.actantId && (
                          <span>{actorName(state, item.author.actantId)}</span>
                        )}
                      {item && status && <span>{status}</span>}
                      {reply?.kind !== "tool" && (
                        <MessageActions
                          createdAt={createdAt}
                          text={item?.body ?? reply!.text}
                        />
                      )}
                    </div>
                  )}
                  {delivery?.error && (
                    <div className="delivery-error" role="alert">
                      {delivery.error}
                    </div>
                  )}
                  {item &&
                    runtime.configured &&
                    (!delivery || delivery.retryable) && (
                      <button
                        className="retry-input"
                        onClick={() => void onRetry(item.id)}
                      >
                        {delivery ? "重试发送" : "发送这条消息"}
                      </button>
                    )}
                </article>
                {item && stopControl && (
                  <div className="response-placeholder">{stopControl}</div>
                )}
              </Fragment>
            );
          })}
        </div>
      ) : (
        <div className="conversation-empty">
          <p>这里还没有交流记录</p>
        </div>
      )}
      {unread && (
        <button
          className="new-exchange"
          onClick={() => {
            following.current = true;
            if (scroller.current)
              scroller.current.scrollTop = scroller.current.scrollHeight;
            setUnread(false);
          }}
        >
          有新内容 · 返回最新
        </button>
      )}
    </section>
  );
}

function StopResponse({
  delivery,
  stopping,
  error,
  onStop,
}: {
  delivery: ConversationRuntime["deliveries"][number];
  stopping: boolean;
  error: string;
  onStop: (inputId: string) => Promise<void>;
}) {
  const pending = stopping || delivery.cancelRequested;
  const label = pending ? "已请求停止，等待确认" : "停止这次处理";
  return (
    <div
      className="response-controls"
      data-response-input-id={delivery.inputId}
    >
      <button
        className="stop-response"
        aria-label={label}
        title={pending ? label : "停止这次处理；已发生的操作不会撤销。"}
        disabled={pending}
        onClick={() => {
          if (!pending) void onStop(delivery.inputId);
        }}
      >
        <Square size={12} fill="currentColor" aria-hidden="true" />
        <span>停止</span>
      </button>
      {error && (
        <span className="delivery-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

function MessageActions({
  createdAt,
  text,
}: {
  createdAt: string;
  text: string;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <>
      <span className="message-peek">
        <time dateTime={createdAt}>
          {new Date(createdAt).toLocaleString("zh-CN", {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </time>
        <button
          className="message-copy"
          type="button"
          aria-label={copied ? "已复制消息" : "复制消息"}
          title={copied ? "已复制" : "复制消息"}
          onClick={async () => {
            setError(false);
            try {
              await copyMessage(text);
              setCopied(true);
            } catch {
              setCopied(false);
              setError(true);
            }
          }}
        >
          {copied ? (
            <Check size={13} aria-hidden="true" />
          ) : (
            <Copy size={13} aria-hidden="true" />
          )}
        </button>
      </span>
      {error && (
        <span className="delivery-error" role="alert">
          复制失败，请重试或选中文字复制。
        </span>
      )}
    </>
  );
}

async function copyMessage(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Electron's permission gate can reject the async Clipboard API. Copy only
    // the requested message via the existing user gesture; never read clipboard.
    const selection = window.getSelection();
    const ranges = selection
      ? Array.from({ length: selection.rangeCount }, (_, i) =>
          selection.getRangeAt(i).cloneRange(),
        )
      : [];
    const focused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const input = document.createElement("textarea");
    input.value = text;
    input.readOnly = true;
    input.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    document.body.append(input);
    try {
      input.select();
      if (!document.execCommand("copy")) throw new Error("Copy unavailable");
    } finally {
      input.remove();
      focused?.focus({ preventScroll: true });
      if (selection) {
        selection.removeAllRanges();
        for (const range of ranges) selection.addRange(range);
      }
    }
  }
}

function ToolMessage({ message }: { message: LiveMessage }) {
  const tool = message.tool!;
  const status =
    (
      {
        generating: "正在生成参数",
        pending: "参数已生成",
        running: "执行中",
        queued: "排队中",
        waiting_approval: "等待审批",
        approval_required: "等待审批",
        success: "已完成",
        succeeded: "已完成",
        completed: "已完成",
        failed: "失败",
        error: "失败",
        cancelled: "已取消",
      } as Record<string, string>
    )[tool.status] ?? tool.status;
  return (
    <details className="message-tool" data-tool-status={tool.status}>
      <summary>
        <ChevronRight className="tool-chevron" size={14} />
        <Wrench size={14} aria-hidden="true" />
        <span className="tool-name">{tool.name || "工具调用"}</span>
        <span className="tool-state">{status}</span>
      </summary>
      <div className="tool-details">
        {tool.arguments && (
          <>
            <span className="tool-detail-label">参数</span>
            <pre>{tool.arguments}</pre>
          </>
        )}
        {tool.result !== undefined && (
          <>
            <span className="tool-detail-label">结果</span>
            <pre>{tool.result || "无文本输出"}</pre>
          </>
        )}
        {tool.truncated && (
          <small>此处为预览；完整记录可在执行记录与审批中查看。</small>
        )}
      </div>
    </details>
  );
}
