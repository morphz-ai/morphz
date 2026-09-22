import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SafeMarkdown } from "./SafeMarkdown.js";
import { inputIntents } from "../../../packages/core/src/input-intent.js";
import type { Workspace } from "../../../packages/core/src/model.js";
import {
  conversationGroups,
  conversationTimeline,
  activeExecutionThreads,
  type ConversationRuntime,
} from "../../../packages/core/src/conversation.js";
import { shouldFollow } from "./interaction.js";
import { actorName } from "./client.js";
import {
  focusedInputs,
  hasUnreadReplies,
  replyReceipts,
  type ReadReplies,
  type ReplyReceipt,
} from "./conversation-read.js";
import type { LiveMessage } from "../../../packages/core/src/live-conversation.js";
import { Wrench, ChevronRight, Copy, Check, Square, Film } from "lucide-react";
import {
  resolveScriptLocation,
  type ScriptOutput,
} from "../../../packages/core/src/script-delivery.js";
import { scriptKindLabels } from "../../../packages/core/src/script-studio.js";
import type { WorkspaceClient } from "./client.js";
import { ObjectIcon } from "./ArtifactEditor.js";
import { AttachmentPreview } from "./AttachmentPreview.js";
import { conversationDate } from "./conversation-presentation.js";
import { ApprovalCard } from "./ApprovalCard.js";
import { executionPresentation } from "./execution-presentation.js";
import type { InputContinuation } from "../../../packages/core/src/continuation.js";

export type ExchangePosition = {
  top: number;
  following: boolean;
  revealed: string | null;
};

