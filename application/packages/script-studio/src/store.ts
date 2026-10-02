import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { z } from "zod";
import { DomainError } from "../../core/src/model.js";
import type { ScriptOutput } from "../../core/src/script-delivery.js";
import {
  scriptWorkflowReportSchema,
  type ScriptWorkflowReport,
} from "../../core/src/script-tool.js";
import {
  defaultScriptExportTemplate,
  emptyScriptBrief,
  emptyScriptDraft,
  scriptCreativeContext,
  scriptIssues,
  scriptImpact,
  currentScriptDraft,
  scriptDraftSchema,
  scriptBriefSchema,
  scriptExportTemplateSchema,
  scriptItemKinds,
  prepareScriptGeneration,
  scriptGenerationSchema,
  scriptContextCurrent,
  scriptPreparationRequestSchema,
  scriptProductionSchema,
  type ScriptDraft,
  type ScriptGeneration,
  type ScriptProduction,
} from "../../core/src/script-studio.js";
import {
  postgresQuery,
  safeInteger,
  schemaHash,
  verifySchemaObjects,
  sqliteQuery,
  prepareSqlCommit,
  publishSqlCommit,
  type SqlQuery,
  type SqlScalar,
} from "../../storage/src/sql.js";
import {
  sqliteChangeSource,
  postgresChangeSource,
  type SqlChangeSource,
} from "../../storage/src/commit-notifications.js";
import { scriptStudioSchemaSql } from "./schema.js";
import {
  scriptEditorPageRequestSchema,
  type ScriptEditorPageRequest,
} from "../../core/src/script-editor.js";
import {
  editorHead,
  editorPage,
  candidateDetail,
  reviewDetail,
  exportDetail,
  contextDetail,
  versionTitle,
} from "./editor-read.js";

type Backend =
  | { kind: "sqlite"; database: DatabaseSync }
  | { kind: "postgres"; pool: Pool; schema: string };
type Row = Record<string, unknown>;

// The installed v2 schema differs from the reviewed schema only by these two
// read indexes. Keep the exact prior fingerprint so an unrelated or damaged
// database cannot be mistaken for an upgrade candidate.
const scriptStudioV2Hash =
  "f1bcec4486f3077839b135132b52084683e7ea16f6729232b827f09cfd3cb56c";
const scriptStudioV3Hash =
  "94960ac44ec24b0153d382afc42cb67d3ff32825383986ecbd7a745b2c356427";
const scriptStudioV3Indexes = [
  "CREATE INDEX candidates_by_input ON script_candidates(tenant_id, production_id, input_id, created_at, candidate_id);",
  "CREATE INDEX reviews_by_input ON script_reviews(tenant_id, input_id, created_at, review_id);",
] as const;
const scriptStudioV4Index =
  "CREATE INDEX script_receipts_by_input ON script_command_receipts(tenant_id, input_id, committed_at, command_id);";
const scriptStudioV4ReviewColumn = "  command_id TEXT,\n";
const scriptStudioV4Hash =
  "0abba0b4f79bf068515fb9761cf5de6eff78cacb53d19fd95658f906e41f2a7f";
const scriptStudioV6Hash =
  "c8eaf0cd6c5f75c86a49793b94bdba4039e3578f04083cbff2ce65839987dca7";
const scriptStudioV7TaskColumn =
  "  task_request TEXT NOT NULL DEFAULT '' CHECK (length(task_request) <= 12000),\n";
const scriptStudioV7Indexes = [
  "CREATE UNIQUE INDEX script_preparations_by_input_target ON script_preparations(tenant_id, input_id, target_item_id);",
  "CREATE INDEX script_preparations_by_input_order ON script_preparations(tenant_id, input_id, collection_ordinal, preparation_id);",
] as const;
const scriptStudioV6Sql = scriptStudioV7Indexes.reduce(
  (sql, statement) => sql.replace(statement + "\n", ""),
  scriptStudioSchemaSql.replace(scriptStudioV7TaskColumn, ""),
);
const scriptStudioV6IndexesSql = scriptStudioV6Sql.slice(
  scriptStudioV6Sql.indexOf("-- Bounded editor reads:"),
);
const scriptStudioV5Sql =
  scriptStudioV6Sql
    .slice(0, scriptStudioV6Sql.indexOf("-- Bounded editor reads:"))
    .trimEnd() + "\n";
const scriptStudioV5Hash = schemaHash(scriptStudioV5Sql);
const scriptStudioV5ReportsSql = scriptStudioSchemaSql.slice(
  scriptStudioSchemaSql.indexOf("-- Workflow reports"),
  scriptStudioSchemaSql.indexOf("CREATE TABLE script_outbox"),
);
const scriptStudioV4Sql = scriptStudioV5Sql.replace(
  scriptStudioV5ReportsSql,
  "",
);
const scriptStudioV3Sql = scriptStudioV4Sql
  .replace(scriptStudioV4Index, "")
  .replace(scriptStudioV4ReviewColumn, "");
const scriptStudioV2Sql = scriptStudioV3Indexes.reduce(
  (sql, statement) => sql.replace(statement, ""),
  scriptStudioV3Sql,
);

export type ScriptStudioAuthority = {
  /** Runtime owns execution lifecycle. This hook only checks the accepted
   * input's current delivery; it never creates an app-owned execution state. */
  assertInputActive?(inputId: string): Promise<void>;
  /** The host resolves the actual Human and persisted Runtime invocation source.
   * A project ID supplied by a model is never authorization by itself.
   */
  authorizeCreate(request: { credential: string; projectId: string }): Promise<{
    tenantId: string;
    principalId: string;
    actantId: string;
    kind: "human" | "agent";
    runtimeInputId: string | null;
    runtimeTaskRunEventId?: string | null;
  } | null>;
  /** A preparation lookup reads the accepted input's scope; it does not
   * authorize creating an original in that communication/working space. */
  authorizeProjectRead?(request: {
    credential: string;
    projectId: string;
  }): ReturnType<ScriptStudioAuthority["authorizeCreate"]>;
  authorizeObject(request: {
    credential: string;
    productionId: string;
    operation: "read" | "write";
  }): Promise<{
    tenantId: string;
    principalId: string;
    actantId: string;
    kind: "human" | "agent";
    runtimeInputId: string | null;
    runtimeTaskRunEventId?: string | null;
    projectId: string;
    objectKind: string;
  } | null>;
  verifyReviewers?(request: {
    credential: string;
    projectId: string;
    principalIds: string[];
  }): Promise<boolean>;
  /** Only the owning source App can confirm an exact version and quote.
   * Directory visibility alone is not proof that the text is still readable.
   */
  verifySourceVersion?(request: {
    credential: string;
    tenantId: string;
    principalId: string;
    actantId: string;
    kind: "human" | "agent";
    runtimeInputId: string | null;
    runtimeTaskRunEventId?: string | null;
    productionProjectId: string;
    alreadyPinned: boolean;
    appId: string;
    instanceId: string;
    objectId: string;
    versionRef: string;
    quote: string;
  }): Promise<boolean>;
};

export type ScriptProductionReceipt = {
  tenantId: string;
  productionId: string;
  title: string;
  requestedProjectId: string;
  versionRef: "1";
  receiptId: string;
  eventId: string;
};

export type ScriptProductionUpdateReceipt = {
  tenantId: string;
  productionId: string;
  metadataRevision: number;
  activityRevision: number;
  versionRef: string;
  title: string;
  receiptId: string;
  eventId: string | null;
};

export type ScriptCandidateDecisionReceipt = {
  tenantId: string;
  productionId: string;
  candidateId: string;
  candidateRevision: number;
  decision: "accept" | "reject";
  adoptedItemId: string | null;
  adoptedItemRevision: number | null;
  activityRevision: number;
  versionRef: string;
  title: string;
  receiptId: string;
  eventId: string;
};

export type ScriptItemCursor = { ordinal: number; itemId: string };

export type ScriptItemPage = {
  activityRevision: number;
  items: Array<{
    itemId: string;
    kind: ScriptProduction["items"][number]["kind"];
    parentId: string | null;
    order: number;
    title: string;
    revision: number;
    workflowRevision: number;
    status: ScriptProduction["items"][number]["status"];
  }>;
  nextCursor: ScriptItemCursor | null;
};

export const liveScriptDraftSchema = scriptDraftSchema
  .omit({ sources: true })
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
  });
export type LiveScriptDraft = z.infer<typeof liveScriptDraftSchema>;

export type ScriptItemCreationReceipt = {
  tenantId: string;
  productionId: string;
  itemId: string;
  itemRevision: 1;
  activityRevision: number;
  versionRef: string;
  title: string;
  receiptId: string;
  eventId: string;
};

export type ScriptItemRevisionReceipt = {
  tenantId: string;
  productionId: string;
  itemId: string;
  itemRevision: number;
  activityRevision: number;
  versionRef: string;
  title: string;
  receiptId: string;
  eventId: string;
};

export type ScriptPreparationReceipt = {
  preparationId: string;
  inputId: string;
  generation: ScriptGeneration;
  generations: ScriptGeneration[];
  /** Semantic task interpretation, never an input rewrite or authorization. */
  task: string;
  receiptId: string;
};

export type ScriptCandidateSubmissionReceipt = {
  tenantId: string;
  productionId: string;
  candidateId: string;
  inputId: string;
  activityRevision: number;
  versionRef: string;
  title: string;
  receiptId: string;
  eventId: string;
};

export type ScriptExportReceipt = {
  tenantId: string;
  productionId: string;
  exportId: string;
  activityRevision: number;
  versionRef: string;
  title: string;
  receiptId: string;
  eventId: string;
};

export type ScriptWorkflowReceipt = {
  tenantId: string;
  productionId: string;
  itemId: string;
  activityRevision: number;
  versionRef: string;
  title: string;
  receiptId: string;
  eventId: string;
};

export type ScriptReviewReceipt = {
  tenantId: string;
  productionId: string;
  reviewId: string;
  activityRevision: number;
  versionRef: string;
  title: string;
  receiptId: string;
  eventId: string;
};

export type ScriptReviewBatchReceipt = ScriptReviewReceipt & {
  reviewIds: string[];
};

const domainId = /^[a-zA-Z0-9_-]{1,100}$/;
function requireDomainId(value: string, label: string) {
  if (!domainId.test(value)) throw new Error(`${label}无效。`);
  return value;
}

function bool(value: boolean) {
  return value ? 1 : 0;
}
function readBool(value: number | string) {
  if (Number(value) !== 0 && Number(value) !== 1)
    throw new Error("应用数据库中的布尔值无效。");
  return Number(value) === 1;
}
function optionalBool(value: number | string | null): boolean | undefined {
  return value === null ? undefined : readBool(value);
}
function templateColumns(template: ScriptProduction["template"]) {
  return {
    template_title: template.title,
    template_include_notes: bool(template.includeNotes),
    template_include_continuity: bool(template.includeContinuity),
    template_page_break_episodes: bool(template.pageBreakEpisodes),
    template_font: template.font,
    template_font_size: template.fontSize,
    template_scene_heading: template.sceneHeading,
  };
}
function briefColumns(brief: ScriptProduction["brief"]) {
  return {
    mode: brief.mode,
    audience: brief.audience,
    genre: brief.genre,
    episode_count: brief.episodeCount,
    episode_seconds: brief.episodeSeconds,
    style: brief.style,
    constraints_text: brief.constraints,
    rights_statement: brief.rightsStatement,
    model_processing_allowed: bool(brief.modelProcessingAllowed),
  };
}
function readTemplate(row: Row): ScriptProduction["template"] {
  return {
    title: String(row.template_title),
    includeNotes: readBool(row.template_include_notes as number | string),
    includeContinuity: readBool(
      row.template_include_continuity as number | string,
    ),
    pageBreakEpisodes: readBool(
      row.template_page_break_episodes as number | string,
    ),
    font: row.template_font as ScriptProduction["template"]["font"],
    fontSize: safeInteger(row.template_font_size as number | string, "字号"),
    sceneHeading: String(row.template_scene_heading),
  };
}
function readBrief(row: Row): ScriptProduction["brief"] {
  return {
    mode: row.mode as ScriptProduction["brief"]["mode"],
    audience: String(row.audience),
    genre: String(row.genre),
    episodeCount: safeInteger(row.episode_count as number | string, "集数"),
    episodeSeconds: safeInteger(
      row.episode_seconds as number | string,
      "单集时长",
    ),
    style: String(row.style),
    constraints: String(row.constraints_text),
    rightsStatement: String(row.rights_statement),
    modelProcessingAllowed: readBool(
      row.model_processing_allowed as number | string,
    ),
  };
}
async function insert(
  q: SqlQuery,
  table: string,
  record: Record<string, SqlScalar>,
) {
  const columns = Object.keys(record);
  const placeholders = columns.map(() => "?").join(",");
  await q.change(
    `INSERT INTO ${table}(${columns.join(",")}) VALUES(${placeholders})`,
    Object.values(record),
  );
}
function draftIdentity(productionId: string, owner: string) {
  return `draft_${createHash("sha256").update(`${productionId}\0${owner}`).digest("hex").slice(0, 40)}`;
}

/** App-owned relation store. Import is for an offline, unactivated migration target. */
export class ScriptStudioStore {
  private gate: Promise<unknown> = Promise.resolve();
  private readonly sqlChanges: SqlChangeSource;
  private constructor(
    private readonly backend: Backend,
    private readonly authority?: ScriptStudioAuthority,
  ) {
    this.sqlChanges =
      backend.kind === "sqlite"
        ? sqliteChangeSource(backend.database)
        : postgresChangeSource(backend.pool.options, backend.schema);
  }

  changeSource(): SqlChangeSource {
    return this.sqlChanges;
  }

  static async sqlite(
    filename: string,
    authority?: ScriptStudioAuthority,
  ): Promise<ScriptStudioStore> {
    if (filename !== ":memory:")
      mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    if (filename !== ":memory:" && existsSync(filename)) {
      const check = new DatabaseSync(filename, { readOnly: true });
      try {
        const tables = check
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          )
          .all() as { name: string }[];
        if (
          tables.length &&
          !tables.some((table) => table.name === "script_schema_version")
        )
          throw new Error("目标文件不属于剧本工作室，拒绝混用。");
      } finally {
        check.close();
      }
    }
    const database = new DatabaseSync(filename);
    try {
      if (filename !== ":memory:") chmodSync(filename, 0o600);
      database.exec(
        "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;",
      );
      const store = new ScriptStudioStore(
        { kind: "sqlite", database },
        authority,
      );
      await store.initialize();
      return store;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  static async postgres(options: {
    connectionString: string;
    schema: string;
    authority?: ScriptStudioAuthority;
  }): Promise<ScriptStudioStore> {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(options.schema))
      throw new Error("剧本数据库 schema 名称无效。");
    const pool = new Pool({
      connectionString: options.connectionString,
      max: 10,
    });
    try {
      const store = new ScriptStudioStore(
        {
          kind: "postgres",
          pool,
          schema: options.schema,
        },
        options.authority,
      );
      await store.initialize();
      return store;
    } catch (error) {
      await pool.end();
      throw error;
    }
  }

