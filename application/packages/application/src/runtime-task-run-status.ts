import { z } from "zod";
import type { AccessContext } from "../../core/src/model.js";
import type { TaskRunLink } from "../../platform/src/store.js";

const runtimeId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const scheduleSchema = z.object({
  id: runtimeId,
  revision: z.number().int().positive(),
  thread_id: runtimeId,
  status: z.enum(["queued", "paused", "dispatched", "completed", "cancelled"]),
  not_before: z.string().nullable(),
  interval_seconds: z.number().int().nonnegative().nullable(),
});
const threadSchema = z.object({
  thread_id: runtimeId,
  session_id: runtimeId,
  root_turn_id: z.string().min(1),
  revision: z.number().int().positive(),
  lifecycle: z.enum(["open", "completed", "failed", "cancelled"]),
});

export type RuntimeTaskRunStatus = {
  source: "runtime";
  runtime: TaskRunLink["runtime"];
  sampledAt: string;
  schedule: {
    revision: number;
    status: z.infer<typeof scheduleSchema>["status"];
    notBefore: string | null;
    intervalSeconds: number | null;
  };
  thread: {
    revision: number;
    lifecycle: z.infer<typeof threadSchema>["lifecycle"];
  };
};

export class RuntimeTaskRunStatusError extends Error {
  constructor(
    readonly reason: "unavailable" | "forbidden" | "mismatch",
    message: string,
  ) {
    super(message);
  }
}

function readFailure(error: unknown, target: "安排" | "Thread") {
  if (
    error &&
    typeof error === "object" &&
    (("status" in error && error.status === 403) ||
      ("code" in error && error.code === "forbidden"))
  )
    return new RuntimeTaskRunStatusError(
      "forbidden",
      "当前身份无权读取这次执行的 Runtime 状态。",
    );
  return new RuntimeTaskRunStatusError(
    "unavailable",
    `暂时无法向 Runtime 确认这次执行的当前${target}。`,
  );
}

/** A trusted Host supplies an authenticated Runtime request function. The
 * Client or model cannot choose a URL, credential, Session, Schedule or Thread.
 * The two reads are separate observations, not an atomic Runtime snapshot. */
export class RuntimeTaskRunStatusReader {
  constructor(
    private readonly request: (
      path: string,
      access: AccessContext,
    ) => Promise<unknown>,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async inspect(
    runtime: TaskRunLink["runtime"],
    access: AccessContext,
  ): Promise<RuntimeTaskRunStatus> {
    const ids = [runtime.sessionId, runtime.scheduleId, runtime.threadId];
    if (ids.some((id) => !runtimeId.safeParse(id).success))
      throw new RuntimeTaskRunStatusError(
        "mismatch",
        "事项执行记录中的 Runtime 引用无效。",
      );
    const base = `/api/sessions/${encodeURIComponent(runtime.sessionId)}`;
    let raw: unknown;
    try {
      raw = await this.request(
        `${base}/schedules/${encodeURIComponent(runtime.scheduleId)}`,
        access,
      );
    } catch (error) {
      throw readFailure(error, "安排");
    }
    const schedule = scheduleSchema.safeParse(raw);
    if (
      !schedule.success ||
      schedule.data.id !== runtime.scheduleId ||
      schedule.data.thread_id !== runtime.threadId
    )
      throw new RuntimeTaskRunStatusError(
        "mismatch",
        "Runtime 返回的安排与事项执行记录不一致。",
      );
    try {
      raw = await this.request(
        `${base}/turns/${encodeURIComponent(`client-schedule-${runtime.scheduleId}`)}/thread`,
        access,
      );
    } catch (error) {
      throw readFailure(error, "Thread");
    }
    const thread = threadSchema.safeParse(raw);
    if (
      !thread.success ||
      thread.data.thread_id !== runtime.threadId ||
      thread.data.session_id !== runtime.sessionId ||
      thread.data.root_turn_id !== `client-schedule-${runtime.scheduleId}`
    )
      throw new RuntimeTaskRunStatusError(
        "mismatch",
        "Runtime 返回的 Thread 与事项执行记录不一致。",
      );
    return {
      source: "runtime",
      runtime,
      sampledAt: this.now(),
      schedule: {
        revision: schedule.data.revision,
        status: schedule.data.status,
        notBefore: schedule.data.not_before,
        intervalSeconds: schedule.data.interval_seconds,
      },
      thread: {
        revision: thread.data.revision,
        lifecycle: thread.data.lifecycle,
      },
    };
  }
}
