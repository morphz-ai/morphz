import { useRef, useState } from "react";
import type { Artifact, Workspace } from "../../../packages/core/src/model.js";
import {
  taskPresentation,
  taskRunBusy,
  taskRuntimeSchema,
  type TaskRuntime,
} from "../../../packages/core/src/task-runtime.js";
import type { WorkspaceClient } from "./client.js";
import { ExecutionDialog } from "./ExecutionDialog.js";
import { ComposerOptions, type ComposerOption } from "./ComposerOptions.js";
import { FileText, ListChecks, Play, X } from "lucide-react";
import { useObservedRead } from "./useObservedRead.js";

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
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [localReadError, setReadError] = useState("");
  const readError = runtimeObserved ? (runtimeReadError ?? "") : localReadError;
  const [live, setLive] = useState<{
    scope: string;
    taskId: string;
    taskRevision: number;
    view: TaskRuntime;
  } | null>(null);
  const [loadedResponses, setLoadedResponses] = useState<{
    scope: string;
    taskId: string;
    taskRevision: number;
    items: Workspace["taskResponses"];
  } | null>(null);
  const api = useRef(client);
  api.current = client;
  const [inspect, setInspect] = useState(false);
  const task = artifact.content;
  const isTask = task.kind === "task";
  const taskRunRequested = isTask ? task.runRequested : 0;
  const human =
    isTask &&
    state.actants.find((a) => a.id === task.assigneeId)?.kind === "human";
  const observationScope = JSON.stringify([
    client.boot?.centerId,
    client.boot?.principalId,
    client.boot?.csrfToken,
    artifact.id,
    artifact.revision,
    taskRunRequested,
  ]);
  useObservedRead({
    scope: observationScope,
    enabled:
      isTask &&
      !human &&
      !!taskRunRequested &&
      client.online &&
      !runtimeObserved,
    revision: client.workspaceChangeRevision,
    read: async (signal) =>
      taskRuntimeSchema.parse(
        await api.current.taskRuntime(artifact.id, undefined, {
          signal,
          isCurrent: () => !signal.aborted,
        }),
      ),
    publish: (view) => {
      setLive({
        scope: observationScope,
        taskId: artifact.id,
        taskRevision: artifact.revision,
        view,
      });
      setReadError("");
    },
    failed: (cause) =>
      setReadError(
        cause instanceof Error ? cause.message : "无法读取执行状态。",
      ),
  });
  useObservedRead({
    scope: observationScope,
    enabled: isTask && !!human && !compact && client.online,
    revision: client.workspaceChangeRevision,
    read: () => api.current.taskResponses(artifact.id),
    publish: (items) => {
      setLoadedResponses({
        scope: observationScope,
        taskId: artifact.id,
        taskRevision: artifact.revision,
        items,
      });
      setReadError("");
    },
    failed: (cause) =>
      setReadError(
        cause instanceof Error ? cause.message : "无法读取事项回应。",
      ),
  });
  if (!isTask) return null;
  const view =
    live?.scope === observationScope &&
    live.taskId === artifact.id &&
    live.taskRevision === artifact.revision
      ? live.view
      : client.boot?.taskRuns[artifact.id];
  const run = view?.runs.find((r) => r.run === task.runRequested);
  const active = taskRunBusy(task, view);
  const status = taskPresentation(task, !!human, view);
  const connected = client.online && client.boot?.capabilities.runtime;
  const responses =
    loadedResponses?.scope === observationScope &&
    loadedResponses.taskId === artifact.id &&
    loadedResponses.taskRevision === artifact.revision
      ? loadedResponses.items
      : [];
  const responsesLoading =
    human &&
    !compact &&
    client.online &&
    (loadedResponses?.scope !== observationScope ||
      loadedResponses.taskId !== artifact.id ||
      loadedResponses.taskRevision !== artifact.revision) &&
    !readError;
  const canRespond =
    human &&
    client.boot?.actantId === task.assigneeId &&
    !["completed", "cancelled"].includes(task.execution);
  const thread = client.boot?.runtime.activity?.threads.find(
    (t) => t.id === run?.record?.thread_id,
  );
  const threadId = run?.record?.thread_id;
  const attention =
    client.boot?.runtime.attention?.approvals.filter(
      (a) => a.scope.threadId === run?.record?.thread_id,
    ) ?? [];
  const dependencies = status.state === "waiting" ? (view?.blockers ?? []) : [];
  async function perform(action: () => Promise<unknown>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
      await client.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作尚未确认，请核对状态。");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const start: ComposerOption = {
    label:
      run?.threadState === "failed"
        ? "重试"
        : run || ["completed", "cancelled"].includes(task.execution)
          ? "重新执行"
          : "开始",
    icon: <Play />,
    disabled: busy || !connected,
    title: !connected
      ? "连接智能体后可以开始执行"
      : "按当前事项开始一次新的执行，已有结果保留",
    onSelect: () =>
      void perform(() =>
        client.execute({
          type: "request-task-run",
          taskId: artifact.id,
          expectedRevision: artifact.revision,
        }),
      ),
  };
  const records: ComposerOption = {
    label: "执行记录",
    icon: <ListChecks />,
    onSelect: () => setInspect(true),
  };
  const results: ComposerOption = {
    label: "查看结果",
    icon: <FileText />,
    onSelect: () =>
      onOpen?.(task.resultIds.length === 1 ? task.resultIds[0]! : artifact.id),
  };
  const detail: ComposerOption = {
    label: "查看事项",
    icon: <FileText />,
    onSelect: () => onOpen?.(artifact.id),
  };
  let primary: ComposerOption | undefined;
  if (
    attention.length &&
    threadId &&
    run?.threadState === "open" &&
    !run.stopRequested
  )
    primary = { ...records, label: `处理确认 (${attention.length})` };
  else if (dependencies.length && onOpen)
    primary = {
      ...detail,
      label: "查看前置事项",
      onSelect: () => onOpen(dependencies[0]!.taskId),
    };
  else if (active)
    primary = threadId
      ? { ...records, label: "查看进度" }
      : compact
        ? detail
        : undefined;
  else if (run?.threadState === "failed") primary = start;
  else if (task.resultIds.length && onOpen) primary = results;
  else if (run?.threadState === "completed" && threadId) primary = records;
  else if (status.state === "waiting")
    primary = compact ? { ...detail, label: "查看原因" } : undefined;
  else if (task.execution !== "cancelled" && task.execution !== "completed")
    primary = start;
  const secondary: ComposerOption[] = [];
  if (!active && primary !== start) secondary.push(start);
  if (threadId && primary?.onSelect !== records.onSelect)
    secondary.push(records);
  if (task.resultIds.length && onOpen && primary !== results)
    secondary.push(results);
  if (!active && !["cancelled", "completed"].includes(task.execution))
    secondary.push({
      label: "取消事项",
      icon: <X />,
      disabled: busy || !client.online,
      onSelect: () =>
        void perform(() =>
          client.execute({
            type: "cancel-task",
            taskId: artifact.id,
            expectedRevision: artifact.revision,
          }),
        ),
    });
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
                onClick={() =>
                  void perform(() =>
                    client.taskRuntime(artifact.id, {
                      run: run.run,
                      revision: run.controlRevision,
                      action: "stop",
                    }),
                  )
                }
              >
                {run.stopRequested ? status.label : "停止"}
              </button>
            )}
            {active && !run && (
              <button
                disabled={busy || !connected}
                onClick={() =>
                  void perform(() =>
                    client.taskRuntime(artifact.id, {
                      run: task.runRequested,
                      revision: 1,
                      action: "stop",
                    }),
                  )
                }
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
                    onClick={() =>
                      void perform(() =>
                        client.taskRuntime(artifact.id, {
                          run: run.run,
                          revision: run.controlRevision,
                          action: run.paused ? "resume" : "pause",
                        }),
                      )
                    }
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
          onClose={() => setInspect(false)}
          onOpen={(id) => {
            setInspect(false);
            onOpen?.(id);
          }}
        />
      )}
    </section>
  );
}
