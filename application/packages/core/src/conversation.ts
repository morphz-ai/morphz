import { z } from "zod";
import { executionModelSchema } from "./inference.js";
import { modelActivitySchema } from "./model-activity.js";
import { runtimeMessageFailureSchema } from "./runtime-message-failure.js";
import {
  evaluationResultSchema,
  evaluationSourceSchema,
} from "./evaluation-result.js";
import { providerRecoverySchema } from "./provider-recovery.js";
import { executionAttentionSchema, delegationLinkSchema } from "./execution.js";
import { continuationSchema } from "./continuation.js";
export const artifactOutputSchema = z.object({
  commandId: z.string(),
  inputId: z.string(),
  projectId: z.string(),
  artifactId: z.string(),
  revision: z.number().int().positive(),
  createdAt: z.string(),
});
export type ArtifactOutput = z.infer<typeof artifactOutputSchema>;
/** Read-only Runtime inventory. Source IDs are verified persisted links, not
 * renderer-selected scope or a second Host schedule/timer authority. */
export const runtimeScheduleSchema = z.object({
  scheduleId: z.string(),
  threadId: z.string(),
  sessionId: z.string(),
  contextId: z.string(),
  rootId: z.string(),
  inputId: z.string(),
  sourceTurnId: z.string(),
  sourceRootId: z.string(),
  projectId: z.string(),
  conversationId: z.string(),
  status: z.enum(["queued", "paused", "dispatched", "completed", "cancelled"]),
  revision: z.number().int().positive(),
  notBefore: z.string().nullable(),
  intervalSeconds: z.number().int().positive().nullable(),
  dependencyThreadIds: z.array(z.string()),
  intent: z.string(),
  updatedAt: z.string(),
});
export type RuntimeSchedule = z.infer<typeof runtimeScheduleSchema>;
export const activitySchema = z.object({
  available: z.boolean(),
  /** Read observations, not execution/control authority. A failed Context must
   * not erase another Context's successfully read current work. */
  readScopes: z
    .array(
      z.object({
        contextId: z.string().min(1),
        currentAvailable: z.boolean(),
        historyAvailable: z.boolean(),
      }),
    )
    .optional(),
  truncated: z.boolean().default(false),
  /** Current open threads/Objectives were fully read in the authorized domain.
   * Independent of the bounded terminal activity history; absent is unknown. */
  openWorkComplete: z.boolean().optional(),
  /** Per Context snapshot bound, not a claim of complete execution history. */
  limit: z.number().int().positive().optional(),
  objectivesTruncated: z.boolean().optional(),
  schedulesAvailable: z.boolean().optional(),
  schedulesTruncated: z.boolean().optional(),
  /** Cross-Context delegation visibility has its own read bounds; it does not
   * redefine the registered Platform-Session openWorkComplete domain. */
  delegationsAvailable: z.boolean().optional(),
  delegationsTruncated: z.boolean().optional(),
  schedules: z.array(runtimeScheduleSchema).optional(),
  objectives: z
    .array(
      z.object({
        id: z.string(),
        projectId: z.string(),
        conversationId: z.string(),
        inputId: z.string(),
        rootId: z.string(),
        sessionId: z.string(),
        contextId: z.string().optional(),
        title: z.string(),
        status: z.string(),
        /** Missing control metadata cannot authorize an action. */
        revision: z.number().int().positive().optional(),
        generation: z.number().int().positive().optional(),
        controlAllowed: z.boolean().optional(),
        statusReason: z.string().nullable(),
        readiness: z.string(),
        waitKinds: z.array(z.string()).optional(),
        parentId: z.string().nullable(),
        threadIds: z.array(z.string()),
        updatedAt: z.string(),
      }),
    )
    .optional(),
  threads: z.array(
    z.object({
      id: z.string(),
      kind: z.string().optional(),
      projectId: z.string().nullable(),
      conversationId: z.string().nullable(),
      inputId: z.string().nullable(),
      rootId: z.string(),
      sessionId: z.string(),
      contextId: z.string().optional(),
      /** Execution read ownership, independent of optional Platform association. */
      initiatingPrincipalId: z.string().nullable().optional(),
      title: z.string(),
      /** Display-only Runtime projection, never a separate activity state. */
      summary: z.string().optional(),
      annotationProtocol: z.enum(["on"]).optional(),
      executionModel: executionModelSchema.nullable().optional(),
      annotationsTruncated: z.boolean().optional(),
      phase: z.string(),
      waitKinds: z.array(z.string()).optional(),
      /** Exact queued Schedule time, not a prediction or a parent goal's wait. */
      waitUntil: z.string().optional(),
      lifecycle: z.string(),
      controlState: z.string().optional(),
      createdAt: z.string().optional(),
      parentThreadId: z.string().nullable().optional(),
      delegation: delegationLinkSchema.optional(),
      objectiveId: z.string().optional(),
      outcome: z
        .object({
          terminalKind: z.string(),
          disposition: z.string(),
          summary: z.string().nullable(),
          createdAt: z.string(),
        })
        .optional(),
      revision: z.number(),
      updatedAt: z.string(),
      continuation: continuationSchema.optional(),
    }),
  ),
});
export type ExecutionActivity = z.infer<typeof activitySchema>;
export const deliverySchema = z
  .object({
    inputId: z.string(),
    state: z.enum([
      "queued",
      "sending",
      "running",
      "completed",
      "failed",
      "cancelled",
      "merged",
    ]),
    /** Verified Runtime mailbox handoff, not authority to control the successor. */
    handoff: z
      .object({
        signalId: z.string().min(1),
        sourceThreadId: z.string().min(1),
        destinationThreadId: z.string().min(1),
        destinationRootId: z.string().min(1),
        destinationGeneration: z.number().int().positive(),
      })
      .optional(),
    error: z.string().nullable(),
    retryable: z.boolean().default(false),
    cancellable: z.boolean().optional(),
    cancelRequested: z.boolean().optional(),
    supplement: z
      .enum(["pending", "delivered", "rejected", "unknown"])
      .optional(),
    rejection: z.enum(["closed", "changed", "forbidden", "invalid"]).optional(),
  })
  .refine((delivery) => delivery.state !== "merged" || !!delivery.handoff, {
    message: "Merged input requires an exact Runtime handoff proof",
  });
