import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { SafeMarkdown } from "./SafeMarkdown.js";
import { RuntimeMessageError } from "./RuntimeMessageError.js";
import { presentRuntimeErrors } from "./runtime-error-presentation.js";
import { EvaluationMessage } from "./EvaluationMessage.js";
import { evaluationDisplayText } from "../../../packages/core/src/evaluation-result.js";
import { copyText as copyMessage } from "./clipboard-text.js";
import { Tooltip } from "./ui/Tooltip.js";
import {
  MessageShareDialog,
  type MessageShareContent,
} from "./MessageShareDialog.js";
import { ResponseWaiting } from "./ResponseWaiting.js";
import { ConversationSearch } from "./ConversationSearch.js";
import { inputIntents } from "../../../packages/core/src/input-intent.js";
import type { Workspace } from "../../../packages/core/src/model.js";
import { discussionId } from "../../../packages/core/src/model.js";
import { SentTextQuotes } from "./TextQuotes.js";
import { quoteSource } from "./text-quote-dom.js";
import {
  quotedInputText,
  type TextQuote,
  type TextQuoteSource,
} from "../../../packages/core/src/text-quotes.js";
import {
  conversationGroups,
  conversationTimeline,
  type ConversationRuntime,
} from "../../../packages/core/src/conversation.js";
import { actorName } from "./client.js";
import {
  hasUnreadReplies,
  focusedInputs,
  projectConversationReadScope,
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
  Clock3,
  CircleHelp,
  MessageSquarePlus,
  Pause,
  Link2,
  Search,
  Image as ImageIcon,
} from "lucide-react";
import {
  scriptOutputKey,
  type ScriptOutput,
} from "../../../packages/core/src/script-delivery.js";
import { scriptKindLabels } from "../../../packages/core/src/script-studio.js";
import type { WorkspaceClient } from "./client.js";
import { ObjectIcon, kindLabel } from "./ui/ObjectIcon.js";
import { AttachmentPreview } from "./AttachmentPreview.js";
import {
  conversationDate,
  isPendingResponse,
  responseAnswered,
  messageSourceSummary,
  responseWaitingPresentation,
} from "./conversation-presentation.js";
import { ApprovalCard } from "./ApprovalCard.js";
import { liveToolPresentation } from "./execution-presentation.js";
import { inputExecutionActivityPresentation } from "./execution-activity.js";
import { inputExecutionRecordStatus } from "./message-execution-record.js";
import { MessageActivityLink } from "./MessageActivityLink.js";
import type { InputContinuation } from "../../../packages/core/src/continuation.js";
import type { CognitiveAppObjectLocator } from "../../../packages/core/src/cognitive-app-object-locator.js";
import { cognitiveWorkSurfaceKey } from "./host/work-surface.js";

import {
  useConversationViewportState,
  useConversationViewportCommit,
  useConversationMessageReveal,
  type ExchangePosition,
} from "./features/exchange/useConversationViewport.js";

