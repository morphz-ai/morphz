import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Pool } from "pg";
import {
  PlatformStore,
  PlatformStorageError,
  type PlatformAuthorityVerifier,
} from "../packages/platform/src/store.js";
import { platformSchemaSql } from "../packages/platform/src/schema.js";
import { schemaHash } from "../packages/storage/src/sql.js";

// The known hashes are historical identities, not recalculated expectations.
const v10Hash =
  "57b923d57efc09d0e722246916e083237f988836d82042029039c45ffd704cdd";
const v9Hash =
  "95bd108425eacc274efd75837ea7f47e5dcea853d4c23128171efe87e18f0161";
const v11Hash =
  "d4b180364680faffd2956dc079b3f0838ef31c9252e2aa975df8d4d05455837d";
const v11Sql = platformSchemaSql.replace(
  /\n-- BEGIN cognitive-app-registration-v1\n[\s\S]*?-- END cognitive-app-registration-v1\n?$/,
  "",
);
const v10Sql = v11Sql.replace(
  /\n-- BEGIN cognitive-app-v1\n[\s\S]*?-- END cognitive-app-v1\n?$/,
  "",
);
const v9Sql = v10Sql.replace(
  /^-- BEGIN profile-avatar-v1\n[\s\S]*?^-- END profile-avatar-v1\n\n/gm,
  "",
);
const cognitiveTables = [
  "cognitive_app_versions",
  "cognitive_app_grants",
  "cognitive_app_authorities",
  "cognitive_app_connections",
  "cognitive_app_view_bindings",
  "cognitive_app_commands",
] as const;
const legacyTables = [
  "tenants",
  "projects",
  "project_members",
  "app_installations",
  "app_ui_packages",
  "app_instances",
  "app_view_instances",
  "content_entries",
] as const;
const now = "2026-10-05T00:00:00.000Z";
const hash = "a".repeat(64);
const verifier: PlatformAuthorityVerifier = {
  resolveActor: async () => null,
  resolveActant: async () => null,
  resolveProjectAgent: async () => null,
  verifyApplicationObject: async () => false,
};
type Row = Record<string, string | number | null>;
type TestQuery = {
  all(sql: string, values?: readonly SQLInputValue[]): Promise<Row[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
};
type Harness = {
  q: TestQuery;
  connect(): Promise<TestQuery>;
  open(): Promise<PlatformStore>;
};

async function isolated(
  backend: "sqlite" | "postgres",
  work: (h: Harness) => Promise<void>,
) {
  if (backend === "sqlite") {
    const directory = mkdtempSync(
      join(tmpdir(), "morphz-cognitive-migration-"),
    );
    const filename = join(directory, "platform.sqlite");
    const connect = async (): Promise<TestQuery> => {
      const database = new DatabaseSync(filename);
      database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
      return {
        async all(sql, values = []) {
          return database.prepare(sql).all(...values) as Row[];
        },
        async exec(sql) {
          database.exec(sql);
        },
        async close() {
          database.close();
        },
      };
    };
    const q = await connect();
    try {
      await work({
        q,
        connect,
        open: () => PlatformStore.sqlite(filename, verifier),
      });
    } finally {
      await q.close();
      rmSync(directory, { recursive: true, force: true });
    }
    return;
  }
  const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
  const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString });
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const connect = async (): Promise<TestQuery> => {
    const client = await pool.connect();
    await client.query(`SET search_path TO "${schema}", pg_catalog`);
    return {
      async all(sql, values = []) {
        let ordinal = 0;
        return (
          await client.query(
            sql.replace(/\?/g, () => `$${++ordinal}`),
            [...values],
          )
        ).rows;
      },
      async exec(sql) {
        await client.query(sql);
      },
      async close() {
        client.release();
      },
    };
  };
  const q = await connect();
  try {
    await work({
      q,
      connect,
      open: () =>
        PlatformStore.postgres({ connectionString, schema }, verifier),
    });
  } finally {
    await q.close();
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
}

