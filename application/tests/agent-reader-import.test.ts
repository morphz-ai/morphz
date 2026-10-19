import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  truncateSync,
  readFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Pool } from "pg";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import { LocalFiles } from "../packages/application/src/local-files.js";
import { workToolDefinitions } from "../packages/application/src/agent-tools.js";
import { localAccess } from "../packages/core/src/model.js";
import { zip, epubFiles } from "./fixtures/reader-publication.js";

const postgresUrl = process.env.MORPHZ_TEST_POSTGRES_URL;
type Imported = {
  ok: true;
  entityId: string;
  bookId: string;
  revision: number;
  receipt: { commandId: string };
  source: { sha256: string };
};
const invoke = (source: unknown) => ({
  action: "operations",
  operations: {
    action: "invoke",
    operationId: "reader.import",
    parameters: { source },
  },
});

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: Agent 真实导入 EPUB／附件，权限、撤权、版本、幂等、重开和定位共用原服务`,
    { skip: backend === "postgres" && !postgresUrl },
    async () => {
      const root = mkdtempSync(join(tmpdir(), "morphz-agent-book-"));
      const directory = join(root, "books");
      mkdirSync(directory);
      const files = new LocalFiles(join(root, "grants.json"), randomUUID());
      const epub = zip(epubFiles);
      writeFileSync(join(directory, "book.epub"), epub);
      writeFileSync(join(directory, "changed.md"), "# 原文件\n原文。");
      writeFileSync(join(directory, "bad.epub"), "broken ZIP");
      writeFileSync(join(directory, "large.epub"), "");
      truncateSync(join(directory, "large.epub"), 32 * 1024 * 1024 + 1);
      writeFileSync(join(directory, ".env"), "never read");
      symlinkSync(join(directory, "book.epub"), join(directory, "link.epub"));
      const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
      const schemas = Object.fromEntries(
        ["platform", "objects", "scriptStudio", "reader", "browser"].map(
          (name, i) => [name, `bi${i}_${suffix}`],
        ),
      ) as Record<
        "platform" | "objects" | "scriptStudio" | "reader" | "browser",
        string
      >;
      const admin =
        backend === "postgres"
          ? new Pool({ connectionString: postgresUrl })
          : null;
      let f: Awaited<ReturnType<typeof agentDomainFixture>> | undefined;
      try {
        if (admin)
          for (const schema of Object.values(schemas))
            await admin.query(`CREATE SCHEMA "${schema}"`);
        f = await agentDomainFixture({
          localFiles: files,
          readAcceptedAttachment: async (scope, author, assetId) => {
            assert.equal(scope.projectId, f!.projectId);
            assert.equal(author.principalId, localAccess.principalId);
            return f!.domains.messageAttachments.service.readForOwner(
              author.principalId,
              assetId,
            );
          },
          ...(admin
            ? {
                storage: {
                  platform: {
                    kind: "postgres",
                    connectionString: postgresUrl!,
                    schema: schemas.platform,
                  },
                  applications: {
                    deploymentId: `import_${suffix}`,
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
        const h = f;
        const grant = files.authorizeDirectory(
          directory,
          h.projectId,
          h.projectId,
          localAccess,
        );
        const route = h.input(
          h.projectId,
          "导入授权目录中的书籍并打开第二章",
          "",
          undefined,
          { directories: [grant] },
        );
        const discovery = await h.call<{ operations: { id: string }[] }>(
          {
            action: "operations",
            operations: { action: "list", domain: "reader" },
          },
          route,
        );
        assert.ok(discovery.operations.some((op) => op.id === "reader.import"));
        const description = await h.call<{
          operation: { parameters: unknown };
        }>(
          {
            action: "operations",
            operations: { action: "describe", operationId: "reader.import" },
          },
          route,
        );
        assert.doesNotMatch(
          JSON.stringify(description.operation.parameters),
          /commandId|projectId|base64/,
        );
        assert.doesNotMatch(
          JSON.stringify(workToolDefinitions),
          /reader-import|reader\.import/,
        );
        const envelope = h.envelope(
          invoke({
            kind: "directory",
            grantId: grant.grantId,
            path: "book.epub",
          }),
          route,
        );
        const imported = (await h.tools.call(envelope)) as Imported;
        assert.equal(imported.ok, true);
        assert.equal(imported.revision, 1);
        assert.equal(
          imported.source.sha256,
          createHash("sha256").update(epub).digest("hex"),
        );
        assert.deepEqual(readFileSync(join(directory, "book.epub")), epub);
        assert.doesNotMatch(
          JSON.stringify(imported),
          /<package|base64|先王慎德/,
        );
        assert.deepEqual(await h.tools.call(envelope), imported);
        const contents = await h.call<{ sections: { id: string }[] }>(
          {
            action: "reader",
            reader: {
              action: "contents",
              artifactId: imported.entityId,
              revision: 1,
            },
          },
          route,
        );
        assert.equal(contents.sections.length, 2);
        const readingDescription = await h.call<{
          operation: { parameters: { properties: Record<string, unknown> } };
        }>(
          {
            action: "operations",
            operations: { action: "describe", operationId: "reader.read" },
          },
          route,
        );
        assert.deepEqual(
          Object.keys(
            readingDescription.operation.parameters.properties,
          ).sort(),
          ["artifactId", "revision", "sectionId", "offset", "limit"].sort(),
        );
        const reading = await h.call<{ ok: boolean; text: string }>(
          {
            action: "operations",
            operations: {
              action: "invoke",
              operationId: "reader.read",
              parameters: {
                artifactId: imported.entityId,
                revision: 1,
                sectionId: contents.sections[1]!.id,
                offset: 0,
                limit: 100,
              },
            },
          },
          route,
        );
        assert.equal(reading.ok, true);
        assert.ok(reading.text.length > 0);
        for (const bad of [
          {
            action: "read",
            artifactId: imported.entityId,
            revision: 1,
            sectionId: "section-16",
            start: 7900,
            limit: 11000,
          },
          {
            action: "reader.read",
            artifactId: imported.entityId,
            artifactRevision: 1,
            sectionId: "section-17",
            start: 12500,
            end: 16500,
          },
          {
            action: "read",
            artifactId: imported.entityId,
            revision: 1,
            sectionId: "section-17",
            offset: 0,
            limit: 4000,
          },
        ])
          await assert.rejects(h.call(bad, route));
        const navigationDescription = await h.call<{
          operation: { parameters: unknown };
        }>(
          {
            action: "operations",
            operations: {
              action: "describe",
              operationId: "applications.launch",
            },
          },
          route,
        );
        for (const field of [
          "artifactId",
          "revision",
          "sectionId",
          "location",
          "sourceId",
          "start",
          "end",
        ])
          assert.ok(
            JSON.stringify(navigationDescription.operation.parameters).includes(
              `"${field}"`,
            ),
            `Navigation discovery must expose ${field}`,
          );
        const opened = await h.call<{
          instance: {
            state: { artifactId: string; location: { sectionId: string } };
          };
        }>(
          {
            action: "operations",
            operations: {
              action: "invoke",
              operationId: "applications.launch",
              parameters: {
                appId: "morphz.reader",
                packageVersion: "1.0.0",
                state: {
                  artifactId: imported.entityId,
                  revision: 1,
                  sectionId: contents.sections[1]!.id,
                },
              },
            },
          },
          route,
        );
        assert.equal(opened.instance.state.artifactId, imported.entityId);
        assert.equal(
          opened.instance.state.location.sectionId,
          contents.sections[1]!.id,
        );
        await h.reopen();
        assert.deepEqual(await h.tools.call(envelope), imported);

        for (const path of ["../book.epub", "/etc/passwd", ".env", "link.epub"])
          await assert.rejects(
            h.call(
              invoke({ kind: "directory", grantId: grant.grantId, path }),
              route,
            ),
          );
        await assert.rejects(
          h.call(
            invoke({
              kind: "directory",
              grantId: grant.grantId,
              path: "book.epub",
              sha256: "0".repeat(64),
            }),
            route,
          ),
          /版本已变化/,
        );
        await assert.rejects(
          h.call(
            invoke({
              kind: "directory",
              grantId: grant.grantId,
              path: "bad.epub",
            }),
            route,
          ),
        );
        await assert.rejects(
          h.call(
            invoke({
              kind: "directory",
              grantId: grant.grantId,
              path: "book.epub",
            }),
          ),
          /没有此目录/,
        );
        const other = await h.withHuman((actor) =>
          h.domains.work.service.createProject(actor, {
            commandId: randomUUID(),
            projectId: "other-import-project",
            title: "另一项目",
          }),
        );
        void other;
        const foreign = h.input(
          "other-import-project",
          "不能跨项目借授权",
          "",
          undefined,
          { directories: [grant] },
        );
        await assert.rejects(
          h.call(
            invoke({
              kind: "directory",
              grantId: grant.grantId,
              path: "book.epub",
            }),
            foreign,
          ),
          /授权/,
        );

        const originalReadingFile = files.readingFile.bind(files);
        const otherGrant = files.authorizeDirectory(
          directory,
          h.projectId,
          h.projectId,
          { principalId: "other-human", actantId: "other-human-actant" },
        );
        const foreignAuthor = h.input(
          h.projectId,
          "不能借用其他用户的目录授权",
          "",
          undefined,
          { directories: [otherGrant] },
        );
        await assert.rejects(
          h.call(
            invoke({
              kind: "directory",
              grantId: otherGrant.grantId,
              path: "book.epub",
            }),
            foreignAuthor,
          ),
          /授权/,
        );
        await assert.rejects(
          h.call(
            invoke({
              kind: "directory",
              grantId: grant.grantId,
              path: "large.epub",
            }),
            route,
          ),
          /32 MB/,
        );
        files.readingFile = (...args) => {
          const file = originalReadingFile(...args);
          return {
            ...file,
            assertSource: () => {
              writeFileSync(join(directory, "changed.md"), "# 已变化\n新内容");
              file.assertSource();
            },
          };
        };
        await assert.rejects(
          h.call(
            invoke({
              kind: "directory",
              grantId: grant.grantId,
              path: "changed.md",
            }),
            route,
          ),
          /导入期间已变化/,
        );
        files.readingFile = originalReadingFile;

        const uploaded = await h.withHuman((actor) =>
          h.domains.messageAttachments.service.upload(
            actor,
            "attachment.md",
            Buffer.from("# 附件测试\n这是本次实际提交的附件。"),
          ),
        );
        const attached = h.input(h.projectId, "导入这个附件", "", undefined, {
          attachments: [{ ...uploaded, name: "attachment.md" }],
        });
        const attachmentImport = await h.call<Imported>(
          invoke({ kind: "attachment", assetId: uploaded.assetId }),
          attached,
        );
        assert.equal(attachmentImport.revision, 1);
        await assert.rejects(
          h.call(
            invoke({ kind: "attachment", assetId: uploaded.assetId }),
            route,
          ),
          /不属于本次/,
        );
        await assert.rejects(
          h.call(
            invoke({ kind: "attachment", assetId: "0".repeat(64) }),
            attached,
          ),
          /不属于本次/,
        );
        await assert.rejects(
          h.call(
            {
              action: "operations",
              operations: {
                action: "invoke",
                operationId: "reader.import",
                parameters: {
                  projectId: "other-import-project",
                  source: { kind: "attachment", assetId: uploaded.assetId },
                },
              },
            },
            attached,
          ),
        );
        files.readingFile = (...args) => {
          const file = originalReadingFile(...args);
          return {
            ...file,
            assertSource: () => {
              files.revoke(grant.grantId, h.projectId, localAccess);
              file.assertSource();
            },
          };
        };
        await assert.rejects(
          h.call(
            invoke({
              kind: "directory",
              grantId: grant.grantId,
              path: "changed.md",
            }),
            route,
          ),
          /授权/,
        );
        files.readingFile = originalReadingFile;
        await assert.rejects(async () => h.tools.call(envelope), /授权/);
        const catalog = await h.call<{ books: { artifactId: string }[] }>({
          action: "reader",
          reader: { action: "catalog" },
        });
        assert.equal(
          catalog.books.length,
          2,
          "Failures/retry/reopen cannot create extra books",
        );
        h.assertNoLegacyData();
      } finally {
        await f?.close();
        if (admin) {
          for (const schema of Object.values(schemas))
            await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          await admin.end();
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}