export const conversationRuntimeSchema = z.object({
  activity: activitySchema.optional(),
  attention: executionAttentionSchema.optional(),
  configured: z.boolean(),
  connected: z.boolean(),
  harnesses: z
    .array(
      z.object({
        id: z.string(),
        version: z.string(),
        title: z.string().optional(),
      }),
    )
    .nullable()
    .optional(),
  retainedHarnesses: z
    .array(
      z.object({
        id: z.string(),
        version: z.string(),
        title: z.string().optional(),
      }),
    )
    .nullable()
    .optional(),
  model: z.string(),
  error: z.string(),
  deliveries: z.array(deliverySchema),
  messages: z.array(
    z.object({
      id: z.string(),
      projectId: z.string(),
      conversationId: z.string().optional(),
      artifactId: z.string().nullable(),
      inputId: z.string().nullable().optional(),
      inputPreview: z.string().min(1).max(101).optional(),
      rootId: z.string().nullable().optional(),
      publicationKey: z.string().optional(),
      modelAttemptId: z.string().optional(),
      threadId: z.string().optional(),
      providerRecovery: providerRecoverySchema.optional(),
      modelActivity: modelActivitySchema.optional(),
      failure: runtimeMessageFailureSchema.optional(),
      incomplete: z.boolean().optional(),
      truncated: z.boolean().optional(),
      sequence: z.number().int().nonnegative().optional(),
      text: z.string(),
      createdAt: z.string(),
      kind: z.enum(["reply", "progress", "error", "evaluation"]),
      evaluation: evaluationResultSchema.optional(),
      resultSource: evaluationSourceSchema
        .extend({ path: z.array(z.string()).optional() })
        .optional(),
    }),
  ),
});
export type ConversationRuntime = z.infer<typeof conversationRuntimeSchema>;

/** A delivery or dialogue turn is not a background execution. Unknown old kinds
 * remain unmarked; a stale snapshot cannot claim that work is still running. */
export function activeExecutionThreads(runtime: ConversationRuntime) {
  return runtime.connected && runtime.activity?.available
    ? runtime.activity.threads.filter(
        (t) => t.kind === "execution" && t.lifecycle === "open",
      )
    : [];
}

/** Group only by authoritative input identity. Unattributed older events stay separate. */
export function conversationGroups<
  T extends { id: string; createdAt: string; inputId?: string | null },
>(inputs: Array<{ id: string; createdAt: string }>, messages: T[]) {
  const groups = inputs.map((input) => ({
    id: input.id,
    inputId: input.id as string | null,
    createdAt: input.createdAt,
    messages: [] as T[],
  }));
  const index = new Map(groups.map((group) => [group.id, group]));
  for (const message of messages) {
    const group = message.inputId ? index.get(message.inputId) : undefined;
    if (group) group.messages.push(message);
    else
      groups.push({
        id: "event:" + message.id,
        inputId: null,
        createdAt: message.createdAt,
        messages: [message],
      });
  }
  for (const group of groups)
    group.messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return groups.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Presentation order is independent of causal ownership. Never reinsert a late reply under its input. */
export function conversationTimeline<
  T extends { id: string; createdAt: string },
>(items: T[]): T[] {
  return [...items].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}
export const disconnectedRuntime: ConversationRuntime = {
  configured: false,
  connected: false,
  model: "",
  error: "",
  deliveries: [],
  messages: [],
};
