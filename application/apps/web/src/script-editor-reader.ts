import { z } from "zod";
import {
  scriptEditorHeadSchema,
  scriptDirectoryPageSchema,
  scriptCandidatePageSchema,
  scriptVersionPageSchema,
  scriptEventPageSchema,
  scriptReviewPageSchema,
  scriptExportPageSchema,
  scriptMetadataPageSchema,
  scriptCandidateDetailSchema,
  scriptEditorDraftSchema,
  type ScriptEditorHead,
  type ScriptDirectoryItem,
  type ScriptEditorPageRequest,
  type ScriptEditorDetailRequest,
} from "../../../packages/core/src/script-editor.js";
import {
  scriptProductionSchema,
  scriptDraftSchema,
  type ScriptDraft,
} from "../../../packages/core/src/script-studio.js";
import type { PlatformClient, PlatformContent } from "./platform-client.js";

/** The editor's explicit navigation model; never an incomplete production. */
export type ScriptEditorHeader = ScriptEditorHead & {
  contentId: string;
  catalogRevision: number;
  providerRevision: number;
};
export type ScriptEditorProduction = ScriptEditorHeader & {
  items: ScriptDirectoryItem[];
};
const scriptItem = scriptProductionSchema.shape.items.element;
const exactItemSchema = z.object({
  productionId: z.string(),
  itemId: z.string(),
  kind: scriptItem.shape.kind,
  status: scriptItem.shape.status,
  headRevision: z.number().int().positive(),
  workflowRevision: z.number().int().positive(),
  revision: z.number().int().positive(),
  candidateId: z.string().nullable(),
  author: scriptProductionSchema.shape.createdBy,
  createdAt: z.string(),
  approvalForRequestedVersion: scriptItem.shape.approval,
  draft: scriptEditorDraftSchema,
});
export type ScriptEditorVersion = Omit<
  z.infer<typeof exactItemSchema>,
  "draft"
> & {
  draft: ScriptDraft;
};
export type ScriptEditorCandidate = Omit<
  z.infer<typeof scriptCandidateDetailSchema>,
  "draft"
> & { draft: ScriptDraft };

export const editorPageSchemas = {
  directory: scriptDirectoryPageSchema,
  candidates: scriptCandidatePageSchema,
  versions: scriptVersionPageSchema,
  events: scriptEventPageSchema,
  reviews: scriptReviewPageSchema,
  exports: scriptExportPageSchema,
  metadata: scriptMetadataPageSchema,
} as const;
export type ScriptPage<K extends keyof typeof editorPageSchemas> = z.infer<
  (typeof editorPageSchemas)[K]
>;
/** A complete local collection of bounded pages, not an RPC page. */
export type ScriptPanel<K extends keyof typeof editorPageSchemas> = Omit<
  ScriptPage<K>,
  "nextCursor"
>;

/** Resolve only the sources of a deliberately read draft. A reference's
 * instance and version cannot be guessed from a similar catalog title. */
export async function editorDraftForClient(
  source: PlatformClient,
  draft: z.infer<typeof scriptEditorDraftSchema>,
  signal?: AbortSignal,
): Promise<ScriptDraft> {
  const references: ScriptDraft["sources"] = [];
  for (let at = 0; at < draft.sources.length; at += 8) {
    references.push(
      ...(await Promise.all(
        draft.sources.slice(at, at + 8).map(async (ref) => {
          const entry = await source.resolveContent(
            {
              appId: ref.appId,
              appObjectId: ref.objectId,
            },
            signal,
          );
          const revision = Number(ref.versionRef);
          if (
            entry.instanceId !== ref.instanceId ||
            entry.availability !== "available" ||
            !/^[1-9][0-9]*$/.test(ref.versionRef) ||
            !Number.isSafeInteger(revision) ||
            revision < 1
          )
            throw new Error("剧本引用来源已变化，请重新核对原件。");
          return { artifactId: entry.id, revision, quote: ref.quote };
        }),
      )),
    );
  }
  return scriptDraftSchema.parse({ ...draft, sources: references });
}

export function parseEditorHead(
  entry: PlatformContent,
  value: unknown,
): ScriptEditorHeader {
  const head = scriptEditorHeadSchema.parse(value);
  if (
    head.id !== entry.appObjectId ||
    head.projectId !== entry.projectId ||
    head.title !== entry.title ||
    String(head.activityRevision) !== entry.observedVersionRef
  )
    throw new Error("剧本目录与原件已变化，请重新打开。");
  return {
    ...head,
    contentId: entry.id,
    catalogRevision: entry.revision,
    providerRevision: entry.providerRevision,
  };
}

/** Each bounded page remains tied to the same app revision. Completing a
 * metadata directory does not materialize any manuscript or old version. */
export async function collectEditorPage<
  K extends keyof typeof editorPageSchemas,
>(
  read: (request: ScriptEditorPageRequest) => Promise<unknown>,
  production: Pick<
    ScriptEditorProduction,
    "contentId" | "id" | "activityRevision"
  >,
  panel: K,
  itemId?: string,
): Promise<ScriptPanel<K>> {
  const schema = editorPageSchemas[panel];
  let combined: Record<string, unknown> | undefined;
  let after: string | undefined;
  const cursors = new Set<string>();
  const field = {
    directory: "items",
    candidates: "candidates",
    versions: "versions",
    events: "events",
    reviews: "reviews",
    exports: "exports",
    metadata: "versions",
  }[panel];
  let collected = 0;
  do {
    const page = schema.parse(
      await read({
        contentId: production.contentId,
        panel,
        ...(itemId ? { itemId } : {}),
        limit: 100,
        ...(after ? { after } : {}),
        expectedActivityRevision: production.activityRevision,
      }),
    );
    if (
      page.productionId !== production.id ||
      page.activityRevision !== production.activityRevision ||
      ("itemId" in page && page.itemId !== (itemId ?? null))
    )
      throw new Error("剧本已变化，请重新读取这个面板。");
    const rows = (page as unknown as Record<string, unknown>)[
      field
    ] as unknown[];
    collected += rows.length;
    if (combined) {
      if (combined.total !== page.total)
        throw new Error("剧本分页计数已变化，请重试。");
      (combined[field] as unknown[]).push(...rows);
    } else combined = { ...page, [field]: [...rows] };
    after = page.nextCursor ?? undefined;
    if (after && (!rows.length || cursors.has(after)))
      throw new Error("剧本分页未向前推进，请重试。");
    if (after) cursors.add(after);
  } while (after);
  if (collected !== combined!.total)
    throw new Error("剧本面板尚未完整读取，请重试。");
  const { nextCursor: _cursor, ...complete } = combined!;
  return complete as ScriptPanel<K>;
}

export async function parseEditorVersion(
  source: PlatformClient,
  value: unknown,
  signal?: AbortSignal,
): Promise<ScriptEditorVersion> {
  const version = exactItemSchema.parse(value);
  return {
    ...version,
    draft: await editorDraftForClient(source, version.draft, signal),
  };
}
export async function parseEditorCandidate(
  source: PlatformClient,
  value: unknown,
  signal?: AbortSignal,
): Promise<ScriptEditorCandidate> {
  const candidate = scriptCandidateDetailSchema.parse(value);
  return {
    ...candidate,
    draft: await editorDraftForClient(source, candidate.draft, signal),
  };
}
export type { ScriptEditorPageRequest, ScriptEditorDetailRequest };
