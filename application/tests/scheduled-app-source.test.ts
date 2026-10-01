import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { emptyScriptDraft } from "../packages/core/src/script-studio.js";
import {
  projectPendingDocumentDirectory,
  platformObjectsAuthority,
} from "../packages/application/src/document-service.js";
import {
  createScriptItem,
  platformScriptStudioAuthority,
  projectPendingScriptDirectory,
} from "../packages/application/src/script-production-service.js";
import { ObjectsStore } from "../packages/objects/src/store.js";
import { ScriptStudioStore } from "../packages/script-studio/src/store.js";
import {
  PlatformStore,
  type PlatformAuthorityVerifier,
} from "../packages/platform/src/store.js";
import type { TaskRunAdmission } from "../packages/platform/src/task-run-admission.js";

function authority(state: {
  admission: TaskRunAdmission | null;
  taskCredentialValid: boolean;
  objects: ObjectsStore | null;
  studio: ScriptStudioStore | null;
}): PlatformAuthorityVerifier {
  return {
    async resolveActor({ credential }) {
      if (credential === "human")
        return {
          tenantId: "tenant-one",
          principalId: "alice",
          actantId: "alice",
          kind: "human",
          runtimeInputId: null,
        };
      if (
        credential !== "task" ||
        !state.taskCredentialValid ||
        !state.admission
      )
        return null;
      return {
        tenantId: "tenant-one",
        principalId: "alice",
        actantId: "agent-one",
        kind: "agent",
        runtimeInputId: null,
        initiatingHumanActantId: "alice",
        scopeProjectId: state.admission.projectId,
        runtimeTaskRun: {
          sessionId: state.admission.sessionId,
          scheduleId: state.admission.request.id,
          eventId: state.admission.eventId,
        },
      };
    },
    async resolveActant({ actantId }) {
      if (actantId === "agent-one")
        return { principalId: "morphz-service", kind: "agent" };
      if (actantId === "alice") return { principalId: "alice", kind: "human" };
      return null;
    },
    async resolveProjectAgent() {
      return { principalId: "morphz-service", actantId: "agent-one" };
    },
    async verifyApplicationObject(request) {
      if (request.proof !== request.receiptId) return false;
      if (request.instanceId === "objects-one" && state.objects)
        return state.objects.verifyCommittedDocument({
          ...request,
          objectId: request.objectId,
        });
      if (request.instanceId === "studio-one" && state.studio)
        return (
          (await state.studio.verifyCommittedProduction({
            ...request,
            productionId: request.objectId,
          })) ||
          (await state.studio.verifyCommittedItemCreation({
            ...request,
            productionId: request.objectId,
          }))
        );
      return false;
    },
  };
}

