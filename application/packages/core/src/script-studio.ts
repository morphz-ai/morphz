import { z } from "zod";

// Application-owned business records. Runtime remains the execution authority.
const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);
const title = z.string().trim().min(1).max(180);
const text = z.string().max(100_000);
// Inclusive integer bounds preserve the positive revision contract. Session
// IO uses a separate structural descriptor; these domain checks stay mandatory.
const revision = z.number().int().min(1);
const timestamp = z.iso.datetime();
const author = z.object({ principalId: id, actantId: id }).strict();
export const scriptItemKinds = [
  "source",
  "setting",
  "character",
  "outline",
  "episode",
  "scene",
] as const;
export const scriptItemReferenceSchema = z
  .object({ itemId: id, revision })
  .strict();
export const scriptSourceReferenceSchema = z
  .object({
    artifactId: id,
    revision,
    quote: z.string().max(10_000),
  })
  .strict();

export const scriptBriefSchema = z
  .object({
    mode: z.enum(["original", "adaptation"]),
    audience: z.string().max(2000),
    genre: z.string().max(500),
    episodeCount: z.number().int().min(1).max(500),
    episodeSeconds: z.number().int().min(15).max(14_400),
    style: z.string().max(5000),
    constraints: z.string().max(10_000),
    rightsStatement: z.string().max(5000),
    modelProcessingAllowed: z.boolean(),
  })
  .strict();
export const emptyScriptBrief: z.infer<typeof scriptBriefSchema> = {
  mode: "original",
  audience: "",
  genre: "",
  episodeCount: 12,
  episodeSeconds: 120,
  style: "",
  constraints: "",
  rightsStatement: "",
  modelProcessingAllowed: false,
};

export const scriptDraftSchema = z
  .object({
    title,
    text,
    parentId: id.nullable(),
    order: z.number().int().min(0).max(10_000),
    basis: z.enum(["original", "source", "adaptation"]),
    sources: z.array(scriptSourceReferenceSchema).max(100),
    dependencies: z.array(scriptItemReferenceSchema).max(200),
    // These are authored assertions, not facts inferred from model output.
    location: z.string().max(500),
    storyTime: z.string().max(1000),
    characters: z.array(id).max(100),
    audienceKnowledge: z.string().max(5000),
    characterKnowledge: z.string().max(5000),
    setupPayoff: z.string().max(5000),
    productionNotes: z.string().max(5000),
  })
  .strict();
export type ScriptDraft = z.infer<typeof scriptDraftSchema>;
export function emptyScriptDraft(name: string, order = 0): ScriptDraft {
  return {
    title: name,
    text: "",
    parentId: null,
    order,
    basis: "original",
    sources: [],
    dependencies: [],
    location: "",
    storyTime: "",
    characters: [],
    audienceKnowledge: "",
    characterKnowledge: "",
    setupPayoff: "",
    productionNotes: "",
  };
}
const scriptVersionSchema = z
  .object({
    revision,
    draft: scriptDraftSchema,
    author,
    createdAt: timestamp,
    candidateId: id.nullable(),
  })
  .strict();
const scriptApprovalSchema = z
  .object({
    revision,
    author,
    createdAt: timestamp,
    note: z.string().max(5000),
    contextRevision: revision,
  })
  .strict();
export const scriptItemSchema = z
  .object({
    id,
    kind: z.enum(scriptItemKinds),
    revision,
    // Workflow has its own CAS so a late approval cannot clobber a new review.
    workflowRevision: revision,
    status: z.enum(["draft", "in-review", "approved", "locked"]),
    versions: z.array(scriptVersionSchema).min(1),
    approval: scriptApprovalSchema.nullable(),
    events: z.array(
      z
        .object({
          action: z.enum([
            "submit",
            "approve",
            "request-changes",
            "lock",
            "unlock",
            "revise",
            "invalidate",
          ]),
          revision,
          author,
          createdAt: timestamp,
          note: z.string().max(5000),
        })
        .strict(),
    ),
  })
  .strict();
export type ScriptItem = z.infer<typeof scriptItemSchema>;

export const scriptGenerationSchema = z
  .object({
    productionId: id,
    targetId: id,
    baseRevision: revision,
    contextRevision: revision,
    purpose: z.enum(["draft", "rewrite", "continuity", "impact"]),
    // The sender pins the context; the domain verifies every reference at admission.
    references: z.array(scriptItemReferenceSchema).max(200),
    maxCandidates: z.number().int().min(1).max(3),
    maxOutputCharacters: z.number().int().min(100).max(50_000),
    maxReviewPasses: z.number().int().min(0).max(2),
  })
  .strict();
