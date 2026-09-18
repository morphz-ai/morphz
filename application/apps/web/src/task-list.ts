import type {
  Artifact,
  TaskContent,
  Workspace,
} from "../../../packages/core/src/model.js";
import { orderedTasks } from "../../../packages/core/src/model.js";
import {
  taskPresentation,
  type TaskRuntime,
} from "../../../packages/core/src/task-runtime.js";

export type TaskArtifact = Artifact & { content: TaskContent };
export const taskOwners = {
  mine: "我的",
  agent: "智能体",
  all: "全部",
} as const;
export const taskStates = {
  open: "未完成",
  active: "进行中",
  waiting: "等待",
  completed: "已完成",
  cancelled: "已取消",
  all: "全部状态",
} as const;
export type TaskListOptions = {
  owner: keyof typeof taskOwners;
  status: keyof typeof taskStates;
  query: string;
  view?: "list" | "board";
  projectId?: string;
};
export const defaultTaskList: TaskListOptions = {
  owner: "mine",
  status: "open",
  query: "",
  view: "list",
  projectId: "",
};
export function localDay(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function taskListOptions(
  value?: Partial<TaskListOptions>,
): TaskListOptions {
  return {
    owner:
      value?.owner && Object.hasOwn(taskOwners, value.owner)
        ? value.owner
        : "mine",
    status:
      value?.status && Object.hasOwn(taskStates, value.status)
        ? value.status
        : "open",
    query: typeof value?.query === "string" ? value.query.slice(0, 200) : "",
    view: value?.view === "board" ? "board" : "list",
    projectId: typeof value?.projectId === "string" ? value.projectId : "",
  };
}
export function taskGroups(
  state: Workspace,
  principalId: string,
  options: TaskListOptions,
  today: string,
  runs?: Record<string, TaskRuntime>,
) {
  const words = options.query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const filtered = state.artifacts.filter((a): a is TaskArtifact => {
    if (a.content.kind !== "task") return false;
    const project = state.projects.find((p) => p.id === a.projectId);
    if (
      !project?.members.includes(principalId) ||
      project.deletedAt ||
      project.archivedAt
    )
      return false;
    if (options.projectId && options.projectId !== a.projectId) return false;
    const assigneeId = a.content.assigneeId;
    const actor = state.actants.find((actor) => actor.id === assigneeId);
    if (options.owner === "mine" && actor?.principalId !== principalId)
      return false;
    if (options.owner === "agent" && actor?.kind !== "agent") return false;
    const execution = runs
      ? taskPresentation(a.content, actor?.kind === "human", runs[a.id]).state
      : a.content.execution;
    if (
      options.status === "open"
        ? ["completed", "cancelled"].includes(execution)
        : options.status !== "all" && execution !== options.status
    )
      return false;
    const haystack =
      `${a.title}\n${a.content.description}\n${project.title}`.toLocaleLowerCase();
    return words.every((word) => haystack.includes(word));
  });
  const group = (a: TaskArtifact) => {
    const execution = runs
      ? taskPresentation(
          a.content,
          state.actants.find((actor) => actor.id === a.content.assigneeId)
            ?.kind === "human",
          runs[a.id],
        ).state
      : a.content.execution;
    return execution === "completed"
      ? "已完成"
      : execution === "cancelled"
        ? "已取消"
        : !a.content.dueDate
          ? "未设截止日期"
          : a.content.dueDate < today
            ? "已逾期"
            : a.content.dueDate === today
              ? "今天到期"
              : "之后到期";
  };
  const order = new Map(orderedTasks(state).map((a, index) => [a.id, index]));
  return ["已逾期", "今天到期", "之后到期", "未设截止日期", "已完成", "已取消"]
    .map((label) => ({
      label,
      tasks: filtered
        .filter((a) => group(a) === label)
        .sort((a, b) => order.get(a.id)! - order.get(b.id)!),
    }))
    .filter((g) => g.tasks.length);
}
export function taskStatusLabel(value: TaskContent, human: boolean) {
  if (value.execution === "completed") return "已完成";
  if (value.execution === "cancelled") return "已取消";
  if (value.assignment === "declined") return "待重新安排";
  if (value.assignment === "proposed") return "待接受";
  return {
    planned: human ? "待处理" : "已计划",
    active: "进行中",
    waiting: "等待",
  }[value.execution];
}
