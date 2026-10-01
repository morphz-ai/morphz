import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Pool, Client } from "pg";
import {
  ManagedArtifactStore,
  type StoreAuthorizer,
} from "../packages/managed-artifact-store/src/store.js";
import { managedArtifactStoreSchemaSql } from "../packages/managed-artifact-store/src/schema.js";
import { managedArtifactStoreV1SchemaSql } from "../packages/managed-artifact-store/src/schema-v1.js";
import { backupTables } from "../packages/managed-artifact-store/src/backup.js";
import {
  postgresQuery,
  sqliteQuery,
  schemaHash,
  type SqlQuery,
} from "../packages/storage/src/sql.js";

const original = Buffer.from(
  "非空原件：升级只移除退役的节点身份字段。",
  "utf8",
);
const revised = Buffer.from("第二个不可变版本，保留原命令回执。", "utf8");
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const authorizer: StoreAuthorizer = {
  async authorize(credential, request) {
    if (credential !== "alice" || request.storeId !== "store-one")
      throw new Error("未授权");
    return { tenantId: "tenant-one", principalId: "alice" };
  },
};

async function snapshot(q: SqlQuery) {
  const rows: unknown[] = [];
  for (const table of backupTables)
    rows.push(
      await q.all(
        `SELECT ${table.columns.join(",")} FROM ${table.name} ORDER BY ${table.keys.join(",")}`,
      ),
    );
  rows.push(await q.all("SELECT * FROM store_usage ORDER BY id"));
  return rows;
}

