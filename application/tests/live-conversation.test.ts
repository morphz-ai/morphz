import test from "node:test";
import assert from "node:assert/strict";
import {
  LiveConversationProjection,
  type StreamEvent,
} from "../packages/core/src/live-conversation.js";
let sequence = 0;
function event(topic: string, payload: Record<string, unknown>): StreamEvent {
  return {
    id: `event-${++sequence}`,
    timestamp: `2026-09-09T00:00:${String(sequence % 60).padStart(2, "0")}.000Z`,
    topic,
    payload,
  };
}
function projection() {
  return new LiveConversationProjection((e) => ({
    projectId: "p",
    conversationId: "c",
    artifactId: null,
    inputId:
      typeof e.payload.root_turn_id === "string"
        ? `input:${e.payload.root_turn_id}`
        : null,
    rootId:
      typeof e.payload.root_turn_id === "string"
        ? e.payload.root_turn_id
        : null,
  }));
}
function delta(
  p: LiveConversationProjection,
  id: string,
  stream: Record<string, unknown>,
  activation = id,
) {
  p.consume(
    event("runtime/model_stream", {
      attempt_id: id,
      activation_id: activation,
      root_turn_id: id,
      stream,
    }),
  );
}
test("真实增量在终结前可见，持久回复替换草稿，迟到增量不复活", () => {
  const p = projection();
  delta(p, "a", { kind: "started" });
  delta(p, "a", { kind: "text_delta", text: "正在" });
  assert.equal(p.snapshot()[0]!.text, "正在");
  assert.equal(p.snapshot()[0]!.streaming, true);
  delta(p, "a", { kind: "text_delta", text: "生成" });
  assert.equal(p.snapshot()[0]!.text, "正在生成");
  const reply = event("chat/reply", {
    attempt_id: "a",
    root_turn_id: "a",
    text: "完整回复",
  });
  p.consume(reply);
  p.consume(reply);
  delta(p, "a", { kind: "started" });
  delta(p, "a", { kind: "text_delta", text: "迟到" });
  assert.equal(p.snapshot().length, 1);
  assert.equal(p.snapshot()[0]!.text, "完整回复");
});
test("并发同 activation 的 attempt 分别终结；重连不拼接丢失前缀", () => {
  const p = projection();
  for (const id of ["a", "b"]) {
    delta(p, id, { kind: "started" }, "shared");
    delta(p, id, { kind: "text_delta", text: id }, "shared");
  }
  p.consume(
    event("chat/reply", {
      attempt_id: "a",
      activation_id: "shared",
      text: "A",
    }),
  );
  assert.ok(p.snapshot().some((m) => m.id === "stream:b"));
  p.reconnect();
  delta(p, "b", { kind: "text_delta", text: "不完整后缀" }, "shared");
  assert.ok(!p.snapshot().some((m) => m.text.includes("后缀")));
});
test("工具参数生成不是执行成功，持久调用和回执去重并保留丰富参数", () => {
  const p = projection();
  delta(p, "a", { kind: "started" });
  delta(p, "a", {
    kind: "tool_call_started",
    index: 0,
    id: "call",
    name: "exec",
  });
  delta(p, "a", {
    kind: "tool_arguments_delta",
    index: 0,
    delta: '{"command":"ls"}',
  });
  delta(p, "a", { kind: "tool_call_completed", index: 0 });
  assert.equal(p.snapshot()[0]!.tool!.status, "pending");
  p.consume(
    event("chat/assistant_call", {
      attempt_id: "a",
      tool_calls: [
        {
          id: "call",
          function: { name: "exec", arguments: '{"command":"ls"}' },
        },
      ],
    }),
  );
  p.consume(
    event("runtime/tool_calls_selected", {
      attempt_id: "a",
      calls: [
        { id: "call", name: "exec", arguments: '{"comm', truncated: true },
      ],
    }),
  );
  assert.equal(p.snapshot().length, 1);
  assert.equal(p.snapshot()[0]!.tool!.status, "running");
  assert.equal(p.snapshot()[0]!.tool!.arguments, '{"command":"ls"}');
  p.consume({
    ...event("custom/output", {
      tool_call_id: "call",
      tool_name: "exec",
      tool_status: "failed",
      text: "失败详情",
    }),
    type: "tool_output",
  });
  assert.equal(p.snapshot()[0]!.tool!.status, "failed");
  assert.equal(p.snapshot()[0]!.tool!.result, "失败详情");
});
test("后台工具启动回执仍显示运行，终结回到原调用", () => {
  const p = projection();
  p.consume(
    event("chat/tool_output", {
      tool_call_id: "call",
      tool_name: "exec",
      execution: "background",
      task_id: "job",
      task_status: "running",
      tool_status: "success",
    }),
  );
  assert.equal(p.snapshot()[0]!.tool!.status, "running");
  p.consume(
    event("chat/tool_output", {
      tool_call_id: "call:background",
      tool_name: "exec/background",
      task_id: "job",
      task_status: "succeeded",
      text: "done",
    }),
  );
  assert.equal(p.snapshot().length, 1);
  assert.equal(p.snapshot()[0]!.tool!.status, "succeeded");
});
test("取消 tombstone 拒绝迟到 started；不展示推理和模型请求", () => {
  const p = projection();
  delta(p, "a", { kind: "started" });
  delta(p, "a", { kind: "reasoning_summary_delta", text: "hidden" });
  p.consume(event("runtime/model_request_snapshot", { text: "secret" }));
  assert.deepEqual(p.snapshot(), []);
  p.consume(event("chat/cancelled", { activation_id: "a" }));
  delta(p, "new", { kind: "started" }, "a");
  delta(p, "new", { kind: "text_delta", text: "late" }, "a");
  assert.deepEqual(p.snapshot(), []);
});
