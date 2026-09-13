import { useRef, useState } from "react";
import { Folder, UserRound, CalendarDays, X } from "lucide-react";
import type { Operation, Workspace } from "../../../packages/core/src/model.js";
import type { WorkspaceClient } from "./client.js";
import type { TaskArtifact } from "./task-list.js";
import { localDay } from "./task-list.js";
import {
  taskRunBusy,
  taskPresentation,
} from "../../../packages/core/src/task-runtime.js";
import { ComposerOptions } from "./ComposerOptions.js";

type Changes = Extract<Operation, { type: "arrange-task" }>["changes"];

export function TaskStatusSelect({
  artifact,
  client,
  busy,
  onChange,
}: {
  artifact: TaskArtifact;
  client: WorkspaceClient;
  busy: boolean;
  onChange(a: TaskArtifact, changes: Changes): Promise<void>;
}) {
  if (artifact.content.assigneeId !== client.boot!.actantId) return null;
  return (
    <label
      className="task-property task-human-state"
      title={`修改状态：${artifact.title}`}
    >
      <select
        aria-label="事项状态"
        value={artifact.content.execution}
        disabled={busy || !client.online}
        onChange={(e) =>
          void onChange(artifact, {
            execution: e.target.value as Changes["execution"],
          })
        }
      >
        <option value="planned">待处理</option>
        <option value="active">进行中</option>
        <option value="waiting">等待</option>
        <option value="completed">已完成</option>
        <option value="cancelled">已取消</option>
      </select>
    </label>
  );
}

