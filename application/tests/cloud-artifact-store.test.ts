import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  ManagedArtifactStore,
  type StoreAuthorizer,
} from "../packages/managed-artifact-store/src/store.js";
import {
  S3BlobBytes,
  type S3StoreBinding,
} from "../packages/managed-artifact-store/src/s3-bytes.js";
import { cloudByteBindingSchemaSql } from "../packages/managed-artifact-store/src/cloud-schema.js";
import { readFileSync } from "node:fs";

const authorizer: StoreAuthorizer = {
  async authorize(credential, request) {
    if (request.storeId !== "cloud-store-one" || credential !== "alice")
      throw new Error("云 Store 未获授权。");
    return { tenantId: "tenant-one", principalId: "alice" };
  },
};

test("云 Store 扩展 schema 与评审 SQL 相同", () => {
  assert.equal(
    cloudByteBindingSchemaSql.trim(),
    readFileSync(
      new URL(
        "../docs/storage-model-v1/cloud-artifact-store-extension.sql",
        import.meta.url,
      ),
      "utf8",
    ).trim(),
  );
});

test("云 Store 身份只绑定 bucket 与 prefix，不被可替换的网关端点改变", () => {
  const first = new S3BlobBytes({
    bucket: "morphz-data",
    prefix: "center/ui",
    region: "us-east-1",
    endpoint: "https://s3-gateway-one.example.test",
  });
  const second = new S3BlobBytes({
    bucket: "morphz-data",
    prefix: "center/ui",
    region: "us-west-2",
    endpoint: "https://s3-gateway-two.example.test",
  });
  const other = new S3BlobBytes({
    bucket: "morphz-data",
    prefix: "center/reader",
    region: "us-east-1",
  });
  try {
    assert.equal(first.locatorSha256, second.locatorSha256);
    assert.notEqual(first.locatorSha256, other.locatorSha256);
  } finally {
    first.close();
    second.close();
    other.close();
  }
});

test("云 Store 根格式只在初始化升级：同一身份条件发布，失败及丢回执可重试，不接受旧节点路由", async () => {
  const expected: S3StoreBinding = {
    format: 2,
    backend: "s3",
    storeId: "store-one",
    schema: "store_schema",
    database: "store_database",
    bindingId: randomUUID(),
    bucket: "morphz-data",
    prefix: "center/ui",
  };
  for (const failure of ["before", "after"] as const) {
    let value: object = { ...expected, format: 1, nodeId: null };
    let etag = "original-etag";
    let puts = 0;
    let failed = false;
    const client = {
      async send(command: unknown) {
        const bytes = Buffer.from(JSON.stringify(value));
        if (command instanceof HeadObjectCommand)
          return { ContentLength: bytes.length, ETag: etag };
        if (command instanceof GetObjectCommand)
          return {
            ContentLength: bytes.length,
            ETag: etag,
            Body: {
              async *[Symbol.asyncIterator]() {
                yield bytes;
              },
            },
          };
        if (!(command instanceof PutObjectCommand))
          throw new Error("unexpected S3 operation");
        assert.equal(command.input.IfMatch, etag);
        assert.equal(command.input.IfNoneMatch, undefined);
        puts++;
        if (!failed && failure === "before") {
          failed = true;
          throw new Error("test: publish failed");
        }
        value = JSON.parse(
          Buffer.from(command.input.Body as Uint8Array).toString("utf8"),
        );
        etag = "upgraded-etag";
        if (!failed && failure === "after") {
          failed = true;
          throw new Error("test: acknowledgement lost");
        }
        return { ETag: etag };
      },
    } as unknown as S3Client;
    const plane = new S3BlobBytes(
      { bucket: expected.bucket, prefix: expected.prefix, region: "us-east-1" },
      client,
    );
    try {
      await plane.validateBinding(expected, false);
      assert.equal(puts, 0);
      await assert.rejects(plane.bind(expected, false), /test:/);
      await plane.bind(expected, false);
      assert.deepEqual(value, expected);
      assert.equal(puts, failure === "before" ? 2 : 1);
      await plane.bind(expected, false);
      assert.equal(puts, failure === "before" ? 2 : 1);
      value = { ...expected, nodeId: "remote-node" };
      await assert.rejects(plane.bind(expected, false), /身份不匹配/);
      value = { ...expected, format: 1, nodeId: null, bindingId: randomUUID() };
      await assert.rejects(
        plane.validateBinding(expected, false),
        /身份不匹配/,
      );
    } finally {
      plane.close();
    }
  }
});

