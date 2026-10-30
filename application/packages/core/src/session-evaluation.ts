import { z } from "zod";
import { reasoningEffortSchema } from "./inference.js";

export const sessionEvaluationScopeSchema = z
  .object({
    projectId: z.string().min(1).max(200),
    conversationId: z.string().min(1).max(200),
  })
  .strict();
export const sessionEvaluationDefaultsSchema = z
  .object({
    model: z.string().trim().min(1).max(256).nullable(),
    // Session HTTP shares the canonical levels; null restores inheritance.
    // Task-level provider_default is not a separate Session PATCH value.
    reasoningEffort: reasoningEffortSchema.nullable(),
  })
  .strict();
export const sessionEvaluationUpdateSchema = sessionEvaluationScopeSchema
  .extend({
    defaults: sessionEvaluationDefaultsSchema,
    expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const sessionEvaluationSnapshotSchema = z.object({
  scope: sessionEvaluationScopeSchema.extend({
    kind: z.enum(["global", "conversation"]),
  }),
  runtimeSessionId: z.string().nullable(),
  defaults: sessionEvaluationDefaultsSchema,
  source: z.enum(["runtime", "not_started"]),
  canUpdate: z.boolean(),
  readOnlyReason: z
    .enum(["not_started", "team_managed", "local_only"])
    .nullable(),
  // Host preflight observation; not a Runtime atomic revision.
  fingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});
export type SessionEvaluationScope = z.infer<
  typeof sessionEvaluationScopeSchema
>;
export type SessionEvaluationDefaults = z.infer<
  typeof sessionEvaluationDefaultsSchema
>;
export type SessionEvaluationUpdate = z.infer<
  typeof sessionEvaluationUpdateSchema
>;
export type SessionEvaluationSnapshot = z.infer<
  typeof sessionEvaluationSnapshotSchema
>;
