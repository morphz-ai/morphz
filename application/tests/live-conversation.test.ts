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

test("Session IO 终态与快照一致：失败说明可见、清除流式草稿且迟到增量不复活", () => {
  const p = projection();
  delta(p, "a", { kind: "started" });
  delta(p, "a", { kind: "text_delta", text: "未完成的正文" });
  p.consume({
    ...event("session/io_state", {
      attempt_id: "a",
      root_turn_id: "a",
      terminal_kind: "failed",
      text: "结构化输出未完成，请检查结果",
    }),
    sequence: 471,
  });
  delta(p, "a", { kind: "text_delta", text: "迟到文本" });
  const messages = p.snapshot();
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.kind, "error");
  assert.equal(messages[0]!.text, "结构化输出未完成，请检查结果");
  assert.equal((messages[0] as { sequence?: number }).sequence, 471);
});

test("工具调用及最终发布间正文始终可见，最终回执只替换同一次流式输出", () => {
  const p = projection();
  delta(p, "a", { kind: "started" });
  delta(p, "a", { kind: "text_delta", text: "我先核对原文。" });
  const visible = p.snapshot()[0]!;
  for (const topic of [
    "chat/assistant_call",
    "runtime/tool_calls_selected",
    "chat/progress",
  ]) {
    p.consume(
      event(topic, { attempt_id: "a", activation_id: "a", text: "正在核对" }),
    );
    assert.ok(
      p.snapshot().some((m) => m.id === visible.id && m.text === visible.text),
    );
  }
  p.consume(
    event("chat/reply", {
      attempt_id: "a",
      root_turn_id: "a",
      text: "我先核对原文。已经核对完成。",
    }),
  );
  assert.equal(p.snapshot().filter((m) => m.kind === "reply").length, 1);
  assert.equal(
    p.snapshot().find((m) => m.kind === "reply")!.text,
    "我先核对原文。已经核对完成。",
  );
});

test("断线保留读到的前缀，但不拼接缺失前缀的后缀；最终正文原位替换", () => {
  const p = projection();
  delta(p, "a", { kind: "started" });
  delta(p, "a", { kind: "text_delta", text: "读到这里" });
  p.reconnect();
  assert.equal(p.snapshot()[0]!.text, "读到这里");
  assert.equal(p.snapshot()[0]!.streaming, false);
  delta(p, "a", { kind: "text_delta", text: "中间未知的后缀" });
  assert.equal(p.snapshot()[0]!.text, "读到这里");
  p.consume(
    event("chat/reply", {
      attempt_id: "a",
      text: "读到这里，以及完整的最后一段。",
    }),
  );
  assert.equal(p.snapshot().length, 1);
  assert.equal(p.snapshot()[0]!.text, "读到这里，以及完整的最后一段。");
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

test("公开流快照跨刷新恢复半段回复，取消与快照乱序不改变原来源", () => {
  const snapshot = event("runtime/model_public_output", {
    attempt_id: "a",
    activation_id: "act",
    root_turn_id: "root",
    text: "已显示的半段原文",
    first_visible_at: "2026-09-09T00:00:01.000Z",
    complete: false,
    truncated: false,
  });
  const cancelled = event("runtime/thread_cancelled", {
    root_turn_id: "root",
    terminal_kind: "cancelled",
  });
  for (const events of [
    [snapshot, cancelled],
    [cancelled, snapshot],
  ]) {
    const p = projection();
    for (const e of events) p.consume(e);
    p.consume(snapshot);
    delta(p, "a", { kind: "started" }, "act");
    delta(p, "a", { kind: "text_delta", text: "迟到" }, "act");
    assert.equal(p.snapshot().length, 1);
    assert.deepEqual(p.snapshot()[0], {
      id: "stream:a",
      projectId: "p",
      conversationId: "c",
      artifactId: null,
      inputId: "input:root",
      rootId: "root",
      publicationKey: "a",
      createdAt: snapshot.payload.first_visible_at,
      text: "已显示的半段原文",
      kind: "reply",
      streaming: false,
      incomplete: true,
      truncated: false,
    });
  }
});

test("公开流快照原位接替直播；完整发布优先于快照，无重复或时间跳动", () => {
  const p = projection();
  delta(p, "a", { kind: "started" });
  delta(p, "a", { kind: "text_delta", text: "公开前缀" });
  const visible = p.snapshot()[0]!;
  const snapshot = event("runtime/model_public_output", {
    attempt_id: "a",
    root_turn_id: "a",
    text: "公开前缀",
    first_visible_at: visible.createdAt,
    complete: true,
  });
  p.consume(snapshot);
  assert.equal(p.snapshot().length, 1);
  assert.equal(p.snapshot()[0]!.id, visible.id);
  assert.equal(p.snapshot()[0]!.createdAt, visible.createdAt);
  assert.equal(p.snapshot()[0]!.incomplete, false);
  const reply = event("chat/reply", {
    attempt_id: "a",
    root_turn_id: "a",
    text: "公开前缀和正式结果",
  });
  p.consume(reply);
  const replay = projection();
  replay.consume(reply);
  replay.consume(snapshot);
  assert.deepEqual(p.snapshot(), replay.snapshot());
  assert.equal(p.snapshot().length, 1);
  assert.equal(p.snapshot()[0]!.incomplete, undefined);
});

test("同一根多个尝试不互相覆盖；截断标记明确，取消不影响另一根", () => {
  const p = projection();
  for (const [id, root] of [
    ["a", "root"],
    ["b", "root"],
    ["c", "other"],
  ])
    p.consume(
      event("runtime/model_public_output", {
        attempt_id: id,
        root_turn_id: root,
        text: id,
        first_visible_at: "2026-09-09T00:00:01.000Z",
        complete: true,
        truncated: id === "b",
      }),
    );
  p.consume(event("runtime/thread_cancelled", { root_turn_id: "root" }));
  assert.equal(p.snapshot().length, 3);
  assert.ok(
    p
      .snapshot()
      .filter((m) => m.rootId === "root")
      .every((m) => m.incomplete),
  );
  assert.equal(
    p.snapshot().find((m) => m.publicationKey === "b")!.truncated,
    true,
  );
  assert.equal(
    p.snapshot().find((m) => m.publicationKey === "c")!.incomplete,
    false,
  );
});

test("先收到根取消时，未知尝试的迟到流不能复活", () => {
  const p = projection();
  p.consume(event("runtime/thread_cancelled", { root_turn_id: "a" }));
  delta(p, "a", { kind: "started" }, "unseen-activation");
  delta(p, "a", { kind: "text_delta", text: "不可复活" }, "unseen-activation");
  assert.deepEqual(p.snapshot(), []);
});
