import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  promises as fsPromises,
  readFileSync,
  writeFileSync,
  renameSync,
  statSync,
  fstatSync,
} from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import { localAccess } from "../packages/core/src/model.js";
import { ManagedArtifactStore } from "../packages/managed-artifact-store/src/store.js";

const postgresUrl = process.env.MORPHZ_TEST_POSTGRES_URL;
const chunkSize = 1024 * 1024;
const other = { principalId: "range-other", actantId: "range-other-actant" };
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** Valid PDF comments before the existing xref enlarge the original without
 * changing its pages/text. Existing object offsets stay fixed; startxref moves.
 */
function largePdf() {
  const original = readFileSync(
    new URL("./fixtures/reader.pdf", import.meta.url),
  );
  const tail = original.toString("latin1").match(/startxref\s+(\d+)\s+%%EOF/);
  assert.ok(tail);
  const xref = Number(tail[1]);
  const padding = Buffer.from(("%" + "x".repeat(1022) + "\n").repeat(2048));
  return Buffer.concat([
    original.subarray(0, xref),
    padding,
    Buffer.from(
      original
        .subarray(xref)
        .toString("latin1")
        .replace(/startxref\s+\d+/, `startxref\n${xref + padding.length}`),
      "latin1",
    ),
  ]);
}

/** Observe actual file-handle reads, not a fake byte provider. File identity is
 * checked by inode/device; the real implementation still reads the real bytes.
 */
