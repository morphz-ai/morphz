import { z } from "zod";
import { DomainError } from "../../core/src/model.js";
import { scriptProductionSchema } from "../../core/src/script-studio.js";
import {
  scriptEditorHeadSchema,
  scriptDirectoryPageSchema,
  scriptCandidatePageSchema,
  scriptVersionPageSchema,
  scriptVersionTitleSchema,
  scriptEventPageSchema,
  scriptReviewPageSchema,
  scriptExportPageSchema,
  scriptMetadataPageSchema,
  scriptCandidateDetailSchema,
  scriptReviewDetailSchema,
  scriptExportDetailSchema,
  scriptEditorDraftSchema,
  type ScriptEditorPageRequest,
  type ScriptEditorPage,
} from "../../core/src/script-editor.js";
import {
  safeInteger,
  type SqlQuery,
  type SqlScalar,
} from "../../storage/src/sql.js";

type Row = Record<string, unknown>;
type Scope = { tenantId: string; productionId: string; projectId: string };
type Format = {
  brief: (row: Row) => z.infer<typeof scriptProductionSchema.shape.brief>;
  template: (row: Row) => z.infer<typeof scriptProductionSchema.shape.template>;
  backend: "sqlite" | "postgres";
};
const integer = (value: unknown) =>
  safeInteger(value as number | string, "剧本计数或版本");
const author = (row: Row, prefix = "author") => ({
  principalId: String(row[`${prefix}_principal_id`]),
  actantId: String(row[`${prefix}_actant_id`]),
});
const candidateValid = `c.base_creative_epoch=p.creative_epoch AND target.head_revision=c.base_item_revision AND NOT EXISTS (SELECT 1 FROM script_candidate_references ref LEFT JOIN script_items dependency ON dependency.tenant_id=ref.tenant_id AND dependency.item_id=ref.item_id WHERE ref.tenant_id=c.tenant_id AND ref.candidate_id=c.candidate_id AND (dependency.item_id IS NULL OR dependency.head_revision<>ref.revision))`;
const chars = (format: Format, alias = "d") =>
  format.backend === "sqlite"
    ? `length(replace(${alias}.body_text,char(0),'x'))`
    : `length(${alias}.body_text)`;
const cursorSchema = z
  .object({
    v: z.literal(1),
    productionId: z.string(),
    panel: z.string(),
    itemId: z.string().nullable(),
    activityRevision: z.number().int().positive(),
    ordinal: z.number().int().nonnegative(),
    id: z.string(),
  })
  .strict();
type Cursor = z.infer<typeof cursorSchema>;

