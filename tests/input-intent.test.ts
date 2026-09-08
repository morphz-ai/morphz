import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { RuntimeBridge } from "../apps/service/src/runtime.js";
import {
  localAccess,
  operationSchema,
  stateSchema,
} from "../packages/core/src/model.js";

test("输入意图持久化并进入 Runtime，普通输入享有相同工具行为且不直接创建对象", () => {
  const store = new WorkspaceStore(":memory:");
  const bridge = new RuntimeBridge(store, {
    url: "http://127.0.0.1:1",
    token: "test-only",
    namespace: randomUUID(),
  });
  try {
    for (const intent of [
      undefined,
      "task",
      "document",
      "website",
      "interactive",
    ] as const) {
      const receipt = store.execute(
        {
          commandId: randomUUID(),
          operation: {
            type: "record-input",
            projectId: "local-inbox",
            artifactId: null,
            artifactRevision: null,
            selection: "",
            body: "帮我记下检查文案，由我来做，先不执行",
            targetActantId: "morphz-agent",
            ...(intent ? { intent } : {}),
          },
        },
        localAccess,
      );
      bridge.enqueue(receipt.entityId);
    }
    const saved = stateSchema.parse(store.snapshot());
    assert.equal(saved.artifacts.length, 0);
    assert.equal(saved.inputs.length, 5);
    assert.equal(saved.inputs[1]!.intent, "task");
    const runtime = store.runtimeState() as {
      deliveries: { request: { text: string }; sessionId: string }[];
    };
    assert.equal(new Set(runtime.deliveries.map((d) => d.sessionId)).size, 1);
    for (const delivery of runtime.deliveries) {
      assert.match(
        delivery.request.text,
        /当前输入者的 Actant ID：local-human/,
      );
      assert.match(delivery.request.text, /不要要求用户再去填新建表单/);
      assert.match(delivery.request.text, /不能声称已保存/);
      assert.match(delivery.request.text, /runRequested=0/);
    }
    assert.match(
      runtime.deliveries[1]!.request.text,
      /用户选择的输入意图：安排事项/,
    );
    assert.doesNotMatch(
      runtime.deliveries[0]!.request.text,
      /用户选择的输入意图/,
    );
    assert.throws(() =>
      operationSchema.parse({
        type: "record-input",
        intent: "publish-everything",
      }),
    );
  } finally {
    store.close();
  }
});
