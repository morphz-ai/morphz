import type { ApplicationComposePreparationOptions } from "../../apps/web/src/host/application-compose-preparation.js";
import type { InputDraft } from "../../apps/web/src/host/exchange-drafts.js";
import type { ScriptGeneration } from "../../packages/core/src/script-studio.js";
import {
  emptyScriptBrief,
  defaultScriptExportTemplate,
} from "../../packages/core/src/script-studio.js";

type Model = NonNullable<
  ReturnType<ApplicationComposePreparationOptions["client"]["getScriptEditor"]>
>;
type Catalog =
  ApplicationComposePreparationOptions["client"]["contentCatalog"][number];
type Artifact =
  ApplicationComposePreparationOptions["render"]["state"]["artifacts"][number];
export const empty: InputDraft = { body: "", selection: "", revision: null };
export const generation: ScriptGeneration = {
  productionId: "script-one",
  targetId: "scene-one",
  baseRevision: 2,
  contextRevision: 5,
  purpose: "draft",
  references: [],
  maxCandidates: 1,
  maxOutputCharacters: 1000,
  maxReviewPasses: 1,
};
const date = "2026-10-05T00:00:00.000Z";
const author = { principalId: "human", actantId: "human-actant" };
export function production(): Model {
  return {
    id: "script-one",
    projectId: "project",
    title: "剧本原件",
    revision: 5,
    brief: { ...emptyScriptBrief },
    reviewerPrincipalIds: ["human"],
    template: { ...defaultScriptExportTemplate },
    createdBy: author,
    createdAt: date,
    updatedAt: date,
    activityRevision: 5,
    creativeEpoch: 1,
    totals: {
      items: 1,
      candidates: 0,
      pendingCandidates: 0,
      reviews: 0,
      pendingReviews: 0,
      exports: 0,
      metadataVersions: 0,
    },
    contentId: "content-script",
    catalogRevision: 1,
    providerRevision: 1,
    items: [
      {
        id: "scene-one",
        kind: "scene",
        revision: 2,
        workflowRevision: 1,
        status: "draft",
        title: "场景",
        parentId: null,
        order: 0,
        basis: "original",
        dependencies: [],
        characters: [],
        approval: null,
        textCharacters: 0,
        sourceCount: 0,
        pendingCandidateCount: 0,
        currentPendingReviewCount: 0,
        blockingReviewCount: 0,
        hasText: false,
        approvalCurrent: false,
      },
    ],
  };
}
export function catalog(version = "9"): Catalog {
  return {
    id: "artifact",
    appId: "morphz.objects",
    instanceId: "objects-instance",
    appObjectId: "artifact",
    projectId: "project",
    kind: "document",
    title: "对象",
    observedVersionRef: version,
    availability: "available",
    revision: 1,
    providerRevision: 1,
    createdAt: date,
    updatedAt: date,
  };
}
export function artifact(revision = 9): Artifact {
  const content = { kind: "document" as const, markdown: "原文" };
  return {
    id: "artifact",
    projectId: "project",
    title: "对象",
    revision,
    content,
    createdBy: author,
    createdAt: date,
    updatedAt: date,
    source: null,
    versions: [{ revision, title: "对象", content, author, createdAt: date }],
  };
}
export const quote: NonNullable<InputDraft["textQuotes"]>[number] = {
  id: "11111111-1111-4111-8111-111111111111",
  source: {
    kind: "artifact",
    projectId: "project",
    artifactId: "artifact",
    revision: 9,
    title: "对象",
  },
  text: "选文",
  comment: "评论",
};
