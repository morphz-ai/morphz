import { z } from "zod";
import { id } from "./model.js";

/** Control an attributed Runtime goal, not an arbitrary user-selected Session. */
const objectiveControlBase = z.object({
  objectiveId: id,
  projectId: id,
  conversationId: id,
  revision: z.number().int().positive(),
});
export const objectiveControlSchema = z.discriminatedUnion("action", [
  objectiveControlBase
    .extend({ action: z.enum(["pause", "resume", "delete"]) })
    .strict(),
  objectiveControlBase
    .extend({
      action: z.literal("edit"),
      statedObjective: z.string().trim().min(1).max(32000),
    })
    .strict(),
]);
export type ObjectiveControl = z.infer<typeof objectiveControlSchema>;
