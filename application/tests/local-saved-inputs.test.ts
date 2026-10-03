import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  readSavedInputs,
  removeSavedInput,
  saveInputLocally,
  matchSavedInputOperation,
  newInputOperation,
  withSavedInputs,
  withoutSavedInputs,
} from "../apps/web/src/local-saved-inputs.js";
import {
  initialWorkspace,
  localAccess,
  operationSchema,
  type Operation,
} from "../packages/core/src/model.js";

type InputOperation = Extract<Operation, { type: "record-input" }>;

function supplement(): InputOperation {
  return {
    type: "record-input",
    projectId: "original-project",
    conversationId: "original-conversation",
    artifactId: null,
    artifactRevision: null,
    continuation: {
      mode: "supplement",
      inputId: "original-input",
      threadId: "original-thread",
      generation: 7,
    },
    selection: "",
    body: "仅补充原工作",
    targetActantId: "morphz-agent",
  };
}

test("旧补充pending遗漏parallel时匹配已冻结outbox，原字节/身份不改", () => {
  const local = storage();
  const candidate = supplement();
  const candidateBytes = JSON.stringify(candidate);
  const frozen = operationSchema.parse(newInputOperation(candidate));
  assert.equal(frozen.type, "record-input");
  if (frozen.type !== "record-input") throw new Error("not input");
  const entry = {
    commandId: randomUUID(),
    createdAt: new Date().toISOString(),
    operation: frozen,
    submission: { state: "failed" as const, error: "未知回执" },
  };
  saveInputLocally(local, "original-identity", entry);
  const key = local.key(0)!;
  const savedBytes = local.getItem(key);
  const reopened = readSavedInputs(local, "original-identity")[0]!;
  assert.equal(reopened.operation.dispatchMode, "parallel");
  const retained = matchSavedInputOperation(candidate, reopened.operation);
  assert.strictEqual(retained, reopened.operation);
  assert.equal(JSON.stringify(candidate), candidateBytes);
  assert.equal(local.getItem(key), savedBytes);
  assert.equal(
    readSavedInputs(local, "original-identity")[0]!.commandId,
    entry.commandId,
  );
  assert.equal(retained.continuation?.generation, 7);
});

test("补充兼容不吞显式mode、当前模型/目录或不同来源和正文", () => {
  const candidate = supplement();
  const saved = operationSchema.parse(newInputOperation(candidate));
  if (saved.type !== "record-input") throw new Error("not input");
  const bytes = JSON.stringify(saved);
  const rejected: InputOperation[] = [
    { ...candidate, dispatchMode: "interrupt" },
    { ...candidate, projectId: "current-project" },
    { ...candidate, conversationId: "current-conversation" },
    { ...candidate, artifactId: "different-artifact", artifactRevision: 2 },
    { ...candidate, body: "改变的正文" },
    { ...candidate, selection: "后来的选文" },
    { ...candidate, targetActantId: "different-agent" },
    { ...candidate, model: "current-model" },
    { ...candidate, reasoningEffort: "max" },
    {
      ...candidate,
      directories: [
        {
          grantId: "933e6399-f91e-43b3-bd04-6c77ec7b2aab",
          name: "新目录",
          path: "/new-path",
          access: "read-write",
        },
      ],
    },
    { ...candidate, applicationInstanceId: "new-application" },
    {
      ...candidate,
      continuation: { ...candidate.continuation!, inputId: "new-input" },
    },
    {
      ...candidate,
      continuation: { ...candidate.continuation!, threadId: "new-thread" },
    },
    {
      ...candidate,
      continuation: { ...candidate.continuation!, generation: 8 },
    },
  ];
  for (const changed of rejected) {
    operationSchema.parse(changed);
    assert.throws(
      () => matchSavedInputOperation(changed, saved),
      /这条消息已保存，请从原消息重试；新草稿未发送/,
    );
    assert.equal(JSON.stringify(saved), bytes);
  }
  assert.strictEqual(
    matchSavedInputOperation({ ...candidate, dispatchMode: "parallel" }, saved),
    saved,
  );
});

test("普通输入和旧无mode outbox不获得新的默认值", () => {
  const { continuation: _continuation, ...ordinary } = supplement();
  const saved = operationSchema.parse(newInputOperation(ordinary));
  if (saved.type !== "record-input") throw new Error("not input");
  assert.throws(() => matchSavedInputOperation(ordinary, saved));
  assert.strictEqual(
    matchSavedInputOperation({ ...ordinary, dispatchMode: "interrupt" }, saved),
    saved,
  );
  const legacy = operationSchema.parse(supplement());
  if (legacy.type !== "record-input") throw new Error("not input");
  const bytes = JSON.stringify(legacy);
  assert.strictEqual(matchSavedInputOperation(supplement(), legacy), legacy);
  assert.equal(JSON.stringify(legacy), bytes);
  assert.equal(legacy.dispatchMode, undefined);
});

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
