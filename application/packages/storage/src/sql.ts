import { createHash } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { PoolClient } from "pg";
import {
  postgresCommitChannel,
  publishSqliteCommit,
  sqlChangeSchema,
  type SqlChangeSource,
} from "./commit-notifications.js";

export type SqlScalar = string | number | null;
export type SqlRow = Record<string, unknown>;
export type SqlQuery = {
  all<T extends SqlRow>(sql: string, values?: SqlScalar[]): Promise<T[]>;
  change(sql: string, values?: SqlScalar[]): Promise<number>;
  exec(sql: string): Promise<void>;
};
const mutations = new WeakMap<
  SqlQuery,
  { changed: boolean; prepared: boolean; published: boolean }
>();

/** Row changes are an invalidation hint, not proof that a user-visible field
 * differs. Idempotent replay/zero affected rows do not request a refresh.
 * Business writes use change(); exec() is schema/control SQL, not domain data. */
export function hasSqlChanges(query: SqlQuery): boolean {
  return mutations.get(query)?.changed ?? false;
}

export async function prepareSqlCommit(
  query: SqlQuery,
  source: SqlChangeSource,
): Promise<void> {
  const state = mutations.get(query);
  if (!state?.changed || state.prepared || source.driver !== "postgres") return;
  const schema = sqlChangeSchema(source)!;
  // NOTIFY becomes visible only if the enclosing transaction actually commits.
  await query.all("SELECT pg_notify(?, '')", [postgresCommitChannel(schema)]);
  state.prepared = true;
}

export function publishSqlCommit(
  query: SqlQuery,
  source: SqlChangeSource,
): void {
  const state = mutations.get(query);
  if (!state?.changed || state.published || source.driver !== "sqlite") return;
  publishSqliteCommit(source);
  state.published = true;
}

/** `node:sqlite` blocks the JS thread while waiting for a writer. When two
 * connections to the same file share this process, a blocking busy wait can
 * prevent the first connection's async transaction from ever committing.
 * Serialize same-process writers before BEGIN IMMEDIATE; SQLite's own lock
 * still arbitrates with writers in other processes.
 */
const sqliteWriteGates = new Map<string, Promise<void>>();
export async function withSqliteWriteGate<T>(
  canonicalFilename: string,
  work: () => Promise<T>,
): Promise<T> {
  const prior = sqliteWriteGates.get(canonicalFilename) ?? Promise.resolve();
  const pending = prior.then(work, work);
  const settled = pending.then(
    () => undefined,
    () => undefined,
  );
  sqliteWriteGates.set(canonicalFilename, settled);
  try {
    return await pending;
  } finally {
    if (sqliteWriteGates.get(canonicalFilename) === settled)
      sqliteWriteGates.delete(canonicalFilename);
  }
}

/** Translate only bind markers, never question marks in SQL text or comments. */
export function postgresSql(sql: string, valuesCount: number) {
  let index = 0;
  let converted = "";
  for (let offset = 0; offset < sql.length;) {
    const delimiter =
      sql[offset] === "$"
        ? sql.slice(offset).match(/^\$[a-zA-Z_][a-zA-Z_0-9]*\$|^\$\$/)?.[0]
        : undefined;
    if (delimiter) {
      const end = sql.indexOf(delimiter, offset + delimiter.length);
      if (end < 0) throw new Error("SQL 字符串未闭合。");
      converted += sql.slice(offset, end + delimiter.length);
      offset = end + delimiter.length;
      continue;
    }
    if (sql.startsWith("--", offset)) {
      const end = sql.indexOf("\n", offset + 2);
      const next = end < 0 ? sql.length : end + 1;
      converted += sql.slice(offset, next);
      offset = next;
      continue;
    }
    if (sql.startsWith("/*", offset)) {
      const end = sql.indexOf("*/", offset + 2);
      if (end < 0) throw new Error("SQL 注释未闭合。");
      converted += sql.slice(offset, end + 2);
      offset = end + 2;
      continue;
    }
    if (sql[offset] === "'" || sql[offset] === '"') {
      const quote = sql[offset]!;
      let end = offset + 1;
      while (end < sql.length) {
        if (sql[end] === quote) {
          if (sql[end + 1] === quote) {
            end += 2;
            continue;
          }
          end++;
          break;
        }
        end++;
      }
      if (sql[end - 1] !== quote) throw new Error("SQL 字符串未闭合。");
      converted += sql.slice(offset, end);
      offset = end;
      continue;
    }
    converted += sql[offset] === "?" ? `$${++index}` : sql[offset];
    offset++;
  }
  if (index !== valuesCount) throw new Error("SQL 参数数量不匹配。");
  return converted;
}

