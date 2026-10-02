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

test("普通聊天从空书库创建剧本和条目，复用领域操作并在冷启动后幂等重试", async () => {
  const f = await agentDomainFixture();
  const route = f.input(
    f.projectId,
    "新建 TEST 聊天剧本及空的第一集，不生成正文。",
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
    await assert.rejects(
      f.call(
        operation("invoke", "script.prepare-workflow", {
          productionId: saved.productionId,
          targetId: item.itemId,
          baseRevision: 1,
          contextRevision: reopened.contextRevision,
          purpose: "draft",
        }),
        route,
      ),
      /未获准|模型处理/,
      "Creation must not impersonate Human model-processing consent",
    );
    assert.equal(
      (
        await f.call<{ total: number }>(
          { action: "script", script: { action: "list" } },
          route,
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