export type ScriptGeneration = z.infer<typeof scriptGenerationSchema>;

const scriptCandidateSchema = z
  .object({
    id,
    inputId: id,
    targetId: id,
    baseRevision: revision,
    contextRevision: revision,
    references: z.array(scriptItemReferenceSchema).max(200),
    draft: scriptDraftSchema,
    explanation: z.string().max(10_000),
    createdBy: author,
    createdAt: timestamp,
    revision,
    status: z.enum(["pending", "accepted", "rejected"]),
    decisionBy: author.nullable(),
    decidedAt: timestamp.nullable(),
  })
  .strict();
export type ScriptCandidate = z.infer<typeof scriptCandidateSchema>;
const scriptReviewSchema = z
  .object({
    id,
    itemId: id,
    itemRevision: revision,
    quote: z.string().max(10_000),
    body: z.string().trim().min(1).max(10_000),
    severity: z.enum(["note", "warning", "blocking"]),
    author,
    createdAt: timestamp,
    inputId: id.nullable(),
    // Decided by the domain at submission, never supplied by the model.
    // Existing unresolved blockers remain active until explicitly resolved;
    // late reviews of superseded evidence are retained as history only.
    contextRevision: revision.optional(),
    historicalOnly: z.boolean().optional(),
    revision,
    resolvedBy: author.nullable(),
    resolvedAt: timestamp.nullable(),
    resolution: z.string().max(5000),
  })
  .strict();
export type ScriptReview = z.infer<typeof scriptReviewSchema>;
export const scriptExportTemplateSchema = z
  .object({
    title: z.string().trim().min(1).max(100),
    includeNotes: z.boolean(),
    includeContinuity: z.boolean(),
    pageBreakEpisodes: z.boolean(),
    font: z.enum(["宋体", "等线", "Microsoft YaHei", "Arial"]),
    fontSize: z.number().int().min(9).max(24),
    sceneHeading: z.string().trim().min(1).max(80),
  })
  .strict();
export const defaultScriptExportTemplate: z.infer<
  typeof scriptExportTemplateSchema
> = {
  title: "分场剧本",
  includeNotes: true,
  includeContinuity: false,
  pageBreakEpisodes: true,
  font: "宋体",
  fontSize: 12,
  sceneHeading: "场景",
};
export const scriptProductionSchema = z
  .object({
    id,
    projectId: id,
    title,
    revision,
    // Metadata/rights/brief changes invalidate outstanding generation and approval.
    brief: scriptBriefSchema,
    reviewerPrincipalIds: z.array(id).min(1).max(50),
    createdBy: author,
    createdAt: timestamp,
    updatedAt: timestamp,
    items: z.array(scriptItemSchema).max(5000),
    candidates: z.array(scriptCandidateSchema),
    reviews: z.array(scriptReviewSchema),
    template: scriptExportTemplateSchema,
    metadataHistory: z.array(
      z
        .object({
          revision,
          title,
          brief: scriptBriefSchema,
          reviewerPrincipalIds: z.array(id),
          template: scriptExportTemplateSchema,
          author,
          createdAt: timestamp,
        })
        .strict(),
    ),
    exports: z.array(
      z
        .object({
          id,
          createdBy: author,
          createdAt: timestamp,
          contextRevision: revision,
          items: z.array(scriptItemReferenceSchema),
          template: scriptExportTemplateSchema,
          format: z.literal("docx"),
        })
        .strict(),
    ),
  })
  .strict();
export type ScriptProduction = z.infer<typeof scriptProductionSchema>;

