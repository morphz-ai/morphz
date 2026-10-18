import { z } from "zod";
import { id } from "./model.js";

/** Control an attributed Runtime goal, not an arbitrary user-selected Session. */
export const objectiveControlSchema = z
  .object({
    objectiveId: id,
    projectId: id,
    conversationId: id,
    revision: z.number().int().positive(),
    action: z.enum(["pause", "resume", "delete"]),
  })
  .strict();
export type ObjectiveControl = z.infer<typeof objectiveControlSchema>;
