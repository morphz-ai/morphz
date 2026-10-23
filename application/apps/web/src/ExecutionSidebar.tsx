import { useState, type ReactNode } from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";
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
  executionActivityOrigin,
  type ActivityThread,
} from "./execution-activity.js";
import { projectDisplayLabel } from "./project-display-label.js";
import { ExecutionStatusIcon } from "./ExecutionStatusIcon.js";
import { ExecutionProgress } from "./ExecutionProgress.js";
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
  onOpen,
  onOpenScript,
  viewOptions,
  embedded = false,
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
  onOpen: (id: string, revision?: number) => void;
  onOpenScript?: (output: ScriptOutput) => void;
  viewOptions?: ComposerOption[];
  embedded?: boolean;
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
    ? executionActivitySummary(thread, activityAvailable && !!currentThread)
    : "";
  const threadStatus = thread
    ? executionActivityGroupStatus(
        thread,
        activityThreads,
        activityAvailable && !!currentThread,
      )
    : undefined;
  const supplementAction = supplementTarget && onSupplement && (
    <button
      className="secondary-action execution-supplement"
      disabled={
        !client.online || !runtime.connected || !runtime.activity?.available
      }
      onClick={() => onSupplement(supplementTarget)}
    >
      补充
    </button>
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
  const row = (t: ActivityThread) => {
    const status = executionActivityGroupStatus(
      t,
      activityThreads,
      activityAvailable,
    );
    const children = executionActivityDescendants(t, activityThreads);
    const summary = executionActivitySummary(t, activityAvailable);
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
      <button
        className="execution-activity-row"
        key={t.id}
        data-thread-id={t.id}
        data-root-id={t.rootId}
        aria-label={[
          t.title || "执行事项",
          status.label,
          summary,
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
          title={status.label}
        >
          <ExecutionStatusIcon kind={status.kind} size={19} />
        </span>
        <span className="execution-activity-body">
          <strong title={t.title}>{t.title || "执行事项"}</strong>
          {summary && (
            <span className="execution-activity-summary" title={summary}>
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
    );
  };
  const content = (
    <div className="execution-sidebar-scroll">
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
          <span>后台状态暂不可用，以下保留上次记录。</span>
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
      {detail ? (
        <>
          {!scope.threadId && supplementAction}
          {scope.threadId && (
            <section className="execution-origin">
              <p className="execution-origin-title" title={thread?.title}>
                {thread?.title ?? "执行分支"}
              </p>
              {threadSummary && (
                <p className="execution-activity-summary" title={threadSummary}>
                  {threadSummary}
                </p>
              )}
              <p
                className="execution-model"
                title={executionModelDescription(thread?.executionModel)}
              >
                最近调用：{executionModelLabel(thread?.executionModel)}
              </p>
              <div>
                <span
                  className="execution-origin-status"
                  data-status={threadStatus?.kind ?? "unknown"}
                >
                  <ExecutionStatusIcon kind={threadStatus?.kind} size={18} />
                  {threadStatus?.label ?? "此分支不在当前快照中"}
                </span>
                <div className="execution-origin-actions">
                  {supplementAction}
                  {!readOnly && currentThread?.lifecycle === "open" && (
                    <button
                      className="secondary-action execution-stop-thread"
                      aria-busy={stopping}
                      title={
                        stopping
                          ? "正在请求停止"
                          : stopRequested
                            ? "停止请求已发送"
                            : undefined
                      }
                      disabled={
                        stopping ||
                        stopRequested ||
                        !activityAvailable ||
                        !client.online
                      }
                      onClick={stopThread}
                    >
                      停止
                    </button>
                  )}
                  {(stopping || stopRequested) && (
                    <span className="sr-only" role="status">
                      {stopping ? "正在请求停止" : "停止请求已发送"}
                    </span>
                  )}
                </div>
              </div>
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
          {runtime.activity?.delegationsAvailable === false && (
            <p className="muted" role="status">
              子任务状态暂不可用，请刷新后核对。
            </p>
          )}
          {runtime.activity?.delegationsAvailable &&
            runtime.activity.delegationsTruncated && (
              <p className="muted">当前仅显示已核验的部分子任务。</p>
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
