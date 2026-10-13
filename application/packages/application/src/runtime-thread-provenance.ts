import { z } from "zod";

/** Runtime-owned parent relation only. Never infer lineage from roots, tool
 * arguments, shared input IDs or Session signals. Both Host provenance and
 * execution inspection use this shape and the same bounded ancestry budget. */
export const runtimeThreadSupervisionSchema = z.object({
  parent_thread_id: z.string().min(1).nullable().optional(),
});
export const runtimeThreadAncestryLimit = 64;

/** Current Runtime contract. A null proof is unknown, not permission to infer
 * an original input from a shared Session or a synthetic root's spelling. */
export const runtimeSchedulerSourceSchema = z
  .object({
    event_id: z.string().min(1),
    context_id: z.string().min(1),
    session_id: z.string().min(1),
    root_turn_id: z.string().min(1),
    activation_id: z.string().nullable(),
  })
  .nullable();