export function useTaskArrangement(client: WorkspaceClient) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [undo, setUndo] = useState<{
    taskId: string;
    expectedRevision: number;
    changes: Changes;
    title: string;
  } | null>(null);
  async function save(a: TaskArtifact, changes: Changes) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    const previous: Changes = {};
    for (const key of Object.keys(changes) as (keyof Changes)[])
      Object.assign(previous, {
        [key]: key === "projectId" ? a.projectId : a.content[key],
      });
    try {
      await client.execute({
        type: "arrange-task",
        taskId: a.id,
        expectedRevision: a.revision,
        changes,
      });
      setUndo({
        taskId: a.id,
        expectedRevision: a.revision + 1,
        changes: previous,
        title: a.title,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "修改未确认，请重试。");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function revert() {
    if (!undo || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await client.execute({
        type: "arrange-task",
        taskId: undo.taskId,
        expectedRevision: undo.expectedRevision,
        changes: undo.changes,
      });
      setUndo(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "撤销未确认。");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const feedback = (
    <>
      {error && (
        <p role="alert" className="task-list-error">
          {error}
        </p>
      )}
      {undo && (
        <div className="task-completion-feedback" role="status">
          <span>已修改：{undo.title}</span>
          <button
            disabled={busy || !client.online}
            onClick={() => void revert()}
            title="撤销本次安排；不会自动启动执行或撤回已有结果"
          >
            撤销
          </button>
          <button
            className="icon-button"
            aria-label="关闭修改提示"
            onClick={() => setUndo(null)}
          >
            <X />
          </button>
        </div>
      )}
    </>
  );
  return { save, busy, feedback };
}

export function TaskProperties({
  artifact: a,
  state,
  client,
  busy,
  onChange,
  showStatus = true,
}: {
  artifact: TaskArtifact;
  state: Workspace;
  client: WorkspaceClient;
  busy: boolean;
  onChange(a: TaskArtifact, changes: Changes): Promise<void>;
  showStatus?: boolean;
}) {
  const task = a.content;
  const locked = busy || !client.online;
  const running = taskRunBusy(task, client.boot?.taskRuns[a.id]);
  const progress = taskPresentation(
    task,
    state.actants.find((actor) => actor.id === task.assigneeId)?.kind ===
      "human",
    client.boot?.taskRuns[a.id],
  );
  const projects = state.projects.filter(
    (p) =>
      p.members.includes(client.boot!.principalId) &&
      (p.kind === "project" ||
        !p.kind ||
        (p.kind === "inbox" &&
          p.ownerPrincipalId === client.boot!.principalId)),
  );
  const currentProject = state.projects.find((p) => p.id === a.projectId);
  if (currentProject && !projects.some((p) => p.id === a.projectId))
    projects.push(currentProject);
  const actors = state.actants.filter(
    (actor) =>
      (actor.id === client.boot!.actantId ||
        actor.id === "morphz-agent" ||
        actor.id === task.assigneeId) &&
      currentProject?.members.includes(actor.principalId),
  );
  const change = (changes: Changes) => void onChange(a, changes);
  return (
    <div className="task-inline-properties" aria-label={`安排：${a.title}`}>
      <label
        className="task-property"
        title={running ? "先停止执行，再修改项目" : "项目"}
      >
        <Folder />
        <select
          aria-label="项目"
          disabled={locked || running}
          value={a.projectId}
          onChange={(e) => change({ projectId: e.target.value })}
        >
          {projects.map((p) => (
            <option value={p.id} key={p.id}>
              {p.kind === "inbox" ? "无项目" : p.title}
            </option>
          ))}
        </select>
      </label>
      <label
        className="task-property"
        title={
          running ? "先停止执行，再修改负责人" : "负责人；指派不会自动开始执行"
        }
      >
        <UserRound />
        <select
          aria-label="负责人"
          disabled={locked || running}
          value={task.assigneeId}
          onChange={(e) => change({ assigneeId: e.target.value })}
        >
          {actors.map((p) => (
            <option value={p.id} key={p.id}>
              {p.id === client.boot!.actantId ? "我" : p.name}
            </option>
          ))}
        </select>
      </label>
      <div
        className="task-property task-date-property"
        data-overdue={
          !!task.dueDate &&
          task.dueDate < localDay() &&
          !["completed", "cancelled"].includes(progress.state)
        }
      >
        <ComposerOptions
          below
          label="修改截止日期"
          menuLabel="设置截止日期"
          options={[]}
          triggerIcon={
            <>
              <CalendarDays />
              <span>
                {!task.dueDate
                  ? "截止日期"
                  : task.dueDate === localDay()
                    ? "今天"
                    : `${task.dueDate.slice(0, 4) !== localDay().slice(0, 4) ? task.dueDate.slice(0, 4) + "年" : ""}${Number(task.dueDate.slice(5, 7))}月${Number(task.dueDate.slice(8))}日`}
              </span>
            </>
          }
          modelControl={
            <div className="task-date-panel">
              <div className="task-date-shortcuts" aria-label="快捷日期">
                {[0, 1].map((offset) => (
                  <button
                    key={offset}
                    disabled={locked}
                    onClick={() => {
                      const date = new Date();
                      date.setDate(date.getDate() + offset);
                      if (localDay(date) !== task.dueDate)
                        change({ dueDate: localDay(date) });
                    }}
                  >
                    {offset === 0 ? "今天" : "明天"}
                  </button>
                ))}
              </div>
              <label>
                截止日期
                <input
                  aria-label="截止日期"
                  type="date"
                  value={task.dueDate ?? ""}
                  disabled={locked}
                  onChange={(e) => {
                    const value = e.target.value;
                    if (!value || /^\d{4}-\d{2}-\d{2}$/.test(value))
                      change({ dueDate: value || null });
                  }}
                />
              </label>
              <button
                disabled={locked || !task.dueDate}
                onClick={() => change({ dueDate: null })}
              >
                清除日期
              </button>
            </div>
          }
        />
      </div>
      {showStatus && (
        <TaskStatusSelect
          artifact={a}
          client={client}
          busy={busy}
          onChange={onChange}
        />
      )}
    </div>
  );
}

export function TaskArrangement({
  artifact,
  state,
  client,
}: {
  artifact: TaskArtifact;
  state: Workspace;
  client: WorkspaceClient;
}) {
  const edit = useTaskArrangement(client);
  return (
    <div className="task-arrangement">
      <TaskProperties
        artifact={artifact}
        state={state}
        client={client}
        busy={edit.busy}
        onChange={edit.save}
      />
      {edit.feedback}
    </div>
  );
}
