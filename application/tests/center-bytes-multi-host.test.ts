import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { Application } from "../packages/application/src/application.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import { IdentityCenter } from "../packages/application/src/identity.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { applicationManifestFormat } from "../packages/core/src/application-names.js";
import type { ApplicationMethod } from "../packages/core/src/application-api.js";
import { localAccess } from "../packages/core/src/model.js";

const postgresUrl = process.env.MORPHZ_TEST_POSTGRES_URL;
const sha = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
type Domains = Awaited<ReturnType<typeof openApplicationDomainsHost>>;

// This is the reviewed co-located center deployment: independently opened
// Hosts share an explicitly selected center directory, not each other's queues.
// It does not prove arbitrary remote filesystems, S3, or an Edge Store channel.
for (const backend of ["sqlite", "postgres"] as const)
  test(
    `${backend}: 两个独立 Host 通过同一明确中心保存方读取 Reader、图片和 UI 包字节`,
    { skip: backend === "postgres" && !postgresUrl },
    async () => {
      const root = mkdtempSync(join(tmpdir(), "morphz-center-bytes-"));
      const center = join(root, "center");
      mkdirSync(center);
      const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
      const schemas = {
        platform: `bytes_p_${suffix}`,
        objects: `bytes_o_${suffix}`,
        scriptStudio: `bytes_s_${suffix}`,
        reader: `bytes_r_${suffix}`,
        browser: `bytes_b_${suffix}`,
        ui: `bytes_u_${suffix}`,
      };
      const admin =
        backend === "postgres"
          ? new Pool({ connectionString: postgresUrl })
          : null;
      const options: Parameters<typeof openApplicationDomainsHost>[3] = admin
        ? {
            platform: {
              kind: "postgres",
              connectionString: postgresUrl!,
              schema: schemas.platform,
            },
            applications: {
              deploymentId: `bytes_${suffix}`,
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
            uiPackages: {
              root: join(center, "ui-packages"),
              postgres: { connectionString: postgresUrl!, schema: schemas.ui },
            },
          }
        : {
            platform: { kind: "sqlite" },
            retirementInputCoverage: "cross-host-unverified",
          };
      const aliceToken = "a".repeat(64),
        bobToken = "b".repeat(64);
      const bob = {
        principalId: "other-human",
        actantId: "other-human-actant",
      };
      const configuration = {
        version: 1,
        members: [
          { ...localAccess, loginTokenHash: sha(aliceToken), enabled: true },
          { ...bob, loginTokenHash: sha(bobToken), enabled: true },
        ],
      };
      type Host = {
        transport: WorkspaceStore;
        identity: IdentityCenter;
        domains: Domains;
        application: Application;
        connections: LocalApplicationConnection[];
      };
      let hostA: Host | undefined, hostB: Host | undefined;
      let tenantId: string | undefined;
      async function openHost(
        name: string,
        directory = center,
        storage = options,
      ): Promise<Host> {
        const transport = new WorkspaceStore(
          join(root, `host-${name}.sqlite`),
          { mode: "transport", ...(tenantId ? { tenantId } : {}) },
        );
        tenantId ??= transport.identity();
        const identity = new IdentityCenter(transport, configuration);
        try {
          const domains = await openApplicationDomainsHost(
            directory,
            transport,
            identity,
            storage,
          );
          const application = new Application(transport, {
            identity,
            platformWork: domains.work,
            platformDocuments: domains.content,
            platformReader: domains.reader,
            images: domains.images,
            uiPackages: domains.uiPackages,
          });
          return { transport, identity, domains, application, connections: [] };
        } catch (error) {
          transport.close();
          throw error;
        }
      }
      async function client(host: Host, token = aliceToken) {
        const connection = new LocalApplicationConnection(host.application);
        host.connections.push(connection);
        await connection.call("login", { token });
        const boot = (await connection.call("platform.bootstrap")) as {
          csrfToken: string;
        };
        return {
          connection,
          call: <T = unknown>(method: ApplicationMethod, params?: unknown) =>
            connection.call(method, params, {
              identityGeneration: boot.csrfToken,
            }) as Promise<T>,
        };
      }
      async function closeHost(host: Host | undefined) {
        if (!host) return;
        for (const connection of host.connections) connection.close();
        await host.domains.close();
        host.transport.close();
      }
      try {
        if (admin)
          for (const schema of Object.values(schemas))
            await admin.query(`CREATE SCHEMA "${schema}"`);
        hostA = await openHost("a");
        hostB = await openHost("b");
        assert.notEqual(hostA.transport, hostB.transport);
        assert.notEqual(
          hostA.domains.content.platform,
          hostB.domains.content.platform,
        );
        assert.equal(hostA.transport.identity(), hostB.transport.identity());
        hostA.transport.saveServiceState("private-delivery-evidence", {
          owner: "A",
        });
        assert.equal(
          hostB.transport.serviceState("private-delivery-evidence"),
          null,
        );
        let a = await client(hostA),
          b = await client(hostB);
        const projectId = "shared-center-project";
        await a.call("projects.create", {
          commandId: randomUUID(),
          projectId,
          title: "共置中心验证",
        });

        const pdf = readFileSync(
          new URL("./fixtures/reader.pdf", import.meta.url),
        );
        const importRequest = {
          commandId: randomUUID(),
          projectId,
          relativePath: "中心原页.pdf",
          data: pdf,
        };
        const imported = await a.call<{
          entityId: string;
          revision: number;
          receiptId: string;
        }>("reader.import", importRequest);
        assert.equal(imported.revision, 1);
        assert.deepEqual(
          await b.call("reader.import", importRequest),
          imported,
          "another Host recovers the exact original import receipt",
        );
        const readPdf = async (c: typeof a) => {
          assert.deepEqual(
            await c.connection.readerOriginalMetadata(imported.entityId, 1),
            { byteLength: pdf.length, sha256: sha(pdf) },
          );
          assert.deepEqual(
            Buffer.from(
              await c.connection.readerOriginalRange(
                imported.entityId,
                1,
                0,
                pdf.length,
              ),
            ),
            pdf,
          );
          await assert.rejects(
            c.connection.readerOriginalMetadata(imported.entityId, 2),
          );
        };
        await Promise.all([readPdf(a), readPdf(b)]);
        if (admin) {
          const privateRoot = join(root, "private-reader");
          mkdirSync(privateRoot);
          await assert.rejects(
            openHost("private-reader", privateRoot),
            /缺少原件 Store/,
          );
        }

        const png = Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLytQAAAABJRU5ErkJggg==",
          "base64",
        );
        const replacement = Buffer.concat([png, Buffer.from([0])]);
        const firstUpload = await a.call<{ assetId: string }>("asset.add", png);
        assert.equal(firstUpload.assetId, sha(png));
        const created = await b.call<{ contentId: string; versionRef: string }>(
          "images.create",
          {
            commandId: randomUUID(),
            objectId: "shared-image",
            projectId,
            title: "原图",
            assetId: firstUpload.assetId,
            alt: "旧版",
          },
        );
        assert.equal(created.versionRef, "1");
        const secondUpload = await b.call<{ assetId: string }>(
          "asset.add",
          replacement,
        );
        assert.equal(secondUpload.assetId, sha(replacement));
        const revised = await a.call<{ versionRef: string }>("images.revise", {
          commandId: randomUUID(),
          contentId: created.contentId,
          expectedRevision: 1,
          title: "新图",
          assetId: secondUpload.assetId,
          alt: "新版",
        });
        assert.equal(revised.versionRef, "2");
        await assert.rejects(
          b.call("images.revise", {
            commandId: randomUUID(),
            contentId: created.contentId,
            expectedRevision: 1,
            title: "过期",
            assetId: firstUpload.assetId,
            alt: "不应提交",
          }),
          { code: "conflict" },
        );
        const readImage = async (c: typeof a) => {
          const old = await c.call<{
            revision: number;
            content: { assetId: string; alt: string };
          }>("objects.read", { contentId: created.contentId, revision: 1 });
          const head = await c.call<typeof old>("objects.read", {
            contentId: created.contentId,
            revision: 2,
          });
          assert.equal(old.revision, 1);
          assert.equal(old.content.alt, "旧版");
          assert.equal(old.content.assetId, firstUpload.assetId);
          assert.equal(head.revision, 2);
          assert.equal(head.content.assetId, secondUpload.assetId);
          assert.deepEqual(
            Buffer.from(
              (await c.connection.resource("assets", old.content.assetId))
                .bytes,
            ),
            png,
          );
          assert.deepEqual(
            Buffer.from(
              (await c.connection.resource("assets", head.content.assetId))
                .bytes,
            ),
            replacement,
          );
          await assert.rejects(c.connection.resource("assets", "0".repeat(64)));
        };
        await Promise.all([readImage(a), readImage(b)]);

        const manifest = (version: string, html: string) => ({
          format: applicationManifestFormat,
          id: "example.centerbytes",
          version,
          title: "中心字节",
          description: "共置验证",
          icon: "document",
          permissions: ["artifacts.read"],
          harness: null,
          ui: { type: "sandbox", html },
        });
        const oldUi = manifest(
            "1.0.0",
            "<!doctype html><title>中心旧界面</title>",
          ),
          newUi = manifest("2.0.0", "<!doctype html><title>中心新界面</title>");
        const install = { commandId: randomUUID(), manifest: oldUi };
        assert.equal(
          await a.call("apps.install", install),
          "example.centerbytes@1.0.0",
        );
        assert.equal(
          await b.call("apps.install", install),
          "example.centerbytes@1.0.0",
        );
        assert.equal(
          await b.call("apps.install", {
            commandId: randomUUID(),
            manifest: newUi,
          }),
          "example.centerbytes@2.0.0",
        );
        const readUi = async (c: typeof a) => {
          for (const m of [oldUi, newUi]) {
            const bytes = Buffer.from(
              (
                await c.connection.resource(
                  "application-view",
                  `${m.id}@${m.version}`,
                )
              ).bytes,
            );
            assert.equal(bytes.toString("utf8"), m.ui.html);
            assert.equal(sha(bytes), sha(m.ui.html));
          }
          const list = await c.call<unknown[]>("apps.list");
          assert.equal(list.length, 2);
          assert.equal(JSON.stringify(list).includes("中心新界面"), false);
        };
        await Promise.all([readUi(a), readUi(b)]);

        const denied = await client(hostB, bobToken);
        await assert.rejects(
          denied.connection.readerOriginalMetadata(imported.entityId, 1),
          { code: "not_found" },
        );
        await assert.rejects(
          denied.connection.resource("assets", firstUpload.assetId),
          { code: "not_found" },
        );
        await assert.rejects(
          denied.connection.resource(
            "application-view",
            "example.centerbytes@1.0.0",
          ),
          { code: "not_found" },
        );
        assert.deepEqual(await denied.call("apps.list"), []);
        if (admin) {
          const privateRoot = join(root, "private-images");
          mkdirSync(privateRoot);
          await assert.rejects(
            openHost("private-images", privateRoot),
            /图片原件 Store 缺失/,
          );
          const noUiStore = { ...options, uiPackages: undefined };
          await assert.rejects(
            openHost("private-ui", center, noUiStore),
            /未配置共享包 Store/,
          );
        }
        // Config replacement is the existing real shared authority. Host B
        // still holds old config locally and must reject, not serve cached bytes.
        await hostA.identity.replaceConfiguration({
          ...configuration,
          members: configuration.members.map((m) => ({
            ...m,
            enabled: m.principalId !== localAccess.principalId,
          })),
        });
        await assert.rejects(
          async () => a.connection.readerOriginalMetadata(imported.entityId, 1),
          /请登录后继续操作/,
        );
        await assert.rejects(
          async () =>
            b.connection.readerOriginalRange(imported.entityId, 1, 0, 16),
          { code: "forbidden" },
        );
        await assert.rejects(
          b.connection.resource("assets", firstUpload.assetId),
          { code: "forbidden" },
        );
        await assert.rejects(
          b.connection.resource(
            "application-view",
            "example.centerbytes@1.0.0",
          ),
          { code: "forbidden" },
        );
        await hostA.identity.replaceConfiguration(configuration);

        await closeHost(hostA);
        hostA = undefined;
        await closeHost(hostB);
        hostB = undefined;
        hostA = await openHost("a");
        hostB = await openHost("b");
        a = await client(hostA);
        b = await client(hostB);
        await Promise.all([
          readPdf(a),
          readPdf(b),
          readImage(a),
          readImage(b),
          readUi(a),
          readUi(b),
        ]);
        assert.deepEqual(
          hostA.transport.serviceState("private-delivery-evidence"),
          { owner: "A" },
        );
        assert.equal(
          hostB.transport.serviceState("private-delivery-evidence"),
          null,
        );
      } finally {
        try {
          await closeHost(hostA);
          await closeHost(hostB);
        } finally {
          if (admin) {
            try {
              for (const schema of Object.values(schemas))
                await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
            } finally {
              await admin.end();
            }
          }
          rmSync(root, { recursive: true, force: true });
        }
      }
    },
  );
