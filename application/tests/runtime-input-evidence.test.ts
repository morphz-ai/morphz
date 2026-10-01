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
                author_actant_id: { type: "string", value: "claimed-human-actant" },
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

function evidence(
  threads: Record<string, unknown> = { "thread-1": parentThread },
  events: Record<string, unknown> = { "event-1": inputEvent },
): RuntimeInputEvidenceReader {
  return {
    async readThread(_sessionId, threadId) {
      return { snapshot: { thread: threads[threadId] } };
    },
    async readSessionEvent(_sessionId, eventId) {
      return events[eventId] ?? null;
    },
  };
}

test("Runtime 原始输入可独立于旧 workspace JSON 绑定实际执行 Thread", async () => {
  assert.deepEqual(await resolveRuntimeInputEvidence(route, evidence()), {
    runtimePrincipalId: "runtime-human-1",
    runtimeEventId: "event-1",
    inputId: "input-1",
    projectId: "project-1",
    claimedActantId: "claimed-human-actant",
    sessionId: "session-1",
    contextId: "context-1",
  });
});

test("只接受 Runtime 签发的类型化输入，不把旧扁平 JSON 当成来源证明", async () => {
  const flat = {
    ...inputEvent,
    payload: {
      ...inputEvent.payload,
      session_io: {
        request: {
          ...inputEvent.payload.session_io.request,
          message: {
            ...inputEvent.payload.session_io.request.message,
            content: {
              encoding: "json",
              value: {
                input_id: "input-1",
                workspace_id: "project-1",
                author_actant_id: "claimed-human-actant",
              },
            },
          },
        },
      },
    },
  };
  await assert.rejects(
    resolveRuntimeInputEvidence(route, evidence(undefined, { "event-1": flat })),
    /未绑定/,
  );
});

test("受信 Runtime 传输按事件 ID 精确读取，不再扫描最近消息页", async () => {
  const paths: string[] = [];
  const reader = runtimeHttpInputEvidenceReader(async (path) => {
    paths.push(path);
    return path.includes("/events/")
      ? { event: inputEvent }
      : { snapshot: { thread: parentThread } };
  });
  await reader.readThread("session/one", "thread?one");
  await reader.readSessionEvent("session/one", "event?one");
  await reader.readSessionSchedule?.("session/one", "schedule?one");
  assert.deepEqual(paths, [
    "/api/sessions/session%2Fone/threads/thread%3Fone",
    "/api/sessions/session%2Fone/events/event%3Fone",
    "/api/sessions/session%2Fone/schedules/schedule%3Fone",
  ]);
});

