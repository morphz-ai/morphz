import { z } from "zod";
import { DomainError } from "../../core/src/model.js";
import type { InputContinuation } from "../../core/src/continuation.js";

export class ContinuationConflict extends DomainError {
  constructor(readonly reason: "closed" | "changed") {
    super(
      "conflict",
      reason === "closed"
        ? "这项工作已结束或暂停，未接收补充。草稿已保留，可以作为后续请求继续。"
        : "这项工作的执行代次已变化，未接收补充。请重新选择补充目标，草稿已保留。",
    );
  }
}
export class SupplementUnconfirmed extends Error {
  constructor() {
    super(
      "补充的送达结果尚未确认，草稿已保留。重试会核对同一次投递，不会重复发送。",
    );
  }
}
const routing = z.object({
  generation: z.number().int().positive(),
  control_state: z.literal("active"),
  lifecycle: z.literal("open"),
  kind: z.string().refine((v) => v !== "delivery"),
  executor_kind: z.string(),
  supervision: z
    .object({
      supervisor_kind: z.string(),
      supervisor_id: z.string().nullable(),
      generation: z.number().int().positive(),
      origin_evaluation_id: z.string().nullable(),
    })
    .optional(),
});
export function continuationTarget(
  raw: unknown,
  inputId: string,
  threadId: string,
): InputContinuation | undefined {
  const parsed = routing.safeParse(raw);
  if (!parsed.success) return;
  const t = parsed.data,
    s = t.supervision;
  const primary =
    s?.supervisor_kind === "objective" &&
    !s.origin_evaluation_id &&
    s.supervisor_id;
  if (t.executor_kind !== "self" && !primary) return;
  return {
    mode: "supplement",
    inputId,
    threadId,
    generation: t.generation,
    ...(primary
      ? { objective: { id: primary, generation: s!.generation } }
      : {}),
  };
}
