import { useLayoutEffect, useRef, useState } from "react";
import { MessageCircle } from "lucide-react";
import Markdown from "react-markdown";
import type { Workspace } from "../../../packages/core/src/model.js";
import {
  conversationGroups,
  type ConversationRuntime,
} from "../../../packages/core/src/conversation.js";
import { shouldFollow } from "./interaction.js";
import { actorName } from "./client.js";
import { BrandMark } from "./BrandMark.js";
import { ExecutionDialog } from "./ExecutionDialog.js";
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
  contextTitle,
  runtime,
  projectId,
  artifactId,
  onRetry,
  client,
  onOpen,
  positions,
  revealInputId,
}: {
  inputs: Workspace["inputs"];
  state: Workspace;
  contextTitle: string;
  runtime: ConversationRuntime;
  projectId: string;
  artifactId: string | null;
  onRetry: (id: string) => Promise<void>;
  client: WorkspaceClient;
  onOpen: (id: string) => void;
  positions: Map<string, ExchangePosition>;
  revealInputId: string | null;
}) {
  const [executions, setExecutions] = useState(false);
  const [stopping, setStopping] = useState<string | null>(null);
  const [stopError, setStopError] = useState("");
  const scroller = useRef<HTMLElement>(null);
  const saved = positions.get(projectId);
  const following = useRef(saved?.following ?? true);
  const initialized = useRef(false);
  const revealed = useRef(saved?.revealed ?? revealInputId);
  const [unread, setUnread] = useState(false);
  const groups = conversationGroups(
    inputs,
    runtime.messages.filter((m) => m.projectId === projectId),
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
    .map((item) => item.id + ":" + (item.reply?.text.length ?? 0))
    .join("|");
  const active = runtime.deliveries.filter(
    (d) =>
      inputs.some((i) => i.id === d.inputId) &&
      ["queued", "sending", "running"].includes(d.state),
  );
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
    positions.set(projectId, {
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
        positions.set(projectId, {
          top: el.scrollTop,
          following: following.current,
          version: contentVersion,
          revealed: revealed.current,
        });
        if (following.current) setUnread(false);
      }}
    >
      <header className="conversation-heading">
        <span>{contextTitle}的交流</span>
        <button
          className="conversation-execution-button"
          disabled={!runtime.configured}
          onClick={() => setExecutions(true)}
        >
          执行记录与审批
        </button>
      </header>
      {stopError && (
        <p role="alert" className="delivery-error">
          {stopError}
        </p>
      )}
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
                  queued: "排队中",
                  sending: "正在发送",
                  running: "Morphz 正在处理",
                  completed: "已完成",
                  failed: "执行失败",
                  cancelled: "已取消",
                }[delivery.state];
            return (
              <article
                className={
                  "message conversation-message" +
                  (reply ? " agent-reply " + reply.kind : " human-message")
                }
                key={id}
                data-input-id={item?.id ?? reply?.inputId ?? undefined}
              >
                <div className="message-author">
                  <span className="avatar">
                    {item ? (
                      actorName(state, item.author.actantId).slice(0, 1)
                    ) : (
                      <BrandMark />
                    )}
                  </span>
                  <span>
                    {item
                      ? actorName(state, item.author.actantId)
                      : reply?.kind === "reply"
                        ? "Morphz"
                        : "执行进度"}
                  </span>
                  <time dateTime={createdAt}>
                    {new Date(createdAt).toLocaleString("zh-CN", {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </div>
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
                    {reply?.kind === "progress" ? (
                      <details className="message-progress">
                        <summary>执行进度</summary>
                        <p>{reply.text}</p>
                      </details>
                    ) : (
                      <Markdown
                        skipHtml
                        components={{
                          a: ({ children }) => <span>{children}</span>,
                          img: ({ alt }) => <span>{alt || "图片"}</span>,
                        }}
                      >
                        {reply!.text}
                      </Markdown>
                    )}
                  </div>
                )}
                {item && (
                  <small>
                    {delivery?.cancelRequested
                      ? "已请求停止 · 等待 Runtime 确认"
                      : status}
                    {item.artifactRevision
                      ? " · v" + item.artifactRevision
                      : ""}
                  </small>
                )}
                {delivery?.error && (
                  <div className="delivery-error" role="alert">
                    {delivery.error}
                  </div>
                )}
                {item && delivery?.cancellable && (
                  <button
                    className="retry-input"
                    disabled={stopping === item.id}
                    title="只停止这条输入的处理；已发生的操作不会撤销。"
                    onClick={async () => {
                      setStopping(item.id);
                      setStopError("");
                      try {
                        await client.cancelInput(item.id);
                      } catch (error) {
                        setStopError(
                          error instanceof Error
                            ? error.message
                            : "未能确认停止。",
                        );
                      } finally {
                        setStopping(null);
                      }
                    }}
                  >
                    {stopping === item.id
                      ? "正在请求…"
                      : delivery.state === "queued"
                        ? "取消发送"
                        : "停止这次处理"}
                  </button>
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
            );
          })}
        </div>
      ) : (
        <div className="conversation-empty">
          <MessageCircle />
          <p>这里还没有交流记录</p>
          <small>在下方输入，围绕当前工作继续。</small>
        </div>
      )}
      {active.length > 0 && (
        <div className="execution-status" role="status">
          <span className="connection-dot" />
          {runtime.connected
            ? `Morphz 正在处理${active.length > 1 ? ` ${active.length} 条消息` : ""}…`
            : "等待连接恢复…"}
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
      {executions && (
        <ExecutionDialog
          key={projectId + ":" + artifactId}
          client={client}
          scope={{ projectId, artifactId }}
          onClose={() => setExecutions(false)}
          onOpen={onOpen}
        />
      )}
    </section>
  );
}
