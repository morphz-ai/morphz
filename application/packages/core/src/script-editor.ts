import { z } from "zod";
import {
  scriptProductionSchema,
  scriptItemKinds,
  scriptItemReferenceSchema,
  scriptDraftSchema,
} from "./script-studio.js";

const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);
const revision = z.number().int().positive();
const count = z.number().int().nonnegative();
const item = scriptProductionSchema.shape.items.element;
const candidate = scriptProductionSchema.shape.candidates.element;
const review = scriptProductionSchema.shape.reviews.element;
const exported = scriptProductionSchema.shape.exports.element;

/** Navigation is not a partially populated ScriptProduction. Bodies and
 * immutable historical versions have explicit, independently loaded ports. */
export const scriptDirectoryItemSchema = z
  .object({
    id,
    kind: z.enum(scriptItemKinds),
    revision,
    workflowRevision: revision,
    status: item.shape.status,
    title: z.string(),
    parentId: id.nullable(),
    order: count,
    basis: scriptDraftSchema.shape.basis,
    dependencies: z.array(scriptItemReferenceSchema).max(200),
    characters: z.array(id).max(100),
    approval: item.shape.approval,
    textCharacters: count,
    sourceCount: count,
    pendingCandidateCount: count,
    currentPendingReviewCount: count,
    blockingReviewCount: count,
    hasText: z.boolean(),
    approvalCurrent: z.boolean(),
  })
  .strict();
export type ScriptDirectoryItem = z.infer<typeof scriptDirectoryItemSchema>;
export const scriptEditorHeadSchema = scriptProductionSchema
  .pick({
    id: true,
    projectId: true,
    title: true,
    revision: true,
    brief: true,
    reviewerPrincipalIds: true,
    template: true,
    createdBy: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    activityRevision: revision,
    creativeEpoch: revision,
    totals: z
      .object({
        items: count,
        candidates: count,
        pendingCandidates: count,
        reviews: count,
        pendingReviews: count,
        exports: count,
        metadataVersions: count,
      })
      .strict(),
  })
  .strict();
export type ScriptEditorHead = z.infer<typeof scriptEditorHeadSchema>;
const page = {
  productionId: id,
  activityRevision: revision,
  total: count,
  nextCursor: z.string().nullable(),
};
export const scriptDirectoryPageSchema = z
  .object({ ...page, items: z.array(scriptDirectoryItemSchema).max(100) })
  .strict();
export const scriptCandidateHeaderSchema = candidate
  .omit({ draft: true, explanation: true, references: true })
  .extend({
    ordinal: revision,
    title: z.string(),
    textCharacters: count,
    stale: z.boolean(),
    acceptedRevision: revision.nullable(),
  })
  .strict();
export const scriptCandidatePageSchema = z
  .object({
    ...page,
    itemId: id,
    pendingTotal: count,
    defaultCandidateId: id.nullable(),
    candidates: z.array(scriptCandidateHeaderSchema).max(100),
  })
  .strict();
export const scriptVersionHeaderSchema = item.shape.versions.element
  .omit({ draft: true })
  .extend({ title: z.string(), textCharacters: count })
  .strict();
/** An exact immutable display title, never the current item's title or body. */
export const scriptVersionTitleSchema = z
  .object({ productionId: id, itemId: id, revision, title: z.string() })
  .strict();
export const scriptVersionPageSchema = z
  .object({
    ...page,
    itemId: id,
    versions: z.array(scriptVersionHeaderSchema).max(100),
  })
  .strict();
export const scriptEventPageSchema = z
  .object({
    ...page,
    itemId: id,
    events: z.array(item.shape.events.element).max(100),
  })
  .strict();
export const scriptReviewPageSchema = z
  .object({
    ...page,
    itemId: id.nullable(),
    pendingTotal: count,
    reviews: z.array(review).max(100),
  })
  .strict();
export const scriptExportHeaderSchema = exported
  .omit({ items: true, template: true })
  .extend({ itemCount: count })
  .strict();
