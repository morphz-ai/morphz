import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import {
  emptyInteractive,
  type InteractiveRowsPage,
} from "../packages/core/src/interactive.js";
import { localAccess } from "../packages/core/src/model.js";
import { createScriptProduction } from "../packages/application/src/script-production-service.js";

const postgresUrl = process.env.MORPHZ_TEST_POSTGRES_URL;
const other = {
  principalId: "table-other-human",
  actantId: "table-other-actant",
};

/** The production Agent router, Runtime input authority, Platform catalog and
 * Objects transactions are real. Only accepted Runtime evidence is controlled;
 * these tests never run a model, inject a Human input, or write business SQL. */
async function fixture(backend: "sqlite" | "postgres") {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  const schemas = {
    objects: `ao_${suffix}`,
    scriptStudio: `as_${suffix}`,
    reader: `ar_${suffix}`,
    browser: `ab_${suffix}`,
  };
  const platformSchema = `ap_${suffix}`;
  const admin =
    backend === "postgres" ? new Pool({ connectionString: postgresUrl }) : null;
  try {
    if (admin)
      for (const schema of [platformSchema, ...Object.values(schemas)])
        await admin.query(`CREATE SCHEMA "${schema}"`);
    const host = await agentDomainFixture({
      additionalHumans: [other],
      ...(backend === "postgres"
        ? {
            storage: {
              platform: {
                kind: "postgres" as const,
                connectionString: postgresUrl!,
                schema: platformSchema,
              },
              applications: {
                connectionStrings: {
                  objects: postgresUrl!,
                  scriptStudio: postgresUrl!,
                  reader: postgresUrl!,
                  browser: postgresUrl!,
                },
                deploymentId: `agent_rows_${suffix}`,
                schemas,
              },
            },
          }
        : {}),
    });
    const close = host.close.bind(host);
    return {
      host,
      async close() {
        try {
          await close();
        } finally {
          if (admin) {
            for (const schema of [platformSchema, ...Object.values(schemas)])
              await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
            await admin.end();
          }
        }
      },
    };
  } catch (error) {
    if (admin) {
      for (const schema of [platformSchema, ...Object.values(schemas)])
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
    throw error;
  }
}

type Receipt = { contentId: string; versionRef: string; receipt: string };
const rows = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `row_${index}`,
    cells: {
      name: `记录 ${String(index).padStart(3, "0")}`,
      value: index,
      done: index % 2 === 0,
    },
  }));

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: Agent 表格查询与行操作共用确切版本、真实回执和冷重开`,
    { skip: backend === "postgres" && !postgresUrl },
    async (t) => {
      const f = await fixture(backend);
      try {
        const original = await f.host.call<Receipt>({
          action: "create-interactive",
          title: "持续记录",
          interactive: { ...emptyInteractive, rows: rows(205) },
        });
        const operations = await f.host.call<{
          operations: Array<{ id: string }>;
        }>({
          action: "operations",
          operations: { action: "list", domain: "table" },
        });
        assert.deepEqual(operations.operations.map((op) => op.id).sort(), [
          "table.create",
          "table.patch",
          "table.query",
          "table.revise",
        ]);
        const described = await f.host.call<{
          operation: {
            parameters: {
              properties: {
                limit: { maximum: number };
                rowCursor: { maxLength: number };
              };
            };
          };
        }>({
          action: "operations",
          operations: { action: "describe", operationId: "table.query" },
        });
        assert.equal(
          described.operation.parameters.properties.limit.maximum,
          100,
        );
        assert.equal(
          described.operation.parameters.properties.rowCursor.maxLength,
          8192,
        );
        // The old read path used readObject(full rows). This guard proves both
        // Agent row entrypoints use the production relational page query instead.
        t.mock.method(f.host.domains.content.objects, "readObject", () => {
          throw new Error(
            "Agent row page must not materialize the full original",
          );
        });
        const first = await f.host.call<InteractiveRowsPage>({
          action: "operations",
          operations: {
            action: "invoke",
            operationId: "table.query",
            parameters: {
              artifactId: original.contentId,
              query: "记录",
              rowSort: { columnId: "value", descending: true },
              limit: 3,
            },
          },
        });
        assert.equal(first.revision, 1);
        assert.equal(first.headRevision, 1);
        assert.equal(first.total, 205);
        assert.equal(first.matched, 205);
        assert.deepEqual(
          first.rows.map((row) => row.id),
          ["row_204", "row_203", "row_202"],
        );
        assert.deepEqual(first.summaries, [
          { id: "value", title: "数值", count: 205, sum: 20910, mean: 102 },
        ]);
        assert.ok(first.nextCursor);
        const read = await f.host.call<{
          interactive: typeof emptyInteractive;
          rowOffset: number;
          totalRows: number;
          hasMoreRows: boolean;
          textScope: string;
          text: string;
          totalCharacters?: number;
        }>({
          action: "read",
          artifactId: original.contentId,
          rowOffset: 110,
          limit: 24000,
        });
        assert.equal(read.rowOffset, 110);
        assert.equal(read.totalRows, 205);
        assert.equal(read.hasMoreRows, true);
        assert.equal(read.interactive.rows.length, 50);
        assert.equal(read.interactive.rows[0]!.id, "row_110");
        assert.equal(read.interactive.rows.at(-1)!.id, "row_159");
        assert.equal(read.textScope, "row-page");
        assert.equal(
          read.totalCharacters,
          undefined,
          "Page size is not passed off as full-table length",
        );
        assert.ok(!read.text.includes("记录 204"));
        const patch = f.host.envelope({
          action: "operations",
          operations: {
            action: "invoke",
            operationId: "table.patch",
            parameters: {
              artifactId: original.contentId,
              revision: 1,
              rowOperations: [
                {
                  type: "update",
                  rowId: "row_204",
                  cells: { value: 777 },
                  unset: ["done"],
                },
                { type: "delete", rowId: "row_0" },
                {
                  type: "insert",
                  row: {
                    id: "inserted",
                    cells: { name: "新记录", value: 100 },
                  },
                  beforeRowId: "row_1",
                },
              ],
            },
          },
        });
        const committed = (await f.host.tools.call(patch)) as Receipt;
        assert.equal(committed.contentId, original.contentId);
        assert.equal(committed.versionRef, "2");
        assert.ok(committed.receipt);
        assert.deepEqual(
          await f.host.tools.call(patch),
          committed,
          "Same actual tool call returns its durable receipt",
        );
        const next = await f.host.call<InteractiveRowsPage>({
          action: "query-interactive",
          artifactId: original.contentId,
          query: "记录",
          rowSort: { columnId: "value", descending: true },
          rowCursor: first.nextCursor!,
          limit: 3,
        });
        assert.equal(
          next.revision,
          1,
          "Cursor stays on its accepted version after a current-head edit",
        );
        assert.equal(next.headRevision, 2);
        assert.deepEqual(
          next.rows.map((row) => row.id),
          ["row_201", "row_200", "row_199"],
        );
        const current = await f.host.call<InteractiveRowsPage>({
          action: "query-interactive",
          artifactId: original.contentId,
          rowSort: { columnId: "value", descending: true },
          limit: 1,
        });
        assert.equal(current.rows[0]!.cells.value, 777);
        assert.equal(Object.hasOwn(current.rows[0]!.cells, "done"), false);
        assert.equal(current.total, 205);
        assert.equal(current.summaries[0]!.sum, 21583);
        const restored = await f.host.call<Receipt>({
          action: "patch-interactive",
          artifactId: original.contentId,
          revision: 2,
          rowOperations: [
            {
              type: "restore",
              rowId: "row_0",
              fromRevision: 1,
              beforeRowId: "inserted",
            },
          ],
        });
        assert.equal(restored.versionRef, "3");
        const catalog = await f.host.withHuman((actor) =>
          f.host.domains.content.platform.content(actor, original.contentId),
        );
        assert.equal(
          catalog.observed_version_ref,
          "3",
          "App receipt updates only the directory projection",
        );
        assert.deepEqual(
          await f.host.domains.content.objects.pendingDirectoryEvents(
            f.host.transport.identity(),
          ),
          [],
        );
        await assert.rejects(
          f.host.call({
            action: "patch-interactive",
            artifactId: original.contentId,
            revision: 1,
            rowOperations: [{ type: "delete", rowId: "row_2" }],
          }),
          /已变化|版本/,
        );
        await f.host.reopen();
        assert.deepEqual(
          await f.host.tools.call(patch),
          committed,
          "Receipt survives cold domain reopen without replaying edits",
        );
        const exact = await f.host.call<InteractiveRowsPage>({
          action: "query-interactive",
          artifactId: original.contentId,
          revision: 1,
          limit: 1,
        });
        assert.equal(exact.revision, 1);
        assert.equal(exact.headRevision, 3);
        assert.equal(exact.rows[0]!.id, "row_0");
        const head = await f.host.call<InteractiveRowsPage>({
          action: "query-interactive",
          artifactId: original.contentId,
          limit: 2,
        });
        assert.equal(head.total, 206);
        assert.deepEqual(
          head.rows.map((row) => row.id),
          ["row_0", "inserted"],
        );
        const empty = await f.host.call<InteractiveRowsPage>({
          action: "query-interactive",
          artifactId: original.contentId,
          query: "不存在的过滤",
          limit: 10,
        });
        assert.equal(empty.matched, 0);
        assert.deepEqual(empty.rows, []);
        assert.equal(empty.nextCursor, null);
        f.host.assertNoLegacyData();
      } finally {
        await f.close();
      }
    },
  );

  test(
    `${backend}: Agent 表格操作拒绝越权、跨域、陈旧版本与伪造来源`,
    { skip: backend === "postgres" && !postgresUrl },
    async () => {
      const f = await fixture(backend);
      try {
        const original = await f.host.call<Receipt>({
          action: "create-interactive",
          title: "权限原件",
          interactive: { ...emptyInteractive, rows: rows(4) },
        });
        const second = await f.host.call<Receipt>({
          action: "create-interactive",
          title: "另一原件",
          interactive: { ...emptyInteractive, rows: rows(4) },
        });
        const document = await f.host.call<Receipt>({
          action: "create-document",
          title: "不是表格",
          markdown: "# 正文",
        });
        const script = await f.host.withHuman((actor) =>
          createScriptProduction({
            ...f.host.domains.content,
            actor,
            instanceId: f.host.domains.content.instanceIds.scriptStudio,
            commandId: randomUUID(),
            productionId: randomUUID(),
            projectId: f.host.projectId,
            title: "另一应用原件",
          }),
        );
        for (const contentId of [document.contentId, script.contentId])
          for (const action of ["query-interactive", "patch-interactive"])
            await assert.rejects(
              f.host.call({
                action,
                artifactId: contentId,
                revision: 1,
                ...(action === "patch-interactive"
                  ? { rowOperations: [{ type: "delete", rowId: "row_0" }] }
                  : {}),
              }),
              /不属于当前表格/,
            );
        await f.host.withHuman((actor) =>
          f.host.domains.work.service.createProject(actor, {
            commandId: randomUUID(),
            projectId: "other-table-project",
            title: "另一个项目",
          }),
        );
        const otherRoute = f.host.input("other-table-project");
        const external = await f.host.call<Receipt>(
          {
            action: "create-interactive",
            title: "项目外原件",
            interactive: { ...emptyInteractive, rows: rows(4) },
          },
          otherRoute,
        );
        for (const action of ["query-interactive", "patch-interactive"])
          await assert.rejects(
            f.host.call({
              action,
              artifactId: external.contentId,
              revision: 1,
              ...(action === "patch-interactive"
                ? { rowOperations: [{ type: "delete", rowId: "row_0" }] }
                : {}),
            }),
            /超出原始输入的项目范围/,
          );
        const page = await f.host.call<InteractiveRowsPage>({
          action: "query-interactive",
          artifactId: original.contentId,
          limit: 1,
        });
        assert.ok(page.nextCursor);
        for (const args of [
          { artifactId: second.contentId, rowCursor: page.nextCursor },
          {
            artifactId: original.contentId,
            rowCursor: page.nextCursor,
            query: "记录",
          },
          {
            artifactId: original.contentId,
            rowCursor: page.nextCursor,
            rowSort: { columnId: "value", descending: true },
          },
          {
            artifactId: original.contentId,
            rowCursor: page.nextCursor,
            revision: 99,
          },
        ])
          await assert.rejects(
            f.host.call({ action: "query-interactive", ...args }),
            /游标.*不符/,
          );
        await assert.rejects(
          f.host.call({
            action: "query-interactive",
            artifactId: original.contentId,
            rowSort: { columnId: "unknown", descending: false },
          }),
          /字段|排序/,
        );
        await assert.rejects(
          f.host.call({
            action: "query-interactive",
            artifactId: original.contentId,
            limit: 101,
          }),
          /最多 100/,
        );
        await assert.rejects(
          f.host.call({
            action: "operations",
            operations: {
              action: "invoke",
              operationId: "table.query",
              parameters: { artifactId: original.contentId, limit: 101 },
            },
          }),
        );
        await assert.rejects(
          f.host.call({
            action: "query-interactive",
            artifactId: original.contentId,
            query: "x".repeat(501),
          }),
        );
        await assert.rejects(
          f.host.call({
            action: "query-interactive",
            artifactId: original.contentId,
            rowCursor: "x".repeat(8193),
          }),
        );
        for (const rowOperations of [
          [],
          Array.from({ length: 101 }, () => ({
            type: "delete",
            rowId: "row_0",
          })),
          [{ type: "update", rowId: "row_0", cells: {}, unset: [] }],
          [
            {
              type: "update",
              rowId: "row_0",
              cells: { name: "changed" },
              unset: ["name"],
            },
          ],
        ])
          await assert.rejects(
            f.host.call({
              action: "patch-interactive",
              artifactId: original.contentId,
              revision: 1,
              rowOperations,
            }),
          );
        for (const rowOperations of [
          [
            { type: "update", rowId: "row_0", cells: { name: "合法修改" } },
            {
              type: "insert",
              row: { id: "row_1", cells: { name: "重复 ID" } },
            },
          ],
          [{ type: "update", rowId: "row_0", cells: { value: "错误类型" } }],
          [{ type: "update", rowId: "row_0", cells: { unknown: true } }],
          [{ type: "delete", rowId: "not-found" }],
        ])
          await assert.rejects(
            f.host.call({
              action: "patch-interactive",
              artifactId: original.contentId,
              revision: 1,
              rowOperations,
            }),
          );
        const preserved = await f.host.call<InteractiveRowsPage>({
          action: "query-interactive",
          artifactId: original.contentId,
          limit: 4,
        });
        assert.equal(preserved.headRevision, 1);
        assert.deepEqual(
          preserved.rows,
          rows(4),
          "Invalid batch never partially modifies rows",
        );
        const accepted = f.host.envelope({
          action: "patch-interactive",
          artifactId: original.contentId,
          revision: 1,
          rowOperations: [
            { type: "update", rowId: "row_0", cells: { value: 99 } },
          ],
        });
        const receipt = await f.host.tools.call(accepted);
        await assert.rejects(
          async () =>
            f.host.tools.call({
              ...accepted,
              arguments: {
                action: "patch-interactive",
                artifactId: original.contentId,
                revision: 1,
                rowOperations: [{ type: "delete", rowId: "row_0" }],
              },
            }),
          /幂等|相同|命令|请求|重复/,
        );
        await assert.rejects(
          f.host.call(
            { action: "query-interactive", artifactId: original.contentId },
            { ...f.host.route, principal_id: "forged-runtime-principal" },
          ),
          /未绑定到可验证的原始应用输入/,
        );
        await f.host.identity!.replaceConfiguration(
          {
            version: 1,
            members: [localAccess, other].map((human) => ({
              ...human,
              enabled: human.principalId !== localAccess.principalId,
              loginTokenHash: createHash("sha256")
                .update(`synthetic-login-${human.principalId}`)
                .digest("hex"),
            })),
          },
          [
            { ...localAccess, enabled: false, projectIds: [] },
            { ...other, enabled: true, projectIds: [] },
          ],
        );
        await assert.rejects(
          f.host.call({
            action: "query-interactive",
            artifactId: original.contentId,
            revision: 1,
            rowCursor: page.nextCursor!,
          }),
          /身份|停用|权限|请求|不可用/,
        );
        await assert.rejects(
          async () => f.host.tools.call(accepted),
          /身份|停用|权限|请求|不可用/,
          "Even receipt replay rechecks the current initiating Human",
        );
        assert.ok(receipt);
      } finally {
        await f.close();
      }
    },
  );
}