async function observeBytes<T>(
  path: string,
  work: () => Promise<T>,
  afterRead?: () => Promise<void>,
) {
  const probe = await fsPromises.open(path, "r");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  const target = statSync(path);
  const originalRead = prototype.read;
  const reads: Array<{ bytes: number; position: number }> = [];
  let triggered = false;
  prototype.read = async function (this: FileHandle, ...arguments_: unknown[]) {
    const source = fstatSync(this.fd);
    const result = (await Reflect.apply(originalRead, this, arguments_)) as {
      bytesRead: number;
    };
    if (source.dev === target.dev && source.ino === target.ino) {
      reads.push({ bytes: result.bytesRead, position: Number(arguments_[3]) });
      if (afterRead && !triggered) {
        triggered = true;
        await afterRead();
      }
    }
    return result;
  } as typeof prototype.read;
  try {
    return { value: await work(), reads };
  } finally {
    prototype.read = originalRead;
  }
}

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: Reader PDF 小 Range 不扫描全原件，实际块校验和当前授权仍有效`,
    { skip: backend === "postgres" && !postgresUrl },
    async () => {
      const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
      const schemas = {
        platform: `rp_${suffix}`,
        objects: `ro_${suffix}`,
        scriptStudio: `rs_${suffix}`,
        reader: `rr_${suffix}`,
        browser: `rb_${suffix}`,
        manifest: `rm_${suffix}`,
      };
      const admin =
        backend === "postgres"
          ? new Pool({ connectionString: postgresUrl })
          : null;
      let h: Awaited<ReturnType<typeof agentDomainFixture>> | undefined;
      let store: ManagedArtifactStore | undefined;
      try {
        if (admin)
          for (const schema of Object.values(schemas))
            await admin.query(`CREATE SCHEMA "${schema}"`);
        h = await agentDomainFixture({
          additionalHumans: [other],
          ...(admin
            ? {
                storage: {
                  platform: {
                    kind: "postgres" as const,
                    connectionString: postgresUrl!,
                    schema: schemas.platform,
                  },
                  applications: {
                    deploymentId: `range_${suffix}`,
                    connectionStrings: {
                      objects: postgresUrl!,
                      scriptStudio: postgresUrl!,
                      reader: postgresUrl!,
                      browser: postgresUrl!,
                    },
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
        const pdf = largePdf();
        const digest = sha(pdf);
        const imported = await h.withHuman((actor) =>
          h!.domains.reader.service.import(actor, {
            commandId: randomUUID(),
            projectId: h!.projectId,
            name: "大原件.pdf",
            bytes: pdf,
          }),
        );
        const readerBlob = join(
          h.directory,
          "reader-originals",
          "blobs",
          digest.slice(0, 2),
          digest,
        );
        const readOriginal = (start = 13, end = 29) =>
          h!.withHuman((actor) =>
            h!.domains.reader.service.originalRange(
              actor,
              imported.entityId,
              1,
              start,
              end,
            ),
          );
        const metadata = () =>
          h!.withHuman((actor) =>
            h!.domains.reader.service.originalMetadata(
              actor,
              imported.entityId,
              1,
            ),
          );
        const first = await observeBytes(readerBlob, async () => {
          assert.deepEqual(await metadata(), {
            byteLength: pdf.length,
            sha256: digest,
          });
          assert.deepEqual(
            Buffer.from(await readOriginal()),
            pdf.subarray(13, 29),
          );
        });
        assert.deepEqual(
          first.reads,
          [{ bytes: chunkSize, position: 0 }],
          "metadata reads zero bytes; a 16-byte request verifies only its 1 MiB chunk",
        );
        const corruption = Buffer.from(pdf);
        corruption[chunkSize + 31] = corruption[chunkSize + 31]! ^ 1;
        writeFileSync(readerBlob, corruption);
        const untouched = await observeBytes(readerBlob, async () => {
          await metadata();
          return readOriginal();
        });
        assert.deepEqual(Buffer.from(untouched.value), pdf.subarray(13, 29));
        assert.deepEqual(untouched.reads, [{ bytes: chunkSize, position: 0 }]);
        await assert.rejects(
          readOriginal(chunkSize + 30, chunkSize + 33),
          /分块摘要损坏/,
        );
        writeFileSync(readerBlob, pdf);
        const absent = `${readerBlob}.absent`;
        renameSync(readerBlob, absent);
        try {
          await assert.rejects(metadata(), /ENOENT/);
        } finally {
          renameSync(absent, readerBlob);
        }
        await assert.rejects(
          h.domains.reader.authority.withSession(
            other,
            () => {},
            (actor) =>
              h!.domains.reader.service.originalMetadata(
                actor,
                imported.entityId,
                1,
              ),
          ),
          /内容不存在或无权访问/,
        );
        await assert.rejects(
          h.withHuman((actor) =>
            h!.domains.reader.service.originalMetadata(
              actor,
              imported.entityId,
              99,
            ),
          ),
          /阅读书籍原件缺少派生阅读数据/,
        );
        await h.reopen();
        const cold = await observeBytes(readerBlob, async () => {
          await metadata();
          return readOriginal();
        });
        assert.deepEqual(Buffer.from(cold.value), pdf.subarray(13, 29));
        assert.deepEqual(cold.reads, [{ bytes: chunkSize, position: 0 }]);

        // Exercise both manifest backends independently of the Host's accepted
        // local-byte deployment. Credentials are real Human capabilities and
        // authorization uses the actual Platform, not a test identity resolver.
        const root = join(h.directory, "range-manifest");
        const storeOptions = {
          root,
          storeId: "range-byte-store",
          authorizer: {
            async authorize(credential: string, request: { storeId: string }) {
              if (request.storeId !== "range-byte-store")
                throw new Error("Store 身份不一致。");
              const actor =
                await h!.domains.content.platform.authorizeContentProject(
                  { credential },
                  h!.domains.content.instanceIds.objects,
                  "morphz.objects",
                  h!.projectId,
                  h!.domains.content.provider(),
                );
              return {
                tenantId: actor.tenantId,
                principalId: actor.principalId,
              };
            },
          },
        };
        const openStore = () =>
          admin
            ? ManagedArtifactStore.postgres({
                ...storeOptions,
                connectionString: postgresUrl!,
                schema: schemas.manifest,
              })
            : ManagedArtifactStore.sqlite(storeOptions);
        store = await openStore();
        const stored = await h.withHuman((actor) =>
          store!.put({
            credential: actor.credential,
            artifactId: "pdf-original",
            commandId: "pdf-put",
            baseRevision: 0,
            mime: "application/pdf",
            bytes: pdf,
          }),
        );
        const nextBytes = Buffer.from(pdf);
        nextBytes[chunkSize + 17] = nextBytes[chunkSize + 17]! ^ 1;
        const nextVersion = await h.withHuman((actor) =>
          store!.put({
            credential: actor.credential,
            artifactId: stored.artifactId,
            commandId: "pdf-put-next",
            baseRevision: 1,
            mime: "application/pdf",
            bytes: nextBytes,
          }),
        );
        assert.equal(nextVersion.revision, 2);
        assert.deepEqual(
          await h.withHuman((actor) =>
            store!.readVersionMetadata({
              credential: actor.credential,
              artifactId: stored.artifactId,
            }),
          ),
          nextVersion,
        );
        const blob = join(root, "blobs", digest.slice(0, 2), digest);
        const metadataRequest = (credential: string) => ({
          credential,
          artifactId: stored.artifactId,
          revision: 1,
        });
        const direct = () =>
          h!.withHuman(async (actor) => {
            assert.deepEqual(
              await store!.readVersionMetadata(
                metadataRequest(actor.credential),
              ),
              stored,
            );
            return store!.readRange({
              ...metadataRequest(actor.credential),
              start: 13,
              endExclusive: 29,
            });
          });
        assert.deepEqual((await observeBytes(blob, direct)).reads, [
          { bytes: chunkSize, position: 0 },
        ]);
        await assert.rejects(
          h.withHuman((actor) =>
            store!.readVersionMetadata({
              ...metadataRequest(actor.credential),
              revision: 99,
            }),
          ),
          /Artifact 版本不存在/,
        );
        await assert.rejects(
          store.readVersionMetadata(metadataRequest("model-supplied-identity")),
          /身份|凭据|授权/,
        );
        writeFileSync(blob, pdf.subarray(0, pdf.length - 1));
        await assert.rejects(
          h.withHuman((actor) =>
            store!.readVersionMetadata(metadataRequest(actor.credential)),
          ),
          /字节缺失或长度损坏/,
        );
        writeFileSync(blob, pdf);
        writeFileSync(blob, corruption);
        assert.deepEqual((await observeBytes(blob, direct)).reads, [
          { bytes: chunkSize, position: 0 },
        ]);
        await assert.rejects(
          h.withHuman((actor) =>
            store!.verifyVersion(metadataRequest(actor.credential)),
          ),
          /分块摘要损坏/,
        );
        await assert.rejects(
          h.withHuman((actor) =>
            store!.readRange({
              ...metadataRequest(actor.credential),
              start: chunkSize + 30,
              endExclusive: chunkSize + 33,
            }),
          ),
          /分块摘要损坏/,
        );
        writeFileSync(blob, pdf);
        await store.close();
        store = await openStore();
        assert.deepEqual((await observeBytes(blob, direct)).reads, [
          { bytes: chunkSize, position: 0 },
        ]);
        h.assertNoLegacyData();
        const revoke = async () =>
          h!.identity!.replaceConfiguration(
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
          observeBytes(blob, direct, revoke),
          /身份|权限|失效/,
          "revocation after the actual file read must reject before exposing bytes",
        );
        await assert.rejects(metadata(), /身份|权限|失效/);
        console.log(
          `${backend}: ${pdf.length} bytes original, metadata=0 bytes, range=16 bytes, verified IO=${chunkSize} bytes`,
        );
      } finally {
        await store?.close();
        await h?.close();
        if (admin) {
          for (const schema of Object.values(schemas))
            await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          await admin.end();
        }
      }
    },
  );
}
