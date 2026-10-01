import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { scriptStudioSchemaSql } from "../packages/script-studio/src/schema.js";
import { ScriptStudioStore } from "../packages/script-studio/src/store.js";
import { schemaHash } from "../packages/storage/src/sql.js";
import { emptyScriptDraft } from "../packages/core/src/script-studio.js";

const taskRunColumn =
  "  task_run_event_id TEXT CHECK (task_run_event_id IS NULL OR length(task_run_event_id) BETWEEN 1 AND 100),\n";
const reportSql = scriptStudioSchemaSql.slice(
  scriptStudioSchemaSql.indexOf("-- Workflow reports"),
  scriptStudioSchemaSql.indexOf("CREATE TABLE script_outbox"),
);
const versionFiveSql =
  scriptStudioSchemaSql
    .slice(0, scriptStudioSchemaSql.indexOf("-- Bounded editor reads:"))
    .trimEnd() + "\n";
const versionFourSql = versionFiveSql.replace(reportSql, "");
const versionFourHash =
  "0abba0b4f79bf068515fb9761cf5de6eff78cacb53d19fd95658f906e41f2a7f";
const priorSql = versionFourSql.replace(taskRunColumn, "");
const priorHash = schemaHash(priorSql);
const addedIndexes = [
  "CREATE INDEX candidates_by_input ON script_candidates(tenant_id, production_id, input_id, created_at, candidate_id);",
  "CREATE INDEX reviews_by_input ON script_reviews(tenant_id, input_id, created_at, review_id);",
] as const;
const receiptIndex =
  "CREATE INDEX script_receipts_by_input ON script_command_receipts(tenant_id, input_id, committed_at, command_id);";
const versionThreeSql = versionFourSql
  .replace(receiptIndex, "")
  .replace("  command_id TEXT,\n", "");
const versionTwoSql = addedIndexes.reduce(
  (sql, statement) => sql.replace(statement, ""),
  versionThreeSql,
);
const versionTwoHash =
  "f1bcec4486f3077839b135132b52084683e7ea16f6729232b827f09cfd3cb56c";
const versionThreeHash =
  "94960ac44ec24b0153d382afc42cb67d3ff32825383986ecbd7a745b2c356427";

