import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import sharp from "sharp";
import {
  PlatformStore,
  type PlatformAuthorityVerifier,
} from "../packages/platform/src/store.js";
import { ProfileAvatarService } from "../packages/application/src/profile-avatar-service.js";

// Only the S3 command boundary is controlled here. PostgreSQL manifests, two
// Host instances, original bytes, decoder, CAS and authorization are real.
// This does not stand in for a real provider or whole deployment backup test.
function controlledS3() {
  const objects = new Map<string, Buffer>();
  let blobPuts = 0,
    failPoster = true;
  const fail = (status: number) =>
    Object.assign(new Error(`fixture S3 ${status}`), {
      $metadata: { httpStatusCode: status },
    });
  const client = {
    async send(command: unknown) {
      if (!(
        command instanceof HeadObjectCommand ||
        command instanceof GetObjectCommand ||
        command instanceof PutObjectCommand
      ))
        throw new Error("Unexpected avatar S3 command");
      assert.equal(command.input.Bucket, "profile-fixture");
      const key = command.input.Key!;
      assert.ok(key.startsWith("profile/avatar/"));
      if (command instanceof PutObjectCommand) {
        if (key.includes("/blobs/")) {
          blobPuts++;
          if (blobPuts === 2 && failPoster) {
            failPoster = false;
            throw fail(503);
          }
        }
        if (objects.has(key) && command.input.IfNoneMatch === "*")
          throw fail(412);
        const chunks: Buffer[] = [];
        if (command.input.Body instanceof Uint8Array)
          chunks.push(Buffer.from(command.input.Body));
        else
          for await (const part of command.input
            .Body as AsyncIterable<Uint8Array>)
            chunks.push(Buffer.from(part));
        const bytes = Buffer.concat(chunks);
        assert.equal(bytes.length, command.input.ContentLength);
        if (command.input.ChecksumSHA256)
          assert.equal(
            createHash("sha256").update(bytes).digest("base64"),
            command.input.ChecksumSHA256,
          );
        objects.set(key, bytes);
        return { ETag: createHash("sha256").update(bytes).digest("hex") };
      }
      const full = objects.get(key);
      if (!full) throw fail(404);
      const result = {
        ContentLength: full.length,
        ETag: createHash("sha256").update(full).digest("hex"),
      };
      if (command instanceof HeadObjectCommand) return result;
      const range = command.input.Range?.match(/^bytes=(\d+)-(\d+)$/);
      const bytes = range
        ? full.subarray(Number(range[1]), Number(range[2]) + 1)
        : full;
      return {
        ...result,
        ContentLength: bytes.length,
        ...(range
          ? { ContentRange: `bytes ${range[1]}-${range[2]}/${full.length}` }
          : {}),
        Body: {
          async *[Symbol.asyncIterator]() {
            yield bytes;
          },
        },
      };
    },
  } as unknown as S3Client;
  return { client, objects };
}

