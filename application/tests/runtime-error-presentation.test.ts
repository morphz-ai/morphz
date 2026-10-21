import assert from "node:assert/strict";
import test from "node:test";
import { replyReceipts } from "../apps/web/src/conversation-read.js";
import {
  presentRuntimeErrors,
  runtimeErrorDetails,
} from "../apps/web/src/runtime-error-presentation.js";
import { runtimeFailureDiagnostics } from "../packages/core/src/runtime-message-failure.js";
import { responseAnswered } from "../apps/web/src/conversation-presentation.js";
import { searchConversationPage } from "../packages/core/src/conversation-search.js";
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
    1,
    "an intermediate diagnostic is not an unread reply publication",
  );
  assert.equal(
    terminal.text,
    "execution safely stopped",
    "presentation never mutates raw history",
  );
});
for (const text of [
  "The reply could not be delivered correctly; previously completed work was preserved.",
  "The reply delivery format was invalid. The Objective is not complete; previously completed work was preserved.",
  "本次回复未能正确交付；已保留此前完成的工作。",
  "本次回复的交付格式不正确，目标尚未完成；已保留此前完成的工作。",
])
  test(`a generic terminal notice is not an error detail; persisted reasons survive: ${text}`, () => {
    const terminal = {
      ...message("terminal", "terminal"),
      text,
    };
    const empty = presentRuntimeErrors([terminal])[0]!;
    assert.equal(runtimeErrorDetails(empty), "");
    assert.equal(runtimeErrorDetails(terminal), "");
    const reason =
      'schema_validation_failed: Schema validation failed at JSON pointer ""';
    const populated = presentRuntimeErrors([
      {
        ...terminal,
        failure: {
          ...terminal.failure!,
          diagnostics: [{ eventId: "actual-rejection", reason }],
        },
      },
    ])[0]!;
    assert.equal(populated.errorDetails, reason);
    assert.equal(
      populated.text,
      terminal.text,
      "immutable terminal text is preserved",
    );
    assert.equal(
      populated.representedMessages?.length,
      1,
      "diagnostics are not fabricated messages",
    );
  });

test("history diagnostics require exact persisted public rejection scope and never expose captures", () => {
  const payload = {
    session_id: "session",
    context_id: "context",
    root_turn_id: "root",
    thread_id: "thread",
    attempt_id: "attempt",
    principal_id: "human",
    model_output_visibility: "public",
  };
  const terminal = {
    id: "terminal",
    sequence: 50,
    topic: "session/io_state",
    actor: "Runtime-Orchestrator",
    payload: { ...payload, runtime_failure_kind: "response_protocol" },
  };
  const diagnostic = {
    id: "diagnostic",
    sequence: 49,
    topic: "runtime/response_protocol_error",
    actor: "Runtime-Orchestrator",
    payload: {
      ...payload,
      reason: "actual schema failure",
      response_capture: { reasoning: "never public" },
    },
  };
  const mutations = [
    "session_id",
    "context_id",
    "root_turn_id",
    "thread_id",
    "attempt_id",
    "principal_id",
    "model_output_visibility",
  ];
  const events = mutations.map((key) => ({
    ...diagnostic,
    id: key,
    payload: {
      ...diagnostic.payload,
      [key]: key === "model_output_visibility" ? "internal" : "foreign",
    },
  }));
  assert.deepEqual(
    runtimeFailureDiagnostics(terminal, [
      ...events,
      { ...diagnostic, actor: "Model" },
      { ...diagnostic, sequence: 51 },
      { ...diagnostic, topic: "runtime/model_output" },
      diagnostic,
    ]),
    [{ eventId: "diagnostic", reason: "actual schema failure" }],
  );
  assert.deepEqual(
    runtimeFailureDiagnostics(
      { ...terminal, payload: { ...terminal.payload, thread_id: "" } },
      [diagnostic],
    ),
    [],
  );
  assert.deepEqual(
    runtimeFailureDiagnostics({ ...terminal, sequence: undefined }, [
      diagnostic,
    ]),
    [],
  );
  assert.equal(
    runtimeFailureDiagnostics(
      terminal,
      Array.from({ length: 64 }, (_, i) => ({ ...diagnostic, id: String(i) })),
    ).length,
    16,
  );
});
test("independent terminal and nonprotocol failures stay separate; diagnostics never masquerade as failures", () => {
  const messages = [
    message("a", "diagnostic"),
    message("b", "terminal", "other"),
    message("c", "terminal", "attempt", "other-thread"),
    { ...message("d", "diagnostic"), threadId: undefined },
    { ...message("ordinary", "terminal"), failure: undefined },
  ];
  assert.deepEqual(
    presentRuntimeErrors(messages).map((m) => m.id),
    messages.filter((m) => m.failure?.phase !== "diagnostic").map((m) => m.id),
  );
});

test("a recoverable wait rejection neither fails nor answers a request, before or after a corrected reply", () => {
  const diagnostic = {
    ...message("wait-rejected", "diagnostic", "first-attempt"),
    text: "no_reply(mode=wait) was rejected: no pending Runtime event",
    failure: {
      ...message("unused", "diagnostic").failure!,
      state: "invalid_wait",
      attemptId: "first-attempt",
    },
  };
  const corrected: LiveMessage = {
    ...message("actual-final-reply", "terminal", "later-attempt"),
    kind: "reply",
    failure: undefined,
    text: "TEST 已完成并交付。",
  };
  for (const messages of [
    [diagnostic],
    [diagnostic, corrected],
    [corrected, diagnostic],
  ]) {
    assert.deepEqual(
      presentRuntimeErrors(messages).map((m) => m.id),
      messages.includes(corrected) ? [corrected.id] : [],
    );
    assert.equal(
      responseAnswered(messages, "input"),
      messages.includes(corrected),
    );
    assert.equal(
      replyReceipts(messages, []).length,
      messages.includes(corrected) ? 1 : 0,
    );
    assert.deepEqual(
      searchConversationPage([], messages, "no_reply"),
      [],
      "execution diagnostics are not searchable user replies",
    );
  }
  assert.equal(
    diagnostic.text.includes("rejected"),
    true,
    "raw execution evidence is retained",
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