test(
  "云 Store：两个 Host 共读原件、精确版本、备份恢复和损坏拒绝",
  {
    skip:
      !process.env.MORPHZ_TEST_POSTGRES_URL ||
      !process.env.MORPHZ_TEST_S3_ENDPOINT,
    timeout: 60_000,
  },
  async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const schema = `cloud_store_${suffix}`;
    const restoredSchema = `cloud_restore_${suffix}`;
    const bucket = `morphz-test-${suffix}`;
    const parent = mkdtempSync(join(tmpdir(), "morphz-cloud-store-"));
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
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
      prefix: "managed/cloud-store-one",
      region: "us-east-1",
      endpoint: process.env.MORPHZ_TEST_S3_ENDPOINT!,
      forcePathStyle: true,
    };
    let first: ManagedArtifactStore | undefined;
    let second: ManagedArtifactStore | undefined;
    let restored: ManagedArtifactStore | undefined;
    try {
      await pg.query(`CREATE SCHEMA "${schema}"`);
      await pg.query(`CREATE SCHEMA "${restoredSchema}"`);
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
      first = await ManagedArtifactStore.cloud({
        root: join(parent, "host-one"),
        storeId: "cloud-store-one",
        schema,
        connectionString,
        bytes,
        s3Client: s3,
        authorizer,
      });
      const content = Buffer.alloc(1024 * 1024 + 23, 0x61);
      content.fill(0x62, 1024 * 1024);
      const sha256 = createHash("sha256").update(content).digest("hex");
      const version = await first.put({
        credential: "alice",
        commandId: "cloud-first-put",
        artifactId: "artifact-one",
        baseRevision: 0,
        mime: "application/pdf",
        expectedSha256: sha256,
        bytes: content,
      });
      second = await ManagedArtifactStore.cloud({
        root: join(parent, "host-two"),
        storeId: "cloud-store-one",
        schema,
        connectionString,
        bytes,
        s3Client: s3,
        authorizer,
      });
      assert.deepEqual(
        (
          await second.readRange({
            credential: "alice",
            artifactId: "artifact-one",
            start: 1024 * 1024 - 5,
            endExclusive: 1024 * 1024 + 8,
          })
        ).bytes,
        content.subarray(1024 * 1024 - 5, 1024 * 1024 + 8),
      );
      assert.deepEqual(
        await second.verifyVersion({
          credential: "alice",
          artifactId: "artifact-one",
        }),
        version,
      );
      assert.deepEqual(
        await second.put({
          credential: "alice",
          commandId: "cloud-first-put",
          artifactId: "artifact-one",
          baseRevision: 0,
          mime: "application/pdf",
          bytes: content,
        }),
        version,
      );
      await s3.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: `managed/cloud-store-one/blobs/${sha256.slice(0, 2)}/${sha256}`,
        }),
      );
      assert.deepEqual(
        await second.put({
          credential: "alice",
          commandId: "cloud-first-put",
          artifactId: "artifact-one",
          baseRevision: 0,
          mime: "application/pdf",
          bytes: content,
        }),
        version,
      );
      await assert.rejects(
        second.readRange({ credential: "bob", artifactId: "artifact-one" }),
        /未获授权/,
      );
      await assert.rejects(
        ManagedArtifactStore.cloud({
          root: join(parent, "wrong-location"),
          storeId: "cloud-store-one",
          schema,
          connectionString,
          bytes: { ...bytes, prefix: "different/location" },
          s3Client: s3,
          authorizer,
        }),
        /字节位置与 manifest 绑定不一致/,
      );
      const backup = join(parent, "backup");
      await first.backupTo(backup);
      restored = await ManagedArtifactStore.restoreCloud({
        root: join(parent, "restored"),
        storeId: "cloud-store-one",
        schema: restoredSchema,
        connectionString,
        bytes: { ...bytes, prefix: "managed/restored" },
        s3Client: s3,
        authorizer,
        backupDirectory: backup,
      });
      assert.deepEqual(
        (
          await restored.readRange({
            credential: "alice",
            artifactId: "artifact-one",
          })
        ).bytes,
        content,
      );
      assert.deepEqual((await first.inspectIntegrity()).damaged, []);
      const orphan = Buffer.from("unreferenced cloud test bytes", "utf8");
      const orphanSha = createHash("sha256").update(orphan).digest("hex");
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: `managed/cloud-store-one/blobs/${orphanSha.slice(0, 2)}/${orphanSha}`,
          Body: orphan,
        }),
      );
      assert.deepEqual((await first.inspectIntegrity()).orphans, [orphanSha]);
      assert.deepEqual(
        (await first.quarantineOrphanBlobs({ minAgeMs: 0 })).quarantined,
        [orphanSha],
      );
      assert.deepEqual((await first.inspectIntegrity()).orphans, []);
      assert.deepEqual(
        (await first.purgeQuarantinedOrphans({ minAgeMs: 0 })).removed,
        [orphanSha],
      );
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: `managed/cloud-store-one/blobs/${sha256.slice(0, 2)}/${sha256}`,
          Body: Buffer.from("corrupted"),
        }),
      );
      await assert.rejects(
        second.readRange({ credential: "alice", artifactId: "artifact-one" }),
        /分块范围|分块摘要|长度/,
      );
      assert.deepEqual((await first.inspectIntegrity()).damaged, [sha256]);
      await s3.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: "managed/cloud-store-one/store-binding.json",
        }),
      );
      await assert.rejects(
        ManagedArtifactStore.cloud({
          root: join(parent, "missing-binding"),
          storeId: "cloud-store-one",
          schema,
          connectionString,
          bytes,
          s3Client: s3,
          authorizer,
        }),
        /身份标记缺失/,
      );
    } finally {
      await restored?.close();
      await second?.close();
      await first?.close();
      await pg.query(`DROP SCHEMA IF EXISTS "${restoredSchema}" CASCADE`);
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
        rmSync(parent, { recursive: true, force: true });
      }
    }
  },
);
