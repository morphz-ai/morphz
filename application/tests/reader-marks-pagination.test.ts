import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import { Application } from "../packages/application/src/application.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";
import { localAccess } from "../packages/core/src/model.js";
import type {
  ReaderCommand,
  ReadingMarksPage,
  ReaderMarksRead,
} from "../packages/core/src/reader.js";
import type { ReaderService } from "../packages/application/src/reader-service.js";
import {
  ReaderStore,
  type ReaderAuthorityVerifier,
} from "../packages/reader/src/store.js";
import { readerSchemaSql } from "../packages/reader/src/schema.js";
import type { SqlQuery, SqlRow } from "../packages/storage/src/sql.js";
import { schemaHash } from "../packages/storage/src/sql.js";

const postgresUrl = process.env.MORPHZ_TEST_POSTGRES_URL;
const other = { principalId: "marks-other", actantId: "marks-other-human" };

/** Observe queries and actual rows returned by the real backend transaction.
 * No SQL/domain operation or result is replaced by a test implementation. */
async function observeReaderSql<T>(
  service: ReaderService,
  work: () => Promise<T>,
  afterMarkRead?: () => Promise<void>,
) {
  const store = (service as unknown as { reader: ReaderStore }).reader;
  type Transaction = <R>(
    work: (query: SqlQuery) => Promise<R>,
    readOnly?: boolean,
  ) => Promise<R>;
  const internal = store as unknown as { transaction: Transaction };
  const original = internal.transaction;
  const queries: Array<{ sql: string; values: unknown[]; rows: number }> = [];
  let after = afterMarkRead;
  internal.transaction = function <R>(
    work: (query: SqlQuery) => Promise<R>,
    readOnly?: boolean,
  ) {
    return original.call(
      store,
      async (query: SqlQuery) =>
        work({
          ...query,
          async all<U extends SqlRow>(sql: string, values = []) {
            const rows = await query.all<U>(sql, values);
            queries.push({ sql, values, rows: rows.length });
            if (/FROM reading_marks/i.test(sql) && after) {
              const effect = after;
              after = undefined;
              await effect();
            }
            return rows;
          },
        }),
      readOnly,
    ) as Promise<R>;
  };
  try {
    return { value: await work(), queries };
  } finally {
    internal.transaction = original;
  }
}

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: 正式 Reader 千条标注先按原件/身份/章节/删除过滤再分页，进度不读取标注`,
    { skip: backend === "postgres" && !postgresUrl },
    async () => {
      const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
      const schemas = Object.fromEntries(
        ["platform", "objects", "scriptStudio", "reader", "browser"].map(
          (name, index) => [name, `mp_${index}_${suffix}`],
        ),
      ) as Record<
        "platform" | "objects" | "scriptStudio" | "reader" | "browser",
        string
      >;
      const admin =
        backend === "postgres"
          ? new Pool({ connectionString: postgresUrl })
          : null;
      let fixture: Awaited<ReturnType<typeof agentDomainFixture>> | undefined;
      let connection: LocalApplicationConnection | undefined;
      try {
        if (admin)
          for (const schema of Object.values(schemas))
            await admin.query(`CREATE SCHEMA "${schema}"`);
        fixture = await agentDomainFixture({
          additionalHumans: [other],
          loginTokenForHuman: (human) =>
            human.principalId === localAccess.principalId
              ? "a".repeat(64)
              : "b".repeat(64),
          ...(admin
            ? {
                storage: {
                  platform: {
                    kind: "postgres" as const,
                    connectionString: postgresUrl!,
                    schema: schemas.platform,
                  },
                  applications: {
                    deploymentId: `marks_${suffix}`,
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
        const h = fixture;
        await h.domains.content.platform.reconcileOperatorMembers(
          h.transport.identity(),
          [localAccess, other].map((access) => ({
            ...access,
            projectIds: [h.projectId],
            enabled: true,
          })),
        );
        const connect = async () => {
          connection = new LocalApplicationConnection(
            new Application(h.transport, {
              identity: h.identity,
              platformWork: h.domains.work,
              platformDocuments: h.domains.content,
              platformReader: h.domains.reader,
            }),
          );
          await connection.call("login", { token: "a".repeat(64) });
          const boot = (await connection.call("platform.bootstrap")) as {
            csrfToken: string;
          };
          return (
            method: Parameters<LocalApplicationConnection["call"]>[0],
            request: unknown,
          ) =>
            connection!.call(method, request, {
              identityGeneration: boot.csrfToken,
            });
        };
        let call = await connect();
        const document = (await call("documents.create", {
          commandId: randomUUID(),
          objectId: `marks_document_${suffix}`,
          projectId: h.projectId,
          title: "千条标注真实原文",
          markdown: `# 第一章\n\n${"甲".repeat(7000)}\n\n# 第二章\n\n${"乙".repeat(7000)}`,
        })) as { contentId: string };
        const artifactId = document.contentId;
        const sections = (await call("reader.contents", {
          artifactId,
          revision: 1,
        })) as Array<{ id: string }>;
        assert.equal(sections.length, 2);
        const section = (await call("reader.read", {
          artifactId,
          revision: 1,
          sectionId: sections[0]!.id,
        })) as { id: string; sourceId: string; text: string };
        const second = (await call("reader.read", {
          artifactId,
          revision: 1,
          sectionId: sections[1]!.id,
        })) as typeof section;
        const command = (operation: ReaderCommand) =>
          h.withHuman((actor) =>
            h.domains.reader.service.command(actor, {
              commandId: randomUUID(),
              contentId: artifactId,
              revision: 1,
              command: operation,
            }),
          );
        const add = (
          source: typeof section,
          start: number,
          end: number,
          kind: "highlight" | "bookmark" = "highlight",
        ): ReaderCommand => ({
          action: "mark-add",
          artifactId,
          artifactRevision: 1,
          location: {
            sourceId: source.sourceId,
            sectionId: source.id,
            start,
            end,
          },
          quote: source.text.slice(start, end),
          kind,
          color: "yellow",
          note: "",
        });
        const denseIds: string[] = [],
          deletedIds: string[] = [];
        const began = performance.now();
        for (let index = 0; index < 1060; index++) {
          const mark = await command(
            add(section, 4000 + (index % 20), 4025 + Math.floor(index / 20)),
          );
          if (index < 60) {
            deletedIds.push(mark.id);
            await command({
              action: "mark-remove",
              markId: mark.id,
              expectedRevision: 1,
            });
          } else denseIds.push(mark.id);
        }
        for (let index = 0; index < 65; index++)
          await command(add(second, 40 + index, 45 + index));
        const spanning = await command(add(section, 10, 4050));
        const lower = await command(add(section, 4000, 4000, "bookmark"));
        const upper = await command(add(section, 4100, 4100, "bookmark"));
        const withOther = <T>(
          work: Parameters<typeof h.domains.work.authority.withSession<T>>[2],
        ) => h.domains.work.authority.withSession(other, () => {}, work);
        for (let index = 0; index < 20; index++)
          await withOther((actor) =>
            h.domains.reader.service.command(actor, {
              commandId: randomUUID(),
              contentId: artifactId,
              revision: 1,
              command: add(section, 4020 + index, 4025 + index),
            }),
          );
        await command({
          action: "save-position",
          artifactId,
          artifactRevision: 1,
          location: {
            sourceId: second.sourceId,
            sectionId: second.id,
            start: 200,
            end: 200,
          },
          preferences: { fontSize: 20, font: "serif", theme: "system" },
          expectedRevision: 0,
        });
        const state = await observeReaderSql(h.domains.reader.service, () =>
          call("reader.state", { artifactId, revision: 1 }),
        );
        assert.deepEqual(Object.keys(state.value as object), ["position"]);
        assert.equal(
          state.queries.filter((q) => /reading_marks/i.test(q.sql)).length,
          0,
        );
        const request: ReaderMarksRead = {
          artifactId,
          revision: 1,
          sectionId: section.id,
          start: 4000,
          end: 4100,
          limit: 50,
        };
        const first = await observeReaderSql(
          h.domains.reader.service,
          async () => (await call("reader.marks", request)) as ReadingMarksPage,
        );
        assert.equal(first.value.marks.length, 50);
        assert.equal(first.value.hasMore, true);
        const reads = first.queries.filter((q) =>
          /FROM reading_marks/i.test(q.sql),
        );
        assert.equal(reads.length, 1);
        assert.equal(reads[0]!.rows, 51);
        assert.match(
          reads[0]!.sql,
          /tenant_id=\? AND reading_source_id=\? AND principal_id=\?/,
        );
        assert.match(reads[0]!.sql, /deleted_at IS NULL AND section_id=\?/);
        assert.match(reads[0]!.sql, /start_offset<\? AND end_offset>\?/);
        assert.deepEqual(reads[0]!.values.slice(-2), [51, 0]);
        let after = first.value.nextCursor,
          page = first.value;
        const visible = [...page.marks];
        let pages = 1;
        while (after) {
          page = (await call("reader.marks", {
            ...request,
            after,
          })) as ReadingMarksPage;
          assert.ok(page.marks.length <= 50);
          visible.push(...page.marks);
          after = page.nextCursor;
          pages++;
        }
        assert.equal(visible.length, 1003);
        assert.equal(new Set(visible.map((m) => m.id)).size, 1003);
        for (const id of [...denseIds, spanning.id, lower.id, upper.id])
          assert.ok(visible.some((m) => m.id === id));
        for (const id of deletedIds)
          assert.ok(!visible.some((m) => m.id === id));
        assert.equal(pages, 21);
        const point = (await call("reader.marks", {
          ...request,
          start: 4000,
          end: 4000,
        })) as ReadingMarksPage;
        const pointTail = (await call("reader.marks", {
          ...request,
          start: 4000,
          end: 4000,
          after: point.nextCursor!,
        })) as ReadingMarksPage;
        assert.equal(point.marks.length + pointTail.marks.length, 52);
        assert.ok(
          [...point.marks, ...pointTail.marks].some((m) => m.id === lower.id),
        );
        assert.ok(
          [...point.marks, ...pointTail.marks].some(
            (m) => m.id === spanning.id,
          ),
        );
        assert.equal(pointTail.nextCursor, null);
        const deleted = (await call("reader.marks", {
          artifactId,
          revision: 1,
          deleted: true,
          offset: 50,
          limit: 50,
        })) as ReadingMarksPage;
        assert.equal(deleted.marks.length, 10);
        assert.ok(deleted.marks.every((m) => m.deletedAt !== null));
        const foreign = await withOther((actor) =>
          h.domains.reader.service.marks(actor, artifactId, 1, false, 0, 50, {
            sectionId: section.id,
          }),
        );
        assert.equal(foreign.marks.length, 20);
        assert.ok(foreign.marks.every((m) => !denseIds.includes(m.id)));
        const offset = await observeReaderSql(h.domains.reader.service, () =>
          h.call<{ marks: Array<{ id: string }> }>({
            action: "reader",
            reader: {
              action: "marks",
              artifactId,
              revision: 1,
              sectionId: section.id,
              start: 4000,
              end: 4100,
              offset: 1000,
              limit: 50,
            },
          }),
        );
        assert.deepEqual(
          offset.value.marks.map((m) => m.id),
          visible.slice(1000).map((m) => m.id),
        );
        assert.equal(
          offset.queries.filter((q) => /FROM reading_marks/i.test(q.sql))
            .length,
          1,
        );
        assert.deepEqual(
          offset.queries
            .find((q) => /FROM reading_marks/i.test(q.sql))!
            .values.slice(-2),
          [51, 1000],
        );
        for (const invalid of [
          { ...request, limit: 51 },
          { ...request, end: undefined },
          { ...request, end: section.text.length + 1 },
          { ...request, deleted: "false" },
          { ...request, after: "%%bad" },
          {
            ...request,
            after: Buffer.from(
              JSON.stringify({
                ...JSON.parse(
                  Buffer.from(first.value.nextCursor!, "base64url").toString(
                    "utf8",
                  ),
                ),
                createdAt: "yesterday",
              }),
            ).toString("base64url"),
          },
          { ...request, after: first.value.nextCursor!, start: 4001 },
          { ...request, after: first.value.nextCursor!, sectionId: second.id },
          { ...request, after: first.value.nextCursor!, offset: 1 },
        ]) {
          await assert.rejects(call("reader.marks", invalid), {
            status: 400,
            code: "invalid",
          });
        }
        await assert.rejects(
          withOther((actor) =>
            h.domains.reader.service.marks(actor, artifactId, 1, false, 0, 50, {
              ...request,
              after: first.value.nextCursor!,
            }),
          ),
          /游标/,
        );
        const removeId = denseIds[75]!;
        const remove = {
          commandId: randomUUID(),
          artifactId,
          revision: 1,
          command: {
            action: "mark-remove",
            markId: removeId,
            expectedRevision: 1,
          },
        };
        const removed = (await call("reader.command", remove)) as {
          revision: number;
        };
        assert.equal(removed.revision, 2);
        assert.deepEqual(await call("reader.command", remove), removed);
        await assert.rejects(
          call("reader.command", { ...remove, commandId: randomUUID() }),
          /其他位置更新/,
        );
        await call("reader.command", {
          commandId: randomUUID(),
          artifactId,
          revision: 1,
          command: {
            action: "mark-restore",
            markId: removeId,
            expectedRevision: 2,
          },
        });
        await connection!.close();
        connection = undefined;
        await h.reopen();
        call = await connect();
        const restored = (await call("reader.marks", {
          ...request,
          offset: 50,
          limit: 50,
        })) as ReadingMarksPage;
        assert.equal(
          restored.marks.find((m) => m.id === removeId)!.revision,
          3,
        );
        const coldState = (await call("reader.state", {
          artifactId,
          revision: 1,
        })) as {
          position: {
            revision: number;
            location: { sectionId: string; start: number };
          };
        };
        assert.equal(coldState.position.revision, 1);
        assert.equal(coldState.position.location.sectionId, second.id);
        assert.equal(coldState.position.location.start, 200);
        await call("documents.revise", {
          commandId: randomUUID(),
          contentId: artifactId,
          expectedRevision: 1,
          title: "千条标注真实原文",
          markdown: "# 新版\n\n新的原文",
        });
        assert.equal(
          (
            (await call("reader.marks", {
              artifactId,
              revision: 2,
            })) as ReadingMarksPage
          ).marks.length,
          0,
        );
        await assert.rejects(
          call("reader.marks", {
            artifactId,
            revision: 2,
            after: first.value.nextCursor!,
          }),
          /游标/,
        );
        assert.equal(
          ((await call("reader.marks", request)) as ReadingMarksPage).marks
            .length,
          50,
        );
        const revoke = async () => {
          await h.identity!.replaceConfiguration({
            version: 1,
            members: [localAccess, other].map((member) => ({
              ...member,
              enabled: member.principalId !== localAccess.principalId,
              loginTokenHash: createHash("sha256")
                .update(
                  member.principalId === localAccess.principalId
                    ? "a".repeat(64)
                    : "b".repeat(64),
                )
                .digest("hex"),
            })),
          });
        };
        await assert.rejects(
          observeReaderSql(
            h.domains.reader.service,
            () =>
              h.withHuman((actor) =>
                h.domains.reader.service.marks(
                  actor,
                  artifactId,
                  1,
                  false,
                  0,
                  50,
                ),
              ),
            revoke,
          ),
          /权限|授权|身份|成员|无权/,
        );
        await assert.rejects(call("reader.marks", request));
        h.assertNoLegacyData();
        console.log(
          JSON.stringify({
            backend,
            formalCreatedMarks: 1148,
            activeOwnerFirstSection: 1003,
            filteredPageRows: 50,
            actualSqlRows: 51,
            visiblePages: pages,
            stateMarkReads: 0,
            agentOffsetQueries: 1,
            elapsedMs: Math.round(performance.now() - began),
          }),
        );
      } finally {
        try {
          await connection?.close();
        } finally {
          try {
            await fixture?.close();
          } finally {
            if (admin) {
              try {
                for (const schema of Object.values(schemas))
                  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
              } finally {
                await admin.end();
              }
            }
          }
        }
      }
    },
  );

  test(
    `${backend}: Reader v3→v4 仅升级正式索引，指纹/结构不符原子拒绝`,
    { skip: backend === "postgres" && !postgresUrl },
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "morphz-reader-v4-"));
      const filename = join(directory, "reader.sqlite");
      const schema = `mu_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const admin =
        backend === "postgres"
          ? new Pool({ connectionString: postgresUrl })
          : null;
      const index =
        "CREATE INDEX marks_by_section_user ON reading_marks(tenant_id, reading_source_id, principal_id, section_id, deleted_at, created_at, mark_id, start_offset, end_offset);\n";
      const old = readerSchemaSql
        .replace("-- Reader schema v4.", "-- Reader schema v3.")
        .replace(index, "");
      const authority = {} as ReaderAuthorityVerifier;
      const open = () =>
        admin
          ? ReaderStore.postgres(
              { connectionString: postgresUrl!, schema },
              authority,
            )
          : ReaderStore.sqlite(filename, authority);
      try {
        if (admin) {
          await admin.query(`CREATE SCHEMA "${schema}"`);
          await admin.query(`SET search_path TO "${schema}",pg_catalog`);
          await admin.query(old);
          await admin.query(
            "INSERT INTO reader_schema_version(version,schema_sha256) VALUES(3,$1)",
            [schemaHash(old)],
          );
        } else {
          const db = new DatabaseSync(filename);
          try {
            db.exec(old);
            db.prepare(
              "INSERT INTO reader_schema_version(version,schema_sha256) VALUES(3,?)",
            ).run(schemaHash(old));
          } finally {
            db.close();
          }
        }
        const upgraded = await open();
        await upgraded.close();
        if (admin) {
          const version = await admin.query(
            `SELECT version,schema_sha256 FROM "${schema}".reader_schema_version`,
          );
          assert.equal(Number(version.rows[0]!.version), 4);
          assert.equal(
            version.rows[0]!.schema_sha256,
            schemaHash(readerSchemaSql),
          );
          assert.equal(
            (
              await admin.query(
                "SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND indexname='marks_by_section_user'",
                [schema],
              )
            ).rowCount,
            1,
          );
          await admin.query(
            `DROP INDEX "${schema}".marks_by_section_user; UPDATE "${schema}".reader_schema_version SET version=3,schema_sha256='invalid'`,
          );
        } else {
          const db = new DatabaseSync(filename);
          try {
            const row = db
              .prepare(
                "SELECT version,schema_sha256 FROM reader_schema_version",
              )
              .get()!;
            assert.equal(row.version, 4);
            assert.equal(row.schema_sha256, schemaHash(readerSchemaSql));
            assert.ok(
              db
                .prepare(
                  "SELECT name FROM sqlite_master WHERE type='index' AND name='marks_by_section_user'",
                )
                .get(),
            );
            db.exec(
              "DROP INDEX marks_by_section_user; UPDATE reader_schema_version SET version=3,schema_sha256='invalid'",
            );
          } finally {
            db.close();
          }
        }
        await assert.rejects(open(), /结构指纹|不受支持/);
        if (admin) {
          assert.equal(
            Number(
              (
                await admin.query(
                  `SELECT version FROM "${schema}".reader_schema_version`,
                )
              ).rows[0]!.version,
            ),
            3,
          );
          assert.equal(
            (
              await admin.query(
                "SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND indexname='marks_by_section_user'",
                [schema],
              )
            ).rowCount,
            0,
          );
        } else {
          const db = new DatabaseSync(filename);
          try {
            assert.equal(
              db.prepare("SELECT version FROM reader_schema_version").get()!
                .version,
              3,
            );
            assert.equal(
              db
                .prepare(
                  "SELECT name FROM sqlite_master WHERE type='index' AND name='marks_by_section_user'",
                )
                .get(),
              undefined,
            );
          } finally {
            db.close();
          }
        }
      } finally {
        try {
          if (admin) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        } finally {
          if (admin) await admin.end();
          rmSync(directory, { recursive: true, force: true });
        }
      }
    },
  );
}
