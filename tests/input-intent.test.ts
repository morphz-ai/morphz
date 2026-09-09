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
      deliveries: {
        request: {
          io_version: string;
          message: {
            content: {
              value: {
                text: string;
                author_actant_id: string;
                intent?: string;
              };
            };
          };
        };
        sessionId: string;
      }[];
    };
    assert.equal(new Set(runtime.deliveries.map((d) => d.sessionId)).size, 1);
    for (const delivery of runtime.deliveries) {
      assert.equal(delivery.request.io_version, "1");
      assert.equal(
        delivery.request.message.content.value.author_actant_id,
        "local-human",
      );
      assert.equal(
        delivery.request.message.content.value.text,
        "帮我记下检查文案，由我来做，先不执行",
      );
      assert.equal("text" in delivery.request, false);
    }
    assert.equal(
      runtime.deliveries[1]!.request.message.content.value.intent,
      "task",
    );
    assert.equal(
      runtime.deliveries[0]!.request.message.content.value.intent,
      undefined,
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
