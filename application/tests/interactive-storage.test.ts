import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { Application } from "../packages/application/src/application.js";
import {
  DomainError,
  localAccess,
  type AccessContext,
} from "../packages/core/src/model.js";
import {
  emptyInteractive,
  interactiveSummary,
  type InteractiveContent,
} from "../packages/core/src/interactive.js";
import {
  ObjectsStore,
  type ObjectsAuthority,
  type InteractiveRowOperation,
} from "../packages/objects/src/store.js";
import { objectsSchemaSql } from "../packages/objects/src/schema.js";
import { schemaHash } from "../packages/storage/src/sql.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";

const postgresUrl = process.env.MORPHZ_TEST_POSTGRES_URL;
const other = { principalId: "table-reader", actantId: "table-human" };
const content: InteractiveContent = {
  ...emptyInteractive,
  description: "字面 <script> 不执行",
  columns: emptyInteractive.columns.map((column) => ({
    ...column,
    required: false,
  })),
  rows: Array.from(
    { length: 60 },
    (_, index): InteractiveContent["rows"][number] => ({
      id: `r${index}`,
      cells:
        index === 0
          ? { name: "缺失" }
          : index === 1
            ? { name: "记录1", value: null, done: false }
            : index === 2
              ? { name: "记录2", value: "", done: true }
              : { name: `记录${index}`, value: index, done: index % 2 === 0 },
    }),
  ),
};

