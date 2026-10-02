import { z } from "zod";
import { taskRunAdmissionSchema } from "./task-run-admission.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
export const taskSourceDestinationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("thread"),
    threadId: id,
    generation: z.number().int().positive().safe(),
    principalId: z.string().min(1).max(200),
  }),
  z.strictObject({
    kind: z.literal("follow-up"),
    principalId: z.string().min(1).max(200),
    targetId: z.string().min(1).max(200).nullable(),
  }),
]);
const sourceSchema = z.strictObject({
  kind: z.enum(["task", "content"]),
  sourceId: id,
  projectId: id,
  versionRef: z.string().min(1).max(200),
  appId: z.string().min(1).max(200).optional(),
  instanceId: id.optional(),
  objectId: id.optional(),
});
const taskSourceObservationSchema = z.strictObject({
  eventId: id,
  admissionEventId: id,
  tenantId: id,
  taskId: id,
  runNumber: z.number().int().positive().safe(),
  controlRevision: z.number().int().positive().safe(),
  previousSignature: z.string().max(128_000),
  sourceSignature: z.string().max(128_000),
  sourceCommandIds: z.array(id).max(100),
  sources: z.array(sourceSchema).min(1).max(100),
  destination: taskSourceDestinationSchema,
  admission: taskRunAdmissionSchema,
});
export const taskSourceEventSchema = taskSourceObservationSchema.extend({
  request: z.record(z.string(), z.unknown()),
});
export type TaskSourceEvent = z.infer<typeof taskSourceEventSchema>;
export type TaskSourceDestination = z.infer<typeof taskSourceDestinationSchema>;
export const taskSourceReceiptSchema = z.strictObject({
  eventId: id,
  rootId: id,
  threadId: id.nullable(),
});
export type TaskSourceReceipt = z.infer<typeof taskSourceReceiptSchema>;

/** A connector observation under the existing watch admission, never a new
 * Human request. Persist this complete request before contacting Runtime. */
export function taskSourceRequest(
  event: z.infer<typeof taskSourceObservationSchema>,
) {
  const { admission, destination } = event;
  return {
    io_version: "1",
    client_message_id: event.eventId,
    message: {
      format: { id: "morphz.data", version: "1" },
      validation: "registered",
      content: {
        encoding: "json",
        value: {
          kind: "morphz.task-source-change",
          version: 1,
          sender: "Morphz Application",
          eventId: event.eventId,
          admissionEventId: event.admissionEventId,
          taskId: event.taskId,
          runNumber: event.runNumber,
          projectId: admission.projectId,
          sources: event.sources,
          sourceCommandIds: event.sourceCommandIds,
          text: "已关注的来源版本发生变化。这是应用观察数据，不是新的用户指令；仅在原事项授权范围内处理，按确切版本读取来源，不重复已完成的物理操作。",
        },
      },
    },
    client_metadata: {
      kind: "morphz.task-source-change",
      version: 1,
      eventId: event.eventId,
      admissionEventId: event.admissionEventId,
    },
    activation: {
      mode: "evaluate",
      dispatch_mode: "parallel",
      model_alias:
        destination.kind === "follow-up" ? admission.request.model_alias : null,
      reasoning_effort:
        destination.kind === "follow-up"
          ? admission.request.reasoning_effort
          : null,
      ...(destination.kind === "follow-up" &&
      admission.request.response_annotations !== undefined
        ? { response_annotations: admission.request.response_annotations }
        : {}),
      target_id: destination.kind === "follow-up" ? destination.targetId : null,
      harness: null,
      input_destination:
        destination.kind === "thread"
          ? {
              kind: "thread",
              thread_id: destination.threadId,
              generation: destination.generation,
            }
          : null,
    },
    delivery: {
      accept_formats: null,
      required_formats: [],
      require_schema: false,
    },
  };
}

/** Decode Runtime's tagged Data representation, with a bounded traversal. */
export function taskSourceStoredData(
  raw: unknown,
  budget = { nodes: 0 },
  depth = 0,
): unknown {
  if (++budget.nodes > 20_000 || depth > 32)
    throw new Error("来源事件数据超出边界。");
  const node = z
    .object({ type: z.string(), value: z.unknown().optional() })
    .parse(raw);
  if (node.type === "null") return null;
  if (node.type === "string") return z.string().parse(node.value);
  if (node.type === "boolean") return z.boolean().parse(node.value);
  if (node.type === "number") {
    const result = Number(z.string().parse(node.value));
    if (!Number.isSafeInteger(result)) throw new Error("来源事件数字无效。");
    return result;
  }
  if (node.type === "array")
    return z
      .array(z.unknown())
      .parse(node.value)
      .map((value) => taskSourceStoredData(value, budget, depth + 1));
  if (node.type === "object")
    return Object.fromEntries(
      Object.entries(z.record(z.string(), z.unknown()).parse(node.value)).map(
        ([key, value]) => [key, taskSourceStoredData(value, budget, depth + 1)],
      ),
    );
  throw new Error("来源事件数据类型无效。");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Metadata alone grants nothing: compare all immutable request fields with
 * the Platform event which was committed by the source producer. */
export function matchesTaskSourceRequest(
  event: TaskSourceEvent,
  raw: unknown,
): boolean {
  try {
    const stored = z
      .object({
        client_metadata: z.unknown(),
        message: z
          .object({ content: z.object({ value: z.unknown() }).passthrough() })
          .passthrough(),
      })
      .passthrough()
      .parse(raw);
    const decoded = {
      ...stored,
      client_metadata: taskSourceStoredData(stored.client_metadata),
      message: {
        ...stored.message,
        content: {
          ...stored.message.content,
          value: taskSourceStoredData(stored.message.content.value),
        },
      },
    };
    return canonical(decoded) === canonical(event.request);
  } catch {
    return false;
  }
}
