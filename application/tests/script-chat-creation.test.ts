import test from "node:test";
import assert from "node:assert/strict";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import { emptyScriptDraft } from "../packages/core/src/script-studio.js";

const operation = (
  action: string,
  operationId: string,
  parameters?: unknown,
) => ({
  action: "operations",
  operations: { action, operationId, ...(parameters ? { parameters } : {}) },
});

test("普通聊天从空书库创建剧本和条目，旧false不禁用候选创作，冷启动后幂等重试", async () => {
  const f = await agentDomainFixture();
  const route = f.input(
    f.projectId,
    "新建 TEST 聊天剧本及第一集，并生成候选；不采纳正式稿。",
  );
  try {
    const workflow = await f.call<{
      generating: boolean;
      projectId: string;
      body: string;
    }>(operation("invoke", "script.read-workflow", {}), route);
    assert.equal(workflow.generating, false);
    assert.equal(workflow.projectId, f.projectId);
    assert.equal(workflow.body, (await f.readAcceptedInput(route)).text);
    const before = await f.call<{ total: number }>(
      { action: "script", script: { action: "list" } },
      route,
    );
    assert.equal(before.total, 0);
    for (const name of ["create-production", "create-item"]) {
      const described = await f.call<{
        operation: {
          harness?: unknown;
          workflow: string;
          parameters: unknown;
        };
      }>(operation("describe", `script.${name}`), route);
      assert.equal(
        described.operation.harness,
        undefined,
        "Empty creation needs no Harness",
      );
      assert.match(described.operation.workflow, /无需 Harness、已有剧本/);
      assert.ok(described.operation.parameters);
    }
    const create = f.envelope(
      operation("invoke", "script.create-production", {
        projectId: workflow.projectId,
        title: "TEST 聊天剧本",
      }),
      route,
    );
    const saved = (await f.tools.call(create)) as {
      ok: boolean;
      contentId: string;
      productionId: string;
      receipt: { entityId: string };
    };
    assert.equal(saved.ok, true);
    assert.equal(saved.receipt.entityId, saved.productionId);
    assert.deepEqual(await f.tools.call(create), saved);
    const read = () =>
      f.call<{
        contextRevision: number;
        activityRevision: number;
        brief: { modelProcessingAllowed: boolean };
        items: { id: string; title: string; revision: number }[];
      }>(
        operation("invoke", "script.read-production", {
          productionId: saved.productionId,
        }),
        route,
      );
    const initial = await read();
    assert.equal(initial.items.length, 0);
    assert.equal(initial.brief.modelProcessingAllowed, false);
    const createItem = f.envelope(
      operation("invoke", "script.create-item", {
        productionId: saved.productionId,
        expectedActivityRevision: initial.activityRevision,
        kind: "episode",
        draft: emptyScriptDraft("第一集"),
      }),
      route,
    );
    const item = (await f.tools.call(createItem)) as {
      itemId: string;
      revision: number;
      receipt: { entityId: string };
    };
    assert.equal(item.receipt.entityId, item.itemId);
    assert.equal(item.revision, 1);
    assert.deepEqual(await f.tools.call(createItem), item);
    await f.reopen();
    f.setInputExecution("completed", false, route);
    assert.deepEqual(await f.tools.call(create), saved);
    assert.deepEqual(await f.tools.call(createItem), item);
    f.setInputExecution("running", false, route);
    const reopened = await read();
    assert.equal(reopened.items.length, 1);
    assert.equal(reopened.items[0]?.id, item.itemId);
    assert.equal(reopened.items[0]?.title, "第一集");
    assert.equal(reopened.brief.modelProcessingAllowed, false);
    const version = await f.call<{ draftJson: string }>(
      operation("invoke", "script.read-item", {
        productionId: saved.productionId,
        itemId: item.itemId,
        revision: 1,
      }),
      route,
    );
    assert.deepEqual(JSON.parse(version.draftJson), emptyScriptDraft("第一集"));
    const prepared = await f.call<{ prepared: boolean }>(
      operation("invoke", "script.prepare-workflow", {
        productionId: saved.productionId,
        targetId: item.itemId,
        baseRevision: 1,
        contextRevision: reopened.contextRevision,
        purpose: "draft",
        maxReviewPasses: 0,
      }),
      route,
    );
    assert.equal(prepared.prepared, true);
    const packet = await f.call<{
      generating: boolean;
      brief: { modelProcessingAllowed: boolean; rightsStatement: string };
      materials: Array<{ draft: { text: string } }>;
    }>(operation("invoke", "script.read-workflow", {}), route);
    assert.equal(packet.generating, true);
    assert.equal(packet.brief.modelProcessingAllowed, false);
    assert.equal(packet.brief.rightsStatement, "");
    assert.equal(packet.materials[0]?.draft.text, "");
    const submit = f.envelope(
      operation("invoke", "script.submit-workflow", {
        payload: { ...emptyScriptDraft("第一集"), text: "TEST 新原创候选。" },
        explanation: "合成回归，无模型请求。",
        checks: [
          { performed: false, revise: false, blocked: false, notes: "未自审" },
          { performed: false, revise: false, blocked: false, notes: "未自审" },
        ],
      }),
      route,
    );
    const submitted = (await f.tools.call(submit)) as {
      ok: boolean;
      candidateId: string;
      receipt: { entityId: string };
    };
    assert.equal(submitted.ok, true);
    assert.equal(submitted.receipt.entityId, submitted.candidateId);
    assert.deepEqual(await f.tools.call(submit), submitted);
    const results = await f.call<{ total: number }>(
      operation("invoke", "script.read-results", {}),
      route,
    );
    assert.equal(results.total, 1);
    const unchanged = await f.call<{ draftJson: string }>(
      operation("invoke", "script.read-item", {
        productionId: saved.productionId,
        itemId: item.itemId,
        revision: 1,
      }),
      route,
    );
    assert.equal(
      JSON.parse(unchanged.draftJson).text,
      "",
      "Candidate is not adopted",
    );
    await f.reopen();
    assert.deepEqual(await f.tools.call(submit), submitted);
    assert.equal((await read()).brief.modelProcessingAllowed, false);
    await assert.rejects(
      f.call({ action: "script", script: { action: "list" } }, route),
      /固定生成请求不能浏览其他剧本/,
    );
    const listRoute = f.input(f.projectId, "核对 TEST 剧本目录，不生成。");
    assert.equal(
      (
        await f.call<{ total: number }>(
          { action: "script", script: { action: "list" } },
          listRoute,
        )
      ).total,
      1,
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("聊天创建不扩大实际项目或取消后的写权限", async () => {
  const f = await agentDomainFixture();
  try {
    await assert.rejects(
      f.call(
        operation("invoke", "script.create-production", {
          projectId: "not-the-initiating-project",
          title: "不能越界",
        }),
      ),
      /输入范围外/,
    );
    f.setInputExecution("running", true);
    await assert.rejects(
      f.call(
        operation("invoke", "script.create-production", {
          projectId: f.projectId,
          title: "取消后不能创建",
        }),
      ),
      /未获准继续|停止后的/,
    );
    f.setInputExecution("running");
    assert.equal(
      (
        await f.call<{ total: number }>({
          action: "script",
          script: { action: "list" },
        })
      ).total,
      0,
    );
  } finally {
    await f.close();
  }
});
