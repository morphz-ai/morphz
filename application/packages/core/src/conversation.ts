import { z } from "zod";
import { executionAttentionSchema } from "./execution.js";
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
  truncated: z.boolean().default(false),
  /** Current open threads/Objectives were fully read and causally attributed.
   * Independent of the bounded terminal activity history; absent is unknown. */
  openWorkComplete: z.boolean().optional(),
  /** Per Context snapshot bound, not a claim of complete execution history. */
  limit: z.number().int().positive().optional(),
  objectivesTruncated: z.boolean().optional(),
  schedulesAvailable: z.boolean().optional(),
  schedulesTruncated: z.boolean().optional(),
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
        title: z.string(),
        status: z.string(),
        statusReason: z.string().nullable(),
        readiness: z.string(),
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
      projectId: z.string(),
      conversationId: z.string(),
      inputId: z.string().nullable(),
      rootId: z.string(),
      sessionId: z.string(),
      contextId: z.string().optional(),
      title: z.string(),
      /** Display-only Runtime projection, never a separate activity state. */
      summary: z.string().optional(),
      annotationProtocol: z.enum(["v1", "v2"]).optional(),
      annotationsTruncated: z.boolean().optional(),
      phase: z.string(),
      lifecycle: z.string(),
      controlState: z.string().optional(),
      createdAt: z.string().optional(),
      parentThreadId: z.string().nullable().optional(),
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
export const deliverySchema = z.object({
  inputId: z.string(),
  state: z.enum([
    "queued",
    "sending",
    "running",
    "completed",
    "failed",
    "cancelled",
  ]),
  error: z.string().nullable(),
  retryable: z.boolean().default(false),
  cancellable: z.boolean().optional(),
  cancelRequested: z.boolean().optional(),
  supplement: z
    .enum(["pending", "delivered", "rejected", "unknown"])
    .optional(),
  rejection: z.enum(["closed", "changed", "forbidden", "invalid"]).optional(),
});
export const conversationRuntimeSchema = z.object({
  activity: activitySchema.optional(),
  attention: executionAttentionSchema.optional(),
  configured: z.boolean(),
  connected: z.boolean(),
  harnesses: z
    .array(z.object({ id: z.string(), version: z.string() }))
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
      rootId: z.string().nullable().optional(),
      publicationKey: z.string().optional(),
      threadId: z.string().optional(),
      incomplete: z.boolean().optional(),
      truncated: z.boolean().optional(),
      sequence: z.number().int().nonnegative().optional(),
      text: z.string(),
      createdAt: z.string(),
      kind: z.enum(["reply", "progress", "error"]),
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
