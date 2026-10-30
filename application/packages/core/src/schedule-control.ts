import { z } from "zod";
import { executionScopeSchema } from "./execution.js";
import { id } from "./model.js";

const base = z.object({
  scope: executionScopeSchema
    .extend({
      conversationId: id,
      inputId: id,
      threadId: id,
      taskRun: z.undefined().optional(),
    })
    .strict(),
  scheduleId: id,
  revision: z.number().int().positive(),
});

/** Exact existing Runtime arrangement, never a renderer-supplied Session or
 * a replacement timer. Task-owned arrangements retain their task operation. */
export const scheduleControlSchema = z.discriminatedUnion("action", [
  base.extend({ action: z.enum(["pause", "resume", "cancel"]) }).strict(),
  base
    .extend({
      action: z.literal("reschedule"),
      notBefore: z.string().datetime({ offset: true }),
      intervalSeconds: z.number().int().positive().nullable(),
    })
    .strict(),
]);
export type ScheduleControl = z.infer<typeof scheduleControlSchema>;
