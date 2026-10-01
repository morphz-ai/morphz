import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import {
  createDocument,
  createInteractive,
  listObjectVersions,
  platformObjectsAuthority,
  projectPendingDocumentDirectory,
  readDocument,
  renameObject,
  reviseDocument,
  reviseInteractive,
} from "../packages/application/src/document-service.js";
import { emptyInteractive } from "../packages/core/src/interactive.js";
import { ObjectsStore } from "../packages/objects/src/store.js";
import {
  PlatformStore,
  type PlatformAuthorityVerifier,
} from "../packages/platform/src/store.js";

function fixtureAuthority(
  objects: () => ObjectsStore,
  proofReady: () => boolean,
  credentialReady: () => boolean = () => true,
): PlatformAuthorityVerifier {
  return {
    async resolveActor({ credential }) {
      if (!credentialReady()) return null;
      if (credential === "alice")
        return {
          tenantId: "tenant-one",
          principalId: "alice",
          actantId: "alice",
          kind: "human",
          runtimeInputId: null,
        };
      if (credential === "agent-input")
        return {
          tenantId: "tenant-one",
          principalId: "alice",
          actantId: "agent-one",
          kind: "agent",
          runtimeInputId: "input-one",
          scopeProjectId: "project-one",
        };
      if (credential === "agent-without-input")
        return {
          tenantId: "tenant-one",
          principalId: "alice",
          actantId: "agent-one",
          kind: "agent",
          runtimeInputId: null,
          scopeProjectId: "project-one",
        };
      if (credential === "bob")
        return {
          tenantId: "tenant-one",
          principalId: "bob",
          actantId: "bob",
          kind: "human",
          runtimeInputId: null,
        };
      return null;
    },
    async resolveActant({ actantId }) {
      return actantId === "agent-one"
        ? { principalId: "morphz-service", kind: "agent" }
        : null;
    },
    async resolveProjectAgent() {
      return { principalId: "morphz-service", actantId: "agent-one" };
    },
    async verifyApplicationObject(request) {
      if (
        !proofReady() ||
        request.instanceId !== "objects-one" ||
        request.proof !== request.receiptId
      )
        return false;
      const proof = {
        tenantId: request.tenantId,
        principalId: request.principalId,
        actantId: request.actantId,
        runtimeInputId: request.runtimeInputId,
        runtimeTaskRunEventId: request.runtimeTaskRunEventId,
        objectId: request.objectId,
        projectId: request.projectId,
        kind: request.kind,
        title: request.title,
        versionRef: request.versionRef,
        receiptId: request.receiptId,
      };
      return (
        (await objects().verifyCommittedRename(proof)) ||
        (request.kind === "document" &&
          (await objects().verifyCommittedDocument(proof))) ||
        (request.kind === "interactive" &&
          (await objects().verifyCommittedInteractive(proof)))
      );
    },
  };
}