test("后台事项只凭精确 Runtime Schedule、Thread 与已提交准入回溯来源", async () => {
  const key = "a".repeat(40);
  const scheduleId = `task_${key}`;
  const rootId = `client-schedule-${scheduleId}`;
  const scheduleThread = {
    ...parentThread,
    id: "scheduled-thread",
    root_turn_id: rootId,
    executor_kind: "self",
  };
  const scheduledRoute = { ...route, thread_id: scheduleThread.id };
  const admission = taskRunAdmissionSchema.parse({
    eventId: `task_run_${key}`,
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
  const schedule = {
    id: scheduleId,
    thread_id: scheduleThread.id,
    source_turn_id: rootId,
  };
  let reads = 0;
  const reader: RuntimeInputEvidenceReader = {
    async readThread(sessionId, threadId) {
      assert.equal(sessionId, route.session_id);
      return {
        snapshot: {
          thread: threadId === scheduleThread.id ? scheduleThread : null,
        },
      };
    },
    async readSessionEvent() {
      throw new Error("普通输入事件不应成为后台事项的来源");
    },
    async readSessionSchedule(sessionId, id) {
      assert.equal(sessionId, route.session_id);
      assert.equal(id, scheduleId);
      reads++;
      return schedule;
    },
  };
  const lookup = async (sessionId: string, id: string) => {
    assert.equal(sessionId, route.session_id);
    assert.equal(id, scheduleId);
    return admission;
  };
  const resolved = await resolveRuntimeTaskRunEvidence(
    scheduledRoute,
    reader,
    lookup,
  );
  assert.equal(resolved.admission, admission);
  assert.equal(resolved.rootThreadId, scheduleThread.id);
  assert.equal(reads, 1);
  const child = {
    ...scheduleThread,
    id: "scheduled-infer",
    root_turn_id: "scheduled-infer-event",
    executor_kind: "plan_infer",
    executor_id: "scheduled-plan",
  };
  const infer = {
    id: child.root_turn_id,
    actor: "Runtime-Yao",
    type: "infer_request",
    topic: "chat/infer_request",
    payload: {
      plan_execution_id: child.executor_id,
      root_turn_id: child.root_turn_id,
      parent_thread_id: scheduleThread.id,
      session_id: route.session_id,
      context_id: route.context_id,
      principal_id: route.principal_id,
      agent_id: route.agent_id,
    },
  };
  assert.equal(
    (
      await resolveRuntimeTaskRunEvidence(
        { ...scheduledRoute, thread_id: child.id },
        {
          ...reader,
          readThread: async (_sessionId, threadId) => ({
            snapshot: {
              thread: threadId === child.id ? child : scheduleThread,
            },
          }),
          readSessionEvent: async () => infer,
        },
        lookup,
      )
    ).rootThreadId,
    scheduleThread.id,
  );
  await assert.rejects(
    resolveRuntimeTaskRunEvidence(
      { ...scheduledRoute, thread_id: child.id },
      {
        ...reader,
        readThread: async (_sessionId, threadId) => ({
          snapshot: { thread: threadId === child.id ? child : scheduleThread },
        }),
        readSessionEvent: async () => ({
          ...infer,
          payload: { ...infer.payload, parent_thread_id: child.id },
        }),
      },
      lookup,
    ),
    /未绑定/,
  );
  for (const wrong of [
    { ...schedule, thread_id: "other-thread" },
    { ...schedule, source_turn_id: "other-root" },
    { ...schedule, id: "other-schedule" },
  ])
    await assert.rejects(
      resolveRuntimeTaskRunEvidence(
        scheduledRoute,
        { ...reader, readSessionSchedule: async () => wrong },
        lookup,
      ),
      /未绑定/,
    );
  await assert.rejects(
    resolveRuntimeTaskRunEvidence(scheduledRoute, reader, async () => ({
      ...admission,
      sessionId: "other-session",
    })),
    /未绑定/,
  );
  await assert.rejects(
    resolveRuntimeTaskRunEvidence(
      { ...scheduledRoute, principal_id: "forged-principal" },
      reader,
      lookup,
    ),
    /未绑定/,
  );
  await assert.rejects(
    resolveRuntimeTaskRunEvidence(
      scheduledRoute,
      evidence({
        [scheduleThread.id]: scheduleThread,
      }),
      lookup,
    ),
    /未绑定/,
  );
});

test("Yao infer 子线程只沿 Runtime 签发的同身份父链继承输入", async () => {
  const child = {
    ...parentThread,
    id: "thread-infer",
    root_turn_id: "infer-event",
    executor_kind: "plan_infer",
    executor_id: "plan-1",
  };
  const inferEvent = {
    id: "infer-event",
    actor: "Runtime-Yao",
    type: "infer_request",
    topic: "chat/infer_request",
    payload: {
      plan_execution_id: "plan-1",
      root_turn_id: "infer-event",
      parent_thread_id: "thread-1",
      session_id: "session-1",
      context_id: "context-1",
      principal_id: "runtime-human-1",
      agent_id: "agent-1",
    },
  };
  const childRoute = { ...route, thread_id: "thread-infer" };
  const reader = evidence(
    { "thread-1": parentThread, "thread-infer": child },
    { "event-1": inputEvent, "infer-event": inferEvent },
  );
  assert.equal(
    (await resolveRuntimeInputEvidence(childRoute, reader)).inputId,
    "input-1",
  );
  await assert.rejects(
    resolveRuntimeInputEvidence(
      childRoute,
      evidence(
        { "thread-1": parentThread, "thread-infer": child },
        {
          "event-1": inputEvent,
          "infer-event": {
            ...inferEvent,
            payload: {
              ...inferEvent.payload,
              parent_thread_id: "thread-infer",
            },
          },
        },
      ),
    ),
    /未绑定/,
  );
});

test("跨身份、跨 Session、伪造输入 ID 与普通聊天都不能获得应用输入来源", async () => {
  const failures = [
    { route: { ...route, principal_id: "other-human" }, reader: evidence() },
    { route: { ...route, session_id: "other-session" }, reader: evidence() },
    {
      route,
      reader: evidence(undefined, {
        "event-1": {
          ...inputEvent,
          payload: { ...inputEvent.payload, client_message_id: "other-input" },
        },
      }),
    },
    {
      route,
      reader: evidence(undefined, {
        "event-1": {
          ...inputEvent,
          payload: {
            ...inputEvent.payload,
            session_io: {
              request: {
                ...inputEvent.payload.session_io.request,
                message: {
                  ...inputEvent.payload.session_io.request.message,
                  format: { id: "morphz.chat", version: "1" },
                },
              },
            },
          },
        },
      }),
    },
  ];
  for (const value of failures)
    await assert.rejects(
      resolveRuntimeInputEvidence(value.route, value.reader),
      /未绑定/,
    );
});
