import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  backupCloudApplicationStorage,
  restoreCloudApplicationStorage,
  type CloudApplicationStorage,
} from "../packages/application/src/cloud-deployment-backup.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import { createImage } from "../packages/application/src/document-service.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { applicationManifestFormat } from "../packages/core/src/application-names.js";
import { localAccess } from "../packages/core/src/model.js";

const ready =
  process.env.MORPHZ_TEST_POSTGRES_URL &&
  process.env.MORPHZ_TEST_S3_ENDPOINT &&
  process.env.MORPHZ_TEST_PG_DUMP &&
  process.env.MORPHZ_TEST_PG_RESTORE;

test(
  "停写后的云部署关系库＋对象字节成套备份、隔离恢复、损坏及覆盖保护",
  { skip: !ready, timeout: 120_000 },
  async () => {
    const sourceConnection = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const suffix = randomUUID().replaceAll("-", "").slice(0, 18);
    const targetDatabase = `morphz_restore_${suffix}`;
    const targetUrl = new URL(sourceConnection);
    targetUrl.pathname = `/${targetDatabase}`;
    const targetConnection = targetUrl.toString();
    const schemas = {
      platform: `p_${suffix}`,
      objects: `o_${suffix}`,
      scriptStudio: `s_${suffix}`,
      reader: `r_${suffix}`,
      browser: `b_${suffix}`,
      ui: `ui_${suffix}`,
      readerBytes: `rb_${suffix}`,
      images: `im_${suffix}`,
    };
    const bucket = `morphz-backup-test-${suffix}`;
    const parent = mkdtempSync(join(tmpdir(), "morphz-cloud-backup-"));
    const directoryA = join(parent, "source-host");
    const directoryB = join(parent, "restored-host");
    const backupRoot = join(parent, "backups");
    const sourceStaging = join(parent, "source-staging");
    const targetStaging = join(parent, "target-staging");
    for (const path of [
      directoryA,
      directoryB,
      backupRoot,
      sourceStaging,
      targetStaging,
    ])
      mkdirSync(path, { mode: 0o700 });
    const s3 = new S3Client({
      endpoint: process.env.MORPHZ_TEST_S3_ENDPOINT!,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.MORPHZ_TEST_S3_ACCESS_KEY ?? "test",
        secretAccessKey: process.env.MORPHZ_TEST_S3_SECRET_KEY ?? "test",
      },
    });
    const admin = new Pool({ connectionString: sourceConnection });
    let workspaceA: WorkspaceStore | undefined;
    let workspaceB: WorkspaceStore | undefined;
    let hostA:
      Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
    let hostB:
      Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
    let targetCreated = false;
    let bucketCreated = false;
    try {
      for (const schema of Object.values(schemas))
        await admin.query(`CREATE SCHEMA "${schema}"`);
      await admin.query(`CREATE DATABASE "${targetDatabase}"`);
      targetCreated = true;
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
      bucketCreated = true;
      workspaceA = new WorkspaceStore(join(directoryA, "workspace.sqlite"));
      const tenantId = workspaceA.identity();
      const applications = (connectionString: string) => ({
        connectionStrings: {
          objects: connectionString,
          scriptStudio: connectionString,
          reader: connectionString,
          browser: connectionString,
        },
        deploymentId: `cloud_${suffix}`,
        schemas: {
          objects: schemas.objects,
          scriptStudio: schemas.scriptStudio,
          reader: schemas.reader,
          browser: schemas.browser,
        },
      });
      const location = (
        connectionString: string,
        prefix: string,
      ): CloudApplicationStorage => ({
        tenantId,
        platform: { connectionString, schema: schemas.platform },
        applications: applications(connectionString),
        stores: {
          connectionString,
          schemas: {
            ui: schemas.ui,
            reader: schemas.readerBytes,
            images: schemas.images,
          },
          bytes: {
            bucket,
            prefix,
            region: "us-east-1",
            endpoint: process.env.MORPHZ_TEST_S3_ENDPOINT!,
            forcePathStyle: true,
          },
        },
        s3Client: s3,
      });
      const source = location(sourceConnection, `source-${suffix}`);
      const target = location(targetConnection, `restored-${suffix}`);
      const hostOptions = (
        storage: CloudApplicationStorage,
        stagingRoot: string,
      ) => ({
        platform: { kind: "postgres" as const, ...storage.platform },
        applications: storage.applications,
        cloudStore: {
          connectionString: storage.stores.connectionString,
          schemas: storage.stores.schemas,
          bytes: storage.stores.bytes,
          stagingRoot,
          s3Client: s3,
        },
      });
      const runCloudCommand = (
        operation: "backup" | "restore",
        storage: CloudApplicationStorage,
        directory: string,
        stagingRoot: string,
      ) => {
        const result = spawnSync(
          process.execPath,
          [
            fileURLToPath(
              new URL(
                "../scripts/cloud-application-storage.mjs",
                import.meta.url,
              ),
            ),
            operation,
            tenantId,
            directory,
            "--stopped",
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              AWS_ACCESS_KEY_ID:
                process.env.MORPHZ_TEST_S3_ACCESS_KEY ?? "test",
              AWS_SECRET_ACCESS_KEY:
                process.env.MORPHZ_TEST_S3_SECRET_KEY ?? "test",
              MORPHZ_APP_PLATFORM_POSTGRES_URL:
                storage.platform.connectionString,
              MORPHZ_APP_PLATFORM_POSTGRES_SCHEMA: storage.platform.schema,
              MORPHZ_APP_OBJECTS_POSTGRES_URL:
                storage.applications.connectionStrings.objects,
              MORPHZ_APP_SCRIPT_POSTGRES_URL:
                storage.applications.connectionStrings.scriptStudio,
              MORPHZ_APP_READER_POSTGRES_URL:
                storage.applications.connectionStrings.reader,
              MORPHZ_APP_BROWSER_POSTGRES_URL:
                storage.applications.connectionStrings.browser,
              MORPHZ_APP_COGNITIVE_DEPLOYMENT_ID:
                storage.applications.deploymentId,
              MORPHZ_APP_OBJECTS_POSTGRES_SCHEMA:
                storage.applications.schemas.objects,
              MORPHZ_APP_SCRIPT_POSTGRES_SCHEMA:
                storage.applications.schemas.scriptStudio,
              MORPHZ_APP_READER_POSTGRES_SCHEMA:
                storage.applications.schemas.reader,
              MORPHZ_APP_BROWSER_POSTGRES_SCHEMA:
                storage.applications.schemas.browser,
              MORPHZ_APP_CLOUD_STORE_POSTGRES_URL:
                storage.stores.connectionString,
              MORPHZ_APP_CLOUD_STORE_UI_SCHEMA: storage.stores.schemas.ui,
              MORPHZ_APP_CLOUD_STORE_READER_SCHEMA:
                storage.stores.schemas.reader,
              MORPHZ_APP_CLOUD_STORE_IMAGE_SCHEMA:
                storage.stores.schemas.images,
              MORPHZ_APP_CLOUD_STORE_STAGING_ROOT: stagingRoot,
              MORPHZ_APP_CLOUD_STORE_BUCKET: storage.stores.bytes.bucket,
              MORPHZ_APP_CLOUD_STORE_PREFIX: storage.stores.bytes.prefix,
              MORPHZ_APP_CLOUD_STORE_REGION: storage.stores.bytes.region,
              MORPHZ_APP_CLOUD_STORE_ENDPOINT: storage.stores.bytes.endpoint,
              MORPHZ_APP_CLOUD_STORE_FORCE_PATH_STYLE: "true",
              MORPHZ_APP_PG_DUMP: process.env.MORPHZ_TEST_PG_DUMP,
              MORPHZ_APP_PG_RESTORE: process.env.MORPHZ_TEST_PG_RESTORE,
            },
          },
        );
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
      };
      hostA = await openApplicationDomainsHost(
        directoryA,
        workspaceA,
        undefined,
        hostOptions(source, sourceStaging),
      );
      const projectId = `project_${suffix}`;
      await hostA.content.authority.withSession(
        localAccess,
        () => {},
        (actor) =>
          hostA!.content.platform.createProject(actor, {
            commandId: `project_${suffix}`,
            projectId,
            title: "云部署备份原件",
          }),
      );
      const pdf = readFileSync(
        new URL("./fixtures/reader.pdf", import.meta.url),
      );
      const imported = await hostA.reader.authority.withSession(
        localAccess,
        () => {},
        (actor) =>
          hostA!.reader.service.import(actor, {
            commandId: `reader_${suffix}`,
            projectId,
            name: "备份.pdf",
            bytes: pdf,
          }),
      );
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLytQAAAABJRU5ErkJggg==",
        "base64",
      );
      const image = await hostA.images.authority.withSession(
        localAccess,
        () => {},
        async (actor) => {
          const uploaded = await hostA!.images.service.upload(actor, png);
          await createImage({
            platform: hostA!.content.platform,
            objects: hostA!.content.objects,
            actor,
            instanceId: hostA!.content.instanceIds.objects,
            commandId: `image_${suffix}`,
            objectId: `image_${suffix}`,
            projectId,
            title: "备份图片",
            assetId: uploaded.assetId,
            alt: "一张图片",
            reference: await hostA!.images.service.uploadedReference(
              actor,
              uploaded.assetId,
            ),
          });
          return uploaded;
        },
      );
      const manifest = {
        format: applicationManifestFormat,
        id: "example.cloud-backup",
        version: "1.0.0",
        title: "备份界面包",
        description: "恢复后能打开",
        icon: "document" as const,
        permissions: ["artifacts.read" as const],
        harness: null,
        ui: {
          type: "sandbox" as const,
          html: "<!doctype html><title>已恢复</title>",
        },
      };
      await hostA.uiPackages!.authority.withSession(
        localAccess,
        () => {},
        (actor) =>
          hostA!.uiPackages!.service.install(actor, `ui_${suffix}`, manifest),
      );
      await hostA.close();
      hostA = undefined;
      workspaceA.close();
      workspaceA = undefined;

      const backup = await backupCloudApplicationStorage({
        location: source,
        backupRoot,
        stagingRoot: sourceStaging,
        writersStopped: true,
        pgDumpPath: process.env.MORPHZ_TEST_PG_DUMP!,
      });
      assert.equal(backup.manifest.relations.length, 5);
      assert.equal(backup.manifest.stores.length, 3);
      assert.equal(
        existsSync(join(backup.destination, "backup-manifest.json")),
        true,
      );
      assert.match(
        runCloudCommand("backup", source, backupRoot, sourceStaging),
        /云应用存储成套备份完成/,
      );
      await assert.rejects(
        restoreCloudApplicationStorage({
          location: source,
          backupDirectory: backup.destination,
          stagingRoot: sourceStaging,
          writersStopped: true,
          pgRestorePath: process.env.MORPHZ_TEST_PG_RESTORE!,
        }),
        /目标 schema 已存在/,
      );
      const tampered = join(parent, "tampered");
      cpSync(backup.destination, tampered, { recursive: true });
      chmodSync(tampered, 0o700);
      appendFileSync(join(tampered, "platform.dump"), "altered");
      await assert.rejects(
        restoreCloudApplicationStorage({
          location: target,
          backupDirectory: tampered,
          stagingRoot: targetStaging,
          writersStopped: true,
          pgRestorePath: process.env.MORPHZ_TEST_PG_RESTORE!,
        }),
        /归档摘要损坏/,
      );
      const pdfSha = createHash("sha256").update(pdf).digest("hex");
      const damagedBytes = join(parent, "damaged-bytes");
      cpSync(backup.destination, damagedBytes, { recursive: true });
      chmodSync(damagedBytes, 0o700);
      for (const name of ["ui", "reader", "images"]) {
        const store = join(damagedBytes, name);
        const blobs = join(store, "blobs");
        chmodSync(store, 0o700);
        chmodSync(blobs, 0o700);
        for (const prefix of readdirSync(blobs))
          chmodSync(join(blobs, prefix), 0o700);
      }
      appendFileSync(
        join(damagedBytes, "reader", "blobs", pdfSha.slice(0, 2), pdfSha),
        "damaged",
      );
      await assert.rejects(
        restoreCloudApplicationStorage({
          location: target,
          backupDirectory: damagedBytes,
          stagingRoot: targetStaging,
          writersStopped: true,
          pgRestorePath: process.env.MORPHZ_TEST_PG_RESTORE!,
        }),
        /字节缺失或长度损坏/,
      );
      const emptyTarget = new Pool({ connectionString: targetConnection });
      try {
        const found = await emptyTarget.query(
          "SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname=$1",
          [schemas.platform],
        );
        assert.equal(found.rowCount, 0, "损坏备份不能先创建目标 schema");
      } finally {
        await emptyTarget.end();
      }
      const corruptedReference = await admin.query(
        `UPDATE "${schemas.reader}".book_revisions SET sha256=$1 WHERE sha256=$2`,
        ["0".repeat(64), pdfSha],
      );
      assert.equal(corruptedReference.rowCount, 1);
      await assert.rejects(
        backupCloudApplicationStorage({
          location: source,
          backupRoot,
          stagingRoot: sourceStaging,
          writersStopped: true,
          pgDumpPath: process.env.MORPHZ_TEST_PG_DUMP!,
        }),
        /阅读原件引用的 Store 字节版本不完整/,
      );
      await admin.query(
        `UPDATE "${schemas.reader}".book_revisions SET sha256=$1 WHERE sha256=$2`,
        [pdfSha, "0".repeat(64)],
      );
      const sentinel = `${target.stores.bytes.prefix}/${tenantId}/ui/sentinel`;
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: sentinel,
          Body: "not empty",
        }),
      );
      await assert.rejects(
        restoreCloudApplicationStorage({
          location: target,
          backupDirectory: backup.destination,
          stagingRoot: targetStaging,
          writersStopped: true,
          pgRestorePath: process.env.MORPHZ_TEST_PG_RESTORE!,
        }),
        /prefix 已包含字节/,
      );
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: sentinel }));
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: `${source.stores.bytes.prefix}/${tenantId}/reader/blobs/${pdfSha.slice(0, 2)}/${pdfSha}`,
          Body: "corrupt after sealed backup",
        }),
      );
      await assert.rejects(
        backupCloudApplicationStorage({
          location: source,
          backupRoot,
          stagingRoot: sourceStaging,
          writersStopped: true,
          pgDumpPath: process.env.MORPHZ_TEST_PG_DUMP!,
        }),
        /长度损坏|摘要损坏/,
      );

      assert.match(
        runCloudCommand("restore", target, backup.destination, targetStaging),
        /云应用存储恢复并校验/,
      );
      workspaceB = new WorkspaceStore(join(directoryB, "workspace.sqlite"), {
        tenantId,
      });
      hostB = await openApplicationDomainsHost(
        directoryB,
        workspaceB,
        undefined,
        hostOptions(target, targetStaging),
      );
      await hostB.reader.authority.withSession(
        localAccess,
        () => {},
        async (actor) => {
          assert.deepEqual(
            await hostB!.reader.service.originalRange(
              actor,
              imported.entityId,
              imported.revision,
              0,
              pdf.length,
            ),
            pdf,
          );
        },
      );
      await hostB.images.authority.withSession(
        localAccess,
        () => {},
        async (actor) => {
          assert.deepEqual(
            (await hostB!.images.service.read(actor, image.assetId)).bytes,
            png,
          );
        },
      );
      await hostB.uiPackages!.authority.withSession(
        localAccess,
        () => {},
        async (actor) => {
          assert.deepEqual(
            await hostB!.uiPackages!.service.read(
              actor,
              manifest.id,
              manifest.version,
            ),
            manifest,
          );
        },
      );
    } finally {
      await hostB?.close();
      await hostA?.close();
      workspaceB?.close();
      workspaceA?.close();
      for (const schema of Object.values(schemas))
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      if (targetCreated)
        await admin.query(`DROP DATABASE "${targetDatabase}" WITH (FORCE)`);
      await admin.end();
      if (bucketCreated) {
        let continuation: string | undefined;
        do {
          const page = await s3.send(
            new ListObjectsV2Command({
              Bucket: bucket,
              ...(continuation ? { ContinuationToken: continuation } : {}),
            }),
          );
          for (const object of page.Contents ?? [])
            if (object.Key)
              await s3.send(
                new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }),
              );
          continuation = page.NextContinuationToken;
        } while (continuation);
        await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
      }
      s3.destroy();
      rmSync(parent, { recursive: true, force: true });
    }
  },
);
