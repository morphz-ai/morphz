import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluationPreview,
  evaluationSourceKey,
} from "../packages/core/src/evaluation-result.js";
import {
  LiveConversationProjection,
  type StreamEvent,
} from "../packages/core/src/live-conversation.js";

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
