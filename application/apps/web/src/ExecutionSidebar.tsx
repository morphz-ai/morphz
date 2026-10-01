import { useState, type ReactNode } from "react";
import {
  Activity,
  ArrowLeft,
  ChevronRight,
  CircleCheck,
  CircleHelp,
  CircleSlash,
  CircleX,
  Clock3,
  Pause,
  Square,
} from "lucide-react";
import type { ExecutionScope } from "../../../packages/core/src/execution.js";
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
  executionActivityDateGroups,
  executionActivityScope,
  executionActivityStatus,
  executionActivityThreads,
  type ActivityThread,
} from "./execution-activity.js";
import "./execution-activity.css";

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
  overviewLeading,
  onRefresh,
  allWork: allWorkOverride,
  onAllWorkChange,
}: {
  client: WorkspaceClient;
  scope: ExecutionScope;
  layout: InspectorLayout;
  onResize: (width: number) => void;
  onClose: () => void;
  onSelect: (scope: ExecutionScope) => void;
  onSupplement?: (target: InputContinuation) => void;
  onOpen: (id: string, revision?: number) => void;
  onOpenScript?: (output: ScriptOutput) => void;
  viewOptions?: ComposerOption[];
  embedded?: boolean;
  overviewLeading?: ReactNode | ((allWork: boolean) => ReactNode);
  onRefresh?: () => void | Promise<void>;
  allWork?: boolean;
  onAllWorkChange?: (allWork: boolean) => void;
}) {
  const state = client.boot!.workspace,
    runtime = client.boot!.runtime;
  const input = state.inputs.find((i) => i.id === scope.inputId);
  const delivery = runtime.deliveries.find((d) => d.inputId === scope.inputId);
  const [stopping, setStopping] = useState(false),
    [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [localAllWork, setLocalAllWork] = useState(false);
  const allWork = allWorkOverride ?? localAllWork;
  const setAllWork = onAllWorkChange ?? setLocalAllWork;
  const [showOther, setShowOther] = useState(false),
    [stopRequested, setStopRequested] = useState(false);
  const threads = runtime.activity?.threads ?? [];
  const currentThread = threads.find((t) => t.id === scope.threadId);
  const [initialThread] = useState(currentThread);
  const thread =
    currentThread ??
    (initialThread?.id === scope.threadId ? initialThread : undefined);
  const detail = !!(scope.inputId || scope.threadId);
  const branches = threads.filter((t) => t.inputId === scope.inputId);
  const supplementThreads = activeExecutionThreads(runtime).filter(
    (t) => t.inputId === scope.inputId && t.continuation,
  );
  const supplementTarget = scope.threadId
    ? supplementThreads.find((t) => t.id === scope.threadId)?.continuation
    : supplementThreads.length === 1
      ? supplementThreads[0]?.continuation
      : undefined;
  const streamConversation = scope.conversationId ?? scope.projectId;
  const streamProject =
    state.conversations.find((c) => c.id === streamConversation)?.projectId ??
    scope.projectId;
  const stream = useConversationStream(
    streamProject,
    streamConversation,
    detail && runtime.configured,
  );
  const messages = stream.messages.filter((m) =>
    scope.threadId
      ? m.threadId === scope.threadId
      : m.inputId === scope.inputId,
  );
  const liveTools = messages.filter((m) => m.tool && m.streaming);
  const activityThreads = executionActivityThreads(
    state,
    threads,
    scope,
    allWork,
    !client.boot!.capabilities.teamAuthentication,
  );
  const active = activityThreads.filter((t) => t.lifecycle === "open");
  const recent = executionActivityDateGroups(
    activityThreads.filter((t) => t.lifecycle !== "open"),
  );
  const activeCount = active.length;
  const activityAvailable =
    runtime.connected && runtime.activity?.available === true;
  const activityComplete = activityAvailable && !runtime.activity?.truncated;
  const activitySummary = !activityAvailable
    ? "工作状态待核对"
    : runtime.activity?.truncated
      ? activeCount
        ? `至少 ${activeCount} 项进行中`
        : "工作状态待核对"
      : `${activeCount} 项进行中`;
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
    const status = executionActivityStatus(t, activityAvailable);
    const Icon = {
      running: Activity,
      waiting: Clock3,
      paused: Pause,
      ended: CircleCheck,
      failed: CircleX,
      cancelled: CircleSlash,
      unknown: CircleHelp,
    }[status.kind];
    const project = state.projects.find((p) => p.id === t.projectId);
    const showProject = project && (allWork || t.projectId !== scope.projectId);
    return (
      <button
        className="execution-activity-row"
        key={t.id}
        data-thread-id={t.id}
        data-root-id={t.rootId}
        aria-label={`${t.title || "执行事项"} · ${status.label} · ${executionActivityClock(t)}`}
        onClick={() => onSelect(executionActivityScope(t, state))}
      >
        <span
          className="execution-activity-icon"
          data-status={status.kind}
          title={status.label}
        >
          <Icon size={19} aria-hidden="true" />
        </span>
        <span className="execution-activity-body">
          <strong title={t.title}>{t.title || "执行事项"}</strong>
          <span className="execution-activity-meta">
            <time
              dateTime={
                t.outcome?.terminalKind === t.lifecycle
                  ? t.outcome.createdAt
                  : t.updatedAt
              }
            >
              {executionActivityClock(t)}
            </time>
            {showProject && (
              <span className="execution-activity-project">
                {project.title}
              </span>
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
        <div className="execution-activity-scope" aria-label="活动范围">
          <button aria-pressed={!allWork} onClick={() => setAllWork(false)}>
            当前工作
          </button>
          <button aria-pressed={allWork} onClick={() => setAllWork(true)}>
            全部工作
          </button>
          {!embedded && (
            <small className="execution-scope-count">{activitySummary}</small>
          )}
        </div>
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
      {!detail &&
        (typeof overviewLeading === "function"
          ? overviewLeading(allWork)
          : overviewLeading)}
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
              origin={
                state.projects.find((p) => p.id === entry.scope.projectId)
                  ?.title
              }
              onInspect={() => onSelect(entry.scope)}
            />
          ))}
        </section>
      )}
      {detail ? (
        <>
          {supplementTarget && onSupplement && (
            <button
              className="button execution-supplement"
              title="给这项后台工作追加要求"
              disabled={
                !client.online ||
                !runtime.connected ||
                !runtime.activity?.available
              }
              onClick={() => onSupplement(supplementTarget)}
            >
              补充要求
            </button>
          )}
          {scope.threadId && (
            <section className="execution-origin">
              <p>{thread?.title ?? "执行分支"}</p>
              <div>
                <small>
                  {thread
                    ? executionActivityStatus(
                        thread,
                        activityAvailable && !!currentThread,
                      ).label
                    : "此分支不在当前快照中"}
                </small>
                {currentThread?.lifecycle === "open" && (
                  <button
                    className="execution-stop-thread"
                    disabled={
                      stopping ||
                      stopRequested ||
                      !activityAvailable ||
                      !client.online
                    }
                    onClick={stopThread}
                  >
                    <Square size={12} />
                    {stopping || stopRequested
                      ? "停止请求已发送"
                      : "停止此分支"}
                  </button>
                )}
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
                  {state.projects.find((p) => p.id === input.projectId)?.title}
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
          {messages
            .filter((m) => m.kind === "progress")
            .map((m) => (
              <p className="execution-progress" key={m.id}>
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
        allWork && !detail
          ? "全部工作"
          : state.projects.find((p) => p.id === scope.projectId)?.title
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
              onSelect({
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
