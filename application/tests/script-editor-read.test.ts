import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createServer as createPortServer } from "node:net";
import { createAppServer } from "../apps/service/src/http.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { Application } from "../packages/application/src/application.js";
import { localAccess } from "../packages/core/src/model.js";
import {
  emptyScriptDraft,
  prepareScriptGeneration,
  scriptImpact,
} from "../packages/core/src/script-studio.js";
import {
  scriptEditorHeadSchema,
  scriptDirectoryPageSchema,
  scriptCandidatePageSchema,
  scriptVersionPageSchema,
  scriptVersionTitleSchema,
  scriptReviewPageSchema,
  scriptExportPageSchema,
} from "../packages/core/src/script-editor.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import {
  createScriptItem,
  reviseScriptItem,
  submitScriptCandidate,
  changeScriptReview,
  recordScriptExport,
  decideScriptCandidate,
  updateScriptProduction,
} from "../packages/application/src/script-production-service.js";

const postgresUrl = process.env.MORPHZ_TEST_POSTGRES_URL;
const loginTokenForHuman = (human: { principalId: string }) =>
  createHash("sha256")
    .update(`editor-login-${human.principalId}`)
    .digest("hex");
const other = {
  principalId: "script-other-human",
  actantId: "script-other-actant",
};
for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: 页式剧本目录、候选、历史、审改与导出保持真实权限和精确版本`,
    { skip: backend === "postgres" && !postgresUrl },
    async () => {
      const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
      const schemas = {
        platform: `ep_${suffix}`,
        objects: `eo_${suffix}`,
        scriptStudio: `es_${suffix}`,
        reader: `er_${suffix}`,
        browser: `eb_${suffix}`,
      };
      const admin =
        backend === "postgres"
          ? new Pool({ connectionString: postgresUrl })
          : null;
      let host: Awaited<ReturnType<typeof agentDomainFixture>> | undefined;
      let server: ReturnType<typeof createAppServer> | undefined;
      try {
        if (admin)
          for (const schema of Object.values(schemas))
            await admin.query(`CREATE SCHEMA "${schema}"`);
        host = await agentDomainFixture({
          additionalHumans: [other],
          loginTokenForHuman,
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
                    deploymentId: `editor_${suffix}`,
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
        const f = host;
        const app = (access = localAccess) =>
          new Application(f.transport, {
            identity: f.identity,
            platformWork: f.domains.work,
            platformScripts: f.domains.content,
          }).session(access);
        const original = await f.call<{
          contentId: string;
          productionId: string;
        }>({
          action: "script",
          script: {
            action: "command",
            command: {
              action: "create-production",
              projectId: f.projectId,
              title: "按需剧本",
            },
          },
        });
        const shared = () => ({
          platform: f.domains.content.platform,
          studio: f.domains.content.studio!,
          instanceId: f.domains.content.instanceIds.scriptStudio,
          productionId: original.productionId,
        });
        const head = () =>
          app().readPlatformScriptEditorHead({ contentId: original.contentId });
        const current = await head();
        await f.withHuman((actor) =>
          updateScriptProduction({
            ...shared(),
            actor,
            commandId: randomUUID(),
            expectedRevision: current.revision,
            title: current.title,
            brief: { ...current.brief, modelProcessingAllowed: true },
            reviewerPrincipalIds: current.reviewerPrincipalIds,
            template: current.template,
          }),
        );
        const create = async (
          title: string,
          dependencies: { itemId: string; revision: number }[] = [],
        ) => {
          const current = await head();
          return f.withHuman((actor) =>
            createScriptItem({
              ...shared(),
              actor,
              commandId: randomUUID(),
              itemId: `item_${randomUUID().replaceAll("-", "")}`,
              expectedActivityRevision: current.activityRevision,
              kind: "episode",
              draft: {
                ...emptyScriptDraft(title),
                sources: [],
                text: "原稿中文😀",
                dependencies,
              },
            }),
          );
        };
        const item = (await create("第一集")).original.itemId;
        const second = (await create("第二集", [{ itemId: item, revision: 1 }]))
          .original.itemId;
        for (let i = 0; i < 4; i++) await create(`目录 ${i}`);
        let itemRevision = 1;
        for (let i = 0; i < 61; i++) {
          await f.withHuman((actor) =>
            reviseScriptItem({
              ...shared(),
              actor,
              commandId: randomUUID(),
              itemId: item,
              expectedRevision: itemRevision,
              draft: {
                ...emptyScriptDraft(`第一集 v${itemRevision + 1}`),
                sources: [],
                text: `确切正文 ${itemRevision + 1} 😀`,
              },
            }),
          );
          itemRevision++;
        }
        const h = scriptEditorHeadSchema.parse(await head());
        assert.equal(h.totals.items, 6);
        assert.equal(h.createdBy.actantId, f.agentAccess.actantId);
        const tree1 = scriptDirectoryPageSchema.parse(
          await app().readPlatformScriptEditorPage({
            contentId: original.contentId,
            panel: "directory",
            limit: 2,
          }),
        );
        assert.equal(tree1.items.length, 2);
        assert.equal(tree1.total, 6);
        assert.ok(tree1.nextCursor);
        assert.equal("text" in tree1.items[0]!, false);
        assert.equal("versions" in tree1.items[0]!, false);
        const tree2 = scriptDirectoryPageSchema.parse(
          await app().readPlatformScriptEditorPage({
            contentId: original.contentId,
            panel: "directory",
            limit: 2,
            after: tree1.nextCursor!,
          }),
        );
        assert.equal(
          new Set([...tree1.items, ...tree2.items].map((i) => i.id)).size,
          4,
        );
        const structural = { head: h, items: [...tree1.items, ...tree2.items] };
        assert.deepEqual(scriptImpact(structural, [item]), [second]);
        assert.throws(
          () =>
            prepareScriptGeneration(structural, {
              productionId: h.id,
              targetId: second,
              baseRevision: 1,
              contextRevision: h.revision,
              purpose: "draft",
            }),
          /过期/,
        );
        const versions = scriptVersionPageSchema.parse(
          await app().readPlatformScriptEditorPage({
            contentId: original.contentId,
            panel: "versions",
            itemId: item,
            limit: 5,
          }),
        );
        assert.equal(versions.total, 62);
        assert.equal(versions.versions.length, 5);
        assert.equal("draft" in versions.versions[0]!, false);
        assert.equal(versions.versions[0]!.revision, 62);
        const v1 = await app().readPlatformScriptItem({
          contentId: original.contentId,
          itemId: item,
          revision: 1,
        });
        assert.equal(v1.draft.text, "原稿中文😀");
        // A historical display title comes from its immutable version even
        // when the current item has been renamed; metadata must not use body
        // reads or the current head as a substitute.
        const bodyReader = f.domains.content.studio!.readItemVersion;
        let unexpectedBodyReads = 0;
        f.domains.content.studio!.readItemVersion = async () => {
          unexpectedBodyReads++;
          throw new Error("版本标题不应读取正文。");
        };
        try {
          for (const [revision, title] of [[1, "第一集"], [62, "第一集 v62"]] as const) {
            assert.deepEqual(scriptVersionTitleSchema.parse(
              await app().readPlatformScriptEditorDetail({
                contentId: original.contentId,
                kind: "item-version-title",
                objectId: item,
                revision,
              }),
            ), { productionId: original.productionId, itemId: item, revision, title });
          }
          assert.equal(unexpectedBodyReads, 0);
          await assert.rejects(app().readPlatformScriptEditorDetail({
            contentId: original.contentId,
            kind: "item-version-title",
            objectId: item,
            revision: 999,
          }), /不存在/);
          await assert.rejects(app().readPlatformScriptEditorDetail({
            contentId: original.contentId,
            kind: "item-version-title",
            objectId: randomUUID(),
            revision: 1,
          }), /不存在/);
        } finally {
          f.domains.content.studio!.readItemVersion = bodyReader;
        }
        for (const request of [
          {
            contentId: original.contentId,
            panel: "events",
            itemId: item,
            after: versions.nextCursor,
          },
          {
            contentId: original.contentId,
            panel: "versions",
            itemId: second,
            after: versions.nextCursor,
          },
        ])
          await assert.rejects(
            app().readPlatformScriptEditorPage(request),
            /不一致/,
          );
        const candidateIds: string[] = [];
        for (let i = 0; i < 6; i++) {
          const generation = {
            productionId: original.productionId,
            targetId: item,
            baseRevision: itemRevision,
            contextRevision: h.revision,
            purpose: "rewrite" as const,
            references: [],
            maxCandidates: 1,
            maxOutputCharacters: 5000,
            maxReviewPasses: 0,
          };
          const invocation = f.input(
            f.projectId,
            `固定候选 ${i}`,
            "",
            undefined,
            {
              inputId: `source_${randomUUID().replaceAll("-", "")}`,
              scriptGeneration: generation,
            },
          );
          const inputId = (await f.readAcceptedInput(invocation)).input_id;
          await f.withAgent(
            (actor) =>
              shared().studio.prepareGeneration({
                credential: actor.credential,
                commandId: randomUUID(),
                productionId: original.productionId,
                inputId,
                generation,
              }),
            invocation,
          );
          const result = await f.withAgent(
            (actor) =>
              submitScriptCandidate({
                ...shared(),
                actor,
                commandId: randomUUID(),
                inputId,
                draft: {
                  ...emptyScriptDraft(`候选 ${i}`),
                  sources: [],
                  text: "汉😀e\u0301",
                },
                explanation: "受控生成原文",
              }),
            invocation,
          );
          candidateIds.push(result.original.candidateId);
        }
        const candidates = scriptCandidatePageSchema.parse(
          await app().readPlatformScriptEditorPage({
            contentId: original.contentId,
            panel: "candidates",
            itemId: item,
            limit: 2,
          }),
        );
        assert.equal(candidates.total, 6);
        assert.equal(candidates.pendingTotal, 6);
        assert.deepEqual(
          candidates.candidates.map((c) => c.ordinal),
          [6, 5],
        );
        assert.equal(candidates.candidates[0]!.textCharacters, 4);
        assert.equal(candidates.defaultCandidateId, candidateIds.at(-1));
        assert.ok(
          candidates.candidates.every((c) => !c.stale && !("draft" in c)),
        );
        const selected = await app().readPlatformScriptEditorDetail({
          contentId: original.contentId,
          kind: "candidate",
          objectId: candidateIds[0],
        });
        assert.equal("draft" in selected && selected.draft.text, "汉😀e\u0301");
        const acceptCommand = {
          ...shared(),
          commandId: randomUUID(),
          candidateId: candidateIds[5]!,
          expectedRevision: 1,
          decision: "accept" as const,
        };
        const accepted = await f.withHuman((actor) =>
          decideScriptCandidate({ ...acceptCommand, actor }),
        );
        assert.deepEqual(
          await f.withHuman((actor) =>
            decideScriptCandidate({ ...acceptCommand, actor }),
          ),
          accepted,
        );
        const stale = scriptCandidatePageSchema.parse(
          await app().readPlatformScriptEditorPage({
            contentId: original.contentId,
            panel: "candidates",
            itemId: item,
          }),
        );
        assert.equal(stale.pendingTotal, 0);
        assert.equal(stale.candidates[0]!.acceptedRevision, 63);
        assert.ok(
          stale.candidates
            .filter((c) => c.status === "pending")
            .every((c) => c.stale),
        );
        await assert.rejects(
          app().readPlatformScriptEditorPage({
            contentId: original.contentId,
            panel: "versions",
            itemId: item,
            after: versions.nextCursor,
          }),
          /已有更新/,
        );
        await assert.rejects(
          f.withHuman((actor) =>
            reviseScriptItem({
              ...shared(),
              actor,
              commandId: randomUUID(),
              itemId: item,
              expectedRevision: 62,
              draft: { ...emptyScriptDraft("不能覆盖"), sources: [] },
            }),
          ),
          /版本|更新|冲突/,
        );
        for (let i = 0; i < 7; i++)
          await f.withHuman((actor) =>
            changeScriptReview({
              ...shared(),
              actor,
              commandId: randomUUID(),
              action: "add-review",
              itemId: item,
              itemRevision: 63,
              quote: "汉😀",
              body: `审改 ${i}`,
              severity: i === 0 ? "blocking" : "note",
            }),
          );
        const reviews = scriptReviewPageSchema.parse(
          await app().readPlatformScriptEditorPage({
            contentId: original.contentId,
            panel: "reviews",
            itemId: item,
            limit: 3,
          }),
        );
        assert.equal(reviews.total, 7);
        assert.equal(reviews.pendingTotal, 7);
        assert.equal(reviews.reviews.length, 3);
        const review = await app().readPlatformScriptEditorDetail({
          contentId: original.contentId,
          kind: "review",
          objectId: reviews.reviews[0]!.id,
        });
        assert.equal("body" in review && review.body, reviews.reviews[0]!.body);
        const exportResult = await f.withHuman((actor) =>
          recordScriptExport({
            ...shared(),
            actor,
            commandId: randomUUID(),
            expectedRevision: h.revision,
            items: [{ itemId: item, revision: 63 }],
            template: h.template,
            workingCopy: true,
          }),
        );
        const exports = scriptExportPageSchema.parse(
          await app().readPlatformScriptEditorPage({
            contentId: original.contentId,
            panel: "exports",
            limit: 1,
          }),
        );
        assert.equal(exports.exports[0]!.itemCount, 1);
        assert.equal("items" in exports.exports[0]!, false);
        const exactExport = await app().readPlatformScriptEditorDetail({
          contentId: original.contentId,
          kind: "export",
          objectId: exportResult.original.exportId,
        });
        assert.deepEqual("items" in exactExport && exactExport.items, [
          { itemId: item, revision: 63 },
        ]);
        // The production HTTP adapter uses real IdentityCenter login, CSRF and
        // the same domain store as the embedded Human interface.
        const probe = createPortServer();
        await new Promise<void>((resolve) =>
          probe.listen(0, "127.0.0.1", resolve),
        );
        const port = (probe.address() as { port: number }).port;
        await new Promise<void>((resolve) => probe.close(() => resolve()));
        server = createAppServer(f.transport, {
          port,
          webRoot: "/nonexistent",
          identity: f.identity,
          platformWork: f.domains.work,
          platformScripts: f.domains.content,
        });
        await new Promise<void>((resolve) =>
          server!.listen(port, "127.0.0.1", resolve),
        );
        const origin = `http://127.0.0.1:${port}`;
        // A complete production hydration is not an allowed implementation of
        // any editor read port, including selected immutable historical bodies.
        Object.defineProperty(f.domains.content.studio, "productionSnapshot", {
          configurable: true,
          value: () => {
            throw new Error("Editor read unexpectedly hydrated all history");
          },
        });
        const cookies = new Map<string, string>();
        const fetchWithCookies: typeof fetch = async (url, init) => {
          const headers = new Headers(init?.headers);
          if (cookies.size)
            headers.set("Cookie", [...cookies.values()].join("; "));
          const response = await fetch(url, { ...init, headers });
          for (const cookie of response.headers.getSetCookie()) {
            const value = cookie.split(";")[0]!;
            cookies.set(value.split("=")[0]!, value);
          }
          return response;
        };
        const remote = new HttpApplicationClient(origin, fetchWithCookies);
        await remote.call("login", {
          token: loginTokenForHuman(localAccess),
        });
        const boot = (await remote.call("platform.bootstrap")) as {
          csrfToken: string;
        };
        const options = { identityGeneration: boot.csrfToken };
        assert.deepEqual(
          await remote.call(
            "scripts.editor.head",
            { contentId: original.contentId },
            options,
          ),
          await head(),
        );
        const remotePage = scriptCandidatePageSchema.parse(
          await remote.call(
            "scripts.editor.page",
            {
              contentId: original.contentId,
              panel: "candidates",
              itemId: item,
              limit: 2,
            },
            options,
          ),
        );
        assert.equal(remotePage.total, 6);
        for (const panel of [
          "directory",
          "versions",
          "events",
          "reviews",
          "exports",
          "metadata",
        ] as const) {
          const page = (await remote.call(
            "scripts.editor.page",
            {
              contentId: original.contentId,
              panel,
              ...(["versions", "events", "reviews"].includes(panel)
                ? { itemId: item }
                : {}),
              limit: 2,
            },
            options,
          )) as { total: number; activityRevision: number };
          assert.ok(page.total > 0, panel);
          assert.equal(page.activityRevision, (await head()).activityRevision);
        }
        const historicalItem = (await remote.call("scripts.item", {
          contentId: original.contentId,
          itemId: item,
          revision: 1,
        })) as { draft: { text: string }; revision: number };
        assert.equal(historicalItem.revision, 1);
        assert.equal(historicalItem.draft.text, "原稿中文😀");
        assert.deepEqual(await remote.call("scripts.editor.detail", {
          contentId: original.contentId,
          kind: "item-version-title",
          objectId: item,
          revision: 1,
        }, options), {
          productionId: original.productionId, itemId: item, revision: 1, title: "第一集",
        });
        assert.deepEqual(
          await remote.call(
            "scripts.editor.detail",
            {
              contentId: original.contentId,
              kind: "export",
              objectId: exportResult.original.exportId,
            },
            options,
          ),
          exactExport,
        );
        const context = (await remote.call(
          "scripts.editor.detail",
          {
            contentId: original.contentId,
            kind: "context",
            revision: h.revision,
          },
          options,
        )) as { revision: number; author: unknown; createdAt: string };
        assert.equal(context.revision, h.revision);
        assert.ok(context.author);
        assert.ok(context.createdAt);
        await assert.rejects(
          remote.call(
            "scripts.editor.page",
            {
              contentId: original.contentId,
              panel: "reviews",
              itemId: item,
              after: remotePage.nextCursor,
            },
            options,
          ),
          /不一致/,
        );
        await assert.rejects(
          remote.call("scripts.editor.head", { contentId: original.contentId }),
          /验证/,
        );
        await new Promise<void>((resolve, reject) =>
          server!.close((error) => (error ? reject(error) : resolve())),
        );
        server = undefined;
        Reflect.deleteProperty(f.domains.content.studio, "productionSnapshot");
        await assert.rejects(
          app(other).readPlatformScriptEditorHead({
            contentId: original.contentId,
          }),
        );
        await assert.rejects(app(other).readPlatformScriptEditorDetail({
          contentId: original.contentId,
          kind: "item-version-title",
          objectId: item,
          revision: 1,
        }));
        const document = await f.call<{ contentId: string }>({
          action: "create-document",
          title: "非剧本",
          markdown: "正文",
        });
        await assert.rejects(
          app().readPlatformScriptEditorHead({ contentId: document.contentId }),
          /剧本/,
        );
        const after = scriptReviewPageSchema.parse(
          await app().readPlatformScriptEditorPage({
            contentId: original.contentId,
            panel: "reviews",
            itemId: item,
            limit: 3,
          }),
        );
        await f.reopen();
        const restored = scriptReviewPageSchema.parse(
          await app().readPlatformScriptEditorPage({
            contentId: original.contentId,
            panel: "reviews",
            itemId: item,
            after: after.nextCursor!,
            limit: 3,
          }),
        );
        assert.equal(restored.reviews[0]!.body, "审改 3");
        assert.deepEqual(await app().readPlatformScriptEditorDetail({
          contentId: original.contentId,
          kind: "item-version-title",
          objectId: item,
          revision: 1,
        }), { productionId: original.productionId, itemId: item, revision: 1, title: "第一集" });
        assert.equal(
          (
            await app().readPlatformScriptItem({
              contentId: original.contentId,
              itemId: item,
              revision: 1,
            })
          ).draft.text,
          "原稿中文😀",
        );
        assert.deepEqual(
          await f.withHuman((actor) =>
            decideScriptCandidate({ ...acceptCommand, ...shared(), actor }),
          ),
          accepted,
        );
        const currentHead = await head();
        await f.withHuman((actor) =>
          updateScriptProduction({
            ...shared(),
            actor,
            commandId: randomUUID(),
            expectedRevision: currentHead.revision,
            title: currentHead.title,
            brief: { ...currentHead.brief, modelProcessingAllowed: false },
            reviewerPrincipalIds: currentHead.reviewerPrincipalIds,
            template: currentHead.template,
          }),
        );
        await assert.rejects(
          f.withAgent((actor) =>
            shared().studio.readCandidate({
              credential: actor.credential,
              productionId: original.productionId,
              candidateId: candidateIds[0]!,
            }),
          ),
          /模型处理许可/,
        );
        await f.identity!.replaceConfiguration(
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
        await assert.rejects(async () =>
          app().readPlatformScriptEditorPage({
            contentId: original.contentId,
            panel: "reviews",
            itemId: item,
            after: after.nextCursor!,
            limit: 3,
          }),
        );
        await assert.rejects(async () =>
          app().readPlatformScriptEditorDetail({
            contentId: original.contentId,
            kind: "candidate",
            objectId: candidateIds[0],
          }),
        );
        await assert.rejects(
          f.withHuman((actor) =>
            decideScriptCandidate({ ...acceptCommand, ...shared(), actor }),
          ),
        );
        f.assertNoLegacyData();
      } finally {
        if (host)
          Reflect.deleteProperty(
            host.domains.content.studio,
            "productionSnapshot",
          );
        if (server)
          await new Promise<void>((resolve, reject) =>
            server!.close((error) => (error ? reject(error) : resolve())),
          );
        if (host) await host.close();
        if (admin) {
          for (const schema of Object.values(schemas))
            await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          await admin.end();
        }
      }
    },
  );
}
