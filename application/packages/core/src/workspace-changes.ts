import { z } from "zod";

/** A workspace invalidation is not a conversation, a receipt or a grant.
 * Sequence is local to this subscription, never an authoritative data version.
 */
export const workspaceChangeScopeSchema = z
  .object({ kind: z.literal("workspace") })
  .strict();

export const workspaceChangeSchema = z
  .object({
    kind: z.literal("workspace"),
    sequence: z.number().int().positive(),
    reason: z.enum(["changed", "resync"]),
    accessChanged: z.boolean(),
  })
  .strict();

export type WorkspaceChange = z.infer<typeof workspaceChangeSchema>;
export type WorkspaceChangeScope = z.infer<typeof workspaceChangeScopeSchema>;
