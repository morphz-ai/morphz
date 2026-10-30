import { z } from "zod";
import { continuationSchema } from "./continuation.js";
import { pendingUserInputRequestSchema } from "./user-input.js";

const identifier = z.string().min(1).max(256);
/** Read an exact saved request without paging or moving the visible history. */
export const userInputTargetReadSchema = z
  .object({
    projectId: identifier,
    conversationId: identifier,
    requestId: identifier,
    legacy: z.literal(true).optional(),
    continuation: continuationSchema.refine(
      (target) => target.mode === "supplement" && !target.reply,
    ),
  })
  .strict();
export type UserInputTargetRead = z.infer<typeof userInputTargetReadSchema>;
export const userInputTargetSchema = z
  .object({
    title: z.string(),
    request: pendingUserInputRequestSchema.optional(),
    legacyRequestId: identifier.optional(),
    continuation: continuationSchema,
    source: z
      .object({
        inputId: identifier,
        projectId: identifier,
        conversationId: identifier,
        targetActantId: identifier,
        artifactId: identifier.nullable(),
        artifactRevision: z.number().int().positive().nullable(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (target) => !!target.request !== !!target.legacyRequestId,
    "A read identifies one saved question or one legacy wait, never both",
  );
export type UserInputTarget = z.infer<typeof userInputTargetSchema>;
