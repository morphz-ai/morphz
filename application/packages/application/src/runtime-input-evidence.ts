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
const sourceViewSchema = z.object({
  thread: z.object({
    id: z.string().min(1),
    session_id: z.string().min(1),
    context_id: z.string().min(1),
    root_turn_id: z.string().min(1),
    initiating_principal_id: z.string().nullable(),
    agent_id: z.string().min(1),
  }),
  source: z
    .discriminatedUnion("kind", [
      z.object({
        kind: z.literal("input"),
        input_event: eventSchema,
        root_thread_id: z.string().min(1).nullable(),
      }),
      z.object({
        kind: z.literal("schedule"),
        schedule_id: z.string().min(1),
        source_turn_id: z.string().min(1),
        root_thread_id: z.string().min(1),
      }),
    ])
    .nullable(),
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

/** Exact owner-side provenance. Runtime resolves bounded ancestry; Host does
 * not parse Goal IDs, walk a second graph or scan message history. Provenance
 * is not current Platform authorization. Reads use a configured trusted client. */
export type RuntimeInputEvidenceReader = {
  readThreadInputSource(
    sessionId: string,
    threadId: string,
    runtimePrincipalId?: string,
  ): Promise<unknown>;
  readThread(
    sessionId: string,
    threadId: string,
    contextId?: string,
    runtimePrincipalId?: string,
  ): Promise<unknown>;
  readSessionEvent(
    sessionId: string,
    eventId: string,
    runtimePrincipalId?: string,
  ): Promise<unknown>;
  readSessionSchedule?(
    sessionId: string,
    scheduleId: string,
    runtimePrincipalId?: string,
  ): Promise<unknown>;
};
export class RuntimeInputSourceError extends Error {
  readonly code = "source_unverified";
  constructor() {
    super("Runtime 执行未绑定到可验证的原始应用输入。");
  }
}
function invalid(): never {
  throw new RuntimeInputSourceError();
}

export function runtimeHttpInputEvidenceReader(
  request: (path: string, runtimePrincipalId?: string) => Promise<unknown>,
  options: { sessionScoped?: boolean } = {},
): RuntimeInputEvidenceReader {
  return {
    readThreadInputSource: (sessionId, threadId, principal) =>
      request(
        `/api/sessions/${encodeURIComponent(sessionId)}/threads/${encodeURIComponent(threadId)}/input-source`,
        principal,
      ),
    readThread: (sessionId, threadId, contextId, principal) =>
      request(
        contextId && !options.sessionScoped
          ? `/api/contexts/${encodeURIComponent(contextId)}/threads/${encodeURIComponent(threadId)}`
          : `/api/sessions/${encodeURIComponent(sessionId)}/threads/${encodeURIComponent(threadId)}`,
        principal,
      ),
    async readSessionEvent(sessionId, eventId, principal) {
      return z
        .object({ event: z.unknown() })
        .parse(
          await request(
            `/api/sessions/${encodeURIComponent(sessionId)}/events/${encodeURIComponent(eventId)}`,
            principal,
          ),
        ).event;
    },
    readSessionSchedule: (sessionId, scheduleId, principal) =>
      request(
        `/api/sessions/${encodeURIComponent(sessionId)}/schedules/${encodeURIComponent(scheduleId)}`,
        principal,
      ),
  };
}
function field(event: z.infer<typeof eventSchema>, name: string) {
  const route = event.payload.route as Record<string, unknown> | undefined;
  const value = event.payload[name] ?? route?.[name];
  return typeof value === "string" ? value : null;
}
async function invocationSource(
  route: HostInvocation,
  reader: RuntimeInputEvidenceReader,
) {
  if (!route.principal_id) invalid();
  const parsed = sourceViewSchema.safeParse(
    await reader.readThreadInputSource(
      route.session_id,
      route.thread_id,
      route.principal_id,
    ),
  );
  if (!parsed.success) invalid();
  const { thread, source } = parsed.data;
  if (
    !source ||
    thread.id !== route.thread_id ||
    thread.session_id !== route.session_id ||
    thread.context_id !== route.context_id ||
    thread.agent_id !== route.agent_id ||
    thread.initiating_principal_id !== route.principal_id
  )
    invalid();
  if (source.kind === "input") {
    const event = source.input_event;
    if (
      event.actor !== "Session-Client" ||
      event.type !== "session_message" ||
      event.topic !== "chat/user_message" ||
      field(event, "session_id") !== route.session_id ||
      field(event, "context_id") !== route.context_id ||
      field(event, "principal_id") !== route.principal_id
    )
      invalid();
  }
  return { source, runtimePrincipalId: route.principal_id };
}
function inputEvidence(
  route: HostInvocation,
  root: z.infer<typeof eventSchema>,
  runtimePrincipalId: string,
) {
  const accepted = acceptedSchema.safeParse(root.payload.session_io);
  if (!accepted.success) invalid();
  const { request } = accepted.data;
  const supplied = request.message.content.value.value;
  if (
    !workInputFormats.some(
      (known) =>
        known.id === request.message.format.id &&
        known.version === request.message.format.version,
    ) ||
    field(root, "client_message_id") !== request.client_message_id ||
    supplied.input_id.value !== request.client_message_id
  )
    invalid();
  return {
    runtimePrincipalId,
    runtimeEventId: root.id,
    inputId: request.client_message_id,
    projectId: supplied.workspace_id.value,
    claimedActantId: supplied.author_actant_id.value,
    sessionId: route.session_id,
    contextId: route.context_id,
    // Host-private evidence. Explicit read-input exposes the request, never
    // automatically injecting attachment bytes into the model's context.
    inputEvent: root,
  };
}
export async function resolveRuntimeInputEvidence(
  route: HostInvocation,
  reader: RuntimeInputEvidenceReader,
) {
  const { source, runtimePrincipalId } = await invocationSource(route, reader);
  if (source.kind !== "input") invalid();
  return inputEvidence(route, source.input_event, runtimePrincipalId);
}
async function taskRunEvidence(
  route: HostInvocation,
  source: Extract<
    NonNullable<z.infer<typeof sourceViewSchema>["source"]>,
    { kind: "schedule" }
  >,
  admissionForRuntime: (
    sessionId: string,
    scheduleId: string,
  ) => Promise<TaskRunAdmission>,
  runtimePrincipalId: string,
) {
  const admission = await admissionForRuntime(
    route.session_id,
    source.schedule_id,
  );
  if (
    admission.sessionId !== route.session_id ||
    admission.request.id !== source.schedule_id ||
    source.source_turn_id !== `client-schedule-${admission.request.id}` ||
    admission.eventId !== `task_run_${admission.request.id.slice(5)}`
  )
    invalid();
  return {
    runtimePrincipalId,
    sessionId: route.session_id,
    contextId: route.context_id,
    rootThreadId: source.root_thread_id,
    scheduleId: source.schedule_id,
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
  const { source, runtimePrincipalId } = await invocationSource(route, reader);
  if (source.kind !== "schedule") invalid();
  return taskRunEvidence(
    route,
    source,
    admissionForRuntime,
    runtimePrincipalId,
  );
}
/** Classification is explicit in Runtime's proof. Ordinary inputs never fall
 * back to task admission or a Host-local delivery on failure. */
export async function resolveRuntimeInvocationEvidence(
  route: HostInvocation,
  reader: RuntimeInputEvidenceReader,
  admissionForRuntime?: (
    sessionId: string,
    scheduleId: string,
  ) => Promise<TaskRunAdmission>,
  sourceEventForRuntime?: TaskSourceEvidenceReader,
) {
  const { source, runtimePrincipalId } = await invocationSource(route, reader);
  if (source.kind === "schedule") {
    if (!admissionForRuntime) invalid();
    return {
      kind: "task-run" as const,
      ...(await taskRunEvidence(
        route,
        source,
        admissionForRuntime,
        runtimePrincipalId,
      )),
    };
  }
  const observed = source.input_event;
  const clientId = field(observed, "client_message_id");
  if (clientId?.startsWith("task_source_")) {
    if (
      !sourceEventForRuntime ||
      source.root_thread_id === null ||
      field(observed, "root_turn_id") !== observed.id
    )
      invalid();
    const admitted = await sourceEventForRuntime(route.session_id, clientId);
    const accepted = z
      .object({ request: z.unknown() })
      .safeParse(observed.payload.session_io);
    if (
      !accepted.success ||
      admitted.event.eventId !== clientId ||
      admitted.event.admission.sessionId !== route.session_id ||
      admitted.event.destination.kind !== "follow-up" ||
      admitted.event.destination.principalId !== route.principal_id ||
      !matchesTaskSourceRequest(admitted.event, accepted.data.request) ||
      (admitted.receipt &&
        (admitted.receipt.rootId !== observed.id ||
          (admitted.receipt.threadId !== null &&
            admitted.receipt.threadId !== source.root_thread_id)))
    )
      invalid();
    return {
      kind: "task-run" as const,
      runtimePrincipalId,
      sessionId: route.session_id,
      contextId: route.context_id,
      rootThreadId: source.root_thread_id,
      scheduleId: admitted.event.admission.request.id,
      admission: admitted.event.admission,
    };
  }
  return {
    kind: "input" as const,
    ...inputEvidence(route, observed, runtimePrincipalId),
  };
}
