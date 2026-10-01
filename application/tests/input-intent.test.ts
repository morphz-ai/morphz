import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";
import {
  inputIntents,
  inputIntentSchema,
} from "../packages/core/src/input-intent.js";
import { operationSchema } from "../packages/core/src/model.js";

test("旧表格意图继续可读，不再将报告当作表格创作提示", () => {
  assert.equal(inputIntentSchema.parse("interactive"), "interactive");
  assert.equal(inputIntents.interactive.label, "制作表格");
  assert.doesNotMatch(inputIntents.interactive.placeholder, /报告|Office/);
});

test("新剧构思使用独立意图与占位提示，不将模板写入正文", () => {
  assert.equal(inputIntentSchema.parse("script"), "script");
  assert.equal(inputIntents.script.label, "构思新剧");
  assert.match(inputIntents.script.placeholder, /想法|题材/);
});

test("输入意图持久化并进入 Runtime，普通输入享有相同工具行为且不直接创建对象", async () => {
  const f = await platformRuntimeHostFixture();
  try {
    for (const intent of [
      undefined,
      "task",
      "document",
      "website",
      "interactive",
      "script",
    ] as const) {
      await f.session().platformMessage({
        commandId: randomUUID(),
        operation: {
          type: "record-input",
          projectId: f.projectId,
          artifactId: null,
          artifactRevision: null,
          selection: "",
          body: "帮我记下检查文案，由我来做，先不执行",
          targetActantId: "morphz-agent",
          ...(intent ? { intent } : {}),
        },
      });
    }
    assert.deepEqual(
      await f.session().listPlatformContent({ projectId: f.projectId }),
      [],
    );
    assert.deepEqual(
      await f.session().listPlatformTasks({ projectId: f.projectId }),
      [],
    );
    const runtime = f.store.runtimeState() as {
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
    assert.equal(runtime.deliveries.length, 6);
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
    assert.equal(
      runtime.deliveries[5]!.request.message.content.value.intent,
      "script",
    );
    assert.throws(() =>
      operationSchema.parse({
        type: "record-input",
        intent: "publish-everything",
      }),
    );
    await f.reopen();
    assert.deepEqual(
      (f.store.runtimeState() as typeof runtime).deliveries,
      runtime.deliveries,
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});