async function exercise(
  platform: PlatformStore,
  objects: ObjectsStore,
  setProofReady: (ready: boolean) => void,
  setCredentialReady: (ready: boolean) => void,
) {
  await platform.provisionTenant("tenant-one");
  await platform.createProject(
    { credential: "alice" },
    {
      commandId: "create-project-one",
      projectId: "project-one",
      title: "写作项目",
    },
  );
  await platform.createProject(
    { credential: "alice" },
    {
      commandId: "create-project-two",
      projectId: "project-two",
      title: "另一个项目",
    },
  );
  const create = {
    platform,
    objects,
    actor: { credential: "alice" },
    instanceId: "objects-one",
    commandId: "create-document-one",
    objectId: "document-one",
    projectId: "project-one",
    title: "初稿",
    markdown: "# 初稿\n正文一",
  };
  await assert.rejects(createDocument(create), /应用实例不可用/);
  assert.deepEqual(await objects.pendingDirectoryEvents("tenant-one"), []);
  await platform.registerApplication("tenant-one", {
    appId: "morphz.objects",
    installationId: "install-objects-one",
    instanceId: "objects-one",
    routeKind: "service",
    routeRef: "test:objects-one",
  });
  await assert.rejects(
    platform.authorizeApplicationProject(
      { credential: "alice" },
      "objects-one",
      "morphz.script-studio",
      "project-one",
    ),
    /应用实例与应用类型不符/,
  );

  // The app commit survives a Platform failure; the directory stays empty.
  await assert.rejects(createDocument(create), /应用未确认/);
  assert.equal((await objects.pendingDirectoryEvents("tenant-one")).length, 1);
  setProofReady(true);
  assert.equal(
    await objects.verifyCommittedDocument({
      tenantId: "tenant-one",
      principalId: "alice",
      actantId: "alice",
      runtimeInputId: null,
      objectId: "document-one",
      projectId: "project-two",
      kind: "document",
      title: "初稿",
      versionRef: "1",
      receiptId: create.commandId,
    }),
    false,
  );
  await assert.rejects(
    platform.recordContent(
      { credential: "alice" },
      { instanceId: "objects-one", proof: create.commandId },
      {
        commandId: "forged-document-catalog",
        appReceiptId: create.commandId,
        contentId: "forged-content",
        objectId: "document-one",
        projectId: "project-one",
        kind: "document",
        title: "伪造标题",
        observedVersionRef: "1",
      },
    ),
    /应用未确认/,
  );
  setProofReady(false);
  const unresolved = await projectPendingDocumentDirectory({
    platform,
    objects,
    tenantId: "tenant-one",
    instanceId: "objects-one",
  });
  assert.deepEqual(unresolved.unresolved, [create.commandId]);
  setProofReady(true);
  setCredentialReady(false);
  const recovered = await projectPendingDocumentDirectory({
    platform,
    objects,
    tenantId: "tenant-one",
    instanceId: "objects-one",
  });
  assert.equal(recovered.projected, 1);
  setCredentialReady(true);
  assert.deepEqual(await objects.pendingDirectoryEvents("tenant-one"), []);
  const first = await createDocument(create);
  assert.equal(first.original.versionRef, "1");
  assert.equal(first.original.contentId, null);
  assert.equal(
    (await platform.content({ credential: "alice" }, first.contentId))
      .observed_version_ref,
    "1",
  );
  const firstRead = await readDocument({
    objects,
    actor: { credential: "alice" },
    objectId: "document-one",
  });
  assert.equal(firstRead.content.markdown, create.markdown);
  assert.equal(firstRead.projectId, "project-one");
  assert.equal(firstRead.contentId, first.contentId);
  assert.equal(firstRead.revision, 1);
  const note = {
    credential: "alice",
    commandId: "annotation-command-one",
    objectId: "document-one",
    revision: 1,
    quote: "正文一",
    body: "这一句值得回看",
  };
  const savedNote = await objects.annotateObject(note);
  assert.equal(savedNote.id, note.commandId);
  assert.equal(savedNote.artifactRevision, 1);
  assert.deepEqual(await objects.annotateObject(note), savedNote);
  assert.deepEqual(
    (
      await objects.listObjectAnnotations({
        credential: "alice",
        objectId: "document-one",
      })
    ).map((row) => row.annotation),
    [savedNote],
  );
  assert.deepEqual(
    await objects.listObjectAnnotations({
      credential: "agent-input",
      objectId: "document-one",
    }),
    [{ ordinal: 0, annotation: savedNote }],
  );
  await assert.rejects(
    objects.annotateObject({ ...note, body: "重复 ID 的不同内容" }),
    /相同命令 ID/,
  );
  await assert.rejects(
    objects.annotateObject({
      ...note,
      commandId: "annotation-bad-quote",
      quote: "正文二",
    }),
    /引文/,
  );
  await assert.rejects(
    objects.annotateObject({
      ...note,
      commandId: "annotation-bob",
      credential: "bob",
    }),
    /无权访问这个项目/,
  );
  await assert.rejects(
    objects.listObjectAnnotations({
      credential: "bob",
      objectId: "document-one",
    }),
    /无权访问这个项目/,
  );
  assert.deepEqual(
    (
      await objects.listObjectAnnotations({
        credential: "alice",
        objectId: "document-one",
      })
    ).map((row) => row.annotation),
    [savedNote],
  );
  await assert.rejects(
    readDocument({
      objects,
      actor: { credential: "bob" },
      objectId: "document-one",
    }),
    /无权访问这个项目/,
  );
  assert.equal(
    (
      await readDocument({
        objects,
        actor: { credential: "agent-input" },
        objectId: "document-one",
      })
    ).revision,
    1,
  );
  await assert.rejects(
    createDocument({ ...create, markdown: "另一份正文" }),
    /相同命令 ID/,
  );
  await assert.rejects(
    createDocument({ ...create, commandId: "duplicate-original" }),
    /内容 ID 已存在/,
  );
  await assert.rejects(
    createDocument({
      ...create,
      actor: { credential: "bob" },
      commandId: "bob-create",
      objectId: "bob-document",
    }),
    /无权访问这个项目/,
  );
  await assert.rejects(
    createDocument({
      ...create,
      actor: { credential: "agent-without-input" },
      commandId: "unbound-agent-create",
      objectId: "unbound-document",
    }),
    /已持久化的发起来源/,
  );

  // Revision commits version two, but an unprojected version blocks version
  // three and is recoverable without rewriting version two.
  const revise = {
    platform,
    objects,
    actor: { credential: "alice" },
    instanceId: "objects-one",
    commandId: "revise-document-two",
    objectId: "document-one",
    expectedRevision: 1,
    title: "定稿",
    markdown: "# 定稿\n正文二",
  };
  setProofReady(false);
  await assert.rejects(reviseDocument(revise), /应用未确认/);
  const pendingRead = await readDocument({
    objects,
    actor: { credential: "alice" },
    objectId: "document-one",
  });
  assert.equal(pendingRead.revision, 2);
  assert.equal(pendingRead.observedVersionRef, "1");
  assert.equal(pendingRead.content.markdown, revise.markdown);
  assert.equal(
    (await platform.content({ credential: "alice" }, first.contentId))
      .observed_version_ref,
    "1",
  );
  await assert.rejects(
    reviseDocument({
      ...revise,
      commandId: "revise-document-three",
      expectedRevision: 2,
      markdown: "正文三",
    }),
    /目录尚未确认/,
  );
  setProofReady(true);
  const pendingRevision = await objects.pendingDirectoryEvents("tenant-one");
  assert.equal(pendingRevision.length, 1);
  assert.equal(pendingRevision[0]!.expectedCatalogRevision, 1);
  assert.equal(pendingRevision[0]!.contentId, first.contentId);
  const revisionRecovery = await projectPendingDocumentDirectory({
    platform,
    objects,
    tenantId: "tenant-one",
    instanceId: "objects-one",
  });
  assert.equal(revisionRecovery.projected, 1);
  assert.deepEqual(await objects.pendingDirectoryEvents("tenant-one"), []);
  const second = await reviseDocument(revise);
  assert.equal(second.original.versionRef, "2");
  assert.equal(
    (
      await readDocument({
        objects,
        actor: { credential: "alice" },
        objectId: "document-one",
        revision: 1,
      })
    ).content.markdown,
    create.markdown,
  );
  await assert.rejects(
    readDocument({
      objects,
      actor: { credential: "alice" },
      objectId: "document-one",
      revision: 99,
    }),
    /精确版本不存在/,
  );
  assert.equal(
    (await platform.content({ credential: "alice" }, first.contentId))
      .observed_version_ref,
    "2",
  );
  assert.equal(
    (
      await objects.listObjectVersions({
        credential: "alice",
        objectId: "document-one",
      })
    ).versions.length,
    2,
  );
  await assert.rejects(
    reviseDocument({ ...revise, commandId: "stale-revision" }),
    /目录尚未确认|文档版本已变化/,
  );
  await assert.rejects(
    reviseDocument({
      ...revise,
      actor: { credential: "bob" },
      commandId: "bob-revise",
      expectedRevision: 2,
    }),
    /无权访问这个项目/,
  );
  await assert.rejects(
    platform.authorizeApplicationObject(
      { credential: "agent-input" },
      "objects-one",
      "morphz.objects",
      "missing-document",
    ),
    /内容或应用实例不可用/,
  );
  const movedRevision = await objects.reviseDocument({
    credential: "alice",
    commandId: "revision-before-move",
    objectId: "document-one",
    expectedRevision: 2,
    title: "移动时的修订",
    markdown: "# 第三版",
  });
  assert.equal(movedRevision.expectedCatalogRevision, 2);
  await platform.moveContent(
    { credential: "alice" },
    {
      commandId: "move-document-project-two",
      contentId: first.contentId,
      targetProjectId: "project-two",
      expectedRevision: 2,
    },
  );
  assert.equal(
    await objects.verifyCommittedDocument({
      tenantId: "tenant-one",
      principalId: "alice",
      actantId: "alice",
      runtimeInputId: null,
      objectId: "document-one",
      projectId: "project-two",
      kind: "document",
      title: movedRevision.title,
      versionRef: movedRevision.versionRef,
      receiptId: movedRevision.receiptId,
    }),
    true,
  );
  await assert.rejects(
    platform.authorizeApplicationObject(
      { credential: "agent-input" },
      "objects-one",
      "morphz.objects",
      "document-one",
    ),
    /超出原始输入的项目范围/,
  );
  await assert.rejects(
    readDocument({
      objects,
      actor: { credential: "agent-input" },
      objectId: "document-one",
    }),
    /超出原始输入的项目范围/,
  );
  const afterMove = await projectPendingDocumentDirectory({
    platform,
    objects,
    tenantId: "tenant-one",
    instanceId: "objects-one",
  });
  assert.equal(afterMove.projected, 1);
  assert.equal(
    (await platform.content({ credential: "alice" }, first.contentId))
      .observed_version_ref,
    "3",
  );
  assert.equal(
    (await platform.content({ credential: "alice" }, first.contentId))
      .project_id,
    "project-two",
  );
  assert.equal(
    (
      await readDocument({
        objects,
        actor: { credential: "alice" },
        objectId: "document-one",
      })
    ).projectId,
    "project-two",
  );
  const history = await listObjectVersions({
    objects,
    actor: { credential: "alice" },
    objectId: "document-one",
    limit: 2,
  });
  assert.deepEqual(
    history.versions.map((version) => version.revision),
    [3, 2],
  );
  assert.equal(history.nextCursor, 2);
  assert.deepEqual(
    (
      await listObjectVersions({
        objects,
        actor: { credential: "alice" },
        objectId: "document-one",
        limit: 2,
        beforeRevision: history.nextCursor!,
      })
    ).versions.map((version) => version.revision),
    [1],
  );
  await assert.rejects(
    listObjectVersions({
      objects,
      actor: { credential: "bob" },
      objectId: "document-one",
    }),
    /无权访问这个项目/,
  );
  assert.equal(
    (
      await reviseDocument({
        ...revise,
        commandId: "revision-before-move",
        expectedRevision: 2,
        title: "移动时的修订",
        markdown: "# 第三版",
      })
    ).original.versionRef,
    "3",
  );
  const agentDocument = await createDocument({
    ...create,
    actor: { credential: "agent-input" },
    commandId: "agent-document-create",
    objectId: "agent-document",
    title: "Agent 文档",
  });
  assert.equal(
    (await platform.content({ credential: "alice" }, agentDocument.contentId))
      .app_object_id,
    "agent-document",
  );
  const rename = {
    platform,
    objects,
    actor: { credential: "alice" },
    instanceId: "objects-one",
    commandId: "rename-agent-document",
    objectId: "agent-document",
    expectedCatalogRevision: 1,
    title: "改名后的文档",
  };
  setProofReady(false);
  await assert.rejects(renameObject(rename), /应用未确认/);
  const pendingRename = await readDocument({
    objects,
    actor: { credential: "alice" },
    objectId: rename.objectId,
  });
  assert.equal(pendingRename.revision, 2);
  assert.equal(pendingRename.title, rename.title);
  assert.equal(pendingRename.content.markdown, create.markdown);
  assert.equal(pendingRename.observedVersionRef, "1");
  setProofReady(true);
  assert.equal(
    await objects.verifyCommittedRename({
      tenantId: "tenant-one",
      principalId: "alice",
      actantId: "alice",
      runtimeInputId: null,
      objectId: rename.objectId,
      projectId: "project-one",
      kind: "document",
      title: rename.title,
      versionRef: "2",
      receiptId: rename.commandId,
    }),
    true,
  );
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
  const replay = await renameObject(rename);
  assert.equal(replay.original.versionRef, "2");
  assert.equal(
    (await platform.content({ credential: "alice" }, replay.contentId)).title,
    rename.title,
  );
  assert.equal(
    (
      await readDocument({
        objects,
        actor: { credential: "alice" },
        objectId: rename.objectId,
        revision: 1,
      })
    ).title,
    "Agent 文档",
  );
  await assert.rejects(
    renameObject({ ...rename, title: "篡改回执" }),
    /相同命令 ID/,
  );
  await assert.rejects(
    renameObject({ ...rename, commandId: "stale-rename" }),
    /目录已变化/,
  );
  await assert.rejects(
    renameObject({
      ...rename,
      actor: { credential: "bob" },
      commandId: "bob-rename",
      expectedCatalogRevision: 2,
    }),
    /无权访问这个项目/,
  );

  const interactive = {
    ...emptyInteractive,
    rows: [{ id: "row-one", cells: { name: "第一行", value: 4 } }],
  };
  const createTable = {
    platform,
    objects,
    actor: { credential: "agent-input" },
    instanceId: "objects-one",
    commandId: "create-interactive-one",
    objectId: "interactive-one",
    projectId: "project-one",
    title: "可编辑表格",
    content: interactive,
  };
  setProofReady(false);
  await assert.rejects(createInteractive(createTable), /应用未确认/);
  assert.equal(
    await objects.verifyCommittedInteractive({
      tenantId: "tenant-one",
      principalId: "alice",
      actantId: "agent-one",
      runtimeInputId: "input-one",
      objectId: createTable.objectId,
      projectId: "project-one",
      kind: "interactive",
      title: createTable.title,
      versionRef: "1",
      receiptId: createTable.commandId,
    }),
    true,
  );
  assert.equal(
    await objects.verifyCommittedInteractive({
      tenantId: "tenant-one",
      principalId: "alice",
      actantId: "agent-one",
      runtimeInputId: "input-one",
      objectId: createTable.objectId,
      projectId: "project-two",
      kind: "interactive",
      title: createTable.title,
      versionRef: "1",
      receiptId: createTable.commandId,
    }),
    false,
  );
  setProofReady(true);
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
  const createdTable = await createInteractive(createTable);
  assert.equal(createdTable.original.versionRef, "1");
  assert.equal(
    (await platform.content({ credential: "alice" }, createdTable.contentId))
      .kind,
    "interactive",
  );
  assert.deepEqual(
    (
      await objects.readObject({
        credential: "alice",
        objectId: createTable.objectId,
      })
    ).content,
    interactive,
  );
  await assert.rejects(
    createInteractive({ ...createTable, content: emptyInteractive }),
    /相同命令 ID/,
  );
  await assert.rejects(
    objects.readObject({ credential: "bob", objectId: createTable.objectId }),
    /无权访问这个项目/,
  );
  const reviseTable = {
    platform,
    objects,
    actor: { credential: "alice" },
    instanceId: "objects-one",
    commandId: "revise-interactive-two",
    objectId: createTable.objectId,
    expectedRevision: 1,
    title: "第二版表格",
    content: {
      ...interactive,
      rows: [{ id: "row-one", cells: { name: "更新", value: 5 } }],
    },
  };
  setProofReady(false);
  await assert.rejects(reviseInteractive(reviseTable), /应用未确认/);
  await assert.rejects(
    reviseInteractive({
      ...reviseTable,
      commandId: "revise-interactive-three",
      expectedRevision: 2,
    }),
    /目录尚未确认/,
  );
  setProofReady(true);
  const revisedTable = await reviseInteractive(reviseTable);
  assert.equal(revisedTable.original.versionRef, "2");
  assert.equal(
    (await platform.content({ credential: "alice" }, createdTable.contentId))
      .observed_version_ref,
    "2",
  );
  assert.deepEqual(
    (
      await objects.readObject({
        credential: "agent-input",
        objectId: createTable.objectId,
      })
    ).content,
    reviseTable.content,
  );
  await assert.rejects(
    reviseInteractive({
      ...reviseTable,
      commandId: "bob-interactive-revise",
      actor: { credential: "bob" },
    }),
    /无权访问这个项目/,
  );
}

