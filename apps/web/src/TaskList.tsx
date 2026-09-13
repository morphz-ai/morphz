import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  Circle,
  CircleDashed,
  Clock3,
  Inbox,
  MessageCircle,
  Plus,
  Search,
  SlidersHorizontal,
  X,
  List,
  Columns3,
  GripVertical,
} from "lucide-react";
import {
  orderedTasks,
  type Workspace,
  type TaskContent,
} from "../../../packages/core/src/model.js";
import type { WorkspaceClient } from "./client.js";
import { ComposerOptions } from "./ComposerOptions.js";
import {
  TaskProperties,
  TaskStatusSelect,
  useTaskArrangement,
} from "./TaskArrangement.js";
import { actorName } from "./client.js";
import { TaskRunPanel } from "./TaskRunPanel.js";
import { taskPresentation } from "../../../packages/core/src/task-runtime.js";
import {
  localDay,
  taskGroups,
  taskOwners,
  taskStates,
  type TaskListOptions,
  type TaskArtifact,
} from "./task-list.js";

export function TaskList({
  state,
  client,
  options,
  onOptions,
  onOpen,
  onCreate,
  toolbarTarget,
}: {
  state: Workspace;
  client: WorkspaceClient;
  options: TaskListOptions;
  onOptions(options: TaskListOptions): void;
  onOpen(id: string): void;
  onCreate(): void;
  toolbarTarget: HTMLElement | null;
}) {
  const [today, setToday] = useState(localDay);
  const edit = useTaskArrangement(client);
  const [dragging, setDragging] = useState<TaskArtifact | null>(null);
  const pointerDrag = useRef<{
    task: TaskArtifact;
    x: number;
    y: number;
    startX: number;
    startY: number;
  } | null>(null);
  const board = options.view === "board";
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState("");
  const [orderUndo, setOrderUndo] = useState<{
    ids: string[];
    revision: number;
    move?: {
      taskId: string;
      expectedRevision: number;
      execution: TaskContent["execution"];
    };
  } | null>(null);
  const [undo, setUndo] = useState<{
    id: string;
    title: string;
    revision: number;
    completed: boolean;
  } | null>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const tick = () => setToday(localDay());
    const timer = setInterval(tick, 60000);
    window.addEventListener("focus", tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", tick);
    };
  }, []);
  useEffect(() => {
    // A completed row leaves the pending list. Keep keyboard navigation in the
    // task surface without taking focus back from intentional navigation.
    if (undo && document.activeElement === document.body)
      undoButton.current?.focus();
  }, [undo]);
  const dateGroups = taskGroups(
    state,
    client.boot!.principalId,
    options,
    today,
    client.boot!.taskRuns,
  );
  const visibleIds = new Set(
    dateGroups.flatMap((g) => g.tasks.map((a) => a.id)),
  );
  const tasks = orderedTasks(state).filter((a) => visibleIds.has(a.id));
  const presented = (a: TaskArtifact) =>
    taskPresentation(
      a.content,
      state.actants.find((p) => p.id === a.content.assigneeId)?.kind ===
        "human",
      client.boot!.taskRuns[a.id],
    );
  const columns = [
    { label: "待处理", status: "planned" },
    { label: "进行中", status: "active" },
    { label: "等待", status: "waiting" },
    { label: "已完成", status: "completed" },
  ] as const;
  const groups = board
    ? [
        ...columns.map((column) => ({
          ...column,
          tasks: tasks.filter((a) => presented(a).state === column.status),
        })),
        ...(tasks.some((a) => presented(a).state === "cancelled")
          ? [
              {
                label: "已取消",
                status: "cancelled" as const,
                tasks: tasks.filter((a) => presented(a).state === "cancelled"),
              },
            ]
          : []),
      ]
    : dateGroups.map((group) => ({ ...group, status: null }));
  const count = tasks.length;
  async function reorder(
    source: TaskArtifact,
    target: TaskArtifact | undefined,
    after = false,
    status?: TaskContent["execution"],
  ) {
    if (pending.current || edit.busy) return;
    if (
      !board &&
      target &&
      !groups.some(
        (g) =>
          g.tasks.some((t) => t.id === source.id) &&
          g.tasks.some((t) => t.id === target.id),
      )
    ) {
      setError(
        "清单按截止日期分组，请在同组内调整顺序；移动到其他日期组请修改截止日期。",
      );
      return;
    }
    const move =
      status && status !== presented(source).state
        ? {
            taskId: source.id,
            expectedRevision: source.revision,
            execution: status,
          }
        : undefined;
    if (move && source.content.assigneeId !== client.boot!.actantId) {
      setError("Morphz 的执行进度不能拖动修改；可以在同一列调整顺序。");
      return;
    }
    const previous = tasks.map((a) => a.id),
      next = previous.filter((id) => id !== source.id);
    const index = target
      ? next.indexOf(target.id) + (after ? 1 : 0)
      : next.length;
    next.splice(Math.max(0, index), 0, source.id);
    if (!move && JSON.stringify(previous) === JSON.stringify(next)) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await client.execute({
        type: "reorder-tasks",
        taskIds: next,
        expectedOrderRevision: state.taskOrderRevision,
        ...(move ? { move } : {}),
      });
      setOrderUndo({
        ids: previous,
        revision: state.taskOrderRevision + 1,
        ...(move
          ? {
              move: {
                ...move,
                expectedRevision: source.revision + 1,
                execution: source.content.execution,
              },
            }
          : {}),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "排序未确认。");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function undoOrder() {
    if (!orderUndo || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await client.execute({
        type: "reorder-tasks",
        taskIds: orderUndo.ids,
        expectedOrderRevision: orderUndo.revision,
        move: orderUndo.move,
      });
      setOrderUndo(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "撤销未确认。");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function complete(
    id: string,
    revision: number,
    completed: boolean,
    title: string,
  ) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await client.execute({
        type: "set-task-completed",
        taskId: id,
        expectedRevision: revision,
        completed,
      });
      setUndo({ id, revision: revision + 1, completed, title });
    } catch (error) {
      setError(error instanceof Error ? error.message : "操作未确认，请重试。");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const ownerSelect = (
    <select
      aria-label="事项负责人筛选"
      value={options.owner}
      onChange={(e) =>
        onOptions({
          ...options,
          owner: e.target.value as TaskListOptions["owner"],
        })
      }
    >
      {Object.entries(taskOwners).map(([key, label]) => (
        <option key={key} value={key}>
          {label}
        </option>
      ))}
    </select>
  );
  const statusSelect = (
    <select
      aria-label="事项状态筛选"
      value={options.status}
      onChange={(e) =>
        onOptions({
          ...options,
          status: e.target.value as TaskListOptions["status"],
        })
      }
    >
      {Object.entries(taskStates).map(([key, label]) => (
        <option key={key} value={key}>
          {label}
        </option>
      ))}
    </select>
  );
  const projectSelect = (
    <select
      aria-label="事项项目筛选"
      value={options.projectId ?? ""}
      onChange={(e) => onOptions({ ...options, projectId: e.target.value })}
    >
      <option value="">全部项目</option>
      {state.projects
        .filter(
          (p) =>
            !p.kind ||
            p.kind === "project" ||
            (p.kind === "inbox" &&
              p.ownerPrincipalId === client.boot!.principalId),
        )
        .map((p) => (
          <option key={p.id} value={p.id}>
            {p.kind === "inbox" ? "无项目" : p.title}
          </option>
        ))}
    </select>
  );
  const search = (
    <label className="search-field task-search">
      <Search aria-hidden="true" />
      <input
        aria-label="搜索事项"
        placeholder="搜索事项"
        maxLength={200}
        value={options.query}
        onChange={(e) => onOptions({ ...options, query: e.target.value })}
      />
    </label>
  );
  return (
    <section
      className={`collection matter-collection task-list${board ? " task-board" : ""}`}
      aria-label="事项列表"
    >
      {toolbarTarget &&
        createPortal(
          <div className="task-list-toolbar">
            <div className="task-view-tabs" role="group" aria-label="事项视图">
              <button
                title="清单"
                aria-label="清单视图"
                aria-pressed={!board}
                onClick={() => onOptions({ ...options, view: "list" })}
              >
                <List />
              </button>
              <button
                title="看板"
                aria-label="看板视图"
                aria-pressed={board}
                onClick={() => onOptions({ ...options, view: "board" })}
              >
                <Columns3 />
              </button>
            </div>
            <div className="task-list-wide">
              <div
                className="task-owner-tabs"
                role="group"
                aria-label="事项负责人"
              >
                {Object.entries(taskOwners).map(([key, label]) => (
                  <button
                    key={key}
                    aria-pressed={options.owner === key}
                    onClick={() =>
                      onOptions({
                        ...options,
                        owner: key as TaskListOptions["owner"],
                      })
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
              {search}
              {statusSelect}
              {projectSelect}
            </div>
            <div className="task-list-narrow">
              <ComposerOptions
                below
                label={`筛选事项：${taskOwners[options.owner]} · ${taskStates[options.status]}`}
                menuLabel="筛选事项"
                triggerIcon={
                  <>
                    <SlidersHorizontal />
                    <span>
                      {taskOwners[options.owner]} · {taskStates[options.status]}
                    </span>
                  </>
                }
                options={[]}
                modelControl={
                  <div className="task-filter-panel">
                    <label>负责人{ownerSelect}</label>
                    <label>状态{statusSelect}</label>
                    <label>项目{projectSelect}</label>
                    {search}
                  </div>
                }
              />
            </div>
            <small className="task-list-count">{count} 项</small>
            <button
              className="secondary-action"
              aria-label="新建事项"
              title="新建事项"
              onClick={onCreate}
            >
              <Plus />
              <span className="toolbar-action-label">新建</span>
            </button>
          </div>,
          toolbarTarget,
        )}
      {error && (
        <p role="alert" className="task-list-error">
          {error}
        </p>
      )}
      {edit.feedback}
      {orderUndo && (
        <div className="task-completion-feedback" role="status">
          <span>已调整顺序</span>
          <button
            disabled={busy || !client.online}
            onClick={() => void undoOrder()}
          >
            撤销
          </button>
          <button
            className="icon-button"
            aria-label="关闭排序提示"
            onClick={() => setOrderUndo(null)}
          >
            <X />
          </button>
        </div>
      )}
      {undo && (
        <div className="task-completion-feedback" role="status">
          <span>
            {undo.completed ? "已完成" : "已重新打开"}：{undo.title}
          </span>
          <button
            ref={undoButton}
            disabled={busy || !client.online}
            title="撤销事项状态，不会撤回已产生的后续执行或结果"
            onClick={() =>
              void complete(undo.id, undo.revision, !undo.completed, undo.title)
            }
          >
            撤销
          </button>
          <button
            className="icon-button"
            aria-label="关闭完成提示"
            onClick={() => setUndo(null)}
          >
            <X />
          </button>
        </div>
      )}
      <div className={board ? "task-board-columns" : "task-list-groups"}>
        {groups.map((group) => (
          <section
            className={`task-date-group${board ? (group.status === "cancelled" ? " task-cancelled-group" : " task-board-column") : ""}`}
            key={group.label}
            aria-label={group.label}
            data-task-state={group.status ?? ""}
            data-task-group={group.label}
            data-drop-target={!!dragging && board}
            onDragOver={(e) => {
              if (dragging) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragging)
                void reorder(
                  dragging,
                  group.tasks.filter((a) => a.id !== dragging.id).at(-1),
                  true,
                  group.status ?? undefined,
                );
              setDragging(null);
            }}
          >
            <h2
              className="task-group-heading"
              data-overdue={group.label === "已逾期"}
            >
              <span>{group.label}</span>
              <small>{group.tasks.length}</small>
            </h2>
            <ul>
              {group.tasks.map((a) => {
                const task = a.content;
                const actor = state.actants.find(
                  (actor) => actor.id === task.assigneeId,
                );
                const own =
                  actor?.kind === "human" &&
                  task.assigneeId === client.boot!.actantId;
                const done = presented(a).state === "completed";
                const ended = done || presented(a).state === "cancelled";
                const status = presented(a).label;
                const canComplete =
                  own &&
                  task.execution !== "cancelled" &&
                  client.boot!.capabilities.taskCompletion;
                const needsResult =
                  !done &&
                  state.artifacts.some(
                    (dependent) =>
                      dependent.content.kind === "task" &&
                      dependent.content.dependsOnIds.includes(a.id) &&
                      !["completed", "cancelled"].includes(
                        dependent.content.execution,
                      ),
                  );
                return (
                  <li
                    className="task-row"
                    key={a.id}
                    data-completed={done}
                    data-task-id={a.id}
                    draggable={!busy && !edit.busy && client.online}
                    onDragStart={(e) => {
                      // The grip owns a captured pointer gesture. Do not let
                      // its draggable ancestor also start a native drag loop,
                      // which can consume pointerup on the desktop host.
                      if (
                        pointerDrag.current ||
                        (e.target as HTMLElement).closest("input, select")
                      ) {
                        e.preventDefault();
                        return;
                      }
                      setDragging(a);
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", a.id);
                    }}
                    onDragEnd={() => setDragging(null)}
                    onDragOver={(e) => {
                      if (dragging) {
                        e.preventDefault();
                        e.stopPropagation();
                        e.dataTransfer.dropEffect = "move";
                      }
                    }}
                    onDrop={(e) => {
                      if (!dragging) return;
                      e.preventDefault();
                      e.stopPropagation();
                      if (dragging.id !== a.id)
                        void reorder(
                          dragging,
                          a,
                          e.clientY >
                            e.currentTarget.getBoundingClientRect().top +
                              e.currentTarget.getBoundingClientRect().height /
                                2,
                          group.status ?? undefined,
                        );
                      setDragging(null);
                    }}
                  >
                    <button
                      className="task-drag-handle"
                      aria-label={`排序：${a.title}`}
                      title={
                        board
                          ? own
                            ? "拖动排序或移到其他状态列；按 ↑ / ↓ 调整顺序"
                            : "同列拖动排序；执行状态由 Morphz 更新"
                          : "同一日期组内拖动排序；按 ↑ / ↓ 调整顺序"
                      }
                      disabled={busy || edit.busy || !client.online}
                      style={{ touchAction: "none" }}
                      onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        e.preventDefault();
                        e.currentTarget.focus();
                        e.currentTarget.setPointerCapture(e.pointerId);
                        pointerDrag.current = {
                          task: a,
                          x: e.clientX,
                          y: e.clientY,
                          startX: e.clientX,
                          startY: e.clientY,
                        };
                      }}
                      onPointerMove={(e) => {
                        const start = pointerDrag.current;
                        if (start) {
                          start.x = e.clientX;
                          start.y = e.clientY;
                        }
                        if (
                          start &&
                          Math.hypot(
                            start.x - start.startX,
                            start.y - start.startY,
                          ) > 6
                        )
                          setDragging(start.task);
                      }}
                      onPointerUp={() => {
                        const start = pointerDrag.current;
                        pointerDrag.current = null;
                        setDragging(null);
                        if (
                          !start ||
                          Math.hypot(
                            start.x - start.startX,
                            start.y - start.startY,
                          ) <= 6
                        )
                          return;
                        const hit = document.elementFromPoint(start.x, start.y);
                        const row = hit?.closest<HTMLElement>("[data-task-id]");
                        const column =
                          hit?.closest<HTMLElement>("[data-task-group]");
                        if (!column) return;
                        const destination = groups.find(
                          (g) => g.label === column.dataset.taskGroup,
                        );
                        const target = row
                          ? tasks.find((t) => t.id === row.dataset.taskId)
                          : destination?.tasks
                              .filter((t) => t.id !== start.task.id)
                              .at(-1);
                        if (target?.id === start.task.id) return;
                        void reorder(
                          start.task,
                          target,
                          row
                            ? start.y >
                                row.getBoundingClientRect().top +
                                  row.getBoundingClientRect().height / 2
                            : true,
                          destination?.status ?? undefined,
                        );
                      }}
                      onPointerCancel={() => {
                        pointerDrag.current = null;
                        setDragging(null);
                      }}
                      onLostPointerCapture={() => {
                        pointerDrag.current = null;
                        setDragging(null);
                      }}
                      onKeyDown={(e) => {
                        if (!["ArrowUp", "ArrowDown"].includes(e.key)) return;
                        e.preventDefault();
                        const index = group.tasks.findIndex(
                          (t) => t.id === a.id,
                        );
                        const target =
                          group.tasks[index + (e.key === "ArrowUp" ? -1 : 1)];
                        if (target)
                          void reorder(a, target, e.key === "ArrowDown");
                      }}
                    >
                      <GripVertical />
                    </button>
                    {canComplete && needsResult ? (
                      <button
                        className="task-toggle"
                        aria-label={`提交结果：${a.title}`}
                        title="此事项关联后续工作，请打开详情提交结果"
                        onClick={() => onOpen(a.id)}
                      >
                        <MessageCircle />
                      </button>
                    ) : canComplete ? (
                      <button
                        className="task-toggle"
                        role="checkbox"
                        aria-checked={done}
                        aria-label={`${done ? "重新打开" : "标记完成"}：${a.title}`}
                        disabled={busy || !client.online}
                        title={
                          done
                            ? "重新打开事项（不撤回已产生的后续执行）"
                            : "标记完成"
                        }
                        onClick={() =>
                          void complete(a.id, a.revision, !done, a.title)
                        }
                      >
                        {done ? <Check /> : <Circle />}
                      </button>
                    ) : (
                      <span className="task-status-icon" title={status}>
                        {done ? (
                          <Check />
                        ) : presented(a).state === "waiting" ? (
                          <Clock3 />
                        ) : (
                          <CircleDashed />
                        )}
                      </span>
                    )}
                    <button
                      className="task-row-open"
                      aria-label={`打开事项：${a.title}`}
                      onClick={() => onOpen(a.id)}
                    >
                      <span className="task-row-copy">
                        <h3>{a.title}</h3>
                        <span className="task-row-details">
                          {!board && (
                            <span>
                              {state.projects.find((p) => p.id === a.projectId)
                                ?.kind === "inbox"
                                ? "无项目"
                                : state.projects.find(
                                    (p) => p.id === a.projectId,
                                  )?.title}
                            </span>
                          )}
                          {!board && options.owner !== "mine" && (
                            <span>{actorName(state, task.assigneeId)}</span>
                          )}
                          {own && needsResult && <span>需提交结果</span>}
                          {(!own ||
                            (board && task.execution !== "planned") ||
                            task.assignment !== "accepted") && (
                            <span
                              title={[status, presented(a).reason]
                                .filter(Boolean)
                                .join("。")}
                            >
                              {status}
                            </span>
                          )}
                        </span>
                      </span>
                      <span className="task-row-trailing">
                        {task.dueDate && (
                          <time
                            dateTime={task.dueDate}
                            className="task-due"
                            data-overdue={!ended && task.dueDate < today}
                            title={`截止日期：${task.dueDate}`}
                          >
                            {board
                              ? !ended && task.dueDate < today
                                ? "已逾期"
                                : ""
                              : task.dueDate === today
                                ? "今天"
                                : task.dueDate.slice(0, 4) === today.slice(0, 4)
                                  ? `${Number(task.dueDate.slice(5, 7))}月${Number(task.dueDate.slice(8))}日`
                                  : task.dueDate}
                          </time>
                        )}
                      </span>
                    </button>
                    {!board && own && (
                      <TaskStatusSelect
                        artifact={a}
                        client={client}
                        busy={busy || edit.busy}
                        onChange={edit.save}
                      />
                    )}
                    {board ? (
                      <TaskProperties
                        artifact={a}
                        state={state}
                        client={client}
                        busy={busy || edit.busy}
                        onChange={edit.save}
                        showStatus={false}
                      />
                    ) : (
                      <ComposerOptions
                        below
                        label={`安排事项：${a.title}`}
                        menuLabel="安排事项"
                        triggerIcon={<SlidersHorizontal />}
                        options={[]}
                        modelControl={
                          <div className="task-arrange-popover">
                            <TaskProperties
                              artifact={a}
                              state={state}
                              client={client}
                              busy={busy || edit.busy}
                              onChange={edit.save}
                              showStatus={false}
                            />
                          </div>
                        }
                      />
                    )}
                    {!own && (
                      <TaskRunPanel
                        compact
                        artifact={a}
                        state={state}
                        client={client}
                        onRespond={() => onOpen(a.id)}
                        onOpen={onOpen}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
      {!count && (
        <div className="empty-state">
          <span className="empty-icon">
            <Inbox />
          </span>
          <h2>
            {options.query.trim()
              ? "没有找到匹配的事项"
              : options.status === "completed"
                ? "还没有已完成事项"
                : options.status === "open"
                  ? "目前没有待处理事项"
                  : "没有符合筛选的事项"}
          </h2>
          {options.query && (
            <button onClick={() => onOptions({ ...options, query: "" })}>
              清除搜索
            </button>
          )}
        </div>
      )}
    </section>
  );
}
