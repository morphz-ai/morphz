import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  emptyInteractive,
  interactiveRowEdits,
  type InteractiveContent,
} from "../packages/core/src/interactive.js";
import { executePlatformOperation, type Boot } from "../apps/web/src/client.js";
import type { PlatformClient } from "../apps/web/src/platform-client.js";

const previous: InteractiveContent = {
  ...emptyInteractive,
  rows: [
    { id: "a", cells: { name: "一", value: 3, done: true } },
    { id: "b", cells: { name: "二", value: 4, done: false } },
    { id: "c", cells: { name: "三", value: 5, done: false } },
  ],
};
const next: InteractiveContent = {
  ...previous,
  rows: [
    { id: "x", cells: { name: "新增一" } },
    { id: "y", cells: { name: "新增二" } },
    { id: "a", cells: { name: "一", value: 0, done: false } },
    { id: "c", cells: { name: "三", value: null } },
  ],
};

test("原编辑器的普通记录增改删发局部命令，保留缺失/null/0/false与插入次序", async () => {
  const operations = interactiveRowEdits(previous, next);
  assert.deepEqual(operations, [
    { type: "delete", rowId: "b" },
    { type: "update", rowId: "a", cells: { value: 0, done: false } },
    { type: "update", rowId: "c", cells: { value: null }, unset: ["done"] },
    { type: "insert", row: next.rows[1], beforeRowId: "a" },
    { type: "insert", row: next.rows[0], beforeRowId: "y" },
  ]);
  const calls: unknown[] = [];
  const source = {
    patchInteractiveRows: async (input: unknown) => {
      calls.push(input);
    },
    reviseInteractive: async () => {
      throw new Error("row edit must not submit the whole table");
    },
  } as unknown as PlatformClient;
  const identity = {
    workspace: {
      revision: 4,
      artifacts: [
        {
          id: "table",
          revision: 1,
          title: "记录",
          content: previous,
          versions: [],
        },
      ],
    },
  } as unknown as Boot;
  const commandId = randomUUID();
  const receipt = await executePlatformOperation(
    source,
    identity,
    {
      commandId,
      operation: {
        type: "revise-artifact",
        artifactId: "table",
        expectedRevision: 1,
        title: "记录",
        content: next,
      },
    },
    false,
  );
  assert.equal(receipt.entityId, "table");
  assert.deepEqual(calls, [
    { commandId, contentId: "table", expectedRevision: 1, operations },
  ]);
});

test("字段/说明/布局/既有行次序变化仍是明确完整修订，不丢原编辑器能力", () => {
  for (const changed of [
    { ...previous, description: "说明" },
    { ...previous, layout: "form" as const },
    { ...previous, columns: previous.columns.slice(0, 2) },
    { ...previous, rows: [...previous.rows].reverse() },
    { ...previous, rows: [previous.rows[0]!, previous.rows[0]!] },
    {
      ...previous,
      rows: Array.from({ length: 101 }, (_, i) => ({
        id: `new_${i}`,
        cells: { name: "新增" },
      })),
    },
  ])
    assert.equal(interactiveRowEdits(previous, changed), null);
  assert.deepEqual(
    interactiveRowEdits(previous, structuredClone(previous)),
    [],
  );
});