async function production(q: SqlQuery, scope: Scope) {
  const row = (
    await q.all<Row>(
      "SELECT * FROM script_productions WHERE tenant_id=? AND production_id=? AND deleted_at IS NULL",
      [scope.tenantId, scope.productionId],
    )
  )[0];
  if (!row) throw new DomainError("not_found", "剧本不存在。");
  return row;
}
export async function editorHead(q: SqlQuery, scope: Scope, format: Format) {
  const row = await production(q, scope);
  const values = [scope.tenantId, scope.productionId];
  const totals = (
    await q.all<Row>(
      `SELECT
    (SELECT COUNT(*) FROM script_items WHERE tenant_id=? AND production_id=?) AS items,
    (SELECT COUNT(*) FROM script_candidates WHERE tenant_id=? AND production_id=?) AS candidates,
    (SELECT COUNT(*) FROM script_candidates c JOIN script_productions p ON p.tenant_id=c.tenant_id AND p.production_id=c.production_id JOIN script_items target ON target.tenant_id=c.tenant_id AND target.item_id=c.target_item_id WHERE c.tenant_id=? AND c.production_id=? AND c.status='pending' AND ${candidateValid}) AS pending_candidates,
    (SELECT COUNT(*) FROM script_reviews r JOIN script_items i ON i.tenant_id=r.tenant_id AND i.item_id=r.item_id WHERE i.tenant_id=? AND i.production_id=?) AS reviews,
    (SELECT COUNT(*) FROM script_reviews r JOIN script_items i ON i.tenant_id=r.tenant_id AND i.item_id=r.item_id WHERE i.tenant_id=? AND i.production_id=? AND r.resolved_at IS NULL AND COALESCE(r.historical_only,0)=0) AS pending_reviews,
    (SELECT COUNT(*) FROM script_exports WHERE tenant_id=? AND production_id=?) AS exports,
    (SELECT COUNT(*) FROM script_metadata_versions WHERE tenant_id=? AND production_id=?) AS metadata_versions`,
      Array.from({ length: 7 }, () => values).flat(),
    )
  )[0]!;
  const reviewers = await q.all<Row>(
    "SELECT principal_id FROM script_reviewers WHERE tenant_id=? AND production_id=? ORDER BY ordinal",
    values,
  );
  return scriptEditorHeadSchema.parse({
    id: scope.productionId,
    projectId: scope.projectId,
    title: row.title,
    revision: integer(row.metadata_revision),
    activityRevision: integer(row.activity_revision),
    creativeEpoch: integer(row.creative_epoch),
    createdBy: author(row, "created_by"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    brief: format.brief(row),
    template: format.template(row),
    reviewerPrincipalIds: reviewers.map((r) => r.principal_id),
    totals: {
      items: integer(totals.items),
      candidates: integer(totals.candidates),
      pendingCandidates: integer(totals.pending_candidates),
      reviews: integer(totals.reviews),
      pendingReviews: integer(totals.pending_reviews),
      exports: integer(totals.exports),
      metadataVersions: integer(totals.metadata_versions),
    },
  });
}

/** Each keyset page pins a mutable activity revision and exact panel scope.
 * Counts scan metadata, never historical manuscript text. No page is presented
 * as a complete production. Current data changes require an explicit restart. */
export async function editorPage(
  q: SqlQuery,
  scope: Scope,
  format: Format,
  request: Omit<ScriptEditorPageRequest, "contentId">,
): Promise<ScriptEditorPage> {
  const p = await production(q, scope);
  const activityRevision = integer(p.activity_revision);
  let after: Cursor | undefined;
  if (request.after !== undefined) {
    try {
      after = cursorSchema.parse(
        JSON.parse(Buffer.from(request.after, "base64url").toString("utf8")),
      );
    } catch {
      throw new DomainError("invalid", "剧本分页位置无效。");
    }
    if (
      after.productionId !== scope.productionId ||
      after.panel !== request.panel ||
      after.itemId !== (request.itemId ?? null)
    )
      throw new DomainError("invalid", "分页位置与当前剧本面板不一致。");
  }
  if (
    (after && after.activityRevision !== activityRevision) ||
    (request.expectedActivityRevision !== undefined &&
      request.expectedActivityRevision !== activityRevision)
  )
    throw new DomainError("conflict", "剧本已有更新，请重新读取当前面板。");
  if (request.itemId) {
    const item = (
      await q.all<Row>(
        "SELECT item_id FROM script_items WHERE tenant_id=? AND production_id=? AND item_id=?",
        [scope.tenantId, scope.productionId, request.itemId],
      )
    )[0];
    if (!item) throw new DomainError("not_found", "剧本条目不存在。");
  }
  const limit = request.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new DomainError("invalid", "分页大小应为 1 至 100。");
  const base = { productionId: scope.productionId, activityRevision };
  const encode = (rows: Row[], ordinalKey: string, idKey: string) => {
    const last = rows.slice(0, limit).at(-1);
    return rows.length > limit && last
      ? Buffer.from(
          JSON.stringify({
            v: 1,
            productionId: scope.productionId,
            panel: request.panel,
            itemId: request.itemId ?? null,
            activityRevision,
            ordinal: integer(last[ordinalKey]),
            id: String(last[idKey]),
          }),
        ).toString("base64url")
      : null;
  };
  const predicate = (
    ordinal: string,
    id: string,
    values: SqlScalar[],
    desc = false,
  ) => {
    if (!after) return "";
    values.push(after.ordinal, after.ordinal, after.id);
    const op = desc ? "<" : ">";
    return ` AND (${ordinal}${op}? OR (${ordinal}=? AND ${id}${op}?))`;
  };
  const countRows = async (
    from: string,
    condition: string,
    values: SqlScalar[],
  ) =>
    integer(
      (
        await q.all<Row>(
          `SELECT COUNT(*) AS total FROM ${from} WHERE ${condition}`,
          values,
        )
      )[0]!.total,
    );
  const values: SqlScalar[] = [scope.tenantId, scope.productionId];
  if (request.panel === "directory") {
    const total = await countRows(
      "script_items",
      "tenant_id=? AND production_id=?",
      values,
    );
    const where = predicate("i.collection_ordinal", "i.item_id", values);
    // Both adapters apply JS trim semantics inside SQL. This is the exact
    // Unicode whitespace set used by String.trim(), not SQL's ASCII-only trim.
    const whitespace =
      "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
    const trimSql =
      format.backend === "sqlite"
        ? "replace(trim(d.body_text,?),char(0),'x')"
        : "btrim(d.body_text,?)";
    const rows = await q.all<Row>(
      `SELECT i.*,d.draft_id,d.title,d.parent_item_id AS draft_parent,d.order_index AS draft_order,d.basis,${chars(format)} AS text_characters,CASE WHEN length(${trimSql})>0 THEN 1 ELSE 0 END AS has_text,(SELECT COUNT(*) FROM script_draft_sources s WHERE s.tenant_id=d.tenant_id AND s.draft_id=d.draft_id) AS source_count,(SELECT COUNT(*) FROM script_candidates c JOIN script_productions p ON p.tenant_id=c.tenant_id AND p.production_id=c.production_id JOIN script_items target ON target.tenant_id=c.tenant_id AND target.item_id=c.target_item_id WHERE c.tenant_id=i.tenant_id AND c.target_item_id=i.item_id AND c.status='pending' AND ${candidateValid}) AS pending_candidates,(SELECT COUNT(*) FROM script_reviews r WHERE r.tenant_id=i.tenant_id AND r.item_id=i.item_id AND r.resolved_at IS NULL AND COALESCE(r.historical_only,0)=0) AS pending_reviews,(SELECT COUNT(*) FROM script_reviews r WHERE r.tenant_id=i.tenant_id AND r.item_id=i.item_id AND r.resolved_at IS NULL AND COALESCE(r.historical_only,0)=0 AND r.severity='blocking') AS blocking_reviews FROM script_items i JOIN script_item_versions v ON v.tenant_id=i.tenant_id AND v.item_id=i.item_id AND v.revision=i.head_revision JOIN script_drafts d ON d.tenant_id=v.tenant_id AND d.draft_id=v.draft_id WHERE i.tenant_id=? AND i.production_id=?${where} ORDER BY i.collection_ordinal,i.item_id LIMIT ?`,
      [whitespace, ...values, limit + 1],
    );
    const page = rows.slice(0, limit);
    const ids = page.map((r) => String(r.draft_id));
    const placeholders = ids.map(() => "?").join(",");
    const deps = ids.length
      ? await q.all<Row>(
          `SELECT * FROM script_draft_dependencies WHERE tenant_id=? AND draft_id IN (${placeholders}) ORDER BY draft_id,ordinal`,
          [scope.tenantId, ...ids],
        )
      : [];
    const characters = ids.length
      ? await q.all<Row>(
          `SELECT * FROM script_draft_characters WHERE tenant_id=? AND draft_id IN (${placeholders}) ORDER BY draft_id,ordinal`,
          [scope.tenantId, ...ids],
        )
      : [];
    const approvals = page.length
      ? await q.all<Row>(
          `SELECT * FROM script_item_approvals WHERE tenant_id=? AND item_id IN (${page.map(() => "?").join(",")})`,
          [scope.tenantId, ...page.map((r) => String(r.item_id))],
        )
      : [];
    return scriptDirectoryPageSchema.parse({
      ...base,
      total,
      nextCursor: encode(rows, "collection_ordinal", "item_id"),
      items: page.map((row) => {
        const approval = approvals.find((a) => a.item_id === row.item_id);
        // Creative updates, revised drafts and blocking reviews transactionally
        // remove approvals; presence is authoritative, not a reconstructed label.
        return {
          id: row.item_id,
          kind: row.kind,
          revision: integer(row.head_revision),
          workflowRevision: integer(row.workflow_revision),
          status: row.status,
          title: row.title,
          parentId: row.draft_parent,
          order: integer(row.draft_order),
          basis: row.basis,
          textCharacters: integer(row.text_characters),
          sourceCount: integer(row.source_count),
          pendingCandidateCount: integer(row.pending_candidates),
          currentPendingReviewCount: integer(row.pending_reviews),
          blockingReviewCount: integer(row.blocking_reviews),
          hasText: integer(row.has_text) === 1,
          approvalCurrent: Boolean(
            approval &&
            integer(approval.revision) === integer(row.head_revision),
          ),
          dependencies: deps
            .filter((d) => d.draft_id === row.draft_id)
            .map((d) => ({
              itemId: d.depends_on_item_id,
              revision: integer(d.depends_on_revision),
            })),
          characters: characters
            .filter((c) => c.draft_id === row.draft_id)
            .map((c) => c.character_item_id),
          approval: approval
            ? {
                revision: integer(approval.revision),
                contextRevision: integer(approval.context_revision),
                note: approval.note,
                author: author(approval),
                createdAt: approval.created_at,
              }
            : null,
        };
      }),
    });
  }
  if (request.panel === "candidates") {
    values.push(request.itemId!);
    const total = await countRows(
      "script_candidates",
      "tenant_id=? AND production_id=? AND target_item_id=?",
      values,
    );
    const candidateFrom =
      "script_candidates c JOIN script_productions p ON p.tenant_id=c.tenant_id AND p.production_id=c.production_id JOIN script_items target ON target.tenant_id=c.tenant_id AND target.item_id=c.target_item_id";
    const condition =
      "c.tenant_id=? AND c.production_id=? AND c.target_item_id=?";
    const pendingTotal = await countRows(
      candidateFrom,
      `${condition} AND c.status='pending' AND ${candidateValid}`,
      values,
    );
    const preferred = (
      await q.all<Row>(
        `SELECT c.candidate_id FROM ${candidateFrom} WHERE ${condition} AND c.status='pending' AND ${candidateValid} ORDER BY c.collection_ordinal DESC,c.candidate_id DESC LIMIT 1`,
        values,
      )
    )[0];
    const latest =
      preferred ??
      (
        await q.all<Row>(
          `SELECT candidate_id FROM script_candidates WHERE tenant_id=? AND production_id=? AND target_item_id=? ORDER BY collection_ordinal DESC,candidate_id DESC LIMIT 1`,
          values,
        )
      )[0];
    const where = predicate(
      "c.collection_ordinal",
      "c.candidate_id",
      values,
      true,
    );
    const rows = await q.all<Row>(
      `SELECT c.*,d.title,${chars(format)} AS text_characters,CASE WHEN ${candidateValid} THEN 0 ELSE 1 END AS stale,(SELECT COUNT(*) FROM script_candidates prior WHERE prior.tenant_id=c.tenant_id AND prior.production_id=c.production_id AND prior.target_item_id=c.target_item_id AND prior.collection_ordinal<=c.collection_ordinal) AS target_ordinal,(SELECT MIN(v.revision) FROM script_item_versions v WHERE v.tenant_id=c.tenant_id AND v.item_id=c.target_item_id AND v.candidate_id=c.candidate_id) AS accepted_revision FROM ${candidateFrom} JOIN script_drafts d ON d.tenant_id=c.tenant_id AND d.draft_id=c.draft_id WHERE ${condition}${where} ORDER BY c.collection_ordinal DESC,c.candidate_id DESC LIMIT ?`,
      [...values, limit + 1],
    );
    return scriptCandidatePageSchema.parse({
      ...base,
      total,
      itemId: request.itemId,
      pendingTotal,
      defaultCandidateId: latest?.candidate_id ?? null,
      nextCursor: encode(rows, "collection_ordinal", "candidate_id"),
      candidates: rows.slice(0, limit).map(candidateHeader),
    });
  }
  if (request.panel === "versions" || request.panel === "events") {
    const version = request.panel === "versions";
    const table = version ? "script_item_versions" : "script_item_events";
    const ordinal = version ? "revision" : "ordinal";
    const scoped: SqlScalar[] = [scope.tenantId, request.itemId!];
    const total = await countRows(table, "tenant_id=? AND item_id=?", scoped);
    const where = after ? ` AND v.${ordinal}<?` : "";
    if (after) scoped.push(after.ordinal);
    const rows = await q.all<Row>(
      version
        ? `SELECT v.*,d.title,${chars(format)} AS text_characters FROM script_item_versions v JOIN script_drafts d ON d.tenant_id=v.tenant_id AND d.draft_id=v.draft_id WHERE v.tenant_id=? AND v.item_id=?${where} ORDER BY v.revision DESC LIMIT ?`
        : `SELECT v.* FROM script_item_events v WHERE v.tenant_id=? AND v.item_id=?${where} ORDER BY v.ordinal DESC LIMIT ?`,
      [...scoped, limit + 1],
    );
    const common = {
      ...base,
      total,
      itemId: request.itemId,
      nextCursor: encode(rows, ordinal, "item_id"),
    };
    return version
      ? scriptVersionPageSchema.parse({
          ...common,
          versions: rows.slice(0, limit).map((r) => ({
            revision: integer(r.revision),
            title: r.title,
            textCharacters: integer(r.text_characters),
            author: author(r),
            createdAt: r.created_at,
            candidateId: r.candidate_id,
          })),
        })
      : scriptEventPageSchema.parse({
          ...common,
          events: rows.slice(0, limit).map((r) => ({
            action: r.action,
            revision: integer(r.revision),
            author: author(r),
            createdAt: r.created_at,
            note: r.note,
          })),
        });
  }
  if (request.panel === "reviews") {
    let condition = "i.tenant_id=? AND i.production_id=?";
    if (request.itemId) {
      condition += " AND r.item_id=?";
      values.push(request.itemId);
    }
    const from =
      "script_reviews r JOIN script_items i ON i.tenant_id=r.tenant_id AND i.item_id=r.item_id";
    const total = await countRows(from, condition, values);
    const pendingTotal = await countRows(
      from,
      `${condition} AND r.resolved_at IS NULL AND COALESCE(r.historical_only,0)=0`,
      values,
    );
    const where = predicate("r.collection_ordinal", "r.review_id", values);
    const rows = await q.all<Row>(
      `SELECT r.* FROM ${from} WHERE ${condition}${where} ORDER BY r.collection_ordinal,r.review_id LIMIT ?`,
      [...values, limit + 1],
    );
    return scriptReviewPageSchema.parse({
      ...base,
      total,
      itemId: request.itemId ?? null,
      pendingTotal,
      nextCursor: encode(rows, "collection_ordinal", "review_id"),
      reviews: rows.slice(0, limit).map(reviewRecord),
    });
  }
  if (request.panel === "exports") {
    const total = await countRows(
      "script_exports",
      "tenant_id=? AND production_id=?",
      values,
    );
    const where = predicate(
      "e.collection_ordinal",
      "e.export_id",
      values,
      true,
    );
    const rows = await q.all<Row>(
      `SELECT e.*,(SELECT COUNT(*) FROM script_export_items i WHERE i.tenant_id=e.tenant_id AND i.export_id=e.export_id) AS item_count FROM script_exports e WHERE e.tenant_id=? AND e.production_id=?${where} ORDER BY e.collection_ordinal DESC,e.export_id DESC LIMIT ?`,
      [...values, limit + 1],
    );
    return scriptExportPageSchema.parse({
      ...base,
      total,
      nextCursor: encode(rows, "collection_ordinal", "export_id"),
      exports: rows.slice(0, limit).map((r) => ({
        id: r.export_id,
        createdBy: author(r, "created_by"),
        createdAt: r.created_at,
        contextRevision: integer(r.context_revision),
        itemCount: integer(r.item_count),
        format: "docx",
        ...(r.working_copy === null
          ? {}
          : { workingCopy: integer(r.working_copy) === 1 }),
      })),
    });
  }
  const total = await countRows(
    "script_metadata_versions",
    "tenant_id=? AND production_id=?",
    values,
  );
  if (after) values.push(after.ordinal);
  const rows = await q.all<Row>(
    `SELECT revision,title,author_principal_id,author_actant_id,created_at,production_id FROM script_metadata_versions WHERE tenant_id=? AND production_id=?${after ? " AND revision<?" : ""} ORDER BY revision DESC LIMIT ?`,
    [...values, limit + 1],
  );
  return scriptMetadataPageSchema.parse({
    ...base,
    total,
    nextCursor: encode(rows, "revision", "production_id"),
    versions: rows.slice(0, limit).map((r) => ({
      revision: integer(r.revision),
      title: r.title,
      author: author(r),
      createdAt: r.created_at,
    })),
  });
}

function candidateHeader(r: Row) {
  return {
    id: r.candidate_id,
    inputId: r.input_id,
    targetId: r.target_item_id,
    baseRevision: integer(r.base_item_revision),
    contextRevision: integer(r.context_revision),
    createdBy: author(r, "created_by"),
    createdAt: r.created_at,
    revision: integer(r.candidate_revision),
    status: r.status,
    decisionBy:
      r.decided_by_principal_id === null ? null : author(r, "decided_by"),
    decidedAt: r.decided_at,
    ordinal: integer(r.target_ordinal),
    title: r.title,
    textCharacters: integer(r.text_characters),
    stale: integer(r.stale) === 1,
    acceptedRevision:
      r.accepted_revision === null ? null : integer(r.accepted_revision),
  };
}
function reviewRecord(r: Row) {
  return {
    id: r.review_id,
    itemId: r.item_id,
    itemRevision: integer(r.item_revision),
    quote: r.quote_text,
    body: r.body_text,
    severity: r.severity,
    author: author(r),
    createdAt: r.created_at,
    inputId: r.input_id,
    ...(r.context_revision === null
      ? {}
      : { contextRevision: integer(r.context_revision) }),
    ...(r.historical_only === null
      ? {}
      : { historicalOnly: integer(r.historical_only) === 1 }),
    revision: integer(r.review_revision),
    resolvedBy:
      r.resolved_by_principal_id === null ? null : author(r, "resolved_by"),
    resolvedAt: r.resolved_at,
    resolution: r.resolution ?? "",
  };
}
export async function readEditorDraft(
  q: SqlQuery,
  tenantId: string,
  draftId: string,
) {
  const row = (
    await q.all<Row>(
      "SELECT * FROM script_drafts WHERE tenant_id=? AND draft_id=?",
      [tenantId, draftId],
    )
  )[0];
  if (!row) throw new Error("剧本文稿原件缺失。");
  const refs = [tenantId, draftId];
  const sources = await q.all<Row>(
    "SELECT * FROM script_draft_sources WHERE tenant_id=? AND draft_id=? ORDER BY ordinal",
    refs,
  );
  const deps = await q.all<Row>(
    "SELECT * FROM script_draft_dependencies WHERE tenant_id=? AND draft_id=? ORDER BY ordinal",
    refs,
  );
  const characters = await q.all<Row>(
    "SELECT * FROM script_draft_characters WHERE tenant_id=? AND draft_id=? ORDER BY ordinal",
    refs,
  );
  return scriptEditorDraftSchema.parse({
    title: row.title,
    text: row.body_text,
    parentId: row.parent_item_id,
    order: integer(row.order_index),
    basis: row.basis,
    sources: sources.map((r) => ({
      appId: r.source_app_id,
      instanceId: r.source_instance_id,
      objectId: r.source_object_id,
      versionRef: r.source_version_ref,
      quote: r.quote_text,
    })),
    dependencies: deps.map((r) => ({
      itemId: r.depends_on_item_id,
      revision: integer(r.depends_on_revision),
    })),
    location: row.location_text,
    storyTime: row.story_time,
    characters: characters.map((r) => r.character_item_id),
    audienceKnowledge: row.audience_knowledge,
    characterKnowledge: row.character_knowledge,
    setupPayoff: row.setup_payoff,
    productionNotes: row.production_notes,
  });
}
export async function candidateDetail(
  q: SqlQuery,
  scope: Scope,
  candidateId: string,
  format: Format,
) {
  const row = (
    await q.all<Row>(
      `SELECT c.*,d.title,${chars(format)} AS text_characters,CASE WHEN ${candidateValid} THEN 0 ELSE 1 END AS stale,(SELECT COUNT(*) FROM script_candidates prior WHERE prior.tenant_id=c.tenant_id AND prior.production_id=c.production_id AND prior.target_item_id=c.target_item_id AND prior.collection_ordinal<=c.collection_ordinal) AS target_ordinal,(SELECT MIN(v.revision) FROM script_item_versions v WHERE v.tenant_id=c.tenant_id AND v.item_id=c.target_item_id AND v.candidate_id=c.candidate_id) AS accepted_revision FROM script_candidates c JOIN script_productions p ON p.tenant_id=c.tenant_id AND p.production_id=c.production_id JOIN script_items target ON target.tenant_id=c.tenant_id AND target.item_id=c.target_item_id JOIN script_drafts d ON d.tenant_id=c.tenant_id AND d.draft_id=c.draft_id WHERE c.tenant_id=? AND c.production_id=? AND c.candidate_id=? AND p.deleted_at IS NULL`,
      [scope.tenantId, scope.productionId, candidateId],
    )
  )[0];
  if (!row) throw new DomainError("not_found", "候选稿不存在。");
  const refs = await q.all<Row>(
    "SELECT item_id,revision FROM script_candidate_references WHERE tenant_id=? AND candidate_id=? ORDER BY ordinal",
    [scope.tenantId, candidateId],
  );
  const {
    title: _title,
    textCharacters: _characters,
    ...header
  } = candidateHeader(row);
  return scriptCandidateDetailSchema.parse({
    ...header,
    references: refs.map((r) => ({
      itemId: r.item_id,
      revision: integer(r.revision),
    })),
    draft: await readEditorDraft(q, scope.tenantId, String(row.draft_id)),
    explanation: row.explanation,
  });
}
export async function reviewDetail(
  q: SqlQuery,
  scope: Scope,
  reviewId: string,
) {
  await production(q, scope);
  const row = (
    await q.all<Row>(
      "SELECT r.* FROM script_reviews r JOIN script_items i ON i.tenant_id=r.tenant_id AND i.item_id=r.item_id WHERE i.tenant_id=? AND i.production_id=? AND r.review_id=?",
      [scope.tenantId, scope.productionId, reviewId],
    )
  )[0];
  if (!row) throw new DomainError("not_found", "审改意见不存在。");
  return scriptReviewDetailSchema.parse(reviewRecord(row));
}
export async function exportDetail(
  q: SqlQuery,
  scope: Scope,
  exportId: string,
  format: Format,
) {
  await production(q, scope);
  const row = (
    await q.all<Row>(
      "SELECT * FROM script_exports WHERE tenant_id=? AND production_id=? AND export_id=?",
      [scope.tenantId, scope.productionId, exportId],
    )
  )[0];
  if (!row) throw new DomainError("not_found", "导出记录不存在。");
  const items = await q.all<Row>(
    "SELECT item_id,revision FROM script_export_items WHERE tenant_id=? AND export_id=? ORDER BY ordinal",
    [scope.tenantId, exportId],
  );
  return scriptExportDetailSchema.parse({
    id: exportId,
    createdBy: author(row, "created_by"),
    createdAt: row.created_at,
    contextRevision: integer(row.context_revision),
    format: "docx",
    ...(row.working_copy === null
      ? {}
      : { workingCopy: integer(row.working_copy) === 1 }),
    template: format.template(row),
    items: items.map((r) => ({
      itemId: r.item_id,
      revision: integer(r.revision),
    })),
  });
}

export async function contextDetail(
  q: SqlQuery,
  scope: Scope,
  revision: number,
  format: Format,
) {
  await production(q, scope);
  const row = (
    await q.all<Row>(
      "SELECT * FROM script_metadata_versions WHERE tenant_id=? AND production_id=? AND revision=?",
      [scope.tenantId, scope.productionId, revision],
    )
  )[0];
  if (!row) throw new DomainError("not_found", "剧本规范版本不存在。");
  const reviewers = await q.all<Row>(
    "SELECT principal_id FROM script_metadata_reviewers WHERE tenant_id=? AND production_id=? AND revision=? ORDER BY ordinal",
    [scope.tenantId, scope.productionId, revision],
  );
  return scriptProductionSchema.shape.metadataHistory.element.parse({
    revision,
    title: row.title,
    brief: format.brief(row),
    template: format.template(row),
    reviewerPrincipalIds: reviewers.map((r) => r.principal_id),
    author: author(row),
    createdAt: row.created_at,
  });
}

export async function versionTitle(
  q: SqlQuery,
  scope: Scope,
  itemId: string,
  revision: number,
) {
  const row = (
    await q.all<Row>(
      "SELECT d.title FROM script_productions p JOIN script_items i ON i.tenant_id=p.tenant_id AND i.production_id=p.production_id JOIN script_item_versions v ON v.tenant_id=i.tenant_id AND v.item_id=i.item_id AND v.revision=? JOIN script_drafts d ON d.tenant_id=v.tenant_id AND d.draft_id=v.draft_id WHERE p.tenant_id=? AND p.production_id=? AND p.deleted_at IS NULL AND i.item_id=?",
      [revision, scope.tenantId, scope.productionId, itemId],
    )
  )[0];
  if (!row) throw new DomainError("not_found", "剧本条目或版本不存在。");
  return scriptVersionTitleSchema.parse({
    productionId: scope.productionId, itemId, revision, title: row.title,
  });
}
