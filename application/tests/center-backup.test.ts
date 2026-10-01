import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  chmodSync,
  cpSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  backupCenterStorage,
  restoreCenterStorage,
} from "../packages/application/src/center-backup.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import {
  createDocument,
  createImage,
} from "../packages/application/src/document-service.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { localAccess } from "../packages/core/src/model.js";
import { applicationManifestFormat } from "../packages/core/src/application-names.js";

function privateCopiedDirectories(path: string) {
  if (!lstatSync(path).isDirectory()) return;
  chmodSync(path, 0o700);
  for (const name of readdirSync(path))
    privateCopiedDirectories(join(path, name));
}

function recordAttachmentReference(filename: string) {
  const db = new DatabaseSync(filename);
  try {
    db.exec("PRAGMA journal_mode=DELETE");
    db.prepare(
      "INSERT INTO runtime_deliveries(key,ordinal,body) VALUES(?,?,?)",
    ).run(
      "test-upload-delivery",
      0,
      JSON.stringify({ resourceUploads: [{ assetId: "a".repeat(64) }] }),
    );
  } finally {
    db.close();
  }
}

test("中心冷备份成套恢复 Platform、应用原件与稳定实例身份", async () => {
  const root = mkdtempSync(join(tmpdir(), "morphz-center-backup-"));
  const source = join(root, "source");
  const backups = join(root, "backups");
  const restored = join(root, "restored");
  mkdirSync(source);
  const workspace = new WorkspaceStore(join(source, "workspace.sqlite"), {
    mode: "transport",
  });
  const centerId = workspace.identity();
  let host: Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
  try {
    host = await openApplicationDomainsHost(source, workspace);
    const { authority, platform, objects, instanceIds } = host.content;
    await authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        platform.createProject(actor, {
          commandId: randomUUID(),
          projectId: "test-project",
          title: "项目",
        }),
    );
    const created = await authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        createDocument({
          platform,
          objects,
          actor,
          instanceId: instanceIds.objects,
          commandId: "create-test-document",
          objectId: "test-document",
          projectId: "test-project",
          title: "一份文档",
          markdown: "# 不得丢失的正文",
        }),
    );
    const section = await host.reader.authority.withSession(
      localAccess,
      () => {},
      async (actor) => {
        const contents = await host!.reader.service.contents(
          actor,
          created.contentId,
          1,
        );
        return host!.reader.service.read(
          actor,
          created.contentId,
          1,
          contents[0]!.id,
        );
      },
    );
    const start = section.text.indexOf("不得丢失");
    const location = {
      sourceId: section.sourceId,
      sectionId: section.id,
      start,
      end: start + "不得丢失".length,
    };
    await host.reader.authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        host!.reader.service.command(actor, {
          commandId: randomUUID(),
          contentId: created.contentId,
          revision: 1,
          command: {
            action: "mark-add",
            artifactId: created.contentId,
            artifactRevision: 1,
            location,
            quote: "不得丢失",
            kind: "highlight",
            color: "yellow",
            note: "",
          },
        }),
    );
    const pdf = readFileSync(new URL("./fixtures/reader.pdf", import.meta.url));
    const importedBook = await host.reader.authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        host!.reader.service.import(actor, {
          commandId: randomUUID(),
          projectId: "test-project",
          name: "备份原件.pdf",
          bytes: pdf,
        }),
    );
    const messageBytes = Buffer.from("备份后仍可读取的附件", "utf8");
    const messageAttachment =
      await host.messageAttachments.authority.withSession(
        localAccess,
        () => {},
        (actor) =>
          host!.messageAttachments.service.upload(
            actor,
            "附件.txt",
            messageBytes,
          ),
      );
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLytQAAAABJRU5ErkJggg==",
      "base64",
    );
    const image = await host.images.authority.withSession(
      localAccess,
      () => {},
      async (actor) => {
        const upload = await host!.images.service.upload(actor, png);
        return {
          upload,
          created: await createImage({
            platform,
            objects,
            actor,
            instanceId: instanceIds.objects,
            commandId: randomUUID(),
            objectId: "backed-image",
            projectId: "test-project",
            title: "备份图片",
            assetId: upload.assetId,
            alt: "一张图片",
            reference: await host!.images.service.uploadedReference(
              actor,
              upload.assetId,
            ),
          }),
        };
      },
    );
    const uiManifest = {
      format: applicationManifestFormat,
      id: "example.backup-notes",
      version: "1.0.0",
      title: "备份便笺",
      description: "恢复时按版本核验",
      icon: "document" as const,
      permissions: ["artifacts.read" as const],
      harness: null,
      ui: { type: "sandbox" as const, html: "<title>恢复后仍可打开</title>" },
    };
    await host.uiPackages!.authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        host!.uiPackages!.service.install(actor, randomUUID(), uiManifest),
    );
    await platform.registerApplication(centerId, {
      appId: "morphz.objects",
      installationId: "install_morphz_objects",
      instanceId: "objects_external_test",
      routeKind: "service",
      routeRef: "external:test",
    });
    await host.close();
    host = undefined;
    workspace.close();

    const externalCatalog = new DatabaseSync(join(source, "platform.sqlite"));
    try {
      const now = new Date().toISOString();
      externalCatalog
        .prepare(
          `INSERT INTO content_entries
            (tenant_id,content_id,app_id,instance_id,app_object_id,project_id,kind,title,
             observed_version_ref,observed_at,availability,revision,created_at,updated_at,deleted_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?,NULL)`,
        )
        .run(
          centerId,
          "external-content",
          "morphz.objects",
          "objects_external_test",
          "external-original",
          "test-project",
          "document",
          "外部应用实例的内容",
          "1",
          now,
          "available",
          now,
          now,
        );
    } finally {
      externalCatalog.close();
    }

    const backup = await backupCenterStorage({
      sourceDirectory: source,
      backupDirectory: backups,
      writersStopped: true,
    });
    assert.equal(backup.centerId, centerId);
    assert.deepEqual(backup.files, [
      "workspace.sqlite",
      "platform.sqlite",
      "browser.sqlite",
      "objects.sqlite",
      "script-studio.sqlite",
      "reader.sqlite",
      "application-instances.json",
      "reader-originals",
      "message-attachments",
      "objects-images",
      "ui-packages",
    ]);
    await assert.rejects(
      restoreCenterStorage({
        backupDirectory: backup.destination,
        destinationDirectory: source,
        writersStopped: true,
      }),
      /恢复目标已存在/,
    );
    await restoreCenterStorage({
      backupDirectory: backup.destination,
      destinationDirectory: restored,
      writersStopped: true,
    });
    const recoveredWorkspace = new WorkspaceStore(
      join(restored, "workspace.sqlite"),
      { mode: "transport" },
    );
    try {
      const restoredDatabase = new DatabaseSync(
        join(restored, "workspace.sqlite"),
        { readOnly: true },
      );
      try {
        assert.equal(
          restoredDatabase
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace'",
            )
            .get(),
          undefined,
        );
      } finally {
        restoredDatabase.close();
      }
      const recoveredHost = await openApplicationDomainsHost(
        restored,
        recoveredWorkspace,
      );
      try {
        assert.equal(recoveredWorkspace.identity(), centerId);
        assert.deepEqual(recoveredHost.content.instanceIds, instanceIds);
        const contents = await recoveredHost.content.authority.withSession(
          localAccess,
          () => {},
          (actor) =>
            recoveredHost.content.platform.listContent(actor, {
              projectId: "test-project",
            }),
        );
        assert.equal(contents.length, 4);
        assert.ok(
          contents.some((item) => item.content_id === created.contentId),
        );
        assert.ok(
          contents.some((item) => item.content_id === image.created.contentId),
        );
        const original = await recoveredHost.content.authority.withSession(
          localAccess,
          () => {},
          (actor) =>
            recoveredHost.content.objects.readDocument({
              credential: actor.credential,
              objectId: "test-document",
            }),
        );
        assert.equal(original.content.markdown, "# 不得丢失的正文");
        const reading = await recoveredHost.reader.authority.withSession(
          localAccess,
          () => {},
          (actor) =>
            recoveredHost.reader.service.marks(
              actor,
              created.contentId,
              1,
              false,
              0,
              50,
            ),
        );
        assert.equal(reading.hasMore, false);
        assert.equal(reading.marks.length, 1);
        assert.equal(reading.marks[0]?.quote, "不得丢失");
        assert.equal(reading.marks[0]?.location.sourceId, section.sourceId);
        const restoredBytes = await recoveredHost.reader.authority.withSession(
          localAccess,
          () => {},
          (actor) =>
            recoveredHost.reader.service.originalRange(
              actor,
              importedBook.entityId,
              1,
              0,
              pdf.length,
            ),
        );
        assert.deepEqual(Buffer.from(restoredBytes), pdf);
        const restoredAttachment =
          await recoveredHost.messageAttachments.authority.withSession(
            localAccess,
            () => {},
            (actor) =>
              recoveredHost.messageAttachments.service.readOwned(
                actor,
                messageAttachment.assetId,
              ),
          );
        assert.deepEqual(Buffer.from(restoredAttachment.bytes), messageBytes);
        const restoredImage = await recoveredHost.images.authority.withSession(
          localAccess,
          () => {},
          (actor) =>
            recoveredHost.images.service.read(actor, image.upload.assetId),
        );
        assert.deepEqual(Buffer.from(restoredImage.bytes), png);
        const restoredUi =
          await recoveredHost.uiPackages!.authority.withSession(
            localAccess,
            () => {},
            (actor) =>
              recoveredHost.uiPackages!.service.read(
                actor,
                uiManifest.id,
                uiManifest.version,
              ),
          );
        assert.deepEqual(restoredUi, uiManifest);
      } finally {
        await recoveredHost.close();
      }
    } finally {
      recoveredWorkspace.close();
    }

    const missingOriginal = join(root, "missing-original");
    cpSync(backup.destination, missingOriginal, { recursive: true });
    const missingCatalog = join(missingOriginal, "platform.sqlite");
    const damaged = new DatabaseSync(missingCatalog);
    try {
      damaged.exec("PRAGMA journal_mode=DELETE");
      damaged
        .prepare(
          "UPDATE content_entries SET app_object_id=? WHERE content_id=?",
        )
        .run("missing-original", created.contentId);
    } finally {
      damaged.close();
    }
    const missingManifestPath = join(missingOriginal, "manifest.json");
    const missingManifest = JSON.parse(
      readFileSync(missingManifestPath, "utf8"),
    ) as { files: Array<{ name: string; sha256: string }> };
    missingManifest.files.find(
      (file) => file.name === "platform.sqlite",
    )!.sha256 = createHash("sha256")
      .update(readFileSync(missingCatalog))
      .digest("hex");
    writeFileSync(missingManifestPath, JSON.stringify(missingManifest));
    const refusedMissingOriginal = join(root, "refused-missing-original");
    await assert.rejects(
      restoreCenterStorage({
        backupDirectory: missingOriginal,
        destinationDirectory: refusedMissingOriginal,
        writersStopped: true,
      }),
      /morphz\.objects 原件缺失或已删除/,
    );
    assert.equal(existsSync(refusedMissingOriginal), false);

    const wrongInstance = join(root, "wrong-instance");
    cpSync(backup.destination, wrongInstance, { recursive: true });
    const wrongInstanceCatalog = join(wrongInstance, "platform.sqlite");
    const wrongInstanceDatabase = new DatabaseSync(wrongInstanceCatalog);
    try {
      wrongInstanceDatabase.exec("PRAGMA foreign_keys=OFF");
      wrongInstanceDatabase.exec("PRAGMA journal_mode=DELETE");
      wrongInstanceDatabase
        .prepare("UPDATE content_entries SET instance_id=? WHERE content_id=?")
        .run(instanceIds.scriptStudio, created.contentId);
    } finally {
      wrongInstanceDatabase.close();
    }
    const wrongInstanceManifestPath = join(wrongInstance, "manifest.json");
    const wrongInstanceManifest = JSON.parse(
      readFileSync(wrongInstanceManifestPath, "utf8"),
    ) as { files: Array<{ name: string; sha256: string }> };
    wrongInstanceManifest.files.find(
      (file) => file.name === "platform.sqlite",
    )!.sha256 = createHash("sha256")
      .update(readFileSync(wrongInstanceCatalog))
      .digest("hex");
    writeFileSync(
      wrongInstanceManifestPath,
      JSON.stringify(wrongInstanceManifest),
    );
    const refusedWrongInstance = join(root, "refused-wrong-instance");
    await assert.rejects(
      restoreCenterStorage({
        backupDirectory: wrongInstance,
        destinationDirectory: refusedWrongInstance,
        writersStopped: true,
      }),
      /数据库外键校验失败：platform\.sqlite/,
    );
    assert.equal(existsSync(refusedWrongInstance), false);

    const sourceCatalog = new DatabaseSync(join(source, "platform.sqlite"));
    try {
      sourceCatalog
        .prepare(
          "UPDATE content_entries SET app_object_id=? WHERE content_id=?",
        )
        .run("missing-original", created.contentId);
    } finally {
      sourceCatalog.close();
    }
    try {
      await assert.rejects(
        backupCenterStorage({
          sourceDirectory: source,
          backupDirectory: backups,
          writersStopped: true,
        }),
        /morphz\.objects 原件缺失或已删除/,
      );
    } finally {
      const catalog = new DatabaseSync(join(source, "platform.sqlite"));
      try {
        catalog
          .prepare(
            "UPDATE content_entries SET app_object_id=? WHERE content_id=?",
          )
          .run("test-document", created.contentId);
      } finally {
        catalog.close();
      }
    }

    for (const [name, databaseName, sql, expected] of [
      [
        "wrong-image-version",
        "objects.sqlite",
        "UPDATE object_version_bytes SET sha256=?",
        /Objects 原件的字节版本与图片 Store 不一致/,
      ],
      [
        "wrong-reader-version",
        "reader.sqlite",
        "UPDATE book_revisions SET sha256=? WHERE storage_kind='app_private'",
        /Reader 书籍原件与阅读 Store 的字节版本不一致/,
      ],
    ] as const) {
      const damagedBackup = join(root, name);
      cpSync(backup.destination, damagedBackup, { recursive: true });
      privateCopiedDirectories(damagedBackup);
      const damagedFile = join(damagedBackup, databaseName);
      const database = new DatabaseSync(damagedFile);
      try {
        database.exec("PRAGMA journal_mode=DELETE");
        assert.ok(database.prepare(sql).run("f".repeat(64)).changes > 0);
      } finally {
        database.close();
      }
      const manifestPath = join(damagedBackup, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        files: Array<{ name: string; sha256: string }>;
      };
      manifest.files.find((file) => file.name === databaseName)!.sha256 =
        createHash("sha256").update(readFileSync(damagedFile)).digest("hex");
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const destination = join(root, `refused-${name}`);
      await assert.rejects(
        restoreCenterStorage({
          backupDirectory: damagedBackup,
          destinationDirectory: destination,
          writersStopped: true,
        }),
        expected,
      );
      assert.equal(existsSync(destination), false);
    }

    const omittedImageStore = join(root, "omitted-image-store");
    cpSync(backup.destination, omittedImageStore, { recursive: true });
    rmSync(join(omittedImageStore, "objects-images"), { recursive: true });
    const omittedManifestPath = join(omittedImageStore, "manifest.json");
    const omittedManifest = JSON.parse(
      readFileSync(omittedManifestPath, "utf8"),
    ) as { imageStore: unknown };
    omittedManifest.imageStore = null;
    writeFileSync(omittedManifestPath, JSON.stringify(omittedManifest));
    await assert.rejects(
      restoreCenterStorage({
        backupDirectory: omittedImageStore,
        destinationDirectory: join(root, "rejected-missing-image"),
        writersStopped: true,
      }),
      /缺少已登记原件的图片 Store/,
    );

    const omittedUiStore = join(root, "omitted-ui-store");
    cpSync(backup.destination, omittedUiStore, { recursive: true });
    rmSync(join(omittedUiStore, "ui-packages"), { recursive: true });
    const omittedUiManifestPath = join(omittedUiStore, "manifest.json");
    const omittedUiManifest = JSON.parse(
      readFileSync(omittedUiManifestPath, "utf8"),
    ) as {
      uiStore: unknown;
    };
    omittedUiManifest.uiStore = null;
    writeFileSync(omittedUiManifestPath, JSON.stringify(omittedUiManifest));
    await assert.rejects(
      restoreCenterStorage({
        backupDirectory: omittedUiStore,
        destinationDirectory: join(root, "rejected-missing-ui"),
        writersStopped: true,
      }),
      /缺少已安装应用的界面包 Store/,
    );

    const messageBlob = readFileSync(
      join(backup.destination, "message-attachments", "manifest.ndjson"),
      "utf8",
    )
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            table: string;
            row: { sha256?: string };
          },
      )
      .find((line) => line.table === "blobs")?.row.sha256;
    assert.ok(messageBlob);
    const backedMessageBlob = join(
      backup.destination,
      "message-attachments",
      "blobs",
      messageBlob.slice(0, 2),
      messageBlob,
    );
    writeFileSync(backedMessageBlob, "corrupt");
    const rejectedMessage = join(root, "rejected-message");
    await assert.rejects(
      restoreCenterStorage({
        backupDirectory: backup.destination,
        destinationDirectory: rejectedMessage,
        writersStopped: true,
      }),
      /摘要|字节|Blob/,
    );
    assert.equal(existsSync(rejectedMessage), false);
    copyFileSync(
      join(
        source,
        "message-attachments",
        "blobs",
        messageBlob.slice(0, 2),
        messageBlob,
      ),
      backedMessageBlob,
    );

    const imageBlob = readFileSync(
      join(backup.destination, "objects-images", "manifest.ndjson"),
      "utf8",
    )
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            table: string;
            row: { sha256?: string };
          },
      )
      .find((line) => line.table === "blobs")?.row.sha256;
    assert.ok(imageBlob);
    const backedImageBlob = join(
      backup.destination,
      "objects-images",
      "blobs",
      imageBlob.slice(0, 2),
      imageBlob,
    );
    writeFileSync(backedImageBlob, "corrupt");
    const rejectedImage = join(root, "rejected-image");
    await assert.rejects(
      restoreCenterStorage({
        backupDirectory: backup.destination,
        destinationDirectory: rejectedImage,
        writersStopped: true,
      }),
      /摘要|字节|Blob/,
    );
    assert.equal(existsSync(rejectedImage), false);
    copyFileSync(
      join(source, "objects-images", "blobs", imageBlob.slice(0, 2), imageBlob),
      backedImageBlob,
    );

    const blob = readFileSync(
      join(backup.destination, "reader-originals", "manifest.ndjson"),
      "utf8",
    )
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            table: string;
            row: { sha256?: string };
          },
      )
      .find((line) => line.table === "blobs")?.row.sha256;
    assert.ok(blob);
    writeFileSync(
      join(
        backup.destination,
        "reader-originals",
        "blobs",
        blob.slice(0, 2),
        blob,
      ),
      "corrupt",
    );
    const rejectedStore = join(root, "rejected-store");
    await assert.rejects(
      restoreCenterStorage({
        backupDirectory: backup.destination,
        destinationDirectory: rejectedStore,
        writersStopped: true,
      }),
      /摘要|字节|Blob/,
    );
    assert.equal(existsSync(rejectedStore), false);
    writeFileSync(join(backup.destination, "objects.sqlite"), "corrupt");
    const rejectedDestination = join(root, "rejected");
    await assert.rejects(
      restoreCenterStorage({
        backupDirectory: backup.destination,
        destinationDirectory: rejectedDestination,
        writersStopped: true,
      }),
      /备份摘要不匹配/,
    );
    assert.equal(existsSync(rejectedDestination), false);
    rmSync(join(source, "objects-images"), { recursive: true });
    await assert.rejects(
      backupCenterStorage({
        sourceDirectory: source,
        backupDirectory: backups,
        writersStopped: true,
      }),
      /原件引用了缺失的图片 Store/,
    );
    unlinkSync(join(source, "application-instances.json"));
    await assert.rejects(
      backupCenterStorage({
        sourceDirectory: source,
        backupDirectory: backups,
        writersStopped: true,
      }),
      /私库与实例身份不成套/,
    );
  } finally {
    await host?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Objects 有文档但没有图片引用时，冷备份和恢复不要求空图片 Store", async () => {
  const root = mkdtempSync(join(tmpdir(), "morphz-center-no-image-"));
  const source = join(root, "source");
  const restored = join(root, "restored");
  mkdirSync(source);
  const workspace = new WorkspaceStore(join(source, "workspace.sqlite"));
  let workspaceClosed = false;
  let host: Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
  try {
    host = await openApplicationDomainsHost(source, workspace);
    const { authority, platform, objects, instanceIds } = host.content;
    await authority.withSession(
      localAccess,
      () => {},
      async (actor) => {
        await platform.createProject(actor, {
          commandId: randomUUID(),
          projectId: "document-project",
          title: "文档项目",
        });
        await createDocument({
          platform,
          objects,
          actor,
          instanceId: instanceIds.objects,
          commandId: randomUUID(),
          objectId: "text-only-document",
          projectId: "document-project",
          title: "纯文档",
          markdown: "# 原文仍在",
        });
      },
    );
    await host.close();
    host = undefined;
    workspace.close();
    workspaceClosed = true;
    rmSync(join(source, "objects-images"), { recursive: true });
    rmSync(join(source, "message-attachments"), { recursive: true });
    const backup = await backupCenterStorage({
      sourceDirectory: source,
      backupDirectory: join(root, "backups"),
      writersStopped: true,
    });
    assert.ok(backup.files.includes("objects.sqlite"));
    assert.ok(!backup.files.includes("objects-images"));
    await restoreCenterStorage({
      backupDirectory: backup.destination,
      destinationDirectory: restored,
      writersStopped: true,
    });
    const recoveredWorkspace = new WorkspaceStore(
      join(restored, "workspace.sqlite"),
    );
    try {
      const recovered = await openApplicationDomainsHost(
        restored,
        recoveredWorkspace,
      );
      try {
        const original = await recovered.content.authority.withSession(
          localAccess,
          () => {},
          (actor) =>
            recovered.content.objects.readDocument({
              credential: actor.credential,
              objectId: "text-only-document",
            }),
        );
        assert.equal(original.content.markdown, "# 原文仍在");
      } finally {
        await recovered.close();
      }
    } finally {
      recoveredWorkspace.close();
    }

    const omittedAttachmentStore = join(root, "omitted-attachment-store");
    cpSync(backup.destination, omittedAttachmentStore, { recursive: true });
    const omittedWorkspace = join(omittedAttachmentStore, "workspace.sqlite");
    recordAttachmentReference(omittedWorkspace);
    const omittedManifestPath = join(omittedAttachmentStore, "manifest.json");
    const omittedManifest = JSON.parse(
      readFileSync(omittedManifestPath, "utf8"),
    ) as { files: Array<{ name: string; sha256: string }> };
    omittedManifest.files.find(
      (file) => file.name === "workspace.sqlite",
    )!.sha256 = createHash("sha256")
      .update(readFileSync(omittedWorkspace))
      .digest("hex");
    writeFileSync(omittedManifestPath, JSON.stringify(omittedManifest));
    await assert.rejects(
      restoreCenterStorage({
        backupDirectory: omittedAttachmentStore,
        destinationDirectory: join(root, "rejected-missing-attachment"),
        writersStopped: true,
      }),
      /缺少已投递消息的附件 Store/,
    );
    recordAttachmentReference(join(source, "workspace.sqlite"));
    await assert.rejects(
      backupCenterStorage({
        sourceDirectory: source,
        backupDirectory: join(root, "backups"),
        writersStopped: true,
      }),
      /消息投递引用了缺失的附件 Store/,
    );
  } finally {
    await host?.close();
    if (!workspaceClosed) workspace.close();
    rmSync(root, { recursive: true, force: true });
  }
});
