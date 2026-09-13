import { z } from "zod";
import type { TaskContent } from "./model.js";

export const taskRuntimeSchema = z.object({
  error: z.string().default(""),
  approvalCount: z.number().int().nonnegative().optional(),
  blockers: z
    .array(
      z.object({
        taskId: z.string(),
        title: z.string(),
        assigneeName: z.string(),
        reason: z.enum([
          "response",
          "not-started",
          "running",
          "failed",
          "cancelled",
        ]),
      }),
    )
    .optional(),
  runs: z
    .array(
      z.object({
        run: z.number(),
        artifactRevision: z.number(),
        record: z
          .object({
            revision: z.number(),
            thread_id: z.string().optional(),
            status: z.enum([
              "queued",
              "paused",
              "dispatched",
              "completed",
              "cancelled",
            ]),
            interval_seconds: z.number().nullable(),
          })
          .nullable(),
        error: z.string().default(""),
        paused: z.boolean().default(false),
        sourceStopped: z.boolean().default(false),
        controlRevision: z.number(),
        hasSourceWatch: z.boolean().default(false),
        controlPending: z.string().nullable().default(null),
        stopRequested: z.boolean().default(false),
        threadState: z
          .enum(["open", "completed", "failed", "cancelled"])
          .nullable(),
      }),
    )
    .default([]),
});
export type TaskRuntime = z.infer<typeof taskRuntimeSchema>;

/** Conservative: an unacknowledged request is not permission to start another. */
export function taskRunBusy(task: TaskContent, runtime?: TaskRuntime) {
  if (!task.runRequested) return false;
  const run = runtime?.runs.find((r) => r.run === task.runRequested);
  if (!run) return true;
  if (run.controlPending || run.stopRequested) return true;
  if (run.threadState === "open") return true;
  if (!run.record) return !run.sourceStopped;
  if (
    !run.sourceStopped &&
    (run.hasSourceWatch || run.record.interval_seconds !== null)
  )
    return true;
  if (["queued", "paused"].includes(run.record.status)) return true;
  return run.record.status === "dispatched" && !run.threadState;
}

/** The board is a projection, never an execution engine. */
export function taskPresentation(
  task: TaskContent,
  human: boolean,
  runtime?: TaskRuntime,
) {
  const result = (
    state: TaskContent["execution"],
    label: string,
    reason = "",
  ) => ({ state, label, reason });
  if (human)
    return result(
      task.execution,
      {
        planned: "待处理",
        active: "进行中",
        waiting: "等待 · 未说明原因",
        completed: "已完成",
        cancelled: "已取消",
      }[task.execution],
    );
  const run = runtime?.runs.find((r) => r.run === task.runRequested);
  if (run?.stopRequested) return result("active", "正在停止");
  if (run?.threadState === "open" && runtime?.approvalCount)
    return result("waiting", "等待你的确认", "确认具体操作后才能继续执行。");
  if (run?.threadState === "open")
    return task.execution === "waiting"
      ? result(
          "waiting",
          "等待 · 未说明原因",
          "事项被标为等待，但没有可核实的前置事项或待确认操作。请补充说明。",
        )
      : result("active", "正在执行");
  if (task.execution === "cancelled") return result("cancelled", "已取消");
  if (run?.threadState === "failed")
    return result(
      "planned",
      "执行失败",
      "查看失败记录后可重试；已有结果保留。",
    );
  if (run?.threadState === "cancelled") return result("planned", "已停止");
  if (task.execution === "completed") return result("completed", "已完成");
  if (run?.threadState === "completed")
    return result(
      "planned",
      "执行结束 · 事项未完成",
      "本次执行已结束，但事项尚未完成。查看已有结果或执行记录，再决定是否补充要求。",
    );
  const blockers = runtime?.blockers ?? [];
  // Dependencies describe an admitted/requested run, not an instruction to
  // start an unrequested task or resurrect an ended run.
  if (task.runRequested && blockers.length) {
    const first = blockers[0]!;
    const prefix = {
      response: `等${first.assigneeName}提交结果`,
      "not-started": "前置事项未开始",
      running: "等待前置事项完成",
      failed: "前置事项执行失败",
      cancelled: "前置事项已取消",
    }[first.reason];
    return result(
      "waiting",
      `${prefix}：${first.title}${blockers.length > 1 ? ` 等 ${blockers.length} 项` : ""}`,
      "打开前置事项查看或处理；满足条件后会按已提交的安排继续。",
    );
  }
  if (!task.runRequested)
    return task.execution === "waiting"
      ? result(
          "waiting",
          "等待 · 未说明原因",
          "尚未请求执行，也没有可核实的等待原因。请先补充说明，或明确开始执行。",
        )
      : result("planned", "待开始");
  if (runtime?.error || run?.error)
    return result("planned", "执行安排异常", runtime?.error || run?.error);
  return result(
    "planned",
    run?.paused
      ? "已暂停"
      : run?.record?.status === "queued"
        ? "已排队"
        : "正在确认执行安排",
  );
}
