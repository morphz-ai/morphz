import type { ConversationRuntime } from "../../../packages/core/src/conversation.js";
import type { TaskRuntime } from "../../../packages/core/src/task-runtime.js";
import type { ConversationStream } from "../../../packages/core/src/live-conversation.js";
import { isPendingResponse } from "./conversation-presentation.js";

export type SubjectView = "activity" | "permissions" | "schedules" | "settings";

export type SubjectLogoState = {
  state:
    | "working"
    | "processing"
    | "approval"
    | "paused"
    | "waiting"
    | "idle"
    | "unknown";
  label: string;
  working: boolean;
  processing?: boolean;
  view: "activity" | "permissions";
};

/** A subject's presence is not a network light or a background-task count.
 * Dialogue generation is real work too. Delivery acceptance is not proof of
 * execution, and pausing future activations does not stop an existing step. */
export function subjectLogoState(
  runtime: ConversationRuntime,
  online: boolean,
  stream?: ConversationStream,
  outputInputIds: readonly string[] = [],
): SubjectLogoState {
  const result = (
    state: SubjectLogoState["state"],
    label: string,
    working = false,
    processing = false,
  ): SubjectLogoState => ({
    state,
    label,
    working,
    processing,
    view: state === "approval" ? "permissions" : "activity",
  });
  if (!online || !runtime.connected)
    return result("unknown", "暂无法读取工作状态");
  const activity = runtime.activity;
  const open = activity?.available
    ? activity.threads.filter((thread) => thread.lifecycle === "open")
    : [];
  const known = open.filter((thread) =>
    ["execution", "dialogue_turn"].includes(thread.kind ?? ""),
  );
  const running = known.filter((thread) => thread.phase === "running");
  // Public stream events are actual model activity, not delivery acceptance.
  // A short reply can otherwise start and finish between scheduler polls.
  const responding =
    !!stream?.connected &&
    stream.messages.some(
      (message) =>
        message.streaming &&
        (message.kind === "tool" ||
          (message.kind === "reply" && !!message.text.trim())),
    );
  // A Runtime acceptance is not proof of model/tool execution. It is however
  // the same observable pending-response stage shown by Conversation before
  // the first visible token. Keep this distinct from a future scheduled wait.
  const answered = new Set(outputInputIds);
  for (const message of [
    ...runtime.messages,
    ...(stream?.connected ? stream.messages : []),
  ])
    if (
      message.inputId &&
      ["reply", "error"].includes(message.kind) &&
      message.text.trim()
    )
      answered.add(message.inputId);
  const pending = runtime.configured
    ? runtime.deliveries.filter(
        (delivery) =>
          !delivery.cancelRequested &&
          isPendingResponse({
            configured: runtime.configured,
            delivery,
            answered: answered.has(delivery.inputId),
            approvalPending:
              runtime.attention?.approvals.some(
                (approval) => approval.scope.inputId === delivery.inputId,
              ) ?? false,
          }),
      )
    : [];
  const processing = pending.some((delivery) => delivery.state === "running");
  if (runtime.attention?.available && runtime.attention.approvals.length)
    return result(
      "approval",
      running.length || responding
        ? "有操作等待你的批准，其他工作仍在进行"
        : "有操作等待你的批准",
      running.length > 0 || responding,
      processing,
    );
  if (responding) return result("working", "正在回应你", true);
  if (running.length) {
    const paused = running.filter((thread) => thread.controlState === "paused");
    return result(
      "working",
      paused.length === running.length
        ? "当前步骤仍在执行，后续已暂停"
        : paused.length
          ? "正在工作，部分后续步骤已暂停"
          : running.every((thread) => thread.kind === "dialogue_turn")
            ? "正在回应你"
            : "正在工作",
      true,
    );
  }
  if (processing) return result("processing", "正在处理你的输入", false, true);
  if (pending.length)
    return result(
      "waiting",
      pending.some((delivery) => delivery.state === "sending")
        ? "正在发送你的输入"
        : "输入等待处理",
    );
  if (!activity?.available) return result("unknown", "工作状态待核对");
  const advancing = known.filter((thread) => thread.controlState !== "paused");
  if (advancing.some((thread) => thread.phase === "runnable"))
    return result("waiting", "工作待推进");
  if (advancing.some((thread) => ["waiting", "idle"].includes(thread.phase)))
    return result("waiting", "等待后续条件");
  if (open.length !== known.length || advancing.length)
    return result("unknown", "工作状态待核对");
  if (known.length) return result("paused", "有工作已暂停");
  const objectives = activity.objectives ?? [];
  if (
    objectives.some((goal) =>
      ["active", "paused", "blocked"].includes(goal.status),
    )
  )
    return result("waiting", "有目标等待推进或处理");
  if (
    (activity.openWorkComplete === undefined
      ? activity.truncated || activity.objectivesTruncated
      : !activity.openWorkComplete) ||
    !runtime.attention?.available ||
    objectives.some(
      (goal) => !["completed", "cancelled", "failed"].includes(goal.status),
    )
  )
    return result("unknown", "工作状态待核对");
  return result("idle", "目前没有进行中的工作");
}

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
  const incomplete =
    runtime.activity.openWorkComplete === undefined
      ? runtime.activity.truncated
      : !runtime.activity.openWorkComplete;
  if (count) {
    const prefix = incomplete ? "至少 " : "";
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
  return incomplete ? "状态待核对" : "目前没有进行中的执行";
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

/** Use the scheduler's structured state, never parse its diagnostic prose or
 * rewrite the persisted Agent intent. The original reason remains inspectable. */
export function objectiveDetailStatus(status: string, readiness: string) {
  if (status !== "active") return objectiveStatus(status);
  return (
    {
      runnable: "等待推进",
      waiting: "等待关联工作或条件",
      leased: "正在评估进展",
      suspended: "等待恢复推进",
      paused: "已暂停",
      blocked: "需要处理",
    }[readiness] ?? "状态待核对"
  );
}

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