for (const backend of ["sqlite", "postgres"] as const) {
  for (const priorVersion of [4, 5] as const) {
    test(
      `${backend} 剧本 v${priorVersion} 加入编辑器读取索引后保留实际领域原稿和命令回执`,
      { skip: backend === "postgres" && !process.env.MORPHZ_TEST_POSTGRES_URL },
      async () => {
        assert.equal(schemaHash(versionFourSql), versionFourHash);
        const directory = mkdtempSync(
          join(tmpdir(), "morphz-script-v4-upgrade-"),
        );
        const filename = join(directory, "script.sqlite");
        const schema = `script_v4_${randomUUID().replaceAll("-", "")}`;
        const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL;
        const admin =
          backend === "postgres" ? new Pool({ connectionString }) : null;
        const identity = {
          tenantId: "tenant-one",
          principalId: "human-one",
          actantId: "human-one",
          kind: "human" as const,
          runtimeInputId: null,
        };
        const authority = {
          async authorizeCreate() {
            return identity;
          },
          async authorizeObject() {
            return {
              ...identity,
              projectId: "project-one",
              objectKind: "script",
            };
          },
        };
        const open = () =>
          backend === "sqlite"
            ? ScriptStudioStore.sqlite(filename, authority)
            : ScriptStudioStore.postgres({
                connectionString: connectionString!,
                schema,
                authority,
              });
        let store: ScriptStudioStore | undefined;
        try {
          if (admin) await admin.query(`CREATE SCHEMA "${schema}"`);
          store = await open();
          const created = await store.createProduction({
            credential: "synthetic-human",
            commandId: "create-one",
            productionId: "production-one",
            requestedProjectId: "project-one",
            title: "原有剧本",
          });
          await store.markDirectoryProjected(created.tenantId, created.eventId);
          await store.createItem({
            credential: "synthetic-human",
            commandId: "item-one",
            productionId: created.productionId,
            itemId: "episode-one",
            expectedActivityRevision: 1,
            kind: "episode",
            draft: {
              ...emptyScriptDraft("第一集"),
              sources: [],
              text: "升级必须保留的实际原稿。",
            },
          });
          const before = await store.readProduction({
            credential: "synthetic-human",
            productionId: created.productionId,
          });
          await store.close();
          store = undefined;
          // This fixture reconstructs the exact installed prior schema, not a
          // workspace snapshot or a production downgrade operation.
          if (admin) {
            for (const name of [
              "script_editor_items",
              "script_editor_candidates",
              "script_editor_candidate_versions",
              "script_editor_reviews",
              "script_editor_exports",
            ])
              await admin.query(`DROP INDEX "${schema}"."${name}"`);
            if (priorVersion === 4)
              await admin.query(`DROP TABLE "${schema}".script_check_reports`);
            await admin.query(
              `UPDATE "${schema}".script_schema_version SET version=$1,schema_sha256=$2`,
              [
                priorVersion,
                schemaHash(
                  priorVersion === 4 ? versionFourSql : versionFiveSql,
                ),
              ],
            );
          } else {
            const db = new DatabaseSync(filename);
            try {
              for (const name of [
                "script_editor_items",
                "script_editor_candidates",
                "script_editor_candidate_versions",
                "script_editor_reviews",
                "script_editor_exports",
              ])
                db.exec(`DROP INDEX ${name}`);
              if (priorVersion === 4)
                db.exec("DROP TABLE script_check_reports");
              db.prepare(
                "UPDATE script_schema_version SET version=?,schema_sha256=?",
              ).run(
                priorVersion,
                schemaHash(
                  priorVersion === 4 ? versionFourSql : versionFiveSql,
                ),
              );
            } finally {
              db.close();
            }
          }
          for (let attempt = 0; attempt < 2; attempt++) {
            store = await open();
            assert.deepEqual(
              await store.readProduction({
                credential: "synthetic-human",
                productionId: created.productionId,
              }),
              before,
            );
            await store.close();
            store = undefined;
          }
          if (admin) {
            assert.equal(
              Number(
                (
                  await admin.query(
                    `SELECT version FROM "${schema}".script_schema_version`,
                  )
                ).rows[0].version,
              ),
              6,
            );
            assert.equal(
              Number(
                (
                  await admin.query(
                    `SELECT COUNT(*) AS total FROM "${schema}".script_check_reports`,
                  )
                ).rows[0].total,
              ),
              0,
            );
            assert.equal(
              Number(
                (
                  await admin.query(
                    `SELECT COUNT(*) AS total FROM "${schema}".script_command_receipts`,
                  )
                ).rows[0].total,
              ),
              2,
            );
          } else {
            const db = new DatabaseSync(filename, { readOnly: true });
            try {
              assert.equal(
                db.prepare("SELECT version FROM script_schema_version").get()
                  ?.version,
                6,
              );
              assert.equal(
                db
                  .prepare("SELECT COUNT(*) AS total FROM script_check_reports")
                  .get()?.total,
                0,
              );
              assert.equal(
                db
                  .prepare(
                    "SELECT COUNT(*) AS total FROM script_command_receipts",
                  )
                  .get()?.total,
                2,
              );
            } finally {
              db.close();
            }
          }
        } finally {
          if (store) await store.close();
          if (admin) {
            await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
            await admin.end();
          }
          rmSync(directory, { recursive: true, force: true });
        }
      },
    );
  }
}

