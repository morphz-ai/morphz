import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import {
  artifactSchema,
  contentSchema,
  DomainError,
  isPublicUnderstanding,
  quotedText,
  type Artifact,
  type Workspace,
} from "../../core/src/model.js";
import { contentText, searchTerms } from "../../core/src/retrieval.js";
import type { InteractiveContent } from "../../core/src/interactive.js";
import { interactiveRowOperationSchema } from "../../core/src/interactive.js";
import {
  interactivePointer,
  patchInteractiveContent,
  queryRows,
  readInteractiveContent,
  readInteractiveRoot,
  writeInteractiveContent,
} from "./interactive-storage.js";
import type {
  InteractiveRowsPage,
  InteractiveRowsPatch,
  InteractiveRowsRequest,
} from "./interactive-types.js";
export type {
  InteractiveRowsPage,
  InteractiveRowsPatch,
  InteractiveRowsRequest,
  InteractiveRowOperation,
  InteractiveSort,
} from "./interactive-types.js";
import { z } from "zod";
import {
  documentImportIssue,
  documentTextIssue,
} from "../../core/src/sources.js";
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
import { sqliteChangeSource, postgresChangeSource, type SqlChangeSource } from "../../storage/src/commit-notifications.js";
import { objectsSchemaSql } from "./schema.js";

const imageDigestIndexSql =
  "CREATE INDEX object_version_bytes_by_digest ON object_version_bytes(tenant_id, sha256, store_id, object_id, object_revision);";
const annotationOrderIndexSql =
  "CREATE INDEX object_annotations_by_object_order ON object_annotations(tenant_id, object_id, collection_ordinal);";
const searchProjectionMarker =
  "\n-- Search is an Objects-owned, disposable projection";
const interactiveSchemaMarker =
  "\n-- Interactive tables are an Objects-owned relational original.";
const interactiveSchemaOffset = objectsSchemaSql.indexOf(
  interactiveSchemaMarker,
);
if (interactiveSchemaOffset < 0) throw new Error("Objects 表格关系定义缺失。");
const objectsSchemaV4Sql = objectsSchemaSql.slice(0, interactiveSchemaOffset);
const interactiveSchemaSql = objectsSchemaSql.slice(
  interactiveSchemaOffset + 1,
);
const searchProjectionOffset = objectsSchemaSql.indexOf(searchProjectionMarker);
if (searchProjectionOffset < 0) throw new Error("Objects 搜索投影定义缺失。");
const objectsSchemaV3Sql = objectsSchemaSql.slice(0, searchProjectionOffset);
const searchProjectionSql = objectsSchemaV4Sql.slice(
  searchProjectionOffset + 1,
);
const objectsSchemaV2Sql = objectsSchemaV3Sql.replace(
  `${annotationOrderIndexSql}\n`,
  "",
);
const objectsSchemaV1Sql = objectsSchemaV2Sql.replace(
  `${imageDigestIndexSql}\n`,
  "",
);
if (
  objectsSchemaV1Sql === objectsSchemaV2Sql ||
  objectsSchemaV2Sql === objectsSchemaV3Sql
)
  throw new Error("Objects 图片摘要索引定义缺失。");

const sqliteSearchTables = [
  "object_search_fts",
  "object_search_fts_data",
  "object_search_fts_idx",
  "object_search_fts_docsize",
  "object_search_fts_config",
];

export class ObjectsConflictError extends Error {}

type Backend =
  | { kind: "sqlite"; database: DatabaseSync }
  | { kind: "postgres"; pool: Pool; schema: string };
type Row = Record<string, unknown>;
const digest = (body: string) =>
  createHash("sha256").update(body).digest("hex");
const domainId = /^[a-zA-Z0-9_-]{1,100}$/;
function requireDomainId(value: string, label: string) {
  if (typeof value !== "string" || !domainId.test(value))
    throw new Error(`${label}无效。`);
  return value;
}
type ObjectsActor = {
  tenantId: string;
  principalId: string;
  actantId: string;
  kind: "human" | "agent";
  runtimeInputId: string | null;
  runtimeTaskRunEventId?: string | null;
};
type AuthorizedDocument = ObjectsActor & {
  projectId: string;
  contentId: string;
  objectKind: string;
  observedVersionRef: string | null;
  catalogRevision: number;
};
export type ObjectsAuthority = {
  authorizeCreate(request: {
    credential: string;
    projectId: string;
  }): Promise<ObjectsActor>;
  authorizeDocumentRevision(request: {
    credential: string;
    objectId: string;
  }): Promise<AuthorizedDocument>;
  authorizeObjectRead(request: {
    credential: string;
    objectId: string;
  }): Promise<AuthorizedDocument>;
  authorizeByteRead(request: {
    credential: string;
    objectId: string;
  }): Promise<AuthorizedDocument>;
};
type DirectoryPayload = {
  projectId: string;
  contentId: string | null;
  expectedCatalogRevision: number | null;
  principalId: string;
  actantId: string;
  runtimeInputId: string | null;
  runtimeTaskRunEventId?: string;
};
function readDirectoryPayload(body: string): DirectoryPayload {
  const value = JSON.parse(body) as DirectoryPayload;
  requireDomainId(value.projectId, "目录项目 ID");
  requireDomainId(value.principalId, "目录用户 ID");
  requireDomainId(value.actantId, "目录执行者 ID");
  if (value.runtimeInputId !== null)
    requireDomainId(value.runtimeInputId, "目录输入 ID");
  if (value.runtimeTaskRunEventId !== undefined)
    requireDomainId(value.runtimeTaskRunEventId, "目录事项执行 ID");
  if (value.contentId !== null) requireDomainId(value.contentId, "目录内容 ID");
  if (
    value.expectedCatalogRevision !== null &&
    (!Number.isSafeInteger(value.expectedCatalogRevision) ||
      value.expectedCatalogRevision < 1)
  )
    throw new Error("目录修订无效。");
  return value;
}
export type DocumentCommit = {
  tenantId: string;
  objectId: string;
  projectId: string;
  title: string;
  versionRef: string;
  receiptId: string;
  eventId: string;
  contentId: string | null;
  expectedCatalogRevision: number | null;
};
export type ObjectsByteReference = {
  storeId: string;
  artifactId: string;
  revision: number;
  sha256: string;
  byteLength: number;
  mime: string;
};
export type ObjectSearchCandidate = {
  objectId: string;
  revision: number;
  title: string;
  body: string;
  updatedAt: string;
  titleMatch: 0 | 1;
};
const storeIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/;
function requireByteReference(reference: ObjectsByteReference) {
  if (
    !storeIdPattern.test(reference.storeId) ||
    !storeIdPattern.test(reference.artifactId) ||
    !Number.isSafeInteger(reference.revision) ||
    reference.revision < 1 ||
    !/^[a-f0-9]{64}$/.test(reference.sha256) ||
    !Number.isSafeInteger(reference.byteLength) ||
    reference.byteLength < 0 ||
    !reference.mime ||
    reference.mime.length > 200 ||
    /[\x00-\x1f]/.test(reference.mime)
  )
    throw new Error("Objects 字节提供方版本无效。");
}

