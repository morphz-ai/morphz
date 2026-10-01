import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  readSavedInputs,
  removeSavedInput,
  saveInputLocally,
  withSavedInputs,
  withoutSavedInputs,
} from "../apps/web/src/local-saved-inputs.js";
import { initialWorkspace, localAccess } from "../packages/core/src/model.js";

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

test("未发送输入按身份和消息 ID 独立保存，不覆盖其他窗口的消息", () => {
  const local = storage();
  const scope = `${randomUUID()}:${randomUUID()}`;
  const firstId = randomUUID();
  const secondId = randomUUID();
  const operation = {
    type: "record-input" as const,
    projectId: randomUUID(),
    artifactId: null,
    artifactRevision: null,
    selection: "",
    body: "尚未发送",
    targetActantId: "morphz-agent",
  };
  const createdAt = new Date().toISOString();
  saveInputLocally(local, scope, {
    commandId: firstId,
    createdAt,
    operation,
  });
  saveInputLocally(local, scope, {
    commandId: secondId,
    createdAt,
    operation: { ...operation, body: "另一个窗口的消息" },
  });
  assert.deepEqual(
    readSavedInputs(local, scope).map((item) => item.commandId),
    [firstId, secondId].sort(),
  );
  assert.deepEqual(readSavedInputs(local, `${scope}:other`), []);
  removeSavedInput(local, scope, firstId);
  assert.deepEqual(
    readSavedInputs(local, scope).map((item) => item.commandId),
    [secondId],
  );
});

test("发送中的本机展示不冒充已提交输入，权威同 ID 原位去重", () => {
  const workspace = initialWorkspace();
  const commandId = randomUUID();
  const entry = {
    commandId,
    createdAt: new Date().toISOString(),
    operation: {
      type: "record-input" as const,
      projectId: "first-project",
      conversationId: "first-project",
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body: "立即显示，不等回执",
      targetActantId: "morphz-agent",
    },
    submission: { state: "sending" as const },
  };
  const display = withSavedInputs(
    workspace,
    [entry],
    localAccess,
    new Set([commandId]),
  );
  assert.equal(workspace.inputs.length, 0);
  assert.equal(display.workspace.inputs[0]!.id, commandId);
  assert.deepEqual(display.submissions[commandId], { state: "sending" });
  assert.deepEqual(
    withoutSavedInputs(display.workspace, display.localInputIds).inputs,
    [],
  );
  const confirmed = withSavedInputs(display.workspace, [entry], localAccess);
  assert.equal(confirmed.workspace.inputs.length, 1);
  assert.deepEqual(confirmed.localInputIds, []);
  assert.deepEqual(confirmed.submissions, {});
});

test("重开窗口不自动重放未确认发送，失败仍保留原 ID、时间和载荷", () => {
  const local = storage();
  const entry = {
    commandId: randomUUID(),
    createdAt: new Date().toISOString(),
    operation: {
      type: "record-input" as const,
      projectId: "first-project",
      artifactId: null,
      artifactRevision: null,
      selection: "原选文",
      body: "原消息",
      model: "fixture-model",
      targetActantId: "morphz-agent",
    },
    submission: { state: "sending" as const },
  };
  saveInputLocally(local, "identity", entry);
  entry.operation.body = "后写的草稿";
  const saved = readSavedInputs(local, "identity");
  assert.equal(saved[0]!.operation.body, "原消息");
  const display = withSavedInputs(initialWorkspace(), saved, localAccess);
  assert.equal(display.submissions[entry.commandId]!.state, "failed");
  assert.equal(display.workspace.inputs[0]!.createdAt, entry.createdAt);
  const error = "网络中断";
  saveInputLocally(local, "identity", {
    ...saved[0]!,
    submission: { state: "failed", error },
  });
  const failed = readSavedInputs(local, "identity")[0]!;
  assert.deepEqual(failed.operation, saved[0]!.operation);
  assert.equal(failed.commandId, entry.commandId);
  assert.deepEqual(failed.submission, { state: "failed", error });
  const denied = initialWorkspace();
  denied.projects = [];
  assert.deepEqual(
    withSavedInputs(denied, [failed], localAccess).localInputIds,
    [],
  );
});
