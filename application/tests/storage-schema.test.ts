import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import {
  postgresQuery,
  sqliteQuery,
  type SqlQuery,
} from "../packages/storage/src/sql.js";

const names = [
  "platform",
  "script-studio",
  "reader",
  "objects",
  "browser",
  "managed-artifact-store",
] as const;

for (const name of names) {
  const sql = readFileSync(
    new URL(`../docs/storage-model-v1/${name}.sql`, import.meta.url),
    "utf8",
  );
  test(`${name} 关系模型在 SQLite 上可建表且外键有效`, () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys=ON");
      db.exec(sql);
      assert.ok(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            )
            .get() as { n: number }
        ).n > 0,
      );
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      db.close();
    }
  });

  test(
    `${name} 关系模型在 PostgreSQL 独立 schema 上可建表`,
    { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
    async () => {
      const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
      const pool = new Pool({
        connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
      });
      const client = await pool.connect();
      try {
        await client.query(`CREATE SCHEMA "${schema}"`);
        await client.query("BEGIN");
        await client.query(`SET LOCAL search_path TO "${schema}", pg_catalog`);
        await client.query(sql);
        const { rows } = await client.query<{ n: string }>(
          "SELECT COUNT(*)::text AS n FROM pg_catalog.pg_tables WHERE schemaname=$1",
          [schema],
        );
        assert.ok(Number(rows[0]?.n) > 0);
        await client.query("ROLLBACK");
      } finally {
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        client.release();
        await pool.end();
      }
    },
  );
}

async function assertExternalReadingSurface(q: SqlQuery) {
  const addSource = async (sourceId: string, objectId: string) =>
    q.change(
      "INSERT INTO reading_sources(tenant_id,reading_source_id,source_app_id,source_instance_id,source_object_id,source_version_ref,source_locator_id,source_kind,title,format,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      [
        "tenant-a",
        sourceId,
        "morphz.objects",
        "objects-a",
        objectId,
        "v1",
        "shared-text-hash",
        "external_object",
        objectId,
        "markdown",
        "2026-09-25T00:00:00.000Z",
      ],
    );
  await addSource("source-1", "document-1");
  await addSource("source-2", "document-2");
  await q.change(
    "INSERT INTO book_sections(tenant_id,reading_source_id,section_id,ordinal,section_kind,title,character_count) VALUES(?,?,?,?,?,?,?)",
    ["tenant-a", "source-1", "section-1", 0, "native", "第一节", 6],
  );
  await q.change(
    "INSERT INTO reading_marks(tenant_id,mark_id,reading_source_id,principal_id,section_id,start_offset,end_offset,quote_text,kind,color,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [
      "tenant-a",
      "mark-1",
      "source-1",
      "human-a",
      "section-1",
      0,
      2,
      "选文",
      "highlight",
      "yellow",
      1,
      "2026-09-25T00:00:00.000Z",
      "2026-09-25T00:00:00.000Z",
    ],
  );
  const sources = await q.all<{
    source_object_id: string;
    source_locator_id: string;
  }>(
    "SELECT source_object_id,source_locator_id FROM reading_sources WHERE tenant_id=? ORDER BY source_object_id",
    ["tenant-a"],
  );
  assert.deepEqual(
    sources.map((source) => ({ ...source })),
    [
      { source_object_id: "document-1", source_locator_id: "shared-text-hash" },
      { source_object_id: "document-2", source_locator_id: "shared-text-hash" },
    ],
  );
  assert.equal((await q.all("SELECT * FROM books")).length, 0);
  assert.equal((await q.all("SELECT * FROM reading_marks")).length, 1);
}

test("Reader 可标注外部 Markdown 原件，但不复制为书籍；共享文本 hash 不合并原件", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(
      readFileSync(
        new URL("../docs/storage-model-v1/reader.sql", import.meta.url),
        "utf8",
      ),
    );
    await assertExternalReadingSurface(sqliteQuery(db));
    assert.throws(() =>
      db
        .prepare(
          "INSERT INTO reading_sources(tenant_id,reading_source_id,source_app_id,source_instance_id,source_object_id,source_version_ref,source_locator_id,source_kind,title,format,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          "tenant-a",
          "invalid",
          "morphz.reader",
          "reader-a",
          "book-1",
          "v1",
          "locator",
          "reader_book",
          "书",
          "epub",
          "2026-09-25T00:00:00.000Z",
        ),
    );
  } finally {
    db.close();
  }
});

test(
  "Reader 外部原件标注在 PostgreSQL 保持相同归属",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({
      connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
    });
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query("BEGIN");
      await client.query(`SET LOCAL search_path TO "${schema}", pg_catalog`);
      await client.query(
        readFileSync(
          new URL("../docs/storage-model-v1/reader.sql", import.meta.url),
          "utf8",
        ),
      );
      await assertExternalReadingSurface(postgresQuery(client));
      await client.query("ROLLBACK");
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      client.release();
      await pool.end();
    }
  },
);
