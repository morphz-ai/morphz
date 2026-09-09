import { z } from "zod";
export const artifactOutputSchema = z.object({
  commandId: z.string(),
  inputId: z.string(),
  projectId: z.string(),
  artifactId: z.string(),
  revision: z.number().int().positive(),
  createdAt: z.string(),
});
export type ArtifactOutput = z.infer<typeof artifactOutputSchema>;
export const activitySchema = z.object({
  available: z.boolean(),
  truncated: z.boolean().default(false),
  threads: z.array(
    z.object({
      id: z.string(),
      projectId: z.string(),
      conversationId: z.string(),
      inputId: z.string().nullable(),
      rootId: z.string(),
      sessionId: z.string(),
      title: z.string(),
      phase: z.string(),
      lifecycle: z.string(),
      revision: z.number(),
      updatedAt: z.string(),
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
});
export const conversationRuntimeSchema = z.object({
  activity: activitySchema.optional(),
  configured: z.boolean(),
  connected: z.boolean(),
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
      text: z.string(),
      createdAt: z.string(),
      kind: z.enum(["reply", "progress", "error"]),
    }),
  ),
});
export type ConversationRuntime = z.infer<typeof conversationRuntimeSchema>;

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
