import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  linkSync,
  renameSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
  constants,
} from "node:fs";
import { open, link, lstat, mkdir, readdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import type { S3Client } from "@aws-sdk/client-s3";
import {
  postgresQuery,
  safeInteger,
  schemaHash,
  sqliteQuery,
  verifySchemaObjects,
  type SqlQuery,
} from "../../storage/src/sql.js";
import { managedArtifactStoreSchemaSql } from "./schema.js";
import { cloudArtifactStoreSchemaSql } from "./cloud-schema.js";
import {
  managedArtifactStoreV1SchemaSql,
  cloudArtifactStoreV1SchemaSql,
} from "./schema-v1.js";
import {
  S3BlobBytes,
  type S3ByteLocation,
  type S3StoreBinding,
} from "./s3-bytes.js";
import {
  backupTables,
  copyVerifiedBlob,
  insertBackupSql,
  readBackupRows,
  snapshotRows,
} from "./backup.js";

type Backend =
  | { kind: "sqlite"; database: DatabaseSync }
  | { kind: "postgres"; pool: Pool; schema: string };

export type StoreOperation = "write" | "read" | "delete";
export type StorePrincipal = { tenantId: string; principalId: string };
export type StoreOperationScope =
  | { operation: "read"; artifactId: string; revision: number | null }
  | {
      operation: "write" | "delete";
      artifactId: string;
      baseRevision: number;
      commandId: string;
    };
export type StoreAuthorizationRequest = StoreOperationScope & {
  storeId: string;
};
export type StoreAuthorizer = {
  /** Resolve an opaque host credential; request fields are never authority. */
  authorize(
    credential: string,
    request: StoreAuthorizationRequest,
  ): Promise<StorePrincipal>;
};

export type StoredVersion = {
  storeId: string;
  artifactId: string;
  revision: number;
  sha256: string;
  byteLength: number;
  mime: string;
};

type PutRequest = {
  credential: string;
  commandId: string;
  artifactId: string;
  baseRevision: number;
  mime: string;
  expectedSha256?: string;
  bytes: Uint8Array | AsyncIterable<Uint8Array>;
};

type PutReceiptRequest = {
  operation: "put";
  credential: string;
  commandId: string;
  artifactId: string;
  baseRevision: number;
  mime: string;
  sha256: string;
  byteLength: number;
};

export type StoreReceiptRequest =
  | PutReceiptRequest
  | {
      operation: "delete";
      credential: string;
      commandId: string;
      artifactId: string;
      baseRevision: number;
    };

export type StoreCommandReceipt =
  | { operation: "put"; version: StoredVersion; committedAt: string }
  | {
      operation: "delete";
      artifactId: string;
      deletedAt: string;
    };

type VersionRow = {
  owner_tenant_id: string;
  owner_principal_id: string;
  deleted_at: string | null;
  head_revision: number | string;
  revision: number | string;
  sha256: string;
  byte_length: number | string;
  mime: string;
  state: string;
};

const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/;
const shaPattern = /^[a-f0-9]{64}$/;
const quarantineFilePattern =
  /^([0-9]{13,16})-([a-f0-9]{64})-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const chunkSize = 1024 * 1024;
const sqliteTransactionGates = new Map<string, Promise<unknown>>();
type ChunkDigest = { ordinal: number; sha256: string; byteLength: number };
type RootBinding = {
  format: 2;
  backend: "postgres";
  storeId: string;
  schema: string;
  database: string;
  bindingId: string;
};
type V1RootBinding = Omit<RootBinding, "format"> & {
  format: 1;
  nodeId: string | null;
};
type InstalledRootBinding = RootBinding | V1RootBinding;
const rootBindingName = "store-root.json";

function validId(value: string, label: string) {
  if (!idPattern.test(value)) throw new Error(`${label}无效。`);
  return value;
}

function validSha(value: string, label: string) {
  if (!shaPattern.test(value)) throw new Error(`${label}无效。`);
  return value;
}

function putRequestHash(
  actor: StorePrincipal,
  request: Pick<
    PutReceiptRequest,
    "artifactId" | "baseRevision" | "mime" | "sha256" | "byteLength"
  >,
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        actor,
        artifactId: request.artifactId,
        baseRevision: request.baseRevision,
        mime: request.mime,
        sha256: request.sha256,
        byteLength: request.byteLength,
      }),
    )
    .digest("hex");
}

function deleteRequestHash(
  actor: StorePrincipal,
  request: { artifactId: string; baseRevision: number },
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        operation: "delete",
        actor,
        artifactId: request.artifactId,
        baseRevision: request.baseRevision,
      }),
    )
    .digest("hex");
}

function privateDirectory(path: string) {
  if (!isAbsolute(path)) throw new Error("Store 根目录必须是绝对路径。");
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077)
    throw new Error("Store 根目录必须是私有的真实目录。");
}

function syncDirectory(path: string) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function sameRootBinding(
  left: InstalledRootBinding,
  right: InstalledRootBinding,
) {
  return (
    left.format === right.format &&
    left.backend === right.backend &&
    left.storeId === right.storeId &&
    (left.format !== 1 ||
      (right.format === 1 && left.nodeId === right.nodeId)) &&
    left.schema === right.schema &&
    left.database === right.database &&
    left.bindingId === right.bindingId
  );
}

/** v1 is accepted only by initialization, which must finish its strict upgrade
 * before returning a Store. No byte or business operation reads this format. */
function readRootBinding(root: string): InstalledRootBinding | null {
  const path = join(root, rootBindingName);
  let pathStat: ReturnType<typeof lstatSync>;
  try {
    pathStat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (pathStat.isSymbolicLink())
    throw new Error("Store 字节目录绑定文件无效。");
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Store 字节目录绑定文件无效。", { cause: error });
  }
  let value: unknown;
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.dev !== pathStat.dev ||
      stat.ino !== pathStat.ino ||
      stat.size > 1024 ||
      (process.platform !== "win32" && stat.mode & 0o077)
    )
      throw new Error("Store 字节目录绑定文件无效。");
    value = JSON.parse(readFileSync(descriptor, "utf8"));
  } catch {
    throw new Error("Store 字节目录绑定文件损坏。");
  } finally {
    closeSync(descriptor);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Store 字节目录绑定文件损坏。");
  const binding = value as Record<string, unknown>;
  if (
    ![1, 2].includes(binding.format as number) ||
    Object.keys(binding).length !== (binding.format === 1 ? 7 : 6) ||
    binding.backend !== "postgres" ||
    typeof binding.storeId !== "string" ||
    (binding.format === 1 &&
      binding.nodeId !== null &&
      typeof binding.nodeId !== "string") ||
    typeof binding.schema !== "string" ||
    typeof binding.database !== "string" ||
    typeof binding.bindingId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      binding.bindingId,
    )
  )
    throw new Error("Store 字节目录绑定文件损坏。");
  return binding as InstalledRootBinding;
}

