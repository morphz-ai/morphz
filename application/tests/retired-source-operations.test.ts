import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { commandSchema, operationSchema } from "../packages/core/src/model.js";

test("废弃的目录同步不能通过操作或命令契约重新进入正式写路径", () => {
  const identity = {
    projectId: "first-project",
    artifactId: randomUUID(),
    sourceId: randomUUID(),
    deviceId: randomUUID(),
  };
  for (const operation of [
    {
      type: "sync-linked-document",
      ...identity,
      relativePath: "notes.md",
      text: "不恢复已停用的目录同步。",
    },
    {
      type: "linked-source-status",
      ...identity,
      status: "current",
    },
  ]) {
    assert.equal(operationSchema.safeParse(operation).success, false);
    assert.equal(
      commandSchema.safeParse({ commandId: randomUUID(), operation }).success,
      false,
    );
  }
});
