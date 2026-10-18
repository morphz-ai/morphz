import assert from "node:assert/strict";
import test from "node:test";
import { replyReceipts } from "../apps/web/src/conversation-read.js";
import { presentRuntimeErrors } from "../apps/web/src/runtime-error-presentation.js";
import {
  LiveConversationProjection,
  type LiveMessage,
} from "../packages/core/src/live-conversation.js";

const message = (
  id: string,
  phase: "diagnostic" | "terminal",
  attemptId = "attempt",
  threadId = "thread",
): LiveMessage => ({
  id,
  projectId: "project",
  conversationId: "conversation",
  artifactId: null,
  inputId: "input",
  rootId: "root",
  createdAt: "2026-10-18T14:20:00Z",
  text: id,
  kind: "error",
  threadId,
  failure: {
    kind: "response_protocol",
    phase,
    attemptId,
    state: "response_annotations",
  },
});
test("one physical rejection has one visible error without losing either original diagnostic", () => {
  const diagnostic = message("unescaped layout", "diagnostic"),
    terminal = message("execution safely stopped", "terminal");
  const presented = presentRuntimeErrors([diagnostic, terminal]);
  assert.equal(presented.length, 1);
  assert.equal(presented[0]!.id, terminal.id);
  assert.equal(
    presented[0]!.errorDetails,
    diagnostic.text + "\n\n" + terminal.text,
  );
  assert.equal(presented[0]!.text, terminal.text);
  assert.equal(
    replyReceipts(presented[0]!.representedMessages!, []).length,
    2,
    "one displayed causal error acknowledges both original publications",
  );
  assert.equal(
    terminal.text,
    "execution safely stopped",
    "presentation never mutates raw history",
  );
});
test("independent threads, attempts, unattributed and nonprotocol failures remain separate", () => {
  const messages = [
    message("a", "diagnostic"),
    message("b", "terminal", "other"),
    message("c", "terminal", "attempt", "other-thread"),
    { ...message("d", "diagnostic"), threadId: undefined },
    { ...message("ordinary", "terminal"), failure: undefined },
  ];
  assert.deepEqual(
    presentRuntimeErrors(messages).map((m) => m.id),
    messages.map((m) => m.id),
  );
});
test("only actual Runtime rejection events acquire typed error presentation metadata", () => {
  const projector = new LiveConversationProjection(() => ({
    projectId: "project",
    conversationId: "conversation",
    artifactId: null,
    inputId: "input",
    rootId: "root",
  }));
  for (const [index, topic] of [
    "chat/reply",
    "runtime/response_protocol_error",
    "runtime/response_protocol_fused",
  ].entries())
    projector.consume({
      id: `event-${index}`,
      timestamp: "2026-10-18T14:20:00Z",
      topic,
      payload: {
        text: "original text",
        attempt_id: `attempt-${index}`,
        thread_id: "thread",
        response_state: "response_annotations",
      },
    });
  const messages = projector.snapshot();
  assert.equal(messages.find((m) => m.id === "event-0")!.failure, undefined);
  assert.equal(
    messages.find((m) => m.id === "event-1")!.failure!.phase,
    "diagnostic",
  );
  assert.equal(
    messages.find((m) => m.id === "event-2")!.failure!.phase,
    "terminal",
  );
});

test("actual Session IO terminal failure is presented as an error, not an English normal answer", () => {
  const projector = new LiveConversationProjection(() => ({
    projectId: "project",
    conversationId: "conversation",
    artifactId: null,
    inputId: "input",
    rootId: "root",
  }));
  projector.consume({
    id: "typed-terminal",
    timestamp: "2026-10-18T14:20:00Z",
    topic: "session/io_state",
    payload: {
      text: "Original protocol diagnostic",
      terminal_kind: "failed",
      runtime_failure_kind: "response_annotations_protocol",
      attempt_id: "attempt",
      thread_id: "thread",
    },
  });
  const result = projector.snapshot();
  assert.equal(result.length, 1);
  assert.equal(result[0]!.kind, "error");
  assert.equal(result[0]!.text, "Original protocol diagnostic");
  assert.deepEqual(result[0]!.failure, {
    kind: "response_protocol",
    phase: "terminal",
    attemptId: "attempt",
    state: "response_annotations",
  });
});
