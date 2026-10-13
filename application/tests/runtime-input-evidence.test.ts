import test from "node:test";
import assert from "node:assert/strict";
import type { HostInvocation } from "../packages/application/src/agent-tools.js";
import {
  resolveRuntimeInputEvidence,
  resolveRuntimeTaskRunEvidence,
  runtimeHttpInputEvidenceReader,
  type RuntimeInputEvidenceReader,
} from "../packages/application/src/runtime-input-evidence.js";
import { taskRunAdmissionSchema } from "../packages/platform/src/task-run-admission.js";

const route: HostInvocation = {
  job_id: "job-1",
  tool_call_id: "call-1",
  session_id: "session-1",
  context_id: "context-1",
  principal_id: "runtime-human-1",
  agent_id: "agent-1",
  thread_id: "thread-1",
  target_id: "target-1",
};
const inputEvent = {
  id: "event-1",
  actor: "Session-Client",
  type: "session_message",
  topic: "chat/user_message",
  payload: {
    session_id: "session-1",
    context_id: "context-1",
    principal_id: "runtime-human-1",
    client_message_id: "input-1",
    session_io: {
      request: {
        io_version: "1",
        client_message_id: "input-1",
        message: {
          format: { id: "morphz.application.input", version: "1" },
          content: {
            encoding: "json",
            value: {
              type: "object",
              value: {
                input_id: { type: "string", value: "input-1" },
                workspace_id: { type: "string", value: "project-1" },
                author_actant_id: {
                  type: "string",
                  value: "claimed-human-actant",
                },
                text: { type: "string", value: "创建剧本" },
              },
            },
          },
        },
      },
    },
  },
};
const parentThread = {
  id: "thread-1",
  session_id: "session-1",
  context_id: "context-1",
  root_turn_id: "event-1",
  initiating_principal_id: "runtime-human-1",
  agent_id: "agent-1",
  executor_kind: "agent",
  executor_id: null,
};

/** Controlled current Runtime proof DTOs; ancestry itself is tested against the
 * actual Runtime/SQL owner, not reconstructed in this Host fixture. */
