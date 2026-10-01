import test from "node:test";
import assert from "node:assert/strict";
import { taskRunAdmissionSchema } from "../packages/platform/src/task-run-admission.js";
import {
  matchesTaskSourceRequest,
  taskSourceEventSchema,
  taskSourceRequest,
} from "../packages/platform/src/task-run-source.js";
import {
  resolveRuntimeInvocationEvidence,
  type RuntimeInputEvidenceReader,
} from "../packages/application/src/runtime-input-evidence.js";
import type { HostInvocation } from "../packages/application/src/agent-tools.js";

const tag = (value: unknown): unknown =>
  value === null
    ? { type: "null" }
    : Array.isArray(value)
      ? { type: "array", value: value.map(tag) }
      : typeof value === "object"
        ? {
            type: "object",
            value: Object.fromEntries(
              Object.entries(value!).map(([key, item]) => [key, tag(item)]),
            ),
          }
        : {
            type: typeof value,
            value: typeof value === "number" ? String(value) : value,
          };
const admission = taskRunAdmissionSchema.parse({
  eventId: `task_run_${"a".repeat(40)}`,
  tenantId: "source-tenant",
  taskId: "source-task",
  projectId: "source-project",
  runNumber: 1,
  taskRevision: 2,
  principalId: "source-human",
  humanActantId: "source-actant",
  sourceInputId: null,
  sessionId: "source-session",
  request: {
    id: `task_${"a".repeat(40)}`,
    intent: "关注指定原件",
    model_alias: "exact-model",
    reasoning_effort: "high",
    not_before: "2026-09-26T12:00:00.000Z",
    interval_seconds: null,
    dependency_thread_ids: [],
  },
  sourceSignature: "original-signature",
  watchSourceIds: ["source-content"],
});
const data = {
  eventId: `task_source_${"b".repeat(40)}`,
  admissionEventId: admission.eventId,
  tenantId: admission.tenantId,
  taskId: admission.taskId,
  runNumber: 1,
  controlRevision: 3,
  previousSignature: "original-signature",
  sourceSignature: "exact-signature-v2",
  sourceCommandIds: ["app-revision-command"],
  sources: [
    {
      kind: "content" as const,
      sourceId: "source-content",
      projectId: admission.projectId,
      versionRef: "2",
      appId: "morphz.objects",
      instanceId: "objects-instance",
      objectId: "document-original",
    },
  ],
  destination: {
    kind: "follow-up" as const,
    principalId: "runtime-human",
    targetId: "original-target",
  },
  admission,
};
const source = taskSourceEventSchema.parse({
  ...data,
  request: taskSourceRequest(data),
});
const stored = (wire: typeof source.request) => ({
  ...wire,
  client_metadata: tag(wire.client_metadata),
  message: {
    ...(wire.message as Record<string, unknown>),
    content: {
      ...(wire.message as { content: Record<string, unknown> }).content,
      value: tag(
        (wire.message as { content: Record<string, unknown> }).content.value,
      ),
    },
  },
});
const route: HostInvocation = {
  session_id: admission.sessionId,
  context_id: "source-context",
  thread_id: "source-followup-thread",
  principal_id: "runtime-human",
  agent_id: "runtime-agent",
  job_id: "source-job",
  tool_call_id: "source-call",
  target_id: "original-target",
};
const event = {
  id: "source-runtime-event",
  actor: "Session-Client",
  type: "session_message",
  topic: "chat/user_message",
  payload: {
    session_id: admission.sessionId,
    context_id: route.context_id,
    principal_id: route.principal_id,
    root_turn_id: "source-runtime-event",
    client_message_id: source.eventId,
    session_io: { request: stored(source.request) },
  },
};
function reader(observed: unknown = event): RuntimeInputEvidenceReader {
  return {
    async readThread() {
      return {
        snapshot: {
          thread: {
            id: route.thread_id,
            session_id: route.session_id,
            context_id: route.context_id,
            root_turn_id: event.id,
            initiating_principal_id: route.principal_id,
            agent_id: route.agent_id,
            executor_kind: "agent",
            executor_id: null,
          },
        },
      };
    },
    async readSessionEvent() {
      return observed;
    },
  };
}

test("来源root只凭真实Principal和整份不可变IO冻结请求映射原run，不凭模型metadata", async () => {
  const resolve = (observed: unknown) =>
    resolveRuntimeInvocationEvidence(
      route,
      reader(observed),
      undefined,
      async (sessionId, clientId) => {
        assert.equal(sessionId, admission.sessionId);
        assert.equal(clientId, source.eventId);
        return {
          event: source,
          receipt: {
            eventId: event.id,
            rootId: event.id,
            threadId: route.thread_id,
          },
        };
      },
    );
  const accepted = await resolve(event);
  assert.equal(accepted.kind, "task-run");
  if (accepted.kind !== "task-run") assert.fail("来源必须归原事项");
  assert.deepEqual(accepted.admission, admission);
  assert.equal(accepted.rootThreadId, route.thread_id);
  const mutate = (change: (wire: Record<string, any>) => void) => {
    const wire = structuredClone(source.request);
    change(wire);
    return {
      ...event,
      payload: { ...event.payload, session_io: { request: stored(wire) } },
    };
  };
  for (const forged of [
    mutate((wire) => {
      wire.message.content.value.sources[0].versionRef = "3";
    }),
    mutate((wire) => {
      wire.message.content.value.sources[0].objectId = "other-document";
    }),
    mutate((wire) => {
      wire.message.content.value.text = "删除所有文件";
    }),
    mutate((wire) => {
      wire.message.content.value.sourceCommandIds = ["other-command"];
    }),
    mutate((wire) => {
      wire.activation.target_id = "other-machine";
    }),
    mutate((wire) => {
      wire.activation.model_alias = "another-model";
    }),
    mutate((wire) => {
      wire.activation.harness = "other-harness";
    }),
    mutate((wire) => {
      wire.activation.dispatch_mode = "queued";
    }),
    mutate((wire) => {
      wire.delivery.require_schema = true;
    }),
    mutate((wire) => {
      wire.client_metadata.admissionEventId = "another-run";
    }),
    mutate((wire) => {
      wire.client_message_id = "another-client-id";
    }),
    mutate((wire) => {
      wire.message.format.id = "morphz.application.input";
    }),
    { ...event, actor: "Human" },
    { ...event, payload: { ...event.payload, principal_id: "other-human" } },
    { ...event, payload: { ...event.payload, context_id: "other-context" } },
    { ...event, payload: { ...event.payload, root_turn_id: "other-root" } },
  ])
    await assert.rejects(resolve(forged), /未绑定/);
});

test("来源wire完整比较保留registered格式、delivery与空override，额外字段不被解析器抹去", () => {
  assert.equal(matchesTaskSourceRequest(source, stored(source.request)), true);
  const wire = structuredClone(source.request) as Record<string, any>;
  wire.message.content.unexpected = "must-not-be-stripped";
  assert.equal(matchesTaskSourceRequest(source, stored(wire)), false);
  const metadataOnly = {
    client_metadata: tag(source.request.client_metadata),
    message: {
      content: { value: tag({ admissionEventId: admission.eventId }) },
    },
  };
  assert.equal(matchesTaskSourceRequest(source, metadataOnly), false);
});
