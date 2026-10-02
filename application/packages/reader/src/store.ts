import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { z } from "zod";
import {
  readingLocationSchema,
  readingPreferencesSchema,
  maxReadingCharacters,
  type ReaderSection,
} from "../../core/src/reader.js";
import {
  ocrLayoutSchema,
  ocrResultSchema,
  type ReadingOcr,
} from "../../core/src/reader-ocr.js";
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
import { readerSchemaSql } from "./schema.js";

type Backend =
  | { kind: "sqlite"; database: DatabaseSync }
  | { kind: "postgres"; pool: Pool; schema: string };
type Row = Record<string, unknown>;

export class ReaderStorageError extends Error {
  constructor(
    public readonly code: "not_found" | "forbidden" | "conflict" | "invalid",
    message: string,
  ) {
    super(message);
  }
}

export type ReaderOriginal = {
  tenantId: string;
  appId: string;
  instanceId: string;
  objectId: string;
  versionRef: string;
};

/** Implemented by the owning app/Platform adapter, never by model parameters. */
export type ReaderAuthorityVerifier = {
  /** Resolve the trusted ingress credential before looking up a source ID. */
  resolveActor(request: { credential: string }): Promise<{
    tenantId: string;
    principalId: string;
    kind: "human" | "agent";
    inputId: string | null;
  } | null>;
  verifyOriginal(original: ReaderOriginal): Promise<void>;
  verifyBookBytes(request: {
    credential: string;
    original: ReaderOriginal;
    bytes: ReaderBookBytes;
  }): Promise<void>;
  verifyBookCreate(request: ReaderBookCommit): Promise<void>;
  verifyAccess(request: {
    /** Host-only authenticated caller context; never a model parameter. */
    credential: string;
    original: ReaderOriginal;
    principalId: string;
    inputId?: string;
    action: "read" | "annotate";
  }): Promise<void>;
};

export type ReaderBookBytes = {
  bookId: string;
  ownerPrincipalId: string;
  revision: number;
  storageKind: "app_private" | "artifact_store" | "external_reference";
  providerId: string;
  objectRef: string;
  sha256: string;
  byteLength: number;
  parserVersion: string;
};

export type ReaderBookCommit = {
  credential: string;
  commandId: string;
  projectId: string;
  tenantId: string;
  principalId: string;
  actantId: string;
  runtimeInputId: string | null;
  runtimeTaskRunEventId: string | null;
};

export type ReaderSourceImport = {
  tenantId: string;
  readingSourceId: string;
  original: ReaderOriginal;
  /** Text locator is not an original's identity; distinct originals may share it. */
  sourceLocatorId: string;
  book?: ReaderBookBytes;
  bookCommit?: ReaderBookCommit;
  title: string;
  author: string;
  edition: string;
  format: string;
  language: string;
  createdAt: string;
  sections: Array<ReaderSection & { pageNumber?: number; ocr?: ReadingOcr }>;
  /** Trusted Host import only. The cache stores provenance, not a second text. */
  importCache?: { optionsSha256: string };
};

export type ReaderParsedImport = Pick<
  ReaderSourceImport,
  "title" | "author" | "edition" | "format" | "language" | "sections"
>;
function parsedImportHash(parsed: ReaderParsedImport) {
  return hash(
    JSON.stringify({
      title: parsed.title,
      author: parsed.author,
      edition: parsed.edition,
      format: parsed.format,
      language: parsed.language,
      sections: parsed.sections.map((s) => ({
        id: s.id,
        title: s.title,
        html: s.html,
        text: s.text,
        pageNumber: s.pageNumber ?? null,
      })),
    }),
  );
}

// Structure upgrade only: existing immutable sources remain authoritative;
// new imports populate the empty provenance index, never a JSON fallback.
const cacheMarker = "\n-- Parsed import cache:";
const marksIndexSql =
  "CREATE INDEX marks_by_section_user ON reading_marks(tenant_id, reading_source_id, principal_id, section_id, deleted_at, created_at, mark_id, start_offset, end_offset);\n";
const readerV3SchemaSql = readerSchemaSql
  .replace("-- Reader schema v4.", "-- Reader schema v3.")
  .replace(marksIndexSql, "");
const cacheSchemaSql = readerV3SchemaSql.slice(
  readerV3SchemaSql.indexOf(cacheMarker),
);
const readerV2SchemaSql = readerV3SchemaSql
  .slice(0, readerV3SchemaSql.indexOf(cacheMarker))
  .replace("-- Reader schema v3.", "-- Reader schema v2.");

const actionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("mark-add"),
      readingSourceId: z.string().min(1),
      location: readingLocationSchema,
      quote: z.string().max(8000),
      kind: z.enum(["bookmark", "highlight", "note"]),
      color: z.enum(["yellow", "green", "blue", "pink"]),
      note: z.string().max(8000),
    })
    .strict(),
  z
    .object({
      action: z.literal("mark-update"),
      markId: z.string().min(1),
      expectedRevision: z.number().int().positive(),
      note: z.string().max(8000),
      color: z.enum(["yellow", "green", "blue", "pink"]),
    })
    .strict(),
  z
    .object({
      action: z.literal("mark-remove"),
      markId: z.string().min(1),
      expectedRevision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      action: z.literal("mark-restore"),
      markId: z.string().min(1),
      expectedRevision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      action: z.literal("save-position"),
      readingSourceId: z.string().min(1),
      location: readingLocationSchema,
      preferences: readingPreferencesSchema,
      expectedRevision: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type ReaderDomainAction = z.infer<typeof actionSchema>;
export type ReaderDomainCommand = {
  credential: string;
  tenantId: string;
  principalId: string;
  inputId?: string;
  commandId: string;
  /** Exact Host-resolved binding, including for mark-ID actions. */
  expectedReadingSourceId?: string;
  action: ReaderDomainAction;
};

function ensureId(value: string, label: string) {
  if (!value || value.length > 250 || /[\u0000-\u001f]/.test(value))
    throw new Error(`${label}无效。`);
}
function instant(value: string) {
  if (!Number.isFinite(Date.parse(value))) throw new Error("时间格式无效。");
  return value;
}
function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
export function readerBookEventId(tenantId: string, commandId: string) {
  return `reader_event_${hash(JSON.stringify([tenantId, commandId])).slice(0, 40)}`;
}
function bookRequestHash(source: ReaderSourceImport) {
  return hash(
    JSON.stringify({
      original: source.original,
      sourceLocatorId: source.sourceLocatorId,
      book: source.book,
      title: source.title,
      author: source.author,
      edition: source.edition,
      format: source.format,
      language: source.language,
      sections: source.sections,
      ...(source.importCache
        ? { importOptionsSha256: source.importCache.optionsSha256 }
        : {}),
      projectId: source.bookCommit?.projectId,
      principalId: source.bookCommit?.principalId,
      actantId: source.bookCommit?.actantId,
      runtimeInputId: source.bookCommit?.runtimeInputId,
      runtimeTaskRunEventId: source.bookCommit?.runtimeTaskRunEventId,
    }),
  );
}
async function insert(
  q: SqlQuery,
  table: string,
  record: Record<string, SqlScalar>,
) {
  const columns = Object.keys(record);
  await q.change(
    `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
    Object.values(record),
  );
}
function originalFromRow(row: Row): ReaderOriginal {
  return {
    tenantId: String(row.tenant_id),
    appId: String(row.source_app_id),
    instanceId: String(row.source_instance_id),
    objectId: String(row.source_object_id),
    versionRef: String(row.source_version_ref),
  };
}
/** Reader-owned metadata and annotations; it never takes ownership of external originals. */
export class ReaderStore {
  private gate: Promise<unknown> = Promise.resolve();
  private readonly sqlChanges: SqlChangeSource;
  private constructor(
    private readonly backend: Backend,
    private readonly authority: ReaderAuthorityVerifier,
  ) {
    this.sqlChanges = backend.kind === "sqlite"
      ? sqliteChangeSource(backend.database)
      : postgresChangeSource(backend.pool.options, backend.schema);
  }

  changeSource(): SqlChangeSource { return this.sqlChanges; }

  static async sqlite(
    filename: string,
    authority: ReaderAuthorityVerifier,
  ): Promise<ReaderStore> {
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
          !tables.some((t) => t.name === "reader_schema_version")
        )
          throw new Error("目标文件不属于阅读器，拒绝混用。");
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
      const store = new ReaderStore({ kind: "sqlite", database }, authority);
      await store.initialize();
      return store;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  static async postgres(
    options: { connectionString: string; schema: string },
    authority: ReaderAuthorityVerifier,
  ): Promise<ReaderStore> {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(options.schema))
      throw new Error("阅读器数据库 schema 名称无效。");
    const pool = new Pool({
      connectionString: options.connectionString,
      max: 10,
    });
    try {
      const store = new ReaderStore(
        { kind: "postgres", pool, schema: options.schema },
        authority,
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
            const result = await work(q);
            database.exec("COMMIT");
            publishSqlCommit(q, this.sqlChanges);
            return result;
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
      const result = await work(q);
      await prepareSqlCommit(q, this.sqlChanges);
      await client.query("COMMIT");
      return result;
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
        !tables.some((t) => t.name === "reader_schema_version")
      )
        throw new Error("目标 schema 含非阅读器表，拒绝混用。");
      if (!tables.length) {
        await q.exec(readerSchemaSql);
        await q.change(
          "INSERT INTO reader_schema_version(version,schema_sha256) VALUES(4,?)",
          [schemaHash(readerSchemaSql)],
        );
        return;
      }
      const versions = await q.all<{
        version: number | string;
        schema_sha256: string;
      }>("SELECT version,schema_sha256 FROM reader_schema_version");
      if (
        versions.length === 1 &&
        Number(versions[0]!.version) === 2 &&
        versions[0]!.schema_sha256 === schemaHash(readerV2SchemaSql) &&
        tables.length > 1
      ) {
        await verifySchemaObjects(
          q,
          this.backend.kind,
          readerV2SchemaSql,
          [],
          ["morphz_app_binding"],
        );
        await q.exec(cacheSchemaSql);
        await q.change(
          "UPDATE reader_schema_version SET version=3,schema_sha256=? WHERE version=2",
          [schemaHash(readerV3SchemaSql)],
        );
        versions[0] = {
          version: 3,
          schema_sha256: schemaHash(readerV3SchemaSql),
        };
      }
      if (
        versions.length === 1 &&
        Number(versions[0]!.version) === 3 &&
        versions[0]!.schema_sha256 === schemaHash(readerV3SchemaSql) &&
        tables.length > 1
      ) {
        await verifySchemaObjects(
          q,
          this.backend.kind,
          readerV3SchemaSql,
          [],
          ["morphz_app_binding"],
        );
        await q.exec(marksIndexSql);
        await q.change(
          "UPDATE reader_schema_version SET version=4,schema_sha256=? WHERE version=3",
          [schemaHash(readerSchemaSql)],
        );
        versions[0] = {
          version: 4,
          schema_sha256: schemaHash(readerSchemaSql),
        };
      }
      if (
        versions.length !== 1 ||
        Number(versions[0]!.version) !== 4 ||
        versions[0]!.schema_sha256 !== schemaHash(readerSchemaSql) ||
        tables.length === 1
      )
        throw new Error("阅读器数据库版本不完整或不受支持。");
      await verifySchemaObjects(
        q,
        this.backend.kind,
        readerSchemaSql,
        [],
        ["morphz_app_binding"],
      );
    });
  }

  async close() {
    if (this.backend.kind === "sqlite") this.backend.database.close();
    else await this.backend.pool.end();
  }

  async importSource(source: ReaderSourceImport) {
    ensureId(source.tenantId, "租户");
    ensureId(source.readingSourceId, "阅读来源");
    ensureId(source.sourceLocatorId, "原文定位");
    for (const [label, value] of Object.entries(source.original))
      ensureId(value, label);
    if (source.original.tenantId !== source.tenantId)
      throw new Error("原件与阅读来源不属于同一租户。");
    if (source.sections.length < 1 || source.sections.length > 2000)
      throw new Error("章节数量无效。");
    if (
      source.sections.some((section) => section.text.length > 1_000_000) ||
      source.sections.reduce(
        (total, section) => total + section.text.length,
        0,
      ) > maxReadingCharacters
    )
      throw new Error("阅读原文超出允许范围。");
    if (source.book) {
      if (
        !source.bookCommit ||
        source.bookCommit.tenantId !== source.tenantId ||
        source.bookCommit.principalId !== source.book.ownerPrincipalId ||
        source.original.appId !== "morphz.reader" ||
        source.original.objectId !== source.book.bookId ||
        source.original.versionRef !== String(source.book.revision) ||
        !/^[a-f0-9]{64}$/.test(source.book.sha256) ||
        !Number.isSafeInteger(source.book.byteLength) ||
        source.book.byteLength < 0
      )
        throw new Error("阅读器书籍原件绑定不一致。");
    } else if (source.original.appId === "morphz.reader" || source.bookCommit)
      throw new Error("阅读器自有原件缺少书籍版本和字节证明。");
    if (
      source.importCache &&
      (!source.book ||
        !/^[a-f0-9]{64}$/.test(source.importCache.optionsSha256) ||
        source.sections.some((section) => section.ocr))
    )
      throw new Error("阅读导入缓存必须绑定完整的原生书籍解析结果。");
    if (source.bookCommit) {
      for (const value of [
        source.bookCommit.commandId,
        source.bookCommit.projectId,
        source.bookCommit.principalId,
        source.bookCommit.actantId,
      ])
        ensureId(value, "书籍提交身份");
      await this.authority.verifyBookCreate(source.bookCommit);
    }
    await this.authority.verifyOriginal(source.original);
    if (source.book)
      await this.authority.verifyBookBytes({
        credential: source.bookCommit!.credential,
        original: source.original,
        bytes: source.book,
      });
    return this.transaction(async (q) => {
      const existing = await q.all<Row>(
        "SELECT * FROM reading_sources WHERE tenant_id=? AND reading_source_id=?",
        [source.tenantId, source.readingSourceId],
      );
      if (existing.length)
        throw new Error("阅读来源已存在；不覆盖原件或派生文本。");
      if (source.book) {
        const book = source.book;
        const rows = await q.all<Row>(
          "SELECT * FROM books WHERE tenant_id=? AND book_id=?",
          [source.tenantId, book.bookId],
        );
        if (!rows.length)
          await insert(q, "books", {
            tenant_id: source.tenantId,
            book_id: book.bookId,
            owner_principal_id: book.ownerPrincipalId,
            title: source.title,
            author: source.author,
            edition: source.edition,
            format: source.format,
            head_revision: book.revision,
            created_at: instant(source.createdAt),
            updated_at: instant(source.createdAt),
            deleted_at: null,
          });
        else {
          if (
            String(rows[0]!.owner_principal_id) !== book.ownerPrincipalId ||
            String(rows[0]!.format) !== source.format
          )
            throw new Error("书籍原件的所有者或格式不一致。");
          await q.change(
            "UPDATE books SET head_revision=?,title=?,author=?,edition=?,updated_at=? WHERE tenant_id=? AND book_id=? AND head_revision<?",
            [
              book.revision,
              source.title,
              source.author,
              source.edition,
              instant(source.createdAt),
              source.tenantId,
              book.bookId,
              book.revision,
            ],
          );
        }
        await insert(q, "book_revisions", {
          tenant_id: source.tenantId,
          book_id: book.bookId,
          revision: book.revision,
          storage_kind: book.storageKind,
          provider_id: book.providerId,
          object_ref: book.objectRef,
          sha256: book.sha256,
          byte_length: book.byteLength,
          parser_version: book.parserVersion,
          created_at: instant(source.createdAt),
        });
      }
      await insert(q, "reading_sources", {
        tenant_id: source.tenantId,
        reading_source_id: source.readingSourceId,
        source_app_id: source.original.appId,
        source_instance_id: source.original.instanceId,
        source_object_id: source.original.objectId,
        source_version_ref: source.original.versionRef,
        source_locator_id: source.sourceLocatorId,
        source_kind: source.book ? "reader_book" : "external_object",
        book_id: source.book?.bookId ?? null,
        book_revision: source.book?.revision ?? null,
        title: source.title,
        author: source.author,
        edition: source.edition,
        format: source.format,
        language: source.language,
        created_at: instant(source.createdAt),
      });
      for (const [ordinal, section] of source.sections.entries()) {
        ensureId(section.id, "章节");
        await insert(q, "book_sections", {
          tenant_id: source.tenantId,
          reading_source_id: source.readingSourceId,
          section_id: section.id,
          ordinal,
          section_kind: section.ocr ? "ocr" : "native",
          page_number: section.pageNumber ?? null,
          title: section.title,
          character_count: section.text.length,
          source_html: section.html,
        });
        for (let start = 0, index = 0; start < section.text.length; index++) {
          const end = Math.min(start + 4000, section.text.length);
          await insert(q, "book_text_chunks", {
            tenant_id: source.tenantId,
            reading_source_id: source.readingSourceId,
            section_id: section.id,
            chunk_index: index,
            start_offset: start,
            end_offset: end,
            page_number: section.pageNumber ?? null,
            body_text: section.text.slice(start, end),
            extraction_kind: section.ocr ? "ocr" : "native",
          });
          start = end;
        }
        if (section.ocr) {
          if (!section.pageNumber) throw new Error("OCR 章节缺少页码。");
          ocrResultSchema.parse({
            image: section.ocr.image,
            items: section.ocr.items,
          });
          ocrLayoutSchema.parse(section.ocr.layout);
          if (
            !section.ocr.engine ||
            (section.ocr.parent !== undefined &&
              !/^page-[1-9]\d*(?:-ocr-[a-f0-9]{64})?$/.test(section.ocr.parent))
          )
            throw new Error("OCR 引擎或来源版本无效。");
          const body = JSON.stringify(section.ocr);
          const digest = hash(body);
          if (!section.id.endsWith(`-ocr-${digest}`))
            throw new Error("OCR 章节 ID 与原始结果摘要不符。");
          await insert(q, "reading_ocr_versions", {
            tenant_id: source.tenantId,
            reading_source_id: source.readingSourceId,
            section_id: section.id,
            page_number: section.pageNumber ?? null,
            result_digest: digest,
            engine: section.ocr.engine,
            layout: section.ocr.layout,
            parent_section_id: section.ocr.parent ?? null,
            result_body: body,
            created_at: instant(source.createdAt),
          });
        }
      }
      if (source.book && source.bookCommit) {
        const eventId = readerBookEventId(
          source.tenantId,
          source.bookCommit.commandId,
        );
        await insert(q, "reader_book_events", {
          tenant_id: source.tenantId,
          event_id: eventId,
          command_id: source.bookCommit.commandId,
          request_hash: bookRequestHash(source),
          book_id: source.book.bookId,
          book_revision: source.book.revision,
          project_id: source.bookCommit.projectId,
          principal_id: source.bookCommit.principalId,
          actant_id: source.bookCommit.actantId,
          runtime_input_id: source.bookCommit.runtimeInputId,
          runtime_task_run_event_id: source.bookCommit.runtimeTaskRunEventId,
          title: source.title,
          created_at: instant(source.createdAt),
          projected_at: null,
        });
        if (source.importCache)
          await insert(q, "reader_import_cache", {
            tenant_id: source.tenantId,
            reading_source_id: source.readingSourceId,
            principal_id: source.book.ownerPrincipalId,
            sha256: source.book.sha256,
            format: source.format,
            parser_version: source.book.parserVersion,
            options_sha256: source.importCache.optionsSha256,
            result_sha256: parsedImportHash(source),
            created_at: instant(source.createdAt),
          });
      }
      return source.readingSourceId;
    });
  }

  /** Internal import-only lookup after the caller has actually supplied bytes.
   * No Client/Agent endpoint accepts a hash to retrieve private book text.
   * Cached body reconstruction and persistence are bounded O(N); only the
   * extraction Worker is avoided. OCR and personal annotations are not reused.
   */
  async readImportResult(request: {
    commit: ReaderBookCommit;
    sha256: string;
    byteLength: number;
    format: string;
    parserVersion: string;
    optionsSha256: string;
  }): Promise<(ReaderParsedImport & { parserVersion: string }) | null> {
    const { commit } = request;
    await this.authority.verifyBookCreate(commit);
    const actor = await this.authority.resolveActor({
      credential: commit.credential,
    });
    if (
      !actor ||
      actor.tenantId !== commit.tenantId ||
      actor.principalId !== commit.principalId ||
      actor.inputId !== commit.runtimeInputId
    )
      throw new ReaderStorageError("forbidden", "阅读导入身份已失效。");
    for (const digest of [request.sha256, request.optionsSha256])
      if (!/^[a-f0-9]{64}$/.test(digest))
        throw new ReaderStorageError("invalid", "阅读导入摘要无效。");
    const candidate = await this.transaction(async (q) => {
      const events = await q.all<Row>(
        "SELECT * FROM reader_book_events WHERE tenant_id=? AND command_id=?",
        [commit.tenantId, commit.commandId],
      );
      const replay = events[0];
      if (
        replay &&
        (replay.project_id !== commit.projectId ||
          replay.principal_id !== commit.principalId ||
          replay.actant_id !== commit.actantId ||
          replay.runtime_input_id !== commit.runtimeInputId ||
          replay.runtime_task_run_event_id !== commit.runtimeTaskRunEventId)
      )
        throw new ReaderStorageError(
          "conflict",
          "相同导入命令的身份或项目不一致。",
        );
      const rows = await q.all<Row>(
        `SELECT c.*,s.source_app_id,s.source_instance_id,s.source_object_id,s.source_version_ref,
          s.title,s.author,s.edition,s.language,s.format AS original_format,s.source_kind,s.book_id,s.book_revision,
          b.owner_principal_id,b.deleted_at,v.storage_kind,v.provider_id,v.object_ref,
          v.byte_length,v.sha256 AS original_sha256,v.parser_version AS original_parser_version
         FROM reader_import_cache c
         JOIN reading_sources s ON s.tenant_id=c.tenant_id AND s.reading_source_id=c.reading_source_id
         JOIN books b ON b.tenant_id=s.tenant_id AND b.book_id=s.book_id
         JOIN book_revisions v ON v.tenant_id=s.tenant_id AND v.book_id=s.book_id AND v.revision=s.book_revision
         WHERE c.tenant_id=? AND c.principal_id=? AND
          ${replay ? "s.book_id=? AND s.book_revision=?" : "c.sha256=? AND c.format=? AND c.parser_version=? AND c.options_sha256=?"}
         ORDER BY c.created_at DESC,c.reading_source_id LIMIT 1`,
        replay
          ? [
              commit.tenantId,
              commit.principalId,
              String(replay.book_id),
              String(replay.book_revision),
            ]
          : [
              commit.tenantId,
              commit.principalId,
              request.sha256,
              request.format,
              request.parserVersion,
              request.optionsSha256,
            ],
      );
      if (!rows.length) return null; // pre-cache canonical sources remain readable.
      const row = rows[0]!;
      const invalid =
        row.owner_principal_id !== commit.principalId ||
        row.source_kind !== "reader_book" ||
        row.sha256 !== request.sha256 ||
        row.original_sha256 !== request.sha256 ||
        row.format !== request.format ||
        row.original_format !== request.format ||
        row.options_sha256 !== request.optionsSha256 ||
        row.parser_version !== row.original_parser_version ||
        Number(row.byte_length) !== request.byteLength ||
        row.deleted_at !== null;
      if (invalid) {
        if (replay)
          throw new ReaderStorageError(
            "conflict",
            "已提交导入与当前文件或解析选项不一致。",
          );
        return null;
      }
      return {
        row,
        replay: Boolean(replay),
        projected: replay?.projected_at !== null,
      };
    }, true);
    if (!candidate) return null;
    const { row, replay } = candidate;
    const original = originalFromRow(row);
    const authorize = () =>
      this.authority.verifyAccess({
        credential: commit.credential,
        original,
        principalId: actor.principalId,
        ...(actor.inputId ? { inputId: actor.inputId } : {}),
        action: "read",
      });
    try {
      // An unprojected retry has the actual committed owner's creation proof;
      // ordinary cache candidates always need their current catalog grant.
      if (!replay || candidate.projected) await authorize();
      await this.authority.verifyBookBytes({
        credential: commit.credential,
        original,
        bytes: {
          bookId: String(row.book_id),
          ownerPrincipalId: String(row.owner_principal_id),
          revision: safeInteger(
            row.book_revision as number | string,
            "书籍版本",
          ),
          storageKind: row.storage_kind as ReaderBookBytes["storageKind"],
          providerId: String(row.provider_id),
          objectRef: String(row.object_ref),
          sha256: String(row.sha256),
          byteLength: safeInteger(
            row.byte_length as number | string,
            "原件大小",
          ),
          parserVersion: String(row.parser_version),
        },
      });
      const parsed = await this.transaction(async (q) => {
        const headers = await q.all<Row>(
          "SELECT * FROM book_sections WHERE tenant_id=? AND reading_source_id=? AND section_kind='native' ORDER BY ordinal LIMIT 2001",
          [commit.tenantId, String(row.reading_source_id)],
        );
        if (!headers.length || headers.length > 2000)
          throw new Error("缓存章节结构不完整。");
        const chunks = await q.all<Row>(
          "SELECT * FROM book_text_chunks WHERE tenant_id=? AND reading_source_id=? AND extraction_kind='native' ORDER BY section_id,chunk_index LIMIT 4002",
          [commit.tenantId, String(row.reading_source_id)],
        );
        if (chunks.length > 4001) throw new Error("缓存文本超出允许范围。");
        const bySection = new Map<string, Row[]>();
        for (const chunk of chunks) {
          const key = String(chunk.section_id);
          const entries = bySection.get(key) ?? [];
          entries.push(chunk);
          bySection.set(key, entries);
        }
        let total = 0;
        const sections = headers.map((header, index) => {
          if (
            Number(header.ordinal) !== index ||
            typeof header.source_html !== "string"
          )
            throw new Error("缓存章节顺序或正文无效。");
          const parts = bySection.get(String(header.section_id)) ?? [];
          bySection.delete(String(header.section_id));
          let end = 0;
          for (const [i, chunk] of parts.entries()) {
            if (
              Number(chunk.chunk_index) !== i ||
              Number(chunk.start_offset) !== end ||
              typeof chunk.body_text !== "string" ||
              chunk.body_text.length < 1 ||
              chunk.body_text.length > 4000 ||
              Number(chunk.end_offset) !== end + chunk.body_text.length ||
              chunk.page_number !== header.page_number
            )
              throw new Error("缓存文本分块不完整。");
            end += chunk.body_text.length;
          }
          total += end;
          if (
            end !== Number(header.character_count) ||
            end > 1_000_000 ||
            total > maxReadingCharacters
          )
            throw new Error("缓存原文长度不一致。");
          return {
            id: String(header.section_id),
            title: String(header.title),
            html: header.source_html,
            text: parts.map((chunk) => String(chunk.body_text)).join(""),
            ...(header.page_number === null
              ? {}
              : {
                  pageNumber: safeInteger(
                    header.page_number as number | string,
                    "页码",
                  ),
                }),
          };
        });
        if (bySection.size) throw new Error("缓存存在无归属文本块。");
        const result: ReaderParsedImport = {
          title: String(row.title),
          author: String(row.author),
          edition: String(row.edition),
          format: String(row.format),
          language: String(row.language),
          sections,
        };
        if (parsedImportHash(result) !== row.result_sha256)
          throw new Error("缓存解析结果摘要不一致。");
        return result;
      }, true);
      if (!replay || candidate.projected) await authorize();
      await this.authority.verifyBookCreate(commit);
      return { ...parsed, parserVersion: String(row.parser_version) };
    } catch (error) {
      // Cache provenance is optional. A denied/damaged old source is never
      // exposed; parse the currently uploaded authorized bytes instead.
      // An exact command replay, however, must not silently rewrite history.
      if (replay) throw error;
      return null;
    }
  }

  /** Offline-only equality check; returns no book text to an unauthenticated caller. */
  async verifyImportedSource(expected: ReaderSourceImport): Promise<void> {
    await this.transaction(async (q) => {
      const row = await this.source(
        q,
        expected.tenantId,
        expected.readingSourceId,
      );
      const matches =
        expected.original.tenantId === expected.tenantId &&
        String(row.source_app_id) === expected.original.appId &&
        String(row.source_instance_id) === expected.original.instanceId &&
        String(row.source_object_id) === expected.original.objectId &&
        String(row.source_version_ref) === expected.original.versionRef &&
        String(row.source_locator_id) === expected.sourceLocatorId &&
        String(row.source_kind) ===
          (expected.book ? "reader_book" : "external_object") &&
        String(row.title) === expected.title &&
        String(row.author) === expected.author &&
        String(row.edition) === expected.edition &&
        String(row.format) === expected.format &&
        String(row.language) === expected.language &&
        (expected.book ? true : String(row.created_at) === expected.createdAt);
      if (!matches) throw new Error("阅读来源与原件绑定或元数据不一致。");
      if (expected.book) {
        const bookRows = await q.all<Row>(
          "SELECT * FROM book_revisions WHERE tenant_id=? AND book_id=? AND revision=?",
          [expected.tenantId, expected.book.bookId, expected.book.revision],
        );
        const book = bookRows[0];
        if (
          bookRows.length !== 1 ||
          row.book_id !== expected.book.bookId ||
          safeInteger(row.book_revision as number | string, "书籍版本") !==
            expected.book.revision ||
          book!.storage_kind !== expected.book.storageKind ||
          book!.provider_id !== expected.book.providerId ||
          book!.object_ref !== expected.book.objectRef ||
          book!.sha256 !== expected.book.sha256 ||
          safeInteger(book!.byte_length as number | string, "字节长度") !==
            expected.book.byteLength ||
          book!.parser_version !== expected.book.parserVersion
        )
          throw new Error("阅读器自有原件字节绑定不一致。");
        const commit = expected.bookCommit;
        if (!commit) throw new Error("书籍提交回执缺失。");
        const events = await q.all<Row>(
          "SELECT * FROM reader_book_events WHERE tenant_id=? AND command_id=?",
          [expected.tenantId, commit.commandId],
        );
        const event = events[0];
        if (
          events.length !== 1 ||
          event!.request_hash !== bookRequestHash(expected) ||
          event!.book_id !== expected.book.bookId ||
          safeInteger(event!.book_revision as number | string, "书籍版本") !==
            expected.book.revision ||
          event!.project_id !== commit.projectId ||
          event!.principal_id !== commit.principalId ||
          event!.actant_id !== commit.actantId ||
          event!.runtime_input_id !== commit.runtimeInputId ||
          event!.runtime_task_run_event_id !== commit.runtimeTaskRunEventId ||
          event!.title !== expected.title
        )
          throw new Error("书籍提交回执与重试请求不一致。");
      } else if (row.book_id !== null || row.book_revision !== null)
        throw new Error("外部阅读原件错误绑定了阅读器书籍。");

      const sections = await q.all<Row>(
        "SELECT * FROM book_sections WHERE tenant_id=? AND reading_source_id=? AND (ordinal<? OR section_kind='native') ORDER BY ordinal",
        [expected.tenantId, expected.readingSourceId, expected.sections.length],
      );
      if (sections.length !== expected.sections.length)
        throw new Error("阅读章节数量不一致。");
      for (const [ordinal, section] of expected.sections.entries()) {
        const saved = sections[ordinal]!;
        if (
          saved.section_id !== section.id ||
          safeInteger(saved.ordinal as number | string, "章节顺序") !==
            ordinal ||
          saved.section_kind !== (section.ocr ? "ocr" : "native") ||
          (saved.page_number === null
            ? undefined
            : safeInteger(saved.page_number as number | string, "页码")) !==
            section.pageNumber ||
          saved.title !== section.title ||
          safeInteger(saved.character_count as number | string, "文字长度") !==
            section.text.length ||
          saved.source_html !== section.html
        )
          throw new Error("阅读章节元数据不一致。");
        const chunks = await q.all<Row>(
          "SELECT * FROM book_text_chunks WHERE tenant_id=? AND reading_source_id=? AND section_id=? ORDER BY chunk_index",
          [expected.tenantId, expected.readingSourceId, section.id],
        );
        const count = Math.ceil(section.text.length / 4000);
        if (chunks.length !== count)
          throw new Error("阅读文本分块数量不一致。");
        for (const [index, chunk] of chunks.entries()) {
          const start = index * 4000;
          const end = Math.min(start + 4000, section.text.length);
          if (
            safeInteger(chunk.chunk_index as number | string, "文本块序号") !==
              index ||
            safeInteger(chunk.start_offset as number | string, "文本块起点") !==
              start ||
            safeInteger(chunk.end_offset as number | string, "文本块终点") !==
              end ||
            (chunk.page_number === null
              ? undefined
              : safeInteger(
                  chunk.page_number as number | string,
                  "文本块页码",
                )) !== section.pageNumber ||
            chunk.body_text !== section.text.slice(start, end) ||
            chunk.extraction_kind !== (section.ocr ? "ocr" : "native")
          )
            throw new Error("阅读文本分块与原文不一致。");
        }
        const ocrRows = await q.all<Row>(
          "SELECT * FROM reading_ocr_versions WHERE tenant_id=? AND reading_source_id=? AND section_id=?",
          [expected.tenantId, expected.readingSourceId, section.id],
        );
        if (ocrRows.length !== (section.ocr ? 1 : 0))
          throw new Error("阅读 OCR 版本数量不一致。");
        if (section.ocr) {
          const body = JSON.stringify(section.ocr);
          if (
            ocrRows[0]!.result_body !== body ||
            ocrRows[0]!.result_digest !== hash(body) ||
            safeInteger(
              ocrRows[0]!.page_number as number | string,
              "OCR 页码",
            ) !== section.pageNumber ||
            ocrRows[0]!.engine !== section.ocr.engine ||
            ocrRows[0]!.layout !== section.ocr.layout ||
            ocrRows[0]!.parent_section_id !== (section.ocr.parent ?? null)
          )
            throw new Error("阅读 OCR 版本与旧结果不一致。");
        }
      }
    }, true);
  }

  /** Proof for exactly one committed Reader original; no Platform caller may
   * invent an app object or relocate a receipt to a different project. */
  async verifyCommittedBook(request: {
    tenantId: string;
    principalId: string;
    actantId: string;
    runtimeInputId: string | null;
    runtimeTaskRunEventId: string | null;
    instanceId: string;
    objectId: string;
    projectId: string;
    kind: string;
    title: string;
    versionRef: string;
    receiptId: string;
  }): Promise<boolean> {
    return this.transaction(async (q) => {
      const rows = await q.all<Row>(
        `SELECT e.*,s.source_app_id,s.source_instance_id,s.source_object_id,
                s.source_version_ref,s.title AS source_title,b.owner_principal_id
         FROM reader_book_events e
         JOIN reading_sources s ON s.tenant_id=e.tenant_id
           AND s.book_id=e.book_id AND s.book_revision=e.book_revision
         JOIN books b ON b.tenant_id=e.tenant_id AND b.book_id=e.book_id
         WHERE e.tenant_id=? AND e.event_id=?`,
        [request.tenantId, request.receiptId],
      );
      const row = rows[0];
      return (
        rows.length === 1 &&
        request.kind === "publication" &&
        row!.principal_id === request.principalId &&
        row!.actant_id === request.actantId &&
        row!.runtime_input_id === request.runtimeInputId &&
        row!.runtime_task_run_event_id === request.runtimeTaskRunEventId &&
        row!.project_id === request.projectId &&
        row!.book_id === request.objectId &&
        row!.owner_principal_id === request.principalId &&
        row!.title === request.title &&
        row!.source_title === request.title &&
        String(row!.book_revision) === request.versionRef &&
        row!.source_app_id === "morphz.reader" &&
        row!.source_instance_id === request.instanceId &&
        row!.source_object_id === request.objectId &&
        row!.source_version_ref === request.versionRef
      );
    }, true);
  }

  async pendingDirectoryEvents(
    tenantId: string,
    limit = 100,
    after?: { createdAt: string; eventId: string },
  ) {
    ensureId(tenantId, "租户");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("目录待投影分页大小无效。");
    if (after) {
      instant(after.createdAt);
      ensureId(after.eventId, "事件");
    }
    return this.transaction(async (q) => {
      const rows = await q.all<Row>(
        `SELECT * FROM reader_book_events WHERE tenant_id=? AND projected_at IS NULL
         ${after ? "AND (created_at>? OR (created_at=? AND event_id>?))" : ""}
         ORDER BY created_at,event_id LIMIT ?`,
        after
          ? [tenantId, after.createdAt, after.createdAt, after.eventId, limit]
          : [tenantId, limit],
      );
      return rows.map((row) => ({
        eventId: String(row.event_id),
        bookId: String(row.book_id),
        versionRef: String(row.book_revision),
        projectId: String(row.project_id),
        principalId: String(row.principal_id),
        actantId: String(row.actant_id),
        runtimeInputId:
          row.runtime_input_id === null ? null : String(row.runtime_input_id),
        runtimeTaskRunEventId:
          row.runtime_task_run_event_id === null
            ? null
            : String(row.runtime_task_run_event_id),
        title: String(row.title),
        createdAt: String(row.created_at),
      }));
    }, true);
  }

  async markDirectoryProjected(tenantId: string, eventId: string) {
    ensureId(tenantId, "租户");
    ensureId(eventId, "目录事件");
    await this.transaction(async (q) => {
      const changed = await q.change(
        "UPDATE reader_book_events SET projected_at=? WHERE tenant_id=? AND event_id=? AND projected_at IS NULL",
        [new Date().toISOString(), tenantId, eventId],
      );
      if (changed) return;
      const rows = await q.all(
        "SELECT 1 AS present FROM reader_book_events WHERE tenant_id=? AND event_id=? AND projected_at IS NOT NULL",
        [tenantId, eventId],
      );
      if (!rows.length) throw new Error("书籍目录投影事件不存在。");
    });
  }

  async bookOverview(request: {
    credential: string;
    tenantId: string;
    readingSourceId: string;
    principalId: string;
    inputId?: string;
  }) {
    const { original } = await this.authorizeSource({
      ...request,
      action: "read",
    });
    return this.transaction(async (q) => {
      const source = await this.checkedSource(
        q,
        request.tenantId,
        request.readingSourceId,
        original,
      );
      if (source.source_kind !== "reader_book")
        throw new ReaderStorageError("invalid", "此阅读来源不是书籍原件。");
      const rows = await q.all<Row>(
        `SELECT b.owner_principal_id,b.created_at,r.sha256,r.byte_length,e.actant_id,
                (SELECT COUNT(*) FROM book_sections s WHERE s.tenant_id=r.tenant_id
                  AND s.reading_source_id=? AND s.section_kind='native') AS section_count
         FROM books b JOIN book_revisions r ON r.tenant_id=b.tenant_id AND r.book_id=b.book_id
         JOIN reader_book_events e ON e.tenant_id=r.tenant_id
           AND e.book_id=r.book_id AND e.book_revision=r.revision
         WHERE b.tenant_id=? AND b.book_id=? AND r.revision=?
        `,
        [
          request.readingSourceId,
          request.tenantId,
          String(source.book_id),
          safeInteger(source.book_revision as number | string, "书籍版本"),
        ],
      );
      if (rows.length !== 1) throw new Error("书籍原件或章节不完整。");
      const row = rows[0]!;
      const sectionRows = await q.all<Row>(
        `SELECT section_id,title,character_count FROM book_sections
         WHERE tenant_id=? AND reading_source_id=? AND section_kind='native'
         ORDER BY ordinal LIMIT 2001`,
        [request.tenantId, request.readingSourceId],
      );
      if (
        sectionRows.length !== Number(row.section_count) ||
        sectionRows.length < 1 ||
        sectionRows.length > 2000
      )
        throw new Error("书籍目录与派生章节不一致。");
      return {
        bookId: String(source.book_id),
        title: String(source.title),
        author: String(source.author),
        edition: String(source.edition),
        format: String(source.format),
        revision: safeInteger(
          source.book_revision as number | string,
          "书籍版本",
        ),
        sha256: String(row.sha256),
        byteLength: safeInteger(row.byte_length as number | string, "字节长度"),
        sectionCount: safeInteger(
          row.section_count as number | string,
          "章节数量",
        ),
        sections: sectionRows.map((section) => ({
          id: String(section.section_id),
          title: String(section.title),
          characters: safeInteger(
            section.character_count as number | string,
            "章节长度",
          ),
        })),
        ownerPrincipalId: String(row.owner_principal_id),
        authorActantId: String(row.actant_id),
        createdAt: String(row.created_at),
      };
    }, true);
  }

  /** Current owning-app grant plus this Human's reading metadata; no text. */
  async workspaceChangeVersion(request: { credential: string; appId: string; instanceId: string; objectId: string }) {
    const actor = await this.authority.resolveActor({ credential: request.credential });
    if (!actor || actor.kind !== "human") throw new ReaderStorageError("forbidden", "阅读通知需要用户身份。");
    const sources = await this.transaction(q => q.all<Row>("SELECT tenant_id,reading_source_id,source_app_id,source_instance_id,source_object_id,source_version_ref FROM reading_sources WHERE tenant_id=? AND source_app_id=? AND source_instance_id=? AND source_object_id=? ORDER BY reading_source_id", [actor.tenantId, request.appId, request.instanceId, request.objectId]), true);
    const authorize = async () => {
      for (const source of sources) await this.authority.verifyAccess({ credential: request.credential, original: originalFromRow(source), principalId: actor.principalId, action: "read" });
    };
    await authorize();
    const metadata = await this.transaction(async q => ({
      positions: await q.all("SELECT p.reading_source_id,p.revision FROM reading_positions p JOIN reading_sources s ON s.tenant_id=p.tenant_id AND s.reading_source_id=p.reading_source_id WHERE p.tenant_id=? AND p.principal_id=? AND s.source_app_id=? AND s.source_instance_id=? AND s.source_object_id=? ORDER BY p.reading_source_id", [actor.tenantId, actor.principalId, request.appId, request.instanceId, request.objectId]),
      marks: await q.all("SELECT m.mark_id,m.revision,m.deleted_at FROM reading_marks m JOIN reading_sources s ON s.tenant_id=m.tenant_id AND s.reading_source_id=m.reading_source_id WHERE m.tenant_id=? AND m.principal_id=? AND s.source_app_id=? AND s.source_instance_id=? AND s.source_object_id=? ORDER BY m.mark_id", [actor.tenantId, actor.principalId, request.appId, request.instanceId, request.objectId]),
    }), true);
    await authorize();
    return createHash("sha256").update(JSON.stringify({ sources, metadata })).digest("hex");
  }

  /** App-authoritative book head; text/bytes are never read for a watch baseline. */
  async readBookHead(request: { credential: string; bookId: string }) {
    ensureId(request.bookId, "书籍");
    const actor = await this.authority.resolveActor({
      credential: request.credential,
    });
    if (!actor) throw new ReaderStorageError("forbidden", "阅读身份无效。");
    const source = await this.transaction(async (q) => {
      const rows = await q.all<Row>(
        "SELECT s.tenant_id,s.source_app_id,s.source_instance_id,s.source_object_id,s.source_version_ref,r.revision FROM books b JOIN book_revisions r ON r.tenant_id=b.tenant_id AND r.book_id=b.book_id AND r.revision=b.head_revision JOIN reading_sources s ON s.tenant_id=r.tenant_id AND s.book_id=r.book_id AND s.book_revision=r.revision WHERE b.tenant_id=? AND b.book_id=? AND b.deleted_at IS NULL",
        [actor.tenantId, request.bookId],
      );
      if (rows.length !== 1)
        throw new ReaderStorageError("not_found", "书籍当前精确版本不存在。");
      return rows[0]!;
    }, true);
    const original = originalFromRow(source);
    const versionRef = String(safeInteger(String(source.revision), "书籍修订"));
    if (
      original.objectId !== request.bookId ||
      original.appId !== "morphz.reader" ||
      original.versionRef !== versionRef
    )
      throw new ReaderStorageError("conflict", "书籍原件身份已变化。");
    // Metadata reads use the live owning-app grant. They do not require a
    // selected reading passage or pretend a scheduled Agent has Human input.
    await this.authority.verifyAccess({
      credential: request.credential,
      original,
      principalId: actor.principalId,
      ...(actor.inputId ? { inputId: actor.inputId } : {}),
      action: "read",
    });
    return { bookId: request.bookId, versionRef };
  }

  /** Host-only lookup before deriving a source from an immutable original.
   * A reused ID with a different binding must fail instead of serving stale
   * text or annotations. The caller authorizes the original first.
   */
  async hasSourceBinding(request: {
    tenantId: string;
    readingSourceId: string;
    original: ReaderOriginal;
  }): Promise<boolean> {
    return this.transaction(async (q) => {
      const rows = await q.all<Row>(
        "SELECT source_app_id,source_instance_id,source_object_id,source_version_ref FROM reading_sources WHERE tenant_id=? AND reading_source_id=?",
        [request.tenantId, request.readingSourceId],
      );
      if (!rows.length) return false;
      const row = rows[0]!;
      if (
        rows.length !== 1 ||
        row.source_app_id !== request.original.appId ||
        row.source_instance_id !== request.original.instanceId ||
        row.source_object_id !== request.original.objectId ||
        row.source_version_ref !== request.original.versionRef ||
        request.original.tenantId !== request.tenantId
      )
        throw new Error("阅读来源与原件绑定不一致。");
      return true;
    }, true);
  }

  private async source(q: SqlQuery, tenantId: string, readingSourceId: string) {
    const rows = await q.all<Row>(
      "SELECT * FROM reading_sources WHERE tenant_id=? AND reading_source_id=?",
      [tenantId, readingSourceId],
    );
    if (rows.length !== 1)
      throw new ReaderStorageError("not_found", "阅读来源不存在。");
    return rows[0]!;
  }

  private async authorizeSource(request: {
    credential: string;
    tenantId: string;
    readingSourceId?: string;
    principalId: string;
    inputId?: string;
    action: "read" | "annotate";
    markId?: string;
  }): Promise<{ original: ReaderOriginal; readingSourceId: string }> {
    if (!request.credential || request.credential.length > 4096)
      throw new Error("缺少已认证的阅读身份。");
    const actor = await this.authority.resolveActor({
      credential: request.credential,
    });
    if (
      !actor ||
      actor.tenantId !== request.tenantId ||
      actor.principalId !== request.principalId ||
      actor.inputId !== (request.inputId ?? null) ||
      (actor.kind === "agent" && actor.inputId === null)
    )
      throw new ReaderStorageError(
        "forbidden",
        "阅读身份与已认证的发起者不符。",
      );
    const binding = await this.transaction(async (q) => {
      let readingSourceId = request.readingSourceId;
      if (request.markId) {
        const marks = await q.all<Row>(
          "SELECT reading_source_id FROM reading_marks WHERE tenant_id=? AND mark_id=? AND principal_id=?",
          [request.tenantId, request.markId, request.principalId],
        );
        if (marks.length !== 1)
          throw new ReaderStorageError(
            "not_found",
            "标注不存在或不属于当前身份。",
          );
        if (
          readingSourceId !== undefined &&
          marks[0]!.reading_source_id !== readingSourceId
        )
          throw new Error("标注的阅读来源已变化。");
        readingSourceId = String(marks[0]!.reading_source_id);
      }
      if (!readingSourceId)
        throw new ReaderStorageError("invalid", "阅读来源未指定。");
      return {
        readingSourceId,
        original: originalFromRow(
          await this.source(q, request.tenantId, readingSourceId),
        ),
      };
    }, true);
    // The owning app/Platform may perform I/O. Never hold the SQLite writer
    // lock or a PostgreSQL transaction while waiting for that authority.
    await this.authority.verifyAccess({
      credential: request.credential,
      original: binding.original,
      principalId: request.principalId,
      inputId: request.inputId,
      action: request.action,
    });
    return binding;
  }

  private async checkedSource(
    q: SqlQuery,
    tenantId: string,
    readingSourceId: string,
    original: ReaderOriginal,
  ) {
    const source = await this.source(q, tenantId, readingSourceId);
    const current = originalFromRow(source);
    if (
      Object.entries(original).some(
        ([key, value]) => current[key as keyof ReaderOriginal] !== value,
      )
    )
      throw new Error("阅读来源的原件绑定已经变化。");
    return source;
  }

  private async sectionSlice(
    q: SqlQuery,
    tenantId: string,
    readingSourceId: string,
    sectionId: string,
    offset: number,
    limit: number,
  ) {
    const sections = await q.all<Row>(
      "SELECT character_count FROM book_sections WHERE tenant_id=? AND reading_source_id=? AND section_id=?",
      [tenantId, readingSourceId, sectionId],
    );
    if (sections.length !== 1)
      throw new ReaderStorageError("not_found", "章节不存在。");
    const total = safeInteger(
      sections[0]!.character_count as number | string,
      "章节长度",
    );
    const end = Math.min(total, offset + limit);
    const chunks =
      end <= offset
        ? []
        : await q.all<Row>(
            "SELECT start_offset,end_offset,body_text FROM book_text_chunks WHERE tenant_id=? AND reading_source_id=? AND section_id=? AND end_offset>? AND start_offset<? ORDER BY start_offset",
            [tenantId, readingSourceId, sectionId, offset, end],
          );
    let cursor = offset;
    let text = "";
    for (const chunk of chunks) {
      const start = safeInteger(
        chunk.start_offset as number | string,
        "分块起点",
      );
      const chunkEnd = safeInteger(
        chunk.end_offset as number | string,
        "分块终点",
      );
      const body = String(chunk.body_text);
      if (body.length !== chunkEnd - start || start > cursor)
        throw new Error("阅读分块不连续或长度异常。");
      const right = Math.min(end, chunkEnd);
      text += body.slice(cursor - start, right - start);
      cursor = right;
    }
    if (cursor !== Math.max(offset, end)) throw new Error("阅读分块缺失。");
    return { text, totalCharacters: total };
  }

  /** Bounded application-domain read, with current original permission rechecked. */
  async listSections(request: {
    credential: string;
    tenantId: string;
    readingSourceId: string;
    principalId: string;
    inputId?: string;
    afterOrdinal?: number;
    limit: number;
  }) {
    if (
      !Number.isSafeInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > 100 ||
      (request.afterOrdinal !== undefined &&
        (!Number.isSafeInteger(request.afterOrdinal) ||
          request.afterOrdinal < 0))
    )
      throw new Error("章节分页范围无效。");
    const { original } = await this.authorizeSource({
      ...request,
      action: "read",
    });
    return this.transaction(async (q) => {
      await this.checkedSource(
        q,
        request.tenantId,
        request.readingSourceId,
        original,
      );
      const rows = await q.all<Row>(
        `SELECT section_id,title,character_count,ordinal FROM book_sections
         WHERE tenant_id=? AND reading_source_id=? AND section_kind='native'
         ${request.afterOrdinal === undefined ? "" : "AND ordinal>?"}
         ORDER BY ordinal LIMIT ?`,
        request.afterOrdinal === undefined
          ? [request.tenantId, request.readingSourceId, request.limit]
          : [
              request.tenantId,
              request.readingSourceId,
              request.afterOrdinal,
              request.limit,
            ],
      );
      return rows.map((row) => ({
        sectionId: String(row.section_id),
        title: String(row.title),
        characters: safeInteger(
          row.character_count as number | string,
          "章节长度",
        ),
        ordinal: safeInteger(row.ordinal as number | string, "章节顺序"),
      }));
    }, true);
  }

  /** Bounded application-domain read, with current original permission rechecked. */
  async readSection(request: {
    credential: string;
    tenantId: string;
    readingSourceId: string;
    sectionId: string;
    principalId: string;
    inputId?: string;
    offset: number;
    limit: number;
  }) {
    if (
      !Number.isSafeInteger(request.offset) ||
      request.offset < 0 ||
      !Number.isSafeInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > 8000
    )
      throw new Error("阅读范围无效。");
    const { original } = await this.authorizeSource({
      ...request,
      action: "read",
    });
    return this.transaction(async (q) => {
      const source = await this.checkedSource(
        q,
        request.tenantId,
        request.readingSourceId,
        original,
      );
      const titleRows = await q.all<{ title: string }>(
        "SELECT title FROM book_sections WHERE tenant_id=? AND reading_source_id=? AND section_id=?",
        [request.tenantId, request.readingSourceId, request.sectionId],
      );
      if (titleRows.length !== 1)
        throw new ReaderStorageError("not_found", "章节不存在。");
      const slice = await this.sectionSlice(
        q,
        request.tenantId,
        request.readingSourceId,
        request.sectionId,
        request.offset,
        request.limit,
      );
      return {
        sourceLocatorId: String(source.source_locator_id),
        title: titleRows[0]!.title,
        ...slice,
      };
    }, true);
  }

  /** Authenticate a pinned reading position without loading the chapter. */
  async sectionMetadata(request: {
    credential: string;
    tenantId: string;
    readingSourceId: string;
    sectionId: string;
    principalId: string;
    inputId?: string;
  }) {
    const { original } = await this.authorizeSource({
      ...request,
      action: "read",
    });
    return this.transaction(async (q) => {
      const source = await this.checkedSource(
        q,
        request.tenantId,
        request.readingSourceId,
        original,
      );
      const rows = await q.all<{
        title: string;
        character_count: number | string;
        section_kind: string;
      }>(
        "SELECT title,character_count,section_kind FROM book_sections WHERE tenant_id=? AND reading_source_id=? AND section_id=?",
        [request.tenantId, request.readingSourceId, request.sectionId],
      );
      if (rows.length !== 1)
        throw new ReaderStorageError("not_found", "章节不存在。");
      return {
        sourceLocatorId: String(source.source_locator_id),
        title: String(rows[0]!.title),
        totalCharacters: safeInteger(rows[0]!.character_count, "章节长度"),
        book: {
          title: String(source.title),
          author: String(source.author),
          edition: String(source.edition),
          format:
            rows[0]!.section_kind === "ocr" ? "pdf-ocr" : String(source.format),
        },
      };
    }, true);
  }

  /** One authenticated chapter for the visible reader, never the whole book.
   * source_html is canonical inert HTML produced at import. The text chunks
   * are checked independently so selection offsets match Agent references.
   */
  async readDisplaySection(request: {
    credential: string;
    tenantId: string;
    readingSourceId: string;
    sectionId: string;
    principalId: string;
    inputId?: string;
  }) {
    const { original } = await this.authorizeSource({
      ...request,
      action: "read",
    });
    return this.transaction(async (q) => {
      const source = await this.checkedSource(
        q,
        request.tenantId,
        request.readingSourceId,
        original,
      );
      const rows = await q.all<Row>(
        "SELECT title,character_count,source_html,section_kind FROM book_sections WHERE tenant_id=? AND reading_source_id=? AND section_id=?",
        [request.tenantId, request.readingSourceId, request.sectionId],
      );
      if (rows.length !== 1)
        throw new ReaderStorageError("not_found", "章节不存在。");
      const row = rows[0]!;
      const characters = safeInteger(
        row.character_count as number | string,
        "章节长度",
      );
      if (characters > 1_000_000 || String(row.source_html).length > 4_000_000)
        throw new Error("章节超过阅读器限制。");
      const { text } = await this.sectionSlice(
        q,
        request.tenantId,
        request.readingSourceId,
        request.sectionId,
        0,
        characters,
      );
      let ocr: ReadingOcr | undefined;
      if (row.section_kind === "ocr") {
        const versions = await q.all<Row>(
          "SELECT result_body,result_digest FROM reading_ocr_versions WHERE tenant_id=? AND reading_source_id=? AND section_id=?",
          [request.tenantId, request.readingSourceId, request.sectionId],
        );
        if (
          versions.length !== 1 ||
          hash(String(versions[0]!.result_body)) !== versions[0]!.result_digest
        )
          throw new Error("OCR 结果缺失或摘要不匹配。");
        ocr = JSON.parse(String(versions[0]!.result_body)) as ReadingOcr;
        ocrResultSchema.parse({ image: ocr.image, items: ocr.items });
        ocrLayoutSchema.parse(ocr.layout);
        if (
          text !==
          ocr.items.map((item) => item.correction ?? item.text).join("\n")
        )
          throw new Error("OCR 文本与原始识别结果不一致。");
      }
      return {
        id: request.sectionId,
        title: String(row.title),
        html: String(row.source_html),
        text,
        sourceId: String(source.source_locator_id),
        ...(ocr ? { ocr } : {}),
        book: {
          title: String(source.title),
          author: String(source.author),
          edition: String(source.edition),
          format: ocr ? "pdf-ocr" : String(source.format),
        },
      };
    }, true);
  }

  /** Restore this person's position without exposing another reader's state. */
  async readPosition(request: {
    credential: string;
    tenantId: string;
    readingSourceId: string;
    principalId: string;
    inputId?: string;
  }) {
    const { original } = await this.authorizeSource({
      ...request,
      action: "read",
    });
    return this.transaction(async (q) => {
      const source = await this.checkedSource(
        q,
        request.tenantId,
        request.readingSourceId,
        original,
      );
      const rows = await q.all<Row>(
        "SELECT section_id,start_offset,end_offset,font_size,font_family,theme,revision,updated_at FROM reading_positions WHERE tenant_id=? AND reading_source_id=? AND principal_id=?",
        [request.tenantId, request.readingSourceId, request.principalId],
      );
      if (!rows.length) return null;
      const row = rows[0]!;
      return {
        readingSourceId: request.readingSourceId,
        location: readingLocationSchema.parse({
          sourceId: String(source.source_locator_id),
          sectionId: String(row.section_id),
          start: safeInteger(row.start_offset as number | string, "阅读起点"),
          end: safeInteger(row.end_offset as number | string, "阅读终点"),
        }),
        preferences: readingPreferencesSchema.parse({
          fontSize: safeInteger(row.font_size as number | string, "字号"),
          font: String(row.font_family),
          theme: String(row.theme),
        }),
        revision: safeInteger(row.revision as number | string, "阅读进度修订"),
        updatedAt: String(row.updated_at),
      };
    }, true);
  }

  /** OCR is a Reader-owned, immutable derived version of one PDF page. The
   * original book bytes and the Platform catalog are never revised here. */
  async saveOcrVersion(request: {
    credential: string;
    tenantId: string;
    readingSourceId: string;
    principalId: string;
    inputId?: string;
    page: number;
    result: ReadingOcr;
  }): Promise<string> {
    if (
      !Number.isSafeInteger(request.page) ||
      request.page < 1 ||
      request.page > 300
    )
      throw new ReaderStorageError("invalid", "PDF 页码无效。");
    ocrResultSchema.parse({
      image: request.result.image,
      items: request.result.items,
    });
    ocrLayoutSchema.parse(request.result.layout);
    if (
      !request.result.engine ||
      request.result.engine.length > 200 ||
      (request.result.parent &&
        !/^page-[1-9]\d*-ocr-[a-f0-9]{64}$/.test(request.result.parent))
    )
      throw new ReaderStorageError("invalid", "OCR 引擎或来源版本无效。");
    const body = JSON.stringify(request.result);
    const digest = hash(body);
    const sectionId = `page-${request.page}-ocr-${digest}`;
    const text = request.result.items
      .map((item) => item.correction ?? item.text)
      .join("\n");
    const html = `<pre>${text.replace(
      /[&<>]/g,
      (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character]!,
    )}</pre>`;
    const { original } = await this.authorizeSource({
      ...request,
      action: "annotate",
    });
    return this.transaction(async (q) => {
      const source = await this.checkedSource(
        q,
        request.tenantId,
        request.readingSourceId,
        original,
      );
      if (source.format !== "pdf" || source.source_kind !== "reader_book")
        throw new ReaderStorageError(
          "invalid",
          "只能识别阅读器中的 PDF 原件。",
        );
      // Serialize appends for one source on PostgreSQL; SQLite already has a
      // single-writer gate. No cross-domain transaction is involved.
      if (this.backend.kind === "postgres")
        await q.all(
          "SELECT reading_source_id FROM reading_sources WHERE tenant_id=? AND reading_source_id=? FOR UPDATE",
          [request.tenantId, request.readingSourceId],
        );
      const native = await q.all(
        "SELECT 1 AS present FROM book_sections WHERE tenant_id=? AND reading_source_id=? AND section_id=? AND section_kind='native' AND page_number=?",
        [
          request.tenantId,
          request.readingSourceId,
          `page-${request.page}`,
          request.page,
        ],
      );
      if (native.length !== 1)
        throw new ReaderStorageError("invalid", "请选择存在的 PDF 页面。");
      const existing = await q.all<Row>(
        "SELECT result_body,result_digest FROM reading_ocr_versions WHERE tenant_id=? AND reading_source_id=? AND section_id=?",
        [request.tenantId, request.readingSourceId, sectionId],
      );
      if (existing.length) {
        if (
          existing.length !== 1 ||
          existing[0]!.result_digest !== digest ||
          existing[0]!.result_body !== body
        )
          throw new Error("OCR 版本摘要对应了不同结果，拒绝覆盖。");
        return sectionId;
      }
      if (request.result.parent) {
        const parent = await q.all(
          "SELECT 1 AS present FROM reading_ocr_versions WHERE tenant_id=? AND reading_source_id=? AND section_id=? AND page_number=?",
          [
            request.tenantId,
            request.readingSourceId,
            request.result.parent,
            request.page,
          ],
        );
        if (parent.length !== 1)
          throw new ReaderStorageError(
            "conflict",
            "OCR 校对的来源版本已失效。",
          );
      }
      const last = (
        await q.all<{ ordinal: number | string }>(
          "SELECT MAX(ordinal) AS ordinal FROM book_sections WHERE tenant_id=? AND reading_source_id=?",
          [request.tenantId, request.readingSourceId],
        )
      )[0];
      const ordinal =
        last?.ordinal === null || last?.ordinal === undefined
          ? 0
          : safeInteger(last.ordinal, "章节顺序") + 1;
      const now = new Date().toISOString();
      await insert(q, "book_sections", {
        tenant_id: request.tenantId,
        reading_source_id: request.readingSourceId,
        section_id: sectionId,
        ordinal,
        section_kind: "ocr",
        page_number: request.page,
        title: `第 ${request.page} 页 · OCR 识别文本（需核对）`,
        character_count: text.length,
        source_html: html,
      });
      for (let start = 0, index = 0; start < text.length; index++) {
        const end = Math.min(start + 4000, text.length);
        await insert(q, "book_text_chunks", {
          tenant_id: request.tenantId,
          reading_source_id: request.readingSourceId,
          section_id: sectionId,
          chunk_index: index,
          start_offset: start,
          end_offset: end,
          page_number: request.page,
          body_text: text.slice(start, end),
          extraction_kind: "ocr",
        });
        start = end;
      }
      await insert(q, "reading_ocr_versions", {
        tenant_id: request.tenantId,
        reading_source_id: request.readingSourceId,
        section_id: sectionId,
        page_number: request.page,
        result_digest: digest,
        engine: request.result.engine,
        layout: request.result.layout,
        parent_section_id: request.result.parent ?? null,
        result_body: body,
        created_at: now,
      });
      return sectionId;
    });
  }

  async latestOcrVersion(request: {
    credential: string;
    tenantId: string;
    readingSourceId: string;
    principalId: string;
    inputId?: string;
    page: number;
  }): Promise<string | null> {
    if (
      !Number.isSafeInteger(request.page) ||
      request.page < 1 ||
      request.page > 300
    )
      throw new ReaderStorageError("invalid", "PDF 页码无效。");
    const { original } = await this.authorizeSource({
      ...request,
      action: "read",
    });
    return this.transaction(async (q) => {
      const source = await this.checkedSource(
        q,
        request.tenantId,
        request.readingSourceId,
        original,
      );
      if (source.format !== "pdf" || source.source_kind !== "reader_book")
        throw new ReaderStorageError("invalid", "此阅读来源不是 PDF 原件。");
      const native = await q.all(
        "SELECT 1 AS present FROM book_sections WHERE tenant_id=? AND reading_source_id=? AND section_id=? AND section_kind='native' AND page_number=?",
        [
          request.tenantId,
          request.readingSourceId,
          `page-${request.page}`,
          request.page,
        ],
      );
      if (native.length !== 1)
        throw new ReaderStorageError("invalid", "请选择存在的 PDF 页面。");
      const rows = await q.all<{ section_id: string }>(
        "SELECT o.section_id FROM reading_ocr_versions o JOIN book_sections s ON s.tenant_id=o.tenant_id AND s.reading_source_id=o.reading_source_id AND s.section_id=o.section_id WHERE o.tenant_id=? AND o.reading_source_id=? AND o.page_number=? ORDER BY o.created_at DESC,s.ordinal DESC LIMIT 1",
        [request.tenantId, request.readingSourceId, request.page],
      );
      return rows[0]?.section_id ?? null;
    }, true);
  }

  async readOcrVersion(request: {
    credential: string;
    tenantId: string;
    readingSourceId: string;
    sectionId: string;
    principalId: string;
    inputId?: string;
  }): Promise<ReadingOcr> {
    const { original } = await this.authorizeSource({
      ...request,
      action: "read",
    });
    return this.transaction(async (q) => {
      await this.checkedSource(
        q,
        request.tenantId,
        request.readingSourceId,
        original,
      );
      const rows = await q.all<Row>(
        "SELECT result_body,result_digest FROM reading_ocr_versions WHERE tenant_id=? AND reading_source_id=? AND section_id=?",
        [request.tenantId, request.readingSourceId, request.sectionId],
      );
      if (rows.length !== 1) throw new Error("OCR 版本不存在。");
      const body = String(rows[0]!.result_body);
      if (hash(body) !== rows[0]!.result_digest)
        throw new Error("OCR 结果摘要不匹配。");
      const result = JSON.parse(body) as ReadingOcr;
      ocrResultSchema.parse({ image: result.image, items: result.items });
      ocrLayoutSchema.parse(result.layout);
      if (typeof result.engine !== "string" || !result.engine)
        throw new Error("OCR 结果引擎无效。");
      return result;
    }, true);
  }

  /** A current permission check precedes even an idempotent receipt lookup. */
  async command(request: ReaderDomainCommand) {
    ensureId(request.tenantId, "租户");
    ensureId(request.principalId, "发起者");
    ensureId(request.commandId, "命令");
    const action = actionSchema.parse(request.action);
    const requestHash = hash(
      JSON.stringify({
        tenantId: request.tenantId,
        principalId: request.principalId,
        inputId: request.inputId ?? null,
        expectedReadingSourceId: request.expectedReadingSourceId ?? null,
        action,
      }),
    );
    const { original, readingSourceId } = await this.authorizeSource({
      ...request,
      action: "annotate",
      ...("markId" in action
        ? {
            markId: action.markId,
            ...(request.expectedReadingSourceId
              ? { readingSourceId: request.expectedReadingSourceId }
              : {}),
          }
        : { readingSourceId: action.readingSourceId }),
    });
    return this.transaction(async (q) => {
      const markRows =
        "markId" in action
          ? await q.all<Row>(
              "SELECT * FROM reading_marks WHERE tenant_id=? AND mark_id=? AND principal_id=?",
              [request.tenantId, action.markId, request.principalId],
            )
          : [];
      if ("markId" in action && markRows.length !== 1)
        throw new ReaderStorageError(
          "not_found",
          "标注不存在或不属于当前身份。",
        );
      const mark = markRows[0];
      if (mark && mark.reading_source_id !== readingSourceId)
        throw new Error("标注的阅读来源已变化。");
      const source = await this.checkedSource(
        q,
        request.tenantId,
        readingSourceId,
        original,
      );
      if (this.backend.kind === "postgres")
        await q.all(
          "SELECT pg_advisory_xact_lock(hashtextextended(? || ':' || ? || ':' || ?, 0)) AS locked",
          [request.tenantId, readingSourceId, request.principalId],
        );
      const receipts = await q.all<Row>(
        "SELECT request_hash,result_ref,result_revision FROM reader_command_receipts WHERE tenant_id=? AND command_id=?",
        [request.tenantId, request.commandId],
      );
      if (receipts.length) {
        if (receipts[0]!.request_hash !== requestHash)
          throw new ReaderStorageError("conflict", "命令 ID 已用于不同请求。");
        return {
          id: String(receipts[0]!.result_ref),
          revision: safeInteger(
            receipts[0]!.result_revision as number | string,
            "回执修订",
          ),
        };
      }
      let id: string;
      let revision: number;
      const now = new Date().toISOString();
      if (action.action === "mark-add" || action.action === "save-position") {
        if (action.location.sourceId !== source.source_locator_id)
          throw new Error("原文定位与原件版本不符。");
        const location = action.location;
        const selected = await this.sectionSlice(
          q,
          request.tenantId,
          readingSourceId,
          location.sectionId,
          location.start,
          Math.max(1, location.end - location.start),
        );
        if (location.end > selected.totalCharacters)
          throw new Error("阅读位置超出原文。");
        if (action.action === "mark-add") {
          if (
            action.kind !== "bookmark" &&
            (location.start === location.end ||
              !action.quote.trim() ||
              selected.text.slice(0, location.end - location.start) !==
                action.quote)
          )
            throw new Error("标注选文与原文不符。");
          if (action.kind === "note" && !action.note.trim())
            throw new Error("批注内容不能为空。");
          const duplicates = await q.all<Row>(
            "SELECT mark_id,revision FROM reading_marks WHERE tenant_id=? AND reading_source_id=? AND principal_id=? AND section_id=? AND start_offset=? AND end_offset=? AND kind=? AND color=? AND note_text=? AND deleted_at IS NULL ORDER BY created_at,mark_id LIMIT 1",
            [
              request.tenantId,
              readingSourceId,
              request.principalId,
              location.sectionId,
              location.start,
              location.end,
              action.kind,
              action.color,
              action.note,
            ],
          );
          if (duplicates.length) {
            id = String(duplicates[0]!.mark_id);
            revision = safeInteger(
              duplicates[0]!.revision as number | string,
              "标注修订",
            );
          } else {
            id = randomUUID();
            revision = 1;
            await insert(q, "reading_marks", {
              tenant_id: request.tenantId,
              mark_id: id,
              reading_source_id: readingSourceId,
              principal_id: request.principalId,
              section_id: location.sectionId,
              start_offset: location.start,
              end_offset: location.end,
              quote_text: action.quote,
              kind: action.kind,
              color: action.color,
              note_text: action.note,
              revision,
              created_at: now,
              updated_at: now,
              deleted_at: null,
            });
          }
        } else {
          id = readingSourceId;
          revision = action.expectedRevision + 1;
          const fields = [
            location.sectionId,
            location.start,
            location.end,
            action.preferences.fontSize,
            action.preferences.font,
            action.preferences.theme,
            revision,
            now,
          ];
          const changed =
            action.expectedRevision === 0
              ? await q.change(
                  "INSERT INTO reading_positions(tenant_id,reading_source_id,principal_id,section_id,start_offset,end_offset,font_size,font_family,theme,revision,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,reading_source_id,principal_id) DO NOTHING",
                  [
                    request.tenantId,
                    readingSourceId,
                    request.principalId,
                    ...fields,
                  ],
                )
              : await q.change(
                  "UPDATE reading_positions SET section_id=?,start_offset=?,end_offset=?,font_size=?,font_family=?,theme=?,revision=?,updated_at=? WHERE tenant_id=? AND reading_source_id=? AND principal_id=? AND revision=?",
                  [
                    ...fields,
                    request.tenantId,
                    readingSourceId,
                    request.principalId,
                    action.expectedRevision,
                  ],
                );
          if (changed !== 1)
            throw new ReaderStorageError(
              "conflict",
              "阅读进度已被其他操作更新。",
            );
        }
      } else {
        id = action.markId;
        revision = action.expectedRevision + 1;
        if (action.action === "mark-update") {
          if (mark!.deleted_at !== null)
            throw new ReaderStorageError("conflict", "请先恢复此标注。");
          if (mark!.kind === "note" && !action.note.trim())
            throw new Error("批注内容不能为空。");
          if (
            (await q.change(
              "UPDATE reading_marks SET note_text=?,color=?,revision=?,updated_at=? WHERE tenant_id=? AND mark_id=? AND principal_id=? AND revision=? AND deleted_at IS NULL",
              [
                action.note,
                action.color,
                revision,
                now,
                request.tenantId,
                id,
                request.principalId,
                action.expectedRevision,
              ],
            )) !== 1
          )
            throw new ReaderStorageError("conflict", "标注已在其他位置更新。");
        } else if (
          (await q.change(
            "UPDATE reading_marks SET deleted_at=?,revision=?,updated_at=? WHERE tenant_id=? AND mark_id=? AND principal_id=? AND revision=?",
            [
              action.action === "mark-remove" ? now : null,
              revision,
              now,
              request.tenantId,
              id,
              request.principalId,
              action.expectedRevision,
            ],
          )) !== 1
        )
          throw new ReaderStorageError("conflict", "标注已在其他位置更新。");
      }
      await insert(q, "reader_command_receipts", {
        tenant_id: request.tenantId,
        command_id: request.commandId,
        request_hash: requestHash,
        operation: action.action,
        result_ref: id,
        result_revision: revision,
        committed_at: now,
      });
      return { id, revision };
    });
  }

  async listMarks(request: {
    credential: string;
    tenantId: string;
    readingSourceId: string;
    principalId: string;
    inputId?: string;
    deleted?: boolean;
    sectionId?: string;
    start?: number;
    end?: number;
    after?: string;
    offset?: number;
    limit: number;
  }) {
    if (
      !Number.isSafeInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > 50 ||
      !Number.isSafeInteger(request.offset ?? 0) ||
      (request.offset ?? 0) < 0 ||
      (request.after !== undefined && (request.offset ?? 0) !== 0) ||
      (request.start === undefined) !== (request.end === undefined) ||
      (request.start !== undefined &&
        (!request.sectionId ||
          !Number.isSafeInteger(request.start) ||
          !Number.isSafeInteger(request.end) ||
          request.start < 0 ||
          request.end! < request.start))
    )
      throw new ReaderStorageError("invalid", "标注分页范围无效。");
    const { original } = await this.authorizeSource({
      ...request,
      action: "read",
    });
    const scope = hash(
      JSON.stringify([
        request.tenantId,
        request.readingSourceId,
        request.principalId,
        request.deleted ?? false,
        request.sectionId ?? null,
        request.start ?? null,
        request.end ?? null,
      ]),
    );
    let after: { scope: string; createdAt: string; markId: string } | undefined;
    if (request.after !== undefined) {
      try {
        if (
          request.after.length > 4096 ||
          !/^[A-Za-z0-9_-]+$/.test(request.after)
        )
          throw new Error();
        after = z
          .object({
            scope: z.literal(scope),
            createdAt: z.iso.datetime(),
            markId: z.string().min(1).max(256),
          })
          .strict()
          .parse(
            JSON.parse(
              Buffer.from(request.after, "base64url").toString("utf8"),
            ),
          );
      } catch {
        throw new ReaderStorageError(
          "invalid",
          "标注游标与当前原件或读取范围不符。",
        );
      }
    }
    const result = await this.transaction(async (q) => {
      const source = await this.checkedSource(
        q,
        request.tenantId,
        request.readingSourceId,
        original,
      );
      const clauses = [
        request.deleted ? "deleted_at IS NOT NULL" : "deleted_at IS NULL",
      ];
      const values: SqlScalar[] = [
        request.tenantId,
        request.readingSourceId,
        request.principalId,
      ];
      if (request.sectionId) {
        ensureId(request.sectionId, "标注章节");
        const sections = await q.all<Row>(
          "SELECT character_count FROM book_sections WHERE tenant_id=? AND reading_source_id=? AND section_id=?",
          [request.tenantId, request.readingSourceId, request.sectionId],
        );
        if (
          sections.length !== 1 ||
          (request.end !== undefined &&
            request.end > Number(sections[0]!.character_count))
        )
          throw new ReaderStorageError("invalid", "标注读取范围超出原文。");
        clauses.push("section_id=?");
        values.push(request.sectionId);
      }
      if (request.start !== undefined) {
        // Half-open spans intersect the visible text; point bookmarks include
        // both visible edges. A long mark beginning offscreen remains visible.
        clauses.push(
          "((start_offset=end_offset AND start_offset>=? AND start_offset<=?) OR (start_offset<? AND end_offset>?))",
        );
        values.push(
          request.start,
          request.end!,
          Math.max(request.end!, request.start + 1),
          request.start,
        );
      }
      if (after) {
        clauses.push("(created_at>? OR (created_at=? AND mark_id>?))");
        values.push(after.createdAt, after.createdAt, after.markId);
      }
      values.push(request.limit + 1, request.offset ?? 0);
      const rows = await q.all<Row>(
        `SELECT mark_id,section_id,start_offset,end_offset,quote_text,kind,color,note_text,revision,created_at,updated_at,deleted_at
         FROM reading_marks WHERE tenant_id=? AND reading_source_id=? AND principal_id=?
         AND ${clauses.join(" AND ")}
         ORDER BY created_at,mark_id LIMIT ? OFFSET ?`,
        values,
      );
      const hasMore = rows.length > request.limit;
      const marks = rows.slice(0, request.limit).map((row) => ({
        id: String(row.mark_id),
        readingSourceId: request.readingSourceId,
        location: {
          sourceId: String(source.source_locator_id),
          sectionId: String(row.section_id),
          start: safeInteger(row.start_offset as number | string, "标注起点"),
          end: safeInteger(row.end_offset as number | string, "标注终点"),
        },
        quote: String(row.quote_text),
        kind: String(row.kind),
        color: String(row.color),
        note: String(row.note_text),
        revision: safeInteger(row.revision as number | string, "标注修订"),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        deletedAt: row.deleted_at === null ? null : String(row.deleted_at),
      }));
      const last = marks.at(-1);
      return {
        marks,
        hasMore,
        nextCursor:
          hasMore && last
            ? Buffer.from(
                JSON.stringify({
                  scope,
                  createdAt: last.createdAt,
                  markId: last.id,
                }),
              ).toString("base64url")
            : null,
      };
    }, true);
    // Reading a page cannot turn an authorization snapshot into a capability.
    await this.authority.verifyAccess({
      credential: request.credential,
      original,
      principalId: request.principalId,
      inputId: request.inputId,
      action: "read",
    });
    return result;
  }
}
