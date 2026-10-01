import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { Pool } from "pg";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import { localAccess } from "../packages/core/src/model.js";
import { readerParserIdentity } from "../packages/application/src/reader-parser-identity.js";
import {
  ReaderStore,
  type ReaderAuthorityVerifier,
} from "../packages/reader/src/store.js";
import { readerSchemaSql } from "../packages/reader/src/schema.js";
import { schemaHash, type SqlScalar } from "../packages/storage/src/sql.js";

const postgresUrl = process.env.MORPHZ_TEST_POSTGRES_URL;
const other = { principalId: "cache-other", actantId: "cache-other-actant" };
const sha = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

/** Observe actual Worker startup. Neither the parser nor its returned text is
 * mocked; a miss executes the real bounded Host extraction Worker. */
async function workerStarts<T>(work: () => Promise<T>) {
  const emit = Worker.prototype.emit;
  let starts = 0;
  Worker.prototype.emit = function (
    event: string | symbol,
    ...arguments_: unknown[]
  ) {
    if (event === "online" && this.threadName?.startsWith("morphz-reader-"))
      starts++;
    return Reflect.apply(emit, this, [event, ...arguments_]);
  };
  try {
    return { value: await work(), starts };
  } finally {
    Worker.prototype.emit = emit;
  }
}

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: 已上传原字节的 Reader 解析缓存跳过真实 Worker，独立新书与权限/旧标注不混用`,
    { skip: backend === "postgres" && !postgresUrl },
    async () => {
      const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
      const schemas = {
        platform: `cp_${suffix}`,
        objects: `co_${suffix}`,
        scriptStudio: `cs_${suffix}`,
        reader: `cr_${suffix}`,
        browser: `cb_${suffix}`,
      };
      const admin =
        backend === "postgres"
          ? new Pool({ connectionString: postgresUrl })
          : null;
      let h: Awaited<ReturnType<typeof agentDomainFixture>> | undefined;
      let db: DatabaseSync | undefined;
      try {
        if (admin)
          for (const schema of Object.values(schemas))
            await admin.query(`CREATE SCHEMA "${schema}"`);
        h = await agentDomainFixture({
          additionalHumans: [other],
          ...(admin
            ? {
                storage: {
                  platform: {
                    kind: "postgres" as const,
                    connectionString: postgresUrl!,
                    schema: schemas.platform,
                  },
                  applications: {
                    deploymentId: `cache_${suffix}`,
                    connectionStrings: {
                      objects: postgresUrl!,
                      scriptStudio: postgresUrl!,
                      reader: postgresUrl!,
                      browser: postgresUrl!,
                    },
                    schemas: {
                      objects: schemas.objects,
                      scriptStudio: schemas.scriptStudio,
                      reader: schemas.reader,
                      browser: schemas.browser,
                    },
                  },
                },
              }
            : {}),
        });
        if (!admin) db = new DatabaseSync(join(h.directory, "reader.sqlite"));
        const query = async (
          sql: string,
          values: SqlScalar[] = [],
        ): Promise<Record<string, unknown>[]> => {
          if (db)
            return db.prepare(sql).all(...values) as Record<string, unknown>[];
          let index = 0;
          return (
            await admin!.query(
              sql
                .replace(
                  /\b(reader_import_cache|reading_sources|book_revisions|book_sections|book_text_chunks|reader_book_events|reader_schema_version|marks_by_section_user)\b/g,
                  `"${schemas.reader}".$1`,
                )
                .replaceAll("?", () => `$${++index}`),
              values,
            )
          ).rows;
        };
        const bytes = Buffer.from(
          "# 第一章\n\n可核对的原文。\n\n第二段保留原文位置。",
          "utf8",
        );
        const commandId = randomUUID();
        const initial = {
          commandId,
          projectId: h.projectId,
          name: "伴读.md",
          bytes,
        };
        const importBook = (request = initial) =>
          h!.withHuman((actor) =>
            h!.domains.reader.service.import(actor, request),
          );
        const first = await workerStarts(() => importBook());
        assert.equal(first.starts, 1);
        const original = first.value;
        const parseKey = readerParserIdentity(initial.name);
        assert.notEqual(
          parseKey.parserVersion,
          readerParserIdentity("伴读.pdf").parserVersion,
        );
        const rows = await query("SELECT * FROM reader_import_cache");
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.parser_version, parseKey.parserVersion);
        assert.equal(rows[0]!.options_sha256, parseKey.optionsSha256);
        assert.equal(rows[0]!.sha256, sha(bytes));
        assert.equal(
          Object.keys(rows[0]!).some((key) => /body|text|html/.test(key)),
          false,
          "cache indexes provenance, never duplicates book bodies",
        );
        const overview = await h.withHuman((actor) =>
          h!.domains.reader.service.bookOverview(actor, original.entityId, 1),
        );
        const section = await h.withHuman((actor) =>
          h!.domains.reader.service.read(
            actor,
            original.entityId,
            1,
            overview.sections[0]!.id,
          ),
        );
        const start = section.text.indexOf("可核对");
        assert.ok(start >= 0);
        const location = {
          sourceId: section.sourceId,
          sectionId: section.id,
          start,
          end: start + 3,
        };
        const mark = await h.withHuman((actor) =>
          h!.domains.reader.service.command(actor, {
            commandId: randomUUID(),
            contentId: original.entityId,
            revision: 1,
            command: {
              action: "mark-add",
              artifactId: original.entityId,
              artifactRevision: 1,
              location,
              quote: "可核对",
              kind: "highlight",
              color: "yellow",
              note: "旧版理解",
            },
          }),
        );
        const second = await workerStarts(() =>
          importBook({ ...initial, commandId: randomUUID() }),
        );
        assert.equal(second.starts, 0);
        assert.notEqual(second.value.bookId, original.bookId);
        assert.notEqual(second.value.entityId, original.entityId);
        assert.notEqual(second.value.receiptId, original.receiptId);
        const state = await h.withHuman((actor) =>
          h!.domains.reader.service.state(actor, second.value.entityId, 1),
        );
        const secondMarks = await h.withHuman((actor) =>
          h!.domains.reader.service.marks(
            actor,
            second.value.entityId,
            1,
            false,
            0,
            50,
          ),
        );
        assert.deepEqual(secondMarks.marks, []);
        assert.equal(secondMarks.hasMore, false);
        assert.equal(state.position, null);
        const retry = await workerStarts(() => importBook());
        assert.equal(retry.starts, 0);
        assert.deepEqual(retry.value, original);
        const event = (
          await query("SELECT * FROM reader_book_events WHERE command_id=?", [
            commandId,
          ])
        )[0]!;
        const originalStore = Reflect.get(
          h.domains.reader.service,
          "reader",
        ) as ReaderStore;
        const newerParserKey = `${parseKey.parserVersion}:next-host`;
        const oldParserReplay = await h.withHuman((actor) =>
          originalStore.readImportResult({
            commit: {
              credential: actor.credential,
              commandId,
              projectId: initial.projectId,
              tenantId: String(event.tenant_id),
              principalId: String(event.principal_id),
              actantId: String(event.actant_id),
              runtimeInputId: null,
              runtimeTaskRunEventId: null,
            },
            sha256: sha(bytes),
            byteLength: bytes.length,
            format: parseKey.format,
            parserVersion: newerParserKey,
            optionsSha256: parseKey.optionsSha256,
          }),
        );
        assert.equal(
          oldParserReplay!.parserVersion,
          parseKey.parserVersion,
          "a later trusted Host fingerprint must replay the committed parser version",
        );
        assert.equal(oldParserReplay!.sections[0]!.text, section.text);
        assert.equal(
          (await query("SELECT * FROM reader_import_cache")).length,
          2,
        );
        await assert.rejects(
          importBook({ ...initial, name: "改名.md" }),
          /选项|不一致/,
        );
        await assert.rejects(
          importBook({ ...initial, bytes: Buffer.from("# 不同原文") }),
          /文件|不一致/,
        );
        const changed = await workerStarts(() =>
          importBook({
            ...initial,
            commandId: randomUUID(),
            bytes: Buffer.from("# 新原文\n\n不同版本。"),
          }),
        );
        assert.equal(
          changed.starts,
          1,
          "different original digest must run Worker",
        );
        const nameChanged = await workerStarts(() =>
          importBook({
            ...initial,
            commandId: randomUUID(),
            name: "另一本.md",
          }),
        );
        assert.equal(
          nameChanged.starts,
          1,
          "filename is an actual parsing option",
        );
        // Cache lookup must be owner-scoped even inside the same tenant.
        let otherProject = "";
        await h.domains.reader.authority.withSession(
          other,
          () => {},
          async (actor) => {
            otherProject = `other_${suffix}`;
            await h!.domains.work.service.createProject(actor, {
              commandId: randomUUID(),
              projectId: otherProject,
              title: "另一位读者",
            });
          },
        );
        const privateImport = await workerStarts(() =>
          h!.domains.reader.authority.withSession(
            other,
            () => {},
            (actor) =>
              h!.domains.reader.service.import(actor, {
                ...initial,
                commandId: randomUUID(),
                projectId: otherProject,
              }),
          ),
        );
        assert.equal(
          privateImport.starts,
          1,
          "same byte hash is not permission to read another owner's parsed source",
        );
        await assert.rejects(
          h.domains.reader.authority.withSession(
            other,
            () => {},
            (actor) =>
              h!.domains.reader.service.read(
                actor,
                original.entityId,
                1,
                section.id,
              ),
          ),
          /权限|访问|授权/,
        );
        await assert.rejects(
          h.domains.reader.service.import(
            { credential: "forged-cache-credential" },
            initial,
          ),
          /身份|权限|失效|不存在/,
        );
        const oldSourceId = String(rows[0]!.reading_source_id);
        // A later parser fingerprint does not invalidate the existing canonical
        // source/mark. Simulate an older trusted import fingerprint in immutable
        // private metadata only; all subsequent reads and import go via Host.
        // Changing the indexed fingerprint (not the original) must be a miss.
        await query(
          "UPDATE reader_import_cache SET parser_version='retired-test-parser' WHERE principal_id=? AND options_sha256=?",
          [localAccess.principalId, parseKey.optionsSha256],
        );
        const newParser = await workerStarts(() =>
          importBook({ ...initial, commandId: randomUUID() }),
        );
        assert.equal(
          newParser.starts,
          1,
          "cache with a different parser fingerprint cannot be reused",
        );
        const oldRead = await h.withHuman((actor) =>
          h!.domains.reader.service.read(
            actor,
            original.entityId,
            1,
            section.id,
          ),
        );
        assert.equal(oldRead.text, section.text);
        const oldMarks = await h.withHuman((actor) =>
          h!.domains.reader.service.marks(
            actor,
            original.entityId,
            1,
            false,
            0,
            50,
          ),
        );
        assert.equal(oldMarks.marks[0]!.id, mark.id);
        assert.deepEqual(oldMarks.marks[0]!.location, location);
        assert.equal(oldMarks.hasMore, false);
        // Restore provenance for exact replay; corruption of result digest must
        // reparse this upload, never hand damaged cached HTML to another book.
        await query(
          "UPDATE reader_import_cache SET parser_version=? WHERE reading_source_id=?",
          [parseKey.parserVersion, oldSourceId],
        );
        await query(
          "UPDATE reader_import_cache SET result_sha256=? WHERE principal_id=? AND options_sha256=?",
          ["0".repeat(64), localAccess.principalId, parseKey.optionsSha256],
        );
        const repaired = await workerStarts(() =>
          importBook({ ...initial, commandId: randomUUID() }),
        );
        assert.equal(repaired.starts, 1);
        const repairedOverview = await h.withHuman((actor) =>
          h!.domains.reader.service.bookOverview(
            actor,
            repaired.value.entityId,
            1,
          ),
        );
        assert.equal(
          (
            await h.withHuman((actor) =>
              h!.domains.reader.service.read(
                actor,
                repaired.value.entityId,
                1,
                repairedOverview.sections[0]!.id,
              ),
            )
          ).text,
          section.text,
        );
        await assert.rejects(
          importBook(),
          /摘要/,
          "exact committed retry must not silently rewrite damaged canonical provenance",
        );
        // A parse failure commits neither book receipt nor cache entry.
        const count = (await query("SELECT * FROM reader_import_cache")).length;
        await assert.rejects(
          importBook({
            ...initial,
            commandId: randomUUID(),
            name: "坏书.epub",
            bytes: Buffer.from("not an epub"),
          }),
          /EPUB|ZIP|格式|文件|解析/i,
        );
        assert.equal(
          (await query("SELECT * FROM reader_import_cache")).length,
          count,
        );
        // Force a real SQL failure at cache publication. It must roll back
        // source/chunks/book event in that transaction, not leave a success
        // receipt or index pointing at an incompletely persisted canonical book.
        if (db)
          await query(
            "CREATE TRIGGER fail_reader_cache BEFORE INSERT ON reader_import_cache BEGIN SELECT RAISE(ABORT,'test cache write failure'); END",
          );
        else {
          await admin!.query(
            `CREATE FUNCTION "${schemas.reader}".fail_reader_cache_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test cache write failure'; END $$`,
          );
          await admin!.query(
            `CREATE TRIGGER fail_reader_cache BEFORE INSERT ON "${schemas.reader}".reader_import_cache FOR EACH ROW EXECUTE FUNCTION "${schemas.reader}".fail_reader_cache_write()`,
          );
        }
        const rollbackRequest = {
          ...initial,
          commandId: randomUUID(),
          name: "事务失败.md",
          bytes: Buffer.from("# 原子写入\n\n不得发布半成品。"),
        };
        const sourceCount = (await query("SELECT * FROM reading_sources"))
          .length;
        const eventCount = (await query("SELECT * FROM reader_book_events"))
          .length;
        await assert.rejects(
          importBook(rollbackRequest),
          /test cache write failure/,
        );
        assert.equal(
          (await query("SELECT * FROM reader_import_cache")).length,
          count,
        );
        assert.equal(
          (await query("SELECT * FROM reading_sources")).length,
          sourceCount,
        );
        assert.equal(
          (await query("SELECT * FROM reader_book_events")).length,
          eventCount,
        );
        if (db) await query("DROP TRIGGER fail_reader_cache");
        else {
          await admin!.query(
            `DROP TRIGGER fail_reader_cache ON "${schemas.reader}".reader_import_cache`,
          );
          await admin!.query(
            `DROP FUNCTION "${schemas.reader}".fail_reader_cache_write()`,
          );
        }
        const rollbackRetry = await workerStarts(() =>
          importBook(rollbackRequest),
        );
        assert.equal(rollbackRetry.starts, 1);
        assert.equal(
          (
            await query("SELECT * FROM reader_book_events WHERE command_id=?", [
              rollbackRequest.commandId,
            ])
          ).length,
          1,
        );
        db?.close();
        db = undefined;
        await h.reopen();
        if (!admin) db = new DatabaseSync(join(h.directory, "reader.sqlite"));
        const cold = await workerStarts(() =>
          importBook({ ...initial, commandId: randomUUID() }),
        );
        assert.equal(
          cold.starts,
          0,
          "cache remains usable after a real Host/DB reopen",
        );
        const coldSource = (
          await query(
            "SELECT reading_source_id FROM reading_sources WHERE book_id=?",
            [cold.value.bookId],
          )
        )[0]!;
        await query(
          "UPDATE book_text_chunks SET body_text=replace(body_text,'可核对','伪核对') WHERE reading_source_id=?",
          [String(coldSource.reading_source_id)],
        );
        const damagedChunks = await workerStarts(() =>
          importBook({ ...initial, commandId: randomUUID() }),
        );
        assert.equal(
          damagedChunks.starts,
          1,
          "actual damaged canonical chunks must not pass the cached result digest",
        );
        const repairedText = await h.withHuman((actor) =>
          h!.domains.reader.service.read(
            actor,
            damagedChunks.value.entityId,
            1,
            section.id,
          ),
        );
        assert.equal(
          repairedText.text,
          section.text,
          "reparse uses this upload, not damaged source text",
        );
        assert.equal(
          (
            await h.withHuman((actor) =>
              h!.domains.reader.service.marks(
                actor,
                original.entityId,
                1,
                false,
                0,
                50,
              ),
            )
          ).marks[0]!.id,
          mark.id,
        );
        // A real canonical source + mark survive the exact v2 structural
        // upgrade. No parsed JSON fallback is read or created during upgrade.
        await query("DROP TABLE reader_import_cache");
        await query("DROP INDEX marks_by_section_user");
        await query(
          "UPDATE reader_schema_version SET version=2,schema_sha256=?",
          [schemaHash(v2Sql)],
        );
        db?.close();
        db = undefined;
        await h.reopen();
        if (!admin) db = new DatabaseSync(join(h.directory, "reader.sqlite"));
        assert.equal(
          Number(
            (await query("SELECT version FROM reader_schema_version"))[0]!
              .version,
          ),
          4,
        );
        assert.equal(
          (await query("SELECT * FROM reader_import_cache")).length,
          0,
        );
        assert.equal(
          (
            await h.withHuman((actor) =>
              h!.domains.reader.service.read(
                actor,
                original.entityId,
                1,
                section.id,
              ),
            )
          ).text,
          section.text,
        );
        assert.deepEqual(
          (
            await h.withHuman((actor) =>
              h!.domains.reader.service.marks(
                actor,
                original.entityId,
                1,
                false,
                0,
                50,
              ),
            )
          ).marks[0]!.location,
          location,
        );
        const afterUpgrade = await workerStarts(() =>
          importBook({ ...initial, commandId: randomUUID() }),
        );
        assert.equal(
          afterUpgrade.starts,
          1,
          "empty v4 cache index must reparse the currently supplied bytes",
        );
        assert.equal(
          (
            await workerStarts(() =>
              importBook({ ...initial, commandId: randomUUID() }),
            )
          ).starts,
          0,
        );
        // Actual project grant withdrawal while the importing identity stays
        // active: the cached source is inaccessible, but a new authorized
        // upload into the reader's own project may independently be parsed.
        const members = () =>
          [localAccess, other].map((human) => ({
            ...human,
            enabled: true,
            loginTokenHash: sha(`synthetic-login-${human.principalId}`),
          }));
        await h.identity!.replaceConfiguration(
          { version: 1, members: members() },
          [
            { ...localAccess, enabled: true, projectIds: [otherProject] },
            { ...other, enabled: true, projectIds: [] },
          ],
        );
        const scopedBytes = Buffer.from(
          "# 有私有授权的书\n\n当前权限不是摘要。",
        );
        const scoped = {
          ...initial,
          commandId: randomUUID(),
          projectId: otherProject,
          bytes: scopedBytes,
        };
        const scopedBook = await workerStarts(() => importBook(scoped));
        assert.equal(scopedBook.starts, 1);
        await h.identity!.replaceConfiguration(
          { version: 1, members: members() },
          [
            { ...localAccess, enabled: true, projectIds: [] },
            { ...other, enabled: true, projectIds: [] },
          ],
        );
        await assert.rejects(
          h.withHuman((actor) =>
            h!.domains.reader.service.bookOverview(
              actor,
              scopedBook.value.entityId,
              1,
            ),
          ),
          /权限|访问|授权/,
        );
        const scopedMiss = await workerStarts(() =>
          importBook({
            ...scoped,
            commandId: randomUUID(),
            projectId: h!.projectId,
          }),
        );
        assert.equal(
          scopedMiss.starts,
          1,
          "withdrawn source grant must not be bypassed by the digest cache",
        );
        assert.notEqual(scopedMiss.value.bookId, scopedBook.value.bookId);
        // PDF has a different real Worker fingerprint and native page mapping.
        const pdfRequest = {
          ...initial,
          commandId: randomUUID(),
          name: "原页.pdf",
          bytes: readFileSync(
            new URL("./fixtures/reader.pdf", import.meta.url),
          ),
        };
        const firstPdf = await workerStarts(() => importBook(pdfRequest));
        assert.equal(firstPdf.starts, 1);
        const secondPdf = await workerStarts(() =>
          importBook({ ...pdfRequest, commandId: randomUUID() }),
        );
        assert.equal(secondPdf.starts, 0);
        const pdfOverview = await h.withHuman((actor) =>
          h!.domains.reader.service.bookOverview(
            actor,
            secondPdf.value.entityId,
            1,
          ),
        );
        assert.equal(pdfOverview.sections.length, 2);
        const pdfPages = await query(
          "SELECT page_number FROM book_sections WHERE reading_source_id=(SELECT reading_source_id FROM reading_sources WHERE book_id=?) ORDER BY ordinal",
          [secondPdf.value.bookId],
        );
        assert.deepEqual(
          pdfPages.map((row) => Number(row.page_number)),
          [1, 2],
        );
        await assert.rejects(
          h.domains.reader.service.import(
            { credential: "forged-cache-credential" },
            pdfRequest,
          ),
          /身份|权限|失效|不存在/,
        );
        // Real identity withdrawal blocks cache hits and command receipts.
        await h.identity!.replaceConfiguration(
          {
            version: 1,
            members: [localAccess, other].map((human) => ({
              ...human,
              enabled: human.principalId !== localAccess.principalId,
              loginTokenHash: sha(`synthetic-login-${human.principalId}`),
            })),
          },
          [
            { ...localAccess, enabled: false, projectIds: [] },
            { ...other, enabled: true, projectIds: [] },
          ],
        );
        await assert.rejects(
          importBook({ ...pdfRequest, commandId: randomUUID() }),
          /身份|权限|失效/,
        );
        await assert.rejects(importBook(pdfRequest), /身份|权限|失效/);
        h.assertNoLegacyData();
        console.log(
          `${backend}: real Worker miss=1, duplicate/retry/cold/PDF hit=0; independent books, owner isolation, damaged cache and withdrawn identity checked`,
        );
      } finally {
        db?.close();
        await h?.close();
        if (admin) {
          for (const schema of Object.values(schemas))
            await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          await admin.end();
        }
      }
    },
  );
}