async function fixture(backend: "sqlite" | "postgres") {
  const suffix = randomUUID().replaceAll("-", "");
  const schemas = {
    platform: `p_${suffix}`,
    objects: `o_${suffix}`,
    scriptStudio: `s_${suffix}`,
    reader: `r_${suffix}`,
    browser: `b_${suffix}`,
  };
  const admin =
    backend === "postgres" ? new Pool({ connectionString: postgresUrl }) : null;
  if (admin)
    for (const name of Object.values(schemas))
      await admin.query(`CREATE SCHEMA "${name}"`);
  const host = await agentDomainFixture(
    admin
      ? {
          additionalHumans: [other],
          storage: {
            platform: {
              kind: "postgres",
              connectionString: postgresUrl!,
              schema: schemas.platform,
            },
            applications: {
              deploymentId: suffix,
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
      : { additionalHumans: [other] },
  );
  const session = (access: AccessContext = localAccess) =>
    new Application(host.transport, {
      identity: host.identity,
      platformWork: host.domains.work,
      platformDocuments: host.domains.content,
    }).session(access);
  const raw = async (sql: string, values: (string | number | null)[] = []) => {
    if (admin)
      return (
        await admin.query(
          sql
            .replace(
              /\?/g,
              (_, offset: number, whole: string) =>
                `$${whole.slice(0, offset).split("?").length}`,
            )
            .replaceAll("APP.", `"${schemas.objects}".`),
          values,
        )
      ).rows as Record<string, unknown>[];
    const db = new DatabaseSync(join(host.directory, "objects.sqlite"));
    try {
      return db.prepare(sql.replaceAll("APP.", "")).all(...values) as Record<
        string,
        unknown
      >[];
    } finally {
      db.close();
    }
  };
  return {
    host,
    session,
    raw,
    async close() {
      await host.close();
      if (admin) {
        for (const name of Object.values(schemas))
          await admin.query(`DROP SCHEMA "${name}" CASCADE`);
        await admin.end();
      }
    },
  };
}

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `Objects ${backend} 真实Agent/Human表格按行查询、局部CAS、版本引用和撤权`,
    { skip: backend === "postgres" && !postgresUrl },
    async () => {
      const f = await fixture(backend);
      try {
        const created = await f.host.call<{ contentId: string }>({
          action: "create-interactive",
          title: "关系表格",
          interactive: content,
        });
        const entry = await f
          .session()
          .getPlatformContent({ contentId: created.contentId });
        const objectId = entry.appObjectId;
        const initial = await f.raw(
          "SELECT payload_body FROM APP.object_versions WHERE object_id=? AND revision=1",
          [objectId],
        );
        const pointer = JSON.parse(String(initial[0]!.payload_body));
        assert.equal(pointer.storage, "relational-v1");
        assert.equal(pointer.rows, undefined);
        assert.equal(pointer.columns, undefined);
        assert.equal(
          Number(
            (
              await f.raw(
                "SELECT COUNT(*) AS n FROM APP.interactive_row_versions WHERE object_id=?",
                [objectId],
              )
            )[0]!.n,
          ),
          60,
        );
        const first = await f.session().queryPlatformInteractiveRows({
          contentId: created.contentId,
          limit: 5,
        });
        assert.equal(first.rows.length, 5);
        assert.equal(first.total, 60);
        assert.equal(first.matched, 60);
        assert.deepEqual(first.summaries, interactiveSummary(content));
        assert.ok(first.nextCursor);
        assert.equal(Object.hasOwn(first.rows[0]!.cells, "value"), false);
        assert.equal(first.rows[1]!.cells.value, null);
        assert.equal(first.rows[1]!.cells.done, false);
        assert.equal(first.rows[2]!.cells.value, "");
        const command = {
          commandId: randomUUID(),
          contentId: created.contentId,
          expectedRevision: 1,
          operations: [
            {
              type: "update" as const,
              rowId: "r3",
              cells: { value: 0, done: false },
              unset: ["name"],
            },
          ],
        };
        const saved = await f.session().patchPlatformInteractiveRows(command);
        assert.equal(saved.versionRef, "2");
        assert.deepEqual(
          await f.session().patchPlatformInteractiveRows(command),
          saved,
        );
        await assert.rejects(
          f.session().patchPlatformInteractiveRows({
            ...command,
            operations: [{ type: "update", rowId: "r3", cells: { value: 9 } }],
          }),
        );
        await assert.rejects(
          f.session().patchPlatformInteractiveRows({
            ...command,
            commandId: randomUUID(),
          }),
        );
        assert.equal(
          Number(
            (
              await f.raw(
                "SELECT COUNT(*) AS n FROM APP.interactive_row_versions WHERE object_id=?",
                [objectId],
              )
            )[0]!.n,
          ),
          61,
          "one changed row, not sixty copies",
        );
        assert.equal(
          Number(
            (
              await f.raw(
                "SELECT COUNT(*) AS n FROM APP.interactive_version_rows WHERE object_id=?",
                [objectId],
              )
            )[0]!.n,
          ),
          120,
          "bounded per-version manifest cost is explicit",
        );
        assert.equal(
          Number(
            (
              await f.raw(
                "SELECT COUNT(*) AS n FROM APP.object_command_receipts WHERE command_id=?",
                [command.commandId],
              )
            )[0]!.n,
          ),
          1,
        );
        assert.equal(
          Number(
            (
              await f.raw(
                "SELECT COUNT(*) AS n FROM APP.object_outbox WHERE event_id=?",
                [command.commandId],
              )
            )[0]!.n,
          ),
          1,
        );
        const history = await f
          .session()
          .readPlatformObject({ contentId: created.contentId, revision: 1 });
        assert.deepEqual(history.content, content);
        const next = await f.session().queryPlatformInteractiveRows({
          contentId: created.contentId,
          after: first.nextCursor!,
          limit: 5,
        });
        assert.equal(next.revision, 1);
        assert.deepEqual(next.rows, content.rows.slice(5, 10));
        await assert.rejects(
          f.session().queryPlatformInteractiveRows({
            contentId: created.contentId,
            after: first.nextCursor!,
            query: "换条件",
          }),
        );
        await assert.rejects(
          f.session().queryPlatformInteractiveRows({
            contentId: created.contentId,
            after: first.nextCursor!,
            revision: 2,
          }),
        );
        const sorted = await f.session().queryPlatformInteractiveRows({
          contentId: created.contentId,
          revision: 1,
          query: "记录",
          sort: { columnId: "value", descending: true },
          limit: 3,
        });
        assert.deepEqual(
          sorted.rows.map((row) => row.id),
          ["r59", "r58", "r57"],
        );
        assert.equal(sorted.matched, 59);
        assert.deepEqual(
          sorted.summaries,
          interactiveSummary({ ...content, rows: content.rows.slice(1) }),
        );
        const offset = await f.host.withHuman((actor) =>
          f.host.domains.content.objects.queryInteractiveRows({
            credential: actor.credential,
            objectId,
            revision: 1,
            offset: 20,
            limit: 2,
          }),
        );
        assert.deepEqual(offset.rows, content.rows.slice(20, 22));
        await assert.rejects(
          f.host.withHuman((actor) =>
            f.host.domains.content.objects.queryInteractiveRows({
              credential: actor.credential,
              objectId,
              after: first.nextCursor!,
              offset: 0,
            }),
          ),
        );
        await f.session().patchPlatformInteractiveRows({
          commandId: randomUUID(),
          contentId: created.contentId,
          expectedRevision: 2,
          operations: [{ type: "delete", rowId: "r3" }],
        });
        await f.session().patchPlatformInteractiveRows({
          commandId: randomUUID(),
          contentId: created.contentId,
          expectedRevision: 3,
          operations: [
            {
              type: "restore",
              rowId: "r3",
              fromRevision: 1,
              beforeRowId: "r4",
            },
          ],
        });
        assert.equal(
          Number(
            (
              await f.raw(
                "SELECT COUNT(*) AS n FROM APP.interactive_row_versions WHERE object_id=?",
                [objectId],
              )
            )[0]!.n,
          ),
          61,
          "restore reuses exact historical row state",
        );
        assert.deepEqual(
          (
            await f
              .session()
              .readPlatformObject({ contentId: created.contentId, revision: 4 })
          ).content,
          content,
        );
        await f.session().annotatePlatformObject({
          commandId: randomUUID(),
          contentId: created.contentId,
          revision: 1,
          quote: "记录6",
          body: "不随当前行编辑而改变",
        });
        await f.host.reopen();
        assert.deepEqual(
          (
            await f
              .session()
              .readPlatformObject({ contentId: created.contentId, revision: 1 })
          ).content,
          content,
        );
        assert.deepEqual(
          (
            await f.session().queryPlatformInteractiveRows({
              contentId: created.contentId,
              revision: 4,
              limit: 2,
            })
          ).rows,
          content.rows.slice(0, 2),
        );
        assert.equal(
          (
            await f
              .session()
              .listPlatformObjectAnnotations({ contentId: created.contentId })
          )[0]!.annotation.artifactRevision,
          1,
        );
        await f.host.domains.content.platform.reconcileOperatorMembers(
          f.host.transport.identity(),
          [
            { ...localAccess, projectIds: [f.host.projectId], enabled: true },
            { ...other, projectIds: [f.host.projectId], enabled: true },
          ],
        );
        assert.equal(
          (
            await f.session(other).queryPlatformInteractiveRows({
              contentId: created.contentId,
              revision: 1,
              limit: 1,
            })
          ).rows.length,
          1,
        );
        await f.host.domains.content.platform.reconcileOperatorMembers(
          f.host.transport.identity(),
          [
            { ...localAccess, projectIds: [f.host.projectId], enabled: true },
            { ...other, projectIds: [], enabled: true },
          ],
        );
        await assert.rejects(
          f.session(other).queryPlatformInteractiveRows({
            contentId: created.contentId,
            revision: 1,
          }),
        );
        await assert.rejects(
          f.session(other).patchPlatformInteractiveRows({
            ...command,
            commandId: randomUUID(),
            expectedRevision: 4,
          }),
        );
        f.host.assertNoLegacyData();
      } finally {
        await f.close();
      }
    },
  );

  test(
    `Objects ${backend} 非法行修改原子拒绝，字段版本与改名精确复用，损坏不是用户错误`,
    { skip: backend === "postgres" && !postgresUrl },
    async () => {
      const f = await fixture(backend);
      try {
        const original: InteractiveContent = {
          ...content,
          columns: content.columns.map((column) => ({
            ...column,
            required: column.id === "name",
          })),
          rows: content.rows.slice(0, 3),
        };
        const created = await f.host.call<{ contentId: string }>({
          action: "create-interactive",
          title: "字段版本",
          interactive: original,
        });
        const entry = await f
          .session()
          .getPlatformContent({ contentId: created.contentId });
        const objectId = entry.appObjectId;
        const invalid: InteractiveRowOperation[][] = [
          [{ type: "delete", rowId: "missing" }],
          [{ type: "update", rowId: "r0", cells: {}, unset: ["name"] }],
          [{ type: "update", rowId: "r0", cells: { value: "不是数值" } }],
          [{ type: "update", rowId: "r0", cells: {}, unset: ["undefined"] }],
          [{ type: "insert", row: original.rows[0]! }],
          [{ type: "restore", rowId: "r0", fromRevision: 2 }],
          [{ type: "restore", rowId: "missing", fromRevision: 1 }],
          [
            { type: "update", rowId: "r0", cells: { value: 7 } },
            {
              type: "insert",
              row: { id: "new", cells: { name: "新记录" } },
              beforeRowId: "missing",
            },
          ],
        ];
        for (const operations of invalid) {
          const commandId = randomUUID();
          await assert.rejects(
            f.session().patchPlatformInteractiveRows({
              commandId,
              contentId: created.contentId,
              expectedRevision: 1,
              operations,
            }),
            { code: "invalid" },
          );
          for (const [table, column] of [
            ["object_command_receipts", "command_id"],
            ["object_outbox", "event_id"],
          ])
            assert.equal(
              Number(
                (
                  await f.raw(
                    `SELECT COUNT(*) AS n FROM APP.${table} WHERE ${column}=?`,
                    [commandId],
                  )
                )[0]!.n,
              ),
              0,
              "failed patch leaves neither receipt nor outbox",
            );
          assert.equal(
            Number(
              (
                await f.raw(
                  "SELECT head_revision FROM APP.objects WHERE object_id=?",
                  [objectId],
                )
              )[0]!.head_revision,
            ),
            1,
            "a failed second operation rolls back the earlier operation and head CAS",
          );
        }
        for (const query of [
          { sort: { columnId: "undefined", descending: false } },
          { after: "not-a-cursor" },
          { revision: 999 },
        ])
          await assert.rejects(
            f.session().queryPlatformInteractiveRows({
              contentId: created.contentId,
              ...query,
            }),
            { code: "invalid" },
          );
        const evolved: InteractiveContent = {
          ...original,
          layout: "report",
          columns: [
            ...original.columns.map((column) => ({
              ...column,
              title: `${column.title}新版`,
            })),
            { id: "note", title: "备注", type: "text", required: false },
          ],
        };
        await f.session().revisePlatformInteractive({
          commandId: randomUUID(),
          contentId: created.contentId,
          expectedRevision: 1,
          title: "字段版本",
          content: evolved,
        });
        const renamed = await f.session().renamePlatformObject({
          commandId: randomUUID(),
          contentId: created.contentId,
          expectedCatalogRevision: (
            await f
              .session()
              .getPlatformContent({ contentId: created.contentId })
          ).revision,
          title: "只改变标题",
        });
        assert.equal(renamed.original.versionRef, "3");
        assert.equal(
          Number(
            (
              await f.raw(
                "SELECT COUNT(*) AS n FROM APP.interactive_versions WHERE object_id=?",
                [objectId],
              )
            )[0]!.n,
          ),
          2,
        );
        assert.equal(
          Number(
            (
              await f.raw(
                "SELECT COUNT(*) AS n FROM APP.interactive_columns WHERE object_id=?",
                [objectId],
              )
            )[0]!.n,
          ),
          7,
        );
        assert.equal(
          Number(
            (
              await f.raw(
                "SELECT COUNT(*) AS n FROM APP.interactive_row_versions WHERE object_id=?",
                [objectId],
              )
            )[0]!.n,
          ),
          3,
        );
        for (const revision of [1, 2, 3])
          assert.deepEqual(
            (
              await f
                .session()
                .readPlatformObject({ contentId: created.contentId, revision })
            ).content,
            revision === 1 ? original : evolved,
          );
        await f.host.reopen();
        assert.deepEqual(
          (
            await f.session().queryPlatformInteractiveRows({
              contentId: created.contentId,
              revision: 3,
            })
          ).columns,
          evolved.columns,
        );
        await f.raw(
          "UPDATE APP.interactive_cells SET text_value='损坏' WHERE object_id=? AND row_id='r0' AND row_revision=1 AND column_id='name'",
          [objectId],
        );
        await assert.rejects(
          f.session().queryPlatformInteractiveRows({
            contentId: created.contentId,
            limit: 1,
          }),
          (error: unknown) =>
            error instanceof Error &&
            !(error instanceof DomainError) &&
            /摘要/.test(error.message),
        );
        await f.raw(
          "UPDATE APP.interactive_cells SET text_value=? WHERE object_id=? AND row_id='r0' AND row_revision=1 AND column_id='name'",
          [String(original.rows[0]!.cells.name), objectId],
        );
        await f.raw(
          "UPDATE APP.interactive_columns SET column_id='invalid.id' WHERE object_id=? AND schema_revision=2 AND column_id='name'",
          [objectId],
        );
        await assert.rejects(
          f
            .session()
            .queryPlatformInteractiveRows({ contentId: created.contentId }),
          (error: unknown) =>
            error instanceof Error && !(error instanceof DomainError),
          "invalid stored fields remain internal errors rather than blaming user query",
        );
      } finally {
        await f.close();
      }
    },
  );

  test(
    `Objects ${backend} 1000行24字段仍只写变更行，满表拒绝越界且原历史不变`,
    { skip: backend === "postgres" && !postgresUrl },
    async (t) => {
      const f = await fixture(backend);
      try {
        const large: InteractiveContent = {
          kind: "interactive",
          layout: "table",
          description: "容量边界",
          columns: Array.from({ length: 24 }, (_, index) => ({
            id: `c${index}`,
            title: `字段${index}`,
            type: "text",
            required: false,
          })),
          rows: Array.from({ length: 1000 }, (_, index) => ({
            id: `r${index}`,
            cells: Object.fromEntries(
              Array.from({ length: 24 }, (_, column) => [
                `c${column}`,
                `值${index}_${column}`,
              ]),
            ),
          })),
        };
        const started = performance.now();
        const created = await f.host.call<{ contentId: string }>({
          action: "create-interactive",
          title: "最大当前表格",
          interactive: large,
        });
        const entry = await f
          .session()
          .getPlatformContent({ contentId: created.contentId });
        const createdAt = performance.now();
        const page = await f.session().queryPlatformInteractiveRows({
          contentId: created.contentId,
          limit: 50,
        });
        assert.equal(page.total, 1000);
        assert.deepEqual(page.rows, large.rows.slice(0, 50));
        const queriedAt = performance.now();
        await f.session().patchPlatformInteractiveRows({
          commandId: randomUUID(),
          contentId: created.contentId,
          expectedRevision: 1,
          operations: [
            {
              type: "update",
              rowId: "r500",
              cells: { c23: "仅此单元格修改" },
            },
          ],
        });
        const patchedAt = performance.now();
        for (const [table, count] of [
          ["interactive_row_versions", 1001],
          ["interactive_cells", 24024],
          ["interactive_version_rows", 2000],
        ] as const)
          assert.equal(
            Number(
              (
                await f.raw(
                  `SELECT COUNT(*) AS n FROM APP.${table} WHERE object_id=?`,
                  [entry.appObjectId],
                )
              )[0]!.n,
            ),
            count,
          );
        const commandId = randomUUID();
        await assert.rejects(
          f.session().patchPlatformInteractiveRows({
            commandId,
            contentId: created.contentId,
            expectedRevision: 2,
            operations: [
              {
                type: "insert",
                row: { id: "overflow", cells: { c0: "不保存" } },
              },
            ],
          }),
          { code: "invalid" },
        );
        assert.equal(
          Number(
            (
              await f.raw(
                "SELECT head_revision FROM APP.objects WHERE object_id=?",
                [entry.appObjectId],
              )
            )[0]!.head_revision,
          ),
          2,
        );
        assert.equal(
          Number(
            (
              await f.raw(
                "SELECT COUNT(*) AS n FROM APP.object_command_receipts WHERE command_id=?",
                [commandId],
              )
            )[0]!.n,
          ),
          0,
        );
        assert.deepEqual(
          (
            await f
              .session()
              .readPlatformObject({ contentId: created.contentId, revision: 1 })
          ).content,
          large,
        );
        const current: InteractiveContent = {
          ...large,
          rows: large.rows.map((row) =>
            row.id === "r500"
              ? { ...row, cells: { ...row.cells, c23: "仅此单元格修改" } }
              : row,
          ),
        };
        assert.deepEqual(
          (
            await f.session().readPlatformObject({
              contentId: created.contentId,
              revision: 2,
            })
          ).content,
          current,
          "十个cells批次保持清单次序，并精确混合未变行v1与改动行v2",
        );
        await f.host.reopen();
        for (const revision of [1, 2])
          assert.deepEqual(
            (
              await f.session().readPlatformObject({
                contentId: created.contentId,
                revision,
              })
            ).content,
            revision === 1 ? large : current,
            "冷重开后当前与历史全文仍读取各自确切行版本",
          );
        // Fault injection changes only the new row state. The new read must
        // still fail its hash check, while the original version stays valid.
        await f.raw(
          "UPDATE APP.interactive_cells SET text_value='损坏第二版' WHERE object_id=? AND row_id='r500' AND row_revision=2 AND column_id='c23'",
          [entry.appObjectId],
        );
        await assert.rejects(
          f.session().readPlatformObject({
            contentId: created.contentId,
            revision: 2,
          }),
          (error: unknown) =>
            error instanceof Error &&
            !(error instanceof DomainError) &&
            /摘要/.test(error.message),
          "优化不能绕过精确新行的完整性校验",
        );
        assert.deepEqual(
          (
            await f.session().readPlatformObject({
              contentId: created.contentId,
              revision: 1,
            })
          ).content,
          large,
          "历史查询不得错误拾取同row_id的损坏新版本",
        );
        await f.raw(
          "UPDATE APP.interactive_cells SET text_value='仅此单元格修改' WHERE object_id=? AND row_id='r500' AND row_revision=2 AND column_id='c23'",
          [entry.appObjectId],
        );
        await f.raw(
          "DELETE FROM APP.interactive_cells WHERE object_id=? AND row_id='r100' AND row_revision=1 AND column_id='c0'",
          [entry.appObjectId],
        );
        for (const revision of [1, 2])
          await assert.rejects(
            f.session().readPlatformObject({
              contentId: created.contentId,
              revision,
            }),
            (error: unknown) =>
              error instanceof Error &&
              !(error instanceof DomainError) &&
              /摘要/.test(error.message),
            "跨百行批次的共享行缺cell仍拒绝当前和历史读取",
          );
        t.diagnostic(
          `actual ${backend}: create=${Math.round(createdAt - started)}ms; page50=${Math.round(queriedAt - createdAt)}ms; patch1=${Math.round(patchedAt - queriedAt)}ms. Fixed manifest and existing search rebuild stay bounded O(N).`,
        );
      } finally {
        await f.close();
      }
    },
  );
}

const sha = (body: string) => createHash("sha256").update(body).digest("hex");
const v4Sql = objectsSchemaSql.slice(
  0,
  objectsSchemaSql.indexOf("\n-- Interactive tables are"),
);
const upgradeReadAuthority: ObjectsAuthority = {
  async authorizeCreate() {
    throw new Error("Upgrade verification is read-only");
  },
  async authorizeDocumentRevision() {
    throw new Error("Upgrade verification is read-only");
  },
  async authorizeByteRead() {
    throw new Error("Upgrade verification has no file bytes");
  },
  async authorizeObjectRead({ credential, objectId }) {
    assert.equal(credential, "upgrade-reader");
    assert.equal(objectId, "table");
    return {
      tenantId: "tenant",
      principalId: "alice",
      actantId: "alice",
      kind: "human",
      runtimeInputId: null,
      projectId: "project",
      contentId: "table-content",
      objectKind: "interactive",
      observedVersionRef: "2",
      catalogRevision: 1,
    };
  },
};
function seedV4(db: DatabaseSync, bad = false) {
  db.exec(v4Sql);
  db.prepare(
    "INSERT INTO objects_schema_version(version,schema_sha256) VALUES(4,?)",
  ).run(schemaHash(v4Sql));
  db.prepare(
    "INSERT INTO objects(tenant_id,object_id,kind,head_revision,created_by_principal_id,created_by_actant_id,created_at,updated_at) VALUES('tenant','table','interactive',2,'alice','agent','2026-09-30T00:00:00.000Z','2026-09-30T00:00:00.000Z')",
  ).run();
  for (const revision of [1, 2]) {
    const body = JSON.stringify({
      ...content,
      rows: revision === 1 ? content.rows : content.rows.slice(1),
    });
    db.prepare(
      "INSERT INTO object_versions(tenant_id,object_id,revision,title,kind,payload_body,payload_sha256,author_principal_id,author_actant_id,created_at) VALUES('tenant','table',?,'原件','interactive',?,?,'alice','agent','2026-09-30T00:00:00.000Z')",
    ).run(revision, body, bad && revision === 2 ? "0".repeat(64) : sha(body));
  }
  db.exec(
    "CREATE VIRTUAL TABLE object_search_fts USING fts5(search_fold,content='object_search_documents',content_rowid='rowid',tokenize='trigram'); CREATE TRIGGER object_search_insert AFTER INSERT ON object_search_documents BEGIN INSERT INTO object_search_fts(rowid,search_fold) VALUES(new.rowid,new.search_fold); END; CREATE TRIGGER object_search_delete AFTER DELETE ON object_search_documents BEGIN INSERT INTO object_search_fts(object_search_fts,rowid,search_fold) VALUES('delete',old.rowid,old.search_fold); END; CREATE TRIGGER object_search_update AFTER UPDATE OF search_fold ON object_search_documents BEGIN INSERT INTO object_search_fts(object_search_fts,rowid,search_fold) VALUES('delete',old.rowid,old.search_fold); INSERT INTO object_search_fts(rowid,search_fold) VALUES(new.rowid,new.search_fold); END;",
  );
}
test("Objects v4 单次原子转化每个表格历史版，坏摘要回滚结构和正文", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-interactive-upgrade-"));
  try {
    for (const bad of [false, true]) {
      const filename = join(directory, bad ? "bad.sqlite" : "valid.sqlite");
      const db = new DatabaseSync(filename);
      seedV4(db, bad);
      db.close();
      if (bad) await assert.rejects(ObjectsStore.sqlite(filename), /摘要/);
      else {
        const store = await ObjectsStore.sqlite(filename, upgradeReadAuthority);
        const read = (revision: number) =>
          store.readObject({
            credential: "upgrade-reader",
            objectId: "table",
            revision,
          });
        assert.deepEqual((await read(1)).content, content);
        assert.deepEqual((await read(2)).content, {
          ...content,
          rows: content.rows.slice(1),
        });
        await store.close();
      }
      const checked = new DatabaseSync(filename, { readOnly: true });
      try {
        assert.equal(
          (
            checked
              .prepare("SELECT version FROM objects_schema_version")
              .get() as { version: number }
          ).version,
          bad ? 4 : 5,
        );
        assert.equal(
          (
            checked
              .prepare(
                "SELECT COUNT(*) AS n FROM sqlite_master WHERE name='interactive_versions'",
              )
              .get() as { n: number }
          ).n,
          bad ? 0 : 1,
        );
        const first = (
          checked
            .prepare(
              "SELECT payload_body FROM object_versions WHERE revision=1",
            )
            .get() as { payload_body: string }
        ).payload_body;
        assert.equal(
          JSON.parse(first).rows !== undefined,
          bad,
          "successful conversion has no old payload fallback; failed conversion changes nothing",
        );
      } finally {
        checked.close();
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "Objects PostgreSQL v4 原子升级历史行；坏摘要回滚DDL、marker和先前版本",
  { skip: !postgresUrl },
  async () => {
    const admin = new Pool({ connectionString: postgresUrl });
    try {
      for (const bad of [false, true]) {
        const schema = `upgrade_${randomUUID().replaceAll("-", "")}`;
        await admin.query(`CREATE SCHEMA "${schema}"`);
        try {
          const client = await admin.connect();
          try {
            await client.query("BEGIN");
            await client.query(
              `SET LOCAL search_path TO "${schema}",pg_catalog`,
            );
            await client.query(v4Sql);
            await client.query(
              "INSERT INTO objects_schema_version(version,schema_sha256) VALUES(4,$1)",
              [schemaHash(v4Sql)],
            );
            await client.query(
              "INSERT INTO objects(tenant_id,object_id,kind,head_revision,created_by_principal_id,created_by_actant_id,created_at,updated_at) VALUES('tenant','table','interactive',2,'alice','agent','2026-09-30T00:00:00.000Z','2026-09-30T00:00:00.000Z')",
            );
            for (const revision of [1, 2]) {
              const body = JSON.stringify({
                ...content,
                rows: revision === 1 ? content.rows : content.rows.slice(1),
              });
              await client.query(
                "INSERT INTO object_versions(tenant_id,object_id,revision,title,kind,payload_body,payload_sha256,author_principal_id,author_actant_id,created_at) VALUES('tenant','table',$1,'原件','interactive',$2,$3,'alice','agent','2026-09-30T00:00:00.000Z')",
                [
                  revision,
                  body,
                  bad && revision === 2 ? "0".repeat(64) : sha(body),
                ],
              );
            }
            await client.query(
              "CREATE INDEX object_search_trigram ON object_search_documents USING gin (search_fold public.gin_trgm_ops)",
            );
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            client.release();
          }
          if (bad)
            await assert.rejects(
              ObjectsStore.postgres({ connectionString: postgresUrl!, schema }),
              /摘要/,
            );
          else {
            const store = await ObjectsStore.postgres({
              connectionString: postgresUrl!,
              schema,
              authority: upgradeReadAuthority,
            });
            try {
              const read = (revision: number) =>
                store.readObject({
                  credential: "upgrade-reader",
                  objectId: "table",
                  revision,
                });
              assert.deepEqual((await read(1)).content, content);
              assert.deepEqual((await read(2)).content, {
                ...content,
                rows: content.rows.slice(1),
              });
            } finally {
              await store.close();
            }
          }
          assert.equal(
            Number(
              (
                await admin.query(
                  `SELECT version FROM "${schema}".objects_schema_version`,
                )
              ).rows[0].version,
            ),
            bad ? 4 : 5,
          );
          assert.equal(
            (
              await admin.query(
                "SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name='interactive_versions'",
                [schema],
              )
            ).rows.length,
            bad ? 0 : 1,
          );
          const first = (
            await admin.query(
              `SELECT payload_body FROM "${schema}".object_versions WHERE revision=1`,
            )
          ).rows[0].payload_body as string;
          assert.equal(JSON.parse(first).rows !== undefined, bad);
        } finally {
          await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        }
      }
    } finally {
      await admin.end();
    }
  },
);