test("SQLite 剧本私库 v3 补交付索引与审阅命令来源", async () => {
  assert.equal(schemaHash(versionThreeSql), versionThreeHash);
  const directory = mkdtempSync(join(tmpdir(), "morphz-script-v3-upgrade-"));
  const filename = join(directory, "script.sqlite");
  try {
    const db = new DatabaseSync(filename);
    db.exec(
      "CREATE TABLE script_schema_version(version BIGINT PRIMARY KEY CHECK(version > 0), schema_sha256 TEXT NOT NULL)",
    );
    db.exec(versionThreeSql);
    db.prepare(
      "INSERT INTO script_schema_version(version,schema_sha256) VALUES(3,?)",
    ).run(versionThreeHash);
    db.prepare(
      "INSERT INTO script_command_receipts(tenant_id,command_id,request_hash,input_id,operation,result_object_id,result_version_ref,committed_at) VALUES('tenant-one','kept-command','kept-hash','input-one','create-item','item-one','1','2026-09-25T00:00:00.000Z')",
    ).run();
    db.close();
    const studio = await ScriptStudioStore.sqlite(filename);
    await studio.close();
    const upgraded = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.equal(
        upgraded.prepare("SELECT version FROM script_schema_version").get()
          ?.version,
        6,
      );
      assert.equal(
        upgraded.prepare("SELECT command_id FROM script_command_receipts").get()
          ?.command_id,
        "kept-command",
      );
      assert.ok(
        upgraded
          .prepare("PRAGMA table_info(script_reviews)")
          .all()
          .some((column) => column.name === "command_id"),
      );
      assert.ok(
        upgraded
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='script_receipts_by_input'",
          )
          .get(),
      );
    } finally {
      upgraded.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "PostgreSQL 剧本私库 v3 原子补交付索引与审阅命令来源",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    assert.equal(schemaHash(versionThreeSql), versionThreeHash);
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const schema = `script_v3_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const client = await admin.connect();
      try {
        await client.query(`SET search_path TO "${schema}", pg_catalog`);
        await client.query(
          "CREATE TABLE script_schema_version(version BIGINT PRIMARY KEY CHECK(version > 0), schema_sha256 TEXT NOT NULL)",
        );
        await client.query(versionThreeSql);
        await client.query(
          "INSERT INTO script_schema_version(version,schema_sha256) VALUES(3,$1)",
          [versionThreeHash],
        );
        await client.query(
          "INSERT INTO script_command_receipts(tenant_id,command_id,request_hash,input_id,operation,result_object_id,result_version_ref,committed_at) VALUES('tenant-one','kept-command','kept-hash','input-one','create-item','item-one','1','2026-09-25T00:00:00.000Z')",
        );
      } finally {
        client.release();
      }
      const studio = await ScriptStudioStore.postgres({
        connectionString,
        schema,
      });
      await studio.close();
      const version = await admin.query(
        `SELECT version FROM "${schema}".script_schema_version`,
      );
      assert.equal(Number(version.rows[0]?.version), 6);
      const receipt = await admin.query(
        `SELECT command_id FROM "${schema}".script_command_receipts`,
      );
      assert.equal(receipt.rows[0]?.command_id, "kept-command");
      const column = await admin.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='script_reviews' AND column_name='command_id'",
        [schema],
      );
      assert.equal(column.rows[0]?.column_name, "command_id");
      const indexes = await admin.query(
        "SELECT indexname FROM pg_catalog.pg_indexes WHERE schemaname=$1 AND indexname='script_receipts_by_input'",
        [schema],
      );
      assert.equal(indexes.rows[0]?.indexname, "script_receipts_by_input");
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  },
);

test("SQLite 剧本私库 v2 升级领域结构，原回执和重复启动保持不变", async () => {
  assert.equal(schemaHash(versionTwoSql), versionTwoHash);
  const directory = mkdtempSync(join(tmpdir(), "morphz-script-v2-upgrade-"));
  const filename = join(directory, "script.sqlite");
  try {
    const db = new DatabaseSync(filename);
    db.exec(
      "CREATE TABLE script_schema_version(version BIGINT PRIMARY KEY CHECK(version > 0), schema_sha256 TEXT NOT NULL)",
    );
    db.exec(versionTwoSql);
    db.prepare(
      "INSERT INTO script_schema_version(version,schema_sha256) VALUES(2,?)",
    ).run(versionTwoHash);
    db.prepare(
      "INSERT INTO script_command_receipts(tenant_id,command_id,request_hash,input_id,operation,result_object_id,result_version_ref,committed_at) VALUES('tenant-one','kept-command','kept-hash','input-one','create-production','script-one','1','2026-09-25T00:00:00.000Z')",
    ).run();
    db.close();
    for (let attempt = 0; attempt < 2; attempt++) {
      const store = await ScriptStudioStore.sqlite(filename);
      await store.close();
    }
    const upgraded = new DatabaseSync(filename, { readOnly: true });
    try {
      const version = upgraded
        .prepare("SELECT version,schema_sha256 FROM script_schema_version")
        .get();
      assert.equal(version?.version, 6);
      assert.equal(version?.schema_sha256, schemaHash(scriptStudioSchemaSql));
      assert.deepEqual(
        upgraded
          .prepare("SELECT command_id,input_id FROM script_command_receipts")
          .all()
          .map((row) => ({ ...row })),
        [{ command_id: "kept-command", input_id: "input-one" }],
      );
      assert.deepEqual(
        upgraded
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('candidates_by_input','reviews_by_input','script_receipts_by_input') ORDER BY name",
          )
          .all()
          .map((row) => ({ ...row })),
        [
          { name: "candidates_by_input" },
          { name: "reviews_by_input" },
          { name: "script_receipts_by_input" },
        ],
      );
    } finally {
      upgraded.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite 剧本私库 v2 有其他结构损坏时拒绝升级且不写新索引", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-script-v2-damaged-"));
  const filename = join(directory, "script.sqlite");
  try {
    const db = new DatabaseSync(filename);
    db.exec(
      "CREATE TABLE script_schema_version(version BIGINT PRIMARY KEY CHECK(version > 0), schema_sha256 TEXT NOT NULL)",
    );
    db.exec(versionTwoSql);
    db.exec("DROP INDEX productions_by_owner");
    db.prepare(
      "INSERT INTO script_schema_version(version,schema_sha256) VALUES(2,?)",
    ).run(versionTwoHash);
    db.close();
    await assert.rejects(ScriptStudioStore.sqlite(filename), /索引缺失/);
    const unchanged = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.equal(
        unchanged.prepare("SELECT version FROM script_schema_version").get()
          ?.version,
        2,
      );
      assert.equal(
        unchanged
          .prepare(
            "SELECT count(*) AS count FROM sqlite_master WHERE type='index' AND name IN ('candidates_by_input','reviews_by_input')",
          )
          .get()?.count,
        0,
      );
    } finally {
      unchanged.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "PostgreSQL 剧本私库 v2 原子升级领域结构并保留原回执",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    assert.equal(schemaHash(versionTwoSql), versionTwoHash);
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const schema = `script_v2_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const client = await admin.connect();
      try {
        await client.query(`SET search_path TO "${schema}", pg_catalog`);
        await client.query(
          "CREATE TABLE script_schema_version(version BIGINT PRIMARY KEY CHECK(version > 0), schema_sha256 TEXT NOT NULL)",
        );
        await client.query(versionTwoSql);
        await client.query(
          "INSERT INTO script_schema_version(version,schema_sha256) VALUES(2,$1)",
          [versionTwoHash],
        );
        await client.query(
          "INSERT INTO script_command_receipts(tenant_id,command_id,request_hash,input_id,operation,result_object_id,result_version_ref,committed_at) VALUES('tenant-one','kept-command','kept-hash','input-one','create-production','script-one','1','2026-09-25T00:00:00.000Z')",
        );
      } finally {
        client.release();
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        const store = await ScriptStudioStore.postgres({
          connectionString,
          schema,
        });
        await store.close();
      }
      const version = await admin.query(
        `SELECT version,schema_sha256 FROM "${schema}".script_schema_version`,
      );
      assert.equal(Number(version.rows[0]?.version), 6);
      assert.equal(
        version.rows[0]?.schema_sha256,
        schemaHash(scriptStudioSchemaSql),
      );
      const receipt = await admin.query(
        `SELECT command_id,input_id FROM "${schema}".script_command_receipts`,
      );
      assert.deepEqual(receipt.rows, [
        { command_id: "kept-command", input_id: "input-one" },
      ]);
      const indexes = await admin.query(
        "SELECT indexname FROM pg_catalog.pg_indexes WHERE schemaname=$1 AND indexname IN ('candidates_by_input','reviews_by_input','script_receipts_by_input') ORDER BY indexname",
        [schema],
      );
      assert.deepEqual(indexes.rows, [
        { indexname: "candidates_by_input" },
        { indexname: "reviews_by_input" },
        { indexname: "script_receipts_by_input" },
      ]);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  },
);