async function fixture(backend: "sqlite" | "postgres") {
  const parent = mkdtempSync(
    join(tmpdir(), `morphz-store-v1-upgrade-${backend}-`),
  );
  const root = join(parent, "source");
  const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
  const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
  const admin = backend === "postgres" ? new Pool({ connectionString }) : null;
  if (admin) await admin.query(`CREATE SCHEMA "${schema}"`);
  const options = {
    root,
    storeId: "store-one",
    authorizer,
    maxCommittedBytes: 10000,
  };
  const open = () =>
    backend === "sqlite"
      ? ManagedArtifactStore.sqlite(options)
      : ManagedArtifactStore.postgres({ ...options, connectionString, schema });
  const store = await open();
  const request = {
    credential: "alice",
    commandId: "original-command",
    artifactId: "artifact-one",
    baseRevision: 0,
    mime: "text/plain",
    bytes: original,
  };
  const first = await store.put(request);
  const second = await store.put({
    ...request,
    commandId: "revision-command",
    baseRevision: 1,
    bytes: revised,
  });
  await store.close();
  let database =
    backend === "sqlite"
      ? new DatabaseSync(join(root, "manifest.sqlite"))
      : null;
  const client = admin ? await admin.connect() : null;
  if (client) await client.query(`SET search_path TO "${schema}", pg_catalog`);
  let q = database ? sqliteQuery(database) : postgresQuery(client!);
  function refresh() {
    if (database) {
      database.close();
      database = new DatabaseSync(join(root, "manifest.sqlite"));
      q = sqliteQuery(database);
    }
  }
  const identity = (
    await q.all<{
      store_id: string;
      root_binding_id: string;
      created_at: string;
    }>("SELECT * FROM store_identity")
  )[0]!;
  const before = await snapshot(q);
  const rootMarker =
    backend === "postgres"
      ? (JSON.parse(
          readFileSync(join(root, "store-root.json"), "utf8"),
        ) as Record<string, unknown>)
      : null;
  async function downgrade(markerVersion: 1 | 2 = 1) {
    await q.exec("BEGIN");
    try {
      await q.exec(
        "ALTER TABLE store_identity RENAME TO store_identity_fixture_v2",
      );
      await q.exec(
        "CREATE TABLE store_identity(store_id TEXT PRIMARY KEY,node_id TEXT,root_binding_id TEXT NOT NULL,created_at TEXT NOT NULL)",
      );
      await q.change(
        "INSERT INTO store_identity(store_id,node_id,root_binding_id,created_at) SELECT store_id,?,root_binding_id,created_at FROM store_identity_fixture_v2",
        [null],
      );
      await q.exec("DROP TABLE store_identity_fixture_v2");
      await q.change(
        "UPDATE store_schema_version SET version=1,schema_sha256=?",
        [schemaHash(managedArtifactStoreV1SchemaSql)],
      );
      await q.exec("COMMIT");
    } catch (error) {
      await q.exec("ROLLBACK");
      throw error;
    }
    if (rootMarker && markerVersion === 1)
      writeFileSync(
        join(root, "store-root.json"),
        JSON.stringify({ ...rootMarker, format: 1, nodeId: null }),
        { mode: 0o600 },
      );
  }
  async function prove(store: ManagedArtifactStore) {
    refresh();
    assert.equal(store.storeId, identity.store_id);
    assert.deepEqual(await snapshot(q), before);
    assert.deepEqual(
      (await q.all("SELECT * FROM store_identity"))[0],
      identity,
    );
    assert.deepEqual(
      (
        await q.all("SELECT version,schema_sha256 FROM store_schema_version")
      ).map((row) => ({
        version: Number(row.version),
        hash: row.schema_sha256,
      })),
      [{ version: 2, hash: schemaHash(managedArtifactStoreSchemaSql) }],
    );
    const columns = database
      ? await q.all<{ name: string }>("PRAGMA table_info(store_identity)")
      : await q.all<{ name: string }>(
          "SELECT column_name AS name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='store_identity' ORDER BY ordinal_position",
        );
    assert.deepEqual(
      columns.map((column) => column.name),
      ["store_id", "root_binding_id", "created_at"],
    );
    assert.deepEqual(
      (
        await store.readRange({
          credential: "alice",
          artifactId: "artifact-one",
          revision: 1,
        })
      ).bytes,
      original,
    );
    assert.deepEqual(
      (
        await store.readRange({
          credential: "alice",
          artifactId: "artifact-one",
          revision: 2,
        })
      ).bytes,
      revised,
    );
    assert.deepEqual(await store.put(request), first);
    assert.deepEqual(
      await store.inspectCommandReceipt({
        operation: "put",
        ...request,
        sha256: sha256(original),
        byteLength: original.length,
      }),
      {
        operation: "put",
        version: first,
        committedAt: (
          await q.all<{ committed_at: string }>(
            "SELECT committed_at FROM store_command_receipts WHERE command_id='original-command'",
          )
        )[0]!.committed_at,
      },
    );
    assert.deepEqual(
      await store.verifyVersion({
        credential: "alice",
        artifactId: "artifact-one",
        revision: 2,
      }),
      second,
    );
    if (rootMarker)
      assert.deepEqual(
        JSON.parse(readFileSync(join(root, "store-root.json"), "utf8")),
        rootMarker,
      );
  }
  async function cleanup() {
    database?.close();
    client?.release();
    if (admin) {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
    chmodSync(root, 0o700);
    rmSync(parent, { recursive: true, force: true });
  }
  return {
    backend,
    parent,
    root,
    open,
    get q() {
      return q;
    },
    identity,
    before,
    rootMarker,
    request,
    first,
    second,
    downgrade,
    prove,
    refresh,
    cleanup,
  };
}

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.MORPHZ_TEST_POSTGRES_URL,
  };
  test(
    `受管 Store ${backend}：严格 v1→v2 保留非空字节、根身份、版本、配额与回执，重开和恢复不变`,
    options,
    async () => {
      const f = await fixture(backend);
      let opened: ManagedArtifactStore | undefined;
      let restored: ManagedArtifactStore | undefined;
      const targetSchema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
      const admin =
        backend === "postgres"
          ? new Pool({
              connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
            })
          : null;
      try {
        await f.downgrade();
        opened = await f.open();
        await f.prove(opened);
        const backupDirectory = join(f.parent, "backup");
        const backupInfo = await opened.backupTo(backupDirectory);
        assert.equal(backupInfo.format, 2);
        assert.equal(Object.hasOwn(backupInfo, "nodeId"), false);
        await opened.close();
        opened = await f.open();
        await f.prove(opened);
        if (admin) await admin.query(`CREATE SCHEMA "${targetSchema}"`);
        const restoreOptions = {
          root: join(f.parent, "restored"),
          storeId: "store-one",
          authorizer,
          maxCommittedBytes: 10000,
          backupDirectory,
        };
        restored =
          backend === "sqlite"
            ? await ManagedArtifactStore.restoreSqlite(restoreOptions)
            : await ManagedArtifactStore.restorePostgres({
                ...restoreOptions,
                connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
                schema: targetSchema,
              });
        assert.equal(restored.storeId, f.identity.store_id);
        assert.deepEqual(
          (
            await restored.readRange({
              credential: "alice",
              artifactId: "artifact-one",
              revision: 1,
            })
          ).bytes,
          original,
        );
        assert.deepEqual(
          (
            await restored.readRange({
              credential: "alice",
              artifactId: "artifact-one",
              revision: 2,
            })
          ).bytes,
          revised,
        );
        assert.deepEqual(await restored.put(f.request), f.first);
        assert.deepEqual(
          await restored.verifyVersion({
            credential: "alice",
            artifactId: "artifact-one",
            revision: 2,
          }),
          f.second,
        );
        await restored.close();
        restored = undefined;
        const oldInfo = {
          ...backupInfo,
          format: 1,
          nodeId: null,
          schemaSha256: schemaHash(managedArtifactStoreV1SchemaSql),
        };
        writeFileSync(
          join(backupDirectory, "backup-info.json"),
          JSON.stringify(oldInfo),
        );
        await assert.rejects(
          ManagedArtifactStore.verifyBackup({
            backupDirectory,
            storeId: "store-one",
          }),
          /身份、版本或完成标记不匹配/,
        );
        await assert.rejects(
          ManagedArtifactStore.restoreSqlite({
            ...restoreOptions,
            root: join(f.parent, "old-backup-target"),
          }),
          /身份、版本或完成标记不匹配/,
        );
      } finally {
        await restored?.close();
        await opened?.close();
        if (admin) {
          await admin.query(`DROP SCHEMA IF EXISTS "${targetSchema}" CASCADE`);
          await admin.end();
        }
        await f.cleanup();
      }
    },
  );

  test(
    `受管 Store ${backend}：旧结构不完整或新版身份表残留 node_id 都拒绝，失败不升级`,
    options,
    async () => {
      const f = await fixture(backend);
      try {
        await f.downgrade();
        await f.q.exec(
          "ALTER TABLE store_identity ADD COLUMN foreign_column TEXT",
        );
        await assert.rejects(f.open(), /身份表字段/);
        assert.equal(
          Number(
            (await f.q.all("SELECT version FROM store_schema_version"))[0]!
              .version,
          ),
          1,
        );
        assert.deepEqual(await snapshot(f.q), f.before);
        await f.q.exec("ALTER TABLE store_identity DROP COLUMN foreign_column");
        await f.q.exec("DROP INDEX versions_by_blob");
        await assert.rejects(f.open(), /索引缺失/);
        assert.equal(
          Number(
            (await f.q.all("SELECT version FROM store_schema_version"))[0]!
              .version,
          ),
          1,
        );
        await f.q.exec(
          "CREATE INDEX versions_by_blob ON artifact_versions(sha256,artifact_id,revision)",
        );
        const upgraded = await f.open();
        await upgraded.close();
        // Refresh this fixture's separate SQLite connection after the production
        // connection committed DDL; then deliberately corrupt the actual v2 table.
        f.refresh();
        await f.q.exec("ALTER TABLE store_identity ADD COLUMN node_id TEXT");
        await assert.rejects(f.open(), /身份表字段/);
        assert.equal(
          Number(
            (await f.q.all("SELECT version FROM store_schema_version"))[0]!
              .version,
          ),
          2,
        );
      } finally {
        await f.cleanup();
      }
    },
  );
}