test("SQLite：文档版本、目录投影失败恢复、回执和 Agent 权限", async () => {
  let objects!: ObjectsStore;
  let proofReady = false;
  let credentialReady = true;
  const platform = await PlatformStore.sqlite(
    ":memory:",
    fixtureAuthority(
      () => objects,
      () => proofReady,
      () => credentialReady,
    ),
  );
  try {
    objects = await ObjectsStore.sqlite(
      ":memory:",
      platformObjectsAuthority(platform, "objects-one", () => ({
        routeKind: "service",
        routeRef: "test:objects-one",
      })),
    );
    try {
      await exercise(
        platform,
        objects,
        (ready) => {
          proofReady = ready;
        },
        (ready) => {
          credentialReady = ready;
        },
      );
    } finally {
      await objects.close();
    }
  } finally {
    await platform.close();
  }
});

test("SQLite 文件重开后仍用原回执补目录，不重复创建正文", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-document-recovery-"));
  const platformFile = join(directory, "platform.sqlite");
  const objectsFile = join(directory, "objects.sqlite");
  let objects!: ObjectsStore;
  let proofReady = false;
  let credentialReady = true;
  const authority = fixtureAuthority(
    () => objects,
    () => proofReady,
    () => credentialReady,
  );
  try {
    const platform = await PlatformStore.sqlite(platformFile, authority);
    try {
      objects = await ObjectsStore.sqlite(
        objectsFile,
        platformObjectsAuthority(platform, "objects-one", () => ({
          routeKind: "service",
          routeRef: "test:objects-one",
        })),
      );
      try {
        await platform.provisionTenant("tenant-one");
        await platform.createProject(
          { credential: "alice" },
          {
            commandId: "restart-project",
            projectId: "project-one",
            title: "重启恢复",
          },
        );
        await platform.registerApplication("tenant-one", {
          appId: "morphz.objects",
          installationId: "restart-installation",
          instanceId: "objects-one",
          routeKind: "service",
          routeRef: "test:objects-one",
        });
        await assert.rejects(
          createDocument({
            platform,
            objects,
            actor: { credential: "alice" },
            instanceId: "objects-one",
            commandId: "restart-document-command",
            objectId: "restart-document",
            projectId: "project-one",
            title: "恢复正文",
            markdown: "正文只生成一次",
          }),
          /应用未确认/,
        );
      } finally {
        await objects.close();
      }
    } finally {
      await platform.close();
    }
    proofReady = true;
    credentialReady = false;
    const reopenedPlatform = await PlatformStore.sqlite(
      platformFile,
      authority,
    );
    try {
      objects = await ObjectsStore.sqlite(
        objectsFile,
        platformObjectsAuthority(reopenedPlatform, "objects-one", () => ({
          routeKind: "service",
          routeRef: "test:objects-one",
        })),
      );
      try {
        const recovery = await projectPendingDocumentDirectory({
          platform: reopenedPlatform,
          objects,
          tenantId: "tenant-one",
          instanceId: "objects-one",
        });
        assert.equal(recovery.projected, 1);
        credentialReady = true;
        const replay = await createDocument({
          platform: reopenedPlatform,
          objects,
          actor: { credential: "alice" },
          instanceId: "objects-one",
          commandId: "restart-document-command",
          objectId: "restart-document",
          projectId: "project-one",
          title: "恢复正文",
          markdown: "正文只生成一次",
        });
        assert.equal(replay.original.versionRef, "1");
        assert.equal(
          (
            await objects.listObjectVersions({
              credential: "alice",
              objectId: "restart-document",
            })
          ).versions.length,
          1,
        );
        assert.deepEqual(
          await objects.pendingDirectoryEvents("tenant-one"),
          [],
        );
      } finally {
        await objects.close();
      }
    } finally {
      await reopenedPlatform.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("读取期间项目移动使 Agent 原输入失效时，不返回已读取的正文", async () => {
  let objects!: ObjectsStore;
  const platform = await PlatformStore.sqlite(
    ":memory:",
    fixtureAuthority(
      () => objects,
      () => true,
    ),
  );
  try {
    await platform.provisionTenant("tenant-one");
    for (const [projectId, commandId] of [
      ["project-one", "read-race-project-one"],
      ["project-two", "read-race-project-two"],
    ] as const)
      await platform.createProject(
        { credential: "alice" },
        { commandId, projectId, title: projectId },
      );
    await platform.registerApplication("tenant-one", {
      appId: "morphz.objects",
      installationId: "read-race-installation",
      instanceId: "objects-one",
      routeKind: "service",
      routeRef: "test:objects-one",
    });
    const base = platformObjectsAuthority(platform, "objects-one", () => ({
      routeKind: "service",
      routeRef: "test:objects-one",
    }));
    let moveAfterFirstReadCheck = false;
    let readChecks = 0;
    let contentId = "";
    objects = await ObjectsStore.sqlite(":memory:", {
      ...base,
      async authorizeObjectRead(request) {
        const resolved = await base.authorizeObjectRead(request);
        if (
          moveAfterFirstReadCheck &&
          request.credential === "agent-input" &&
          ++readChecks === 1
        )
          await platform.moveContent(
            { credential: "alice" },
            {
              commandId: "read-race-move",
              contentId,
              targetProjectId: "project-two",
              expectedRevision: 1,
            },
          );
        return resolved;
      },
    });
    try {
      contentId = (
        await createDocument({
          platform,
          objects,
          actor: { credential: "alice" },
          instanceId: "objects-one",
          commandId: "read-race-create",
          objectId: "read-race-document",
          projectId: "project-one",
          title: "不能跨权限读取",
          markdown: "敏感正文",
        })
      ).contentId;
      moveAfterFirstReadCheck = true;
      await assert.rejects(
        readDocument({
          objects,
          actor: { credential: "agent-input" },
          objectId: "read-race-document",
        }),
        /超出原始输入的项目范围/,
      );
      assert.equal(readChecks, 1);
      assert.equal(
        (
          await readDocument({
            objects,
            actor: { credential: "alice" },
            objectId: "read-race-document",
          })
        ).projectId,
        "project-two",
      );
    } finally {
      await objects.close();
    }
  } finally {
    await platform.close();
  }
});

test(
  "PostgreSQL：文档与目录的双库写入遵守同一恢复及权限语义",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const schemaPlatform = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const schemaObjects = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({
      connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
    });
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA "${schemaPlatform}"`);
      await client.query(`CREATE SCHEMA "${schemaObjects}"`);
      let objects!: ObjectsStore;
      let proofReady = false;
      let credentialReady = true;
      const platform = await PlatformStore.postgres(
        {
          connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
          schema: schemaPlatform,
        },
        fixtureAuthority(
          () => objects,
          () => proofReady,
          () => credentialReady,
        ),
      );
      try {
        objects = await ObjectsStore.postgres({
          connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
          schema: schemaObjects,
          authority: platformObjectsAuthority(platform, "objects-one", () => ({
            routeKind: "service",
            routeRef: "test:objects-one",
          })),
        });
        try {
          await exercise(
            platform,
            objects,
            (ready) => {
              proofReady = ready;
            },
            (ready) => {
              credentialReady = ready;
            },
          );
        } finally {
          await objects.close();
        }
      } finally {
        await platform.close();
      }
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS "${schemaObjects}" CASCADE`);
      await client.query(`DROP SCHEMA IF EXISTS "${schemaPlatform}" CASCADE`);
      client.release();
      await pool.end();
    }
  },
);
