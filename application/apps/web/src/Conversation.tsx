import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { SafeMarkdown } from "./SafeMarkdown.js";
import { inputIntents } from "../../../packages/core/src/input-intent.js";
import type { Workspace } from "../../../packages/core/src/model.js";
import { discussionId } from "../../../packages/core/src/model.js";
import { SentTextQuotes } from "./TextQuotes.js";
import { quoteSource, locateTextQuote } from "./text-quote-dom.js";
import {
  quotedInputText,
  type TextQuote,
} from "../../../packages/core/src/text-quotes.js";
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
import {
  Wrench,
  ChevronRight,
  Copy,
  Check,
  Square,
  Film,
  RotateCcw,
  LoaderCircle,
  Activity,
  Clock3,
  CircleHelp,
  MessageSquarePlus,
  Pause,
} from "lucide-react";
import {
  scriptOutputKey,
  type ScriptOutput,
} from "../../../packages/core/src/script-delivery.js";
import { scriptKindLabels } from "../../../packages/core/src/script-studio.js";
import type { WorkspaceClient } from "./client.js";
import { ObjectIcon } from "./ArtifactEditor.js";
import { AttachmentPreview } from "./AttachmentPreview.js";
import { conversationDate } from "./conversation-presentation.js";
import { ApprovalCard } from "./ApprovalCard.js";
import { executionPresentation } from "./execution-presentation.js";
import { executionActivityStatus } from "./execution-activity.js";
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
  onFocusComposer,
  onOpenQuote,
  quoteReveal,
  onQuoteUnavailable,
  hasEarlierHistory,
  onLoadEarlierHistory,
  notice,
}: {
  notice?: ReactNode;
  onOpenQuote?: (quote: TextQuote) => void;
  quoteReveal?: { quote: TextQuote; token: string } | null;
  onQuoteUnavailable?: (reason?: string) => void;
  hasEarlierHistory?: boolean;
  onLoadEarlierHistory?: () => Promise<void>;
  onFocusComposer?: () => void;
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
  const inputById = new Map(inputs.map((input) => [input.id, input]));
  const stateInputById = new Map(
    state.inputs.map((input) => [input.id, input]),
  );
  const deliveryByInputId = new Map(
    runtime.deliveries.map((delivery) => [delivery.inputId, delivery]),
  );
  const [stopStates, setStopStates] = useState<
    Record<string, { pending: boolean; error: string }>
  >({});
  async function stopResponse(inputId: string) {
    // The stop button is disabled, then removed when cancellation completes.
    // Hand focus to a stable control synchronously, before either change, so
    // stopping is not mistaken for leaving the unpinned exchange. Never focus
    // from the async reply: the user may have navigated elsewhere by then.
    onFocusComposer?.();
    if (!onFocusComposer) scroller.current?.focus({ preventScroll: true });
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
  const prependPosition = useRef<{
    key: string;
    height: number;
    top: number;
  } | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierError, setEarlierError] = useState("");
  async function loadEarlier() {
    if (!onLoadEarlierHistory || loadingEarlier) return;
    const el = scroller.current;
    if (el)
      prependPosition.current = {
        key: positionKey,
        height: el.scrollHeight,
        top: el.scrollTop,
      };
    setLoadingEarlier(true);
    setEarlierError("");
    try {
      await onLoadEarlierHistory();
    } catch (error) {
      prependPosition.current = null;
      setEarlierError(
        error instanceof Error ? error.message : "旧消息暂时无法读取，请重试。",
      );
    } finally {
      setLoadingEarlier(false);
    }
  }
  const revealedQuote = useRef<string | null>(null);
  const loadingQuote = useRef<string | null>(null);
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
        onFocusComposer?.();
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
      (m) => !focused || (!!m.inputId && inputById.has(m.inputId)),
    ),
  );
  // The initiating input owns cancellation, even without a current output.
  // Background execution branches retain their separate inspector controls.
  const responseControls = new Map(
    groups.flatMap((group) => {
      const delivery = group.inputId
        ? deliveryByInputId.get(group.inputId)
        : undefined;
      if (
        !delivery ||
        !["queued", "sending", "running"].includes(delivery.state) ||
        !(delivery.cancellable || delivery.cancelRequested)
      )
        return [];
      return [[group.id, delivery] as const];
    }),
  );
  const items = conversationTimeline(
    groups.flatMap((group) => [
      ...(group.inputId && inputById.has(group.inputId)
        ? [inputById.get(group.inputId)!]
        : []
      ).map((input) => ({
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
    inputById.has(o.inputId),
  );
  const scriptOutputs = (client.boot?.scriptOutputs ?? []).filter((o) =>
    inputById.has(o.inputId),
  );
  // Presentation only, owned by the actual input. Waiting is not a reply,
  // publication or unread receipt, and does not depend on cancellation support.
  const waitingResponses = new Map(
    groups.flatMap((group) => {
      const delivery = group.inputId
        ? deliveryByInputId.get(group.inputId)
        : undefined;
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
      id: scriptOutputKey(o),
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
  useLayoutEffect(() => {
    const el = scroller.current;
    const old = prependPosition.current;
    if (!el || !old || old.key !== positionKey || loadingEarlier) return;
    following.current = false;
    el.scrollTop = old.top + el.scrollHeight - old.height;
    positions.set(positionKey, {
      top: el.scrollTop,
      following: false,
      revealed: revealed.current,
    });
    setAwayFromLatest(true);
    prependPosition.current = null;
  }, [contentVersion, loadingEarlier, positionKey]);
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
  useLayoutEffect(() => {
    if (!quoteReveal || revealedQuote.current === quoteReveal.token) return;
    const quote = quoteReveal.quote.source;
    if (quote.kind !== "message") return;
    const el = scroller.current;
    const message = el?.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(quote.messageId)}"]`,
    );
    if (!message) {
      if (
        focused &&
        (allInputs.some((item) => item.id === quote.messageId) ||
          messages.some((item) => item.id === quote.messageId))
      ) {
        setAllHistory(true);
      } else if (
        hasEarlierHistory &&
        loadingQuote.current !== quoteReveal.token
      ) {
        loadingQuote.current = quoteReveal.token;
        void client.loadHistoryUntil(quote.messageId).then(
          (found) => {
            if (!found) {
              revealedQuote.current = quoteReveal.token;
              onQuoteUnavailable?.();
            }
          },
          (error: unknown) => {
            revealedQuote.current = quoteReveal.token;
            onQuoteUnavailable?.(
              error instanceof Error ? error.message : undefined,
            );
          },
        );
      } else {
        if (loadingQuote.current !== quoteReveal.token) {
          revealedQuote.current = quoteReveal.token;
          onQuoteUnavailable?.();
        }
      }
      return;
    }
    revealedQuote.current = quoteReveal.token;
    // A source jump is explicit navigation, not a request to follow new output.
    following.current = false;
    el!.scrollTop +=
      message.getBoundingClientRect().top -
      el!.getBoundingClientRect().top -
      24;
    setAwayFromLatest(true);
    positions.set(positionKey, {
      top: el!.scrollTop,
      following: false,
      revealed: revealed.current,
    });
    const range = locateTextQuote(quoteReveal.quote);
    if (range) {
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    }
    message.setAttribute("data-quote-revealed", "true");
    const timeout = window.setTimeout(
      () => message.removeAttribute("data-quote-revealed"),
      2200,
    );
    return () => {
      clearTimeout(timeout);
      message.removeAttribute("data-quote-revealed");
    };
  }, [quoteReveal, focused, contentVersion, hasEarlierHistory]);
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
      {notice}
      {hasEarlierHistory && onLoadEarlierHistory && (
        <button
          type="button"
          className="conversation-load-older"
          disabled={loadingEarlier}
          onClick={() => void loadEarlier()}
        >
          {loadingEarlier ? "正在读取…" : "查看更早消息"}
        </button>
      )}
      {earlierError && (
        <p className="conversation-load-error" role="alert">
          {earlierError}
        </p>
      )}
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
              const replySourceText = reply?.inputId
                ? inputById
                    .get(reply.inputId)
                    ?.body.slice(0, 50)
                    .replace(/\s+/g, " ")
                    .trim() || "原消息"
                : "";
              const startsTurn =
                !!previous &&
                !dateDivider &&
                (!inputId || inputId !== previousInputId);
              if (scriptOutput) {
                const catalogEntry = client.contentCatalog.find(
                  (entry) =>
                    entry.appId === "morphz.script-studio" &&
                    entry.appObjectId === scriptOutput.productionId &&
                    entry.availability === "available",
                );
                const label =
                  scriptOutput.kind === "production"
                    ? "剧本"
                    : scriptOutput.kind === "candidate"
                      ? `候选稿 · ${scriptOutput.candidateStatus === "accepted" ? "已采纳" : scriptOutput.candidateStatus === "rejected" ? "已拒绝" : "待决定"}`
                      : scriptOutput.kind === "review"
                        ? "审查意见"
                        : `${scriptKindLabels[scriptOutput.itemKind!]}${scriptOutput.isEmpty ? " · 空白条目" : ""}`;
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
                        disabled={!catalogEntry || !onOpenScript}
                        aria-label={`打开${scriptOutput.kind === "production" ? "剧本" : "剧本结果"}：${scriptOutput.title}`}
                        onClick={() => onOpenScript?.(scriptOutput)}
                      >
                        <Film aria-hidden />
                        <span className="delivery-object-info">
                          <small>{label}</small>
                          <span>{scriptOutput.title}</span>
                          {scriptOutput.itemId && (
                            <small>{scriptOutput.productionTitle}</small>
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
                const catalogEntry = client.contentCatalog.find(
                  (entry) => entry.id === output.artifactId,
                );
                const version = artifact?.versions.find(
                  (v) => v.revision === output.revision,
                );
                const title = client.contentVersionTitle(
                  output.artifactId,
                  output.revision,
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
                        disabled={!version && !catalogEntry}
                        aria-label={"打开交付：" + (title ?? "交付内容")}
                        onClick={() =>
                          onOpen(output.artifactId, output.revision)
                        }
                      >
                        {(artifact || catalogEntry) && (
                          <ObjectIcon
                            kind={
                              (artifact?.content.kind ??
                                catalogEntry!.kind) as Parameters<
                                typeof ObjectIcon
                              >[0]["kind"]
                            }
                          />
                        )}
                        <span className="delivery-object-info">
                          <small>交付内容</small>
                          <span>{title ?? "交付内容"}</span>
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
              const localInput =
                !!item && client.boot!.localSavedInputIds.includes(item.id);
              const submission = item
                ? client.boot!.localInputSubmissions[item.id]
                : undefined;
              const textSource = quoteSource({
                kind: "message",
                messageId: id,
                inputId: item?.id ?? reply?.inputId ?? null,
                projectId: (item ?? reply)!.projectId,
                conversationId: discussionId((item ?? reply)!),
                title: item
                  ? item.author.actantId === client.boot?.actantId
                    ? "我"
                    : actorName(state, item.author.actantId)
                  : "Morphz",
                createdAt: (item ?? reply)!.createdAt,
              });
              const activeBranches =
                item && client.online
                  ? activeExecutionThreads(runtime).filter(
                      (t) => t.inputId === item.id,
                    )
                  : [];
              const activeBranch = activeBranches.length > 0;
              const branchStatuses = activeBranches.map((thread) =>
                executionActivityStatus(thread, true),
              );
              const workStatus =
                branchStatuses.find((s) => s.kind === "running") ??
                branchStatuses.find((s) => s.kind === "unknown") ??
                branchStatuses.find((s) => s.kind === "paused") ??
                branchStatuses[0];
              const WorkStatusIcon =
                workStatus?.kind === "running"
                  ? Activity
                  : workStatus?.kind === "paused"
                    ? Pause
                    : workStatus?.kind === "waiting"
                      ? Clock3
                      : CircleHelp;
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
                : submission
                  ? ""
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
                  compact
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
                    data-submission-state={submission?.state}
                    data-message-id={id}
                    data-starts-turn={startsTurn || undefined}
                    data-background-execution={activeBranch || undefined}
                    data-execution-inspectable={
                      (activeBranch && !!onInspect) || undefined
                    }
                    data-supplement-target={targets.length > 0 || undefined}
                    onClick={
                      activeBranch && item && onInspect
                        ? (event) => {
                            // The card is a shortcut, not a wrapper button:
                            // nested references/actions and selecting original
                            // message text keep their own interaction.
                            if (
                              document.getSelection()?.isCollapsed === false ||
                              (event.target instanceof Element &&
                                event.target.closest(
                                  "button, a, input, textarea, select, summary, [role=button], [contenteditable=true], [data-quote-ui], [data-quote-ignore]",
                                ))
                            )
                              return;
                            onInspect(item.id);
                          }
                        : undefined
                    }
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
                        {stateInputById
                          .get(item.continuation!.inputId)
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
                          className="message-source response-source"
                          aria-label={"回复：" + replySourceText}
                          title={replySourceText}
                          onClick={() => onInspect(reply.inputId!)}
                        >
                          <span>{replySourceText}</span>
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
                    {!!item?.textQuotes?.length && onOpenQuote && (
                      <SentTextQuotes
                        quotes={item.textQuotes}
                        onOpen={onOpenQuote}
                      />
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
                        {client.contentVersionTitle(
                          item.artifactId,
                          item.artifactRevision ?? undefined,
                        ) ?? "关联对象"}
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
                    {item ? (
                      <>
                        {!!item.attachments?.length && (
                          <div className="message-attachments">
                            {item.attachments.map((a, index) => (
                              <AttachmentPreview
                                key={a.assetId + index}
                                attachment={a}
                                source={
                                  localInput
                                    ? undefined
                                    : {
                                        projectId: item.projectId,
                                        conversationId: discussionId(item),
                                        inputId: item.id,
                                      }
                                }
                              />
                            ))}
                          </div>
                        )}
                        {item.body && (
                          <p
                            data-quotable={!localInput || undefined}
                            {...textSource}
                          >
                            {item.body}
                          </p>
                        )}
                      </>
                    ) : (
                      <div
                        className="reply-content"
                        {...textSource}
                        data-quotable={
                          reply?.kind === "reply" || reply?.kind === "error"
                            ? true
                            : undefined
                        }
                      >
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
                              catalog={client.contentCatalog}
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
                    {reply?.kind !== "tool" && (
                      <div
                        className="message-meta"
                        data-work-actions={
                          Boolean(
                            item &&
                            ((onSupplement && targets.length > 0) ||
                              (activeBranch && onInspect)),
                          ) || undefined
                        }
                      >
                        <MessageActions
                          createdAt={createdAt}
                          control={item ? stopControl : undefined}
                          text={
                            item
                              ? quotedInputText(item.body, item.textQuotes)
                              : reply!.text
                          }
                        />
                        {item &&
                          ((onSupplement && targets.length > 0) ||
                            (activeBranch && onInspect)) && (
                            <span className="message-work-actions">
                              {onSupplement && targets.length > 0 && (
                                <button
                                  type="button"
                                  className="message-execution-link message-supplement"
                                  aria-label={
                                    targets.length === 1
                                      ? "补充要求"
                                      : "选择补充分支"
                                  }
                                  title={
                                    targets.length === 1
                                      ? "给这项后台工作追加要求"
                                      : "选择要补充的执行分支"
                                  }
                                  onClick={() =>
                                    targets.length === 1
                                      ? onSupplement(targets[0]!.continuation!)
                                      : onInspect?.(item.id)
                                  }
                                >
                                  <MessageSquarePlus
                                    size={14}
                                    aria-hidden="true"
                                  />
                                  <span>补充</span>
                                  {targets.length > 1 && (
                                    <ChevronRight
                                      size={12}
                                      aria-hidden="true"
                                    />
                                  )}
                                </button>
                              )}
                              {activeBranch && onInspect && workStatus && (
                                <button
                                  type="button"
                                  className="message-execution-link message-work-status"
                                  data-status={workStatus.kind}
                                  aria-label={
                                    workStatus.kind === "running"
                                      ? "后台执行中"
                                      : "后台工作" + workStatus.label
                                  }
                                  title={
                                    workStatus.label +
                                    " · 查看这条消息的执行记录"
                                  }
                                  onClick={() => onInspect(item.id)}
                                >
                                  <WorkStatusIcon
                                    size={14}
                                    aria-hidden="true"
                                  />
                                  <span>{workStatus.label}</span>
                                </button>
                              )}
                            </span>
                          )}
                        {reply?.incomplete && <span>未完成的回复</span>}
                        {reply?.truncated && <span>仅保留部分内容</span>}
                        {item &&
                          item.author.actantId !== client.boot?.actantId && (
                            <span>
                              {actorName(state, item.author.actantId)}
                            </span>
                          )}
                        {item && status && <span>{status}</span>}
                      </div>
                    )}
                    {delivery?.error && (
                      <div className="delivery-error" role="alert">
                        {delivery.error}
                      </div>
                    )}
                    {item && submission?.state === "sending" && (
                      <span
                        className="message-submission"
                        role="status"
                        aria-label="正在发送消息"
                      >
                        <LoaderCircle size={16} aria-hidden="true" />
                      </span>
                    )}
                    {item && submission?.state === "failed" && (
                      <button
                        className="message-submission retry-submission"
                        aria-label="重新发送消息"
                        title={`发送失败：${submission.error ?? "请重试"}`}
                        disabled={!runtime.configured || !client.online}
                        onClick={() => void onRetry(item.id)}
                      >
                        <RotateCcw size={16} aria-hidden="true" />
                      </button>
                    )}
                    {item &&
                      !submission &&
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
  compact = false,
}: {
  delivery: ConversationRuntime["deliveries"][number];
  stopping: boolean;
  error: string;
  onStop: (inputId: string) => Promise<void>;
  available?: boolean;
  compact?: boolean;
}) {
  const pending = stopping || delivery.cancelRequested;
  const label = pending ? "已请求停止，等待确认" : "停止这次处理";
  const Container = compact ? "span" : "div";
  return (
    <Container
      className={`response-controls${compact ? " message-stop-controls" : ""}`}
      data-response-input-id={delivery.inputId}
      data-stop-pending={pending || undefined}
    >
      <button
        className="stop-response"
        aria-label={label}
        title={
          error || (pending ? label : "停止这次处理；已发生的操作不会撤销。")
        }
        disabled={pending || !available}
        onClick={() => {
          if (!pending) void onStop(delivery.inputId);
        }}
      >
        <Square size={12} fill="currentColor" aria-hidden="true" />
        {!compact && <span>停止</span>}
      </button>
      {error && (
        <span className="delivery-error" role="alert">
          {error}
        </span>
      )}
    </Container>
  );
}

function MessageActions({
  createdAt,
  text,
  control,
}: {
  createdAt: string;
  text: string;
  control?: ReactNode;
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
        {control}
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
