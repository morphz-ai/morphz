import { z } from "zod";
import { applicationStateSchema } from "./applications.js";

/** Installed-app discovery and navigation only. The Host derives the Human
 * owner and project from an accepted chat input; neither is a model parameter.
 * Installation and executable UI bytes remain Human-only operations. */
export const applicationToolSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("list"),
      offset: z.number().int().min(0).max(100).default(0),
      limit: z.number().int().min(1).max(50).default(20),
    })
    .strict(),
  z
    .object({
      action: z.literal("launch"),
      appId: z.string().regex(/^[a-z][a-z0-9.-]{2,80}$/),
      packageVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
      state: applicationStateSchema.default({}),
    })
    .strict(),
]);
export type ApplicationToolRequest = z.infer<typeof applicationToolSchema>;