export function sqliteQuery(database: DatabaseSync): SqlQuery {
  const state = { changed: false, prepared: false, published: false };
  const query: SqlQuery = {
    async all<T extends SqlRow>(sql: string, values: SqlScalar[] = []) {
      return database.prepare(sql).all(...(values as SQLInputValue[])) as T[];
    },
    async change(sql: string, values: SqlScalar[] = []) {
      const changed = Number(
        database.prepare(sql).run(...(values as SQLInputValue[])).changes,
      );
      if (changed > 0) state.changed = true;
      return changed;
    },
    async exec(sql: string) {
      database.exec(sql);
    },
  };
  mutations.set(query, state);
  return query;
}

export function postgresQuery(client: PoolClient): SqlQuery {
  const state = { changed: false, prepared: false, published: false };
  const query: SqlQuery = {
    async all<T extends SqlRow>(sql: string, values: SqlScalar[] = []) {
      const result = await client.query<T>(
        postgresSql(sql, values.length),
        values,
      );
      if (
        ["INSERT", "UPDATE", "DELETE", "MERGE"].includes(result.command) &&
        (result.rowCount ?? 0) > 0
      )
        state.changed = true;
      return result.rows;
    },
    async change(sql: string, values: SqlScalar[] = []) {
      const changed =
        (await client.query(postgresSql(sql, values.length), values))
          .rowCount ?? 0;
      if (changed > 0) state.changed = true;
      return changed;
    },
    async exec(sql: string) {
      await client.query(sql);
    },
  };
  mutations.set(query, state);
  return query;
}

export function safeInteger(value: number | string, label: string) {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted))
    throw new Error(`${label}超过安全整数范围，停止读取。`);
  return converted;
}

/** Version-one DDL guard: comments and spacing are not storage semantics. */
export function schemaHash(sql: string) {
  const structural = sql
    .replace(/--[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(structural).digest("hex");
}

/** Refuse an interrupted/foreign schema even when its version marker survived. */
export async function verifySchemaObjects(
  q: SqlQuery,
  backend: "sqlite" | "postgres",
  reviewedSql: string,
  extraTables: string[] = [],
  optionalTables: string[] = [],
) {
  const expectedTables = new Set([
    ...extraTables,
    ...Array.from(
      reviewedSql.matchAll(/^\s*CREATE TABLE\s+([a-z][a-z0-9_]*)\s*\(/gm),
      (match) => match[1]!,
    ),
  ]);
  const expectedIndexes = new Set(
    Array.from(
      reviewedSql.matchAll(
        /^\s*CREATE (?:UNIQUE )?INDEX\s+([a-z][a-z0-9_]*)\s+ON\s+/gm,
      ),
      (match) => match[1]!,
    ),
  );
  if (!expectedTables.size) throw new Error("存储模型未声明业务表。");
  const tables =
    backend === "postgres"
      ? await q.all<{ name: string }>(
          "SELECT tablename AS name FROM pg_catalog.pg_tables WHERE schemaname=current_schema()",
        )
      : await q.all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        );
  const optional = new Set(optionalTables);
  const actualTables = new Set(
    tables.map((table) => table.name).filter((name) => !optional.has(name)),
  );
  if (
    actualTables.size !== expectedTables.size ||
    [...expectedTables].some((name) => !actualTables.has(name))
  )
    throw new Error("数据库业务表与当前存储模型不一致，拒绝打开。");
  const indexes =
    backend === "postgres"
      ? await q.all<{ name: string }>(
          "SELECT indexname AS name FROM pg_catalog.pg_indexes WHERE schemaname=current_schema()",
        )
      : await q.all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL",
        );
  const actualIndexes = new Set(indexes.map((index) => index.name));
  if ([...expectedIndexes].some((name) => !actualIndexes.has(name)))
    throw new Error("数据库索引缺失，拒绝打开。");
}