test("受管 Store SQLite：升级事务失败回滚原列和版本，原操作重试完成", async () => {
  const f = await fixture("sqlite");
  let opened: ManagedArtifactStore | undefined;
  try {
    await f.downgrade();
    await f.q.exec(
      "CREATE TRIGGER reject_store_upgrade BEFORE UPDATE ON store_schema_version BEGIN SELECT RAISE(ABORT,'test: marker update failed'); END",
    );
    await assert.rejects(f.open(), /marker update failed/);
    f.refresh();
    assert.equal(
      Number(
        (await f.q.all("SELECT version FROM store_schema_version"))[0]!.version,
      ),
      1,
    );
    assert.deepEqual(
      (
        await f.q.all<{ name: string }>("PRAGMA table_info(store_identity)")
      ).map((column) => column.name),
      ["store_id", "node_id", "root_binding_id", "created_at"],
    );
    assert.deepEqual(await snapshot(f.q), f.before);
    await f.q.exec("DROP TRIGGER reject_store_upgrade");
    opened = await f.open();
    await f.prove(opened);
  } finally {
    await opened?.close();
    await f.cleanup();
  }
});

test(
  "受管 Store PostgreSQL：DB已提交而根标记发布失败，不开放业务，同一重开完成升级",
  {
    skip: !process.env.MORPHZ_TEST_POSTGRES_URL || process.platform === "win32",
  },
  async () => {
    const f = await fixture("postgres");
    let opened: ManagedArtifactStore | undefined;
    try {
      await f.downgrade();
      chmodSync(f.root, 0o500);
      await assert.rejects(f.open(), /EACCES|EPERM/);
      assert.equal(
        Number(
          (await f.q.all("SELECT version FROM store_schema_version"))[0]!
            .version,
        ),
        2,
      );
      assert.equal(
        JSON.parse(readFileSync(join(f.root, "store-root.json"), "utf8"))
          .format,
        1,
      );
      chmodSync(f.root, 0o700);
      opened = await f.open();
      await f.prove(opened);
    } finally {
      chmodSync(f.root, 0o700);
      await opened?.close();
      await f.cleanup();
    }
  },
);