export const scriptExportPageSchema = z
  .object({ ...page, exports: z.array(scriptExportHeaderSchema).max(100) })
  .strict();
export const scriptMetadataPageSchema = z
  .object({
    ...page,
    versions: z
      .array(
        scriptProductionSchema.shape.metadataHistory.element.pick({
          revision: true,
          title: true,
          author: true,
          createdAt: true,
        }),
      )
      .max(100),
  })
  .strict();
export const scriptEditorPageRequestSchema = z
  .object({
    contentId: id,
    panel: z.enum([
      "directory",
      "candidates",
      "versions",
      "events",
      "reviews",
      "exports",
      "metadata",
    ]),
    itemId: id.optional(),
    limit: z.number().int().min(1).max(100).default(50),
    after: z.string().max(8192).optional(),
    expectedActivityRevision: revision.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      ["candidates", "versions", "events"].includes(value.panel) &&
      !value.itemId
    )
      context.addIssue({
        code: "custom",
        message: "请选择剧本条目。",
        path: ["itemId"],
      });
    if (
      ["directory", "exports", "metadata"].includes(value.panel) &&
      value.itemId
    )
      context.addIssue({
        code: "custom",
        message: "此面板不接受条目筛选。",
        path: ["itemId"],
      });
  });
export type ScriptEditorPageRequest = z.input<
  typeof scriptEditorPageRequestSchema
>;
export const scriptEditorDetailRequestSchema = z
  .object({
    contentId: id,
    kind: z.enum(["candidate", "review", "export", "context", "item-version-title"]),
    objectId: id.optional(),
    revision: revision.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.kind === "context"
        ? !value.revision || value.objectId
        : value.kind === "item-version-title"
          ? !value.objectId || !value.revision
          : !value.objectId || value.revision
    )
      context.addIssue({
        code: "custom",
        message: "请提供确切的剧本对象或版本。",
      });
  });
export type ScriptEditorDetailRequest = z.input<
  typeof scriptEditorDetailRequestSchema
>;
// Source references retain their app identity until an authorized Client maps
// them to the corresponding Platform catalog ID. No guessed Objects ownership.
export const scriptEditorDraftSchema = scriptDraftSchema
  .extend({
    sources: z
      .array(
        z
          .object({
            appId: z.string().min(1).max(160),
            instanceId: z.string().min(1).max(160),
            objectId: z.string().min(1).max(160),
            versionRef: z.string().min(1).max(200),
            quote: z.string().max(10_000),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export const scriptCandidateDetailSchema = candidate
  .extend({
    draft: scriptEditorDraftSchema,
    ordinal: revision,
    stale: z.boolean(),
    acceptedRevision: revision.nullable(),
  })
  .strict();
export const scriptReviewDetailSchema = review;
export const scriptExportDetailSchema = exported;
export type ScriptCandidateHeader = z.infer<typeof scriptCandidateHeaderSchema>;
export type ScriptCandidateDetail = z.infer<typeof scriptCandidateDetailSchema>;
export type ScriptDirectoryPage = z.infer<typeof scriptDirectoryPageSchema>;
export type ScriptCandidatePage = z.infer<typeof scriptCandidatePageSchema>;
export type ScriptVersionPage = z.infer<typeof scriptVersionPageSchema>;
export type ScriptEventPage = z.infer<typeof scriptEventPageSchema>;
export type ScriptReviewPage = z.infer<typeof scriptReviewPageSchema>;
export type ScriptExportPage = z.infer<typeof scriptExportPageSchema>;
export type ScriptMetadataPage = z.infer<typeof scriptMetadataPageSchema>;
export type ScriptEditorPage =
  | ScriptDirectoryPage
  | ScriptCandidatePage
  | ScriptVersionPage
  | ScriptEventPage
  | ScriptReviewPage
  | ScriptExportPage
  | ScriptMetadataPage;
export type ScriptEditorReadModel = {
  head: ScriptEditorHead;
  items: ScriptDirectoryItem[];
};
