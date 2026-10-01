import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { emptyScriptDraft } from "../packages/core/src/script-studio.js";
import {
  ScriptStudioStore,
  type ScriptStudioAuthority,
} from "../packages/script-studio/src/store.js";
import { scriptStudioSchemaSql } from "../packages/script-studio/src/schema.js";

test("剧本工作室生产 schema 与评审 SQL 相同", () => {
  assert.equal(
    scriptStudioSchemaSql.trim(),
    readFileSync(
      new URL("../docs/storage-model-v1/script-studio.sql", import.meta.url),
      "utf8",
    ).trim(),
  );
});

test("剧本域不暴露开发样本导入或跳过权限的验证读接口", () => {
  for (const operation of [
    "assertLegacyImportTargetEmpty",
    "importLegacyProduction",
    "importLegacyPreparations",
    "readLegacyProductionForVerification",
    "readLegacyPreparationsForVerification",
  ])
    assert.equal(operation in ScriptStudioStore.prototype, false);
});

const authority: ScriptStudioAuthority = {
  async authorizeCreate({ credential, projectId }) {
    return credential === "alice" && projectId === "project-one"
      ? {
          tenantId: "tenant-one",
          principalId: "alice",
          actantId: "alice",
          kind: "human",
          runtimeInputId: null,
        }
      : null;
  },
  async authorizeObject({ credential, productionId }) {
    const actor = await this.authorizeCreate({
      credential,
      projectId: "project-one",
    });
    return actor && productionId === "production-one"
      ? { ...actor, projectId: "project-one", objectKind: "script" }
      : null;
  },
};

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend} 正式领域创建、确切历史、CAS 与幂等在冷重开后保持一致`,
    { skip: backend === "postgres" && !process.env.MORPHZ_TEST_POSTGRES_URL },
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "morphz-script-storage-"));
      const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
      const schema = `script_storage_${randomUUID().replaceAll("-", "")}`;
      const admin =
        backend === "postgres" ? new Pool({ connectionString }) : null;
      let store: ScriptStudioStore | undefined;
      const open = () =>
        backend === "sqlite"
          ? ScriptStudioStore.sqlite(
              join(directory, "studio.sqlite"),
              authority,
            )
          : ScriptStudioStore.postgres({ connectionString, schema, authority });
      try {
        if (admin) await admin.query(`CREATE SCHEMA "${schema}"`);
        store = await open();
        const create = {
          credential: "alice",
          commandId: "production-created",
          productionId: "production-one",
          requestedProjectId: "project-one",
          title: "渡河",
        };
        const created = await store.createProduction(create);
        assert.deepEqual(await store.createProduction(create), created);
        await store.markDirectoryProjected(created.tenantId, created.eventId);
        const item = await store.createItem({
          credential: "alice",
          commandId: "episode-created",
          productionId: "production-one",
          itemId: "episode-one",
          expectedActivityRevision: 1,
          kind: "episode",
          draft: {
            ...emptyScriptDraft("第一集"),
            sources: [],
            text: "原始正文。",
          },
        });
        assert.equal(item.activityRevision, 2);
        await store.markDirectoryProjected(item.tenantId, item.eventId);
        const revise = {
          credential: "alice",
          commandId: "episode-revised",
          productionId: "production-one",
          itemId: "episode-one",
          expectedRevision: 1,
          draft: {
            ...emptyScriptDraft("第一集"),
            sources: [],
            text: "修订正文。",
          },
        };
        const revised = await store.reviseItem(revise);
        assert.equal(revised.activityRevision, 3);
        assert.deepEqual(await store.reviseItem(revise), revised);
        await store.markDirectoryProjected(revised.tenantId, revised.eventId);
        await assert.rejects(
          store.reviseItem({ ...revise, commandId: "conflicting-revision" }),
          /版本|修订|变化/,
        );
        await assert.rejects(
          store.readProduction({
            credential: "other-tenant",
            productionId: "production-one",
          }),
          /权限|无权/,
        );
        const before = await store.readProduction({
          credential: "alice",
          productionId: "production-one",
        });
        assert.equal(before.activityRevision, 3);
        assert.deepEqual(
          before.items[0]!.versions.map((version) => version.draft.text),
          ["原始正文。", "修订正文。"],
        );
        await store.close();
        store = await open();
        assert.deepEqual(
          await store.readProduction({
            credential: "alice",
            productionId: "production-one",
          }),
          before,
        );
        assert.deepEqual(await store.createProduction(create), created);
        assert.deepEqual(await store.reviseItem(revise), revised);
        const historical = await store.readItemVersion({
          credential: "alice",
          productionId: "production-one",
          itemId: "episode-one",
          revision: 1,
        });
        assert.equal(historical.revision, 1);
        assert.equal(historical.headRevision, 2);
        assert.equal(historical.draft.text, "原始正文。");
        await assert.rejects(
          store.readItemVersion({
            credential: "alice",
            productionId: "production-one",
            itemId: "episode-one",
            revision: 3,
          }),
          /不存在/,
        );
      } finally {
        try {
          await store?.close();
        } finally {
          try {
            if (admin)
              await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          } finally {
            await admin?.end();
            rmSync(directory, { recursive: true, force: true });
          }
        }
      }
    },
  );
}