function evidence(
  source: unknown = {
    kind: "input",
    input_event: inputEvent,
    root_thread_id: parentThread.id,
  },
  thread: unknown = parentThread,
): RuntimeInputEvidenceReader {
  return {
    async readThreadInputSource(sessionId, threadId, principal) {
      assert.equal(sessionId, route.session_id);
      assert.equal(threadId, (thread as typeof parentThread).id);
      assert.equal(principal, route.principal_id);
      return { thread, source };
    },
    async readThread() {
      throw new Error("Host must not walk its own ancestry");
    },
    async readSessionEvent() {
      throw new Error("Host must not look up a synthetic root Event");
    },
  };
}
test("Host reads one Runtime-owned source proof, including exact authenticated input", async () => {
  assert.deepEqual(await resolveRuntimeInputEvidence(route, evidence()), {
    runtimePrincipalId: "runtime-human-1",
    runtimeEventId: inputEvent.id,
    inputId: "input-1",
    projectId: "project-1",
    claimedActantId: "claimed-human-actant",
    sessionId: route.session_id,
    contextId: route.context_id,
    inputEvent,
  });
});
test("Goal / spawn / infer roots are execution identities, never guessed Human Event IDs", async () => {
  for (const root of [
    "objective-root",
    "spawn-root",
    "infer-request-root",
    "resumed-root",
  ]) {
    const thread = { ...parentThread, root_turn_id: root };
    assert.equal(
      (await resolveRuntimeInputEvidence(route, evidence(undefined, thread)))
        .inputId,
      "input-1",
    );
  }
  await assert.rejects(
    resolveRuntimeInputEvidence(route, evidence(null)),
    /未绑定/,
  );
});
test("direct admitted Goal source may have an exact Human Event without an ordinary source Thread", async () => {
  const source = {
    kind: "input",
    input_event: inputEvent,
    root_thread_id: null,
  };
  const thread = { ...parentThread, root_turn_id: "objective-primary-root" };
  assert.equal(
    (await resolveRuntimeInputEvidence(route, evidence(source, thread)))
      .inputId,
    "input-1",
  );
});
test("unverifiable or cross-scope proofs fail closed without fallback or source rewriting", async () => {
  for (const key of [
    "session_id",
    "context_id",
    "initiating_principal_id",
    "agent_id",
  ]) {
    const thread = { ...parentThread, [key]: "foreign" };
    await assert.rejects(
      resolveRuntimeInputEvidence(route, evidence(undefined, thread)),
      /未绑定/,
    );
  }
  for (const key of [
    "session_id",
    "context_id",
    "principal_id",
    "client_message_id",
  ]) {
    const wrong = {
      ...inputEvent,
      payload: { ...inputEvent.payload, [key]: "foreign" },
    };
    await assert.rejects(
      resolveRuntimeInputEvidence(
        route,
        evidence({
          kind: "input",
          input_event: wrong,
          root_thread_id: parentThread.id,
        }),
      ),
      /未绑定/,
    );
  }
  for (const wrong of [
    { ...inputEvent, actor: "Agent-Morphz" },
    { ...inputEvent, type: "agent_call" },
    { ...inputEvent, topic: "chat/reply" },
    {
      ...inputEvent,
      payload: {
        ...inputEvent.payload,
        session_io: {
          request: {
            ...inputEvent.payload.session_io.request,
            message: {
              format: { id: "morphz.chat", version: "1" },
              content: inputEvent.payload.session_io.request.message.content,
            },
          },
        },
      },
    },
    {
      ...inputEvent,
      payload: {
        ...inputEvent.payload,
        session_io: {
          request: {
            ...inputEvent.payload.session_io.request,
            message: {
              format: { id: "morphz.application.input", version: "1" },
              content: { encoding: "json", value: { input_id: "input-1" } },
            },
          },
        },
      },
    },
  ])
    await assert.rejects(
      resolveRuntimeInputEvidence(
        route,
        evidence({
          kind: "input",
          input_event: wrong,
          root_thread_id: parentThread.id,
        }),
      ),
      /未绑定/,
    );
});
test("trusted HTTP source read is exact, encoded, carries the initiating principal and uses no Context operator endpoint", async () => {
  const reads: Array<{ path: string; principal?: string }> = [];
  const reader = runtimeHttpInputEvidenceReader(async (path, principal) => {
    reads.push({ path, principal });
    return { event: inputEvent };
  });
  await reader.readThreadInputSource(
    "session/one",
    "thread?one",
    "runtime-alice",
  );
  await reader.readThread("session/one", "thread?one", "context/one");
  await reader.readSessionEvent("session/one", "event?one");
  await reader.readSessionSchedule!("session/one", "schedule?one");
  assert.deepEqual(
    reads.map((r) => r.path),
    [
      "/api/sessions/session%2Fone/threads/thread%3Fone/input-source",
      "/api/contexts/context%2Fone/threads/thread%3Fone",
      "/api/sessions/session%2Fone/events/event%3Fone",
      "/api/sessions/session%2Fone/schedules/schedule%3Fone",
    ],
  );
  assert.equal(reads[0]!.principal, "runtime-alice");
});
test("scheduled execution requires the exact Runtime Schedule proof and committed Platform admission", async () => {
  const key = "a".repeat(40),
    scheduleId = "task_" + key;
  const source = {
    kind: "schedule",
    schedule_id: scheduleId,
    source_turn_id: "client-schedule-" + scheduleId,
    root_thread_id: "scheduled-root-thread",
  };
  const admission = taskRunAdmissionSchema.parse({
    eventId: "task_run_" + key,
    tenantId: "tenant-one",
    taskId: "task-one",
    projectId: "project-one",
    runNumber: 1,
    taskRevision: 2,
    principalId: "human-one",
    humanActantId: "actant-one",
    sourceInputId: null,
    sessionId: route.session_id,
    request: {
      id: scheduleId,
      intent: "执行事项",
      model_alias: null,
      reasoning_effort: null,
      not_before: "2026-09-26T00:00:00.000Z",
      interval_seconds: null,
      dependency_thread_ids: [],
    },
    sourceSignature: "[]",
    watchSourceIds: [],
  });
  const lookup = async (sessionId: string, id: string) => {
    assert.equal(sessionId, route.session_id);
    assert.equal(id, scheduleId);
    return admission;
  };
  const resolved = await resolveRuntimeTaskRunEvidence(
    route,
    evidence(source),
    lookup,
  );
  assert.equal(resolved.admission, admission);
  assert.equal(resolved.rootThreadId, source.root_thread_id);
  await assert.rejects(
    resolveRuntimeInputEvidence(route, evidence(source)),
    /未绑定/,
  );
  await assert.rejects(
    resolveRuntimeTaskRunEvidence(route, evidence(), lookup),
    /未绑定/,
  );
  for (const wrong of [
    { ...admission, sessionId: "foreign" },
    { ...admission, eventId: "foreign" },
    { ...admission, request: { ...admission.request, id: "foreign" } },
  ])
    await assert.rejects(
      resolveRuntimeTaskRunEvidence(route, evidence(source), async () => wrong),
      /未绑定/,
    );
  await assert.rejects(
    resolveRuntimeTaskRunEvidence(
      route,
      evidence({ ...source, source_turn_id: "foreign" }),
      lookup,
    ),
    /未绑定/,
  );
});
test("Runtime read failure is not evidence of missing Human authorization and cannot fall back", async () => {
  const failure = new Error("controlled unavailable transport");
  await assert.rejects(
    resolveRuntimeInputEvidence(route, {
      ...evidence(),
      async readThreadInputSource() {
        throw failure;
      },
    }),
    (e) => e === failure,
  );
});
