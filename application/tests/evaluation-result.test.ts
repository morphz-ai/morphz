import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluationPreview,
  evaluationSourceKey,
  evaluationDisplayText,
  evaluationMessageId,
  coalesceEvaluationMessages,
} from "../packages/core/src/evaluation-result.js";
import { harnessOutputTextPath } from "../packages/application/src/harness-output-presentation.js";
import {
  LiveConversationProjection,
  type StreamEvent,
} from "../packages/core/src/live-conversation.js";

test("同一逻辑求值的工具续接只更新一条消息，晚到快照不覆盖校验终值，其他求值不合并", () => {
  const source = { plan_execution_id: "same-plan", effect_sequence: 2 };
  const id = evaluationMessageId("first", source, "root");
  assert.equal(id, evaluationMessageId("continuation", source, "root"));
  assert.notEqual(id, evaluationMessageId("first", source, "different-root"));
  const projection = new LiveConversationProjection(() => ({
    projectId: "p",
    conversationId: "c",
    artifactId: null,
    inputId: "i",
    rootId: "root",
  }));
  for (const [index, activation, topic, payload] of [
    [
      1,
      "first",
      "runtime/inference_value",
      { text: '"已返回终值"', validation: "accepted" },
    ],
    [
      2,
      "continuation",
      "runtime/model_evaluation_output",
      { text: '"晚到的前缀"', complete: true },
    ],
    [3, "continuation", "plan/infer_result", { text: '"另一个未校验快照"' }],
  ] as const)
    projection.consume({
      id: String(index),
      topic,
      timestamp: "2026-10-17T01:00:00Z",
      sequence: index,
      payload: {
        activation_id: activation,
        root_turn_id: "root",
        inference_source: source,
        ...payload,
      },
    });
  assert.equal(projection.snapshot().length, 1);
  assert.equal(projection.snapshot()[0]?.text, '"已返回终值"');
  const terminal = projection.snapshot()[0]!;
  const prefix = {
    ...terminal,
    createdAt: "2026-10-17T00:00:00Z",
    text: "old",
    evaluation: { ...terminal.evaluation!, validation: "pending" as const },
  };
  for (const order of [
    [prefix, terminal],
    [terminal, prefix],
  ]) {
    const merged = coalesceEvaluationMessages(order);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.text, terminal.text);
    assert.equal(merged[0]?.createdAt, prefix.createdAt);
  }
});

test("普通讨论只投影实际 Harness 声明的正文，未知结构仍是数据而非靠 reply 字段猜测", () => {
  const root = {
    topic: "chat/infer_request",
    payload: {
      request: {
        program:
          '(infer (captures input) (returns ScriptIntent) "STAGE script-discussion")',
      },
    },
  };
  const harness = { id: "morphz.script-studio", version: "2.3.0" };
  assert.deepEqual(harnessOutputTextPath(root, harness), ["reply"]);
  assert.equal(
    harnessOutputTextPath(root, { ...harness, id: "other" }),
    undefined,
  );
  assert.equal(
    harnessOutputTextPath({ ...root, topic: "chat/message" }, harness),
    undefined,
  );
  assert.equal(
    harnessOutputTextPath(
      {
        ...root,
        payload: {
          request: {
            program:
              '(infer (returns String) "mentions (returns ScriptIntent)")',
          },
        },
      },
      harness,
    ),
    undefined,
  );
  const text = '{"execute":false,"reply":"第一行\\n第二行正在';
  const evaluation = {
    activationId: "a",
    validation: "pending" as const,
    textPath: ["reply"],
  };
  assert.equal(
    evaluationDisplayText({ text, evaluation }),
    "第一行\n第二行正在",
  );
  assert.equal(
    evaluationDisplayText({ text: '{"execute":false,', evaluation }),
    "",
  );
  assert.match(evaluationDisplayText({ text }), /"execute": false/);
  assert.equal(
    evaluationDisplayText({ text: '"普通文字\\n仍可见' }),
    "普通文字\n仍可见",
  );
  assert.equal(
    evaluationDisplayText({
      text: '{"$yao":{"fields":{"reply":"带类型包装"}}}',
      evaluation,
    }),
    "带类型包装",
  );
});

test("求值展示只解析数据前缀，解码换行和引号，不伪造终值", () => {
  const partial = evaluationPreview(
    '{"execute":false,"reply":"第一行\\n第二行\\u4f60\\"',
  );
  assert.equal(partial.partial, true);
  assert.equal(
    (partial.value as Record<string, unknown>).reply,
    '第一行\n第二行你"',
  );
  const whole = evaluationPreview(
    JSON.stringify({ execute: false, reply: "真正正文\n下一行", task: "" }),
  );
  assert.equal(whole.partial, false);
  assert.deepEqual(whole.value, {
    execute: false,
    reply: "真正正文\n下一行",
    task: "",
  });
  assert.equal(evaluationPreview('"尾部\\uD83D').value, "尾部");
  assert.equal(evaluationPreview('(eval "code")').value, undefined);
});

test("不信任字段名和相同正文，只使用完整求值来源", () => {
  assert.equal(evaluationSourceKey({ reply: "hello" }), null);
  assert.notEqual(
    evaluationSourceKey({ plan_execution_id: "p", effect_sequence: 1 }),
    evaluationSourceKey({ plan_execution_id: "p", effect_sequence: 2 }),
  );
});