/** The conversation shares the primary column with objects and the global composer. */
export function Conversation({
  inputs: allInputs,
  state,
  runtime,
  messages,
  streamConnected,
  seenReplies,
  onRead,
  conversationId,
  onRetry,
  client,
  onOpen,
  onOpenScript,
  positions,
  revealInputId,
  onInspect,
  onSupplement,
  focusedArtifactId,
  focusedApplicationId,
  toolbarTarget,
  onReturnToLatest,
}: {
  onReturnToLatest?: () => void;
  toolbarTarget?: HTMLElement | null;
  focusedArtifactId?: string;
  focusedApplicationId?: string;
  inputs: Workspace["inputs"];
  state: Workspace;
  runtime: ConversationRuntime;
  messages: LiveMessage[];
  streamConnected: boolean;
  seenReplies: ReadReplies;
  onRead: (receipts: ReplyReceipt[]) => void;
  conversationId: string;
  onRetry: (id: string) => Promise<void>;
  client: WorkspaceClient;
  onOpen: (
    id: string,
    revision?: number,
    page?: number,
    reading?: import("../../../packages/core/src/reader.js").ReadingLocation,
  ) => void;
  onOpenScript?: (output: ScriptOutput) => void;
  positions: Map<string, ExchangePosition>;
  revealInputId: string | null;
  onInspect?: (inputId: string) => void;
  onSupplement?: (target: InputContinuation) => void;
}) {
  const [allHistory, setAllHistory] = useState(false);
  useEffect(
    () => setAllHistory(false),
    [focusedArtifactId, focusedApplicationId],
  );
  const focused = !!(focusedArtifactId || focusedApplicationId) && !allHistory;
  const inputs = focusedInputs(
    allInputs,
    client.boot!.outputs,
    focused
      ? { artifactId: focusedArtifactId, applicationId: focusedApplicationId }
      : {},
  );
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
  const latestButton = useRef<HTMLButtonElement>(null);
  const positionKey =
    conversationId +
    (focused
      ? ":focus:" + (focusedArtifactId ?? focusedApplicationId)
      : ":all");
  const saved = positions.get(positionKey);
  const previousPositionKey = useRef(positionKey);
  const following = useRef(saved?.following ?? true);
  const initialized = useRef(false);
  const revealed = useRef(saved?.revealed ?? revealInputId);
  const [awayFromLatest, setAwayFromLatest] = useState(!following.current);
  function acknowledgeVisibleReplies() {
    if (
      following.current &&
      document.visibilityState === "visible" &&
      document.hasFocus() &&
      !document.querySelector("dialog[open]")
    )
      onRead(receipts);
  }
  function updateLatestIndicator() {
    if (following.current) {
      // Move focus before removing its button. A detached focused control
      // otherwise looks like leaving the unpinned exchange. Do not steal
      // focus when ordinary scrolling or new content reaches the bottom.
      if (latestButton.current === document.activeElement) {
        onReturnToLatest?.();
        if (latestButton.current === document.activeElement)
          scroller.current?.focus({ preventScroll: true });
      }
      acknowledgeVisibleReplies();
    }
    setAwayFromLatest(!following.current);
  }
  const groups = conversationGroups(
    inputs,
    messages.filter(
      (m) =>
        !focused || (!!m.inputId && inputs.some((i) => i.id === m.inputId)),
    ),
  );
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
      return [
        [
          group.messages
            .filter(
              (m) =>
                (m.kind === "reply" || m.kind === "error") && m.text.trim(),
            )
            .at(-1)?.id ?? group.id,
          delivery,
        ] as const,
      ];
    }),
  );
  const items = conversationTimeline(
    groups.flatMap((group) => [
      ...inputs
        .filter((input) => input.id === group.inputId)
        .map((input) => ({
          id: input.id,
          createdAt: input.createdAt,
          input,
          reply: null,
        })),
      ...group.messages
        .filter((m) => !onInspect || m.kind === "reply" || m.kind === "error")
        .filter(
          (m) => (m.kind !== "reply" && m.kind !== "error") || m.text.trim(),
        )
        .map((reply) => ({
          id: reply.id,
          createdAt: reply.createdAt,
          input: null,
          reply,
        })),
    ]),
  );
  const outputs = (client.boot?.outputs ?? []).filter((o) =>
    inputs.some((i) => i.id === o.inputId),
  );
  const scriptOutputs = (client.boot?.scriptOutputs ?? []).filter((o) =>
    inputs.some((i) => i.id === o.inputId),
  );
  // Presentation only, owned by the actual input. Waiting is not a reply,
  // publication or unread receipt, and does not depend on cancellation support.
  const waitingResponses = new Map(
    groups.flatMap((group) => {
      const delivery = runtime.deliveries.find(
        (d) => d.inputId === group.inputId,
      );
      if (
        !runtime.configured ||
        !delivery ||
        delivery.supplement ||
        delivery.error ||
        !["queued", "sending", "running"].includes(delivery.state) ||
        group.messages.some(
          (m) => (m.kind === "reply" || m.kind === "error") && m.text.trim(),
        ) ||
        outputs.some((o) => o.inputId === group.inputId) ||
        scriptOutputs.some((o) => o.inputId === group.inputId) ||
        runtime.attention?.approvals.some(
          (a) => a.scope.inputId === group.inputId,
        )
      )
        return [];
      const connected = client.online && runtime.connected;
      const label = !connected
        ? "连接中断，等待恢复"
        : delivery.cancelRequested || stopStates[delivery.inputId]?.pending
          ? "已请求停止，等待确认"
          : delivery.state === "sending"
            ? "正在发送…"
            : delivery.state === "queued"
              ? "等待处理…"
              : "正在处理…";
      return [[group.id, { label, connected }] as const];
    }),
  );
  const deliveryItems = outputs.map((o) => ({
    id: "output:" + o.commandId,
    createdAt: o.createdAt,
    input: null,
    reply: null,
    output: o,
    scriptOutput: null as ScriptOutput | null,
  }));
  const timeline = conversationTimeline([
    ...items.map((item) => ({
      ...item,
      output: null as (typeof outputs)[number] | null,
      scriptOutput: null as ScriptOutput | null,
    })),
    ...deliveryItems,
    ...scriptOutputs.map((o) => ({
      id: "output:" + o.commandId,
      createdAt: o.createdAt,
      input: null,
      reply: null,
      output: null,
      scriptOutput: o,
    })),
  ]);
  const receipts = replyReceipts(
    items.flatMap((item) => (item.reply ? [item.reply] : [])),
    outputs,
    scriptOutputs,
  );
  const readVersion = JSON.stringify(receipts);
  const unread = hasUnreadReplies(seenReplies, receipts);
  const contentVersion =
    timeline
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
      .join("|") + JSON.stringify([...waitingResponses]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (previousPositionKey.current !== positionKey) {
      initialized.current = false;
      following.current = saved?.following ?? true;
      revealed.current = saved?.revealed ?? revealInputId;
      previousPositionKey.current = positionKey;
    }
    if (!initialized.current && saved) el.scrollTop = saved.top;
    if (revealInputId && revealed.current !== revealInputId)
      following.current = true;
    if (following.current) {
      el.scrollTop = el.scrollHeight;
    }
    revealed.current = revealInputId;
    initialized.current = true;
    updateLatestIndicator();
    positions.set(positionKey, {
      top: el.scrollTop,
      following: following.current,
      revealed: revealed.current,
    });
  }, [contentVersion, readVersion, revealInputId, positionKey, onRead]);
  useEffect(() => {
    const read = () => acknowledgeVisibleReplies();
    document.addEventListener("visibilitychange", read);
    window.addEventListener("focus", read);
    document.addEventListener("focusin", read);
    return () => {
      document.removeEventListener("visibilitychange", read);
      window.removeEventListener("focus", read);
      document.removeEventListener("focusin", read);
    };
  }, [readVersion, positionKey, onRead]);
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
      tabIndex={-1}
      ref={scroller}
      onScroll={() => {
        const el = scroller.current;
        if (!el) return;
        following.current = shouldFollow(
          el.scrollHeight - el.clientHeight - el.scrollTop,
        );
        updateLatestIndicator();
        positions.set(positionKey, {
          top: el.scrollTop,
          following: following.current,
          revealed: revealed.current,
        });
      }}
    >
      {(focusedArtifactId || focusedApplicationId) &&
        toolbarTarget &&
        createPortal(
          <button
            className="conversation-scope"
            onClick={() => setAllHistory(!allHistory)}
          >
            {allHistory
              ? focusedArtifactId
                ? "仅看当前对象的交流"
                : "仅看当前应用的交流"
              : "查看全部交流"}
          </button>,
          toolbarTarget,
        )}
      {timeline.length ? (
        <div
          className="conversation-messages"
          role="log"
          aria-label="对话消息"
          aria-live="polite"
          aria-relevant="additions"
        >
          {timeline.map(
            (
              { input: item, reply, output, scriptOutput, id, createdAt },
              index,
            ) => {
              const date = conversationDate(createdAt);
              const previous = timeline[index - 1];
              const dateDivider = date &&
                date.key !==
                  conversationDate(previous?.createdAt ?? "")?.key && (
                  <div className="conversation-date">
                    <time dateTime={date.key}>{date.label}</time>
                  </div>
                );
              const inputId =
                item?.id ??
                reply?.inputId ??
                output?.inputId ??
                scriptOutput?.inputId;
              const previousInputId =
                previous?.input?.id ??
                previous?.reply?.inputId ??
                previous?.output?.inputId ??
                previous?.scriptOutput?.inputId;
              const startsTurn =
                !!previous &&
                !dateDivider &&
                (!inputId || inputId !== previousInputId);
              if (scriptOutput) {
                const resolved = resolveScriptLocation(state, scriptOutput);
                const version = resolved?.item?.versions.find(
                  (v) => v.revision === scriptOutput.revision,
                );
                const candidate = resolved?.production.candidates.find(
                  (c) => c.id === scriptOutput.candidateId,
                );
                const label =
                  scriptOutput.kind === "production"
                    ? "剧本"
                    : scriptOutput.kind === "candidate"
                      ? `候选稿 · ${candidate?.status === "accepted" ? "已采纳" : candidate?.status === "rejected" ? "已拒绝" : "待决定"}`
                      : scriptOutput.kind === "review"
                        ? "审查意见"
                        : `${resolved?.item ? scriptKindLabels[resolved.item.kind] : "条目"}${version && !version.draft.text.trim() ? " · 空白条目" : ""}`;
                return (
                  <Fragment key={id}>
                    {dateDivider}
                    <article
                      className="conversation-message agent-message delivery-message"
                      data-starts-turn={startsTurn || undefined}
                      data-message-id={id}
                    >
                      <button
                        className="delivery-object"
                        disabled={!resolved || !onOpenScript}
                        aria-label={`打开${scriptOutput.kind === "production" ? "剧本" : "剧本结果"}：${scriptOutput.title}`}
                        onClick={() => onOpenScript?.(scriptOutput)}
                      >
                        <Film aria-hidden />
                        <span className="delivery-object-info">
                          <small>{label}</small>
                          <span>{scriptOutput.title}</span>
                          {scriptOutput.itemId && (
                            <small>
                              {resolved?.production.title ?? "对象不可用"}
                            </small>
                          )}
                        </span>
                        {scriptOutput.itemId && (
                          <small>v{scriptOutput.revision}</small>
                        )}
                        <ChevronRight size={14} aria-hidden />
                      </button>
                    </article>
                  </Fragment>
                );
              }
              if (output) {
                const artifact = state.artifacts.find(
                  (a) => a.id === output.artifactId,
                );
                const version = artifact?.versions.find(
                  (v) => v.revision === output.revision,
                );
                return (
                  <Fragment key={id}>
                    {dateDivider}
                    <article
                      className="conversation-message agent-message delivery-message"
                      data-starts-turn={startsTurn || undefined}
                      data-message-id={id}
                    >
                      <button
                        className="delivery-object"
                        disabled={!version}
                        aria-label={
                          "打开交付：" + (version?.title ?? "对象不可用")
                        }
                        onClick={() =>
                          onOpen(output.artifactId, output.revision)
                        }
                      >
                        {artifact && (
                          <ObjectIcon kind={artifact.content.kind} />
                        )}
                        <span className="delivery-object-info">
                          <small>交付内容</small>
                          <span>
                            {version?.title ?? "对象不存在或无访问权限"}
                          </span>
                        </span>
                        <small>v{output.revision}</small>
                        <ChevronRight size={14} />
                      </button>
                    </article>
                  </Fragment>
                );
              }
              const delivery = item
                ? runtime.deliveries.find((d) => d.inputId === item.id)
                : undefined;
              const activeBranch =
                item &&
                client.online &&
                activeExecutionThreads(runtime).some(
                  (t) => t.inputId === item.id,
                );
              const approvals = item
                ? (runtime.attention?.approvals.filter(
                    (a) => a.scope.inputId === item.id,
                  ) ?? [])
                : [];
              const targets =
                item &&
                item.continuation?.mode !== "supplement" &&
                runtime.activity?.available &&
                runtime.connected &&
                client.online
                  ? runtime.activity.threads.filter(
                      (t) =>
                        t.inputId === item.id &&
                        t.kind === "execution" &&
                        t.lifecycle === "open" &&
                        t.continuation,
                    )
                  : [];
              const status = delivery?.supplement
                ? {
                    pending: "补充待送达",
                    delivered: "补充已送达",
                    rejected: "补充未送达",
                    unknown: "补充送达待确认",
                  }[delivery.supplement]
                : !delivery
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
              const waiting = waitingResponses.get(id);
              const stopControl = control && (
                <StopResponse
                  key={control.inputId}
                  delivery={control}
                  stopping={stopStates[control.inputId]?.pending ?? false}
                  error={stopStates[control.inputId]?.error ?? ""}
                  onStop={stopResponse}
                  available={client.online && runtime.connected}
                />
              );
              return (
                <Fragment key={id}>
                  {dateDivider}
                  <article
                    className={
                      "message conversation-message" +
                      (reply ? " agent-reply " + reply.kind : " human-message")
                    }
                    key={id}
                    data-input-id={item?.id ?? reply?.inputId ?? undefined}
                    data-message-id={id}
                    data-starts-turn={startsTurn || undefined}
                    data-background-execution={activeBranch || undefined}
                    data-supplement-target={targets.length > 0 || undefined}
                    aria-description={
                      activeBranch ? "这条消息的后台执行仍在进行" : undefined
                    }
                    data-streaming={reply?.streaming || undefined}
                    data-stream-active={
                      (streamConnected &&
                        reply?.streaming &&
                        (!reply.tool || reply.tool.status === "generating")) ||
                      undefined
                    }
                  >
                    {item?.continuation && (
                      <button
                        className="message-source"
                        onClick={() => onInspect?.(item.continuation!.inputId)}
                      >
                        {item.continuation.mode === "supplement"
                          ? "补充给："
                          : "接着处理："}
                        {state.inputs
                          .find((i) => i.id === item.continuation!.inputId)
                          ?.body.slice(0, 50) || "原工作"}
                        <ChevronRight size={12} />
                      </button>
                    )}
                    {reply?.inputId &&
                      onInspect &&
                      (timeline[index - 1]?.input?.id ??
                        timeline[index - 1]?.reply?.inputId ??
                        timeline[index - 1]?.output?.inputId) !==
                        reply.inputId && (
                        <button
                          className="message-source"
                          onClick={() => onInspect(reply.inputId!)}
                        >
                          关于：
                          {inputs
                            .find((i) => i.id === reply.inputId)
                            ?.body.slice(0, 50) ?? "之前的工作"}
                          <ChevronRight size={12} />
                        </button>
                      )}
                    {item?.intent && (
                      <small className="message-intent">
                        {inputIntents[item.intent].label}
                      </small>
                    )}
                    {item?.selection && (
                      <blockquote>{item.selection}</blockquote>
                    )}
                    {item?.artifactId && (
                      <button
                        className="message-object-link"
                        onClick={() =>
                          onOpen(
                            item.artifactId!,
                            item.artifactRevision ?? undefined,
                            undefined,
                            item.reading?.location,
                          )
                        }
                      >
                        {state.artifacts
                          .find((a) => a.id === item.artifactId)
                          ?.versions.find(
                            (v) => v.revision === item.artifactRevision,
                          )?.title ?? "关联对象"}
                        {item.reading &&
                          ` · ${item.reading.chapter} · 回到原文`}
                        {!item.reading &&
                          item.artifactRevision != null &&
                          ` · v${item.artifactRevision}`}
                      </button>
                    )}
                    {item?.localFile && (
                      <small
                        className="message-local-file"
                        title="本机原文件引用，不是导入副本；读取时校验版本和授权。"
                      >
                        原文件：{item.localFile.name}
                      </small>
                    )}
                    {!!item?.directories?.length && (
                      <small
                        className="message-local-file"
                        title="发送时允许使用的目录；是否仍可访问以当前授权为准。"
                      >
                        目录读写：
                        {item.directories.map((g) => g.name).join("、")}
                      </small>
                    )}
                    {item ? (
                      <>
                        {!!item.attachments?.length && (
                          <div className="message-attachments">
                            {item.attachments.map((a, index) => (
                              <AttachmentPreview
                                key={a.assetId + index}
                                attachment={a}
                              />
                            ))}
                          </div>
                        )}
                        {item.body && <p>{item.body}</p>}
                      </>
                    ) : (
                      <div className="reply-content">
                        {reply?.tool ? (
                          <ToolMessage message={reply} state={state} />
                        ) : reply?.kind === "progress" ? (
                          <details className="message-progress">
                            <summary>执行进度</summary>
                            <p>{reply.text}</p>
                          </details>
                        ) : (
                          <>
                            <SafeMarkdown
                              state={state}
                              onOpen={onOpen}
                              streaming={
                                !!(streamConnected && reply?.streaming)
                              }
                            >
                              {reply!.text}
                            </SafeMarkdown>
                          </>
                        )}
                      </div>
                    )}
                    {(reply?.kind !== "tool" || stopControl) && (
                      <div className="message-meta">
                        {item && onSupplement && targets.length > 0 && (
                          <button
                            className="message-execution-link"
                            title="给这项后台工作追加要求"
                            onClick={() =>
                              targets.length === 1
                                ? onSupplement(targets[0]!.continuation!)
                                : onInspect?.(item.id)
                            }
                          >
                            {targets.length === 1 ? "补充要求" : "选择补充分支"}
                          </button>
                        )}
                        {item && activeBranch && onInspect && (
                          <button
                            className="message-execution-link"
                            onClick={() => onInspect(item.id)}
                          >
                            后台执行中
                          </button>
                        )}
                        {reply && stopControl}
                        {item &&
                          item.author.actantId !== client.boot?.actantId && (
                            <span>
                              {actorName(state, item.author.actantId)}
                            </span>
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
                  {approvals.map((entry) => (
                    <ApprovalCard
                      key={
                        entry.approval.request.approval_id +
                        entry.approval.fingerprint
                      }
                      entry={entry}
                      client={client}
                      available={
                        !!(
                          client.online &&
                          runtime.connected &&
                          runtime.attention?.available
                        )
                      }
                      onInspect={
                        item && onInspect ? () => onInspect(item.id) : undefined
                      }
                    />
                  ))}
                  {item && waiting && (
                    <div
                      className="response-placeholder"
                      data-waiting-input-id={item.id}
                      data-connected={waiting.connected}
                    >
                      <span className="response-waiting" role="status">
                        <span className="response-dots" aria-hidden="true">
                          <i />
                          <i />
                          <i />
                        </span>
                        {waiting.label}
                      </span>
                      {stopControl}
                    </div>
                  )}
                </Fragment>
              );
            },
          )}
        </div>
      ) : (
        <div className="conversation-empty">
          <p>暂无交流记录</p>
        </div>
      )}
      {awayFromLatest && (
        <div className="conversation-return">
          <button
            ref={latestButton}
            className="new-exchange"
            onClick={() => {
              following.current = true;
              if (scroller.current)
                scroller.current.scrollTop = scroller.current.scrollHeight;
              updateLatestIndicator();
            }}
          >
            {unread ? "有新内容 · 返回最新" : "返回最新"}
          </button>
        </div>
      )}
    </section>
  );
}

export function StopResponse({
  delivery,
  stopping,
  error,
  onStop,
  available = true,
}: {
  delivery: ConversationRuntime["deliveries"][number];
  stopping: boolean;
  error: string;
  onStop: (inputId: string) => Promise<void>;
  available?: boolean;
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
        disabled={pending || !available}
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

export function ToolMessage({
  message,
  state,
}: {
  message: LiveMessage;
  state: Workspace;
}) {
  const tool = message.tool!;
  let presentation;
  try {
    presentation = executionPresentation(
      tool.name,
      JSON.parse(tool.arguments),
      state,
    );
  } catch {
    /* Streaming arguments may be incomplete. */
  }
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
        <span className="tool-name" title={presentation?.detail}>
          {presentation?.title ?? tool.name ?? "工具调用"}
          {presentation?.detail ? ` · ${presentation.detail}` : ""}
        </span>
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
        {tool.truncated && <small>内容已截断</small>}
      </div>
    </details>
  );
}