// Exact old DDL hash + structural validation are required before the atomic
// v2 -> v4 upgrade. No dummy schema number or JSON compatibility fallback.
const v2Sql = readerSchemaSql
  .slice(0, readerSchemaSql.indexOf("\n-- Parsed import cache:"))
  .replace(
    "CREATE INDEX marks_by_section_user ON reading_marks(tenant_id, reading_source_id, principal_id, section_id, deleted_at, created_at, mark_id, start_offset, end_offset);\n",
    "",
  )
  .replace("-- Reader schema v4.", "-- Reader schema v2.");
test("Reader v2 结构升级新增空缓存索引，旧关系/正文不重写且坏结构原子拒绝", async (t) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const directory = mkdtempSync(join(tmpdir(), "reader-cache-schema-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const authority = {} as ReaderAuthorityVerifier;
  const filename = join(directory, "reader.sqlite");
  const db = new DatabaseSync(filename);
  db.exec(v2Sql);
  db.prepare("INSERT INTO reader_schema_version VALUES(2,?)").run(
    schemaHash(v2Sql),
  );
  db.close();
  const store = await ReaderStore.sqlite(filename, authority);
  await store.close();
  const upgraded = new DatabaseSync(filename);
  assert.equal(
    upgraded.prepare("SELECT version FROM reader_schema_version").get()!
      .version,
    4,
  );
  assert.equal(
    upgraded.prepare("SELECT COUNT(*) AS n FROM reader_import_cache").get()!.n,
    0,
  );
  assert.ok(
    upgraded
      .prepare(
        "SELECT name FROM sqlite_master WHERE name='reader_import_cache_lookup'",
      )
      .get(),
  );
  upgraded.close();
  const bad = join(directory, "bad-reader.sqlite");
  const badDb = new DatabaseSync(bad);
  badDb.exec(v2Sql);
  badDb
    .prepare("INSERT INTO reader_schema_version VALUES(2,?)")
    .run(schemaHash(v2Sql));
  badDb.exec("DROP INDEX marks_by_source_user");
  badDb.close();
  await assert.rejects(ReaderStore.sqlite(bad, authority), /索引缺失/);
  const after = new DatabaseSync(bad);
  assert.equal(
    after.prepare("SELECT version FROM reader_schema_version").get()!.version,
    2,
  );
  assert.equal(
    after
      .prepare(
        "SELECT name FROM sqlite_master WHERE name='reader_import_cache'",
      )
      .get(),
    undefined,
  );
  after.close();
});

test(
  "PostgreSQL Reader v2 升级严格校验旧结构，坏索引不留下v4缓存表",
  { skip: !postgresUrl },
  async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
    const schema = `cm_${suffix}`;
    const admin = new Pool({ connectionString: postgresUrl });
    const authority = {} as ReaderAuthorityVerifier;
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const connection = await admin.connect();
      try {
        await connection.query("BEGIN");
        await connection.query(
          `SET LOCAL search_path TO "${schema}",pg_catalog`,
        );
        await connection.query(v2Sql);
        await connection.query(
          "INSERT INTO reader_schema_version VALUES(2,$1)",
          [schemaHash(v2Sql)],
        );
        await connection.query("DROP INDEX marks_by_source_user");
        await connection.query("COMMIT");
      } finally {
        connection.release();
      }
      await assert.rejects(
        ReaderStore.postgres(
          { connectionString: postgresUrl!, schema },
          authority,
        ),
        /索引缺失/,
      );
      assert.equal(
        Number(
          (
            await admin.query(
              `SELECT version FROM "${schema}".reader_schema_version`,
            )
          ).rows[0].version,
        ),
        2,
      );
      assert.equal(
        (
          await admin.query(
            "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname=$1 AND tablename='reader_import_cache'",
            [schema],
          )
        ).rows.length,
        0,
      );
      await admin.query(
        `CREATE INDEX marks_by_source_user ON "${schema}".reading_marks(tenant_id, reading_source_id, principal_id, deleted_at, created_at, mark_id)`,
      );
      const store = await ReaderStore.postgres(
        { connectionString: postgresUrl!, schema },
        authority,
      );
      await store.close();
      assert.equal(
        Number(
          (
            await admin.query(
              `SELECT version FROM "${schema}".reader_schema_version`,
            )
          ).rows[0].version,
        ),
        4,
      );
      assert.equal(
        (
          await admin.query(
            `SELECT COUNT(*) AS n FROM "${schema}".reader_import_cache`,
          )
        ).rows[0].n,
        "0",
      );
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