async function prior(q: TestQuery, version: 9 | 10 | 11) {
  await q.exec(version === 11 ? v11Sql : version === 10 ? v10Sql : v9Sql);
  await q.exec(
    "CREATE TABLE platform_schema_version (version BIGINT PRIMARY KEY CHECK(version>0),schema_sha256 TEXT NOT NULL)",
  );
  await q.all("INSERT INTO platform_schema_version VALUES(?,?)", [
    version,
    version === 11 ? v11Hash : version === 10 ? v10Hash : v9Hash,
  ]);
}
async function insert(q: TestQuery, table: string, row: Row) {
  const keys = Object.keys(row);
  await q.all(
    `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
    Object.values(row),
  );
}
async function seedLegacy(q: TestQuery) {
  await q.all("INSERT INTO tenants VALUES('tenant-a',?)", [now]);
  await q.all(
    "INSERT INTO projects(tenant_id,project_id,kind,owner_principal_id,title,revision,created_at,updated_at) VALUES('tenant-a','project-a','project','alice','原项目',7,?,?)",
    [now, now],
  );
  await q.all(
    "INSERT INTO project_members(tenant_id,project_id,principal_id) VALUES('tenant-a','project-a','alice')",
  );
  await q.all(
    "INSERT INTO app_installations VALUES('tenant-a','example.notes','install_ui_original','active',?)",
    [now],
  );
  await q.all(
    "INSERT INTO app_instances VALUES('tenant-a','example.notes','instance-original','service',NULL,'authority-original',5,'active',?)",
    [now],
  );
  await q.all(
    "INSERT INTO app_installations VALUES('tenant-a','reader','builtin_reader_installation','active',?)",
    [now],
  );
  await q.all(
    "INSERT INTO app_instances VALUES('tenant-a','reader','builtin_reader_instance','service',NULL,'builtin-reader',2,'active',?)",
    [now],
  );
  await q.all(
    "INSERT INTO app_ui_packages VALUES('tenant-a','example.notes','1.0.0','alice','{}','store-original','artifact-original',3,?,12,?)",
    [hash, now],
  );
  await q.all(
    "INSERT INTO app_view_instances VALUES('tenant-a','view-original','alice','project-a','example.notes','1.0.0','{}',4,'open',?,?)",
    [now, now],
  );
  await q.all(
    "INSERT INTO content_entries VALUES('tenant-a','content-original','example.notes','instance-original','原件 opaque / id','project-a','note','原目录','版本 opaque / 7',?,'available',9,?,?,NULL)",
    [now, now, now],
  );
}
async function seedCognitive(q: TestQuery) {
  await insert(q, "cognitive_app_versions", {
    tenant_id: "tenant-a",
    app_id: "example.notes",
    version: "1.0.0",
    installation_id: "install_ui_original",
    definition_hash: hash,
    definition_json: "{}",
    installed_by_principal_id: "alice",
    installed_at: now,
  });
  for (const principal of ["alice", "bob"]) {
    await insert(q, "cognitive_app_grants", {
      tenant_id: "tenant-a",
      principal_id: principal,
      app_id: "example.notes",
      version: "1.0.0",
      state: "active",
      revision: 1,
      consented_at: now,
      updated_at: now,
    });
  }
  await q.all(
    "INSERT INTO cognitive_app_authorities VALUES('tenant-a','example.notes','instance-original','service-original','data-original')",
  );
  for (const principal of ["alice", "bob"])
    await insert(q, "cognitive_app_connections", {
      tenant_id: "tenant-a",
      connection_id: `connection-${principal}`,
      owner_principal_id: principal,
      app_id: "example.notes",
      instance_id: "instance-original",
      service_id: "service-original",
      data_authority_id: "data-original",
      host_binding_id: `opaque-${principal}`,
      state: "active",
      revision: 1,
      created_at: now,
      updated_at: now,
    });
}
function command(commandId: string, overrides: Row = {}): Row {
  return {
    tenant_id: "tenant-a",
    command_id: commandId,
    app_id: "example.notes",
    version: "1.0.0",
    definition_hash: hash,
    instance_id: "instance-original",
    service_id: "service-original",
    data_authority_id: "data-original",
    connection_id: "connection-alice",
    connection_revision: 1,
    grant_principal_id: "alice",
    grant_revision: 1,
    project_id: "project-a",
    operation_id: "notes.create",
    operation_scope: "project",
    effect: "write",
    actor_kind: "human",
    actor_principal_id: "alice",
    actor_actant_id: "human-alice",
    initiating_human_actant_id: "human-alice",
    source_kind: "human",
    runtime_input_id: null,
    runtime_session_id: null,
    runtime_schedule_id: null,
    runtime_task_run_event_id: null,
    request_hash: hash,
    resources_json: "[]",
    revision: 1,
    state: "admitted",
    receipt_ref: null,
    receipt_hash: null,
    receipt_summary_json: null,
    committed_at: null,
    projection_state: "none",
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}
async function snapshot(q: TestQuery) {
  const result: Array<[string, Row[]]> = [];
  for (const table of legacyTables)
    result.push([table, await q.all(`SELECT * FROM ${table} ORDER BY 1,2`)]);
  return result;
}
async function current(h: Harness) {
  const store = await h.open();
  await store.close();
  await seedLegacy(h.q);
  await seedCognitive(h.q);
}

test("cognitive migration fixtures freeze exact v10 and v9 identities", () => {
  assert.equal(schemaHash(v11Sql), v11Hash);
  assert.equal(schemaHash(v10Sql), v10Hash);
  assert.equal(schemaHash(v9Sql), v9Hash);
  assert.notEqual(v10Sql, platformSchemaSql);
  assert.notEqual(schemaHash(platformSchemaSql), v10Hash);
});

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.MORPHZ_TEST_POSTGRES_URL,
  };
  test(
    `cognitive ${backend} fresh initialization is v12 and concurrent-safe`,
    options,
    async () => {
      await isolated(backend, async (h) => {
        const stores = await Promise.all([h.open(), h.open()]);
        for (const store of stores) await store.close();
        const rows = await h.q.all(
          "SELECT version,schema_sha256 FROM platform_schema_version",
        );
        assert.equal(rows.length, 1);
        assert.equal(Number(rows[0]!.version), 12);
        assert.equal(rows[0]!.schema_sha256, schemaHash(platformSchemaSql));
        for (const table of cognitiveTables)
          assert.equal((await h.q.all(`SELECT * FROM ${table}`)).length, 0);
      });
    },
  );
  for (const version of [9, 10] as const)
    test(
      `cognitive ${backend} v${version} upgrades to v12 preserving exact originals and reopens`,
      options,
      async () => {
        await isolated(backend, async (h) => {
          await prior(h.q, version);
          await seedLegacy(h.q);
          if (version === 10) {
            await h.q.all(
              "INSERT INTO profile_avatar_heads VALUES('tenant-a','human','alice',1)",
            );
            await h.q.all(
              "INSERT INTO profile_avatar_versions(tenant_id,subject_kind,subject_id,revision,changed_by_principal_id,changed_by_actant_id,changed_at) VALUES('tenant-a','human','alice',1,'alice','human-alice',?)",
              [now],
            );
          }
          const avatars =
            version === 10
              ? await h.q.all("SELECT * FROM profile_avatar_versions")
              : [];
          const before = await snapshot(h.q);
          for (let attempt = 0; attempt < 2; attempt++) {
            const stores = await Promise.all([h.open(), h.open()]);
            for (const store of stores) await store.close();
            assert.deepEqual(await snapshot(h.q), before);
            const rows = await h.q.all(
              "SELECT version,schema_sha256 FROM platform_schema_version",
            );
            assert.equal(Number(rows[0]!.version), 12);
            assert.equal(rows[0]!.schema_sha256, schemaHash(platformSchemaSql));
            assert.deepEqual(
              await h.q.all("SELECT * FROM profile_avatar_versions"),
              avatars,
            );
          }
          await seedCognitive(h.q);
          await insert(h.q, "cognitive_app_commands", command("after-upgrade"));
        });
      },
    );
  test(
    `cognitive ${backend} exact v11 upgrades personal registrations from facts only and reopens`,
    options,
    async () =>
      isolated(backend, async (h) => {
        await prior(h.q, 11);
        await seedLegacy(h.q);
        await seedCognitive(h.q);
        await h.q.all(
          "UPDATE cognitive_app_grants SET state='disabled' WHERE principal_id='bob'",
        );
        const before = await snapshot(h.q);
        const grants = await h.q.all(
          "SELECT * FROM cognitive_app_grants ORDER BY principal_id",
        );
        const originalUi = await h.q.all("SELECT * FROM app_ui_packages");
        for (let attempt = 0; attempt < 2; attempt++) {
          const stores = await Promise.all([h.open(), h.open()]);
          for (const store of stores) await store.close();
          assert.deepEqual(await snapshot(h.q), before);
          assert.deepEqual(
            await h.q.all(
              "SELECT * FROM cognitive_app_grants ORDER BY principal_id",
            ),
            grants,
          );
          assert.deepEqual(
            await h.q.all("SELECT * FROM app_ui_packages"),
            originalUi,
          );
          const registered = await h.q.all(
            "SELECT principal_id,app_id,version,definition_hash,registered_at FROM cognitive_app_registrations ORDER BY principal_id",
          );
          assert.deepEqual(
            registered.map((r) => ({ ...r })),
            ["alice", "bob"].map((principal_id) => ({
              principal_id,
              app_id: "example.notes",
              version: "1.0.0",
              definition_hash: hash,
              registered_at: now,
            })),
          );
          assert.equal(
            Number(
              (await h.q.all("SELECT version FROM platform_schema_version"))[0]!
                .version,
            ),
            12,
          );
        }
      }),
  );
  test(
    `cognitive ${backend} v11 registration DDL conflict rolls back facts and marker`,
    options,
    async () =>
      isolated(backend, async (h) => {
        await prior(h.q, 11);
        await seedLegacy(h.q);
        await seedCognitive(h.q);
        const before = await snapshot(h.q);
        await h.q.exec(
          "CREATE TABLE cognitive_app_registrations (fixture_failure TEXT)",
        );
        await assert.rejects(h.open());
        assert.deepEqual(await snapshot(h.q), before);
        assert.deepEqual(
          (
            await h.q.all(
              "SELECT version,schema_sha256 FROM platform_schema_version",
            )
          ).map((r) => ({ ...r })),
          [
            {
              version: backend === "postgres" ? "11" : 11,
              schema_sha256: v11Hash,
            },
          ],
        );
        const indices = await h.q.all(
          backend === "sqlite"
            ? "SELECT name FROM sqlite_schema WHERE type='index' AND name='cognitive_app_registrations_by_version'"
            : "SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND indexname='cognitive_app_registrations_by_version'",
        );
        assert.equal(indices.length, 0);
      }),
  );
  test(
    `cognitive ${backend} v11 mid-DDL failure leaves no new registration table`,
    options,
    async () =>
      isolated(backend, async (h) => {
        await prior(h.q, 11);
        await seedLegacy(h.q);
        await seedCognitive(h.q);
        const before = await snapshot(h.q);
        await h.q.exec(
          "CREATE INDEX cognitive_app_registrations_by_version ON tenants(tenant_id)",
        );
        await assert.rejects(h.open());
        assert.deepEqual(await snapshot(h.q), before);
        await assert.rejects(
          h.q.all("SELECT * FROM cognitive_app_registrations"),
        );
        assert.equal(
          Number(
            (await h.q.all("SELECT version FROM platform_schema_version"))[0]!
              .version,
          ),
          11,
        );
        assert.equal(
          (
            await h.q.all("SELECT schema_sha256 FROM platform_schema_version")
          )[0]!.schema_sha256,
          v11Hash,
        );
      }),
  );
  test(
    `cognitive ${backend} forged v11 marker refuses registration backfill`,
    options,
    async () =>
      isolated(backend, async (h) => {
        await prior(h.q, 11);
        await seedLegacy(h.q);
        await seedCognitive(h.q);
        const before = await snapshot(h.q);
        await h.q.all("UPDATE platform_schema_version SET schema_sha256=?", [
          hash,
        ]);
        await assert.rejects(
          h.open(),
          (error: unknown) =>
            error instanceof PlatformStorageError && error.code === "conflict",
        );
        assert.deepEqual(await snapshot(h.q), before);
        await assert.rejects(
          h.q.all("SELECT * FROM cognitive_app_registrations"),
        );
        assert.equal(
          Number(
            (await h.q.all("SELECT version FROM platform_schema_version"))[0]!
              .version,
          ),
          11,
        );
        assert.equal(
          (
            await h.q.all("SELECT schema_sha256 FROM platform_schema_version")
          )[0]!.schema_sha256,
          hash,
        );
      }),
  );
  test(
    `cognitive ${backend} rejects a forged v10 hash without changing old records`,
    options,
    async () => {
      await isolated(backend, async (h) => {
        await prior(h.q, 10);
        await seedLegacy(h.q);
        const before = await snapshot(h.q);
        await h.q.all("UPDATE platform_schema_version SET schema_sha256=?", [
          hash,
        ]);
        await assert.rejects(
          h.open(),
          (error: unknown) =>
            error instanceof PlatformStorageError && error.code === "conflict",
        );
        assert.deepEqual(await snapshot(h.q), before);
        const rows = await h.q.all(
          "SELECT version,schema_sha256 FROM platform_schema_version",
        );
        assert.equal(Number(rows[0]!.version), 10);
        assert.equal(rows[0]!.schema_sha256, hash);
      });
    },
  );
  test(
    `cognitive ${backend} rejects future markers forged v12 hashes and interrupted schemas`,
    options,
    async () => {
      await isolated(backend, async (h) => {
        const store = await h.open();
        await store.close();
        const conflict = (error: unknown) =>
          error instanceof PlatformStorageError && error.code === "conflict";
        await h.q.all("UPDATE platform_schema_version SET version=13");
        await assert.rejects(h.open(), conflict);
        assert.equal(
          Number(
            (await h.q.all("SELECT version FROM platform_schema_version"))[0]!
              .version,
          ),
          13,
        );
        await h.q.all(
          "UPDATE platform_schema_version SET version=12,schema_sha256=?",
          [hash],
        );
        await assert.rejects(h.open(), conflict);
        assert.equal(
          (
            await h.q.all("SELECT schema_sha256 FROM platform_schema_version")
          )[0]!.schema_sha256,
          hash,
        );
        await h.q.all("UPDATE platform_schema_version SET schema_sha256=?", [
          schemaHash(platformSchemaSql),
        ]);
        await h.q.exec("DROP TABLE cognitive_app_view_bindings");
        await assert.rejects(h.open(), conflict);
        await assert.rejects(
          h.q.all("SELECT * FROM cognitive_app_view_bindings"),
        );
        assert.equal(
          Number(
            (await h.q.all("SELECT version FROM platform_schema_version"))[0]!
              .version,
          ),
          12,
        );
      });
    },
  );
  for (const version of [9, 10] as const)
    test(
      `cognitive ${backend} v${version} failed DDL rolls back migration and old marker`,
      options,
      async () => {
        await isolated(backend, async (h) => {
          await prior(h.q, version);
          await seedLegacy(h.q);
          const before = await snapshot(h.q);
          await h.q.exec(
            "CREATE TABLE cognitive_app_connections (fixture_failure TEXT)",
          );
          await assert.rejects(h.open());
          assert.deepEqual(await snapshot(h.q), before);
          const rows = await h.q.all(
            "SELECT version,schema_sha256 FROM platform_schema_version",
          );
          assert.equal(Number(rows[0]!.version), version);
          assert.equal(
            rows[0]!.schema_sha256,
            version === 10 ? v10Hash : v9Hash,
          );
          await assert.rejects(h.q.all("SELECT * FROM cognitive_app_versions"));
          assert.equal(
            (
              await h.q.all(
                backend === "sqlite"
                  ? "SELECT name FROM sqlite_master WHERE type='index' AND name='app_installations_exact_identity'"
                  : "SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND indexname='app_installations_exact_identity'",
              )
            ).length,
            0,
          );
          if (version === 9)
            await assert.rejects(h.q.all("SELECT * FROM profile_avatar_heads"));
        });
      },
    );
  test(
    `cognitive ${backend} exact installation authority view and tenant FKs reject mismatches`,
    options,
    async () => {
      await isolated(backend, async (h) => {
        await current(h);
        await assert.rejects(
          insert(h.q, "cognitive_app_versions", {
            tenant_id: "tenant-a",
            app_id: "example.notes",
            version: "1.0.0",
            installation_id: "install_ui_original",
            definition_hash: "b".repeat(64),
            definition_json: "{}",
            installed_by_principal_id: "alice",
            installed_at: now,
          }),
        );
        await assert.rejects(
          insert(h.q, "cognitive_app_versions", {
            tenant_id: "tenant-a",
            app_id: "example.notes",
            version: "2.0.0",
            installation_id: "different-install",
            definition_hash: hash,
            definition_json: "{}",
            installed_by_principal_id: "alice",
            installed_at: now,
          }),
        );
        await insert(h.q, "cognitive_app_versions", {
          tenant_id: "tenant-a",
          app_id: "example.notes",
          version: "2.0.0",
          installation_id: "install_ui_original",
          definition_hash: hash,
          definition_json: "{}",
          installed_by_principal_id: "alice",
          installed_at: now,
        });
        await h.q.all(
          "INSERT INTO cognitive_app_grants VALUES('tenant-a','alice','example.notes','2.0.0','active',1,?,?)",
          [now, now],
        );
        await h.q.all(
          "INSERT INTO app_instances VALUES('tenant-a','example.notes','instance-other','service',NULL,'authority-other',1,'active',?)",
          [now],
        );
        await assert.rejects(
          h.q.all(
            "INSERT INTO cognitive_app_authorities VALUES('tenant-a','example.notes','instance-other','service-original','data-original')",
          ),
        );
        const binding: Row = {
          tenant_id: "tenant-a",
          view_id: "view-original",
          owner_principal_id: "alice",
          project_id: "project-a",
          app_id: "example.notes",
          version: "1.0.0",
          instance_id: "instance-original",
          connection_id: "connection-alice",
          revision: 1,
          created_at: now,
          updated_at: now,
        };
        for (const mismatch of [
          { owner_principal_id: "bob", connection_id: "connection-bob" },
          { project_id: "different-project" },
          { version: "2.0.0" },
          { instance_id: "different-instance" },
          { tenant_id: "tenant-b" },
        ] as Row[])
          await assert.rejects(
            insert(h.q, "cognitive_app_view_bindings", {
              ...binding,
              ...mismatch,
            }),
          );
        await insert(h.q, "cognitive_app_view_bindings", binding);
        for (const mismatch of [
          { definition_hash: "b".repeat(64) },
          { grant_principal_id: "bob" },
          { connection_id: "connection-bob" },
          { service_id: "other-service" },
          { data_authority_id: "other-data" },
          { tenant_id: "tenant-b" },
          { project_id: "different-project" },
        ] as Row[])
          await assert.rejects(
            insert(h.q, "cognitive_app_commands", command("bad-fk", mismatch)),
          );
        await insert(h.q, "cognitive_app_commands", command("valid-fk"));
        await assert.rejects(
          h.q.all(
            "DELETE FROM cognitive_app_connections WHERE connection_id='connection-alice'",
          ),
        );
        await assert.rejects(
          h.q.all(
            "DELETE FROM cognitive_app_grants WHERE principal_id='alice'",
          ),
        );
      });
    },
  );
  test(
    `cognitive ${backend} typed source keeps task-run even with source input`,
    options,
    async () => {
      await isolated(backend, async (h) => {
        await current(h);
        await insert(h.q, "cognitive_app_commands", command("human"));
        await insert(
          h.q,
          "cognitive_app_commands",
          command("input", {
            actor_kind: "agent",
            actor_actant_id: "agent",
            source_kind: "input",
            runtime_input_id: "input-a",
          }),
        );
        const scheduled: Row = {
          actor_kind: "agent",
          actor_actant_id: "agent",
          source_kind: "task-run",
          runtime_session_id: "session-a",
          runtime_schedule_id: "schedule-a",
          runtime_task_run_event_id: "event-a",
        };
        await insert(
          h.q,
          "cognitive_app_commands",
          command("scheduled-no-input", scheduled),
        );
        await insert(
          h.q,
          "cognitive_app_commands",
          command("scheduled-with-input", {
            ...scheduled,
            runtime_input_id: "input-a",
          }),
        );
        for (const invalid of [
          { runtime_input_id: "input-a" },
          { actor_actant_id: "not-human" },
          { initiating_human_actant_id: null },
          { actor_kind: "agent", source_kind: "input" },
          { ...scheduled, runtime_schedule_id: null },
          { ...scheduled, runtime_task_run_event_id: null },
          { ...scheduled, source_kind: "input", runtime_input_id: "input-a" },
        ] as Row[])
          await assert.rejects(
            insert(
              h.q,
              "cognitive_app_commands",
              command("bad-source", invalid),
            ),
          );
      });
    },
  );
  test(
    `cognitive ${backend} terminal evidence and catalog status are independent and constrained`,
    options,
    async () => {
      await isolated(backend, async (h) => {
        await current(h);
        const committed: Row = {
          state: "committed",
          receipt_ref: "receipt-a",
          receipt_hash: hash,
          committed_at: now,
          receipt_summary_json: "[]",
          projection_state: "pending",
        };
        await insert(
          h.q,
          "cognitive_app_commands",
          command("committed", committed),
        );
        await insert(
          h.q,
          "cognitive_app_commands",
          command("rejected", {
            state: "rejected",
            receipt_ref: "receipt-rejected",
            receipt_hash: hash,
          }),
        );
        for (const invalid of [
          { state: "committed" },
          { ...committed, committed_at: null },
          { ...committed, receipt_summary_json: null },
          { ...committed, receipt_hash: null },
          { state: "unknown", projection_state: "projected" },
          {
            state: "unknown",
            receipt_ref: "pretend-rejection",
            receipt_hash: hash,
          },
          { state: "rejected" },
          {
            state: "cancelled",
            receipt_ref: "not-evidence",
            receipt_hash: hash,
          },
          { committed_at: now },
          { effect: "read" },
          { operation_scope: "unbounded" },
          { resources_json: "x".repeat(32769) },
        ] as Row[])
          await assert.rejects(
            insert(
              h.q,
              "cognitive_app_commands",
              command("bad-terminal", invalid),
            ),
          );
        await h.q.all(
          "UPDATE cognitive_app_commands SET projection_state='projected',revision=revision+1 WHERE command_id='committed'",
        );
        assert.equal(
          (
            await h.q.all(
              "SELECT state FROM cognitive_app_commands WHERE command_id='committed'",
            )
          )[0]!.state,
          "committed",
        );
      });
    },
  );
  test(
    `cognitive ${backend} revision snapshots survive revocation and CAS has one winner`,
    options,
    async () => {
      await isolated(backend, async (h) => {
        await current(h);
        await insert(h.q, "cognitive_app_commands", command("pending"));
        const second = await h.connect();
        try {
          const changed = await Promise.all(
            [h.q, second].map((q) =>
              q.all(
                "UPDATE cognitive_app_connections SET state='disabled',revision=revision+1 WHERE tenant_id='tenant-a' AND connection_id='connection-alice' AND revision=1 RETURNING revision",
              ),
            ),
          );
          assert.equal(changed.flat().length, 1);
        } finally {
          await second.close();
        }
        await h.q.all(
          "UPDATE cognitive_app_grants SET state='disabled',revision=revision+1 WHERE principal_id='alice'",
        );
        const rows = await h.q.all(
          "SELECT connection_revision,grant_revision,state FROM cognitive_app_commands WHERE command_id='pending'",
        );
        assert.equal(Number(rows[0]!.connection_revision), 1);
        assert.equal(Number(rows[0]!.grant_revision), 1);
        assert.equal(rows[0]!.state, "admitted");
      });
    },
  );
}
