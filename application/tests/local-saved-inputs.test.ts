import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  readSavedInputs,
  removeSavedInput,
  saveInputLocally,
} from "../apps/web/src/local-saved-inputs.js";

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
