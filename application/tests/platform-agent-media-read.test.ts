import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { searchDomainFixture } from "./search-domain-fixture.js";
import { localAccess } from "../packages/core/src/model.js";
import { extractPdf } from "../packages/application/src/pdf.js";
import { ManagedArtifactStore } from "../packages/managed-artifact-store/src/store.js";
import { postgresQuery, sqliteQuery } from "../packages/storage/src/sql.js";
import { seedExistingPdf } from "./objects-existing-pdf-fixture.js";

const postgresUrl = process.env.MORPHZ_TEST_POSTGRES_URL;
const other = {
  principalId: "media-other-human",
  actantId: "media-other-actant",
};
const pdfBytes = readFileSync(
  new URL("./fixtures/reader.pdf", import.meta.url),
);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGmQAAAAASUVORK5CYII=",
  "base64",
);
type Read = {
  contentId: string;
  objectId: string;
  revision: number;
  headRevision: number;
  title: string;
  kind: string;
  text: string;
  offset: number;
  totalCharacters: number;
  hasMore: boolean;
  pageCount?: number;
  page?: number | null;
};

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: 正式 Human 图片原件到 Agent 说明读取；已存 PDF 精确页文本与历史读取`,
    { skip: backend === "postgres" && !postgresUrl },
    async () => {
      const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
      const schemas = {
        platform: `mp_${suffix}`,
        objects: `mo_${suffix}`,
        scriptStudio: `ms_${suffix}`,
        reader: `mr_${suffix}`,
        browser: `mb_${suffix}`,
      };
      const admin =
        backend === "postgres"
          ? new Pool({ connectionString: postgresUrl })
          : null;
      let f: Awaited<ReturnType<typeof searchDomainFixture>> | undefined;
      let pdfStore: ManagedArtifactStore | undefined;
      try {
        if (admin)
          for (const schema of Object.values(schemas))
            await admin.query(`CREATE SCHEMA "${schema}"`);
        f = await searchDomainFixture({
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
                    connectionStrings: {
                      objects: postgresUrl!,
                      scriptStudio: postgresUrl!,
                      reader: postgresUrl!,
                      browser: postgresUrl!,
                    },
                    deploymentId: `media_read_${suffix}`,
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
        const h = f.host;
        const upload = await f.session().addAsset(png);
        const create = {
          commandId: randomUUID(),
          objectId: "image-description",
          projectId: f.projectId,
          title: "图片第一版",
          assetId: upload.assetId,
          alt: "第一版：只读取真实图片说明，不推断图片内容。",
        };
        const image = await f.session().createPlatformImage(create);
        assert.deepEqual(await f.session().createPlatformImage(create), image);
        const read = (
          contentId: string,
          parameters: Record<string, unknown> = {},
          route = h.route,
        ) =>
          h.call<Read>(
            {
              action: "operations",
              operations: {
                action: "invoke",
                operationId: "content.read",
                parameters: { artifactId: contentId, ...parameters },
              },
            },
            route,
          );
        const imageRead = await read(image.contentId, {
          revision: 1,
          offset: 3,
          limit: 8,
        });
        assert.equal(imageRead.kind, "image");
        assert.equal(imageRead.text, create.alt.slice(3, 11));
        assert.equal(imageRead.totalCharacters, create.alt.length);
        assert.equal(imageRead.hasMore, true);
        assert.equal(imageRead.objectId, create.objectId);
        await assert.rejects(read(image.contentId, { page: 1 }), /没有页码/);
        await assert.rejects(
          read(image.contentId, { rowOffset: 1 }),
          /没有表格行偏移/,
        );
        await assert.rejects(
          read(image.contentId, { revision: 99 }),
          /精确版本不存在/,
        );
        const updated = {
          commandId: randomUUID(),
          contentId: image.contentId,
          expectedRevision: 1,
          title: "图片第二版",
          assetId: upload.assetId,
          alt: "第二版：Human 修正后的说明。",
        };
        await f.session().revisePlatformImage(updated);
        assert.equal((await read(image.contentId)).text, updated.alt);
        assert.equal(
          (await read(image.contentId, { revision: 1 })).text,
          create.alt,
        );
        assert.equal(
          (await read(image.contentId, { revision: 1 })).title,
          create.title,
        );
        const exactImage = await f
          .session()
          .readPlatformObject({ contentId: image.contentId, revision: 1 });
        assert.equal(exactImage.content.kind, "image");
        if (exactImage.content.kind === "image")
          assert.equal(exactImage.content.alt, create.alt);
        await f.session().revisePlatformImage({
          ...updated,
          commandId: randomUUID(),
          expectedRevision: 2,
          title: "未填写图片说明",
          alt: "",
        });
        assert.equal(
          (await read(image.contentId)).text,
          "",
          "No alt text is not permission to invent image understanding",
        );

        // This is an isolated ALREADY-STORED PDF initial state, not a successful
        // new PDF creation/receipt/projection flow. A small current-schema
        // fixture supplies existing versions and the matching catalog row.
        // All subsequent reads, rename and permissions use actual domain APIs.
        const at = "2026-09-30T00:00:00.000Z";
        const pages = await extractPdf(pdfBytes);
        // New Human PDF imports use Reader, independently of the existing
        // Objects PDF fixture below. The Agent then reads the actual page text.
        const imported = await f.session().importReading({
          commandId: randomUUID(),
          projectId: f.projectId,
          relativePath: "当前阅读原页.pdf",
          data: pdfBytes,
        });
        const importedContents = await h.call<{
          sections: Array<{ id: string }>;
        }>({
          action: "operations",
          operations: {
            action: "invoke",
            operationId: "reader.contents",
            parameters: { artifactId: imported.entityId, revision: 1 },
          },
        });
        assert.equal(importedContents.sections.length, pages.length);
        const importedPage = await h.call<{ text: string }>({
          action: "operations",
          operations: {
            action: "invoke",
            operationId: "reader.read",
            parameters: {
              artifactId: imported.entityId,
              revision: 1,
              sectionId: importedContents.sections[1]!.id,
              offset: 0,
              limit: 8000,
            },
          },
        });
        assert.equal(importedPage.text.trim(), pages[1]!.trim());
        const assetId = createHash("sha256").update(pdfBytes).digest("hex");
        pdfStore = await ManagedArtifactStore.sqlite({
          root: join(h.directory, "existing-pdf-bytes"),
          storeId: "store_existing_pdf",
          authorizer: {
            async authorize(credential, operation) {
              assert.equal(operation.artifactId, "existing-pdf-source");
              return h.domains.content.platform.authorizeApplicationProject(
                { credential },
                h.domains.content.instanceIds.objects,
                "morphz.objects",
                f!.projectId,
              );
            },
          },
        });
        const savedBytes = await h.withHuman((actor) =>
          pdfStore!.put({
            credential: actor.credential,
            commandId: randomUUID(),
            artifactId: "existing-pdf-source",
            baseRevision: 0,
            mime: "application/pdf",
            bytes: pdfBytes,
            expectedSha256: assetId,
          }),
        );
        const seedPdf = async (objectId: string, savedPages: string[]) => {
          const value = {
            tenantId: h.transport.identity(),
            objectId,
            projectId: f!.projectId,
            author: localAccess,
            reference: savedBytes,
            versions: [
              { title: "已存 PDF 原始标题", pages: savedPages },
              { title: "已存 PDF 当前标题", pages: savedPages },
            ],
          };
          if (admin) {
            const client = await admin.connect();
            try {
              await client.query("BEGIN");
              await client.query(
                `SET LOCAL search_path TO "${schemas.objects}",pg_catalog`,
              );
              await seedExistingPdf(postgresQuery(client), value);
              await client.query("COMMIT");
            } catch (error) {
              await client.query("ROLLBACK");
              throw error;
            } finally {
              client.release();
            }
          } else {
            const db = new DatabaseSync(join(h.directory, "objects.sqlite"));
            try {
              await seedExistingPdf(sqliteQuery(db), value);
            } finally {
              db.close();
            }
          }
          const contentId = `content_${objectId}`;
          const values = [
            h.transport.identity(),
            contentId,
            "morphz.objects",
            h.domains.content.instanceIds.objects,
            objectId,
            f!.projectId,
            "pdf",
            "已存 PDF 当前标题",
            "2",
            at,
            at,
            at,
          ];
          const sql =
            "INSERT INTO content_entries(tenant_id,content_id,app_id,instance_id,app_object_id,project_id,kind,title,observed_version_ref,observed_at,availability,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'available',1,?,?)";
          if (admin) {
            let index = 0;
            await admin.query(
              sql
                .replace(
                  "content_entries",
                  `"${schemas.platform}".content_entries`,
                )
                .replaceAll("?", () => `$${++index}`),
              values,
            );
          } else {
            const db = new DatabaseSync(join(h.directory, "platform.sqlite"));
            try {
              db.prepare(sql).run(...values);
            } finally {
              db.close();
            }
          }
          return contentId;
        };
        const pdfId = await seedPdf("existing-pdf", pages);
        const blankPdfId = await seedPdf("existing-scanned-pdf", ["", ""]);
        const page = await read(pdfId, {
          revision: 1,
          page: 2,
          offset: 2,
          limit: 20,
        });
        assert.equal(page.kind, "pdf");
        assert.equal(page.page, 2);
        assert.equal(page.pageCount, 2);
        assert.equal(page.text, pages[1]!.slice(2, 22));
        assert.equal(page.totalCharacters, pages[1]!.length);
        assert.equal(page.hasMore, true);
        assert.equal(page.revision, 1);
        assert.equal(page.headRevision, 2);
        assert.equal(page.title, "已存 PDF 原始标题");
        assert.equal((await read(pdfId)).text, pages.join("\n\n"));
        await assert.rejects(read(pdfId, { page: 3 }), /页码不存在/);
        await assert.rejects(read(pdfId, { page: 0 }));
        await assert.rejects(read(pdfId, { revision: 99 }), /精确版本不存在/);
        await assert.rejects(read(pdfId, { rowOffset: 1 }), /没有表格行偏移/);
        await assert.rejects(read(blankPdfId), /没有提取到文字/);
        await assert.rejects(read(blankPdfId, { page: 1 }), /没有提取到文字/);
        await f.session().renamePlatformObject({
          commandId: randomUUID(),
          contentId: pdfId,
          expectedCatalogRevision: 1,
          title: "Human 改名后的 PDF",
        });
        assert.equal((await read(pdfId)).title, "Human 改名后的 PDF");
        assert.equal((await read(pdfId)).revision, 3);
        assert.equal(
          (await read(pdfId, { revision: 1 })).title,
          "已存 PDF 原始标题",
        );
        await assert.rejects(
          f
            .session(other)
            .readPlatformObject({ contentId: pdfId, revision: 1 }),
          /不存在|无权|权限/,
        );
        await assert.rejects(
          f
            .session(other)
            .readPlatformObject({ contentId: image.contentId, revision: 1 }),
          /不存在|无权|权限/,
        );
        await h.withHuman((actor) =>
          h.domains.work.service.createProject(actor, {
            commandId: randomUUID(),
            projectId: "other-media-project",
            title: "另一个项目",
          }),
        );
        const wrongProject = h.input("other-media-project");
        for (const id of [pdfId, image.contentId]) {
          await assert.rejects(
            read(id, {}, wrongProject),
            /范围|权限|当前项目/,
          );
          await assert.rejects(
            read(id, {}, { ...h.route, principal_id: "forged-human" }),
            /原始应用输入/,
          );
        }
        await f.reopen();
        assert.equal(
          (await read(pdfId, { revision: 1, page: 2 })).text,
          pages[1],
        );
        assert.equal((await read(pdfId)).revision, 3);
        assert.equal(
          (await read(image.contentId, { revision: 1 })).text,
          create.alt,
        );
        assert.equal(
          (await read(image.contentId, { revision: 2 })).text,
          updated.alt,
        );
        await h.identity!.replaceConfiguration(
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
        for (const id of [pdfId, image.contentId])
          await assert.rejects(read(id), /身份|权限|失效/);
        f.assertNoLegacyData();
      } finally {
        await pdfStore?.close();
        await f?.close();
        if (admin) {
          for (const schema of Object.values(schemas))
            await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          await admin.end();
        }
      }
    },
  );
}
