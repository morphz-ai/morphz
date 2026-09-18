import { z } from "zod";

const identifier = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_-]+$/);
/** Exact work identity, never a title, page selection or latest-active heuristic. */
export const continuationSchema = z
  .object({
    mode: z.enum(["supplement", "follow-up"]),
    inputId: identifier,
    threadId: identifier,
    generation: z.number().int().positive(),
    objective: z
      .object({ id: identifier, generation: z.number().int().positive() })
      .strict()
      .optional(),
  })
  .strict();
export type InputContinuation = z.infer<typeof continuationSchema>;

export function inputDestination(target: InputContinuation) {
  return target.objective
    ? {
        kind: "objective" as const,
        objective_id: target.objective.id,
        generation: target.objective.generation,
      }
    : {
        kind: "thread" as const,
        thread_id: target.threadId,
        generation: target.generation,
      };
}
