import { z } from "zod";
import { id } from "./model.js";
import {
  scriptCommandSchema,
  scriptPreparationRequestSchema,
} from "./script-studio.js";

const page = {
  offset: z.number().int().min(0).max(2_000_000).default(0),
  limit: z.number().int().min(1).max(50).default(20),
};
const productionScope = { productionId: id };
const workflowCheck = z
  .object({
    performed: z.boolean(),
    revise: z.boolean(),
    blocked: z.boolean(),
    notes: z.string().max(5000),
  })
  .strict();
export const scriptWorkflowReportSchema = z
  .object({
    explanation: z.string().max(7000),
    checks: z.array(workflowCheck).length(2),
  })
  .strict();
export type ScriptWorkflowReport = z.infer<typeof scriptWorkflowReportSchema>;

/** The exact data shape produced by continuity/impact inference and accepted
 * by its Host submission. It is not a draft and grants no review authority. */
export const scriptWorkflowReviewBatchSchema = z
  .array(
    z
      .object({
        action: z.literal("add-review"),
        productionId: id,
        itemId: id,
        itemRevision: z.number().int().positive(),
        quote: z.string().max(10_000),
        body: z.string().trim().min(1).max(10_000),
        severity: z.enum(["note", "warning", "blocking"]),
      })
      .strict(),
  )
  .max(32);

/** Data-only Host protocol. Persistence and workflow authorization belong to
 * ScriptStudioStore and its domain services, not to the tool schema. */
export const scriptToolSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("list"),
      query: z.string().max(200).default(""),
      ...page,
    })
    .strict(),
  z
    .object({
      action: z.literal("read-production"),
      ...productionScope,
      ...page,
      cursor: z
        .object({ ordinal: z.number().int().nonnegative(), itemId: id })
        .strict()
        .optional(),
    })
    .strict(),
  z.object({ action: z.literal("read-generation") }).strict(),
  z.object({ action: z.literal("read-workflow") }).strict(),
  scriptPreparationRequestSchema.extend({
    action: z.literal("prepare-workflow"),
    // The primary fields remain the exact legacy single-target request.
    // A batch includes that primary target first and is frozen in one call.
    targets: z
      .array(
        z
          .object({
            targetId: id,
            baseRevision: z.number().int().positive(),
            references: scriptPreparationRequestSchema.shape.references,
          })
          .strict(),
      )
      .min(1)
      .max(12)
      .optional(),
    task: z.string().max(12000).optional(),
    // No parser default: historical inputs retain their exact candidate contract.
    submissionMode: z.enum(["candidate", "current"]).optional(),
  }),
  z
    .object({
      action: z.literal("submit-workflow"),
      payload: z.unknown(),
      explanation: z.string().max(7000),
      checks: z.array(workflowCheck).length(2),
    })
    .strict(),
  z.object({ action: z.literal("read-results"), ...page }).strict(),
  z
    .object({
      action: z.literal("list-candidates"),
      ...productionScope,
      itemId: id,
      limit: page.limit,
      after: z.string().max(8192).optional(),
      expectedActivityRevision: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("read-candidate"),
      ...productionScope,
      candidateId: id,
      offset: page.offset,
      limit: z.number().int().min(1).max(24_000).default(24_000),
    })
    .strict(),
  z
    .object({
      action: z.literal("read-result"),
      resultId: id,
      offset: page.offset,
      limit: z.number().int().min(1).max(24_000).default(24_000),
    })
    .strict(),
  z
    .object({
      action: z.literal("read-item"),
      ...productionScope,
      itemId: id,
      revision: z.number().int().min(1),
      offset: page.offset,
      limit: z.number().int().min(1).max(24_000).default(24_000),
    })
    .strict(),
  z
    .object({
      action: z.literal("read-source"),
      ...productionScope,
      itemId: id,
      revision: z.number().int().min(1),
      sourceIndex: z.number().int().min(0).max(99),
      offset: page.offset,
      limit: z.number().int().min(1).max(24_000).default(24_000),
    })
    .strict(),
  z
    .object({ action: z.literal("issues"), ...productionScope, ...page })
    .strict(),
  z
    .object({
      action: z.literal("impact"),
      ...productionScope,
      itemIds: z.array(id).min(1).max(200),
      ...page,
    })
    .strict(),
  z
    .object({ action: z.literal("command"), command: scriptCommandSchema })
    .strict(),
]);
export type ScriptToolRequest = z.infer<typeof scriptToolSchema>;
