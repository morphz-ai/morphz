import { useRef, useState } from "react";
import type {
  Artifact,
  Workspace,
} from "../../../../../packages/core/src/model.js";
import {
  taskPresentation,
  taskRunBusy,
  taskRuntimeSchema,
  type TaskRuntime,
} from "../../../../../packages/core/src/task-runtime.js";
import type { WorkspaceClient } from "../../client.js";
import type { ComposerOption } from "../../ComposerOptions.js";
import { FileText, ListChecks, Play, X } from "lucide-react";
import { useObservedRead } from "../../useObservedRead.js";

type TaskRunPanelClient = Pick<
  WorkspaceClient,
  | "boot"
  | "online"
  | "workspaceChangeRevision"
  | "taskRuntime"
  | "taskResponses"
  | "execute"
  | "refresh"
>;

// Observations read the latest client through api; actions and their following
// refresh retain the client and artifact captured by the original render.
export function useTaskRunPanel({
  artifact,
  state,
  client,
  onOpen,
  compact,
  runtimeObserved,
  runtimeReadError,
}: {
  artifact: Artifact;
  state: Pick<Workspace, "actants">;
  client: TaskRunPanelClient;
  onOpen?: (id: string) => void;
  compact: boolean;
  runtimeObserved: boolean;
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
  const stopCurrentRun = () =>
    void perform(() =>
      client.taskRuntime(artifact.id, {
        run: run!.run,
        revision: run!.controlRevision,
        action: "stop",
      }),
    );
  const withdrawArrangement = () =>
    void perform(() =>
      client.taskRuntime(artifact.id, {
        run: task.runRequested,
        revision: 1,
        action: "stop",
      }),
    );
  const toggleFutureTriggers = () =>
    void perform(() =>
      client.taskRuntime(artifact.id, {
        run: run!.run,
        revision: run!.controlRevision,
        action: run!.paused ? "resume" : "pause",
      }),
    );
  const closeInspection = () => setInspect(false);
  const openInspectionContent = (id: string) => {
    setInspect(false);
    onOpen?.(id);
  };
  return {
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
  } as const;
}
