import test from "node:test";
import assert from "node:assert/strict";
import { conversationTimeline } from "../packages/core/src/conversation.js";
import {
  LiveConversationProjection,
  type StreamEvent,
} from "../packages/core/src/live-conversation.js";

test("迟到交付按发布时间追加，而不是跟随原始输入排序", () => {
  const items = [
    { id: "input-a", createdAt: "01" },
    { id: "final-a", createdAt: "05" },
    { id: "input-b", createdAt: "02" },
    { id: "reply-b", createdAt: "03" },
  ];
  assert.deepEqual(
    conversationTimeline(items).map((x) => x.id),
    ["input-a", "input-b", "reply-b", "final-a"],
  );
  assert.equal(items[1]!.id, "final-a");
});

test("流式正文以首段可见内容定位置，增量不改变时间，分支标识随消息保留", () => {
  const projection = new LiveConversationProjection(() => ({
    projectId: "p",
    conversationId: "c",
    artifactId: null,
    inputId: "i",
    rootId: "r",
  }));
  const event = (
    id: string,
    timestamp: string,
    stream: unknown,
  ): StreamEvent => ({
    id,
    timestamp,
    topic: "runtime/model_stream",
    payload: {
      attempt_id: "attempt",
      activation_id: "activation",
      thread_id: "thread",
      stream,
    },
  });
  projection.consume(event("s", "01", { kind: "started" }));
  projection.consume(event("t", "03", { kind: "text_delta", text: "部分" }));
  projection.consume(event("u", "05", { kind: "text_delta", text: "回复" }));
  const message = projection.snapshot().find((m) => m.kind === "reply")!;
  assert.equal(message.createdAt, "03");
  assert.equal(message.publicationKey, "attempt");
  assert.equal(message.threadId, "thread");
  assert.equal(message.text, "部分回复");
});
