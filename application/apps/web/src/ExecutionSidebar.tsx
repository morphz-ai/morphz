import { useEffect, useRef, useState, type ReactNode } from "react";
import { observeSupplementAttention } from "./supplement-attention.js";
import {
  ArrowLeft,
  ChevronRight,
  MessageSquarePlus,
  Square,
} from "lucide-react";
import type { ExecutionReadScope } from "../../../packages/core/src/execution.js";
import type { WorkspaceClient } from "./client.js";
import { ExecutionDialog } from "./ExecutionDialog.js";
import { StopResponse, ToolMessage } from "./Conversation.js";
import { useConversationStream } from "./useConversationStream.js";
import { InspectorPanel } from "./InspectorPanel.js";
import type { InspectorLayout } from "./inspector-layout.js";
import { ApprovalCard } from "./ApprovalCard.js";
import type { ComposerOption } from "./ComposerOptions.js";
import type { InputContinuation } from "../../../packages/core/src/continuation.js";
import { activeExecutionThreads } from "../../../packages/core/src/conversation.js";
import type { ScriptOutput } from "../../../packages/core/src/script-delivery.js";
import {
  executionActivityClock,
  executionActivityOverview,
  executionActivityOverviewSummary,
  executionActivityScope,
  executionActivitySummary,
  executionActivityRoots,
  executionActivityDescendants,
  executionActivityGroupStatus,
  executionActivityThreadAvailable,
  executionActivityOrigin,
  type ActivityThread,
} from "./execution-activity.js";
import { projectDisplayLabel } from "./project-display-label.js";
import { ExecutionStatusIcon } from "./ExecutionStatusIcon.js";
import { ExecutionProgress } from "./ExecutionProgress.js";
import { Tooltip } from "./ui/Tooltip.js";
import { UserInputPreview } from "./UserInputPreview.js";
import {
  executionModelLabel,
  executionModelDescription,
} from "./execution-model.js";