function checkPriorSchema() {
  assert.notEqual(priorSql, scriptStudioSchemaSql);
  assert.notEqual(priorHash, schemaHash(scriptStudioSchemaSql));
}

test("SQLite 剧本私库结构不匹配时拒绝写入，保留原有回执", async () => {
  checkPriorSchema();
  const directory = mkdtempSync(
    join(tmpdir(), "morphz-script-source-upgrade-"),
  );
  const filename = join(directory, "script.sqlite");
  try {
    const db = new DatabaseSync(filename);
    db.exec(
      "CREATE TABLE script_schema_version(version BIGINT PRIMARY KEY CHECK(version > 0), schema_sha256 TEXT NOT NULL)",
    );
    db.exec(priorSql);
    db.prepare(
      "INSERT INTO script_schema_version(version,schema_sha256) VALUES(1,?)",
    ).run(priorHash);
    db.prepare(
      "INSERT INTO script_command_receipts(tenant_id,command_id,request_hash,input_id,operation,result_object_id,result_version_ref,committed_at) VALUES('tenant-one','old-command','old-hash','input-one','create-production','old-script','1','2026-09-25T00:00:00.000Z')",
    ).run();
    db.close();
    await assert.rejects(
      ScriptStudioStore.sqlite(filename),
      /结构与当前程序不一致/,
    );
    const reopened = new DatabaseSync(filename, { readOnly: true });
    try {
      const receipt = reopened
        .prepare(
          "SELECT input_id FROM script_command_receipts WHERE command_id='old-command'",
        )
        .get();
      assert.equal(receipt?.input_id, "input-one");
      assert.equal(
        reopened.prepare("SELECT version FROM script_schema_version").get()
          ?.version,
        1,
      );
    } finally {
      reopened.close();
    }
    await assert.rejects(
      ScriptStudioStore.sqlite(filename),
      /结构与当前程序不一致/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "PostgreSQL 剧本私库结构不匹配时拒绝写入",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    checkPriorSchema();
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const schema = `script_upgrade_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const client = await admin.connect();
      try {
        await client.query(`SET search_path TO "${schema}", pg_catalog`);
        await client.query(
          "CREATE TABLE script_schema_version(version BIGINT PRIMARY KEY CHECK(version > 0), schema_sha256 TEXT NOT NULL)",
        );
        await client.query(priorSql);
        await client.query(
          "INSERT INTO script_schema_version(version,schema_sha256) VALUES(1,$1)",
          [priorHash],
        );
        await client.query(
          "INSERT INTO script_command_receipts(tenant_id,command_id,request_hash,input_id,operation,result_object_id,result_version_ref,committed_at) VALUES('tenant-one','old-command','old-hash','input-one','create-production','old-script','1','2026-09-25T00:00:00.000Z')",
        );
      } finally {
        client.release();
      }
      await assert.rejects(
        ScriptStudioStore.postgres({
          connectionString,
          schema,
        }),
        /结构与当前程序不一致/,
      );
      const receipt = await admin.query(
        `SELECT input_id FROM "${schema}".script_command_receipts WHERE command_id='old-command'`,
      );
      assert.deepEqual(receipt.rows, [{ input_id: "input-one" }]);
      const version = await admin.query(
        `SELECT version FROM "${schema}".script_schema_version`,
      );
      assert.equal(Number(version.rows[0]?.version), 1);
      await assert.rejects(
        ScriptStudioStore.postgres({
          connectionString,
          schema,
        }),
        /结构与当前程序不一致/,
      );
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
