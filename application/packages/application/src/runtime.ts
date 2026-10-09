import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  sessionPermissionModeSchema,
  sessionPermissionsReadSchema,
  sessionPermissionsUpdateSchema,
  sessionPermissionsSnapshotSchema,
  type SessionPermissionsRead,
  type SessionPermissionsSnapshot,
  type SessionPermissionsUpdate,
} from "../../core/src/session-permissions.js";
import { workInputRequest } from "./session-io.js";
import { scriptGenerationSchema } from "../../core/src/script-studio.js";
import { readingInputSchema } from "../../core/src/reader.js";
import {
  cognitiveAppObjectLocatorSchema,
  parseCognitiveAppObjectLocator,
  sameCognitiveAppObjectLocator,
  coherentCognitiveAppInput,
  type CognitiveAppObjectLocator,
} from "../../core/src/cognitive-app-object-locator.js";
import {
  cognitiveAppApplicationTargetSchema,
  parseCognitiveAppApplicationTarget,
  sameCognitiveAppApplicationTarget,
  coherentCognitiveAppApplicationInput,
  type CognitiveAppApplicationTarget,
} from "../../core/src/cognitive-app-application-target.js";
import { textQuotesSchema } from "../../core/src/text-quotes.js";
import { isoTimeAtMicros, isoTimeMicros } from "./iso-time.js";
import {
  directoryGrantSchema,
  localFileReferenceSchema,
} from "../../core/src/local-files.js";
import {
  continuationTarget,
  ContinuationConflict,
  SupplementUnconfirmed,
} from "./continuation.js";
import {
  continuationSchema,
  type InputContinuation,
} from "../../core/src/continuation.js";
import {
  modelOptionSchema,
  reasoningEffortSchema,
  reasoningLevels,
  type ReasoningEffort,
  type ModelCatalog,
} from "../../../packages/core/src/inference.js";
import { publicSummary } from "../../../packages/core/src/understanding.js";
import { RuntimeProfileClient } from "./runtime-profile-client.js";
import { activityAnnotationFields } from "./response-annotations.js";
import { authorizedExecutionThreadTree } from "./execution-thread-tree.js";
import {
  DomainError,
  browserReferenceSchema,
  inputApplicationSchema,
  inputAttachmentSchema,
  discussionId,
  type AccessContext,
  type RecordedInput,
} from "../../../packages/core/src/model.js";
import { localAccess } from "../../../packages/core/src/model.js";
import { ExecutionControls, approvalFingerprint } from "./execution.js";
import {
  approvalSchema,
  jobSchema,
  type ExecutionControl,
  type ExecutionScope,
  type ExecutionSnapshot,
  type ExecutionAttention,
} from "../../../packages/core/src/execution.js";
import {
  type ConversationRuntime,
  deliverySchema,
  activitySchema,
} from "../../../packages/core/src/conversation.js";
import type { WorkspaceStore } from "./store.js";
import type { HostInvocation, ToolScope } from "./agent-tools.js";
import type { IdentityCenter } from "./identity.js";
import type { MessageAttachmentService } from "./message-attachment-service.js";
import { ConversationFeed } from "./conversation-feed.js";
import { RuntimeChangeObserver } from "./runtime-change-observer.js";
import type { ConversationStream } from "../../../packages/core/src/live-conversation.js";
import { inspectRuntimeConnection } from "./runtime-connection.js";
import { RuntimeModelSettings } from "./model-settings.js";
import { harnessReadinessError } from "../../core/src/applications.js";
import {
  runtimeHttpInputEvidenceReader,
  resolveRuntimeInvocationEvidence,
  type RuntimeInputEvidenceReader,
  type TaskSourceEvidenceReader,
} from "./runtime-input-evidence.js";
import { RuntimeTaskRunStatusReader } from "./runtime-task-run-status.js";
import {
  matchesTaskSourceRequest,
  type TaskSourceEvent,
  type TaskSourceDestination,
  type TaskSourceReceipt,
} from "../../platform/src/task-run-source.js";
import {
  taskRunAdmissionSchema,
  taskRunRuntimeReceiptSchema,
  type TaskRunAdmission,
  type TaskRunRuntimeReceipt,
} from "../../platform/src/task-run-admission.js";
import {
  PlatformStorageError,
  type PendingTaskRunStop,
  type PendingTaskRunScheduleControl,
  type TaskRunStopObservation,
  type TaskRunLink,
} from "../../platform/src/store.js";

const configSchema = z
  .object({
    url: z.url(),
    token: z.string().min(1),
    // Host-only control-plane credential. Never emitted in connection state,
    // renderer settings or model tool inputs; Team gateway token stays scoped.
    operatorToken: z
      .string()
      .min(1)
      .max(8192)
      .regex(/^[\x21-\x7e]+$/)
      .optional(),
    namespace: z.string().uuid(),
    identityMode: z.literal("trusted_gateway").optional(),
  })
  .strict();
export type RuntimeConfig = z.infer<typeof configSchema>;
export function runtimeOperatorTokenFromEnvironment() {
  try {
    return configSchema.shape.operatorToken.parse(
      process.env.MORPHZ_APP_RUNTIME_OPERATOR_TOKEN,
    );
  } catch {
    throw new Error("Runtime 管理凭据格式无效，请联系管理员。");
  }
}
export function loadRuntimeConfig(directory: string): RuntimeConfig | null {
  const filename = join(directory, "runtime.json");
  if (!existsSync(filename)) return null;
  let config: RuntimeConfig;
  try {
    config = configSchema.parse(JSON.parse(readFileSync(filename, "utf8")));
  } catch {
    throw new Error("Runtime 配置无效，请由管理员检查私有配置文件。");
  }
  if (
    config.operatorToken ||
    process.env.MORPHZ_APP_RUNTIME_OPERATOR_TOKEN !== undefined
  ) {
    const stat = lstatSync(filename);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (process.platform !== "win32" &&
        (stat.mode & 0o077 || stat.uid !== process.getuid!()))
    )
      throw new Error("Runtime 管理凭据必须放在当前用户私有配置文件中。");
  }
  if (process.env.MORPHZ_APP_RUNTIME_OPERATOR_TOKEN !== undefined)
    config.operatorToken = runtimeOperatorTokenFromEnvironment();
  const url = new URL(config.url);
  // First adapter is explicitly local-only. Never silently send this token to another host.
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("本机 Runtime 地址必须是 loopback HTTP origin。");
  config.url = url.origin;
  return config;
}
const eventSchema = z.object({
  id: z.string(),
  sequence: z.number().int(),
  timestamp: z.string(),
  topic: z.string(),
  actor: z.string().optional(),
  type: z.string().optional(),
  payload: z.record(z.string(), z.unknown()),
});
type RuntimeEvent = z.infer<typeof eventSchema>;
const sessionTimelineItemSchema = z.object({
  entry_id: z.string(),
  visible_at: z.iso.datetime({ offset: true }),
  visible_at_micros: z.number().int().safe(),
  root_turn_id: z.string(),
  attempt_id: z.string().nullable(),
  display_kind: z.enum(["input", "reply", "progress", "error"]),
  final_event: z.boolean(),
  event: eventSchema,
  root_event: eventSchema.nullable(),
});
const sessionTimelinePageSchema = z.object({
  entries: z.array(sessionTimelineItemSchema),
  next_before: z
    .object({
      visible_at_micros: z.number().int().safe(),
      entry_id: z.string(),
    })
    .nullable(),
});
type SessionTimelineItem = z.infer<typeof sessionTimelineItemSchema>;

/** JavaScript Date discards sub-millisecond precision. Preserve the Runtime's
 * exact six-digit ordering key when a UI history cursor comes back. */
function historyTimeMicros(value: string) {
  const micros = isoTimeMicros(value);
  if (micros === null)
    throw new DomainError("invalid", "对话历史游标时间无效。");
  return micros;
}
function historyCursorAtMicros(micros: number, id: string) {
  const createdAt = isoTimeAtMicros(micros);
  if (!createdAt)
    throw new DomainError("invalid", "对话历史游标超出时间范围。");
  return { createdAt, id };
}
/** The Ledger has already materialized each immutable Event from its own
 * row. Validate the shape without asking Zod to retain a second copy of the
 * entire Session history in the live bridge. */
const storedEventHistorySchema = z.custom<RuntimeEvent[]>(
  (value) =>
    Array.isArray(value) &&
    value.every((event) => eventSchema.safeParse(event).success),
);
/** A combined reply without a unique causal input must not be assigned by array order. */
export function attributedDelivery<
  T extends { sessionId: string; rootId: string | null },
>(
  sessionId: string,
  event: RuntimeEvent,
  deliveries: T[],
  events: RuntimeEvent[],
): T | undefined {
  const scoped = deliveries.filter(
    (d) => d.sessionId === sessionId && d.rootId,
  );
  for (const key of ["root_turn_id", "trigger_event_id", "source_turn_id"]) {
    const root = payloadString(event, key);
    const direct = root ? scoped.filter((d) => d.rootId === root) : [];
    if (direct.length) return direct.length === 1 ? direct[0] : undefined;
  }
  const covered = scoped.filter((d) => settles(event, d.rootId!, events));
  return covered.length === 1 ? covered[0] : undefined;
}

/** Resolve a whole Session's Event projection without rescanning every
 * delivery and thread result for each message. This preserves the single-
 * event attribution rule: an ambiguous root or combined reply has no owner.
 */
export function sessionDeliveryAttribution<
  T extends { sessionId: string; rootId: string | null },
>(sessionId: string, deliveries: T[], events: RuntimeEvent[]) {
  const byRoot = new Map<string, T[]>();
  for (const delivery of deliveries) {
    if (delivery.sessionId !== sessionId || !delivery.rootId) continue;
    const owners = byRoot.get(delivery.rootId) ?? [];
    owners.push(delivery);
    byRoot.set(delivery.rootId, owners);
  }
  const byThread = new Map<string, Set<T>>();
  for (const event of events) {
    if (event.topic !== "runtime/thread_result") continue;
    const root = payloadString(event, "root_turn_id");
    const thread = payloadString(event, "thread_id");
    if (!root || !thread) continue;
    const owners = byRoot.get(root);
    if (!owners) continue;
    const covered = byThread.get(thread) ?? new Set<T>();
    for (const owner of owners) covered.add(owner);
    byThread.set(thread, covered);
  }
  return (event: RuntimeEvent): T | undefined => {
    for (const key of ["root_turn_id", "trigger_event_id", "source_turn_id"]) {
      const root = payloadString(event, key);
      const owners = root ? byRoot.get(root) : undefined;
      if (owners?.length) return owners.length === 1 ? owners[0] : undefined;
    }
    if (!terminal.has(event.topic)) return undefined;
    let owner: T | undefined;
    for (const thread of [
      event.payload.covers,
      event.payload.defer_covers,
    ].flatMap((value) => (Array.isArray(value) ? value : []))) {
      const covered =
        typeof thread === "string" ? byThread.get(thread) : undefined;
      if (!covered) continue;
      for (const candidate of covered) {
        if (owner && owner !== candidate) return undefined;
        owner = candidate;
      }
    }
    return owner;
  };
}
const sessionSchema = z.object({
  id: z.string(),
  context_id: z.string(),
});
const permissionSessionSchema = sessionSchema.extend({
  permission_mode: sessionPermissionModeSchema.nullable().optional(),
  sandbox_mode: z
    .enum(["workspace-write", "danger-full-access"])
    .nullable()
    .optional(),
  default_target_id: z.string().nullable().optional(),
});
const permissionStatusSchema = z.object({
  permission_mode: sessionPermissionModeSchema,
  sandbox_mode: z.enum(["workspace-write", "danger-full-access"]),
  reviewer: z.enum(["user", "auto_review", "deny"]),
});
const sessionTargetsSchema = z.object({
  session_id: z.string(),
  effective_target_id: z.string().nullable(),
  ready: z.boolean(),
  reason: z.string(),
  targets: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      workspace_root: z.string().nullable(),
    }),
  ),
});
const permissionPreset = (
  mode: SessionPermissionsSnapshot["permissionMode"],
) => {
  switch (mode) {
    case "request_approval":
      return { sandboxMode: "workspace-write", reviewer: "user" } as const;
    case "auto_review":
      return {
        sandboxMode: "workspace-write",
        reviewer: "auto_review",
      } as const;
    case "full_access":
      return { sandboxMode: "danger-full-access", reviewer: "deny" } as const;
    default:
      return null;
  }
};
const platformInputSourceSchema = z.object({
  projectId: z.string(),
  conversationId: z.string(),
  targetActantId: z.string(),
  author: z.object({ principalId: z.string(), actantId: z.string() }),
  createdAt: z.iso.datetime(),
  // The Runtime request also contains quoted source text. Keep the Human's
  // own words separate so message history never presents the entire prompt
  // as text the Human typed.
  body: z.string().optional(),
  attachments: z.array(inputAttachmentSchema).optional(),
  artifactId: z.string().optional(),
  artifactRevision: z.number().int().positive().optional(),
  cognitiveObject: cognitiveAppObjectLocatorSchema.optional(),
  cognitiveApplication: cognitiveAppApplicationTargetSchema.optional(),
  selection: z.string().optional(),
  reading: readingInputSchema.optional(),
  continuation: continuationSchema.optional(),
  application: inputApplicationSchema.optional(),
  browser: browserReferenceSchema.optional(),
  textQuotes: textQuotesSchema.optional(),
  localFile: localFileReferenceSchema.optional(),
  directories: z.array(directoryGrantSchema).max(8).optional(),
  scriptGeneration: scriptGenerationSchema.optional(),
  sharedDefault: z.boolean(),
  firstInputId: z.string().optional(),
  newConversationTitle: z.string().optional(),
});
type PlatformInputSource = z.infer<typeof platformInputSourceSchema>;
/** Runtime persists JSON leaves as tagged Data so number lexemes survive a
 * JSONB backend. This decoder is only for a bounded, Runtime-accepted root;
 * the decoded client metadata is never an authorization decision by itself. */
function storedDataValue(
  raw: unknown,
  budget: { nodes: number },
  depth = 0,
): unknown {
  if (++budget.nodes > 32_768 || depth > 32)
    throw new Error("Runtime 消息来源超过结构边界。");
  const node = z
    .object({ type: z.string(), value: z.unknown().optional() })
    .parse(raw);
  switch (node.type) {
    case "null":
      return null;
    case "boolean":
      return z.boolean().parse(node.value);
    case "string":
      return z.string().parse(node.value);
    case "number": {
      const lexeme = z.string().parse(node.value);
      const number = Number(lexeme);
      if (!Number.isSafeInteger(number))
        throw new Error("Runtime 消息来源包含不安全的数字。");
      return number;
    }
    case "array":
      return z
        .array(z.unknown())
        .parse(node.value)
        .map((item) => storedDataValue(item, budget, depth + 1));
    case "object":
      return Object.fromEntries(
        Object.entries(z.record(z.string(), z.unknown()).parse(node.value)).map(
          ([key, item]) => [key, storedDataValue(item, budget, depth + 1)],
        ),
      );
    default:
      throw new Error("Runtime 消息来源的数据类型无效。");
  }
}

function platformSourceFromRuntimeRoot(
  event: RuntimeEvent,
  sessionId: string,
  inputId: string,
  // A trusted gateway can map each Human to a Runtime principal. A local
  // single-user Runtime authenticates with its own default principal instead;
  // Platform still rechecks the source against the current reader grant.
  principalId: (id: string) => string | null,
): PlatformInputSource | null {
  if (
    !["chat/user_message", "chat/steering"].includes(event.topic) ||
    payloadString(event, "session_id") !== sessionId ||
    payloadString(event, "client_message_id") !== inputId
  )
    return null;
  const accepted = z
    .object({
      request: z.object({
        client_message_id: z.literal(inputId),
        client_metadata: z.unknown(),
        message: z.object({
          format: z.object({ id: z.string(), version: z.string() }).optional(),
          content: z.object({
            encoding: z.literal("json"),
            value: z.unknown(),
          }),
        }),
      }),
    })
    .safeParse(event.payload.session_io);
  if (!accepted.success) return null;
  try {
    const budget = { nodes: 0 };
    const metadata = z
      .object({
        kind: z.literal("morphz.platform-input"),
        version: z.literal(1),
        source: platformInputSourceSchema,
      })
      .parse(storedDataValue(accepted.data.request.client_metadata, budget));
    const value = storedDataValue(
      accepted.data.request.message.content.value,
      budget,
    );
    const targeted = !!metadata.source.cognitiveApplication;
    const visible = z
      .object({
        input_id: z.literal(inputId),
        workspace_id: z.literal(metadata.source.projectId),
        author_actant_id: z.literal(metadata.source.author.actantId),
        cognitiveObject: targeted
          ? cognitiveAppObjectLocatorSchema.nullable()
          : cognitiveAppObjectLocatorSchema.optional(),
        cognitiveApplication: targeted
          ? cognitiveAppApplicationTargetSchema
          : cognitiveAppApplicationTargetSchema.optional(),
      })
      .parse(value);
    const expectedPrincipal = principalId(metadata.source.author.principalId);
    if (
      !visible ||
      !coherentCognitiveAppInput(metadata.source) ||
      !coherentCognitiveAppApplicationInput(metadata.source) ||
      !sameCognitiveAppApplicationTarget(
        metadata.source.cognitiveApplication,
        visible.cognitiveApplication,
      ) ||
      (targeted &&
        (accepted.data.request.message.format?.id !==
          "morphz.application.input" ||
          accepted.data.request.message.format.version !==
            (metadata.source.cognitiveObject ? "12" : "11"))) ||
      !sameCognitiveAppObjectLocator(
        metadata.source.cognitiveObject,
        visible.cognitiveObject ?? undefined,
      ) ||
      (expectedPrincipal !== null &&
        payloadString(event, "principal_id") !== expectedPrincipal)
    )
      return null;
    return metadata.source;
  } catch {
    return null;
  }
}
type PlatformReadGrant = {
  personalDefault: boolean;
  projectIds: string[];
};
type PlatformInputTarget = Omit<
  PlatformInputSource,
  "sharedDefault" | "createdAt" | "body"
> & { phase: "prepare" | "dispatch" | "receipt" };
const storedSchema = z.object({
  identityMode: z.literal("trusted_gateway").optional(),
  namespace: z.string(),
  endpoint: z.string(),
  connected: z.boolean(),
  directedInput: z.boolean().default(false),
  model: z.string(),
  error: z.string(),
  publications: z
    .record(z.string(), z.object({ id: z.string(), createdAt: z.string() }))
    .default({}),
  activity: activitySchema.optional(),
  threadBindings: z
    .record(z.string(), activitySchema.shape.threads.element)
    .default({}),
  sessions: z.record(
    z.string(),
    z.object({
      id: z.string(),
      projectId: z.string(),
      conversationId: z.string().optional(),
      artifactId: z.string().nullable(),
      cursor: z.number(),
      events: storedEventHistorySchema,
      runtimePrincipalId: z.string().nullable().default(null),
      // Durable first-creation receipt only, never a pending Human policy.
      // Persist before POST; clear only after safe Runtime policy readback.
      permissionInitializationRequired: z.boolean().optional(),
      turnControl: z.boolean().default(false),
      schedules: z.boolean().default(false),
      hasWork: z.boolean().default(false),
      scope: z.enum(["object", "workspace"]).default("object"),
      sharedDefault: z.boolean().default(false),
      platform: z.boolean().default(false),
    }),
  ),
  deliveries: z.array(
    deliverySchema.extend({
      sessionId: z.string(),
      rootId: z.string().nullable(),
      acceptedEventId: z.string().optional(),
      // Missing on older records means the POST boundary cannot be proven.
      // A known false value proves a failed delivery stopped before POST.
      runtimePostAttempted: z.boolean().optional(),
      request: z.record(z.string(), z.unknown()),
      resourceUploads: z
        .array(
          z
            .object({
              stageId: z.string(),
              name: z.string(),
              mediaType: z.string(),
              dataBase64: z.string().optional(),
              assetId: z
                .string()
                .regex(/^[a-f0-9]{64}$/)
                .optional(),
              sha256: z.string(),
              ready: z.boolean(),
            })
            .refine((upload) => !!upload.dataBase64 !== !!upload.assetId),
        )
        .optional(),
      cancelRequested: z.boolean().default(false),
      platformSource: platformInputSourceSchema.optional(),
      platformHeld: z.boolean().default(false),
      /** Compact local projections of this Host's Runtime Events. The Event
       * history itself belongs to Runtime and is fetched on demand. */
      causalThreadIds: z.array(z.string()).default([]),
      lastActivityAt: z.string().optional(),
    }),
  ),
});
type StoredDelivery = z.infer<typeof storedSchema>["deliveries"][number];
const platformPlainRequestSchema = z.object({
  message: z.object({
    content: z.object({ value: z.object({ text: z.string() }).passthrough() }),
  }),
});
function platformInputBody(delivery: StoredDelivery): string {
  return (
    delivery.platformSource?.body ??
    platformPlainRequestSchema.parse(delivery.request).message.content.value
      .text
  );
}
export type PlatformConversationHistory = {
  inputs: Array<{
    id: string;
    projectId: string;
    conversationId: string;
    author: AccessContext;
    targetActantId: string;
    body: string;
    attachments?: RecordedInput["attachments"];
    artifactId?: string;
    artifactRevision?: number;
    cognitiveObject?: CognitiveAppObjectLocator;
    cognitiveApplication?: CognitiveAppApplicationTarget;
    selection?: string;
    reading?: RecordedInput["reading"];
    continuation?: RecordedInput["continuation"];
    application?: RecordedInput["application"];
    browser?: RecordedInput["browser"];
    textQuotes?: RecordedInput["textQuotes"];
    localFile?: RecordedInput["localFile"];
    directories?: RecordedInput["directories"];
    createdAt: string;
  }>;
  runtime: ConversationRuntime;
  nextCursor: { createdAt: string; id: string } | null;
};
type HistoryEntry =
  | {
      kind: "input";
      id: string;
      createdAt: string;
      value: PlatformConversationHistory["inputs"][number];
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      value: ConversationRuntime["messages"][number];
    };

