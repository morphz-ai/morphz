import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { Pool } from "pg";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import { emptyScriptDraft } from "../packages/core/src/script-studio.js";
import {
  listenLocalHostTools,
  prepareLocalHostTools,
} from "../packages/application/src/host-tools-ipc.js";
import { projectPendingScriptItems } from "../packages/application/src/script-production-service.js";

// Real framed IPC, actual RuntimePlatformAuthority and app/Platform SQL stores.
// Accepted Runtime inputs and story text are controlled; no paid model executes.
async function fixture(backend: "sqlite" | "postgres") {
  const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL;
  if (backend === "postgres")
    assert.ok(connectionString, "npm test prepares dedicated PostgreSQL");
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  const schemas = Object.fromEntries(
    ["platform", "objects", "scriptStudio", "reader", "browser"].map(
      (name, index) => [name, `rfh_${index}_${suffix}`],
    ),
  );
  const admin = backend === "postgres" ? new Pool({ connectionString }) : null;
  let f: Awaited<ReturnType<typeof agentDomainFixture>> | undefined;
  let listener: Awaited<ReturnType<typeof listenLocalHostTools>> | undefined;
  try {
    if (admin)
      for (const schema of Object.values(schemas))
        await admin.query(`CREATE SCHEMA "${schema}"`);
    f = await agentDomainFixture({
      ...(admin
        ? {
            storage: {
              platform: {
                kind: "postgres" as const,
                connectionString: connectionString!,
                schema: schemas.platform!,
              },
              applications: {
                deploymentId: `result_host_${suffix}`,
                connectionStrings: {
                  objects: connectionString!,
                  scriptStudio: connectionString!,
                  reader: connectionString!,
                  browser: connectionString!,
                },
                schemas: {
                  objects: schemas.objects!,
                  scriptStudio: schemas.scriptStudio!,
                  reader: schemas.reader!,
                  browser: schemas.browser!,
                },
              },
            },
          }
        : {}),
    });
    const host = f;
    const manifest = prepareLocalHostTools(f.directory, `result-${suffix}`);
    const openListener = async () => {
      listener = await listenLocalHostTools(
        manifest.endpoint,
        host.createTools(manifest.token),
      );
    };
    await openListener();
    const exchange = (request: unknown, token = manifest.token) =>
      new Promise<any>((resolve, reject) => {
        const socket = createConnection(manifest.endpoint);
        const bytes = Buffer.from(
          JSON.stringify({ protocol: 1, token, request }),
        );
        const header = Buffer.alloc(4);
        header.writeUInt32BE(bytes.length);
        const chunks: Buffer[] = [];
        socket.on("error", reject);
        socket.setTimeout(5000, () => {
          socket.destroy();
          reject(new Error("isolated result IPC timeout"));
        });
        socket.on("connect", () =>
          socket.write(Buffer.concat([header, bytes])),
        );
        socket.on("data", (chunk) => chunks.push(chunk));
        socket.on("end", () => {
          const reply = Buffer.concat(chunks);
          socket.destroy();
          assert.ok(reply.length >= 4, "Host returns a framed response");
          assert.equal(reply.readUInt32BE(), reply.length - 4);
          resolve(JSON.parse(reply.subarray(4).toString("utf8")));
        });
      });
    const invoke = (
      operationId: string,
      parameters: unknown,
      route = host.route,
    ) =>
      host.envelope(
        {
          action: "operations",
          operations: { action: "invoke", operationId, parameters },
        },
        route,
      );
    const call = async (
      operationId: string,
      parameters: unknown,
      route = host.route,
    ) => {
      const reply = await exchange(invoke(operationId, parameters, route));
      assert.equal(reply.ok, true, JSON.stringify(reply));
      assert.equal(reply.value.ok, true, JSON.stringify(reply));
      return reply.value;
    };
    return {
      f: host,
      exchange,
      invoke,
      call,
      async reopen() {
        await listener!.close();
        await host.reopen();
        await openListener();
      },
      async close() {
        await listener?.close();
        await host.close();
        if (admin) {
          for (const schema of Object.values(schemas))
            await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
          await admin.end();
        }
      },
    };
  } catch (error) {
    await listener?.close();
    await f?.close();
    if (admin) {
      for (const schema of Object.values(schemas))
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
    throw error;
  }
}

const checks = [
  {
    performed: false,
    revise: false,
    blocked: false,
    notes: "本隔离测试不运行语义自审。",
  },
  { performed: false, revise: false, blocked: false, notes: "未执行。" },
];

for (const backend of ["sqlite", "postgres"] as const) {
  test(`${backend}: 真实 IPC 的 Agent 直接写正文、指导修改、回退追加版本，不产生候选`, async () => {
    const h = await fixture(backend);
    const { f, call } = h;
    try {
      const created = await call("script.create-production", {
        projectId: f.projectId,
        title: "TEST 直接创作与版本回退",
      });
      const productionId = created.productionId;
      const episode = await call("script.create-item", {
        productionId,
        expectedActivityRevision: 1,
        kind: "episode",
        draft: { ...emptyScriptDraft("第一集"), text: "TEST 原正文。" },
      });
      const revised = await call("script.revise-item", {
        productionId,
        itemId: episode.itemId,
        expectedRevision: 1,
        draft: {
          ...emptyScriptDraft("第一集"),
          text: "TEST 按指导修改的正文。",
        },
      });
      assert.equal(revised.revision, 2);
      const restored = await call("script.restore-item", {
        productionId,
        itemId: episode.itemId,
        expectedRevision: 2,
        restoreRevision: 1,
      });
      assert.equal(restored.revision, 3);
      assert.equal(restored.activityRevision, 4);
      const scene = await call("script.create-item", {
        productionId,
        expectedActivityRevision: 4,
        kind: "scene",
        draft: {
          ...emptyScriptDraft("第一场"),
          parentId: episode.itemId,
          dependencies: [{ itemId: episode.itemId, revision: 3 }],
          text: "TEST 分场直接保存完整正文。",
          location: "餐桌",
          storyTime: "夜",
        },
      });
      assert.equal(scene.revision, 1);
      assert.equal(scene.activityRevision, 5);
      const studio = f.domains.content.studio!;
      for (const [revision, text] of [
        [1, "TEST 原正文。"],
        [2, "TEST 按指导修改的正文。"],
        [3, "TEST 原正文。"],
      ] as const) {
        const version = await f.withHuman((actor) =>
          studio.readItemVersion({
            credential: actor.credential,
            productionId,
            itemId: episode.itemId,
            revision,
          }),
        );
        assert.equal(version.draft.text, text);
        assert.equal(version.headRevision, 3);
      }
      assert.equal(
        (
          await call("script.list-candidates", {
            productionId,
            itemId: episode.itemId,
          })
        ).total,
        0,
      );
      const stale = await h.exchange(
        h.invoke("script.revise-item", {
          productionId,
          itemId: episode.itemId,
          expectedRevision: 1,
          draft: { ...emptyScriptDraft("第一集"), text: "不得覆盖当前版本" },
        }),
      );
      assert.equal(stale.value?.ok ?? stale.ok, false);
      await h.reopen();
      const head = await call("script.read-item", {
        productionId,
        itemId: episode.itemId,
        revision: 3,
      });
      assert.equal(JSON.parse(head.draftJson).text, "TEST 原正文。");
    } finally {
      await h.close();
    }
  });

  test(`${backend}: 真实 IPC 整批正文与新版本依赖、目录顺序、冷重开与丢响应重试`, async () => {
    const h = await fixture(backend);
    const { f, call } = h;
    try {
      const { productionId } = await call("script.create-production", {
        projectId: f.projectId,
        title: "TEST 原子正文批次",
      });
      const character = await call("script.create-item", {
        productionId,
        expectedActivityRevision: 1,
        kind: "character",
        draft: emptyScriptDraft("人物"),
      });
      const outline = await call("script.create-item", {
        productionId,
        expectedActivityRevision: 2,
        kind: "outline",
        draft: emptyScriptDraft("大纲"),
      });
      const route = f.input(f.projectId, "TEST 一次交付人物和大纲，不采纳。");
      await call(
        "script.prepare-workflow",
        {
          productionId,
          targetId: character.itemId,
          baseRevision: 1,
          contextRevision: 1,
          purpose: "draft",
          submissionMode: "current",
          maxCandidates: 1,
          maxReviewPasses: 0,
          maxOutputCharacters: 8000,
          targets: [
            { targetId: character.itemId, baseRevision: 1 },
            { targetId: outline.itemId, baseRevision: 1 },
          ],
        },
        route,
      );
      const packet = await call("script.read-workflow", {}, route);
      assert.equal(packet.submissionMode, "current");
      const parameters = {
        payload: [
          {
            targetId: outline.itemId,
            payload: {
              ...emptyScriptDraft("大纲"),
              text: "TEST 人物在大纲中作出选择。",
              dependencies: [{ itemId: character.itemId, revision: 2 }],
            },
            explanation: "大纲依据本批人物。",
          },
          {
            targetId: character.itemId,
            payload: {
              ...emptyScriptDraft("人物"),
              text: "TEST 有明确目标的人物。",
            },
            explanation: "人物交付。",
          },
        ],
        explanation: "TEST 原子正文交付。",
        checks,
      };
      const envelope = h.invoke("script.submit-workflow", parameters, route);
      // The actual Host handles this write; discarding its response models a
      // lost response, not an absent commit. Reopening proves durable receipts.
      const response = await h.exchange(envelope);
      assert.equal(response.ok, true);
      assert.equal(response.value.ok, true, JSON.stringify(response));
      assert.equal(response.value.saved, true);
      assert.equal(response.value.kind, "items");
      assert.equal(response.value.savedCount, 2);
      assert.ok(
        response.value.results.every(
          (result: any) =>
            result.itemRevision === 2 && result.status === "saved",
        ),
      );
      const receipt = response.value;
      await h.reopen();
      assert.deepEqual((await h.exchange(envelope)).value, receipt);
      assert.deepEqual(
        await call("script.submit-workflow", parameters, route),
        receipt,
        "new tool-call identity reuses the same input result",
      );
      const page = await call("script.read-results", {}, route);
      assert.equal(page.total, 2);
      assert.ok(
        page.results.every(
          (result: any) => result.kind === "item" && result.status === "saved",
        ),
      );
      for (const result of page.results) {
        const raw = await call(
          "script.read-result",
          { resultId: result.id },
          route,
        );
        const value = JSON.parse(raw.resultJson);
        assert.equal(value.revision, 2);
        assert.ok(value.draft.text.startsWith("TEST "));
        assert.ok(value.author.actantId);
        assert.equal(value.workflowReport.checks[0].performed, false);
      }
      const followup = f.input(f.projectId, "TEST 只读核验当前版本和旧版本。");
      const overview = await call(
        "script.read-production",
        { productionId },
        followup,
      );
      assert.equal(overview.activityRevision, 5);
      assert.equal(
        (
          await call(
            "script.list-candidates",
            { productionId, itemId: outline.itemId },
            followup,
          )
        ).total,
        0,
      );
      const current = await call(
        "script.read-item",
        { productionId, itemId: outline.itemId, revision: 2 },
        followup,
      );
      assert.deepEqual(JSON.parse(current.draftJson).dependencies, [
        { itemId: character.itemId, revision: 2 },
      ]);
      const old = await call(
        "script.read-item",
        { productionId, itemId: outline.itemId, revision: 1 },
        followup,
      );
      assert.equal(JSON.parse(old.draftJson).text, "");
      const conflict = await h.exchange(
        h.invoke(
          "script.submit-workflow",
          {
            ...parameters,
            explanation: "改变的请求",
            payload: parameters.payload.map((part) => ({
              ...part,
              explanation: "不同内容",
            })),
          },
          route,
        ),
      );
      assert.equal(conflict.value?.ok ?? conflict.ok, false);
      const content = await f.withHuman((actor) =>
        f.domains.content.platform.content(actor, createdContentId(receipt)),
      );
      assert.equal(content.observed_version_ref, "5");
    } finally {
      await h.close();
    }
  });

  test(`${backend}: 第二目标无效整批回滚；已写入但目录失败不会冒称未保存，可恢复原回执`, async () => {
    const h = await fixture(backend);
    const { f, call } = h;
    try {
      const { productionId } = await call("script.create-production", {
        projectId: f.projectId,
        title: "TEST 原子失败与目录恢复",
      });
      const first = await call("script.create-item", {
        productionId,
        expectedActivityRevision: 1,
        kind: "character",
        draft: emptyScriptDraft("人物"),
      });
      const second = await call("script.create-item", {
        productionId,
        expectedActivityRevision: 2,
        kind: "outline",
        draft: emptyScriptDraft("大纲"),
      });
      const route = f.input(f.projectId, "TEST 双目标结果");
      await call(
        "script.prepare-workflow",
        {
          productionId,
          targetId: first.itemId,
          baseRevision: 1,
          contextRevision: 1,
          purpose: "draft",
          submissionMode: "current",
          maxCandidates: 1,
          maxReviewPasses: 0,
          maxOutputCharacters: 8000,
          targets: [
            { targetId: first.itemId, baseRevision: 1 },
            { targetId: second.itemId, baseRevision: 1 },
          ],
        },
        route,
      );
      const parameters = {
        payload: [
          {
            targetId: first.itemId,
            payload: { ...emptyScriptDraft("人物"), text: "TEST 人物正文" },
            explanation: "交付人物",
          },
          {
            targetId: second.itemId,
            payload: { ...emptyScriptDraft("大纲"), text: "TEST 大纲正文" },
            explanation: "交付大纲",
          },
        ],
        explanation: "测试双目标",
        checks,
      };
      const invalid = await h.exchange(
        h.invoke(
          "script.submit-workflow",
          {
            ...parameters,
            payload: parameters.payload.map((part, index) =>
              index === 1
                ? {
                    ...part,
                    payload: {
                      ...part.payload,
                      dependencies: [{ itemId: first.itemId, revision: 500 }],
                    },
                  }
                : part,
            ),
          },
          route,
        ),
      );
      assert.equal(invalid.value?.ok ?? invalid.ok, false);
      assert.equal((await call("script.read-results", {}, route)).total, 0);
      for (const itemId of [first.itemId, second.itemId]) {
        const item = await f.withHuman((actor) =>
          f.domains.content.studio!.readItemVersion({
            credential: actor.credential,
            productionId,
            itemId,
          }),
        );
        assert.equal(item.headRevision, 1);
      }
      const platform = f.domains.content.platform;
      const actualRefresh = platform.refreshContent;
      platform.refreshContent = async () => {
        throw new Error("TEST controlled directory failure after app commit");
      };
      const envelope = h.invoke("script.submit-workflow", parameters, route);
      let response: any;
      try {
        response = await h.exchange(envelope);
      } finally {
        platform.refreshContent = actualRefresh;
      }
      assert.equal(response.ok, true);
      assert.equal(response.value.ok, false);
      assert.equal(response.value.saved, true);
      assert.equal(response.value.savedCount, 2);
      assert.ok(
        response.value.results.every(
          (part: any) => part.status === "saved-projection-pending",
        ),
      );
      const studio = f.domains.content.studio!;
      const original = await f.withAgent(
        (actor) =>
          studio.readSubmittedResults({
            credential: actor.credential,
            productionId,
            inputId: response.value.inputId,
          }),
        route,
      );
      const pending = await studio.pendingItemDirectoryEvents(
        original.items[0]!.tenantId,
      );
      assert.equal(pending.length, 2);
      for (const event of pending) {
        const proof = {
          tenantId: original.items[0]!.tenantId,
          principalId: event.principal_id,
          actantId: event.actant_id,
          runtimeInputId: event.input_id,
          runtimeTaskRunEventId: event.task_run_event_id,
          productionId,
          title: event.title,
          versionRef: event.version_ref,
          receiptId: event.event_id,
        };
        assert.equal(
          await studio.verifyCommittedItemRevision(proof),
          true,
          "exact batch child is proved before the earlier directory step",
        );
        for (const change of [
          { receiptId: "not-a-child" },
          { runtimeInputId: "another-input" },
          { actantId: "another-agent" },
          { versionRef: "3" },
        ])
          assert.equal(
            await studio.verifyCommittedItemRevision({ ...proof, ...change }),
            false,
          );
      }
      await h.reopen();
      const recovered = (await h.exchange(envelope)).value;
      assert.equal(recovered.ok, true, JSON.stringify(recovered));
      assert.equal(
        recovered.receipt.commandId,
        response.value.receipt.commandId,
      );
      assert.deepEqual(
        recovered.results.map((part: any) => part.itemRevision),
        [2, 2],
      );
      assert.equal(
        (
          await f.domains.content.studio!.pendingItemDirectoryEvents(
            original.items[0]!.tenantId,
          )
        ).length,
        0,
      );
      const again = await projectPendingScriptItems({
        platform: f.domains.content.platform,
        studio: f.domains.content.studio!,
        tenantId: original.items[0]!.tenantId,
        instanceId: f.domains.content.instanceIds.scriptStudio!,
      });
      assert.equal(again.examined, 0);
    } finally {
      await h.close();
    }
  });
}

function createdContentId(receipt: any): string {
  const ids = receipt.results.map((result: any) => result.contentId);
  assert.ok(
    ids.every((id: unknown) => typeof id === "string" && id === ids[0]),
  );
  return ids[0];
}
