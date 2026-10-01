import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  openApplicationDomainsHost,
  type PostgresApplicationDomains,
} from "../packages/application/src/application-domains-host.js";
import { createImage } from "../packages/application/src/document-service.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { applicationManifestFormat } from "../packages/core/src/application-names.js";
import { localAccess } from "../packages/core/src/model.js";

test(
  "云部署两个 Host 从同一私库和云 Store 读取阅读、图片与界面包原件",
  {
    skip:
      !process.env.MORPHZ_TEST_POSTGRES_URL ||
      !process.env.MORPHZ_TEST_S3_ENDPOINT,
    timeout: 120_000,
  },
  async () => {
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const suffix = randomUUID().replaceAll("-", "").slice(0, 20);
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
    const bucket = `morphz-host-test-${suffix}`;
    const prefix = `cloud-host-${suffix}`;
    const directoryA = mkdtempSync(join(tmpdir(), "morphz-cloud-host-a-"));
    const directoryB = mkdtempSync(join(tmpdir(), "morphz-cloud-host-b-"));
    const applications: PostgresApplicationDomains = {
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
    };
    const s3 = new S3Client({
      endpoint: process.env.MORPHZ_TEST_S3_ENDPOINT!,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.MORPHZ_TEST_S3_ACCESS_KEY ?? "test",
        secretAccessKey: process.env.MORPHZ_TEST_S3_SECRET_KEY ?? "test",
      },
    });
    const pg = new Pool({ connectionString });
    const bytes = {
      bucket,
      prefix,
      region: "us-east-1",
      endpoint: process.env.MORPHZ_TEST_S3_ENDPOINT!,
      forcePathStyle: true,
    };
    const optionsFor = (directory: string) => ({
      platform: {
        kind: "postgres" as const,
        connectionString,
        schema: schemas.platform,
      },
      applications,
      cloudStore: {
        stagingRoot: join(directory, "cloud-staging"),
        connectionString,
        schemas: {
          ui: schemas.ui,
          reader: schemas.readerBytes,
          images: schemas.images,
        },
        bytes,
        s3Client: s3,
      },
    });
    let workspaceA: WorkspaceStore | undefined;
    let workspaceB: WorkspaceStore | undefined;
    let hostA:
      Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
    let hostB:
      Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
    try {
      for (const schema of Object.values(schemas))
        await pg.query(`CREATE SCHEMA "${schema}"`);
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
      workspaceA = new WorkspaceStore(join(directoryA, "workspace.sqlite"));
      const tenantId = workspaceA.identity();
      hostA = await openApplicationDomainsHost(
        directoryA,
        workspaceA,
        undefined,
        optionsFor(directoryA),
      );
      const projectId = `project_${suffix}`;
      await hostA.content.authority.withSession(
        localAccess,
        () => {},
        (actor) =>
          hostA!.content.platform.createProject(actor, {
            commandId: `project_${suffix}`,
            projectId,
            title: "跨 Host 云原件",
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
            commandId: `book_${suffix}`,
            projectId,
            name: "云端原件.pdf",
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
            title: "云端图片",
            assetId: uploaded.assetId,
            alt: "测试图片",
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
        id: "example.cloud-notes",
        version: "1.0.0",
        title: "云便笺",
        description: "跨 Host 打开界面包",
        icon: "document" as const,
        permissions: ["artifacts.read" as const],
        harness: null,
        ui: {
          type: "sandbox" as const,
          html: "<!doctype html><title>同一份云端界面包</title>",
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

      workspaceB = new WorkspaceStore(join(directoryB, "workspace.sqlite"), {
        tenantId,
      });
      hostB = await openApplicationDomainsHost(
        directoryB,
        workspaceB,
        undefined,
        optionsFor(directoryB),
      );
      await hostB.reader.authority.withSession(
        localAccess,
        () => {},
        async (actor) => {
          const read = await hostB!.reader.service.originalRange(
            actor,
            imported.entityId,
            imported.revision,
            0,
            pdf.length,
          );
          assert.deepEqual(read, pdf);
        },
      );
      await hostB.images.authority.withSession(
        localAccess,
        () => {},
        async (actor) => {
          const read = await hostB!.images.service.read(actor, image.assetId);
          assert.equal(read.mime, image.mime);
          assert.deepEqual(read.bytes, png);
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
      await assert.rejects(
        openApplicationDomainsHost(directoryB, workspaceB, undefined, {
          ...optionsFor(directoryB),
          cloudStore: {
            ...optionsFor(directoryB).cloudStore,
            bytes: { ...bytes, prefix: `${prefix}-wrong` },
          },
        }),
        /字节位置与 manifest 绑定不一致/,
      );
    } finally {
      await hostB?.close();
      await hostA?.close();
      workspaceB?.close();
      workspaceA?.close();
      for (const schema of Object.values(schemas))
        await pg.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pg.end();
      try {
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
                new DeleteObjectCommand({
                  Bucket: bucket,
                  Key: object.Key,
                }),
              );
          continuation = page.NextContinuationToken;
        } while (continuation);
        await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
      } finally {
        s3.destroy();
        rmSync(directoryA, { recursive: true, force: true });
        rmSync(directoryB, { recursive: true, force: true });
      }
    }
  },
);
