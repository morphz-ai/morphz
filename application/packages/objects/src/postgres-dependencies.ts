import type { SqlQuery } from "../../storage/src/sql.js";

/** Call inside a transaction on the Objects database. Extensions are shared
 * across schemas, including when a stopped deployment is restored from its
 * schema-only archives into a fresh database. */
export async function initializeObjectsPostgresDependencies(query: SqlQuery) {
  await query.all(
    "SELECT pg_advisory_xact_lock(hashtextextended('morphz:objects:pg_trgm', 0)) AS locked",
  );
  await query.exec("CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;");
  const installed = await query.all<{ namespace: string }>(
    `SELECT n.nspname AS namespace FROM pg_catalog.pg_extension e
     JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace
     WHERE e.extname='pg_trgm'`,
  );
  if (installed.length !== 1 || installed[0]!.namespace !== "public")
    throw new Error(
      "Objects 的 pg_trgm 扩展必须位于 public；拒绝自动迁移已有共享扩展。",
    );
}
