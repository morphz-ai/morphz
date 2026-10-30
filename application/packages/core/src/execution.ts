import { z } from "zod";
import { executionModelSchema } from "./inference.js";
import { id } from "./model.js";
import { pendingUserInputRequestSchema } from "./user-input.js";
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
/** Immutable Runtime delegation edge. Display association is not permission
 * to control either Session; the Host revalidates this fact on every read. */
export const delegationLinkSchema = z
  .object({
    id,
    requestEventId: id,
    parentSessionId: id,
    parentContextId: id,
    parentThreadId: id,
  })
  .strict();
export type DelegationLink = z.infer<typeof delegationLinkSchema>;
/** An execution reference authorizes no mutation or project access. The Host
 * verifies ownership against Runtime facts on every read, not this request. */
export const runtimeExecutionReadScopeSchema = z
  .object({
    runtime: z
      .object({
        sessionId: id,
        contextId: id,
        delegation: delegationLinkSchema.optional(),
      })
      .strict(),
    threadId: id,
    artifactId: z.null(),
    projectId: z.undefined().optional(),
    conversationId: z.undefined().optional(),
    inputId: z.undefined().optional(),
    taskRun: z.undefined().optional(),
  })
  .strict();
export const executionReadScopeSchema = z.union([
  executionScopeSchema,
  runtimeExecutionReadScopeSchema,
]);
export type ExecutionReadScope = z.infer<typeof executionReadScopeSchema>;
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
  approval_ref: z.string().nullable().optional(),
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
    lease_offer: z
      .object({
        principal_id: z.string(),
        agent_id: z.string(),
        session_id: z.string(),
        thread_id: z.string(),
        scope: z.enum(["thread", "objective", "session"]),
        scope_id: z.string(),
        objective_id: z.string().optional(),
        target_id: z.string(),
        capability: z.string(),
        capabilities: z.array(z.string()).default([]),
        requested: z.record(z.string(), z.unknown()),
        policy_digest: z.string(),
        duration_secs: z.number().int().nonnegative(),
      })
      .optional(),
  }),
});
/** Authorized read projection of real Runtime Threads, not another activity
 * ledger. Roots and parent links retain each execution's original identity. */
export const executionThreadSchema = z.object({
  executionModel: executionModelSchema.nullable().optional(),
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
  /** Current, exact Runtime scheduler facts; absent means unknown. */
  waitKinds: z.array(z.string()).optional(),
  waitUntil: z.string().optional(),
  /** Exact pending Runtime question, not text inferred from progress. */
  userInputRequest: pendingUserInputRequestSchema.optional(),
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
    scope: executionReadScopeSchema,
    action: z.discriminatedUnion("type", [
      z
        .object({
          type: z.enum(["cancel-thread", "pause-thread", "resume-thread"]),
          threadId: id,
          revision: z.number().int().positive(),
        })
        .strict(),
      z
        .object({
          type: z.literal("supersede-thread"),
          threadId: id,
          revision: z.number().int().positive(),
          intent: z.string().trim().min(1).max(64000),
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
          type: z.enum([
            "allow-once",
            "deny",
            "allow-objective",
            "allow-session",
          ]),
          approvalId: id,
          fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
      z.object({ type: z.literal("cancel-delegation") }).strict(),
    ]),
  })
  .strict()
  .superRefine(({ scope, action }, context) => {
    const runtime = "runtime" in scope;
    const delegated = runtime && !!scope.runtime.delegation;
    const threadAction = [
      "cancel-thread",
      "pause-thread",
      "resume-thread",
      "supersede-thread",
    ].includes(action.type);
    if (
      (delegated && action.type !== "cancel-delegation") ||
      (action.type === "cancel-delegation" && !delegated) ||
      (runtime && !delegated && !threadAction)
    )
      context.addIssue({
        code: "custom",
        path: ["action"],
        message: "控制动作与执行来源不匹配。",
      });
  });
export type ExecutionControl = z.infer<typeof executionControlSchema>;
export type ExecutionThreadControl = Extract<
  ExecutionControl["action"],
  { threadId: string }
>;
export function isExecutionThreadControl(
  action: ExecutionControl["action"],
): action is ExecutionThreadControl {
  return "threadId" in action;
}
export type ExecutionApprovalControl = Extract<
  ExecutionControl["action"],
  { approvalId: string }
>;
export function isExecutionApprovalControl(
  action: ExecutionControl["action"],
): action is ExecutionApprovalControl {
  return "approvalId" in action;
}
/** Reusable grants require an actual, finite Runtime offer. A displayed
 * goal association is not proof of causal supervision of this approval. */
export function reusableApprovalScopes(
  approval: z.infer<typeof approvalSchema>,
  jobs: z.infer<typeof jobSchema>[] = [],
): ("objective" | "session")[] {
  const request = approval.request,
    offer = request.lease_offer;
  if (
    !offer ||
    offer.session_id !== request.session_id ||
    offer.thread_id !== request.thread_id ||
    !(offer.duration_secs > 0)
  )
    return [];
  const objective =
    offer.scope === "objective" ||
    !!offer.objective_id ||
    jobs.some((job) => {
      const value = job.request;
      return (
        job.approval_ref === request.approval_id &&
        job.session_id === request.session_id &&
        job.context_id === request.context_id &&
        job.thread_id === request.thread_id &&
        !!value &&
        typeof value === "object" &&
        "_morphz_capability_lease_objective_id" in value &&
        typeof value._morphz_capability_lease_objective_id === "string" &&
        !!value._morphz_capability_lease_objective_id
      );
    });
  return objective ? ["objective", "session"] : ["session"];
}
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
