import { z } from "zod";
import { DomainError } from "../../core/src/model.js";
import { scheduleControlSchema } from "../../core/src/schedule-control.js";
import type { RuntimeRequest } from "./execution.js";

const recordSchema = z.object({
  id: z.string(),
  thread_id: z.string(),
  source_turn_id: z.string(),
  revision: z.number().int().positive(),
  status: z.enum(["queued", "paused", "dispatched", "completed", "cancelled"]),
  not_before: z.string().nullable(),
  interval_seconds: z.number().int().positive().nullable(),
});

type Source = {
  sessionId: string;
  contextId: string;
  threadId: string;
  rootId: string;
  sourceTurnId: string;
  principalId: string;
};

/** The Gateway supplies freshly verified immutable source authority. Every
 * request is wrapped by its current membership/identity recheck; Runtime owns
 * the only Schedule row and its atomic revision check. */
export class RuntimeScheduleControls {
  constructor(
    private request: RuntimeRequest,
    private source: Source,
  ) {}

  async control(raw: unknown) {
    const control = scheduleControlSchema.parse(raw);
    if (control.scope.threadId !== this.source.threadId)
      throw new DomainError("forbidden", "定时任务不属于所选执行。");
    const base = `/api/sessions/${encodeURIComponent(this.source.sessionId)}`;
    const path = `${base}/schedules/${encodeURIComponent(control.scheduleId)}`;
    const current = recordSchema.parse(await this.request(path));
    const matches = (record: z.infer<typeof recordSchema>) =>
      record.id === control.scheduleId &&
      record.thread_id === this.source.threadId &&
      record.source_turn_id === this.source.sourceTurnId;
    if (!matches(current))
      throw new DomainError("forbidden", "定时任务的原始来源不匹配。");
    if (current.revision !== control.revision)
      throw new DomainError("conflict", "定时任务已变化，请核对后重新操作。");
    if (!["queued", "paused"].includes(current.status))
      throw new DomainError(
        "conflict",
        "定时任务已触发或结束，不能调整原安排。",
      );
    z.object({
      snapshot: z.object({
        thread: z.object({
          id: z.literal(this.source.threadId),
          session_id: z.literal(this.source.sessionId),
          context_id: z.literal(this.source.contextId),
          root_turn_id: z.literal(this.source.rootId),
          initiating_principal_id: z.literal(this.source.principalId),
        }),
      }),
    }).parse(
      await this.request(
        `${base}/threads/${encodeURIComponent(this.source.threadId)}`,
      ),
    );
    const result = recordSchema.parse(
      await this.request(path, "POST", {
        action: control.action,
        expected_revision: control.revision,
        ...(control.action === "reschedule"
          ? {
              not_before: control.notBefore,
              interval_seconds: control.intervalSeconds,
            }
          : {}),
      }),
    );
    const desired =
      control.action === "reschedule"
        ? current.status
        : { pause: "paused", resume: "queued", cancel: "cancelled" }[
            control.action
          ];
    if (
      !matches(result) ||
      result.revision <= current.revision ||
      result.status !== desired ||
      (control.action === "reschedule" &&
        (Date.parse(result.not_before ?? "") !==
          Date.parse(control.notBefore) ||
          result.interval_seconds !== control.intervalSeconds))
    )
      throw new DomainError("conflict", "定时任务回执不匹配，请核对最新状态。");
    return {
      accepted: true,
      scheduleId: result.id,
      revision: result.revision,
      status: result.status,
    };
  }
}