export type { ExchangePosition } from "./features/exchange/useConversationViewport.js";

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
  onResend,
  client,
  onOpen,
  onOpenScript,
  positions,
  revealInputId,
  onInspect,
  onSupplement,
  focusedArtifactId,
  focusedApplicationId,
  focusedCognitiveObject,
  onOpenCognitiveObject,
  toolbarTarget,
  searchToolbarTarget,
  onSearchEngage,
  onFocusComposer,
  onOpenQuote,
  quoteReveal,
  onQuoteUnavailable,
  hasEarlierHistory,
  onLoadEarlierHistory,
  searchProjectId,
  notice,
}: {
  searchProjectId?: string;
  notice?: ReactNode;
  onOpenQuote?: (quote: TextQuote) => void;
  quoteReveal?: { quote: TextQuote; token: string } | null;
  onQuoteUnavailable?: (reason?: string) => void;
  hasEarlierHistory?: boolean;
  onLoadEarlierHistory?: () => Promise<void>;
  onFocusComposer?: () => void;
  toolbarTarget?: HTMLElement | null;
  searchToolbarTarget?: HTMLElement | null;
  onSearchEngage?: () => void;
  focusedArtifactId?: string;
  focusedApplicationId?: string;
  focusedCognitiveObject?: CognitiveAppObjectLocator;
  onOpenCognitiveObject?: (locator: CognitiveAppObjectLocator) => void;
  inputs: Workspace["inputs"];
  state: Workspace;
  runtime: ConversationRuntime;
  messages: LiveMessage[];
  streamConnected: boolean;
  seenReplies: ReadReplies;
  onRead: (receipts: ReplyReceipt[]) => void;
  conversationId: string;
  onRetry: (id: string) => Promise<void>;
  onResend?: (id: string) => Promise<void>;
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
  const [allHistory, setAllHistory] = useState(true);
  const resending = useRef(new Set<string>());
  const [resendStates, setResendStates] = useState<
    Record<string, { pending: boolean; error?: string }>
  >({});
  async function resend(id: string) {
    if (!onResend || resending.current.has(id)) return;
    resending.current.add(id);
    setResendStates((old) => ({ ...old, [id]: { pending: true } }));
    try {
      await onResend(id);
      setResendStates((old) => ({ ...old, [id]: { pending: false } }));
    } catch (error) {
      setResendStates((old) => ({
        ...old,
        [id]: {
          pending: false,
          error:
            error instanceof Error
              ? error.message
              : "重新发送失败，原消息仍保留。",
        },
      }));
    } finally {
      resending.current.delete(id);
    }
  }
  const [searchOpen, setSearchOpen] = useState(false);
  const searchWasOpen = useRef(false);
  useLayoutEffect(() => {
    // Native dialog cleanup restores focus during React's commit, when the
    // trigger's synthetic onFocus cannot run. Closing search is not an intent
    // to hide the exchange; cancel that stale leave after focus is restored.
    if (searchWasOpen.current && !searchOpen) onSearchEngage?.();
    searchWasOpen.current = searchOpen;
  }, [searchOpen, onSearchEngage]);
  const [messageReveal, setMessageReveal] = useState<{
    messageId: string;
    token: string;
  } | null>(null);
  const revealMessage = (messageId: string) =>
    setMessageReveal({ messageId, token: crypto.randomUUID() });
  useEffect(() => setMessageReveal(null), [quoteReveal?.token]);
  const cognitiveFocusKey = focusedCognitiveObject
    ? cognitiveWorkSurfaceKey({
        kind: "original",
        locator: focusedCognitiveObject,
      })
    : undefined;
  useEffect(
    () => setAllHistory(true),
    [focusedArtifactId, focusedApplicationId, cognitiveFocusKey],
  );
  const focused =
    !!(focusedArtifactId || focusedApplicationId || focusedCognitiveObject) &&
    !allHistory;
  // The choice is useful only when it changes readable history. Keep this
  // independent of the selected choice: selecting all must not remove its
  // return path. Ownership remains the same as the existing read projector.
  const objectInputIds = new Set(
    focusedInputs(allInputs, client.boot!.outputs, {
      artifactId: focusedArtifactId,
      applicationId: focusedApplicationId,
      cognitiveObject: focusedCognitiveObject,
    }).map((input) => input.id),
  );
  const hasOtherHistory =
    !!(focusedArtifactId || focusedApplicationId || focusedCognitiveObject) &&
    (allInputs.some((input) => !objectInputIds.has(input.id)) ||
      messages.some(
        (message) =>
          (!message.inputId || !objectInputIds.has(message.inputId)) &&
          (!onInspect || message.kind !== "tool") &&
          (message.kind === "tool" || message.text.trim()),
      ));
  const readScope = projectConversationReadScope({
    inputs: allInputs,
    messages,
    outputs: client.boot!.outputs,
    scriptOutputs: client.boot?.scriptOutputs ?? [],
    scope: {
      focus: focused
        ? {
            artifactId: focusedArtifactId,
            applicationId: focusedApplicationId,
            cognitiveObject: focusedCognitiveObject,
          }
        : {},
      messageArray: "filter-always",
    },
  });
  const { inputs } = readScope;
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
  const viewport = useConversationViewportState({
    conversationId,
    focused,
    focusedArtifactId,
    focusedApplicationId,
    focusedCognitiveKey: cognitiveFocusKey,
    positions,
    revealInputId,
  });
  const {
    scroller,
    latestButton,
    loadingEarlier,
    earlierError,
    awayFromLatest,
  } = viewport;
  const groups = conversationGroups(inputs, readScope.messages);
  const publishedErrorInputs = new Set(
    readScope.messages
      .filter(
        (message) =>
          message.kind === "error" &&
          message.failure?.phase !== "diagnostic" &&
          message.inputId,
      )
      .map((message) => message.inputId),
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
      ...presentRuntimeErrors(group.messages)
        .filter(
          (m) =>
            m.kind !== "evaluation" ||
            (!m.evaluation?.consumed && evaluationDisplayText(m).trim()),
        )
        .filter((m) => !onInspect || m.kind !== "tool")
        .filter((m) => m.kind === "tool" || m.text.trim())
        .map((reply) => ({
          id: reply.id,
          createdAt: reply.createdAt,
          input: null,
          reply,
        })),
    ]),
  );
  const outputs = readScope.outputs;
  const scriptOutputs = readScope.scriptOutputs;
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
        group.messages.some(
          (message) =>
            message.kind === "evaluation" &&
            message.streaming &&
            !message.evaluation?.consumed &&
            evaluationDisplayText(message).trim(),
        ) ||
        !isPendingResponse({
          configured: runtime.configured,
          delivery,
          answered:
            responseAnswered(group.messages, group.inputId!) ||
            outputs.some((o) => o.inputId === group.inputId) ||
            scriptOutputs.some((o) => o.inputId === group.inputId),
          approvalPending:
            runtime.attention?.approvals.some(
              (a) => a.scope.inputId === group.inputId,
            ) ?? false,
        })
      )
        return [];
      const connected = client.online && runtime.connected;
      const presentation = responseWaitingPresentation(
        delivery,
        group.messages,
        connected,
        stopStates[delivery.inputId]?.pending,
        runtime.activity,
      );
      return [[group.id, presentation] as const];
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
  // Published progress can precede more physical work. The exact execution
  // snapshot, not prose or a finished stream, owns that continuation cue.
  const continuingResponses = new Map<
    string,
    {
      inputId: string;
      createdAt: string;
      label: string;
      connected: boolean;
    }
  >();
  for (const group of groups) {
    const input = inputs.find((input) => input.id === group.inputId);
    if (!input) continue;
    const latest = timeline
      .filter(
        (entry) =>
          entry.reply?.inputId === input.id &&
          (entry.reply.kind === "reply" ||
            entry.reply.kind === "error" ||
            entry.reply.kind === "evaluation") &&
          entry.reply.text.trim(),
      )
      .at(-1);
    if (
      !latest?.reply ||
      latest.reply.kind === "error" ||
      latest.reply.streaming
    )
      continue;
    const waiting = waitingResponses.get(group.id);
    if (waiting) {
      waitingResponses.delete(group.id);
      continuingResponses.set(latest.id, {
        inputId: input.id,
        createdAt: input.createdAt,
        ...waiting,
        ...(latest.reply.kind === "evaluation" && waiting.label === "等待回复…"
          ? { label: "继续处理中…" }
          : {}),
      });
      continue;
    }
    const { activeBranch, workStatus } = inputExecutionActivityPresentation(
      runtime,
      input,
      client.online,
    );
    if (activeBranch && workStatus?.kind === "running")
      continuingResponses.set(latest.id, {
        inputId: input.id,
        createdAt: input.createdAt,
        label: "继续处理中…",
        connected: true,
      });
  }
  const receipts = replyReceipts(
    items.flatMap((item) =>
      item.reply ? (item.reply.representedMessages ?? [item.reply]) : [],
    ),
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
      .join("|") +
    JSON.stringify([[...waitingResponses], [...continuingResponses]]);
  const { loadEarlier, onScroll, returnLatest } = useConversationViewportCommit(
    viewport,
    {
      contentVersion,
      readVersion,
      receipts,
      onRead,
      onFocusComposer,
      onLoadEarlierHistory,
      quoteReveal,
      onQuoteUnavailable,
      focused,
      allInputs,
      messages,
      hasEarlierHistory,
      setAllHistory,
      client,
    },
  );
  useConversationMessageReveal(viewport, {
    request: messageReveal,
    quoteToken: quoteReveal?.token,
    contentVersion,
    focused,
    allInputs,
    messages,
    hasEarlierHistory,
    setAllHistory,
    client,
    onUnavailable: onQuoteUnavailable,
  });
  return (
    <section
      className="conversation"
      aria-label="当前对话"
      tabIndex={-1}
      ref={scroller}
      onScroll={onScroll}
    >
      {searchOpen && (
        <ConversationSearch
          client={client}
          projectId={searchProjectId ?? client.boot!.workspace.id}
          conversationId={conversationId}
          onClose={() => setSearchOpen(false)}
          onReveal={revealMessage}
        />
      )}
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
      {toolbarTarget &&
        hasOtherHistory &&
        createPortal(
          <div className="conversation-reading-tools">
            <div
              className="conversation-scope"
              role="group"
              aria-label="交流范围"
            >
              <button
                type="button"
                aria-pressed={!allHistory}
                onClick={() => setAllHistory(false)}
              >
                {focusedArtifactId || focusedCognitiveObject
                  ? "当前作品"
                  : "当前应用"}
              </button>
              <button
                type="button"
                aria-pressed={allHistory}
                onClick={() => setAllHistory(true)}
              >
                全部交流
              </button>
            </div>
          </div>,
          toolbarTarget,
        )}
      {searchToolbarTarget &&
        (timeline.length > 0 || hasEarlierHistory) &&
        createPortal(
          <Tooltip label="查找对话">
            <button
              type="button"
              className="icon-button conversation-search-trigger"
              aria-label="查找对话"
              onFocus={onSearchEngage}
              onClick={() => {
                onSearchEngage?.();
                setSearchOpen(true);
              }}
            >
              <Search size={16} />
            </button>
          </Tooltip>,
          searchToolbarTarget,
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
                ? (messageSourceSummary(stateInputById.get(reply.inputId)) ??
                  reply.inputPreview ??
                  "来源内容暂不可用")
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
              const messageSource: TextQuoteSource = {
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
              };
              const textSource = quoteSource(
                messageSource,
                item ? 0 : undefined,
              );
              const linkedArtifact = item?.artifactId
                ? state.artifacts.find(
                    (artifact) => artifact.id === item.artifactId,
                  )
                : undefined;
              const linkedCatalog = item?.artifactId
                ? client.contentCatalog.find(
                    (entry) => entry.id === item.artifactId,
                  )
                : undefined;
              const catalogKind = linkedCatalog?.kind;
              const linkedKind =
                linkedArtifact?.content.kind ??
                (catalogKind && Object.hasOwn(kindLabel, catalogKind)
                  ? (catalogKind as keyof typeof kindLabel)
                  : undefined);
              const linkedTitle = item?.artifactId
                ? (client.contentVersionTitle(
                    item.artifactId,
                    item.artifactRevision ?? undefined,
                  ) ?? "关联资源")
                : "";
              const linkedVersion =
                item?.artifactRevision != null
                  ? `v${item.artifactRevision}`
                  : "";
              const linkedLabel = `${linkedTitle}${item?.reading ? ` · ${item.reading.chapter}` : ""}${linkedVersion ? ` · ${linkedVersion}` : ""}`;
              const originalTitle = item?.cognitiveObject
                ? (client.contentCatalog.find(
                    (entry) => entry.id === item.cognitiveObject!.contentId,
                  )?.title ?? "关联原件")
                : "";
              const { activeBranch, workStatus } =
                inputExecutionActivityPresentation(
                  runtime,
                  item,
                  item && client.online,
                );
              const recordStatus = item
                ? inputExecutionRecordStatus(runtime, item, client.online)
                : undefined;
              const inspectable = !!recordStatus && !!onInspect;
              const WorkStatusIcon =
                workStatus?.kind === "paused"
                  ? Pause
                  : workStatus?.kind === "waiting"
                    ? Clock3
                    : CircleHelp;
              const showWorkStatus =
                activeBranch &&
                onInspect &&
                workStatus &&
                workStatus.kind !== "running";
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
                        failed:
                          delivery.error ||
                          publishedErrorInputs.has(item?.id ?? "")
                            ? ""
                            : "执行失败",
                        cancelled: "已取消",
                        merged: "并入后续处理",
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
                    data-execution-inspectable={inspectable || undefined}
                    data-execution-record={
                      (!activeBranch && inspectable && recordStatus?.kind) ||
                      undefined
                    }
                    data-supplement-target={targets.length > 0 || undefined}
                    onClick={
                      inspectable && item && onInspect
                        ? (event) => {
                            // The card is a shortcut, not a wrapper button:
                            // nested references/actions and selecting original
                            // message text keep their own interaction.
                            if (
                              document.getSelection()?.isCollapsed === false ||
                              (event.target instanceof Element &&
                                event.target.closest(
                                  "button, a, input, textarea, select, summary, [role=button], [contenteditable=true], [data-quote-ui], [data-quote-ignore], .sent-text-quotes",
                                ))
                            )
                              return;
                            onInspect(item.id);
                          }
                        : undefined
                    }
                    aria-description={
                      activeBranch
                        ? "这条消息的后台执行仍在进行"
                        : recordStatus
                          ? `这条消息有关联执行活动：${recordStatus.label}`
                          : undefined
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
                      (timeline[index - 1]?.input?.id ??
                        timeline[index - 1]?.reply?.inputId ??
                        timeline[index - 1]?.output?.inputId) !==
                        reply.inputId && (
                        <button
                          className="message-source response-source"
                          aria-label={"回复：" + replySourceText}
                          title={replySourceText}
                          onClick={() => revealMessage(reply.inputId!)}
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
                        message={{ source: messageSource, body: item.body }}
                      />
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
                        {(item.artifactId ||
                          (item.cognitiveObject && onOpenCognitiveObject) ||
                          item.localFile) && (
                          <div
                            className="message-resources"
                            role="group"
                            aria-label="关联资源"
                            data-quote-ignore="true"
                          >
                            {item.artifactId && (
                              <Tooltip
                                label={`打开${linkedKind ? kindLabel[linkedKind] : "资源"}：${linkedLabel}`}
                              >
                                <button
                                  className="message-object-link"
                                  aria-label={`打开关联资源：${linkedLabel}`}
                                  onClick={() =>
                                    onOpen(
                                      item.artifactId!,
                                      item.artifactRevision ?? undefined,
                                      undefined,
                                      item.reading?.location,
                                    )
                                  }
                                >
                                  <span
                                    className="message-resource-icon"
                                    aria-hidden
                                  >
                                    {linkedKind ? (
                                      <ObjectIcon kind={linkedKind} />
                                    ) : (
                                      <Link2 />
                                    )}
                                  </span>
                                  <span className="message-resource-title">
                                    {linkedTitle}
                                  </span>
                                  {item.reading && (
                                    <span className="message-resource-location">
                                      {item.reading.chapter}
                                    </span>
                                  )}
                                  {linkedVersion && (
                                    <small className="message-resource-version">
                                      {linkedVersion}
                                    </small>
                                  )}
                                </button>
                              </Tooltip>
                            )}
                            {item.cognitiveObject && onOpenCognitiveObject && (
                              <Tooltip
                                label={`打开原件：${originalTitle} · ${item.cognitiveObject.object.versionRef}`}
                              >
                                <button
                                  className="message-object-link"
                                  aria-label={`打开关联原件：${originalTitle} · ${item.cognitiveObject.object.versionRef}`}
                                  onClick={() =>
                                    onOpenCognitiveObject(item.cognitiveObject!)
                                  }
                                >
                                  <span
                                    className="message-resource-icon"
                                    aria-hidden
                                  >
                                    <Link2 />
                                  </span>
                                  <span className="message-resource-title">
                                    {originalTitle}
                                  </span>
                                  <small className="message-resource-version">
                                    {item.cognitiveObject.object.versionRef}
                                  </small>
                                </button>
                              </Tooltip>
                            )}
                            {item.localFile && (
                              <small
                                className="message-local-file"
                                title="本机原文件引用，不是导入副本；读取时校验版本和授权。"
                              >
                                原文件：{item.localFile.name}
                              </small>
                            )}
                          </div>
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
                        {reply?.kind === "evaluation" ? (
                          <EvaluationMessage
                            message={reply}
                            streaming={!!(streamConnected && reply.streaming)}
                            renderText={(text) => (
                              <SafeMarkdown
                                state={state}
                                catalog={client.contentCatalog}
                                onOpen={onOpen}
                                streaming={
                                  !!(streamConnected && reply.streaming)
                                }
                              >
                                {text}
                              </SafeMarkdown>
                            )}
                          />
                        ) : reply?.kind === "error" && reply.failure ? (
                          <RuntimeMessageError message={reply} />
                        ) : reply?.tool ? (
                          <ToolMessage message={reply} state={state} />
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
                    {item && inspectable && recordStatus && (
                      <MessageActivityLink
                        status={recordStatus}
                        live={activeBranch}
                        onOpen={() => onInspect?.(item.id)}
                      />
                    )}
                    {reply?.kind !== "tool" && (
                      <div
                        className="message-meta"
                        data-work-actions={
                          Boolean(
                            item &&
                            ((onSupplement && targets.length > 0) ||
                              showWorkStatus),
                          ) || undefined
                        }
                      >
                        <MessageActions
                          createdAt={createdAt}
                          client={client}
                          share={{
                            text: item
                              ? item.body
                              : reply!.kind === "evaluation"
                                ? evaluationDisplayText(reply!)
                                : reply!.text,
                            author: item
                              ? item.author.actantId === client.boot?.actantId
                                ? "我"
                                : actorName(state, item.author.actantId)
                              : "Morphz",
                            createdAt,
                            format:
                              item || reply?.kind === "progress"
                                ? "plain"
                                : "markdown",
                            partial: !!(
                              reply?.streaming ||
                              reply?.incomplete ||
                              reply?.truncated
                            ),
                            quotes:
                              item?.textQuotes?.map(({ text, comment }) => ({
                                text,
                                comment,
                              })) ?? [],
                            attachments:
                              item?.attachments?.map(
                                (attachment) => attachment.name,
                              ) ?? [],
                            state,
                            catalog: client.contentCatalog,
                          }}
                          control={
                            item ? (
                              <>
                                {stopControl}
                                {onResend &&
                                  !submission &&
                                  delivery?.state === "failed" &&
                                  !delivery.retryable &&
                                  !item.continuation &&
                                  item.author.actantId ===
                                    client.boot?.actantId && (
                                    <Tooltip label="重新发送原消息">
                                      <button
                                        type="button"
                                        className="message-copy message-resend"
                                        aria-label="重新发送原消息"
                                        disabled={
                                          !runtime.connected ||
                                          !client.online ||
                                          resendStates[item.id]?.pending
                                        }
                                        onClick={() => void resend(item.id)}
                                      >
                                        {resendStates[item.id]?.pending ? (
                                          <LoaderCircle
                                            size={13}
                                            aria-hidden="true"
                                          />
                                        ) : (
                                          <RotateCcw
                                            size={13}
                                            aria-hidden="true"
                                          />
                                        )}
                                      </button>
                                    </Tooltip>
                                  )}
                              </>
                            ) : undefined
                          }
                          text={
                            item
                              ? quotedInputText(item.body, item.textQuotes)
                              : reply!.kind === "evaluation"
                                ? evaluationDisplayText(reply!)
                                : reply!.text
                          }
                        />
                        {item &&
                          ((onSupplement && targets.length > 0) ||
                            showWorkStatus) && (
                            <span className="message-work-actions">
                              {onSupplement && targets.length > 0 && (
                                <Tooltip
                                  label={
                                    targets.length === 1
                                      ? "补充要求"
                                      : "选择补充分支"
                                  }
                                >
                                  <button
                                    type="button"
                                    className="message-execution-link message-supplement"
                                    aria-label={
                                      targets.length === 1
                                        ? "补充要求"
                                        : "选择补充分支"
                                    }
                                    onClick={() =>
                                      targets.length === 1
                                        ? onSupplement(
                                            targets[0]!.continuation!,
                                          )
                                        : onInspect?.(item.id)
                                    }
                                  >
                                    <MessageSquarePlus
                                      size={14}
                                      aria-hidden="true"
                                    />
                                    {targets.length > 1 && (
                                      <ChevronRight
                                        size={12}
                                        aria-hidden="true"
                                      />
                                    )}
                                  </button>
                                </Tooltip>
                              )}
                              {showWorkStatus && onInspect && workStatus && (
                                <button
                                  type="button"
                                  className="message-execution-link message-work-status"
                                  data-status={workStatus.kind}
                                  aria-label={"后台工作" + workStatus.label}
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
                    {delivery?.error &&
                      !publishedErrorInputs.has(item?.id ?? "") && (
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
                    {item && resendStates[item.id]?.error && (
                      <div className="delivery-error" role="alert">
                        {resendStates[item.id]!.error}
                      </div>
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
                    <ResponseWaiting
                      inputId={item.id}
                      createdAt={item.createdAt}
                      {...waiting}
                    />
                  )}
                  {reply && continuingResponses.has(id) && (
                    <ResponseWaiting
                      {...continuingResponses.get(id)!}
                      showElapsed={false}
                    />
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
            onClick={returnLatest}
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
      <Tooltip label="停止">
        <button
          className="stop-response"
          aria-label={label}
          disabled={pending || !available}
          onClick={() => {
            if (!pending) void onStop(delivery.inputId);
          }}
        >
          <Square size={12} fill="currentColor" aria-hidden="true" />
          {!compact && <span>停止</span>}
        </button>
      </Tooltip>
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
  share,
  client,
}: {
  createdAt: string;
  text: string;
  control?: ReactNode;
  share: MessageShareContent;
  client: WorkspaceClient;
}) {
  // Locale formatting is relatively expensive across a long history. The
  // timestamp is immutable while typing or streaming, unlike the message body.
  const formattedTime = useMemo(
    () =>
      new Date(createdAt).toLocaleString("zh-CN", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
    [createdAt],
  );
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const [sharing, setSharing] = useState<MessageShareContent | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <>
      <span className="message-peek">
        <time dateTime={createdAt}>{formattedTime}</time>
        <Tooltip label={copied ? "已复制" : "复制消息"}>
          <button
            className="message-copy"
            type="button"
            aria-label={copied ? "已复制消息" : "复制消息"}
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
        </Tooltip>
        <Tooltip label="分享图片">
          <button
            className="message-copy message-share"
            type="button"
            aria-label="分享图片"
            disabled={
              !share.text.trim() &&
              !share.quotes.length &&
              !share.attachments.length
            }
            onClick={() => setSharing(share)}
          >
            <ImageIcon size={13} aria-hidden="true" />
          </button>
        </Tooltip>
        {control}
      </span>
      {error && (
        <span className="delivery-error" role="alert">
          复制失败，请重试或选中文字复制。
        </span>
      )}
      {sharing && (
        <MessageShareDialog
          content={sharing}
          client={client}
          onClose={() => setSharing(null)}
        />
      )}
    </>
  );
}

export function ToolMessage({
  message,
  state,
}: {
  message: LiveMessage;
  state: Workspace;
}) {
  const tool = message.tool!;
  const presentation = liveToolPresentation(tool, state);
  return (
    <details className="message-tool" data-tool-status={tool.status}>
      <summary>
        <ChevronRight className="tool-chevron" size={14} />
        <Wrench size={14} aria-hidden="true" />
        <span className="tool-name" title={presentation.detail}>
          {presentation.title}
          {presentation.detail ? ` · ${presentation.detail}` : ""}
        </span>
        <span className="tool-state">{presentation.statusLabel}</span>
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
