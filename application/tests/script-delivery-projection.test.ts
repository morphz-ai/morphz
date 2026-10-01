import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer as createPortServer } from "node:net";
import { Pool } from "pg";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import {
  emptyScriptDraft,
  type ScriptGeneration,
} from "../packages/core/src/script-studio.js";
import { localAccess } from "../packages/core/src/model.js";
import { scriptOutputSchema } from "../packages/core/src/script-delivery.js";
import { Application } from "../packages/application/src/application.js";
import { createAppServer } from "../apps/service/src/http.js";
import type { RuntimeBridge } from "../packages/application/src/runtime.js";
import {
  decideScriptCandidate,
  reviseScriptItem,
  updateScriptProduction,
} from "../packages/application/src/script-production-service.js";

const postgresUrl = process.env.MORPHZ_TEST_POSTGRES_URL;
const other = { principalId: "delivery-other", actantId: "delivery-other" };
const loginToken = (principalId: string) =>
  createHash("sha256").update(`delivery-http-${principalId}`).digest("hex");
const loginHash = (principalId: string) =>
  createHash("sha256").update(loginToken(principalId)).digest("hex");

/** All receipts, originals, catalog projections and current permissions use
 * the production Host and actual databases. Only Runtime accepted-input
 * evidence is controlled; no model, fake SQL store or test-only write API. */
