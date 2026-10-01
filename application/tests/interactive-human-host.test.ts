import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer as createPortServer } from "node:net";
import { Pool } from "pg";
import { createAppServer } from "../apps/service/src/http.js";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { Application } from "../packages/application/src/application.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import {
  emptyInteractive,
  interactiveRowOperationSchema,
  interactiveRowsQuerySchema,
} from "../packages/core/src/interactive.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";

const postgresUrl = process.env.MORPHZ_TEST_POSTGRES_URL;

for (const backend of ["sqlite", "postgres"] as const)
  test(
    `${backend}: Human 本地和 HTTP 查询、局部修改共享原件、版本与回执`,
    { skip: backend === "postgres" && !postgresUrl },
    async () => {
      const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
      const schemas = {
        platform: `ip_${suffix}`,
        objects: `io_${suffix}`,
        scriptStudio: `is_${suffix}`,
        reader: `ir_${suffix}`,
        browser: `ib_${suffix}`,
      };
      const admin =
        backend === "postgres"
          ? new Pool({ connectionString: postgresUrl })
          : undefined;
      let fixture: Awaited<ReturnType<typeof agentDomainFixture>> | undefined;
      let server: ReturnType<typeof createAppServer> | undefined;
      let local: LocalApplicationConnection | undefined;
      try {
        if (admin)
          for (const schema of Object.values(schemas))
            await admin.query(`CREATE SCHEMA "${schema}"`);
        fixture = await agentDomainFixture({
          ...(admin
            ? {
                storage: {
                  platform: {
                    kind: "postgres" as const,
                    connectionString: postgresUrl!,
                    schema: schemas.platform,
                  },
                  applications: {
                    connectionStrings: {
                      objects: postgresUrl!,
                      scriptStudio: postgresUrl!,
                      reader: postgresUrl!,
                      browser: postgresUrl!,
                    },
                    deploymentId: `interactive_human_${suffix}`,
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
        const options = () => ({
          platformWork: fixture!.domains.work,
          platformDocuments: fixture!.domains.content,
        });
        local = new LocalApplicationConnection(
          new Application(fixture.transport, options()),
        );
        const localClient = await PlatformClient.connect(local);
        const probe = createPortServer();
        await new Promise<void>((resolve) =>
          probe.listen(0, "127.0.0.1", resolve),
        );
        const port = (probe.address() as { port: number }).port;
        await new Promise<void>((resolve) => probe.close(() => resolve()));
        server = createAppServer(fixture.transport, {
          ...options(),
          port,
          webRoot: "/nonexistent",
        });
        await new Promise<void>((resolve) =>
          server!.listen(port, "127.0.0.1", resolve),
        );
        const origin = `http://127.0.0.1:${port}`;
        const remoteClient = await PlatformClient.connect(
          new HttpApplicationClient(origin),
        );
        const created = (await localClient.createInteractive({
          commandId: randomUUID(),
          objectId: `table_${suffix}`,
          projectId: fixture.projectId,
          title: "真实按行接口",
          content: {
            ...emptyInteractive,
            rows: Array.from({ length: 60 }, (_, i) => ({
              id: `row_${i}`,
              cells: { name: `记录_${i}`, value: i, done: i % 2 === 0 },
            })),
          },
        })) as { contentId: string };
        const query = {
          sort: { columnId: "value", descending: true },
          limit: 7,
        };
        const page = await remoteClient.queryInteractiveRows(
          created.contentId,
          query,
        );
        assert.equal(page.total, 60);
        assert.equal(page.matched, 60);
        assert.deepEqual(
          page.rows.map((row) => row.id),
          [59, 58, 57, 56, 55, 54, 53].map((id) => `row_${id}`),
        );
        assert.equal(page.summaries[0]!.count, 60);
        assert.equal(page.summaries[0]!.sum, 1770);
        assert.ok(page.nextCursor);
        assert.deepEqual(
          await localClient.queryInteractiveRows(created.contentId, query),
          page,
        );
        const patch = {
          commandId: randomUUID(),
          contentId: created.contentId,
          expectedRevision: 1,
          operations: [
            {
              type: "update" as const,
              rowId: "row_59",
              cells: { value: 0, done: false },
            },
            { type: "delete" as const, rowId: "row_0" },
            {
              type: "insert" as const,
              row: {
                id: "new_row",
                cells: { name: "新增", value: null, done: false },
              },
              beforeRowId: "row_1",
            },
          ],
        };
        const committed = (await remoteClient.patchInteractiveRows(patch)) as {
          contentId: string;
          versionRef: string;
          receiptId: string;
        };
        assert.equal(committed.versionRef, "2");
        assert.ok(committed.receiptId);
        assert.deepEqual(
          await localClient.patchInteractiveRows(patch),
          committed,
        );
        await assert.rejects(
          localClient.patchInteractiveRows({
            ...patch,
            commandId: randomUUID(),
          }),
          /已变化|版本|修订/,
        );
        await assert.rejects(
          remoteClient.patchInteractiveRows({
            ...patch,
            operations: [{ type: "delete", rowId: "row_1" }],
          }),
          /命令|参数|重复|不一致/,
        );

        // The previous cursor is pinned to v1, even after v2 changes its sort keys.
        const nextOld = await remoteClient.queryInteractiveRows(
          created.contentId,
          {
            ...query,
            after: page.nextCursor!,
          },
        );
        assert.equal(nextOld.revision, 1);
        assert.equal(nextOld.headRevision, 2);
        assert.deepEqual(
          nextOld.rows.map((row) => row.id),
          [52, 51, 50, 49, 48, 47, 46].map((id) => `row_${id}`),
        );
        await assert.rejects(
          remoteClient.queryInteractiveRows(created.contentId, {
            ...query,
            after: page.nextCursor!,
            query: "偷换过滤条件",
          }),
          /游标|查询|分页/,
        );
        const filtered = await localClient.queryInteractiveRows(
          created.contentId,
          {
            query: "新增",
            limit: 1,
          },
        );
        assert.equal(filtered.revision, 2);
        assert.equal(filtered.matched, 1);
        assert.deepEqual(filtered.rows[0]!.cells, {
          name: "新增",
          value: null,
          done: false,
        });
        assert.equal(filtered.summaries[0]!.count, 0);
        const restored = (await localClient.patchInteractiveRows({
          commandId: randomUUID(),
          contentId: created.contentId,
          expectedRevision: 2,
          operations: [
            {
              type: "restore",
              rowId: "row_0",
              fromRevision: 1,
              beforeRowId: "new_row",
            },
          ],
        })) as { versionRef: string };
        assert.equal(restored.versionRef, "3");
        const restoredPage = await remoteClient.queryInteractiveRows(
          created.contentId,
          { limit: 3 },
        );
        assert.equal(restoredPage.total, 61);
        assert.deepEqual(
          restoredPage.rows.map((row) => row.id),
          ["row_0", "new_row", "row_1"],
        );
        assert.deepEqual(restoredPage.rows[0]!.cells, {
          name: "记录_0",
          value: 0,
          done: true,
        });
        await assert.rejects(
          localClient.patchInteractiveRows({
            commandId: randomUUID(),
            contentId: created.contentId,
            expectedRevision: 3,
            operations: [
              { type: "update", rowId: "row_0", cells: {}, unset: ["name"] },
            ],
          }),
          (error: unknown) =>
            error instanceof Error && "status" in error && error.status === 400,
        );
        assert.equal(
          (await remoteClient.queryInteractiveRows(created.contentId)).revision,
          3,
        );
        const noToken = await fetch(`${origin}/api/platform/interactive/rows`, {
          method: "POST",
          headers: { Origin: origin, "Content-Type": "application/json" },
          body: JSON.stringify({ contentId: created.contentId }),
        });
        assert.equal(noToken.status, 403);
        const wrongKind = (await localClient.createDocument({
          commandId: randomUUID(),
          objectId: `doc_${suffix}`,
          projectId: fixture.projectId,
          title: "非表格",
          markdown: "不是表格原件",
        })) as { contentId: string };
        await assert.rejects(
          localClient.queryInteractiveRows(wrongKind.contentId),
          /不是交互表格/,
        );

        server.closeAllConnections();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = undefined;
        local.close();
        local = undefined;
        await fixture.reopen();
        local = new LocalApplicationConnection(
          new Application(fixture.transport, options()),
        );
        const reopened = await PlatformClient.connect(local);
        assert.deepEqual(
          await reopened.queryInteractiveRows(created.contentId, { limit: 3 }),
          restoredPage,
        );
        const catalog = await fixture.withHuman((actor) =>
          fixture!.domains.content.platform.content(actor, created.contentId),
        );
        assert.equal(catalog.observed_version_ref, "3");
        fixture.assertNoLegacyData();
      } finally {
        local?.close();
        if (server) {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server!.close(() => resolve()));
        }
        await fixture?.close();
        if (admin) {
          try {
            for (const schema of Object.values(schemas))
              await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          } finally {
            await admin.end();
          }
        }
      }
    },
  );

test("表格局部操作契约拒绝空更新、字段冲突和无界请求", () => {
  for (const value of [
    { type: "update", rowId: "one", cells: {} },
    { type: "update", rowId: "one", cells: { name: "改名" }, unset: ["name"] },
    { type: "update", rowId: "one", cells: {}, unset: ["name", "name"] },
    { type: "restore", rowId: "one", fromRevision: 0 },
  ])
    assert.equal(interactiveRowOperationSchema.safeParse(value).success, false);
  for (const value of [
    { limit: 101 },
    { query: "x".repeat(501) },
    { after: "x".repeat(8193) },
  ])
    assert.equal(interactiveRowsQuerySchema.safeParse(value).success, false);
  assert.equal(
    interactiveRowOperationSchema.safeParse({
      type: "update",
      rowId: "one",
      cells: { value: 0, done: false, name: "" },
    }).success,
    true,
  );
});
