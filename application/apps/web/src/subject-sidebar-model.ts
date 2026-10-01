import type { ConversationRuntime } from "../../../packages/core/src/conversation.js";
import type { TaskRuntime } from "../../../packages/core/src/task-runtime.js";

export type SubjectView = "activity" | "permissions" | "schedules" | "settings";
export function subjectStatus(runtime: ConversationRuntime, online: boolean) {
  if (!online || !runtime.connected) return "暂未连接";
  if (runtime.attention?.available && runtime.attention.approvals.length)
    return "等待你的批准";
  const threads =
    runtime.activity?.threads.filter(
      (t) => t.kind === "execution" && t.lifecycle === "open",
    ) ?? [];
  const count = threads.length;
  if (!runtime.activity?.available) return "状态待核对";
  if (count) {
    const prefix = runtime.activity.truncated ? "至少 " : "";
    if (threads.every((t) => t.controlState === "paused"))
      return `${prefix}${count} 项工作已暂停`;
    const running = threads.filter(
      (t) =>
        t.controlState !== "paused" &&
        ["running", "runnable"].includes(t.phase),
    ).length;
    return running
      ? `${prefix}${running} 项工作正在推进`
      : `${prefix}${count} 项工作等待后续条件`;
  }
  return runtime.activity.truncated ? "状态待核对" : "目前没有进行中的执行";
}
export const objectiveStatus = (status: string) =>
  ({
    active: "推进中",
    paused: "已暂停",
    blocked: "需要处理",
    completed: "已完成",
    cancelled: "已停止",
    failed: "失败",
  })[status] ?? "状态待核对";

/** A saved due date is not a live Agent schedule. Only an exact Runtime run
 * observation can describe an admitted future/repeating/watch execution. */
export function liveArrangement(runtime: TaskRuntime, runNumber: number) {
  const run = runtime.runs.find((r) => r.run === runNumber);
  if (!run || run.error || runtime.error || !run.record || run.sourceStopped)
    return null;
  if (run.record.status === "cancelled") return null;
  if (run.record.status === "completed" && !run.hasSourceWatch) return null;
  if (
    run.record.status === "dispatched" &&
    !run.hasSourceWatch &&
    run.record.interval_seconds === null
  )
    return null;
  return run;
}
