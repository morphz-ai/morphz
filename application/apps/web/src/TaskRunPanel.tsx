import type { Artifact, Workspace } from "../../../packages/core/src/model.js";
import type { WorkspaceClient } from "./client.js";
import { ExecutionDialog } from "./ExecutionDialog.js";
import { ComposerOptions } from "./ComposerOptions.js";
import { useTaskRunPanel } from "./features/tasks/useTaskRunPanel.js";

export function TaskRunPanel({
  artifact,
  state,
  client,
  onRespond,
  onOpen,
  compact = false,
  runtimeObserved = false,
  runtimeReadError,
}: {
  artifact: Artifact;
  state: Workspace;
  client: WorkspaceClient;
  onRespond: () => void;
  onOpen?: (id: string) => void;
  compact?: boolean;
  runtimeObserved?: boolean;
  runtimeReadError?: string;
}) {
  const panel = useTaskRunPanel({
    artifact,
    state,
    client,
    onOpen,
    compact,
    runtimeObserved,
    runtimeReadError,
  });
  if (!panel) return null;
  const {
    busy,
    error,
    readError,
    human,
    view,
    run,
    active,
    status,
    connected,
    responses,
    responsesLoading,
    canRespond,
    thread,
    threadId,
    dependencies,
    inspect,
    primary,
    secondary,
    stopCurrentRun,
    withdrawArrangement,
    toggleFutureTriggers,
    closeInspection,
    openInspectionContent,
  } = panel;
  return (
    <section
      className={`task-run-panel${compact ? " task-run-compact" : ""}`}
      aria-label="实际执行与回应"
    >
      {human ? (
        <>
          {responsesLoading && (
            <p className="muted" role="status">
              正在读取处理结果…
            </p>
          )}
          {responses.length > 0 && <h2>处理结果</h2>}
          {responses.map((r) => (
            <blockquote key={r.id}>
              <p>{r.body}</p>
              <small>
                {state.actants.find((a) => a.id === r.author.actantId)?.name} ·
                回应 v{r.taskRevision}
              </small>
            </blockquote>
          ))}
          {canRespond && (
            <button className="task-result-action" onClick={onRespond}>
              提交结果并完成
            </button>
          )}
        </>
      ) : (
        <>
          {!compact && (
            <p className="task-run-status" role="status">
              {status.label}
              {run && <small> · 第 {run.run} 次执行</small>}
            </p>
          )}
          <div className="task-run-actions">
            {primary && (
              <button
                className="task-primary-action"
                disabled={primary.disabled}
                title={primary.title}
                onClick={primary.onSelect}
              >
                {primary.label}
              </button>
            )}
            {active && run && (
              <button
                disabled={busy || !connected || run.stopRequested}
                onClick={stopCurrentRun}
              >
                {run.stopRequested ? status.label : "停止"}
              </button>
            )}
            {active && !run && (
              <button
                disabled={busy || !connected}
                onClick={withdrawArrangement}
              >
                撤回安排
              </button>
            )}
            {secondary.length > 0 && (
              <ComposerOptions
                below
                label={`更多操作：${artifact.title}`}
                menuLabel="事项操作"
                options={secondary}
              />
            )}
          </div>
          {!compact && status.reason && (
            <p className="task-status-reason">{status.reason}</p>
          )}
          {!compact && dependencies.length > 1 && (
            <div className="task-dependency-actions">
              <span>等待前置事项</span>
              {dependencies.map((a) => (
                <button key={a.taskId} onClick={() => onOpen?.(a.taskId)}>
                  {a.title}
                </button>
              ))}
            </div>
          )}
          {!compact && run && (
            <details className="task-execution-note">
              <summary>执行安排</summary>
              <p>
                使用事项版本 v{run.artifactRevision}
                。停止不会撤回已经产生的结果。
              </p>
              {run.record &&
                !run.sourceStopped &&
                (["queued", "paused"].includes(run.record.status) ||
                  run.hasSourceWatch) && (
                  <button
                    disabled={busy || !connected}
                    onClick={toggleFutureTriggers}
                  >
                    {run.paused ? "恢复后续触发" : "暂停后续触发"}
                  </button>
                )}
            </details>
          )}
        </>
      )}
      {(error || readError || (!compact && (view?.error || run?.error))) && (
        <p className="delivery-error" role="alert">
          {error || readError || view?.error || run?.error}
        </p>
      )}
      {inspect && threadId && (
        <ExecutionDialog
          client={client}
          scope={{
            projectId: thread?.projectId ?? artifact.projectId,
            artifactId: artifact.id,
            conversationId: thread?.conversationId,
            threadId,
            taskRun: true,
          }}
          onClose={closeInspection}
          onOpen={openInspectionContent}
        />
      )}
    </section>
  );
}