function upgradeRootBinding(
  root: string,
  previous: V1RootBinding,
  expected: RootBinding,
) {
  const current = readRootBinding(root);
  if (current?.format === 2 && sameRootBinding(current, expected)) return;
  if (!current || !sameRootBinding(current, previous))
    throw new Error("Store 升级期间字节目录绑定发生变化。");
  const staging = join(root, `.store-root-upgrade-${randomUUID()}.json`);
  const descriptor = openSync(staging, "wx", 0o600);
  try {
    try {
      writeFileSync(descriptor, JSON.stringify(expected));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(staging, join(root, rootBindingName));
    syncDirectory(root);
  } finally {
    if (existsSync(staging)) unlinkSync(staging);
  }
}

function rootContainsOtherStoreBytes(root: string) {
  if (existsSync(join(root, "manifest.sqlite"))) return true;
  for (const name of ["blobs", "staging", "quarantine"]) {
    const directory = join(root, name);
    if (!existsSync(directory)) continue;
    privateDirectory(directory);
    if (readdirSync(directory).length) return true;
  }
  return false;
}

function publishRootBinding(root: string, expected: RootBinding) {
  const temporary = join(root, `store-root-${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(expected), {
    flag: "wx",
    mode: 0o600,
  });
  try {
    const descriptor = openSync(temporary, "r");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      linkSync(temporary, join(root, rootBindingName));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = readRootBinding(root);
      if (!current || !sameRootBinding(current, expected))
        throw new Error("Store 字节目录已绑定其他 manifest 实例。");
    }
  } finally {
    unlinkSync(temporary);
    syncDirectory(root);
  }
}

async function verifyBlobFile(
  path: string,
  expectedSha: string,
  expectedLength: number,
) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== expectedLength)
      throw new Error("Artifact 字节缺失或长度损坏。");
    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false }))
      hash.update(chunk);
    if (hash.digest("hex") !== expectedSha)
      throw new Error("Artifact 字节摘要损坏。");
  } finally {
    await file.close();
  }
}

/** Private managed bytes. Not a Target and not a Platform content catalog. */
export class ManagedArtifactStore {
  private constructor(
    private readonly backend: Backend,
    private readonly root: string,
    readonly storeId: string,
    private readonly authorizer: StoreAuthorizer,
    private readonly maxBytes: number,
    private readonly maxCommittedBytes: number | null,
    private readonly cloudBytes: S3BlobBytes | null = null,
  ) {}

  static async sqlite(options: {
    root: string;
    storeId: string;
    authorizer: StoreAuthorizer;
    maxBytes?: number;
    maxCommittedBytes?: number;
  }) {
    if (
      options.maxBytes !== undefined &&
      (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)
    )
      throw new Error("Store 单对象容量限制无效。");
    if (
      options.maxCommittedBytes !== undefined &&
      (!Number.isSafeInteger(options.maxCommittedBytes) ||
        options.maxCommittedBytes < 0)
    )
      throw new Error("Store 已提交字节容量限制无效。");
    privateDirectory(options.root);
    const root = realpathSync(options.root);
    if (readRootBinding(root))
      throw new Error(
        "Store 字节目录已绑定 PostgreSQL manifest，不能创建 SQLite manifest。",
      );
    const filename = join(root, "manifest.sqlite");
    if (!existsSync(filename) && rootContainsOtherStoreBytes(root))
      throw new Error(
        "Store 字节目录已有其他 manifest 的文件，拒绝创建 SQLite manifest。",
      );
    if (existsSync(filename)) {
      const stat = lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error("Store manifest 必须是私有目录中的真实文件。");
      const check = new DatabaseSync(filename, { readOnly: true });
      try {
        const tables = check
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          )
          .all() as { name: string }[];
        if (
          tables.length &&
          !tables.some((row) => row.name === "store_schema_version")
        )
          throw new Error("目标文件不属于 受管 Artifact Store，拒绝混用。");
      } finally {
        check.close();
      }
    }
    const database = new DatabaseSync(filename);
    try {
      chmodSync(filename, 0o600);
      database.exec(
        "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;",
      );
      const store = new ManagedArtifactStore(
        { kind: "sqlite", database },
        root,
        validId(options.storeId, "Store ID"),
        options.authorizer,
        options.maxBytes ?? 1024 * 1024 * 1024,
        options.maxCommittedBytes ?? null,
      );
      await store.initialize();
      return store;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  static async postgres(options: {
    root: string;
    storeId: string;
    connectionString: string;
    schema: string;
    authorizer: StoreAuthorizer;
    maxBytes?: number;
    maxCommittedBytes?: number;
  }) {
    if (
      options.maxBytes !== undefined &&
      (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)
    )
      throw new Error("Store 单对象容量限制无效。");
    if (
      options.maxCommittedBytes !== undefined &&
      (!Number.isSafeInteger(options.maxCommittedBytes) ||
        options.maxCommittedBytes < 0)
    )
      throw new Error("Store 已提交字节容量限制无效。");
    privateDirectory(options.root);
    const root = realpathSync(options.root);
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(options.schema))
      throw new Error("受管 Store 数据库 schema 名称无效。");
    const pool = new Pool({
      connectionString: options.connectionString,
      max: 10,
    });
    try {
      const schema = await pool.query<{ present: number }>(
        "SELECT 1 AS present FROM pg_catalog.pg_namespace WHERE nspname=$1",
        [options.schema],
      );
      if (schema.rowCount !== 1)
        throw new Error(
          "受管 Store 的 PostgreSQL schema 不存在，拒绝回退到其他 schema。",
        );
      const store = new ManagedArtifactStore(
        { kind: "postgres", pool, schema: options.schema },
        root,
        validId(options.storeId, "Store ID"),
        options.authorizer,
        options.maxBytes ?? 1024 * 1024 * 1024,
        options.maxCommittedBytes ?? null,
      );
      await store.initialize();
      return store;
    } catch (error) {
      await pool.end();
      throw error;
    }
  }

  /** Cloud Store: PostgreSQL owns versions and receipts, while an S3-compatible
   * bucket owns immutable bytes. `root` is private per-Host staging only.
   */
  static async cloud(options: {
    root: string;
    storeId: string;
    connectionString: string;
    schema: string;
    bytes: S3ByteLocation;
    s3Client?: S3Client;
    authorizer: StoreAuthorizer;
    maxBytes?: number;
    maxCommittedBytes?: number;
  }) {
    if (
      options.maxBytes !== undefined &&
      (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)
    )
      throw new Error("Store 单对象容量限制无效。");
    if (
      options.maxCommittedBytes !== undefined &&
      (!Number.isSafeInteger(options.maxCommittedBytes) ||
        options.maxCommittedBytes < 0)
    )
      throw new Error("Store 已提交字节容量限制无效。");
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(options.schema))
      throw new Error("云 Store 数据库 schema 名称无效。");
    privateDirectory(options.root);
    const root = realpathSync(options.root);
    if (
      existsSync(join(root, "manifest.sqlite")) ||
      existsSync(join(root, "blobs")) ||
      existsSync(join(root, "quarantine")) ||
      readRootBinding(root)
    )
      throw new Error("云 Store 暂存目录不能复用本机字节 Store。");
    const cloudBytes = new S3BlobBytes(options.bytes, options.s3Client);
    const pool = new Pool({
      connectionString: options.connectionString,
      max: 10,
    });
    try {
      const schema = await pool.query<{ present: number }>(
        "SELECT 1 AS present FROM pg_catalog.pg_namespace WHERE nspname=$1",
        [options.schema],
      );
      if (schema.rowCount !== 1)
        throw new Error("云 Store PostgreSQL schema 不存在，拒绝回退。");
      const store = new ManagedArtifactStore(
        { kind: "postgres", pool, schema: options.schema },
        root,
        validId(options.storeId, "Store ID"),
        options.authorizer,
        options.maxBytes ?? 1024 * 1024 * 1024,
        options.maxCommittedBytes ?? null,
        cloudBytes,
      );
      await store.initialize();
      return store;
    } catch (error) {
      cloudBytes.close();
      await pool.end();
      throw error;
    }
  }

  /** Restore into a fresh, unregistered Store. A failed attempt is never
   * exposed as a usable Store and does not partially commit manifest rows.
   */
  static async restoreSqlite(
    options: Parameters<typeof ManagedArtifactStore.sqlite>[0] & {
      backupDirectory: string;
    },
  ) {
    const store = await ManagedArtifactStore.sqlite(options);
    try {
      await store.restoreFromBackup(options.backupDirectory);
      return store;
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  static async restorePostgres(
    options: Parameters<typeof ManagedArtifactStore.postgres>[0] & {
      backupDirectory: string;
    },
  ) {
    const store = await ManagedArtifactStore.postgres(options);
    try {
      await store.restoreFromBackup(options.backupDirectory);
      return store;
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  static async restoreCloud(
    options: Parameters<typeof ManagedArtifactStore.cloud>[0] & {
      backupDirectory: string;
    },
  ) {
    const store = await ManagedArtifactStore.cloud(options);
    try {
      await store.restoreFromBackup(options.backupDirectory);
      return store;
    } catch (error) {
      await store.close();
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
      const key = join(this.root, "manifest.sqlite");
      const previous = sqliteTransactionGates.get(key) ?? Promise.resolve();
      const pending = previous.then(run, run);
      const tail = pending.catch(() => undefined);
      sqliteTransactionGates.set(key, tail);
      void tail.then(() => {
        if (sqliteTransactionGates.get(key) === tail)
          sqliteTransactionGates.delete(key);
      });
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
    const manifestSql = this.cloudBytes
      ? cloudArtifactStoreSchemaSql
      : managedArtifactStoreSchemaSql;
    const marker =
      this.backend.kind === "postgres" && !this.cloudBytes
        ? readRootBinding(this.root)
        : null;
    if (this.backend.kind === "postgres" && !this.cloudBytes) {
      if (existsSync(join(this.root, "manifest.sqlite")))
        throw new Error("Store 字节目录已包含 SQLite manifest。");
      if (
        marker &&
        (marker.schema !== this.backend.schema ||
          marker.storeId !== this.storeId)
      )
        throw new Error("Store 字节目录已绑定其他 manifest 实例。");
      if (!marker && rootContainsOtherStoreBytes(this.root))
        throw new Error(
          "Store 字节目录已有其他 manifest 的文件，拒绝重新绑定。",
        );
    }
    const binding = await this.transaction(async (q) => {
      if (this.backend.kind === "postgres")
        await q.all(
          "SELECT pg_advisory_xact_lock(hashtextextended(current_database() || ':' || current_schema(), 0)) AS locked",
        );
      const database =
        this.backend.kind === "postgres"
          ? (
              await q.all<{ name: string }>("SELECT current_database() AS name")
            )[0]!.name
          : null;
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
        !tables.some((row) => row.name === "store_schema_version")
      )
        throw new Error("目标 schema 含非 受管 Store 表，拒绝混用。");
      if (!tables.length) {
        if (marker)
          throw new Error(
            "Store 字节目录已有绑定，但 PostgreSQL manifest 不存在。",
          );
        const bindingId = randomUUID();
        await q.exec(manifestSql);
        await q.change(
          "INSERT INTO store_schema_version(version,schema_sha256) VALUES(2,?)",
          [schemaHash(manifestSql)],
        );
        await q.change(
          "INSERT INTO store_identity(store_id,root_binding_id,created_at) VALUES(?,?,?)",
          [this.storeId, bindingId, new Date().toISOString()],
        );
        await q.change(
          "INSERT INTO store_usage(id,committed_bytes,limit_bytes) VALUES(1,0,?)",
          [this.maxCommittedBytes],
        );
        if (this.cloudBytes)
          await q.change(
            "INSERT INTO cloud_byte_binding(id,locator_sha256) VALUES(1,?)",
            [this.cloudBytes.locatorSha256],
          );
        return { bindingId, database, hasData: false };
      }
      const versions = await q.all<{
        version: number | string;
        schema_sha256: string;
      }>("SELECT version,schema_sha256 FROM store_schema_version");
      const v1Sql = this.cloudBytes
        ? cloudArtifactStoreV1SchemaSql
        : managedArtifactStoreV1SchemaSql;
      const upgrading =
        versions.length === 1 &&
        Number(versions[0]!.version) === 1 &&
        versions[0]!.schema_sha256 === schemaHash(v1Sql);
      if (
        versions.length !== 1 ||
        (!upgrading &&
          (Number(versions[0]!.version) !== 2 ||
            versions[0]!.schema_sha256 !== schemaHash(manifestSql)))
      )
        throw new Error("Store 数据库版本或字节后端不匹配。");
      await verifySchemaObjects(
        q,
        this.backend.kind,
        upgrading ? v1Sql : manifestSql,
      );
      // The shared table/index guard does not compare columns. In particular,
      // a v2 hash must never hide a surviving node_id or a foreign identity column.
      await this.verifyIdentityColumns(q, upgrading ? 1 : 2);
      if (this.cloudBytes) {
        const cloudBinding = await q.all<{ locator_sha256: string }>(
          "SELECT locator_sha256 FROM cloud_byte_binding WHERE id=1",
        );
        if (
          cloudBinding.length !== 1 ||
          cloudBinding[0]!.locator_sha256 !== this.cloudBytes.locatorSha256
        )
          throw new Error("云 Store 字节位置与 manifest 绑定不一致。");
      }
      const identities = await q.all<{
        store_id: string;
        node_id?: string | null;
        root_binding_id: string;
      }>(
        `SELECT store_id,${upgrading ? "node_id," : ""}root_binding_id FROM store_identity`,
      );
      if (
        identities.length !== 1 ||
        identities[0]!.store_id !== this.storeId ||
        (upgrading &&
          ((identities[0]!.node_id !== null &&
            typeof identities[0]!.node_id !== "string") ||
            (this.cloudBytes && identities[0]!.node_id !== null)))
      )
        throw new Error("Store 身份不匹配，拒绝复用数据目录。");
      const bindingId = identities[0]!.root_binding_id;
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          bindingId,
        )
      )
        throw new Error("Store 字节目录绑定身份无效。");
      if (
        marker &&
        (marker.database !== database ||
          marker.bindingId !== bindingId ||
          (upgrading &&
            marker.format === 1 &&
            marker.nodeId !== identities[0]!.node_id))
      )
        throw new Error("Store 字节目录与 PostgreSQL manifest 绑定不一致。");
      const usage = await q.all<{
        committed_bytes: number | string;
        limit_bytes: number | string | null;
      }>("SELECT committed_bytes,limit_bytes FROM store_usage WHERE id=1");
      if (usage.length !== 1)
        throw new Error("Store 已提交字节计数缺失，拒绝复用数据目录。");
      safeInteger(usage[0]!.committed_bytes, "Store 已提交字节数");
      if (
        (usage[0]!.limit_bytes === null
          ? null
          : safeInteger(usage[0]!.limit_bytes, "Store 容量限制")) !==
        this.maxCommittedBytes
      )
        throw new Error("Store 容量策略与已登记 manifest 不一致。");
      const hasData =
        this.backend.kind === "postgres"
          ? await q.all(
              "SELECT 1 AS present WHERE EXISTS(SELECT 1 FROM blobs) OR EXISTS(SELECT 1 FROM artifacts) OR EXISTS(SELECT 1 FROM store_command_receipts)",
            )
          : [];
      if (this.backend.kind === "postgres" && !marker && !this.cloudBytes) {
        if (hasData.length || Number(usage[0]!.committed_bytes) !== 0)
          throw new Error(
            "Store manifest 已有业务数据，缺少字节目录绑定，拒绝恢复。",
          );
      }
      if (upgrading && this.cloudBytes && this.backend.kind === "postgres")
        await this.cloudBytes.validateBinding(
          {
            format: 2,
            backend: "s3",
            storeId: this.storeId,
            schema: this.backend.schema,
            database: database!,
            bindingId,
            bucket: this.cloudBytes.location.bucket,
            prefix: this.cloudBytes.location.prefix,
          },
          !hasData.length && Number(usage[0]!.committed_bytes) === 0,
        );
      if (upgrading) {
        // Only this exact retired v1 column is removed. All byte/version/receipt
        // rows and the root binding identity stay in place in the same transaction.
        await q.exec("ALTER TABLE store_identity DROP COLUMN node_id");
        const changed = await q.change(
          "UPDATE store_schema_version SET version=2,schema_sha256=? WHERE version=1 AND schema_sha256=?",
          [schemaHash(manifestSql), schemaHash(v1Sql)],
        );
        if (changed !== 1) throw new Error("Store v1 升级发生并发变化。");
        await this.verifyIdentityColumns(q, 2);
        await verifySchemaObjects(q, this.backend.kind, manifestSql);
      }
      return {
        bindingId,
        database,
        hasData: hasData.length > 0 || Number(usage[0]!.committed_bytes) !== 0,
      };
    });
    if (this.backend.kind === "postgres") {
      if (this.cloudBytes) {
        const expected: S3StoreBinding = {
          format: 2,
          backend: "s3",
          storeId: this.storeId,
          schema: this.backend.schema,
          database: binding.database!,
          bindingId: binding.bindingId,
          bucket: this.cloudBytes.location.bucket,
          prefix: this.cloudBytes.location.prefix,
        };
        await this.cloudBytes.bind(expected, !binding.hasData);
      } else {
        const expected: RootBinding = {
          format: 2,
          backend: "postgres",
          storeId: this.storeId,
          schema: this.backend.schema,
          database: binding.database!,
          bindingId: binding.bindingId,
        };
        if (marker) {
          // DB commit and marker publication cannot share a transaction. A
          // failed publication leaves the Store closed; retrying initialization
          // accepts only this matching v1 identity and completes its v2 marker.
          if (marker.format === 1)
            upgradeRootBinding(this.root, marker, expected);
          const current = readRootBinding(this.root);
          if (!current || !sameRootBinding(current, expected))
            throw new Error(
              "Store 字节目录与 PostgreSQL manifest 绑定不一致。",
            );
        } else {
          publishRootBinding(this.root, expected);
        }
      }
    }
    privateDirectory(join(this.root, "staging"));
    if (!this.cloudBytes) {
      privateDirectory(join(this.root, "blobs"));
      privateDirectory(join(this.root, "quarantine"));
    }
  }

  private async verifyIdentityColumns(q: SqlQuery, version: 1 | 2) {
    const columns =
      this.backend.kind === "postgres"
        ? await q.all<{ name: string }>(
            "SELECT a.attname AS name FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname='store_identity' AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum",
          )
        : await q.all<{ name: string }>("PRAGMA table_info(store_identity)");
    const expected =
      version === 1
        ? ["store_id", "node_id", "root_binding_id", "created_at"]
        : ["store_id", "root_binding_id", "created_at"];
    if (columns.map((column) => column.name).join("\0") !== expected.join("\0"))
      throw new Error("Store 身份表字段与当前存储模型不一致，拒绝打开。");
  }

  async close() {
    if (this.backend.kind === "sqlite") this.backend.database.close();
    else await this.backend.pool.end();
    this.cloudBytes?.close();
  }

  async hasCommittedVersions() {
    return this.transaction(
      async (q) =>
        (await q.all("SELECT 1 AS present FROM artifact_versions LIMIT 1"))
          .length > 0,
      true,
    );
  }

  /** Consistent manifest snapshot plus verified immutable bytes. The caller
   * selects a new private directory outside the live Store. A backup is only
   * complete after backup-info.json is durably published last.
   */
  async backupTo(directory: string) {
    if (!isAbsolute(directory))
      throw new Error("Store 备份目录必须是绝对路径。");
    const destination = resolve(directory);
    const inside = relative(this.root, destination);
    if (!inside || (!inside.startsWith("..") && !isAbsolute(inside)))
      throw new Error("Store 备份目录不能位于正在备份的 Store 内。");
    await mkdir(destination, { mode: 0o700 });
    privateDirectory(destination);
    await mkdir(join(destination, "blobs"), { mode: 0o700 });
    const manifest = await open(
      join(destination, "manifest.ndjson"),
      "wx",
      0o600,
    );
    const digest = createHash("sha256");
    let buffered = "";
    let rows = 0;
    let blobs = 0;
    let committedBytes = 0;
    const flush = async () => {
      if (!buffered) return;
      const data = Buffer.from(buffered, "utf8");
      digest.update(data);
      await manifest.writeFile(data);
      buffered = "";
    };
    try {
      await this.transaction(async (q) => {
        for await (const { table, row } of snapshotRows(q)) {
          buffered += JSON.stringify({ table: table.name, row }) + "\n";
          rows++;
          if (buffered.length >= 256 * 1024) await flush();
          if (table.name === "blobs") {
            const sha = validSha(String(row.sha256), "备份 Blob 摘要");
            const byteLength = safeInteger(
              row.byte_length as number | string,
              "备份 Blob 长度",
            );
            committedBytes += byteLength;
            if (!Number.isSafeInteger(committedBytes))
              throw new Error("Store 备份字节数超过安全整数范围。");
            const target = join(destination, "blobs", sha.slice(0, 2), sha);
            const stage = this.cloudBytes
              ? join(this.root, "staging", randomUUID())
              : null;
            let actualChunks;
            try {
              if (stage)
                await this.cloudBytes!.downloadVerified(sha, byteLength, stage);
              actualChunks = await copyVerifiedBlob(
                stage ?? this.blobPath(sha),
                target,
                sha,
                byteLength,
              );
            } finally {
              if (stage)
                await unlink(stage).catch((error: NodeJS.ErrnoException) => {
                  if (error.code !== "ENOENT") throw error;
                });
            }
            const savedChunks = await q.all<{
              ordinal: number | string;
              chunk_sha256: string;
              byte_length: number | string;
            }>(
              "SELECT ordinal,chunk_sha256,byte_length FROM blob_chunks WHERE sha256=? ORDER BY ordinal",
              [sha],
            );
            if (
              savedChunks.length !== actualChunks.length ||
              savedChunks.some(
                (chunk, index) =>
                  safeInteger(chunk.ordinal, "备份分块序号") !== index ||
                  chunk.chunk_sha256 !== actualChunks[index]!.sha256 ||
                  safeInteger(chunk.byte_length, "备份分块长度") !==
                    actualChunks[index]!.byteLength,
              )
            )
              throw new Error("Store Blob 分块 manifest 与原字节不一致。");
            syncDirectory(dirname(target));
            blobs++;
          }
        }
        const usage = await q.all<{ committed_bytes: number | string }>(
          "SELECT committed_bytes FROM store_usage WHERE id=1",
        );
        if (
          usage.length !== 1 ||
          safeInteger(usage[0]!.committed_bytes, "Store 已提交字节数") !==
            committedBytes
        )
          throw new Error("Store 已提交字节计数与 Blob manifest 不一致。");
        await flush();
        await manifest.sync();
      }, true);
    } finally {
      await manifest.close();
    }
    syncDirectory(join(destination, "blobs"));
    const info = {
      format: 2,
      storeId: this.storeId,
      schemaSha256: schemaHash(managedArtifactStoreSchemaSql),
      manifestSha256: digest.digest("hex"),
      rows,
      blobs,
    };
    const marker = await open(
      join(destination, "backup-info.json"),
      "wx",
      0o600,
    );
    try {
      await marker.writeFile(JSON.stringify(info));
      await marker.sync();
    } finally {
      await marker.close();
    }
    syncDirectory(destination);
    return info;
  }

  /** Read-only preflight: a damaged Store backup must fail before another
   * authority is restored into a fresh deployment. Restore rechecks on use.
   */
  static async verifyBackup(options: {
    backupDirectory: string;
    storeId: string;
  }) {
    const directory = options.backupDirectory;
    if (!existsSync(directory) || !existsSync(join(directory, "blobs")))
      throw new Error("Store 备份目录或字节目录不存在。");
    privateDirectory(directory);
    privateDirectory(join(directory, "blobs"));
    const marker = await open(
      join(directory, "backup-info.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let info: Record<string, unknown>;
    try {
      const stat = await marker.stat();
      if (!stat.isFile() || stat.size > 4096)
        throw new Error("Store 备份完成标记无效。");
      info = JSON.parse(await marker.readFile("utf8")) as Record<
        string,
        unknown
      >;
    } finally {
      await marker.close();
    }
    if (
      info.format !== 2 ||
      info.storeId !== options.storeId ||
      Object.hasOwn(info, "nodeId") ||
      info.schemaSha256 !== schemaHash(managedArtifactStoreSchemaSql) ||
      typeof info.manifestSha256 !== "string" ||
      !shaPattern.test(info.manifestSha256) ||
      !Number.isSafeInteger(info.rows) ||
      !Number.isSafeInteger(info.blobs) ||
      (info.rows as number) < 0 ||
      (info.blobs as number) < 0
    )
      throw new Error("Store 备份身份、版本或完成标记不匹配。");
    let blobs = 0;
    const checked = await readBackupRows(
      join(directory, "manifest.ndjson"),
      async (table, row) => {
        if (table.name !== "blobs") return;
        const sha = validSha(String(row.sha256), "备份 Blob 摘要");
        const prefix = join(directory, "blobs", sha.slice(0, 2));
        if (!existsSync(prefix)) throw new Error("Store 备份 Blob 缺失。");
        privateDirectory(prefix);
        await verifyBlobFile(
          join(prefix, sha),
          sha,
          safeInteger(row.byte_length as number | string, "备份 Blob 长度"),
        );
        blobs++;
      },
    );
    if (
      checked.sha256 !== info.manifestSha256 ||
      checked.rows !== info.rows ||
      blobs !== info.blobs
    )
      throw new Error("Store 备份 manifest 摘要或记录数不匹配。");
    return { rows: checked.rows, blobs };
  }

  private async restoreFromBackup(directory: string) {
    if (!existsSync(directory)) throw new Error("Store 备份目录不存在。");
    privateDirectory(directory);
    const infoFile = await open(
      join(directory, "backup-info.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let info: Record<string, unknown>;
    try {
      const stat = await infoFile.stat();
      if (!stat.isFile() || stat.size > 4096)
        throw new Error("Store 备份完成标记无效。");
      info = JSON.parse(await infoFile.readFile("utf8")) as Record<
        string,
        unknown
      >;
    } finally {
      await infoFile.close();
    }
    if (
      info.format !== 2 ||
      info.storeId !== this.storeId ||
      Object.hasOwn(info, "nodeId") ||
      info.schemaSha256 !== schemaHash(managedArtifactStoreSchemaSql) ||
      typeof info.manifestSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(info.manifestSha256) ||
      !Number.isSafeInteger(info.rows) ||
      !Number.isSafeInteger(info.blobs) ||
      (info.rows as number) < 0 ||
      (info.blobs as number) < 0
    )
      throw new Error("Store 备份身份、版本或完成标记不匹配。");
    const manifestPath = join(directory, "manifest.ndjson");
    let backupBytes = 0;
    const verified = await readBackupRows(manifestPath, async (table, row) => {
      if (table.name !== "blobs") return;
      backupBytes += safeInteger(
        row.byte_length as number | string,
        "备份 Blob 长度",
      );
      if (!Number.isSafeInteger(backupBytes))
        throw new Error("Store 备份字节数超过安全整数范围。");
    });
    if (verified.sha256 !== info.manifestSha256 || verified.rows !== info.rows)
      throw new Error("Store 备份 manifest 摘要或记录数不匹配。");
    if (this.maxCommittedBytes !== null && backupBytes > this.maxCommittedBytes)
      throw new Error("Store 备份超过已提交字节容量限制。");
    await this.transaction(async (q) => {
      await this.lockBlobMutation(q);
      for (const table of backupTables) {
        const found = await q.all(
          `SELECT 1 AS present FROM ${table.name} LIMIT 1`,
        );
        if (found.length)
          throw new Error("目标 Store 已有业务数据，拒绝覆盖恢复。");
      }
      const usage = await q.all<{ committed_bytes: number | string }>(
        "SELECT committed_bytes FROM store_usage WHERE id=1",
      );
      if (
        usage.length !== 1 ||
        safeInteger(usage[0]!.committed_bytes, "Store 已提交字节数") !== 0
      )
        throw new Error("目标 Store 已有已提交字节，拒绝覆盖恢复。");
      let copied = 0;
      const inspected = await readBackupRows(
        manifestPath,
        async (table, row) => {
          if (table.name !== "blobs") return;
          const sha = validSha(String(row.sha256), "备份 Blob 摘要");
          const stage = join(this.root, "staging", randomUUID());
          try {
            const byteLength = safeInteger(
              row.byte_length as number | string,
              "备份 Blob 长度",
            );
            await copyVerifiedBlob(
              join(directory, "blobs", sha.slice(0, 2), sha),
              stage,
              sha,
              byteLength,
            );
            await this.publish(stage, sha, byteLength);
            copied++;
          } finally {
            await unlink(stage).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
            });
          }
        },
      );
      if (
        inspected.sha256 !== info.manifestSha256 ||
        inspected.rows !== info.rows ||
        copied !== info.blobs
      )
        throw new Error("Store 备份 manifest 摘要或记录数不匹配。");
      const imported = await readBackupRows(
        manifestPath,
        async (table, row) => {
          await q.change(
            insertBackupSql(table),
            table.columns.map((column) => row[column]!),
          );
        },
      );
      if (
        imported.sha256 !== info.manifestSha256 ||
        imported.rows !== info.rows
      )
        throw new Error("恢复期间 Store 备份 manifest 发生变化。");
      const totals = await q.all<{ total: number | string }>(
        "SELECT COALESCE(SUM(byte_length),0) AS total FROM blobs",
      );
      if (
        totals.length !== 1 ||
        safeInteger(totals[0]!.total, "恢复后的 Store 字节数") !== backupBytes
      )
        throw new Error("Store 恢复后的字节计数与备份不一致。");
      const updated = await q.change(
        "UPDATE store_usage SET committed_bytes=? WHERE id=1 AND committed_bytes=0",
        [backupBytes],
      );
      if (updated !== 1)
        throw new Error("Store 恢复期间字节计数发生并发变化。");
    });
  }

  private blobPath(sha256: string) {
    return join(this.root, "blobs", sha256.slice(0, 2), sha256);
  }

  /** Serializes a filesystem publish with orphan inspection across Store
   * instances. SQLite's write transaction supplies the same exclusion.
   */
  private async lockBlobMutation(q: SqlQuery) {
    if (this.backend.kind === "postgres")
      await q.all(
        "SELECT pg_advisory_xact_lock(hashtextextended(current_database() || ':' || current_schema() || ':' || ?::text, 0)) AS locked",
        [this.storeId],
      );
  }

  private async actor(credential: string, scope: StoreOperationScope) {
    if (!credential || credential.length > 4096)
      throw new Error("缺少有效的受信 Store 凭据。");
    const actor = await this.authorizer.authorize(credential, {
      storeId: this.storeId,
      ...scope,
    });
    validId(actor.tenantId, "租户身份");
    validId(actor.principalId, "主体身份");
    return actor;
  }

  private async confirmActor(
    credential: string,
    scope: StoreOperationScope,
    expected: StorePrincipal,
  ) {
    const current = await this.actor(credential, scope);
    if (
      current.tenantId !== expected.tenantId ||
      current.principalId !== expected.principalId
    )
      throw new Error("Store 授权身份已变化。");
  }

  private async publish(
    stage: string,
    sha256: string,
    byteLength: number,
    mayAlreadyExist = false,
  ) {
    if (this.cloudBytes) {
      await this.cloudBytes.publish(stage, sha256, byteLength, mayAlreadyExist);
      return;
    }
    const directory = dirname(this.blobPath(sha256));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    privateDirectory(directory);
    syncDirectory(dirname(directory));
    const target = this.blobPath(sha256);
    try {
      await link(stage, target);
      syncDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await verifyBlobFile(target, sha256, byteLength);
    }
  }

  async put(request: PutRequest): Promise<StoredVersion> {
    const artifactId = validId(request.artifactId, "Artifact ID");
    const commandId = validId(request.commandId, "命令 ID");
    if (!Number.isSafeInteger(request.baseRevision) || request.baseRevision < 0)
      throw new Error("基准版本无效。");
    if (
      !request.mime ||
      request.mime.length > 200 ||
      /[\x00-\x1f]/.test(request.mime)
    )
      throw new Error("媒体类型无效。");
    if (request.expectedSha256) validSha(request.expectedSha256, "预期摘要");
    const operationScope: StoreOperationScope = {
      operation: "write",
      artifactId,
      baseRevision: request.baseRevision,
      commandId,
    };
    const actor = await this.actor(request.credential, operationScope);
    // Reject obvious unauthorized/stale writes before accepting bytes. The
    // commit transaction repeats this check because another writer may race.
    await this.transaction(async (q) => {
      const prior = await q.all<{ artifact_id: string; operation: string }>(
        "SELECT artifact_id,operation FROM store_command_receipts WHERE command_id=?",
        [commandId],
      );
      if (
        prior.length &&
        (prior[0]!.artifact_id !== artifactId || prior[0]!.operation !== "put")
      )
        throw new Error("相同命令 ID 对应不同写入请求。");
      const rows = await q.all<{
        owner_tenant_id: string;
        owner_principal_id: string;
        head_revision: number | string;
        deleted_at: string | null;
      }>(
        "SELECT owner_tenant_id,owner_principal_id,head_revision,deleted_at FROM artifacts WHERE artifact_id=?",
        [artifactId],
      );
      if (!rows.length) {
        if (prior.length)
          throw new Error("Store 回执引用了不存在的 Artifact。");
        if (request.baseRevision !== 0)
          throw new Error("Artifact 基准版本冲突。");
      } else {
        const current = rows[0]!;
        if (
          current.owner_tenant_id !== actor.tenantId ||
          current.owner_principal_id !== actor.principalId
        )
          throw new Error("没有此 Artifact 的写入权限。");
        if (prior.length) return;
        if (
          current.deleted_at ||
          safeInteger(current.head_revision, "Artifact 版本") !==
            request.baseRevision
        )
          throw new Error("Artifact 基准版本冲突。");
      }
    }, true);
    const stage = join(this.root, "staging", randomUUID());
    const file = await open(stage, "wx", 0o600);
    const hash = createHash("sha256");
    let byteLength = 0;
    const chunkBuffer = Buffer.allocUnsafe(chunkSize);
    let chunkFill = 0;
    const chunkDigests: ChunkDigest[] = [];
    const finishChunk = () => {
      if (!chunkFill) return;
      chunkDigests.push({
        ordinal: chunkDigests.length,
        sha256: createHash("sha256")
          .update(chunkBuffer.subarray(0, chunkFill))
          .digest("hex"),
        byteLength: chunkFill,
      });
      chunkFill = 0;
    };
    let uploadComplete = false;
    try {
      const chunks =
        request.bytes instanceof Uint8Array
          ? (async function* () {
              yield request.bytes as Uint8Array;
            })()
          : request.bytes;
      for await (const chunk of chunks) {
        if (!(chunk instanceof Uint8Array))
          throw new Error("Artifact 字节块无效。");
        byteLength += chunk.byteLength;
        if (!Number.isSafeInteger(byteLength) || byteLength > this.maxBytes)
          throw new Error("Artifact 超过 Store 单对象容量限制。");
        hash.update(chunk);
        let cursor = 0;
        while (cursor < chunk.byteLength) {
          const take = Math.min(
            chunkSize - chunkFill,
            chunk.byteLength - cursor,
          );
          chunkBuffer.set(chunk.subarray(cursor, cursor + take), chunkFill);
          chunkFill += take;
          cursor += take;
          if (chunkFill === chunkSize) finishChunk();
        }
        await file.writeFile(chunk);
      }
      finishChunk();
      await file.sync();
      uploadComplete = true;
    } finally {
      await file.close();
      if (!uploadComplete) await unlink(stage);
    }
    try {
      const sha256 = hash.digest("hex");
      if (request.expectedSha256 && request.expectedSha256 !== sha256)
        throw new Error("Artifact 上传摘要不匹配。");
      // Re-read the sealed staged file: callers may reuse or mutate a supplied
      // Uint8Array while the asynchronous write is in progress.
      await verifyBlobFile(stage, sha256, byteLength);
      await this.confirmActor(request.credential, operationScope, actor);
      const requestHash = putRequestHash(actor, {
        artifactId,
        baseRevision: request.baseRevision,
        mime: request.mime,
        sha256,
        byteLength,
      });
      return await this.transaction(async (q) => {
        await this.lockBlobMutation(q);
        await this.confirmActor(request.credential, operationScope, actor);
        const receipts = await q.all<{
          request_hash: string;
          operation: string;
          artifact_id: string;
          revision: number | string;
          sha256: string;
        }>(
          "SELECT request_hash,operation,artifact_id,revision,sha256 FROM store_command_receipts WHERE command_id=?",
          [commandId],
        );
        if (receipts.length) {
          if (
            receipts[0]!.operation !== "put" ||
            receipts[0]!.request_hash !== requestHash
          )
            throw new Error("相同命令 ID 对应不同写入请求。");
          // A retry may repair bytes lost after the original commit. It does
          // not admit another logical version or consume quota again.
          await this.publish(stage, sha256, byteLength, true);
          await this.confirmActor(request.credential, operationScope, actor);
          return {
            storeId: this.storeId,
            artifactId,
            revision: safeInteger(receipts[0]!.revision, "回执版本"),
            sha256,
            byteLength,
            mime: request.mime,
          };
        }
        const existing = await q.all<{
          owner_tenant_id: string;
          owner_principal_id: string;
          head_revision: number | string;
          deleted_at: string | null;
        }>(
          `SELECT owner_tenant_id,owner_principal_id,head_revision,deleted_at FROM artifacts WHERE artifact_id=?${this.backend.kind === "postgres" ? " FOR UPDATE" : ""}`,
          [artifactId],
        );
        let revision: number;
        if (!existing.length) {
          if (request.baseRevision !== 0)
            throw new Error("Artifact 基准版本冲突。");
          revision = 1;
          const created = await q.change(
            "INSERT INTO artifacts(artifact_id,owner_tenant_id,owner_principal_id,head_revision,created_at,deleted_at) VALUES(?,?,?,?,?,NULL) ON CONFLICT DO NOTHING",
            [
              artifactId,
              actor.tenantId,
              actor.principalId,
              revision,
              new Date().toISOString(),
            ],
          );
          if (created !== 1)
            throw new Error("Artifact 已被并发创建，请核对当前版本。");
        } else {
          const artifact = existing[0]!;
          if (
            artifact.owner_tenant_id !== actor.tenantId ||
            artifact.owner_principal_id !== actor.principalId
          )
            throw new Error("没有此 Artifact 的写入权限。");
          if (
            artifact.deleted_at ||
            safeInteger(artifact.head_revision, "Artifact 版本") !==
              request.baseRevision
          )
            throw new Error("Artifact 基准版本冲突。");
          revision = request.baseRevision + 1;
          await q.change(
            "UPDATE artifacts SET head_revision=? WHERE artifact_id=? AND head_revision=?",
            [revision, artifactId, request.baseRevision],
          );
        }
        const usage = await q.all<{
          committed_bytes: number | string;
          limit_bytes: number | string | null;
        }>(
          `SELECT committed_bytes,limit_bytes FROM store_usage WHERE id=1${this.backend.kind === "postgres" ? " FOR UPDATE" : ""}`,
        );
        if (usage.length !== 1) throw new Error("Store 已提交字节计数缺失。");
        const limitBytes =
          usage[0]!.limit_bytes === null
            ? null
            : safeInteger(usage[0]!.limit_bytes, "Store 容量限制");
        if (limitBytes !== this.maxCommittedBytes)
          throw new Error("Store 容量策略与已登记 manifest 不一致。");
        const committedBytes = safeInteger(
          usage[0]!.committed_bytes,
          "Store 已提交字节数",
        );
        const priorBlob = await q.all<{
          byte_length: number | string;
          state: string;
        }>("SELECT byte_length,state FROM blobs WHERE sha256=?", [sha256]);
        if (
          priorBlob.length &&
          (priorBlob[0]!.state !== "verified" ||
            safeInteger(priorBlob[0]!.byte_length, "Blob 长度") !== byteLength)
        )
          throw new Error("Store Blob manifest 与待写字节不一致。");
        const nextCommittedBytes =
          committedBytes + (priorBlob.length ? 0 : byteLength);
        if (
          !Number.isSafeInteger(nextCommittedBytes) ||
          (limitBytes !== null && nextCommittedBytes > limitBytes)
        )
          throw new Error("Store 已提交字节容量不足。");
        // A publish is not a committed version. Keep the byte path and the
        // manifest decision inside one Store-wide exclusion window, including
        // a final authorization check, so maintenance cannot take the file.
        await this.publish(stage, sha256, byteLength, priorBlob.length > 0);
        await this.confirmActor(request.credential, operationScope, actor);
        const createdBlob = await q.change(
          "INSERT INTO blobs(sha256,byte_length,state,verified_at) VALUES(?,?,'verified',?) ON CONFLICT DO NOTHING",
          [sha256, byteLength, new Date().toISOString()],
        );
        if (createdBlob !== (priorBlob.length ? 0 : 1))
          throw new Error("Store Blob 并发写入绕过了容量锁。");
        if (createdBlob === 1) {
          const updated = await q.change(
            "UPDATE store_usage SET committed_bytes=? WHERE id=1 AND committed_bytes=?",
            [nextCommittedBytes, committedBytes],
          );
          if (updated !== 1) throw new Error("Store 已提交字节计数并发冲突。");
          for (const chunk of chunkDigests)
            await q.change(
              "INSERT INTO blob_chunks(sha256,ordinal,chunk_sha256,byte_length) VALUES(?,?,?,?)",
              [sha256, chunk.ordinal, chunk.sha256, chunk.byteLength],
            );
        }
        const blobRows = await q.all<{
          byte_length: number | string;
          state: string;
        }>("SELECT byte_length,state FROM blobs WHERE sha256=?", [sha256]);
        if (
          blobRows.length !== 1 ||
          blobRows[0]!.state !== "verified" ||
          safeInteger(blobRows[0]!.byte_length, "Blob 长度") !== byteLength
        )
          throw new Error("Store Blob manifest 与已发布字节不一致。");
        const savedChunks = await q.all<{
          ordinal: number | string;
          chunk_sha256: string;
          byte_length: number | string;
        }>(
          "SELECT ordinal,chunk_sha256,byte_length FROM blob_chunks WHERE sha256=? ORDER BY ordinal",
          [sha256],
        );
        if (
          savedChunks.length !== chunkDigests.length ||
          savedChunks.some(
            (row, index) =>
              safeInteger(row.ordinal, "Blob 分块序号") !== index ||
              row.chunk_sha256 !== chunkDigests[index]!.sha256 ||
              safeInteger(row.byte_length, "Blob 分块长度") !==
                chunkDigests[index]!.byteLength,
          )
        )
          throw new Error("Store Blob 分块 manifest 与已发布字节不一致。");
        await q.change(
          "INSERT INTO artifact_versions(artifact_id,revision,sha256,mime,byte_length,created_at) VALUES(?,?,?,?,?,?)",
          [
            artifactId,
            revision,
            sha256,
            request.mime,
            byteLength,
            new Date().toISOString(),
          ],
        );
        const committedAt = new Date().toISOString();
        await q.change(
          "INSERT INTO store_command_receipts(command_id,request_hash,operation,artifact_id,revision,sha256,committed_at) VALUES(?,?,'put',?,?,?,?)",
          [commandId, requestHash, artifactId, revision, sha256, committedAt],
        );
        return {
          storeId: this.storeId,
          artifactId,
          revision,
          sha256,
          byteLength,
          mime: request.mime,
        };
      });
    } finally {
      await unlink(stage).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  /** Tombstone the logical artifact; its immutable byte history is retained for policy-driven GC. */
  async delete(request: {
    credential: string;
    commandId: string;
    artifactId: string;
    baseRevision: number;
  }): Promise<{ artifactId: string; deletedAt: string }> {
    const artifactId = validId(request.artifactId, "Artifact ID");
    const commandId = validId(request.commandId, "命令 ID");
    if (!Number.isSafeInteger(request.baseRevision) || request.baseRevision < 1)
      throw new Error("基准版本无效。");
    const actor = await this.actor(request.credential, {
      operation: "delete",
      artifactId,
      baseRevision: request.baseRevision,
      commandId,
    });
    const requestHash = deleteRequestHash(actor, {
      artifactId,
      baseRevision: request.baseRevision,
    });
    return this.transaction(async (q) => {
      if (this.backend.kind === "postgres")
        await q.all(
          "SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0)) AS locked",
          [`${this.storeId}:${commandId}`],
        );
      const receipts = await q.all<{
        request_hash: string;
        operation: string;
        committed_at: string;
      }>(
        "SELECT request_hash,operation,committed_at FROM store_command_receipts WHERE command_id=?",
        [commandId],
      );
      if (receipts.length) {
        if (
          receipts[0]!.operation !== "delete" ||
          receipts[0]!.request_hash !== requestHash
        )
          throw new Error("相同命令 ID 对应不同删除请求。");
        return { artifactId, deletedAt: receipts[0]!.committed_at };
      }
      const artifacts = await q.all<{
        owner_tenant_id: string;
        owner_principal_id: string;
        head_revision: number | string;
        deleted_at: string | null;
      }>(
        `SELECT owner_tenant_id,owner_principal_id,head_revision,deleted_at FROM artifacts WHERE artifact_id=?${this.backend.kind === "postgres" ? " FOR UPDATE" : ""}`,
        [artifactId],
      );
      if (artifacts.length !== 1) throw new Error("Artifact 不存在。");
      const artifact = artifacts[0]!;
      if (
        artifact.owner_tenant_id !== actor.tenantId ||
        artifact.owner_principal_id !== actor.principalId
      )
        throw new Error("没有此 Artifact 的删除权限。");
      if (
        artifact.deleted_at ||
        safeInteger(artifact.head_revision, "Artifact 版本") !==
          request.baseRevision
      )
        throw new Error("Artifact 基准版本冲突。");
      const versions = await q.all<{ sha256: string }>(
        "SELECT sha256 FROM artifact_versions WHERE artifact_id=? AND revision=?",
        [artifactId, request.baseRevision],
      );
      if (versions.length !== 1) throw new Error("Artifact 当前版本缺失。");
      const deletedAt = new Date().toISOString();
      await q.change(
        "UPDATE artifacts SET deleted_at=? WHERE artifact_id=? AND head_revision=? AND deleted_at IS NULL",
        [deletedAt, artifactId, request.baseRevision],
      );
      await q.change(
        "INSERT INTO store_command_receipts(command_id,request_hash,operation,artifact_id,revision,sha256,committed_at) VALUES(?,?,'delete',?,?,?,?)",
        [
          commandId,
          requestHash,
          artifactId,
          request.baseRevision,
          versions[0]!.sha256,
          deletedAt,
        ],
      );
      return { artifactId, deletedAt };
    });
  }

  /** Resolve an ambiguous write after a lost response. A receipt is only
   * returned for the exact authorized request; a committed put also has to
   * pass the Store's full byte integrity check. This is not an application
   * authorization or a promise that a later deletion did not occur.
   */
  async inspectCommandReceipt(
    request: StoreReceiptRequest,
  ): Promise<StoreCommandReceipt | null> {
    const artifactId = validId(request.artifactId, "Artifact ID");
    const commandId = validId(request.commandId, "命令 ID");
    if (
      !Number.isSafeInteger(request.baseRevision) ||
      request.baseRevision < (request.operation === "put" ? 0 : 1)
    )
      throw new Error("基准版本无效。");
    if (request.operation === "put") {
      validSha(request.sha256, "预期摘要");
      if (
        !Number.isSafeInteger(request.byteLength) ||
        request.byteLength < 0 ||
        !request.mime ||
        request.mime.length > 200 ||
        /[\x00-\x1f]/.test(request.mime)
      )
        throw new Error("Store 写入回执请求无效。");
    }
    const scope: StoreOperationScope = {
      operation: request.operation === "put" ? "write" : "delete",
      artifactId,
      baseRevision: request.baseRevision,
      commandId,
    };
    const actor = await this.actor(request.credential, scope);
    const requestHash =
      request.operation === "put"
        ? putRequestHash(actor, request)
        : deleteRequestHash(actor, request);
    const receipt = await this.transaction(async (q) => {
      const rows = await q.all<{
        request_hash: string;
        operation: string;
        artifact_id: string;
        revision: number | string;
        sha256: string;
        committed_at: string;
      }>(
        "SELECT request_hash,operation,artifact_id,revision,sha256,committed_at FROM store_command_receipts WHERE command_id=?",
        [commandId],
      );
      if (!rows.length || rows[0]!.artifact_id !== artifactId) return null;
      const owner = await q.all<{
        owner_tenant_id: string;
        owner_principal_id: string;
      }>(
        "SELECT owner_tenant_id,owner_principal_id FROM artifacts WHERE artifact_id=?",
        [artifactId],
      );
      if (
        owner.length !== 1 ||
        owner[0]!.owner_tenant_id !== actor.tenantId ||
        owner[0]!.owner_principal_id !== actor.principalId
      )
        return null;
      const row = rows[0]!;
      if (
        row.operation !== request.operation ||
        row.request_hash !== requestHash
      )
        throw new Error("相同命令 ID 对应不同 Store 请求。");
      if (request.operation === "delete")
        return {
          operation: "delete" as const,
          artifactId,
          deletedAt: row.committed_at,
        };
      const versions = await q.all<{
        sha256: string;
        byte_length: number | string;
        mime: string;
      }>(
        "SELECT sha256,byte_length,mime FROM artifact_versions WHERE artifact_id=? AND revision=?",
        [artifactId, row.revision],
      );
      if (
        versions.length !== 1 ||
        versions[0]!.sha256 !== row.sha256 ||
        versions[0]!.sha256 !== request.sha256 ||
        safeInteger(versions[0]!.byte_length, "Artifact 长度") !==
          request.byteLength ||
        versions[0]!.mime !== request.mime
      )
        throw new Error("Store 回执引用的版本缺失或损坏。");
      return {
        operation: "put" as const,
        version: {
          storeId: this.storeId,
          artifactId,
          revision: safeInteger(row.revision, "回执版本"),
          sha256: row.sha256,
          byteLength: request.byteLength,
          mime: request.mime,
        },
        committedAt: row.committed_at,
      };
    }, true);
    if (receipt?.operation === "put")
      await this.verifyVersionBytes(
        receipt.version.sha256,
        receipt.version.byteLength,
      );
    await this.confirmActor(request.credential, scope, actor);
    return receipt;
  }

  private async authorizedVersion(
    actor: StorePrincipal,
    artifactId: string,
    revision: number | null,
  ) {
    return this.transaction(async (q) => {
      const found = await q.all<VersionRow>(
        `SELECT a.owner_tenant_id,a.owner_principal_id,a.deleted_at,a.head_revision,
                v.revision,v.sha256,v.byte_length,v.mime,b.state
           FROM artifacts a JOIN artifact_versions v ON v.artifact_id=a.artifact_id
           JOIN blobs b ON b.sha256=v.sha256
          WHERE a.artifact_id=? AND v.revision=COALESCE(?,a.head_revision)`,
        [artifactId, revision],
      );
      if (found.length !== 1) throw new Error("Artifact 版本不存在。");
      if (
        found[0]!.owner_tenant_id !== actor.tenantId ||
        found[0]!.owner_principal_id !== actor.principalId ||
        found[0]!.deleted_at
      )
        throw new Error("没有此 Artifact 的读取权限。");
      if (found[0]!.state !== "verified")
        throw new Error("Artifact 字节尚未通过校验。");
      return found[0]!;
    }, true);
  }

  private async confirmVersion(
    credential: string,
    scope: StoreOperationScope,
    actor: StorePrincipal,
    artifactId: string,
    row: VersionRow,
  ) {
    await this.confirmActor(credential, scope, actor);
    await this.transaction(async (q) => {
      const current = await q.all<VersionRow>(
        `SELECT a.owner_tenant_id,a.owner_principal_id,a.deleted_at,a.head_revision,
                v.revision,v.sha256,v.byte_length,v.mime,b.state
           FROM artifacts a JOIN artifact_versions v ON v.artifact_id=a.artifact_id
           JOIN blobs b ON b.sha256=v.sha256
          WHERE a.artifact_id=? AND v.revision=?`,
        [artifactId, row.revision],
      );
      if (
        current.length !== 1 ||
        current[0]!.owner_tenant_id !== actor.tenantId ||
        current[0]!.owner_principal_id !== actor.principalId ||
        current[0]!.deleted_at ||
        current[0]!.state !== "verified" ||
        current[0]!.sha256 !== row.sha256 ||
        current[0]!.byte_length !== row.byte_length ||
        current[0]!.mime !== row.mime
      )
        throw new Error("Artifact 读取期间权限或版本已变化。");
    }, true);
  }

  private async verifyVersionBytes(sha256: string, byteLength: number) {
    const expectedChunks = Math.ceil(byteLength / chunkSize);
    const count = await this.transaction(
      (q) =>
        q.all<{ count: number | string }>(
          "SELECT COUNT(*) AS count FROM blob_chunks WHERE sha256=?",
          [sha256],
        ),
      true,
    );
    if (
      count.length !== 1 ||
      safeInteger(count[0]!.count, "Blob 分块数量") !== expectedChunks
    )
      throw new Error("Artifact 分块索引缺失或多余。");
    const file = this.cloudBytes
      ? null
      : await open(
          this.blobPath(sha256),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
    try {
      if (file) {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size !== byteLength)
          throw new Error("Artifact 字节缺失或长度损坏。");
      } else if (expectedChunks === 0) {
        await this.cloudBytes!.assertLength(sha256, byteLength);
      }
      const fullHash = createHash("sha256");
      for (let start = 0; start < expectedChunks; start += 64) {
        const end = Math.min(start + 64, expectedChunks);
        const chunks = await this.transaction(
          (q) =>
            q.all<{
              ordinal: number | string;
              chunk_sha256: string;
              byte_length: number | string;
            }>(
              "SELECT ordinal,chunk_sha256,byte_length FROM blob_chunks WHERE sha256=? AND ordinal>=? AND ordinal<? ORDER BY ordinal",
              [sha256, start, end],
            ),
          true,
        );
        if (chunks.length !== end - start)
          throw new Error("Artifact 分块索引缺失。");
        for (const [index, chunk] of chunks.entries()) {
          const ordinal = start + index;
          const length = Math.min(chunkSize, byteLength - ordinal * chunkSize);
          if (
            safeInteger(chunk.ordinal, "Blob 分块序号") !== ordinal ||
            safeInteger(chunk.byte_length, "Blob 分块长度") !== length
          )
            throw new Error("Artifact 分块 manifest 损坏。");
          validSha(chunk.chunk_sha256, "Blob 分块摘要");
          const bytes = file
            ? Buffer.allocUnsafe(length)
            : await this.cloudBytes!.readChunk(
                sha256,
                ordinal * chunkSize,
                length,
                byteLength,
              );
          if (file) {
            let cursor = 0;
            while (cursor < length) {
              const result = await file.read(
                bytes,
                cursor,
                length - cursor,
                ordinal * chunkSize + cursor,
              );
              if (result.bytesRead === 0)
                throw new Error("Artifact 核验期间字节被截断。");
              cursor += result.bytesRead;
            }
          }
          if (
            createHash("sha256").update(bytes).digest("hex") !==
            chunk.chunk_sha256
          )
            throw new Error("Artifact 分块摘要损坏。");
          fullHash.update(bytes);
        }
      }
      if (fullHash.digest("hex") !== sha256)
        throw new Error("Artifact 字节摘要损坏。");
    } finally {
      await file?.close();
    }
  }

  /** Authoritative full-byte check for one version before a provider reports
   * that it is available. A catalog row or a zero-length range is not proof. */
  async verifyVersion(request: {
    credential: string;
    artifactId: string;
    revision?: number;
  }): Promise<StoredVersion> {
    const artifactId = validId(request.artifactId, "Artifact ID");
    if (
      request.revision !== undefined &&
      (!Number.isSafeInteger(request.revision) || request.revision < 1)
    )
      throw new Error("Artifact 版本无效。");
    const scope: StoreOperationScope = {
      operation: "read",
      artifactId,
      revision: request.revision ?? null,
    };
    const actor = await this.actor(request.credential, scope);
    const row = await this.authorizedVersion(
      actor,
      artifactId,
      request.revision ?? null,
    );
    const byteLength = safeInteger(row.byte_length, "Artifact 长度");
    validSha(row.sha256, "存储摘要");
    await this.verifyVersionBytes(row.sha256, byteLength);
    await this.confirmVersion(
      request.credential,
      scope,
      actor,
      artifactId,
      row,
    );
    return {
      storeId: this.storeId,
      artifactId,
      revision: safeInteger(row.revision, "Artifact 版本"),
      sha256: row.sha256,
      byteLength,
      mime: row.mime,
    };
  }

  /** Authorized immutable version metadata and physical length, without
   * reading the original. This does not certify all bytes as healthy: range
   * reads verify the touched chunks, while verifyVersion/backup audit all bytes.
   */
  async readVersionMetadata(request: {
    credential: string;
    artifactId: string;
    revision?: number;
  }): Promise<StoredVersion> {
    const artifactId = validId(request.artifactId, "Artifact ID");
    if (
      request.revision !== undefined &&
      (!Number.isSafeInteger(request.revision) || request.revision < 1)
    )
      throw new Error("Artifact 版本无效。");
    const scope: StoreOperationScope = {
      operation: "read",
      artifactId,
      revision: request.revision ?? null,
    };
    const actor = await this.actor(request.credential, scope);
    const row = await this.authorizedVersion(
      actor,
      artifactId,
      request.revision ?? null,
    );
    const byteLength = safeInteger(row.byte_length, "Artifact 长度");
    validSha(row.sha256, "存储摘要");
    if (this.cloudBytes) {
      await this.cloudBytes.assertLength(row.sha256, byteLength);
    } else {
      const file = await open(
        this.blobPath(row.sha256),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size !== byteLength)
          throw new Error("Artifact 字节缺失或长度损坏。");
      } finally {
        await file.close();
      }
    }
    await this.confirmVersion(
      request.credential,
      scope,
      actor,
      artifactId,
      row,
    );
    return {
      storeId: this.storeId,
      artifactId,
      revision: safeInteger(row.revision, "Artifact 版本"),
      sha256: row.sha256,
      byteLength,
      mime: row.mime,
    };
  }

  /** Bounded range read; verifies every touched chunk before exposing bytes. */
  async readRange(request: {
    credential: string;
    artifactId: string;
    revision?: number;
    start?: number;
    endExclusive?: number;
  }): Promise<{ version: StoredVersion; bytes: Uint8Array }> {
    const artifactId = validId(request.artifactId, "Artifact ID");
    if (
      request.revision !== undefined &&
      (!Number.isSafeInteger(request.revision) || request.revision < 1)
    )
      throw new Error("Artifact 版本无效。");
    const operationScope: StoreOperationScope = {
      operation: "read",
      artifactId,
      revision: request.revision ?? null,
    };
    const actor = await this.actor(request.credential, operationScope);
    const row = await this.authorizedVersion(
      actor,
      artifactId,
      request.revision ?? null,
    );
    const byteLength = safeInteger(row.byte_length, "Artifact 长度");
    const start = request.start ?? 0;
    const end = request.endExclusive ?? byteLength;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end > byteLength ||
      end - start > 8 * 1024 * 1024
    )
      throw new Error("Artifact 读取范围无效或超过 8 MiB。");
    validSha(row.sha256, "存储摘要");
    const firstChunk = Math.floor(start / chunkSize);
    const lastChunk = Math.floor((end - 1) / chunkSize);
    const chunks =
      start === end
        ? []
        : await this.transaction(
            (q) =>
              q.all<{
                ordinal: number | string;
                chunk_sha256: string;
                byte_length: number | string;
              }>(
                "SELECT ordinal,chunk_sha256,byte_length FROM blob_chunks WHERE sha256=? AND ordinal BETWEEN ? AND ? ORDER BY ordinal",
                [row.sha256, firstChunk, lastChunk],
              ),
            true,
          );
    if (chunks.length !== (start === end ? 0 : lastChunk - firstChunk + 1))
      throw new Error("Artifact 分块索引缺失。");
    const file = this.cloudBytes
      ? null
      : await open(
          this.blobPath(row.sha256),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
    const bytes = Buffer.alloc(end - start);
    try {
      if (file) {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size !== byteLength)
          throw new Error("Artifact 字节缺失或长度损坏。");
      } else if (start === end) {
        await this.cloudBytes!.assertLength(row.sha256, byteLength);
      }
      for (const [index, chunk] of chunks.entries()) {
        const ordinal = firstChunk + index;
        if (safeInteger(chunk.ordinal, "Blob 分块序号") !== ordinal)
          throw new Error("Artifact 分块序号损坏。");
        const chunkLength = safeInteger(chunk.byte_length, "Blob 分块长度");
        if (
          chunkLength !== Math.min(chunkSize, byteLength - ordinal * chunkSize)
        )
          throw new Error("Artifact 分块长度损坏。");
        const buffer = file
          ? Buffer.allocUnsafe(chunkLength)
          : await this.cloudBytes!.readChunk(
              row.sha256,
              ordinal * chunkSize,
              chunkLength,
              byteLength,
            );
        if (file) {
          let cursor = 0;
          while (cursor < chunkLength) {
            const result = await file.read(
              buffer,
              cursor,
              chunkLength - cursor,
              ordinal * chunkSize + cursor,
            );
            if (result.bytesRead === 0)
              throw new Error("Artifact 读取期间字节被截断。");
            cursor += result.bytesRead;
          }
        }
        if (
          createHash("sha256").update(buffer).digest("hex") !==
          chunk.chunk_sha256
        )
          throw new Error("Artifact 分块摘要损坏。");
        const from = Math.max(start, ordinal * chunkSize);
        const to = Math.min(end, ordinal * chunkSize + chunkLength);
        buffer.copy(
          bytes,
          from - start,
          from - ordinal * chunkSize,
          to - ordinal * chunkSize,
        );
      }
    } finally {
      await file?.close();
    }
    // The file read may outlive a permission grant or a logical deletion.
    // Recheck the live capability and exact immutable version before bytes
    // leave this API; an earlier catalog/index observation is never a token.
    await this.confirmVersion(
      request.credential,
      operationScope,
      actor,
      artifactId,
      row,
    );
    return {
      version: {
        storeId: this.storeId,
        artifactId,
        revision: safeInteger(row.revision, "Artifact 版本"),
        sha256: row.sha256,
        byteLength,
        mime: row.mime,
      },
      bytes,
    };
  }

  /** Explicit maintenance check; never deletes an unreferenced or damaged file. */
  async inspectIntegrity() {
    const snapshot = await this.transaction(async (q) => {
      const blobs = await q.all<{
        sha256: string;
        byte_length: number | string;
      }>("SELECT sha256,byte_length FROM blobs ORDER BY sha256");
      const usage = await q.all<{ committed_bytes: number | string }>(
        "SELECT committed_bytes FROM store_usage WHERE id=1",
      );
      return { blobs, usage };
    }, true);
    const { blobs, usage } = snapshot;
    const committedBytes = blobs.reduce(
      (total, blob) => total + safeInteger(blob.byte_length, "Blob 长度"),
      0,
    );
    if (!Number.isSafeInteger(committedBytes))
      throw new Error("Store 已提交字节数超过安全整数范围。");
    const usageMismatch =
      usage.length !== 1 ||
      safeInteger(usage[0]!.committed_bytes, "Store 已提交字节数") !==
        committedBytes;
    const known = new Set(blobs.map((row) => row.sha256));
    const damaged: string[] = [];
    for (const blob of blobs) {
      try {
        validSha(blob.sha256, "Blob 摘要");
        if (this.cloudBytes)
          await this.cloudBytes.verify(
            blob.sha256,
            safeInteger(blob.byte_length, "Blob 长度"),
          );
        else
          await verifyBlobFile(
            this.blobPath(blob.sha256),
            blob.sha256,
            safeInteger(blob.byte_length, "Blob 长度"),
          );
      } catch {
        damaged.push(blob.sha256);
      }
    }
    const orphans: string[] = [];
    const unexpected: string[] = [];
    if (this.cloudBytes) {
      for await (const object of this.cloudBytes.listObjects("blobs")) {
        const match = /^([a-f0-9]{2})\/([a-f0-9]{64})$/.exec(object.relative);
        if (!match || !match[2]!.startsWith(match[1]!)) {
          unexpected.push(object.relative);
          continue;
        }
        if (!known.has(match[2]!)) orphans.push(match[2]!);
      }
    } else {
      for (const prefix of await readdir(join(this.root, "blobs"), {
        withFileTypes: true,
      })) {
        if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) {
          unexpected.push(prefix.name);
          continue;
        }
        for (const entry of await readdir(
          join(this.root, "blobs", prefix.name),
          {
            withFileTypes: true,
          },
        )) {
          if (
            !entry.isFile() ||
            !shaPattern.test(entry.name) ||
            !entry.name.startsWith(prefix.name)
          ) {
            unexpected.push(`${prefix.name}/${entry.name}`);
            continue;
          }
          if (!known.has(entry.name)) orphans.push(entry.name);
        }
      }
    }
    const staged = await readdir(join(this.root, "staging"));
    const quarantined: string[] = [];
    if (this.cloudBytes) {
      for await (const object of this.cloudBytes.listObjects("quarantine"))
        quarantined.push(object.relative);
    } else {
      quarantined.push(...(await readdir(join(this.root, "quarantine"))));
    }
    return {
      manifestBlobs: blobs.length,
      committedBytes,
      usageMismatch,
      damaged,
      orphans,
      unexpected,
      staged,
      quarantined,
    };
  }

  private async quarantineCloudOrphans(options: {
    minAgeMs: number;
    afterSha256?: string;
    limit: number;
  }) {
    const cloud = this.cloudBytes!;
    return this.transaction(async (q) => {
      await this.lockBlobMutation(q);
      const cutoff = Date.now() - options.minAgeMs;
      const quarantined: string[] = [];
      let scanned = 0;
      let cursor: string | null = null;
      for await (const object of cloud.listObjects("blobs")) {
        const match = /^([a-f0-9]{2})\/([a-f0-9]{64})$/.exec(object.relative);
        if (!match || !match[2]!.startsWith(match[1]!)) continue;
        const sha256 = match[2]!;
        if (options.afterSha256 && sha256 <= options.afterSha256) continue;
        if (scanned === options.limit)
          return { scanned, quarantined, nextAfterSha256: cursor };
        scanned++;
        cursor = sha256;
        if (!Number.isFinite(object.modifiedAt) || object.modifiedAt > cutoff)
          continue;
        const referenced = await q.all(
          "SELECT 1 AS present WHERE EXISTS(SELECT 1 FROM blobs WHERE sha256=?) OR EXISTS(SELECT 1 FROM artifact_versions WHERE sha256=?) OR EXISTS(SELECT 1 FROM blob_chunks WHERE sha256=?)",
          [sha256, sha256, sha256],
        );
        if (referenced.length) continue;
        await cloud.quarantineOrphan(
          sha256,
          object.byteLength,
          object.etag,
          `${Date.now()}-${sha256}-${randomUUID()}`,
        );
        quarantined.push(sha256);
      }
      return { scanned, quarantined, nextAfterSha256: null };
    });
  }

  private async purgeCloudQuarantine(options: {
    minAgeMs: number;
    afterName?: string;
    limit: number;
  }) {
    const cloud = this.cloudBytes!;
    return this.transaction(async (q) => {
      await this.lockBlobMutation(q);
      const cutoff = Date.now() - options.minAgeMs;
      const removed: string[] = [];
      const retained: string[] = [];
      const unexpected: string[] = [];
      let scanned = 0;
      let cursor: string | null = null;
      for await (const object of cloud.listObjects("quarantine")) {
        if (options.afterName && object.relative <= options.afterName) continue;
        const match = quarantineFilePattern.exec(object.relative);
        if (!match) {
          unexpected.push(object.relative);
          continue;
        }
        if (scanned === options.limit)
          return {
            scanned,
            removed,
            retained,
            unexpected,
            nextAfterName: cursor,
          };
        scanned++;
        cursor = object.relative;
        const quarantinedAt = Number(match[1]);
        if (
          !Number.isSafeInteger(quarantinedAt) ||
          quarantinedAt > cutoff ||
          !Number.isFinite(object.modifiedAt) ||
          object.modifiedAt > cutoff
        )
          continue;
        const sha256 = match[2]!;
        const referenced = await q.all(
          "SELECT 1 AS present WHERE EXISTS(SELECT 1 FROM blobs WHERE sha256=?) OR EXISTS(SELECT 1 FROM artifact_versions WHERE sha256=?) OR EXISTS(SELECT 1 FROM blob_chunks WHERE sha256=?)",
          [sha256, sha256, sha256],
        );
        if (referenced.length) {
          retained.push(sha256);
          continue;
        }
        await cloud.purgeQuarantine(object.relative, object.etag);
        removed.push(sha256);
      }
      return { scanned, removed, retained, unexpected, nextAfterName: null };
    });
  }

  /** Move old, unreferenced published files to a private recovery area.
   * This never removes manifest rows, historical versions or their bytes.
   * A separate retention decision is required before deleting quarantine.
   */
  async quarantineOrphanBlobs(
    options: {
      minAgeMs?: number;
      afterSha256?: string;
      limit?: number;
    } = {},
  ) {
    const minAgeMs = options.minAgeMs ?? 24 * 60 * 60 * 1000;
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(minAgeMs) || minAgeMs < 0)
      throw new Error("Store 孤立字节保护时间无效。");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new Error("Store 孤立字节扫描上限无效。");
    if (options.afterSha256 !== undefined)
      validSha(options.afterSha256, "Store 扫描游标");
    if (this.cloudBytes)
      return this.quarantineCloudOrphans({
        minAgeMs,
        limit,
        afterSha256: options.afterSha256,
      });
    privateDirectory(join(this.root, "blobs"));
    privateDirectory(join(this.root, "quarantine"));
    return this.transaction(async (q) => {
      await this.lockBlobMutation(q);
      const cutoff = Date.now() - minAgeMs;
      const quarantined: string[] = [];
      let scanned = 0;
      let cursor: string | null = null;
      const prefixes = (
        await readdir(join(this.root, "blobs"), {
          withFileTypes: true,
        })
      )
        .filter(
          (entry) => entry.isDirectory() && /^[a-f0-9]{2}$/.test(entry.name),
        )
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const prefix of prefixes) {
        const directory = join(this.root, "blobs", prefix.name);
        privateDirectory(directory);
        const entries = (await readdir(directory, { withFileTypes: true }))
          .filter(
            (entry) =>
              entry.isFile() &&
              shaPattern.test(entry.name) &&
              entry.name.startsWith(prefix.name) &&
              (!options.afterSha256 || entry.name > options.afterSha256),
          )
          .sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
          if (scanned === limit)
            return { scanned, quarantined, nextAfterSha256: cursor };
          scanned++;
          cursor = entry.name;
          const source = join(directory, entry.name);
          const stat = await lstat(source);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs > cutoff)
            continue;
          const referenced = await q.all(
            "SELECT 1 AS present WHERE EXISTS(SELECT 1 FROM blobs WHERE sha256=?) OR EXISTS(SELECT 1 FROM artifact_versions WHERE sha256=?) OR EXISTS(SELECT 1 FROM blob_chunks WHERE sha256=?)",
            [entry.name, entry.name, entry.name],
          );
          if (referenced.length) continue;
          const target = join(
            this.root,
            "quarantine",
            `${Date.now()}-${entry.name}-${randomUUID()}`,
          );
          await link(source, target);
          syncDirectory(join(this.root, "quarantine"));
          await unlink(source);
          syncDirectory(directory);
          quarantined.push(entry.name);
        }
      }
      return { scanned, quarantined, nextAfterSha256: null };
    });
  }

  /** Permanently remove only aged files previously quarantined as orphans.
   * A newly committed reference to the same digest keeps the recovery copy.
   * Tombstoned Artifacts and every manifest-backed historical version are
   * outside this operation; their retention requires a separate policy.
   */
  async purgeQuarantinedOrphans(
    options: {
      minAgeMs?: number;
      afterName?: string;
      limit?: number;
    } = {},
  ) {
    const minAgeMs = options.minAgeMs ?? 7 * 24 * 60 * 60 * 1000;
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(minAgeMs) || minAgeMs < 0)
      throw new Error("Store 隔离字节保留时间无效。");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new Error("Store 隔离字节清理上限无效。");
    if (
      options.afterName !== undefined &&
      !quarantineFilePattern.test(options.afterName)
    )
      throw new Error("Store 隔离字节清理游标无效。");
    if (this.cloudBytes)
      return this.purgeCloudQuarantine({
        minAgeMs,
        limit,
        afterName: options.afterName,
      });
    const directory = join(this.root, "quarantine");
    privateDirectory(directory);
    return this.transaction(async (q) => {
      await this.lockBlobMutation(q);
      const cutoff = Date.now() - minAgeMs;
      const removed: string[] = [];
      const retained: string[] = [];
      const unexpected: string[] = [];
      let scanned = 0;
      let cursor: string | null = null;
      const entries = (await readdir(directory, { withFileTypes: true })).sort(
        (left, right) => left.name.localeCompare(right.name),
      );
      for (const entry of entries) {
        if (options.afterName && entry.name <= options.afterName) continue;
        const match = quarantineFilePattern.exec(entry.name);
        if (!match || !entry.isFile()) {
          unexpected.push(entry.name);
          continue;
        }
        if (scanned === limit) {
          if (removed.length) syncDirectory(directory);
          return {
            scanned,
            removed,
            retained,
            unexpected,
            nextAfterName: cursor,
          };
        }
        scanned++;
        cursor = entry.name;
        const quarantinedAt = Number(match[1]);
        if (!Number.isSafeInteger(quarantinedAt) || quarantinedAt > cutoff)
          continue;
        const path = join(directory, entry.name);
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
          unexpected.push(entry.name);
          continue;
        }
        const sha256 = match[2]!;
        const referenced = await q.all(
          "SELECT 1 AS present WHERE EXISTS(SELECT 1 FROM blobs WHERE sha256=?) OR EXISTS(SELECT 1 FROM artifact_versions WHERE sha256=?) OR EXISTS(SELECT 1 FROM blob_chunks WHERE sha256=?)",
          [sha256, sha256, sha256],
        );
        if (referenced.length) {
          retained.push(sha256);
          continue;
        }
        await unlink(path);
        removed.push(sha256);
      }
      if (removed.length) syncDirectory(directory);
      return { scanned, removed, retained, unexpected, nextAfterName: null };
    });
  }
}
