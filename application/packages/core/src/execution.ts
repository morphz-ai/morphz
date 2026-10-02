import { z } from "zod";
import { id } from "./model.js";
export const executionScopeSchema = z
  .object({
    projectId: id,
    artifactId: id.nullable(),
    conversationId: id.optional(),
    inputId: id.optional(),
    threadId: id.optional(),
    taskRun: z.literal(true).optional(),
  })
  .strict();
export type ExecutionScope = z.infer<typeof executionScopeSchema>;
export const jobSchema = z.object({
  id: z.string(),
  revision: z.number().int(),
  session_id: z.string(),
  context_id: z.string(),
  tool_name: z.string(),
  target_id: z.string(),
  thread_id: z.string(),
  status: z.enum([
    "queued",
    "waiting_approval",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "lost",
  ]),
  created_at: z.string(),
  updated_at: z.string(),
  cancel_requested_at: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  exit_code: z.number().nullable().default(null),
  request: z.unknown(),
  result_event_id: z.string().nullable().default(null),
  /** Runtime-verified display metadata; actual Job facts remain unchanged. */
  annotation: z
    .object({ intent: z.string().optional(), result: z.string().optional() })
    .optional(),
});
export const approvalSchema = z.object({
  requested_at: z.string(),
  request: z.object({
    approval_id: z.string(),
    session_id: z.string(),
    context_id: z.string(),
    root_turn_id: z.string().optional(),
    thread_id: z.string().optional(),
    justification: z.string(),
    action: z.record(z.string(), z.unknown()),
    requested: z.record(z.string(), z.unknown()),
  }),
});
/** Authorized read projection of real Runtime Threads, not another activity
 * ledger. Roots and parent links retain each execution's original identity. */
export const executionThreadSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  contextId: z.string(),
  rootId: z.string(),
  parentThreadId: z.string().nullable(),
  title: z.string(),
  summary: z.string().optional(),
  phase: z.string(),
  lifecycle: z.string(),
  controlState: z.string().optional(),
  revision: z.number(),
  createdAt: z.string().optional(),
  updatedAt: z.string(),
});
export type ExecutionThread = z.infer<typeof executionThreadSchema>;
export const executionSnapshotSchema = z.object({
  jobs: z.array(jobSchema),
  approvals: z.array(approvalSchema.extend({ fingerprint: z.string() })),
  limit: z.number(),
  threads: z.array(executionThreadSchema).optional(),
  threadsTruncated: z.boolean().optional(),
});
export const executionAttentionSchema = z.object({
  available: z.boolean(),
  approvals: z.array(
    z.object({
      scope: executionScopeSchema,
      approval: approvalSchema.extend({ fingerprint: z.string() }),
    }),
  ),
});
export type ExecutionAttention = z.infer<typeof executionAttentionSchema>;
export type ExecutionSnapshot = z.infer<typeof executionSnapshotSchema>;
export const executionControlSchema = z
  .object({
    scope: executionScopeSchema,
    action: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("cancel-thread"),
          threadId: id,
          revision: z.number().int().positive(),
        })
        .strict(),
      z
        .object({
          type: z.literal("cancel-job"),
          jobId: id,
          revision: z.number().int().positive(),
        })
        .strict(),
      z
        .object({
          type: z.enum(["allow-once", "deny"]),
          approvalId: id,
          fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ]),
  })
  .strict();
export type ExecutionControl = z.infer<typeof executionControlSchema>;
export const jobStatusLabel: Record<
  z.infer<typeof jobSchema>["status"],
  string
> = {
  queued: "排队中",
  waiting_approval: "等待批准",
  running: "执行中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  lost: "需核对结果",
};
