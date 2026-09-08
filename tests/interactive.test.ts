import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { localAccess } from "../packages/core/src/model.js";
import {
  emptyInteractive,
  interactiveSchema,
  interactiveDraftSchema,
  interactiveSummary,
} from "../packages/core/src/interactive.js";
test("交互产物的数据、版本、引用和检索共用对象规则；不执行脚本", () => {
  const store = new WorkspaceStore(":memory:");
  const content = {
    ...emptyInteractive,
    rows: [
      { id: "a", cells: { name: "合成资料", value: 4, done: true } },
      {
        id: "b",
        cells: {
          name: "<script>fetch('/api/workspace')</script>",
          value: 6,
          done: false,
        },
      },
    ],
  };
  const receipt = store.execute(
    {
      commandId: randomUUID(),
      operation: {
        type: "create-artifact",
        projectId: "first-project",
        title: "进度记录",
        content,
      },
    },
    localAccess,
  );
  assert.equal(interactiveSummary(content)[0]!.mean, 5);
  assert.equal(store.search({ query: "合成资料" }, localAccess).total, 1);
  const command = {
    commandId: randomUUID(),
    operation: {
      type: "revise-artifact" as const,
      artifactId: receipt.entityId,
      expectedRevision: 1,
      title: "进度记录",
      content: { ...content, layout: "report" as const },
    },
  };
  store.execute(command, localAccess);
  assert.deepEqual(
    store.execute(command, localAccess),
    store.execute(command, localAccess),
  );
  assert.throws(
    () => store.execute({ ...command, commandId: randomUUID() }, localAccess),
    /新版本/,
  );
  const a = store.snapshot().artifacts[0]!;
  assert.equal(a.versions[0]!.content.kind, "interactive");
  store.execute(
    {
      commandId: randomUUID(),
      operation: {
        type: "annotate",
        artifactId: a.id,
        artifactRevision: 1,
        quote: "合成资料",
        body: "请补充来源",
      },
    },
    localAccess,
  );
  assert.equal(store.snapshot().annotations[0]!.artifactRevision, 1);
  store.close();
});
test("表单验证字段类型与必填项，不完整草稿可恢复但不能提交", () => {
  const draft = { ...emptyInteractive, rows: [{ id: "a", cells: {} }] };
  assert.equal(interactiveDraftSchema.safeParse(draft).success, true);
  assert.equal(interactiveSchema.safeParse(draft).success, false);
  for (const cells of [
    { name: "记录", value: "不是数字" },
    { name: "记录", done: 2 },
    { name: "记录", secret: "未知字段" },
  ])
    assert.equal(
      interactiveSchema.safeParse({
        ...emptyInteractive,
        rows: [{ id: "a", cells }],
      }).success,
      false,
    );
  assert.equal(
    interactiveSchema.safeParse({ ...emptyInteractive, script: "alert(1)" })
      .success,
    false,
  );
});
