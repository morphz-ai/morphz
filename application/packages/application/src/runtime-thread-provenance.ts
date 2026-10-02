import { z } from "zod";

/** Runtime-owned parent relation only. Never infer lineage from roots, tool
 * arguments, shared input IDs or Session signals. Both Host provenance and
 * execution inspection use this shape and the same bounded ancestry budget. */
export const runtimeThreadSupervisionSchema = z.object({
  parent_thread_id: z.string().min(1).nullable().optional(),
});
export const runtimeThreadAncestryLimit = 64;