function historyOrder(
  left: { createdAt: string; id: string },
  right: { createdAt: string; id: string },
) {
  return (
    historyTimeMicros(left.createdAt) - historyTimeMicros(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

class UpstreamError extends Error {
  constructor(
    public status: number,
    detail?: string,
  ) {
    super(
      status === 401 || status === 403
        ? "Morphz 登录凭据已失效，请重新连接。"
        : (detail ?? `Morphz 请求失败（HTTP ${status}），可重试发送。`),
    );
  }
}
/** An IO POST explicitly rejected admission; unlike a transport failure this
 * can release its uncertain-send marker after exact Runtime reconciliation. */
export class TaskSourceRejectedError extends Error {
  constructor(cause: unknown) {
    super("Runtime 未接收这次来源投递。", { cause });
  }
}
/** Only a failure at the HTTP transport boundary, never a parsed Runtime
 * protocol error or a Platform authorization failure. */
class RuntimeTransportError extends Error {
  constructor(cause: unknown) {
    super("无法连接 Morphz Runtime，请检查连接后重试。", { cause });
  }
}
const terminal = new Set([
  "session/io_state",
  "chat/reply",
  "chat/outbound_message",
  "chat/no_reply",
  "chat/cancelled",
  "chat/runtime_error",
  "runtime/response_protocol_fused",
]);
function payloadString(event: RuntimeEvent, key: string): string | undefined {
  const route = event.payload.route as Record<string, unknown> | undefined;
  const value = event.payload[key] ?? route?.[key];
  return typeof value === "string" ? value : undefined;
}
export function settles(
  event: RuntimeEvent,
  root: string,
  events: RuntimeEvent[],
): boolean {
  if (!terminal.has(event.topic)) return false;
  if (
    ["root_turn_id", "trigger_event_id", "source_turn_id"].some(
      (key) => payloadString(event, key) === root,
    )
  )
    return true;
  const covers = [event.payload.covers, event.payload.defer_covers].flatMap(
    (v) => (Array.isArray(v) ? v : []),
  );
  return events.some(
    (e) =>
      e.topic === "runtime/thread_result" &&
      payloadString(e, "root_turn_id") === root &&
      covers.includes(payloadString(e, "thread_id")),
  );
}

/** Reconcile all running roots with one causal pass. A combined terminal may
 * settle several roots without being attributable to one message input. */
export function terminalResultsByRoot(
  events: RuntimeEvent[],
  runningRoots: ReadonlySet<string>,
): Map<string, RuntimeEvent> {
  const rootsByThread = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.topic !== "runtime/thread_result") continue;
    const root = payloadString(event, "root_turn_id");
    const thread = payloadString(event, "thread_id");
    if (!root || !thread || !runningRoots.has(root)) continue;
    const roots = rootsByThread.get(thread) ?? new Set<string>();
    roots.add(root);
    rootsByThread.set(thread, roots);
  }
  const first = new Map<string, RuntimeEvent>();
  for (const event of events) {
    if (!terminal.has(event.topic)) continue;
    const roots = new Set<string>();
    for (const key of ["root_turn_id", "trigger_event_id", "source_turn_id"]) {
      const root = payloadString(event, key);
      if (root && runningRoots.has(root)) roots.add(root);
    }
    for (const thread of [
      event.payload.covers,
      event.payload.defer_covers,
    ].flatMap((value) => (Array.isArray(value) ? value : []))) {
      if (typeof thread !== "string") continue;
      for (const root of rootsByThread.get(thread) ?? []) roots.add(root);
    }
    for (const root of roots) if (!first.has(root)) first.set(root, event);
  }
  return first;
}
function causalThreadEvents(deliveries: StoredDelivery[]): RuntimeEvent[] {
  return deliveries.flatMap((delivery) =>
    delivery.rootId
      ? delivery.causalThreadIds.map((threadId) => ({
          id: `causal:${delivery.inputId}:${threadId}`,
          sequence: 0,
          timestamp: "1970-01-01T00:00:00.000Z",
          topic: "runtime/thread_result",
          payload: { root_turn_id: delivery.rootId, thread_id: threadId },
        }))
      : [],
  );
}
export class RuntimeBridge {
  private permissionOperations = new Map<string, Promise<unknown>>();
  private async serialSessionPolicy<T>(
    id: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.permissionOperations.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.permissionOperations.set(id, current);
    try {
      return await current;
    } finally {
      if (this.permissionOperations.get(id) === current)
        this.permissionOperations.delete(id);
    }
  }

  private async permissionScope(
    scope: SessionPermissionsRead,
    access: AccessContext,
  ) {
    if (!this.authorizePlatformRead)
      throw new DomainError("forbidden", "当前对话授权不可用。");
    const grant = await this.authorizePlatformRead(scope, access);
    return {
      id: this.objectSessionId(
        scope.projectId,
        scope.conversationId,
        grant.personalDefault,
      ),
      shared: grant.personalDefault,
    };
  }
  async readSessionPermissions(
    raw: SessionPermissionsRead,
    access: AccessContext,
    active: () => void = () => {},
  ) {
    const scope = sessionPermissionsReadSchema.parse(raw);
    active();
    const route = await this.permissionScope(scope, access);
    return this.serialSessionPolicy(route.id, async () => {
      active();
      const value = await this.readSessionPolicy(scope, access, route);
      active();
      return value;
    });
  }
  private async readSessionPolicy(
    scope: SessionPermissionsRead,
    access: AccessContext,
    route: { id: string; shared: boolean },
  ): Promise<SessionPermissionsSnapshot> {
    const verify = async () => {
      const current = await this.permissionScope(scope, access);
      if (current.id !== route.id || current.shared !== route.shared)
        throw new DomainError(
          "forbidden",
          "当前对话权限范围已变化，请重新读取。",
        );
    };
    await verify();
    const resultScope = {
      ...scope,
      kind: route.shared ? ("global" as const) : ("conversation" as const),
    };
    const safeDefault = (): SessionPermissionsSnapshot => ({
      scope: resultScope,
      runtimeSessionId: null,
      permissionMode: "request_approval",
      sandboxMode: "workspace-write",
      reviewer: "user",
      source: "safe_default",
      canUpdate: false,
      readOnlyReason: "not_started",
      fingerprint: null,
      workspace: {
        targetId: null,
        targetName: null,
        workspaceRoot: null,
        ready: false,
        reason: "not_started",
      },
    });
    let session: z.infer<typeof permissionSessionSchema>;
    try {
      session = permissionSessionSchema.parse(
        await this.request(
          `/api/sessions/${route.id}`,
          "GET",
          undefined,
          access,
        ),
      );
    } catch (error) {
      if (!(error instanceof UpstreamError) || error.status !== 404)
        throw error;
      await verify();
      return safeDefault();
    }
    if (
      session.id !== route.id ||
      session.context_id !==
        this.contextId(route.shared ? scope.conversationId : scope.projectId)
    )
      throw new DomainError(
        "forbidden",
        "Runtime 会话绑定不匹配，无法读取审批方式。",
      );
    const knownPrincipal = this.state.sessions[route.id]?.runtimePrincipalId;
    if (knownPrincipal) {
      const principal = z
        .object({
          principal_id: z.literal(knownPrincipal),
          session_id: z.literal(route.id),
          context_id: z.literal(session.context_id),
        })
        .safeParse(
          await this.request(
            `/api/sessions/${route.id}/principal`,
            "GET",
            undefined,
            access,
          ),
        );
      if (!principal.success)
        throw new DomainError(
          "forbidden",
          "Runtime 会话身份发生变化，不能读取或修改审批方式。",
        );
    }
    if (this.state.sessions[route.id]?.permissionInitializationRequired) {
      await verify();
      return safeDefault();
    }
    let mode = session.permission_mode ?? null;
    let sandbox = session.sandbox_mode ?? null;
    let reviewer: SessionPermissionsSnapshot["reviewer"] = null;
    const preset = permissionPreset(mode);
    if (preset) {
      sandbox = preset.sandboxMode;
      reviewer = preset.reviewer;
    } else if (
      !this.teamIdentity &&
      access.principalId === localAccess.principalId &&
      access.actantId === localAccess.actantId
    ) {
      // The personal operator may read the Runtime default. Team readers must
      // never borrow that token's global configuration or invent an inherited preset.
      const defaults = permissionStatusSchema.parse(
        await this.request("/api/status", "GET", undefined, access),
      );
      mode = defaults.permission_mode;
      sandbox = defaults.sandbox_mode;
      reviewer = defaults.reviewer;
      // Mirror PermissionBroker.profile_with_overrides: explicit custom uses
      // the base profile (ignoring sandbox); only a differing sandbox-only
      // override changes the inherited preset into a custom profile.
      if (
        session.permission_mode == null &&
        session.sandbox_mode != null &&
        session.sandbox_mode !== defaults.sandbox_mode
      ) {
        mode = "custom";
        sandbox = session.sandbox_mode;
      }
    } else {
      mode = null;
      sandbox = null;
    }
    const targets = sessionTargetsSchema.parse(
      await this.request(
        `/api/sessions/${route.id}/execution-targets`,
        "GET",
        undefined,
        access,
      ),
    );
    if (targets.session_id !== route.id)
      throw new DomainError("forbidden", "执行节点的会话范围不匹配。");
    const target = targets.targets.find(
      (item) => item.id === targets.effective_target_id,
    );
    const workspace = {
      targetId: targets.effective_target_id,
      targetName: target?.name ?? null,
      workspaceRoot: target?.workspace_root ?? null,
      ready: targets.ready,
      reason:
        targets.reason === "ready"
          ? target?.workspace_root
            ? null
            : "workspace_root_unavailable"
          : targets.reason,
    };
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          route.id,
          session.context_id,
          session.permission_mode ?? null,
          session.sandbox_mode ?? null,
          mode,
          sandbox,
          reviewer,
          session.default_target_id ?? null,
          workspace.targetId,
          workspace.workspaceRoot,
        ]),
      )
      .digest("hex");
    await verify();
    const canUpdate =
      !this.teamIdentity &&
      access.principalId === localAccess.principalId &&
      access.actantId === localAccess.actantId;
    return sessionPermissionsSnapshotSchema.parse({
      scope: resultScope,
      runtimeSessionId: route.id,
      permissionMode: mode,
      sandboxMode: sandbox,
      reviewer,
      source: "runtime",
      canUpdate,
      readOnlyReason: canUpdate ? null : "team_managed",
      fingerprint,
      workspace,
    });
  }
  async updateSessionPermissions(
    raw: SessionPermissionsUpdate,
    access: AccessContext,
    authorizeWrite: () => Promise<void>,
  ) {
    const request = sessionPermissionsUpdateSchema.parse(raw);
    if (
      this.teamIdentity ||
      access.principalId !== localAccess.principalId ||
      access.actantId !== localAccess.actantId
    )
      throw new DomainError("forbidden", "审批方式只能由本机本人调整。");
    const scope = {
      projectId: request.projectId,
      conversationId: request.conversationId,
    };
    await authorizeWrite();
    const route = await this.permissionScope(scope, access);
    return this.serialSessionPolicy(route.id, async () => {
      await authorizeWrite();
      const before = await this.readSessionPolicy(scope, access, route);
      if (!before.canUpdate || !before.runtimeSessionId)
        throw new DomainError(
          "conflict",
          "首次发送并建立会话后才能调整审批方式。",
        );
      if (before.fingerprint !== request.expectedFingerprint)
        throw new DomainError(
          "conflict",
          "审批方式或执行节点已变化，请重新读取后调整。",
        );
      await authorizeWrite();
      const currentRoute = await this.permissionScope(scope, access);
      if (currentRoute.id !== route.id || currentRoute.shared !== route.shared)
        throw new DomainError(
          "forbidden",
          "当前对话权限范围已变化，未修改审批方式。",
        );
      // Runtime switches the whole preset and clears a legacy sandbox override.
      // This is not Runtime CAS: other Runtime clients can still race the PATCH.
      await this.request(
        `/api/sessions/${route.id}`,
        "PATCH",
        { permission_mode: request.permissionMode },
        access,
      );
      const after = await this.readSessionPolicy(scope, access, route);
      await authorizeWrite();
      if (
        !after.canUpdate ||
        after.permissionMode !== request.permissionMode ||
        after.source !== "runtime"
      )
        throw new DomainError(
          "conflict",
          "审批方式写入结果未确认，请重新读取；未报告成功。",
        );
      return after;
    });
  }
  private loadedHarnesses: { id: string; version: string }[] | null = null;
  private feeds = new Set<ConversationFeed>();
  /** Stream the same Platform-authorized history exposed by
   * platformConversationHistory. A revoked project is removed from the next
   * publication even when other projects share its Runtime Session.
   */
  async observePlatformConversation(
    scope: { projectId: string; conversationId: string },
    access: AccessContext,
    changed: (value: ConversationStream) => void,
    failed: () => void,
    observeChanges?: (wake: () => void) => Promise<() => void>,
  ): Promise<() => void> {
    const authorizeRead = this.authorizePlatformRead;
    if (!authorizeRead)
      throw new DomainError("invalid", "Platform 对话读取尚未接入。");
    let grant = await authorizeRead(scope, access);
    const sessionId = this.objectSessionId(
      scope.projectId,
      scope.conversationId,
      grant.personalDefault,
    );
    // Capture the durable Event head before the baseline. The WebSocket is
    // subscribed before catching up from this cursor, so no accepted frame is
    // lost while the Platform read awaits authorization.
    let initialCursor = 0;
    try {
      const head = z
        .object({ latest_sequence: z.number().int().nullable() })
        .parse(
          await this.request(
            "/api/sessions/" +
              encodeURIComponent(sessionId) +
              "/events?limit=1",
            "GET",
            undefined,
            access,
            undefined,
          ),
        );
      initialCursor = head.latest_sequence ?? 0;
    } catch (error) {
      if (!(error instanceof UpstreamError && error.status === 404))
        throw error;
    }
    const baseline = (await this.platformConversationHistory(scope, access))
      .runtime.messages;
    type RootRoute = { inputId: string; source: PlatformInputSource };
    const roots = new Map<string, Promise<RootRoute | null>>();
    // Baseline and live feed each retain at most 100 messages. Root provenance
    // is a disposable lookup cache, not another growing Session history.
    const cacheRoot = (rootId: string, route: Promise<RootRoute | null>) => {
      roots.delete(rootId);
      roots.set(rootId, route);
      while (roots.size > 200) roots.delete(roots.keys().next().value!);
    };
    const parseRoot = (event: RuntimeEvent): RootRoute | null => {
      const inputId = payloadString(event, "client_message_id");
      if (!inputId) return null;
      const source = platformSourceFromRuntimeRoot(
        event,
        sessionId,
        inputId,
        (id) => (this.teamIdentity ? this.principalId(id) : null),
      );
      return source ? { inputId, source } : null;
    };
    const rootRoute = (rootId: string): Promise<RootRoute | null> => {
      const cached = roots.get(rootId);
      if (cached) {
        cacheRoot(rootId, cached);
        return cached;
      }
      const lookup = this.request(
        "/api/sessions/" +
          encodeURIComponent(sessionId) +
          "/events/" +
          encodeURIComponent(rootId),
        "GET",
        undefined,
        access,
        undefined,
      )
        .then((raw) => {
          const event = z.object({ event: eventSchema }).parse(raw).event;
          return event.id === rootId ? parseRoot(event) : null;
        })
        .catch((error: unknown) => {
          if (error instanceof UpstreamError && error.status === 404)
            return null;
          throw error;
        })
        .then((route) => {
          // A delayed miss must not erase a newer root Event from the feed.
          if (!route && roots.get(rootId) === lookup) roots.delete(rootId);
          return route;
        });
      cacheRoot(rootId, lookup);
      return lookup;
    };
    const publicationTimes = new Map<string, string>();
    for (const message of baseline)
      if (message.publicationKey)
        publicationTimes.set(message.publicationKey, message.createdAt);
    let pendingAuthorization = Promise.resolve();
    const authorize = () => {
      pendingAuthorization = pendingAuthorization.then(async () => {
        grant = await authorizeRead(scope, access);
      });
      return pendingAuthorization;
    };
    let closed = false;
    let disposeChanges: (() => void) | undefined;
    let feed: ConversationFeed | undefined;
    let pendingPublication = Promise.resolve();
    const publish = (value: ConversationStream) => {
      pendingPublication = pendingPublication
        .then(async () => {
          await authorize();
          if (closed) return;
          const candidates = await Promise.all(
            [...baseline, ...value.messages].map(async (raw) => {
              if (!raw.rootId) return null;
              const route = await rootRoute(raw.rootId);
              return route ? { raw, route } : null;
            }),
          );
          await authorize();
          if (closed) return;
          const visible = candidates.flatMap((candidate) => {
            if (!candidate) return [];
            const { raw, route } = candidate;
            const source = route.source;
            if (
              source.sharedDefault !== grant.personalDefault ||
              !this.platformSourceReadable(source, scope, access, grant)
            )
              return [];
            const publicationKey = raw.publicationKey;
            if (
              publicationKey &&
              raw.id.startsWith("stream:") &&
              (!publicationTimes.has(publicationKey) ||
                historyTimeMicros(raw.createdAt) <
                  historyTimeMicros(publicationTimes.get(publicationKey)!))
            )
              publicationTimes.set(publicationKey, raw.createdAt);
            const finalPublication =
              publicationKey &&
              !raw.id.startsWith("stream:") &&
              !raw.id.startsWith("tool:") &&
              raw.kind !== "progress";
            return [
              {
                ...raw,
                id: finalPublication
                  ? "publication:" + publicationKey
                  : raw.id.startsWith("stream:") && publicationKey
                    ? "stream:" + publicationKey
                    : raw.id,
                createdAt:
                  publicationKey && publicationTimes.has(publicationKey)
                    ? publicationTimes.get(publicationKey)!
                    : raw.createdAt,
                projectId: source.projectId,
                conversationId: source.conversationId,
                artifactId: null,
                inputId: route.inputId,
                rootId: raw.rootId!,
              },
            ];
          });
          const finals = new Set(
            visible
              .filter(
                (message) =>
                  message.publicationKey &&
                  message.id === "publication:" + message.publicationKey,
              )
              .map((message) => message.publicationKey),
          );
          const deduplicated = new Map(
            visible
              .filter(
                (message) =>
                  !message.id.startsWith("stream:") ||
                  !message.publicationKey ||
                  !finals.has(message.publicationKey),
              )
              .map((message) => [message.id, message] as const),
          );
          changed({
            connected: value.connected,
            messages: [...deduplicated.values()].sort(historyOrder),
          });
        })
        .catch(() => feed?.close());
    };
    feed = new ConversationFeed({
      authorize,
      failed: () => {
        if (closed) return;
        closed = true;
        disposeChanges?.();
        if (feed) this.feeds.delete(feed);
        failed();
      },
      changed: publish,
      url: this.config.url,
      initialCursor: () => initialCursor,
      messageLimit: 100,
      sessions: () => [sessionId],
      headers: () => ({
        Authorization: "Bearer " + this.config.token,
        ...(this.teamIdentity
          ? { "X-Morphz-Principal": this.principalId(access.principalId) }
          : {}),
      }),
      request: (path) =>
        this.request(path, "GET", undefined, access, undefined),
      onEvent: (id, raw) => {
        if (
          id !== sessionId ||
          !["chat/user_message", "chat/steering"].includes(raw.topic)
        )
          return;
        const event = { ...raw, sequence: raw.sequence ?? 0 };
        const route = parseRoot(event);
        cacheRoot(event.id, Promise.resolve(route));
      },
      route: (_id, event) => ({
        projectId: scope.projectId,
        conversationId: scope.conversationId,
        artifactId: null,
        inputId: null,
        rootId:
          ["root_turn_id", "trigger_event_id", "source_turn_id"]
            .map((key) => event.payload[key])
            .find((value): value is string => typeof value === "string") ??
          null,
      }),
    });
    this.feeds.add(feed);
    try {
      disposeChanges = await observeChanges?.(() => void feed?.sync());
      if (closed) disposeChanges?.();
    } catch (error) {
      this.feeds.delete(feed);
      feed.close();
      throw error;
    }
    return () => {
      closed = true;
      disposeChanges?.();
      this.feeds.delete(feed!);
      feed?.close();
    };
  }
  private caller = new AsyncLocalStorage<AccessContext>();
  get teamIdentity() {
    return this.config.identityMode === "trusted_gateway";
  }
  as<T>(access: AccessContext, action: () => T): T {
    return this.caller.run(access, action);
  }
  private actor() {
    return (
      this.caller.getStore() ??
      (this.teamIdentity
        ? { principalId: "morphz-service", actantId: "morphz-agent" }
        : localAccess)
    );
  }
  principalId(principalId: string) {
    return (
      "mw-" +
      createHash("sha256")
        .update(this.config.namespace + ":" + principalId)
        .digest("hex")
    );
  }
  /** Read Runtime-owned evidence through the configured, authenticated bridge.
   * A model or browser cannot choose the Runtime origin or credentials.
   */
  inputEvidenceReader(viewer?: AccessContext): RuntimeInputEvidenceReader {
    return runtimeHttpInputEvidenceReader(
      async (path, runtimePrincipalId) => {
        if (!this.teamIdentity)
          return this.request(
            path,
            "GET",
            undefined,
            localAccess,
            undefined,
            "json",
            true,
          );
        // Only a signed Runtime invocation supplies this identity. Map it back
        // to a current Host Human, never elevate a gateway to the operator plane
        // or reclaim Session membership as a side effect of reading evidence.
        const access =
          viewer ??
          (runtimePrincipalId
            ? this.identity!.currentHumanAccesses().find(
                (candidate) =>
                  this.principalId(candidate.principalId) ===
                  runtimePrincipalId,
              )
            : this.caller.getStore());
        if (!access || !(await this.identity!.allowsShared(access)))
          throw new DomainError(
            "forbidden",
            "原始 Runtime 发起身份不可用或已撤销。",
          );
        return this.request(
          path,
          "GET",
          undefined,
          access,
          undefined,
          "json",
          true,
        );
      },
      { sessionScoped: this.teamIdentity },
    );
  }
  /** The Platform link is authorized before this reader is called. Runtime
   * still checks the actual Session principal on every status read. */
  taskRunStatusReader(): RuntimeTaskRunStatusReader {
    return new RuntimeTaskRunStatusReader((path, access) =>
      this.request(path, "GET", undefined, access, undefined),
    );
  }
  /** A project retirement may inspect only durable, attributed deliveries.
   * Legacy active work has no trustworthy Platform project provenance and
   * therefore blocks retirement rather than being guessed into a project. */
  async assertProjectInputsSettled(projectId: string): Promise<void> {
    const deliveries = [...this.state.deliveries];
    if (
      deliveries.some(
        (delivery) =>
          !delivery.platformSource &&
          ["queued", "sending", "running"].includes(delivery.state),
      )
    )
      throw new DomainError(
        "conflict",
        "仍有来源未确认的旧输入，不能归档或删除项目。",
      );
    const selected = deliveries.filter(
      (delivery) => delivery.platformSource?.projectId === projectId,
    );
    if (
      selected.some((delivery) =>
        ["queued", "sending", "running"].includes(delivery.state),
      )
    )
      throw new DomainError("conflict", "项目仍有正在处理的消息。");
    for (let offset = 0; offset < selected.length; offset += 16) {
      await Promise.all(
        selected.slice(offset, offset + 16).map(async (delivery) => {
          if (!delivery.rootId) {
            if (
              delivery.acceptedEventId ||
              delivery.runtimePostAttempted !== false
            )
              throw new DomainError(
                "conflict",
                "消息发送结果尚未确认，不能归档或删除项目。",
              );
            return;
          }
          const source = delivery.platformSource!;
          const path = `/api/sessions/${encodeURIComponent(delivery.sessionId)}/turns/${encodeURIComponent(delivery.rootId)}/thread`;
          let raw: unknown;
          try {
            raw = await this.request(
              path,
              "GET",
              undefined,
              source.author,
              undefined,
            );
          } catch {
            throw new DomainError(
              "conflict",
              "暂时无法确认项目消息的 Runtime 状态。",
            );
          }
          const thread = z
            .object({
              session_id: z.literal(delivery.sessionId),
              root_turn_id: z.literal(delivery.rootId),
              lifecycle: z.enum(["open", "completed", "failed", "cancelled"]),
            })
            .safeParse(raw);
          if (!thread.success || thread.data.lifecycle === "open")
            throw new DomainError(
              "conflict",
              "项目消息仍在执行或 Runtime 状态不明确。",
            );
        }),
      );
    }
  }
  /** Deliver one already-committed Platform admission. Runtime owns the
   * Schedule and its Thread; the POST is safe to repeat after an uncertain
   * acknowledgement because the immutable request carries one stable ID. */
  async deliverTaskRun(
    rawAdmission: TaskRunAdmission,
    access: AccessContext,
  ): Promise<TaskRunRuntimeReceipt> {
    const admission = taskRunAdmissionSchema.parse(rawAdmission);
    if (
      access.principalId !== admission.principalId ||
      access.actantId !== admission.humanActantId
    )
      throw new DomainError("forbidden", "事项执行的发起身份不一致。");
    const base = `/api/sessions/${encodeURIComponent(admission.sessionId)}`;
    const session = sessionSchema.parse(
      await this.request(
        base,
        "GET",
        undefined,
        { principalId: "morphz-service", actantId: "morphz-agent" },
        undefined,
      ),
    );
    if (
      session.id !== admission.sessionId ||
      session.context_id !== this.contextId(admission.projectId)
    )
      throw new DomainError(
        "conflict",
        "事项执行的 Runtime 会话与原项目不一致。",
      );
    // The trusted Host has already rechecked the persisted Human and Platform
    // project. The gateway must bind that same Human to this Session before
    // Runtime can attribute the scheduled root to them.
    if (this.teamIdentity)
      await this.request(
        `${base}/principal`,
        "POST",
        undefined,
        access,
        undefined,
      );
    const schedule = z
      .object({
        id: z.string(),
        thread_id: z.string(),
        source_turn_id: z.string(),
        revision: z.number().int().positive(),
        status: z.enum([
          "queued",
          "paused",
          "dispatched",
          "completed",
          "cancelled",
        ]),
        not_before: z.string().nullable(),
        interval_seconds: z.number().int().positive().nullable(),
      })
      .parse(
        await this.request(
          `${base}/schedules`,
          "POST",
          admission.request,
          access,
          undefined,
        ),
      );
    if (
      schedule.id !== admission.request.id ||
      schedule.source_turn_id !== `client-schedule-${admission.request.id}`
    )
      throw new DomainError("conflict", "Runtime 返回了另一项执行安排。");
    const thread = z
      .object({
        thread_id: z.string(),
        session_id: z.string(),
        root_turn_id: z.string(),
        lifecycle: z.enum(["open", "completed", "failed", "cancelled"]),
      })
      .parse(
        await this.request(
          `${base}/turns/${encodeURIComponent(schedule.source_turn_id)}/thread`,
          "GET",
          undefined,
          access,
          undefined,
        ),
      );
    return taskRunRuntimeReceiptSchema.parse({
      schedule: {
        id: schedule.id,
        thread_id: schedule.thread_id,
        revision: schedule.revision,
        status: schedule.status,
        not_before: schedule.not_before,
        interval_seconds: schedule.interval_seconds,
      },
      thread,
    });
  }
  /** Resolve the actual Runtime route; the Platform observation is never a
   * substitute for current Schedule / Thread control and generation. */
  async inspectTaskSourceDestination(
    admission: TaskRunAdmission,
    ref: TaskRunLink["runtime"],
    access: AccessContext,
  ): Promise<TaskSourceDestination | null> {
    const current = await this.taskRunStatusReader().inspect(ref, access);
    if (
      !["dispatched", "completed"].includes(current.schedule.status) ||
      (current.schedule.notBefore !== null &&
        Date.parse(current.schedule.notBefore) > Date.now())
    )
      return null;
    const session = sessionSchema.parse(
      await this.request(
        `/api/sessions/${encodeURIComponent(admission.sessionId)}`,
        "GET",
        undefined,
        access,
        undefined,
      ),
    );
    if (session.context_id !== this.contextId(admission.projectId))
      throw new DomainError("conflict", "来源关注的 Session 已不属于原项目。");
    const detail = z
      .object({
        snapshot: z.object({
          thread: z.object({
            id: z.literal(ref.threadId),
            session_id: z.literal(admission.sessionId),
            context_id: z.literal(session.context_id),
            root_turn_id: z.literal(`client-schedule-${admission.request.id}`),
            initiating_principal_id: z.string().min(1),
            target_id: z.string().min(1).nullable(),
            generation: z.number().int().positive().safe(),
            lifecycle: z.enum(["open", "completed", "failed", "cancelled"]),
            control_state: z.string(),
          }),
        }),
      })
      .parse(
        await this.request(
          `/api/contexts/${encodeURIComponent(session.context_id)}/threads/${encodeURIComponent(ref.threadId)}`,
          "GET",
          undefined,
          access,
          undefined,
        ),
      );
    const thread = detail.snapshot.thread;
    if (
      this.teamIdentity &&
      thread.initiating_principal_id !== this.principalId(admission.principalId)
    )
      throw new DomainError("forbidden", "来源执行的实际发起身份不一致。");
    if (thread.lifecycle === "cancelled" || thread.control_state !== "active")
      return null;
    return thread.lifecycle === "open"
      ? {
          kind: "thread",
          threadId: ref.threadId,
          generation: thread.generation,
          principalId: thread.initiating_principal_id,
        }
      : {
          kind: "follow-up",
          principalId: thread.initiating_principal_id,
          targetId: thread.target_id,
        };
  }

  /** Exact lookup precedes retries and cancellation. A connector observation
   * is typed data, not an input manufactured on behalf of a Human. */
  async reconcileTaskSourceEvent(
    event: TaskSourceEvent,
    access: AccessContext,
  ): Promise<TaskSourceReceipt | null> {
    let raw: unknown;
    try {
      raw = await this.request(
        `/api/sessions/${encodeURIComponent(event.admission.sessionId)}/messages/by-client-id/${encodeURIComponent(event.eventId)}`,
        "GET",
        undefined,
        access,
        undefined,
      );
    } catch (error) {
      if (error instanceof UpstreamError && error.status === 404) return null;
      throw error;
    }
    const root = z
      .object({
        event: z.object({
          id: z.string(),
          actor: z.literal("Session-Client"),
          type: z.literal("session_message"),
          topic: z.enum(["chat/user_message", "chat/steering"]),
          payload: z.record(z.string(), z.unknown()),
        }),
      })
      .parse(raw).event;
    const payload = root.payload;
    const accepted = z
      .object({ request: z.unknown() })
      .parse(payload.session_io);
    if (
      payload.session_id !== event.admission.sessionId ||
      payload.client_message_id !== event.eventId ||
      payload.principal_id !== event.destination.principalId ||
      (this.teamIdentity &&
        payload.principal_id !==
          this.principalId(event.admission.principalId)) ||
      !matchesTaskSourceRequest(event, accepted.request)
    )
      throw new DomainError(
        "forbidden",
        "Runtime 来源事件与原冻结请求不一致。",
      );
    const rootId =
      typeof payload.root_turn_id === "string" ? payload.root_turn_id : root.id;
    if (event.destination.kind === "thread") {
      if (
        root.topic !== "chat/steering" ||
        payload.thread_id !== event.destination.threadId ||
        payload.thread_generation !== event.destination.generation ||
        rootId !== `client-schedule-${event.admission.request.id}`
      )
        throw new DomainError("conflict", "来源事件被投递到另一执行。");
      return { eventId: root.id, rootId, threadId: event.destination.threadId };
    }
    if (root.topic !== "chat/user_message" || rootId !== root.id)
      throw new DomainError("conflict", "来源接续没有自己的确切执行根。");
    let threadId: string | null = null;
    try {
      threadId = z
        .object({
          thread_id: z.string(),
          session_id: z.literal(event.admission.sessionId),
          root_turn_id: z.literal(rootId),
        })
        .parse(
          await this.request(
            `/api/sessions/${encodeURIComponent(event.admission.sessionId)}/turns/${encodeURIComponent(rootId)}/thread`,
            "GET",
            undefined,
            access,
            undefined,
          ),
        ).thread_id;
    } catch (error) {
      if (!(error instanceof UpstreamError && error.status === 404))
        throw error;
    }
    return { eventId: root.id, rootId, threadId };
  }

  async deliverTaskSource(
    event: TaskSourceEvent,
    admission: TaskRunAdmission,
    access: AccessContext,
  ): Promise<TaskSourceReceipt> {
    if (
      JSON.stringify(event.admission) !== JSON.stringify(admission) ||
      access.principalId !== admission.principalId ||
      access.actantId !== admission.humanActantId
    )
      throw new DomainError("forbidden", "来源投递与原事项准入身份不一致。");
    const earlier = await this.reconcileTaskSourceEvent(event, access);
    if (earlier) return earlier;
    try {
      z.object({ accepted: z.literal(true), event_id: z.string() }).parse(
        await this.request(
          `/api/sessions/${encodeURIComponent(admission.sessionId)}/io/messages`,
          "POST",
          event.request,
          access,
          undefined,
        ),
      );
    } catch (error) {
      if (
        error instanceof UpstreamError &&
        [400, 401, 403, 404, 409, 422].includes(error.status)
      ) {
        const accepted = await this.reconcileTaskSourceEvent(event, access);
        if (accepted) return accepted;
        throw new TaskSourceRejectedError(error);
      }
      throw error;
    }
    const confirmed = await this.reconcileTaskSourceEvent(event, access);
    if (!confirmed)
      throw new DomainError(
        "conflict",
        "Runtime 尚未确认来源事件，请按原标识重试。",
      );
    return confirmed;
  }

  async stopTaskSource(
    event: TaskSourceEvent,
    access: AccessContext,
  ): Promise<TaskSourceReceipt | null> {
    const accepted = await this.reconcileTaskSourceEvent(event, access);
    if (!accepted || event.destination.kind === "thread") return accepted;
    const path = `/api/sessions/${encodeURIComponent(event.admission.sessionId)}/turns/${encodeURIComponent(accepted.rootId)}/thread`;
    const schema = z.object({
      thread_id: z.string(),
      session_id: z.literal(event.admission.sessionId),
      root_turn_id: z.literal(accepted.rootId),
      revision: z.number().int().positive(),
      lifecycle: z.enum(["open", "completed", "failed", "cancelled"]),
    });
    let thread = schema.parse(
      await this.request(path, "GET", undefined, access, undefined),
    );
    if (thread.lifecycle === "open") {
      const session = sessionSchema.parse(
        await this.request(
          `/api/sessions/${encodeURIComponent(event.admission.sessionId)}`,
          "GET",
          undefined,
          access,
          undefined,
        ),
      );
      await this.request(
        `/api/contexts/${encodeURIComponent(session.context_id)}/threads/${encodeURIComponent(thread.thread_id)}`,
        "POST",
        {
          action: "cancel",
          expected_revision: thread.revision,
          reason: "用户停止原事项及来源接续",
        },
        access,
        undefined,
      );
      thread = schema.parse(
        await this.request(path, "GET", undefined, access, undefined),
      );
    }
    if (thread.lifecycle === "open")
      throw new DomainError("conflict", "Runtime 尚未确认来源接续停止。");
    return accepted;
  }

  /** Retry-safe stop of the exact Platform-admitted Thread and any future
   * Schedule wake. A partial Runtime acknowledgement is resolved by reading
   * both objects again before confirming Platform's durable intent. */
  async stopPlatformTaskRun(
    pending: PendingTaskRunStop,
    rawAdmission: TaskRunAdmission,
    access: AccessContext,
  ): Promise<TaskRunStopObservation> {
    const admission = taskRunAdmissionSchema.parse(rawAdmission);
    if (
      pending.taskId !== admission.taskId ||
      pending.runNumber !== admission.runNumber ||
      pending.runtime.sessionId !== admission.sessionId ||
      pending.runtime.scheduleId !== admission.request.id ||
      access.principalId !== admission.principalId ||
      access.actantId !== admission.humanActantId
    )
      throw new DomainError("conflict", "停止请求与原执行授权不一致。");
    const base = `/api/sessions/${encodeURIComponent(admission.sessionId)}`;
    const session = sessionSchema.parse(
      await this.request(
        base,
        "GET",
        undefined,
        { principalId: "morphz-service", actantId: "morphz-agent" },
        undefined,
      ),
    );
    if (
      session.id !== admission.sessionId ||
      session.context_id !== this.contextId(admission.projectId)
    )
      throw new DomainError("conflict", "执行会话已不属于原项目。");
    let status = await this.taskRunStatusReader().inspect(
      pending.runtime,
      access,
    );
    if (status.thread.lifecycle === "open") {
      await this.request(
        `/api/contexts/${encodeURIComponent(session.context_id)}/threads/${encodeURIComponent(pending.runtime.threadId)}`,
        "POST",
        {
          action: "cancel",
          expected_revision: status.thread.revision,
          reason: "用户停止 Morphz 事项执行",
        },
        access,
        undefined,
      );
      status = await this.taskRunStatusReader().inspect(
        pending.runtime,
        access,
      );
    }
    if (["queued", "paused"].includes(status.schedule.status)) {
      await this.request(
        `${base}/schedules/${encodeURIComponent(pending.runtime.scheduleId)}`,
        "POST",
        { action: "cancel", expected_revision: status.schedule.revision },
        access,
        undefined,
      );
      status = await this.taskRunStatusReader().inspect(
        pending.runtime,
        access,
      );
    }
    if (
      status.thread.lifecycle === "open" ||
      ["queued", "paused"].includes(status.schedule.status)
    )
      throw new DomainError("conflict", "Runtime 尚未确认执行停止。");
    if (
      status.schedule.status === "dispatched" &&
      status.schedule.intervalSeconds !== null
    )
      throw new DomainError(
        "conflict",
        "周期安排仍可能再次触发，不能确认已停止。",
      );
    return status;
  }
  async controlPlatformTaskRunSchedule(
    pending: PendingTaskRunScheduleControl,
    rawAdmission: TaskRunAdmission,
    access: AccessContext,
  ): Promise<{ observation: TaskRunStopObservation; error: string }> {
    const admission = taskRunAdmissionSchema.parse(rawAdmission);
    if (
      pending.taskId !== admission.taskId ||
      pending.runNumber !== admission.runNumber ||
      pending.runtime.sessionId !== admission.sessionId ||
      pending.runtime.scheduleId !== admission.request.id ||
      access.principalId !== admission.principalId ||
      access.actantId !== admission.humanActantId
    )
      throw new DomainError("conflict", "执行控制与原执行授权不一致。");
    const base = `/api/sessions/${encodeURIComponent(admission.sessionId)}`;
    const session = sessionSchema.parse(
      await this.request(
        base,
        "GET",
        undefined,
        { principalId: "morphz-service", actantId: "morphz-agent" },
        undefined,
      ),
    );
    if (
      session.id !== admission.sessionId ||
      session.context_id !== this.contextId(admission.projectId)
    )
      throw new DomainError("conflict", "执行会话已不属于原项目。");
    let observation = await this.taskRunStatusReader().inspect(
      pending.runtime,
      access,
    );
    const desired = pending.action === "pause" ? "paused" : "queued";
    // A one-shot Schedule can have ended while its explicitly requested
    // source watch remains active. Only the watch bridge is controlled here;
    // a completed Thread is never reported as Runtime-paused or resumed.
    if (
      admission.watchSourceIds.length &&
      observation.schedule.intervalSeconds === null &&
      ["dispatched", "completed"].includes(observation.schedule.status)
    )
      return { observation, error: "" };
    if (observation.schedule.status === desired)
      return { observation, error: "" };
    const allowed = pending.action === "pause" ? "queued" : "paused";
    if (observation.schedule.status !== allowed)
      return {
        observation,
        error: "安排已经派发或结束，无法再暂停／恢复；请查看实际执行状态。",
      };
    await this.request(
      `${base}/schedules/${encodeURIComponent(pending.runtime.scheduleId)}`,
      "POST",
      {
        action: pending.action,
        expected_revision: observation.schedule.revision,
      },
      access,
      undefined,
    );
    observation = await this.taskRunStatusReader().inspect(
      pending.runtime,
      access,
    );
    if (observation.schedule.status !== desired)
      throw new DomainError("conflict", "Runtime 尚未确认安排控制。");
    return { observation, error: "" };
  }
  /** Build the existing execution viewer against a Platform-authorized run,
   * not against the removed workspace artifact/session binding. */
  async platformTaskExecutionControls(
    projectId: string,
    ref: TaskRunLink["runtime"],
    access: AccessContext,
    sourceForExecution?: (
      eventId: string,
    ) => Promise<Awaited<ReturnType<TaskSourceEvidenceReader>> | null>,
    sourceEventsForExecution?: (afterEventId?: string) => Promise<
      Array<{
        event: TaskSourceEvent;
        receipt: TaskSourceReceipt | null;
        discarded: boolean;
      }>
    >,
  ): Promise<ExecutionControls> {
    const session = sessionSchema.parse(
      await this.request(
        `/api/sessions/${encodeURIComponent(ref.sessionId)}`,
        "GET",
        undefined,
        { principalId: "morphz-service", actantId: "morphz-agent" },
        undefined,
      ),
    );
    if (
      session.id !== ref.sessionId ||
      session.context_id !== this.contextId(projectId)
    )
      throw new DomainError("conflict", "执行会话与事项项目不一致。");
    const additionalRoot = sourceForExecution
      ? async (rootId: string, threadId: string) => {
          const reader = this.inputEvidenceReader(access);
          const thread = z
            .object({
              snapshot: z.object({
                thread: z.object({
                  id: z.string(),
                  session_id: z.string(),
                  context_id: z.string(),
                  root_turn_id: z.string(),
                  initiating_principal_id: z.string().nullable(),
                  agent_id: z.string(),
                }),
              }),
            })
            .parse(
              await reader.readThread(
                ref.sessionId,
                threadId,
                undefined,
                this.principalId(access.principalId),
              ),
            ).snapshot.thread;
          if (
            thread.id !== threadId ||
            thread.session_id !== ref.sessionId ||
            thread.context_id !== session.context_id ||
            thread.root_turn_id !== rootId ||
            !thread.initiating_principal_id
          )
            return false;
          try {
            const evidence = await resolveRuntimeInvocationEvidence(
              {
                session_id: ref.sessionId,
                context_id: session.context_id,
                thread_id: threadId,
                principal_id: thread.initiating_principal_id,
                agent_id: thread.agent_id,
                job_id: "execution-inspector",
                tool_call_id: "execution-inspector",
                target_id: "execution-inspector",
              },
              reader,
              undefined,
              async (sourceSession, sourceId) => {
                const source =
                  sourceSession === ref.sessionId
                    ? await sourceForExecution(sourceId)
                    : null;
                if (!source)
                  throw new Error("Runtime 执行未绑定到可验证的原始应用输入。");
                return source;
              },
            );
            return (
              evidence.kind === "task-run" &&
              evidence.scheduleId === ref.scheduleId &&
              evidence.admission.projectId === projectId
            );
          } catch (error) {
            if (
              error instanceof Error &&
              error.message === "Runtime 执行未绑定到可验证的原始应用输入。"
            )
              return false;
            throw error;
          }
        }
      : undefined;
    const threadIds = sourceEventsForExecution
      ? async () => {
          const ids = new Set([ref.threadId]);
          let afterEventId: string | undefined;
          for (;;) {
            const page = await sourceEventsForExecution(afterEventId);
            for (let offset = 0; offset < page.length; offset += 4) {
              const receipts = await Promise.all(
                page
                  .slice(offset, offset + 4)
                  .map(async (item) =>
                    item.discarded ||
                    item.event.destination.kind !== "follow-up"
                      ? null
                      : item.receipt?.threadId
                        ? item.receipt
                        : await this.reconcileTaskSourceEvent(
                            item.event,
                            access,
                          ),
                  ),
              );
              for (const receipt of receipts)
                if (receipt?.threadId) ids.add(receipt.threadId);
            }
            if (page.length < 100) break;
            afterEventId = page.at(-1)!.event.eventId;
          }
          return [...ids];
        }
      : undefined;
    return new ExecutionControls(
      (path, method, body) => this.request(path, method, body, access),
      () => ({
        sessionId: ref.sessionId,
        contextId: session.context_id,
        rootId: `client-schedule-${ref.scheduleId}`,
        threadId: ref.threadId,
        additionalRoot,
        threadIds,
      }),
    );
  }
  private contextId(projectId: string) {
    return (
      `mw-context-${this.config.namespace}` +
      (this.teamIdentity
        ? "-" +
          createHash("sha256").update(projectId).digest("hex").slice(0, 24)
        : "")
    );
  }
  readonly modelSettings = new RuntimeModelSettings(() => this.config);
  readonly profiles = new RuntimeProfileClient(
    () => this.config,
    undefined,
    () => this.publishWorkspaceChange(),
  );
  private state: z.infer<typeof storedSchema>;
  private dirtyDeliveries = new Map<string, StoredDelivery>();
  // Ephemeral: approvals must be refreshed after restart, never restored as live.
  private attention: ExecutionAttention = { available: false, approvals: [] };
  // Disposable provenance only. Runtime roots remain authoritative; current
  // Platform grants are checked when exposing a view, never cached here.
  private activitySources = new Map<string, PlatformInputSource>();
  private activityRootRoutes = new Map<
    string,
    {
      checkedAt: number;
      route: {
        inputId: string;
        source: PlatformInputSource;
        rootId: string;
      } | null;
    }
  >();
  private busy = false;
  private workspaceChangeListeners = new Set<() => void>();
  private workspaceChangeFingerprint = "";
  private executionObserver?: RuntimeChangeObserver;
  private executionObserverSessions = "";
  private executionChangeVersions = new Map<string, number>();
  // Finite startup work and committed-event wakeups, not a second polling
  // loop. Failed/unknown proofs leave the ledger intact and are not retried
  // until another actual Runtime change (or a fresh Host incarnation).
  private rootCancellationChecks = new Set<StoredDelivery>();
  /** Host-only wake-up for actual public Runtime projection changes. */
  observeWorkspaceChanges(listener: () => void): () => void {
    this.workspaceChangeListeners.add(listener);
    if (!this.executionObserver && !this.stopped) {
      const access = this.teamIdentity
        ? { principalId: "morphz-service", actantId: "morphz-agent" }
        : localAccess;
      this.executionObserver = new RuntimeChangeObserver({
        url: this.config.url,
        sessions: () =>
          this.activeSessions().map((session) => ({
            id: session.id,
            cursor: session.cursor,
          })),
        headers: () => ({
          Authorization: "Bearer " + this.config.token,
          ...(this.teamIdentity
            ? { "X-Morphz-Principal": this.principalId(access.principalId) }
            : {}),
        }),
        request: (path) =>
          this.request(path, "GET", undefined, access, undefined),
        changed: (sessionId) => {
          this.executionChangeVersions.set(
            sessionId,
            (this.executionChangeVersions.get(sessionId) ?? 0) + 1,
          );
          this.publishWorkspaceChange();
        },
      });
      this.executionObserverSessions = this.activeSessions()
        .map((session) => session.id)
        .sort()
        .join("\n");
    }
    return () => {
      this.workspaceChangeListeners.delete(listener);
      if (!this.workspaceChangeListeners.size) {
        this.executionObserver?.close();
        this.executionObserver = undefined;
        this.executionObserverSessions = "";
      }
    };
  }
  /** Ephemeral, authorization-scoped invalidation only. Neither a Runtime
   * cursor nor a token received over WebSocket is an execution-state receipt. */
  platformExecutionChangeVersion(
    access: AccessContext,
    projectIds: readonly string[],
  ): string {
    const readable = new Set(projectIds);
    const ownSharedSessions = new Set(
      this.activeDeliveries()
        .filter((delivery) => {
          const source = delivery.platformSource!;
          return (
            readable.has(source.projectId) &&
            source.author.principalId === access.principalId
          );
        })
        .map((delivery) => delivery.sessionId),
    );
    return createHash("sha256")
      .update(
        JSON.stringify(
          this.activeSessions()
            .filter((session) =>
              session.sharedDefault
                ? ownSharedSessions.has(session.id)
                : readable.has(session.projectId),
            )
            .map((session) => [
              session.id,
              this.executionChangeVersions.get(session.id) ?? 0,
              session.cursor,
            ])
            .sort(([left], [right]) =>
              String(left).localeCompare(String(right)),
            ),
        ),
      )
      .digest("hex");
  }
  private syncExecutionObserverSessions() {
    if (!this.executionObserver) return;
    const next = this.activeSessions()
      .map((session) => session.id)
      .sort()
      .join("\n");
    if (next === this.executionObserverSessions) return;
    this.executionObserverSessions = next;
    void this.executionObserver.sync();
  }
  private notifyWorkspaceChanges() {
    const next = createHash("sha256")
      .update(
        JSON.stringify(
          {
            status: this.platformStatus(),
            activity: this.state.activity,
            attention: this.attention,
            sessions: Object.values(this.state.sessions)
              .filter((session) => session.platform)
              .map((session) => [session.id, session.cursor]),
            deliveries: this.state.deliveries
              .filter((delivery) => delivery.platformSource)
              .map((delivery) => [
                delivery.inputId,
                delivery.state,
                delivery.rootId,
                delivery.acceptedEventId,
                delivery.error,
                delivery.cancelRequested,
                delivery.platformHeld,
                delivery.lastActivityAt,
              ]),
          },
          (key, value) => (key === "checkedAt" ? undefined : value),
        ),
      )
      .digest("hex");
    if (next === this.workspaceChangeFingerprint) return;
    this.workspaceChangeFingerprint = next;
    this.publishWorkspaceChange();
  }
  private publishWorkspaceChange() {
    for (const listener of this.workspaceChangeListeners)
      queueMicrotask(() => {
        if (this.workspaceChangeListeners.has(listener)) listener();
      });
  }
  private busyCompletion: Promise<void> | null = null;
  private stopped = false;
  private authorizePlatformInput?: (
    source: PlatformInputTarget,
  ) => Promise<{ sharedDefault: boolean }>;
  private authorizePlatformRead?: (
    scope: { projectId: string; conversationId: string },
    access: AccessContext,
  ) => Promise<PlatformReadGrant>;
  private messageAttachments?: MessageAttachmentService;
  private platformAgentScope?: (route: HostInvocation) => Promise<ToolScope>;
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private store: WorkspaceStore,
    private config: RuntimeConfig,
    private identity?: IdentityCenter,
    persistOnConstruction = true,
  ) {
    if (this.teamIdentity && !identity)
      throw new Error("可信网关适配需要应用身份配置。");
    const saved = store.runtimeBridgeState();
    this.state = saved
      ? storedSchema.parse(saved)
      : {
          namespace: config.namespace,
          endpoint: config.url,
          ...(config.identityMode ? { identityMode: config.identityMode } : {}),
          connected: false,
          directedInput: false,
          model: "",
          error: "",
          publications: {},
          threadBindings: {},
          sessions: {},
          deliveries: [],
        };
    if (saved) store.adoptValidatedRuntimeEvents(saved, this.state);
    if (
      this.state.namespace !== config.namespace ||
      this.state.endpoint !== config.url ||
      this.state.identityMode !== config.identityMode
    )
      throw new Error(
        "Runtime 连接与已保存的对话不匹配，请勿覆盖已有连接配置。",
      );
    this.state.connected = false;
    for (const delivery of this.state.deliveries) {
      if (this.dirtyDeliveries.has(delivery.inputId))
        throw new Error(`Runtime 投递标识重复：${delivery.inputId}`);
      // Validate/recover every retained row once, including parsed defaults.
      // Subsequent commits contain only mutations explicitly marked below.
      this.markDeliveryDirty(delivery);
      if (delivery.state === "running" && delivery.rootId)
        this.rootCancellationChecks.add(delivery);
      if (
        delivery.state === "sending" &&
        !!delivery.platformSource &&
        this.state.sessions[delivery.sessionId]?.platform
      )
        delivery.state = "queued";
    }
    if (persistOnConstruction) this.save();
  }
  private markDeliveryDirty(delivery: StoredDelivery) {
    this.dirtyDeliveries.set(delivery.inputId, delivery);
  }
  private save(delivery?: StoredDelivery) {
    if (delivery) this.markDeliveryDirty(delivery);
    // The new schedule inventory is a read-only live projection. Do not turn
    // it into a Host schedule ledger or retain a second durable authority.
    const activity = this.state.activity;
    const {
      schedules: _schedules,
      schedulesAvailable: _schedulesAvailable,
      schedulesTruncated: _schedulesTruncated,
      ...persistedActivity
    } = activity ?? {};
    this.store.saveRuntimeBridgeState(
      activity ? { ...this.state, activity: persistedActivity } : this.state,
      this.dirtyDeliveries,
    );
    // Keep the dirty set if SQLite fails; a later save retries the same queue
    // records together with their Event and connection cursors.
    this.dirtyDeliveries.clear();
    this.notifyWorkspaceChanges();
    this.syncExecutionObserverSessions();
  }
  bindPlatformInputAuthority(
    authorize?: (
      source: PlatformInputTarget,
    ) => Promise<{ sharedDefault: boolean }>,
  ) {
    this.authorizePlatformInput = authorize;
  }
  bindPlatformReadAuthority(
    authorize?: (
      scope: { projectId: string; conversationId: string },
      access: AccessContext,
    ) => Promise<PlatformReadGrant>,
  ) {
    this.authorizePlatformRead = authorize;
  }
  bindMessageAttachments(service?: MessageAttachmentService) {
    this.messageAttachments = service;
  }
  bindPlatformAgentScope(
    resolve?: (route: HostInvocation) => Promise<ToolScope>,
  ) {
    this.platformAgentScope = resolve;
  }
  get supportsDirectedInput() {
    return this.state.connected && this.state.directedInput;
  }
  get isConnected() {
    return this.state.connected;
  }
  /** The execution inspector follows the same Platform read grant as message
   * history. Runtime owns jobs; the persisted input roots determine which of
   * those jobs this reader may see or control. */
  async platformExecutionControls(
    scope: ExecutionScope,
    access: AccessContext,
  ) {
    const authorize = this.authorizePlatformRead;
    if (!authorize)
      throw new DomainError("invalid", "Platform 对话读取尚未接入。");
    const conversation = {
      projectId: scope.projectId,
      conversationId: scope.conversationId ?? scope.projectId,
    };
    const readable = async () => {
      const grant = await authorize(conversation, access);
      const deliveries = this.platformReadDeliveries(
        conversation,
        access,
        grant,
      );
      const selected = deliveries.filter((delivery) => {
        const source = delivery.platformSource!;
        if (scope.inputId && delivery.inputId !== scope.inputId) return false;
        if (scope.inputId && source.projectId !== scope.projectId) return false;
        if (scope.artifactId && source.artifactId !== scope.artifactId)
          return false;
        if (scope.threadId) {
          const thread = this.state.threadBindings[scope.threadId];
          if (
            !thread ||
            thread.sessionId !== delivery.sessionId ||
            thread.inputId !== delivery.inputId ||
            thread.projectId !== source.projectId ||
            thread.conversationId !== source.conversationId
          )
            return false;
        }
        return true;
      });
      if ((scope.inputId || scope.threadId) && selected.length !== 1)
        throw new DomainError("forbidden", "执行不属于当前工作对话。");
      if (scope.threadId && selected[0]?.rootId) {
        const delivery = selected[0];
        const session = this.state.sessions[delivery.sessionId];
        if (!session?.platform)
          throw new DomainError("forbidden", "执行不属于当前工作对话。");
        // A spawned child has its own root. This is a fresh parent-chain proof
        // to the authorized input root, not a relaxed cached root comparison.
        await authorizedExecutionThreadTree(
          (path, method, body) =>
            this.request(path, method, body, access, undefined),
          {
            sessionId: delivery.sessionId,
            contextId: this.contextId(session.projectId),
            inputRootId: delivery.rootId!,
            threadId: scope.threadId,
          },
          false,
        );
      }
      return selected.filter((delivery) => !!delivery.rootId);
    };
    const deliveries = await readable();
    const grouped = new Map<
      string,
      { sessionId: string; contextId: string; roots: Set<string> }
    >();
    for (const delivery of deliveries) {
      const session = this.state.sessions[delivery.sessionId];
      if (!session?.platform)
        throw new DomainError("conflict", "执行会话已变化，请刷新后查看。");
      const contextId = this.contextId(session.projectId);
      const key = `${delivery.sessionId}\u0000${contextId}`;
      const entry = grouped.get(key) ?? {
        sessionId: delivery.sessionId,
        contextId,
        roots: new Set<string>(),
      };
      entry.roots.add(delivery.rootId!);
      grouped.set(key, entry);
    }
    const request = async (path: string, method?: string, body?: unknown) => {
      try {
        // Physical reads may await remote Runtime state. A grant revoked while
        // reading a Job/approval must not authorize the subsequent mutation.
        if (method === "POST") await readable();
        return await this.request(path, method, body, access, undefined);
      } catch (error) {
        if (error instanceof UpstreamError)
          throw new DomainError(
            error.status === 409 || error.status === 404
              ? "conflict"
              : "invalid",
            error.status === 409 || error.status === 404
              ? "执行状态已变化，或 Runtime 不支持此操作。请刷新后查看。"
              : "Runtime 未确认操作，请核对最新状态，不要重复批准。",
          );
        throw error;
      }
    };
    const selectedTree =
      scope.threadId && deliveries[0]?.rootId
        ? await authorizedExecutionThreadTree(
            request,
            {
              sessionId: deliveries[0].sessionId,
              contextId: this.contextId(
                this.state.sessions[deliveries[0].sessionId]!.projectId,
              ),
              inputRootId: deliveries[0].rootId,
              threadId: scope.threadId,
            },
            true,
          )
        : undefined;
    const controls = [...grouped.values()].map((entry) => ({
      ...entry,
      viewer: new ExecutionControls(request, () => ({
        sessionId: entry.sessionId,
        contextId: entry.contextId,
        ...(scope.inputId || scope.threadId
          ? { rootId: selectedTree?.selected.rootId ?? [...entry.roots][0] }
          : { rootsBySession: { [entry.sessionId]: [...entry.roots] } }),
        ...(scope.threadId ? { threadId: scope.threadId } : {}),
        ...(selectedTree
          ? {
              threadIds: async () =>
                selectedTree.threads.map((thread) => thread.id),
              additionalRoot: async (rootId: string, threadId: string) =>
                selectedTree.threads.some(
                  (thread) =>
                    thread.id === threadId && thread.rootId === rootId,
                ),
            }
          : {}),
      })),
    }));
    const recheck = async () => {
      const current = await readable();
      const keys = new Set(
        current.map(
          (delivery) => `${delivery.sessionId}\u0000${delivery.rootId}`,
        ),
      );
      if (
        deliveries.some(
          (delivery) =>
            !keys.has(`${delivery.sessionId}\u0000${delivery.rootId}`),
        )
      )
        throw new DomainError("forbidden", "当前对话的读取权限已变化。");
    };
    const snapshot = async (): Promise<ExecutionSnapshot> => {
      const views = await Promise.all(
        controls.map((entry) => entry.viewer.snapshot(scope)),
      );
      await recheck();
      return {
        jobs: [
          ...new Map(
            views.flatMap((view) => view.jobs).map((job) => [job.id, job]),
          ).values(),
        ]
          .sort(
            (a, b) =>
              b.created_at.localeCompare(a.created_at) ||
              b.id.localeCompare(a.id),
          )
          .slice(0, 100),
        approvals: [
          ...new Map(
            views
              .flatMap((view) => view.approvals)
              .map((approval) => [approval.request.approval_id, approval]),
          ).values(),
        ]
          .sort((a, b) => b.requested_at.localeCompare(a.requested_at))
          .slice(0, 100),
        limit: 100,
        ...(selectedTree
          ? {
              threads: selectedTree.threads,
              threadsTruncated: selectedTree.truncated,
            }
          : {}),
      };
    };
    const viewerFor = async (target: {
      jobId?: string;
      approvalId?: string;
    }) => {
      await recheck();
      const owner = target.jobId
        ? jobSchema.parse(
            await request(
              `/api/execution-jobs/${encodeURIComponent(target.jobId)}`,
            ),
          )
        : z
            .object({ approvals: z.array(approvalSchema) })
            .parse(await request("/api/approvals"))
            .approvals.filter(
              (approval) => approval.request.approval_id === target.approvalId,
            )
            .map((approval) => approval.request)[0];
      if (!owner)
        throw new DomainError("not_found", "执行不属于当前工作对话。");
      const matches = controls.filter(
        (entry) =>
          entry.sessionId === owner.session_id &&
          entry.contextId === owner.context_id,
      );
      if (matches.length !== 1)
        throw new DomainError("not_found", "执行不属于当前工作对话。");
      return matches[0]!.viewer;
    };
    return {
      snapshot,
      result: async (jobId: string) => {
        const result = await (await viewerFor({ jobId })).result(scope, jobId);
        await recheck();
        return result;
      },
      control: async (control: ExecutionControl) => {
        const action = control.action;
        const viewer =
          action.type === "cancel-thread"
            ? controls.length === 1 && scope.threadId === action.threadId
              ? controls[0]!.viewer
              : null
            : await viewerFor(
                action.type === "cancel-job"
                  ? { jobId: action.jobId }
                  : { approvalId: action.approvalId },
              );
        if (!viewer)
          throw new DomainError("forbidden", "执行不属于当前工作对话。");
        await recheck();
        const result = await viewer.control(control);
        await recheck();
        return result;
      },
    };
  }
  toolScope(route: HostInvocation): ToolScope | Promise<ToolScope> {
    const session = this.state.sessions[route.session_id];
    if (
      !session ||
      !session.platform ||
      route.context_id !== this.contextId(session.projectId) ||
      !session.runtimePrincipalId ||
      (!this.teamIdentity && route.principal_id !== session.runtimePrincipalId)
    )
      throw new DomainError(
        "forbidden",
        "工具调用未绑定到已授权的 Morphz 会话。",
      );
    if (!this.platformAgentScope)
      throw new DomainError("forbidden", "Platform Agent 来源校验不可用。");
    return this.platformAgentScope(route);
  }
  /** Read the exact submitted Platform input after resolving the Runtime
   * invocation root. Neither model arguments nor the selected UI page can
   * substitute another input here.
   */
  async platformToolInput(route: HostInvocation) {
    const scope = await this.toolScope(route);
    if (!scope.platform || !scope.inputId)
      throw new DomainError("forbidden", "执行未绑定到 Platform 原始输入。");
    const delivery = this.state.deliveries.find(
      (item) =>
        item.inputId === scope.inputId &&
        item.sessionId === route.session_id &&
        item.platformSource?.projectId === scope.projectId,
    );
    if (!delivery) throw new DomainError("not_found", "原始输入不可用。");
    return structuredClone({
      ...platformPlainRequestSchema.parse(delivery.request).message.content
        .value,
      conversation_id: delivery.platformSource!.conversationId,
    });
  }
  /** Check this Host's already-owned delivery. Runtime still owns the actual
   * execution; no other Host recovers or takes over this local outbox. Saved
   * domain receipts do not use this gate because replay is not a new write. */
  async assertPlatformInputActive(inputId: string) {
    const delivery = this.state.deliveries.find(
      (item) => item.inputId === inputId && !!item.platformSource,
    );
    if (
      !delivery ||
      !["sending", "running"].includes(delivery.state) ||
      delivery.cancelRequested
    )
      throw new DomainError(
        "forbidden",
        "本次输入未获准继续读取或写入，停止后的迟到结果不能写入。",
      );
  }
  async publicUnderstanding(
    route: HostInvocation,
    scope: ToolScope,
    revision: number,
  ) {
    await this.toolScope(route);
    const frameId = `mw-public-${scope.projectId}`;
    const view = z
      .object({
        context_id: z.literal(route.context_id),
        active_session_id: z.literal(route.session_id),
        state: z.object({
          frames: z.array(
            z.object({
              id: z.string(),
              body: z.string(),
              revision: z.number().int(),
              updated_version: z.number().int(),
            }),
          ),
          retired: z.array(z.string()),
          retiring: z.record(z.string(), z.unknown()).default({}),
        }),
      })
      .parse(
        await this.request(
          `/api/sessions/${route.session_id}/context/projection`,
        ),
      );
    const frame = view.state.frames.find((f) => f.id === frameId);
    if (
      !frame ||
      frame.revision !== revision ||
      view.state.retired.includes(frameId) ||
      view.state.retiring[frameId]
    )
      throw new DomainError(
        "conflict",
        "公开认知帧尚未提交、已变化或已退役。请先完成上下文事务，再发布当前版本。",
      );
    if (frame.body.length > 30000)
      throw new DomainError("invalid", "公开摘要超过长度限制。");
    let body: string;
    try {
      body = publicSummary(frame.body);
    } catch {
      throw new DomainError(
        "invalid",
        '公开认知帧需包含 (public-summary "面向用户的 Markdown 摘要")，不能发布内部结构或推理。',
      );
    }
    return {
      body,
      frameId,
      frameRevision: frame.revision,
      mindVersion: frame.updated_version,
    };
  }
  private async runtimeFetch(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    try {
      return await fetch(url, init);
    } catch (error) {
      throw new RuntimeTransportError(error);
    }
  }

  private runtimeReadUnavailable(error: unknown): boolean {
    if (
      !(error instanceof RuntimeTransportError) &&
      !(
        error instanceof UpstreamError &&
        (error.status === 401 ||
          error.status === 403 ||
          (error.status >= 500 && error.status <= 599))
      )
    )
      return false;
    // Platform has independently authorized the current reader before these
    // calls. Runtime transport/credential failure is not a failure of that
    // data store and cannot grant access or restore accepted message history.
    this.state.connected = false;
    this.state.error =
      error instanceof Error ? error.message : "Runtime 不可用。";
    return true;
  }

  private async request(
    path: string,
    method = "GET",
    body?: unknown,
    access = this.actor(),
    binary?: { bytes: Buffer; offset: number },
    responseType: "json" | "bytes" = "json",
    readOnlySession = false,
  ): Promise<unknown> {
    // Internal reconciliation must use the original Human's read authority,
    // but must never reclaim membership as a side effect of a read. This is
    // not an option in a public request/SDK DTO; ordinary calls keep claiming.
    if (readOnlySession && (method !== "GET" || body !== undefined || binary))
      throw new Error("只读 Runtime 核对不能执行写入。");
    if (
      this.teamIdentity &&
      access.principalId !== "morphz-service" &&
      !this.identity!.allows(access)
    )
      throw new DomainError("forbidden", "Runtime 调用身份已撤销。");
    const id = /^\/api\/sessions\/([^/?]+)/.exec(path)?.[1],
      session = id ? this.state.sessions[id] : undefined;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.token}`,
      "Content-Type": binary ? "application/octet-stream" : "application/json",
      ...(binary ? { "X-Morphz-Upload-Offset": String(binary.offset) } : {}),
      ...(this.teamIdentity
        ? { "X-Morphz-Principal": this.principalId(access.principalId) }
        : {}),
    };
    // Only the center can assert this mapping. A browser never supplies a Runtime identity.
    // Claiming is idempotent and rechecked on every request, including after revocation.
    if (
      this.teamIdentity &&
      !readOnlySession &&
      session?.runtimePrincipalId &&
      access.principalId !== "morphz-service"
    ) {
      const claim = await this.runtimeFetch(
        `${this.config.url}/api/sessions/${id}/principal`,
        {
          method: "POST",
          headers,
          redirect: "error",
          signal: AbortSignal.timeout(8000),
        },
      );
      if (!claim.ok) throw new UpstreamError(claim.status);
    }
    const response = await this.runtimeFetch(this.config.url + path, {
      method,
      headers,
      body: binary
        ? new Uint8Array(binary.bytes)
        : body === undefined
          ? undefined
          : JSON.stringify(body),
      signal: AbortSignal.timeout(responseType === "bytes" ? 30000 : 8000),
      redirect: "error",
    });
    if (!response.ok) {
      if (path.endsWith("/io/messages")) {
        const error = (await response.json().catch(() => null)) as {
          error?: { code?: string };
        } | null;
        const code = error?.error?.code;
        if (code === "unsupported_activation_mode")
          throw new UpstreamError(
            response.status,
            "当前 Runtime 不支持这种输入方式；补充未送达，草稿已保留。请更新 Runtime 后重试。",
          );
        if (
          response.status === 404 ||
          code === "unsupported_io_version" ||
          code === "unsupported_format"
        ) {
          const format = z
            .object({
              message: z.object({
                format: z.object({ id: z.string(), version: z.string() }),
              }),
            })
            .safeParse(body);
          const reading =
            format.success &&
            format.data.message.format.id === "morphz.application.input" &&
            ["8", "9"].includes(format.data.message.format.version);
          throw new UpstreamError(
            response.status,
            reading
              ? `Runtime 尚未加载阅读消息格式（v${format.success ? format.data.message.format.version : ""}）。请让 Runtime 加载当前 Desktop 的应用配置；只重开阅读页无效。问题和阅读位置已保留，加载后点击「重试发送」，无需重新提问。`
              : "当前 Morphz Runtime 尚未启用结构化工作消息，或未加载所需应用格式。请更新并启用 session-io；原输入已保留，不会转成提示词重发。",
          );
        }
        if (
          code === "projection_budget_exceeded" ||
          code === "message_limit_exceeded"
        )
          throw new UpstreamError(
            response.status,
            "输入超过当前 Runtime 的结构化消息预算。原输入已保留；请将大段资料保存为对象后引用。",
          );
      }
      throw new UpstreamError(response.status);
    }
    if (responseType === "bytes") {
      const limit = 20 * 1024 * 1024;
      if (Number(response.headers.get("content-length")) > limit) {
        await response.body?.cancel();
        throw new Error("Runtime 消息附件超过大小限制。");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Runtime 消息附件没有字节内容。");
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > limit) throw new Error("Runtime 消息附件超过大小限制。");
          chunks.push(Buffer.from(value));
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      } finally {
        reader.releaseLock();
      }
      return {
        mime: response.headers.get("content-type")?.split(";")[0] ?? "",
        bytes: Buffer.concat(chunks, size),
      };
    }
    return response.json();
  }
  async models(includeSources = true) {
    const raw = z
      .object({
        model: z.string().optional(),
        models: z.array(z.string()).optional(),
        model_options: z.array(modelOptionSchema).optional(),
        reasoning_effort: reasoningEffortSchema.nullable().optional(),
      })
      .passthrough()
      .parse(await this.request("/api/runtime/inference"));
    const catalog: ModelCatalog = {
      current: raw.model ?? this.state.model,
      options:
        raw.model_options ??
        (raw.models ?? []).map((id) => ({ id, label: id })),
      reasoning: {
        current: raw.reasoning_effort ?? null,
        levels: reasoningEffortSchema.options,
      },
    };
    // Provider configuration is optional metadata. Only names cross this boundary;
    // never forward keys, endpoints, headers or credential references to the UI.
    if (includeSources) {
      try {
        const providers = z
          .object({
            provider_instances: z.record(
              z.string(),
              z.object({ accounts: z.array(z.string()).default([]) }),
            ),
            auth_accounts: z.record(
              z.string(),
              z.object({
                config: z.object({ label: z.string().nullable().optional() }),
                effective_enabled: z.boolean(),
                oauth: z.boolean(),
                authenticated: z.boolean(),
              }),
            ),
            model_routes: z.record(
              z.string(),
              z.object({
                candidates: z.array(
                  z.object({
                    provider: z.string(),
                    account: z.string().nullable().optional(),
                  }),
                ),
              }),
            ),
          })
          .parse(await this.request("/api/runtime/providers"));
        catalog.options = catalog.options.map((option) => {
          const names = new Set<string>();
          for (const candidate of providers.model_routes[option.id]
            ?.candidates ?? []) {
            const accounts = candidate.account
              ? [candidate.account]
              : (providers.provider_instances[candidate.provider]?.accounts ??
                []);
            for (const id of accounts) {
              const account = providers.auth_accounts[id];
              if (
                account?.effective_enabled &&
                (!account.oauth || account.authenticated)
              )
                names.add(account.config.label?.trim() || candidate.provider);
            }
          }
          return names.size ? { ...option, sources: [...names] } : option;
        });
      } catch {
        /* Older or restricted Runtime: keep the authoritative model catalog. */
      }
    }
    return catalog;
  }
  inspectConnection(signal?: AbortSignal) {
    return inspectRuntimeConnection(
      this.config,
      signal,
      this.teamIdentity ? this.principalId("morphz-service") : undefined,
    );
  }
  validateConnection(config: RuntimeConfig) {
    if (
      config.url !== this.config.url ||
      config.namespace !== this.config.namespace ||
      config.identityMode !== this.config.identityMode
    )
      throw new DomainError(
        "conflict",
        "连接与原会话不匹配，原连接没有被替换。",
      );
  }
  updateConnection(config: RuntimeConfig) {
    this.validateConnection(config);
    // Keep the bridge, feeds, Sessions and durable delivery identities intact.
    this.config = config;
  }
  async validateModel(model: string) {
    return this.validateInference(model);
  }
  async validateInference(model?: string, effort?: ReasoningEffort) {
    const catalog = await this.models(false);
    if (model && !catalog.options.some((option) => option.id === model))
      throw new DomainError(
        "invalid",
        "所选模型当前不可用，请重新选择；草稿已保留。",
      );
    if (effort && !reasoningLevels(catalog, model ?? "").includes(effort))
      throw new DomainError(
        "invalid",
        "所选模型不支持此推理强度，请重新选择；草稿已保留。",
      );
  }
  private deliveryView(
    delivery: StoredDelivery,
  ): ConversationRuntime["deliveries"][number] {
    const {
      inputId,
      state,
      error,
      rootId,
      sessionId,
      cancelRequested,
      supplement,
      rejection,
    } = delivery;
    return {
      inputId,
      state,
      error,
      ...(supplement ? { supplement } : {}),
      ...(rejection ? { rejection } : {}),
      retryable: state === "failed" && !rootId && !rejection,
      cancelRequested,
      cancellable:
        !supplement &&
        !cancelRequested &&
        (state === "queued" ||
          (state === "running" &&
            !!this.state.sessions[sessionId]?.turnControl)),
    };
  }

  private platformReadDeliveries(
    scope: { projectId: string; conversationId: string },
    access: AccessContext,
    grant: PlatformReadGrant,
  ) {
    const readableProjects = new Set(grant.projectIds);
    return this.state.deliveries.filter((delivery) => {
      const source = delivery.platformSource;
      return (
        !!source &&
        this.platformSourceReadable(
          source,
          scope,
          access,
          grant,
          readableProjects,
        )
      );
    });
  }

  private platformSourceReadable(
    source: PlatformInputSource,
    scope: { projectId: string; conversationId: string },
    access: AccessContext,
    grant: PlatformReadGrant,
    readableProjects: ReadonlySet<string> = new Set(grant.projectIds),
  ) {
    if (!readableProjects.has(source.projectId)) return false;
    if (!grant.personalDefault)
      return (
        source.projectId === scope.projectId &&
        source.conversationId === scope.conversationId
      );
    if (source.author.principalId !== access.principalId) return false;
    return (
      source.conversationId === scope.conversationId ||
      (!this.teamIdentity && source.conversationId === source.projectId)
    );
  }

  /** A durable public-output fact is the only safe source for an incomplete
   * stream quote. Live deltas alone are not persisted and cannot be cited. */
  private async platformPublicOutput(
    sessionId: string,
    rootId: string,
    attemptId: string,
    access: AccessContext,
  ): Promise<{ createdAt: string; text: string } | null> {
    if (!attemptId || attemptId.length > 256) return null;
    let response: unknown;
    try {
      response = await this.request(
        `/api/sessions/${encodeURIComponent(sessionId)}/events/${encodeURIComponent(`model_public_output_${attemptId}`)}`,
        "GET",
        undefined,
        access,
        undefined,
      );
    } catch (error) {
      if (error instanceof UpstreamError && error.status === 404) return null;
      throw error;
    }
    const { event } = z.object({ event: eventSchema }).parse(response);
    const createdAt = payloadString(event, "first_visible_at");
    const text = payloadString(event, "text");
    if (
      event.topic !== "runtime/model_public_output" ||
      payloadString(event, "attempt_id") !== attemptId ||
      payloadString(event, "root_turn_id") !== rootId ||
      !createdAt ||
      !Number.isFinite(Date.parse(createdAt)) ||
      !text
    )
      return null;
    return { createdAt, text };
  }

  /** A streamed reply has a stable publication ID, not the random ID of its
   * final Event. Resolve that ID within its causal input root; the Runtime
   * query is indexed and each transfer is bounded even for long Sessions. */
  private async platformPublicationEvent(
    sessionId: string,
    rootId: string,
    attemptId: string,
    access: AccessContext,
  ): Promise<{ event: RuntimeEvent; createdAt: string } | null> {
    if (!attemptId || attemptId.length > 256) return null;
    const pageSize = 100;
    let beforeSequence: number | undefined;
    for (;;) {
      const query = new URLSearchParams({
        root_turn_id: rootId,
        attempt_id: attemptId,
        limit: String(pageSize),
        ...(beforeSequence !== undefined
          ? { before_sequence: String(beforeSequence) }
          : {}),
      });
      const response = await this.request(
        `/api/sessions/${encodeURIComponent(sessionId)}/events?${query}`,
        "GET",
        undefined,
        access,
        undefined,
      );
      const { events } = z
        .object({ events: z.array(eventSchema).max(pageSize) })
        .parse(response);
      const event = events.findLast(
        (candidate) =>
          [
            "chat/reply",
            "chat/outbound_message",
            "chat/runtime_error",
            "session/io_state",
            "runtime/response_protocol_fused",
          ].includes(candidate.topic) &&
          payloadString(candidate, "attempt_id") === attemptId &&
          ["root_turn_id", "trigger_event_id", "source_turn_id"].some(
            (key) => payloadString(candidate, key) === rootId,
          ) &&
          !!(
            payloadString(candidate, "text") ??
            payloadString(candidate, "error") ??
            payloadString(candidate, "message")
          ),
      );
      if (event) {
        const output = await this.platformPublicOutput(
          sessionId,
          rootId,
          attemptId,
          access,
        );
        return { event, createdAt: output?.createdAt ?? event.timestamp };
      }
      if (events.length < pageSize) return null;
      const first = events[0]?.sequence;
      if (
        first === undefined ||
        first <= 0 ||
        (beforeSequence !== undefined && first >= beforeSequence)
      )
        throw new Error("Runtime 消息分页游标未前进。");
      beforeSequence = first;
    }
  }

  /** A second Host can cite an accepted input without opening the sending
   * Host's private delivery database. Runtime proves the immutable root and
   * Platform rechecks current membership after both exact Event reads. */
  private async remotePlatformMessageSource(
    scope: { projectId: string; conversationId: string },
    access: AccessContext,
    messageId: string,
    inputId: string,
    authorize: NonNullable<typeof this.authorizePlatformRead>,
  ) {
    const grant = await authorize(scope, access);
    const sessionId = this.objectSessionId(
      scope.projectId,
      scope.conversationId,
      grant.personalDefault,
    );
    const readEvent = async (path: string) => {
      try {
        const response = await this.request(
          path,
          "GET",
          undefined,
          access,
          undefined,
        );
        return z.object({ event: eventSchema }).parse(response).event;
      } catch (error) {
        if (error instanceof UpstreamError && error.status === 404) return null;
        throw error;
      }
    };
    const root = await readEvent(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages/by-client-id/${encodeURIComponent(inputId)}`,
    );
    if (!root) return null;
    const source = platformSourceFromRuntimeRoot(
      root,
      sessionId,
      inputId,
      (id) => (this.teamIdentity ? this.principalId(id) : null),
    );
    if (
      !source ||
      source.body === undefined ||
      source.sharedDefault !== grant.personalDefault ||
      !this.platformSourceReadable(source, scope, access, grant)
    )
      return null;
    let createdAt = source.createdAt;
    let text = source.body;
    if (messageId !== inputId) {
      const streamAttemptId = messageId.startsWith("stream:")
        ? messageId.slice("stream:".length)
        : null;
      if (streamAttemptId) {
        const snapshot = await this.platformPublicOutput(
          sessionId,
          root.id,
          streamAttemptId,
          access,
        );
        if (!snapshot) return null;
        createdAt = snapshot.createdAt;
        text = snapshot.text;
      } else {
        const attemptId = messageId.startsWith("publication:")
          ? messageId.slice("publication:".length)
          : null;
        const publication = attemptId
          ? await this.platformPublicationEvent(
              sessionId,
              root.id,
              attemptId,
              access,
            )
          : null;
        const event =
          publication?.event ??
          (attemptId
            ? null
            : await readEvent(
                `/api/sessions/${encodeURIComponent(sessionId)}/events/${encodeURIComponent(messageId)}`,
              ));
        if (!event) return null;
        const kind = [
          "chat/reply",
          "chat/outbound_message",
          "chat/progress",
          "chat/runtime_error",
          "session/io_state",
          "runtime/response_protocol_fused",
        ].includes(event.topic);
        const directRoot = [
          "root_turn_id",
          "trigger_event_id",
          "source_turn_id",
        ].some((key) => payloadString(event, key) === root.id);
        const published =
          payloadString(event, "text") ??
          payloadString(event, "error") ??
          payloadString(event, "message");
        if (!kind || !directRoot || !published) return null;
        createdAt = publication?.createdAt ?? event.timestamp;
        text = published;
      }
    }
    if (
      !this.platformSourceReadable(
        source,
        scope,
        access,
        await authorize(scope, access),
      )
    )
      return null;
    return {
      id: messageId,
      inputId,
      projectId: source.projectId,
      conversationId: source.conversationId,
      createdAt,
      text,
    };
  }

  /** Verify one quoted message at its owning Runtime Event, rather than
   * rebuilding an unbounded conversation history for every new input.
   * Platform grants and Runtime Session access are both rechecked.
   */
  async platformMessageSource(
    scope: { projectId: string; conversationId: string },
    access: AccessContext,
    messageId: string,
    inputId: string,
  ): Promise<{
    id: string;
    inputId: string;
    projectId: string;
    conversationId: string;
    createdAt: string;
    text: string;
  } | null> {
    const authorize = this.authorizePlatformRead;
    if (!authorize)
      throw new DomainError("invalid", "Platform 对话读取尚未接入。");
    // Only an input that has not reached Runtime can live in this Host's
    // private outbox. Once accepted, every Host resolves the same immutable
    // Runtime root and rechecks the current Platform grant.
    if (messageId === inputId) {
      const grant = await authorize(scope, access);
      const pending = this.platformReadDeliveries(scope, access, grant).filter(
        (item) => item.inputId === inputId && !item.rootId,
      );
      if (pending.length === 1) {
        const source = pending[0]!.platformSource!;
        if (
          source.projectId === scope.projectId &&
          source.conversationId === scope.conversationId
        ) {
          const current = await authorize(scope, access);
          if (
            this.platformReadDeliveries(scope, access, current).includes(
              pending[0]!,
            )
          )
            return {
              id: inputId,
              inputId,
              projectId: source.projectId,
              conversationId: source.conversationId,
              createdAt: source.createdAt,
              text: platformInputBody(pending[0]!),
            };
        }
      }
    }
    return this.remotePlatformMessageSource(
      scope,
      access,
      messageId,
      inputId,
      authorize,
    );
  }

  /** A message attachment is readable by a current conversation participant,
   * not by anyone who happens to know its content hash. Drafts are handled by
   * the uploader's own Store grant before this lookup is used.
   */
  async platformAttachmentOwner(assetId: string, access: AccessContext) {
    const authorize = this.authorizePlatformRead;
    if (!authorize) return null;
    const candidates = this.state.deliveries.filter((delivery) =>
      delivery.platformSource?.attachments?.some((a) => a.assetId === assetId),
    );
    for (const delivery of candidates) {
      const source = delivery.platformSource!;
      const scope = {
        projectId: source.projectId,
        conversationId: source.conversationId,
      };
      try {
        const grant = await authorize(scope, access);
        if (
          this.platformReadDeliveries(scope, access, grant).includes(delivery)
        )
          return source.author.principalId;
      } catch (error) {
        if (!(
          error instanceof DomainError || error instanceof PlatformStorageError
        ))
          throw error;
      }
    }
    return null;
  }

  /** Read an accepted message attachment from its Runtime-owned Event. The
   * sender Host's private outbox and draft Store are never cross-Host inputs. */
  async platformAcceptedAttachment(
    scope: { projectId: string; conversationId: string },
    access: AccessContext,
    inputId: string,
    assetId: string,
  ): Promise<{ mime: string; bytes: Buffer } | null> {
    if (
      !/^[a-zA-Z0-9_-]{1,200}$/.test(inputId) ||
      !/^[a-f0-9]{64}$/.test(assetId)
    )
      throw new DomainError("invalid", "消息附件来源无效。");
    const authorize = this.authorizePlatformRead;
    if (!authorize)
      throw new DomainError("invalid", "Platform 对话读取尚未接入。");
    const grant = await authorize(scope, access);
    const sessionId = this.objectSessionId(
      scope.projectId,
      scope.conversationId,
      grant.personalDefault,
    );
    let response: unknown;
    try {
      response = await this.request(
        `/api/sessions/${encodeURIComponent(sessionId)}/messages/by-client-id/${encodeURIComponent(inputId)}`,
        "GET",
        undefined,
        access,
        undefined,
      );
    } catch (error) {
      if (error instanceof UpstreamError && error.status === 404) return null;
      throw error;
    }
    const root = z.object({ event: eventSchema }).parse(response).event;
    const source = platformSourceFromRuntimeRoot(
      root,
      sessionId,
      inputId,
      (id) => (this.teamIdentity ? this.principalId(id) : null),
    );
    if (
      !source ||
      source.sharedDefault !== grant.personalDefault ||
      !this.platformSourceReadable(source, scope, access, grant)
    )
      return null;
    const declaration = source.attachments?.find(
      (item) => item.assetId === assetId,
    );
    if (!declaration) return null;
    const stored = z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          media_type: z.string(),
          size_bytes: z
            .number()
            .int()
            .positive()
            .max(20 * 1024 * 1024),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        }),
      )
      .safeParse(root.payload.attachments);
    if (!stored.success) return null;
    const attachment = stored.data.find(
      (item) =>
        item.name === declaration.name &&
        (!declaration.mime || item.media_type === declaration.mime) &&
        item.id === `attachment_${item.sha256}` &&
        createHash("sha256")
          .update(`${item.media_type}\0${item.sha256}`)
          .digest("hex") === assetId,
    );
    if (!attachment) return null;
    const value = (await this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/events/${encodeURIComponent(root.id)}/attachments/${encodeURIComponent(attachment.id)}`,
      "GET",
      undefined,
      access,
      undefined,
      "bytes",
    )) as { mime: string; bytes: Buffer };
    if (
      value.mime !== attachment.media_type ||
      value.bytes.byteLength !== attachment.size_bytes ||
      createHash("sha256").update(value.bytes).digest("hex") !==
        attachment.sha256
    )
      throw new Error("Runtime 消息附件的类型、大小或摘要不匹配。");
    const current = await authorize(scope, access);
    if (
      current.personalDefault !== source.sharedDefault ||
      !this.platformSourceReadable(source, scope, access, current)
    )
      throw new DomainError("forbidden", "消息附件授权已变化。");
    return value;
  }

  /** Platform checks the current reader. An exact input root attributes each
   * event; a personal default conversation retains authorized cross-project
   * history instead of filtering one Session by the selected project.
   */
  private platformTimelineEntry(
    item: SessionTimelineItem,
    sessionId: string,
    scope: { projectId: string; conversationId: string },
    access: AccessContext,
    grant: PlatformReadGrant,
  ): HistoryEntry | null {
    const root = item.display_kind === "input" ? item.event : item.root_event;
    if (!root || root.id !== item.root_turn_id) return null;
    const inputId = payloadString(root, "client_message_id");
    if (!inputId) return null;
    const source = platformSourceFromRuntimeRoot(
      root,
      sessionId,
      inputId,
      (id) => (this.teamIdentity ? this.principalId(id) : null),
    );
    if (
      !source ||
      source.body === undefined ||
      source.sharedDefault !== grant.personalDefault ||
      !this.platformSourceReadable(source, scope, access, grant)
    )
      return null;
    if (item.display_kind === "input") {
      if (item.entry_id !== inputId) return null;
      const input: PlatformConversationHistory["inputs"][number] = {
        id: inputId,
        projectId: source.projectId,
        conversationId: source.conversationId,
        author: source.author,
        targetActantId: source.targetActantId,
        body: source.body,
        ...(source.artifactId ? { artifactId: source.artifactId } : {}),
        ...(source.cognitiveObject
          ? { cognitiveObject: source.cognitiveObject }
          : {}),
        ...(source.cognitiveApplication
          ? { cognitiveApplication: source.cognitiveApplication }
          : {}),
        ...(source.artifactRevision
          ? { artifactRevision: source.artifactRevision }
          : {}),
        ...(source.selection ? { selection: source.selection } : {}),
        ...(source.reading ? { reading: source.reading } : {}),
        ...(source.continuation ? { continuation: source.continuation } : {}),
        ...(source.application ? { application: source.application } : {}),
        ...(source.browser ? { browser: source.browser } : {}),
        ...(source.textQuotes?.length ? { textQuotes: source.textQuotes } : {}),
        ...(source.attachments?.length
          ? { attachments: source.attachments }
          : {}),
        ...(source.localFile ? { localFile: source.localFile } : {}),
        ...(source.directories?.length
          ? { directories: source.directories }
          : {}),
        createdAt: source.createdAt,
      };
      return {
        kind: "input",
        id: item.entry_id,
        createdAt: item.visible_at,
        value: input,
      };
    }
    const text =
      payloadString(item.event, "text") ??
      payloadString(item.event, "error") ??
      payloadString(item.event, "message");
    if (!text) return null;
    // Runtime persists already-public model words as a non-final progress
    // timeline entry, independently from execution completion. They are a
    // visible reply, including after cancellation/restart, not inspector-only
    // progress. Preserve the same stream identity and completeness as the
    // existing live projection so the original exchange can render them.
    const publicOutput = item.event.topic === "runtime/model_public_output";
    const threadId = payloadString(item.event, "thread_id");
    const message: ConversationRuntime["messages"][number] = {
      id:
        !item.final_event && item.attempt_id
          ? "stream:" + item.attempt_id
          : item.entry_id,
      projectId: source.projectId,
      conversationId: source.conversationId,
      artifactId: null,
      inputId,
      rootId: root.id,
      ...(threadId ? { threadId } : {}),
      ...(item.attempt_id ? { publicationKey: item.attempt_id } : {}),
      ...(publicOutput
        ? {
            incomplete: item.event.payload.complete !== true,
            truncated: item.event.payload.truncated === true,
          }
        : {}),
      ...(item.event.sequence === undefined
        ? {}
        : { sequence: item.event.sequence }),
      text,
      createdAt: item.visible_at,
      kind: publicOutput ? "reply" : item.display_kind,
    };
    return {
      kind: "message",
      id: item.entry_id,
      createdAt: item.visible_at,
      value: message,
    };
  }

  /** Runtime owns accepted Session history; the local outbox contributes only
   * unaccepted inputs. Every immutable root is checked against the current
   * Platform grant before either the input or its output reaches a client. */
  async platformConversationHistory(
    scope: { projectId: string; conversationId: string },
    access: AccessContext,
    page: {
      before?: { createdAt: string; id: string };
      limit?: number;
    } = {},
  ): Promise<PlatformConversationHistory> {
    const authorize = this.authorizePlatformRead;
    if (!authorize)
      throw new DomainError("invalid", "Platform 对话读取尚未接入。");
    const grant = await authorize(scope, access);
    const readableProjects = new Set(grant.projectIds);
    const sessionId = this.objectSessionId(
      scope.projectId,
      scope.conversationId,
      grant.personalDefault,
    );
    const limit = Math.min(Math.max(page.limit ?? 100, 1), 100);
    const accepted: HistoryEntry[] = [];
    let before = page.before
      ? {
          visible_at_micros: historyTimeMicros(page.before.createdAt),
          entry_id: page.before.id,
        }
      : null;
    // The Runtime page is bounded, but filtering an authorized shared Session
    // could otherwise make this Host traverse its entire history in one HTTP
    // request. Carry the raw Runtime position across sparse visible pages.
    let scanBoundary: { createdAt: string; id: string } | null = null;
    for (
      let scanPage = 0;
      scanPage < 8 && accepted.length <= limit;
      scanPage++
    ) {
      const params = new URLSearchParams({ limit: "100" });
      if (before) {
        params.set("before_time_micros", String(before.visible_at_micros));
        params.set("before_entry_id", before.entry_id);
      }
      let raw: unknown;
      try {
        raw = await this.request(
          "/api/sessions/" +
            encodeURIComponent(sessionId) +
            "/timeline?" +
            params,
          "GET",
          undefined,
          access,
          undefined,
        );
      } catch (error) {
        if (error instanceof UpstreamError && error.status === 404) break;
        if (this.runtimeReadUnavailable(error)) {
          // Do not present an incomplete scan or cached accepted history as a
          // fresh Runtime read. The local portion below retains only exact
          // not-yet-accepted inputs authorized for this reader.
          accepted.length = 0;
          scanBoundary = null;
          break;
        }
        throw error;
      }
      const batch = sessionTimelinePageSchema.parse(raw);
      for (const item of [...batch.entries].reverse()) {
        const mapped = this.platformTimelineEntry(
          item,
          sessionId,
          scope,
          access,
          grant,
        );
        if (mapped) accepted.push(mapped);
        if (accepted.length > limit) break;
      }
      if (accepted.length > limit || !batch.next_before) break;
      if (
        before &&
        batch.next_before.visible_at_micros === before.visible_at_micros &&
        batch.next_before.entry_id === before.entry_id
      )
        throw new Error("Runtime 对话历史游标未前进。");
      before = batch.next_before;
      if (scanPage === 7)
        scanBoundary = historyCursorAtMicros(
          before.visible_at_micros,
          before.entry_id,
        );
    }
    const local = this.platformReadDeliveries(scope, access, grant).filter(
      (delivery) => delivery.sessionId === sessionId,
    );
    const pending: HistoryEntry[] = local.flatMap((delivery) => {
      const source = delivery.platformSource;
      if (!source || delivery.rootId) return [];
      const input: PlatformConversationHistory["inputs"][number] = {
        id: delivery.inputId,
        projectId: source.projectId,
        conversationId: source.conversationId,
        author: source.author,
        targetActantId: source.targetActantId,
        body: platformInputBody(delivery),
        ...(source.artifactId ? { artifactId: source.artifactId } : {}),
        ...(source.cognitiveObject
          ? { cognitiveObject: source.cognitiveObject }
          : {}),
        ...(source.cognitiveApplication
          ? { cognitiveApplication: source.cognitiveApplication }
          : {}),
        ...(source.artifactRevision
          ? { artifactRevision: source.artifactRevision }
          : {}),
        ...(source.selection ? { selection: source.selection } : {}),
        ...(source.reading ? { reading: source.reading } : {}),
        ...(source.continuation ? { continuation: source.continuation } : {}),
        ...(source.application ? { application: source.application } : {}),
        ...(source.browser ? { browser: source.browser } : {}),
        ...(source.textQuotes?.length ? { textQuotes: source.textQuotes } : {}),
        ...(source.attachments?.length
          ? { attachments: source.attachments }
          : {}),
        ...(source.localFile ? { localFile: source.localFile } : {}),
        ...(source.directories?.length
          ? { directories: source.directories }
          : {}),
        createdAt: source.createdAt,
      };
      const entry: HistoryEntry = {
        kind: "input",
        id: input.id,
        createdAt: input.createdAt,
        value: input,
      };
      return (page.before && historyOrder(entry, page.before) >= 0) ||
        (scanBoundary && historyOrder(entry, scanBoundary) < 0)
        ? []
        : [entry];
    });
    const byId = new Map<string, HistoryEntry>();
    for (const entry of [...pending, ...accepted])
      byId.set(entry.kind + ":" + entry.id, entry);
    const descending = [...byId.values()].sort((a, b) => historyOrder(b, a));
    const hasEarlier = descending.length > limit;
    const pageItems = descending.slice(0, limit).reverse();
    const visibleInputs = new Set(
      pageItems.filter((item) => item.kind === "input").map((item) => item.id),
    );
    const oldest = pageItems[0];
    return {
      inputs: pageItems.flatMap((item) =>
        item.kind === "input" ? [item.value] : [],
      ),
      nextCursor:
        hasEarlier && oldest
          ? historyCursorAtMicros(
              historyTimeMicros(oldest.createdAt),
              oldest.id,
            )
          : scanBoundary,
      runtime: {
        attention: {
          available: this.state.connected && this.attention.available,
          approvals: this.attention.approvals.filter(
            (approval) =>
              readableProjects.has(approval.scope.projectId) &&
              !!approval.scope.inputId &&
              visibleInputs.has(approval.scope.inputId),
          ),
        },
        ...(this.state.activity
          ? {
              activity: {
                ...this.state.activity,
                threads: this.platformActivityThreads(
                  readableProjects,
                  visibleInputs,
                  access,
                ),
                objectives: this.platformActivityObjectives(
                  readableProjects,
                  visibleInputs,
                ),
                schedules: this.platformActivitySchedules(
                  readableProjects,
                  visibleInputs,
                  access,
                ),
              },
            }
          : {}),
        configured: true,
        connected: this.state.connected,
        harnesses: this.state.connected ? this.loadedHarnesses : null,
        model: this.state.model,
        error: this.state.error,
        deliveries: local
          .filter((delivery) => visibleInputs.has(delivery.inputId))
          .map((delivery) => this.deliveryView(delivery)),
        messages: pageItems.flatMap((item) =>
          item.kind === "message" ? [item.value] : [],
        ),
      },
    };
  }

  /** A scoped cache token for the selected Runtime Session. Another Host's
   * accepted input must invalidate this Host's history cache without copying
   * the message or its delivery queue into Platform. */
  async platformConversationHead(
    scope: { projectId: string; conversationId: string },
    access: AccessContext,
  ): Promise<{ sessionId: string; latestSequence: number }> {
    const authorize = this.authorizePlatformRead;
    if (!authorize)
      throw new DomainError("invalid", "Platform 对话读取尚未接入。");
    const grant = await authorize(scope, access);
    const sessionId = this.objectSessionId(
      scope.projectId,
      scope.conversationId,
      grant.personalDefault,
    );
    try {
      const page = z
        .object({ latest_sequence: z.number().int().nonnegative().nullable() })
        .parse(
          await this.request(
            `/api/sessions/${encodeURIComponent(sessionId)}/events?limit=1`,
            "GET",
            undefined,
            access,
            undefined,
          ),
        );
      return { sessionId, latestSequence: page.latest_sequence ?? 0 };
    } catch (error) {
      if (error instanceof UpstreamError && error.status === 404)
        return { sessionId, latestSequence: 0 };
      if (this.runtimeReadUnavailable(error))
        return { sessionId, latestSequence: 0 };
      throw error;
    }
  }

  /** Status-only chrome for Platform clients. Message, delivery and execution
   * history must come from a scoped Platform-authorized conversation read;
   * the old Workspace is not a message or project authority here. */
  platformStatus(): ConversationRuntime {
    return {
      configured: true,
      connected: this.state.connected,
      harnesses: this.state.connected ? this.loadedHarnesses : null,
      model: this.state.model,
      error: this.state.error,
      deliveries: [],
      messages: [],
    };
  }

  /** Seeing another participant's execution does not grant its steering
   * capability. Both history and navigation must expose controls only to the
   * exact Human/Actant that submitted the immutable initiating input. */
  private platformActivityThreads(
    projects: ReadonlySet<string>,
    inputs: ReadonlySet<string>,
    access: AccessContext,
  ) {
    const continuable = new Set(
      this.state.deliveries.flatMap((delivery) => {
        const author = delivery.platformSource?.author;
        return author?.principalId === access.principalId &&
          author.actantId === access.actantId
          ? [delivery.inputId]
          : [];
      }),
    );
    return (this.state.activity?.threads ?? [])
      .filter(
        (thread) =>
          projects.has(thread.projectId) &&
          !!thread.inputId &&
          inputs.has(thread.inputId),
      )
      .map((thread) => {
        if (thread.inputId && continuable.has(thread.inputId)) return thread;
        const { continuation: _continuation, ...readOnly } = thread;
        return readOnly;
      });
  }

  private platformActivityObjectives(
    projects: ReadonlySet<string>,
    inputs: ReadonlySet<string>,
  ) {
    const threads = new Set(
      (this.state.activity?.threads ?? [])
        .filter(
          (thread) =>
            projects.has(thread.projectId) &&
            !!thread.inputId &&
            inputs.has(thread.inputId),
        )
        .map((thread) => thread.id),
    );
    return this.state.activity?.objectives
      ?.filter(
        (objective) =>
          projects.has(objective.projectId) && inputs.has(objective.inputId),
      )
      .map((objective) => ({
        ...objective,
        threadIds: objective.threadIds.filter((id) => threads.has(id)),
      }));
  }

  private platformActivitySchedules(
    projects: ReadonlySet<string>,
    inputs: ReadonlySet<string>,
    access: AccessContext,
  ) {
    return this.state.activity?.schedules?.filter((schedule) => {
      const source = this.activitySources.get(schedule.inputId);
      return (
        projects.has(schedule.projectId) &&
        inputs.has(schedule.inputId) &&
        source?.projectId === schedule.projectId &&
        source.conversationId === schedule.conversationId &&
        source.author.principalId === access.principalId &&
        source.author.actantId === access.actantId
      );
    });
  }

  /** Compact, authorization-scoped navigation state. Runtime remains the
   * source of message/activity time; Platform supplies current project grants.
   * No message body or history is copied into the global workspace refresh. */
  platformNavigationSnapshot(
    access: AccessContext,
    projectIds: readonly string[],
  ): {
    runtime: ConversationRuntime;
    activityByProject: Record<string, string>;
    historyVersion: string;
  } {
    const readable = new Set(projectIds);
    const activityByProject: Record<string, string> = {};
    const touch = (projectId: string, createdAt: string) => {
      if (
        !activityByProject[projectId] ||
        activityByProject[projectId] < createdAt
      )
        activityByProject[projectId] = createdAt;
    };
    const deliveriesBySession = new Map<string, StoredDelivery[]>();
    const allowedInputIds = new Set<string>();
    for (const delivery of this.state.deliveries) {
      const source = delivery.platformSource;
      if (!source) continue;
      if (!readable.has(source.projectId)) continue;
      if (
        !this.teamIdentity &&
        source.author.principalId !== access.principalId
      )
        continue;
      allowedInputIds.add(delivery.inputId);
      touch(source.projectId, source.createdAt);
      if (delivery.lastActivityAt)
        touch(source.projectId, delivery.lastActivityAt);
      const session = deliveriesBySession.get(delivery.sessionId) ?? [];
      session.push(delivery);
      deliveriesBySession.set(delivery.sessionId, session);
    }
    for (const [inputId, source] of this.activitySources) {
      if (
        !readable.has(source.projectId) ||
        (!this.teamIdentity && source.author.principalId !== access.principalId)
      )
        continue;
      allowedInputIds.add(inputId);
    }
    // An opaque, authorization-scoped invalidation token. The navigation
    // response never carries message bodies; the Client can reuse its current
    // conversation history only while these durable roots/cursors and grants
    // are identical. A shared default Session may contain several projects.
    const historyVersion = createHash("sha256")
      .update(
        JSON.stringify({
          principalId: access.principalId,
          projects: [...readable].sort(),
          sessions: [...deliveriesBySession.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([sessionId, deliveries]) => ({
              sessionId,
              cursor: this.state.sessions[sessionId]?.cursor ?? 0,
              deliveries: deliveries.map((delivery) => [
                delivery.inputId,
                delivery.state,
                delivery.rootId,
                delivery.acceptedEventId ?? null,
                delivery.error,
                delivery.cancelRequested,
                delivery.platformHeld,
              ]),
            })),
        }),
      )
      .digest("hex");
    return {
      activityByProject,
      historyVersion,
      runtime: {
        ...this.platformStatus(),
        attention: {
          available: this.state.connected && this.attention.available,
          approvals: this.attention.approvals.filter(
            (approval) =>
              readable.has(approval.scope.projectId) &&
              !!approval.scope.inputId &&
              allowedInputIds.has(approval.scope.inputId),
          ),
        },
        ...(this.state.activity
          ? {
              activity: {
                ...this.state.activity,
                threads: this.platformActivityThreads(
                  readable,
                  allowedInputIds,
                  access,
                ),
                objectives: this.platformActivityObjectives(
                  readable,
                  allowedInputIds,
                ),
                schedules: this.platformActivitySchedules(
                  readable,
                  allowedInputIds,
                  access,
                ),
              },
            }
          : {}),
        deliveries: [...deliveriesBySession.values()]
          .flat()
          .filter((delivery) =>
            ["queued", "sending", "running"].includes(delivery.state),
          )
          .map((delivery) => this.deliveryView(delivery)),
      },
    };
  }

  /** Historical Session identities remain readable by the Runtime. Only
   * Platform-authorized deliveries are current Host work. */
  private activeSessions() {
    return Object.values(this.state.sessions).filter(
      (session) => session.platform,
    );
  }
  private activeDeliveries() {
    return this.state.deliveries.filter(
      (delivery) =>
        !!delivery.platformSource &&
        this.state.sessions[delivery.sessionId]?.platform,
    );
  }
  private activityRefresh: Promise<void> | null = null;
  private refreshActivity() {
    if (!this.activityRefresh)
      this.activityRefresh = this.refreshActivityNow().finally(() => {
        this.activityRefresh = null;
      });
    return this.activityRefresh;
  }
  /** An explicit inventory read never dispatches the outbox or creates work. */
  async refreshPlatformActivity() {
    await this.as(
      this.teamIdentity
        ? { principalId: "morphz-service", actantId: "morphz-agent" }
        : localAccess,
      () => this.refreshActivity(),
    );
  }
  private async refreshActivityNow() {
    const activity: z.infer<typeof activitySchema> = {
      available: true,
      truncated: false,
      openWorkComplete: false,
      limit: 200,
      objectivesTruncated: false,
      objectives: [],
      schedulesAvailable: false,
      schedulesTruncated: false,
      schedules: [],
      threads: [],
    };
    const sessions = this.activeSessions();
    const sessionsById = new Map(
      sessions.map((session) => [session.id, session]),
    );
    const deliveries = this.activeDeliveries();
    const sources = new Map<string, PlatformInputSource>();
    const routes = new Map(
      deliveries
        .filter((d) => d.rootId)
        .map((d) => [
          `${d.sessionId}:${d.rootId}`,
          { inputId: d.inputId, source: d.platformSource!, rootId: d.rootId! },
        ]),
    );
    const routeKey = (sessionId: string, id: string, contextId: string) =>
      `${this.config.namespace}:${contextId}:${sessionId}:${id}:${this.actor().principalId}`;
    const scheduledSources = new Map<string, Set<string>>();
    const objectiveSources = new Map<string, string>();
    const threadRoots = new Map<string, string>();
    // Previously verified bindings supply an exact parent-root reference, not
    // project authority. resolveRoot still checks the initiating input below.
    for (const binding of Object.values(this.state.threadBindings)) {
      if (!sessionsById.has(binding.sessionId)) continue;
      threadRoots.set(
        routeKey(
          binding.sessionId,
          binding.id,
          this.contextId(binding.projectId),
        ),
        binding.rootId,
      );
    }
    let lookupBudget = 16;
    const resolveRoot = async (
      sessionId: string,
      eventId: string,
      contextId: string,
      visited = new Set<string>(),
    ): Promise<{
      inputId: string;
      source: PlatformInputSource;
      rootId: string;
    } | null> => {
      const key = routeKey(sessionId, eventId, contextId);
      if (visited.has(key)) return null;
      const nextVisited = new Set(visited).add(key);
      const local = routes.get(`${sessionId}:${eventId}`);
      if (local) return local;
      const cached = this.activityRootRoutes.get(key);
      // An enqueue may come from a later input. It must not reattribute a
      // real root that was already verified through the Runtime Event.
      if (cached?.route) return cached.route;
      const inherited = scheduledSources.get(key);
      if (inherited) {
        // Schedule.source_turn_id is a persisted Runtime causal link. Never
        // derive a parent ID from a synthetic root prefix or the selected UI.
        if (inherited.size !== 1) return null;
        const sourceId = [...inherited][0]!;
        const route = await resolveRoot(
          sessionId,
          sourceId,
          contextId,
          nextVisited,
        );
        const session = sessionsById.get(sessionId);
        return route &&
          session &&
          route.source.sharedDefault === session.sharedDefault &&
          this.contextId(route.source.projectId) === contextId &&
          this.objectSessionId(
            route.source.projectId,
            route.source.conversationId,
            route.source.sharedDefault,
          ) === sessionId
          ? route
          : null;
      }
      if (cached && (cached.route || Date.now() - cached.checkedAt < 30_000))
        return cached.route;
      if (lookupBudget-- <= 0) return null;
      let route: {
        inputId: string;
        source: PlatformInputSource;
        rootId: string;
      } | null = null;
      try {
        const event = z
          .object({ event: eventSchema })
          .parse(
            await this.request(
              `/api/sessions/${encodeURIComponent(sessionId)}/events/${encodeURIComponent(eventId)}`,
            ),
          ).event;
        if (
          event.id !== eventId ||
          payloadString(event, "session_id") !== sessionId
        )
          return null;
        const rootId = payloadString(event, "root_turn_id");
        if (rootId && rootId !== eventId) {
          route = await resolveRoot(sessionId, rootId, contextId, nextVisited);
        } else if (
          event.topic === "objective/scheduled_created" &&
          payloadString(event, "context_id") === contextId &&
          !!objectiveSources.get(key) &&
          objectiveSources.get(key) === payloadString(event, "objective_id")
        ) {
          const parentId = payloadString(event, "source_thread_id");
          const parentRoot = parentId
            ? threadRoots.get(routeKey(sessionId, parentId, contextId))
            : undefined;
          if (parentRoot) {
            const sourceRoute = await resolveRoot(
              sessionId,
              parentRoot,
              contextId,
              nextVisited,
            );
            const session = sessionsById.get(sessionId);
            if (
              sourceRoute &&
              session &&
              sourceRoute.source.sharedDefault === session.sharedDefault &&
              this.contextId(sourceRoute.source.projectId) === contextId &&
              this.objectSessionId(
                sourceRoute.source.projectId,
                sourceRoute.source.conversationId,
                sourceRoute.source.sharedDefault,
              ) === sessionId
            )
              route = sourceRoute;
          }
        } else {
          const inputId = payloadString(event, "client_message_id");
          const source = inputId
            ? platformSourceFromRuntimeRoot(event, sessionId, inputId, (id) =>
                this.teamIdentity ? this.principalId(id) : null,
              )
            : null;
          const session = sessionsById.get(sessionId);
          if (
            source &&
            inputId &&
            session &&
            source.sharedDefault === session.sharedDefault &&
            this.contextId(source.projectId) === contextId &&
            this.objectSessionId(
              source.projectId,
              source.conversationId,
              source.sharedDefault,
            ) === sessionId
          ) {
            route = { inputId, source, rootId: eventId };
          }
        }
      } catch {
        /* Missing provenance never becomes inferred project authority. */
      }
      this.activityRootRoutes.delete(key);
      this.activityRootRoutes.set(key, { checkedAt: Date.now(), route });
      while (this.activityRootRoutes.size > 400)
        this.activityRootRoutes.delete(
          this.activityRootRoutes.keys().next().value!,
        );
      return route;
    };
    try {
      const scheduleLink = z.object({
        id: z.string(),
        thread_id: z.string(),
        source_turn_id: z.string(),
        revision: z.number().int().positive().optional(),
        status: z.string().optional(),
        not_before: z.string().nullable().optional(),
        interval_seconds: z.number().int().positive().nullable().optional(),
        dependency_thread_ids: z.array(z.string()).optional(),
        intent: z.string().optional(),
        updated_at: z.string().optional(),
      });
      const scheduleRecord = scheduleLink.extend({
        revision: z.number().int().positive(),
        status: z.enum([
          "queued",
          "paused",
          "dispatched",
          "completed",
          "cancelled",
        ]),
        not_before: z.string().nullable(),
        interval_seconds: z.number().int().positive().nullable(),
        dependency_thread_ids: z.array(z.string()),
        intent: z.string(),
        updated_at: z.string(),
      });
      const schema = z.object({
        schedules: z.array(scheduleLink).optional(),
        detail_bounds: z
          .object({
            limit: z.number(),
            has_more_threads: z.boolean(),
            has_more_objectives: z.boolean().optional(),
            has_more_schedules: z.boolean().optional(),
          })
          .optional(),
        objectives: z
          .array(
            z.object({
              readiness: z.object({ state: z.string() }),
              objective: z.object({
                id: z.string(),
                context_id: z.string(),
                coordinator_session_id: z.string(),
                source_event_id: z.string(),
                stated_objective: z.string(),
                status: z.string(),
                status_reason: z.string().nullable(),
                parent_objective_id: z.string().nullable(),
                updated_at: z.string(),
              }),
            }),
          )
          .optional(),
        threads: z.array(
          z.object({
            response_annotations: z.unknown().optional(),
            intent: z.string().nullable().optional(),
            phase: z.string(),
            schedules: z.array(scheduleLink).optional(),
            outcome: z
              .object({
                terminal_kind: z.string(),
                disposition: z.string(),
                summary: z.string().nullable(),
                created_at: z.string(),
              })
              .nullable()
              .optional(),
            thread: z
              .object({
                id: z.string(),
                kind: z.string().optional(),
                session_id: z.string(),
                context_id: z.string(),
                root_turn_id: z.string(),
                lifecycle: z.string(),
                generation: z.unknown().optional(),
                control_state: z.string().optional(),
                created_at: z.string().optional(),
                supervision: z
                  .object({
                    supervisor_kind: z.string(),
                    supervisor_id: z.string().nullable(),
                    parent_thread_id: z.string().nullable().optional(),
                  })
                  .passthrough()
                  .optional(),
                revision: z.number(),
                updated_at: z.string(),
              })
              .passthrough(),
          }),
        ),
      });
      const snapshots: {
        contextId: string;
        active: z.infer<typeof schema>;
        history: z.infer<typeof schema>;
      }[] = [];
      for (const contextId of new Set(
        sessions.map((s) => this.contextId(s.projectId)),
      )) {
        const [active, history] = await Promise.all(
          [false, true].map(async (terminal) =>
            schema.parse(
              await this.request(
                `/api/contexts/${encodeURIComponent(contextId)}/scheduler?include_terminal=${terminal}&limit=200`,
              ),
            ),
          ),
        );
        snapshots.push({ contextId, active: active!, history: history! });
      }
      for (const { contextId, active, history } of snapshots) {
        const known = new Map(
          [...history.threads, ...active.threads].flatMap(({ thread }) =>
            sessionsById.has(thread.session_id) &&
            thread.context_id === contextId
              ? [[thread.id, thread] as const]
              : [],
          ),
        );
        for (const thread of known.values())
          threadRoots.set(
            routeKey(thread.session_id, thread.id, contextId),
            thread.root_turn_id,
          );
        const schedules = [
          ...(history.schedules ?? []),
          ...(active.schedules ?? []),
          ...[...history.threads, ...active.threads].flatMap((value) =>
            (value.schedules ?? []).filter(
              (schedule) => schedule.thread_id === value.thread.id,
            ),
          ),
        ];
        for (const schedule of schedules) {
          const thread = known.get(schedule.thread_id);
          if (
            !thread ||
            !schedule.source_turn_id ||
            schedule.source_turn_id === thread.root_turn_id
          )
            continue;
          const key = routeKey(
            thread.session_id,
            thread.root_turn_id,
            contextId,
          );
          const links = scheduledSources.get(key) ?? new Set<string>();
          links.add(schedule.source_turn_id);
          scheduledSources.set(key, links);
        }
        for (const { objective } of [
          ...(history.objectives ?? []),
          ...(active.objectives ?? []),
        ])
          if (
            objective.context_id === contextId &&
            sessionsById.has(objective.coordinator_session_id)
          )
            objectiveSources.set(
              routeKey(
                objective.coordinator_session_id,
                objective.source_event_id,
                contextId,
              ),
              objective.id,
            );
      }
      // include_terminal=false is the Runtime's bounded open-work inventory:
      // open Threads and active/paused/blocked Objectives. Its explicit bounds
      // can prove current coverage even when terminal history is incomplete.
      // This Host's tracked Platform Sessions define the authority domain.
      // An empty registry is a complete empty domain, not a statement about
      // unrelated Runtime Sessions; connection/availability remain separate.
      activity.openWorkComplete = snapshots.length > 0 || sessions.length === 0;
      for (const { active } of snapshots) {
        activity.openWorkComplete &&=
          !!active.detail_bounds &&
          !active.detail_bounds.has_more_threads &&
          active.detail_bounds.has_more_objectives === false &&
          !!active.objectives;
      }
      // Reserve the existing source-lookup budget for current work in every
      // Context before any terminal history. History must not starve an open
      // Thread or an Objective of its exact persisted initiating-input route.
      for (const { contextId, active } of snapshots) {
        for (const value of active.threads) {
          const t = value.thread;
          if (!sessionsById.has(t.session_id)) continue;
          if (
            t.context_id !== contextId ||
            t.lifecycle !== "open" ||
            !(await resolveRoot(t.session_id, t.root_turn_id, contextId))
          )
            activity.openWorkComplete = false;
        }
        for (const { objective } of active.objectives ?? []) {
          if (!sessionsById.has(objective.coordinator_session_id)) continue;
          if (
            objective.context_id !== contextId ||
            !["active", "paused", "blocked"].includes(objective.status) ||
            !(await resolveRoot(
              objective.coordinator_session_id,
              objective.source_event_id,
              contextId,
            ))
          )
            activity.openWorkComplete = false;
        }
      }
      // Current timers have the same source-lookup priority as open work.
      // Terminal history must not exhaust the bounded Event budget before a
      // future reminder's exact initiating root has been verified.
      for (const { contextId, active, history } of snapshots) {
        const owners = new Map(
          [...history.threads, ...active.threads].flatMap(({ thread }) =>
            sessionsById.has(thread.session_id) &&
            thread.context_id === contextId
              ? [[thread.id, thread] as const]
              : [],
          ),
        );
        for (const record of (active.schedules ?? []).slice(0, 200)) {
          const owner = owners.get(record.thread_id);
          if (
            owner &&
            (["queued", "paused"].includes(record.status ?? "") ||
              (record.status === "dispatched" &&
                record.interval_seconds != null))
          )
            await resolveRoot(
              owner.session_id,
              record.source_turn_id,
              contextId,
            );
        }
      }
      for (const { contextId, active, history } of snapshots) {
        activity.truncated ||= [active, history].some(
          (view) =>
            view.detail_bounds?.has_more_threads ?? view.threads.length >= 200,
        );
        // The existing Runtime caps its recent terminal query at limit (not
        // limit + 1). A full history page cannot prove there is no older row,
        // even when its detail_bounds flag is false.
        activity.truncated ||=
          history!.threads.length >= (history!.detail_bounds?.limit ?? 200);
        activity.objectivesTruncated ||=
          !history!.objectives ||
          (history!.detail_bounds?.has_more_objectives ??
            history!.objectives.length >= 200);
        const threads = new Map(
          history!.threads.map((value) => [value.thread.id, value]),
        );
        for (const value of active!.threads) {
          const previous = threads.get(value.thread.id);
          if (
            !previous ||
            value.thread.revision > previous.thread.revision ||
            value.thread.updated_at > previous.thread.updated_at ||
            (value.thread.revision === previous.thread.revision &&
              value.thread.updated_at === previous.thread.updated_at)
          )
            threads.set(value.thread.id, value);
        }
        for (const value of threads.values()) {
          const t = value.thread,
            session = sessionsById.get(t.session_id);
          if (!session || t.context_id !== contextId) continue;
          const delivery = deliveries.find(
            (d) => d.sessionId === t.session_id && d.rootId === t.root_turn_id,
          );
          const route = await resolveRoot(
            t.session_id,
            t.root_turn_id,
            contextId,
          );
          const source = route?.source;
          // A shared transport is not authority to guess an unknown work project.
          if (!source) {
            activity.truncated = true;
            if (t.lifecycle === "open") activity.openWorkComplete = false;
            continue;
          }
          sources.set(route!.inputId, source);
          activity.threads.push({
            id: t.id,
            kind: t.kind,
            projectId: source?.projectId ?? session.projectId,
            conversationId: source?.conversationId ?? discussionId(session),
            inputId: route!.inputId,
            rootId: t.root_turn_id,
            sessionId: t.session_id,
            contextId: t.context_id,
            title: value.intent?.trim() || source.body || "后台执行",
            ...(activityAnnotationFields(value.response_annotations, t) ?? {}),
            phase: value.phase,
            lifecycle: t.lifecycle,
            controlState: t.control_state,
            createdAt: t.created_at,
            parentThreadId: t.supervision?.parent_thread_id,
            ...(t.supervision?.supervisor_kind === "objective" &&
            t.supervision.supervisor_id
              ? { objectiveId: t.supervision.supervisor_id }
              : {}),
            ...(value.outcome
              ? {
                  outcome: {
                    terminalKind: value.outcome.terminal_kind,
                    disposition: value.outcome.disposition,
                    summary: value.outcome.summary,
                    createdAt: value.outcome.created_at,
                  },
                }
              : {}),
            revision: t.revision,
            updatedAt: t.updated_at,
            ...(source && delivery && this.state.directedInput
              ? { continuation: continuationTarget(t, delivery.inputId, t.id) }
              : {}),
          });
        }
        const objectives = new Map(
          (history.objectives ?? []).map((value) => [
            value.objective.id,
            value,
          ]),
        );
        for (const value of active.objectives ?? []) {
          const previous = objectives.get(value.objective.id);
          if (
            !previous ||
            value.objective.updated_at >= previous.objective.updated_at
          )
            objectives.set(value.objective.id, value);
        }
        for (const value of objectives.values()) {
          const objective = value.objective;
          if (
            objective.context_id !== contextId ||
            !sessionsById.has(objective.coordinator_session_id)
          )
            continue;
          const route = await resolveRoot(
            objective.coordinator_session_id,
            objective.source_event_id,
            contextId,
          );
          if (!route) {
            activity.objectivesTruncated = true;
            if (["active", "paused", "blocked"].includes(objective.status))
              activity.openWorkComplete = false;
            continue;
          }
          sources.set(route.inputId, route.source);
          activity.objectives!.push({
            id: objective.id,
            projectId: route.source.projectId,
            conversationId: route.source.conversationId,
            inputId: route.inputId,
            rootId: route.rootId,
            sessionId: objective.coordinator_session_id,
            title: objective.stated_objective,
            status: objective.status,
            statusReason: objective.status_reason,
            readiness: value.readiness.state,
            parentId: objective.parent_objective_id,
            threadIds: activity.threads
              .filter((thread) => thread.objectiveId === objective.id)
              .map((thread) => thread.id),
            updatedAt: objective.updated_at,
          });
        }
        const ownerThreads = new Map(
          [...history.threads, ...active.threads].flatMap(({ thread }) =>
            sessionsById.has(thread.session_id) &&
            thread.context_id === contextId
              ? [[thread.id, thread] as const]
              : [],
          ),
        );
        const records = new Map<string, z.infer<typeof scheduleLink>>();
        const conflictingIds = new Set<string>();
        for (const record of [
          ...(history.schedules ?? []),
          ...(active.schedules ?? []),
          ...[...history.threads, ...active.threads].flatMap((value) =>
            (value.schedules ?? []).filter(
              (schedule) => schedule.thread_id === value.thread.id,
            ),
          ),
        ]) {
          if (!scheduleRecord.safeParse(record).success)
            activity.schedulesTruncated = true;
          const previous = records.get(record.id);
          if (
            previous &&
            (previous.thread_id !== record.thread_id ||
              previous.source_turn_id !== record.source_turn_id)
          )
            conflictingIds.add(record.id);
          if (!previous || (record.revision ?? 0) >= (previous.revision ?? 0))
            records.set(record.id, record);
        }
        activity.schedulesTruncated ||=
          !active.schedules ||
          active.detail_bounds?.has_more_schedules !== false ||
          active.schedules.length >= (active.detail_bounds?.limit ?? 200);
        const candidates = [...records.values()].filter(
          (record) =>
            ["queued", "paused"].includes(record.status ?? "") ||
            (record.status === "dispatched" && record.interval_seconds != null),
        );
        if (candidates.length > 200) activity.schedulesTruncated = true;
        for (const raw of candidates.slice(0, 200)) {
          const parsed = scheduleRecord.safeParse(raw);
          const thread = ownerThreads.get(raw.thread_id);
          if (!parsed.success || !thread || conflictingIds.has(raw.id)) {
            activity.schedulesTruncated = true;
            continue;
          }
          const record = parsed.data;
          // Each schedule carries its own immutable caller root. Several
          // enqueues to one Thread must not be guessed into one input/project.
          const route = await resolveRoot(
            thread.session_id,
            record.source_turn_id,
            contextId,
          );
          const session = sessionsById.get(thread.session_id);
          if (
            !route ||
            !session ||
            route.source.sharedDefault !== session.sharedDefault ||
            this.contextId(route.source.projectId) !== contextId ||
            this.objectSessionId(
              route.source.projectId,
              route.source.conversationId,
              route.source.sharedDefault,
            ) !== thread.session_id
          ) {
            activity.schedulesTruncated = true;
            continue;
          }
          sources.set(route.inputId, route.source);
          activity.schedules!.push({
            scheduleId: record.id,
            threadId: thread.id,
            sessionId: thread.session_id,
            contextId,
            rootId: thread.root_turn_id,
            inputId: route.inputId,
            sourceTurnId: record.source_turn_id,
            sourceRootId: route.rootId,
            projectId: route.source.projectId,
            conversationId: route.source.conversationId,
            status: record.status,
            revision: record.revision,
            notBefore: record.not_before,
            intervalSeconds: record.interval_seconds,
            dependencyThreadIds: record.dependency_thread_ids,
            intent: record.intent,
            updatedAt: record.updated_at,
          });
        }
      }
      activity.schedulesAvailable = snapshots.every(
        ({ active }) => active.schedules !== undefined,
      );
      this.state.activity = activity;
      this.activitySources = sources;
      for (const thread of activity.threads)
        this.state.threadBindings[thread.id] = thread;
    } catch {
      // Keep the last known records but explicitly mark them stale. A scheduler
      // read failure must not cause message redelivery or fictitious completion.
      this.state.activity = {
        ...(this.state.activity ?? activity),
        available: false,
        schedulesAvailable: false,
        openWorkComplete: false,
      };
    }
    this.notifyWorkspaceChanges();
  }
  private async refreshAttention() {
    try {
      const data = z
        .object({ approvals: z.array(approvalSchema) })
        .parse(await this.request("/api/approvals"));
      const sessions = this.activeSessions();
      const sessionsById = new Map(
        sessions.map((session) => [session.id, session]),
      );
      const deliveries = this.activeDeliveries();
      const approvals: ExecutionAttention["approvals"] = [];
      for (const approval of data.approvals) {
        const request = approval.request;
        const session = sessionsById.get(request.session_id);
        if (
          !session ||
          request.context_id !== this.contextId(session.projectId)
        )
          continue;
        const thread = request.thread_id
          ? this.state.threadBindings[request.thread_id]
          : undefined;
        if (
          thread &&
          (thread.sessionId !== session.id ||
            (request.root_turn_id && thread.rootId !== request.root_turn_id))
        )
          continue;
        const root = request.root_turn_id ?? thread?.rootId;
        const delivery = root
          ? deliveries.find(
              (d) => d.sessionId === session.id && d.rootId === root,
            )
          : undefined;
        const source = delivery?.platformSource;
        // Shared default Sessions span work projects. Never infer ownership from
        // the selected page or transport session when the receipt is missing.
        if (session.sharedDefault && !source) continue;
        const projectId = source?.projectId ?? session.projectId;
        approvals.push({
          scope: {
            projectId,
            conversationId: source?.conversationId ?? discussionId(session),
            artifactId: source?.artifactId ?? session.artifactId,
            ...(source ? { inputId: delivery!.inputId } : {}),
            ...(thread ? { threadId: thread.id } : {}),
          },
          approval: { ...approval, fingerprint: approvalFingerprint(approval) },
        });
      }
      this.attention = { available: true, approvals };
    } catch {
      this.attention = { ...this.attention, available: false };
    }
  }
  private objectSessionId(
    projectId: string,
    conversationId: string,
    sharedDefault: boolean,
  ) {
    if (sharedDefault) projectId = conversationId;
    const key = createHash("sha256")
      .update(
        JSON.stringify(
          sharedDefault
            ? ["shared-default", conversationId]
            : conversationId === projectId
              ? [projectId, null]
              : [projectId, null, conversationId],
        ),
      )
      .digest("hex")
      .slice(0, 24);
    return `mw-${this.config.namespace.slice(0, 8)}-${key}`;
  }
  private objectSession(
    projectId: string,
    _artifactId: string | null,
    conversationId = projectId,
    sharedDefault = false,
  ) {
    // The conversation owns the transport; each delivery retains its work project.
    const sessionId = this.objectSessionId(
      projectId,
      conversationId,
      sharedDefault,
    );
    if (sharedDefault) projectId = conversationId;
    // Reuse the original project-level route when possible. Object routes remain
    // in the ledger and are still polled; no in-flight delivery is rewritten.
    this.state.sessions[sessionId] ??= {
      id: sessionId,
      projectId,
      conversationId,
      artifactId: null,
      scope: "workspace",
      sharedDefault,
      platform: false,
      cursor: 0,
      events: [],
      runtimePrincipalId: null,
      turnControl: false,
      schedules: false,
      hasWork: false,
    };
    this.state.sessions[sessionId]!.scope = "workspace";
    if (sharedDefault) this.state.sessions[sessionId]!.sharedDefault = true;
    return sessionId;
  }
  /** Host-only execution Session for a Platform task's authorized project.
   * It is separate from chat navigation, but uses the same Agent/Context and
   * one stable identity for every task run in this project. */
  async preparePlatformTaskSession(projectId: string) {
    const key = createHash("sha256")
      .update(JSON.stringify(["platform-task-run", projectId]))
      .digest("hex")
      .slice(0, 24);
    const id = `mw-${this.config.namespace.slice(0, 8)}-${key}`;
    const existing = this.state.sessions[id];
    if (
      existing &&
      (existing.projectId !== projectId ||
        !existing.platform ||
        existing.sharedDefault)
    )
      throw new DomainError("conflict", "事项执行会话绑定已变化。");
    this.state.sessions[id] ??= {
      id,
      projectId,
      conversationId: projectId,
      artifactId: null,
      scope: "workspace",
      sharedDefault: false,
      platform: true,
      cursor: 0,
      events: [],
      runtimePrincipalId: null,
      turnControl: false,
      schedules: false,
      hasWork: false,
    };
    await this.ensureSession(id);
    if (!this.state.sessions[id]!.schedules)
      throw new DomainError("invalid", "Runtime 未提供持久安排接口。");
    this.state.sessions[id]!.hasWork = true;
    this.save();
    return id;
  }
  /** A supplement stays on the original Runtime execution. The Platform
   * delivery, not a Client-selected project or legacy workspace input,
   * determines its sender, conversation, Session and root. */
  async validatePlatformContinuation(
    target: InputContinuation,
    projectId: string,
    conversationId: string,
  ) {
    if (target.mode !== "supplement")
      throw new DomainError("invalid", "此入口只接受运行中的工作补充。");
    const actor = this.actor();
    const original = this.state.deliveries.find(
      (delivery) =>
        delivery.inputId === target.inputId &&
        !!delivery.rootId &&
        !!delivery.platformSource &&
        !delivery.supplement,
    );
    const source = original?.platformSource;
    if (
      !original ||
      !source ||
      source.author.principalId !== actor.principalId ||
      source.author.actantId !== actor.actantId ||
      source.projectId !== projectId ||
      source.conversationId !== conversationId
    )
      throw new DomainError("forbidden", "补充目标不属于当前对话或发起者。");
    const authorize = this.authorizePlatformInput;
    if (!authorize)
      throw new DomainError("invalid", "Platform 消息授权尚未接入。");
    const route = await authorize({ ...source, phase: "dispatch" });
    if (route.sharedDefault !== source.sharedDefault)
      throw new DomainError("conflict", "原对话归属已变化，未发送补充。");
    await this.validateContinuationThread(target, original, source.projectId);
    return original;
  }
  private async validateContinuationThread(
    target: InputContinuation,
    delivery: StoredDelivery,
    projectId: string,
  ) {
    if (!this.supportsDirectedInput)
      throw new DomainError(
        "invalid",
        "当前 Runtime 尚未支持定向补充；草稿已保留，请更新连接后重试。",
      );
    let detail: unknown;
    try {
      detail = await this.request(
        `/api/contexts/${this.contextId(projectId)}/threads/${target.threadId}`,
      );
    } catch (e) {
      if (e instanceof UpstreamError && e.status === 404)
        throw new ContinuationConflict("closed");
      throw e;
    }
    const thread = z
      .object({
        snapshot: z.object({
          thread: z
            .object({
              id: z.string(),
              session_id: z.string(),
              context_id: z.string(),
              root_turn_id: z.string(),
              initiating_principal_id: z.string().nullable(),
            })
            .passthrough(),
        }),
      })
      .parse(detail).snapshot.thread;
    const expectedPrincipal = this.teamIdentity
      ? this.principalId(this.actor().principalId)
      : this.state.sessions[delivery.sessionId]?.runtimePrincipalId;
    if (
      thread.id !== target.threadId ||
      thread.session_id !== delivery.sessionId ||
      thread.context_id !== this.contextId(projectId) ||
      thread.root_turn_id !== delivery.rootId ||
      !expectedPrincipal ||
      thread.initiating_principal_id !== expectedPrincipal
    )
      throw new DomainError("forbidden", "补充目标不属于原请求，未发送。");
    const current = continuationTarget(thread, delivery.inputId, thread.id);
    if (!current) throw new ContinuationConflict("closed");
    if (
      current.generation !== target.generation ||
      current.objective?.id !== target.objective?.id ||
      current.objective?.generation !== target.objective?.generation
    )
      throw new ContinuationConflict("changed");
  }
  async confirmSupplement(inputId: string) {
    const initial = this.state.deliveries.find((d) => d.inputId === inputId);
    if (!initial?.supplement) return;
    const deadline = Date.now() + 12000;
    if (initial.state === "queued") void this.tick();
    while (Date.now() < deadline) {
      const delivery = this.state.deliveries.find((d) => d.inputId === inputId);
      if (!delivery?.supplement) return;
      if (delivery.acceptedEventId) return;
      if (delivery.rejection === "closed" || delivery.rejection === "changed")
        throw new ContinuationConflict(delivery.rejection);
      if (delivery.rejection === "forbidden")
        throw new DomainError("forbidden", "原工作不再允许补充，草稿已保留。");
      if (delivery.rejection === "invalid")
        throw new DomainError(
          "invalid",
          delivery.error || "补充未送达，请检查输入；草稿已保留。",
        );
      if (delivery.state === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new SupplementUnconfirmed();
  }
  /** New Platform-scoped plain input. The immutable Runtime request is the
   * durable outbox entry; no project, conversation or input is written into
   * the legacy Workspace snapshot.
   */
  async enqueuePlatformInput(
    input: RecordedInput,
    newConversation?: { title: string },
  ) {
    // The new reference is an independent snapshot before any awaited policy.
    input = {
      ...input,
      ...(input.cognitiveApplication
        ? {
            cognitiveApplication: parseCognitiveAppApplicationTarget(
              input.cognitiveApplication,
            ),
          }
        : {}),
      ...(input.cognitiveObject
        ? {
            cognitiveObject: parseCognitiveAppObjectLocator(
              input.cognitiveObject,
            ),
          }
        : {}),
    };
    if (
      input.continuation &&
      (input.cognitiveObject || input.cognitiveApplication)
    )
      throw new DomainError("invalid", "补充不能指定另一个认知应用原件。");
    const actor = this.actor();
    if (
      input.author.principalId !== actor.principalId ||
      input.author.actantId !== actor.actantId ||
      (!input.body.trim() &&
        !input.textQuotes?.length &&
        !input.attachments?.length &&
        !input.localFile &&
        !input.directories?.length) ||
      !!input.artifactId !== !!input.artifactRevision ||
      (!input.artifactId && (input.selection || input.reading)) ||
      !coherentCognitiveAppInput(input) ||
      !coherentCognitiveAppApplicationInput(input) ||
      (input.continuation &&
        (input.continuation.mode !== "supplement" ||
          !!newConversation ||
          !!input.application ||
          !!input.browser ||
          !!input.reading ||
          !!input.scriptGeneration ||
          !!input.localFile ||
          !!input.directories?.length ||
          !!input.selection ||
          (input.dispatchMode !== undefined &&
            input.dispatchMode !== "parallel") ||
          !!input.model ||
          !!input.reasoningEffort))
    )
      throw new DomainError("invalid", "这条输入需要使用已接入的应用来源。");
    const authorize = this.authorizePlatformInput;
    if (!authorize)
      throw new DomainError("invalid", "Platform 消息授权尚未接入。");
    let previous = this.state.deliveries.find((d) => d.inputId === input.id);
    // Receipt retries inherit their already-persisted reference without a new
    // live Thread/generation check. Only a NEW supplement admits live work.
    const inheritedSource = input.continuation
      ? (previous?.platformSource ??
        this.state.deliveries.find(
          (delivery) =>
            delivery.inputId === input.continuation!.inputId &&
            !!delivery.rootId &&
            !delivery.supplement &&
            delivery.platformSource?.author.principalId ===
              input.author.principalId &&
            delivery.platformSource.author.actantId === input.author.actantId &&
            delivery.platformSource.projectId === input.projectId &&
            delivery.platformSource.conversationId === discussionId(input),
        )?.platformSource)
      : undefined;
    if (inheritedSource?.cognitiveObject)
      input = {
        ...input,
        cognitiveObject: parseCognitiveAppObjectLocator(
          inheritedSource.cognitiveObject,
        ),
      };
    if (inheritedSource?.cognitiveApplication)
      input = {
        ...input,
        cognitiveApplication: parseCognitiveAppApplicationTarget(
          inheritedSource.cognitiveApplication,
        ),
        ...(inheritedSource.application
          ? { application: structuredClone(inheritedSource.application) }
          : {}),
      };
    const target: PlatformInputTarget = {
      projectId: input.projectId,
      conversationId: discussionId(input),
      targetActantId: input.targetActantId,
      author: input.author,
      ...(input.artifactId ? { artifactId: input.artifactId } : {}),
      ...(input.cognitiveObject
        ? { cognitiveObject: input.cognitiveObject }
        : {}),
      ...(input.cognitiveApplication
        ? { cognitiveApplication: input.cognitiveApplication }
        : {}),
      ...(input.artifactRevision
        ? { artifactRevision: input.artifactRevision }
        : {}),
      ...(input.selection ? { selection: input.selection } : {}),
      ...(input.reading ? { reading: input.reading } : {}),
      ...(input.continuation ? { continuation: input.continuation } : {}),
      ...(input.application ? { application: input.application } : {}),
      ...(input.browser ? { browser: input.browser } : {}),
      ...(input.localFile ? { localFile: input.localFile } : {}),
      ...(input.directories?.length ? { directories: input.directories } : {}),
      ...(newConversation
        ? {
            firstInputId: input.id,
            newConversationTitle: newConversation.title,
          }
        : {}),
      // An accepted command retry reads its immutable receipt. It cannot
      // acquire a new file grant or cause another dispatch. Identity and
      // project/conversation authority are still checked by the Host.
      phase:
        previous?.rootId || previous?.acceptedEventId ? "receipt" : "prepare",
    };
    const route = await authorize(target);
    if (input.attachments?.length && !this.messageAttachments)
      throw new DomainError("invalid", "消息附件 Store 不可用，未发送。");
    const resourceUploads = [] as Array<{
      stageId: string;
      name: string;
      mediaType: string;
      assetId: string;
      sha256: string;
      ready: boolean;
    }>;
    for (const [index, attachment] of (input.attachments ?? []).entries()) {
      const value = await this.messageAttachments!.readForDispatch(
        input.author,
        attachment,
      );
      resourceUploads.push({
        stageId: `work-${createHash("sha256").update(`${input.id}:${index}`).digest("hex")}`,
        name: attachment.name,
        mediaType: value.mime,
        assetId: attachment.assetId,
        sha256: createHash("sha256").update(value.bytes).digest("hex"),
        ready: false,
      });
    }
    const platformSource: PlatformInputSource = {
      projectId: target.projectId,
      conversationId: target.conversationId,
      targetActantId: target.targetActantId,
      author: target.author,
      ...(target.firstInputId ? { firstInputId: target.firstInputId } : {}),
      ...(target.newConversationTitle
        ? { newConversationTitle: target.newConversationTitle }
        : {}),
      createdAt: input.createdAt,
      body: input.body,
      ...(input.artifactId ? { artifactId: input.artifactId } : {}),
      ...(input.cognitiveObject
        ? { cognitiveObject: input.cognitiveObject }
        : {}),
      ...(input.cognitiveApplication
        ? { cognitiveApplication: input.cognitiveApplication }
        : {}),
      ...(input.artifactRevision
        ? { artifactRevision: input.artifactRevision }
        : {}),
      ...(input.selection ? { selection: input.selection } : {}),
      ...(input.reading ? { reading: input.reading } : {}),
      ...(input.continuation ? { continuation: input.continuation } : {}),
      ...(input.application ? { application: input.application } : {}),
      ...(input.browser ? { browser: input.browser } : {}),
      ...(input.textQuotes?.length
        ? { textQuotes: textQuotesSchema.parse(input.textQuotes) }
        : {}),
      ...(input.attachments?.length
        ? {
            attachments: input.attachments.map((attachment) =>
              inputAttachmentSchema.parse(attachment),
            ),
          }
        : {}),
      ...(input.localFile ? { localFile: input.localFile } : {}),
      ...(input.directories?.length ? { directories: input.directories } : {}),
      ...(input.scriptGeneration
        ? {
            scriptGeneration: scriptGenerationSchema.parse(
              input.scriptGeneration,
            ),
          }
        : {}),
      sharedDefault: route.sharedDefault,
    };
    let model = input.model;
    if (
      !model &&
      !previous &&
      input.continuation?.mode !== "supplement" &&
      !this.teamIdentity
    ) {
      // Freeze the local Runtime default before the durable outbox write.
      // Omitting it would inherit an existing Session's older model. Gateway
      // clients have no operator access to this setting; their Runtime owns it.
      const current = z
        .object({ model: z.string().trim().min(1).max(256) })
        .safeParse(await this.request("/api/status"));
      if (!current.success)
        throw new DomainError(
          "invalid",
          "无法确认默认模型，请检查模型设置后重试；草稿已保留。",
        );
      model = current.data.model;
    }
    // Authorization, uploads and the default read can await another admission
    // of this command. The first durable envelope still wins that race.
    previous ??= this.state.deliveries.find((d) => d.inputId === input.id);
    if (previous && !input.model && input.continuation?.mode !== "supplement")
      // A retry belongs to its admitted request. Missing aliases stay missing
      // on retained requests, even when today's Runtime default has changed.
      model = z
        .object({ model_alias: z.string().optional() })
        .parse(previous.request.activation ?? {}).model_alias;
    const prepared = workInputRequest(input, model);
    const activation: Record<string, unknown> = { ...prepared.activation };
    if (previous) {
      const retained =
        previous.request.io_version === "1"
          ? (previous.request.activation as Record<string, unknown> | undefined)
              ?.dispatch_mode
          : previous.request.dispatch_mode;
      // Omission on an admitted typed request meant parallel historically.
      // Preserve even its omitted field, not merely an equivalent new value.
      // A caller cannot convert the same command into a different dispatch.
      if (
        input.dispatchMode !== undefined &&
        input.dispatchMode !== (retained ?? "parallel")
      )
        throw new DomainError("conflict", "操作标识已用于另一条输入。");
      if (retained === undefined) delete activation.dispatch_mode;
      else activation.dispatch_mode = retained;
      const retainedAnnotations =
        previous.request.io_version === "1"
          ? (previous.request.activation as Record<string, unknown> | undefined)
              ?.response_annotations
          : previous.request.response_annotations;
      // Upgrading the client must not alter an admitted envelope/fingerprint,
      // including the historical absence of this optional selection.
      if (retainedAnnotations === undefined)
        delete activation.response_annotations;
      else activation.response_annotations = retainedAnnotations;
    }
    const typed = {
      ...prepared,
      activation,
      client_metadata: {
        kind: "morphz.platform-input",
        version: 1,
        // Admission time is part of the original display identity. Reusing an
        // input command must not replace it with the time of a later retry.
        source: previous?.platformSource ?? platformSource,
      },
    };
    const candidate = resourceUploads.length
      ? {
          ...typed,
          message: {
            ...typed.message,
            content: {
              ...typed.message.content,
              value: {
                ...typed.message.content.value,
                attachments: resourceUploads.map((upload) => ({
                  stage_id: upload.stageId,
                })),
              },
            },
          },
        }
      : typed;
    // An admitted request is immutable. A pre-upgrade queued delivery must
    // retry its original envelope, not acquire metadata under the same ID.
    const request =
      previous && !("client_metadata" in previous.request)
        ? (({ client_metadata: _metadata, ...originalShape }) => originalShape)(
            candidate,
          )
        : candidate;
    if (previous) {
      if (
        previous.platformSource?.projectId !== platformSource.projectId ||
        previous.platformSource.conversationId !==
          platformSource.conversationId ||
        previous.platformSource.targetActantId !==
          platformSource.targetActantId ||
        previous.platformSource.author.principalId !==
          platformSource.author.principalId ||
        previous.platformSource.author.actantId !==
          platformSource.author.actantId ||
        previous.platformSource.firstInputId !== platformSource.firstInputId ||
        previous.platformSource.newConversationTitle !==
          platformSource.newConversationTitle ||
        previous.platformSource.body !== platformSource.body ||
        previous.platformSource.artifactId !== platformSource.artifactId ||
        previous.platformSource.artifactRevision !==
          platformSource.artifactRevision ||
        !sameCognitiveAppObjectLocator(
          previous.platformSource.cognitiveObject,
          platformSource.cognitiveObject,
        ) ||
        !sameCognitiveAppApplicationTarget(
          previous.platformSource.cognitiveApplication,
          platformSource.cognitiveApplication,
        ) ||
        previous.platformSource.selection !== platformSource.selection ||
        JSON.stringify(previous.platformSource.reading) !==
          JSON.stringify(platformSource.reading) ||
        JSON.stringify(previous.platformSource.continuation) !==
          JSON.stringify(platformSource.continuation) ||
        JSON.stringify(previous.platformSource.application) !==
          JSON.stringify(platformSource.application) ||
        JSON.stringify(previous.platformSource.browser) !==
          JSON.stringify(platformSource.browser) ||
        JSON.stringify(previous.platformSource.attachments) !==
          JSON.stringify(platformSource.attachments) ||
        JSON.stringify(previous.platformSource.localFile) !==
          JSON.stringify(platformSource.localFile) ||
        JSON.stringify(previous.platformSource.directories) !==
          JSON.stringify(platformSource.directories) ||
        JSON.stringify(previous.platformSource.scriptGeneration) !==
          JSON.stringify(platformSource.scriptGeneration) ||
        previous.platformSource.sharedDefault !==
          platformSource.sharedDefault ||
        JSON.stringify(previous.request) !== JSON.stringify(request)
      )
        throw new DomainError("conflict", "操作标识已用于另一条输入。");
      if (
        previous.state === "failed" &&
        !previous.rootId &&
        !previous.acceptedEventId &&
        !previous.rejection
      ) {
        previous.state = "queued";
        previous.error = null;
        this.save(previous);
      }
      return input.id;
    }
    const originalDelivery = input.continuation
      ? await this.validatePlatformContinuation(
          input.continuation,
          target.projectId,
          target.conversationId,
        )
      : undefined;
    if (
      originalDelivery &&
      (originalDelivery.platformSource?.targetActantId !==
        input.targetActantId ||
        (originalDelivery.platformSource.artifactId ?? null) !==
          (input.artifactId ?? null) ||
        (originalDelivery.platformSource.artifactRevision ?? null) !==
          (input.artifactRevision ?? null) ||
        !sameCognitiveAppObjectLocator(
          originalDelivery.platformSource.cognitiveObject,
          input.cognitiveObject,
        ) ||
        !sameCognitiveAppApplicationTarget(
          originalDelivery.platformSource.cognitiveApplication,
          input.cognitiveApplication,
        ) ||
        (input.cognitiveApplication &&
          JSON.stringify(originalDelivery.platformSource.application) !==
            JSON.stringify(input.application)))
    )
      throw new DomainError("forbidden", "补充不能更换原工作的对象或接收者。");
    const sessionId =
      originalDelivery?.sessionId ??
      this.objectSession(
        input.projectId,
        null,
        target.conversationId,
        route.sharedDefault,
      );
    this.state.sessions[sessionId]!.platform = true;
    this.state.deliveries.push({
      inputId: input.id,
      sessionId,
      rootId: null,
      runtimePostAttempted: false,
      state: "queued",
      error: null,
      retryable: false,
      cancelRequested: false,
      causalThreadIds: [],
      request,
      ...(input.continuation?.mode === "supplement"
        ? { supplement: "pending" as const }
        : {}),
      ...(resourceUploads.length ? { resourceUploads } : {}),
      platformSource,
      platformHeld: !!newConversation,
    });
    this.save(this.state.deliveries.at(-1)!);
    if (!newConversation) void this.tick();
    return input.id;
  }
  async releasePlatformInput(inputId: string) {
    const actor = this.actor();
    const delivery = this.state.deliveries.find(
      (item) => item.inputId === inputId,
    );
    const source = delivery?.platformSource;
    if (
      !source ||
      source.firstInputId !== inputId ||
      source.author.principalId !== actor.principalId ||
      source.author.actantId !== actor.actantId
    )
      throw new DomainError("forbidden", "首条消息不属于当前用户。");
    const authorize = this.authorizePlatformInput;
    if (!authorize)
      throw new DomainError("invalid", "Platform 消息授权尚未接入。");
    const route = await authorize({ ...source, phase: "dispatch" });
    if (route.sharedDefault !== source.sharedDefault)
      throw new DomainError("conflict", "对话归属已变化，未发送。");
    if (delivery.platformHeld) {
      delivery.platformHeld = false;
      this.save(delivery);
      void this.tick();
    }
  }
  /** Retry only an unaccepted Platform input owned by this Human. The saved
   * Runtime request keeps its original input and client-message identities. */
  async retryPlatformInput(inputId: string) {
    const actor = this.actor();
    const delivery = this.state.deliveries.find(
      (item) => item.inputId === inputId,
    );
    const source = delivery?.platformSource;
    if (
      !source ||
      source.author.principalId !== actor.principalId ||
      source.author.actantId !== actor.actantId
    )
      throw new DomainError("forbidden", "这条消息不属于当前用户。");
    const authorize = this.authorizePlatformInput;
    if (!authorize)
      throw new DomainError("invalid", "Platform 消息授权尚未接入。");
    const route = await authorize({ ...source, phase: "dispatch" });
    if (route.sharedDefault !== source.sharedDefault)
      throw new DomainError("conflict", "对话归属已变化，未发送。");
    if (delivery.platformHeld) {
      // The first input may have been admitted before its conversation was
      // committed. Dispatch authorization above verifies that commit now.
      if (
        delivery.state !== "queued" &&
        !(
          delivery.state === "failed" &&
          !delivery.rootId &&
          !delivery.acceptedEventId &&
          !delivery.rejection
        )
      )
        throw new DomainError("conflict", "这条消息的送达状态尚未确认。");
      delivery.state = "queued";
      delivery.error = null;
      delivery.platformHeld = false;
      this.save(delivery);
      void this.tick();
      return;
    }
    if (
      delivery.state !== "failed" ||
      delivery.rootId ||
      delivery.acceptedEventId ||
      delivery.rejection
    )
      throw new DomainError(
        "conflict",
        "这条消息已发送或送达状态尚未确认，不能重复投递。",
      );
    delivery.state = "queued";
    delivery.error = null;
    this.save(delivery);
    void this.tick();
  }
  platformInputFingerprint(inputId: string) {
    const actor = this.actor();
    const delivery = this.state.deliveries.find(
      (item) => item.inputId === inputId,
    );
    const source = delivery?.platformSource;
    if (
      !source ||
      source.firstInputId !== inputId ||
      source.author.principalId !== actor.principalId ||
      source.author.actantId !== actor.actantId
    )
      throw new DomainError("forbidden", "首条消息不属于当前用户。");
    return createHash("sha256")
      .update(JSON.stringify(delivery.request))
      .digest("hex");
  }
  private async ensureSession(id: string) {
    return this.serialSessionPolicy(id, () => this.ensureSessionPolicy(id));
  }
  private async ensureSessionPolicy(id: string) {
    const contextId = this.contextId(this.state.sessions[id]!.projectId);
    let session: z.infer<typeof permissionSessionSchema>;
    try {
      session = permissionSessionSchema.parse(
        await this.request(`/api/sessions/${id}`),
      );
    } catch (error) {
      if (!(error instanceof UpstreamError) || error.status !== 404)
        throw error;
      // Save before attempting creation, including a lost POST response. The
      // receipt survives restart; a later GET/409 cannot bypass initialization.
      this.state.sessions[id]!.permissionInitializationRequired = true;
      this.save();
      try {
        try {
          session = permissionSessionSchema.parse(
            await this.request("/api/sessions", "POST", {
              id,
              title: "Morphz",
              mount: { type: "existing_context", context_id: contextId },
            }),
          );
        } catch (missing) {
          if (!(missing instanceof UpstreamError) || missing.status !== 404)
            throw missing;
          session = permissionSessionSchema.parse(
            await this.request("/api/sessions", "POST", {
              id,
              title: "Morphz",
              mount: {
                type: "new_blank_context",
                context_id: contextId,
                context_title: "Morphz",
              },
            }),
          );
        }
      } catch (e) {
        if (e instanceof UpstreamError && e.status === 409)
          session = permissionSessionSchema.parse(
            await this.request(`/api/sessions/${id}`),
          );
        else throw e;
      }
    }
    if (session.id !== id || session.context_id !== contextId)
      throw new Error("会话绑定不匹配，已停止发送。");
    const binding = this.state.sessions[id]!;
    try {
      const identity = z
        .object({
          principal_id: z.string().min(1),
          session_id: z.literal(id),
          context_id: z.literal(contextId),
          capabilities: z.array(z.string()).default([]),
        })
        .parse(await this.request(`/api/sessions/${id}/principal`));
      if (
        binding.runtimePrincipalId &&
        binding.runtimePrincipalId !== identity.principal_id
      )
        throw new Error("Runtime 会话身份发生变化，已停止发送。");
      binding.runtimePrincipalId = identity.principal_id;
      if (
        this.teamIdentity &&
        identity.principal_id !== this.principalId("morphz-service")
      )
        throw new Error("Runtime 未提供可信网关身份，停止发送。");
      binding.turnControl = identity.capabilities.includes(
        "session_turn_control",
      );
      binding.schedules = identity.capabilities.includes("session_schedules");
    } catch (error) {
      // An older Runtime may chat normally, but cannot obtain Work tool authority.
      if (
        !(error instanceof UpstreamError) ||
        ![404, 405].includes(error.status)
      )
        throw error;
      binding.runtimePrincipalId = null;
      binding.turnControl = false;
    }
    if (binding.permissionInitializationRequired) {
      if (session.permission_mode == null && session.sandbox_mode == null) {
        await this.request(`/api/sessions/${id}`, "PATCH", {
          permission_mode: "request_approval",
        });
        const policy = permissionSessionSchema.parse(
          await this.request(`/api/sessions/${id}`),
        );
        if (
          policy.id !== id ||
          policy.context_id !== contextId ||
          policy.permission_mode !== "request_approval" ||
          policy.sandbox_mode != null
        )
          throw new DomainError(
            "conflict",
            "新会话的安全审批方式尚未确认，已停止发送。",
          );
      }
      // A 409/restart may now observe a durable explicit Runtime choice, e.g.
      // our safe PATCH completed with a lost receipt, or the Human changed it
      // in Dashboard. Do not overwrite that authority with a Host default.
      delete binding.permissionInitializationRequired;
    }
    this.save();
  }
  start() {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 1200);
    this.timer.unref();
  }
  async cancelPlatformInput(inputId: string, access: AccessContext) {
    const delivery = this.state.deliveries.find((d) => d.inputId === inputId);
    const source = delivery?.platformSource;
    if (!delivery || !source)
      throw new DomainError("not_found", "输入不存在。");
    if (
      source.author.principalId !== access.principalId ||
      source.author.actantId !== access.actantId
    )
      throw new DomainError("forbidden", "只能停止自己发送的消息。");
    const authorize = this.authorizePlatformRead;
    if (!authorize) throw new DomainError("forbidden", "当前对话授权不可用。");
    const scope = {
      projectId: source.projectId,
      conversationId: source.conversationId,
    };
    const grant = await authorize(scope, access);
    if (!this.platformReadDeliveries(scope, access, grant).includes(delivery))
      throw new DomainError("forbidden", "这条消息已不可访问。");
    this.requestInputCancellation(delivery);
  }
  private requestInputCancellation(delivery: StoredDelivery | undefined) {
    if (
      !delivery ||
      ["completed", "failed", "cancelled"].includes(delivery.state)
    )
      throw new DomainError("conflict", "这条输入没有正在进行的处理。");
    if (delivery.state === "queued") {
      delivery.state = "cancelled";
      delivery.error = null;
      this.save(delivery);
      return;
    }
    if (delivery.state === "sending" || !delivery.rootId)
      throw new DomainError(
        "conflict",
        "发送回执尚未确认，暂时不能确认停止。请待状态更新后再试。",
      );
    if (!this.state.sessions[delivery.sessionId]?.turnControl)
      throw new DomainError(
        "invalid",
        "当前 Runtime 尚不支持按输入停止，请升级后使用。",
      );
    delivery.cancelRequested = true;
    delivery.error = null;
    this.save(delivery);
    void this.tick();
  }
  private async processCancellations() {
    for (const delivery of this.activeDeliveries()) {
      if (
        !delivery.cancelRequested ||
        delivery.state !== "running" ||
        !delivery.rootId
      )
        continue;
      const viewSchema = z.object({
        thread_id: z.string(),
        session_id: z.literal(delivery.sessionId),
        root_turn_id: z.literal(delivery.rootId),
        revision: z.number().int().positive(),
        lifecycle: z.enum(["open", "completed", "failed", "cancelled"]),
      });
      const path = `/api/sessions/${encodeURIComponent(delivery.sessionId)}/turns/${encodeURIComponent(delivery.rootId)}/thread`;
      const source = delivery.platformSource;
      if (!source) continue;
      const access = source.author;
      try {
        let view = viewSchema.parse(
          await this.request(path, "GET", undefined, access, undefined),
        );
        if (view.lifecycle === "open")
          view = viewSchema.parse(
            await this.request(
              path,
              "POST",
              {
                expected_revision: view.revision,
              },
              access,
              undefined,
            ),
          );
        if (view.lifecycle !== "open") {
          delivery.state = view.lifecycle;
          delivery.cancelRequested = false;
          delivery.error =
            view.lifecycle === "cancelled"
              ? null
              : "停止确认前，这次处理已经结束。已发生的操作不会撤销。";
        }
      } catch {
        delivery.error = "停止尚未被 Runtime 确认，正在核对同一次处理的状态。";
      }
      this.save(delivery);
    }
  }
  private queueRootCancellationChecks(sessionId: string, rootId?: string) {
    for (const delivery of this.activeDeliveries())
      if (
        delivery.state === "running" &&
        delivery.rootId &&
        delivery.sessionId === sessionId &&
        (!rootId || delivery.rootId === rootId)
      )
        this.rootCancellationChecks.add(delivery);
  }

  /** Repair only an already accepted ordinary input's exact root cancellation.
   * Runtime's cancellation Event and outcome are atomic: the Event carries
   * the OLD generation while the cancelled Thread advances by one. A child
   * terminal barrier can route to a parent, so it is never a settlement fact.
   * Reads do not rewind the Session cursor, replay IO, or create chat replies. */
  private async reconcileRootCancellation(delivery: StoredDelivery) {
    const source = delivery.platformSource;
    const authorize = this.authorizePlatformRead;
    const binding = this.state.sessions[delivery.sessionId];
    if (
      !source ||
      !authorize ||
      !binding?.platform ||
      delivery.state !== "running" ||
      !delivery.rootId ||
      delivery.supplement ||
      source.continuation
    )
      return;
    const config = this.config;
    const rootId = delivery.rootId;
    const sessionId = delivery.sessionId;
    const frozen = JSON.stringify(delivery);
    const bindingIdentity = JSON.stringify({
      id: binding.id,
      projectId: binding.projectId,
      conversationId: binding.conversationId,
      sharedDefault: binding.sharedDefault,
      platform: binding.platform,
      runtimePrincipalId: binding.runtimePrincipalId,
    });
    const scope = {
      projectId: source.projectId,
      conversationId: source.conversationId,
    };
    const current = () =>
      !this.stopped &&
      this.config === config &&
      this.authorizePlatformRead === authorize &&
      this.state.sessions[sessionId] === binding &&
      JSON.stringify({
        id: binding.id,
        projectId: binding.projectId,
        conversationId: binding.conversationId,
        sharedDefault: binding.sharedDefault,
        platform: binding.platform,
        runtimePrincipalId: binding.runtimePrincipalId,
      }) === bindingIdentity &&
      this.state.deliveries.includes(delivery) &&
      JSON.stringify(delivery) === frozen &&
      (!this.teamIdentity || this.identity!.allows(source.author));
    const authorized = async () => {
      if (!current()) return false;
      const grant = await authorize(scope, source.author);
      return (
        current() &&
        grant.personalDefault === source.sharedDefault &&
        this.platformSourceReadable(source, scope, source.author, grant) &&
        sessionId ===
          this.objectSessionId(
            source.projectId,
            source.conversationId,
            source.sharedDefault,
          )
      );
    };
    const read = async (path: string) => {
      if (!current()) throw new Error("Runtime 核对已失效。");
      const value = await this.request(
        path,
        "GET",
        undefined,
        source.author,
        undefined,
        "json",
        true,
      );
      if (!current()) throw new Error("Runtime 核对已失效。");
      return value;
    };
    try {
      if (!(await authorized())) return;
      const base = `/api/sessions/${encodeURIComponent(sessionId)}`;
      const root = z
        .object({ event: eventSchema })
        .parse(
          await read(
            `${base}/messages/by-client-id/${encodeURIComponent(delivery.inputId)}`,
          ),
        ).event;
      if (
        root.id !== rootId ||
        root.topic !== "chat/user_message" ||
        root.actor !== "Session-Client" ||
        root.type !== "session_message"
      )
        return;
      const acceptedSource = platformSourceFromRuntimeRoot(
        root,
        sessionId,
        delivery.inputId,
        (id) => (this.teamIdentity ? this.principalId(id) : null),
      );
      if (!isDeepStrictEqual(acceptedSource, source)) return;
      const accepted = z
        .object({
          request: z.object({
            io_version: z.string(),
            client_metadata: z.unknown(),
            message: z.object({
              format: z.unknown(),
              content: z.object({
                encoding: z.literal("json"),
                value: z.unknown(),
              }),
            }),
            activation: z.record(z.string(), z.unknown()),
            delivery: z.record(z.string(), z.unknown()),
          }),
        })
        .parse(root.payload.session_io).request;
      const original = z
        .object({
          io_version: z.string(),
          client_metadata: z.unknown(),
          message: z.object({
            format: z.unknown(),
            content: z.object({
              encoding: z.literal("json"),
              value: z.unknown(),
            }),
          }),
          activation: z.record(z.string(), z.unknown()),
          delivery: z.record(z.string(), z.unknown()),
        })
        .parse(delivery.request);
      const budget = { nodes: 0 };
      // Rust Activation/Delivery serialize absent Option fields as null and
      // default vectors/booleans explicitly. Normalize copies only: never
      // rewrite the submitted IO bytes or compare a subset of its intent.
      const activation = (value: Record<string, unknown>) => ({
        mode: "evaluate",
        dispatch_mode: null,
        model_alias: null,
        reasoning_effort: null,
        target_id: null,
        harness: null,
        input_destination: null,
        ...value,
      });
      const outputDelivery = (value: Record<string, unknown>) => ({
        accept_formats: null,
        required_formats: [],
        require_schema: false,
        ...value,
      });
      if (
        accepted.io_version !== original.io_version ||
        !isDeepStrictEqual(
          storedDataValue(accepted.client_metadata, budget),
          original.client_metadata,
        ) ||
        !isDeepStrictEqual(
          storedDataValue(accepted.message.content.value, budget),
          original.message.content.value,
        ) ||
        !isDeepStrictEqual(accepted.message.format, original.message.format) ||
        !isDeepStrictEqual(
          activation(accepted.activation),
          activation(original.activation),
        ) ||
        !isDeepStrictEqual(
          outputDelivery(accepted.delivery),
          outputDelivery(original.delivery),
        )
      )
        return;
      const turnSchema = z.object({
        thread_id: z.string().min(1),
        session_id: z.literal(sessionId),
        root_turn_id: z.literal(rootId),
        revision: z.number().int().positive(),
        lifecycle: z.literal("cancelled"),
      });
      const turnPath = `${base}/turns/${encodeURIComponent(rootId)}/thread`;
      const turn = turnSchema.parse(await read(turnPath));
      const family = z
        .object({
          session_id: z.literal(sessionId),
          context_id: z.literal(this.contextId(binding.projectId)),
          selected_thread_id: z.literal(turn.thread_id),
          threads: z
            .array(
              z.object({
                id: z.string(),
                session_id: z.string(),
                context_id: z.string(),
                root_turn_id: z.string(),
                parent_thread_id: z.string().nullable(),
                revision: z.number().int().positive(),
                generation: z.number().int().positive(),
              }),
            )
            .max(1),
        })
        .parse(
          await read(
            `${base}/threads/${encodeURIComponent(turn.thread_id)}/family?limit=1`,
          ),
        );
      const thread = family.threads[0];
      if (
        !thread ||
        thread.id !== turn.thread_id ||
        thread.session_id !== sessionId ||
        thread.context_id !== family.context_id ||
        thread.root_turn_id !== rootId ||
        thread.parent_thread_id !== null ||
        thread.revision !== turn.revision
      )
        return;
      let before: number | undefined;
      let proven = false;
      for (let page = 0; page < 4 && !proven; page++) {
        const data = z
          .object({
            events: z.array(eventSchema).max(100),
            next_before_sequence: z.number().int().positive().nullable(),
          })
          .parse(
            await read(
              `${base}/events?root_turn_id=${encodeURIComponent(rootId)}&limit=100${before === undefined ? "" : `&before_sequence=${before}`}`,
            ),
          );
        const upper = before;
        if (
          upper !== undefined &&
          data.events.some((event) => event.sequence >= upper)
        )
          return;
        proven = data.events.some((event) => {
          const p = event.payload;
          return (
            event.topic === "runtime/thread_cancelled" &&
            event.type === "runtime_control" &&
            event.id ===
              `thread_cancelled_${thread.id}_g${thread.generation - 1}` &&
            event.sequence > root.sequence &&
            p.session_id === sessionId &&
            p.context_id === family.context_id &&
            p.root_turn_id === rootId &&
            p.thread_id === thread.id &&
            p.thread_generation === thread.generation - 1 &&
            p.terminal_kind === "cancelled" &&
            p.disposition === "no_reply" &&
            p.runtime_failure_kind === "thread_cancelled" &&
            p.wake_policy === "none"
          );
        });
        if (proven || data.next_before_sequence === null) break;
        if (before !== undefined && data.next_before_sequence >= before) return;
        before = data.next_before_sequence;
      }
      if (!proven) return;
      const finalTurn = turnSchema.parse(await read(turnPath));
      if (
        !isDeepStrictEqual(finalTurn, turn) ||
        !(await authorized()) ||
        !current()
      )
        return;
      delivery.state = "cancelled";
      delivery.cancelRequested = false;
      delivery.error = null;
      this.markDeliveryDirty(delivery);
    } catch {
      // Unknown, unavailable, revoked, or pagination-insufficient evidence is
      // not a cancellation. Preserve the complete original ledger and error.
    }
  }
  private async processRootCancellationChecks() {
    if (!this.authorizePlatformRead) return;
    let count = 0;
    for (const delivery of this.rootCancellationChecks) {
      if (this.stopped || count++ === 8) break;
      this.rootCancellationChecks.delete(delivery);
      await this.reconcileRootCancellation(delivery);
    }
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.executionObserver?.close();
    this.executionObserver = undefined;
    for (const feed of this.feeds) feed.close();
    this.feeds.clear();
    await this.busyCompletion;
  }
  async tick() {
    return this.as(
      this.teamIdentity
        ? { principalId: "morphz-service", actantId: "morphz-agent" }
        : localAccess,
      () => this.tickAsService(),
    );
  }
  private async tickAsService() {
    if (this.stopped) return;
    // Enqueue wakes the loop immediately. A caller that then explicitly awaits
    // tick must await that same in-flight pass, not observe a false success
    // while its message is still queued.
    if (this.busy) return this.busyCompletion ?? undefined;
    this.busy = true;
    let complete!: () => void;
    this.busyCompletion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    try {
      const status = this.teamIdentity
        ? (await this.request("/api/sessions"), { model: "Runtime 默认模型" })
        : z
            .object({ model: z.string() })
            .passthrough()
            .parse(await this.request("/api/status"));
      this.state.connected = true;
      this.state.model = status.model;
      this.state.error = "";
      let clientMetadataCapability:
        "supported" | "unsupported" | "unavailable" = "unavailable";
      try {
        const io = z
          .object({
            enabled: z.boolean(),
            directed_input: z.boolean().default(false),
            client_metadata: z.boolean().default(false),
            harnesses: z
              .array(z.object({ id: z.string(), version: z.string() }))
              .optional(),
            formats: z
              .array(
                z.object({
                  definition: z.object({ id: z.string(), version: z.string() }),
                }),
              )
              .default([]),
          })
          .parse(await this.request("/api/session-io/capabilities"));
        clientMetadataCapability =
          io.enabled && io.client_metadata ? "supported" : "unsupported";
        this.loadedHarnesses = io.enabled ? (io.harnesses ?? null) : null;
        this.state.directedInput =
          io.enabled &&
          io.directed_input &&
          io.formats.some(
            (f) =>
              f.definition.id === "morphz.application.input" &&
              f.definition.version === "4",
          );
      } catch (error) {
        // A missing endpoint is an older Runtime contract. A timeout or 5xx
        // is not evidence of that: keep the original queued input for retry.
        if (
          error instanceof UpstreamError &&
          [404, 405, 501].includes(error.status)
        )
          clientMetadataCapability = "unsupported";
        this.state.directedInput = false;
        this.loadedHarnesses = null;
      }
      for (const delivery of this.activeDeliveries().filter(
        (item) => item.state === "queued" && item.platformHeld,
      )) {
        const source = delivery.platformSource;
        const authorize = this.authorizePlatformInput;
        if (!source?.firstInputId || !authorize) continue;
        try {
          const route = await authorize({ ...source, phase: "dispatch" });
          if (route.sharedDefault !== source.sharedDefault)
            throw new DomainError("conflict", "对话归属已变化，未发送。");
          delivery.platformHeld = false;
          this.save(delivery);
        } catch (error) {
          if (
            (error instanceof DomainError ||
              error instanceof PlatformStorageError) &&
            error.code === "conflict"
          )
            continue;
          delivery.state = "failed";
          delivery.error =
            error instanceof Error ? error.message : "首条消息未能确认。";
          this.save(delivery);
        }
      }
      for (const delivery of this.activeDeliveries().filter(
        (item) => item.state === "queued" && !item.platformHeld,
      )) {
        if (this.stopped) break;
        if (delivery.state !== "queued") continue;
        if (
          "client_metadata" in delivery.request &&
          clientMetadataCapability === "unavailable"
        ) {
          this.state.error =
            "暂时无法确认 Runtime 的消息能力，正在重试；原消息已保留。";
          continue;
        }
        delivery.state = "sending";
        this.save(delivery);
        try {
          if (delivery.platformSource) {
            const authorize = this.authorizePlatformInput;
            if (!authorize)
              throw new DomainError(
                "forbidden",
                "Platform 消息授权不可用，未发送。",
              );
            const source = delivery.platformSource;
            const current = await authorize({
              projectId: source.projectId,
              conversationId: source.conversationId,
              targetActantId: source.targetActantId,
              author: source.author,
              ...(source.artifactId ? { artifactId: source.artifactId } : {}),
              ...(source.cognitiveObject
                ? { cognitiveObject: source.cognitiveObject }
                : {}),
              ...(source.cognitiveApplication
                ? { cognitiveApplication: source.cognitiveApplication }
                : {}),
              ...(source.artifactRevision
                ? { artifactRevision: source.artifactRevision }
                : {}),
              ...(source.selection ? { selection: source.selection } : {}),
              ...(source.reading ? { reading: source.reading } : {}),
              ...(source.continuation
                ? { continuation: source.continuation }
                : {}),
              ...(source.application
                ? { application: source.application }
                : {}),
              ...(source.browser ? { browser: source.browser } : {}),
              ...(source.localFile ? { localFile: source.localFile } : {}),
              ...(source.directories?.length
                ? { directories: source.directories }
                : {}),
              ...(source.firstInputId
                ? { firstInputId: source.firstInputId }
                : {}),
              ...(source.newConversationTitle
                ? { newConversationTitle: source.newConversationTitle }
                : {}),
              phase: "dispatch",
            });
            const { sharedDefault } = source;
            if (current.sharedDefault !== sharedDefault)
              throw new DomainError("conflict", "对话归属已变化，未发送。");
            // After a lost HTTP receipt, Runtime must resolve the same
            // immutable client_message_id even if its thread has since ended.
            // A fresh submission is still fenced by the current generation.
            if (source.continuation && !delivery.runtimePostAttempted)
              await this.as(source.author, () =>
                this.validatePlatformContinuation(
                  source.continuation!,
                  source.projectId,
                  source.conversationId,
                ),
              );
          }
          const activation = delivery.request.activation as
            { harness?: { id: string; version: string } } | undefined;
          if (activation?.harness) {
            const issue = harnessReadinessError(
              activation.harness,
              this.loadedHarnesses,
            );
            if (issue) throw new UpstreamError(422, issue);
          }
          if ("client_metadata" in delivery.request) {
            if (clientMetadataCapability !== "supported")
              throw new DomainError(
                "invalid",
                "Morphz 服务版本过旧，暂时无法发送。更新后可重试，消息已保留。",
              );
          }
          await this.ensureSession(delivery.sessionId);
          // Establish observers before the model can emit its first text chunk.
          await Promise.all([...this.feeds].map((feed) => feed.sync()));
          if (!delivery.platformSource) throw new Error("原始输入不可用。");
          const author = delivery.platformSource.author;
          if (delivery.resourceUploads?.some((upload) => !upload.ready)) {
            const capabilities = z
              .object({ enabled: z.boolean(), resources: z.boolean() })
              .parse(await this.request("/api/session-io/capabilities"));
            if (!capabilities.enabled || !capabilities.resources)
              throw new UpstreamError(
                422,
                "当前 Runtime 不支持结构化消息的附件。原输入和图片已保留，请更新 Runtime 后重试。",
              );
            for (const upload of delivery.resourceUploads) {
              if (upload.ready) continue;
              const access = this.teamIdentity ? author : this.actor();
              let bytes: Buffer;
              if (upload.assetId) {
                if (!this.messageAttachments)
                  throw new Error("消息附件 Store 不可用，未发送。");
                const resource = await this.messageAttachments.readForDispatch(
                  author,
                  {
                    assetId: upload.assetId,
                    name: upload.name,
                    mime: upload.mediaType as NonNullable<
                      RecordedInput["attachments"]
                    >[number]["mime"],
                  },
                );
                bytes = Buffer.from(resource.bytes);
              } else {
                bytes = Buffer.from(upload.dataBase64!, "base64");
              }
              if (
                createHash("sha256").update(bytes).digest("hex") !==
                upload.sha256
              )
                throw new Error("消息附件字节已变化，未发送。");
              const stagePath = `/api/sessions/${delivery.sessionId}/attachment-stages`;
              let stage = z
                .object({
                  offset: z.number().int().nonnegative(),
                  status: z.string(),
                  sha256: z.string().nullable().optional(),
                })
                .parse(
                  await this.request(
                    stagePath,
                    "POST",
                    {
                      stage_id: upload.stageId,
                      client_message_id: delivery.inputId,
                      name: upload.name,
                      media_type: upload.mediaType,
                      size_bytes: bytes.length,
                      expected_sha256: upload.sha256,
                    },
                    access,
                  ),
                );
              while (stage.status === "uploading") {
                if (stage.offset >= bytes.length)
                  throw new Error("附件暂存状态无效，未发送。");
                const offset = stage.offset;
                stage = z
                  .object({
                    offset: z.number().int().nonnegative(),
                    status: z.string(),
                    sha256: z.string().nullable().optional(),
                  })
                  .parse(
                    await this.request(
                      `${stagePath}/${upload.stageId}/content`,
                      "PUT",
                      undefined,
                      access,
                      {
                        bytes: bytes.subarray(offset, offset + 1024 * 1024),
                        offset,
                      },
                    ),
                  );
                if (stage.offset <= offset)
                  throw new Error("附件上传没有推进，未发送。");
              }
              if (
                !["ready", "consumed"].includes(stage.status) ||
                stage.sha256 !== upload.sha256
              )
                throw new Error("附件完整性尚未确认，未发送。");
              upload.ready = true;
              this.save(delivery);
            }
          }
          delivery.runtimePostAttempted = true;
          this.save(delivery);
          const receipt = z
            .object({ accepted: z.literal(true), event_id: z.string() })
            .parse(
              await this.request(
                `/api/sessions/${delivery.sessionId}/${delivery.request.io_version === "1" ? "io/messages" : "messages"}`,
                "POST",
                delivery.request,
                this.teamIdentity ? author : undefined,
              ),
            );
          if (delivery.platformSource.continuation?.mode === "supplement") {
            // This receipt identifies the steering event, NOT a new execution root.
            delivery.acceptedEventId = receipt.event_id;
            delivery.supplement = "delivered";
            delivery.state = "completed";
          } else {
            delivery.rootId = receipt.event_id;
            delivery.state = "running";
          }
          delivery.error = null;
        } catch (error) {
          delivery.state = "failed";
          if (delivery.supplement) {
            delivery.supplement =
              error instanceof UpstreamError &&
              [400, 403, 404, 409, 422].includes(error.status)
                ? "rejected"
                : "unknown";
            if (error instanceof ContinuationConflict) {
              delivery.supplement = "rejected";
              delivery.rejection = error.reason;
            } else if (error instanceof DomainError) {
              delivery.supplement = "rejected";
              delivery.rejection =
                error.code === "forbidden" ? "forbidden" : "invalid";
            }
            if (
              error instanceof UpstreamError &&
              [400, 403, 404, 409, 422].includes(error.status)
            ) {
              delivery.rejection =
                error.status === 403 ? "forbidden" : "invalid";
              const source = delivery.platformSource;
              const target = source?.continuation;
              if (source && target) {
                try {
                  await this.as(source.author, () =>
                    this.validatePlatformContinuation(
                      target,
                      source.projectId,
                      source.conversationId,
                    ),
                  );
                } catch (e) {
                  if (e instanceof ContinuationConflict)
                    delivery.rejection = e.reason;
                }
              }
            }
          }
          delivery.error =
            delivery.rejection === "closed"
              ? new ContinuationConflict("closed").message
              : delivery.rejection === "changed"
                ? new ContinuationConflict("changed").message
                : error instanceof UpstreamError
                  ? error.message
                  : error instanceof DomainError ||
                      error instanceof PlatformStorageError
                    ? error.message
                    : "发送结果未确认。重试将核对同一个请求，不会重复执行。";
        }
        this.save(delivery);
      }
      await this.processCancellations();
      const currentDeliveries = this.activeDeliveries();
      for (const session of this.activeSessions()) {
        if (this.stopped) break;
        if (
          !session.hasWork &&
          !currentDeliveries.some((d) => d.sessionId === session.id && d.rootId)
        )
          continue;
        // Durable cursor resumes after restart; do not filter out causal thread-result joins.
        for (let page = 0; page < 10; page++) {
          const data = z
            .object({ events: z.array(eventSchema) })
            .parse(
              await this.request(
                `/api/sessions/${session.id}/events?after_sequence=${session.cursor}&limit=1000`,
              ),
            );
          for (const event of data.events.sort(
            (a, b) => a.sequence - b.sequence,
          )) {
            if (event.sequence <= session.cursor) continue;
            if (
              payloadString(event, "session_id") &&
              payloadString(event, "session_id") !== session.id
            )
              throw new Error("Runtime 返回了不属于当前会话的事件。");
            if (event.topic === "runtime/thread_cancelled") {
              const root = payloadString(event, "root_turn_id");
              if (root) this.queueRootCancellationChecks(session.id, root);
            }
            if (
              terminal.has(event.topic) ||
              ["runtime/thread_result", "chat/progress"].includes(event.topic)
            )
              session.events.push(event);
            session.cursor = event.sequence;
          }
          if (data.events.length < 1000) break;
        }
        const scopedDeliveries = currentDeliveries.filter(
          (delivery) => delivery.sessionId === session.id && delivery.rootId,
        );
        for (const event of session.events) {
          if (event.topic !== "runtime/thread_result") continue;
          const root = payloadString(event, "root_turn_id");
          const thread = payloadString(event, "thread_id");
          if (!root || !thread) continue;
          for (const delivery of scopedDeliveries)
            if (
              delivery.rootId === root &&
              !delivery.causalThreadIds.includes(thread)
            ) {
              delivery.causalThreadIds.push(thread);
              this.markDeliveryDirty(delivery);
            }
        }
        const causalEvents = [
          ...causalThreadEvents(scopedDeliveries),
          ...session.events,
        ];
        const attribute = sessionDeliveryAttribution(
          session.id,
          scopedDeliveries,
          causalEvents,
        );
        for (const event of session.events) {
          if (
            ![
              "chat/reply",
              "chat/outbound_message",
              "chat/progress",
              "chat/runtime_error",
              "session/io_state",
              "runtime/response_protocol_fused",
            ].includes(event.topic) ||
            !(
              payloadString(event, "text") ??
              payloadString(event, "error") ??
              payloadString(event, "message")
            )
          )
            continue;
          const delivery = attribute(event);
          if (
            delivery?.platformSource &&
            (!delivery.lastActivityAt ||
              delivery.lastActivityAt < event.timestamp)
          ) {
            delivery.lastActivityAt = event.timestamp;
            this.markDeliveryDirty(delivery);
          }
        }
        const running = currentDeliveries.filter(
          (d) =>
            d.sessionId === session.id && d.rootId && d.state === "running",
        );
        const results = running.length
          ? terminalResultsByRoot(
              causalEvents,
              new Set(running.map((delivery) => delivery.rootId!)),
            )
          : new Map<string, RuntimeEvent>();
        for (const delivery of running) {
          const result = results.get(delivery.rootId!);
          if (!result) continue;
          delivery.cancelRequested = false;
          delivery.state =
            result.topic === "chat/cancelled"
              ? "cancelled"
              : [
                    "chat/runtime_error",
                    "session/io_state",
                    "runtime/response_protocol_fused",
                  ].includes(result.topic)
                ? "failed"
                : "completed";
          delivery.error =
            delivery.state === "failed"
              ? (payloadString(result, "error") ??
                "Morphz 执行失败，请查看错误信息。")
              : null;
          this.markDeliveryDirty(delivery);
        }
      }
      await this.processRootCancellationChecks();
      await this.refreshActivity();
      await this.refreshAttention();
    } catch (error) {
      this.state.connected = false;
      this.state.error =
        error instanceof UpstreamError
          ? error.message
          : "暂时无法连接 Morphz，正在重连；消息和执行状态已保留。";
    } finally {
      try {
        this.save();
      } finally {
        this.busy = false;
        this.busyCompletion = null;
        complete();
      }
    }
  }
}