async function fixture(backend: "sqlite" | "postgres") {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  const schemas = {
    objects: `do_${suffix}`,
    scriptStudio: `ds_${suffix}`,
    reader: `dr_${suffix}`,
    browser: `db_${suffix}`,
  };
  const platformSchema = `dp_${suffix}`;
  const admin =
    backend === "postgres" ? new Pool({ connectionString: postgresUrl }) : null;
  try {
    if (admin)
      for (const schema of [platformSchema, ...Object.values(schemas)])
        await admin.query(`CREATE SCHEMA "${schema}"`);
    const host = await agentDomainFixture({
      additionalHumans: [other],
      ...(admin
        ? {
            storage: {
              platform: {
                kind: "postgres" as const,
                connectionString: postgresUrl!,
                schema: platformSchema,
              },
              applications: {
                connectionStrings: {
                  objects: postgresUrl!,
                  scriptStudio: postgresUrl!,
                  reader: postgresUrl!,
                  browser: postgresUrl!,
                },
                deploymentId: `delivery_${suffix}`,
                schemas,
              },
            },
          }
        : {}),
    });
    return {
      host,
      async close() {
        try {
          await host.close();
        } finally {
          if (admin) {
            for (const schema of [platformSchema, ...Object.values(schemas)])
              await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
            await admin.end();
          }
        }
      },
    };
  } catch (error) {
    if (admin) {
      for (const schema of [platformSchema, ...Object.values(schemas)])
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
    throw error;
  }
}

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: 真实剧本消息卡片只读元数据，保留原交付版本及当前候选决定，冷重开和撤权仍有效`,
    { skip: backend === "postgres" && !postgresUrl },
    async () => {
      const f = await fixture(backend);
      const host = f.host;
      let server: ReturnType<typeof createAppServer> | undefined;
      try {
        const inputId = (await host.readAcceptedInput(host.route)).input_id;
        const created = await host.call<{
          productionId: string;
          contentId: string;
        }>({
          action: "script",
          script: {
            action: "command",
            command: {
              action: "create-production",
              projectId: host.projectId,
              title: "交付剧本",
            },
          },
        });
        const shared = () => ({
          platform: host.domains.content.platform,
          studio: host.domains.content.studio!,
          instanceId: host.domains.content.instanceIds.scriptStudio,
          productionId: created.productionId,
        });
        const overview = () =>
          host.withHuman((actor) =>
            shared().studio.readProductionOverview({
              credential: actor.credential,
              productionId: created.productionId,
            }),
          );
        const item = await host.call<{ itemId: string }>({
          action: "script",
          script: {
            action: "command",
            command: {
              action: "create-item",
              productionId: created.productionId,
              expectedActivityRevision: (await overview()).activityRevision,
              kind: "episode",
              draft: emptyScriptDraft("原交付标题"),
            },
          },
        });
        const list = (inputIds: string[]) =>
          host.withHuman((actor) =>
            shared().studio.listInputDeliveries({
              credential: actor.credential,
              inputIds,
              productionIds: [created.productionId],
            }),
          );
        const first = (await list([inputId]))[0]!;
        scriptOutputSchema.parse(first);
        assert.equal(first.title, "原交付标题");
        assert.equal(first.productionTitle, "交付剧本");
        assert.equal(first.itemKind, "episode");
        assert.equal(first.isEmpty, true, "SQL 空白判定与原卡片 trim() 相同");
        const { sources: _sources, ...draft } =
          emptyScriptDraft("Human 第二版标题");
        const body = "不应出现在消息卡片的完整原件".repeat(100);
        await host.withHuman((actor) =>
          reviseScriptItem({
            ...shared(),
            actor,
            commandId: randomUUID(),
            itemId: item.itemId,
            expectedRevision: 1,
            draft: { ...draft, text: body, sources: [] },
          }),
        );
        assert.deepEqual((await list([inputId]))[0], first);
        const header = await overview();
        await host.withHuman((actor) =>
          updateScriptProduction({
            ...shared(),
            actor,
            commandId: randomUUID(),
            expectedRevision: header.metadataRevision,
            title: "交付剧本 · 更新名称",
            brief: { ...header.brief, modelProcessingAllowed: true },
            reviewerPrincipalIds: header.reviewerPrincipalIds,
            template: header.template,
          }),
        );
        const generation: ScriptGeneration = {
          productionId: created.productionId,
          targetId: item.itemId,
          baseRevision: 2,
          contextRevision: (await overview()).metadataRevision,
          purpose: "rewrite",
          references: [],
          maxCandidates: 1,
          maxOutputCharacters: 3000,
          maxReviewPasses: 1,
        };
        const candidateInputId = `input_${randomUUID().replaceAll("-", "")}`;
        const candidateRoute = host.input(
          host.projectId,
          "重写这一集",
          "",
          undefined,
          { inputId: candidateInputId, scriptGeneration: generation },
        );
        await host.withHuman((actor) =>
          shared().studio.prepareGeneration({
            credential: actor.credential,
            commandId: candidateInputId,
            productionId: created.productionId,
            inputId: candidateInputId,
            generation,
          }),
        );
        const submitted = host.envelope(
          {
            action: "script",
            script: {
              action: "submit-workflow",
              payload: { ...emptyScriptDraft("候选原标题"), text: body },
              explanation: "重写",
              checks: [
                {
                  performed: true,
                  revise: false,
                  blocked: false,
                  notes: "已核对",
                },
                { performed: false, revise: false, blocked: false, notes: "" },
              ],
            },
          },
          candidateRoute,
        );
        const candidate = (await host.tools.call(submitted)) as {
          candidateId: string;
        };
        const pending = (await list([candidateInputId]))[0]!;
        scriptOutputSchema.parse(pending);
        assert.equal(pending.candidateStatus, "pending");
        assert.equal(pending.revision, 2);
        assert.equal(pending.itemKind, "episode");
        assert.equal(pending.productionTitle, "交付剧本 · 更新名称");
        assert.equal(pending.title, "候选原标题");
        assert.ok(!JSON.stringify(pending).includes(body));
        const decision = {
          commandId: randomUUID(),
          candidateId: candidate.candidateId,
          expectedRevision: 1,
          decision: "accept" as const,
        };
        const decide = () =>
          host.withHuman((actor) =>
            decideScriptCandidate({ ...shared(), actor, ...decision }),
          );
        const accepted = await decide();
        assert.deepEqual(await decide(), accepted, "同命令真实回执不重复采纳");
        const delivered = await list([inputId, candidateInputId]);
        assert.equal(
          delivered.find((value) => value.kind === "item")!.revision,
          1,
        );
        assert.equal(
          delivered.find((value) => value.kind === "item")!.isEmpty,
          true,
        );
        const acceptedCard = delivered.find(
          (value) => value.kind === "candidate",
        )!;
        assert.equal(acceptedCard.candidateStatus, "accepted");
        assert.equal(acceptedCard.revision, 2, "候选仍指向原基准，正文已是 v3");
        assert.equal(acceptedCard.title, "候选原标题");
        assert.ok(!JSON.stringify(delivered).includes(body));
        await host.reopen();
        assert.deepEqual(await list([inputId, candidateInputId]), delivered);
        assert.deepEqual(await host.tools.call(submitted), candidate);
        const app = () =>
          new Application(host.transport, {
            identity: host.identity,
            platformWork: host.domains.work,
            platformScripts: host.domains.content,
          }).session(localAccess);
        const original = await app().readPlatformScriptItem({
          contentId: created.contentId,
          itemId: item.itemId,
          revision: 1,
        });
        assert.equal(original.draft.title, "原交付标题");
        assert.equal(original.headRevision, 3);
        // The common Agent fixture never logs in. Use real-format credentials
        // through the existing operator configuration before testing HTTP.
        await host.identity!.replaceConfiguration(
          {
            version: 1,
            members: [localAccess, other].map((human) => ({
              ...human,
              enabled: true,
              loginTokenHash: loginHash(human.principalId),
            })),
          },
          [
            { ...localAccess, enabled: true, projectIds: [host.projectId] },
            { ...other, enabled: true, projectIds: [] },
          ],
        );
        const probe = createPortServer();
        await new Promise<void>((resolve) =>
          probe.listen(0, "127.0.0.1", resolve),
        );
        const port = (probe.address() as { port: number }).port;
        await new Promise<void>((resolve) => probe.close(() => resolve()));
        const publishedHistory = {
          teamIdentity: true,
          async platformConversationHistory() {
            // The Runtime publication boundary is controlled; the HTTP
            // session, app receipts, source IDs and catalog authorization are
            // production paths, not a fabricated delivery payload.
            return {
              inputs: [inputId, candidateInputId].map((id) => ({ id })),
              nextCursor: null,
              runtime: {
                configured: true,
                connected: true,
                messages: [],
                deliveries: [],
              },
            };
          },
        } as unknown as RuntimeBridge;
        server = createAppServer(host.transport, {
          port,
          webRoot: "/nonexistent",
          identity: host.identity,
          runtime: publishedHistory,
          platformWork: host.domains.work,
          platformScripts: host.domains.content,
        });
        await new Promise<void>((resolve) =>
          server!.listen(port, "127.0.0.1", resolve),
        );
        const origin = `http://127.0.0.1:${port}`;
        const login = async (principalId: string) => {
          const response = await fetch(`${origin}/api/identity/login`, {
            method: "POST",
            headers: { Origin: origin, "Content-Type": "application/json" },
            body: JSON.stringify({ token: loginToken(principalId) }),
          });
          assert.equal(response.status, 200);
          return response.headers.get("set-cookie")!.split(";")[0]!;
        };
        const cookie = await login(localAccess.principalId);
        const otherCookie = await login(other.principalId);
        const exactItemPath = `/api/platform/scripts/${created.contentId}/items/${item.itemId}?revision=1`;
        const historyPath = `/api/platform/projects/${host.projectId}/conversations/${host.projectId}/history`;
        const get = (path: string, selectedCookie = cookie) =>
          fetch(origin + path, { headers: { Cookie: selectedCookie } });
        const httpItem = await get(exactItemPath);
        assert.equal(httpItem.status, 200);
        assert.equal((await httpItem.json()).draft.title, "原交付标题");
        assert.ok(
          [403, 404].includes((await get(exactItemPath, otherCookie)).status),
        );
        // A card read cannot become a second manuscript transport.
        const readProduction = shared().studio.readProduction;
        shared().studio.readProduction = async () => {
          throw Error("Message cards must not read a production snapshot");
        };
        try {
          assert.deepEqual(await list([inputId, candidateInputId]), delivered);
          const historyResponse = await get(historyPath);
          assert.equal(historyResponse.status, 200);
          const history = await historyResponse.json();
          assert.deepEqual(history.scriptOutputs, delivered);
          assert.ok(!JSON.stringify(history).includes(body));
        } finally {
          shared().studio.readProduction = readProduction;
        }
        await assert.rejects(
          host.domains.work.authority.withSession(
            other,
            () => {},
            (actor) =>
              shared().studio.listInputDeliveries({
                credential: actor.credential,
                inputIds: [inputId, candidateInputId],
                productionIds: [created.productionId],
              }),
          ),
          /权限|成员|不可用|项目/,
        );
        // Revoke the real initiating identity after SQL projection but before
        // the second live authorization. No cached success may be returned.
        const authorize = shared().platform.authorizeApplicationObject.bind(
          shared().platform,
        );
        let readChecks = 0;
        shared().platform.authorizeApplicationObject = async (...args) => {
          if (++readChecks === 2)
            await host.identity!.replaceConfiguration(
              {
                version: 1,
                members: [localAccess, other].map((human) => ({
                  ...human,
                  enabled: human.principalId !== localAccess.principalId,
                  loginTokenHash: loginHash(human.principalId),
                })),
              },
              [
                { ...localAccess, enabled: false, projectIds: [] },
                { ...other, enabled: true, projectIds: [] },
              ],
            );
          return authorize(...args);
        };
        await assert.rejects(list([inputId]), /身份|停用|权限|请求|不可用/);
        assert.equal(readChecks, 2);
        assert.equal((await get(historyPath)).status, 401);
        assert.equal((await get(exactItemPath)).status, 401);
        await assert.rejects(
          async () =>
            app().readPlatformScriptItem({
              contentId: created.contentId,
              itemId: item.itemId,
              revision: 1,
            }),
          /身份|停用|权限|请求|不可用/,
        );
        host.assertNoLegacyData();
      } finally {
        if (server)
          await new Promise<void>((resolve, reject) =>
            server!.close((error) => (error ? reject(error) : resolve())),
          );
        await f.close();
      }
    },
  );
}
