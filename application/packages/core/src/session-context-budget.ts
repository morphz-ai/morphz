import { z } from "zod";
import { sessionEvaluationScopeSchema } from "./session-evaluation.js";

const tokens = z.number().int().positive().safe();
export const sessionContextUsageSchema = z.object({
  contextId: z.string().min(1),
  sessionId: z.string().min(1),
  model: z.string().min(1),
  physicalModel: z.string().min(1),
  inputTokens: z.number().int().nonnegative().safe(),
  accuracy: z.enum([
    "exact",
    "local-tokenizer-estimate",
    "usage-calibrated-estimate",
    "heuristic-estimate",
  ]),
  measuredAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  sequence: z.number().int().positive().safe().optional(),
});
export type SessionContextUsage = z.infer<typeof sessionContextUsageSchema>;
export const sessionContextBudgetSnapshotSchema = z.object({
  scope: sessionEvaluationScopeSchema.extend({
    kind: z.enum(["global", "conversation"]),
  }),
  source: z.enum(["runtime", "not_started"]),
  inputTokens: tokens.nullable(),
  windowTokens: tokens.nullable(),
  outputTokens: tokens.nullable(),
  model: z.string().nullable(),
  capacitySource: z.string().nullable(),
  contextId: z.string().nullable(),
  runtimeSessionId: z.string().nullable(),
  requestedTokens: tokens.nullable(),
  physicalInputTokens: tokens.nullable(),
  revision: z.number().int().nonnegative().safe().nullable(),
  canUpdate: z.boolean(),
  usage: sessionContextUsageSchema.nullable(),
});
export const sessionContextBudgetUpdateSchema = sessionEvaluationScopeSchema
  .extend({
    requestedTokens: tokens.nullable(),
    expectedRevision: z.number().int().nonnegative().safe(),
    expectedModel: z.string().min(1).max(256),
  })
  .strict();
export type SessionContextBudgetUpdate = z.infer<
  typeof sessionContextBudgetUpdateSchema
>;
export type SessionContextBudgetSnapshot = z.infer<
  typeof sessionContextBudgetSnapshotSchema
>;

export function formatContextCapacity(tokens: number) {
  if (tokens < 1024) return String(tokens);
  const value = tokens / 1024;
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value)}K`;
}

/** Only numeric, Runtime-authored full-request measurements enter the UI.
 * Body text, quoted errors, billing totals and unrelated scopes are excluded. */
export function contextUsageFromEvent(
  raw: unknown,
): SessionContextUsage | null {
  const event = z
    .object({
      timestamp: z.string(),
      sequence: z.number().optional(),
      topic: z.literal("runtime/model_attempt_state"),
      payload: z.record(z.string(), z.unknown()),
    })
    .safeParse(raw);
  if (!event.success) return null;
  const p = event.data.payload;
  const pressure = z
    .object({
      token_scope: z.literal("full-work-prompt"),
      estimated_tokens: z.number(),
      token_model: z.string(),
      token_accuracy: z.string(),
    })
    .safeParse(p.pressure);
  if (!pressure.success) return null;
  const declared = z
    .object({ model: z.string() })
    .safeParse(p.context_token_budget);
  const result = sessionContextUsageSchema.safeParse({
    contextId: p.context_id,
    sessionId: p.session_id,
    model: declared.success ? declared.data.model : pressure.data.token_model,
    physicalModel: pressure.data.token_model,
    inputTokens: pressure.data.estimated_tokens,
    accuracy: pressure.data.token_accuracy,
    measuredAt: event.data.timestamp,
    sequence: event.data.sequence,
  });
  return result.success ? result.data : null;
}

export function latestContextUsage(
  values: Array<SessionContextUsage | null | undefined>,
  scope: { contextId: string; sessionId: string; model: string },
): SessionContextUsage | null {
  return (
    values
      .filter(
        (value): value is SessionContextUsage =>
          !!value &&
          value.contextId === scope.contextId &&
          value.sessionId === scope.sessionId &&
          (value.model === scope.model || value.physicalModel === scope.model),
      )
      .sort(
        (a, b) =>
          Date.parse(b.measuredAt) - Date.parse(a.measuredAt) ||
          (b.sequence ?? 0) - (a.sequence ?? 0),
      )[0] ?? null
  );
}