test(
  "受管 Store PostgreSQL：根标记先升级而DB事务回滚，同一重开核验身份并完成升级",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const f = await fixture("postgres");
    let opened: ManagedArtifactStore | undefined;
    try {
      await f.downgrade();
      await f.q.exec("BEGIN");
      await f.q.exec("ALTER TABLE store_identity DROP COLUMN node_id");
      await f.q.change(
        "UPDATE store_schema_version SET version=2,schema_sha256=?",
        [schemaHash(managedArtifactStoreSchemaSql)],
      );
      writeFileSync(
        join(f.root, "store-root.json"),
        JSON.stringify(f.rootMarker),
      );
      await f.q.exec("ROLLBACK");
      assert.equal(
        Number(
          (await f.q.all("SELECT version FROM store_schema_version"))[0]!
            .version,
        ),
        1,
      );
      opened = await f.open();
      await f.prove(opened);
    } finally {
      await opened?.close();
      await f.cleanup();
    }
  },
);

test(
  "受管 Store PostgreSQL：DB提交回执丢失不开放业务，重开从实际已提交状态完成根升级",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const f = await fixture("postgres");
    let opened: ManagedArtifactStore | undefined;
    const query = Client.prototype.query;
    try {
      await f.downgrade();
      Client.prototype.query = function (this: Client, ...args: unknown[]) {
        const result = Reflect.apply(query, this, args);
        if (args[0] === "COMMIT")
          return Promise.resolve(result).then(() => {
            throw new Error("test: committed acknowledgement lost");
          });
        return result;
      } as typeof query;
      await assert.rejects(f.open(), /committed acknowledgement lost/);
      Client.prototype.query = query;
      assert.equal(
        Number(
          (await f.q.all("SELECT version FROM store_schema_version"))[0]!
            .version,
        ),
        2,
      );
      assert.equal(
        JSON.parse(readFileSync(join(f.root, "store-root.json"), "utf8"))
          .format,
        1,
      );
      opened = await f.open();
      await f.prove(opened);
    } finally {
      Client.prototype.query = query;
      await opened?.close();
      await f.cleanup();
    }
  },
);

test(
  "受管 Store PostgreSQL：旧根身份不匹配时升级失败，原列与业务行不变",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const f = await fixture("postgres");
    try {
      await f.downgrade();
      const marker = JSON.parse(
        readFileSync(join(f.root, "store-root.json"), "utf8"),
      );
      writeFileSync(
        join(f.root, "store-root.json"),
        JSON.stringify({ ...marker, nodeId: "other-retired-node" }),
      );
      await assert.rejects(f.open(), /绑定不一致/);
      assert.equal(
        Number(
          (await f.q.all("SELECT version FROM store_schema_version"))[0]!
            .version,
        ),
        1,
      );
      assert.deepEqual(await snapshot(f.q), f.before);
    } finally {
      await f.cleanup();
    }
  },
);