  private async transaction<T>(
    work: (q: SqlQuery) => Promise<T>,
    readOnly = false,
  ): Promise<T> {
    if (this.backend.kind === "sqlite") {
      const database = this.backend.database;
      const run = async () => {
        if (readOnly) database.exec("PRAGMA query_only=ON");
        try {
          database.exec(readOnly ? "BEGIN" : "BEGIN IMMEDIATE");
          try {
            const q = sqliteQuery(database);
            const value = await work(q);
            database.exec("COMMIT");
            publishSqlCommit(q, this.sqlChanges);
            return value;
          } catch (error) {
            database.exec("ROLLBACK");
            throw error;
          }
        } finally {
          if (readOnly) database.exec("PRAGMA query_only=OFF");
        }
      };
      const pending = this.gate.then(run, run);
      this.gate = pending.catch(() => undefined);
      return pending;
    }
    const client = await this.backend.pool.connect();
    try {
      await client.query(
        readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN",
      );
      await client.query(
        `SET LOCAL search_path TO "${this.backend.schema}", pg_catalog`,
      );
      const q = postgresQuery(client);
      const value = await work(q);
      await prepareSqlCommit(q, this.sqlChanges);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async initialize() {
    await this.transaction(async (q) => {
      if (this.backend.kind === "postgres")
        await q.all(
          "SELECT pg_advisory_xact_lock(hashtextextended(current_database() || ':' || current_schema(), 0)) AS locked",
        );
      const tables =
        this.backend.kind === "postgres"
          ? await q.all<{ name: string }>(
              "SELECT tablename AS name FROM pg_catalog.pg_tables WHERE schemaname=current_schema()",
            )
          : await q.all<{ name: string }>(
              "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            );
      if (
        tables.length &&
        !tables.some((t) => t.name === "script_schema_version")
      )
        throw new Error("目标 schema 含非剧本工作室表，拒绝混用。");
      await q.exec(
        "CREATE TABLE IF NOT EXISTS script_schema_version(version BIGINT PRIMARY KEY CHECK(version > 0), schema_sha256 TEXT NOT NULL)",
      );
      const versions = await q.all<{
        version: number | string;
        schema_sha256: string;
      }>("SELECT version,schema_sha256 FROM script_schema_version");
      const schemaSha256 = schemaHash(scriptStudioSchemaSql);
      if (versions.length > 1)
        throw new Error("剧本工作室数据库结构与当前程序不一致。");
      if (versions.length) {
        const installed = versions[0]!;
        const version = Number(installed.version);
        const priorV2 =
          version === 2 && installed.schema_sha256 === scriptStudioV2Hash;
        const priorV3 =
          version === 3 && installed.schema_sha256 === scriptStudioV3Hash;
        const priorV4 =
          version === 4 && installed.schema_sha256 === scriptStudioV4Hash;
        const priorV5 =
          version === 5 && installed.schema_sha256 === scriptStudioV5Hash;
        const priorV6 =
          version === 6 && installed.schema_sha256 === scriptStudioV6Hash;
        const currentSchema =
          version === 7 && installed.schema_sha256 === schemaSha256;
        if (
          !priorV2 &&
          !priorV3 &&
          !priorV4 &&
          !priorV5 &&
          !priorV6 &&
          !currentSchema
        )
          throw new Error("剧本工作室数据库结构与当前程序不一致。");
        if (priorV2) {
          if (schemaHash(scriptStudioV2Sql) !== scriptStudioV2Hash)
            throw new Error("剧本工作室旧结构定义与迁移不一致。");
          await verifySchemaObjects(
            q,
            this.backend.kind,
            scriptStudioV2Sql,
            ["script_schema_version"],
            ["morphz_app_binding"],
          );
          await q.exec(scriptStudioV3Indexes.join("\n"));
        }
        if (priorV2 || priorV3) {
          if (schemaHash(scriptStudioV3Sql) !== scriptStudioV3Hash)
            throw new Error("剧本工作室旧结构定义与迁移不一致。");
          await verifySchemaObjects(
            q,
            this.backend.kind,
            scriptStudioV3Sql,
            ["script_schema_version"],
            ["morphz_app_binding"],
          );
          await q.exec(
            "ALTER TABLE script_reviews ADD COLUMN command_id TEXT;",
          );
          await q.exec(scriptStudioV4Index);
        }
        if (priorV2 || priorV3 || priorV4) {
          if (schemaHash(scriptStudioV4Sql) !== scriptStudioV4Hash)
            throw new Error("剧本工作室检查报告升级定义不一致。");
          await verifySchemaObjects(
            q,
            this.backend.kind,
            scriptStudioV4Sql,
            ["script_schema_version"],
            ["morphz_app_binding"],
          );
          await q.exec(scriptStudioV5ReportsSql);
        }
        if (priorV2 || priorV3 || priorV4 || priorV5) {
          await verifySchemaObjects(
            q,
            this.backend.kind,
            scriptStudioV5Sql,
            ["script_schema_version"],
            ["morphz_app_binding"],
          );
          await q.exec(scriptStudioV6IndexesSql);
        }
        if (priorV2 || priorV3 || priorV4 || priorV5 || priorV6) {
          if (schemaHash(scriptStudioV6Sql) !== scriptStudioV6Hash)
            throw new Error("剧本工作室多目标升级定义与旧结构不一致。");
          await verifySchemaObjects(
            q,
            this.backend.kind,
            scriptStudioV6Sql,
            ["script_schema_version"],
            ["morphz_app_binding"],
          );
          await q.exec(
            "ALTER TABLE script_preparations ADD COLUMN task_request TEXT NOT NULL DEFAULT '' CHECK (length(task_request) <= 12000);",
          );
          await q.exec(scriptStudioV7Indexes.join("\n"));
        }
        await verifySchemaObjects(
          q,
          this.backend.kind,
          scriptStudioSchemaSql,
          ["script_schema_version"],
          ["morphz_app_binding"],
        );
        await q.all(
          "SELECT task_run_event_id FROM script_command_receipts LIMIT 0",
        );
        if (priorV2 || priorV3 || priorV4 || priorV5 || priorV6) {
          const changed = await q.change(
            "UPDATE script_schema_version SET version=7,schema_sha256=? WHERE version=? AND schema_sha256=?",
            [schemaSha256, version, installed.schema_sha256],
          );
          if (changed !== 1) throw new Error("剧本工作室结构升级回执不一致。");
        }
        return;
      }
      if (tables.length > 1)
        throw new Error("剧本工作室初始化未完成，拒绝重复建表。");
      await q.exec(scriptStudioSchemaSql);
      await q.change(
        "INSERT INTO script_schema_version(version,schema_sha256) VALUES(7,?)",
        [schemaSha256],
      );
    });
  }

  async close() {
    if (this.backend.kind === "sqlite") this.backend.database.close();
    else await this.backend.pool.end();
  }

  readEditorHead(request: { credential: string; productionId: string }) {
    const productionId = requireDomainId(request.productionId, "剧本 ID");
    return this.authorizedRead(request.credential, productionId, (q, actor) =>
      editorHead(
        q,
        { tenantId: actor.tenantId, productionId, projectId: actor.projectId },
        {
          brief: readBrief,
          template: readTemplate,
          backend: this.backend.kind,
        },
      ),
    );
  }

  readEditorPage(
    request: Omit<ScriptEditorPageRequest, "contentId"> & {
      credential: string;
      productionId: string;
    },
  ) {
    const { credential, productionId, ...raw } = request;
    requireDomainId(productionId, "剧本 ID");
    const { contentId: _id, ...page } = scriptEditorPageRequestSchema.parse({
      ...raw,
      contentId: productionId,
    });
    return this.authorizedRead(
      credential,
      productionId,
      (q, actor) =>
        editorPage(
          q,
          {
            tenantId: actor.tenantId,
            productionId,
            projectId: actor.projectId,
          },
          {
            brief: readBrief,
            template: readTemplate,
            backend: this.backend.kind,
          },
          page,
        ),
      { modelData: page.panel === "reviews" || page.panel === "events" },
    );
  }

  readCandidate(request: {
    credential: string;
    productionId: string;
    candidateId: string;
  }) {
    const productionId = requireDomainId(request.productionId, "剧本 ID");
    const candidateId = requireDomainId(request.candidateId, "候选 ID");
    return this.authorizedRead(
      request.credential,
      productionId,
      (q, actor) =>
        candidateDetail(
          q,
          {
            tenantId: actor.tenantId,
            productionId,
            projectId: actor.projectId,
          },
          candidateId,
          {
            brief: readBrief,
            template: readTemplate,
            backend: this.backend.kind,
          },
        ),
      { modelData: true, sources: (result) => result.draft.sources },
    );
  }

  readReview(request: {
    credential: string;
    productionId: string;
    reviewId: string;
  }) {
    const productionId = requireDomainId(request.productionId, "剧本 ID");
    const reviewId = requireDomainId(request.reviewId, "审改 ID");
    return this.authorizedRead(
      request.credential,
      productionId,
      (q, actor) =>
        reviewDetail(
          q,
          {
            tenantId: actor.tenantId,
            productionId,
            projectId: actor.projectId,
          },
          reviewId,
        ),
      { modelData: true },
    );
  }

  readExport(request: {
    credential: string;
    productionId: string;
    exportId: string;
  }) {
    const productionId = requireDomainId(request.productionId, "剧本 ID");
    const exportId = requireDomainId(request.exportId, "导出 ID");
    return this.authorizedRead(request.credential, productionId, (q, actor) =>
      exportDetail(
        q,
        { tenantId: actor.tenantId, productionId, projectId: actor.projectId },
        exportId,
        {
          brief: readBrief,
          template: readTemplate,
          backend: this.backend.kind,
        },
      ),
    );
  }
  readEditorContext(request: {
    credential: string;
    productionId: string;
    revision: number;
  }) {
    const productionId = requireDomainId(request.productionId, "剧本 ID");
    if (!Number.isSafeInteger(request.revision) || request.revision < 1)
      throw new DomainError("invalid", "剧本规范版本无效。");
    return this.authorizedRead(
      request.credential,
      productionId,
      (q, actor) =>
        contextDetail(
          q,
          {
            tenantId: actor.tenantId,
            productionId,
            projectId: actor.projectId,
          },
          request.revision,
          {
            brief: readBrief,
            template: readTemplate,
            backend: this.backend.kind,
          },
        ),
      { modelData: true },
    );
  }

  readVersionTitle(request: {
    credential: string;
    productionId: string;
    itemId: string;
    revision: number;
  }) {
    const productionId = requireDomainId(request.productionId, "剧本 ID");
    const itemId = requireDomainId(request.itemId, "条目 ID");
    if (!Number.isSafeInteger(request.revision) || request.revision < 1)
      throw new DomainError("invalid", "条目版本无效。");
    return this.authorizedRead(request.credential, productionId, (q, actor) =>
      versionTitle(
        q,
        { tenantId: actor.tenantId, productionId, projectId: actor.projectId },
        itemId,
        request.revision,
      ),
    );
  }

  /** Resolve the live Platform directory both before and after a bounded app
   * read. The project's current membership never comes from this app's DB.
   * No external authorization call holds a SQLite or PostgreSQL read lock.
   */
  private async authorizedRead<T>(
    credential: string,
    productionId: string,
    read: (
      q: SqlQuery,
      actor: NonNullable<
        Awaited<ReturnType<ScriptStudioAuthority["authorizeObject"]>>
      >,
    ) => Promise<T>,
    options: {
      modelData?: boolean | ((result: T) => boolean);
      sources?: (result: T) => LiveScriptDraft["sources"];
    } = {},
  ): Promise<T> {
    if (!this.authority) throw new Error("剧本工作室尚未接入受信读取权限。");
    const authorize = () =>
      this.authority!.authorizeObject({
        credential,
        productionId,
        operation: "read",
      });
    const actor = await authorize();
    if (!actor || actor.objectKind !== "script")
      throw new Error("没有此剧本的读取权限。");
    for (const [label, value] of [
      ["租户 ID", actor.tenantId],
      ["发起者 ID", actor.principalId],
      ["执行者 ID", actor.actantId],
      ["项目 ID", actor.projectId],
    ] as const)
      requireDomainId(value, label);
    if (
      actor.kind === "agent" &&
      !actor.runtimeInputId &&
      !actor.runtimeTaskRunEventId
    )
      throw new Error("Agent 读取剧本缺少已持久化的发起来源。");
    if (actor.runtimeTaskRunEventId)
      requireDomainId(actor.runtimeTaskRunEventId, "事项执行 ID");
    let modelData = options.modelData === true;
    const checkDataPermission = async (q: SqlQuery) => {
      if (actor.kind !== "agent" || !modelData) return;
      const row = (
        await q.all<Row>(
          "SELECT model_processing_allowed FROM script_productions WHERE tenant_id=? AND production_id=? AND deleted_at IS NULL",
          [actor.tenantId, productionId],
        )
      )[0];
      if (!row || !readBool(row.model_processing_allowed as number | string))
        throw new DomainError("forbidden", "剧本模型处理许可已撤销。");
    };
    if (options.modelData) await this.assertActiveInput(actor);
    const result = await this.transaction(async (q) => {
      await checkDataPermission(q);
      const value = await read(q, actor);
      if (typeof options.modelData === "function") {
        modelData = options.modelData(value);
        await checkDataPermission(q);
      }
      return value;
    }, true);
    if (actor.kind === "agent" && options.sources) {
      for (const source of options.sources(result))
        if (
          !this.authority.verifySourceVersion ||
          !(await this.authority.verifySourceVersion({
            credential,
            tenantId: actor.tenantId,
            principalId: actor.principalId,
            actantId: actor.actantId,
            kind: actor.kind,
            runtimeInputId: actor.runtimeInputId,
            runtimeTaskRunEventId: actor.runtimeTaskRunEventId ?? null,
            productionProjectId: actor.projectId,
            alreadyPinned: true,
            ...source,
          }))
        )
          throw new DomainError("forbidden", "引用的原作版本已不可读。");
    }
    const current = await authorize();
    if (
      !current ||
      current.objectKind !== "script" ||
      current.tenantId !== actor.tenantId ||
      current.principalId !== actor.principalId ||
      current.actantId !== actor.actantId ||
      current.kind !== actor.kind ||
      current.runtimeInputId !== actor.runtimeInputId ||
      (current.runtimeTaskRunEventId ?? null) !==
        (actor.runtimeTaskRunEventId ?? null) ||
      current.projectId !== actor.projectId
    )
      throw new Error("剧本读取期间权限或所属项目已变化。");
    if (actor.kind === "agent" && modelData)
      await this.transaction(checkDataPermission, true);
    if (options.modelData) await this.assertActiveInput(actor);
    return result;
  }

  private async assertActiveInput(actor: {
    kind: "human" | "agent";
    runtimeInputId: string | null;
  }) {
    if (actor.kind === "agent" && actor.runtimeInputId)
      await this.authority?.assertInputActive?.(actor.runtimeInputId);
  }

  private assertWorkflowReport(
    generation: ScriptGeneration,
    report?: ScriptWorkflowReport,
  ) {
    if (
      report?.checks.some(
        (check, index) =>
          check.blocked ||
          (check.performed && index >= generation.maxReviewPasses),
      )
    )
      throw new DomainError("invalid", "检查结果不允许提交。");
  }

  /** Sources are facts about the frozen input, not citations self-reported by
   * a model's output. Reuse the caller's transaction; never open a nested one. */
  private async preparedInputSources(
    q: SqlQuery,
    tenantId: string,
    productionId: string,
    inputId: string,
  ): Promise<LiveScriptDraft["sources"]> {
    const rows = await q.all<Row>(
      `SELECT DISTINCT s.source_app_id,s.source_instance_id,s.source_object_id,s.source_version_ref,s.quote_text
       FROM (SELECT target_item_id AS item_id,base_item_revision AS revision FROM script_preparations WHERE tenant_id=? AND production_id=? AND input_id=?
             UNION ALL SELECT r.item_id,r.revision FROM script_preparation_references r JOIN script_preparations p ON p.tenant_id=r.tenant_id AND p.preparation_id=r.preparation_id WHERE p.tenant_id=? AND p.production_id=? AND p.input_id=?) pinned
       JOIN script_item_versions v ON v.tenant_id=? AND v.item_id=pinned.item_id AND v.revision=pinned.revision
       JOIN script_draft_sources s ON s.tenant_id=v.tenant_id AND s.draft_id=v.draft_id`,
      [
        tenantId,
        productionId,
        inputId,
        tenantId,
        productionId,
        inputId,
        tenantId,
      ],
    );
    return rows.map((source) => ({
      appId: String(source.source_app_id),
      instanceId: String(source.source_instance_id),
      objectId: String(source.source_object_id),
      versionRef: String(source.source_version_ref),
      quote: String(source.quote_text),
    }));
  }

  /** Recheck execution, model consent and all pinned original-source grants
   * without loading the manuscript bodies. */
  async assertPreparedInputReadable(request: {
    credential: string;
    productionId: string;
    inputId: string;
  }) {
    const productionId = requireDomainId(request.productionId, "剧本 ID");
    const inputId = requireDomainId(request.inputId, "输入 ID");
    await this.authorizedRead(
      request.credential,
      productionId,
      async (q, actor) => {
        if (actor.kind === "agent" && actor.runtimeInputId !== inputId)
          throw new DomainError("forbidden", "不能读取另一条输入的固定资料。");
        const preparation = await this.preparationForInput(
          q,
          actor.tenantId,
          productionId,
          inputId,
        );
        if (!preparation)
          throw new DomainError("not_found", "本次输入没有固定的剧本范围。");
        // Validate source grants without loading any manuscript bodies. Both
        // target and references are pinned by this app's preparation record.
        return this.preparedInputSources(
          q,
          actor.tenantId,
          productionId,
          inputId,
        );
      },
      { modelData: true, sources: (sources) => sources },
    );
  }

  /** Exact production activity version, without drafts, candidates or counts. */
  async readProductionHead(request: {
    credential: string;
    productionId: string;
  }) {
    const productionId = requireDomainId(request.productionId, "剧本 ID");
    return this.authorizedRead(
      request.credential,
      productionId,
      async (q, actor) => {
        const rows = await q.all<{ activity_revision: number | string }>(
          "SELECT activity_revision FROM script_productions WHERE tenant_id=? AND production_id=? AND deleted_at IS NULL",
          [actor.tenantId, productionId],
        );
        if (rows.length !== 1) throw new Error("剧本原件不存在。");
        return {
          productionId,
          versionRef: String(
            safeInteger(rows[0]!.activity_revision, "剧本活动修订"),
          ),
        };
      },
    );
  }

  /** Small production header; the Platform project is a live directory fact,
   * while creative revisions and the brief are Script Studio facts. */
  async readProductionOverview(request: {
    credential: string;
    productionId: string;
  }) {
    const productionId = requireDomainId(request.productionId, "剧本 ID");
    return this.authorizedRead(
      request.credential,
      productionId,
      async (q, actor) => {
        const row = (
          await q.all<Row>(
            "SELECT title,metadata_revision,activity_revision,creative_epoch,updated_at,mode,audience,genre,episode_count,episode_seconds,style,constraints_text,rights_statement,model_processing_allowed,template_title,template_include_notes,template_include_continuity,template_page_break_episodes,template_font,template_font_size,template_scene_heading FROM script_productions WHERE tenant_id=? AND production_id=? AND deleted_at IS NULL",
            [actor.tenantId, productionId],
          )
        )[0];
        if (!row) throw new Error("剧本原件不存在。");
        const reviewers = await q.all<{ principal_id: string }>(
          "SELECT principal_id FROM script_reviewers WHERE tenant_id=? AND production_id=? ORDER BY ordinal",
          [actor.tenantId, productionId],
        );
        const itemCounts = await q.all<{
          kind: string;
          total: number | string;
        }>(
          "SELECT kind,COUNT(*) AS total FROM script_items WHERE tenant_id=? AND production_id=? AND kind IN ('episode','scene') GROUP BY kind",
          [actor.tenantId, productionId],
        );
        const pendingCandidates = await q.all<{ total: number | string }>(
          `SELECT COUNT(*) AS total FROM script_candidates c
           JOIN script_items target ON target.tenant_id=c.tenant_id AND target.item_id=c.target_item_id
           WHERE c.tenant_id=? AND c.production_id=? AND c.status='pending'
             AND c.base_creative_epoch=? AND target.head_revision=c.base_item_revision
             AND NOT EXISTS (
               SELECT 1 FROM script_candidate_references ref
               LEFT JOIN script_items dependency ON dependency.tenant_id=ref.tenant_id AND dependency.item_id=ref.item_id
               WHERE ref.tenant_id=c.tenant_id AND ref.candidate_id=c.candidate_id
                 AND (dependency.item_id IS NULL OR dependency.head_revision<>ref.revision)
             )`,
          [
            actor.tenantId,
            productionId,
            safeInteger(row.creative_epoch as number | string, "创作修订"),
          ],
        );
        const count = (kind: string) =>
          safeInteger(
            itemCounts.find((item) => item.kind === kind)?.total ?? 0,
            `${kind} 数量`,
          );
        return {
          productionId,
          projectId: actor.projectId,
          title: String(row.title),
          metadataRevision: safeInteger(
            row.metadata_revision as number | string,
            "元数据修订",
          ),
          activityRevision: safeInteger(
            row.activity_revision as number | string,
            "剧本活动修订",
          ),
          creativeEpoch: safeInteger(
            row.creative_epoch as number | string,
            "创作修订",
          ),
          updatedAt: String(row.updated_at),
          brief: readBrief(row),
          template: readTemplate(row),
          reviewerPrincipalIds: reviewers.map(
            (reviewer) => reviewer.principal_id,
          ),
          progress: {
            episodes: count("episode"),
            scenes: count("scene"),
            pendingCandidates: safeInteger(
              pendingCandidates[0]?.total ?? 0,
              "待决定候选数量",
            ),
          },
        };
      },
    );
  }

  /** Read one immutable creative brief, not today's mutable production header.
   * This remains an app-domain read and never hydrates the whole production. */
  async readCreativeContextVersion(request: {
    credential: string;
    productionId: string;
    revision: number;
  }) {
    const productionId = requireDomainId(request.productionId, "剧本 ID");
    if (!Number.isSafeInteger(request.revision) || request.revision < 1)
      throw new Error("创作要求版本无效。");
    return this.authorizedRead(
      request.credential,
      productionId,
      async (q, actor) => {
        const version = (
          await q.all<Row>(
            "SELECT * FROM script_metadata_versions WHERE tenant_id=? AND production_id=? AND revision=?",
            [actor.tenantId, productionId, request.revision],
          )
        )[0];
        if (!version) throw new Error("固定创作要求版本不存在。");
        const reviewers = await q.all<{ principal_id: string }>(
          "SELECT principal_id FROM script_metadata_reviewers WHERE tenant_id=? AND production_id=? AND revision=? ORDER BY ordinal",
          [actor.tenantId, productionId, request.revision],
        );
        return {
          productionId,
          revision: request.revision,
          title: String(version.title),
          brief: readBrief(version),
          template: readTemplate(version),
          reviewerPrincipalIds: reviewers.map(
            (reviewer) => reviewer.principal_id,
          ),
        };
      },
      { modelData: true },
    );
  }

  /** Check a pinned creative context from metadata history alone. Opening an
   * Agent workflow must not hydrate every draft, candidate and review. */
  async creativeContextCurrent(request: {
    credential: string;
    productionId: string;
    revision: number;
  }): Promise<boolean> {
    const productionId = requireDomainId(request.productionId, "剧本 ID");
    if (!Number.isSafeInteger(request.revision) || request.revision < 1)
      throw new Error("创作要求版本无效。");
    return this.authorizedRead(
      request.credential,
      productionId,
      async (q, actor) => {
        const current = (
          await q.all<{ metadata_revision: number | string }>(
            "SELECT metadata_revision FROM script_productions WHERE tenant_id=? AND production_id=? AND deleted_at IS NULL",
            [actor.tenantId, productionId],
          )
        )[0];
        if (
          !current ||
          request.revision >
            safeInteger(current.metadata_revision, "剧本元数据修订")
        )
          return false;
        const versions = await q.all<Row>(
          "SELECT * FROM script_metadata_versions WHERE tenant_id=? AND production_id=? AND revision>=? ORDER BY revision",
          [actor.tenantId, productionId, request.revision],
        );
        if (
          !versions.length ||
          safeInteger(
            versions[0]!.revision as number | string,
            "创作要求版本",
          ) !== request.revision ||
          safeInteger(
            versions.at(-1)!.revision as number | string,
            "当前创作要求版本",
          ) !== safeInteger(current.metadata_revision, "剧本元数据修订")
        )
          return false;
        const reviewers = await q.all<{
          revision: number | string;
          principal_id: string;
        }>(
          "SELECT revision,principal_id FROM script_metadata_reviewers WHERE tenant_id=? AND production_id=? AND revision>=? ORDER BY revision,ordinal",
          [actor.tenantId, productionId, request.revision],
        );
        const byRevision = new Map<number, string[]>();
        for (const reviewer of reviewers) {
          const revision = safeInteger(reviewer.revision, "审阅人版本");
          const list = byRevision.get(revision) ?? [];
          list.push(reviewer.principal_id);
          byRevision.set(revision, list);
        }
        const contexts = versions.map((row) =>
          scriptCreativeContext({
            brief: readBrief(row),
            reviewerPrincipalIds:
              byRevision.get(
                safeInteger(row.revision as number | string, "创作要求版本"),
              ) ?? [],
          }),
        );
        return contexts.every((context) => context === contexts[0]);
      },
    );
  }

  /** Stable creation-order pagination. The caller pins activityRevision
   * between pages, so a concurrent move/rewrite is a conflict, not a silent
   * omission. order is returned separately for the editor's tree layout.
   */
  async listItems(request: {
    credential: string;
    productionId: string;
    /** Undefined scans the entire production; null selects root items. */
    parentId?: string | null;
    kind?: ScriptProduction["items"][number]["kind"];
    limit?: number;
    after?: ScriptItemCursor;
    expectedActivityRevision?: number;
  }): Promise<ScriptItemPage> {
    const productionId = requireDomainId(request.productionId, "剧本 ID");
    const parentId =
      request.parentId === undefined || request.parentId === null
        ? request.parentId
        : requireDomainId(request.parentId, "上级条目 ID");
    const limit = request.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("剧本条目分页大小无效。");
    if (
      request.expectedActivityRevision !== undefined &&
      (!Number.isSafeInteger(request.expectedActivityRevision) ||
        request.expectedActivityRevision < 1)
    )
      throw new Error("剧本活动修订无效。");
    if (request.after) {
      if (
        !Number.isSafeInteger(request.after.ordinal) ||
        request.after.ordinal < 0
      )
        throw new Error("剧本分页游标无效。");
      requireDomainId(request.after.itemId, "剧本分页条目 ID");
    }
    if (request.kind && !scriptItemKinds.includes(request.kind))
      throw new Error("剧本条目类型无效。");
    return this.authorizedRead(
      request.credential,
      productionId,
      async (q, actor) => {
        const production = (
          await q.all<{ activity_revision: number | string }>(
            "SELECT activity_revision FROM script_productions WHERE tenant_id=? AND production_id=? AND deleted_at IS NULL",
            [actor.tenantId, productionId],
          )
        )[0];
        if (!production) throw new Error("剧本原件不存在。");
        const activityRevision = safeInteger(
          production.activity_revision,
          "剧本活动修订",
        );
        if (
          request.expectedActivityRevision !== undefined &&
          activityRevision !== request.expectedActivityRevision
        )
          throw new Error("剧本在分页期间已更新，请重新读取目录。");
        const values: SqlScalar[] = [actor.tenantId, productionId];
        let sql =
          "SELECT i.item_id,i.collection_ordinal,i.kind,i.parent_item_id,i.order_index,i.head_revision,i.workflow_revision,i.status,d.title FROM script_items i JOIN script_item_versions v ON v.tenant_id=i.tenant_id AND v.item_id=i.item_id AND v.revision=i.head_revision JOIN script_drafts d ON d.tenant_id=v.tenant_id AND d.draft_id=v.draft_id WHERE i.tenant_id=? AND i.production_id=?";
        if (parentId === null) sql += " AND i.parent_item_id IS NULL";
        else if (parentId !== undefined) {
          sql += " AND i.parent_item_id=?";
          values.push(parentId);
        }
        if (request.kind) {
          sql += " AND i.kind=?";
          values.push(request.kind);
        }
        if (request.after) {
          sql +=
            " AND (i.collection_ordinal>? OR (i.collection_ordinal=? AND i.item_id>?))";
          values.push(
            request.after.ordinal,
            request.after.ordinal,
            request.after.itemId,
          );
        }
        sql += " ORDER BY i.collection_ordinal,i.item_id LIMIT ?";
        values.push(limit + 1);
        const rows = await q.all<Row>(sql, values);
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        return {
          activityRevision,
          items: page.map((row) => ({
            itemId: String(row.item_id),
            kind: row.kind as ScriptItemPage["items"][number]["kind"],
            parentId:
              row.parent_item_id === null ? null : String(row.parent_item_id),
            order: safeInteger(row.order_index as number | string, "条目顺序"),
            title: String(row.title),
            revision: safeInteger(
              row.head_revision as number | string,
              "条目修订",
            ),
            workflowRevision: safeInteger(
              row.workflow_revision as number | string,
              "流程修订",
            ),
            status: row.status as ScriptItemPage["items"][number]["status"],
          })),
          nextCursor:
            rows.length > limit && last
              ? {
                  ordinal: safeInteger(
                    last.collection_ordinal as number | string,
                    "条目顺序号",
                  ),
                  itemId: String(last.item_id),
                }
              : null,
        };
      },
    );
  }

  /** Current dependency graph, not manuscript text or a story-quality check.
   * A fixed Agent input receives only pinned IDs; other affected entries are
   * represented by a count, never their identities, titles or bodies. */
  async readImpact(request: {
    credential: string;
    productionId: string;
    itemIds: string[];
    offset?: number;
    limit?: number;
  }) {
    const productionId = requireDomainId(request.productionId, "剧本 ID");
    const itemIds = [
      ...new Set(request.itemIds.map((id) => requireDomainId(id, "条目 ID"))),
    ];
    const offset = request.offset ?? 0;
    const limit = request.limit ?? 20;
    if (
      !itemIds.length ||
      itemIds.length > 200 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      throw new DomainError("invalid", "影响检查范围或分页无效。");
    return this.authorizedRead(
      request.credential,
      productionId,
      async (q, actor) => {
        const preparation =
          actor.kind === "agent" && actor.runtimeInputId
            ? await this.preparationForInput(
                q,
                actor.tenantId,
                productionId,
                actor.runtimeInputId,
              )
            : null;
        const scopedIds = preparation
          ? [
              preparation.generation.targetId,
              ...preparation.generation.references.map((ref) => ref.itemId),
            ]
          : null;
        if (scopedIds && itemIds.some((id) => !scopedIds.includes(id)))
          throw new DomainError("forbidden", "只能检查本次固定资料的影响。");
        const placeholders = itemIds.map(() => "?").join(",");
        const present = await q.all<{ item_id: string }>(
          "SELECT item_id FROM script_items WHERE tenant_id=? AND production_id=? AND item_id IN (" +
            placeholders +
            ")",
          [actor.tenantId, productionId, ...itemIds],
        );
        if (present.length !== itemIds.length)
          throw new DomainError("not_found", "影响检查的条目不存在。");
        const cte =
          "WITH RECURSIVE current_drafts AS (SELECT i.item_id,i.collection_ordinal,i.kind,i.head_revision,i.status,d.parent_item_id,d.title,v.draft_id FROM script_items i JOIN script_item_versions v ON v.tenant_id=i.tenant_id AND v.item_id=i.item_id AND v.revision=i.head_revision JOIN script_drafts d ON d.tenant_id=v.tenant_id AND d.draft_id=v.draft_id WHERE i.tenant_id=? AND i.production_id=?), edges AS (SELECT c.item_id AS child_id,dep.depends_on_item_id AS upstream_id FROM current_drafts c JOIN script_draft_dependencies dep ON dep.tenant_id=? AND dep.draft_id=c.draft_id UNION SELECT item_id,parent_item_id FROM current_drafts WHERE parent_item_id IS NOT NULL UNION SELECT c.item_id,ch.character_item_id FROM current_drafts c JOIN script_draft_characters ch ON ch.tenant_id=? AND ch.draft_id=c.draft_id), impact(item_id) AS (SELECT child_id FROM edges WHERE upstream_id IN (" +
          placeholders +
          ") UNION SELECT e.child_id FROM edges e JOIN impact i ON e.upstream_id=i.item_id), affected AS (SELECT c.* FROM current_drafts c JOIN impact i ON i.item_id=c.item_id WHERE c.item_id NOT IN (" +
          placeholders +
          ")) ";
        const values: SqlScalar[] = [
          actor.tenantId,
          productionId,
          actor.tenantId,
          actor.tenantId,
          ...itemIds,
          ...itemIds,
        ];
        const scopeSql = scopedIds
          ? " WHERE item_id IN (" + scopedIds.map(() => "?").join(",") + ")"
          : "";
        const scopedValues = [...values, ...(scopedIds ?? [])];
        const allCount = (
          await q.all<{ total: number | string }>(
            cte + "SELECT COUNT(*) AS total FROM affected",
            values,
          )
        )[0]!;
        const scopedCount = (
          await q.all<{ total: number | string }>(
            cte + "SELECT COUNT(*) AS total FROM affected" + scopeSql,
            scopedValues,
          )
        )[0]!;
        const total = safeInteger(scopedCount.total, "已固定影响条目数量");
        const rows = await q.all<Row>(
          cte +
            "SELECT item_id,kind,head_revision,status,title FROM affected" +
            scopeSql +
            " ORDER BY collection_ordinal,item_id LIMIT ? OFFSET ?",
          [...scopedValues, limit, offset],
        );
        // This bounded ID-only list is used to explain coverage to inference.
        const scopedAffected = scopedIds
          ? (
              await q.all<{ item_id: string }>(
                cte +
                  "SELECT item_id FROM affected" +
                  scopeSql +
                  " ORDER BY collection_ordinal,item_id",
                scopedValues,
              )
            ).map((row) => row.item_id)
          : null;
        return {
          affected: rows.map((row) => ({
            id: String(row.item_id),
            kind: String(row.kind),
            title: String(row.title),
            revision: safeInteger(
              row.head_revision as number | string,
              "条目版本",
            ),
            status: String(row.status),
          })),
          total,
          hasMore: offset + rows.length < total,
          outOfScopeCount: safeInteger(allCount.total, "影响条目总数") - total,
          scopedAffected,
          semanticQualityChecked: false as const,
        };
      },
      { modelData: true },
    );
  }

  /** Structural issues are queried from normalized head dependencies and
   * reviews. Do not hydrate all drafts/history just to show one issue page. */
  async readStructuralIssues(request: {
    credential: string;
    productionId: string;
    offset?: number;
    limit?: number;
  }) {
    const productionId = requireDomainId(request.productionId, "剧本 ID");
    const offset = request.offset ?? 0;
    const limit = request.limit ?? 20;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      throw new DomainError("invalid", "结构检查分页无效。");
    return this.authorizedRead(
      request.credential,
      productionId,
      async (q, actor) => {
        const preparation =
          actor.kind === "agent" && actor.runtimeInputId
            ? await this.preparationForInput(
                q,
                actor.tenantId,
                productionId,
                actor.runtimeInputId,
              )
            : null;
        const scopedIds = preparation
          ? [
              preparation.generation.targetId,
              ...preparation.generation.references.map((ref) => ref.itemId),
            ]
          : null;
        const scoped = scopedIds
          ? " AND i.item_id IN (" + scopedIds.map(() => "?").join(",") + ")"
          : "";
        const cte =
          "WITH heads AS (SELECT i.item_id,i.kind,i.head_revision,d.draft_id,d.parent_item_id FROM script_items i JOIN script_item_versions v ON v.tenant_id=i.tenant_id AND v.item_id=i.item_id AND v.revision=i.head_revision JOIN script_drafts d ON d.tenant_id=v.tenant_id AND d.draft_id=v.draft_id WHERE i.tenant_id=? AND i.production_id=?" +
          scoped +
          "), issues AS (SELECT 'stale-dependency' AS code,h.item_id,dep.depends_on_item_id AS related_id FROM heads h JOIN script_draft_dependencies dep ON dep.tenant_id=? AND dep.draft_id=h.draft_id LEFT JOIN script_items up ON up.tenant_id=dep.tenant_id AND up.item_id=dep.depends_on_item_id WHERE up.item_id IS NULL OR up.head_revision<>dep.depends_on_revision UNION ALL SELECT 'missing-parent',h.item_id,COALESCE(h.parent_item_id,'') FROM heads h LEFT JOIN script_items parent ON parent.tenant_id=? AND parent.production_id=? AND parent.item_id=h.parent_item_id AND parent.kind='episode' WHERE h.kind='scene' AND parent.item_id IS NULL UNION ALL SELECT 'unresolved-review',h.item_id,r.review_id FROM heads h JOIN script_reviews r ON r.tenant_id=? AND r.item_id=h.item_id WHERE r.resolved_at IS NULL AND COALESCE(r.historical_only,0)=0 AND r.severity='blocking') ";
        const values: SqlScalar[] = [
          actor.tenantId,
          productionId,
          ...(scopedIds ?? []),
          actor.tenantId,
          actor.tenantId,
          productionId,
          actor.tenantId,
        ];
        const count = (
          await q.all<{ total: number | string }>(
            cte + "SELECT COUNT(*) AS total FROM issues",
            values,
          )
        )[0]!;
        const rows = await q.all<{
          code: string;
          item_id: string;
          related_id: string;
        }>(
          cte +
            "SELECT code,item_id,related_id FROM issues ORDER BY item_id,code,related_id LIMIT ? OFFSET ?",
          [...values, limit, offset],
        );
        const total = safeInteger(count.total, "结构问题数量");
        return {
          total,
          hasMore: offset + rows.length < total,
          semanticQualityChecked: false as const,
          issues: rows.map((row) => ({
            code: row.code,
            itemId: row.item_id,
            relatedId:
              scopedIds &&
              row.code === "stale-dependency" &&
              !scopedIds.includes(row.related_id)
                ? ""
                : row.related_id,
            message:
              row.code === "stale-dependency"
                ? "引用的上游版本已变化。"
                : row.code === "missing-parent"
                  ? "分场必须属于一集。"
                  : "有待处理的阻断意见。",
          })),
        };
      },
      { modelData: true },
    );
  }

  /** One exact immutable item version. A source citation retains its owning
   * App and opaque version, rather than pretending every source is an Objects
   * document or granting access to that source through this read.
   */
  async readItemVersion(request: {
    credential: string;
    productionId: string;
    itemId: string;
    revision?: number;
  }) {
    const productionId = requireDomainId(request.productionId, "剧本 ID");
    const itemId = requireDomainId(request.itemId, "条目 ID");
    if (
      request.revision !== undefined &&
      (!Number.isSafeInteger(request.revision) || request.revision < 1)
    )
      throw new Error("条目版本无效。");
    return this.authorizedRead(
      request.credential,
      productionId,
      async (q, actor) => {
        const row = (
          await q.all<Row>(
            "SELECT i.kind,i.status,i.head_revision,i.workflow_revision,v.revision,v.candidate_id,v.author_principal_id,v.author_actant_id,v.created_at AS version_created_at,d.* FROM script_productions p JOIN script_items i ON i.tenant_id=p.tenant_id AND i.production_id=p.production_id JOIN script_item_versions v ON v.tenant_id=i.tenant_id AND v.item_id=i.item_id AND v.revision=COALESCE(?,i.head_revision) JOIN script_drafts d ON d.tenant_id=v.tenant_id AND d.draft_id=v.draft_id WHERE p.tenant_id=? AND p.production_id=? AND p.deleted_at IS NULL AND i.item_id=?",
            [request.revision ?? null, actor.tenantId, productionId, itemId],
          )
        )[0];
        if (!row) throw new Error("剧本条目或版本不存在。");
        const draftId = String(row.draft_id);
        const sources = await q.all<Row>(
          "SELECT source_app_id,source_instance_id,source_object_id,source_version_ref,quote_text FROM script_draft_sources WHERE tenant_id=? AND draft_id=? ORDER BY ordinal",
          [actor.tenantId, draftId],
        );
        const dependencies = await q.all<Row>(
          "SELECT depends_on_item_id,depends_on_revision FROM script_draft_dependencies WHERE tenant_id=? AND draft_id=? ORDER BY ordinal",
          [actor.tenantId, draftId],
        );
        const characters = await q.all<Row>(
          "SELECT character_item_id FROM script_draft_characters WHERE tenant_id=? AND draft_id=? ORDER BY ordinal",
          [actor.tenantId, draftId],
        );
        // Creative edits and blocking reviews invalidate this live approval
        // in their own transactions. Never attach the head's approval to a
        // different immutable version requested by the caller.
        const approval = (
          await q.all<Row>(
            "SELECT revision,context_revision,note,author_principal_id,author_actant_id,created_at FROM script_item_approvals WHERE tenant_id=? AND item_id=? AND revision=?",
            [
              actor.tenantId,
              itemId,
              safeInteger(row.revision as number | string, "条目版本"),
            ],
          )
        )[0];
        return {
          productionId,
          itemId,
          kind: row.kind as ScriptProduction["items"][number]["kind"],
          status: row.status as ScriptProduction["items"][number]["status"],
          headRevision: safeInteger(
            row.head_revision as number | string,
            "条目当前修订",
          ),
          workflowRevision: safeInteger(
            row.workflow_revision as number | string,
            "流程修订",
          ),
          revision: safeInteger(row.revision as number | string, "条目版本"),
          candidateId:
            row.candidate_id === null ? null : String(row.candidate_id),
          author: {
            principalId: String(row.author_principal_id),
            actantId: String(row.author_actant_id),
          },
          createdAt: String(row.version_created_at),
          approvalForRequestedVersion: approval
            ? {
                revision: safeInteger(
                  approval.revision as number | string,
                  "批准版本",
                ),
                contextRevision: safeInteger(
                  approval.context_revision as number | string,
                  "批准创作要求版本",
                ),
                note: String(approval.note),
                author: {
                  principalId: String(approval.author_principal_id),
                  actantId: String(approval.author_actant_id),
                },
                createdAt: String(approval.created_at),
              }
            : null,
          draft: {
            title: String(row.title),
            text: String(row.body_text),
            parentId:
              row.parent_item_id === null ? null : String(row.parent_item_id),
            order: safeInteger(row.order_index as number | string, "条目顺序"),
            basis: row.basis as ScriptDraft["basis"],
            sources: sources.map((source) => ({
              appId: String(source.source_app_id),
              instanceId: String(source.source_instance_id),
              objectId: String(source.source_object_id),
              versionRef: String(source.source_version_ref),
              quote: String(source.quote_text),
            })),
            dependencies: dependencies.map((dependency) => ({
              itemId: String(dependency.depends_on_item_id),
              revision: safeInteger(
                dependency.depends_on_revision as number | string,
                "依赖版本",
              ),
            })),
            location: String(row.location_text),
            storyTime: String(row.story_time),
            characters: characters.map((character) =>
              String(character.character_item_id),
            ),
            audienceKnowledge: String(row.audience_knowledge),
            characterKnowledge: String(row.character_knowledge),
            setupPayoff: String(row.setup_payoff),
            productionNotes: String(row.production_notes),
          },
        };
      },
      {
        // Empty scaffolding is not manuscript data: an Agent can read the
        // title and structure it just created without authorizing material
        // processing. Any body, citation or creative detail requires consent.
        modelData: ({ draft }) =>
          [
            draft.text,
            draft.location,
            draft.storyTime,
            draft.audienceKnowledge,
            draft.characterKnowledge,
            draft.setupPayoff,
            draft.productionNotes,
          ].some((value) => value.length > 0) ||
          draft.sources.length > 0 ||
          draft.dependencies.length > 0 ||
          draft.characters.length > 0,
        sources: (result) => result.draft.sources,
      },
    );
  }

  /** A candidate is an immutable app-owned draft, not an Objects document.
   * Read only the referenced candidate instead of hydrating a production to
   * authenticate a quote from the Script Studio surface.
   */
  async readCandidateQuoteSource(request: {
    credential: string;
    productionId: string;
    candidateId: string;
  }) {
    const productionId = requireDomainId(request.productionId, "剧本 ID");
    const candidateId = requireDomainId(request.candidateId, "候选 ID");
    return this.authorizedRead(
      request.credential,
      productionId,
      async (q, actor) => {
        const row = (
          await q.all<Row>(
            "SELECT c.target_item_id,c.base_item_revision,c.collection_ordinal,c.explanation,p.title AS production_title,d.title,d.body_text,d.location_text,d.story_time,d.audience_knowledge,d.character_knowledge,d.setup_payoff,d.production_notes FROM script_candidates c JOIN script_productions p ON p.tenant_id=c.tenant_id AND p.production_id=c.production_id JOIN script_drafts d ON d.tenant_id=c.tenant_id AND d.draft_id=c.draft_id WHERE c.tenant_id=? AND c.production_id=? AND c.candidate_id=? AND p.deleted_at IS NULL",
            [actor.tenantId, productionId, candidateId],
          )
        )[0];
        if (!row) throw new DomainError("not_found", "候选稿不存在。");
        const ordinal = (
          await q.all<{ total: number | string }>(
            "SELECT COUNT(*) AS total FROM script_candidates WHERE tenant_id=? AND production_id=? AND target_item_id=? AND collection_ordinal<=?",
            [
              actor.tenantId,
              productionId,
              String(row.target_item_id),
              safeInteger(
                row.collection_ordinal as number | string,
                "候选集合顺序",
              ),
            ],
          )
        )[0];
        return {
          productionId,
          candidateId,
          targetItemId: String(row.target_item_id),
          baseRevision: safeInteger(
            row.base_item_revision as number | string,
            "候选基准版本",
          ),
          ordinal: safeInteger(ordinal?.total ?? 0, "候选顺序"),
          productionTitle: String(row.production_title),
          draft: {
            title: String(row.title),
            text: String(row.body_text),
            location: String(row.location_text),
            storyTime: String(row.story_time),
            audienceKnowledge: String(row.audience_knowledge),
            characterKnowledge: String(row.character_knowledge),
            setupPayoff: String(row.setup_payoff),
            productionNotes: String(row.production_notes),
          },
          explanation: String(row.explanation),
        };
      },
    );
  }

  private async preparationForInput(
    q: SqlQuery,
    tenantId: string,
    productionId: string,
    inputId: string,
  ): Promise<ScriptPreparationReceipt | null> {
    const rows = await q.all<Row>(
      "SELECT * FROM script_preparations WHERE tenant_id=? AND production_id=? AND input_id=? ORDER BY collection_ordinal,preparation_id",
      [tenantId, productionId, inputId],
    );
    if (!rows.length) return null;
    if (rows.length > 12 || rows[0]!.preparation_id !== inputId)
      throw new Error("剧本准备集合与根输入不一致。");
    const generations: ScriptGeneration[] = [];
    for (const row of rows) {
      const refs = await q.all<Row>(
        "SELECT item_id,revision FROM script_preparation_references WHERE tenant_id=? AND preparation_id=? ORDER BY ordinal",
        [tenantId, row.preparation_id as string],
      );
      generations.push(
        scriptGenerationSchema.parse({
          productionId,
          targetId: row.target_item_id,
          baseRevision: safeInteger(
            row.base_item_revision as number | string,
            "目标版本",
          ),
          contextRevision: safeInteger(
            row.context_revision as number | string,
            "创作要求版本",
          ),
          purpose: row.purpose,
          references: refs.map((ref) => ({
            itemId: String(ref.item_id),
            revision: safeInteger(
              ref.revision as number | string,
              "固定资料版本",
            ),
          })),
          maxCandidates: safeInteger(
            row.max_candidates as number | string,
            "候选上限",
          ),
          maxOutputCharacters: safeInteger(
            row.max_output_characters as number | string,
            "输出上限",
          ),
          maxReviewPasses: safeInteger(
            row.max_review_passes as number | string,
            "检查轮数",
          ),
        }),
      );
    }
    return {
      preparationId: inputId,
      inputId,
      generation: generations[0]!,
      generations,
      task: String(rows[0]!.task_request),
      receiptId: inputId,
    };
  }

  async readPreparation(request: {
    credential: string;
    productionId: string;
    inputId: string;
  }): Promise<ScriptPreparationReceipt | null> {
    const productionId = requireDomainId(request.productionId, "剧本 ID");
    const inputId = requireDomainId(request.inputId, "输入 ID");
    return this.authorizedRead(
      request.credential,
      productionId,
      async (q, actor) => {
        if (actor.kind === "agent" && actor.runtimeInputId !== inputId)
          throw new Error("不能读取另一条输入的生成范围。");
        return this.preparationForInput(
          q,
          actor.tenantId,
          productionId,
          inputId,
        );
      },
    );
  }

  async findPreparation(request: {
    credential: string;
    projectId: string;
    inputId: string;
  }): Promise<ScriptPreparationReceipt | null> {
    if (!this.authority?.authorizeProjectRead)
      throw new Error("剧本工作室尚未接入受信项目读取权限。");
    const projectId = requireDomainId(request.projectId, "项目 ID");
    const inputId = requireDomainId(request.inputId, "输入 ID");
    const actor = await this.authority.authorizeProjectRead({
      credential: request.credential,
      projectId,
    });
    if (!actor || actor.runtimeInputId !== inputId)
      throw new Error("只能读取本次输入的剧本准备记录。");
    const matches = await this.transaction(
      (q) =>
        q.all<{ production_id: string }>(
          "SELECT DISTINCT production_id FROM script_preparations WHERE tenant_id=? AND input_id=? LIMIT 2",
          [actor.tenantId, inputId],
        ),
      true,
    );
    if (matches.length > 1)
      throw new Error("本次输入存在多份生成范围，拒绝猜测。");
    return matches[0]
      ? this.readPreparation({
          credential: request.credential,
          productionId: matches[0].production_id,
          inputId,
        })
      : null;
  }

  /** Recovery reads are scoped to the persisted input, not a model-supplied
   * production or another conversation. They do not hydrate the production. */
  async listInputResults(request: {
    credential: string;
    productionId: string;
    inputId: string;
    offset: number;
    limit: number;
  }) {
    const productionId = requireDomainId(request.productionId, "剧本 ID");
    const inputId = requireDomainId(request.inputId, "输入 ID");
    if (
      !Number.isSafeInteger(request.offset) ||
      request.offset < 0 ||
      !Number.isSafeInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > 50
    )
      throw new Error("结果分页范围无效。");
    return this.authorizedRead(
      request.credential,
      productionId,
      async (q, actor) => {
        if (actor.kind === "agent" && actor.runtimeInputId !== inputId)
          throw new Error("不能读取另一条输入的结果。");
        const totalRow = (
          await q.all<{ total: number | string }>(
            `SELECT (SELECT COUNT(*) FROM script_candidates WHERE tenant_id=? AND production_id=? AND input_id=?)
              + (SELECT COUNT(*) FROM script_reviews r JOIN script_items i ON i.tenant_id=r.tenant_id AND i.item_id=r.item_id WHERE r.tenant_id=? AND i.production_id=? AND r.input_id=?)
              + (SELECT COUNT(*) FROM script_check_reports report WHERE report.tenant_id=? AND report.production_id=? AND report.input_id=?
                AND report.purpose IN ('continuity','impact')
                AND NOT EXISTS (SELECT 1 FROM script_reviews r WHERE r.tenant_id=report.tenant_id AND r.command_id=report.command_id)) AS total`,
            [
              actor.tenantId,
              productionId,
              inputId,
              actor.tenantId,
              productionId,
              inputId,
              actor.tenantId,
              productionId,
              inputId,
            ],
          )
        )[0]!;
        const total = safeInteger(totalRow.total, "结果数量");
        const rows = await q.all<Row>(
          `SELECT kind,id,item_id,item_revision,created_at,status FROM (
            SELECT 'candidate' AS kind,candidate_id AS id,target_item_id AS item_id,base_item_revision AS item_revision,created_at,status
              FROM script_candidates WHERE tenant_id=? AND production_id=? AND input_id=?
            UNION ALL
            SELECT 'review',r.review_id,r.item_id,r.item_revision,r.created_at,CASE WHEN r.resolved_at IS NULL THEN 'unresolved' ELSE 'resolved' END
              FROM script_reviews r JOIN script_items i ON i.tenant_id=r.tenant_id AND i.item_id=r.item_id
              WHERE r.tenant_id=? AND i.production_id=? AND r.input_id=?
            UNION ALL
            SELECT 'review',report.command_id,p.target_item_id,p.base_item_revision,report.created_at,'complete'
              FROM script_check_reports report JOIN script_preparations p ON p.tenant_id=report.tenant_id AND p.preparation_id=report.input_id AND p.production_id=report.production_id
              WHERE report.tenant_id=? AND report.production_id=? AND report.input_id=?
                AND report.purpose IN ('continuity','impact')
                AND NOT EXISTS (SELECT 1 FROM script_reviews r WHERE r.tenant_id=report.tenant_id AND r.command_id=report.command_id)
          ) results ORDER BY created_at,id LIMIT ? OFFSET ?`,
          [
            actor.tenantId,
            productionId,
            inputId,
            actor.tenantId,
            productionId,
            inputId,
            actor.tenantId,
            productionId,
            inputId,
            request.limit,
            request.offset,
          ],
        );
        return {
          inputId,
          total,
          hasMore: request.offset + rows.length < total,
          results: rows.map((row) => ({
            kind: String(row.kind) as "candidate" | "review",
            id: String(row.id),
            itemId: String(row.item_id),
            itemRevision: safeInteger(
              row.item_revision as number | string,
              "结果条目版本",
            ),
            createdAt: String(row.created_at),
            status: String(row.status),
          })),
        };
      },
      { modelData: true },
    );
  }

  /** Only the Host may supply input IDs, after Runtime has filtered the
   * visible conversation. This first query returns no draft text or output;
   * Platform must resolve current catalog access before the domain read.
   */
  async inputDeliveryProductions(tenantId: string, inputIds: string[]) {
    requireDomainId(tenantId, "租户 ID");
    const ids = [
      ...new Set(inputIds.map((id) => requireDomainId(id, "输入 ID"))),
    ];
    if (ids.length > 100) throw new Error("消息窗口超出剧本交付查询范围。");
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = await this.transaction(
      (q) =>
        q.all<{ production_id: string }>(
          `SELECT DISTINCT o.production_id FROM script_command_receipts r
         JOIN script_outbox o ON o.tenant_id=r.tenant_id AND o.event_id=r.command_id
         WHERE r.tenant_id=? AND r.input_id IN (${placeholders})
           AND ((r.operation='create-item' AND o.event_kind='script.item-created' AND o.object_id=r.result_object_id)
             OR (r.operation='submit-candidate' AND o.event_kind='script.candidate-submitted' AND o.object_id=o.production_id)
             OR (r.operation IN ('add-review','submit-reviews') AND o.event_kind='script.review-changed' AND o.object_id=r.result_object_id))`,
          [tenantId, ...ids],
        ),
      true,
    );
    return rows.map((row) => row.production_id);
  }

  /** Read exact item/candidate/review deliveries from committed domain
   * receipts. The Host has already checked each production against Platform;
   * authorizedRead rechecks the live app route before and after each read.
   */
  async listInputDeliveries(request: {
    credential: string;
    inputIds: string[];
    productionIds: string[];
  }): Promise<ScriptOutput[]> {
    const inputIds = [
      ...new Set(request.inputIds.map((id) => requireDomainId(id, "输入 ID"))),
    ];
    const productionIds = [
      ...new Set(
        request.productionIds.map((id) => requireDomainId(id, "剧本 ID")),
      ),
    ];
    if (inputIds.length > 100)
      throw new Error("消息窗口超出剧本交付查询范围。");
    if (!inputIds.length || !productionIds.length) return [];
    const placeholders = inputIds.map(() => "?").join(",");
    // Match String.trim() without returning manuscript bytes to the Client.
    const trimWhitespace =
      "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
    const trimmed =
      this.backend.kind === "postgres"
        ? "btrim(d.body_text,?)"
        : "trim(d.body_text,?)";
    const outputs: ScriptOutput[] = [];
    for (const productionId of productionIds) {
      const found = await this.authorizedRead(
        request.credential,
        productionId,
        async (q, actor) => {
          if (actor.kind !== "human")
            throw new Error("剧本交付列表只供已授权的对话读者读取。");
          const production = (
            await q.all<Row>(
              "SELECT title FROM script_productions WHERE tenant_id=? AND production_id=? AND deleted_at IS NULL",
              [actor.tenantId, productionId],
            )
          )[0];
          if (!production) throw new Error("剧本原件不存在。");
          const args = [actor.tenantId, productionId, ...inputIds];
          const rows = await q.all<Row>(
            `SELECT * FROM (
              SELECT 'item' AS kind,r.command_id,r.input_id,r.committed_at,
                i.item_id,1 AS revision,d.title,
                NULL AS candidate_id,NULL AS review_id,
                i.kind AS item_kind,
                CASE WHEN LENGTH(${trimmed})=0 THEN 1 ELSE 0 END AS is_empty,
                NULL AS candidate_status
              FROM script_command_receipts r
              JOIN script_outbox o ON o.tenant_id=r.tenant_id AND o.event_id=r.command_id
                AND o.event_kind='script.item-created' AND o.object_id=r.result_object_id
              JOIN script_items i ON i.tenant_id=o.tenant_id AND i.production_id=o.production_id
                AND i.item_id=r.result_object_id
              JOIN script_item_versions v ON v.tenant_id=i.tenant_id AND v.item_id=i.item_id AND v.revision=1
              JOIN script_drafts d ON d.tenant_id=v.tenant_id AND d.draft_id=v.draft_id
              WHERE r.tenant_id=? AND o.production_id=? AND r.operation='create-item'
                AND r.input_id IN (${placeholders})
              UNION ALL
              SELECT 'candidate',r.command_id,r.input_id,r.committed_at,
                c.target_item_id,c.base_item_revision,d.title,
                c.candidate_id,NULL,i.kind,NULL,c.status
              FROM script_command_receipts r
              JOIN script_outbox o ON o.tenant_id=r.tenant_id AND o.event_id=r.command_id
                AND o.event_kind='script.candidate-submitted' AND o.object_id=o.production_id
              JOIN script_candidates c ON c.tenant_id=o.tenant_id AND c.production_id=o.production_id
                AND c.candidate_id=r.result_object_id AND c.input_id=r.input_id
              JOIN script_items i ON i.tenant_id=c.tenant_id AND i.production_id=c.production_id
                AND i.item_id=c.target_item_id
              JOIN script_drafts d ON d.tenant_id=c.tenant_id AND d.draft_id=c.draft_id
              WHERE r.tenant_id=? AND o.production_id=? AND r.operation='submit-candidate'
                AND r.input_id IN (${placeholders})
              UNION ALL
              SELECT 'review',r.command_id,r.input_id,r.committed_at,
                review.item_id,review.item_revision,d.title,
                NULL,review.review_id,i.kind,NULL,NULL
              FROM script_command_receipts r
              JOIN script_outbox o ON o.tenant_id=r.tenant_id AND o.event_id=r.command_id
                AND o.event_kind='script.review-changed' AND o.object_id=r.result_object_id
              JOIN script_reviews review ON review.tenant_id=o.tenant_id
                AND review.command_id=r.command_id AND review.input_id=r.input_id
              JOIN script_items i ON i.tenant_id=review.tenant_id AND i.item_id=review.item_id
                AND i.production_id=o.production_id
              JOIN script_item_versions v ON v.tenant_id=review.tenant_id
                AND v.item_id=review.item_id AND v.revision=review.item_revision
              JOIN script_drafts d ON d.tenant_id=v.tenant_id AND d.draft_id=v.draft_id
              WHERE r.tenant_id=? AND o.production_id=?
                AND r.operation IN ('add-review','submit-reviews')
                AND r.input_id IN (${placeholders})
            ) deliveries ORDER BY committed_at,command_id`,
            [trimWhitespace, ...args, ...args, ...args],
          );
          return rows.map((row): ScriptOutput => ({
            commandId: String(row.command_id),
            inputId: String(row.input_id),
            projectId: actor.projectId,
            productionId,
            kind: String(row.kind) as ScriptOutput["kind"],
            itemId: String(row.item_id),
            revision: safeInteger(row.revision as number | string, "交付版本"),
            title: String(row.title),
            productionTitle: String(production.title),
            itemKind: row.item_kind as ScriptOutput["itemKind"],
            ...(row.is_empty === null
              ? {}
              : {
                  isEmpty:
                    safeInteger(
                      row.is_empty as number | string,
                      "交付版本是否空白",
                    ) === 1,
                }),
            ...(row.candidate_status === null
              ? {}
              : {
                  candidateStatus:
                    row.candidate_status as ScriptOutput["candidateStatus"],
                }),
            createdAt: String(row.committed_at),
            ...(row.candidate_id === null
              ? {}
              : { candidateId: String(row.candidate_id) }),
            ...(row.review_id === null
              ? {}
              : { reviewId: String(row.review_id) }),
          }));
        },
      );
      outputs.push(...found);
    }
    return outputs.sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) ||
        a.commandId.localeCompare(b.commandId),
    );
  }

  async readInputResult(request: {
    credential: string;
    productionId: string;
    inputId: string;
    resultId: string;
  }) {
    const productionId = requireDomainId(request.productionId, "剧本 ID");
    const inputId = requireDomainId(request.inputId, "输入 ID");
    const resultId = requireDomainId(request.resultId, "结果 ID");
    const loaded = await this.authorizedRead(
      request.credential,
      productionId,
      async (q, actor) => {
        if (actor.kind === "agent" && actor.runtimeInputId !== inputId)
          throw new Error("不能读取另一条输入的结果。");
        const readReport = async (commandId: string) => {
          const report = (
            await q.all<Row>(
              "SELECT purpose,explanation,checks_json FROM script_check_reports WHERE tenant_id=? AND production_id=? AND input_id=? AND command_id=?",
              [actor.tenantId, productionId, inputId, commandId],
            )
          )[0];
          if (!report) return undefined;
          return {
            purpose: String(report.purpose),
            ...scriptWorkflowReportSchema.parse({
              explanation: report.explanation,
              checks: JSON.parse(String(report.checks_json)),
            }),
          };
        };
        const candidate = (
          await q.all<Row>(
            "SELECT c.*,d.* FROM script_candidates c JOIN script_drafts d ON d.tenant_id=c.tenant_id AND d.draft_id=c.draft_id WHERE c.tenant_id=? AND c.production_id=? AND c.input_id=? AND c.candidate_id=?",
            [actor.tenantId, productionId, inputId, resultId],
          )
        )[0];
        if (candidate) {
          const draftId = String(candidate.draft_id);
          const sources = await q.all<Row>(
            "SELECT source_app_id,source_instance_id,source_object_id,source_version_ref,quote_text FROM script_draft_sources WHERE tenant_id=? AND draft_id=? ORDER BY ordinal",
            [actor.tenantId, draftId],
          );
          const dependencies = await q.all<Row>(
            "SELECT depends_on_item_id,depends_on_revision FROM script_draft_dependencies WHERE tenant_id=? AND draft_id=? ORDER BY ordinal",
            [actor.tenantId, draftId],
          );
          const characters = await q.all<Row>(
            "SELECT character_item_id FROM script_draft_characters WHERE tenant_id=? AND draft_id=? ORDER BY ordinal",
            [actor.tenantId, draftId],
          );
          const references = await q.all<Row>(
            "SELECT item_id,revision FROM script_candidate_references WHERE tenant_id=? AND candidate_id=? ORDER BY ordinal",
            [actor.tenantId, resultId],
          );
          const sourceRefs = sources.map((source) => ({
            appId: String(source.source_app_id),
            instanceId: String(source.source_instance_id),
            objectId: String(source.source_object_id),
            versionRef: String(source.source_version_ref),
            quote: String(source.quote_text),
          }));
          return {
            actor,
            sourceRefs,
            kind: "candidate" as const,
            status: String(candidate.status),
            value: {
              id: resultId,
              inputId,
              targetId: String(candidate.target_item_id),
              baseRevision: safeInteger(
                candidate.base_item_revision as number | string,
                "候选基准版本",
              ),
              contextRevision: safeInteger(
                candidate.context_revision as number | string,
                "候选上下文版本",
              ),
              references: references.map((ref) => ({
                itemId: String(ref.item_id),
                revision: safeInteger(
                  ref.revision as number | string,
                  "候选引用版本",
                ),
              })),
              draft: {
                title: String(candidate.title),
                text: String(candidate.body_text),
                parentId:
                  candidate.parent_item_id === null
                    ? null
                    : String(candidate.parent_item_id),
                order: safeInteger(
                  candidate.order_index as number | string,
                  "条目顺序",
                ),
                basis: candidate.basis as LiveScriptDraft["basis"],
                sources: sourceRefs,
                dependencies: dependencies.map((ref) => ({
                  itemId: String(ref.depends_on_item_id),
                  revision: safeInteger(
                    ref.depends_on_revision as number | string,
                    "依赖版本",
                  ),
                })),
                location: String(candidate.location_text),
                storyTime: String(candidate.story_time),
                characters: characters.map((ref) =>
                  String(ref.character_item_id),
                ),
                audienceKnowledge: String(candidate.audience_knowledge),
                characterKnowledge: String(candidate.character_knowledge),
                setupPayoff: String(candidate.setup_payoff),
                productionNotes: String(candidate.production_notes),
              },
              explanation: String(candidate.explanation),
              workflowReport: await readReport(resultId),
            },
          };
        }
        const review = (
          await q.all<Row>(
            "SELECT r.* FROM script_reviews r JOIN script_items i ON i.tenant_id=r.tenant_id AND i.item_id=r.item_id WHERE r.tenant_id=? AND i.production_id=? AND r.input_id=? AND r.review_id=?",
            [actor.tenantId, productionId, inputId, resultId],
          )
        )[0];
        if (!review) {
          const workflowReport = await readReport(resultId);
          if (
            !workflowReport ||
            !["continuity", "impact"].includes(workflowReport.purpose)
          )
            throw new DomainError("not_found", "本次输入没有这个已提交结果。");
          return {
            actor,
            sourceRefs: [],
            kind: "review" as const,
            status: "complete",
            value: { id: resultId, inputId, ...workflowReport },
          };
        }
        return {
          actor,
          sourceRefs: [],
          kind: "review" as const,
          status: review.resolved_at === null ? "unresolved" : "resolved",
          value: {
            id: resultId,
            inputId,
            itemId: String(review.item_id),
            itemRevision: safeInteger(
              review.item_revision as number | string,
              "审查版本",
            ),
            contextRevision:
              review.context_revision === null
                ? null
                : safeInteger(
                    review.context_revision as number | string,
                    "审查上下文版本",
                  ),
            quote: String(review.quote_text),
            body: String(review.body_text),
            severity: String(review.severity),
            historicalOnly:
              review.historical_only === null
                ? false
                : readBool(review.historical_only as number | string),
            workflowReport:
              review.command_id == null
                ? undefined
                : await readReport(String(review.command_id)),
          },
        };
      },
      { modelData: true },
    );
    for (const source of loaded.sourceRefs) {
      if (
        !this.authority?.verifySourceVersion ||
        !(await this.authority.verifySourceVersion({
          credential: request.credential,
          tenantId: loaded.actor.tenantId,
          principalId: loaded.actor.principalId,
          actantId: loaded.actor.actantId,
          kind: loaded.actor.kind,
          runtimeInputId: loaded.actor.runtimeInputId,
          runtimeTaskRunEventId: loaded.actor.runtimeTaskRunEventId ?? null,
          productionProjectId: loaded.actor.projectId,
          alreadyPinned: true,
          ...source,
        }))
      )
        throw new DomainError("forbidden", "候选引用的原件已不可读。");
    }
    const current = await this.authority!.authorizeObject({
      credential: request.credential,
      productionId,
      operation: "read",
    });
    if (
      !current ||
      current.objectKind !== "script" ||
      current.tenantId !== loaded.actor.tenantId ||
      current.principalId !== loaded.actor.principalId ||
      current.actantId !== loaded.actor.actantId ||
      current.kind !== loaded.actor.kind ||
      current.projectId !== loaded.actor.projectId ||
      current.runtimeInputId !== loaded.actor.runtimeInputId ||
      (current.runtimeTaskRunEventId ?? null) !==
        (loaded.actor.runtimeTaskRunEventId ?? null)
    )
      throw new DomainError("forbidden", "读取结果期间权限已变化。");
    await this.assertActiveInput(loaded.actor);
    return {
      inputId,
      resultId,
      kind: loaded.kind,
      status: loaded.status,
      format: "script-result-json" as const,
      resultJson: JSON.stringify(loaded.value),
    };
  }

  /** An export is an immutable selection receipt, not a second manuscript.
   * It advances activity so every Client sees the saved export history. */
  async recordExport(request: {
    credential: string;
    commandId: string;
    productionId: string;
    expectedRevision: number;
    items: Array<{ itemId: string; revision: number }>;
    template: ScriptProduction["template"];
    workingCopy?: true;
  }): Promise<ScriptExportReceipt> {
    if (!this.authority) throw new Error("剧本工作室尚未接入受信对象权限。");
    const commandId = requireDomainId(request.commandId, "命令 ID");
    const productionId = requireDomainId(request.productionId, "剧本 ID");
    if (
      !Number.isSafeInteger(request.expectedRevision) ||
      request.expectedRevision < 1 ||
      request.items.length < 1 ||
      request.items.length > 5000
    )
      throw new DomainError("invalid", "导出范围无效。");
    const items = request.items.map((item) => ({
      itemId: requireDomainId(item.itemId, "导出条目 ID"),
      revision: safeInteger(item.revision, "导出条目版本"),
    }));
    if (
      items.some((item) => item.revision < 1) ||
      new Set(items.map((item) => item.itemId)).size !== items.length
    )
      throw new DomainError("invalid", "导出条目重复或版本无效。");
    const template = scriptExportTemplateSchema.parse(request.template);
    const authorize = () =>
      this.authority!.authorizeObject({
        credential: request.credential,
        productionId,
        operation: "write",
      });
    const actor = await authorize();
    if (!actor || actor.objectKind !== "script" || actor.kind !== "human")
      throw new DomainError("forbidden", "只有获授权的本人可以导出剧本。");
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          tenantId: actor.tenantId,
          principalId: actor.principalId,
          actantId: actor.actantId,
          projectId: actor.projectId,
          productionId,
          expectedRevision: request.expectedRevision,
          items,
          template,
          workingCopy: request.workingCopy === true,
        }),
      )
      .digest("hex");
    return this.transaction(async (q) => {
      if (this.backend.kind === "postgres")
        await q.all(
          "SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0)) AS locked",
          [`script:${actor.tenantId}:${productionId}`],
        );
      const prior = (
        await q.all<Row>(
          "SELECT request_hash,operation,result_object_id FROM script_command_receipts WHERE tenant_id=? AND command_id=?",
          [actor.tenantId, commandId],
        )
      )[0];
      if (prior) {
        if (
          prior.request_hash !== requestHash ||
          prior.operation !== "record-export" ||
          prior.result_object_id !== commandId ||
          !(
            await q.all(
              "SELECT 1 AS present FROM script_exports WHERE tenant_id=? AND production_id=? AND export_id=?",
              [actor.tenantId, productionId, commandId],
            )
          ).length
        )
          throw new DomainError("conflict", "相同命令 ID 对应不同导出请求。");
        const row = (
          await q.all<Row>(
            "SELECT p.title,o.version_ref FROM script_outbox o JOIN script_productions p ON p.tenant_id=o.tenant_id AND p.production_id=o.production_id WHERE o.tenant_id=? AND o.event_id=? AND o.production_id=? AND o.object_id=? AND o.event_kind='script.export-recorded' AND p.deleted_at IS NULL",
            [actor.tenantId, commandId, productionId, commandId],
          )
        )[0];
        if (!row)
          throw new DomainError("conflict", "导出回执与目录事件不一致。");
        const activityRevision = safeInteger(
          row.version_ref as number | string,
          "导出活动修订",
        );
        return {
          tenantId: actor.tenantId,
          productionId,
          exportId: commandId,
          activityRevision,
          versionRef: String(activityRevision),
          title: String(row.title),
          receiptId: commandId,
          eventId: commandId,
        };
      }
      if (
        (
          await q.all(
            "SELECT 1 AS present FROM script_outbox WHERE tenant_id=? AND production_id=? AND delivered_at IS NULL",
            [actor.tenantId, productionId],
          )
        ).length
      )
        throw new DomainError(
          "conflict",
          "上一次剧本目录更新尚未完成，请先恢复投影。",
        );
      const production = await this.productionSnapshot(
        q,
        actor.tenantId,
        productionId,
        actor.projectId,
        true,
      );
      if (production.revision !== request.expectedRevision)
        throw new DomainError(
          "conflict",
          "剧本规范已变化，请重新确认导出范围。",
        );
      if (JSON.stringify(production.template) !== JSON.stringify(template))
        throw new DomainError("conflict", "导出模板已变化，请重新确认。");
      const selected = new Set(items.map((item) => item.itemId));
      const issues = request.workingCopy ? [] : scriptIssues(production);
      for (const ref of items) {
        const item = production.items.find((entry) => entry.id === ref.itemId);
        if (
          !item ||
          !["episode", "scene"].includes(item.kind) ||
          item.revision !== ref.revision
        )
          throw new DomainError("conflict", "导出条目或正文版本已变化。");
        if (
          item.kind === "scene" &&
          !selected.has(currentScriptDraft(item).parentId!)
        )
          throw new DomainError("invalid", "导出分场时须包含所属集。");
        if (
          !request.workingCopy &&
          (item.status !== "locked" ||
            !item.approval ||
            !scriptContextCurrent(production, item.approval.contextRevision) ||
            issues.some((issue) => issue.itemId === item.id))
        )
          throw new DomainError(
            "conflict",
            "正式交付只能导出审阅有效的锁定稿。",
          );
      }
      if (
        request.workingCopy &&
        !items.some((ref) =>
          currentScriptDraft(
            production.items.find((item) => item.id === ref.itemId)!,
          ).text.trim(),
        )
      )
        throw new DomainError("invalid", "请先保存需要导出的正文。");
      const current = await authorize();
      if (
        !current ||
        current.tenantId !== actor.tenantId ||
        current.principalId !== actor.principalId ||
        current.actantId !== actor.actantId ||
        current.projectId !== actor.projectId ||
        current.kind !== actor.kind
      )
        throw new DomainError("forbidden", "剧本权限在导出期间已变化。");
      const now = new Date().toISOString();
      const fields = templateColumns(template);
      await insert(q, "script_exports", {
        tenant_id: actor.tenantId,
        export_id: commandId,
        production_id: productionId,
        collection_ordinal: production.exports.length,
        context_revision: production.revision,
        format: "docx",
        working_copy: request.workingCopy ? 1 : null,
        ...fields,
        created_by_principal_id: actor.principalId,
        created_by_actant_id: actor.actantId,
        created_at: now,
      });
      for (const [ordinal, ref] of items.entries())
        await insert(q, "script_export_items", {
          tenant_id: actor.tenantId,
          export_id: commandId,
          ordinal,
          item_id: ref.itemId,
          revision: ref.revision,
        });
      const activityRevision =
        safeInteger(production.activityRevision!, "剧本活动修订") + 1;
      if (
        !Number.isSafeInteger(activityRevision) ||
        (await q.change(
          "UPDATE script_productions SET activity_revision=?,updated_at=? WHERE tenant_id=? AND production_id=? AND activity_revision=? AND deleted_at IS NULL",
          [
            activityRevision,
            now,
            actor.tenantId,
            productionId,
            activityRevision - 1,
          ],
        )) !== 1
      )
        throw new DomainError("conflict", "剧本活动修订发生并发冲突。");
      await insert(q, "script_command_receipts", {
        tenant_id: actor.tenantId,
        command_id: commandId,
        request_hash: requestHash,
        input_id: actor.runtimeInputId,
        task_run_event_id: actor.runtimeTaskRunEventId ?? null,
        operation: "record-export",
        result_object_id: commandId,
        result_version_ref: String(activityRevision),
        committed_at: now,
      });
      await insert(q, "script_outbox", {
        tenant_id: actor.tenantId,
        event_id: commandId,
        production_id: productionId,
        object_id: commandId,
        version_ref: String(activityRevision),
        requested_project_id: null,
        event_kind: "script.export-recorded",
        created_at: now,
        delivered_at: null,
      });
      return {
        tenantId: actor.tenantId,
        productionId,
        exportId: commandId,
        activityRevision,
        versionRef: String(activityRevision),
        title: production.title,
        receiptId: commandId,
        eventId: commandId,
      };
    });
  }

  /** Human review is a versioned domain state transition. No model call or
   * implicit external notification is created by this command. */
  async transitionWorkflow(request: {
    credential: string;
    commandId: string;
    productionId: string;
    itemId: string;
    expectedRevision: number;
    expectedWorkflowRevision: number;
    action: "submit-review" | "review-decision" | "lock-item" | "unlock-item";
    decision?: "approve" | "request-changes";
    note?: string;
  }): Promise<ScriptWorkflowReceipt> {
    if (!this.authority) throw new Error("剧本工作室尚未接入受信对象权限。");
    const commandId = requireDomainId(request.commandId, "命令 ID");
    const productionId = requireDomainId(request.productionId, "剧本 ID");
    const itemId = requireDomainId(request.itemId, "条目 ID");
    if (
      !Number.isSafeInteger(request.expectedRevision) ||
      request.expectedRevision < 1 ||
      !Number.isSafeInteger(request.expectedWorkflowRevision) ||
      request.expectedWorkflowRevision < 1 ||
      (request.action === "review-decision" &&
        !["approve", "request-changes"].includes(request.decision ?? "")) ||
      (request.action !== "review-decision" &&
        request.decision !== undefined) ||
      (request.note?.length ?? 0) > 5000 ||
      ((request.action === "unlock-item" ||
        request.decision === "request-changes") &&
        !request.note?.trim())
    )
      throw new DomainError("invalid", "审阅操作或说明无效。");
    const authorize = () =>
      this.authority!.authorizeObject({
        credential: request.credential,
        productionId,
        operation: "write",
      });
    const actor = await authorize();
    if (!actor || actor.objectKind !== "script" || actor.kind !== "human")
      throw new DomainError("forbidden", "只有获授权的本人可以修改审阅状态。");
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          tenantId: actor.tenantId,
          principalId: actor.principalId,
          actantId: actor.actantId,
          projectId: actor.projectId,
          productionId,
          itemId,
          expectedRevision: request.expectedRevision,
          expectedWorkflowRevision: request.expectedWorkflowRevision,
          action: request.action,
          decision: request.decision ?? null,
          note: request.note ?? "",
        }),
      )
      .digest("hex");
    return this.transaction(async (q) => {
      if (this.backend.kind === "postgres")
        await q.all(
          "SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0)) AS locked",
          [`script:${actor.tenantId}:${productionId}`],
        );
      const prior = (
        await q.all<Row>(
          "SELECT request_hash,operation,result_object_id,result_version_ref FROM script_command_receipts WHERE tenant_id=? AND command_id=?",
          [actor.tenantId, commandId],
        )
      )[0];
      if (prior) {
        if (
          prior.request_hash !== requestHash ||
          prior.operation !== request.action ||
          prior.result_object_id !== itemId ||
          !(
            await q.all(
              "SELECT 1 AS present FROM script_outbox WHERE tenant_id=? AND event_id=? AND production_id=? AND object_id=? AND event_kind='script.workflow-changed' AND version_ref=?",
              [
                actor.tenantId,
                commandId,
                productionId,
                itemId,
                prior.result_version_ref as string,
              ],
            )
          ).length
        )
          throw new DomainError("conflict", "相同命令 ID 对应不同审阅操作。");
        const title = (
          await q.all<{ title: string }>(
            "SELECT title FROM script_productions WHERE tenant_id=? AND production_id=? AND deleted_at IS NULL",
            [actor.tenantId, productionId],
          )
        )[0]?.title;
        if (!title) throw new DomainError("not_found", "剧本原件不存在。");
        const activityRevision = safeInteger(
          prior.result_version_ref as number | string,
          "审阅活动修订",
        );
        return {
          tenantId: actor.tenantId,
          productionId,
          itemId,
          activityRevision,
          versionRef: String(activityRevision),
          title,
          receiptId: commandId,
          eventId: commandId,
        };
      }
      if (
        (
          await q.all(
            "SELECT 1 AS present FROM script_outbox WHERE tenant_id=? AND production_id=? AND delivered_at IS NULL",
            [actor.tenantId, productionId],
          )
        ).length
      )
        throw new DomainError(
          "conflict",
          "上一次剧本目录更新尚未完成，请先恢复投影。",
        );
      const production = await this.productionSnapshot(
        q,
        actor.tenantId,
        productionId,
        actor.projectId,
        true,
      );
      const item = production.items.find((entry) => entry.id === itemId);
      if (!item) throw new DomainError("not_found", "剧本条目不存在。");
      if (
        item.revision !== request.expectedRevision ||
        item.workflowRevision !== request.expectedWorkflowRevision
      )
        throw new DomainError("conflict", "正文或审阅状态已变化，请重新核对。");
      if (
        request.action !== "submit-review" &&
        !production.reviewerPrincipalIds.includes(actor.principalId)
      )
        throw new DomainError(
          "forbidden",
          "只有指定审阅人可以批准、锁稿或解锁。",
        );
      const eventAction =
        request.action === "submit-review"
          ? "submit"
          : request.action === "review-decision"
            ? request.decision!
            : request.action === "lock-item"
              ? "lock"
              : "unlock";
      let status: "draft" | "in-review" | "approved" | "locked";
      if (request.action === "submit-review") {
        if (item.status !== "draft" || !currentScriptDraft(item).text.trim())
          throw new DomainError(
            "conflict",
            "只有已保存正文的草稿可以提交审阅。",
          );
        status = "in-review";
      } else if (request.action === "review-decision") {
        if (item.status !== "in-review")
          throw new DomainError("conflict", "文稿当前不在审阅中。");
        status = request.decision === "approve" ? "approved" : "draft";
      } else if (request.action === "lock-item") {
        if (
          item.status !== "approved" ||
          item.approval?.revision !== item.revision ||
          !scriptContextCurrent(production, item.approval.contextRevision)
        )
          throw new DomainError("conflict", "只能锁定已批准的当前版本。");
        status = "locked";
      } else {
        if (item.status !== "locked")
          throw new DomainError("conflict", "文稿尚未锁定。");
        status = "draft";
      }
      if (status === "approved" || status === "locked") {
        if (!currentScriptDraft(item).text.trim())
          throw new DomainError("invalid", "正文为空，不能批准或锁稿。");
        const issues = scriptIssues(production).filter(
          (issue) => issue.itemId === itemId,
        );
        if (issues.length)
          throw new DomainError(
            "conflict",
            issues.map((issue) => issue.message).join("；"),
          );
        for (const ref of currentScriptDraft(item).dependencies) {
          const upstream = production.items.find(
            (entry) => entry.id === ref.itemId,
          );
          if (
            !upstream?.approval ||
            upstream.approval.revision !== ref.revision ||
            !scriptContextCurrent(production, upstream.approval.contextRevision)
          )
            throw new DomainError(
              "conflict",
              "依赖的上游尚未批准或需要重新审阅。",
            );
        }
      }
      const current = await authorize();
      if (
        !current ||
        current.tenantId !== actor.tenantId ||
        current.principalId !== actor.principalId ||
        current.actantId !== actor.actantId ||
        current.projectId !== actor.projectId ||
        current.kind !== actor.kind
      )
        throw new DomainError("forbidden", "剧本权限在审阅期间已变化。");
      const now = new Date().toISOString();
      if (
        (await q.change(
          "UPDATE script_items SET status=?,workflow_revision=workflow_revision+1,updated_at=? WHERE tenant_id=? AND production_id=? AND item_id=? AND head_revision=? AND workflow_revision=?",
          [
            status,
            now,
            actor.tenantId,
            productionId,
            itemId,
            request.expectedRevision,
            request.expectedWorkflowRevision,
          ],
        )) !== 1
      )
        throw new DomainError("conflict", "审阅状态已变化。");
      if (status === "approved")
        await insert(q, "script_item_approvals", {
          tenant_id: actor.tenantId,
          item_id: itemId,
          revision: item.revision,
          context_revision: production.revision,
          note: request.note ?? "",
          author_principal_id: actor.principalId,
          author_actant_id: actor.actantId,
          created_at: now,
        });
      if (status === "draft")
        await q.change(
          "DELETE FROM script_item_approvals WHERE tenant_id=? AND item_id=?",
          [actor.tenantId, itemId],
        );
      const appendEvent = async (
        targetId: string,
        action: string,
        revision: number,
        note: string,
      ) => {
        const next = (
          await q.all<{ ordinal: number | string }>(
            "SELECT COALESCE(MAX(ordinal)+1,0) AS ordinal FROM script_item_events WHERE tenant_id=? AND item_id=?",
            [actor.tenantId, targetId],
          )
        )[0]!;
        await insert(q, "script_item_events", {
          tenant_id: actor.tenantId,
          item_id: targetId,
          ordinal: safeInteger(next.ordinal, "审阅事件序号"),
          action,
          revision,
          note,
          author_principal_id: actor.principalId,
          author_actant_id: actor.actantId,
          created_at: now,
        });
      };
      await appendEvent(itemId, eventAction, item.revision, request.note ?? "");
      if (request.action === "unlock-item") {
        for (const affectedId of scriptImpact(production, [itemId])) {
          const affected = production.items.find(
            (entry) => entry.id === affectedId,
          )!;
          await q.change(
            "UPDATE script_items SET status=CASE WHEN status='locked' THEN status ELSE 'draft' END,workflow_revision=workflow_revision+1,updated_at=? WHERE tenant_id=? AND production_id=? AND item_id=?",
            [now, actor.tenantId, productionId, affectedId],
          );
          await q.change(
            "DELETE FROM script_item_approvals WHERE tenant_id=? AND item_id=?",
            [actor.tenantId, affectedId],
          );
          await appendEvent(
            affectedId,
            "invalidate",
            affected.revision,
            `上游 ${itemId} 已解锁`,
          );
        }
      }
      const activityRevision = production.activityRevision! + 1;
      if (
        !Number.isSafeInteger(activityRevision) ||
        (await q.change(
          "UPDATE script_productions SET activity_revision=?,updated_at=? WHERE tenant_id=? AND production_id=? AND activity_revision=? AND deleted_at IS NULL",
          [
            activityRevision,
            now,
            actor.tenantId,
            productionId,
            activityRevision - 1,
          ],
        )) !== 1
      )
        throw new DomainError("conflict", "剧本活动修订发生并发冲突。");
      await insert(q, "script_command_receipts", {
        tenant_id: actor.tenantId,
        command_id: commandId,
        request_hash: requestHash,
        input_id: actor.runtimeInputId,
        task_run_event_id: actor.runtimeTaskRunEventId ?? null,
        operation: request.action,
        result_object_id: itemId,
        result_version_ref: String(activityRevision),
        committed_at: now,
      });
      await insert(q, "script_outbox", {
        tenant_id: actor.tenantId,
        event_id: commandId,
        production_id: productionId,
        object_id: itemId,
        version_ref: String(activityRevision),
        requested_project_id: null,
        event_kind: "script.workflow-changed",
        created_at: now,
        delivered_at: null,
      });
      return {
        tenantId: actor.tenantId,
        productionId,
        itemId,
        activityRevision,
        versionRef: String(activityRevision),
        title: production.title,
        receiptId: commandId,
        eventId: commandId,
      };
    });
  }

  async changeReview(request: {
    credential: string;
    commandId: string;
    productionId: string;
    action: "add-review" | "resolve-review";
    itemId?: string;
    itemRevision?: number;
    quote?: string;
    body?: string;
    severity?: "note" | "warning" | "blocking";
    reviewId?: string;
    expectedRevision?: number;
    resolution?: string;
  }): Promise<ScriptReviewReceipt> {
    if (!this.authority) throw new Error("剧本工作室尚未接入受信对象权限。");
    const commandId = requireDomainId(request.commandId, "命令 ID");
    const productionId = requireDomainId(request.productionId, "剧本 ID");
    const isAdd = request.action === "add-review";
    const itemId = isAdd
      ? requireDomainId(request.itemId ?? "", "条目 ID")
      : null;
    const reviewId = isAdd
      ? commandId
      : requireDomainId(request.reviewId ?? "", "审阅 ID");
    if (
      isAdd
        ? !Number.isSafeInteger(request.itemRevision) ||
          (request.itemRevision ?? 0) < 1 ||
          (request.quote?.length ?? 0) > 10_000 ||
          !request.body?.trim() ||
          request.body.length > 10_000 ||
          !["note", "warning", "blocking"].includes(request.severity ?? "")
        : !Number.isSafeInteger(request.expectedRevision) ||
          (request.expectedRevision ?? 0) < 1 ||
          !request.resolution?.trim() ||
          request.resolution.length > 5000
    )
      throw new DomainError("invalid", "审阅意见或解决方式无效。");
    const authorize = () =>
      this.authority!.authorizeObject({
        credential: request.credential,
        productionId,
        operation: "write",
      });
    const actor = await authorize();
    if (
      !actor ||
      actor.objectKind !== "script" ||
      (!isAdd && actor.kind !== "human")
    )
      throw new DomainError("forbidden", "没有修改审阅意见的权限。");
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          tenantId: actor.tenantId,
          principalId: actor.principalId,
          actantId: actor.actantId,
          projectId: actor.projectId,
          productionId,
          action: request.action,
          itemId,
          reviewId,
          itemRevision: request.itemRevision ?? null,
          quote: request.quote ?? null,
          body: request.body ?? null,
          severity: request.severity ?? null,
          expectedRevision: request.expectedRevision ?? null,
          resolution: request.resolution ?? null,
        }),
      )
      .digest("hex");
    return this.transaction(async (q) => {
      if (this.backend.kind === "postgres")
        await q.all(
          "SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0)) AS locked",
          [`script:${actor.tenantId}:${productionId}`],
        );
      const prior = (
        await q.all<Row>(
          "SELECT request_hash,operation,result_object_id,result_version_ref FROM script_command_receipts WHERE tenant_id=? AND command_id=?",
          [actor.tenantId, commandId],
        )
      )[0];
      if (prior) {
        if (
          prior.request_hash !== requestHash ||
          prior.operation !== request.action ||
          prior.result_object_id !== reviewId ||
          !(
            await q.all(
              "SELECT 1 AS present FROM script_outbox WHERE tenant_id=? AND event_id=? AND production_id=? AND object_id=? AND event_kind='script.review-changed' AND version_ref=?",
              [
                actor.tenantId,
                commandId,
                productionId,
                reviewId,
                prior.result_version_ref as string,
              ],
            )
          ).length
        )
          throw new DomainError("conflict", "相同命令 ID 对应不同审阅操作。");
        const title = (
          await q.all<{ title: string }>(
            "SELECT title FROM script_productions WHERE tenant_id=? AND production_id=? AND deleted_at IS NULL",
            [actor.tenantId, productionId],
          )
        )[0]?.title;
        if (!title) throw new DomainError("not_found", "剧本原件不存在。");
        const activityRevision = safeInteger(
          prior.result_version_ref as number | string,
          "审阅活动修订",
        );
        return {
          tenantId: actor.tenantId,
          productionId,
          reviewId,
          activityRevision,
          versionRef: String(activityRevision),
          title,
          receiptId: commandId,
          eventId: commandId,
        };
      }
      if (
        (
          await q.all(
            "SELECT 1 AS present FROM script_outbox WHERE tenant_id=? AND production_id=? AND delivered_at IS NULL",
            [actor.tenantId, productionId],
          )
        ).length
      )
        throw new DomainError(
          "conflict",
          "上一次剧本目录更新尚未完成，请先恢复投影。",
        );
      const production = await this.productionSnapshot(
        q,
        actor.tenantId,
        productionId,
        actor.projectId,
        true,
      );
      let historicalOnly = false;
      if (isAdd) {
        const item = production.items.find((entry) => entry.id === itemId);
        const version = item?.versions.find(
          (entry) => entry.revision === request.itemRevision,
        );
        if (
          !version ||
          (request.quote && !version.draft.text.includes(request.quote))
        )
          throw new DomainError("invalid", "意见必须锚定有效正文版本及原文。");
        historicalOnly = item!.revision !== request.itemRevision;
        if (actor.kind === "agent") {
          const inputId = actor.runtimeInputId;
          const preparation =
            inputId &&
            (await this.preparationForInput(
              q,
              actor.tenantId,
              productionId,
              inputId,
            ));
          if (
            !preparation ||
            !["continuity", "impact"].includes(
              preparation.generation.purpose,
            ) ||
            ![
              {
                itemId: preparation.generation.targetId,
                revision: preparation.generation.baseRevision,
              },
              ...preparation.generation.references,
            ].some(
              (ref) =>
                ref.itemId === itemId && ref.revision === request.itemRevision,
            ) ||
            !production.brief.modelProcessingAllowed
          )
            throw new DomainError(
              "forbidden",
              "审阅意见不属于本次固定的生成范围。",
            );
          const count = (
            await q.all<{ total: number | string }>(
              "SELECT COUNT(*) AS total FROM script_reviews WHERE tenant_id=? AND input_id=?",
              [actor.tenantId, inputId],
            )
          )[0]!;
          if (safeInteger(count.total, "本次审阅数量") >= 100)
            throw new DomainError("invalid", "本次审阅意见已达上限。");
          historicalOnly ||=
            !scriptContextCurrent(
              production,
              preparation.generation.contextRevision,
            ) ||
            [
              {
                itemId: preparation.generation.targetId,
                revision: preparation.generation.baseRevision,
              },
              ...preparation.generation.references,
            ].some(
              (ref) =>
                production.items.find((entry) => entry.id === ref.itemId)
                  ?.revision !== ref.revision,
            );
        }
      } else {
        const review = production.reviews.find(
          (entry) => entry.id === reviewId,
        );
        if (!review) throw new DomainError("not_found", "审阅意见不存在。");
        if (review.revision !== request.expectedRevision || review.resolvedAt)
          throw new DomainError("conflict", "审阅意见已变化或已处理。");
      }
      const current = await authorize();
      if (
        !current ||
        current.tenantId !== actor.tenantId ||
        current.principalId !== actor.principalId ||
        current.actantId !== actor.actantId ||
        current.projectId !== actor.projectId ||
        current.kind !== actor.kind
      )
        throw new DomainError("forbidden", "剧本权限在审阅期间已变化。");
      const now = new Date().toISOString();
      if (isAdd) {
        await insert(q, "script_reviews", {
          tenant_id: actor.tenantId,
          review_id: reviewId,
          collection_ordinal: production.reviews.length,
          item_id: itemId!,
          item_revision: request.itemRevision!,
          context_revision: production.revision,
          historical_only: historicalOnly ? 1 : 0,
          review_revision: 1,
          severity: request.severity!,
          quote_text: request.quote ?? "",
          body_text: request.body!,
          author_principal_id: actor.principalId,
          author_actant_id: actor.actantId,
          input_id: actor.runtimeInputId,
          command_id: commandId,
          created_at: now,
          resolved_at: null,
          resolved_by_principal_id: null,
          resolved_by_actant_id: null,
          resolution: "",
        });
        if (request.severity === "blocking" && !historicalOnly) {
          const affectedIds = [itemId!, ...scriptImpact(production, [itemId!])];
          for (const affectedId of affectedIds) {
            const affected = production.items.find(
              (entry) => entry.id === affectedId,
            )!;
            await q.change(
              "UPDATE script_items SET status=CASE WHEN status='locked' THEN status ELSE 'draft' END,workflow_revision=workflow_revision+1,updated_at=? WHERE tenant_id=? AND production_id=? AND item_id=?",
              [now, actor.tenantId, productionId, affectedId],
            );
            await q.change(
              "DELETE FROM script_item_approvals WHERE tenant_id=? AND item_id=?",
              [actor.tenantId, affectedId],
            );
            const event = (
              await q.all<{ ordinal: number | string }>(
                "SELECT COALESCE(MAX(ordinal)+1,0) AS ordinal FROM script_item_events WHERE tenant_id=? AND item_id=?",
                [actor.tenantId, affectedId],
              )
            )[0]!;
            await insert(q, "script_item_events", {
              tenant_id: actor.tenantId,
              item_id: affectedId,
              ordinal: safeInteger(event.ordinal, "审阅事件序号"),
              action: "invalidate",
              revision: affected.revision,
              note: "新增阻断审阅意见",
              author_principal_id: actor.principalId,
              author_actant_id: actor.actantId,
              created_at: now,
            });
          }
        }
      } else if (
        (await q.change(
          "UPDATE script_reviews SET review_revision=review_revision+1,resolved_at=?,resolved_by_principal_id=?,resolved_by_actant_id=?,resolution=? WHERE tenant_id=? AND review_id=? AND review_revision=? AND resolved_at IS NULL",
          [
            now,
            actor.principalId,
            actor.actantId,
            request.resolution!,
            actor.tenantId,
            reviewId,
            request.expectedRevision!,
          ],
        )) !== 1
      )
        throw new DomainError("conflict", "审阅意见已变化。");
      const activityRevision = production.activityRevision! + 1;
      if (
        !Number.isSafeInteger(activityRevision) ||
        (await q.change(
          "UPDATE script_productions SET activity_revision=?,updated_at=? WHERE tenant_id=? AND production_id=? AND activity_revision=? AND deleted_at IS NULL",
          [
            activityRevision,
            now,
            actor.tenantId,
            productionId,
            activityRevision - 1,
          ],
        )) !== 1
      )
        throw new DomainError("conflict", "剧本活动修订发生并发冲突。");
      await insert(q, "script_command_receipts", {
        tenant_id: actor.tenantId,
        command_id: commandId,
        request_hash: requestHash,
        input_id: actor.runtimeInputId,
        task_run_event_id: actor.runtimeTaskRunEventId ?? null,
        operation: request.action,
        result_object_id: reviewId,
        result_version_ref: String(activityRevision),
        committed_at: now,
      });
      await insert(q, "script_outbox", {
        tenant_id: actor.tenantId,
        event_id: commandId,
        production_id: productionId,
        object_id: reviewId,
        version_ref: String(activityRevision),
        requested_project_id: null,
        event_kind: "script.review-changed",
        created_at: now,
        delivered_at: null,
      });
      return {
        tenantId: actor.tenantId,
        productionId,
        reviewId,
        activityRevision,
        versionRef: String(activityRevision),
        title: production.title,
        receiptId: commandId,
        eventId: commandId,
      };
    });
  }

  /** One pinned Agent result is one app transaction, even when it contains
   * several observations. A failed last quote cannot leave partial reviews. */
  async submitReviewBatch(request: {
    credential: string;
    commandId: string;
    productionId: string;
    inputId: string;
    workflowReport?: ScriptWorkflowReport;
    reviews: Array<{
      itemId: string;
      itemRevision: number;
      quote: string;
      body: string;
      severity: "note" | "warning" | "blocking";
    }>;
  }): Promise<ScriptReviewBatchReceipt> {
    if (!this.authority) throw new Error("剧本工作室尚未接入受信对象权限。");
    const commandId = requireDomainId(request.commandId, "命令 ID");
    const productionId = requireDomainId(request.productionId, "剧本 ID");
    const inputId = requireDomainId(request.inputId, "输入 ID");
    const workflowReport =
      request.workflowReport === undefined
        ? undefined
        : scriptWorkflowReportSchema.parse(request.workflowReport);
    if (
      request.reviews.length > 32 ||
      (!request.reviews.length && !workflowReport)
    )
      throw new DomainError("invalid", "一次最多提交 32 条审阅意见。");
    const reviews = request.reviews.map((review) => {
      const itemId = requireDomainId(review.itemId, "条目 ID");
      if (
        !Number.isSafeInteger(review.itemRevision) ||
        review.itemRevision < 1 ||
        review.quote.length > 10_000 ||
        !review.body.trim() ||
        review.body.length > 10_000 ||
        !["note", "warning", "blocking"].includes(review.severity)
      )
        throw new DomainError("invalid", "审阅意见无效。");
      return { ...review, itemId };
    });
    const reviewIds = reviews.map((_, index) => `${commandId}-${index}`);
    const authorize = () =>
      this.authority!.authorizeObject({
        credential: request.credential,
        productionId,
        operation: "write",
      });
    const actor = await authorize();
    if (
      !actor ||
      actor.objectKind !== "script" ||
      actor.kind !== "agent" ||
      actor.runtimeInputId !== inputId
    )
      throw new DomainError(
        "forbidden",
        "审阅意见必须来自本次固定输入的 Agent。",
      );
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          tenantId: actor.tenantId,
          principalId: actor.principalId,
          actantId: actor.actantId,
          projectId: actor.projectId,
          productionId,
          inputId,
          reviews,
          workflowReport,
        }),
      )
      .digest("hex");
    return this.transaction(async (q) => {
      if (this.backend.kind === "postgres")
        await q.all(
          "SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0)) AS locked",
          [`script:${actor.tenantId}:${productionId}`],
        );
      const prior = (
        await q.all<Row>(
          "SELECT request_hash,operation,result_object_id,result_version_ref FROM script_command_receipts WHERE tenant_id=? AND command_id=?",
          [actor.tenantId, commandId],
        )
      )[0];
      if (prior) {
        if (
          prior.request_hash !== requestHash ||
          prior.operation !== "submit-reviews" ||
          prior.result_object_id !== commandId ||
          !(
            await q.all(
              "SELECT 1 AS present FROM script_outbox WHERE tenant_id=? AND event_id=? AND production_id=? AND object_id=? AND event_kind='script.review-changed' AND version_ref=?",
              [
                actor.tenantId,
                commandId,
                productionId,
                commandId,
                prior.result_version_ref as string,
              ],
            )
          ).length
        )
          throw new DomainError("conflict", "相同命令 ID 对应不同审阅结果。");
        const title = (
          await q.all<{ title: string }>(
            "SELECT title FROM script_productions WHERE tenant_id=? AND production_id=? AND deleted_at IS NULL",
            [actor.tenantId, productionId],
          )
        )[0]?.title;
        if (!title) throw new DomainError("not_found", "剧本原件不存在。");
        const activityRevision = safeInteger(
          prior.result_version_ref as number | string,
          "审阅活动修订",
        );
        return {
          tenantId: actor.tenantId,
          productionId,
          reviewId: commandId,
          reviewIds,
          activityRevision,
          versionRef: String(activityRevision),
          title,
          receiptId: commandId,
          eventId: commandId,
        };
      }
      await this.assertActiveInput(actor);
      if (
        (
          await q.all(
            "SELECT 1 AS present FROM script_outbox WHERE tenant_id=? AND production_id=? AND delivered_at IS NULL",
            [actor.tenantId, productionId],
          )
        ).length
      )
        throw new DomainError(
          "conflict",
          "上一次剧本目录更新尚未完成，请先恢复投影。",
        );
      const preparation = await this.preparationForInput(
        q,
        actor.tenantId,
        productionId,
        inputId,
      );
      if (
        !preparation ||
        !["continuity", "impact"].includes(preparation.generation.purpose)
      )
        throw new DomainError("forbidden", "本次输入没有固定审阅范围。");
      this.assertWorkflowReport(preparation.generation, workflowReport);
      const preparationOwner = (
        await q.all<{ requested_project_id: string }>(
          "SELECT requested_project_id FROM script_preparations WHERE tenant_id=? AND preparation_id=?",
          [actor.tenantId, preparation.preparationId],
        )
      )[0];
      if (preparationOwner?.requested_project_id !== actor.projectId)
        throw new DomainError("forbidden", "本次审阅所属项目已变化。");
      if (
        JSON.stringify(reviews).length >
        preparation.generation.maxOutputCharacters
      )
        throw new DomainError("invalid", "审阅结果超过本次输出上限。");
      const pinned = [
        {
          itemId: preparation.generation.targetId,
          revision: preparation.generation.baseRevision,
        },
        ...preparation.generation.references,
      ];
      const production = await this.productionSnapshot(
        q,
        actor.tenantId,
        productionId,
        actor.projectId,
        true,
      );
      if (
        !production.brief.modelProcessingAllowed ||
        production.reviews.filter((review) => review.inputId === inputId)
          .length +
          reviews.length >
          100
      )
        throw new DomainError(
          "forbidden",
          "模型处理许可已撤销或本次审阅已达上限。",
        );
      for (const review of reviews) {
        if (
          !pinned.some(
            (ref) =>
              ref.itemId === review.itemId &&
              ref.revision === review.itemRevision,
          )
        )
          throw new DomainError("forbidden", "意见不属于本次输入固定的版本。");
        const item = production.items.find(
          (entry) => entry.id === review.itemId,
        );
        const version = item?.versions.find(
          (entry) => entry.revision === review.itemRevision,
        );
        if (
          !version ||
          (review.quote && !version.draft.text.includes(review.quote))
        )
          throw new DomainError("invalid", "意见必须锚定有效正文版本及原文。");
      }
      const current = await authorize();
      if (
        !current ||
        current.tenantId !== actor.tenantId ||
        current.principalId !== actor.principalId ||
        current.actantId !== actor.actantId ||
        current.projectId !== actor.projectId ||
        current.kind !== actor.kind ||
        current.runtimeInputId !== inputId
      )
        throw new DomainError("forbidden", "剧本权限在审阅期间已变化。");
      await this.assertActiveInput(actor);
      const stale =
        !scriptContextCurrent(
          production,
          preparation.generation.contextRevision,
        ) ||
        pinned.some(
          (ref) =>
            production.items.find((entry) => entry.id === ref.itemId)
              ?.revision !== ref.revision,
        );
      const now = new Date().toISOString();
      const invalidated = new Set<string>();
      for (const [index, review] of reviews.entries()) {
        const historicalOnly =
          stale ||
          production.items.find((entry) => entry.id === review.itemId)!
            .revision !== review.itemRevision;
        await insert(q, "script_reviews", {
          tenant_id: actor.tenantId,
          review_id: reviewIds[index]!,
          collection_ordinal: production.reviews.length + index,
          item_id: review.itemId,
          item_revision: review.itemRevision,
          context_revision: preparation.generation.contextRevision,
          historical_only: historicalOnly ? 1 : 0,
          review_revision: 1,
          severity: review.severity,
          quote_text: review.quote,
          body_text: review.body,
          author_principal_id: actor.principalId,
          author_actant_id: actor.actantId,
          input_id: inputId,
          command_id: commandId,
          created_at: now,
          resolved_at: null,
          resolved_by_principal_id: null,
          resolved_by_actant_id: null,
          resolution: "",
        });
        if (review.severity === "blocking" && !historicalOnly)
          for (const affectedId of [
            review.itemId,
            ...scriptImpact(production, [review.itemId]),
          ])
            invalidated.add(affectedId);
      }
      for (const affectedId of invalidated) {
        const affected = production.items.find(
          (entry) => entry.id === affectedId,
        )!;
        await q.change(
          "UPDATE script_items SET status=CASE WHEN status='locked' THEN status ELSE 'draft' END,workflow_revision=workflow_revision+1,updated_at=? WHERE tenant_id=? AND production_id=? AND item_id=?",
          [now, actor.tenantId, productionId, affectedId],
        );
        await q.change(
          "DELETE FROM script_item_approvals WHERE tenant_id=? AND item_id=?",
          [actor.tenantId, affectedId],
        );
        const event = (
          await q.all<{ ordinal: number | string }>(
            "SELECT COALESCE(MAX(ordinal)+1,0) AS ordinal FROM script_item_events WHERE tenant_id=? AND item_id=?",
            [actor.tenantId, affectedId],
          )
        )[0]!;
        await insert(q, "script_item_events", {
          tenant_id: actor.tenantId,
          item_id: affectedId,
          ordinal: safeInteger(event.ordinal, "审阅事件序号"),
          action: "invalidate",
          revision: affected.revision,
          note: "新增阻断审阅意见",
          author_principal_id: actor.principalId,
          author_actant_id: actor.actantId,
          created_at: now,
        });
      }
      const activityRevision = production.activityRevision! + 1;
      if (
        !Number.isSafeInteger(activityRevision) ||
        (await q.change(
          "UPDATE script_productions SET activity_revision=?,updated_at=? WHERE tenant_id=? AND production_id=? AND activity_revision=? AND deleted_at IS NULL",
          [
            activityRevision,
            now,
            actor.tenantId,
            productionId,
            activityRevision - 1,
          ],
        )) !== 1
      )
        throw new DomainError("conflict", "剧本活动修订发生并发冲突。");
      await insert(q, "script_command_receipts", {
        tenant_id: actor.tenantId,
        command_id: commandId,
        request_hash: requestHash,
        input_id: inputId,
        task_run_event_id: actor.runtimeTaskRunEventId ?? null,
        operation: "submit-reviews",
        result_object_id: commandId,
        result_version_ref: String(activityRevision),
        committed_at: now,
      });
      await this.insertWorkflowReport(
        q,
        actor,
        commandId,
        productionId,
        inputId,
        preparation.generation.purpose,
        workflowReport,
        now,
      );
      await insert(q, "script_outbox", {
        tenant_id: actor.tenantId,
        event_id: commandId,
        production_id: productionId,
        object_id: commandId,
        version_ref: String(activityRevision),
        requested_project_id: null,
        event_kind: "script.review-changed",
        created_at: now,
        delivered_at: null,
      });
      return {
        tenantId: actor.tenantId,
        productionId,
        reviewId: commandId,
        reviewIds,
        activityRevision,
        versionRef: String(activityRevision),
        title: production.title,
        receiptId: commandId,
        eventId: commandId,
      };
    });
  }

  /** A preparation pins one actual input, target and dependency closure in the
   * app domain. It is not an item edit and does not advance the catalog.
   */
  async prepareGeneration(request: {
    credential: string;
    commandId: string;
    productionId: string;
    inputId: string;
    generation: z.input<typeof scriptPreparationRequestSchema>;
  }): Promise<ScriptPreparationReceipt> {
    const { generation, ...scope } = request;
    return this.prepareGenerations({ ...scope, generations: [generation] });
  }

  /** Atomically freeze the entire requested delivery set. No later tool call
   * may append another target or change its task interpretation. */
  async prepareGenerations(request: {
    credential: string;
    commandId: string;
    productionId: string;
    inputId: string;
    generations: z.input<typeof scriptPreparationRequestSchema>[];
    task?: string;
  }): Promise<ScriptPreparationReceipt> {
    if (!this.authority) throw new Error("剧本工作室尚未接入受信对象权限。");
    const commandId = requireDomainId(request.commandId, "命令 ID");
    const productionId = requireDomainId(request.productionId, "剧本 ID");
    const inputId = requireDomainId(request.inputId, "输入 ID");
    const submitted = z
      .array(scriptPreparationRequestSchema)
      .min(1)
      .max(12)
      .parse(request.generations);
    const task = z
      .string()
      .max(12000)
      .parse(request.task ?? "");
    if (
      submitted.some((generation) => generation.productionId !== productionId)
    )
      throw new Error("生成请求与剧本原件不一致。");
    if (
      new Set(submitted.map((generation) => generation.targetId)).size !==
      submitted.length
    )
      throw new DomainError("invalid", "同一次准备不能包含重复目标。");
    if (
      submitted.some(
        (generation) =>
          generation.contextRevision !== submitted[0]!.contextRevision,
      )
    )
      throw new DomainError("invalid", "同一次准备必须使用同一创作要求版本。");
    const authorize = () =>
      this.authority!.authorizeObject({
        credential: request.credential,
        productionId,
        operation: "write",
      });
    const actor = await authorize();
    if (!actor || actor.objectKind !== "script")
      throw new Error("没有在此剧本准备生成的权限。");
    if (actor.kind === "agent" && actor.runtimeInputId !== inputId)
      throw new Error("Agent 只能准备当前持久输入的剧本请求。");
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          tenantId: actor.tenantId,
          principalId: actor.principalId,
          actantId: actor.actantId,
          kind: actor.kind,
          runtimeInputId: actor.runtimeInputId,
          projectId: actor.projectId,
          productionId,
          inputId,
          // Preserve existing single-target receipt hashes byte for byte.
          submitted: submitted.length === 1 && !task ? submitted[0] : submitted,
          ...(submitted.length === 1 && !task ? {} : { task }),
        }),
      )
      .digest("hex");
    return this.transaction(async (q) => {
      if (this.backend.kind === "postgres")
        await q.all(
          "SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0)) AS locked",
          [`script-preparation:${actor.tenantId}:${inputId}`],
        );
      const receipt = (
        await q.all<Row>(
          "SELECT request_hash,operation,result_object_id FROM script_command_receipts WHERE tenant_id=? AND command_id=?",
          [actor.tenantId, commandId],
        )
      )[0];
      if (receipt) {
        if (
          receipt.request_hash !== requestHash ||
          receipt.operation !== "prepare-generation" ||
          receipt.result_object_id !== inputId
        )
          throw new Error("相同命令 ID 对应不同剧本准备请求。");
        const committed = await this.preparationForInput(
          q,
          actor.tenantId,
          productionId,
          inputId,
        );
        if (!committed || committed.preparationId !== inputId)
          throw new Error("剧本准备回执与原件不一致。");
        return { ...committed, receiptId: commandId };
      }
      const existing = await q.all<Row>(
        "SELECT production_id FROM script_preparations WHERE tenant_id=? AND input_id=?",
        [actor.tenantId, inputId],
      );
      if (existing.length) {
        // The input is the immutable generation identity. A later tool call
        // can recover the same preparation, but cannot change its intent or
        // impersonate another author; both are included in the request hash.
        const originalReceipt = (
          await q.all<Row>(
            "SELECT command_id FROM script_command_receipts WHERE tenant_id=? AND input_id=? AND operation='prepare-generation' AND request_hash=?",
            [actor.tenantId, inputId, requestHash],
          )
        )[0];
        const committed =
          existing[0]!.production_id === productionId
            ? await this.preparationForInput(
                q,
                actor.tenantId,
                productionId,
                inputId,
              )
            : null;
        if (!originalReceipt || !committed)
          throw new Error("这条输入已经绑定另一份剧本生成范围。");
        return { ...committed, receiptId: String(originalReceipt.command_id) };
      }
      await this.assertActiveInput(actor);
      const production = await this.productionSnapshot(
        q,
        actor.tenantId,
        productionId,
        actor.projectId,
      );
      if (!production.brief.modelProcessingAllowed)
        throw new Error("剧本资料尚未获准交给当前模型处理。");
      const generations = submitted.map((generation) =>
        prepareScriptGeneration(production, generation),
      );
      const current = await authorize();
      if (
        !current ||
        current.tenantId !== actor.tenantId ||
        current.principalId !== actor.principalId ||
        current.actantId !== actor.actantId ||
        current.kind !== actor.kind ||
        current.projectId !== actor.projectId ||
        current.runtimeInputId !== actor.runtimeInputId
      )
        throw new Error("剧本权限在准备期间已变化。");
      await this.assertActiveInput(actor);
      const ordinalRow = (
        await q.all<{ next_ordinal: number | string }>(
          "SELECT COALESCE(MAX(collection_ordinal)+1,0) AS next_ordinal FROM script_preparations WHERE tenant_id=? AND production_id=?",
          [actor.tenantId, productionId],
        )
      )[0]!;
      const now = new Date().toISOString();
      for (const [index, generation] of generations.entries()) {
        const preparationId =
          index === 0
            ? inputId
            : `prepare_${createHash("sha256").update(`${inputId}\0${generation.targetId}`).digest("hex").slice(0, 40)}`;
        await insert(q, "script_preparations", {
          tenant_id: actor.tenantId,
          preparation_id: preparationId,
          collection_ordinal:
            safeInteger(ordinalRow.next_ordinal, "准备顺序号") + index,
          production_id: productionId,
          input_id: inputId,
          task_request: index === 0 ? task : "",
          requested_project_id: actor.projectId,
          target_item_id: generation.targetId,
          base_item_revision: generation.baseRevision,
          context_revision: generation.contextRevision,
          purpose: generation.purpose,
          max_candidates: generation.maxCandidates,
          max_output_characters: generation.maxOutputCharacters,
          max_review_passes: generation.maxReviewPasses,
          created_by_principal_id: actor.principalId,
          created_by_actant_id: actor.actantId,
          created_at: now,
        });
        for (const [ordinal, ref] of generation.references.entries())
          await insert(q, "script_preparation_references", {
            tenant_id: actor.tenantId,
            preparation_id: preparationId,
            ordinal,
            item_id: ref.itemId,
            revision: ref.revision,
          });
      }
      await insert(q, "script_command_receipts", {
        tenant_id: actor.tenantId,
        command_id: commandId,
        request_hash: requestHash,
        input_id: inputId,
        task_run_event_id: actor.runtimeTaskRunEventId ?? null,
        operation: "prepare-generation",
        result_object_id: inputId,
        result_version_ref: "1",
        committed_at: now,
      });
      return {
        preparationId: inputId,
        inputId,
        generation: generations[0]!,
        generations,
        task,
        receiptId: commandId,
      };
    });
  }

  /** Generated text is an immutable proposal, never a direct item edit. The
   * persisted Runtime input and this app's preparation jointly bound it.
   */
  async submitCandidate(request: {
    credential: string;
    commandId: string;
    productionId: string;
    inputId: string;
    targetId?: string;
    draft: LiveScriptDraft;
    explanation: string;
    workflowReport?: ScriptWorkflowReport;
  }): Promise<ScriptCandidateSubmissionReceipt> {
    if (!this.authority) throw new Error("剧本工作室尚未接入受信对象权限。");
    const commandId = requireDomainId(request.commandId, "命令 ID");
    const productionId = requireDomainId(request.productionId, "剧本 ID");
    const inputId = requireDomainId(request.inputId, "输入 ID");
    const targetId =
      request.targetId === undefined
        ? undefined
        : requireDomainId(request.targetId, "目标 ID");
    const draft = liveScriptDraftSchema.parse(request.draft);
    const workflowReport =
      request.workflowReport === undefined
        ? undefined
        : scriptWorkflowReportSchema.parse(request.workflowReport);
    if (workflowReport && workflowReport.explanation !== request.explanation)
      throw new DomainError("invalid", "检查报告与候选说明不一致。");
    if (request.explanation.length > 10_000) throw new Error("候选说明过长。");
    const authorize = () =>
      this.authority!.authorizeObject({
        credential: request.credential,
        productionId,
        operation: "write",
      });
    const actor = await authorize();
    if (
      !actor ||
      actor.kind !== "agent" ||
      actor.objectKind !== "script" ||
      actor.runtimeInputId !== inputId
    )
      throw new Error("候选必须由本次持久输入授权的 Agent 提交。");
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          tenantId: actor.tenantId,
          principalId: actor.principalId,
          actantId: actor.actantId,
          inputId,
          projectId: actor.projectId,
          productionId,
          ...(targetId === undefined ? {} : { targetId }),
          draft,
          explanation: request.explanation,
          workflowReport,
        }),
      )
      .digest("hex");
    return this.transaction(async (q) => {
      if (this.backend.kind === "postgres")
        await q.all(
          "SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0)) AS locked",
          [`script:${actor.tenantId}:${productionId}`],
        );
      let prior = (
        await q.all<Row>(
          "SELECT command_id,request_hash,operation,result_object_id,result_version_ref FROM script_command_receipts WHERE tenant_id=? AND command_id=?",
          [actor.tenantId, commandId],
        )
      )[0];
      if (!prior)
        prior = (
          await q.all<Row>(
            "SELECT command_id,request_hash,operation,result_object_id,result_version_ref FROM script_command_receipts WHERE tenant_id=? AND input_id=? AND operation='submit-candidate' AND request_hash=? ORDER BY committed_at,command_id LIMIT 1",
            [actor.tenantId, inputId, requestHash],
          )
        )[0];
      if (prior) {
        const receiptId = String(prior.command_id);
        if (
          prior.request_hash !== requestHash ||
          prior.operation !== "submit-candidate" ||
          prior.result_object_id !== receiptId
        )
          throw new Error("相同命令 ID 对应不同候选请求。");
        const row = (
          await q.all<Row>(
            "SELECT p.title,c.input_id,c.target_item_id FROM script_candidates c JOIN script_productions p ON p.tenant_id=c.tenant_id AND p.production_id=c.production_id JOIN script_outbox o ON o.tenant_id=c.tenant_id AND o.production_id=p.production_id AND o.event_id=? AND o.event_kind='script.candidate-submitted' WHERE c.tenant_id=? AND c.production_id=? AND c.candidate_id=? AND p.deleted_at IS NULL",
            [receiptId, actor.tenantId, productionId, receiptId],
          )
        )[0];
        if (
          !row ||
          row.input_id !== inputId ||
          (targetId !== undefined && row.target_item_id !== targetId)
        )
          throw new Error("候选回执与原件不一致。");
        const activityRevision = safeInteger(
          prior.result_version_ref as number | string,
          "剧本活动修订",
        );
        return {
          tenantId: actor.tenantId,
          productionId,
          candidateId: receiptId,
          inputId,
          activityRevision,
          versionRef: String(activityRevision),
          title: String(row.title),
          receiptId,
          eventId: receiptId,
        };
      }
      if (
        (
          await q.all(
            "SELECT 1 AS present FROM script_outbox WHERE tenant_id=? AND production_id=? AND delivered_at IS NULL",
            [actor.tenantId, productionId],
          )
        ).length
      )
        throw new Error("上一次剧本目录更新尚未完成，请先恢复投影。");
      await this.assertActiveInput(actor);
      const preparation = await this.preparationForInput(
        q,
        actor.tenantId,
        productionId,
        inputId,
      );
      if (!preparation) throw new Error("本次输入没有固定的创作候选范围。");
      if (preparation.generations.length > 1 && targetId === undefined)
        throw new DomainError(
          "invalid",
          "多目标候选必须明确指定本次固定的目标 ID。",
        );
      const generation =
        targetId === undefined
          ? preparation.generation
          : preparation.generations.find(
              (entry) => entry.targetId === targetId,
            );
      if (!generation || !["draft", "rewrite"].includes(generation.purpose))
        throw new DomainError("forbidden", "目标不属于本次固定候选范围。");
      this.assertWorkflowReport(generation, workflowReport);
      const preparationRow = (
        await q.all<Row>(
          "SELECT requested_project_id FROM script_preparations WHERE tenant_id=? AND preparation_id=?",
          [actor.tenantId, preparation.preparationId],
        )
      )[0];
      if (preparationRow?.requested_project_id !== actor.projectId)
        throw new Error("本次生成所属项目已变化。");
      const productionRow = (
        await q.all<Row>(
          `SELECT title,activity_revision,creative_epoch FROM script_productions WHERE tenant_id=? AND production_id=? AND deleted_at IS NULL${this.backend.kind === "postgres" ? " FOR UPDATE" : ""}`,
          [actor.tenantId, productionId],
        )
      )[0];
      if (!productionRow) throw new Error("剧本原件不存在。");
      const production = await this.productionSnapshot(
        q,
        actor.tenantId,
        productionId,
        actor.projectId,
      );
      if (
        !production.brief.modelProcessingAllowed ||
        !scriptContextCurrent(production, generation.contextRevision)
      )
        throw new Error("剧本创作要求或模型许可已变化，请重新准备。");
      const refreshed = prepareScriptGeneration(production, generation);
      if (JSON.stringify(refreshed) !== JSON.stringify(generation))
        throw new Error("固定资料已变化，请重新准备。");
      const target = production.items.find(
        (item) => item.id === generation.targetId,
      )!;
      if (target.status === "locked") throw new Error("目标条目已经锁稿。");
      if (JSON.stringify(draft).length > generation.maxOutputCharacters)
        throw new Error("候选内容超过本次输出上限。");
      const count = (
        await q.all<{ total: number | string }>(
          "SELECT COUNT(*) AS total FROM script_candidates WHERE tenant_id=? AND production_id=? AND input_id=? AND target_item_id=?",
          [actor.tenantId, productionId, inputId, generation.targetId],
        )
      )[0]!;
      if (safeInteger(count.total, "本次候选数量") >= generation.maxCandidates)
        throw new Error("本次候选数量已达上限。");
      const order = (
        await q.all<{ next_ordinal: number | string }>(
          "SELECT COALESCE(MAX(collection_ordinal)+1,0) AS next_ordinal FROM script_candidates WHERE tenant_id=? AND production_id=?",
          [actor.tenantId, productionId],
        )
      )[0]!;
      if ((target.kind === "scene") !== (draft.parentId !== null))
        throw new Error("分场必须绑定所属集，其他条目不能绑定所属集。");
      if (
        draft.parentId &&
        production.items.find((item) => item.id === draft.parentId)?.kind !==
          "episode"
      )
        throw new Error("分场所属集无效。");
      const allowed = new Map(
        generation.references.map((ref) => [ref.itemId, ref.revision]),
      );
      const dependencyIds = new Set<string>();
      for (const ref of draft.dependencies) {
        if (
          dependencyIds.has(ref.itemId) ||
          allowed.get(ref.itemId) !== ref.revision
        )
          throw new Error("候选依赖超出本次固定资料或重复。");
        dependencyIds.add(ref.itemId);
      }
      for (const id of [draft.parentId, ...draft.characters].filter(
        (id): id is string => !!id,
      )) {
        if (!dependencyIds.has(id))
          throw new Error("角色和所属集必须绑定对应依赖版本。");
      }
      if (
        new Set(draft.characters).size !== draft.characters.length ||
        draft.characters.some(
          (id) =>
            production.items.find((item) => item.id === id)?.kind !==
            "character",
        )
      )
        throw new Error("候选角色引用无效。");
      const visits = new Set<string>();
      const visit = (itemId: string) => {
        if (itemId === target.id) throw new Error("候选依赖不能形成循环。");
        if (visits.has(itemId)) return;
        visits.add(itemId);
        const item = production.items.find((entry) => entry.id === itemId)!;
        const current = item.versions.find(
          (version) => version.revision === item.revision,
        )!;
        for (const ref of current.draft.dependencies) visit(ref.itemId);
      };
      for (const id of dependencyIds) visit(id);
      const pinned = [
        { itemId: generation.targetId, revision: generation.baseRevision },
        ...generation.references,
      ];
      const sourceRows: Row[] = [];
      for (const ref of pinned)
        sourceRows.push(
          ...(await q.all<Row>(
            "SELECT s.source_app_id,s.source_instance_id,s.source_object_id,s.source_version_ref,s.quote_text FROM script_item_versions v JOIN script_draft_sources s ON s.tenant_id=v.tenant_id AND s.draft_id=v.draft_id WHERE v.tenant_id=? AND v.item_id=? AND v.revision=?",
            [actor.tenantId, ref.itemId, ref.revision],
          )),
        );
      for (const source of draft.sources) {
        if (
          !sourceRows.some(
            (row) =>
              row.source_app_id === source.appId &&
              row.source_instance_id === source.instanceId &&
              row.source_object_id === source.objectId &&
              row.source_version_ref === source.versionRef &&
              String(row.quote_text).includes(source.quote),
          )
        )
          throw new Error("候选原作引用超出本次固定资料。");
      }
      // A generated draft may legitimately omit or shorten a citation. That
      // cannot erase its prior access to any of this input's frozen material,
      // including the other targets used by a shared multi-target inference.
      const preparedSources = await this.preparedInputSources(
        q,
        actor.tenantId,
        productionId,
        inputId,
      );
      const sourceChecks = [
        ...new Map(
          [...preparedSources, ...draft.sources].map((source) => [
            JSON.stringify(source),
            source,
          ]),
        ).values(),
      ];
      const checks = sourceChecks.map((source) => ({
        credential: request.credential,
        tenantId: actor.tenantId,
        principalId: actor.principalId,
        actantId: actor.actantId,
        kind: actor.kind,
        runtimeInputId: actor.runtimeInputId,
        runtimeTaskRunEventId: actor.runtimeTaskRunEventId ?? null,
        productionProjectId: actor.projectId,
        alreadyPinned: true,
        ...source,
      }));
      for (const check of checks)
        if (
          !this.authority!.verifySourceVersion ||
          !(await this.authority!.verifySourceVersion(check))
        )
          throw new Error("候选引用的原件已不可读或引文已变化。");
      const current = await authorize();
      if (
        !current ||
        current.tenantId !== actor.tenantId ||
        current.principalId !== actor.principalId ||
        current.actantId !== actor.actantId ||
        current.kind !== actor.kind ||
        current.projectId !== actor.projectId ||
        current.runtimeInputId !== actor.runtimeInputId
      )
        throw new Error("剧本权限在候选提交期间已变化。");
      for (const check of checks)
        if (!(await this.authority!.verifySourceVersion?.(check)))
          throw new Error("候选引用的原件权限在提交期间已变化。");
      await this.assertActiveInput(actor);
      const now = new Date().toISOString();
      const activityRevision =
        safeInteger(
          productionRow.activity_revision as number | string,
          "剧本活动修订",
        ) + 1;
      if (!Number.isSafeInteger(activityRevision))
        throw new Error("剧本活动修订溢出。");
      const draftId = draftIdentity(productionId, `candidate:${commandId}`);
      await this.insertResolvedDraft(
        q,
        actor.tenantId,
        productionId,
        draftId,
        draft,
        now,
      );
      await insert(q, "script_candidates", {
        tenant_id: actor.tenantId,
        candidate_id: commandId,
        production_id: productionId,
        collection_ordinal: safeInteger(order.next_ordinal, "候选顺序号"),
        target_item_id: generation.targetId,
        draft_id: draftId,
        input_id: inputId,
        base_item_revision: generation.baseRevision,
        context_revision: generation.contextRevision,
        base_creative_epoch: safeInteger(
          productionRow.creative_epoch as number | string,
          "创作阶段",
        ),
        candidate_revision: 1,
        status: "pending",
        explanation: request.explanation,
        created_by_principal_id: actor.principalId,
        created_by_actant_id: actor.actantId,
        created_at: now,
        decided_at: null,
        decided_by_principal_id: null,
        decided_by_actant_id: null,
      });
      for (const [ordinal, ref] of generation.references.entries())
        await insert(q, "script_candidate_references", {
          tenant_id: actor.tenantId,
          candidate_id: commandId,
          ordinal,
          item_id: ref.itemId,
          revision: ref.revision,
        });
      if (
        (await q.change(
          "UPDATE script_productions SET activity_revision=?,updated_at=? WHERE tenant_id=? AND production_id=? AND activity_revision=? AND deleted_at IS NULL",
          [
            activityRevision,
            now,
            actor.tenantId,
            productionId,
            activityRevision - 1,
          ],
        )) !== 1
      )
        throw new Error("剧本活动修订发生并发冲突。");
      await insert(q, "script_command_receipts", {
        tenant_id: actor.tenantId,
        command_id: commandId,
        request_hash: requestHash,
        input_id: inputId,
        task_run_event_id: actor.runtimeTaskRunEventId ?? null,
        operation: "submit-candidate",
        result_object_id: commandId,
        result_version_ref: String(activityRevision),
        committed_at: now,
      });
      await this.insertWorkflowReport(
        q,
        actor,
        commandId,
        productionId,
        inputId,
        generation.purpose,
        workflowReport,
        now,
      );
      await insert(q, "script_outbox", {
        tenant_id: actor.tenantId,
        event_id: commandId,
        production_id: productionId,
        object_id: productionId,
        version_ref: String(activityRevision),
        requested_project_id: null,
        event_kind: "script.candidate-submitted",
        created_at: now,
        delivered_at: null,
      });
      return {
        tenantId: actor.tenantId,
        productionId,
        candidateId: commandId,
        inputId,
        activityRevision,
        versionRef: String(activityRevision),
        title: String(productionRow.title),
        receiptId: commandId,
        eventId: commandId,
      };
    });
  }

  /** Live domain command. The creation receipt survives a failed Platform
   * directory projection, so the same command can be retried without making
   * another production or asking the model to generate one again.
   */
  async createProduction(request: {
    credential: string;
    commandId: string;
    productionId: string;
    requestedProjectId: string;
    title: string;
  }): Promise<ScriptProductionReceipt> {
    if (!this.authority) throw new Error("剧本工作室尚未接入受信创建权限。");
    const commandId = requireDomainId(request.commandId, "命令 ID");
    const productionId = requireDomainId(request.productionId, "剧本 ID");
    const requestedProjectId = requireDomainId(
      request.requestedProjectId,
      "项目 ID",
    );
    const title = request.title.trim();
    if (!title || title.length > 180) throw new Error("剧本标题无效。");
    const actor = await this.authority.authorizeCreate({
      credential: request.credential,
      projectId: requestedProjectId,
    });
    if (!actor) throw new Error("没有在该项目创建剧本的权限。");
    requireDomainId(actor.tenantId, "租户 ID");
    requireDomainId(actor.principalId, "发起者 ID");
    requireDomainId(actor.actantId, "执行者 ID");
    if (
      actor.kind === "agent" &&
      !actor.runtimeInputId &&
      !actor.runtimeTaskRunEventId
    )
      throw new Error("Agent 创建剧本缺少已持久化的发起来源。");
    if (actor.runtimeInputId)
      requireDomainId(actor.runtimeInputId, "发起输入 ID");
    if (actor.runtimeTaskRunEventId)
      requireDomainId(actor.runtimeTaskRunEventId, "事项执行 ID");
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          tenantId: actor.tenantId,
          principalId: actor.principalId,
          actantId: actor.actantId,
          actorKind: actor.kind,
          runtimeInputId: actor.runtimeInputId,
          ...(actor.runtimeTaskRunEventId
            ? { runtimeTaskRunEventId: actor.runtimeTaskRunEventId }
            : {}),
          productionId,
          requestedProjectId,
          title,
        }),
      )
      .digest("hex");
    return this.transaction(async (q) => {
      if (this.backend.kind === "postgres")
        await q.all(
          "SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0)) AS locked",
          [`script:${actor.tenantId}:${commandId}`],
        );
      const previous = await q.all<{
        request_hash: string;
        operation: string;
        result_object_id: string;
        result_version_ref: string;
      }>(
        "SELECT request_hash,operation,result_object_id,result_version_ref FROM script_command_receipts WHERE tenant_id=? AND command_id=?",
        [actor.tenantId, commandId],
      );
      if (previous.length) {
        if (
          previous[0]!.request_hash !== requestHash ||
          previous[0]!.operation !== "create-production" ||
          previous[0]!.result_object_id !== productionId ||
          previous[0]!.result_version_ref !== "1"
        )
          throw new Error("相同命令 ID 对应不同剧本创建请求。");
        return {
          tenantId: actor.tenantId,
          productionId,
          title,
          requestedProjectId,
          versionRef: "1" as const,
          receiptId: commandId,
          eventId: commandId,
        };
      }
      // Saved receipts remain recoverable; cancellation only blocks new writes.
      await this.assertActiveInput(actor);
      if (
        (
          await q.all(
            "SELECT 1 AS present FROM script_productions WHERE tenant_id=? AND production_id=?",
            [actor.tenantId, productionId],
          )
        ).length
      )
        throw new Error("剧本 ID 已存在；不能创建第二份原件。");
      const now = new Date().toISOString();
      const brief = briefColumns(emptyScriptBrief);
      const template = templateColumns(defaultScriptExportTemplate);
      await insert(q, "script_productions", {
        tenant_id: actor.tenantId,
        production_id: productionId,
        owner_principal_id: actor.principalId,
        title,
        ...brief,
        ...template,
        metadata_revision: 1,
        activity_revision: 1,
        creative_epoch: 1,
        created_by_principal_id: actor.principalId,
        created_by_actant_id: actor.actantId,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      });
      await insert(q, "script_reviewers", {
        tenant_id: actor.tenantId,
        production_id: productionId,
        ordinal: 0,
        principal_id: actor.principalId,
      });
      await insert(q, "script_metadata_versions", {
        tenant_id: actor.tenantId,
        production_id: productionId,
        revision: 1,
        collection_ordinal: 0,
        title,
        ...brief,
        ...template,
        author_principal_id: actor.principalId,
        author_actant_id: actor.actantId,
        created_at: now,
      });
      await insert(q, "script_metadata_reviewers", {
        tenant_id: actor.tenantId,
        production_id: productionId,
        revision: 1,
        ordinal: 0,
        principal_id: actor.principalId,
      });
      await insert(q, "script_command_receipts", {
        tenant_id: actor.tenantId,
        command_id: commandId,
        request_hash: requestHash,
        input_id: actor.runtimeInputId,
        task_run_event_id: actor.runtimeTaskRunEventId ?? null,
        operation: "create-production",
        result_object_id: productionId,
        result_version_ref: "1",
        committed_at: now,
      });
      await insert(q, "script_outbox", {
        tenant_id: actor.tenantId,
        event_id: commandId,
        production_id: productionId,
        object_id: productionId,
        version_ref: "1",
        requested_project_id: requestedProjectId,
        event_kind: "script.created",
        created_at: now,
        delivered_at: null,
      });
      return {
        tenantId: actor.tenantId,
        productionId,
        title,
        requestedProjectId,
        versionRef: "1" as const,
        receiptId: commandId,
        eventId: commandId,
      };
    });
  }

  /** Settings are an app-owned versioned edit. A creative-context change
   * invalidates existing approval evidence, but never rewrites any draft. */
  async updateProduction(request: {
    credential: string;
    commandId: string;
    productionId: string;
    expectedRevision: number;
    title: string;
    brief: ScriptProduction["brief"];
    reviewerPrincipalIds: string[];
    template: ScriptProduction["template"];
  }): Promise<ScriptProductionUpdateReceipt> {
    if (!this.authority?.verifyReviewers)
      throw new Error("剧本工作室尚未接入审阅人权限校验。");
    const commandId = requireDomainId(request.commandId, "命令 ID");
    const productionId = requireDomainId(request.productionId, "剧本 ID");
    if (
      !Number.isSafeInteger(request.expectedRevision) ||
      request.expectedRevision < 1
    )
      throw new Error("剧本元数据修订无效。");
    const title = request.title.trim();
    if (!title || title.length > 180) throw new Error("剧本标题无效。");
    const brief = scriptBriefSchema.parse(request.brief);
    const template = scriptExportTemplateSchema.parse(request.template);
    const reviewers = request.reviewerPrincipalIds.map((id) =>
      requireDomainId(id, "审阅人 ID"),
    );
    if (
      !reviewers.length ||
      reviewers.length > 50 ||
      new Set(reviewers).size !== reviewers.length
    )
      throw new Error("审阅人列表无效或重复。");
    const authorize = () =>
      this.authority!.authorizeObject({
        credential: request.credential,
        productionId,
        operation: "write",
      });
    const actor = await authorize();
    if (!actor || actor.objectKind !== "script" || actor.kind !== "human")
      throw new Error("只有本项目的人工成员可以修改剧本设置。");
    if (
      !(await this.authority.verifyReviewers({
        credential: request.credential,
        projectId: actor.projectId,
        principalIds: reviewers,
      }))
    )
      throw new Error("审阅人必须是本项目的人工成员。");
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          tenantId: actor.tenantId,
          principalId: actor.principalId,
          actantId: actor.actantId,
          projectId: actor.projectId,
          productionId,
          expectedRevision: request.expectedRevision,
          title,
          brief,
          reviewerPrincipalIds: reviewers,
          template,
        }),
      )
      .digest("hex");
    return this.transaction(async (q) => {
      if (this.backend.kind === "postgres")
        await q.all(
          "SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0)) AS locked",
          [`script:${actor.tenantId}:${productionId}`],
        );
      const previous = (
        await q.all<Row>(
          "SELECT request_hash,operation,result_object_id,result_version_ref FROM script_command_receipts WHERE tenant_id=? AND command_id=?",
          [actor.tenantId, commandId],
        )
      )[0];
      if (previous) {
        if (
          previous.request_hash !== requestHash ||
          !["update-production", "update-production-noop"].includes(
            String(previous.operation),
          ) ||
          previous.result_object_id !== productionId
        )
          throw new Error("相同命令 ID 对应不同剧本设置请求。");
        const changed = previous.operation === "update-production";
        const version = (
          await q.all<{ title: string }>(
            "SELECT title FROM script_metadata_versions WHERE tenant_id=? AND production_id=? AND revision=?",
            [
              actor.tenantId,
              productionId,
              request.expectedRevision + Number(changed),
            ],
          )
        )[0];
        if (
          !version ||
          (changed &&
            !(
              await q.all(
                "SELECT 1 AS present FROM script_outbox WHERE tenant_id=? AND event_id=? AND event_kind='script.updated'",
                [actor.tenantId, commandId],
              )
            ).length)
        )
          throw new Error("剧本设置回执与原件不一致。");
        const activityRevision = safeInteger(
          previous.result_version_ref as string,
          "剧本活动修订",
        );
        return {
          tenantId: actor.tenantId,
          productionId,
          metadataRevision: request.expectedRevision + Number(changed),
          activityRevision,
          versionRef: String(activityRevision),
          title: version.title,
          receiptId: commandId,
          eventId: changed ? commandId : null,
        };
      }
      if (
        (
          await q.all(
            "SELECT 1 AS present FROM script_outbox WHERE tenant_id=? AND production_id=? AND delivered_at IS NULL",
            [actor.tenantId, productionId],
          )
        ).length
      )
        throw new Error("上一次剧本目录更新尚未完成，请先恢复投影。");
      const row = (
        await q.all<Row>(
          `SELECT * FROM script_productions WHERE tenant_id=? AND production_id=? AND deleted_at IS NULL${this.backend.kind === "postgres" ? " FOR UPDATE" : ""}`,
          [actor.tenantId, productionId],
        )
      )[0];
      if (!row) throw new Error("剧本原件不存在。");
      const metadataRevision = safeInteger(
        row.metadata_revision as number | string,
        "元数据修订",
      );
      if (metadataRevision !== request.expectedRevision)
        throw new Error("剧本设置已更新，请刷新后重试。");
      const oldReviewers = (
        await q.all<{ principal_id: string }>(
          "SELECT principal_id FROM script_reviewers WHERE tenant_id=? AND production_id=? ORDER BY ordinal",
          [actor.tenantId, productionId],
        )
      ).map((value) => value.principal_id);
      const creativeChanged =
        scriptCreativeContext({
          brief: readBrief(row),
          reviewerPrincipalIds: oldReviewers,
        }) !==
        scriptCreativeContext({ brief, reviewerPrincipalIds: reviewers });
      const changed =
        creativeChanged ||
        title !== row.title ||
        JSON.stringify(template) !== JSON.stringify(readTemplate(row));
      const activityRevision =
        safeInteger(row.activity_revision as number | string, "剧本活动修订") +
        Number(changed);
      const nextMetadataRevision = metadataRevision + Number(changed);
      if (
        !Number.isSafeInteger(activityRevision) ||
        !Number.isSafeInteger(nextMetadataRevision)
      )
        throw new Error("剧本修订号溢出。");
      const current = await authorize();
      if (
        !current ||
        current.tenantId !== actor.tenantId ||
        current.principalId !== actor.principalId ||
        current.actantId !== actor.actantId ||
        current.projectId !== actor.projectId ||
        current.kind !== actor.kind ||
        !(await this.authority!.verifyReviewers!({
          credential: request.credential,
          projectId: actor.projectId,
          principalIds: reviewers,
        }))
      )
        throw new Error("剧本或审阅人权限在保存期间已变化。");
      const now = new Date().toISOString();
      if (changed) {
        const creativeEpoch =
          safeInteger(row.creative_epoch as number | string, "创作阶段") +
          Number(creativeChanged);
        if (!Number.isSafeInteger(creativeEpoch))
          throw new Error("创作阶段修订溢出。");
        const updated = await q.change(
          "UPDATE script_productions SET title=?,mode=?,audience=?,genre=?,episode_count=?,episode_seconds=?,style=?,constraints_text=?,rights_statement=?,model_processing_allowed=?,template_title=?,template_include_notes=?,template_include_continuity=?,template_page_break_episodes=?,template_font=?,template_font_size=?,template_scene_heading=?,metadata_revision=?,activity_revision=?,creative_epoch=?,updated_at=? WHERE tenant_id=? AND production_id=? AND metadata_revision=? AND activity_revision=? AND deleted_at IS NULL",
          [
            title,
            ...Object.values(briefColumns(brief)),
            ...Object.values(templateColumns(template)),
            nextMetadataRevision,
            activityRevision,
            creativeEpoch,
            now,
            actor.tenantId,
            productionId,
            metadataRevision,
            activityRevision - 1,
          ],
        );
        if (updated !== 1) throw new Error("剧本设置发生并发冲突。");
        await q.change(
          "DELETE FROM script_reviewers WHERE tenant_id=? AND production_id=?",
          [actor.tenantId, productionId],
        );
        for (const [ordinal, principalId] of reviewers.entries())
          await insert(q, "script_reviewers", {
            tenant_id: actor.tenantId,
            production_id: productionId,
            ordinal,
            principal_id: principalId,
          });
        await insert(q, "script_metadata_versions", {
          tenant_id: actor.tenantId,
          production_id: productionId,
          revision: nextMetadataRevision,
          collection_ordinal: nextMetadataRevision - 1,
          title,
          ...briefColumns(brief),
          ...templateColumns(template),
          author_principal_id: actor.principalId,
          author_actant_id: actor.actantId,
          created_at: now,
        });
        for (const [ordinal, principalId] of reviewers.entries())
          await insert(q, "script_metadata_reviewers", {
            tenant_id: actor.tenantId,
            production_id: productionId,
            revision: nextMetadataRevision,
            ordinal,
            principal_id: principalId,
          });
        if (creativeChanged) {
          const items = await q.all<{
            item_id: string;
            head_revision: number | string;
          }>(
            "SELECT item_id,head_revision FROM script_items WHERE tenant_id=? AND production_id=? ORDER BY collection_ordinal",
            [actor.tenantId, productionId],
          );
          for (const item of items) {
            const nextEvent = (
              await q.all<{ ordinal: number | string }>(
                "SELECT COALESCE(MAX(ordinal)+1,0) AS ordinal FROM script_item_events WHERE tenant_id=? AND item_id=?",
                [actor.tenantId, item.item_id],
              )
            )[0]!;
            await q.change(
              "UPDATE script_items SET workflow_revision=workflow_revision+1,status=CASE WHEN status='locked' THEN status ELSE 'draft' END,updated_at=? WHERE tenant_id=? AND production_id=? AND item_id=?",
              [now, actor.tenantId, productionId, item.item_id],
            );
            await q.change(
              "DELETE FROM script_item_approvals WHERE tenant_id=? AND item_id=?",
              [actor.tenantId, item.item_id],
            );
            await insert(q, "script_item_events", {
              tenant_id: actor.tenantId,
              item_id: item.item_id,
              ordinal: safeInteger(nextEvent.ordinal, "工作流事件序号"),
              action: "invalidate",
              revision: safeInteger(item.head_revision, "正文修订"),
              note: "创作要求或制作配置已更新",
              author_principal_id: actor.principalId,
              author_actant_id: actor.actantId,
              created_at: now,
            });
          }
        }
        await insert(q, "script_outbox", {
          tenant_id: actor.tenantId,
          event_id: commandId,
          production_id: productionId,
          object_id: productionId,
          version_ref: String(activityRevision),
          requested_project_id: null,
          event_kind: "script.updated",
          created_at: now,
          delivered_at: null,
        });
      }
      await insert(q, "script_command_receipts", {
        tenant_id: actor.tenantId,
        command_id: commandId,
        request_hash: requestHash,
        input_id: actor.runtimeInputId,
        task_run_event_id: actor.runtimeTaskRunEventId ?? null,
        operation: changed ? "update-production" : "update-production-noop",
        result_object_id: productionId,
        result_version_ref: String(activityRevision),
        committed_at: now,
      });
      return {
        tenantId: actor.tenantId,
        productionId,
        metadataRevision: nextMetadataRevision,
        activityRevision,
        versionRef: String(activityRevision),
        title,
        receiptId: commandId,
        eventId: changed ? commandId : null,
      };
    });
  }

  /** Title-only metadata version. The caller supplies the Platform-observed
   * activity revision; no creative settings or item workflow is rewritten. */
  async renameProduction(request: {
    credential: string;
    commandId: string;
    productionId: string;
    expectedActivityRevision: number;
    expectedCatalogRevision: number;
    currentCatalogRevision: number;
    title: string;
  }): Promise<ScriptProductionUpdateReceipt> {
    if (!this.authority) throw new Error("剧本工作室尚未接入受信权限。");
    const commandId = requireDomainId(request.commandId, "命令 ID");
    const productionId = requireDomainId(request.productionId, "剧本 ID");
    const title = request.title.trim();
    if (!title || title.length > 180) throw new Error("剧本标题无效。");
    if (
      ![
        request.expectedActivityRevision,
        request.expectedCatalogRevision,
      ].every((value) => Number.isSafeInteger(value) && value > 0)
    )
      throw new Error("剧本或目录修订无效。");
    const authorize = () =>
      this.authority!.authorizeObject({
        credential: request.credential,
        productionId,
        operation: "write",
      });
    const actor = await authorize();
    if (!actor || actor.objectKind !== "script")
      throw new Error("没有修改该剧本的权限。");
    if (
      actor.kind === "agent" &&
      !actor.runtimeInputId &&
      !actor.runtimeTaskRunEventId
    )
      throw new Error("Agent 修改剧本缺少已持久化的发起来源。");
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          tenantId: actor.tenantId,
          principalId: actor.principalId,
          actantId: actor.actantId,
          runtimeInputId: actor.runtimeInputId,
          runtimeTaskRunEventId: actor.runtimeTaskRunEventId ?? null,
          operation: "rename-production",
          productionId,
          expectedCatalogRevision: request.expectedCatalogRevision,
          title,
        }),
      )
      .digest("hex");
    return this.transaction(async (q) => {
      if (this.backend.kind === "postgres")
        await q.all(
          "SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0)) AS locked",
          [`script:${actor.tenantId}:${productionId}`],
        );
      const prior = (
        await q.all<Row>(
          "SELECT request_hash,operation,result_object_id,result_version_ref,committed_at FROM script_command_receipts WHERE tenant_id=? AND command_id=?",
          [actor.tenantId, commandId],
        )
      )[0];
      if (prior) {
        if (
          prior.request_hash !== requestHash ||
          prior.operation !== "rename-production" ||
          prior.result_object_id !== productionId
        )
          throw new Error("相同命令 ID 对应不同剧本改名请求。");
        const versions = await q.all<{
          revision: number | string;
          title: string;
        }>(
          "SELECT revision,title FROM script_metadata_versions WHERE tenant_id=? AND production_id=? AND title=? AND created_at=? AND author_principal_id=? AND author_actant_id=?",
          [
            actor.tenantId,
            productionId,
            title,
            prior.committed_at as SqlScalar,
            actor.principalId,
            actor.actantId,
          ],
        );
        if (
          versions.length !== 1 ||
          !(
            await q.all(
              "SELECT 1 AS present FROM script_outbox WHERE tenant_id=? AND event_id=? AND event_kind='script.updated' AND version_ref=?",
              [
                actor.tenantId,
                commandId,
                prior.result_version_ref as SqlScalar,
              ],
            )
          ).length
        )
          throw new Error("剧本改名回执与原件不一致。");
        const activityRevision = safeInteger(
          prior.result_version_ref as string,
          "剧本活动修订",
        );
        return {
          tenantId: actor.tenantId,
          productionId,
          metadataRevision: safeInteger(
            versions[0]!.revision,
            "剧本元数据修订",
          ),
          activityRevision,
          versionRef: String(activityRevision),
          title,
          receiptId: commandId,
          eventId: commandId,
        };
      }
      if (request.currentCatalogRevision !== request.expectedCatalogRevision)
        throw new Error("剧本目录已变化，请刷新后重试。");
      if (
        (
          await q.all(
            "SELECT 1 AS present FROM script_outbox WHERE tenant_id=? AND production_id=? AND delivered_at IS NULL",
            [actor.tenantId, productionId],
          )
        ).length
      )
        throw new Error("上一次剧本目录更新尚未完成，请先恢复投影。");
      const row = (
        await q.all<Row>(
          `SELECT * FROM script_productions WHERE tenant_id=? AND production_id=? AND deleted_at IS NULL${this.backend.kind === "postgres" ? " FOR UPDATE" : ""}`,
          [actor.tenantId, productionId],
        )
      )[0];
      if (
        !row ||
        safeInteger(
          row.activity_revision as number | string,
          "剧本活动修订",
        ) !== request.expectedActivityRevision
      )
        throw new Error("剧本版本已变化，请刷新后重试。");
      if (row.title === title) throw new Error("剧本标题未变化。");
      const current = await authorize();
      if (
        !current ||
        current.tenantId !== actor.tenantId ||
        current.principalId !== actor.principalId ||
        current.actantId !== actor.actantId ||
        current.projectId !== actor.projectId ||
        current.runtimeInputId !== actor.runtimeInputId ||
        (current.runtimeTaskRunEventId ?? null) !==
          (actor.runtimeTaskRunEventId ?? null)
      )
        throw new Error("剧本权限在保存期间已变化。");
      const metadataRevision =
        safeInteger(
          row.metadata_revision as number | string,
          "剧本元数据修订",
        ) + 1;
      const activityRevision = request.expectedActivityRevision + 1;
      if (
        !Number.isSafeInteger(metadataRevision) ||
        !Number.isSafeInteger(activityRevision)
      )
        throw new Error("剧本修订号溢出。");
      const now = new Date().toISOString();
      if (
        (await q.change(
          "UPDATE script_productions SET title=?,metadata_revision=?,activity_revision=?,updated_at=? WHERE tenant_id=? AND production_id=? AND metadata_revision=? AND activity_revision=? AND deleted_at IS NULL",
          [
            title,
            metadataRevision,
            activityRevision,
            now,
            actor.tenantId,
            productionId,
            metadataRevision - 1,
            request.expectedActivityRevision,
          ],
        )) !== 1
      )
        throw new Error("剧本设置发生并发冲突。");
      await insert(q, "script_metadata_versions", {
        tenant_id: actor.tenantId,
        production_id: productionId,
        revision: metadataRevision,
        collection_ordinal: metadataRevision - 1,
        title,
        ...briefColumns(readBrief(row)),
        ...templateColumns(readTemplate(row)),
        author_principal_id: actor.principalId,
        author_actant_id: actor.actantId,
        created_at: now,
      });
      const reviewers = await q.all<{ principal_id: string }>(
        "SELECT principal_id FROM script_reviewers WHERE tenant_id=? AND production_id=? ORDER BY ordinal",
        [actor.tenantId, productionId],
      );
      for (const [ordinal, reviewer] of reviewers.entries())
        await insert(q, "script_metadata_reviewers", {
          tenant_id: actor.tenantId,
          production_id: productionId,
          revision: metadataRevision,
          ordinal,
          principal_id: reviewer.principal_id,
        });
      await insert(q, "script_command_receipts", {
        tenant_id: actor.tenantId,
        command_id: commandId,
        request_hash: requestHash,
        input_id: actor.runtimeInputId,
        task_run_event_id: actor.runtimeTaskRunEventId ?? null,
        operation: "rename-production",
        result_object_id: productionId,
        result_version_ref: String(activityRevision),
        committed_at: now,
      });
      await insert(q, "script_outbox", {
        tenant_id: actor.tenantId,
        event_id: commandId,
        production_id: productionId,
        object_id: productionId,
        version_ref: String(activityRevision),
        requested_project_id: null,
        event_kind: "script.updated",
        created_at: now,
        delivered_at: null,
      });
      return {
        tenantId: actor.tenantId,
        productionId,
        metadataRevision,
        activityRevision,
        versionRef: String(activityRevision),
        title,
        receiptId: commandId,
        eventId: commandId,
      };
    });
  }

  /** Create one app-owned item and its first immutable draft. The Platform
   * directory only observes the production revision; it never owns this text.
   * Agent commands may scaffold an empty item, but cannot bypass the candidate
   * decision boundary to commit generated story text as a formal version.
   */
  async createItem(request: {
    credential: string;
    commandId: string;
    productionId: string;
    itemId: string;
    expectedActivityRevision: number;
    kind: ScriptProduction["items"][number]["kind"];
    draft: LiveScriptDraft;
  }): Promise<ScriptItemCreationReceipt> {
    if (!this.authority) throw new Error("剧本工作室尚未接入受信对象权限。");
    const commandId = requireDomainId(request.commandId, "命令 ID");
    const productionId = requireDomainId(request.productionId, "剧本 ID");
    const itemId = requireDomainId(request.itemId, "条目 ID");
    if (
      !Number.isSafeInteger(request.expectedActivityRevision) ||
      request.expectedActivityRevision < 1
    )
      throw new Error("剧本活动基准修订无效。");
    if (!scriptItemKinds.includes(request.kind))
      throw new Error("剧本条目类型无效。");
    const draft = liveScriptDraftSchema.parse(request.draft);
    if (draft.parentId === itemId) throw new Error("条目不能以自身为所属集。");
    if (
      draft.dependencies.some((dependency) => dependency.itemId === itemId) ||
      draft.characters.includes(itemId)
    )
      throw new Error("新条目不能依赖或引用自身。");
    const authorize = () =>
      this.authority!.authorizeObject({
        credential: request.credential,
        productionId,
        operation: "write",
      });
    const actor = await authorize();
    if (!actor || actor.objectKind !== "script")
      throw new Error("没有在此剧本创建条目的权限。");
    for (const [label, value] of [
      ["租户 ID", actor.tenantId],
      ["发起者 ID", actor.principalId],
      ["执行者 ID", actor.actantId],
      ["项目 ID", actor.projectId],
    ] as const)
      requireDomainId(value, label);
    if (
      actor.kind === "agent" &&
      !actor.runtimeInputId &&
      !actor.runtimeTaskRunEventId
    )
      throw new Error("Agent 创建剧本条目缺少已持久化的发起来源。");
    if (actor.runtimeInputId)
      requireDomainId(actor.runtimeInputId, "发起输入 ID");
    if (actor.runtimeTaskRunEventId)
      requireDomainId(actor.runtimeTaskRunEventId, "事项执行 ID");
    if (actor.kind === "agent") {
      const empty = emptyScriptDraft(draft.title, draft.order);
      if (request.kind === "scene" && draft.parentId) {
        if (
          draft.dependencies.length !== 1 ||
          draft.dependencies[0]!.itemId !== draft.parentId
        )
          throw new Error("Agent 创建空分场只能绑定所属集的当前版本。");
        empty.parentId = draft.parentId;
        empty.dependencies = draft.dependencies;
      }
      if (
        (Object.keys(empty) as (keyof ScriptDraft)[]).some(
          (key) => JSON.stringify(draft[key]) !== JSON.stringify(empty[key]),
        )
      )
        throw new Error("Agent 只能建立空条目；正文须经过候选与人工采纳。");
    }
    const actorIdentity = {
      tenantId: actor.tenantId,
      principalId: actor.principalId,
      actantId: actor.actantId,
      kind: actor.kind,
      runtimeInputId: actor.runtimeInputId,
      ...(actor.runtimeTaskRunEventId
        ? { runtimeTaskRunEventId: actor.runtimeTaskRunEventId }
        : {}),
    };
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          actor: actorIdentity,
          productionId,
          itemId,
          expectedActivityRevision: request.expectedActivityRevision,
          kind: request.kind,
          draft,
        }),
      )
      .digest("hex");
    const sourceChecks = draft.sources.map((source) => ({
      credential: request.credential,
      ...actorIdentity,
      productionProjectId: actor.projectId,
      alreadyPinned: false,
      ...source,
    }));
    return this.transaction(async (q) => {
      if (this.backend.kind === "postgres")
        await q.all(
          "SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0)) AS locked",
          [`script:${actor.tenantId}:${productionId}`],
        );
      const prior = await q.all<{
        request_hash: string;
        operation: string;
        result_object_id: string;
        result_version_ref: string;
      }>(
        "SELECT request_hash,operation,result_object_id,result_version_ref FROM script_command_receipts WHERE tenant_id=? AND command_id=?",
        [actor.tenantId, commandId],
      );
      if (prior.length) {
        if (
          prior[0]!.request_hash !== requestHash ||
          prior[0]!.operation !== "create-item" ||
          prior[0]!.result_object_id !== itemId
        )
          throw new Error("相同命令 ID 对应不同条目创建请求。");
        const committed = await q.all<{ title: string }>(
          "SELECT p.title FROM script_productions p JOIN script_items i ON i.tenant_id=p.tenant_id AND i.production_id=p.production_id JOIN script_outbox o ON o.tenant_id=i.tenant_id AND o.production_id=p.production_id AND o.object_id=i.item_id AND o.event_id=? AND o.event_kind='script.item-created' WHERE p.tenant_id=? AND p.production_id=? AND i.item_id=? AND p.deleted_at IS NULL",
          [commandId, actor.tenantId, productionId, itemId],
        );
        if (committed.length !== 1)
          throw new Error("条目回执与已提交原件不一致。");
        const activityRevision = safeInteger(
          prior[0]!.result_version_ref,
          "剧本活动修订",
        );
        return {
          tenantId: actor.tenantId,
          productionId,
          itemId,
          itemRevision: 1 as const,
          activityRevision,
          versionRef: String(activityRevision),
          title: committed[0]!.title,
          receiptId: commandId,
          eventId: commandId,
        };
      }
      await this.assertActiveInput(actor);
      for (const check of sourceChecks)
        if (
          !this.authority!.verifySourceVersion ||
          !(await this.authority!.verifySourceVersion(check))
        )
          throw new Error("原件版本和引文尚未由所属应用核验。");
      const pending = await q.all(
        "SELECT 1 AS present FROM script_outbox WHERE tenant_id=? AND production_id=? AND delivered_at IS NULL",
        [actor.tenantId, productionId],
      );
      if (pending.length)
        throw new Error("上一次剧本目录更新尚未完成，请先按原命令恢复投影。");
      const production = (
        await q.all<{ title: string; activity_revision: number | string }>(
          `SELECT title,activity_revision FROM script_productions WHERE tenant_id=? AND production_id=? AND deleted_at IS NULL${this.backend.kind === "postgres" ? " FOR UPDATE" : ""}`,
          [actor.tenantId, productionId],
        )
      )[0];
      if (!production) throw new Error("剧本原件不存在。");
      if (
        safeInteger(production.activity_revision, "剧本活动修订") !==
        request.expectedActivityRevision
      )
        throw new Error("剧本已变化，请重新读取目录再创建条目。");
      const count = (
        await q.all<{ total: number | string; next_ordinal: number | string }>(
          "SELECT COUNT(*) AS total,COALESCE(MAX(collection_ordinal)+1,0) AS next_ordinal FROM script_items WHERE tenant_id=? AND production_id=?",
          [actor.tenantId, productionId],
        )
      )[0]!;
      if (safeInteger(count.total, "剧本条目数") >= 5000)
        throw new Error("本剧条目已达上限。");
      const collectionOrdinal = safeInteger(count.next_ordinal, "条目顺序号");
      if (
        (
          await q.all(
            "SELECT 1 AS present FROM script_items WHERE tenant_id=? AND item_id=?",
            [actor.tenantId, itemId],
          )
        ).length
      )
        throw new Error("剧本条目 ID 已存在。");
      if ((request.kind === "scene") !== (draft.parentId !== null))
        throw new Error("只有分场必须且可以指定所属集。");
      if (draft.parentId) {
        const parent = (
          await q.all<{ kind: string; head_revision: number | string }>(
            "SELECT kind,head_revision FROM script_items WHERE tenant_id=? AND production_id=? AND item_id=?",
            [actor.tenantId, productionId, draft.parentId],
          )
        )[0];
        if (!parent || parent.kind !== "episode")
          throw new Error("分场必须属于本剧的一集。");
        if (
          actor.kind === "agent" &&
          safeInteger(parent.head_revision, "所属集修订") !==
            draft.dependencies[0]!.revision
        )
          throw new Error("Agent 创建空分场必须绑定所属集当前版本。");
      }
      const dependencyIds = new Set<string>();
      for (const dependency of draft.dependencies) {
        if (dependencyIds.has(dependency.itemId))
          throw new Error("剧本依赖不能重复。");
        dependencyIds.add(dependency.itemId);
        if (
          !(
            await q.all(
              "SELECT 1 AS present FROM script_items i JOIN script_item_versions v ON v.tenant_id=i.tenant_id AND v.item_id=i.item_id WHERE i.tenant_id=? AND i.production_id=? AND i.item_id=? AND v.revision=?",
              [
                actor.tenantId,
                productionId,
                dependency.itemId,
                dependency.revision,
              ],
            )
          ).length
        )
          throw new Error("剧本依赖必须指向本剧有效版本。");
      }
      if (draft.parentId && !dependencyIds.has(draft.parentId))
        throw new Error("所属集必须同时绑定依赖版本。");
      const characterIds = new Set<string>();
      for (const characterId of draft.characters) {
        if (characterIds.has(characterId))
          throw new Error("出场角色不能重复。");
        characterIds.add(characterId);
        const character = (
          await q.all<{ kind: string }>(
            "SELECT kind FROM script_items WHERE tenant_id=? AND production_id=? AND item_id=?",
            [actor.tenantId, productionId, characterId],
          )
        )[0];
        if (character?.kind !== "character" || !dependencyIds.has(characterId))
          throw new Error("出场角色必须引用本剧角色并绑定其版本。");
      }
      const currentActor = await authorize();
      if (
        !currentActor ||
        currentActor.projectId !== actor.projectId ||
        JSON.stringify({
          tenantId: currentActor.tenantId,
          principalId: currentActor.principalId,
          actantId: currentActor.actantId,
          kind: currentActor.kind,
          runtimeInputId: currentActor.runtimeInputId,
          ...(currentActor.runtimeTaskRunEventId
            ? { runtimeTaskRunEventId: currentActor.runtimeTaskRunEventId }
            : {}),
        }) !== JSON.stringify(actorIdentity)
      )
        throw new Error("剧本权限或所属项目在创建期间已变化。");
      for (const check of sourceChecks)
        if (!(await this.authority!.verifySourceVersion?.(check)))
          throw new Error("来源权限或引文在创建期间已变化。");
      const now = new Date().toISOString();
      const activityRevision =
        safeInteger(production.activity_revision, "剧本活动修订") + 1;
      if (!Number.isSafeInteger(activityRevision))
        throw new Error("剧本活动修订溢出。");
      const draftId = draftIdentity(productionId, `item:${itemId}:1`);
      await insert(q, "script_items", {
        tenant_id: actor.tenantId,
        item_id: itemId,
        production_id: productionId,
        collection_ordinal: collectionOrdinal,
        kind: request.kind,
        parent_item_id: draft.parentId,
        order_index: draft.order,
        head_revision: 1,
        workflow_revision: 1,
        status: "draft",
        created_at: now,
        updated_at: now,
      });
      await this.insertResolvedDraft(
        q,
        actor.tenantId,
        productionId,
        draftId,
        draft,
        now,
      );
      await insert(q, "script_item_versions", {
        tenant_id: actor.tenantId,
        item_id: itemId,
        revision: 1,
        collection_ordinal: 0,
        draft_id: draftId,
        candidate_id: null,
        author_principal_id: actor.principalId,
        author_actant_id: actor.actantId,
        created_at: now,
      });
      const updated = await q.change(
        "UPDATE script_productions SET activity_revision=?,updated_at=? WHERE tenant_id=? AND production_id=? AND activity_revision=? AND deleted_at IS NULL",
        [
          activityRevision,
          now,
          actor.tenantId,
          productionId,
          activityRevision - 1,
        ],
      );
      if (updated !== 1) throw new Error("剧本活动修订发生并发冲突。");
      await insert(q, "script_command_receipts", {
        tenant_id: actor.tenantId,
        command_id: commandId,
        request_hash: requestHash,
        input_id: actor.runtimeInputId,
        task_run_event_id: actor.runtimeTaskRunEventId ?? null,
        operation: "create-item",
        result_object_id: itemId,
        result_version_ref: String(activityRevision),
        committed_at: now,
      });
      await insert(q, "script_outbox", {
        tenant_id: actor.tenantId,
        event_id: commandId,
        production_id: productionId,
        object_id: itemId,
        version_ref: String(activityRevision),
        requested_project_id: null,
        event_kind: "script.item-created",
        created_at: now,
        delivered_at: null,
      });
      return {
        tenantId: actor.tenantId,
        productionId,
        itemId,
        itemRevision: 1 as const,
        activityRevision,
        versionRef: String(activityRevision),
        title: production.title,
        receiptId: commandId,
        eventId: commandId,
      };
    });
  }

  /** Human editing commits one immutable version and invalidates approvals of
   * affected descendants in the same app transaction. The outbox is the only
   * source from which Platform may advance its observed production revision.
   */
  async reviseItem(request: {
    credential: string;
    commandId: string;
    productionId: string;
    itemId: string;
    expectedRevision: number;
    draft: LiveScriptDraft;
    restoreRevision?: number;
  }): Promise<ScriptItemRevisionReceipt> {
    if (!this.authority) throw new Error("剧本工作室尚未接入受信对象权限。");
    const commandId = requireDomainId(request.commandId, "命令 ID");
    const productionId = requireDomainId(request.productionId, "剧本 ID");
    const itemId = requireDomainId(request.itemId, "条目 ID");
    if (
      !Number.isSafeInteger(request.expectedRevision) ||
      request.expectedRevision < 1
    )
      throw new DomainError("invalid", "条目基准版本无效。");
    if (
      request.restoreRevision !== undefined &&
      (!Number.isSafeInteger(request.restoreRevision) ||
        request.restoreRevision < 1 ||
        request.restoreRevision >= request.expectedRevision)
    )
      throw new DomainError("invalid", "恢复来源必须是早于当前正文的版本。");
    const draft = liveScriptDraftSchema.parse(request.draft);
    const authorize = () =>
      this.authority!.authorizeObject({
        credential: request.credential,
        productionId,
        operation: "write",
      });
    const actor = await authorize();
    if (!actor || actor.objectKind !== "script" || actor.kind !== "human")
      throw new DomainError("forbidden", "只有获授权的本人可以修改正式正文。");
    for (const [label, value] of [
      ["租户 ID", actor.tenantId],
      ["发起者 ID", actor.principalId],
      ["执行者 ID", actor.actantId],
      ["项目 ID", actor.projectId],
    ] as const)
      requireDomainId(value, label);
    const actorIdentity = {
      tenantId: actor.tenantId,
      principalId: actor.principalId,
      actantId: actor.actantId,
      kind: actor.kind,
      runtimeInputId: actor.runtimeInputId,
      runtimeTaskRunEventId: actor.runtimeTaskRunEventId ?? null,
      projectId: actor.projectId,
      objectKind: actor.objectKind,
    };
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          actor: actorIdentity,
          productionId,
          itemId,
          expectedRevision: request.expectedRevision,
          draft,
          restoreRevision: request.restoreRevision ?? null,
        }),
      )
      .digest("hex");
    return this.transaction(async (q) => {
      if (this.backend.kind === "postgres")
        await q.all(
          "SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0)) AS locked",
          [`script:${actor.tenantId}:${productionId}`],
        );
      const prior = await q.all<{
        request_hash: string;
        operation: string;
        result_object_id: string;
        result_version_ref: string;
      }>(
        "SELECT request_hash,operation,result_object_id,result_version_ref FROM script_command_receipts WHERE tenant_id=? AND command_id=?",
        [actor.tenantId, commandId],
      );
      if (prior.length) {
        if (
          prior[0]!.request_hash !== requestHash ||
          prior[0]!.operation !== "revise-item" ||
          prior[0]!.result_object_id !== itemId ||
          safeInteger(prior[0]!.result_version_ref, "正文修订") !==
            request.expectedRevision + 1
        )
          throw new Error("相同命令 ID 对应不同正文修订请求。");
        const committed = await q.all<{
          title: string;
          version_ref: string;
        }>(
          "SELECT p.title,o.version_ref FROM script_outbox o JOIN script_productions p ON p.tenant_id=o.tenant_id AND p.production_id=o.production_id JOIN script_item_versions v ON v.tenant_id=o.tenant_id AND v.item_id=o.object_id AND v.revision=? WHERE o.tenant_id=? AND o.event_id=? AND o.production_id=? AND o.object_id=? AND o.event_kind='script.item-revised' AND p.deleted_at IS NULL",
          [
            request.expectedRevision + 1,
            actor.tenantId,
            commandId,
            productionId,
            itemId,
          ],
        );
        if (committed.length !== 1)
          throw new Error("正文回执与已提交原件不一致。");
        const activityRevision = safeInteger(
          committed[0]!.version_ref,
          "剧本活动修订",
        );
        return {
          tenantId: actor.tenantId,
          productionId,
          itemId,
          itemRevision: request.expectedRevision + 1,
          activityRevision,
          versionRef: String(activityRevision),
          title: committed[0]!.title,
          receiptId: commandId,
          eventId: commandId,
        };
      }
      if (
        (
          await q.all(
            "SELECT 1 AS present FROM script_outbox WHERE tenant_id=? AND production_id=? AND delivered_at IS NULL",
            [actor.tenantId, productionId],
          )
        ).length
      )
        throw new DomainError(
          "conflict",
          "上一次剧本目录更新尚未完成，请先按原命令恢复投影。",
        );
      const production = (
        await q.all<{
          title: string;
          activity_revision: number | string;
        }>(
          `SELECT title,activity_revision FROM script_productions WHERE tenant_id=? AND production_id=? AND deleted_at IS NULL${this.backend.kind === "postgres" ? " FOR UPDATE" : ""}`,
          [actor.tenantId, productionId],
        )
      )[0];
      if (!production) throw new DomainError("not_found", "剧本原件不存在。");
      const item = (
        await q.all<{
          kind: string;
          head_revision: number | string;
          status: string;
        }>(
          "SELECT kind,head_revision,status FROM script_items WHERE tenant_id=? AND production_id=? AND item_id=?",
          [actor.tenantId, productionId, itemId],
        )
      )[0];
      if (!item) throw new DomainError("not_found", "剧本条目不存在。");
      if (
        safeInteger(item.head_revision, "正文修订") !== request.expectedRevision
      )
        throw new DomainError(
          "conflict",
          "正文已有新版本，请保留草稿并重新核对。",
        );
      if (item.status === "locked")
        throw new DomainError("forbidden", "已锁稿，不能直接覆盖。");
      if ((item.kind === "scene") !== (draft.parentId !== null))
        throw new Error("只有分场必须且可以指定所属集。");
      if (draft.parentId) {
        const parent = (
          await q.all<{ kind: string }>(
            "SELECT kind FROM script_items WHERE tenant_id=? AND production_id=? AND item_id=?",
            [actor.tenantId, productionId, draft.parentId],
          )
        )[0];
        if (parent?.kind !== "episode")
          throw new Error("分场必须属于本剧的一集。");
      }
      const affectedRows = await q.all<{ item_id: string }>(
        `WITH RECURSIVE current_drafts AS (
           SELECT i.item_id,d.parent_item_id,v.draft_id FROM script_items i
           JOIN script_item_versions v ON v.tenant_id=i.tenant_id AND v.item_id=i.item_id AND v.revision=i.head_revision
           JOIN script_drafts d ON d.tenant_id=v.tenant_id AND d.draft_id=v.draft_id
           WHERE i.tenant_id=? AND i.production_id=?
         ), edges AS (
           SELECT c.item_id AS child_id,dep.depends_on_item_id AS upstream_id
           FROM current_drafts c JOIN script_draft_dependencies dep ON dep.tenant_id=? AND dep.draft_id=c.draft_id
           UNION SELECT item_id,parent_item_id FROM current_drafts WHERE parent_item_id IS NOT NULL
           UNION SELECT c.item_id,ch.character_item_id FROM current_drafts c
             JOIN script_draft_characters ch ON ch.tenant_id=? AND ch.draft_id=c.draft_id
         ), impact(item_id) AS (
           SELECT child_id FROM edges WHERE upstream_id=?
           UNION SELECT e.child_id FROM edges e JOIN impact i ON e.upstream_id=i.item_id
         ) SELECT item_id FROM impact`,
        [actor.tenantId, productionId, actor.tenantId, actor.tenantId, itemId],
      );
      const affected = [...new Set(affectedRows.map((row) => row.item_id))];
      if (affected.includes(itemId))
        throw new Error("现有剧本依赖形成循环，拒绝继续修订。");
      const dependencies = new Set<string>();
      for (const ref of draft.dependencies) {
        if (
          ref.itemId === itemId ||
          dependencies.has(ref.itemId) ||
          affected.includes(ref.itemId)
        )
          throw new Error("剧本依赖重复、指向自身或形成循环。");
        dependencies.add(ref.itemId);
        if (
          !(
            await q.all(
              "SELECT 1 AS present FROM script_items i JOIN script_item_versions v ON v.tenant_id=i.tenant_id AND v.item_id=i.item_id WHERE i.tenant_id=? AND i.production_id=? AND i.item_id=? AND v.revision=?",
              [actor.tenantId, productionId, ref.itemId, ref.revision],
            )
          ).length
        )
          throw new Error("剧本依赖必须指向本剧有效版本。");
      }
      if (draft.parentId && !dependencies.has(draft.parentId))
        throw new Error("所属集必须同时绑定依赖版本。");
      const characters = new Set<string>();
      for (const characterId of draft.characters) {
        if (characters.has(characterId)) throw new Error("出场角色不能重复。");
        characters.add(characterId);
        const character = (
          await q.all<{ kind: string }>(
            "SELECT kind FROM script_items WHERE tenant_id=? AND production_id=? AND item_id=?",
            [actor.tenantId, productionId, characterId],
          )
        )[0];
        if (character?.kind !== "character" || !dependencies.has(characterId))
          throw new Error("出场角色必须引用本剧角色并绑定其版本。");
      }
      const sourceChecks = [] as Parameters<
        NonNullable<ScriptStudioAuthority["verifySourceVersion"]>
      >[0][];
      for (const source of draft.sources) {
        const pinned = await q.all(
          "SELECT 1 AS pinned FROM script_draft_sources s JOIN script_item_versions v ON v.tenant_id=s.tenant_id AND v.draft_id=s.draft_id JOIN script_items i ON i.tenant_id=v.tenant_id AND i.item_id=v.item_id WHERE i.tenant_id=? AND i.production_id=? AND s.source_app_id=? AND s.source_instance_id=? AND s.source_object_id=? AND s.source_version_ref=? AND s.quote_text=? LIMIT 1",
          [
            actor.tenantId,
            productionId,
            source.appId,
            source.instanceId,
            source.objectId,
            source.versionRef,
            source.quote,
          ],
        );
        sourceChecks.push({
          credential: request.credential,
          tenantId: actor.tenantId,
          principalId: actor.principalId,
          actantId: actor.actantId,
          kind: actor.kind,
          runtimeInputId: actor.runtimeInputId,
          runtimeTaskRunEventId: actor.runtimeTaskRunEventId ?? null,
          productionProjectId: actor.projectId,
          alreadyPinned: pinned.length > 0,
          ...source,
        });
      }
      for (const check of sourceChecks)
        if (
          !this.authority!.verifySourceVersion ||
          !(await this.authority!.verifySourceVersion(check))
        )
          throw new Error("原件版本和引文尚未由所属应用核验。");
      const currentActor = await authorize();
      if (
        !currentActor ||
        JSON.stringify({
          tenantId: currentActor.tenantId,
          principalId: currentActor.principalId,
          actantId: currentActor.actantId,
          kind: currentActor.kind,
          runtimeInputId: currentActor.runtimeInputId,
          runtimeTaskRunEventId: currentActor.runtimeTaskRunEventId ?? null,
          projectId: currentActor.projectId,
          objectKind: currentActor.objectKind,
        }) !== JSON.stringify(actorIdentity)
      )
        throw new Error("剧本权限或所属项目在修订期间已变化。");
      for (const check of sourceChecks)
        if (!(await this.authority!.verifySourceVersion?.(check)))
          throw new Error("来源权限或引文在修订期间已变化。");
      const itemRevision = request.expectedRevision + 1;
      const activityRevision =
        safeInteger(production.activity_revision, "剧本活动修订") + 1;
      if (
        !Number.isSafeInteger(itemRevision) ||
        !Number.isSafeInteger(activityRevision)
      )
        throw new Error("剧本修订号溢出。");
      const now = new Date().toISOString();
      const draftId = draftIdentity(
        productionId,
        `item:${itemId}:${itemRevision}`,
      );
      await this.insertResolvedDraft(
        q,
        actor.tenantId,
        productionId,
        draftId,
        draft,
        now,
      );
      if (
        (await q.change(
          "UPDATE script_items SET head_revision=?,workflow_revision=workflow_revision+1,status='draft',parent_item_id=?,order_index=?,updated_at=? WHERE tenant_id=? AND production_id=? AND item_id=? AND head_revision=? AND status!='locked'",
          [
            itemRevision,
            draft.parentId,
            draft.order,
            now,
            actor.tenantId,
            productionId,
            itemId,
            request.expectedRevision,
          ],
        )) !== 1
      )
        throw new Error("正文在保存期间发生版本冲突。");
      await insert(q, "script_item_versions", {
        tenant_id: actor.tenantId,
        item_id: itemId,
        revision: itemRevision,
        collection_ordinal: itemRevision - 1,
        draft_id: draftId,
        candidate_id: null,
        author_principal_id: actor.principalId,
        author_actant_id: actor.actantId,
        created_at: now,
      });
      await q.change(
        "DELETE FROM script_item_approvals WHERE tenant_id=? AND item_id=?",
        [actor.tenantId, itemId],
      );
      const eventOrdinal = async (id: string) => {
        const row = (
          await q.all<{ next_ordinal: number | string }>(
            "SELECT COALESCE(MAX(ordinal)+1,0) AS next_ordinal FROM script_item_events WHERE tenant_id=? AND item_id=?",
            [actor.tenantId, id],
          )
        )[0]!;
        return safeInteger(row.next_ordinal, "工作流事件序号");
      };
      await insert(q, "script_item_events", {
        tenant_id: actor.tenantId,
        item_id: itemId,
        ordinal: await eventOrdinal(itemId),
        action: "revise",
        revision: itemRevision,
        note:
          request.restoreRevision === undefined
            ? ""
            : `恢复 v${request.restoreRevision}`,
        author_principal_id: actor.principalId,
        author_actant_id: actor.actantId,
        created_at: now,
      });
      for (const affectedId of affected) {
        const downstream = (
          await q.all<{ head_revision: number | string; status: string }>(
            "SELECT head_revision,status FROM script_items WHERE tenant_id=? AND production_id=? AND item_id=?",
            [actor.tenantId, productionId, affectedId],
          )
        )[0];
        if (!downstream) throw new Error("受影响条目不存在。");
        await q.change(
          "UPDATE script_items SET workflow_revision=workflow_revision+1,status=CASE WHEN status='locked' THEN status ELSE 'draft' END,updated_at=? WHERE tenant_id=? AND production_id=? AND item_id=?",
          [now, actor.tenantId, productionId, affectedId],
        );
        await q.change(
          "DELETE FROM script_item_approvals WHERE tenant_id=? AND item_id=?",
          [actor.tenantId, affectedId],
        );
        await insert(q, "script_item_events", {
          tenant_id: actor.tenantId,
          item_id: affectedId,
          ordinal: await eventOrdinal(affectedId),
          action: "invalidate",
          revision: safeInteger(downstream.head_revision, "下游正文修订"),
          note: `上游 ${itemId} 更新至 v${itemRevision}`,
          author_principal_id: actor.principalId,
          author_actant_id: actor.actantId,
          created_at: now,
        });
      }
      if (
        (await q.change(
          "UPDATE script_productions SET activity_revision=?,updated_at=? WHERE tenant_id=? AND production_id=? AND activity_revision=? AND deleted_at IS NULL",
          [
            activityRevision,
            now,
            actor.tenantId,
            productionId,
            activityRevision - 1,
          ],
        )) !== 1
      )
        throw new Error("剧本活动修订发生并发冲突。");
      await insert(q, "script_command_receipts", {
        tenant_id: actor.tenantId,
        command_id: commandId,
        request_hash: requestHash,
        input_id: actor.runtimeInputId,
        task_run_event_id: actor.runtimeTaskRunEventId ?? null,
        operation: "revise-item",
        result_object_id: itemId,
        result_version_ref: String(itemRevision),
        committed_at: now,
      });
      await insert(q, "script_outbox", {
        tenant_id: actor.tenantId,
        event_id: commandId,
        production_id: productionId,
        object_id: itemId,
        version_ref: String(activityRevision),
        requested_project_id: null,
        event_kind: "script.item-revised",
        created_at: now,
        delivered_at: null,
      });
      return {
        tenantId: actor.tenantId,
        productionId,
        itemId,
        itemRevision,
        activityRevision,
        versionRef: String(activityRevision),
        title: production.title,
        receiptId: commandId,
        eventId: commandId,
      };
    });
  }

  /** Decide one pinned candidate in the Script Studio transaction. A
   * Platform directory entry grants access to the original, but never owns
   * its draft, item head or decision. The candidate, item revision, affected
   * approvals and receipt commit together in this app domain.
   */
  async decideCandidate(request: {
    credential: string;
    commandId: string;
    productionId: string;
    candidateId: string;
    expectedRevision: number;
    decision: "accept" | "reject";
  }): Promise<ScriptCandidateDecisionReceipt> {
    if (!this.authority) throw new Error("剧本工作室尚未接入受信对象权限。");
    const commandId = requireDomainId(request.commandId, "命令 ID");
    const productionId = requireDomainId(request.productionId, "剧本 ID");
    const candidateId = requireDomainId(request.candidateId, "候选 ID");
    if (
      !Number.isSafeInteger(request.expectedRevision) ||
      request.expectedRevision < 1
    )
      throw new Error("候选修订无效。");
    if (request.decision !== "accept" && request.decision !== "reject")
      throw new Error("候选决定无效。");
    const authorize = () =>
      this.authority!.authorizeObject({
        credential: request.credential,
        productionId,
        operation: "write",
      });
    const actor = await authorize();
    if (!actor || actor.kind !== "human" || actor.objectKind !== "script")
      throw new Error("只有获授权的人工成员可以决定剧本候选。");
    for (const [label, value] of [
      ["租户 ID", actor.tenantId],
      ["发起者 ID", actor.principalId],
      ["执行者 ID", actor.actantId],
      ["项目 ID", actor.projectId],
    ] as const)
      requireDomainId(value, label);
    const actorIdentity = {
      tenantId: actor.tenantId,
      principalId: actor.principalId,
      actantId: actor.actantId,
      kind: actor.kind,
      runtimeInputId: actor.runtimeInputId,
      objectKind: actor.objectKind,
    };
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          actor: actorIdentity,
          productionId,
          candidateId,
          expectedRevision: request.expectedRevision,
          decision: request.decision,
        }),
      )
      .digest("hex");
    return this.transaction(async (q) => {
      if (this.backend.kind === "postgres")
        await q.all(
          "SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0)) AS locked",
          [`script:${actor.tenantId}:${productionId}`],
        );
      const prior = await q.all<{
        request_hash: string;
        operation: string;
        result_object_id: string;
        result_version_ref: string;
      }>(
        "SELECT request_hash,operation,result_object_id,result_version_ref FROM script_command_receipts WHERE tenant_id=? AND command_id=?",
        [actor.tenantId, commandId],
      );
      const operation = `decide-candidate:${request.decision}`;
      if (prior.length) {
        if (
          prior[0]!.request_hash !== requestHash ||
          prior[0]!.operation !== operation ||
          prior[0]!.result_object_id !== candidateId
        )
          throw new Error("相同命令 ID 对应不同候选决定。");
        const adopted = await q.all<{
          item_id: string;
          revision: number | string;
        }>(
          "SELECT item_id,revision FROM script_item_versions WHERE tenant_id=? AND candidate_id=?",
          [actor.tenantId, candidateId],
        );
        if (adopted.length !== (request.decision === "accept" ? 1 : 0))
          throw new Error("候选回执与已提交正文版本不一致。");
        const current = await q.all<{
          title: string;
          candidate_revision: number | string;
        }>(
          "SELECT p.title,c.candidate_revision FROM script_productions p JOIN script_candidates c ON c.tenant_id=p.tenant_id AND c.production_id=p.production_id WHERE p.tenant_id=? AND p.production_id=? AND c.candidate_id=? AND p.deleted_at IS NULL",
          [actor.tenantId, productionId, candidateId],
        );
        if (
          current.length !== 1 ||
          safeInteger(current[0]!.candidate_revision, "候选修订") !==
            request.expectedRevision + 1
        )
          throw new Error("候选回执与决定状态不一致。");
        const activityRevision = safeInteger(
          prior[0]!.result_version_ref,
          "剧本活动修订",
        );
        return {
          tenantId: actor.tenantId,
          productionId,
          candidateId,
          candidateRevision: request.expectedRevision + 1,
          decision: request.decision,
          adoptedItemId: adopted[0]?.item_id ?? null,
          adoptedItemRevision: adopted.length
            ? safeInteger(adopted[0]!.revision, "正文修订")
            : null,
          activityRevision,
          versionRef: String(activityRevision),
          title: current[0]!.title,
          receiptId: commandId,
          eventId: commandId,
        };
      }
      const pending = await q.all(
        "SELECT 1 AS present FROM script_outbox WHERE tenant_id=? AND production_id=? AND delivered_at IS NULL",
        [actor.tenantId, productionId],
      );
      if (pending.length)
        throw new Error("上一次剧本目录更新尚未完成，请先按原命令恢复投影。");
      const productions = await q.all<{
        creative_epoch: number | string;
        metadata_revision: number | string;
        activity_revision: number | string;
        title: string;
      }>(
        `SELECT creative_epoch,metadata_revision,activity_revision,title FROM script_productions WHERE tenant_id=? AND production_id=? AND deleted_at IS NULL${this.backend.kind === "postgres" ? " FOR UPDATE" : ""}`,
        [actor.tenantId, productionId],
      );
      if (productions.length !== 1) throw new Error("剧本原件不存在。");
      const candidates = await q.all<{
        target_item_id: string;
        draft_id: string;
        base_item_revision: number | string;
        context_revision: number | string;
        base_creative_epoch: number | string;
        candidate_revision: number | string;
        status: string;
      }>(
        `SELECT target_item_id,draft_id,base_item_revision,context_revision,base_creative_epoch,candidate_revision,status FROM script_candidates WHERE tenant_id=? AND production_id=? AND candidate_id=?${this.backend.kind === "postgres" ? " FOR UPDATE" : ""}`,
        [actor.tenantId, productionId, candidateId],
      );
      if (candidates.length !== 1) throw new Error("候选稿不存在。");
      const candidate = candidates[0]!;
      const currentRevision = safeInteger(
        candidate.candidate_revision,
        "候选修订",
      );
      if (
        currentRevision !== request.expectedRevision ||
        candidate.status !== "pending"
      )
        throw new Error("候选稿已有决定或修订已变化。");
      const itemRows = await q.all<{
        item_id: string;
        kind: string;
        head_revision: number | string;
        status: string;
      }>(
        "SELECT item_id,kind,head_revision,status FROM script_items WHERE tenant_id=? AND production_id=?",
        [actor.tenantId, productionId],
      );
      const items = new Map(itemRows.map((row) => [row.item_id, row]));
      const target = items.get(candidate.target_item_id);
      if (!target) throw new Error("候选目标条目不存在。");
      let adoptedItemRevision: number | null = null;
      const sourceChecks: Parameters<
        NonNullable<ScriptStudioAuthority["verifySourceVersion"]>
      >[0][] = [];
      if (request.decision === "accept") {
        if (
          safeInteger(productions[0]!.creative_epoch, "创作阶段") !==
            safeInteger(candidate.base_creative_epoch, "候选创作阶段") ||
          safeInteger(productions[0]!.metadata_revision, "剧本元数据修订") <
            safeInteger(candidate.context_revision, "候选上下文修订") ||
          safeInteger(target.head_revision, "正文修订") !==
            safeInteger(candidate.base_item_revision, "候选基准修订")
        )
          throw new Error("候选稿已过期；不能覆盖更新后的正文或创作要求。");
        if (target.status === "locked")
          throw new Error("条目已锁稿，必须先由人工解锁。");
        const pinned = await q.all<{
          item_id: string;
          revision: number | string;
        }>(
          "SELECT item_id,revision FROM script_candidate_references WHERE tenant_id=? AND candidate_id=?",
          [actor.tenantId, candidateId],
        );
        const allowed = new Map(
          pinned.map((ref) => [
            ref.item_id,
            safeInteger(ref.revision, "固定版本"),
          ]),
        );
        for (const [itemId, revision] of allowed) {
          const item = items.get(itemId);
          if (!item || safeInteger(item.head_revision, "上游修订") !== revision)
            throw new Error("候选固定的上游版本已变化。");
        }
        const drafts = await q.all<{
          parent_item_id: string | null;
          order_index: number | string;
        }>(
          "SELECT parent_item_id,order_index FROM script_drafts WHERE tenant_id=? AND production_id=? AND draft_id=?",
          [actor.tenantId, productionId, candidate.draft_id],
        );
        if (drafts.length !== 1) throw new Error("候选正文快照缺失。");
        const draft = drafts[0]!;
        const sources = await q.all<{
          source_app_id: string;
          source_instance_id: string;
          source_object_id: string;
          source_version_ref: string;
          quote_text: string;
        }>(
          "SELECT source_app_id,source_instance_id,source_object_id,source_version_ref,quote_text FROM script_draft_sources WHERE tenant_id=? AND draft_id=? ORDER BY ordinal",
          [actor.tenantId, candidate.draft_id],
        );
        for (const source of sources) {
          const pinnedSource = await q.all(
            "SELECT 1 AS pinned FROM script_draft_sources s JOIN script_item_versions v ON v.tenant_id=s.tenant_id AND v.draft_id=s.draft_id JOIN script_items i ON i.tenant_id=v.tenant_id AND i.item_id=v.item_id WHERE i.tenant_id=? AND i.production_id=? AND s.source_app_id=? AND s.source_instance_id=? AND s.source_object_id=? AND s.source_version_ref=? AND s.quote_text=? LIMIT 1",
            [
              actor.tenantId,
              productionId,
              source.source_app_id,
              source.source_instance_id,
              source.source_object_id,
              source.source_version_ref,
              source.quote_text,
            ],
          );
          const check = {
            credential: request.credential,
            tenantId: actor.tenantId,
            principalId: actor.principalId,
            actantId: actor.actantId,
            kind: actor.kind,
            runtimeInputId: actor.runtimeInputId,
            productionProjectId: actor.projectId,
            alreadyPinned: pinnedSource.length > 0,
            appId: source.source_app_id,
            instanceId: source.source_instance_id,
            objectId: source.source_object_id,
            versionRef: source.source_version_ref,
            quote: source.quote_text,
          };
          sourceChecks.push(check);
          if (
            !this.authority!.verifySourceVersion ||
            !(await this.authority!.verifySourceVersion(check))
          )
            throw new Error("候选引用的原件版本和引文尚未由所属应用核验。");
        }
        if (
          (target.kind === "scene" &&
            (!draft.parent_item_id ||
              items.get(draft.parent_item_id)?.kind !== "episode")) ||
          (target.kind !== "scene" && draft.parent_item_id !== null)
        )
          throw new Error("候选所属分集与条目类型不符。");
        const dependencies = await q.all<{
          depends_on_item_id: string;
          depends_on_revision: number | string;
        }>(
          "SELECT depends_on_item_id,depends_on_revision FROM script_draft_dependencies WHERE tenant_id=? AND draft_id=?",
          [actor.tenantId, candidate.draft_id],
        );
        const dependencyIds = new Set<string>();
        for (const dependency of dependencies) {
          const id = dependency.depends_on_item_id;
          const revision = safeInteger(
            dependency.depends_on_revision,
            "依赖版本",
          );
          if (
            id === target.item_id ||
            dependencyIds.has(id) ||
            allowed.get(id) !== revision ||
            !items.has(id)
          )
            throw new Error("候选依赖不属于固定的有效上游版本。");
          dependencyIds.add(id);
        }
        if (draft.parent_item_id && !dependencyIds.has(draft.parent_item_id))
          throw new Error("候选所属集必须绑定依赖版本。");
        const characters = await q.all<{ character_item_id: string }>(
          "SELECT character_item_id FROM script_draft_characters WHERE tenant_id=? AND draft_id=?",
          [actor.tenantId, candidate.draft_id],
        );
        for (const character of characters)
          if (
            items.get(character.character_item_id)?.kind !== "character" ||
            !dependencyIds.has(character.character_item_id)
          )
            throw new Error("候选出场角色必须绑定角色依赖版本。");
        const downstream = await q.all<{ item_id: string }>(
          `WITH RECURSIVE current_drafts AS (
             SELECT i.item_id,v.draft_id,d.parent_item_id
             FROM script_items i
             JOIN script_item_versions v ON v.tenant_id=i.tenant_id AND v.item_id=i.item_id AND v.revision=i.head_revision
             JOIN script_drafts d ON d.tenant_id=v.tenant_id AND d.draft_id=v.draft_id
             WHERE i.tenant_id=? AND i.production_id=?
           ), edges AS (
             SELECT c.item_id AS child_id,dep.depends_on_item_id AS upstream_id
             FROM current_drafts c JOIN script_draft_dependencies dep ON dep.tenant_id=? AND dep.draft_id=c.draft_id
             UNION
             SELECT item_id,parent_item_id FROM current_drafts WHERE parent_item_id IS NOT NULL
             UNION
             SELECT c.item_id,ch.character_item_id
             FROM current_drafts c JOIN script_draft_characters ch ON ch.tenant_id=? AND ch.draft_id=c.draft_id
           ), impact(item_id) AS (
             SELECT child_id FROM edges WHERE upstream_id=?
             UNION
             SELECT e.child_id FROM edges e JOIN impact i ON e.upstream_id=i.item_id
           ) SELECT item_id FROM impact`,
          [
            actor.tenantId,
            productionId,
            actor.tenantId,
            actor.tenantId,
            target.item_id,
          ],
        );
        const affected = [...new Set(downstream.map((row) => row.item_id))];
        if (
          affected.includes(target.item_id) ||
          dependencies.some((ref) => affected.includes(ref.depends_on_item_id))
        )
          throw new Error("候选依赖会形成循环。");
        const nextRevision = safeInteger(target.head_revision, "正文修订") + 1;
        const now = new Date().toISOString();
        const changed = await q.change(
          "UPDATE script_items SET head_revision=?,workflow_revision=workflow_revision+1,status='draft',parent_item_id=?,order_index=?,updated_at=? WHERE tenant_id=? AND production_id=? AND item_id=? AND head_revision=? AND status!='locked'",
          [
            nextRevision,
            draft.parent_item_id,
            safeInteger(draft.order_index, "目录顺序"),
            now,
            actor.tenantId,
            productionId,
            target.item_id,
            nextRevision - 1,
          ],
        );
        if (changed !== 1) throw new Error("正文在采纳时发生版本冲突。");
        await insert(q, "script_item_versions", {
          tenant_id: actor.tenantId,
          item_id: target.item_id,
          revision: nextRevision,
          collection_ordinal: nextRevision - 1,
          draft_id: candidate.draft_id,
          candidate_id: candidateId,
          author_principal_id: actor.principalId,
          author_actant_id: actor.actantId,
          created_at: now,
        });
        await q.change(
          "DELETE FROM script_item_approvals WHERE tenant_id=? AND item_id=?",
          [actor.tenantId, target.item_id],
        );
        const eventOrdinals = await q.all<{
          item_id: string;
          next_ordinal: number | string;
        }>(
          "SELECT e.item_id,MAX(e.ordinal)+1 AS next_ordinal FROM script_item_events e JOIN script_items i ON i.tenant_id=e.tenant_id AND i.item_id=e.item_id WHERE e.tenant_id=? AND i.production_id=? GROUP BY e.item_id",
          [actor.tenantId, productionId],
        );
        const nextOrdinal = new Map(
          eventOrdinals.map((row) => [
            row.item_id,
            safeInteger(row.next_ordinal, "工作流事件序号"),
          ]),
        );
        const appendEvent = async (
          itemId: string,
          action: "revise" | "invalidate",
          revision: number,
          note: string,
        ) => {
          const ordinal = nextOrdinal.get(itemId) ?? 0;
          await insert(q, "script_item_events", {
            tenant_id: actor.tenantId,
            item_id: itemId,
            ordinal,
            action,
            revision,
            note,
            author_principal_id: actor.principalId,
            author_actant_id: actor.actantId,
            created_at: now,
          });
          nextOrdinal.set(itemId, ordinal + 1);
        };
        await appendEvent(target.item_id, "revise", nextRevision, "采纳候选");
        for (const itemId of affected) {
          const item = items.get(itemId);
          if (!item) throw new Error("受影响条目不存在。");
          await q.change(
            "UPDATE script_items SET workflow_revision=workflow_revision+1,status=CASE WHEN status='locked' THEN status ELSE 'draft' END,updated_at=? WHERE tenant_id=? AND production_id=? AND item_id=?",
            [now, actor.tenantId, productionId, itemId],
          );
          await q.change(
            "DELETE FROM script_item_approvals WHERE tenant_id=? AND item_id=?",
            [actor.tenantId, itemId],
          );
          await appendEvent(
            itemId,
            "invalidate",
            safeInteger(item.head_revision, "正文修订"),
            `上游 ${target.item_id} 更新至 v${nextRevision}`,
          );
        }
        adoptedItemRevision = nextRevision;
      }
      const decidedAt = new Date().toISOString();
      const changed = await q.change(
        "UPDATE script_candidates SET candidate_revision=candidate_revision+1,status=?,decided_at=?,decided_by_principal_id=?,decided_by_actant_id=? WHERE tenant_id=? AND production_id=? AND candidate_id=? AND candidate_revision=? AND status='pending'",
        [
          request.decision === "accept" ? "accepted" : "rejected",
          decidedAt,
          actor.principalId,
          actor.actantId,
          actor.tenantId,
          productionId,
          candidateId,
          request.expectedRevision,
        ],
      );
      if (changed !== 1) throw new Error("候选稿决定发生并发冲突。");
      const currentActor = await authorize();
      if (
        !currentActor ||
        currentActor.projectId !== actor.projectId ||
        JSON.stringify({
          tenantId: currentActor.tenantId,
          principalId: currentActor.principalId,
          actantId: currentActor.actantId,
          kind: currentActor.kind,
          runtimeInputId: currentActor.runtimeInputId,
          objectKind: currentActor.objectKind,
        }) !== JSON.stringify(actorIdentity)
      )
        throw new Error("剧本权限或所属项目在决定期间已变化。");
      for (const check of sourceChecks)
        if (!(await this.authority!.verifySourceVersion?.(check)))
          throw new Error("来源权限或引文在候选决定期间已变化。");
      const activityRevision =
        safeInteger(productions[0]!.activity_revision, "剧本活动修订") + 1;
      if (!Number.isSafeInteger(activityRevision))
        throw new Error("剧本活动修订溢出。");
      const activityChanged = await q.change(
        "UPDATE script_productions SET activity_revision=?,updated_at=? WHERE tenant_id=? AND production_id=? AND activity_revision=? AND deleted_at IS NULL",
        [
          activityRevision,
          decidedAt,
          actor.tenantId,
          productionId,
          activityRevision - 1,
        ],
      );
      if (activityChanged !== 1) throw new Error("剧本活动修订发生并发冲突。");
      await insert(q, "script_command_receipts", {
        tenant_id: actor.tenantId,
        command_id: commandId,
        request_hash: requestHash,
        input_id: actor.runtimeInputId,
        operation,
        result_object_id: candidateId,
        result_version_ref: String(activityRevision),
        committed_at: decidedAt,
      });
      await insert(q, "script_outbox", {
        tenant_id: actor.tenantId,
        event_id: commandId,
        production_id: productionId,
        object_id: productionId,
        version_ref: String(activityRevision),
        requested_project_id: null,
        event_kind: "script.candidate-decided",
        created_at: decidedAt,
        delivered_at: null,
      });
      return {
        tenantId: actor.tenantId,
        productionId,
        candidateId,
        candidateRevision: currentRevision + 1,
        decision: request.decision,
        adoptedItemId: adoptedItemRevision === null ? null : target.item_id,
        adoptedItemRevision,
        activityRevision,
        versionRef: String(activityRevision),
        title: productions[0]!.title,
        receiptId: commandId,
        eventId: commandId,
      };
    });
  }

  /** Trusted Platform verifier checks a committed app receipt, not a model
   * claim. The project is command context only, not a second app-owned owner.
   */
  async verifyCommittedProduction(request: {
    tenantId: string;
    principalId: string;
    actantId: string;
    runtimeInputId: string | null;
    runtimeTaskRunEventId?: string | null;
    productionId: string;
    projectId: string;
    title: string;
    versionRef: string;
    receiptId: string;
  }): Promise<boolean> {
    return this.transaction(async (q) => {
      const rows = await q.all<{
        owner_principal_id: string;
        created_by_actant_id: string;
        input_id: string | null;
        task_run_event_id: string | null;
        title: string;
        result_version_ref: string;
        requested_project_id: string | null;
      }>(
        "SELECT p.owner_principal_id,p.created_by_actant_id,r.input_id,r.task_run_event_id,m.title,r.result_version_ref,o.requested_project_id FROM script_command_receipts r JOIN script_productions p ON p.tenant_id=r.tenant_id AND p.production_id=r.result_object_id JOIN script_metadata_versions m ON m.tenant_id=r.tenant_id AND m.production_id=p.production_id AND m.revision=1 JOIN script_outbox o ON o.tenant_id=r.tenant_id AND o.event_id=r.command_id AND o.production_id=p.production_id AND o.object_id=p.production_id AND o.version_ref=r.result_version_ref AND o.event_kind='script.created' WHERE r.tenant_id=? AND r.command_id=? AND r.operation='create-production' AND r.result_object_id=? AND p.deleted_at IS NULL",
        [request.tenantId, request.receiptId, request.productionId],
      );
      return (
        rows.length === 1 &&
        rows[0]!.owner_principal_id === request.principalId &&
        rows[0]!.created_by_actant_id === request.actantId &&
        rows[0]!.input_id === request.runtimeInputId &&
        rows[0]!.task_run_event_id ===
          (request.runtimeTaskRunEventId ?? null) &&
        rows[0]!.title === request.title &&
        rows[0]!.result_version_ref === request.versionRef &&
        rows[0]!.requested_project_id === request.projectId
      );
    }, true);
  }

  async verifyCommittedProductionUpdate(request: {
    tenantId: string;
    principalId: string;
    actantId: string;
    runtimeInputId: string | null;
    runtimeTaskRunEventId?: string | null;
    productionId: string;
    title: string;
    versionRef: string;
    receiptId: string;
  }): Promise<boolean> {
    return this.transaction(async (q) => {
      const rows = await q.all<Row>(
        "SELECT p.activity_revision,m.title,m.author_principal_id,m.author_actant_id,r.input_id,r.task_run_event_id,r.result_version_ref FROM script_command_receipts r JOIN script_outbox o ON o.tenant_id=r.tenant_id AND o.event_id=r.command_id AND o.production_id=? AND o.object_id=? AND o.version_ref=r.result_version_ref AND o.event_kind='script.updated' JOIN script_productions p ON p.tenant_id=o.tenant_id AND p.production_id=o.production_id JOIN script_metadata_versions m ON m.tenant_id=p.tenant_id AND m.production_id=p.production_id AND m.revision=p.metadata_revision WHERE r.tenant_id=? AND r.command_id=? AND r.operation='update-production' AND r.result_object_id=? AND p.deleted_at IS NULL",
        [
          request.productionId,
          request.productionId,
          request.tenantId,
          request.receiptId,
          request.productionId,
        ],
      );
      return (
        rows.length === 1 &&
        String(rows[0]!.activity_revision) === request.versionRef &&
        rows[0]!.result_version_ref === request.versionRef &&
        rows[0]!.title === request.title &&
        rows[0]!.author_principal_id === request.principalId &&
        rows[0]!.author_actant_id === request.actantId &&
        rows[0]!.input_id === request.runtimeInputId &&
        rows[0]!.task_run_event_id === (request.runtimeTaskRunEventId ?? null)
      );
    }, true);
  }

  async verifyCommittedProductionRename(
    request: Parameters<
      ScriptStudioStore["verifyCommittedProductionUpdate"]
    >[0],
  ): Promise<boolean> {
    return this.transaction(async (q) => {
      const rows = await q.all<Row>(
        "SELECT p.activity_revision,p.metadata_revision,p.creative_epoch,m.*,r.input_id,r.task_run_event_id,r.result_version_ref FROM script_command_receipts r JOIN script_outbox o ON o.tenant_id=r.tenant_id AND o.event_id=r.command_id AND o.production_id=? AND o.object_id=? AND o.version_ref=r.result_version_ref AND o.event_kind='script.updated' JOIN script_productions p ON p.tenant_id=o.tenant_id AND p.production_id=o.production_id JOIN script_metadata_versions m ON m.tenant_id=p.tenant_id AND m.production_id=p.production_id AND m.revision=p.metadata_revision WHERE r.tenant_id=? AND r.command_id=? AND r.operation='rename-production' AND r.result_object_id=? AND p.deleted_at IS NULL",
        [
          request.productionId,
          request.productionId,
          request.tenantId,
          request.receiptId,
          request.productionId,
        ],
      );
      if (rows.length !== 1) return false;
      const row = rows[0]!;
      const revision = safeInteger(
        row.metadata_revision as number | string,
        "剧本元数据修订",
      );
      const previous = (
        await q.all<Row>(
          "SELECT * FROM script_metadata_versions WHERE tenant_id=? AND production_id=? AND revision=?",
          [request.tenantId, request.productionId, revision - 1],
        )
      )[0];
      if (!previous) return false;
      const unchanged = [
        "mode",
        "audience",
        "genre",
        "episode_count",
        "episode_seconds",
        "style",
        "constraints_text",
        "rights_statement",
        "model_processing_allowed",
        "template_title",
        "template_include_notes",
        "template_include_continuity",
        "template_page_break_episodes",
        "template_font",
        "template_font_size",
        "template_scene_heading",
      ];
      if (unchanged.some((key) => String(row[key]) !== String(previous[key])))
        return false;
      const reviewers = await q.all<{
        revision: number | string;
        ordinal: number | string;
        principal_id: string;
      }>(
        "SELECT revision,ordinal,principal_id FROM script_metadata_reviewers WHERE tenant_id=? AND production_id=? AND revision IN (?,?) ORDER BY revision,ordinal",
        [request.tenantId, request.productionId, revision - 1, revision],
      );
      const oldReviewers = reviewers
        .filter((item) => Number(item.revision) === revision - 1)
        .map((item) => item.principal_id);
      const newReviewers = reviewers
        .filter((item) => Number(item.revision) === revision)
        .map((item) => item.principal_id);
      return (
        JSON.stringify(oldReviewers) === JSON.stringify(newReviewers) &&
        row.title === request.title &&
        String(row.activity_revision) === request.versionRef &&
        row.result_version_ref === request.versionRef &&
        row.author_principal_id === request.principalId &&
        row.author_actant_id === request.actantId &&
        row.input_id === request.runtimeInputId &&
        row.task_run_event_id === (request.runtimeTaskRunEventId ?? null)
      );
    }, true);
  }

  async verifyCommittedExport(request: {
    tenantId: string;
    principalId: string;
    actantId: string;
    runtimeInputId: string | null;
    runtimeTaskRunEventId?: string | null;
    productionId: string;
    title: string;
    versionRef: string;
    receiptId: string;
  }): Promise<boolean> {
    return this.transaction(async (q) => {
      const rows = await q.all<Row>(
        "SELECT p.title,p.activity_revision,r.input_id,r.task_run_event_id,r.result_version_ref,e.created_by_principal_id,e.created_by_actant_id FROM script_command_receipts r JOIN script_outbox o ON o.tenant_id=r.tenant_id AND o.event_id=r.command_id AND o.production_id=? AND o.version_ref=r.result_version_ref AND o.event_kind='script.export-recorded' JOIN script_productions p ON p.tenant_id=o.tenant_id AND p.production_id=o.production_id JOIN script_exports e ON e.tenant_id=o.tenant_id AND e.production_id=p.production_id AND e.export_id=o.object_id WHERE r.tenant_id=? AND r.command_id=? AND r.operation='record-export' AND r.result_object_id=e.export_id AND p.deleted_at IS NULL",
        [request.productionId, request.tenantId, request.receiptId],
      );
      return (
        rows.length === 1 &&
        rows[0]!.title === request.title &&
        String(rows[0]!.activity_revision) === request.versionRef &&
        rows[0]!.result_version_ref === request.versionRef &&
        rows[0]!.input_id === request.runtimeInputId &&
        rows[0]!.task_run_event_id ===
          (request.runtimeTaskRunEventId ?? null) &&
        rows[0]!.created_by_principal_id === request.principalId &&
        rows[0]!.created_by_actant_id === request.actantId
      );
    }, true);
  }

  async verifyCommittedWorkflow(request: {
    tenantId: string;
    principalId: string;
    actantId: string;
    runtimeInputId: string | null;
    runtimeTaskRunEventId?: string | null;
    productionId: string;
    title: string;
    versionRef: string;
    receiptId: string;
  }): Promise<boolean> {
    return this.transaction(async (q) => {
      const rows = await q.all<Row>(
        "SELECT p.title,p.activity_revision,r.input_id,r.task_run_event_id,r.result_version_ref,e.author_principal_id,e.author_actant_id FROM script_command_receipts r JOIN script_outbox o ON o.tenant_id=r.tenant_id AND o.event_id=r.command_id AND o.production_id=? AND o.version_ref=r.result_version_ref AND o.event_kind='script.workflow-changed' AND o.object_id=r.result_object_id JOIN script_productions p ON p.tenant_id=o.tenant_id AND p.production_id=o.production_id JOIN script_item_events e ON e.tenant_id=o.tenant_id AND e.item_id=o.object_id AND e.created_at=r.committed_at AND ((r.operation='submit-review' AND e.action='submit') OR (r.operation='review-decision' AND e.action IN ('approve','request-changes')) OR (r.operation='lock-item' AND e.action='lock') OR (r.operation='unlock-item' AND e.action='unlock')) WHERE r.tenant_id=? AND r.command_id=? AND r.result_object_id=o.object_id AND p.deleted_at IS NULL",
        [request.productionId, request.tenantId, request.receiptId],
      );
      return rows.some(
        (row) =>
          row.title === request.title &&
          String(row.activity_revision) === request.versionRef &&
          row.result_version_ref === request.versionRef &&
          row.input_id === request.runtimeInputId &&
          row.task_run_event_id === (request.runtimeTaskRunEventId ?? null) &&
          row.author_principal_id === request.principalId &&
          row.author_actant_id === request.actantId,
      );
    }, true);
  }

  async verifyCommittedReview(request: {
    tenantId: string;
    principalId: string;
    actantId: string;
    runtimeInputId: string | null;
    runtimeTaskRunEventId?: string | null;
    productionId: string;
    title: string;
    versionRef: string;
    receiptId: string;
  }): Promise<boolean> {
    return this.transaction(async (q) => {
      const rows = await q.all<Row>(
        "SELECT p.title,p.activity_revision,r.input_id,r.task_run_event_id,r.result_version_ref,v.author_principal_id,v.author_actant_id,v.resolved_by_principal_id,v.resolved_by_actant_id,r.operation FROM script_command_receipts r JOIN script_outbox o ON o.tenant_id=r.tenant_id AND o.event_id=r.command_id AND o.production_id=? AND o.version_ref=r.result_version_ref AND o.event_kind='script.review-changed' AND o.object_id=r.result_object_id JOIN script_productions p ON p.tenant_id=o.tenant_id AND p.production_id=o.production_id JOIN script_reviews v ON v.tenant_id=o.tenant_id AND (v.review_id=o.object_id OR (r.operation='submit-reviews' AND v.command_id=r.command_id)) JOIN script_items i ON i.tenant_id=v.tenant_id AND i.item_id=v.item_id AND i.production_id=p.production_id WHERE r.tenant_id=? AND r.command_id=? AND ((r.operation IN ('add-review','submit-reviews') AND v.created_at=r.committed_at AND (v.input_id=r.input_id OR (v.input_id IS NULL AND r.input_id IS NULL))) OR (r.operation='resolve-review' AND v.resolved_at=r.committed_at)) AND p.deleted_at IS NULL",
        [request.productionId, request.tenantId, request.receiptId],
      );
      rows.push(
        ...(await q.all<Row>(
          `SELECT p.title,p.activity_revision,r.input_id,r.task_run_event_id,r.result_version_ref,
          report.author_principal_id,report.author_actant_id,NULL AS resolved_by_principal_id,NULL AS resolved_by_actant_id,r.operation
        FROM script_check_reports report
        JOIN script_command_receipts r ON r.tenant_id=report.tenant_id AND r.command_id=report.command_id
          AND r.operation='submit-reviews' AND r.input_id=report.input_id AND r.result_object_id=report.command_id AND r.committed_at=report.created_at
        JOIN script_outbox o ON o.tenant_id=r.tenant_id AND o.event_id=r.command_id AND o.production_id=report.production_id
          AND o.version_ref=r.result_version_ref AND o.event_kind='script.review-changed' AND o.object_id=r.result_object_id
        JOIN script_productions p ON p.tenant_id=report.tenant_id AND p.production_id=report.production_id
        WHERE report.tenant_id=? AND report.command_id=? AND report.production_id=? AND report.purpose IN ('continuity','impact') AND p.deleted_at IS NULL`,
          [request.tenantId, request.receiptId, request.productionId],
        )),
      );
      return rows.some(
        (row) =>
          row.title === request.title &&
          String(row.activity_revision) === request.versionRef &&
          row.result_version_ref === request.versionRef &&
          row.input_id === request.runtimeInputId &&
          row.task_run_event_id === (request.runtimeTaskRunEventId ?? null) &&
          (row.operation === "add-review" || row.operation === "submit-reviews"
            ? row.author_principal_id === request.principalId &&
              row.author_actant_id === request.actantId
            : row.resolved_by_principal_id === request.principalId &&
              row.resolved_by_actant_id === request.actantId),
      );
    }, true);
  }

  /** Platform can refresh a production directory only from this committed
   * app command, never from a caller-provided item ID or activity number.
   */
  async verifyCommittedItemCreation(request: {
    tenantId: string;
    principalId: string;
    actantId: string;
    runtimeInputId: string | null;
    runtimeTaskRunEventId?: string | null;
    productionId: string;
    title: string;
    versionRef: string;
    receiptId: string;
  }): Promise<boolean> {
    return this.transaction(async (q) => {
      const rows = await q.all<{
        title: string;
        activity_revision: number | string;
        input_id: string | null;
        task_run_event_id: string | null;
        result_version_ref: string;
        author_principal_id: string;
        author_actant_id: string;
      }>(
        "SELECT p.title,p.activity_revision,r.input_id,r.task_run_event_id,r.result_version_ref,v.author_principal_id,v.author_actant_id FROM script_command_receipts r JOIN script_outbox o ON o.tenant_id=r.tenant_id AND o.event_id=r.command_id AND o.production_id=? AND o.object_id=r.result_object_id AND o.version_ref=r.result_version_ref AND o.event_kind='script.item-created' JOIN script_productions p ON p.tenant_id=o.tenant_id AND p.production_id=o.production_id JOIN script_items i ON i.tenant_id=p.tenant_id AND i.production_id=p.production_id AND i.item_id=r.result_object_id JOIN script_item_versions v ON v.tenant_id=i.tenant_id AND v.item_id=i.item_id AND v.revision=1 WHERE r.tenant_id=? AND r.command_id=? AND r.operation='create-item' AND p.deleted_at IS NULL",
        [request.productionId, request.tenantId, request.receiptId],
      );
      return (
        rows.length === 1 &&
        rows[0]!.title === request.title &&
        String(rows[0]!.activity_revision) === request.versionRef &&
        rows[0]!.result_version_ref === request.versionRef &&
        rows[0]!.input_id === request.runtimeInputId &&
        rows[0]!.task_run_event_id ===
          (request.runtimeTaskRunEventId ?? null) &&
        rows[0]!.author_principal_id === request.principalId &&
        rows[0]!.author_actant_id === request.actantId
      );
    }, true);
  }

  /** A directory revision is proved by the exact Human-authored immutable
   * item version and its outbox event, not by a caller's claimed activity ID.
   */
  async verifyCommittedItemRevision(request: {
    tenantId: string;
    principalId: string;
    actantId: string;
    runtimeInputId: string | null;
    runtimeTaskRunEventId?: string | null;
    productionId: string;
    title: string;
    versionRef: string;
    receiptId: string;
  }): Promise<boolean> {
    return this.transaction(async (q) => {
      const rows = await q.all<{
        title: string;
        activity_revision: number | string;
        input_id: string | null;
        task_run_event_id: string | null;
        event_version_ref: string;
        author_principal_id: string;
        author_actant_id: string;
      }>(
        "SELECT p.title,p.activity_revision,r.input_id,r.task_run_event_id,o.version_ref AS event_version_ref,v.author_principal_id,v.author_actant_id FROM script_command_receipts r JOIN script_outbox o ON o.tenant_id=r.tenant_id AND o.event_id=r.command_id AND o.production_id=? AND o.version_ref=? AND o.event_kind='script.item-revised' JOIN script_productions p ON p.tenant_id=o.tenant_id AND p.production_id=o.production_id JOIN script_items i ON i.tenant_id=p.tenant_id AND i.production_id=p.production_id AND i.item_id=r.result_object_id AND o.object_id=i.item_id JOIN script_item_versions v ON v.tenant_id=i.tenant_id AND v.item_id=i.item_id AND v.revision=CAST(r.result_version_ref AS BIGINT) WHERE r.tenant_id=? AND r.command_id=? AND r.operation='revise-item' AND p.deleted_at IS NULL",
        [
          request.productionId,
          request.versionRef,
          request.tenantId,
          request.receiptId,
        ],
      );
      return (
        rows.length === 1 &&
        rows[0]!.title === request.title &&
        String(rows[0]!.activity_revision) === request.versionRef &&
        rows[0]!.event_version_ref === request.versionRef &&
        rows[0]!.input_id === request.runtimeInputId &&
        rows[0]!.task_run_event_id ===
          (request.runtimeTaskRunEventId ?? null) &&
        rows[0]!.author_principal_id === request.principalId &&
        rows[0]!.author_actant_id === request.actantId
      );
    }, true);
  }

  /** A Platform refresh proof is an actual committed decision, never a
   * caller-supplied candidate number or stale directory snapshot.
   */
  async verifyCommittedCandidateDecision(request: {
    tenantId: string;
    principalId: string;
    actantId: string;
    runtimeInputId: string | null;
    runtimeTaskRunEventId?: string | null;
    productionId: string;
    title: string;
    versionRef: string;
    receiptId: string;
  }): Promise<boolean> {
    return this.transaction(async (q) => {
      const rows = await q.all<{
        title: string;
        activity_revision: number | string;
        input_id: string | null;
        task_run_event_id: string | null;
        result_version_ref: string;
        decided_by_principal_id: string | null;
        decided_by_actant_id: string | null;
      }>(
        "SELECT p.title,p.activity_revision,r.input_id,r.task_run_event_id,r.result_version_ref,c.decided_by_principal_id,c.decided_by_actant_id FROM script_command_receipts r JOIN script_outbox o ON o.tenant_id=r.tenant_id AND o.event_id=r.command_id AND o.production_id=? AND o.object_id=? AND o.version_ref=r.result_version_ref AND o.event_kind='script.candidate-decided' JOIN script_productions p ON p.tenant_id=o.tenant_id AND p.production_id=o.production_id JOIN script_candidates c ON c.tenant_id=r.tenant_id AND c.candidate_id=r.result_object_id AND c.production_id=p.production_id WHERE r.tenant_id=? AND r.command_id=? AND ((r.operation='decide-candidate:accept' AND c.status='accepted') OR (r.operation='decide-candidate:reject' AND c.status='rejected')) AND p.deleted_at IS NULL",
        [
          request.productionId,
          request.productionId,
          request.tenantId,
          request.receiptId,
        ],
      );
      return (
        rows.length === 1 &&
        rows[0]!.title === request.title &&
        String(rows[0]!.activity_revision) === request.versionRef &&
        rows[0]!.result_version_ref === request.versionRef &&
        rows[0]!.input_id === request.runtimeInputId &&
        rows[0]!.task_run_event_id ===
          (request.runtimeTaskRunEventId ?? null) &&
        rows[0]!.decided_by_principal_id === request.principalId &&
        rows[0]!.decided_by_actant_id === request.actantId
      );
    }, true);
  }

  async verifyCommittedCandidateSubmission(request: {
    tenantId: string;
    principalId: string;
    actantId: string;
    runtimeInputId: string | null;
    runtimeTaskRunEventId?: string | null;
    productionId: string;
    title: string;
    versionRef: string;
    receiptId: string;
  }): Promise<boolean> {
    return this.transaction(async (q) => {
      const rows = await q.all<Row>(
        "SELECT p.title,p.activity_revision,r.input_id,r.task_run_event_id,r.result_version_ref,c.created_by_principal_id,c.created_by_actant_id FROM script_command_receipts r JOIN script_outbox o ON o.tenant_id=r.tenant_id AND o.event_id=r.command_id AND o.production_id=? AND o.object_id=? AND o.version_ref=r.result_version_ref AND o.event_kind='script.candidate-submitted' JOIN script_productions p ON p.tenant_id=o.tenant_id AND p.production_id=o.production_id JOIN script_candidates c ON c.tenant_id=r.tenant_id AND c.candidate_id=r.result_object_id AND c.production_id=p.production_id WHERE r.tenant_id=? AND r.command_id=? AND r.operation='submit-candidate' AND p.deleted_at IS NULL",
        [
          request.productionId,
          request.productionId,
          request.tenantId,
          request.receiptId,
        ],
      );
      return (
        rows.length === 1 &&
        rows[0]!.title === request.title &&
        String(rows[0]!.activity_revision) === request.versionRef &&
        rows[0]!.result_version_ref === request.versionRef &&
        rows[0]!.input_id === request.runtimeInputId &&
        rows[0]!.task_run_event_id ===
          (request.runtimeTaskRunEventId ?? null) &&
        rows[0]!.created_by_principal_id === request.principalId &&
        rows[0]!.created_by_actant_id === request.actantId
      );
    }, true);
  }

  async markDirectoryProjected(tenantId: string, eventId: string) {
    requireDomainId(tenantId, "租户 ID");
    requireDomainId(eventId, "事件 ID");
    return this.transaction(async (q) => {
      const changed = await q.change(
        "UPDATE script_outbox SET delivered_at=? WHERE tenant_id=? AND event_id=? AND delivered_at IS NULL",
        [new Date().toISOString(), tenantId, eventId],
      );
      if (changed) return;
      const rows = await q.all(
        "SELECT 1 AS present FROM script_outbox WHERE tenant_id=? AND event_id=? AND delivered_at IS NOT NULL",
        [tenantId, eventId],
      );
      if (!rows.length) throw new Error("剧本目录投影事件不存在。");
    });
  }

  async directoryEventProjected(tenantId: string, eventId: string) {
    requireDomainId(tenantId, "租户 ID");
    requireDomainId(eventId, "事件 ID");
    return this.transaction(async (q) => {
      const rows = await q.all<{ delivered_at: string | null }>(
        "SELECT delivered_at FROM script_outbox WHERE tenant_id=? AND event_id=?",
        [tenantId, eventId],
      );
      if (rows.length !== 1) throw new Error("剧本目录投影事件不存在。");
      return rows[0]!.delivered_at !== null;
    }, true);
  }

  /** Internal recovery feed. Platform must verify each event's exact
   * committed App receipt before it changes the directory.
   */
  async pendingDirectoryEvents(
    tenantId: string,
    limit = 100,
    after?: { createdAt: string; eventId: string },
  ) {
    requireDomainId(tenantId, "租户 ID");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("目录待投影分页大小无效。");
    if (after) requireDomainId(after.eventId, "目录事件 ID");
    return this.transaction(
      (q) =>
        q.all<{
          event_id: string;
          production_id: string;
          version_ref: string;
          requested_project_id: string | null;
          input_id: string | null;
          task_run_event_id: string | null;
          owner_principal_id: string;
          created_by_actant_id: string;
          title: string;
          created_at: string;
        }>(
          `SELECT o.event_id,o.production_id,o.version_ref,o.requested_project_id,r.input_id,r.task_run_event_id,p.owner_principal_id,p.created_by_actant_id,m.title,o.created_at FROM script_outbox o JOIN script_command_receipts r ON r.tenant_id=o.tenant_id AND r.command_id=o.event_id JOIN script_productions p ON p.tenant_id=o.tenant_id AND p.production_id=o.production_id JOIN script_metadata_versions m ON m.tenant_id=o.tenant_id AND m.production_id=o.production_id AND m.revision=1 WHERE o.tenant_id=? AND o.event_kind='script.created' AND o.delivered_at IS NULL${after ? " AND (o.created_at>? OR (o.created_at=? AND o.event_id>?))" : ""} ORDER BY o.created_at,o.event_id LIMIT ?`,
          after
            ? [tenantId, after.createdAt, after.createdAt, after.eventId, limit]
            : [tenantId, limit],
        ),
      true,
    );
  }

  async pendingCandidateDirectoryEvents(
    tenantId: string,
    limit = 100,
    after?: { createdAt: string; eventId: string },
  ) {
    requireDomainId(tenantId, "租户 ID");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("目录待投影分页大小无效。");
    if (after) requireDomainId(after.eventId, "目录事件 ID");
    return this.transaction(
      (q) =>
        q.all<{
          event_id: string;
          production_id: string;
          candidate_id: string;
          candidate_revision: number | string;
          operation: string;
          version_ref: string;
          title: string;
          principal_id: string;
          actant_id: string;
          input_id: string | null;
          task_run_event_id: string | null;
          created_at: string;
        }>(
          `SELECT o.event_id,o.production_id,c.candidate_id,c.candidate_revision,r.operation,o.version_ref,p.title,CASE WHEN r.operation='submit-candidate' THEN c.created_by_principal_id ELSE c.decided_by_principal_id END AS principal_id,CASE WHEN r.operation='submit-candidate' THEN c.created_by_actant_id ELSE c.decided_by_actant_id END AS actant_id,r.input_id,r.task_run_event_id,o.created_at FROM script_outbox o JOIN script_command_receipts r ON r.tenant_id=o.tenant_id AND r.command_id=o.event_id JOIN script_candidates c ON c.tenant_id=r.tenant_id AND c.candidate_id=r.result_object_id JOIN script_productions p ON p.tenant_id=o.tenant_id AND p.production_id=o.production_id WHERE o.tenant_id=? AND o.event_kind IN ('script.candidate-submitted','script.candidate-decided') AND o.delivered_at IS NULL${after ? " AND (o.created_at>? OR (o.created_at=? AND o.event_id>?))" : ""} ORDER BY o.created_at,o.event_id LIMIT ?`,
          after
            ? [tenantId, after.createdAt, after.createdAt, after.eventId, limit]
            : [tenantId, limit],
        ),
      true,
    );
  }

  async pendingItemDirectoryEvents(
    tenantId: string,
    limit = 100,
    after?: { createdAt: string; eventId: string },
  ) {
    requireDomainId(tenantId, "租户 ID");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("目录待投影分页大小无效。");
    if (after) requireDomainId(after.eventId, "目录事件 ID");
    return this.transaction(
      (q) =>
        q.all<{
          event_id: string;
          production_id: string;
          item_id: string;
          kind: string;
          version_ref: string;
          title: string;
          input_id: string | null;
          task_run_event_id: string | null;
          principal_id: string;
          actant_id: string;
          created_at: string;
        }>(
          `SELECT o.event_id,o.production_id,i.item_id,i.kind,o.version_ref,p.title,r.input_id,r.task_run_event_id,v.author_principal_id AS principal_id,v.author_actant_id AS actant_id,o.created_at FROM script_outbox o JOIN script_command_receipts r ON r.tenant_id=o.tenant_id AND r.command_id=o.event_id JOIN script_productions p ON p.tenant_id=o.tenant_id AND p.production_id=o.production_id JOIN script_items i ON i.tenant_id=o.tenant_id AND i.production_id=o.production_id AND i.item_id=o.object_id JOIN script_item_versions v ON v.tenant_id=i.tenant_id AND v.item_id=i.item_id AND v.revision=CASE WHEN o.event_kind='script.item-created' THEN 1 ELSE CAST(r.result_version_ref AS BIGINT) END WHERE o.tenant_id=? AND o.delivered_at IS NULL AND ((o.event_kind='script.item-created' AND r.operation='create-item') OR (o.event_kind='script.item-revised' AND r.operation='revise-item'))${after ? " AND (o.created_at>? OR (o.created_at=? AND o.event_id>?))" : ""} ORDER BY o.created_at,o.event_id LIMIT ?`,
          after
            ? [tenantId, after.createdAt, after.createdAt, after.eventId, limit]
            : [tenantId, limit],
        ),
      true,
    );
  }

  async pendingProductionUpdates(
    tenantId: string,
    limit = 100,
    after?: { createdAt: string; eventId: string },
  ) {
    requireDomainId(tenantId, "租户 ID");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("目录待投影分页大小无效。");
    if (after) requireDomainId(after.eventId, "目录事件 ID");
    return this.transaction(
      (q) =>
        q.all<{
          event_id: string;
          production_id: string;
          version_ref: string;
          title: string;
          input_id: string | null;
          task_run_event_id: string | null;
          principal_id: string;
          actant_id: string;
          created_at: string;
        }>(
          `SELECT o.event_id,o.production_id,o.version_ref,m.title,r.input_id,r.task_run_event_id,m.author_principal_id AS principal_id,m.author_actant_id AS actant_id,o.created_at FROM script_outbox o JOIN script_command_receipts r ON r.tenant_id=o.tenant_id AND r.command_id=o.event_id AND r.operation IN ('update-production','rename-production') JOIN script_productions p ON p.tenant_id=o.tenant_id AND p.production_id=o.production_id JOIN script_metadata_versions m ON m.tenant_id=p.tenant_id AND m.production_id=p.production_id AND m.revision=p.metadata_revision WHERE o.tenant_id=? AND o.event_kind='script.updated' AND o.delivered_at IS NULL${after ? " AND (o.created_at>? OR (o.created_at=? AND o.event_id>?))" : ""} ORDER BY o.created_at,o.event_id LIMIT ?`,
          after
            ? [tenantId, after.createdAt, after.createdAt, after.eventId, limit]
            : [tenantId, limit],
        ),
      true,
    );
  }

  async pendingExportDirectoryEvents(
    tenantId: string,
    limit = 100,
    after?: { createdAt: string; eventId: string },
  ) {
    requireDomainId(tenantId, "租户 ID");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("目录待投影分页大小无效。");
    if (after) requireDomainId(after.eventId, "目录事件 ID");
    return this.transaction(
      (q) =>
        q.all<{
          event_id: string;
          production_id: string;
          version_ref: string;
          title: string;
          input_id: string | null;
          task_run_event_id: string | null;
          principal_id: string;
          actant_id: string;
          created_at: string;
        }>(
          `SELECT o.event_id,o.production_id,o.version_ref,p.title,r.input_id,r.task_run_event_id,e.created_by_principal_id AS principal_id,e.created_by_actant_id AS actant_id,o.created_at FROM script_outbox o JOIN script_command_receipts r ON r.tenant_id=o.tenant_id AND r.command_id=o.event_id AND r.operation='record-export' JOIN script_productions p ON p.tenant_id=o.tenant_id AND p.production_id=o.production_id JOIN script_exports e ON e.tenant_id=o.tenant_id AND e.production_id=o.production_id AND e.export_id=o.object_id WHERE o.tenant_id=? AND o.event_kind='script.export-recorded' AND o.delivered_at IS NULL${after ? " AND (o.created_at>? OR (o.created_at=? AND o.event_id>?))" : ""} ORDER BY o.created_at,o.event_id LIMIT ?`,
          after
            ? [tenantId, after.createdAt, after.createdAt, after.eventId, limit]
            : [tenantId, limit],
        ),
      true,
    );
  }

  async pendingWorkflowDirectoryEvents(
    tenantId: string,
    limit = 100,
    after?: { createdAt: string; eventId: string },
  ) {
    requireDomainId(tenantId, "租户 ID");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("目录待投影分页大小无效。");
    if (after) requireDomainId(after.eventId, "目录事件 ID");
    return this.transaction(
      (q) =>
        q.all<{
          event_id: string;
          production_id: string;
          version_ref: string;
          title: string;
          input_id: string | null;
          task_run_event_id: string | null;
          principal_id: string;
          actant_id: string;
          created_at: string;
        }>(
          `SELECT o.event_id,o.production_id,o.version_ref,p.title,r.input_id,r.task_run_event_id,e.author_principal_id AS principal_id,e.author_actant_id AS actant_id,o.created_at FROM script_outbox o JOIN script_command_receipts r ON r.tenant_id=o.tenant_id AND r.command_id=o.event_id AND r.result_object_id=o.object_id JOIN script_productions p ON p.tenant_id=o.tenant_id AND p.production_id=o.production_id JOIN script_item_events e ON e.tenant_id=o.tenant_id AND e.item_id=o.object_id AND e.created_at=r.committed_at AND ((r.operation='submit-review' AND e.action='submit') OR (r.operation='review-decision' AND e.action IN ('approve','request-changes')) OR (r.operation='lock-item' AND e.action='lock') OR (r.operation='unlock-item' AND e.action='unlock')) WHERE o.tenant_id=? AND o.event_kind='script.workflow-changed' AND o.delivered_at IS NULL${after ? " AND (o.created_at>? OR (o.created_at=? AND o.event_id>?))" : ""} ORDER BY o.created_at,o.event_id LIMIT ?`,
          after
            ? [tenantId, after.createdAt, after.createdAt, after.eventId, limit]
            : [tenantId, limit],
        ),
      true,
    );
  }

  async pendingReviewDirectoryEvents(
    tenantId: string,
    limit = 100,
    after?: { createdAt: string; eventId: string },
  ) {
    requireDomainId(tenantId, "租户 ID");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("目录待投影分页大小无效。");
    if (after) requireDomainId(after.eventId, "目录事件 ID");
    return this.transaction(
      (q) =>
        q.all<{
          event_id: string;
          production_id: string;
          version_ref: string;
          title: string;
          input_id: string | null;
          task_run_event_id: string | null;
          principal_id: string;
          actant_id: string;
          created_at: string;
        }>(
          `WITH proofs AS (
            SELECT o.event_id,o.production_id,o.version_ref,p.title,r.input_id,r.task_run_event_id,
              CASE WHEN r.operation='resolve-review' THEN v.resolved_by_principal_id ELSE v.author_principal_id END AS principal_id,
              CASE WHEN r.operation='resolve-review' THEN v.resolved_by_actant_id ELSE v.author_actant_id END AS actant_id,o.created_at
            FROM script_outbox o JOIN script_command_receipts r ON r.tenant_id=o.tenant_id AND r.command_id=o.event_id
              AND r.result_object_id=o.object_id AND r.result_version_ref=o.version_ref
            JOIN script_productions p ON p.tenant_id=o.tenant_id AND p.production_id=o.production_id
            JOIN script_reviews v ON v.tenant_id=o.tenant_id AND (v.review_id=o.object_id OR (r.operation='submit-reviews' AND v.command_id=r.command_id))
            JOIN script_items i ON i.tenant_id=v.tenant_id AND i.item_id=v.item_id AND i.production_id=p.production_id
            WHERE o.tenant_id=? AND o.event_kind='script.review-changed' AND o.delivered_at IS NULL AND p.deleted_at IS NULL
              AND ((r.operation IN ('add-review','submit-reviews') AND v.created_at=r.committed_at
                AND (v.input_id=r.input_id OR (v.input_id IS NULL AND r.input_id IS NULL)))
                OR (r.operation='resolve-review' AND v.resolved_at=r.committed_at))
            UNION
            SELECT o.event_id,o.production_id,o.version_ref,p.title,r.input_id,r.task_run_event_id,report.author_principal_id,report.author_actant_id,o.created_at
            FROM script_check_reports report JOIN script_command_receipts r ON r.tenant_id=report.tenant_id
              AND r.command_id=report.command_id AND r.operation='submit-reviews'
              AND r.input_id=report.input_id AND r.result_object_id=report.command_id AND r.committed_at=report.created_at
            JOIN script_outbox o ON o.tenant_id=r.tenant_id AND o.event_id=r.command_id AND o.production_id=report.production_id
              AND o.object_id=r.result_object_id AND o.version_ref=r.result_version_ref
            JOIN script_productions p ON p.tenant_id=report.tenant_id AND p.production_id=report.production_id
            WHERE report.tenant_id=? AND report.purpose IN ('continuity','impact') AND p.deleted_at IS NULL
              AND o.event_kind='script.review-changed' AND o.delivered_at IS NULL
          ) SELECT * FROM proofs WHERE 1=1${after ? " AND (created_at>? OR (created_at=? AND event_id>?))" : ""} ORDER BY created_at,event_id LIMIT ?`,
          after
            ? [
                tenantId,
                tenantId,
                after.createdAt,
                after.createdAt,
                after.eventId,
                limit,
              ]
            : [tenantId, tenantId, limit],
        ),
      true,
    );
  }

  /** The report and its findings/candidate share the domain receipt transaction.
   * No findings is a saved result, not an invented review or approval. */
  private async insertWorkflowReport(
    q: SqlQuery,
    actor: NonNullable<
      Awaited<ReturnType<ScriptStudioAuthority["authorizeObject"]>>
    >,
    commandId: string,
    productionId: string,
    inputId: string,
    purpose: ScriptGeneration["purpose"],
    report: ScriptWorkflowReport | undefined,
    createdAt: string,
  ) {
    if (!report) return;
    await insert(q, "script_check_reports", {
      tenant_id: actor.tenantId,
      command_id: commandId,
      production_id: productionId,
      input_id: inputId,
      purpose,
      explanation: report.explanation,
      checks_json: JSON.stringify(report.checks),
      author_principal_id: actor.principalId,
      author_actant_id: actor.actantId,
      created_at: createdAt,
    });
  }

  private async insertResolvedDraft(
    q: SqlQuery,
    tenantId: string,
    productionId: string,
    draftId: string,
    draft: LiveScriptDraft,
    createdAt: string,
  ) {
    await insert(q, "script_drafts", {
      tenant_id: tenantId,
      production_id: productionId,
      draft_id: draftId,
      title: draft.title,
      body_text: draft.text,
      parent_item_id: draft.parentId,
      order_index: draft.order,
      basis: draft.basis,
      location_text: draft.location,
      story_time: draft.storyTime,
      audience_knowledge: draft.audienceKnowledge,
      character_knowledge: draft.characterKnowledge,
      setup_payoff: draft.setupPayoff,
      production_notes: draft.productionNotes,
      created_at: createdAt,
    });
    for (const [ordinal, source] of draft.sources.entries()) {
      await insert(q, "script_draft_sources", {
        tenant_id: tenantId,
        draft_id: draftId,
        ordinal,
        source_app_id: source.appId,
        source_instance_id: source.instanceId,
        source_object_id: source.objectId,
        source_version_ref: source.versionRef,
        quote_text: source.quote,
      });
    }
    for (const [ordinal, dependency] of draft.dependencies.entries())
      await insert(q, "script_draft_dependencies", {
        tenant_id: tenantId,
        draft_id: draftId,
        ordinal,
        depends_on_item_id: dependency.itemId,
        depends_on_revision: dependency.revision,
      });
    for (const [ordinal, characterId] of draft.characters.entries())
      await insert(q, "script_draft_characters", {
        tenant_id: tenantId,
        draft_id: draftId,
        ordinal,
        character_item_id: characterId,
      });
  }

  /** Read one production for the existing editor. This is a bounded-by-ID
   * application projection, never a persisted workspace snapshot. Platform
   * supplies the live owner and the app rechecks authorization after reading.
   */
  async readProduction(request: {
    credential: string;
    productionId: string;
  }): Promise<ScriptProduction> {
    const productionId = requireDomainId(request.productionId, "剧本 ID");
    return this.authorizedRead(request.credential, productionId, (q, actor) =>
      this.productionSnapshot(
        q,
        actor.tenantId,
        productionId,
        actor.projectId,
        true,
      ),
    );
  }

  private async productionSnapshot(
    q: SqlQuery,
    tenantId: string,
    productionId: string,
    projectId: string,
    includeActivityRevision = false,
  ): Promise<ScriptProduction> {
    const production = (
      await q.all<Row>(
        "SELECT * FROM script_productions WHERE tenant_id=? AND production_id=? AND deleted_at IS NULL",
        [tenantId, productionId],
      )
    )[0];
    if (!production) throw new Error("剧本原件不存在。");
    const reviewerRows = await q.all<Row>(
      "SELECT * FROM script_reviewers WHERE tenant_id=? AND production_id=? ORDER BY ordinal",
      [tenantId, productionId],
    );
    const metadataRows = await q.all<Row>(
      "SELECT * FROM script_metadata_versions WHERE tenant_id=? AND production_id=? ORDER BY collection_ordinal",
      [tenantId, productionId],
    );
    const metadataReviewerRows = await q.all<Row>(
      "SELECT * FROM script_metadata_reviewers WHERE tenant_id=? AND production_id=? ORDER BY revision,ordinal",
      [tenantId, productionId],
    );
    const itemRows = await q.all<Row>(
      "SELECT * FROM script_items WHERE tenant_id=? AND production_id=? ORDER BY collection_ordinal",
      [tenantId, productionId],
    );
    const versionRows = await q.all<Row>(
      "SELECT v.* FROM script_item_versions v JOIN script_items i ON i.tenant_id=v.tenant_id AND i.item_id=v.item_id WHERE i.tenant_id=? AND i.production_id=? ORDER BY i.collection_ordinal,v.collection_ordinal",
      [tenantId, productionId],
    );
    const approvalRows = await q.all<Row>(
      "SELECT a.* FROM script_item_approvals a JOIN script_items i ON i.tenant_id=a.tenant_id AND i.item_id=a.item_id WHERE i.tenant_id=? AND i.production_id=?",
      [tenantId, productionId],
    );
    const eventRows = await q.all<Row>(
      "SELECT e.* FROM script_item_events e JOIN script_items i ON i.tenant_id=e.tenant_id AND i.item_id=e.item_id WHERE i.tenant_id=? AND i.production_id=? ORDER BY i.collection_ordinal,e.ordinal",
      [tenantId, productionId],
    );
    const draftRows = await q.all<Row>(
      "SELECT * FROM script_drafts WHERE tenant_id=? AND production_id=?",
      [tenantId, productionId],
    );
    const sourceRows = await q.all<Row>(
      "SELECT s.* FROM script_draft_sources s JOIN script_drafts d ON d.tenant_id=s.tenant_id AND d.draft_id=s.draft_id WHERE d.tenant_id=? AND d.production_id=? ORDER BY s.draft_id,s.ordinal",
      [tenantId, productionId],
    );
    const dependencyRows = await q.all<Row>(
      "SELECT r.* FROM script_draft_dependencies r JOIN script_drafts d ON d.tenant_id=r.tenant_id AND d.draft_id=r.draft_id WHERE d.tenant_id=? AND d.production_id=? ORDER BY r.draft_id,r.ordinal",
      [tenantId, productionId],
    );
    const characterRows = await q.all<Row>(
      "SELECT r.* FROM script_draft_characters r JOIN script_drafts d ON d.tenant_id=r.tenant_id AND d.draft_id=r.draft_id WHERE d.tenant_id=? AND d.production_id=? ORDER BY r.draft_id,r.ordinal",
      [tenantId, productionId],
    );
    const candidateRows = await q.all<Row>(
      "SELECT * FROM script_candidates WHERE tenant_id=? AND production_id=? ORDER BY collection_ordinal",
      [tenantId, productionId],
    );
    const candidateReferenceRows = await q.all<Row>(
      "SELECT r.* FROM script_candidate_references r JOIN script_candidates c ON c.tenant_id=r.tenant_id AND c.candidate_id=r.candidate_id WHERE c.tenant_id=? AND c.production_id=? ORDER BY c.collection_ordinal,r.ordinal",
      [tenantId, productionId],
    );
    const reviewRows = await q.all<Row>(
      "SELECT r.* FROM script_reviews r JOIN script_items i ON i.tenant_id=r.tenant_id AND i.item_id=r.item_id WHERE i.tenant_id=? AND i.production_id=? ORDER BY r.collection_ordinal",
      [tenantId, productionId],
    );
    const exportRows = await q.all<Row>(
      "SELECT * FROM script_exports WHERE tenant_id=? AND production_id=? ORDER BY collection_ordinal",
      [tenantId, productionId],
    );
    const exportItemRows = await q.all<Row>(
      "SELECT r.* FROM script_export_items r JOIN script_exports e ON e.tenant_id=r.tenant_id AND e.export_id=r.export_id WHERE e.tenant_id=? AND e.production_id=? ORDER BY e.collection_ordinal,r.ordinal",
      [tenantId, productionId],
    );
    const indexes = new WeakMap<Row[], Map<string, Row[]>>();
    const grouped = (rows: Row[], key: string, id: string) => {
      let index = indexes.get(rows);
      if (!index) {
        index = new Map();
        for (const row of rows) {
          const group = String(row[key]);
          const values = index.get(group) ?? [];
          values.push(row);
          index.set(group, values);
        }
        indexes.set(rows, index);
      }
      return index.get(id) ?? [];
    };
    const author = (row: Row, prefix: string) => ({
      principalId: String(row[`${prefix}_principal_id`]),
      actantId: String(row[`${prefix}_actant_id`]),
    });
    const drafts = new Map<string, ScriptDraft>();
    for (const row of draftRows) {
      const draftId = String(row.draft_id);
      drafts.set(draftId, {
        title: String(row.title),
        text: String(row.body_text),
        parentId:
          row.parent_item_id === null ? null : String(row.parent_item_id),
        order: safeInteger(row.order_index as number | string, "条目顺序"),
        basis: row.basis as ScriptDraft["basis"],
        sources: grouped(sourceRows, "draft_id", draftId).map((source) => ({
          artifactId: String(source.source_object_id),
          revision: safeInteger(
            source.source_version_ref as string,
            "来源版本",
          ),
          quote: String(source.quote_text),
        })),
        dependencies: grouped(dependencyRows, "draft_id", draftId).map(
          (dependency) => ({
            itemId: String(dependency.depends_on_item_id),
            revision: safeInteger(
              dependency.depends_on_revision as number | string,
              "依赖版本",
            ),
          }),
        ),
        location: String(row.location_text),
        storyTime: String(row.story_time),
        characters: grouped(characterRows, "draft_id", draftId).map(
          (character) => String(character.character_item_id),
        ),
        audienceKnowledge: String(row.audience_knowledge),
        characterKnowledge: String(row.character_knowledge),
        setupPayoff: String(row.setup_payoff),
        productionNotes: String(row.production_notes),
      });
    }
    const requireDraft = (id: string) => {
      const draft = drafts.get(id);
      if (!draft) throw new Error("剧本文稿缺失，拒绝读取不完整对象。");
      return draft;
    };
    return scriptProductionSchema.parse({
      id: productionId,
      projectId,
      title: production.title,
      revision: safeInteger(
        production.metadata_revision as number | string,
        "元数据修订",
      ),
      ...(includeActivityRevision
        ? {
            activityRevision: safeInteger(
              production.activity_revision as number | string,
              "剧本活动修订",
            ),
          }
        : {}),
      brief: readBrief(production),
      reviewerPrincipalIds: reviewerRows.map((r) => String(r.principal_id)),
      createdBy: author(production, "created_by"),
      createdAt: production.created_at,
      updatedAt: production.updated_at,
      items: itemRows.map((item) => {
        const itemId = String(item.item_id);
        const approval = grouped(approvalRows, "item_id", itemId)[0];
        return {
          id: itemId,
          kind: item.kind,
          revision: safeInteger(
            item.head_revision as number | string,
            "条目修订",
          ),
          workflowRevision: safeInteger(
            item.workflow_revision as number | string,
            "流程修订",
          ),
          status: item.status,
          versions: grouped(versionRows, "item_id", itemId).map((version) => ({
            revision: safeInteger(
              version.revision as number | string,
              "正文版本",
            ),
            draft: requireDraft(String(version.draft_id)),
            author: author(version, "author"),
            createdAt: version.created_at,
            candidateId: version.candidate_id,
          })),
          approval: approval
            ? {
                revision: safeInteger(
                  approval.revision as number | string,
                  "审阅修订",
                ),
                author: author(approval, "author"),
                createdAt: approval.created_at,
                note: approval.note,
                contextRevision: safeInteger(
                  approval.context_revision as number | string,
                  "创作上下文修订",
                ),
              }
            : null,
          events: grouped(eventRows, "item_id", itemId).map((event) => ({
            action: event.action,
            revision: safeInteger(
              event.revision as number | string,
              "流程事件修订",
            ),
            author: author(event, "author"),
            createdAt: event.created_at,
            note: event.note,
          })),
        };
      }),
      candidates: candidateRows.map((candidate) => ({
        id: candidate.candidate_id,
        inputId: candidate.input_id,
        targetId: candidate.target_item_id,
        baseRevision: safeInteger(
          candidate.base_item_revision as number | string,
          "候选基准版本",
        ),
        contextRevision: safeInteger(
          candidate.context_revision as number | string,
          "候选上下文版本",
        ),
        references: grouped(
          candidateReferenceRows,
          "candidate_id",
          String(candidate.candidate_id),
        ).map((r) => ({
          itemId: String(r.item_id),
          revision: safeInteger(r.revision as number | string, "候选引用版本"),
        })),
        draft: requireDraft(String(candidate.draft_id)),
        explanation: candidate.explanation,
        createdBy: author(candidate, "created_by"),
        createdAt: candidate.created_at,
        revision: safeInteger(
          candidate.candidate_revision as number | string,
          "候选修订",
        ),
        status: candidate.status,
        decisionBy:
          candidate.decided_by_principal_id === null
            ? null
            : author(candidate, "decided_by"),
        decidedAt: candidate.decided_at,
      })),
      reviews: reviewRows.map((review) => ({
        id: review.review_id,
        itemId: review.item_id,
        itemRevision: safeInteger(
          review.item_revision as number | string,
          "审查对象版本",
        ),
        quote: review.quote_text,
        body: review.body_text,
        severity: review.severity,
        author: author(review, "author"),
        createdAt: review.created_at,
        inputId: review.input_id,
        ...(review.context_revision === null
          ? {}
          : {
              contextRevision: safeInteger(
                review.context_revision as number | string,
                "审查上下文修订",
              ),
            }),
        ...(review.historical_only === null
          ? {}
          : {
              historicalOnly: optionalBool(
                review.historical_only as number | string | null,
              ),
            }),
        revision: safeInteger(
          review.review_revision as number | string,
          "审查修订",
        ),
        resolvedBy:
          review.resolved_by_principal_id === null
            ? null
            : author(review, "resolved_by"),
        resolvedAt: review.resolved_at,
        resolution: review.resolution,
      })),
      template: readTemplate(production),
      metadataHistory: metadataRows.map((version) => ({
        revision: safeInteger(
          version.revision as number | string,
          "元数据版本",
        ),
        title: version.title,
        brief: readBrief(version),
        reviewerPrincipalIds: grouped(
          metadataReviewerRows,
          "revision",
          String(version.revision),
        ).map((row) => String(row.principal_id)),
        template: readTemplate(version),
        author: author(version, "author"),
        createdAt: version.created_at,
      })),
      exports: exportRows.map((exported) => ({
        id: exported.export_id,
        createdBy: author(exported, "created_by"),
        createdAt: exported.created_at,
        contextRevision: safeInteger(
          exported.context_revision as number | string,
          "导出上下文修订",
        ),
        items: grouped(
          exportItemRows,
          "export_id",
          String(exported.export_id),
        ).map((row) => ({
          itemId: String(row.item_id),
          revision: safeInteger(
            row.revision as number | string,
            "导出条目版本",
          ),
        })),
        template: readTemplate(exported),
        format: exported.format,
        ...(exported.working_copy === null
          ? {}
          : {
              workingCopy: optionalBool(
                exported.working_copy as number | string | null,
              ),
            }),
      })),
    });
  }
}
