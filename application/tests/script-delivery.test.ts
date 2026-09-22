import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { localAccess, type Operation } from "../packages/core/src/model.js";
import { emptyScriptDraft } from "../packages/core/src/script-studio.js";
import {
  scriptStudioApplication,
  objectsApplication,
} from "../packages/core/src/applications.js";
import { scriptOutputLocation } from "../packages/core/src/script-delivery.js";
import { replyReceipts } from "../apps/web/src/conversation-read.js";

const agent = { principalId: "morphz-service", actantId: "morphz-agent" };
test("剧本及分集交付与真实输入原子保存；重启、精确重试及历史版本保持", () => {
  const dir = mkdtempSync(join(tmpdir(), "morphz-script-delivery-"));
  const file = join(dir, "workspace.sqlite");
  let store = new WorkspaceStore(file);
  const execute = (operation: Operation) =>
    store.execute({ commandId: randomUUID(), operation }, localAccess).entityId;
  try {
    const inputId = execute({
      type: "record-input",
      projectId: "first-project",
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body: "TEST 创建剧本和第一集",
      targetActantId: agent.actantId,
    });
    store.saveRuntimeState({ deliveries: [{ inputId, state: "running" }] });
    const create = {
      commandId: randomUUID(),
      operation: {
        type: "script-command" as const,
        command: {
          action: "create-production" as const,
          projectId: "first-project",
          title: "TEST 废火",
        },
      },
    };
    const productionId = store.execute(create, agent, inputId).entityId;
    const itemCommand = {
      commandId: randomUUID(),
      operation: {
        type: "script-command" as const,
        command: {
          action: "create-item" as const,
          productionId,
          kind: "episode" as const,
          draft: emptyScriptDraft("第一集"),
        },
      },
    };
    const itemId = store.execute(itemCommand, agent, inputId).entityId;
    const outputs = store.scriptOutputs(localAccess);
    assert.equal(outputs.length, 2);
    assert.equal(outputs.find((o) => o.kind === "item")!.itemId, itemId);
    assert.ok(outputs.every((o) => o.inputId === inputId));
    assert.equal(replyReceipts([], [], outputs).length, 2);
    execute({
      type: "script-command",
      command: {
        action: "revise-item",
        productionId,
        itemId,
        expectedRevision: 1,
        draft: { ...emptyScriptDraft("人工改名"), text: "后来保存的正文" },
      },
    });
    store.saveRuntimeState({ deliveries: [{ inputId, state: "completed" }] });
    const revision = store.snapshot().revision;
    assert.equal(store.execute(itemCommand, agent, inputId).entityId, itemId);
    assert.equal(store.snapshot().revision, revision);
    assert.deepEqual(store.scriptOutputs(localAccess), outputs);
    assert.deepEqual(
      store.scriptOutputs({ principalId: "outsider", actantId: "outsider" }),
      [],
    );
    assert.throws(() => store.execute(itemCommand, agent, "another-input"));
    store.close();
    // A retry does not repair historical bugs or replay domain writes. New
    // delivery receipts are committed atomically with their original operation.
    const db = new DatabaseSync(file);
    db.prepare("DELETE FROM script_outputs WHERE command_id=?").run(
      itemCommand.commandId,
    );
    db.close();
    store = new WorkspaceStore(file);
    assert.equal(store.scriptOutputs(localAccess).length, 1);
    store.execute(itemCommand, agent, inputId);
    assert.equal(store.scriptOutputs(localAccess).length, 1);
    assert.equal(
      store.snapshot().revision,
      revision,
      "idempotent retries do not manufacture missing historical projections",
    );
    assert.equal(store.snapshot().artifacts.length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("剧本交付定位由共用命令验证空间、条目、版本；复用实例且不产生输入", () => {
  const store = new WorkspaceStore(":memory:");
  const execute = (operation: Operation) =>
    store.execute({ commandId: randomUUID(), operation }, localAccess).entityId;
  try {
    const productionId = execute({
      type: "script-command",
      command: {
        action: "create-production",
        projectId: "first-project",
        title: "TEST 入口",
      },
    });
    const itemId = execute({
      type: "script-command",
      command: {
        action: "create-item",
        productionId,
        kind: "episode",
        draft: emptyScriptDraft("第一集"),
      },
    });
    const scriptTarget = scriptOutputLocation({
      commandId: "test",
      inputId: "test",
      projectId: "first-project",
      productionId,
      itemId,
      kind: "item",
      title: "第一集",
      revision: 1,
      createdAt: new Date().toISOString(),
    });
    const operation = {
      type: "launch-application" as const,
      workspaceId: "first-project",
      applicationId: scriptStudioApplication.id,
      applicationVersion: scriptStudioApplication.version,
      scriptTarget,
    };
    const instanceId = execute(operation);
    assert.equal(execute(operation), instanceId);
    assert.deepEqual(
      store.snapshot().applicationInstances.find((i) => i.id === instanceId)!
        .state.scriptTarget,
      scriptTarget,
    );
    assert.equal(store.snapshot().inputs.length, 0);
    assert.equal(
      store.scriptOutputs(localAccess).length,
      0,
      "manual creation without an input is not a chat delivery",
    );
    const other = execute({ type: "create-project", title: "TEST 另一项目" });
    assert.throws(
      () => execute({ ...operation, workspaceId: other }),
      /不属于/,
    );
    assert.throws(
      () =>
        execute({
          ...operation,
          scriptTarget: { ...scriptTarget, itemId: "missing" },
        }),
      /不可用/,
    );
    assert.throws(
      () =>
        execute({
          ...operation,
          scriptTarget: { ...scriptTarget, revision: 999 },
        }),
      /不可用/,
    );
    assert.throws(
      () => execute({ ...operation, applicationId: objectsApplication.id }),
      /不属于/,
    );
  } finally {
    store.close();
  }
});
