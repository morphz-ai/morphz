import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { z } from "zod";
import {
  bookmarkOperations,
  bookmarkSchema,
  type Bookmark,
} from "../../core/src/bookmarks.js";
import {
  postgresQuery,
  safeInteger,
  schemaHash,
  sqliteQuery,
  verifySchemaObjects,
  type SqlQuery,
} from "../../storage/src/sql.js";
import { browserSchemaSql } from "./schema.js";

type Backend =
  | { kind: "sqlite"; database: DatabaseSync }
  | { kind: "postgres"; pool: Pool; schema: string };
type Row = Record<string, unknown>;
export class BrowserStorageError extends Error {
  constructor(
    readonly code: "invalid" | "forbidden" | "conflict" | "not_found",
    message: string,
  ) {
    super(message);
  }
}
const operationSchema = z.union(bookmarkOperations);
export type BookmarkOperation = z.infer<typeof operationSchema>;
const domainId = /^[a-zA-Z0-9_-]{1,100}$/;
function requireId(value: string, label: string) {
  if (typeof value !== "string" || !domainId.test(value))
    throw new Error(`${label}无效。`);
  return value;
}
function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function rowBookmark(row: Row): Bookmark {
  return bookmarkSchema.parse({
    id: row.bookmark_id,
    ownerPrincipalId: row.owner_principal_id,
    title: row.title,
    url: row.url,
    revision: safeInteger(row.revision as number | string, "收藏修订"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: {
      principalId: row.created_by_principal_id,
      actantId: row.created_by_actant_id,
    },
    updatedBy: {
      principalId: row.updated_by_principal_id,
      actantId: row.updated_by_actant_id,
    },
    deletedAt: row.deleted_at,
  });
}
function rowReceipt(row: Row): BookmarkCommandReceipt {
  return {
    tenantId: String(row.tenant_id),
    commandId: String(row.command_id),
    ownerPrincipalId: String(row.owner_principal_id),
    bookmarkId: String(row.bookmark_id),
    revision: safeInteger(row.revision as number | string, "回执修订"),
    operation: row.operation as BookmarkOperation["type"],
    committedAt: String(row.committed_at),
  };
}

export type BookmarkActor = {
  tenantId: string;
  ownerPrincipalId: string;
  principalId: string;
  actantId: string;
  kind: "human" | "agent";
  runtimeInputId: string | null;
};

export type BrowserBookmarkAuthority = {
  /** Resolve the authenticated actor and, for an Agent, its persisted initiating
   * Human input. Never infer the owner from a model argument or selected page.
   */
  authorize(request: {
    credential: string;
    originInputId: string | null;
  }): Promise<BookmarkActor | null>;
};

export type BookmarkCommandReceipt = {
  tenantId: string;
  commandId: string;
  ownerPrincipalId: string;
  bookmarkId: string;
  revision: number;
  operation: BookmarkOperation["type"];
  committedAt: string;
};

type BookmarkListRequest = {
  credential: string;
  originInputId?: string | null;
  deleted?: boolean;
  query?: string;
  url?: string;
  offset?: number;
  limit?: number;
  expectedActor?: BookmarkActor;
};

function likePattern(value: string) {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

/** Browser-app relation store. Bookmarks never become Platform content rows. */
export class BrowserStore {
  private gate: Promise<unknown> = Promise.resolve();
  private constructor(
    private readonly backend: Backend,
    private readonly authority?: BrowserBookmarkAuthority,
  ) {}

  static async sqlite(filename: string, authority?: BrowserBookmarkAuthority) {
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
          !tables.some((table) => table.name === "browser_schema_version")
        )
          throw new Error("目标文件不属于浏览器应用，拒绝混用。");
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
      const store = new BrowserStore({ kind: "sqlite", database }, authority);
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
    authority?: BrowserBookmarkAuthority;
  }) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(options.schema))
      throw new Error("浏览器数据库 schema 名称无效。");
    const pool = new Pool({
      connectionString: options.connectionString,
      max: 10,
    });
    try {
      const store = new BrowserStore(
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
            const result = await work(sqliteQuery(database));
            database.exec("COMMIT");
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
      const result = await work(postgresQuery(client));
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
        !tables.some((table) => table.name === "browser_schema_version")
      )
        throw new Error("目标 schema 含非浏览器应用表，拒绝混用。");
      await q.exec(
        "CREATE TABLE IF NOT EXISTS browser_schema_version(version BIGINT PRIMARY KEY CHECK(version > 0), schema_sha256 TEXT NOT NULL)",
      );
      const versions = await q.all<{
        version: number | string;
        schema_sha256: string;
      }>("SELECT version,schema_sha256 FROM browser_schema_version");
      const hash = schemaHash(browserSchemaSql);
      if (
        versions.length > 1 ||
        (versions.length &&
          (Number(versions[0]!.version) !== 1 ||
            versions[0]!.schema_sha256 !== hash))
      )
        throw new Error("浏览器数据库结构与当前程序不一致。");
      if (versions.length) {
        await verifySchemaObjects(
          q,
          this.backend.kind,
          browserSchemaSql,
          ["browser_schema_version"],
          ["morphz_app_binding"],
        );
        return;
      }
      if (tables.length > 1)
        throw new Error("浏览器数据库初始化未完成，拒绝重复建表。");
      await q.exec(browserSchemaSql);
      await q.change(
        "INSERT INTO browser_schema_version(version,schema_sha256) VALUES(1,?)",
        [hash],
      );
    });
  }

  async close() {
    if (this.backend.kind === "sqlite") this.backend.database.close();
    else await this.backend.pool.end();
  }

  private async actor(
    credential: string,
    originInputId: string | null,
    expected?: BookmarkActor,
  ) {
    if (!this.authority)
      throw new BrowserStorageError(
        "forbidden",
        "浏览器尚未接入受信身份权限。",
      );
    if (originInputId) requireId(originInputId, "发起输入 ID");
    const actor = await this.authority.authorize({
      credential,
      originInputId,
    });
    if (!actor)
      throw new BrowserStorageError("forbidden", "没有访问这些收藏的权限。");
    requireId(actor.tenantId, "租户 ID");
    requireId(actor.ownerPrincipalId, "所有者 ID");
    requireId(actor.principalId, "主体 ID");
    requireId(actor.actantId, "执行者 ID");
    if (actor.kind === "agent") {
      if (!originInputId || actor.runtimeInputId !== originInputId)
        throw new BrowserStorageError(
          "forbidden",
          "Agent 收藏操作缺少已验证的发起输入。",
        );
    } else if (actor.ownerPrincipalId !== actor.principalId)
      throw new BrowserStorageError(
        "forbidden",
        "用户不能操作另一位用户的收藏。",
      );
    if (
      expected &&
      (actor.tenantId !== expected.tenantId ||
        actor.ownerPrincipalId !== expected.ownerPrincipalId ||
        actor.principalId !== expected.principalId ||
        actor.actantId !== expected.actantId ||
        actor.kind !== expected.kind ||
        actor.runtimeInputId !== expected.runtimeInputId)
    )
      throw new BrowserStorageError(
        "forbidden",
        "浏览器与 Platform 的当前操作身份不一致。",
      );
    return actor;
  }

  async listBookmarkPage(request: BookmarkListRequest) {
    const actor = await this.actor(
      request.credential,
      request.originInputId ?? null,
      request.expectedActor,
    );
    const offset = request.offset ?? 0;
    const limit = request.limit ?? 20;
    const query = (request.query ?? "").trim();
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 10000 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      query.length > 200
    )
      throw new BrowserStorageError("invalid", "收藏查询范围无效。");
    const terms = query.split(/\s+/).filter(Boolean);
    return this.transaction(async (q) => {
      const where = [
        "tenant_id=?",
        "owner_principal_id=?",
        request.deleted ? "deleted_at IS NOT NULL" : "deleted_at IS NULL",
      ];
      const args: Array<string | number> = [
        actor.tenantId,
        actor.ownerPrincipalId,
      ];
      if (request.url !== undefined) {
        where.push("url=?");
        args.push(request.url);
      }
      for (const term of terms) {
        where.push(
          "(lower(title) LIKE lower(?) ESCAPE '\\' OR lower(url) LIKE lower(?) ESCAPE '\\')",
        );
        const pattern = likePattern(term);
        args.push(pattern, pattern);
      }
      const total = await q.all<{ total: number | string }>(
        `SELECT count(*) AS total FROM bookmarks WHERE ${where.join(" AND ")}`,
        args,
      );
      const bookmarks = (
        await q.all<Row>(
          `SELECT * FROM bookmarks WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, bookmark_id LIMIT ? OFFSET ?`,
          [...args, limit, offset],
        )
      ).map(rowBookmark);
      return {
        total: safeInteger(total[0]?.total ?? 0, "收藏数量"),
        bookmarks,
      };
    }, true);
  }

  async listBookmarks(request: BookmarkListRequest) {
    return (await this.listBookmarkPage(request)).bookmarks;
  }

  async readBookmark(request: {
    credential: string;
    originInputId?: string | null;
    bookmarkId: string;
    expectedActor?: BookmarkActor;
  }) {
    const actor = await this.actor(
      request.credential,
      request.originInputId ?? null,
      request.expectedActor,
    );
    const bookmarkId = requireId(request.bookmarkId, "收藏 ID");
    return this.transaction(async (q) => {
      const row = (
        await q.all<Row>(
          "SELECT * FROM bookmarks WHERE tenant_id=? AND owner_principal_id=? AND bookmark_id=?",
          [actor.tenantId, actor.ownerPrincipalId, bookmarkId],
        )
      )[0];
      return row ? rowBookmark(row) : null;
    }, true);
  }

  async command(request: {
    credential: string;
    originInputId?: string | null;
    commandId: string;
    operation: BookmarkOperation;
    expectedActor?: BookmarkActor;
  }): Promise<BookmarkCommandReceipt> {
    const commandId = requireId(request.commandId, "命令 ID");
    const operation = operationSchema.parse(request.operation);
    const actor = await this.actor(
      request.credential,
      request.originInputId ?? null,
      request.expectedActor,
    );
    const requestSha256 = digest({
      operation,
      owner: actor.ownerPrincipalId,
      principal: actor.principalId,
      actant: actor.actantId,
      input: actor.runtimeInputId,
    });
    return this.transaction(async (q) => {
      if (this.backend.kind === "postgres")
        await q.all(
          "SELECT pg_advisory_xact_lock(hashtextextended(?,0)) AS locked",
          [`bookmark:${actor.tenantId}:${commandId}`],
        );
      const previous = (
        await q.all<Row>(
          "SELECT * FROM bookmark_command_receipts WHERE tenant_id=? AND command_id=?",
          [actor.tenantId, commandId],
        )
      )[0];
      if (previous) {
        if (
          previous.request_sha256 !== requestSha256 ||
          previous.owner_principal_id !== actor.ownerPrincipalId
        )
          throw new BrowserStorageError(
            "conflict",
            "命令 ID 已用于不同收藏操作。",
          );
        return rowReceipt(previous);
      }

      const now = new Date().toISOString();
      let bookmark: Bookmark;
      if (operation.type === "bookmark-add") {
        const existing = (
          await q.all<Row>(
            "SELECT * FROM bookmarks WHERE tenant_id=? AND owner_principal_id=? AND url=? AND deleted_at IS NULL",
            [actor.tenantId, actor.ownerPrincipalId, operation.url],
          )
        )[0];
        if (existing) bookmark = rowBookmark(existing);
        else {
          const bookmarkId = `bookmark_${randomUUID().replaceAll("-", "")}`;
          await q.change(
            "INSERT INTO bookmarks(tenant_id,bookmark_id,owner_principal_id,title,url,revision,created_at,updated_at,created_by_principal_id,created_by_actant_id,updated_by_principal_id,updated_by_actant_id,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT DO NOTHING",
            [
              actor.tenantId,
              bookmarkId,
              actor.ownerPrincipalId,
              operation.title,
              operation.url,
              1,
              now,
              now,
              actor.principalId,
              actor.actantId,
              actor.principalId,
              actor.actantId,
            ],
          );
          const inserted = (
            await q.all<Row>(
              "SELECT * FROM bookmarks WHERE tenant_id=? AND owner_principal_id=? AND url=? AND deleted_at IS NULL",
              [actor.tenantId, actor.ownerPrincipalId, operation.url],
            )
          )[0];
          if (!inserted) throw new Error("收藏创建后无法读取。");
          bookmark = rowBookmark(inserted);
        }
      } else {
        const existing = (
          await q.all<Row>(
            "SELECT * FROM bookmarks WHERE tenant_id=? AND bookmark_id=? AND owner_principal_id=?",
            [actor.tenantId, operation.bookmarkId, actor.ownerPrincipalId],
          )
        )[0];
        if (!existing)
          throw new BrowserStorageError("not_found", "收藏不存在或不可访问。");
        bookmark = rowBookmark(existing);
        if (bookmark.revision !== operation.expectedRevision)
          throw new BrowserStorageError(
            "conflict",
            "收藏已被修改，请重新查看后再操作。",
          );
        if ((operation.type === "bookmark-restore") !== !!bookmark.deletedAt)
          throw new BrowserStorageError(
            "conflict",
            "收藏状态已改变，请重新查看。",
          );
        const changed = await q.change(
          "UPDATE bookmarks SET title=?,url=?,revision=?,updated_at=?,updated_by_principal_id=?,updated_by_actant_id=?,deleted_at=? WHERE tenant_id=? AND bookmark_id=? AND owner_principal_id=? AND revision=?",
          [
            operation.type === "bookmark-update"
              ? operation.title
              : bookmark.title,
            operation.type === "bookmark-update" ? operation.url : bookmark.url,
            bookmark.revision + 1,
            now,
            actor.principalId,
            actor.actantId,
            operation.type === "bookmark-remove" ? now : null,
            actor.tenantId,
            bookmark.id,
            actor.ownerPrincipalId,
            bookmark.revision,
          ],
        );
        if (changed !== 1)
          throw new BrowserStorageError(
            "conflict",
            "收藏已被修改，请重新查看后再操作。",
          );
        bookmark = { ...bookmark, revision: bookmark.revision + 1 };
      }
      await q.change(
        "INSERT INTO bookmark_command_receipts(tenant_id,command_id,request_sha256,owner_principal_id,bookmark_id,revision,operation,committed_at) VALUES(?,?,?,?,?,?,?,?)",
        [
          actor.tenantId,
          commandId,
          requestSha256,
          actor.ownerPrincipalId,
          bookmark.id,
          bookmark.revision,
          operation.type,
          now,
        ],
      );
      return {
        tenantId: actor.tenantId,
        commandId,
        ownerPrincipalId: actor.ownerPrincipalId,
        bookmarkId: bookmark.id,
        revision: bookmark.revision,
        operation: operation.type,
        committedAt: now,
      };
    });
  }
}
