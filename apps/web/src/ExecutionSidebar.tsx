import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, Pin, PinOff, Square, X } from "lucide-react";
import { discussionId } from "../../../packages/core/src/model.js";
import type { ExecutionScope } from "../../../packages/core/src/execution.js";
import type { WorkspaceClient } from "./client.js";
import { ExecutionDialog } from "./ExecutionDialog.js";
import { StopResponse, ToolMessage } from "./Conversation.js";
import { useConversationStream } from "./useConversationStream.js";

export function ExecutionSidebar({
  client,
  scope,
  pinned,
  width,
  onResize,
  onPin,
  onClose,
  onSelect,
  onOpen,
}: {
  client: WorkspaceClient;
  scope: ExecutionScope;
  pinned: boolean;
  width: number;
  onResize: (width: number) => void;
  onPin: () => void;
  onClose: () => void;
  onSelect: (scope: ExecutionScope) => void;
  onOpen: (id: string) => void;
}) {
  const state = client.boot!.workspace,
    runtime = client.boot!.runtime;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  const input = state.inputs.find((i) => i.id === scope.inputId);
  const delivery = runtime.deliveries.find((d) => d.inputId === scope.inputId);
  const [stopping, setStopping] = useState(false),
    [error, setError] = useState("");
  const [showRecent, setShowRecent] = useState(false);
  const [showOther, setShowOther] = useState(false),
    [stopRequested, setStopRequested] = useState(false);
  const threads = runtime.activity?.threads ?? [];
  const currentThread = threads.find((t) => t.id === scope.threadId);
  const [initialThread] = useState(currentThread);
  const thread = currentThread ?? initialThread;
  const detail = !!(scope.inputId || scope.threadId);
  const branches = threads.filter((t) => t.inputId === scope.inputId);
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
    const source = state.inputs.find((i) => i.id === d.inputId);
    return source ? [{ delivery: d, source }] : [];
  });
  const pending = (d: (typeof entries)[number]["delivery"]) =>
    ["queued", "sending", "running"].includes(d.state) ||
    threads.some((t) => t.inputId === d.inputId);
  const active = entries.filter(({ delivery: d }) => pending(d));
  const background = threads.filter((t) => !t.inputId);
  const deliveredAt = (id: string, fallback: string) =>
    runtime.messages
      .filter((m) => m.inputId === id)
      .map((m) => m.createdAt)
      .sort()
      .at(-1) ?? fallback;
  const recent = entries
    .filter(({ delivery: d }) => !pending(d))
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
      completed: "已交付",
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
  const branchRow = (t: (typeof threads)[number]) => (
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
        <strong>{t.title}</strong>
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
        <strong>{source.body}</strong>
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
    <aside
      className="execution-sidebar"
      aria-label="执行面板"
      style={{ width }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div
        className="execution-resizer"
        role="separator"
        aria-label="调整执行面板宽度"
        aria-orientation="vertical"
        aria-valuemin={280}
        aria-valuemax={520}
        aria-valuenow={width}
        tabIndex={0}
        onKeyDown={(e) => {
          if (["ArrowLeft", "ArrowRight"].includes(e.key)) {
            e.preventDefault();
            onResize(
              Math.max(
                280,
                Math.min(520, width + (e.key === "ArrowLeft" ? 16 : -16)),
              ),
            );
          }
        }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            onResize(Math.max(280, Math.min(520, innerWidth - e.clientX)));
        }}
        onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
      />
      <header className="execution-sidebar-header">
        {detail && (
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
        )}
        <h2 ref={heading} tabIndex={-1}>
          {scope.threadId ? "执行分支" : scope.inputId ? "执行详情" : "执行"}
        </h2>
        {!detail && (
          <small>
            {active.length + new Set(background.map((t) => t.rootId)).size} 项
            {runtime.activity?.available === false ? "状态待确认" : "进行中"}
          </small>
        )}
        <span className="execution-header-space" />
        <button
          className="icon-button"
          aria-label={pinned ? "取消固定执行面板" : "固定执行面板"}
          aria-pressed={pinned}
          onClick={onPin}
        >
          {pinned ? <PinOff /> : <Pin />}
        </button>
        <button
          className="icon-button"
          aria-label="关闭执行面板"
          onClick={onClose}
        >
          <X />
        </button>
      </header>
      <div className="execution-sidebar-scroll">
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
        {detail ? (
          <>
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
                {input.body.length > 140 ? (
                  <details className="execution-input-text">
                    <summary>{input.body.slice(0, 100)}…</summary>
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
            {!scope.threadId && branches.length > 0 && (
              <section aria-label="执行分支">{branches.map(branchRow)}</section>
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
                    <ToolMessage message={m} />
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
            {background.map(branchRow)}
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
              <summary>其他后台执行与审批</summary>
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
    </aside>
  );
}