test("内部 infer 文本以求值消息流式显示，隐藏推理不进入输出，终值校验独立", () => {
  const projection = new LiveConversationProjection(() => ({
    projectId: "p",
    conversationId: "c",
    artifactId: null,
    inputId: "i",
    rootId: "infer-root",
  }));
  let sequence = 0;
  const event = (
    topic: string,
    payload: Record<string, unknown>,
  ): StreamEvent => ({
    id: `e${++sequence}`,
    timestamp: `2026-10-16T10:00:${String(sequence).padStart(2, "0")}Z`,
    topic,
    sequence,
    payload: {
      model_output_visibility: "internal",
      activation_id: "a",
      attempt_id: "physical",
      root_turn_id: "infer-root",
      inference_source: { plan_execution_id: "plan", effect_sequence: 3 },
      ...payload,
    },
  });
  projection.consume(
    event("runtime/model_stream", { stream: { kind: "started" } }),
  );
  projection.consume(
    event("runtime/model_stream", {
      stream: { kind: "reasoning_summary_delta", text: "not public" },
    }),
  );
  projection.consume(
    event("runtime/model_stream", {
      stream: { kind: "text_delta", text: '{"reply":"边生成' },
    }),
  );
  let messages = projection.snapshot();
  assert.equal(messages.length, 1);
  assert.ok(messages[0]);
  assert.equal(messages[0].kind, "evaluation");
  assert.equal(messages[0].streaming, true);
  assert.equal(messages[0].evaluation?.validation, "pending");
  assert.doesNotMatch(messages[0].text, /not public/);
  projection.consume(
    event("plan/infer_result", { text: '{"reply":"边生成边可见"}' }),
  );
  projection.consume(
    event("runtime/inference_value", {
      text: '{"reply":"边生成边可见"}',
      validation: "accepted",
    }),
  );
  projection.consume(
    event("runtime/model_evaluation_output", {
      text: "old prefix",
      complete: true,
    }),
  );
  messages = projection.snapshot();
  assert.equal(messages.length, 1);
  assert.ok(messages[0]);
  assert.equal(messages[0].evaluation?.validation, "accepted");
  assert.equal(messages[0].text, '{"reply":"边生成边可见"}');
  assert.equal(messages[0].streaming, false);
  assert.equal(
    evaluationSourceKey(messages[0].evaluation?.source),
    evaluationSourceKey({ plan_execution_id: "plan", effect_sequence: 3 }),
  );
});

test("求值重连保留前缀但停止动画，失败重试不拼接旧 JSON，校验后不被迟到事件倒退", () => {
  const projection = new LiveConversationProjection(() => ({
    projectId: "p",
    conversationId: "c",
    artifactId: null,
    inputId: "i",
    rootId: "root",
  }));
  let sequence = 0;
  const emit = (
    topic: string,
    payload: Record<string, unknown>,
    attempt = "first",
  ) =>
    projection.consume({
      id: `retry-${++sequence}`,
      timestamp: `2026-10-16T10:01:${String(sequence).padStart(2, "0")}Z`,
      topic,
      sequence,
      payload: {
        model_output_visibility: "internal",
        activation_id: "a",
        attempt_id: attempt,
        root_turn_id: "root",
        ...payload,
      },
    });
  emit("runtime/model_stream", { stream: { kind: "started" } });
  emit("runtime/model_stream", {
    stream: { kind: "text_delta", text: '"old' },
  });
  projection.reconnect();
  assert.equal(projection.snapshot()[0]?.streaming, false);
  assert.equal(projection.snapshot()[0]?.incomplete, true);
  emit("runtime/model_stream", {
    stream: { kind: "text_delta", text: "lost suffix" },
  });
  assert.equal(projection.snapshot()[0]?.text, '"old');
  emit("runtime/model_stream", { stream: { kind: "started" } }, "retry");
  emit(
    "runtime/model_stream",
    { stream: { kind: "text_delta", text: '"new"' } },
    "retry",
  );
  emit("runtime/model_evaluation_output", { text: '"old"', complete: false });
  assert.equal(projection.snapshot()[0]?.text, '"new"');
  emit(
    "runtime/inference_value",
    { text: '"new"', validation: "accepted" },
    "retry",
  );
  emit("runtime/model_stream", { stream: { kind: "started" } }, "late");
  emit(
    "runtime/model_attempt_state",
    { terminal: true, state: "failed" },
    "retry",
  );
  assert.equal(projection.snapshot()[0]?.text, '"new"');
  assert.equal(projection.snapshot()[0]?.evaluation?.validation, "accepted");
  assert.equal(projection.snapshot()[0]?.streaming, false);
  assert.equal(projection.snapshot()[0]?.incomplete, false);
});

test("只有持久终值也可恢复求值消息；拒绝校验不是任务成功或普通回复", () => {
  const projection = new LiveConversationProjection(() => ({
    projectId: "p",
    conversationId: "c",
    artifactId: null,
    inputId: "i",
    rootId: "root",
  }));
  projection.consume({
    id: "validation",
    timestamp: "2026-10-16T10:02:00Z",
    topic: "runtime/inference_value",
    payload: {
      activation_id: "a",
      validation: "rejected",
      text: "wrong type",
      inference_source: { plan_execution_id: "p", effect_sequence: 1 },
    },
  });
  assert.equal(projection.snapshot()[0]?.text, "wrong type");
  assert.equal(projection.snapshot()[0]?.evaluation?.validation, "rejected");
  assert.equal(projection.snapshot()[0]?.kind, "evaluation");
});