export function ExecutionSidebar({
  client,
  scope,
  layout,
  onResize,
  onClose,
  onSelect,
  onSupplement,
  onReply,
  onOpen,
  onOpenScript,
  viewOptions,
  embedded = false,
  headerLeading,
  leading,
  onRefresh,
}: {
  client: WorkspaceClient;
  scope: ExecutionReadScope;
  layout: InspectorLayout;
  onResize: (width: number) => void;
  onClose: () => void;
  onSelect: (scope: ExecutionReadScope) => void;
  onSupplement?: (target: InputContinuation) => void;
  onReply?: (thread: ActivityThread) => void;
  onOpen: (id: string, revision?: number) => void;
  onOpenScript?: (output: ScriptOutput) => void;
  viewOptions?: ComposerOption[];
  embedded?: boolean;
  headerLeading?: ReactNode;
  leading?: ReactNode;
  onRefresh?: () => void | Promise<void>;
}) {
  const state = client.boot!.workspace,
    runtime = client.boot!.runtime;
  const input = state.inputs.find((i) => i.id === scope.inputId);
  const delivery = runtime.deliveries.find((d) => d.inputId === scope.inputId);
  const [stopping, setStopping] = useState(false),
    [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [showOther, setShowOther] = useState(false),
    [stopRequested, setStopRequested] = useState(false);
  const threads = runtime.activity?.threads ?? [];
  const currentThread = threads.find((t) => t.id === scope.threadId);
  const [initialThread] = useState(currentThread);
  const thread =
    currentThread ??
    (initialThread?.id === scope.threadId ? initialThread : undefined);
  const detail = !!(scope.inputId || scope.threadId);
  const branches = executionActivityRoots(
    threads.filter((t) => t.inputId === scope.inputId),
  );
  const supplementThreads = activeExecutionThreads(runtime).filter(
    (t) => t.inputId === scope.inputId && t.continuation,
  );
  const supplementTarget = scope.threadId
    ? supplementThreads.find((t) => t.id === scope.threadId)?.continuation
    : supplementThreads.length === 1
      ? supplementThreads[0]?.continuation
      : undefined;
  const readOnly = "runtime" in scope;
  const streamConversation = scope.conversationId ?? scope.projectId ?? "";
  const streamProject =
    state.conversations.find((c) => c.id === streamConversation)?.projectId ??
    scope.projectId ??
    "";
  const stream = useConversationStream(
    streamProject,
    streamConversation,
    detail && runtime.configured && !readOnly,
  );
  const messages = stream.messages.filter((m) =>
    scope.threadId
      ? m.threadId === scope.threadId
      : m.inputId === scope.inputId,
  );
  const liveTools = messages.filter((m) => m.tool && m.streaming);
  const {
    activityThreads,
    active,
    recent,
    activeCount,
    activityAvailable,
    activityComplete,
  } = executionActivityOverview(
    state,
    threads,
    scope,
    true,
    !client.boot!.capabilities.teamAuthentication,
    runtime,
  );
  const threadSummary = thread
    ? executionActivitySummary(
        thread,
        client.online &&
          !!currentThread &&
          executionActivityThreadAvailable(thread, runtime),
      )
    : "";
  const threadStatus = thread
    ? executionActivityGroupStatus(
        thread,
        activityThreads,
        (value) =>
          client.online &&
          !!currentThread &&
          executionActivityThreadAvailable(value, runtime),
      )
    : undefined;
  const threadNeedsInput =
    !!thread?.userInputRequest &&
    thread.lifecycle === "open" &&
    thread.controlState !== "paused" &&
    client.online &&
    !!currentThread &&
    executionActivityThreadAvailable(thread, runtime);
  const summaryRef = useRef<HTMLParagraphElement>(null);
  const [summaryVisible, setSummaryVisible] = useState(true);
  useEffect(() => {
    const node = summaryRef.current;
    if (!node || threadStatus?.kind !== "running") return;
    let intersecting = true;
    const sync = () =>
      setSummaryVisible(intersecting && document.visibilityState !== "hidden");
    const observer = new IntersectionObserver(([entry]) => {
      intersecting = !!entry?.isIntersecting;
      sync();
    });
    observer.observe(node);
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", sync);
    };
  }, [threadStatus?.kind, threadSummary]);
  const supplementAction = supplementTarget && onSupplement && (
    <Tooltip label="补充要求">
      <button
        className={`icon-button execution-supplement${thread?.userInputRequest ? " needs-input" : ""}`}
        ref={thread?.userInputRequest ? observeSupplementAttention : undefined}
        aria-label="补充"
        disabled={
          !client.online || !runtime.connected || !runtime.activity?.available
        }
        onClick={() => onSupplement(supplementTarget)}
      >
        <MessageSquarePlus aria-hidden="true" />
      </button>
    </Tooltip>
  );
  const activitySummary = executionActivityOverviewSummary(
    runtime,
    activityAvailable,
    activeCount,
  );
  async function refresh() {
    if (!onRefresh || refreshing) return;
    setRefreshing(true);
    setError("");
    try {
      await onRefresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }
  async function stop() {
    if (!input) return;
    setStopping(true);
    setError("");
    try {
      await client.cancelInput(input.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStopping(false);
    }
  }
  async function stopThread() {
    if (
      readOnly ||
      !currentThread ||
      currentThread.lifecycle !== "open" ||
      !activityAvailable ||
      !client.online
    )
      return;
    setStopping(true);
    setError("");
    try {
      await client.controlExecution({
        scope,
        action: {
          type: "cancel-thread",
          threadId: currentThread.id,
          revision: currentThread.revision,
        },
      });
      setStopRequested(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStopping(false);
    }
  }
  const detailStatus = scope.threadId && (
    <span
      className="execution-origin-status"
      data-status={threadStatus?.kind ?? "unknown"}
    >
      <ExecutionStatusIcon kind={threadStatus?.kind} size={18} />
      {threadNeedsInput
        ? "等待你的输入"
        : (threadStatus?.label ?? "此分支不在当前快照中")}
    </span>
  );
  const detailActions = (
    <div className="execution-origin-actions">
      {supplementAction}
      {scope.threadId && !readOnly && currentThread?.lifecycle === "open" && (
        <Tooltip
          label={
            stopping
              ? "正在请求停止"
              : stopRequested
                ? "停止请求已发送"
                : "停止当前执行"
          }
        >
          <button
            className="icon-button execution-stop-thread"
            aria-label="停止"
            aria-busy={stopping}
            disabled={
              stopping || stopRequested || !activityAvailable || !client.online
            }
            onClick={stopThread}
          >
            <Square aria-hidden="true" />
          </button>
        </Tooltip>
      )}
      {(stopping || stopRequested) && scope.threadId && (
        <span className="sr-only" role="status">
          {stopping ? "正在请求停止" : "停止请求已发送"}
        </span>
      )}
    </div>
  );
  const row = (t: ActivityThread) => {
    const status = executionActivityGroupStatus(
      t,
      activityThreads,
      (value) =>
        client.online && executionActivityThreadAvailable(value, runtime),
    );
    const children = executionActivityDescendants(t, activityThreads);
    const needsInput =
      !!t.userInputRequest &&
      t.lifecycle === "open" &&
      t.controlState !== "paused" &&
      client.online &&
      executionActivityThreadAvailable(t, runtime);
    const summary = needsInput
      ? "等待你的输入"
      : executionActivitySummary(
          t,
          client.online && executionActivityThreadAvailable(t, runtime),
        );
    const origin = executionActivityOrigin(
      t,
      state,
      client.contentCatalog,
      client.boot!.outputs,
      client.boot!.scriptOutputs,
    );
    const model = t.executionModel ? executionModelLabel(t.executionModel) : "";
    const metadata = [
      executionActivityClock(t),
      model,
      origin,
      children.length > 0 ? `${children.length} 个子任务` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <div key={t.id} className="execution-activity-entry">
        <button
          className="execution-activity-row"
          data-thread-id={t.id}
          data-root-id={t.rootId}
          aria-label={[
            t.title || "执行事项",
            needsInput ? "等待你的输入" : status.label,
            needsInput ? "" : summary,
            origin,
            executionActivityClock(t),
            model,
          ]
            .filter(Boolean)
            .join(" · ")}
          onClick={() => onSelect(executionActivityScope(t, state))}
        >
          <span
            className="execution-activity-icon"
            data-status={status.kind}
            title={needsInput ? "等待你的输入" : status.label}
          >
            <ExecutionStatusIcon kind={status.kind} size={19} />
          </span>
          <span className="execution-activity-body">
            <strong title={t.title}>{t.title || "执行事项"}</strong>
            {summary && (
              <span
                className="execution-activity-summary"
                data-user-input={needsInput || undefined}
                title={summary}
              >
                {summary}
              </span>
            )}
            <span className="execution-activity-meta" title={metadata}>
              <time
                dateTime={
                  t.outcome?.terminalKind === t.lifecycle
                    ? t.outcome.createdAt
                    : t.updatedAt
                }
              >
                {executionActivityClock(t)}
              </time>
              {t.executionModel && (
                <>
                  {" · "}
                  <span
                    className="execution-model-meta"
                    title={executionModelDescription(t.executionModel)}
                  >
                    {model}
                  </span>
                </>
              )}
              {origin && (
                <>
                  {" · "}
                  <span className="execution-activity-project" title={origin}>
                    {origin}
                  </span>
                </>
              )}
              {children.length > 0 && (
                <>
                  {" · "}
                  {children.length} 个子任务
                </>
              )}
            </span>
          </span>
          <ChevronRight size={14} aria-hidden="true" />
        </button>
        <UserInputPreview
          thread={t}
          onReply={onReply}
          disabled={
            !client.online || !executionActivityThreadAvailable(t, runtime)
          }
        />
      </div>
    );
  };
  const content = (
    <div className="execution-sidebar-scroll">
      {embedded && detail && (
        <div className="execution-detail-header">
          {headerLeading}
          {detailStatus}
          {detailActions}
        </div>
      )}
      {!detail && (
        <small className="sr-only execution-scope-count">
          {activitySummary}
        </small>
      )}
      {!runtime.connected && (
        <p className="execution-activity-notice" role="status">
          <span>连接中断，保留上次记录，进行中的状态待核对。</span>
          {onRefresh && (
            <button disabled={refreshing} onClick={() => void refresh()}>
              {refreshing ? "重试中" : "重试"}
            </button>
          )}
        </p>
      )}
      {runtime.connected && !runtime.activity?.available && (
        <p className="execution-activity-notice" role="status">
          <span>
            {runtime.activity?.readScopes?.some(
              (value) => value.currentAvailable,
            )
              ? "部分后台状态暂不可用，未核对部分保留上次记录。"
              : "后台状态暂不可用，以下保留上次记录。"}
          </span>
          {onRefresh && (
            <button disabled={refreshing} onClick={() => void refresh()}>
              {refreshing ? "刷新中" : "刷新"}
            </button>
          )}
        </p>
      )}
      {runtime.connected &&
        runtime.activity?.available &&
        runtime.activity.readScopes?.some(
          (value) => !value.historyAvailable && !value.historyRetained,
        ) && (
          <p className="execution-activity-notice" role="status">
            <span>历史记录刷新失败，当前活动状态可用。</span>
            {onRefresh && (
              <button disabled={refreshing} onClick={() => void refresh()}>
                {refreshing ? "刷新中" : "刷新"}
              </button>
            )}
          </p>
        )}
      {!detail && error && (
        <p className="delivery-error" role="alert">
          {error}
        </p>
      )}
      {!detail && runtime.attention && (
        <section className="execution-attention" aria-label="需要处理的审批">
          {!runtime.attention.available && (
            <p className="muted" role="status">
              审批状态暂不可用，请刷新后核对。
            </p>
          )}
          {runtime.attention.approvals.map((entry) => (
            <ApprovalCard
              key={
                entry.approval.request.approval_id + entry.approval.fingerprint
              }
              entry={entry}
              client={client}
              available={
                client.online &&
                runtime.connected &&
                runtime.attention!.available
              }
              origin={projectDisplayLabel(
                state.projects.find((p) => p.id === entry.scope.projectId),
              )}
              onInspect={() => onSelect(entry.scope)}
            />
          ))}
        </section>
      )}
      {!detail && runtime.activity?.delegationsAvailable === false && (
        <p className="muted" role="status">
          子任务状态暂不可用，请刷新后核对。
        </p>
      )}
      {detail ? (
        <>
          {scope.threadId && (
            <section
              className="execution-origin"
              data-status={threadStatus?.kind ?? "unknown"}
            >
              <p className="execution-origin-title" title={thread?.title}>
                {thread?.title ?? "执行分支"}
              </p>
              {threadSummary && (
                <p
                  ref={summaryRef}
                  className="execution-activity-summary"
                  title={threadSummary}
                  data-motion-active={
                    (threadStatus?.kind === "running" && summaryVisible) ||
                    undefined
                  }
                >
                  {threadSummary}
                </p>
              )}
              <p
                className="execution-model"
                title={executionModelDescription(thread?.executionModel)}
              >
                {executionModelLabel(thread?.executionModel)}
              </p>
              {error && (
                <p className="delivery-error" role="alert">
                  {error}
                </p>
              )}
            </section>
          )}
          {input && !scope.threadId && (
            <section className="execution-origin">
              {input.body.length > 48 ? (
                <details className="execution-input-text">
                  <summary>
                    <span>{input.body}</span>
                  </summary>
                  <p>{input.body}</p>
                </details>
              ) : (
                <p>{input.body}</p>
              )}
              <div>
                <small>
                  {projectDisplayLabel(
                    state.projects.find((p) => p.id === input.projectId),
                  )}
                </small>
                {delivery &&
                  (delivery.cancellable || delivery.cancelRequested) && (
                    <StopResponse
                      delivery={delivery}
                      stopping={stopping}
                      error={error}
                      onStop={stop}
                    />
                  )}
              </div>
            </section>
          )}
          {leading}
          {input && (
            <div className="execution-outputs" aria-label="工作成果">
              {client
                .boot!.outputs.filter((o) => o.inputId === input.id)
                .map((o) => (
                  <button
                    key={o.commandId}
                    onClick={() => onOpen(o.artifactId, o.revision)}
                  >
                    {state.artifacts.find((a) => a.id === o.artifactId)
                      ?.title ??
                      client.contentCatalog.find(
                        (entry) => entry.id === o.artifactId,
                      )?.title ??
                      "打开成果"}{" "}
                    · v{o.revision}
                  </button>
                ))}
              {client
                .boot!.scriptOutputs.filter((o) => o.inputId === input.id)
                .map((o) => (
                  <button
                    key={o.commandId}
                    disabled={!onOpenScript}
                    onClick={() => onOpenScript?.(o)}
                  >
                    {o.title}
                    {o.itemId ? ` · v${o.revision}` : ""}
                  </button>
                ))}
            </div>
          )}
          {!scope.threadId && branches.length > 0 && (
            <section aria-label="执行分支">{branches.map(row)}</section>
          )}
          {scope.threadId &&
            activityThreads.some(
              (t) => t.delegation?.parentThreadId === scope.threadId,
            ) && (
              <section aria-label="委派子任务">
                {executionActivityRoots(
                  activityThreads.filter(
                    (t) => t.delegation?.parentThreadId === scope.threadId,
                  ),
                ).map(row)}
              </section>
            )}
          <ExecutionProgress
            messages={messages}
            running={threadStatus?.kind === "running"}
          />
          {messages
            .filter((m) => m.kind === "error")
            .map((m) => (
              <p className="delivery-error" key={m.id}>
                {m.text}
              </p>
            ))}
          {liveTools.length > 0 && (
            <section className="execution-live-calls" aria-label="实时调用过程">
              {liveTools.map((m) => (
                <div
                  key={m.id}
                  data-message-id={m.id}
                  data-stream-active={
                    (stream.connected &&
                      m.streaming &&
                      m.tool?.status === "generating") ||
                    undefined
                  }
                >
                  <ToolMessage message={m} state={state} />
                </div>
              ))}
            </section>
          )}
          <ExecutionDialog
            key={scope.threadId ?? scope.inputId}
            embedded
            hideEmpty={liveTools.length > 0}
            client={client}
            scope={scope}
            onClose={onClose}
            onOpen={onOpen}
          />
        </>
      ) : (
        <>
          {leading}
          {active.length > 0 && (
            <section
              className="execution-activity-section"
              aria-label="进行中的活动"
            >
              <h3>进行中</h3>
              {active.map(row)}
            </section>
          )}
          {!active.length && (!embedded || recent.length === 0) && (
            <p className="execution-quiet">
              {activityComplete
                ? "当前没有正在处理的工作"
                : "尚不能确认是否有工作进行中"}
            </p>
          )}
          {recent.length > 0 && (
            <section aria-label="近期活动">
              {recent.map((group) => (
                <section className="execution-activity-section" key={group.key}>
                  <h3>{group.label}</h3>
                  {group.threads.map(row)}
                </section>
              ))}
            </section>
          )}
          {!readOnly && (
            <details
              className="execution-other"
              onToggle={(e) => setShowOther(e.currentTarget.open)}
            >
              <summary>工具执行记录</summary>
              {showOther && (
                <ExecutionDialog
                  embedded
                  client={client}
                  scope={{ ...scope, inputId: undefined, threadId: undefined }}
                  onClose={onClose}
                  onOpen={onOpen}
                />
              )}
            </details>
          )}
        </>
      )}
    </div>
  );
  if (embedded) return content;
  return (
    <InspectorPanel
      className="execution-sidebar"
      label="执行面板"
      title={scope.threadId ? "执行分支" : scope.inputId ? "执行详情" : "活动"}
      context={
        detail
          ? scope.projectId
            ? projectDisplayLabel(
                state.projects.find((p) => p.id === scope.projectId),
              )
            : undefined
          : undefined
      }
      resizeLabel="调整活动面板宽度"
      layout={layout}
      onResize={onResize}
      onClose={onClose}
      focusOnMount={false}
      viewOptions={viewOptions}
      actions={
        detail ? (
          <>
            {detailStatus}
            {detailActions}
          </>
        ) : undefined
      }
      leading={
        detail && (
          <button
            className="icon-button"
            aria-label="返回活动概览"
            onClick={() =>
              readOnly
                ? onClose()
                : onSelect({
                    projectId: scope.projectId,
                    conversationId: scope.conversationId,
                    artifactId: null,
                  })
            }
          >
            <ArrowLeft />
          </button>
        )
      }
    >
      {content}
    </InspectorPanel>
  );
}
