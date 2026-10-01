import { z } from "zod";
import type { HostInvocation } from "./agent-tools.js";
import { workInputFormats } from "./session-io.js";
import type { TaskRunAdmission } from "../../platform/src/task-run-admission.js";
import {
  matchesTaskSourceRequest,
  type TaskSourceEvent,
  type TaskSourceReceipt,
} from "../../platform/src/task-run-source.js";
export type TaskSourceEvidenceReader = (
  sessionId: string,
  clientMessageId: string,
) => Promise<{ event: TaskSourceEvent; receipt: TaskSourceReceipt | null }>;

const eventSchema = z.object({
  id: z.string().min(1),
  actor: z.string(),
  type: z.string(),
  topic: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
const threadSchema = z.object({
  snapshot: z.object({
    thread: z.object({
      id: z.string(),
      session_id: z.string(),
      context_id: z.string(),
      root_turn_id: z.string(),
      initiating_principal_id: z.string().nullable(),
      agent_id: z.string(),
      executor_kind: z.string(),
      executor_id: z.string().nullable(),
    }),
  }),
});
const acceptedSchema = z.object({
  request: z.object({
    io_version: z.literal("1"),
    client_message_id: z.string().min(1),
    message: z.object({
      format: z.object({ id: z.string(), version: z.string() }),
      content: z.object({
        encoding: z.literal("json"),
        value: z.object({
          type: z.literal("object"),
          value: z.object({
            input_id: z.object({
              type: z.literal("string"),
              value: z.string().min(1),
            }),
            workspace_id: z.object({
              type: z.literal("string"),
              value: z.string().min(1),
            }),
            author_actant_id: z.object({
              type: z.literal("string"),
              value: z.string().min(1),
            }),
          }),
        }),
      }),
    }),
  }),
});
const scheduleSchema = z.object({
  id: z.string().min(1),
  thread_id: z.string().min(1),
  source_turn_id: z.string().min(1),
});

/** A trusted Runtime client must authorize both reads. Event lookup is exact
 * by (session ID, event ID), never a bounded scan of recent history.
 */
export type RuntimeInputEvidenceReader = {
  readThread(sessionId: string, threadId: string): Promise<unknown>;
  readSessionEvent(sessionId: string, eventId: string): Promise<unknown>;
  readSessionSchedule?(sessionId: string, scheduleId: string): Promise<unknown>;
};

/** Adapt an authenticated Runtime request function; it must not accept a
 * browser-supplied bearer token or a model-selected Runtime origin.
 */
export function runtimeHttpInputEvidenceReader(
  request: (path: string) => Promise<unknown>,
): RuntimeInputEvidenceReader {
  return {
    readThread: (sessionId, threadId) =>
      request(
        `/api/sessions/${encodeURIComponent(sessionId)}/threads/${encodeURIComponent(threadId)}`,
      ),
    async readSessionEvent(sessionId, eventId) {
      const result = z
        .object({ event: z.unknown() })
        .parse(
          await request(
            `/api/sessions/${encodeURIComponent(sessionId)}/events/${encodeURIComponent(eventId)}`,
          ),
        );
      return result.event;
    },
    readSessionSchedule: (sessionId, scheduleId) =>
      request(
        `/api/sessions/${encodeURIComponent(sessionId)}/schedules/${encodeURIComponent(scheduleId)}`,
      ),
  };
}

function field(event: z.infer<typeof eventSchema>, name: string) {
  const route = event.payload.route as Record<string, unknown> | undefined;
  const value = event.payload[name] ?? route?.[name];
  return typeof value === "string" ? value : null;
}

function invalid(): never {
  throw new Error("Runtime 执行未绑定到可验证的原始应用输入。");
}

/** Establish provenance, not authorization. The returned workspace and
 * claimed actant came from Human-submitted input and must still be checked
 * against current Platform membership and the trusted identity mapping.
 */
async function resolveRuntimeRoot(
  route: HostInvocation,
  reader: RuntimeInputEvidenceReader,
) {
  if (!route.principal_id) invalid();
  const seen = new Set<string>();
  let threadId = route.thread_id;
  let rootId: string | null = null;
  let rootThreadId: string | null = null;
  for (let depth = 0; depth < 32; depth++) {
    if (seen.has(threadId)) invalid();
    seen.add(threadId);
    const parsed = threadSchema.safeParse(
      await reader.readThread(route.session_id, threadId),
    );
    if (!parsed.success) invalid();
    const thread = parsed.data.snapshot.thread;
    if (
      thread.id !== threadId ||
      thread.session_id !== route.session_id ||
      thread.context_id !== route.context_id ||
      thread.initiating_principal_id !== route.principal_id ||
      thread.agent_id !== route.agent_id ||
      !thread.root_turn_id
    )
      invalid();
    if (thread.executor_kind !== "plan_infer") {
      rootId = thread.root_turn_id;
      rootThreadId = thread.id;
      break;
    }
    const inferResult = eventSchema.safeParse(
      await reader.readSessionEvent(route.session_id, thread.root_turn_id),
    );
    if (!inferResult.success) invalid();
    const infer = inferResult.data;
    if (
      infer.id !== thread.root_turn_id ||
      infer.actor !== "Runtime-Yao" ||
      infer.type !== "infer_request" ||
      infer.topic !== "chat/infer_request" ||
      !thread.executor_id ||
      field(infer, "plan_execution_id") !== thread.executor_id ||
      field(infer, "root_turn_id") !== thread.root_turn_id ||
      field(infer, "session_id") !== route.session_id ||
      field(infer, "context_id") !== route.context_id ||
      field(infer, "principal_id") !== route.principal_id ||
      field(infer, "agent_id") !== route.agent_id
    )
      invalid();
    const parent = field(infer, "parent_thread_id");
    if (!parent) invalid();
    threadId = parent;
  }
  if (!rootId || !rootThreadId) invalid();
  return {
    rootId: rootId!,
    rootThreadId: rootThreadId!,
    runtimePrincipalId: route.principal_id!,
  };
}

async function inputEvidenceFromRoot(
  route: HostInvocation,
  reader: RuntimeInputEvidenceReader,
  rootId: string,
  runtimePrincipalId: string,
) {
  const rootResult = eventSchema.safeParse(
    await reader.readSessionEvent(route.session_id, rootId),
  );
  if (!rootResult.success) invalid();
  const root = rootResult.data;
  if (
    root.id !== rootId ||
    root.actor !== "Session-Client" ||
    root.type !== "session_message" ||
    root.topic !== "chat/user_message" ||
    field(root, "session_id") !== route.session_id ||
    field(root, "context_id") !== route.context_id ||
    field(root, "principal_id") !== route.principal_id
  )
    invalid();
  const accepted = acceptedSchema.safeParse(root.payload.session_io);
  if (!accepted.success) invalid();
  const { request } = accepted.data;
  const { format, content } = request.message;
  const supplied = content.value.value;
  if (
    !workInputFormats.some(
      (known) => known.id === format.id && known.version === format.version,
    ) ||
    field(root, "client_message_id") !== request.client_message_id ||
    supplied.input_id.value !== request.client_message_id
  )
    invalid();
  return {
    runtimePrincipalId,
    runtimeEventId: rootId,
    inputId: request.client_message_id,
    projectId: supplied.workspace_id.value,
    claimedActantId: supplied.author_actant_id.value,
    sessionId: route.session_id,
    contextId: route.context_id,
  };
}

export async function resolveRuntimeInputEvidence(
  route: HostInvocation,
  reader: RuntimeInputEvidenceReader,
) {
  const { rootId, runtimePrincipalId } = await resolveRuntimeRoot(
    route,
    reader,
  );
  return inputEvidenceFromRoot(route, reader, rootId, runtimePrincipalId);
}

/** A scheduled execution has no Session-Client input event. Its provenance is
 * the exact Runtime Schedule/Thread pair plus the Platform admission committed
 * before the Schedule POST. Neither the model nor the selected UI project may
 * supply this mapping. This proves origin only; current authorization remains
 * a separate check before an Agent credential is issued. */
async function taskRunEvidenceFromRoot(
  route: HostInvocation,
  reader: RuntimeInputEvidenceReader,
  admissionForRuntime: (
    sessionId: string,
    scheduleId: string,
  ) => Promise<TaskRunAdmission>,
  rootId: string,
  rootThreadId: string,
  runtimePrincipalId: string,
) {
  if (!/^client-schedule-task_[a-f0-9]{40}$/.test(rootId)) invalid();
  const scheduleId = rootId.slice("client-schedule-".length);
  if (!reader.readSessionSchedule) invalid();
  const schedule = scheduleSchema.safeParse(
    await reader.readSessionSchedule(route.session_id, scheduleId),
  );
  if (
    !schedule.success ||
    schedule.data.id !== scheduleId ||
    schedule.data.thread_id !== rootThreadId ||
    schedule.data.source_turn_id !== rootId
  )
    invalid();
  const admission = await admissionForRuntime(route.session_id, scheduleId);
  if (
    admission.sessionId !== route.session_id ||
    admission.request.id !== scheduleId ||
    admission.eventId !== `task_run_${scheduleId.slice(5)}`
  )
    invalid();
  return {
    runtimePrincipalId,
    sessionId: route.session_id,
    contextId: route.context_id,
    rootThreadId,
    scheduleId,
    admission,
  };
}

export async function resolveRuntimeTaskRunEvidence(
  route: HostInvocation,
  reader: RuntimeInputEvidenceReader,
  admissionForRuntime: (
    sessionId: string,
    scheduleId: string,
  ) => Promise<TaskRunAdmission>,
) {
  const { rootId, rootThreadId, runtimePrincipalId } = await resolveRuntimeRoot(
    route,
    reader,
  );
  return taskRunEvidenceFromRoot(
    route,
    reader,
    admissionForRuntime,
    rootId,
    rootThreadId,
    runtimePrincipalId,
  );
}

/** Classify one verified Runtime root before reading its provenance. A failed
 * normal input cannot silently fall back to a task admission, or vice versa. */
export async function resolveRuntimeInvocationEvidence(
  route: HostInvocation,
  reader: RuntimeInputEvidenceReader,
  admissionForRuntime?: (
    sessionId: string,
    scheduleId: string,
  ) => Promise<TaskRunAdmission>,
  sourceEventForRuntime?: TaskSourceEvidenceReader,
) {
  const root = await resolveRuntimeRoot(route, reader);
  if (root.rootId.startsWith("client-schedule-")) {
    if (!admissionForRuntime) invalid();
    return {
      kind: "task-run" as const,
      ...(await taskRunEvidenceFromRoot(
        route,
        reader,
        admissionForRuntime,
        root.rootId,
        root.rootThreadId,
        root.runtimePrincipalId,
      )),
    };
  }
  const observed = eventSchema.parse(
    await reader.readSessionEvent(route.session_id, root.rootId),
  );
  const clientId = field(observed, "client_message_id");
  if (clientId?.startsWith("task_source_")) {
    if (
      !sourceEventForRuntime ||
      observed.id !== root.rootId ||
      observed.actor !== "Session-Client" ||
      observed.type !== "session_message" ||
      observed.topic !== "chat/user_message" ||
      field(observed, "session_id") !== route.session_id ||
      field(observed, "context_id") !== route.context_id ||
      field(observed, "principal_id") !== route.principal_id ||
      field(observed, "root_turn_id") !== observed.id
    )
      invalid();
    const source = await sourceEventForRuntime(route.session_id, clientId);
    const accepted = z
      .object({ request: z.unknown() })
      .safeParse(observed.payload.session_io);
    if (
      !accepted.success ||
      source.event.eventId !== clientId ||
      source.event.admission.sessionId !== route.session_id ||
      source.event.destination.kind !== "follow-up" ||
      source.event.destination.principalId !== route.principal_id ||
      !matchesTaskSourceRequest(source.event, accepted.data.request) ||
      (source.receipt &&
        (source.receipt.rootId !== observed.id ||
          (source.receipt.threadId !== null &&
            source.receipt.threadId !== root.rootThreadId)))
    )
      invalid();
    return {
      kind: "task-run" as const,
      runtimePrincipalId: root.runtimePrincipalId,
      sessionId: route.session_id,
      contextId: route.context_id,
      rootThreadId: root.rootThreadId,
      scheduleId: source.event.admission.request.id,
      admission: source.event.admission,
    };
  }
  return {
    kind: "input" as const,
    ...(await inputEvidenceFromRoot(
      route,
      reader,
      root.rootId,
      root.runtimePrincipalId,
    )),
  };
}
