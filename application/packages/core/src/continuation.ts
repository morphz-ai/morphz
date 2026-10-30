import { z } from "zod";
import { userInputAnswersSchema } from "./user-input.js";

const identifier = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_-]+$/);
const requestIdentity = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !value.includes("\0"));
/** Exact work identity, never a title, page selection or latest-active heuristic. */
export const continuationSchema = z
  .object({
    mode: z.enum(["supplement", "follow-up", "reply"]),
    inputId: identifier,
    threadId: identifier,
    generation: z.number().int().positive(),
    objective: z
      .object({ id: identifier, generation: z.number().int().positive() })
      .strict()
      .optional(),
    reply: z
      .discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("question"),
            requestId: requestIdentity,
            answers: userInputAnswersSchema,
          })
          .strict(),
        z
          .object({ kind: z.literal("legacy"), requestId: requestIdentity })
          .strict(),
      ])
      .optional(),
  })
  .strict()
  .refine(
    (target) =>
      (target.mode === "reply") === !!target.reply &&
      (target.reply?.kind !== "legacy" || !!target.objective),
    "A reply must identify exactly one question; legacy replies require their owning Objective",
  );
export type InputContinuation = z.infer<typeof continuationSchema>;

/** Original routing facts projected with an authorized Thread. This is not a
 * message body or a permission grant; submission rechecks the immutable owner. */
const sourceId = z.string().min(1).max(256);
export const continuationSourceSchema = z
  .object({
    inputId: sourceId,
    projectId: sourceId,
    conversationId: sourceId,
    targetActantId: sourceId,
    artifactId: sourceId.nullable(),
    artifactRevision: z.number().int().positive().nullable(),
  })
  .strict();
export type ContinuationSource = z.infer<typeof continuationSourceSchema>;

export function isDirectedContinuation(
  target: InputContinuation | undefined,
): boolean {
  return target?.mode === "supplement" || target?.mode === "reply";
}

export function inputDestination(target: InputContinuation) {
  if (target.reply?.kind === "question")
    return {
      kind: "user_input" as const,
      request_id: target.reply.requestId,
      thread_id: target.threadId,
      generation: target.generation,
      answers: target.reply.answers,
    };
  return target.objective
    ? {
        kind: "objective" as const,
        objective_id: target.objective.id,
        generation: target.objective.generation,
        ...(target.reply?.kind === "legacy"
          ? { reply_to_request_id: target.reply.requestId }
          : {}),
      }
    : {
        kind: "thread" as const,
        thread_id: target.threadId,
        generation: target.generation,
      };
}