async function insert(
  q: SqlQuery,
  table: string,
  row: Record<string, SqlScalar>,
) {
  const columns = Object.keys(row);
  await q.change(
    `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
    Object.values(row),
  );
}

/** Objects-app originals, separate from Platform's catalog and byte providers. */
export class ObjectsStore {
  private gate: Promise<unknown> = Promise.resolve();
  private readonly sqlChanges: SqlChangeSource;
  private constructor(
    private readonly backend: Backend,
    private readonly authority?: ObjectsAuthority,
  ) {
    this.sqlChanges = backend.kind === "sqlite"
      ? sqliteChangeSource(backend.database)
      : postgresChangeSource(backend.pool.options, backend.schema);
  }

  changeSource(): SqlChangeSource { return this.sqlChanges; }

  static async sqlite(
    filename: string,
    authority?: ObjectsAuthority,
  ): Promise<ObjectsStore> {
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
          !tables.some((table) => table.name === "objects_schema_version")
        )
          throw new Error("目标文件不属于 Objects 应用，拒绝混用。");
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
      const store = new ObjectsStore({ kind: "sqlite", database }, authority);
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
    authority?: ObjectsAuthority;
  }): Promise<ObjectsStore> {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(options.schema))
      throw new Error("Objects 数据库 schema 名称无效。");
    const pool = new Pool({
      connectionString: options.connectionString,
      max: 10,
    });
    try {
      const store = new ObjectsStore(
        { kind: "postgres", pool, schema: options.schema },
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
      await client.query(readOnly ? "BEGIN READ ONLY" : "BEGIN");
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
        !tables.some((t) => t.name === "objects_schema_version")
      )
        throw new Error("目标 schema 含非 Objects 表，拒绝混用。");
      if (!tables.length) {
        await q.exec(objectsSchemaSql);
        await this.initializeSearchBackend(q);
        await q.change(
          "INSERT INTO objects_schema_version(version,schema_sha256) VALUES(5,?)",
          [schemaHash(objectsSchemaSql)],
        );
        return;
      }
      const versions = await q.all<{
        version: number | string;
        schema_sha256: string;
      }>("SELECT version,schema_sha256 FROM objects_schema_version");
      if (versions.length !== 1 || tables.length === 1)
        throw new Error("Objects 数据库版本不完整或不受支持。");
      if (
        Number(versions[0]!.version) === 5 &&
        versions[0]!.schema_sha256 === schemaHash(objectsSchemaSql)
      ) {
        await verifySchemaObjects(
          q,
          this.backend.kind,
          objectsSchemaSql,
          this.backend.kind === "sqlite" ? sqliteSearchTables : [],
          ["morphz_app_binding"],
        );
        await this.verifySearchBackend(q);
        return;
      }
      if (
        Number(versions[0]!.version) === 4 &&
        versions[0]!.schema_sha256 === schemaHash(objectsSchemaV4Sql)
      ) {
        await this.upgradeInteractiveSchema(q);
        return;
      }
      if (
        Number(versions[0]!.version) === 1 &&
        versions[0]!.schema_sha256 === schemaHash(objectsSchemaV1Sql)
      ) {
        await verifySchemaObjects(
          q,
          this.backend.kind,
          objectsSchemaV1Sql,
          [],
          ["morphz_app_binding"],
        );
        await q.exec(imageDigestIndexSql);
        await q.change(
          "UPDATE objects_schema_version SET version=2,schema_sha256=? WHERE version=1 AND schema_sha256=?",
          [schemaHash(objectsSchemaV2Sql), schemaHash(objectsSchemaV1Sql)],
        );
      } else if (
        Number(versions[0]!.version) !== 2 ||
        versions[0]!.schema_sha256 !== schemaHash(objectsSchemaV2Sql)
      ) {
        if (
          Number(versions[0]!.version) !== 3 ||
          versions[0]!.schema_sha256 !== schemaHash(objectsSchemaV3Sql)
        )
          throw new Error("Objects 数据库版本不完整或不受支持。");
      }
      if (Number(versions[0]!.version) !== 3) {
        await verifySchemaObjects(
          q,
          this.backend.kind,
          objectsSchemaV2Sql,
          [],
          ["morphz_app_binding"],
        );
        await q.exec(annotationOrderIndexSql);
        await q.change(
          "UPDATE objects_schema_version SET version=3,schema_sha256=? WHERE version=2 AND schema_sha256=?",
          [schemaHash(objectsSchemaV3Sql), schemaHash(objectsSchemaV2Sql)],
        );
      }
      await verifySchemaObjects(
        q,
        this.backend.kind,
        objectsSchemaV3Sql,
        [],
        ["morphz_app_binding"],
      );
      await q.exec(searchProjectionSql);
      await this.initializeSearchBackend(q);
      await q.change(
        "UPDATE objects_schema_version SET version=4,schema_sha256=? WHERE version=3 AND schema_sha256=?",
        [schemaHash(objectsSchemaV4Sql), schemaHash(objectsSchemaV3Sql)],
      );
      await verifySchemaObjects(
        q,
        this.backend.kind,
        objectsSchemaV4Sql,
        this.backend.kind === "sqlite" ? sqliteSearchTables : [],
        ["morphz_app_binding"],
      );
      await this.verifySearchBackend(q);
      await this.upgradeInteractiveSchema(q);
    });
  }

  /** One atomic structural upgrade, not a permanent second payload reader.
   * Existing object revisions/receipts/citations survive. Any corrupt version
   * aborts the complete transaction, including table creation and marker. */
  private async upgradeInteractiveSchema(q: SqlQuery) {
    await verifySchemaObjects(
      q,
      this.backend.kind,
      objectsSchemaV4Sql,
      this.backend.kind === "sqlite" ? sqliteSearchTables : [],
      ["morphz_app_binding"],
    );
    await this.verifySearchBackend(q);
    await q.exec(interactiveSchemaSql);
    let offset = 0;
    for (;;) {
      const rows = await q.all<{
        tenant_id: string;
        object_id: string;
        revision: number | string;
        payload_body: string;
        payload_sha256: string;
      }>(
        "SELECT tenant_id,object_id,revision,payload_body,payload_sha256 FROM object_versions WHERE kind='interactive' ORDER BY tenant_id,object_id,revision LIMIT 100 OFFSET ?",
        [offset],
      );
      if (!rows.length) break;
      for (const row of rows) {
        if (digest(row.payload_body) !== row.payload_sha256)
          throw new Error("旧表格版本摘要不匹配，拒绝结构升级。");
        const content = contentSchema.parse(JSON.parse(row.payload_body));
        if (content.kind !== "interactive")
          throw new Error("旧表格版本类型不匹配。");
        const revision = safeInteger(row.revision, "表格版本");
        const previous = (
          await q.all<{ payload_body: string }>(
            "SELECT payload_body FROM object_versions WHERE tenant_id=? AND object_id=? AND revision=?",
            [row.tenant_id, row.object_id, revision - 1],
          )
        )[0];
        const rename =
          (
            await q.all(
              "SELECT 1 AS renamed FROM object_command_receipts WHERE tenant_id=? AND object_id=? AND revision=? AND operation='rename-object'",
              [row.tenant_id, row.object_id, revision],
            )
          ).length > 0;
        let body: string;
        if (rename) {
          if (!previous) throw new Error("重命名表格缺少前一版本。");
          body = previous.payload_body;
        } else
          body = await writeInteractiveContent(
            q,
            row.tenant_id,
            row.object_id,
            revision,
            content,
            previous?.payload_body,
          );
        const restored = await readInteractiveContent(
          q,
          row.tenant_id,
          row.object_id,
          body,
        );
        const canonical = (value: InteractiveContent) =>
          JSON.stringify({
            ...value,
            rows: value.rows.map((record) => ({
              ...record,
              cells: Object.fromEntries(
                Object.entries(record.cells).sort(([a], [b]) =>
                  a < b ? -1 : a > b ? 1 : 0,
                ),
              ),
            })),
          });
        if (canonical(restored) !== canonical(content))
          throw new Error("表格结构升级未能精确还原原版本。");
        await q.change(
          "UPDATE object_versions SET payload_body=?,payload_sha256=? WHERE tenant_id=? AND object_id=? AND revision=?",
          [body, digest(body), row.tenant_id, row.object_id, revision],
        );
      }
      offset += rows.length;
    }
    await q.change(
      "UPDATE objects_schema_version SET version=5,schema_sha256=? WHERE version=4 AND schema_sha256=?",
      [schemaHash(objectsSchemaSql), schemaHash(objectsSchemaV4Sql)],
    );
    await verifySchemaObjects(
      q,
      this.backend.kind,
      objectsSchemaSql,
      this.backend.kind === "sqlite" ? sqliteSearchTables : [],
      ["morphz_app_binding"],
    );
  }

  private async versionContent(
    q: SqlQuery,
    tenantId: string,
    objectId: string,
    body: string,
    sha256: string,
    revision: number,
  ) {
    if (digest(body) !== sha256)
      throw new Error("Objects 正文版本摘要不匹配。");
    const parsed = JSON.parse(body) as { kind?: string };
    if (parsed?.kind === "interactive") {
      const pointer = interactivePointer(body);
      if (pointer.tableRevision > revision)
        throw new Error("表格指针不能读取未来版本。");
      return readInteractiveContent(q, tenantId, objectId, body);
    }
    return contentSchema.parse(parsed);
  }

  private async initializeSearchBackend(q: SqlQuery) {
    if (this.backend.kind === "sqlite") {
      await q.exec(`
        CREATE VIRTUAL TABLE object_search_fts USING fts5(
          search_fold, content='object_search_documents', content_rowid='rowid',
          tokenize='trigram case_sensitive 1'
        );
        CREATE TRIGGER object_search_insert AFTER INSERT ON object_search_documents BEGIN
          INSERT INTO object_search_fts(rowid,search_fold) VALUES(new.rowid,new.search_fold);
        END;
        CREATE TRIGGER object_search_delete AFTER DELETE ON object_search_documents BEGIN
          INSERT INTO object_search_fts(object_search_fts,rowid,search_fold)
            VALUES('delete',old.rowid,old.search_fold);
        END;
        CREATE TRIGGER object_search_update AFTER UPDATE OF search_fold ON object_search_documents BEGIN
          INSERT INTO object_search_fts(object_search_fts,rowid,search_fold)
            VALUES('delete',old.rowid,old.search_fold);
          INSERT INTO object_search_fts(rowid,search_fold) VALUES(new.rowid,new.search_fold);
        END;
      `);
    } else {
      // PostgreSQL's trigram operator class is the counterpart to SQLite's
      // FTS5 trigram index. Extensions are database-wide, while Objects
      // schemas can be initialized concurrently by separate Hosts. Serialize
      // first installation across schemas before checking IF NOT EXISTS.
      await q.all(
        "SELECT pg_advisory_xact_lock(hashtextextended('morphz:objects:pg_trgm', 0)) AS locked",
      );
      await q.exec(`
        CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
        CREATE INDEX object_search_trigram ON object_search_documents
          USING gin (search_fold public.gin_trgm_ops);
      `);
    }
  }

  private async verifySearchBackend(q: SqlQuery) {
    if (this.backend.kind === "sqlite") {
      const rows = await q.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE (type='table' AND name='object_search_fts') OR (type='trigger' AND name IN ('object_search_insert','object_search_delete','object_search_update'))",
      );
      if (rows.length !== 4)
        throw new Error("Objects 搜索索引或同步触发器缺失，拒绝打开。");
    } else {
      const rows = await q.all<{ name: string }>(
        "SELECT indexname AS name FROM pg_catalog.pg_indexes WHERE schemaname=current_schema() AND indexname='object_search_trigram'",
      );
      if (rows.length !== 1)
        throw new Error("Objects PostgreSQL 搜索索引缺失，拒绝打开。");
    }
  }

  private searchColumns(title: string, content: Artifact["content"]) {
    const body = contentText(content);
    const titleFold = title.toLocaleLowerCase();
    const bodyFold = body.toLocaleLowerCase();
    return {
      title,
      body,
      title_fold: titleFold,
      body_fold: bodyFold,
      search_fold: `${titleFold}\n${bodyFold}`,
    };
  }

  /** Creation origin is immutable. A human edit updates an already-indexed
   * Agent deliverable, but a human/imported original never enters the index.
   */
  private async updateSearchProjection(
    q: SqlQuery,
    request: {
      tenantId: string;
      objectId: string;
      revision: number;
      title: string;
      content: Artifact["content"];
      updatedAt: string;
      eligibleAtCreation?: boolean;
    },
  ) {
    const indexed =
      request.eligibleAtCreation ||
      (
        await q.all(
          "SELECT 1 AS present FROM object_search_documents WHERE tenant_id=? AND object_id=?",
          [request.tenantId, request.objectId],
        )
      ).length > 0;
    if (!indexed) return;
    if (isPublicUnderstanding({ content: request.content })) {
      await q.change(
        "DELETE FROM object_search_documents WHERE tenant_id=? AND object_id=?",
        [request.tenantId, request.objectId],
      );
      return;
    }
    const text = this.searchColumns(request.title, request.content);
    await q.change(
      `INSERT INTO object_search_documents(
        tenant_id,object_id,object_revision,title,body,title_fold,body_fold,search_fold,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id,object_id) DO UPDATE SET
        object_revision=excluded.object_revision,title=excluded.title,
        body=excluded.body,title_fold=excluded.title_fold,
        body_fold=excluded.body_fold,search_fold=excluded.search_fold,
        updated_at=excluded.updated_at`,
      [
        request.tenantId,
        request.objectId,
        request.revision,
        text.title,
        text.body,
        text.title_fold,
        text.body_fold,
        text.search_fold,
        request.updatedAt,
      ],
    );
  }

  /** Internal app-owned search page. It returns no authorization decision:
   * the Host must intersect object IDs with the live Platform directory
   * before exposing even a count or excerpt to a Client or Agent.
   */
  async searchCandidates(request: {
    tenantId: string;
    query: string;
    limit?: number;
    includeBody?: boolean;
    after?: Pick<
      ObjectSearchCandidate,
      "objectId" | "updatedAt" | "titleMatch"
    >;
  }): Promise<ObjectSearchCandidate[]> {
    const tenantId = requireDomainId(request.tenantId, "租户 ID");
    if (
      typeof request.query !== "string" ||
      !request.query.trim() ||
      request.query.length > 200
    )
      throw new Error("搜索关键词无效。");
    const limit = request.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("搜索分页大小无效。");
    if (
      request.includeBody !== undefined &&
      typeof request.includeBody !== "boolean"
    )
      throw new Error("搜索正文投影选项无效。");
    const terms = searchTerms(request.query);
    const contains = (column: string) =>
      this.backend.kind === "sqlite"
        ? `instr(${column},?)>0`
        : `POSITION(? IN ${column})>0`;
    const rank = `CASE WHEN (${terms.map(() => contains("title_fold")).join(" OR ")}) THEN 1 ELSE 0 END`;
    const exact = terms
      .map(() => `(${contains("title_fold")} OR ${contains("body_fold")})`)
      .join(" AND ");
    const values: SqlScalar[] = [
      ...terms,
      tenantId,
      ...terms.flatMap((term) => [term, term]),
    ];
    let indexed = "";
    if (this.backend.kind === "sqlite") {
      const indexTerms = terms.filter(
        (term) => [...term].length >= 3 && !term.includes("\0"),
      );
      if (indexTerms.length) {
        indexed =
          " AND rowid IN (SELECT rowid FROM object_search_fts WHERE object_search_fts MATCH ?)";
        values.push(
          indexTerms
            .map((term) => `"${term.replaceAll('"', '""')}"`)
            .join(" AND "),
        );
      }
    } else {
      for (const term of terms) {
        if ([...term].length < 3 || /[%_\\\0]/u.test(term)) continue;
        indexed += " AND search_fold LIKE ?";
        values.push(`%${term}%`);
      }
    }
    let cursor = "";
    if (request.after) {
      if (
        ![0, 1].includes(request.after.titleMatch) ||
        !Number.isFinite(Date.parse(request.after.updatedAt))
      )
        throw new Error("搜索游标无效。");
      requireDomainId(request.after.objectId, "搜索对象 ID");
      cursor =
        "WHERE title_match<? OR (title_match=? AND updated_at<?) OR (title_match=? AND updated_at=? AND object_id>?)";
      values.push(
        request.after.titleMatch,
        request.after.titleMatch,
        request.after.updatedAt,
        request.after.titleMatch,
        request.after.updatedAt,
        request.after.objectId,
      );
    }
    values.push(limit);
    return this.transaction(async (q) => {
      const rows = await q.all<{
        object_id: string;
        object_revision: number | string;
        title: string;
        body: string;
        updated_at: string;
        title_match: number | string;
      }>(
        `WITH matching AS (
          SELECT object_id,object_revision,title,${request.includeBody === false ? "'' AS body" : "body"},updated_at,${rank} AS title_match
          FROM object_search_documents
          WHERE tenant_id=? AND ${exact}${indexed}
        )
        SELECT object_id,object_revision,title,body,updated_at,title_match
        FROM matching ${cursor}
        ORDER BY title_match DESC,updated_at DESC,object_id ASC LIMIT ?`,
        values,
      );
      return rows.map((row) => ({
        objectId: row.object_id,
        revision: safeInteger(row.object_revision, "搜索对象版本"),
        title: row.title,
        body: row.body,
        updatedAt: row.updated_at,
        titleMatch: safeInteger(row.title_match, "标题匹配") as 0 | 1,
      }));
    }, true);
  }

  async close() {
    if (this.backend.kind === "sqlite") this.backend.database.close();
    else await this.backend.pool.end();
  }

  private requireActor(actor: ObjectsActor) {
    requireDomainId(actor.tenantId, "租户 ID");
    requireDomainId(actor.principalId, "发起者 ID");
    requireDomainId(actor.actantId, "执行者 ID");
    if (actor.kind !== "human" && actor.kind !== "agent")
      throw new Error("应用执行者类型无效。");
    if (
      actor.kind === "agent" &&
      !actor.runtimeInputId &&
      !actor.runtimeTaskRunEventId
    )
      throw new Error("Agent 操作缺少已持久化的发起来源。");
    if (actor.runtimeInputId)
      requireDomainId(actor.runtimeInputId, "发起输入 ID");
    if (actor.runtimeTaskRunEventId)
      requireDomainId(actor.runtimeTaskRunEventId, "事项执行 ID");
    if (actor.kind === "human" && actor.runtimeTaskRunEventId)
      throw new Error("Human 操作不能冒用事项执行来源。");
  }

  private async confirmObjectRead(
    credential: string,
    objectId: string,
    authorized: AuthorizedDocument,
  ) {
    if (!this.authority) throw new Error("Objects 尚未接入受信权限。");
    const current = await this.authority.authorizeObjectRead({
      credential,
      objectId,
    });
    this.requireActor(current);
    if (
      current.tenantId !== authorized.tenantId ||
      current.principalId !== authorized.principalId ||
      current.actantId !== authorized.actantId ||
      current.kind !== authorized.kind ||
      current.runtimeInputId !== authorized.runtimeInputId ||
      (current.runtimeTaskRunEventId ?? null) !==
        (authorized.runtimeTaskRunEventId ?? null) ||
      current.contentId !== authorized.contentId ||
      current.objectKind !== authorized.objectKind ||
      current.projectId !== authorized.projectId
    )
      throw new Error("读取期间对象身份或授权发生变化。");
    return current;
  }

  private async replayDocumentReceipt(
    q: SqlQuery,
    actor: ObjectsActor,
    commandId: string,
    requestHash: string,
    operation:
      | "create-document"
      | "revise-document"
      | "create-image"
      | "revise-image"
      | "create-interactive"
      | "revise-interactive"
      | "patch-interactive",
    objectId: string,
  ): Promise<DocumentCommit | null> {
    const receipt = (
      await q.all<{
        request_hash: string;
        operation: string;
        object_id: string;
        revision: number | string;
      }>(
        "SELECT request_hash,operation,object_id,revision FROM object_command_receipts WHERE tenant_id=? AND command_id=?",
        [actor.tenantId, commandId],
      )
    )[0];
    if (!receipt) return null;
    if (
      receipt.request_hash !== requestHash ||
      receipt.operation !== operation ||
      receipt.object_id !== objectId
    )
      throw new ObjectsConflictError("相同命令 ID 对应不同内容请求。");
    const row = (
      await q.all<{
        title: string;
        event_kind: string;
        payload_body: string;
      }>(
        "SELECT v.title,o.event_kind,o.payload_body FROM object_versions v JOIN object_outbox o ON o.tenant_id=v.tenant_id AND o.object_id=v.object_id AND o.object_revision=v.revision WHERE v.tenant_id=? AND v.object_id=? AND v.revision=? AND o.event_id=?",
        [actor.tenantId, objectId, receipt.revision, commandId],
      )
    )[0];
    if (
      !row ||
      row.event_kind !==
        (operation.startsWith("create-")
          ? `${operation.slice(operation.indexOf("-") + 1)}.created`
          : `${operation.slice(operation.indexOf("-") + 1)}.revised`)
    )
      throw new Error("文档回执对应的目录事件缺失。");
    const payload = readDirectoryPayload(row.payload_body);
    if (
      payload.principalId !== actor.principalId ||
      payload.actantId !== actor.actantId ||
      payload.runtimeInputId !== actor.runtimeInputId ||
      (payload.runtimeTaskRunEventId ?? null) !==
        (actor.runtimeTaskRunEventId ?? null)
    )
      throw new Error("文档回执与当前执行者不一致。");
    return {
      tenantId: actor.tenantId,
      objectId,
      projectId: payload.projectId,
      title: row.title,
      versionRef: String(receipt.revision),
      receiptId: commandId,
      eventId: commandId,
      contentId: payload.contentId,
      expectedCatalogRevision: payload.expectedCatalogRevision,
    };
  }

  /** Commit one app-owned original. Platform receives only a verified catalog
   * reference; a failed directory update never repeats this document write.
   */
  async createDocument(request: {
    credential: string;
    commandId: string;
    objectId: string;
    requestedProjectId: string;
    title: string;
    markdown: string;
    relativePath?: string;
  }): Promise<DocumentCommit> {
    return this.createObjectVersion({
      ...request,
      kind: "document",
      content: { kind: "document", markdown: request.markdown },
      ...(request.relativePath ? { relativePath: request.relativePath } : {}),
    });
  }

  async createImage(request: {
    credential: string;
    commandId: string;
    objectId: string;
    requestedProjectId: string;
    title: string;
    assetId: string;
    alt: string;
    reference: ObjectsByteReference;
  }): Promise<DocumentCommit> {
    return this.createObjectVersion({
      ...request,
      kind: "image",
      content: { kind: "image", assetId: request.assetId, alt: request.alt },
    });
  }

  async createInteractive(request: {
    credential: string;
    commandId: string;
    objectId: string;
    requestedProjectId: string;
    title: string;
    content: InteractiveContent;
  }): Promise<DocumentCommit> {
    return this.createObjectVersion({
      ...request,
      kind: "interactive",
      content: request.content,
    });
  }

  private async createObjectVersion(request: {
    credential: string;
    commandId: string;
    objectId: string;
    requestedProjectId: string;
    title: string;
    kind: "document" | "image" | "interactive";
    content:
      | { kind: "document"; markdown: string }
      | { kind: "image"; assetId: string; alt: string }
      | InteractiveContent;
    reference?: ObjectsByteReference;
    relativePath?: string;
  }): Promise<DocumentCommit> {
    if (!this.authority) throw new Error("Objects 尚未接入受信权限。");
    const commandId = requireDomainId(request.commandId, "命令 ID");
    const objectId = requireDomainId(request.objectId, "内容 ID");
    const projectId = requireDomainId(request.requestedProjectId, "项目 ID");
    const title = request.title.trim();
    if (!title || title.length > 180) throw new Error("内容标题无效。");
    const content = contentSchema.parse(request.content);
    if (content.kind !== request.kind) throw new Error("内容类型无效。");
    if (request.relativePath !== undefined) {
      if (request.kind !== "document" || content.kind !== "document")
        throw new Error("只有文档可以记录导入来源。");
      const issue =
        documentImportIssue(request.relativePath) ??
        documentTextIssue(content.markdown);
      if (issue) throw new Error(issue);
    }
    if (request.kind === "image") {
      if (
        !request.reference ||
        content.kind !== "image" ||
        !["image/png", "image/jpeg", "image/webp"].includes(
          request.reference.mime,
        ) ||
        request.reference.sha256 !== content.assetId
      )
        throw new Error("图片内容缺少匹配的对象存储版本。");
      requireByteReference(request.reference);
    } else if (request.reference) {
      throw new Error("无文件内容不能绑定文件版本。");
    }
    const actor = await this.authority.authorizeCreate({
      credential: request.credential,
      projectId,
    });
    this.requireActor(actor);
    const requestHash = digest(
      JSON.stringify({
        actor: {
          tenantId: actor.tenantId,
          principalId: actor.principalId,
          actantId: actor.actantId,
          kind: actor.kind,
          runtimeInputId: actor.runtimeInputId,
          ...(actor.runtimeTaskRunEventId
            ? { runtimeTaskRunEventId: actor.runtimeTaskRunEventId }
            : {}),
        },
        operation: `create-${request.kind}`,
        objectId,
        projectId,
        title,
        content,
        ...(request.relativePath ? { relativePath: request.relativePath } : {}),
        ...(request.reference ? { reference: request.reference } : {}),
      }),
    );
    const body = JSON.stringify(content);
    return this.transaction(async (q) => {
      if (this.backend.kind === "postgres")
        await q.all(
          "SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0)) AS locked",
          [`objects:${actor.tenantId}:${commandId}`],
        );
      const prior = await this.replayDocumentReceipt(
        q,
        actor,
        commandId,
        requestHash,
        `create-${request.kind}` as
          "create-document" | "create-image" | "create-interactive",
        objectId,
      );
      if (prior) return prior;
      if (
        (
          await q.all(
            "SELECT 1 AS present FROM objects WHERE tenant_id=? AND object_id=?",
            [actor.tenantId, objectId],
          )
        ).length
      )
        throw new Error("内容 ID 已存在；不能创建第二份原件。");
      const now = new Date().toISOString();
      const source = request.relativePath
        ? artifactSchema.shape.source.parse({
            mode: "copy",
            name: request.relativePath.split("/").at(-1),
            relativePath: request.relativePath,
            importedAt: now,
            importedRevision: 1,
          })
        : null;
      await insert(q, "objects", {
        tenant_id: actor.tenantId,
        object_id: objectId,
        kind: request.kind,
        head_revision: 1,
        created_by_principal_id: actor.principalId,
        created_by_actant_id: actor.actantId,
        created_at: now,
        updated_at: now,
        origin_conversation_id: null,
        origin_project_id: projectId,
        source_body: source ? JSON.stringify(source) : null,
        deleted_at: null,
      });
      const storedBody =
        content.kind === "interactive"
          ? await writeInteractiveContent(
              q,
              actor.tenantId,
              objectId,
              1,
              content,
            )
          : body;
      await insert(q, "object_versions", {
        tenant_id: actor.tenantId,
        object_id: objectId,
        revision: 1,
        title,
        kind: request.kind,
        payload_body: storedBody,
        payload_sha256: digest(storedBody),
        historical_project_id: projectId,
        author_principal_id: actor.principalId,
        author_actant_id: actor.actantId,
        created_at: now,
      });
      await this.updateSearchProjection(q, {
        tenantId: actor.tenantId,
        objectId,
        revision: 1,
        title,
        content,
        updatedAt: now,
        eligibleAtCreation: actor.kind === "agent" && !source,
      });
      await insert(q, "object_command_receipts", {
        tenant_id: actor.tenantId,
        command_id: commandId,
        request_hash: requestHash,
        operation: `create-${request.kind}`,
        object_id: objectId,
        revision: 1,
        committed_at: now,
      });
      await insert(q, "object_outbox", {
        tenant_id: actor.tenantId,
        event_id: commandId,
        object_id: objectId,
        object_revision: 1,
        event_kind: `${request.kind}.created`,
        payload_body: JSON.stringify({
          projectId,
          contentId: null,
          expectedCatalogRevision: null,
          principalId: actor.principalId,
          actantId: actor.actantId,
          runtimeInputId: actor.runtimeInputId,
          ...(actor.runtimeTaskRunEventId
            ? { runtimeTaskRunEventId: actor.runtimeTaskRunEventId }
            : {}),
        } satisfies DirectoryPayload),
        created_at: now,
        delivered_at: null,
        attempts: 0,
      });
      if (request.reference)
        await insert(q, "object_version_bytes", {
          tenant_id: actor.tenantId,
          object_id: objectId,
          object_revision: 1,
          store_id: request.reference.storeId,
          artifact_id: request.reference.artifactId,
          artifact_revision: request.reference.revision,
          sha256: request.reference.sha256,
          byte_length: request.reference.byteLength,
          mime: request.reference.mime,
        });
      return {
        tenantId: actor.tenantId,
        objectId,
        projectId,
        title,
        versionRef: "1",
        receiptId: commandId,
        eventId: commandId,
        contentId: null,
        expectedCatalogRevision: null,
      };
    });
  }

  /** The Platform directory supplies current membership and its observed
   * revision. A new app version is not stacked over an unprojected version.
   */
  async reviseDocument(request: {
    credential: string;
    commandId: string;
    objectId: string;
    expectedRevision: number;
    title: string;
    markdown: string;
  }): Promise<DocumentCommit> {
    return this.reviseObjectVersion({
      ...request,
      kind: "document",
      content: { kind: "document", markdown: request.markdown },
    });
  }

  async reviseImage(request: {
    credential: string;
    commandId: string;
    objectId: string;
    expectedRevision: number;
    title: string;
    assetId: string;
    alt: string;
    reference: ObjectsByteReference;
  }): Promise<DocumentCommit> {
    return this.reviseObjectVersion({
      ...request,
      kind: "image",
      content: { kind: "image", assetId: request.assetId, alt: request.alt },
    });
  }

  async reviseInteractive(request: {
    credential: string;
    commandId: string;
    objectId: string;
    expectedRevision: number;
    title: string;
    content: InteractiveContent;
  }): Promise<DocumentCommit> {
    return this.reviseObjectVersion({
      ...request,
      kind: "interactive",
      content: request.content,
    });
  }

  private async reviseObjectVersion(request: {
    credential: string;
    commandId: string;
    objectId: string;
    expectedRevision: number;
    title: string;
    kind: "document" | "image" | "interactive";
    content:
      | { kind: "document"; markdown: string }
      | { kind: "image"; assetId: string; alt: string }
      | InteractiveContent;
    reference?: ObjectsByteReference;
  }): Promise<DocumentCommit> {
    if (!this.authority) throw new Error("Objects 尚未接入受信权限。");
    const commandId = requireDomainId(request.commandId, "命令 ID");
    const objectId = requireDomainId(request.objectId, "内容 ID");
    if (
      !Number.isSafeInteger(request.expectedRevision) ||
      request.expectedRevision < 1
    )
      throw new Error("内容预期版本无效。");
    const title = request.title.trim();
    if (!title || title.length > 180) throw new Error("内容标题无效。");
    const content = contentSchema.parse(request.content);
    if (content.kind !== request.kind) throw new Error("内容类型无效。");
    if (request.kind === "image") {
      if (
        !request.reference ||
        content.kind !== "image" ||
        !["image/png", "image/jpeg", "image/webp"].includes(
          request.reference.mime,
        ) ||
        request.reference.sha256 !== content.assetId
      )
        throw new Error("图片内容缺少匹配的对象存储版本。");
      requireByteReference(request.reference);
    } else if (request.reference) {
      throw new Error("无文件内容不能绑定文件版本。");
    }
    const actor = await this.authority.authorizeDocumentRevision({
      credential: request.credential,
      objectId,
    });
    this.requireActor(actor);
    requireDomainId(actor.projectId, "当前项目 ID");
    requireDomainId(actor.contentId, "当前目录 ID");
    const requestHash = digest(
      JSON.stringify({
        tenantId: actor.tenantId,
        principalId: actor.principalId,
        actantId: actor.actantId,
        kind: actor.kind,
        runtimeInputId: actor.runtimeInputId,
        ...(actor.runtimeTaskRunEventId
          ? { runtimeTaskRunEventId: actor.runtimeTaskRunEventId }
          : {}),
        operation: `revise-${request.kind}`,
        objectId,
        expectedRevision: request.expectedRevision,
        title,
        content,
        ...(request.reference ? { reference: request.reference } : {}),
      }),
    );
    const body = JSON.stringify(content);
    return this.transaction(async (q) => {
      if (this.backend.kind === "postgres")
        await q.all(
          "SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0)) AS locked",
          [`objects:${actor.tenantId}:${commandId}`],
        );
      const prior = await this.replayDocumentReceipt(
        q,
        actor,
        commandId,
        requestHash,
        `revise-${request.kind}` as
          "revise-document" | "revise-image" | "revise-interactive",
        objectId,
      );
      if (prior) return prior;
      if (
        actor.objectKind !== request.kind ||
        actor.observedVersionRef !== String(request.expectedRevision)
      )
        throw new ObjectsConflictError(
          "目录尚未确认当前内容版本，请先完成目录投影。",
        );
      const changed = await q.change(
        "UPDATE objects SET head_revision=head_revision+1,updated_at=? WHERE tenant_id=? AND object_id=? AND kind=? AND deleted_at IS NULL AND head_revision=?",
        [
          new Date().toISOString(),
          actor.tenantId,
          objectId,
          request.kind,
          request.expectedRevision,
        ],
      );
      if (changed !== 1)
        throw new ObjectsConflictError("内容版本已变化，请重新读取后修改。");
      const nextRevision = request.expectedRevision + 1;
      const now = new Date().toISOString();
      const previous =
        content.kind === "interactive"
          ? (
              await q.all<{ payload_body: string; payload_sha256: string }>(
                "SELECT payload_body,payload_sha256 FROM object_versions WHERE tenant_id=? AND object_id=? AND revision=?",
                [actor.tenantId, objectId, request.expectedRevision],
              )
            )[0]
          : null;
      if (
        content.kind === "interactive" &&
        (!previous || digest(previous.payload_body) !== previous.payload_sha256)
      )
        throw new Error("表格前一版本摘要不匹配。");
      const storedBody =
        content.kind === "interactive"
          ? await writeInteractiveContent(
              q,
              actor.tenantId,
              objectId,
              nextRevision,
              content,
              previous!.payload_body,
            )
          : body;
      await insert(q, "object_versions", {
        tenant_id: actor.tenantId,
        object_id: objectId,
        revision: nextRevision,
        title,
        kind: request.kind,
        payload_body: storedBody,
        payload_sha256: digest(storedBody),
        historical_project_id: actor.projectId,
        author_principal_id: actor.principalId,
        author_actant_id: actor.actantId,
        created_at: now,
      });
      await this.updateSearchProjection(q, {
        tenantId: actor.tenantId,
        objectId,
        revision: nextRevision,
        title,
        content,
        updatedAt: now,
      });
      await insert(q, "object_command_receipts", {
        tenant_id: actor.tenantId,
        command_id: commandId,
        request_hash: requestHash,
        operation: `revise-${request.kind}`,
        object_id: objectId,
        revision: nextRevision,
        committed_at: now,
      });
      await insert(q, "object_outbox", {
        tenant_id: actor.tenantId,
        event_id: commandId,
        object_id: objectId,
        object_revision: nextRevision,
        event_kind: `${request.kind}.revised`,
        payload_body: JSON.stringify({
          projectId: actor.projectId,
          contentId: actor.contentId,
          expectedCatalogRevision: actor.catalogRevision,
          principalId: actor.principalId,
          actantId: actor.actantId,
          runtimeInputId: actor.runtimeInputId,
          ...(actor.runtimeTaskRunEventId
            ? { runtimeTaskRunEventId: actor.runtimeTaskRunEventId }
            : {}),
        } satisfies DirectoryPayload),
        created_at: now,
        delivered_at: null,
        attempts: 0,
      });
      if (request.reference)
        await insert(q, "object_version_bytes", {
          tenant_id: actor.tenantId,
          object_id: objectId,
          object_revision: nextRevision,
          store_id: request.reference.storeId,
          artifact_id: request.reference.artifactId,
          artifact_revision: request.reference.revision,
          sha256: request.reference.sha256,
          byte_length: request.reference.byteLength,
          mime: request.reference.mime,
        });
      return {
        tenantId: actor.tenantId,
        objectId,
        projectId: actor.projectId,
        title,
        versionRef: String(nextRevision),
        receiptId: commandId,
        eventId: commandId,
        contentId: actor.contentId,
        expectedCatalogRevision: actor.catalogRevision,
      };
    });
  }

  /** Rename without round-tripping a possibly large payload through the UI or
   * model. The new immutable version retains the exact body and byte locator.
   */
  async renameObject(request: {
    credential: string;
    commandId: string;
    objectId: string;
    expectedCatalogRevision: number;
    title: string;
  }): Promise<DocumentCommit> {
    if (!this.authority) throw new Error("Objects 尚未接入受信权限。");
    const objectId = requireDomainId(request.objectId, "内容 ID");
    const commandId = requireDomainId(request.commandId, "命令 ID");
    if (
      !Number.isSafeInteger(request.expectedCatalogRevision) ||
      request.expectedCatalogRevision < 1
    )
      throw new Error("目录预期版本无效。");
    const title = request.title.trim();
    if (!title || title.length > 180) throw new Error("内容标题无效。");
    const actor = await this.authority.authorizeDocumentRevision({
      credential: request.credential,
      objectId,
    });
    this.requireActor(actor);
    const requestHash = digest(
      JSON.stringify({
        tenantId: actor.tenantId,
        principalId: actor.principalId,
        actantId: actor.actantId,
        kind: actor.kind,
        runtimeInputId: actor.runtimeInputId,
        runtimeTaskRunEventId: actor.runtimeTaskRunEventId ?? null,
        operation: "rename-object",
        objectId,
        expectedCatalogRevision: request.expectedCatalogRevision,
        title,
      }),
    );
    return this.transaction(async (q) => {
      if (this.backend.kind === "postgres")
        await q.all(
          "SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0)) AS locked",
          [`objects:${actor.tenantId}:${commandId}`],
        );
      const receipt = (
        await q.all<Row>(
          "SELECT request_hash,operation,object_id,revision FROM object_command_receipts WHERE tenant_id=? AND command_id=?",
          [actor.tenantId, commandId],
        )
      )[0];
      if (receipt) {
        if (
          receipt.request_hash !== requestHash ||
          receipt.operation !== "rename-object" ||
          receipt.object_id !== objectId
        )
          throw new Error("相同命令 ID 对应不同内容请求。");
        const previous = (
          await q.all<Row>(
            "SELECT v.title,o.event_kind,o.payload_body FROM object_versions v JOIN object_outbox o ON o.tenant_id=v.tenant_id AND o.object_id=v.object_id AND o.object_revision=v.revision WHERE v.tenant_id=? AND v.object_id=? AND v.revision=? AND o.event_id=?",
            [
              actor.tenantId,
              objectId,
              receipt.revision as SqlScalar,
              commandId,
            ],
          )
        )[0];
        if (
          !previous ||
          previous.title !== title ||
          previous.event_kind !== `${actor.objectKind}.revised`
        )
          throw new Error("重命名回执对应的原件版本缺失。");
        const payload = readDirectoryPayload(String(previous.payload_body));
        if (
          payload.principalId !== actor.principalId ||
          payload.actantId !== actor.actantId ||
          payload.runtimeInputId !== actor.runtimeInputId ||
          (payload.runtimeTaskRunEventId ?? null) !==
            (actor.runtimeTaskRunEventId ?? null) ||
          payload.expectedCatalogRevision !== request.expectedCatalogRevision
        )
          throw new Error("重命名回执与当前执行来源不一致。");
        return {
          tenantId: actor.tenantId,
          objectId,
          projectId: payload.projectId,
          title,
          versionRef: String(receipt.revision),
          receiptId: commandId,
          eventId: commandId,
          contentId: payload.contentId,
          expectedCatalogRevision: payload.expectedCatalogRevision,
        };
      }
      if (actor.catalogRevision !== request.expectedCatalogRevision)
        throw new ObjectsConflictError("内容目录已变化，请刷新后重试。");
      const object = (
        await q.all<Row>(
          "SELECT kind,head_revision,deleted_at FROM objects WHERE tenant_id=? AND object_id=?",
          [actor.tenantId, objectId],
        )
      )[0];
      if (
        !object ||
        object.deleted_at ||
        object.kind !== actor.objectKind ||
        actor.observedVersionRef !== String(object.head_revision)
      )
        throw new ObjectsConflictError("内容版本已变化，请重新读取后修改。");
      const oldRevision = safeInteger(
        object.head_revision as number | string,
        "对象当前版本",
      );
      const version = (
        await q.all<Row>(
          "SELECT payload_body,payload_sha256,kind FROM object_versions WHERE tenant_id=? AND object_id=? AND revision=?",
          [actor.tenantId, objectId, oldRevision],
        )
      )[0];
      if (
        !version ||
        digest(String(version.payload_body)) !== version.payload_sha256 ||
        version.kind !== actor.objectKind
      )
        throw new Error("对象当前原件版本不完整。");
      const content = await this.versionContent(
        q,
        actor.tenantId,
        objectId,
        String(version.payload_body),
        String(version.payload_sha256),
        oldRevision,
      );
      if (content.kind !== actor.objectKind)
        throw new Error("对象当前原件类型不一致。");
      const byteRef = (
        await q.all<Row>(
          "SELECT store_id,artifact_id,artifact_revision,sha256,byte_length,mime FROM object_version_bytes WHERE tenant_id=? AND object_id=? AND object_revision=?",
          [actor.tenantId, objectId, oldRevision],
        )
      )[0];
      if (
        "assetId" in content &&
        (!byteRef || byteRef.sha256 !== content.assetId)
      )
        throw new Error("对象原件缺少确切文件字节引用。");
      const now = new Date().toISOString();
      const changed = await q.change(
        "UPDATE objects SET head_revision=head_revision+1,updated_at=? WHERE tenant_id=? AND object_id=? AND kind=? AND deleted_at IS NULL AND head_revision=?",
        [now, actor.tenantId, objectId, actor.objectKind, oldRevision],
      );
      if (changed !== 1)
        throw new ObjectsConflictError("内容版本已变化，请重新读取后修改。");
      const nextRevision = oldRevision + 1;
      await insert(q, "object_versions", {
        tenant_id: actor.tenantId,
        object_id: objectId,
        revision: nextRevision,
        title,
        kind: actor.objectKind,
        payload_body: String(version.payload_body),
        payload_sha256: String(version.payload_sha256),
        historical_project_id: actor.projectId,
        author_principal_id: actor.principalId,
        author_actant_id: actor.actantId,
        created_at: now,
      });
      await this.updateSearchProjection(q, {
        tenantId: actor.tenantId,
        objectId,
        revision: nextRevision,
        title,
        content,
        updatedAt: now,
      });
      if (byteRef)
        await insert(q, "object_version_bytes", {
          tenant_id: actor.tenantId,
          object_id: objectId,
          object_revision: nextRevision,
          store_id: String(byteRef.store_id),
          artifact_id: String(byteRef.artifact_id),
          artifact_revision: safeInteger(
            byteRef.artifact_revision as number | string,
            "文件版本",
          ),
          sha256: String(byteRef.sha256),
          byte_length: safeInteger(
            byteRef.byte_length as number | string,
            "文件字节数",
          ),
          mime: String(byteRef.mime),
        });
      await insert(q, "object_command_receipts", {
        tenant_id: actor.tenantId,
        command_id: commandId,
        request_hash: requestHash,
        operation: "rename-object",
        object_id: objectId,
        revision: nextRevision,
        committed_at: now,
      });
      await insert(q, "object_outbox", {
        tenant_id: actor.tenantId,
        event_id: commandId,
        object_id: objectId,
        object_revision: nextRevision,
        event_kind: `${actor.objectKind}.revised`,
        payload_body: JSON.stringify({
          projectId: actor.projectId,
          contentId: actor.contentId,
          expectedCatalogRevision: actor.catalogRevision,
          principalId: actor.principalId,
          actantId: actor.actantId,
          runtimeInputId: actor.runtimeInputId,
          ...(actor.runtimeTaskRunEventId
            ? { runtimeTaskRunEventId: actor.runtimeTaskRunEventId }
            : {}),
        } satisfies DirectoryPayload),
        created_at: now,
        delivered_at: null,
        attempts: 0,
      });
      return {
        tenantId: actor.tenantId,
        objectId,
        projectId: actor.projectId,
        title,
        versionRef: String(nextRevision),
        receiptId: commandId,
        eventId: commandId,
        contentId: actor.contentId,
        expectedCatalogRevision: actor.catalogRevision,
      };
    });
  }

  /** Trusted Host only: resolve one app-owned file version after current
   * Platform permission and Objects payload checks. This returns a locator,
   * never a Store credential or file bytes.
   */
  async authorizeVersionBytes(request: {
    credential: string;
    objectId: string;
    objectRevision: number;
  }) {
    if (!this.authority) throw new Error("Objects 尚未接入受信权限。");
    const objectId = requireDomainId(request.objectId, "原件 ID");
    if (
      !Number.isSafeInteger(request.objectRevision) ||
      request.objectRevision < 1
    )
      throw new Error("原件版本无效。");
    const authorized = await this.authority.authorizeByteRead({
      credential: request.credential,
      objectId,
    });
    this.requireActor(authorized);
    const reference = await this.transaction(async (q) => {
      const row = (
        await q.all<{
          object_kind: string;
          deleted_at: string | null;
          version_kind: string;
          payload_body: string;
          payload_sha256: string;
          store_id: string | null;
          artifact_id: string | null;
          artifact_revision: number | string | null;
          sha256: string | null;
          byte_length: number | string | null;
          mime: string | null;
        }>(
          `SELECT o.kind AS object_kind,o.deleted_at,v.kind AS version_kind,
                  v.payload_body,v.payload_sha256,b.store_id,b.artifact_id,
                  b.artifact_revision,b.sha256,b.byte_length,b.mime
             FROM objects o JOIN object_versions v
               ON v.tenant_id=o.tenant_id AND v.object_id=o.object_id
             LEFT JOIN object_version_bytes b
               ON b.tenant_id=v.tenant_id AND b.object_id=v.object_id AND b.object_revision=v.revision
            WHERE o.tenant_id=? AND o.object_id=? AND v.revision=?`,
          [authorized.tenantId, objectId, request.objectRevision],
        )
      )[0];
      if (
        !row ||
        row.deleted_at ||
        row.object_kind !== authorized.objectKind ||
        row.version_kind !== row.object_kind
      )
        throw new Error("Objects 原件或版本不可用。");
      if (digest(row.payload_body) !== row.payload_sha256)
        throw new Error("Objects 正文版本摘要不匹配。");
      const content = await this.versionContent(
        q,
        authorized.tenantId,
        objectId,
        row.payload_body,
        row.payload_sha256,
        request.objectRevision,
      );
      if (
        content.kind !== row.version_kind ||
        !("assetId" in content) ||
        !row.store_id ||
        !row.artifact_id ||
        row.artifact_revision === null ||
        !row.sha256 ||
        row.byte_length === null ||
        !row.mime ||
        content.assetId !== row.sha256
      )
        throw new Error("Objects 文件版本缺少已验证的字节引用。");
      const bound: ObjectsByteReference = {
        storeId: row.store_id,
        artifactId: row.artifact_id,
        revision: safeInteger(row.artifact_revision, "Store 版本"),
        sha256: row.sha256,
        byteLength: safeInteger(row.byte_length, "字节长度"),
        mime: row.mime,
      };
      requireByteReference(bound);
      return bound;
    }, true);
    const current = await this.authority.authorizeByteRead({
      credential: request.credential,
      objectId,
    });
    this.requireActor(current);
    if (
      current.tenantId !== authorized.tenantId ||
      current.principalId !== authorized.principalId ||
      current.actantId !== authorized.actantId ||
      current.kind !== authorized.kind ||
      current.runtimeInputId !== authorized.runtimeInputId ||
      (current.runtimeTaskRunEventId ?? null) !==
        (authorized.runtimeTaskRunEventId ?? null) ||
      current.contentId !== authorized.contentId ||
      current.objectKind !== authorized.objectKind
    )
      throw new Error("Objects 字节读取期间身份或目录授权已变化。");
    return {
      tenantId: current.tenantId,
      principalId: current.principalId,
      actantId: current.actantId,
      runtimeInputId: current.runtimeInputId,
      runtimeTaskRunEventId: current.runtimeTaskRunEventId ?? null,
      contentId: current.contentId,
      projectId: current.projectId,
      objectId,
      objectRevision: request.objectRevision,
      reference,
    };
  }

  /** Resolve an asset URL through a live catalog grant. The digest is
   * only a lookup key, never authority to read an app-owned original. */
  async authorizeAssetBytes(request: {
    credential: string;
    tenantId: string;
    assetId: string;
    storeId: string;
  }) {
    if (!this.authority) throw new Error("Objects 尚未接入受信权限。");
    requireDomainId(request.tenantId, "租户 ID");
    if (!/^[a-f0-9]{64}$/.test(request.assetId))
      throw new Error("文件摘要无效。");
    if (!storeIdPattern.test(request.storeId))
      throw new Error("文件提供方无效。");
    let afterObjectId = "";
    let afterRevision = 0;
    for (;;) {
      const rows = await this.transaction(
        (q) =>
          q.all<{ object_id: string; object_revision: number | string }>(
            `SELECT object_id,object_revision FROM object_version_bytes
            WHERE tenant_id=? AND sha256=? AND store_id=? AND
              (object_id>? OR (object_id=? AND object_revision>?))
            ORDER BY object_id,object_revision LIMIT 100`,
            [
              request.tenantId,
              request.assetId,
              request.storeId,
              afterObjectId,
              afterObjectId,
              afterRevision,
            ],
          ),
        true,
      );
      if (!rows.length) return null;
      for (const row of rows) {
        try {
          const granted = await this.authority.authorizeByteRead({
            credential: request.credential,
            objectId: row.object_id,
          });
          if (granted.tenantId !== request.tenantId) continue;
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            ["forbidden", "not_found"].includes(String(error.code))
          )
            continue;
          throw error;
        }
        const authorized = await this.authorizeVersionBytes({
          credential: request.credential,
          objectId: row.object_id,
          objectRevision: safeInteger(row.object_revision, "对象版本"),
        });
        if (
          authorized.tenantId === request.tenantId &&
          authorized.reference.sha256 === request.assetId
        )
          return authorized;
      }
      if (rows.length < 100) return null;
      const last = rows.at(-1)!;
      afterObjectId = last.object_id;
      afterRevision = safeInteger(last.object_revision, "对象版本");
    }
  }

  async hasImageVersions(tenantId: string) {
    requireDomainId(tenantId, "租户 ID");
    return this.transaction(async (q) => {
      const rows = await q.all(
        "SELECT 1 AS present FROM object_versions WHERE tenant_id=? AND kind='image' LIMIT 1",
        [tenantId],
      );
      return rows.length > 0;
    }, true);
  }

  /** Exact authorized metadata only; annotations need not advance object head. */
  async workspaceChangeVersion(request: { credential: string; objectId: string }) {
    if (!this.authority) throw new Error("Objects 尚未接入受信权限。");
    const objectId = requireDomainId(request.objectId, "对象 ID");
    const actor = await this.authority.authorizeObjectRead(request);
    this.requireActor(actor);
    const metadata = await this.transaction(async q => ({
      head: await q.all("SELECT kind,head_revision,deleted_at FROM objects WHERE tenant_id=? AND object_id=? AND kind=?", [actor.tenantId, objectId, actor.objectKind]),
      annotations: await q.all("SELECT annotation_id,object_revision,collection_ordinal FROM object_annotations WHERE tenant_id=? AND object_id=? ORDER BY collection_ordinal", [actor.tenantId, objectId]),
    }), true);
    await this.confirmObjectRead(request.credential, objectId, actor);
    return createHash("sha256").update(JSON.stringify(metadata)).digest("hex");
  }

  /** Small app-authoritative head for source watches; never load the payload. */
  async readObjectHead(request: { credential: string; objectId: string }) {
    if (!this.authority) throw new Error("Objects 尚未接入受信权限。");
    const objectId = requireDomainId(request.objectId, "对象 ID");
    const authorized = await this.authority.authorizeObjectRead(request);
    this.requireActor(authorized);
    const head = await this.transaction(async (q) => {
      const rows = await q.all<{
        kind: string;
        head_revision: number | string;
      }>(
        "SELECT o.kind,o.head_revision FROM objects o JOIN object_versions v ON v.tenant_id=o.tenant_id AND v.object_id=o.object_id AND v.revision=o.head_revision AND v.kind=o.kind WHERE o.tenant_id=? AND o.object_id=? AND o.deleted_at IS NULL",
        [authorized.tenantId, objectId],
      );
      if (rows.length !== 1 || rows[0]!.kind !== authorized.objectKind)
        throw new Error("对象当前精确版本不存在或不可用。");
      return {
        objectId,
        versionRef: String(safeInteger(rows[0]!.head_revision, "对象当前版本")),
      };
    }, true);
    await this.confirmObjectRead(request.credential, objectId, authorized);
    return head;
  }

  /** One exact immutable version, never an entire workspace or version list.
   * Platform resolves current catalog access before and after the app read;
   * the app independently verifies its stored version and payload digest.
   */
  async readObject(request: {
    credential: string;
    objectId: string;
    revision?: number;
  }) {
    if (!this.authority) throw new Error("Objects 尚未接入受信权限。");
    const objectId = requireDomainId(request.objectId, "对象 ID");
    if (
      request.revision !== undefined &&
      (!Number.isSafeInteger(request.revision) || request.revision < 1)
    )
      throw new Error("对象版本无效。");
    const authorized = await this.authority.authorizeObjectRead({
      credential: request.credential,
      objectId,
    });
    this.requireActor(authorized);
    const version = await this.transaction(async (q) => {
      const object = (
        await q.all<{
          kind: string;
          head_revision: number | string;
          source_body: string | null;
          deleted_at: string | null;
        }>(
          "SELECT kind,head_revision,source_body,deleted_at FROM objects WHERE tenant_id=? AND object_id=?",
          [authorized.tenantId, objectId],
        )
      )[0];
      if (!object || object.deleted_at || object.kind !== authorized.objectKind)
        throw new Error("对象原件不存在或不可用。");
      const headRevision = safeInteger(object.head_revision, "对象当前版本");
      const revision = request.revision ?? headRevision;
      const row = (
        await q.all<{
          title: string;
          kind: string;
          payload_body: string;
          payload_sha256: string;
          author_principal_id: string;
          author_actant_id: string;
          created_at: string;
        }>(
          "SELECT title,kind,payload_body,payload_sha256,author_principal_id,author_actant_id,created_at FROM object_versions WHERE tenant_id=? AND object_id=? AND revision=?",
          [authorized.tenantId, objectId, revision],
        )
      )[0];
      if (!row || row.kind !== object.kind)
        throw new Error("对象精确版本不存在。");
      if (digest(row.payload_body) !== row.payload_sha256)
        throw new Error("对象正文版本摘要不匹配。");
      const content = await this.versionContent(
        q,
        authorized.tenantId,
        objectId,
        row.payload_body,
        row.payload_sha256,
        revision,
      );
      if (content.kind !== object.kind)
        throw new Error("对象正文版本类型不匹配。");
      return {
        objectId,
        revision,
        headRevision,
        title: row.title,
        content,
        source: artifactSchema.shape.source.parse(
          object.source_body === null ? null : JSON.parse(object.source_body),
        ),
        author: {
          principalId: row.author_principal_id,
          actantId: row.author_actant_id,
        },
        createdAt: row.created_at,
      };
    }, true);
    const current = await this.confirmObjectRead(
      request.credential,
      objectId,
      authorized,
    );
    return {
      ...version,
      contentId: current.contentId,
      projectId: current.projectId,
      observedVersionRef: current.observedVersionRef,
    };
  }

  async readDocument(request: {
    credential: string;
    objectId: string;
    revision?: number;
  }) {
    const version = await this.readObject(request);
    const content = version.content;
    if (content.kind !== "document") throw new Error("目录原件不是文档。");
    return { ...version, content };
  }

  async queryInteractiveRows(
    raw: InteractiveRowsRequest,
  ): Promise<InteractiveRowsPage> {
    if (!this.authority) throw new Error("Objects 尚未接入受信权限。");
    const validation = z
      .object({
        credential: z.string().min(1),
        objectId: z.string().regex(domainId, "对象 ID 无效。"),
        revision: z.number().int().positive().optional(),
        query: z.string().max(500).optional(),
        sort: z
          .object({
            columnId: z.string().min(1).max(64),
            descending: z.boolean(),
          })
          .strict()
          .optional(),
        after: z.string().min(1).max(8192).optional(),
        offset: z.number().int().min(0).max(1000).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      })
      .strict()
      .safeParse(raw);
    if (!validation.success)
      throw new DomainError("invalid", "表格查询条件或分页参数无效。");
    const request = validation.data;
    if (request.after !== undefined && request.offset !== undefined)
      throw new DomainError("invalid", "不能同时指定分页游标和行位置。");
    const objectId = request.objectId;
    const query = request.query ?? "",
      sort = request.sort ?? null,
      limit = request.limit ?? 50;
    let cursor: {
      objectId: string;
      revision: number;
      query: string;
      sort: InteractiveRowsRequest["sort"] | null;
      offset: number;
    } | null = null;
    if (request.after) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(
          Buffer.from(request.after, "base64url").toString("utf8"),
        );
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new DomainError("invalid", "表格分页游标无效。");
      }
      const parsed = z
        .object({
          objectId: z.string(),
          revision: z.number().int().positive(),
          query: z.string().max(500),
          sort: z
            .object({ columnId: z.string(), descending: z.boolean() })
            .strict()
            .nullable(),
          offset: z.number().int().min(0).max(1000),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .safeParse(decoded);
      if (!parsed.success)
        throw new DomainError("invalid", "表格分页游标无效。");
      const { sha256, ...payload } = parsed.data;
      if (
        digest(JSON.stringify(payload)) !== sha256 ||
        payload.objectId !== objectId ||
        payload.query !== query ||
        JSON.stringify(payload.sort) !== JSON.stringify(sort) ||
        (request.revision !== undefined &&
          request.revision !== payload.revision)
      )
        throw new DomainError("invalid", "表格分页游标与固定版本或查询不符。");
      cursor = payload;
    }
    const authorized = await this.authority.authorizeObjectRead({
      credential: request.credential,
      objectId,
    });
    this.requireActor(authorized);
    if (authorized.objectKind !== "interactive")
      throw new DomainError("invalid", "所选原件不是表格。");
    const page = await this.transaction(async (q) => {
      const object = (
        await q.all<{
          head_revision: number | string;
          kind: string;
          deleted_at: string | null;
        }>(
          "SELECT head_revision,kind,deleted_at FROM objects WHERE tenant_id=? AND object_id=?",
          [authorized.tenantId, objectId],
        )
      )[0];
      if (!object || object.kind !== "interactive" || object.deleted_at)
        throw new Error("表格原件不存在或不可用。");
      const headRevision = safeInteger(object.head_revision, "表格当前版本");
      const revision = cursor?.revision ?? request.revision ?? headRevision;
      const version = (
        await q.all<{
          title: string;
          kind: string;
          payload_body: string;
          payload_sha256: string;
        }>(
          "SELECT title,kind,payload_body,payload_sha256 FROM object_versions WHERE tenant_id=? AND object_id=? AND revision=?",
          [authorized.tenantId, objectId, revision],
        )
      )[0];
      if (!version) throw new DomainError("invalid", "所选表格版本不存在。");
      if (
        version.kind !== "interactive" ||
        digest(version.payload_body) !== version.payload_sha256
      )
        throw new Error("表格精确版本不存在或摘要不符。");
      const pointer = interactivePointer(version.payload_body);
      if (pointer.tableRevision > revision)
        throw new Error("表格指针不能读取未来版本。");
      const root = await readInteractiveRoot(
        q,
        authorized.tenantId,
        objectId,
        pointer,
      );
      const offset = cursor?.offset ?? request.offset ?? 0;
      const result = await queryRows(
        q,
        this.backend.kind,
        authorized.tenantId,
        objectId,
        root,
        query,
        sort ?? undefined,
        offset,
        limit,
      );
      const next = {
        objectId,
        revision,
        query,
        sort,
        offset: offset + result.rows.length,
      };
      return {
        objectId,
        revision,
        headRevision,
        title: version.title,
        layout: root.layout,
        description: root.description,
        columns: root.columns,
        total: root.references.length,
        matched: result.matched,
        rows: result.rows,
        summaries: result.summaries,
        nextCursor: result.hasMore
          ? Buffer.from(
              JSON.stringify({ ...next, sha256: digest(JSON.stringify(next)) }),
            ).toString("base64url")
          : null,
      };
    }, true);
    const current = await this.confirmObjectRead(
      request.credential,
      objectId,
      authorized,
    );
    return { ...page, contentId: current.contentId };
  }

  async patchInteractiveRows(
    raw: InteractiveRowsPatch,
  ): Promise<DocumentCommit> {
    if (!this.authority) throw new Error("Objects 尚未接入受信权限。");
    const validation = z
      .object({
        credential: z.string().min(1),
        commandId: z.string().regex(domainId, "命令 ID 无效。"),
        objectId: z.string().regex(domainId, "对象 ID 无效。"),
        expectedRevision: z.number().int().positive(),
        operations: z.array(interactiveRowOperationSchema).min(1).max(100),
      })
      .strict()
      .safeParse(raw);
    if (!validation.success)
      throw new DomainError("invalid", "表格修改参数无效，请检查记录与字段。");
    const request = validation.data;
    const objectId = request.objectId,
      commandId = request.commandId;
    const actor = await this.authority.authorizeDocumentRevision({
      credential: request.credential,
      objectId,
    });
    this.requireActor(actor);
    const requestHash = digest(
      JSON.stringify({
        tenantId: actor.tenantId,
        principalId: actor.principalId,
        actantId: actor.actantId,
        kind: actor.kind,
        runtimeInputId: actor.runtimeInputId,
        runtimeTaskRunEventId: actor.runtimeTaskRunEventId ?? null,
        operation: "patch-interactive",
        objectId,
        expectedRevision: request.expectedRevision,
        operations: request.operations,
      }),
    );
    return this.transaction(async (q) => {
      if (this.backend.kind === "postgres")
        await q.all(
          "SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0)) AS locked",
          [`objects:${actor.tenantId}:${commandId}`],
        );
      const prior = await this.replayDocumentReceipt(
        q,
        actor,
        commandId,
        requestHash,
        "patch-interactive",
        objectId,
      );
      if (prior) return prior;
      if (actor.objectKind !== "interactive")
        throw new DomainError("invalid", "所选原件不是表格。");
      if (actor.observedVersionRef !== String(request.expectedRevision))
        throw new ObjectsConflictError("目录尚未确认当前表格版本。");
      const previous = (
        await q.all<{
          title: string;
          payload_body: string;
          payload_sha256: string;
        }>(
          "SELECT title,payload_body,payload_sha256 FROM object_versions WHERE tenant_id=? AND object_id=? AND revision=? AND kind='interactive'",
          [actor.tenantId, objectId, request.expectedRevision],
        )
      )[0];
      if (
        !previous ||
        digest(previous.payload_body) !== previous.payload_sha256
      )
        throw new Error("表格前一版本不存在或摘要不符。");
      const now = new Date().toISOString();
      const changed = await q.change(
        "UPDATE objects SET head_revision=head_revision+1,updated_at=? WHERE tenant_id=? AND object_id=? AND kind='interactive' AND deleted_at IS NULL AND head_revision=?",
        [now, actor.tenantId, objectId, request.expectedRevision],
      );
      if (changed !== 1)
        throw new ObjectsConflictError("内容版本已变化，请重新读取后修改。");
      const revision = request.expectedRevision + 1;
      const body = await patchInteractiveContent(
        q,
        actor.tenantId,
        objectId,
        revision,
        previous.payload_body,
        request.operations,
        async (fromRevision) => {
          if (fromRevision > request.expectedRevision)
            throw new DomainError("invalid", "恢复来源不能是未来版本。");
          const old = (
            await q.all<{ payload_body: string; payload_sha256: string }>(
              "SELECT payload_body,payload_sha256 FROM object_versions WHERE tenant_id=? AND object_id=? AND revision=? AND kind='interactive'",
              [actor.tenantId, objectId, fromRevision],
            )
          )[0];
          if (!old)
            throw new DomainError("invalid", "所选恢复来源版本不存在。");
          if (digest(old.payload_body) !== old.payload_sha256)
            throw new Error("恢复来源表格版本不存在或摘要不符。");
          return old.payload_body;
        },
      );
      await insert(q, "object_versions", {
        tenant_id: actor.tenantId,
        object_id: objectId,
        revision,
        title: previous.title,
        kind: "interactive",
        payload_body: body,
        payload_sha256: digest(body),
        historical_project_id: actor.projectId,
        author_principal_id: actor.principalId,
        author_actant_id: actor.actantId,
        created_at: now,
      });
      if (
        (
          await q.all(
            "SELECT 1 AS indexed FROM object_search_documents WHERE tenant_id=? AND object_id=?",
            [actor.tenantId, objectId],
          )
        ).length
      ) {
        // Existing Agent deliverable search requires a current exact text
        // projection. Its <=1MB rebuild remains bounded O(N), not a new store.
        await this.updateSearchProjection(q, {
          tenantId: actor.tenantId,
          objectId,
          revision,
          title: previous.title,
          content: await readInteractiveContent(
            q,
            actor.tenantId,
            objectId,
            body,
          ),
          updatedAt: now,
        });
      }
      await insert(q, "object_command_receipts", {
        tenant_id: actor.tenantId,
        command_id: commandId,
        request_hash: requestHash,
        operation: "patch-interactive",
        object_id: objectId,
        revision,
        committed_at: now,
      });
      await insert(q, "object_outbox", {
        tenant_id: actor.tenantId,
        event_id: commandId,
        object_id: objectId,
        object_revision: revision,
        event_kind: "interactive.revised",
        payload_body: JSON.stringify({
          projectId: actor.projectId,
          contentId: actor.contentId,
          expectedCatalogRevision: actor.catalogRevision,
          principalId: actor.principalId,
          actantId: actor.actantId,
          runtimeInputId: actor.runtimeInputId,
          ...(actor.runtimeTaskRunEventId
            ? { runtimeTaskRunEventId: actor.runtimeTaskRunEventId }
            : {}),
        } satisfies DirectoryPayload),
        created_at: now,
        delivered_at: null,
        attempts: 0,
      });
      return {
        tenantId: actor.tenantId,
        objectId,
        projectId: actor.projectId,
        title: previous.title,
        versionRef: String(revision),
        receiptId: commandId,
        eventId: commandId,
        contentId: actor.contentId,
        expectedCatalogRevision: actor.catalogRevision,
      };
    });
  }

  /** A note belongs to one immutable original version. The command ID is also
   * its stable annotation ID, so an uncertain response can be retried safely.
   */
  async annotateObject(request: {
    credential: string;
    commandId: string;
    objectId: string;
    revision: number;
    quote: string;
    page?: number;
    body: string;
  }): Promise<Workspace["annotations"][number]> {
    if (!this.authority) throw new Error("Objects 尚未接入受信权限。");
    const objectId = requireDomainId(request.objectId, "对象 ID");
    const commandId = requireDomainId(request.commandId, "批注命令 ID");
    if (!Number.isSafeInteger(request.revision) || request.revision < 1)
      throw new Error("批注原文版本无效。");
    if (
      request.page !== undefined &&
      (!Number.isSafeInteger(request.page) || request.page < 1)
    )
      throw new Error("批注页码无效。");
    if (!request.quote.trim() || request.quote.length > 10000)
      throw new Error("批注引文无效。");
    const body = request.body.trim();
    if (!body || body.length > 10000) throw new Error("批注正文无效。");
    const actor = await this.authority.authorizeDocumentRevision({
      credential: request.credential,
      objectId,
    });
    this.requireActor(actor);
    const requestHash = digest(
      JSON.stringify({
        tenantId: actor.tenantId,
        principalId: actor.principalId,
        actantId: actor.actantId,
        kind: actor.kind,
        runtimeInputId: actor.runtimeInputId,
        runtimeTaskRunEventId: actor.runtimeTaskRunEventId ?? null,
        operation: "annotate",
        objectId,
        revision: request.revision,
        quote: request.quote,
        page: request.page ?? null,
        body,
      }),
    );
    return this.transaction(async (q) => {
      if (this.backend.kind === "postgres")
        await q.all(
          "SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0)) AS locked",
          [`objects:annotations:${actor.tenantId}`],
        );
      const prior = (
        await q.all<Row>(
          "SELECT request_hash,operation,object_id,revision FROM object_command_receipts WHERE tenant_id=? AND command_id=?",
          [actor.tenantId, commandId],
        )
      )[0];
      if (prior) {
        if (
          prior.request_hash !== requestHash ||
          prior.operation !== "annotate" ||
          prior.object_id !== objectId ||
          safeInteger(prior.revision as number | string, "批注版本") !==
            request.revision
        )
          throw new Error("相同命令 ID 对应不同批注请求。");
        const row = (
          await q.all<Row>(
            "SELECT * FROM object_annotations WHERE tenant_id=? AND annotation_id=?",
            [actor.tenantId, commandId],
          )
        )[0];
        if (!row) throw new Error("批注回执缺少原始批注。");
        return this.annotationFromRow(row);
      }
      const original = (
        await q.all<Row>(
          "SELECT o.kind,o.deleted_at,v.kind AS version_kind,v.payload_body,v.payload_sha256 FROM objects o JOIN object_versions v ON v.tenant_id=o.tenant_id AND v.object_id=o.object_id WHERE o.tenant_id=? AND o.object_id=? AND v.revision=?",
          [actor.tenantId, objectId, request.revision],
        )
      )[0];
      if (
        !original ||
        original.deleted_at ||
        original.kind !== actor.objectKind ||
        original.version_kind !== original.kind ||
        digest(String(original.payload_body)) !== original.payload_sha256
      )
        throw new Error("批注原文版本不存在或已变化。");
      const content = await this.versionContent(
        q,
        actor.tenantId,
        objectId,
        String(original.payload_body),
        String(original.payload_sha256),
        request.revision,
      );
      if (
        content.kind === "task" ||
        content.kind !== original.kind ||
        !quotedText(content).includes(request.quote) ||
        (request.page !== undefined &&
          (content.kind !== "pdf" ||
            !content.pages[request.page - 1]?.includes(request.quote)))
      )
        throw new Error("批注引文与 Objects 精确版本不符。");
      const ordinal = (
        await q.all<{ next_ordinal: number | string }>(
          "SELECT COALESCE(MAX(collection_ordinal),-1)+1 AS next_ordinal FROM object_annotations WHERE tenant_id=?",
          [actor.tenantId],
        )
      )[0];
      const now = new Date().toISOString();
      await insert(q, "object_annotations", {
        tenant_id: actor.tenantId,
        annotation_id: commandId,
        collection_ordinal: safeInteger(ordinal!.next_ordinal, "批注顺序"),
        object_id: objectId,
        object_revision: request.revision,
        quote_text: request.quote,
        page_number: request.page ?? null,
        body_text: body,
        author_principal_id: actor.principalId,
        author_actant_id: actor.actantId,
        created_at: now,
      });
      await insert(q, "object_command_receipts", {
        tenant_id: actor.tenantId,
        command_id: commandId,
        request_hash: requestHash,
        operation: "annotate",
        object_id: objectId,
        revision: request.revision,
        committed_at: now,
      });
      return {
        id: commandId,
        artifactId: objectId,
        artifactRevision: request.revision,
        quote: request.quote,
        ...(request.page === undefined ? {} : { page: request.page }),
        body,
        author: { principalId: actor.principalId, actantId: actor.actantId },
        createdAt: now,
      };
    });
  }

  private annotationFromRow(row: Row): Workspace["annotations"][number] {
    return {
      id: String(row.annotation_id),
      artifactId: String(row.object_id),
      artifactRevision: safeInteger(
        row.object_revision as number | string,
        "批注原文版本",
      ),
      quote: String(row.quote_text),
      ...(row.page_number === null
        ? {}
        : {
            page: safeInteger(row.page_number as number | string, "批注页码"),
          }),
      body: String(row.body_text),
      author: {
        principalId: String(row.author_principal_id),
        actantId: String(row.author_actant_id),
      },
      createdAt: String(row.created_at),
    };
  }

  async listObjectAnnotations(request: {
    credential: string;
    objectId: string;
    limit?: number;
    afterOrdinal?: number;
  }) {
    if (!this.authority) throw new Error("Objects 尚未接入受信权限。");
    const objectId = requireDomainId(request.objectId, "对象 ID");
    const limit = request.limit ?? 100;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (request.afterOrdinal !== undefined &&
        (!Number.isSafeInteger(request.afterOrdinal) ||
          request.afterOrdinal < 0))
    )
      throw new Error("批注分页参数无效。");
    const actor = await this.authority.authorizeObjectRead({
      credential: request.credential,
      objectId,
    });
    this.requireActor(actor);
    const rows = await this.transaction(
      async (q) =>
        q.all<Row>(
          `SELECT a.* FROM object_annotations a JOIN objects o ON o.tenant_id=a.tenant_id AND o.object_id=a.object_id WHERE a.tenant_id=? AND a.object_id=? AND o.deleted_at IS NULL AND o.kind=?${request.afterOrdinal === undefined ? "" : " AND a.collection_ordinal>?"} ORDER BY a.collection_ordinal LIMIT ?`,
          [
            actor.tenantId,
            objectId,
            actor.objectKind,
            ...(request.afterOrdinal === undefined
              ? []
              : [request.afterOrdinal]),
            limit,
          ],
        ),
      true,
    );
    await this.confirmObjectRead(request.credential, objectId, actor);
    return rows.map((row) => ({
      ordinal: safeInteger(
        row.collection_ordinal as number | string,
        "批注顺序",
      ),
      annotation: this.annotationFromRow(row),
    }));
  }

  /** Host-only existence and integrity proof for an app that derives data from
   * an Objects document. Authorization belongs to the caller's live Platform
   * credential; this method is deliberately not an application API route.
   */
  async verifyDocumentVersion(request: {
    tenantId: string;
    objectId: string;
    revision: number;
  }): Promise<void> {
    const objectId = requireDomainId(request.objectId, "对象 ID");
    if (!Number.isSafeInteger(request.revision) || request.revision < 1)
      throw new Error("对象版本无效。");
    await this.transaction(async (q) => {
      const rows = await q.all<{
        object_kind: string;
        deleted_at: string | null;
        version_kind: string;
        payload_body: string;
        payload_sha256: string;
      }>(
        `SELECT o.kind AS object_kind,o.deleted_at,v.kind AS version_kind,
                v.payload_body,v.payload_sha256
           FROM objects o JOIN object_versions v
             ON v.tenant_id=o.tenant_id AND v.object_id=o.object_id
          WHERE o.tenant_id=? AND o.object_id=? AND v.revision=?`,
        [request.tenantId, objectId, request.revision],
      );
      const row = rows[0];
      if (
        rows.length !== 1 ||
        row!.deleted_at !== null ||
        row!.object_kind !== "document" ||
        row!.version_kind !== "document" ||
        digest(row!.payload_body) !== row!.payload_sha256 ||
        contentSchema.parse(JSON.parse(row!.payload_body)).kind !== "document"
      )
        throw new Error("文档原件精确版本不存在或不完整。");
    }, true);
  }

  /** Verify a source citation against the owning Objects original. This
   * returns only the resolved identity and location; Script Studio does not
   * receive or copy the full source body merely to adopt a candidate.
   */
  async verifyQuotedVersion(request: {
    credential: string;
    objectId: string;
    revision: number;
    quote: string;
  }) {
    if (!this.authority) throw new Error("Objects 尚未接入受信权限。");
    const objectId = requireDomainId(request.objectId, "来源原件 ID");
    if (!Number.isSafeInteger(request.revision) || request.revision < 1)
      throw new Error("来源原件版本无效。");
    if (typeof request.quote !== "string" || request.quote.length > 10_000)
      throw new Error("来源引文无效。");
    const authorized = await this.authority.authorizeObjectRead({
      credential: request.credential,
      objectId,
    });
    this.requireActor(authorized);
    const verified = await this.transaction(async (q) => {
      const rows = await q.all<{
        object_kind: string;
        deleted_at: string | null;
        version_kind: string;
        historical_project_id: string | null;
        payload_body: string;
        payload_sha256: string;
      }>(
        "SELECT o.kind AS object_kind,o.deleted_at,v.kind AS version_kind,v.historical_project_id,v.payload_body,v.payload_sha256 FROM objects o JOIN object_versions v ON v.tenant_id=o.tenant_id AND v.object_id=o.object_id WHERE o.tenant_id=? AND o.object_id=? AND v.revision=?",
        [authorized.tenantId, objectId, request.revision],
      );
      if (rows.length !== 1 || rows[0]!.deleted_at)
        throw new Error("来源原件或精确版本不存在。");
      const row = rows[0]!;
      if (row.object_kind !== authorized.objectKind)
        throw new Error("来源目录与原件类型不一致。");
      if (digest(row.payload_body) !== row.payload_sha256)
        throw new Error("来源版本正文摘要不匹配。");
      const content = await this.versionContent(
        q,
        authorized.tenantId,
        objectId,
        row.payload_body,
        row.payload_sha256,
        request.revision,
      );
      if (content.kind !== row.version_kind)
        throw new Error("来源版本正文类型不匹配。");
      if (request.quote && !quotedText(content).includes(request.quote))
        throw new Error("来源引文不在所引用的精确版本中。");
      return {
        kind: row.version_kind,
        historicalProjectId: row.historical_project_id,
      };
    }, true);
    const current = await this.authority.authorizeObjectRead({
      credential: request.credential,
      objectId,
    });
    this.requireActor(current);
    if (
      current.tenantId !== authorized.tenantId ||
      current.principalId !== authorized.principalId ||
      current.actantId !== authorized.actantId ||
      current.kind !== authorized.kind ||
      current.runtimeInputId !== authorized.runtimeInputId ||
      (current.runtimeTaskRunEventId ?? null) !==
        (authorized.runtimeTaskRunEventId ?? null) ||
      current.contentId !== authorized.contentId ||
      current.objectKind !== authorized.objectKind ||
      current.projectId !== authorized.projectId
    )
      throw new Error("来源读取期间身份或目录归属发生变化。");
    return {
      tenantId: current.tenantId,
      principalId: current.principalId,
      actantId: current.actantId,
      kind: current.kind,
      runtimeInputId: current.runtimeInputId,
      runtimeTaskRunEventId: current.runtimeTaskRunEventId ?? null,
      projectId: current.projectId,
      contentId: current.contentId,
      objectId,
      revision: request.revision,
      sourceKind: verified.kind,
      historicalProjectId: verified.historicalProjectId,
    };
  }

  /** Metadata-only history page; each body is fetched by exact revision. */
  async listObjectVersions(request: {
    credential: string;
    objectId: string;
    limit?: number;
    beforeRevision?: number;
  }) {
    if (!this.authority) throw new Error("Objects 尚未接入受信权限。");
    const objectId = requireDomainId(request.objectId, "对象 ID");
    const limit = request.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("对象历史分页大小无效。");
    if (
      request.beforeRevision !== undefined &&
      (!Number.isSafeInteger(request.beforeRevision) ||
        request.beforeRevision < 1)
    )
      throw new Error("对象历史游标无效。");
    const authorized = await this.authority.authorizeObjectRead({
      credential: request.credential,
      objectId,
    });
    this.requireActor(authorized);
    const rows = await this.transaction(async (q) => {
      const object = (
        await q.all<{ kind: string; deleted_at: string | null }>(
          "SELECT kind,deleted_at FROM objects WHERE tenant_id=? AND object_id=?",
          [authorized.tenantId, objectId],
        )
      )[0];
      if (!object || object.kind !== authorized.objectKind || object.deleted_at)
        throw new Error("对象原件不存在或不可用。");
      return q.all<{
        revision: number | string;
        title: string;
        author_principal_id: string;
        author_actant_id: string;
        created_at: string;
      }>(
        `SELECT revision,title,author_principal_id,author_actant_id,created_at FROM object_versions WHERE tenant_id=? AND object_id=? AND kind=?${request.beforeRevision === undefined ? "" : " AND revision<?"} ORDER BY revision DESC LIMIT ?`,
        request.beforeRevision === undefined
          ? [authorized.tenantId, objectId, authorized.objectKind, limit + 1]
          : [
              authorized.tenantId,
              objectId,
              authorized.objectKind,
              request.beforeRevision,
              limit + 1,
            ],
      );
    }, true);
    const current = await this.confirmObjectRead(
      request.credential,
      objectId,
      authorized,
    );
    const page = rows.slice(0, limit).map((row) => ({
      revision: safeInteger(row.revision, "对象历史版本"),
      title: row.title,
      author: {
        principalId: row.author_principal_id,
        actantId: row.author_actant_id,
      },
      createdAt: row.created_at,
    }));
    return {
      objectId,
      contentId: current.contentId,
      projectId: current.projectId,
      versions: page,
      nextCursor: rows.length > limit ? page.at(-1)!.revision : null,
    };
  }

  /** Platform calls this through a trusted app connector. A title, version or
   * actor in a model response cannot substitute for the committed app receipt.
   */
  async verifyCommittedDocument(request: {
    tenantId: string;
    principalId: string;
    actantId: string;
    runtimeInputId: string | null;
    runtimeTaskRunEventId?: string | null;
    objectId: string;
    projectId: string;
    kind: string;
    title: string;
    versionRef: string;
    receiptId: string;
  }): Promise<boolean> {
    return this.verifyCommittedObject(request, "document");
  }

  async verifyCommittedImage(
    request: Parameters<ObjectsStore["verifyCommittedDocument"]>[0],
  ): Promise<boolean> {
    return this.verifyCommittedObject(request, "image");
  }

  async verifyCommittedInteractive(
    request: Parameters<ObjectsStore["verifyCommittedDocument"]>[0],
  ): Promise<boolean> {
    return this.verifyCommittedObject(request, "interactive");
  }

  async verifyCommittedRename(
    request: Parameters<ObjectsStore["verifyCommittedDocument"]>[0],
  ): Promise<boolean> {
    return this.verifyCommittedObject(request, null);
  }

  private async verifyCommittedObject(
    request: Parameters<ObjectsStore["verifyCommittedDocument"]>[0],
    expectedKind: "document" | "image" | "interactive" | null,
  ): Promise<boolean> {
    return this.transaction(async (q) => {
      const row = (
        await q.all<{
          operation: string;
          revision: number | string;
          title: string;
          kind: string;
          payload_body: string;
          payload_sha256: string;
          author_principal_id: string;
          author_actant_id: string;
          event_kind: string;
          directory_payload: string;
          object_kind: string;
          head_revision: number | string;
          byte_sha256: string | null;
          byte_mime: string | null;
          byte_store_id: string | null;
          byte_artifact_id: string | null;
          byte_artifact_revision: number | string | null;
          byte_length: number | string | null;
        }>(
          `SELECT r.operation,r.revision,v.title,v.kind,v.payload_body,v.payload_sha256,v.author_principal_id,v.author_actant_id,o.event_kind,o.payload_body AS directory_payload,x.kind AS object_kind,x.head_revision,b.sha256 AS byte_sha256,b.mime AS byte_mime,b.store_id AS byte_store_id,b.artifact_id AS byte_artifact_id,b.artifact_revision AS byte_artifact_revision,b.byte_length AS byte_length FROM object_command_receipts r JOIN object_versions v ON v.tenant_id=r.tenant_id AND v.object_id=r.object_id AND v.revision=r.revision JOIN object_outbox o ON o.tenant_id=r.tenant_id AND o.event_id=r.command_id AND o.object_id=r.object_id AND o.object_revision=r.revision JOIN objects x ON x.tenant_id=r.tenant_id AND x.object_id=r.object_id LEFT JOIN object_version_bytes b ON b.tenant_id=v.tenant_id AND b.object_id=v.object_id AND b.object_revision=v.revision WHERE r.tenant_id=? AND r.command_id=? AND r.object_id=? AND x.deleted_at IS NULL${expectedKind === null ? " AND r.operation='rename-object'" : ""}`,
          [request.tenantId, request.receiptId, request.objectId],
        )
      )[0];
      if (!row) return false;
      try {
        const payload = readDirectoryPayload(row.directory_payload);
        const content = await this.versionContent(
          q,
          request.tenantId,
          request.objectId,
          row.payload_body,
          row.payload_sha256,
          safeInteger(row.revision, "对象版本"),
        );
        const rename = row.operation === "rename-object";
        if (expectedKind === null && !rename) return false;
        if (expectedKind !== null && rename) return false;
        if (rename) {
          const previous = (
            await q.all<{
              kind: string;
              payload_body: string;
              payload_sha256: string;
              byte_sha256: string | null;
              byte_mime: string | null;
              byte_store_id: string | null;
              byte_artifact_id: string | null;
              byte_artifact_revision: number | string | null;
              byte_length: number | string | null;
            }>(
              "SELECT v.kind,v.payload_body,v.payload_sha256,b.sha256 AS byte_sha256,b.mime AS byte_mime,b.store_id AS byte_store_id,b.artifact_id AS byte_artifact_id,b.artifact_revision AS byte_artifact_revision,b.byte_length AS byte_length FROM object_versions v LEFT JOIN object_version_bytes b ON b.tenant_id=v.tenant_id AND b.object_id=v.object_id AND b.object_revision=v.revision WHERE v.tenant_id=? AND v.object_id=? AND v.revision=?",
              [request.tenantId, request.objectId, Number(row.revision) - 1],
            )
          )[0];
          if (
            !previous ||
            previous.kind !== row.kind ||
            previous.payload_body !== row.payload_body ||
            previous.payload_sha256 !== row.payload_sha256 ||
            [
              "byte_sha256",
              "byte_mime",
              "byte_store_id",
              "byte_artifact_id",
              "byte_artifact_revision",
              "byte_length",
            ].some(
              (key) =>
                String(previous[key as keyof typeof previous]) !==
                String(row[key as keyof typeof row]),
            )
          )
            return false;
        }
        const expectedEvent = rename
          ? `${request.kind}.revised`
          : row.operation === `create-${expectedKind}`
            ? `${expectedKind}.created`
            : row.operation === `revise-${expectedKind}` ||
                (expectedKind === "interactive" &&
                  row.operation === "patch-interactive")
              ? `${expectedKind}.revised`
              : null;
        return (
          (expectedKind === null || request.kind === expectedKind) &&
          row.kind === request.kind &&
          row.object_kind === request.kind &&
          content.kind === request.kind &&
          expectedEvent !== null &&
          row.event_kind === expectedEvent &&
          (rename
            ? "assetId" in content
              ? row.byte_sha256 === content.assetId
              : row.byte_sha256 === null
            : expectedKind === "document" || expectedKind === "interactive"
              ? row.byte_sha256 === null
              : content.kind === "image" &&
                row.byte_sha256 === content.assetId &&
                ["image/png", "image/jpeg", "image/webp"].includes(
                  row.byte_mime ?? "",
                )) &&
          digest(row.payload_body) === row.payload_sha256 &&
          row.title === request.title &&
          String(row.revision) === request.versionRef &&
          Number(row.head_revision) === Number(row.revision) &&
          row.author_principal_id === request.principalId &&
          row.author_actant_id === request.actantId &&
          // Creation binds the requested project; after a revision, current
          // project ownership is solely Platform's live directory decision.
          (rename ||
            row.operation !== `create-${expectedKind}` ||
            payload.projectId === request.projectId) &&
          payload.principalId === request.principalId &&
          payload.actantId === request.actantId &&
          payload.runtimeInputId === request.runtimeInputId &&
          (payload.runtimeTaskRunEventId ?? null) ===
            (request.runtimeTaskRunEventId ?? null) &&
          (!rename && row.operation === `create-${expectedKind}`
            ? payload.contentId === null &&
              payload.expectedCatalogRevision === null
            : payload.contentId !== null &&
              payload.expectedCatalogRevision !== null)
        );
      } catch {
        return false;
      }
    }, true);
  }

  /** Internal recovery feed. Stored events contain identity, never a reusable
   * credential; the host must resolve and re-authorize the original actor.
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
    return this.transaction(async (q) => {
      const rows = await q.all<{
        event_id: string;
        object_id: string;
        object_revision: number | string;
        event_kind: string;
        title: string;
        payload_body: string;
        created_at: string;
      }>(
        `SELECT o.event_id,o.object_id,o.object_revision,o.event_kind,v.title,o.payload_body,o.created_at FROM object_outbox o JOIN object_command_receipts r ON r.tenant_id=o.tenant_id AND r.command_id=o.event_id AND r.object_id=o.object_id AND r.revision=o.object_revision JOIN object_versions v ON v.tenant_id=o.tenant_id AND v.object_id=o.object_id AND v.revision=o.object_revision WHERE o.tenant_id=? AND o.delivered_at IS NULL${after ? " AND (o.created_at>? OR (o.created_at=? AND o.event_id>?))" : ""} ORDER BY o.created_at,o.event_id LIMIT ?`,
        after
          ? [tenantId, after.createdAt, after.createdAt, after.eventId, limit]
          : [tenantId, limit],
      );
      return rows.map((row) => ({
        eventId: row.event_id,
        objectId: row.object_id,
        versionRef: String(row.object_revision),
        eventKind: row.event_kind,
        title: row.title,
        createdAt: row.created_at,
        ...readDirectoryPayload(row.payload_body),
      }));
    }, true);
  }

  async markDirectoryProjected(tenantId: string, eventId: string) {
    requireDomainId(tenantId, "租户 ID");
    requireDomainId(eventId, "事件 ID");
    return this.transaction(async (q) => {
      const changed = await q.change(
        "UPDATE object_outbox SET delivered_at=? WHERE tenant_id=? AND event_id=? AND delivered_at IS NULL",
        [new Date().toISOString(), tenantId, eventId],
      );
      if (changed) return;
      const rows = await q.all(
        "SELECT 1 AS present FROM object_outbox WHERE tenant_id=? AND event_id=? AND delivered_at IS NOT NULL",
        [tenantId, eventId],
      );
      if (!rows.length) throw new Error("文档目录投影事件不存在。");
    });
  }
}