const postgresUrl = process.env.MORPHZ_TEST_POSTGRES_URL;
test(
  "头像云 Store 协议：两个真实 PG Host 共读、半发布重试、本人隔离与损坏拒绝（受控 S3）",
  { skip: !postgresUrl },
  async () => {
    const suffix = randomUUID().replaceAll("-", ""),
      tenantId = randomUUID(),
      platformSchema = "profilep_" + suffix,
      avatarSchema = "profilea_" + suffix,
      root = mkdtempSync(join(tmpdir(), "morphz-profile-cloud-"));
    const admin = new Pool({ connectionString: postgresUrl! }),
      plane = controlledS3();
    let platformA: PlatformStore | undefined,
      platformB: PlatformStore | undefined,
      avatarsA: ProfileAvatarService | undefined,
      avatarsB: ProfileAvatarService | undefined;
    const verifier = (
      avatars: () => ProfileAvatarService | undefined,
    ): PlatformAuthorityVerifier => ({
      async resolveActor(actor) {
        return ["alice", "bob"].includes(actor.credential)
          ? {
              tenantId,
              principalId: actor.credential,
              actantId: actor.credential + "-human",
              kind: "human",
              runtimeInputId: null,
            }
          : null;
      },
      async resolveActant() {
        return null;
      },
      async resolveProjectAgent() {
        return null;
      },
      async verifyApplicationObject() {
        return false;
      },
      async resolveProfileAgent() {
        return { agentId: "team-kernel", editable: false };
      },
      async verifyProfileAvatar({ actor, subject, subjectId, media }) {
        return (
          !!avatars() &&
          avatars()!.verifyMedia(actor, subject, subjectId, media)
        );
      },
    });
    try {
      await admin.query(`CREATE SCHEMA "${platformSchema}"`);
      await admin.query(`CREATE SCHEMA "${avatarSchema}"`);
      const verifierA = verifier(() => avatarsA),
        verifierB = verifier(() => avatarsB);
      platformA = await PlatformStore.postgres(
        { connectionString: postgresUrl!, schema: platformSchema },
        verifierA,
      );
      await platformA.provisionTenant(tenantId);
      platformB = await PlatformStore.postgres(
        { connectionString: postgresUrl!, schema: platformSchema },
        verifierB,
      );
      const cloud = {
        connectionString: postgresUrl!,
        schema: avatarSchema,
        bytes: {
          bucket: "profile-fixture",
          prefix: "profile/avatar",
          region: "us-east-1",
        },
        s3Client: plane.client,
      };
      avatarsA = await ProfileAvatarService.open({
        root: join(root, "host-a"),
        tenantId,
        platform: platformA,
        verifier: verifierA,
        cloud,
      });
      avatarsB = await ProfileAvatarService.open({
        root: join(root, "host-b"),
        tenantId,
        platform: platformB,
        verifier: verifierB,
        cloud,
      });
      const original = await sharp({
          create: {
            width: 320,
            height: 160,
            channels: 4,
            background: "#31b8bb",
          },
        })
          .png()
          .toBuffer(),
        actor = { credential: "alice" },
        command = {
          subject: "human" as const,
          commandId: "same-command",
          expectedRevision: 0,
        };
      await assert.rejects(
        avatarsA.set(actor, command, original),
        /fixture S3 503/,
      );
      assert.deepEqual(await platformA.readProfileAvatar(actor, "human"), {
        revision: 0,
        media: null,
      });
      const result = await avatarsB.set(actor, command, original);
      assert.equal(result.revision, 1);
      assert.deepEqual(
        await platformA.readProfileAvatar(actor, "human"),
        result,
      );
      assert.deepEqual(await avatarsA.set(actor, command, original), result);
      assert.deepEqual(
        Buffer.from(
          (
            await avatarsA.read(actor, {
              subject: "human",
              revision: 1,
              variant: "original",
            })
          ).bytes,
        ),
        original,
      );
      const poster = await avatarsB.read(actor, {
        subject: "human",
        revision: 1,
        variant: "poster",
      });
      const metadata = await sharp(poster.bytes).metadata();
      assert.equal(metadata.width, 256);
      assert.equal(metadata.height, 128);
      await assert.rejects(
        avatarsB.read(
          { credential: "bob" },
          { subject: "human", revision: 1, variant: "original" },
        ),
        /已更新/,
      );
      await assert.rejects(
        avatarsB.set(
          actor,
          { ...command, subject: "agent", commandId: "no-team-write" },
          original,
        ),
        /只读/,
      );
      const key = `profile/avatar/blobs/${result.media!.original.sha256.slice(0, 2)}/${result.media!.original.sha256}`;
      const corrupted = Buffer.from(plane.objects.get(key)!);
      corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 1;
      plane.objects.set(key, corrupted);
      await assert.rejects(
        avatarsA.read(actor, {
          subject: "human",
          revision: 1,
          variant: "original",
        }),
        /摘要|校验|损坏|不匹配/,
      );
      assert.deepEqual(
        await platformB.readProfileAvatar(actor, "human"),
        result,
      );
      const receipts = await admin.query<{ n: string }>(
        `SELECT count(*) AS n FROM "${platformSchema}".command_receipts WHERE operation='profile-avatar'`,
      );
      assert.equal(Number(receipts.rows[0]!.n), 1);
    } finally {
      await avatarsA?.close();
      await avatarsB?.close();
      await platformA?.close();
      await platformB?.close();
      for (const schema of [avatarSchema, platformSchema])
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
