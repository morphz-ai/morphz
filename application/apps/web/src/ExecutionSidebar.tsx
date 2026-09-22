import { useState } from "react";
import { ArrowLeft, ChevronRight, Pin, PinOff, Square } from "lucide-react";
import {
  discussionId,
  inConversation,
} from "../../../packages/core/src/model.js";
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

export function ExecutionSidebar({
  client,
  scope,
  pinned,
  layout,
  onResize,
  onPin,
  onClose,
  onSelect,
  onSupplement,
  onOpen,
  onOpenScript,
  viewOptions,
}: {
  client: WorkspaceClient;
  scope: ExecutionScope;
  pinned: boolean;
  layout: InspectorLayout;
  onResize: (width: number) => void;
  onPin: () => void;
  onClose: () => void;
  onSelect: (scope: ExecutionScope) => void;
  onSupplement?: (target: InputContinuation) => void;
  onOpen: (id: string, revision?: number) => void;
  onOpenScript?: (output: ScriptOutput) => void;
  viewOptions?: ComposerOption[];
}) {
  const state = client.boot!.workspace,
    runtime = client.boot!.runtime;
  const input = state.inputs.find((i) => i.id === scope.inputId);
  const delivery = runtime.deliveries.find((d) => d.inputId === scope.inputId);
  const [stopping, setStopping] = useState(false),
    [error, setError] = useState("");
  const [showRecent, setShowRecent] = useState(false);
  const [allWork, setAllWork] = useState(false);
  const [showOther, setShowOther] = useState(false),
    [stopRequested, setStopRequested] = useState(false);
  const threads = runtime.activity?.threads ?? [];
  const currentThread = threads.find((t) => t.id === scope.threadId);
  const [initialThread] = useState(currentThread);
  const thread = currentThread ?? initialThread;
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
  const entries = runtime.deliveries.flatMap((d) => {
    if (d.supplement) return [];
    const source = state.inputs.find((i) => i.id === d.inputId);
    return source &&
      (allWork ||
        (scope.artifactId
          ? source.artifactId === scope.artifactId
          : inConversation(
              state,
              scope.conversationId ?? scope.projectId,
              source,
              !client.boot!.capabilities.teamAuthentication,
            )))
      ? [{ delivery: d, source }]
      : [];
  });
  const pending = (d: (typeof entries)[number]["delivery"]) =>
    ["queued", "sending", "running"].includes(d.state) ||
    threads.some((t) => t.inputId === d.inputId);
  const active = entries.filter(({ delivery: d }) => pending(d));
  const background = threads.filter(
    (t) =>
      !t.inputId &&
      (allWork ||
        inConversation(
          state,
          scope.conversationId ?? scope.projectId,
          t,
          !client.boot!.capabilities.teamAuthentication,
        )),
  );
  const deliveredAt = (id: string, fallback: string) =>
    runtime.messages
      .filter((m) => m.inputId === id)
      .map((m) => m.createdAt)
      .sort()
      .at(-1) ?? fallback;
  const recent = entries
    .filter(
      ({ delivery: d, source }) =>
        !pending(d) &&
        (d.state === "failed" ||
          source.intent ||
          source.artifactId ||
          client.boot!.outputs.some((o) => o.inputId === source.id) ||
          client.boot!.scriptOutputs.some((o) => o.inputId === source.id) ||
          allWork),
    )
    .sort((a, b) =>
      deliveredAt(b.source.id, b.source.createdAt).localeCompare(
        deliveredAt(a.source.id, a.source.createdAt),
      ),
    );
  const status = (value: string) =>
    ({
      queued: "等待执行",
      sending: "等待确认",
      running: "进行中",
      completed: "已结束",
      failed: "执行失败",
      cancelled: "已停止",
    })[value] ?? value;
  const phase = (value: string) =>
    ({
      idle: "等待唤醒",
      runnable: "待执行",
      running: "执行中",
      waiting: "等待中",
    })[value] ?? "进行中";
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
    if (!currentThread || !runtime.activity?.available) return;
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
  const branchRow = (t: (typeof threads)[number], compact = false) => (
    <button
      className="execution-work-row"
      key={t.id}
      onClick={() =>
        onSelect({
          projectId: t.projectId,
          conversationId: t.conversationId,
          artifactId: null,
          ...(t.inputId ? { inputId: t.inputId } : {}),
          threadId: t.id,
        })
      }
    >
      <span className="execution-work-body">
        <strong>{compact ? "查看执行分支" : t.title}</strong>
        <small>
          {runtime.activity?.available ? phase(t.phase) : "状态待确认"} ·{" "}
          {t.id.slice(-8)}
        </small>
      </span>
      <span
        className="execution-work-mark"
        data-active={
          (runtime.connected && runtime.activity?.available) || undefined
        }
      />
      <ChevronRight size={14} />
    </button>
  );
  const row = ({ source, delivery: d }: (typeof entries)[number]) => (
    <button
      className="execution-work-row"
      key={source.id}
      onClick={() =>
        onSelect({
          projectId: source.projectId,
          conversationId: discussionId(source),
          artifactId: source.artifactId,
          inputId: source.id,
        })
      }
    >
      <span className="execution-work-body">
        <strong>
          {source.body || source.attachments?.[0]?.name || "附件消息"}
        </strong>
        <small>
          {state.projects.find((p) => p.id === source.projectId)?.title} ·{" "}
          {runtime.connected
            ? threads.some((t) => t.inputId === source.id)
              ? `${threads.filter((t) => t.inputId === source.id).length} 个执行分支${runtime.activity?.available ? "" : " · 状态待确认"}`
              : status(d.state)
            : "连接中断，状态待确认"}
        </small>
      </span>
      <span
        className="execution-work-mark"
        data-active={
          (runtime.connected &&
            (d.state === "running" ||
              (runtime.activity?.available &&
                threads.some((t) => t.inputId === source.id)))) ||
          undefined
        }
        aria-hidden="true"
      />
      <ChevronRight size={14} />
    </button>
  );
  return (
    <InspectorPanel
      className="execution-sidebar"
      label="执行面板"
      title={
        scope.threadId ? "执行分支" : scope.inputId ? "执行详情" : "执行记录"
      }
      context={
        allWork && !detail
          ? "全部工作"
          : state.projects.find((p) => p.id === scope.projectId)?.title
      }
      resizeLabel="调整执行面板宽度"
      layout={layout}
      onResize={onResize}
      onClose={onClose}
      focusOnMount={false}
      viewOptions={viewOptions}
      leading={
        detail && (
          <button
            className="icon-button"
            aria-label="返回执行概览"
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
      actions={
        <button
          className="icon-button"
          aria-label={pinned ? "取消固定执行面板" : "固定执行面板"}
          aria-pressed={pinned}
          title={
            pinned ? "取消固定，跟随当前工作" : "固定当前执行，不随页面切换"
          }
          onClick={onPin}
        >
          {pinned ? <PinOff /> : <Pin />}
        </button>
      }
    >
      <div className="execution-sidebar-scroll">
        {!detail && (
          <div className="execution-scope">
            <button aria-pressed={!allWork} onClick={() => setAllWork(false)}>
              当前工作
            </button>
            <button aria-pressed={allWork} onClick={() => setAllWork(true)}>
              全部工作
            </button>
            <small className="execution-scope-count">
              {active.length + new Set(background.map((t) => t.rootId)).size} 项
              {runtime.activity?.available === false ? "状态待确认" : "进行中"}
            </small>
          </div>
        )}
        {!runtime.connected && (
          <p className="delivery-error" role="status">
            连接中断，执行状态尚未确认。
          </p>
        )}
        {runtime.connected && runtime.activity?.available === false && (
          <p className="execution-progress" role="status">
            后台调度状态暂不可用，以下保留上次记录。
          </p>
        )}
        {runtime.activity?.truncated && (
          <p className="execution-progress">当前概览未覆盖全部后台分支。</p>
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
                  entry.approval.request.approval_id +
                  entry.approval.fingerprint
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
                    {currentThread
                      ? runtime.activity?.available
                        ? phase(currentThread.phase)
                        : "状态待确认"
                      : "此分支已不在进行中"}
                  </small>
                  {currentThread && (
                    <button
                      className="execution-stop-thread"
                      disabled={
                        stopping ||
                        stopRequested ||
                        !runtime.activity?.available
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
                    {
                      state.projects.find((p) => p.id === input.projectId)
                        ?.title
                    }
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
                        ?.title ?? "打开成果"}{" "}
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
              <section aria-label="执行分支">
                {branches.map((branch) =>
                  branchRow(
                    branch,
                    branches.length === 1 && branch.title === input?.body,
                  ),
                )}
              </section>
            )}
            {messages
              .filter((m) => m.kind === "progress")
              .map((m) => (
                <p className="execution-progress" key={m.id}>
                  {m.text}
                </p>
              ))}
            {liveTools.length > 0 && (
              <section
                className="execution-live-calls"
                aria-label="实时调用过程"
              >
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
            {active.map(row)}
            {background.map((branch) => branchRow(branch))}
            {!active.length && !background.length && (
              <p className="execution-quiet">当前没有正在处理的工作</p>
            )}
            {recent.length > 0 && (
              <section className="execution-recent">
                <button
                  className="execution-section-toggle"
                  aria-expanded={showRecent}
                  onClick={() => setShowRecent(!showRecent)}
                >
                  最近结束 <span>{recent.length}</span>
                  <ChevronRight size={14} />
                </button>
                {showRecent && recent.slice(0, 30).map(row)}
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
    </InspectorPanel>
  );
}