async function exercise(
  platform: PlatformStore,
  objects: ObjectsStore,
  studio: ScriptStudioStore,
  state: {
    admission: TaskRunAdmission | null;
    taskCredentialValid: boolean;
  },
) {
  await platform.provisionTenant("tenant-one");
  await platform.createProject(
    { credential: "human" },
    {
      commandId: "create-project",
      projectId: "project-one",
      title: "创作项目",
    },
  );
  await platform.createTask(
    { credential: "human" },
    {
      commandId: "create-task",
      taskId: "task-one",
      projectId: "project-one",
      title: "创作事项",
      assigneeId: "agent-one",
    },
  );
  await platform.registerApplication("tenant-one", {
    appId: "morphz.objects",
    installationId: "objects-install",
    instanceId: "objects-one",
    routeKind: "service",
    routeRef: "test:objects",
  });
  await platform.registerApplication("tenant-one", {
    appId: "morphz.script-studio",
    installationId: "studio-install",
    instanceId: "studio-one",
    routeKind: "service",
    routeRef: "test:studio",
  });
  state.admission = await platform.requestTaskRun(
    { credential: "human" },
    {
      commandId: "start-task",
      taskId: "task-one",
      expectedRevision: 1,
      sessionId: "task-session",
      intent: "创建内容",
      notBefore: "2026-09-26T00:00:00.000Z",
    },
  );
  const originalDocument = await objects.createDocument({
    credential: "task",
    commandId: "document-command",
    objectId: "document-one",
    requestedProjectId: "project-one",
    title: "后台文档",
    markdown: "# 正文",
  });
  const originalScript = await studio.createProduction({
    credential: "task",
    commandId: "script-command",
    productionId: "script-one",
    requestedProjectId: "project-one",
    title: "后台剧本",
  });
  assert.equal(
    (await objects.pendingDirectoryEvents("tenant-one"))[0]
      ?.runtimeTaskRunEventId,
    state.admission.eventId,
  );
  assert.equal(
    (await studio.pendingDirectoryEvents("tenant-one"))[0]?.task_run_event_id,
    state.admission.eventId,
  );
  assert.equal(
    await objects.verifyCommittedDocument({
      tenantId: "tenant-one",
      principalId: "alice",
      actantId: "agent-one",
      runtimeInputId: null,
      runtimeTaskRunEventId: "different-task",
      objectId: originalDocument.objectId,
      projectId: "project-one",
      kind: "document",
      title: originalDocument.title,
      versionRef: "1",
      receiptId: originalDocument.receiptId,
    }),
    false,
  );
  assert.equal(
    await studio.verifyCommittedProduction({
      tenantId: "tenant-one",
      principalId: "alice",
      actantId: "agent-one",
      runtimeInputId: null,
      runtimeTaskRunEventId: "different-task",
      productionId: originalScript.productionId,
      projectId: "project-one",
      title: originalScript.title,
      versionRef: "1",
      receiptId: originalScript.receiptId,
    }),
    false,
  );
  state.taskCredentialValid = false;
  assert.equal(
    (
      await projectPendingDocumentDirectory({
        platform,
        objects,
        tenantId: "tenant-one",
        instanceId: "objects-one",
      })
    ).projected,
    1,
  );
  assert.equal(
    (
      await projectPendingScriptDirectory({
        platform,
        studio,
        tenantId: "tenant-one",
        instanceId: "studio-one",
      })
    ).projected,
    1,
  );
  state.taskCredentialValid = true;
  assert.equal(
    (
      await objects.createDocument({
        credential: "task",
        commandId: "document-command",
        objectId: "document-one",
        requestedProjectId: "project-one",
        title: "后台文档",
        markdown: "# 正文",
      })
    ).receiptId,
    originalDocument.receiptId,
  );
  assert.equal(
    (
      await studio.createProduction({
        credential: "task",
        commandId: "script-command",
        productionId: "script-one",
        requestedProjectId: "project-one",
        title: "后台剧本",
      })
    ).receiptId,
    originalScript.receiptId,
  );
  const { sources: _sources, ...draft } = emptyScriptDraft("第一集");
  const item = await createScriptItem({
    platform,
    studio,
    actor: { credential: "task" },
    instanceId: "studio-one",
    commandId: "item-command",
    productionId: "script-one",
    itemId: "episode-one",
    expectedActivityRevision: 1,
    kind: "episode",
    draft: { ...draft, sources: [] },
  });
  assert.equal(item.original.itemRevision, 1);
  const catalog = await platform.listContent(
    { credential: "human" },
    { projectId: "project-one" },
  );
  assert.deepEqual(
    catalog.map((row) => [row.kind, row.observed_version_ref]).sort(),
    [
      ["document", "1"],
      ["script", "2"],
    ],
  );
}

test("SQLite 后台事项无聊天输入仍可提交应用原件并从回执恢复目录", async () => {
  const state = {
    admission: null as TaskRunAdmission | null,
    taskCredentialValid: true,
    objects: null as ObjectsStore | null,
    studio: null as ScriptStudioStore | null,
  };
  const platform = await PlatformStore.sqlite(":memory:", authority(state));
  try {
    state.objects = await ObjectsStore.sqlite(
      ":memory:",
      platformObjectsAuthority(platform, "objects-one", () => ({
        routeKind: "service",
        routeRef: "test:objects",
      })),
    );
    state.studio = await ScriptStudioStore.sqlite(
      ":memory:",
      platformScriptStudioAuthority(platform, "studio-one", () => ({
        routeKind: "service",
        routeRef: "test:studio",
      })),
    );
    await exercise(platform, state.objects, state.studio, state);
  } finally {
    await state.studio?.close();
    await state.objects?.close();
    await platform.close();
  }
});

test(
  "PostgreSQL 后台事项跨隔离 schema 保留同一来源及恢复语义",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const suffix = randomUUID().replaceAll("-", "");
    const schemas = ["platform", "objects", "studio"].map(
      (name) => `${name}_${suffix}`,
    );
    const admin = new Pool({ connectionString });
    const state = {
      admission: null as TaskRunAdmission | null,
      taskCredentialValid: true,
      objects: null as ObjectsStore | null,
      studio: null as ScriptStudioStore | null,
    };
    let platform: PlatformStore | undefined;
    try {
      for (const schema of schemas)
        await admin.query(`CREATE SCHEMA "${schema}"`);
      platform = await PlatformStore.postgres(
        { connectionString, schema: schemas[0]! },
        authority(state),
      );
      state.objects = await ObjectsStore.postgres({
        connectionString,
        schema: schemas[1]!,
        authority: platformObjectsAuthority(platform, "objects-one", () => ({
          routeKind: "service",
          routeRef: "test:objects",
        })),
      });
      state.studio = await ScriptStudioStore.postgres({
        connectionString,
        schema: schemas[2]!,
        authority: platformScriptStudioAuthority(
          platform,
          "studio-one",
          () => ({ routeKind: "service", routeRef: "test:studio" }),
        ),
      });
      await exercise(platform, state.objects, state.studio, state);
    } finally {
      await state.studio?.close();
      await state.objects?.close();
      await platform?.close();
      for (const schema of schemas)
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