const scope = { productionId: id };
const itemScope = { ...scope, itemId: id, expectedRevision: revision };
const workflowScope = { ...itemScope, expectedWorkflowRevision: revision };
export const scriptCommandSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("create-production"), projectId: id, title })
    .strict(),
  z
    .object({
      action: z.literal("update-production"),
      ...scope,
      expectedRevision: revision,
      title,
      brief: scriptBriefSchema,
      reviewerPrincipalIds: z.array(id).min(1).max(50),
      template: scriptExportTemplateSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("create-item"),
      ...scope,
      kind: z.enum(scriptItemKinds),
      draft: scriptDraftSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("revise-item"),
      ...itemScope,
      draft: scriptDraftSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("restore-item"),
      ...itemScope,
      restoreRevision: revision,
    })
    .strict(),
  z.object({ action: z.literal("submit-review"), ...workflowScope }).strict(),
  z
    .object({
      action: z.literal("review-decision"),
      ...workflowScope,
      decision: z.enum(["approve", "request-changes"]),
      note: z.string().max(5000),
    })
    .strict(),
  z.object({ action: z.literal("lock-item"), ...workflowScope }).strict(),
  z
    .object({
      action: z.literal("unlock-item"),
      ...workflowScope,
      reason: z.string().trim().min(1).max(5000),
    })
    .strict(),
  // inputId is deliberately absent: the trusted Host adapter supplies the actual root.
  z
    .object({
      action: z.literal("submit-candidate"),
      ...scope,
      draft: scriptDraftSchema,
      explanation: z.string().max(10_000),
    })
    .strict(),
  z
    .object({
      action: z.literal("decide-candidate"),
      ...scope,
      candidateId: id,
      expectedRevision: revision,
      decision: z.enum(["accept", "reject"]),
    })
    .strict(),
  z
    .object({
      action: z.literal("add-review"),
      ...scope,
      itemId: id,
      itemRevision: revision,
      quote: z.string().max(10_000),
      body: z.string().trim().min(1).max(10_000),
      severity: z.enum(["note", "warning", "blocking"]),
    })
    .strict(),
  z
    .object({
      action: z.literal("resolve-review"),
      ...scope,
      reviewId: id,
      expectedRevision: revision,
      resolution: z.string().trim().min(1).max(5000),
    })
    .strict(),
  z
    .object({
      action: z.literal("record-export"),
      ...scope,
      expectedRevision: revision,
      items: z.array(scriptItemReferenceSchema).min(1).max(5000),
      template: scriptExportTemplateSchema,
    })
    .strict(),
]);
export type ScriptCommand = z.infer<typeof scriptCommandSchema>;
export const scriptOperationSchema = z
  .object({
    type: z.literal("script-command"),
    command: scriptCommandSchema,
  })
  .strict();

export function currentScriptDraft(item: ScriptItem): ScriptDraft {
  const version = item.versions.find((v) => v.revision === item.revision);
  if (!version) throw new Error("剧本文稿版本缺失。");
  return version.draft;
}
export type ScriptIssue = {
  code: "stale-dependency" | "unresolved-review" | "missing-parent";
  itemId: string;
  relatedId: string;
  message: string;
};
/** Deterministic structural checks, not a claim of semantic/story quality. */
export function scriptIssues(production: ScriptProduction): ScriptIssue[] {
  const issues: ScriptIssue[] = [];
  for (const item of production.items) {
    const draft = currentScriptDraft(item);
    for (const ref of draft.dependencies) {
      const dependency = production.items.find((i) => i.id === ref.itemId);
      if (!dependency || dependency.revision !== ref.revision)
        issues.push({
          code: "stale-dependency",
          itemId: item.id,
          relatedId: ref.itemId,
          message: `引用的上游版本已变化：${dependency ? currentScriptDraft(dependency).title : ref.itemId} v${ref.revision}`,
        });
    }
    if (
      item.kind === "scene" &&
      !production.items.some(
        (i) => i.id === draft.parentId && i.kind === "episode",
      )
    )
      issues.push({
        code: "missing-parent",
        itemId: item.id,
        relatedId: draft.parentId ?? "",
        message: "分场必须属于一集。",
      });
    for (const review of production.reviews.filter(
      (r) =>
        r.itemId === item.id &&
        !r.resolvedAt &&
        !r.historicalOnly &&
        r.severity === "blocking",
    ))
      issues.push({
        code: "unresolved-review",
        itemId: item.id,
        relatedId: review.id,
        message: `待处理的阻断意见：${review.body}`,
      });
  }
  return issues;
}
export function scriptImpact(
  production: ScriptProduction,
  changedIds: string[],
): string[] {
  const affected = new Set(changedIds);
  let size = -1;
  while (size !== affected.size) {
    size = affected.size;
    for (const item of production.items) {
      const draft = currentScriptDraft(item);
      if (
        draft.dependencies.some((d) => affected.has(d.itemId)) ||
        draft.characters.some((id) => affected.has(id)) ||
        (draft.parentId && affected.has(draft.parentId))
      )
        affected.add(item.id);
    }
  }
  return [...affected].filter((id) => !changedIds.includes(id));
}
export function scriptCandidateStale(
  production: ScriptProduction,
  candidate: ScriptCandidate,
) {
  return (
    production.revision !== candidate.contextRevision ||
    production.items.find((i) => i.id === candidate.targetId)?.revision !==
      candidate.baseRevision ||
    candidate.references.some(
      (r) =>
        production.items.find((i) => i.id === r.itemId)?.revision !==
        r.revision,
    )
  );
}
export const scriptKindLabels: Record<ScriptItem["kind"], string> = {
  source: "资料",
  setting: "设定",
  character: "角色",
  outline: "全剧大纲",
  episode: "分集",
  scene: "分场",
};
