import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { z } from "zod";
import {
  applicationInstanceSchema,
  parseApplicationViewState,
  browserApplication,
  objectsApplication,
  readerApplication,
  scriptStudioApplication,
  uiPackageHeaderSchema,
  type ApplicationInstance,
  type UiPackageHeader,
} from "../../core/src/applications.js";
import { morphzAgentAccess } from "../../core/src/model.js";
import {
  notificationStateSchema,
  notificationIdSchema,
  type NotificationState,
} from "../../core/src/notification-state.js";
import { platformSchemaSql } from "./schema.js";
import { ensureApplicationInstallation } from "./application-installation.js";
import {
  createCognitiveAppRegistry,
  type CognitiveAppConsentRequest,
  type CognitiveAppGrantChange,
  type CognitiveAppRegistryCatalogRequest,
  type CognitiveAppHostConnectionRequest,
  type CognitiveAppTargetRequest,
  type CognitiveAppTargetSnapshot,
  type CognitiveAppVersion,
  type CognitiveAppConnection,
} from "./cognitive-app-registry.js";
import {
  createCognitiveAppCommands,
  type CognitiveAppCommandSnapshot,
  type CognitiveAppCommandPage,
} from "./cognitive-app-commands.js";
import {
  createCognitiveAppProjection,
  type CognitiveAppProjectionResult,
} from "./cognitive-app-projection.js";
import { readCognitiveAppUiByteProof } from "./cognitive-app-ui-proof.js";
import {
  domainProtocol,
  parseCognitiveAppDefinition,
  validateOperationValue,
  parseOperationResources,
  parseProtocolValue,
  type CognitiveAppDefinition,
  type JsonValue,
  type OperationDefinition,
  type OperationResourceReference,
} from "../../cognitive-app-sdk/src/protocol.js";
import {
  canonicalJsonBytes,
  domainWireLimits,
  parseDomainActor,
  type DomainActor,
} from "../../cognitive-app-sdk/src/domain-wire.js";
import {
  profileAvatarMediaSchema, profileAvatarSnapshotSchema,
  type ProfileAvatarMedia, type ProfileAvatarSnapshot, type ProfileSubject,
} from "../../core/src/profile.js";
import type { NavigationRevisions } from "../../core/src/application-api.js";
import {
  understandingSourcesSchema,
  type UnderstandingSource,
} from "../../core/src/understanding.js";
import {
  taskRunAdmissionSchema,
  taskRunRuntimeReceiptSchema,
  preparedTaskRunSchema,
  prepareTaskAdmission,
  taskPreparationEventId,
  type TaskRunAdmission,
  type TaskRunRuntimeReceipt,
  type TaskRunPrerequisite,
  type PreparedTaskRun,
} from "./task-run-admission.js";
import { taskSourceEventSchema, taskSourceReceiptSchema, taskSourceRequest, type TaskSourceEvent, type TaskSourceDestination, type TaskSourceReceipt } from "./task-run-source.js";
import {
  postgresQuery,
  safeInteger,
  schemaHash,
  verifySchemaObjects,
  sqliteQuery,
  withSqliteWriteGate,
  prepareSqlCommit,
  publishSqlCommit,
  hasSqlChanges,
  type SqlQuery as Query,
  type SqlRow as Row,
  type SqlScalar as Scalar,
} from "../../storage/src/sql.js";
import { sqliteChangeSource, postgresChangeSource, type SqlChangeSource } from "../../storage/src/commit-notifications.js";

type Backend =
  | { kind: "sqlite"; database: DatabaseSync; writeGateKey: string | null }
  | { kind: "postgres"; pool: Pool; schema: string };
type ContentFilter = {
  projectId?: string;
  contentIds?: string[];
  appObjectIds?: string[];
  appId?: string;
  appIds?: string[];
  kind?: string;
  kinds?: string[];
  availability?: string;
  query?: string;
};
type ContentOrder = "updated" | "created" | "title";
export type ApplicationProviderRoute = {
  routeKind: "service" | "node";
  routeRef: string;
  nodeId?: string;
};

function matchesApplicationProviderRoute(
  actual: {
    route_kind: string;
    route_ref: string;
    node_id: string | null;
  },
  expected: ApplicationProviderRoute,
) {
  return (
    actual.route_kind === expected.routeKind &&
    actual.route_ref === expected.routeRef &&
    actual.node_id === (expected.nodeId ?? null)
  );
}
type TeamCredentialBinding = {
  principalId: string;
  actantId: string;
  credentialHash: string;
};
export type PlatformAuthorityVerifier = {
  /** Resolve a host-only credential to the current authenticated identity.
   * For an Agent, the adapter must resolve the persisted Runtime input or
   * admitted task run and its Human; model parameters are never identity.
   */
  resolveActor(request: PlatformActor): Promise<{
    tenantId: string;
    principalId: string;
    actantId: string;
    kind: "human" | "agent";
    runtimeInputId: string | null;
    /** For Agent invocations, the persisted input's authenticated Human. */
    initiatingHumanActantId?: string;
    /** A trusted Runtime ingress may bind Agent authority to one input project. */
    scopeProjectId?: string;
    /** Exact Platform admission for a Runtime-scheduled task with no chat
     * input. Only a trusted Host verifier may assert this provenance. */
    runtimeTaskRun?: {
      sessionId: string;
      scheduleId: string;
      eventId: string;
    };
  } | null>;
  resolveActant(request: {
    tenantId: string;
    actantId: string;
  }): Promise<{ principalId: string; kind: "human" | "agent" } | null>;
  /** The tenant's current Morphz Agent, resolved by trusted identity state.
   * A project-creation request must not name its own privileged member. */
  resolveProjectAgent(request: {
    tenantId: string;
  }): Promise<{ principalId: string; actantId: string } | null>;
  /** Profile presentation uses the kernel Agent ID, not the display Actant ID.
   * Only the trusted Host can bind this ID and its current edit policy. */
  resolveProfileAgent?(request: { tenantId: string; principalId: string }): Promise<{ agentId: string; editable: boolean } | null>;
  verifyProfileAvatar?(request: { actor: PlatformActor; subject: ProfileSubject; subjectId: string; media: ProfileAvatarMedia }): Promise<boolean>;
  verifyApplicationObject(request: {
    tenantId: string;
    principalId: string;
    actantId: string;
    runtimeInputId: string | null;
    /** Distinct from a chat input: the admitted Runtime task-run event. */
    runtimeTaskRunEventId: string | null;
    instanceId: string;
    objectId: string;
    versionRef: string;
    kind: string;
    title: string;
    projectId: string;
    receiptId: string;
    proof: string;
  }): Promise<boolean>;
};
export type PlatformActor = {
  /** Supplied by the trusted Client/Runtime ingress, never model arguments. */
  credential: string;
};
/** A Host-owned login credential. Only hashes and a CSRF nonce are persisted;
 * Runtime Sessions and Agent messages are never stored in this table. */
export type TeamLoginSession = {
  sessionHash: string;
  csrf: string;
  principalId: string;
  actantId: string;
  credentialHash: string;
  expiresAt: number;
};
export type UiPackageVersion = {
  appId: string;
  version: string;
  installedByPrincipalId: string;
  header: UiPackageHeader;
  storeId: string;
  artifactId: string;
  artifactRevision: number;
  sha256: string;
  byteLength: number;
  installedAt: string;
};
/** Host-internal evidence from an owning App's committed outbox. This is not
 * a Client credential: every projection is checked against the exact App
 * receipt through verifyApplicationObject before Platform changes its catalog.
 */
export type CommittedAppOrigin = {
  tenantId: string;
  principalId: string;
  actantId: string;
  runtimeInputId: string | null;
  runtimeTaskRunEventId?: string | null;
  instanceId: string;
  receiptId: string;
};
type ResolvedActor = {
  tenantId: string;
  principalId: string;
  actantId: string;
  kind: "human" | "agent" | "provider";
  runtimeInputId: string | null;
  initiatingHumanActantId?: string;
  scopeProjectId?: string;
  runtimeTaskRun?: {
    sessionId: string;
    scheduleId: string;
    eventId: string;
  };
  /** Outbox recovery retains the committed source without a live credential. */
  committedTaskRunEventId?: string;
};
/** Only created privately after the real capabilities resolver succeeds,
 * before SQL. The optional legacy guard argument is never a caller port. */
type PreparedExecutor = {
  tenantId: string;
  actantId: string;
  principalId: string;
  kind: "agent";
};
type PreparedCognitiveActor = {
  actor: ResolvedActor;
  domainActor: DomainActor;
  executor?: PreparedExecutor;
};
/** Host-internal describe/alias proof. Not part of SDK, Client, Agent or iframe
 * requests. The Gateway must authenticate describe before supplying it; this
 * Store boundary checks exact installation/consent and never verifies network. */
export type HostVerifiedCognitiveConnectionProof = {
  purpose: "connection-setup";
  appId: string;
  version: string;
  definitionHash: string;
  serviceId: string;
  dataAuthorityId: string;
  hostBindingId: string;
};
export type HostVerifiedCognitiveConnectionCreate = {
  proof: HostVerifiedCognitiveConnectionProof;
  connectionId: string;
  expectedRevision: 0;
  expectedGrantRevision?: number;
  now?: string;
};
export type HostVerifiedCognitiveConnectionChange = {
  proof: HostVerifiedCognitiveConnectionProof;
  connectionId: string;
  expectedRevision: number;
  expectedGrantRevision?: number;
  state: "active" | "disabled" | "unavailable";
  now?: string;
};
export type CognitiveAppOperationResolutionRequest =
  CognitiveAppTargetRequest & {
    projectId: string;
    operationId: string;
    parameters: unknown;
    resources: unknown;
  };
/** A current policy snapshot, NOT permission to dispatch later. Command
 * admission/first dispatch must recheck this same authority in their own q. */
export type ResolvedCognitiveAppOperation = {
  actor: DomainActor;
  target: CognitiveAppTargetSnapshot;
  operation: OperationDefinition;
  parameters: JsonValue;
  resources: readonly OperationResourceReference[];
};
export type CognitiveAppObjectReadRequest = CognitiveAppTargetRequest & {
  projectId: string;
  object: OperationResourceReference;
  maxBytes: number;
};
/** Current read-policy snapshot only. The owning App must still prove the
 * exact requested historical version and bounded original response. */
export type ResolvedCognitiveAppObjectRead = {
  actor: DomainActor;
  target: CognitiveAppTargetSnapshot;
  object: OperationResourceReference;
  maxBytes: number;
};
export type CognitiveAppCommandRequest =
  CognitiveAppOperationResolutionRequest & { commandId: string };
export type PreparedCognitiveAppCommand = {
  command: CognitiveAppCommandSnapshot;
  operation: OperationDefinition;
  parameters: JsonValue;
};
export type PreparedCognitiveAppReceiptRecovery = {
  command: CognitiveAppCommandSnapshot;
  definition: CognitiveAppDefinition;
  connection: CognitiveAppConnection & { hostBindingId: string };
};
export type CognitiveAppConnectionStateRequest = {
  appId: string;
  version: string;
  connectionId: string;
  expectedRevision: number;
  state: "active" | "disabled" | "unavailable";
  expectedDefinitionHash?: string;
  expectedGrantRevision?: number;
  now?: string;
};
/** Fixed Host authority, never registered on Client/Agent/iframe transports. */
export type CognitiveAppHostCommandRequest = {
  tenantId: string;
  commandId: string;
};
type CognitiveAppOperationDeclaration = {
  version: CognitiveAppVersion;
  operation: OperationDefinition;
  parameters: JsonValue;
  resources: readonly OperationResourceReference[];
};
export type ContentRow = {
  content_id: string;
  app_id: string;
  instance_id: string;
  provider_revision: number;
  app_object_id: string;
  project_id: string;
  kind: string;
  title: string;
  observed_version_ref: string | null;
  availability: string;
  revision: number;
  created_at: string;
  updated_at: string;
};
/** A Platform reference used to ask the owning app for an exact version.
 * observedVersionRef is only a catalog CAS premise, never the app head. */
export type TaskWatchSource =
  | { kind: "task"; sourceId: string; projectId: string; revision: number }
  | {
      kind: "content";
      sourceId: string;
      projectId: string;
      appId: string;
      instanceId: string;
      objectId: string;
      catalogRevision: number;
      providerRevision: number;
      observedVersionRef: string | null;
    };
export type TaskWatchSourceReader = (
  actor: PlatformActor,
  source: Extract<TaskWatchSource, { kind: "content" }>,
) => Promise<string>;
export type TaskSourceRun = {
  admission: TaskRunAdmission;
  sequence: number;
  controlRevision: number;
  sourceSignature: string;
  runtime: TaskRunLink["runtime"];
};
export type ContentDeliveryRow = {
  command_id: string;
  operation: "record-content" | "refresh-content";
  runtime_input_id: string;
  source_project_id: string;
  content_id: string;
  project_id: string;
  app_id: string;
  app_object_id: string;
  kind: string;
  title: string;
  version_ref: string;
  committed_at: string;
};
type AppViewRow = {
  view_id: string;
  project_id: string;
  app_id: string;
  package_version: string;
  state_json: string;
  revision: number | string;
  status: "open" | "closed";
  created_at: string;
  updated_at: string;
};
const builtinViewApps = [
  objectsApplication,
  browserApplication,
  readerApplication,
  scriptStudioApplication,
];
function appView(row: AppViewRow): ApplicationInstance {
  return applicationInstanceSchema.parse({
    id: row.view_id,
    workspaceId: row.project_id,
    applicationId: row.app_id,
    applicationVersion: row.package_version,
    state: JSON.parse(row.state_json),
    revision: safeInteger(row.revision, "应用窗口修订"),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
export type TaskRow = {
  task_id: string;
  project_id: string;
  title: string;
  description: string;
  assignee_id: string;
  execution: string;
  due_date: string | null;
  order_rank: number;
  revision: number;
  updated_at: string;
};
/** One authorized list row carries the current immutable version. A Client
 * must not issue one version request per task just to render the list. */
export type TaskListRow = TaskRow & {
  created_by_principal_id: string;
  created_by_actant_id: string;
  created_at: string;
  head_version: TaskVersionRow;
};
export type TaskCountSummary = {
  projectId: string;
  total: number;
  pending: number;
  mineOpen: number;
  latestActivityAt: string;
};
export type TaskListFilter = {
  /** Resolved from the trusted actor, never a caller-supplied principal ID. */
  owner?: "mine" | "human" | "agent" | "all";
  query?: string;
};
export type ConversationRow = {
  conversation_id: string;
  project_id: string;
  kind: "default" | "named";
  title: string;
  revision: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};
export type ProjectRow = {
  project_id: string;
  kind: "project" | "desk" | "inbox" | "dialogue";
  owner_principal_id: string | null;
  member_principal_ids: string[];
  title: string;
  revision: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  deleted_at: string | null;
};
export type ProjectUnderstandingVersion = {
  projectId: string;
  revision: number;
  frameId: string;
  frameRevision: number;
  mindVersion: number;
  body: string;
  sources: Array<
    UnderstandingSource & { title: string | null; appId: string | null }
  >;
  publishedByPrincipalId: string;
  publishedByActantId: string;
  publishedAt: string;
};
type ProjectUnderstandingRow = {
  project_id: string;
  revision: number | string;
  frame_id: string;
  frame_revision: number | string;
  mind_version: number | string;
  body: string;
  sources_json: string;
  published_by_principal_id: string;
  published_by_actant_id: string;
  published_at: string;
};
type ProjectRetirementRequest = {
  commandId: string;
  projectId: string;
  expectedRevision: number;
  state: "archived" | "deleted";
  now?: string;
};
export type PersonalSpaces = {
  deskId: string;
  inboxId: string;
  dialogueId: string;
};
export type TaskVersionRow = {
  task_id: string;
  revision: number;
  /** NULL means the old immutable version did not record its project. */
  project_id: string | null;
  title: string;
  description: string;
  assignee_id: string;
  model_id: string | null;
  reasoning_effort: string | null;
  legacy_priority: "low" | "normal" | "high";
  due_date: string | null;
  assignment: "proposed" | "accepted" | "declined";
  execution: "planned" | "active" | "waiting" | "completed" | "cancelled";
  delivery: "none" | "ready" | "accepted";
  run_requested: number;
  not_before: string | null;
  every_seconds: number | null;
  author_principal_id: string;
  author_actant_id: string;
  created_at: string;
  result_ids: string[];
  depends_on_ids: string[];
  watch_source_ids: string[];
};
export type NotificationCandidateRow = {
  task_id: string;
  title: string;
  revision: number;
  entered_revision: number;
  entered_at: string;
  assignment: TaskVersionRow["assignment"];
  execution: TaskVersionRow["execution"];
  assignee_id: string;
  delivery: TaskVersionRow["delivery"];
  run_requested: number;
  result_ids: string[];
  phase_kind: "human" | "delivery";
};
export type TaskResponseRow = {
  response_id: string;
  task_id: string;
  task_revision: number;
  body: string;
  author_principal_id: string;
  author_actant_id: string;
  created_at: string;
};
/** A persisted link, not an authoritative Runtime execution status. */
export type TaskRunLink = {
  taskId: string;
  runNumber: number;
  taskRevision: number;
  sequence: number;
  runtime: {
    sessionId: string;
    scheduleId: string;
    threadId: string;
  };
  request: {
    intent: string;
    modelAlias: string | null;
    reasoningEffort: string | null;
    notBefore: string;
    intervalSeconds: number | null;
    dependencyThreadIds: string[];
  };
  observed: {
    scheduleRevision: number;
    scheduleStatus: string;
    scheduleNotBefore: string | null;
    scheduleIntervalSeconds: number | null;
    threadStatus: string | null;
  };
  bridge: {
    sourceSignature: string;
    watchSourceIds: string[];
    sourceCommandIds: string[];
    paused: boolean;
    sourceStopped: boolean;
    stopRequested: boolean;
    controlRevision: number;
    controlPending: string | null;
    error: string;
  };
};
export type ProjectRetirementRun = {
  sequence: number;
  runtime: TaskRunLink["runtime"];
  access: { principalId: string; actantId: string };
};
/** A trusted Host reads this from Runtime immediately before requesting the
 * next run. Terminal Schedule and Thread states are immutable in Runtime. */
export type PriorRuntimeObservation = {
  source: "runtime";
  runtime: { sessionId: string; scheduleId: string; threadId: string };
  schedule: { status: string };
  thread: { lifecycle: string };
};
export type PendingTaskRunStop = {
  taskId: string;
  runNumber: number;
  sequence: number;
  controlRevision: number;
  runtime: TaskRunLink["runtime"];
};
export type PendingTaskRunScheduleControl = PendingTaskRunStop & {
  action: "pause" | "resume";
};
export type TaskRunStopObservation = {
  source: "runtime";
  runtime: TaskRunLink["runtime"];
  schedule: {
    revision: number;
    status: "queued" | "paused" | "dispatched" | "completed" | "cancelled";
    notBefore: string | null;
    intervalSeconds: number | null;
  };
  thread: { lifecycle: "open" | "completed" | "failed" | "cancelled" };
};
type TaskRunLinkRow = {
  task_id: string;
  run_number: number | string;
  task_revision: number | string;
  sequence: number | string;
  runtime_session_id: string;
  runtime_schedule_id: string;
  runtime_thread_id: string;
  request_intent: string;
  request_model_alias: string | null;
  request_reasoning_effort: string | null;
  request_not_before: string;
  request_interval_seconds: number | string | null;
  observed_schedule_revision: number | string;
  observed_schedule_status: string;
  observed_schedule_not_before: string | null;
  observed_schedule_interval_seconds: number | string | null;
  observed_thread_status: string | null;
  source_signature: string;
  bridge_paused: number | string;
  bridge_source_stopped: number | string;
  bridge_stop_requested: number | string;
  bridge_control_revision: number | string;
  bridge_control_pending: string | null;
  bridge_error: string;
};
export class PlatformStorageError extends Error {
  constructor(
    readonly code: "invalid" | "forbidden" | "conflict" | "not_found",
    message: string,
  ) {
    super(message);
  }
}

function viewNavigationState(appId: string, value: unknown) {
  try {
    return parseApplicationViewState(appId, value);
  } catch {
    throw new PlatformStorageError(
      "invalid",
      "应用窗口只能保存导航位置；正文和草稿请由所属应用保存。",
    );
  }
}

const identifier = /^[a-zA-Z0-9_-]{1,100}$/;
function requireId(value: string, label: string) {
  if (typeof value !== "string" || !identifier.test(value))
    throw new PlatformStorageError("invalid", `${label}无效。`);
}
function requireAppId(value: string) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9.-]{2,80}$/.test(value))
    throw new PlatformStorageError("invalid", "应用标识无效。");
}
function requireTitle(value: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 180)
    throw new PlatformStorageError("invalid", "标题无效。");
}
function validTaskAgentSettings(request: {
  modelId?: string | null;
  reasoningEffort?: string | null;
  notBefore?: string | null;
  everySeconds?: number | null;
}) {
  return (
    (request.modelId == null ||
      (request.modelId.length >= 1 &&
        request.modelId.length <= 100 &&
        request.modelId.trim() === request.modelId)) &&
    (request.reasoningEffort == null ||
      ["none", "low", "medium", "high", "max"].includes(
        request.reasoningEffort,
      )) &&
    (request.notBefore == null ||
      (!Number.isNaN(Date.parse(request.notBefore)) &&
        new Date(request.notBefore).toISOString() === request.notBefore)) &&
    (request.everySeconds == null ||
      (Number.isSafeInteger(request.everySeconds) &&
        request.everySeconds >= 60 &&
        request.everySeconds <= 31536000))
  );
}
function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function nullableSafeInteger(value: number | string | null, label: string) {
  return value === null ? null : safeInteger(value, label);
}
function personalSpaceId(
  tenantId: string,
  principalId: string,
  kind: "desk" | "inbox" | "dialogue",
) {
  return `${kind}-${fingerprint([tenantId, principalId, kind]).slice(0, 32)}`;
}
/** Platform-owned relations only. No App body, user file bytes or Runtime Session. */
export class PlatformStore {
  private gate: Promise<unknown> = Promise.resolve();
  private readonly sqlChanges: SqlChangeSource;
  private constructor(
    private readonly backend: Backend,
    private readonly capabilities: PlatformAuthorityVerifier,
  ) {
    this.sqlChanges =
      backend.kind === "sqlite"
        ? sqliteChangeSource(backend.database)
        : postgresChangeSource(backend.pool.options, backend.schema);
  }

  changeSource(): SqlChangeSource {
    return this.sqlChanges;
  }

  private async authorize(access: PlatformActor): Promise<ResolvedActor> {
    if (!access.credential || access.credential.length > 4096)
      throw new PlatformStorageError("forbidden", "缺少已认证的操作身份。");
    const actor = await this.capabilities.resolveActor(access);
    if (!actor) throw new PlatformStorageError("forbidden", "操作身份已失效。");
    requireId(actor.tenantId, "租户标识");
    requireId(actor.principalId, "发起者标识");
    requireId(actor.actantId, "执行者标识");
    if (actor.runtimeInputId !== null)
      requireId(actor.runtimeInputId, "Runtime 输入标识");
    if (
      actor.kind === "agent" &&
      actor.runtimeInputId === null &&
      !actor.runtimeTaskRun
    )
      throw new PlatformStorageError(
        "forbidden",
        "Agent 操作缺少已持久化的发起来源。",
      );
    if (actor.kind === "agent" && actor.scopeProjectId === undefined)
      throw new PlatformStorageError(
        "forbidden",
        "Agent 操作缺少原始输入的项目范围。",
      );
    if (actor.scopeProjectId !== undefined)
      requireId(actor.scopeProjectId, "输入项目标识");
    if (actor.runtimeTaskRun) {
      if (actor.kind !== "agent" || !actor.initiatingHumanActantId)
        throw new PlatformStorageError("forbidden", "事项执行来源身份无效。");
      const admission = await this.taskRunAdmissionForRuntime(
        actor.tenantId,
        actor.runtimeTaskRun.sessionId,
        actor.runtimeTaskRun.scheduleId,
      );
      if (
        admission.eventId !== actor.runtimeTaskRun.eventId ||
        admission.principalId !== actor.principalId ||
        admission.humanActantId !== actor.initiatingHumanActantId ||
        admission.sourceInputId !== actor.runtimeInputId ||
        admission.projectId !== actor.scopeProjectId
      )
        throw new PlatformStorageError("forbidden", "事项执行来源已变化。");
    }
    return actor;
  }

  private async assertHumanTaskActor(actor: ResolvedActor) {
    if (actor.kind !== "human")
      throw new PlatformStorageError(
        "forbidden",
        "只有当前负责人可以操作这件事项。",
      );
    const actant = await this.capabilities.resolveActant({
      tenantId: actor.tenantId,
      actantId: actor.actantId,
    });
    if (
      !actant ||
      actant.kind !== "human" ||
      actant.principalId !== actor.principalId
    )
      throw new PlatformStorageError("forbidden", "当前负责人身份已失效。");
  }

  private async prepareCognitiveActor(
    access: PlatformActor,
    humanOnly = false,
  ): Promise<PreparedCognitiveActor> {
    const resolved = await this.authorize(access);
    const actor: ResolvedActor = {
      ...resolved,
      ...(resolved.runtimeTaskRun
        ? { runtimeTaskRun: { ...resolved.runtimeTaskRun } }
        : {}),
    };
    if (actor.kind === "provider" || (humanOnly && actor.kind !== "human"))
      throw new PlatformStorageError(
        "forbidden",
        "只有已认证 Human 可以管理本人应用许可与连接。",
      );
    const humanActantId =
      actor.kind === "human" ? actor.actantId : actor.initiatingHumanActantId;
    if (!humanActantId)
      throw new PlatformStorageError(
        "forbidden",
        "应用调用缺少实际发起 Human。",
      );
    requireId(humanActantId, "发起 Human 标识");
    const human = await this.capabilities.resolveActant({
      tenantId: actor.tenantId,
      actantId: humanActantId,
    });
    if (human?.kind !== "human" || human.principalId !== actor.principalId)
      throw new PlatformStorageError(
        "forbidden",
        "应用调用的实际发起 Human 已失效或不匹配。",
      );
    let executor: PreparedExecutor | undefined;
    if (actor.kind === "agent") {
      const actual = await this.capabilities.resolveActant({
        tenantId: actor.tenantId,
        actantId: actor.actantId,
      });
      if (actual?.kind !== "agent")
        throw new PlatformStorageError("forbidden", "Agent 执行身份已失效。");
      requireId(actual.principalId, "Agent 成员标识");
      executor = {
        tenantId: actor.tenantId,
        actantId: actor.actantId,
        principalId: actual.principalId,
        kind: "agent",
      };
    }
    // A scheduled source remains a task-run even if it retained an original
    // input. authorize() has checked the actual prepared Platform admission.
    const source =
      actor.kind === "human"
        ? { kind: "human" }
        : actor.runtimeTaskRun
          ? {
              kind: "task-run",
              ...actor.runtimeTaskRun,
              sourceInputId: actor.runtimeInputId,
              humanActantId,
            }
          : { kind: "input", inputId: actor.runtimeInputId, humanActantId };
    return {
      actor,
      executor,
      domainActor: parseDomainActor({
        tenantId: actor.tenantId,
        principalId: actor.principalId,
        actantId: actor.actantId,
        kind: actor.kind,
        source,
      }),
    };
  }

  private cognitiveRegistry(
    q: Query,
    actor: Pick<ResolvedActor, "tenantId" | "principalId">,
  ) {
    return createCognitiveAppRegistry({
      q,
      backend: this.backend.kind,
      tenantId: actor.tenantId,
      principalId: actor.principalId,
      fail: (code, message) => {
        throw new PlatformStorageError(code, message);
      },
    });
  }

  private cognitiveCommands(q: Query, tenantId: string) {
    return createCognitiveAppCommands({
      q,
      backend: this.backend.kind,
      tenantId,
      fail: (code, message) => {
        throw new PlatformStorageError(code, message);
      },
    });
  }

  /** Actual Human installation only. No grant is silently created. GUI bytes
   * require a genuine Host proof and current exact UI row in the same q. */
  async installCognitiveApp(
    access: PlatformActor,
    request: { definition: unknown; now?: string; verifiedUi?: unknown },
  ) {
    const now = request.now ?? new Date().toISOString();
    const proof = readCognitiveAppUiByteProof(request.verifiedUi);
    let definition: CognitiveAppDefinition;
    try {
      // Independent bounded snapshot before identity I/O yields to the caller;
      // retain the genuine frozen proof reference, never clone its capability.
      // Schema parsers validate their JSON subtrees but may retain references.
      // Detach the entire bounded declaration, including nested Schema enum,
      // properties and required arrays, before the first identity await.
      definition = parseCognitiveAppDefinition(
        JSON.parse(
          Buffer.from(
            canonicalJsonBytes(parseCognitiveAppDefinition(request.definition)),
          ).toString("utf8"),
        ),
      );
    } catch {
      throw new PlatformStorageError("invalid", "应用定义不符合有界声明协议。");
    }
    if (definition.ui !== null && !proof)
      throw new PlatformStorageError(
        "invalid",
        "界面字节缺少实际 Host 核验的安装证明。",
      );
    const { actor } = await this.prepareCognitiveActor(access, true);
    return this.transaction(async (q) => {
      const result = await this.cognitiveRegistry(q, actor).installVersion(
        definition,
        now,
        proof,
      );
      if (hasSqlChanges(q))
        await this.advanceNavigation(q, actor.tenantId, ["access"]);
      return result;
    });
  }

  async changeCognitiveAppGrant(
    access: PlatformActor,
    request: Omit<CognitiveAppGrantChange, "now"> & { now?: string },
  ) {
    const { actor } = await this.prepareCognitiveActor(access, true);
    return this.transaction(async (q) => {
      const result = await this.cognitiveRegistry(q, actor).changeOwnGrant({
        ...request,
        now: request.now ?? new Date().toISOString(),
      });
      if (hasSqlChanges(q))
        await this.advanceNavigation(q, actor.tenantId, ["access"]);
      return result;
    });
  }

  async listCognitiveApps(
    access: PlatformActor,
    request: CognitiveAppRegistryCatalogRequest,
  ) {
    const { actor, executor } = await this.prepareCognitiveActor(access);
    return this.transaction(async (q) => {
      if (actor.kind === "agent")
        await this.assertProjectReader(
          q,
          actor,
          actor.scopeProjectId!,
          executor,
        );
      return this.cognitiveRegistry(q, actor).readOwnRegistry(request);
    }, "read");
  }

  /** Host-only pre-describe consent snapshot. Not registered on transports. */
  async prepareCognitiveAppConnection(
    access: PlatformActor,
    request: CognitiveAppConsentRequest,
  ) {
    const prepared = await this.prepareCognitiveActor(access, true);
    return this.transaction(async (q) => ({
      actor: prepared.domainActor,
      ...(await this.cognitiveRegistry(q, prepared.actor).lockOwnConsent(
        request,
      )),
    }));
  }

  private assertCognitiveConnectionProof(
    proof: HostVerifiedCognitiveConnectionProof,
  ) {
    if (
      !proof ||
      proof.purpose !== "connection-setup" ||
      typeof proof.definitionHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(proof.definitionHash)
    )
      throw new PlatformStorageError("invalid", "Host 连接设置证明无效。");
  }

  /** Host-internal only: a trusted Gateway's authenticated describe result.
   * No URL or credential is accepted or published by this relational port. */
  async createVerifiedCognitiveAppConnection(
    access: PlatformActor,
    request: HostVerifiedCognitiveConnectionCreate,
  ) {
    const { actor } = await this.prepareCognitiveActor(access, true);
    this.assertCognitiveConnectionProof(request.proof);
    return this.transaction(async (q) => {
      const registry = this.cognitiveRegistry(q, actor);
      await registry.lockOwnConsent({
        appId: request.proof.appId,
        version: request.proof.version,
        expectedDefinitionHash: request.proof.definitionHash,
        expectedGrantRevision: request.expectedGrantRevision,
      });
      const result = await registry.createOwnConnection({
        ...request.proof,
        connectionId: request.connectionId,
        expectedRevision: request.expectedRevision,
        now: request.now ?? new Date().toISOString(),
      });
      if (hasSqlChanges(q))
        await this.advanceNavigation(q, actor.tenantId, ["access"]);
      return result;
    });
  }

  async changeVerifiedCognitiveAppConnection(
    access: PlatformActor,
    request: HostVerifiedCognitiveConnectionChange,
  ) {
    const { actor } = await this.prepareCognitiveActor(access, true);
    this.assertCognitiveConnectionProof(request.proof);
    return this.transaction(async (q) => {
      const registry = this.cognitiveRegistry(q, actor);
      // Exact versions are immutable. Do not let disabling a connection depend
      // on a still-active consent, but never admit a new active target revoked.
      await registry.lockRetainedVersion({
        appId: request.proof.appId,
        version: request.proof.version,
        expectedDefinitionHash: request.proof.definitionHash,
      });
      if (request.state === "active")
        await registry.lockOwnConsent({
          appId: request.proof.appId,
          version: request.proof.version,
          expectedDefinitionHash: request.proof.definitionHash,
          expectedGrantRevision: request.expectedGrantRevision,
        });
      const result = await registry.changeOwnConnection({
        ...request.proof,
        expectedAppId: request.proof.appId,
        connectionId: request.connectionId,
        expectedRevision: request.expectedRevision,
        state: request.state,
        now: request.now ?? new Date().toISOString(),
      });
      if (hasSqlChanges(q))
        await this.advanceNavigation(q, actor.tenantId, ["access"]);
      return result;
    });
  }

  /** Actual Human state management derives the immutable private route from
   * its owned relation. Disabling needs no secret, network, or active consent.
   */
  async changeCognitiveAppConnectionState(
    access: PlatformActor,
    request: CognitiveAppConnectionStateRequest,
  ): Promise<CognitiveAppConnection> {
    const { actor } = await this.prepareCognitiveActor(access, true);
    return this.transaction(async (q) => {
      const registry = this.cognitiveRegistry(q, actor);
      await registry.lockRetainedVersion({
        appId: request.appId,
        version: request.version,
        expectedDefinitionHash: request.expectedDefinitionHash,
      });
      if (request.state === "active")
        await registry.lockOwnConsent({
          appId: request.appId,
          version: request.version,
          expectedDefinitionHash: request.expectedDefinitionHash,
          expectedGrantRevision: request.expectedGrantRevision,
        });
      const connection = await registry.readOwnConnectionForManagement({
        appId: request.appId,
        connectionId: request.connectionId,
      });
      const result = await registry.changeOwnConnection({
        expectedAppId: request.appId,
        connectionId: connection.connectionId,
        serviceId: connection.serviceId,
        dataAuthorityId: connection.dataAuthorityId,
        hostBindingId: connection.hostBindingId,
        expectedRevision: request.expectedRevision,
        state: request.state,
        now: request.now ?? new Date().toISOString(),
      });
      if (hasSqlChanges(q))
        await this.advanceNavigation(q, actor.tenantId, ["access"]);
      return result;
    });
  }

  /** Private alias read is purpose-neutral; later Gateway dispatch/recovery
   * must prove its own durable command purpose. This is not send authority. */
  async getCognitiveAppHostConnection(
    access: PlatformActor,
    request: CognitiveAppHostConnectionRequest & { projectId: string },
  ) {
    const { actor, executor } = await this.prepareCognitiveActor(access);
    requireId(request.projectId, "项目标识");
    return this.transaction(async (q) => {
      await this.assertProjectReader(q, actor, request.projectId, executor);
      return this.cognitiveRegistry(q, actor).readHostConnection(request);
    });
  }

  private snapshotCognitiveOperationRequest(
    input: CognitiveAppOperationResolutionRequest,
  ): CognitiveAppOperationResolutionRequest {
    // Capture known tuple scalars before the first asynchronous identity/SQL
    // read. Do not canonicalize the whole request: optional undefined premises
    // are legitimate, and caller-added identity/effect/hash fields are ignored.
    const {
      projectId,
      appId,
      version,
      connectionId,
      operationId,
      expectedDefinitionHash,
      expectedGrantRevision,
      expectedConnectionRevision,
    } = input;
    try {
      // A detached JSON carrier, not persisted business data. The JSON budget
      // allows legal NUL/surrogate body text; raw identity guards do not apply.
      const parameters = JSON.parse(
        Buffer.from(
          canonicalJsonBytes(parseProtocolValue(input.parameters)),
        ).toString("utf8"),
      ) as JsonValue;
      // Zod's array/object parser returns new references. Project is only the
      // framing shape here; the fixed declaration's scope is checked below.
      const resources = parseOperationResources("project", input.resources);
      return {
        projectId,
        appId,
        version,
        connectionId,
        operationId,
        expectedDefinitionHash,
        expectedGrantRevision,
        expectedConnectionRevision,
        parameters,
        resources,
      };
    } catch {
      throw new PlatformStorageError(
        "invalid",
        "应用参数或资源不是有界 JSON。",
      );
    }
  }

  private async cognitiveOperationDeclaration(
    q: Query,
    actor: Pick<ResolvedActor, "tenantId" | "principalId">,
    request: CognitiveAppOperationResolutionRequest,
  ): Promise<CognitiveAppOperationDeclaration> {
    requireId(request.projectId, "项目标识");
    const version = await this.cognitiveRegistry(q, actor).readExactVersion(
      request.appId,
      request.version,
    );
    const operation = version.definition.operations.find(
      (op) => op.id === request.operationId,
    );
    if (!operation)
      throw new PlatformStorageError("not_found", "应用未声明这项操作。");
    try {
      return {
        version,
        operation,
        parameters: validateOperationValue(
          operation.inputSchema,
          request.parameters,
        ),
        resources: parseOperationResources(operation.scope, request.resources),
      };
    } catch {
      throw new PlatformStorageError(
        "invalid",
        "应用参数或精确资源引用不符合固定声明。",
      );
    }
  }

  private async assertCognitiveOperationPolicy(
    q: Query,
    prepared: PreparedCognitiveActor,
    projectId: string,
    operation: OperationDefinition,
  ) {
    if (operation.effect === "read")
      await this.assertProjectReader(
        q,
        prepared.actor,
        projectId,
        prepared.executor,
      );
    else
      await this.assertMember(
        q,
        prepared.actor,
        projectId,
        true,
        true,
        prepared.executor,
      );
  }

  private async resolveCognitiveOperationTarget(
    q: Query,
    prepared: PreparedCognitiveActor,
    request: CognitiveAppOperationResolutionRequest,
    declaration: CognitiveAppOperationDeclaration,
  ): Promise<ResolvedCognitiveAppOperation> {
    const { version, operation, parameters, resources } = declaration;
    const target = await this.cognitiveRegistry(
      q,
      prepared.actor,
    ).lockCurrentTarget({
      appId: request.appId,
      version: request.version,
      connectionId: request.connectionId,
      expectedDefinitionHash:
        request.expectedDefinitionHash ?? version.definitionHash,
      expectedGrantRevision: request.expectedGrantRevision,
      expectedConnectionRevision: request.expectedConnectionRevision,
    });
    if (target.definitionHash !== version.definitionHash)
      throw new PlatformStorageError(
        "conflict",
        "应用固定声明在权限核验时已变化。",
      );
    // Lock a sorted COPY; semantic resources and the request hash retain order.
    const authorizationResources = [...resources].sort((a, b) =>
      a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0,
    );
    for (const resource of authorizationResources) {
      const row = await this.authorizeApplicationObjectRow(
        q,
        prepared.actor,
        target.instanceId,
        target.appId,
        resource.objectId,
        operation.effect === "read" ? "read" : "write",
        undefined,
        prepared.executor,
        operation.effect !== "read",
      );
      if (row.project_id !== request.projectId)
        throw new PlatformStorageError(
          "forbidden",
          "应用资源不属于本次实际项目。",
        );
      if (row.availability !== "available")
        throw new PlatformStorageError("not_found", "应用资源当前不可用。");
      if (
        operation.effect !== "read" &&
        row.observed_version_ref !== resource.versionRef
      )
        throw new PlatformStorageError(
          "conflict",
          "写入或执行的目录基线已变化。",
        );
    }
    return {
      actor: prepared.domainActor,
      target,
      operation,
      parameters,
      resources,
    };
  }

  async resolveCognitiveAppOperation(
    access: PlatformActor,
    input: CognitiveAppOperationResolutionRequest,
  ): Promise<ResolvedCognitiveAppOperation> {
    const request = this.snapshotCognitiveOperationRequest(input);
    const prepared = await this.prepareCognitiveActor(access);
    return this.transaction(async (q) => {
      const declaration = await this.cognitiveOperationDeclaration(
        q,
        prepared.actor,
        request,
      );
      await this.assertCognitiveOperationPolicy(
        q,
        prepared,
        request.projectId,
        declaration.operation,
      );
      return this.resolveCognitiveOperationTarget(
        q,
        prepared,
        request,
        declaration,
      );
    });
  }

  /** Actual source/member/catalog policy without inventing an invoke operation
   * or treating the observed catalog head as an authority on App history. */
  async resolveCognitiveAppObjectRead(
    access: PlatformActor,
    input: CognitiveAppObjectReadRequest,
  ): Promise<ResolvedCognitiveAppObjectRead> {
    // Snapshot known identity scalars and independently parsed references
    // before asynchronous identity/SQL work can yield to the caller.
    const {
      projectId,
      appId,
      version,
      connectionId,
      expectedDefinitionHash,
      expectedGrantRevision,
      expectedConnectionRevision,
      maxBytes,
    } = input;
    let object: OperationResourceReference;
    try {
      object = parseOperationResources("objects", [input.object])[0]!;
    } catch {
      throw new PlatformStorageError("invalid", "精确原件引用无效。");
    }
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > domainWireLimits.objectReadBytes
    )
      throw new PlatformStorageError("invalid", "原件读取字节上限无效。");
    requireId(projectId, "项目标识");
    const prepared = await this.prepareCognitiveActor(access);
    return this.transaction(async (q) => {
      await this.assertProjectReader(
        q,
        prepared.actor,
        projectId,
        prepared.executor,
      );
      const target = await this.cognitiveRegistry(
        q,
        prepared.actor,
      ).lockCurrentTarget({
        appId,
        version,
        connectionId,
        expectedDefinitionHash,
        expectedGrantRevision,
        expectedConnectionRevision,
      });
      const row = await this.authorizeApplicationObjectRow(
        q,
        prepared.actor,
        target.instanceId,
        target.appId,
        object.objectId,
        "read",
        undefined,
        prepared.executor,
      );
      if (row.project_id !== projectId)
        throw new PlatformStorageError(
          "forbidden",
          "应用原件不属于本次实际项目。",
        );
      if (row.availability !== "available")
        throw new PlatformStorageError("not_found", "应用原件当前不可用。");
      return { actor: prepared.domainActor, target, object, maxBytes };
    });
  }

  /** Host-only committed-fact projection. Never a caller-supplied business
   * result or a public permission/dispatch port. All bookkeeping and its one
   * navigation notification commit or roll back in the same transaction. */
  async projectCognitiveAppCommand(
    input: CognitiveAppHostCommandRequest & {
      expectedCommandRevision: number;
    },
  ): Promise<CognitiveAppProjectionResult | null> {
    const { tenantId, commandId, expectedCommandRevision } = input;
    requireId(tenantId, "租户标识");
    return this.transaction(async (q) => {
      const result = await createCognitiveAppProjection({
        q,
        backend: this.backend.kind,
        tenantId,
        fail: (code, message) => {
          throw new PlatformStorageError(code, message);
        },
      }).projectCommitted({
        commandId,
        expectedRevision: expectedCommandRevision,
      });
      // A same-head or empty summary is still a first committed delivery.
      // A replay returns null and must not notify navigation again.
      if (result !== null) await this.advanceNavigation(q, tenantId, []);
      return result;
    });
  }

  private cognitiveRequestHash(
    authority: CognitiveAppCommandSnapshot["authority"],
    actor: DomainActor,
    projectId: string,
    operationId: string,
    parameters: JsonValue,
    resources: readonly OperationResourceReference[],
  ) {
    // Exactly the SDK's normative semantic object, without inventing a transport
    // issuer/expiry. Neither a caller hash nor a current mutable revision is input.
    return createHash("sha256")
      .update(
        canonicalJsonBytes({
          protocol: domainProtocol,
          authority,
          actor,
          projectId,
          operationId,
          parameters,
          resources,
        }),
      )
      .digest("hex");
  }

  private assertCognitiveCommandOwner(
    current: CognitiveAppCommandSnapshot,
    actual: DomainActor,
  ) {
    if (
      !Buffer.from(canonicalJsonBytes(current.actor)).equals(
        Buffer.from(canonicalJsonBytes(actual)),
      )
    )
      throw new PlatformStorageError(
        "forbidden",
        "命令不属于本次实际参与者与持久来源。",
      );
  }

  private cognitiveCommandAdmission(current: CognitiveAppCommandSnapshot) {
    const {
      commandId,
      requestHash,
      authority,
      actor,
      projectId,
      operationId,
      effect,
      operationScope,
      resources,
      connectionId,
      connectionRevision,
      grantRevision,
    } = current;
    return {
      commandId,
      requestHash,
      authority,
      actor,
      projectId,
      operationId,
      effect,
      operationScope,
      resources,
      connectionId,
      connectionRevision,
      grantRevision,
    };
  }

  private assertCognitiveCommandReplay(
    current: CognitiveAppCommandSnapshot,
    request: CognitiveAppCommandRequest,
    declaration: CognitiveAppOperationDeclaration,
  ) {
    if (
      request.projectId !== current.projectId ||
      request.appId !== current.authority.appId ||
      request.version !== current.authority.version ||
      request.connectionId !== current.connectionId ||
      request.operationId !== current.operationId ||
      declaration.version.definitionHash !== current.authority.definitionHash ||
      declaration.operation.effect !== current.effect ||
      declaration.operation.scope !== current.operationScope ||
      (request.expectedDefinitionHash !== undefined &&
        request.expectedDefinitionHash !== current.authority.definitionHash) ||
      (request.expectedGrantRevision !== undefined &&
        request.expectedGrantRevision !== current.grantRevision) ||
      (request.expectedConnectionRevision !== undefined &&
        request.expectedConnectionRevision !== current.connectionRevision) ||
      !Buffer.from(canonicalJsonBytes(declaration.resources)).equals(
        Buffer.from(canonicalJsonBytes(current.resources)),
      ) ||
      this.cognitiveRequestHash(
        current.authority,
        current.actor,
        current.projectId,
        current.operationId,
        declaration.parameters,
        current.resources,
      ) !== current.requestHash
    )
      throw new PlatformStorageError(
        "conflict",
        "原命令的固定目标、资源或参数身份不一致。",
      );
  }

  async admitCognitiveAppCommand(
    access: PlatformActor,
    input: CognitiveAppCommandRequest,
  ): Promise<PreparedCognitiveAppCommand> {
    const commandId = input.commandId;
    const request = {
      ...this.snapshotCognitiveOperationRequest(input),
      commandId,
    };
    const prepared = await this.prepareCognitiveActor(access);
    requireId(request.commandId, "命令标识");
    return this.transaction(async (q) => {
      const commands = this.cognitiveCommands(q, prepared.actor.tenantId);
      const declaration = await this.cognitiveOperationDeclaration(
        q,
        prepared.actor,
        request,
      );
      if (declaration.operation.effect === "read")
        throw new PlatformStorageError(
          "invalid",
          "只读操作不能受理副作用命令。",
        );
      const prior = await commands.read(request.commandId);
      if (prior) {
        await this.assertProjectReader(
          q,
          prepared.actor,
          prior.projectId,
          prepared.executor,
        );
        this.assertCognitiveCommandOwner(prior, prepared.domainActor);
        this.assertCognitiveCommandReplay(prior, request, declaration);
        // The ledger re-locks and compares its complete immutable admission.
        // Revoked current consent cannot rewrite or hide original facts.
        const command = await commands.admit(
          this.cognitiveCommandAdmission(prior),
        );
        return {
          command,
          operation: declaration.operation,
          parameters: declaration.parameters,
        };
      }
      await this.assertCognitiveOperationPolicy(
        q,
        prepared,
        request.projectId,
        declaration.operation,
      );
      const raced = await commands.lockForAdmission(request.commandId);
      if (raced) {
        this.assertCognitiveCommandOwner(raced, prepared.domainActor);
        this.assertCognitiveCommandReplay(raced, request, declaration);
        return {
          command: await commands.admit(this.cognitiveCommandAdmission(raced)),
          operation: declaration.operation,
          parameters: declaration.parameters,
        };
      }
      const resolved = await this.resolveCognitiveOperationTarget(
        q,
        prepared,
        request,
        declaration,
      );
      const {
        appId,
        version,
        definitionHash,
        instanceId,
        serviceId,
        dataAuthorityId,
      } = resolved.target;
      const authority = {
        appId,
        version,
        definitionHash,
        instanceId,
        serviceId,
        dataAuthorityId,
      };
      const command = await commands.admit({
        commandId: request.commandId,
        requestHash: this.cognitiveRequestHash(
          authority,
          resolved.actor,
          request.projectId,
          request.operationId,
          resolved.parameters,
          resolved.resources,
        ),
        authority,
        actor: resolved.actor,
        projectId: request.projectId,
        operationId: resolved.operation.id,
        effect: resolved.operation.effect as "write" | "execute",
        operationScope: resolved.operation.scope,
        resources: resolved.resources,
        connectionId: resolved.target.connectionId,
        connectionRevision: resolved.target.connectionRevision,
        grantRevision: resolved.target.grantRevision,
      });
      return {
        command,
        operation: resolved.operation,
        parameters: resolved.parameters,
      };
    });
  }

  async dispatchCognitiveAppCommand(
    access: PlatformActor,
    input: CognitiveAppCommandRequest & { expectedCommandRevision: number },
  ): Promise<PreparedCognitiveAppCommand | null> {
    const { commandId, expectedCommandRevision } = input;
    const request = {
      ...this.snapshotCognitiveOperationRequest(input),
      commandId,
      expectedCommandRevision,
    };
    const prepared = await this.prepareCognitiveActor(access);
    requireId(request.commandId, "命令标识");
    if (
      !Number.isSafeInteger(request.expectedCommandRevision) ||
      request.expectedCommandRevision < 1 ||
      request.expectedCommandRevision >= Number.MAX_SAFE_INTEGER
    )
      throw new PlatformStorageError("invalid", "命令发送修订前提无效。");
    return this.transaction(async (q) => {
      const commands = this.cognitiveCommands(q, prepared.actor.tenantId);
      const prior = await commands.read(request.commandId);
      if (!prior) throw new PlatformStorageError("not_found", "命令尚未受理。");
      this.assertCognitiveCommandOwner(prior, prepared.domainActor);
      const declaration = await this.cognitiveOperationDeclaration(
        q,
        prepared.actor,
        request,
      );
      this.assertCognitiveCommandReplay(prior, request, declaration);
      // Policy/project locks precede the command lock. Known terminal/unknown
      // results are inspection, never permission to resend or to change target.
      if (
        prior.state !== "admitted" ||
        prior.revision !== request.expectedCommandRevision
      ) {
        await this.assertProjectReader(
          q,
          prepared.actor,
          prior.projectId,
          prepared.executor,
        );
        return null;
      }
      await this.assertCognitiveOperationPolicy(
        q,
        prepared,
        prior.projectId,
        declaration.operation,
      );
      const current = await commands.lockForAdmission(request.commandId);
      if (
        !current ||
        current.state !== "admitted" ||
        current.revision !== request.expectedCommandRevision
      )
        return null;
      this.assertCognitiveCommandOwner(current, prepared.domainActor);
      this.assertCognitiveCommandReplay(current, request, declaration);
      await this.resolveCognitiveOperationTarget(
        q,
        prepared,
        {
          ...request,
          expectedDefinitionHash: current.authority.definitionHash,
          expectedGrantRevision: current.grantRevision,
          expectedConnectionRevision: current.connectionRevision,
        },
        declaration,
      );
      const command = await commands.dispatch(
        request.commandId,
        request.expectedCommandRevision,
      );
      return command
        ? {
            command,
            operation: declaration.operation,
            parameters: declaration.parameters,
          }
        : null;
    });
  }

  async inspectCognitiveAppCommand(
    access: PlatformActor,
    request: { projectId: string; commandId: string },
  ): Promise<CognitiveAppCommandSnapshot> {
    const prepared = await this.prepareCognitiveActor(access);
    requireId(request.projectId, "项目标识");
    return this.transaction(async (q) => {
      await this.assertProjectReader(
        q,
        prepared.actor,
        request.projectId,
        prepared.executor,
      );
      const command = await this.cognitiveCommands(
        q,
        prepared.actor.tenantId,
      ).read(request.commandId);
      if (!command || command.projectId !== request.projectId)
        throw new PlatformStorageError("not_found", "命令不存在于这个项目。");
      if (command.actor.principalId !== prepared.actor.principalId)
        throw new PlatformStorageError(
          "forbidden",
          "不能查看另一位参与者的本人命令。",
        );
      if (prepared.actor.kind === "agent")
        this.assertCognitiveCommandOwner(command, prepared.domainActor);
      return command;
    }, "read");
  }

  /** Receipt-only Host recovery derives ALL authority/source from a durable old
   * admission. No live Runtime credential or generic disabled-target flag exists.
   * The exact original personal connection must still be active for network use.
   */
  async prepareCognitiveAppReceiptRecovery(
    request: CognitiveAppHostCommandRequest,
  ): Promise<PreparedCognitiveAppReceiptRecovery> {
    requireId(request.tenantId, "租户标识");
    return this.transaction(async (q) => {
      const command = await this.cognitiveCommands(q, request.tenantId).read(
        request.commandId,
      );
      if (!command)
        throw new PlatformStorageError("not_found", "命令尚未受理。");
      if (command.state === "admitted" || command.state === "cancelled")
        throw new PlatformStorageError(
          "conflict",
          "确知未发送的命令不能读取服务回执。",
        );
      const registry = this.cognitiveRegistry(q, {
        tenantId: request.tenantId,
        principalId: command.actor.principalId,
      });
      const version = await registry.readExactVersion(
        command.authority.appId,
        command.authority.version,
      );
      if (version.definitionHash !== command.authority.definitionHash)
        throw new PlatformStorageError(
          "conflict",
          "原命令的不可变应用定义不一致。",
        );
      const connection = await registry.readHostConnection({
        ...command.authority,
        connectionId: command.connectionId,
      });
      return { command, definition: version.definition, connection };
    });
  }

  /** Only the Gateway's authenticated fixed-route response may enter this port.
   * Full expected binding is revalidated by the ledger, even after revocation.
   */
  async recordCognitiveAppCommandReceipt(
    request: CognitiveAppHostCommandRequest & { receipt: unknown },
  ): Promise<CognitiveAppCommandSnapshot> {
    requireId(request.tenantId, "租户标识");
    return this.transaction((q) =>
      this.cognitiveCommands(q, request.tenantId).recordReceipt(
        request.commandId,
        request.receipt,
      ),
    );
  }

  async markCognitiveAppCommandUnknown(
    request: CognitiveAppHostCommandRequest & {
      expectedCommandRevision: number;
    },
  ): Promise<CognitiveAppCommandSnapshot | null> {
    requireId(request.tenantId, "租户标识");
    return this.transaction((q) =>
      this.cognitiveCommands(q, request.tenantId).markUnknown(
        request.commandId,
        request.expectedCommandRevision,
      ),
    );
  }

  /** Explicit known-unsent cancellation only, never a timeout workaround. */
  async cancelAdmittedCognitiveAppCommand(
    request: CognitiveAppHostCommandRequest & {
      expectedCommandRevision: number;
    },
  ): Promise<CognitiveAppCommandSnapshot | null> {
    requireId(request.tenantId, "租户标识");
    return this.transaction((q) =>
      this.cognitiveCommands(q, request.tenantId).cancelAdmitted(
        request.commandId,
        request.expectedCommandRevision,
      ),
    );
  }

  async listRecoverableCognitiveAppCommands(
    request: { tenantId: string } & CognitiveAppCommandPage,
  ): Promise<CognitiveAppCommandSnapshot[]> {
    requireId(request.tenantId, "租户标识");
    return this.transaction(
      (q) =>
        this.cognitiveCommands(q, request.tenantId).listRecoverable({
          afterCommandId: request.afterCommandId,
          limit: request.limit,
        }),
      "read",
    );
  }

  async listPendingCognitiveAppCommandProjections(
    request: { tenantId: string } & CognitiveAppCommandPage,
  ): Promise<CognitiveAppCommandSnapshot[]> {
    requireId(request.tenantId, "租户标识");
    return this.transaction(
      (q) =>
        this.cognitiveCommands(q, request.tenantId).listPendingProjection({
          afterCommandId: request.afterCommandId,
          limit: request.limit,
        }),
      "read",
    );
  }

  static async sqlite(
    filename: string,
    capabilities: PlatformAuthorityVerifier,
  ): Promise<PlatformStore> {
    if (filename !== ":memory:")
      mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    if (filename !== ":memory:" && existsSync(filename)) {
      const existing = new DatabaseSync(filename, { readOnly: true });
      try {
        const tables = existing
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
          )
          .all();
        const platform = existing
          .prepare(
            "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='platform_schema_version'",
          )
          .get();
        if (tables.length && !platform)
          throw new PlatformStorageError(
            "conflict",
            "目标文件已有非 Platform 数据，拒绝在旧库中创建新表。",
          );
      } finally {
        existing.close();
      }
    }
    const database = new DatabaseSync(filename);
    try {
      if (filename !== ":memory:") chmodSync(filename, 0o600);
      database.exec(
        "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;",
      );
      const store = new PlatformStore(
        {
          kind: "sqlite",
          database,
          writeGateKey: filename === ":memory:" ? null : realpathSync(filename),
        },
        capabilities,
      );
      await store.initialize();
      return store;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  /** The schema and its database role are provisioned by deployment, not a model tool. */
  static async postgres(
    options: {
      connectionString: string;
      schema: string;
    },
    capabilities: PlatformAuthorityVerifier,
  ): Promise<PlatformStore> {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(options.schema))
      throw new PlatformStorageError("invalid", "数据库 schema 名称无效。");
    const pool = new Pool({
      connectionString: options.connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    try {
      const store = new PlatformStore(
        {
          kind: "postgres",
          pool,
          schema: options.schema,
        },
        capabilities,
      );
      await store.initialize();
      return store;
    } catch (error) {
      await pool.end();
      throw error;
    }
  }

  private async transaction<T>(
    work: (q: Query) => Promise<T>,
    mode: "read" | "write" = "write",
  ): Promise<T> {
    if (this.backend.kind === "sqlite") {
      const database = this.backend.database;
      const writeGateKey = this.backend.writeGateKey;
      const run = async () => {
        if (mode === "read") database.exec("PRAGMA query_only=ON");
        try {
          database.exec(mode === "read" ? "BEGIN" : "BEGIN IMMEDIATE");
          try {
            const q = sqliteQuery(database);
            const result = await work(q);
            database.exec("COMMIT");
            publishSqlCommit(q, this.sqlChanges);
            return result;
          } catch (error) {
            database.exec("ROLLBACK");
            throw error;
          }
        } finally {
          if (mode === "read") database.exec("PRAGMA query_only=OFF");
        }
      };
      const scheduled = () =>
        mode === "write" && writeGateKey !== null
          ? withSqliteWriteGate(writeGateKey, run)
          : run();
      const pending = this.gate.then(scheduled, scheduled);
      this.gate = pending.catch(() => undefined);
      return pending;
    }
    const client = await this.backend.pool.connect();
    try {
      // A read can join authorization, project metadata and membership in
      // several statements. Keep them on one snapshot so a concurrent
      // membership change cannot produce a mixed project view.
      await client.query(
        mode === "read"
          ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
          : "BEGIN",
      );
      await client.query(
        `SET LOCAL search_path TO "${this.backend.schema}", pg_catalog`,
      );
      const q = postgresQuery(client);
      const result = await work(q);
      await prepareSqlCommit(q, this.sqlChanges);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async initialize() {
    await this.transaction(async (q) => {
      if (this.backend.kind === "postgres")
        await q.all(
          "SELECT pg_advisory_xact_lock(hashtextextended(current_database() || ':' || current_schema(), 0)) AS locked",
        );
      const tables =
        this.backend.kind === "postgres"
          ? await q.all<{ name: string }>(
              "SELECT tablename AS name FROM pg_catalog.pg_tables WHERE schemaname=current_schema()",
            )
          : await q.all<{ name: string }>(
              "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            );
      if (
        tables.length &&
        !tables.some((table) => table.name === "platform_schema_version")
      )
        throw new PlatformStorageError(
          "conflict",
          "目标数据库含有非 Platform 表，拒绝自动混用。",
        );
      await q.exec(
        "CREATE TABLE IF NOT EXISTS platform_schema_version (version BIGINT PRIMARY KEY CHECK(version > 0), schema_sha256 TEXT NOT NULL)",
      );
      let versions: { version: number | string; schema_sha256: string }[];
      try {
        versions = await q.all<{
          version: number | string;
          schema_sha256: string;
        }>("SELECT version,schema_sha256 FROM platform_schema_version");
      } catch {
        throw new PlatformStorageError(
          "conflict",
          "Platform 数据库版本标记不完整，拒绝打开。",
        );
      }
      const schemaSha256 = schemaHash(platformSchemaSql);
      const previousSchemaSha256 =
        "8cf6082fe757e99cef6f09989e38e03751ac4f70ae950ecb4d8c1158a6c79f58";
      const v3SchemaSha256 =
        "c327f57f68bfa092ef74995cf6a7040342b192380e20d61d6a94412ff94579a8";
      const v4SchemaSha256 =
        "3032316482d0ef73300ee1446cf9d8024914259152d11d95e13202cfd61be355";
      const v5SchemaSha256 =
        "72a2a96f229c98978a8b0c212be9fe7770cc0508e09649432ddf0699d2195b20";
      const v6SchemaSha256 =
        "fd1904013e8eeee7c3226d46b51d82dca409a19b2aea845f1268b72949ac16b4";
      const v7SchemaSha256 =
        "8f534910c59705175b876c85902d5d60e277d7f0c5a7cc88ac5f0eedd021bb02";
      const v8SchemaSha256 =
        "eb0eb5d3dd4dea09b39b5b9c2ec317973225eff0f0dd953931d0255cef378780";
      const v9SchemaSha256 =
        "95bd108425eacc274efd75837ea7f47e5dcea853d4c23128171efe87e18f0161";
      const v10SchemaSha256 =
        "57b923d57efc09d0e722246916e083237f988836d82042029039c45ffd704cdd";
      if (versions.length > 1)
        throw new PlatformStorageError(
          "conflict",
          "Platform 数据库结构与当前程序不一致，拒绝打开。",
        );
      if (versions.length) {
        const version = Number(versions[0]!.version);
        const installedHash = versions[0]!.schema_sha256;
        if (
          version === 1 &&
          installedHash ===
            "f30dd70e0e46c6c61921657b96d896649161ce0fe441f0fb0d704100c23cd414"
        ) {
          await q.exec(
            "CREATE TABLE project_retirements (tenant_id TEXT NOT NULL,project_id TEXT NOT NULL,command_id TEXT NOT NULL,request_hash TEXT NOT NULL CHECK(length(request_hash)=64),target_state TEXT NOT NULL CHECK(target_state IN ('archived','deleted')),expected_revision BIGINT NOT NULL CHECK(expected_revision>0),begun_at TEXT NOT NULL,PRIMARY KEY(tenant_id,project_id),UNIQUE(tenant_id,command_id),FOREIGN KEY(tenant_id,project_id) REFERENCES projects(tenant_id,project_id))",
          );
          await q.change(
            "UPDATE platform_schema_version SET version=2,schema_sha256=? WHERE version=1 AND schema_sha256=?",
            [previousSchemaSha256, installedHash],
          );
        } else if (
          version !== 2 &&
          version !== 3 &&
          version !== 4 &&
          version !== 5 &&
          version !== 6 &&
          version !== 7 &&
          version !== 8 &&
          version !== 9 &&
          version !== 10 &&
          version !== 11
        )
          throw new PlatformStorageError(
            "conflict",
            "Platform 数据库结构与当前程序不一致，拒绝打开。",
          );
        if (
          (version === 1 &&
            installedHash ===
              "f30dd70e0e46c6c61921657b96d896649161ce0fe441f0fb0d704100c23cd414") ||
          (version === 2 && installedHash === previousSchemaSha256)
        ) {
          await q.exec(
            "CREATE TABLE navigation_heads (tenant_id TEXT PRIMARY KEY,revision BIGINT NOT NULL CHECK(revision >= 0),FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id))",
          );
          await q.change(
            "INSERT INTO navigation_heads(tenant_id,revision) SELECT tenant_id,0 FROM tenants",
          );
          await q.change(
            "UPDATE platform_schema_version SET version=3,schema_sha256=? WHERE version=2 AND schema_sha256=?",
            [v3SchemaSha256, previousSchemaSha256],
          );
        } else if (
          (version === 3 && installedHash !== v3SchemaSha256) ||
          (version === 4 && installedHash !== v4SchemaSha256) ||
          (version === 5 && installedHash !== v5SchemaSha256) ||
          (version === 6 && installedHash !== v6SchemaSha256) ||
          (version === 7 && installedHash !== v7SchemaSha256) ||
          (version === 8 && installedHash !== v8SchemaSha256) ||
          (version === 9 && installedHash !== v9SchemaSha256) ||
          (version === 10 && installedHash !== v10SchemaSha256) ||
          (version === 11 && installedHash !== schemaSha256)
        )
          throw new PlatformStorageError(
            "conflict",
            "Platform 数据库结构与当前程序不一致，拒绝打开。",
          );
        if (
          version !== 4 &&
          version !== 5 &&
          version !== 6 &&
          version !== 7 &&
          version !== 8 &&
          version !== 9 &&
          version !== 10 &&
          version !== 11
        ) {
          await q.exec(
            "CREATE INDEX content_by_app_object ON content_entries(tenant_id, app_id, app_object_id, deleted_at, content_id)",
          );
          await q.change(
            "UPDATE platform_schema_version SET version=4,schema_sha256=? WHERE version=3 AND schema_sha256=?",
            [v4SchemaSha256, v3SchemaSha256],
          );
        }
        if (version < 5) {
          await q.exec(`
            CREATE TABLE app_ui_packages (
              tenant_id TEXT NOT NULL, app_id TEXT NOT NULL,
              package_version TEXT NOT NULL, installed_by_principal_id TEXT NOT NULL,
              manifest_header TEXT NOT NULL CHECK (length(manifest_header) BETWEEN 2 AND 200000),
              store_id TEXT NOT NULL, artifact_id TEXT NOT NULL,
              artifact_revision BIGINT NOT NULL CHECK (artifact_revision > 0),
              sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
              byte_length BIGINT NOT NULL CHECK (byte_length BETWEEN 1 AND 1000000),
              installed_at TEXT NOT NULL,
              PRIMARY KEY (tenant_id, app_id, package_version),
              UNIQUE (tenant_id, store_id, artifact_id, artifact_revision),
              FOREIGN KEY (tenant_id, app_id) REFERENCES app_installations(tenant_id, app_id)
            );
            CREATE INDEX app_ui_packages_by_installer
              ON app_ui_packages(tenant_id, installed_by_principal_id, installed_at DESC, app_id);
          `);
          await q.change(
            "UPDATE platform_schema_version SET version=5,schema_sha256=? WHERE version=4 AND schema_sha256=?",
            [v5SchemaSha256, v4SchemaSha256],
          );
        }
        if (version < 6) {
          await q.exec(`
            CREATE TABLE team_identity_config (
              tenant_id TEXT PRIMARY KEY,
              config_sha256 TEXT NOT NULL CHECK (length(config_sha256) = 64),
              revision BIGINT NOT NULL CHECK (revision > 0),
              updated_at TEXT NOT NULL,
              FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id)
            );
            CREATE TABLE team_login_sessions (
              tenant_id TEXT NOT NULL,
              session_hash TEXT NOT NULL CHECK (length(session_hash) = 64),
              csrf TEXT NOT NULL CHECK (length(csrf) = 64),
              principal_id TEXT NOT NULL,
              actant_id TEXT NOT NULL,
              credential_hash TEXT NOT NULL CHECK (length(credential_hash) = 64),
              expires_at BIGINT NOT NULL,
              PRIMARY KEY (tenant_id, session_hash),
              FOREIGN KEY (tenant_id) REFERENCES team_identity_config(tenant_id)
            );
            CREATE INDEX team_login_sessions_by_expiry
              ON team_login_sessions(tenant_id, expires_at);
          `);
          await q.change(
            "UPDATE platform_schema_version SET version=6,schema_sha256=? WHERE version=5 AND schema_sha256=?",
            [v6SchemaSha256, v5SchemaSha256],
          );
        }
        if (version < 7) {
          await q.exec(`
            CREATE TABLE app_view_instances (
              tenant_id TEXT NOT NULL, view_id TEXT NOT NULL,
              owner_principal_id TEXT NOT NULL, project_id TEXT NOT NULL,
              app_id TEXT NOT NULL, package_version TEXT NOT NULL,
              state_json TEXT NOT NULL CHECK (length(state_json) BETWEEN 2 AND 65536),
              revision BIGINT NOT NULL CHECK (revision > 0),
              status TEXT NOT NULL CHECK (status IN ('open','closed')),
              created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
              PRIMARY KEY (tenant_id, view_id),
              UNIQUE (tenant_id, owner_principal_id, project_id, app_id, package_version),
              FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, project_id)
            );
            CREATE INDEX app_view_instances_by_owner
              ON app_view_instances(tenant_id, owner_principal_id, status, created_at, view_id);
          `);
          await q.change(
            "UPDATE platform_schema_version SET version=7,schema_sha256=? WHERE version=6 AND schema_sha256=?",
            [v7SchemaSha256, v6SchemaSha256],
          );
        }
        if (version < 8) {
          await q.exec(`
            CREATE TABLE project_understanding_versions (
              tenant_id TEXT NOT NULL, project_id TEXT NOT NULL,
              revision BIGINT NOT NULL CHECK (revision > 0),
              frame_id TEXT NOT NULL CHECK (length(frame_id) BETWEEN 1 AND 200),
              frame_revision BIGINT NOT NULL CHECK (frame_revision > 0),
              mind_version BIGINT NOT NULL CHECK (mind_version > 0),
              body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 30000),
              sources_json TEXT NOT NULL CHECK (length(sources_json) BETWEEN 2 AND 40000),
              published_by_principal_id TEXT NOT NULL,
              published_by_actant_id TEXT NOT NULL,
              published_at TEXT NOT NULL,
              PRIMARY KEY (tenant_id, project_id, revision),
              UNIQUE (tenant_id, project_id, frame_id, frame_revision),
              FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, project_id)
            );
          `);
          await q.change(
            "UPDATE platform_schema_version SET version=8,schema_sha256=? WHERE version=7 AND schema_sha256=?",
            [v8SchemaSha256, v7SchemaSha256],
          );
        }
        if (version < 9) {
          await q.exec(`
            ALTER TABLE navigation_heads ADD COLUMN projects_revision BIGINT NOT NULL DEFAULT 0 CHECK (projects_revision >= 0);
            ALTER TABLE navigation_heads ADD COLUMN conversations_revision BIGINT NOT NULL DEFAULT 0 CHECK (conversations_revision >= 0);
            ALTER TABLE navigation_heads ADD COLUMN tasks_revision BIGINT NOT NULL DEFAULT 0 CHECK (tasks_revision >= 0);
            ALTER TABLE navigation_heads ADD COLUMN access_revision BIGINT NOT NULL DEFAULT 0 CHECK (access_revision >= 0);
          `);
          await q.change(
            "UPDATE platform_schema_version SET version=9,schema_sha256=? WHERE version=8 AND schema_sha256=?",
            [v9SchemaSha256, v8SchemaSha256],
          );
        }
        if (version < 10) {
          // The named, immutable migration section is generated from the same
          // SQL source as fresh creation; unrelated later DDL is not included.
          const begin = platformSchemaSql.indexOf("-- BEGIN profile-avatar-v1");
          const end = platformSchemaSql.indexOf("-- END profile-avatar-v1", begin);
          if (begin < 0 || end < begin) throw new PlatformStorageError("conflict", "头像存储迁移定义不完整。");
          await q.exec(platformSchemaSql.slice(begin, end));
          await q.change(
            "UPDATE platform_schema_version SET version=10,schema_sha256=? WHERE version=9 AND schema_sha256=?",
            [v10SchemaSha256, v9SchemaSha256],
          );
        }
        if (version < 11) {
          const begin = platformSchemaSql.indexOf("-- BEGIN cognitive-app-v1");
          const end = platformSchemaSql.indexOf("-- END cognitive-app-v1", begin);
          if (begin < 0 || end < begin)
            throw new PlatformStorageError(
              "conflict",
              "认知应用存储迁移定义不完整。",
            );
          await q.exec(platformSchemaSql.slice(begin, end));
          await q.change(
            "UPDATE platform_schema_version SET version=11,schema_sha256=? WHERE version=10 AND schema_sha256=?",
            [schemaSha256, v10SchemaSha256],
          );
        }
        try {
          await verifySchemaObjects(q, this.backend.kind, platformSchemaSql, [
            "platform_schema_version",
          ]);
        } catch (error) {
          throw new PlatformStorageError("conflict", (error as Error).message);
        }
        return;
      }
      if (tables.length > 1)
        throw new PlatformStorageError(
          "conflict",
          "Platform 初始化未完成；需要核验后恢复，不能重复建表。",
        );
      await q.exec(platformSchemaSql);
      await q.change(
        "INSERT INTO platform_schema_version(version,schema_sha256) VALUES(11,?)",
        [schemaSha256],
      );
    });
  }

  /** Provisioning operation; never exposed as a Cognitive App or Agent tool. */
  async provisionTenant(
    tenantId: string,
    createdAt = new Date().toISOString(),
  ) {
    requireId(tenantId, "租户标识");
    await this.transaction(async (q) => {
      await q.change(
        "INSERT INTO tenants(tenant_id,created_at) VALUES(?,?) ON CONFLICT(tenant_id) DO NOTHING",
        [tenantId, createdAt],
      );
      await q.change(
        "INSERT INTO navigation_heads(tenant_id,revision) VALUES(?,0) ON CONFLICT(tenant_id) DO NOTHING",
        [tenantId],
      );
      await q.change(
        "INSERT INTO task_order_heads(tenant_id,revision) VALUES(?,0) ON CONFLICT(tenant_id) DO NOTHING",
        [tenantId],
      );
    });
  }

  /** Host-only authentication state. A team center can be served by several
   * Hosts; none may silently fall back to a private session list or a
   * different operator configuration. */
  async teamIdentityConfigured(tenantId: string): Promise<boolean> {
    requireId(tenantId, "租户标识");
    return this.transaction(
      async (q) =>
        !!(
          await q.all(
            "SELECT 1 AS present FROM team_identity_config WHERE tenant_id=?",
            [tenantId],
          )
        )[0],
      "read",
    );
  }

  async bindTeamIdentityConfig(tenantId: string, configSha256: string) {
    requireId(tenantId, "租户标识");
    if (!/^[a-f0-9]{64}$/.test(configSha256))
      throw new PlatformStorageError("invalid", "团队身份配置摘要无效。");
    return this.transaction(async (q) => {
      await q.change(
        "INSERT INTO team_identity_config(tenant_id,config_sha256,revision,updated_at) VALUES(?,?,1,?) ON CONFLICT(tenant_id) DO NOTHING",
        [tenantId, configSha256, new Date().toISOString()],
      );
      const row = (
        await q.all<{ config_sha256: string }>(
          `SELECT config_sha256 FROM team_identity_config WHERE tenant_id=?${this.backend.kind === "postgres" ? " FOR UPDATE" : ""}`,
          [tenantId],
        )
      )[0];
      if (row?.config_sha256 !== configSha256)
        throw new PlatformStorageError(
          "conflict",
          "此 Host 的团队身份配置与 Platform 当前配置不一致。",
        );
    });
  }

  async teamIdentityConfigMatches(tenantId: string, configSha256: string) {
    requireId(tenantId, "租户标识");
    if (!/^[a-f0-9]{64}$/.test(configSha256)) return false;
    return this.transaction(
      async (q) =>
        !!(
          await q.all(
            "SELECT 1 AS present FROM team_identity_config WHERE tenant_id=? AND config_sha256=?",
            [tenantId, configSha256],
          )
        )[0],
      "read",
    );
  }

  async replaceTeamIdentityConfig(
    tenantId: string,
    previousSha256: string,
    nextSha256: string,
    activeBindings: TeamCredentialBinding[],
  ) {
    requireId(tenantId, "租户标识");
    if (
      !/^[a-f0-9]{64}$/.test(previousSha256) ||
      !/^[a-f0-9]{64}$/.test(nextSha256)
    )
      throw new PlatformStorageError("invalid", "团队身份配置摘要无效。");
    this.validateTeamCredentialBindings(activeBindings);
    await this.transaction(async (q) => {
      const changed = await q.change(
        "UPDATE team_identity_config SET config_sha256=?,revision=revision+1,updated_at=? WHERE tenant_id=? AND config_sha256=?",
        [nextSha256, new Date().toISOString(), tenantId, previousSha256],
      );
      if (changed !== 1)
        throw new PlatformStorageError(
          "conflict",
          "团队身份配置已被其他 Host 更新，请重新加载。",
        );
      await this.pruneTeamLoginSessions(q, tenantId, activeBindings);
      await this.advanceNavigation(q, tenantId, ["access"]);
    });
  }

  private validateTeamCredentialBindings(bindings: TeamCredentialBinding[]) {
    if (bindings.length > 200)
      throw new PlatformStorageError("invalid", "团队身份配置成员过多。");
    const principals = new Set<string>();
    const actants = new Set<string>();
    const credentials = new Set<string>();
    for (const binding of bindings) {
      requireId(binding.principalId, "主体标识");
      requireId(binding.actantId, "参与者标识");
      if (
        !/^[a-f0-9]{64}$/.test(binding.credentialHash) ||
        principals.has(binding.principalId) ||
        actants.has(binding.actantId) ||
        credentials.has(binding.credentialHash)
      )
        throw new PlatformStorageError("invalid", "团队身份绑定无效或重复。");
      principals.add(binding.principalId);
      actants.add(binding.actantId);
      credentials.add(binding.credentialHash);
    }
  }

  private async pruneTeamLoginSessions(
    q: Query,
    tenantId: string,
    bindings: TeamCredentialBinding[],
  ) {
    const eligible = bindings
      .map(() => "(principal_id=? AND actant_id=? AND credential_hash=?)")
      .join(" OR ");
    await q.change(
      `DELETE FROM team_login_sessions WHERE tenant_id=?${eligible ? ` AND NOT (${eligible})` : ""}`,
      [
        tenantId,
        ...bindings.flatMap((binding) => [
          binding.principalId,
          binding.actantId,
          binding.credentialHash,
        ]),
      ],
    );
  }

  async issueTeamLoginSession(
    tenantId: string,
    configSha256: string,
    session: TeamLoginSession,
    now: number,
  ) {
    requireId(tenantId, "租户标识");
    if (
      !/^[a-f0-9]{64}$/.test(configSha256) ||
      ![session.sessionHash, session.csrf, session.credentialHash].every(
        (value) => /^[a-f0-9]{64}$/.test(value),
      ) ||
      !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(session.expiresAt) ||
      session.expiresAt <= now
    )
      throw new PlatformStorageError("invalid", "登录会话参数无效。");
    requireId(session.principalId, "主体标识");
    requireId(session.actantId, "参与者标识");
    await this.transaction(async (q) => {
      const config = (
        await q.all<{ config_sha256: string }>(
          `SELECT config_sha256 FROM team_identity_config WHERE tenant_id=?${this.backend.kind === "postgres" ? " FOR UPDATE" : ""}`,
          [tenantId],
        )
      )[0];
      if (config?.config_sha256 !== configSha256)
        throw new PlatformStorageError("forbidden", "团队身份配置已变化。");
      await q.change(
        "DELETE FROM team_login_sessions WHERE tenant_id=? AND expires_at<=?",
        [tenantId, now],
      );
      const existing = (
        await q.all<{
          csrf: string;
          principal_id: string;
          actant_id: string;
          credential_hash: string;
          expires_at: number | string;
        }>(
          "SELECT csrf,principal_id,actant_id,credential_hash,expires_at FROM team_login_sessions WHERE tenant_id=? AND session_hash=?",
          [tenantId, session.sessionHash],
        )
      )[0];
      if (existing) {
        if (
          existing.csrf !== session.csrf ||
          existing.principal_id !== session.principalId ||
          existing.actant_id !== session.actantId ||
          existing.credential_hash !== session.credentialHash ||
          safeInteger(existing.expires_at, "登录会话到期时间") !==
            session.expiresAt
        )
          throw new PlatformStorageError("conflict", "登录会话标识已被占用。");
        return;
      }
      const count = (
        await q.all<{ amount: number | string }>(
          "SELECT COUNT(*) AS amount FROM team_login_sessions WHERE tenant_id=?",
          [tenantId],
        )
      )[0];
      if (safeInteger(count?.amount ?? 0, "登录会话数量") >= 4000)
        throw new PlatformStorageError(
          "invalid",
          "登录会话数量已达上限，请稍后重试或联系管理员。",
        );
      await q.change(
        "INSERT INTO team_login_sessions(tenant_id,session_hash,csrf,principal_id,actant_id,credential_hash,expires_at) VALUES(?,?,?,?,?,?,?)",
        [
          tenantId,
          session.sessionHash,
          session.csrf,
          session.principalId,
          session.actantId,
          session.credentialHash,
          session.expiresAt,
        ],
      );
    });
  }

  async teamLoginSession(
    tenantId: string,
    configSha256: string,
    sessionHash: string,
    now: number,
  ): Promise<TeamLoginSession | null> {
    requireId(tenantId, "租户标识");
    if (
      !/^[a-f0-9]{64}$/.test(configSha256) ||
      !/^[a-f0-9]{64}$/.test(sessionHash) ||
      !Number.isSafeInteger(now)
    )
      return null;
    return this.transaction(async (q) => {
      const row = (
        await q.all<{
          session_hash: string;
          csrf: string;
          principal_id: string;
          actant_id: string;
          credential_hash: string;
          expires_at: number | string;
        }>(
          "SELECT s.session_hash,s.csrf,s.principal_id,s.actant_id,s.credential_hash,s.expires_at FROM team_login_sessions s JOIN team_identity_config c ON c.tenant_id=s.tenant_id WHERE s.tenant_id=? AND c.config_sha256=? AND s.session_hash=? AND s.expires_at>?",
          [tenantId, configSha256, sessionHash, now],
        )
      )[0];
      return row
        ? {
            sessionHash: row.session_hash,
            csrf: row.csrf,
            principalId: row.principal_id,
            actantId: row.actant_id,
            credentialHash: row.credential_hash,
            expiresAt: safeInteger(row.expires_at, "登录会话到期时间"),
          }
        : null;
    }, "read");
  }

  async revokeTeamLoginSession(tenantId: string, sessionHash: string) {
    requireId(tenantId, "租户标识");
    if (!/^[a-f0-9]{64}$/.test(sessionHash))
      throw new PlatformStorageError("invalid", "登录会话标识无效。");
    await this.transaction((q) =>
      q.change(
        "DELETE FROM team_login_sessions WHERE tenant_id=? AND session_hash=?",
        [tenantId, sessionHash],
      ),
    );
  }

  /** Apply the operator's existing team membership configuration to the
   * Platform authority. This is a Host-only control-plane operation, never a
   * Client or Agent command. A missing or invalid project aborts the whole
   * change; no membership is inferred from the old workspace snapshot. */
  async reconcileOperatorMembers(
    tenantId: string,
    members: {
      principalId: string;
      actantId: string;
      projectIds: string[];
      enabled: boolean;
    }[],
    identityAuthority?: {
      expectedSha256: string;
      replacement?: {
        sha256: string;
        activeBindings: TeamCredentialBinding[];
        retiredPrincipalIds: string[];
      };
    },
  ): Promise<void> {
    requireId(tenantId, "租户标识");
    if (
      identityAuthority &&
      (!/^[a-f0-9]{64}$/.test(identityAuthority.expectedSha256) ||
        (identityAuthority.replacement !== undefined &&
          (!/^[a-f0-9]{64}$/.test(identityAuthority.replacement.sha256) ||
            identityAuthority.replacement.retiredPrincipalIds.length > 200 ||
            identityAuthority.replacement.activeBindings.length > 200)))
    )
      throw new PlatformStorageError("invalid", "团队身份配置摘要无效。");
    if (identityAuthority?.replacement)
      this.validateTeamCredentialBindings(
        identityAuthority.replacement.activeBindings,
      );
    if (members.length < 1 || members.length > 200)
      throw new PlatformStorageError("invalid", "成员数量无效。");
    const principals = new Set<string>();
    const actants = new Set<string>();
    const retiredPrincipalIds =
      identityAuthority?.replacement?.retiredPrincipalIds ?? [];
    if (new Set(retiredPrincipalIds).size !== retiredPrincipalIds.length)
      throw new PlatformStorageError("invalid", "撤销成员列表包含重复身份。");
    for (const principalId of retiredPrincipalIds)
      requireId(principalId, "撤销成员主体标识");
    for (const member of members) {
      requireId(member.principalId, "成员主体标识");
      requireId(member.actantId, "成员参与者标识");
      if (
        member.principalId === morphzAgentAccess.principalId ||
        member.actantId === morphzAgentAccess.actantId ||
        principals.has(member.principalId) ||
        actants.has(member.actantId) ||
        member.projectIds.length > 1000 ||
        new Set(member.projectIds).size !== member.projectIds.length
      )
        throw new PlatformStorageError("invalid", "成员身份或项目配置无效。");
      principals.add(member.principalId);
      actants.add(member.actantId);
      for (const projectId of member.projectIds)
        requireId(projectId, "成员项目标识");
      if (member.enabled && !identityAuthority?.replacement) {
        const actor = await this.capabilities.resolveActant({
          tenantId,
          actantId: member.actantId,
        });
        if (
          !actor ||
          actor.kind !== "human" ||
          actor.principalId !== member.principalId
        )
          throw new PlatformStorageError("forbidden", "成员身份未获确认。");
      }
    }
    if (retiredPrincipalIds.some((principalId) => principals.has(principalId)))
      throw new PlatformStorageError("invalid", "在用成员不能同时被撤销。");
    await this.transaction(async (q) => {
      if (this.backend.kind === "postgres")
        await q.all(
          "SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0)) AS locked",
          [`platform:${tenantId}:operator-members`],
        );
      if (identityAuthority) {
        const current = (
          await q.all<{ config_sha256: string }>(
            `SELECT config_sha256 FROM team_identity_config WHERE tenant_id=?${this.backend.kind === "postgres" ? " FOR UPDATE" : ""}`,
            [tenantId],
          )
        )[0];
        if (current?.config_sha256 !== identityAuthority.expectedSha256)
          throw new PlatformStorageError(
            "conflict",
            "团队身份配置已被其他 Host 更新，请重新加载。",
          );
      }
      // Operator reload is not a tenant-wide catalog read. Resolve only
      // explicitly named IDs through the project PK, in bounded SQL batches.
      const configuredIds = [
        ...new Set(members.flatMap((member) => member.projectIds)),
      ];
      for (let start = 0; start < configuredIds.length; start += 500) {
        const batch = configuredIds.slice(start, start + 500);
        const found = await q.all<{ project_id: string }>(
          `SELECT project_id FROM projects WHERE tenant_id=? AND project_id IN (${batch.map(() => "?").join(",")})`,
          [tenantId, ...batch],
        );
        if (found.length !== batch.length)
          throw new PlatformStorageError(
            "not_found",
            "成员配置引用了不存在的项目。",
          );
      }
      const changes = new Map<
        string,
        { additions: string[]; removals: string[] }
      >();
      const change = (projectId: string) => {
        let entry = changes.get(projectId);
        if (!entry) {
          entry = { additions: [], removals: [] };
          changes.set(projectId, entry);
        }
        return entry;
      };
      for (const member of members) {
        const wanted = new Set(member.enabled ? member.projectIds : []);
        // Creating a project already grants its owner membership in the same
        // Platform transaction. Reloading an older operator file must not
        // revoke that grant just because its projectIds list predates creation.
        if (member.enabled) {
          const owned = await q.all<{ project_id: string }>(
            "SELECT project_id FROM projects WHERE tenant_id=? AND owner_principal_id=?",
            [tenantId, member.principalId],
          );
          for (const project of owned) wanted.add(project.project_id);
        }
        const existing = await q.all<{ project_id: string }>(
          "SELECT project_id FROM project_members WHERE tenant_id=? AND principal_id=?",
          [tenantId, member.principalId],
        );
        const current = new Set(existing.map((row) => row.project_id));
        for (const projectId of wanted)
          if (!current.has(projectId))
            change(projectId).additions.push(member.principalId);
        for (const projectId of current)
          if (!wanted.has(projectId))
            change(projectId).removals.push(member.principalId);
      }
      for (const principalId of retiredPrincipalIds) {
        const existing = await q.all<{ project_id: string }>(
          "SELECT project_id FROM project_members WHERE tenant_id=? AND principal_id=?",
          [tenantId, principalId],
        );
        for (const project of existing)
          change(project.project_id).removals.push(principalId);
      }
      const now = new Date().toISOString();
      if (changes.size) {
        await this.lockProjectAudiences(q, tenantId, [...changes.keys()]);
        for (const [projectId, entry] of [...changes].sort(([a], [b]) =>
          a.localeCompare(b),
        )) {
          for (const principalId of entry.removals)
            await q.change(
              "DELETE FROM project_members WHERE tenant_id=? AND project_id=? AND principal_id=?",
              [tenantId, projectId, principalId],
            );
          for (const principalId of entry.additions)
            await q.change(
              "INSERT INTO project_members(tenant_id,project_id,principal_id,joined_at) VALUES(?,?,?,?)",
              [tenantId, projectId, principalId, now],
            );
          await q.change(
            "UPDATE projects SET revision=revision+1,updated_at=? WHERE tenant_id=? AND project_id=?",
            [now, tenantId, projectId],
          );
        }
      }
      if (identityAuthority?.replacement) {
        await q.change(
          "UPDATE team_identity_config SET config_sha256=?,revision=revision+1,updated_at=? WHERE tenant_id=? AND config_sha256=?",
          [
            identityAuthority.replacement.sha256,
            now,
            tenantId,
            identityAuthority.expectedSha256,
          ],
        );
        await this.pruneTeamLoginSessions(
          q,
          tenantId,
          identityAuthority.replacement.activeBindings,
        );
      }
      if (changes.size || identityAuthority?.replacement)
        await this.advanceNavigation(q, tenantId, [
          "access",
          ...(changes.size ? (["projects"] as const) : []),
        ]);
    });
  }

  /** Trusted Human onboarding, not an Agent tool. Existing imported spaces
   * retain their IDs; a partial or foreign-owned set is never repaired by
   * silently minting a second personal workspace. */
  async ensurePersonalSpaces(access: PlatformActor): Promise<PersonalSpaces> {
    const actor = await this.authorize(access);
    if (actor.kind !== "human")
      throw new PlatformStorageError(
        "forbidden",
        "只有已认证用户可以初始化个人空间。",
      );
    const agent = await this.capabilities.resolveProjectAgent({
      tenantId: actor.tenantId,
    });
    if (!agent)
      throw new PlatformStorageError(
        "forbidden",
        "Morphz Agent 身份未获确认。",
      );
    requireId(agent.principalId, "Agent 主体标识");
    requireId(agent.actantId, "Agent 参与者标识");
    if (agent.principalId === actor.principalId)
      throw new PlatformStorageError("invalid", "Agent 与用户不能共用主体。");
    const specs = [
      { kind: "desk", title: "未归项目", key: "deskId" },
      { kind: "inbox", title: "事项", key: "inboxId" },
      { kind: "dialogue", title: "对话", key: "dialogueId" },
    ] as const;
    return this.transaction(async (q) => {
      if (this.backend.kind === "postgres")
        await q.all(
          "SELECT pg_advisory_xact_lock(hashtextextended(?, 0)) AS locked",
          [`${actor.tenantId}:${actor.principalId}:personal-spaces`],
        );
      const tenant = await q.all(
        "SELECT 1 AS present FROM tenants WHERE tenant_id=?",
        [actor.tenantId],
      );
      if (!tenant.length)
        throw new PlatformStorageError("not_found", "租户尚未建立。");
      const existing = await q.all<{
        project_id: string;
        kind: "desk" | "inbox" | "dialogue";
        archived_at: string | null;
        deleted_at: string | null;
      }>(
        "SELECT project_id,kind,archived_at,deleted_at FROM projects WHERE tenant_id=? AND owner_principal_id=? AND kind IN ('desk','inbox','dialogue')",
        [actor.tenantId, actor.principalId],
      );
      if (existing.length && existing.length !== specs.length)
        throw new PlatformStorageError(
          "conflict",
          "个人空间不完整，须先核验原数据，不能自动补建。",
        );
      if (existing.length) {
        const ids = existing.map((row) => row.project_id);
        const members = await q.all<{
          project_id: string;
          principal_id: string;
        }>(
          "SELECT project_id,principal_id FROM project_members WHERE tenant_id=? AND project_id IN (?,?,?)",
          [actor.tenantId, ...ids],
        );
        const conversations = await q.all<{
          conversation_id: string;
          project_id: string;
          kind: string;
          archived_at: string | null;
        }>(
          "SELECT conversation_id,project_id,kind,archived_at FROM conversations WHERE tenant_id=? AND conversation_id IN (?,?,?)",
          [actor.tenantId, ...ids],
        );
        const result = {} as PersonalSpaces;
        for (const spec of specs) {
          const row = existing.find((value) => value.kind === spec.kind);
          const principals = members
            .filter((member) => member.project_id === row?.project_id)
            .map((member) => member.principal_id)
            .sort();
          const conversation = conversations.find(
            (value) => value.conversation_id === row?.project_id,
          );
          if (
            !row ||
            row.archived_at !== null ||
            row.deleted_at !== null ||
            JSON.stringify(principals) !==
              JSON.stringify([actor.principalId, agent.principalId].sort()) ||
            conversation?.project_id !== row.project_id ||
            conversation.kind !== "default" ||
            conversation.archived_at !== null
          )
            throw new PlatformStorageError(
              "conflict",
              "个人空间的成员或默认对话不完整，须先核验原数据。",
            );
          result[spec.key] = row.project_id;
        }
        return result;
      }
      const now = new Date().toISOString();
      const result = {} as PersonalSpaces;
      for (const spec of specs) {
        const projectId = personalSpaceId(
          actor.tenantId,
          actor.principalId,
          spec.kind,
        );
        await q.change(
          "INSERT INTO projects(tenant_id,project_id,kind,owner_principal_id,title,revision,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)",
          [
            actor.tenantId,
            projectId,
            spec.kind,
            actor.principalId,
            spec.title,
            now,
            now,
          ],
        );
        for (const principalId of [actor.principalId, agent.principalId])
          await q.change(
            "INSERT INTO project_members(tenant_id,project_id,principal_id,joined_at) VALUES(?,?,?,?)",
            [actor.tenantId, projectId, principalId, now],
          );
        await q.change(
          "INSERT INTO conversations(tenant_id,conversation_id,project_id,kind,title,revision,created_at,updated_at) VALUES(?,?,?,'default',?,1,?,?)",
          [actor.tenantId, projectId, projectId, "默认对话", now, now],
        );
        result[spec.key] = projectId;
      }
      await this.advanceNavigation(q, actor.tenantId, [
        "projects",
        "conversations",
        "access",
      ]);
      return result;
    });
  }

  /** Shared Host entry for personal Cognitive App data. This resolves only
   * identity; the app still owns its records and performs its own authorization.
   */
  async authorizePersonalApplication(access: PlatformActor) {
    const actor = await this.authorize(access);
    if (actor.kind === "provider")
      throw new PlatformStorageError(
        "forbidden",
        "资源提供方不能操作个人应用数据。",
      );
    // A personal app is owned by the initiating Human, not by the project in
    // which the input happened. The trusted Runtime ingress rechecks that
    // input's current project access when resolving the Agent credential.
    return {
      tenantId: actor.tenantId,
      principalId: actor.principalId,
      actantId: actor.actantId,
      kind: actor.kind,
      runtimeInputId: actor.runtimeInputId,
    };
  }

  /** App-private reads and writes must be served by the currently registered
   * provider, not merely by a process holding an old private database handle.
   */
  async authorizePersonalApplicationAtRoute(
    access: PlatformActor,
    instanceId: string,
    appId: string,
    provider: ApplicationProviderRoute,
  ) {
    const actor = await this.authorizePersonalApplication(access);
    requireId(instanceId, "应用实例标识");
    requireAppId(appId);
    const instances = await this.transaction(
      (q) =>
        q.all<{
          route_kind: string;
          route_ref: string;
          node_id: string | null;
        }>(
          "SELECT route_kind,route_ref,node_id FROM app_instances WHERE tenant_id=? AND instance_id=? AND app_id=? AND state='active'",
          [actor.tenantId, instanceId, appId],
        ),
      "read",
    );
    if (!instances[0])
      throw new PlatformStorageError("not_found", "应用实例不可用。");
    if (!matchesApplicationProviderRoute(instances[0], provider))
      throw new PlatformStorageError(
        "conflict",
        "应用原件已不由当前保存方提供。",
      );
    return actor;
  }

  /** Notification choices and acknowledgements follow the person across
   * Clients. Candidate notifications remain a projection of current tasks.
   */
  async readNotificationState(access: PlatformActor) {
    const actor = await this.authorize(access);
    if (actor.kind === "provider")
      throw new PlatformStorageError(
        "forbidden",
        "资源提供方不能读取用户通知。",
      );
    return this.transaction(async (q) => {
      if (actor.kind === "agent")
        await this.assertMember(q, actor, actor.scopeProjectId!, false);
      return this.notificationState(q, actor.tenantId, actor.principalId);
    }, "read");
  }

  /** Current task phases are derived from the Platform authority. The query
   * finds the first revision of the uninterrupted current phase in SQL, so a
   * title edit keeps the same notification while leaving and re-entering a
   * phase creates a new one. Only the final 200 candidates cross the Host
   * boundary; neither the legacy workspace nor full task histories do.
   */
  async notificationCandidates(
    access: PlatformActor,
  ): Promise<NotificationCandidateRow[]> {
    const actor = await this.authorize(access);
    if (actor.kind !== "human")
      throw new PlatformStorageError(
        "forbidden",
        "只有当前用户可以读取自己的通知。",
      );
    const refs = (version: string) =>
      this.backend.kind === "postgres"
        ? `(SELECT string_agg(r.ref_id, '|' ORDER BY r.ordinal) FROM task_version_refs r WHERE r.tenant_id=${version}.tenant_id AND r.task_id=${version}.task_id AND r.revision=${version}.revision AND r.ref_kind='result')`
        : `(SELECT group_concat(ref_id, '|') FROM (SELECT r.ref_id FROM task_version_refs r WHERE r.tenant_id=${version}.tenant_id AND r.task_id=${version}.task_id AND r.revision=${version}.revision AND r.ref_kind='result' ORDER BY r.ordinal))`;
    const phase = (version: string, task: string) => `CASE
      WHEN ${version}.assignee_id=s.actant_id AND ${version}.execution NOT IN ('completed','cancelled') AND ${version}.assignment<>'declined'
        THEN 'human|' || ${version}.assignment || '|' || CASE WHEN ${version}.execution='waiting' THEN 'waiting' ELSE 'ready' END || '|' || ${version}.assignee_id || '|' || CAST(${version}.run_requested AS TEXT)
      WHEN ${version}.delivery='ready' AND ${task}.created_by_principal_id=s.principal_id
        THEN 'delivery|' || CAST(${version}.run_requested AS TEXT) || '|' || COALESCE(${refs(version)}, '')
      ELSE NULL END`;
    return this.transaction(async (q) => {
      const rows = await q.all<{
        task_id: string;
        title: string;
        revision: number | string;
        entered_revision: number | string;
        entered_at: string;
        assignment: TaskVersionRow["assignment"];
        execution: TaskVersionRow["execution"];
        assignee_id: string;
        delivery: TaskVersionRow["delivery"];
        run_requested: number | string;
        result_ids: string | null;
        phase_kind: "human" | "delivery";
      }>(
        `WITH scope AS (SELECT ? AS tenant_id, ? AS principal_id, ? AS actant_id),
        candidates AS (
          SELECT t.tenant_id,t.task_id,t.title,t.created_by_principal_id,
                 v.revision,v.assignment,v.execution,v.assignee_id,v.delivery,v.run_requested,
                 ${phase("v", "t")} AS phase,
                 CASE WHEN v.assignee_id=s.actant_id AND v.execution NOT IN ('completed','cancelled') AND v.assignment<>'declined' THEN 'human' ELSE 'delivery' END AS phase_kind
          FROM tasks t
          JOIN task_versions v ON v.tenant_id=t.tenant_id AND v.task_id=t.task_id AND v.revision=t.revision
          JOIN project_members m ON m.tenant_id=t.tenant_id AND m.project_id=t.project_id
          JOIN projects p ON p.tenant_id=t.tenant_id AND p.project_id=t.project_id
          JOIN scope s ON s.tenant_id=t.tenant_id AND s.principal_id=m.principal_id
          WHERE t.deleted_at IS NULL AND p.deleted_at IS NULL AND
            ((v.assignee_id=s.actant_id AND v.execution NOT IN ('completed','cancelled') AND v.assignment<>'declined')
              OR (v.delivery='ready' AND t.created_by_principal_id=s.principal_id))
        ),
        entered AS (
          SELECT c.*,
                 COALESCE((SELECT MAX(old.revision) FROM task_versions old
                           WHERE old.tenant_id=c.tenant_id AND old.task_id=c.task_id
                             AND old.revision<c.revision
                             AND COALESCE(${phase("old", "c")}, '')<>c.phase),0)+1 AS entered_revision
          FROM candidates c CROSS JOIN scope s
        )
        SELECT e.task_id,e.title,e.revision,e.entered_revision,first.created_at AS entered_at,
               e.assignment,e.execution,e.assignee_id,e.delivery,e.run_requested,
               ${refs("e")} AS result_ids,e.phase_kind
        FROM entered e
        JOIN task_versions first ON first.tenant_id=e.tenant_id AND first.task_id=e.task_id AND first.revision=e.entered_revision
        ORDER BY first.created_at DESC,e.task_id
        LIMIT 200`,
        [actor.tenantId, actor.principalId, actor.actantId],
      );
      return rows.map((row) => ({
        ...row,
        revision: safeInteger(row.revision, "事项修订"),
        entered_revision: safeInteger(row.entered_revision, "通知起始修订"),
        run_requested: safeInteger(row.run_requested, "事项执行次数"),
        result_ids: row.result_ids ? row.result_ids.split("|") : [],
      }));
    }, "read");
  }

  /** Personal presentation only; Runtime Custom remains the sole name/persona authority. */
  async profileAvatarSubject(access: PlatformActor, subject: ProfileSubject, write = false) {
    const actor = await this.authorize(access);
    if (subject !== "human" && subject !== "agent") throw new PlatformStorageError("invalid", "头像主体无效。");
    if (write && actor.kind !== "human") throw new PlatformStorageError("forbidden", "修改头像需要用户确认。");
    if (actor.kind === "agent") await this.transaction(q => this.assertMember(q, actor, actor.scopeProjectId!, false), "read");
    if (subject === "human") return { actor, subjectId: actor.principalId };
    const agent = await this.capabilities.resolveProfileAgent?.({ tenantId: actor.tenantId, principalId: actor.principalId });
    if (!agent || !agent.agentId || agent.agentId.length > 512 || /[\x00-\x1f\x7f]/.test(agent.agentId)) throw new PlatformStorageError("forbidden", "智能体身份尚未可靠连接。");
    if (write && !agent.editable) throw new PlatformStorageError("forbidden", "当前智能体资料只读。");
    return { actor, subjectId: agent.agentId, editable: agent.editable };
  }

  private async profileAvatarState(q: Query, tenantId: string, subject: ProfileSubject, subjectId: string): Promise<ProfileAvatarSnapshot> {
    const row = (await q.all<Record<string, unknown>>(
      "SELECT v.*,h.revision AS head_revision FROM profile_avatar_heads h LEFT JOIN profile_avatar_versions v ON v.tenant_id=h.tenant_id AND v.subject_kind=h.subject_kind AND v.subject_id=h.subject_id AND v.revision=h.revision WHERE h.tenant_id=? AND h.subject_kind=? AND h.subject_id=?",
      [tenantId, subject, subjectId],
    ))[0];
    if (!row) return { revision: 0, media: null };
    if (row.revision === null || row.revision === undefined) throw new PlatformStorageError("conflict", "头像版本关系不完整，请先恢复存储。");
    const ref = (prefix: string) => ({
      storeId: row[prefix + "_store_id"], artifactId: row[prefix + "_artifact_id"],
      revision: safeInteger(row[prefix + "_revision"] as number | string, "头像字节修订"),
      sha256: row[prefix + "_sha256"], byteLength: safeInteger(row[prefix + "_byte_length"] as number | string, "头像字节大小"), mime: row[prefix + "_mime"],
    });
    return profileAvatarSnapshotSchema.parse({ revision: safeInteger(row.revision as number | string, "头像修订"), media: row.original_store_id === null ? null : {
      original: ref("original"), poster: ref("poster"), width: safeInteger(row.width as number | string, "头像宽度"), height: safeInteger(row.height as number | string, "头像高度"),
      frames: safeInteger(row.frames as number | string, "头像帧数"), durationMs: safeInteger(row.duration_ms as number | string, "头像时长"),
    } });
  }

  async readProfileAvatar(access: PlatformActor, subject: ProfileSubject) {
    const { actor, subjectId } = await this.profileAvatarSubject(access, subject);
    return this.transaction(q => this.profileAvatarState(q, actor.tenantId, subject, subjectId), "read");
  }

  /** Host startup recovery guard; never creates an empty Store for live refs. */
  async hasProfileAvatarReferences(tenantId: string) {
    requireId(tenantId, "租户标识");
    return this.transaction(async q => (await q.all("SELECT 1 FROM profile_avatar_versions WHERE tenant_id=? AND original_store_id IS NOT NULL LIMIT 1", [tenantId])).length > 0, "read");
  }

  async updateProfileAvatar(access: PlatformActor, request: { subject: ProfileSubject; commandId: string; expectedRevision: number; media: ProfileAvatarMedia | null }) {
    const { actor, subjectId } = await this.profileAvatarSubject(access, request.subject, true);
    requireId(request.commandId, "操作标识");
    if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) throw new PlatformStorageError("invalid", "头像修订无效。");
    const media = request.media === null ? null : profileAvatarMediaSchema.parse(request.media);
    if (media && (media.poster.mime !== "image/png" || !await this.capabilities.verifyProfileAvatar?.({ actor: access, subject: request.subject, subjectId, media }))) throw new PlatformStorageError("forbidden", "头像字节版本未经核验。");
    const hash = fingerprint({ actor, subject: request.subject, subjectId, expectedRevision: request.expectedRevision, media });
    const now = new Date().toISOString();
    return this.transaction(async q => {
      const prior = await this.replay(q, actor, request.commandId, hash);
      if (prior !== null) return profileAvatarSnapshotSchema.parse(JSON.parse(prior));
      const current = await this.profileAvatarState(q, actor.tenantId, request.subject, subjectId);
      if (current.revision !== request.expectedRevision) throw new PlatformStorageError("conflict", "头像已更新，请重新读取。");
      const revision = current.revision + 1;
      if (!Number.isSafeInteger(revision)) throw new PlatformStorageError("conflict", "头像修订超出范围。");
      const changed = current.revision === 0
        ? await q.change("INSERT INTO profile_avatar_heads(tenant_id,subject_kind,subject_id,revision) VALUES(?,?,?,?) ON CONFLICT(tenant_id,subject_kind,subject_id) DO NOTHING", [actor.tenantId, request.subject, subjectId, revision])
        : await q.change("UPDATE profile_avatar_heads SET revision=? WHERE tenant_id=? AND subject_kind=? AND subject_id=? AND revision=?", [revision, actor.tenantId, request.subject, subjectId, current.revision]);
      if (changed !== 1) throw new PlatformStorageError("conflict", "头像已更新，请重新读取。");
      const values = media ? [...[media.original, media.poster].flatMap(v => [v.storeId, v.artifactId, v.revision, v.sha256, v.byteLength, v.mime]), media.width, media.height, media.frames, media.durationMs] : Array(16).fill(null);
      await q.change("INSERT INTO profile_avatar_versions(tenant_id,subject_kind,subject_id,revision,original_store_id,original_artifact_id,original_revision,original_sha256,original_byte_length,original_mime,poster_store_id,poster_artifact_id,poster_revision,poster_sha256,poster_byte_length,poster_mime,width,height,frames,duration_ms,changed_by_principal_id,changed_by_actant_id,changed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [actor.tenantId, request.subject, subjectId, revision, ...values, actor.principalId, actor.actantId, now]);
      const result = { revision, media };
      await this.receipt(q, actor, request.commandId, hash, "profile-avatar", JSON.stringify(result), now, actor.runtimeInputId, false);
      return result;
    });
  }

  private async notificationState(
    q: Query,
    tenantId: string,
    principalId: string,
  ): Promise<NotificationState & { revision: number }> {
    const preference = (
      await q.all<{
        mode: NotificationState["mode"];
        revision: number | string;
      }>(
        "SELECT mode,revision FROM notification_preferences WHERE tenant_id=? AND principal_id=?",
        [tenantId, principalId],
      )
    )[0];
    if (!preference) return { mode: "all", read: [], revision: 0 };
    const read = await q.all<{ notification_id: string }>(
      "SELECT notification_id FROM notification_reads WHERE tenant_id=? AND principal_id=? ORDER BY read_order",
      [tenantId, principalId],
    );
    const state = notificationStateSchema.parse({
      mode: preference.mode,
      read: read.map((row) => row.notification_id),
    });
    return { ...state, revision: safeInteger(preference.revision, "通知修订") };
  }

  /** Idempotent personal notification command. */
  async updateNotificationState(
    access: PlatformActor,
    request: {
      commandId: string;
      expectedRevision: number;
      action: "settings" | "read";
      mode?: "all" | "off";
      ids?: string[];
      now?: string;
    },
  ) {
    const actor = await this.authorize(access);
    if (actor.kind === "provider")
      throw new PlatformStorageError(
        "forbidden",
        "资源提供方不能修改用户通知。",
      );
    requireId(request.commandId, "操作标识");
    if (
      !Number.isSafeInteger(request.expectedRevision) ||
      request.expectedRevision < 0
    )
      throw new PlatformStorageError("invalid", "通知修订无效。");
    if (
      (request.action === "settings" &&
        ((request.mode !== "all" && request.mode !== "off") ||
          request.ids !== undefined)) ||
      (request.action === "read" &&
        (request.mode !== undefined ||
          !Array.isArray(request.ids) ||
          request.ids.length > 200 ||
          request.ids.some(
            (id) => !notificationIdSchema.safeParse(id).success,
          ))) ||
      (request.action !== "settings" && request.action !== "read")
    )
      throw new PlatformStorageError("invalid", "通知操作无效。");
    const hash = fingerprint({ actor, ...request, now: undefined });
    const now = request.now ?? new Date().toISOString();
    return this.transaction(async (q) => {
      if (actor.kind === "agent")
        await this.assertMember(q, actor, actor.scopeProjectId!);
      const earlier = await this.replay(q, actor, request.commandId, hash);
      if (earlier !== null) return safeInteger(Number(earlier), "通知回执修订");
      const current = await this.notificationState(
        q,
        actor.tenantId,
        actor.principalId,
      );
      if (current.revision !== request.expectedRevision)
        throw new PlatformStorageError(
          "conflict",
          "通知状态已更新，请重新读取。",
        );
      const revision = current.revision + 1;
      if (!Number.isSafeInteger(revision))
        throw new PlatformStorageError("conflict", "通知修订超出范围。");
      const mode = request.action === "settings" ? request.mode! : current.mode;
      const changed =
        current.revision === 0
          ? await q.change(
              "INSERT INTO notification_preferences(tenant_id,principal_id,mode,revision,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(tenant_id,principal_id) DO NOTHING",
              [actor.tenantId, actor.principalId, mode, revision, now],
            )
          : await q.change(
              "UPDATE notification_preferences SET mode=?,revision=?,updated_at=? WHERE tenant_id=? AND principal_id=? AND revision=?",
              [
                mode,
                revision,
                now,
                actor.tenantId,
                actor.principalId,
                current.revision,
              ],
            );
      if (changed !== 1)
        throw new PlatformStorageError(
          "conflict",
          "通知状态已更新，请重新读取。",
        );
      if (request.action === "read") {
        const seen = new Set(current.read);
        const append = [...new Set(request.ids)].filter((id) => !seen.has(id));
        const rows = await q.all<{ maximum: number | string | null }>(
          "SELECT MAX(read_order) AS maximum FROM notification_reads WHERE tenant_id=? AND principal_id=?",
          [actor.tenantId, actor.principalId],
        );
        const start =
          rows[0]?.maximum === null
            ? 0
            : safeInteger(rows[0]!.maximum!, "通知顺序");
        if (!Number.isSafeInteger(start + append.length))
          throw new PlatformStorageError("conflict", "通知顺序超出范围。");
        for (const [index, id] of append.entries())
          await q.change(
            "INSERT INTO notification_reads(tenant_id,principal_id,notification_id,read_order) VALUES(?,?,?,?)",
            [actor.tenantId, actor.principalId, id, start + index + 1],
          );
        const excess = current.read.length + append.length - 2000;
        if (excess > 0)
          await q.change(
            "DELETE FROM notification_reads WHERE tenant_id=? AND principal_id=? AND notification_id IN (SELECT notification_id FROM notification_reads WHERE tenant_id=? AND principal_id=? ORDER BY read_order LIMIT ?)",
            [
              actor.tenantId,
              actor.principalId,
              actor.tenantId,
              actor.principalId,
              excess,
            ],
          );
      }
      await this.receipt(
        q,
        actor,
        request.commandId,
        hash,
        `notifications-${request.action}`,
        String(revision),
        now,
      );
      return revision;
    });
  }

  private async requestedTaskRun(
    q: Query,
    tenantId: string,
    eventId: string,
  ): Promise<TaskRunAdmission> {
    const row = (
      await q.all<{
        aggregate_kind: string;
        aggregate_id: string;
        aggregate_revision: number | string;
        event_kind: string;
        payload: string;
      }>(
        "SELECT aggregate_kind,aggregate_id,aggregate_revision,event_kind,payload FROM outbox WHERE tenant_id=? AND event_id=?",
        [tenantId, eventId],
      )
    )[0];
    if (
      !row ||
      row.aggregate_kind !== "task" ||
      row.event_kind !== "task.run_requested"
    )
      throw new PlatformStorageError("not_found", "事项执行请求不存在。");
    const admission = taskRunAdmissionSchema.parse(JSON.parse(row.payload));
    if (
      admission.tenantId !== tenantId ||
      admission.eventId !== eventId ||
      admission.taskId !== row.aggregate_id ||
      admission.taskRevision !==
        safeInteger(row.aggregate_revision, "事项执行版本")
    )
      throw new Error("事项执行请求与持久事件不一致。");
    return admission;
  }

  private async preparedTaskRun(
    q: Query,
    admission: TaskRunAdmission,
  ): Promise<PreparedTaskRun | null> {
    const row = (
      await q.all<{
        aggregate_kind: string;
        aggregate_id: string;
        aggregate_revision: number | string;
        event_kind: string;
        payload: string;
      }>(
        "SELECT aggregate_kind,aggregate_id,aggregate_revision,event_kind,payload FROM outbox WHERE tenant_id=? AND event_id=?",
        [admission.tenantId, taskPreparationEventId(admission.eventId)],
      )
    )[0];
    if (!row) return null;
    const prepared = preparedTaskRunSchema.parse(JSON.parse(row.payload));
    if (
      row.aggregate_kind !== "task" ||
      row.event_kind !== "task.run_prepared" ||
      row.aggregate_id !== admission.taskId ||
      safeInteger(row.aggregate_revision, "固定执行版本") !==
        admission.taskRevision ||
      fingerprint(prepared.admission) !==
        fingerprint(prepareTaskAdmission(admission, prepared.prerequisites))
    )
      throw new Error("固定的事项执行请求与原始准入不一致。");
    const version = await this.loadTaskVersion(
      q,
      admission.tenantId,
      admission.taskId,
      admission.taskRevision,
    );
    if (
      !version ||
      fingerprint(version.depends_on_ids) !==
        fingerprint(prepared.prerequisites.map((item) => item.taskId))
    )
      throw new Error("固定的前置引用与事项原始版本不一致。");
    return prepared;
  }

  private async taskRunAdmission(q: Query, tenantId: string, eventId: string) {
    const admission = await this.requestedTaskRun(q, tenantId, eventId);
    return (await this.preparedTaskRun(q, admission))?.admission ?? admission;
  }

  /** The declared graph comes from the admitted immutable version. Reads
   * select at most 100 current dependencies, not a workspace or response log. */
  private async loadTaskPrerequisites(
    q: Query,
    admission: TaskRunAdmission,
  ): Promise<TaskRunPrerequisite[]> {
    const version = await this.loadTaskVersion(
      q,
      admission.tenantId,
      admission.taskId,
      admission.taskRevision,
    );
    if (!version || version.project_id !== admission.projectId)
      throw new Error("事项执行的原始版本不存在或归属不一致。");
    const ids = version.depends_on_ids;
    if (!ids.length) return [];
    if (ids.length > 100) throw new Error("事项执行依赖超过上限。");
    const rows = await q.all<{
      task_id: string;
      project_id: string;
      title: string;
      revision: number | string;
      assignee_id: string;
      execution: TaskRunPrerequisite["execution"];
      response_id: string | null;
      response_revision: number | string | null;
      runtime_session_id: string | null;
      runtime_schedule_id: string | null;
      runtime_thread_id: string | null;
    }>(
      `SELECT t.task_id,t.project_id,t.title,t.revision,t.assignee_id,t.execution,r.response_id,r.task_revision AS response_revision,l.runtime_session_id,l.runtime_schedule_id,l.runtime_thread_id
       FROM tasks t JOIN task_versions v ON v.tenant_id=t.tenant_id AND v.task_id=t.task_id AND v.revision=t.revision
       LEFT JOIN task_responses r ON r.tenant_id=t.tenant_id AND r.task_id=t.task_id AND r.response_id=(
         SELECT candidate.response_id FROM task_responses candidate JOIN task_versions source ON source.tenant_id=candidate.tenant_id AND source.task_id=candidate.task_id AND source.revision=candidate.task_revision
         WHERE candidate.tenant_id=t.tenant_id AND candidate.task_id=t.task_id AND candidate.author_actant_id=t.assignee_id AND t.execution='completed' AND source.description=t.description
           AND NOT EXISTS(SELECT 1 FROM task_versions changed WHERE changed.tenant_id=t.tenant_id AND changed.task_id=t.task_id AND changed.revision>candidate.task_revision AND changed.revision<=t.revision AND (changed.execution<>'completed' OR changed.assignee_id<>t.assignee_id OR changed.description<>source.description))
         ORDER BY candidate.created_at DESC,candidate.response_id DESC LIMIT 1)
       LEFT JOIN task_run_links l ON l.tenant_id=t.tenant_id AND l.task_id=t.task_id AND l.run_number=v.run_requested
       WHERE t.tenant_id=? AND t.deleted_at IS NULL AND t.task_id IN (${ids.map(() => "?").join(",")}) ORDER BY t.task_id`,
      [admission.tenantId, ...ids],
    );
    if (
      rows.length !== ids.length ||
      rows.some((row) => row.project_id !== admission.projectId)
    )
      throw new PlatformStorageError(
        "conflict",
        "前置事项已删除或移出原项目，未投递执行。",
      );
    const identities = new Map<
      string,
      Awaited<ReturnType<PlatformAuthorityVerifier["resolveActant"]>>
    >();
    for (const assigneeId of new Set(rows.map((row) => row.assignee_id)))
      identities.set(
        assigneeId,
        await this.capabilities.resolveActant({
          tenantId: admission.tenantId,
          actantId: assigneeId,
        }),
      );
    const selected = new Map(rows.map((row) => [row.task_id, row]));
    return ids.map((id) => {
      const row = selected.get(id)!;
      const identity = identities.get(row.assignee_id);
      if (!identity)
        throw new PlatformStorageError(
          "forbidden",
          "前置事项的负责人身份已失效。",
        );
      return {
        taskId: id,
        taskRevision: safeInteger(row.revision, "前置事项修订"),
        title: row.title,
        assigneeId: row.assignee_id,
        kind: identity.kind,
        execution: row.execution,
        response:
          identity.kind === "human" && row.response_id
            ? {
                responseId: row.response_id,
                taskRevision: safeInteger(
                  row.response_revision!,
                  "前置答复版本",
                ),
              }
            : null,
        runtime:
          identity.kind === "agent" && row.runtime_thread_id
            ? {
                sessionId: row.runtime_session_id!,
                scheduleId: row.runtime_schedule_id!,
                threadId: row.runtime_thread_id,
              }
            : null,
      };
    });
  }

  private async assertTaskRunPreparer(
    q: Query,
    actor: ResolvedActor,
    admission: TaskRunAdmission,
    forWrite = false,
  ) {
    if (
      actor.kind !== "human" ||
      actor.principalId !== admission.principalId ||
      actor.actantId !== admission.humanActantId
    )
      throw new PlatformStorageError(
        "forbidden",
        "执行准备必须使用原始 Human 身份。",
      );
    await this.assertMember(q, actor, admission.projectId, forWrite);
    if (!forWrite)
      await this.assertProjectNotRetiring(q, actor, admission.projectId);
  }

  /** Compile exactly once before POST. External Runtime reads never hold a
   * database write lock; a fresh authorization and dependency fingerprint are
   * checked in the commit transaction. Normal waiting is not a retry error. */
  async prepareTaskRun(
    access: PlatformActor,
    eventId: string,
    inspect: (
      runtime: TaskRunLink["runtime"],
    ) => Promise<PriorRuntimeObservation>,
  ): Promise<TaskRunAdmission | null> {
    const actor = await this.authorize(access);
    requireId(eventId, "执行事件标识");
    const selected = await this.transaction(async (q) => {
      const admission = await this.requestedTaskRun(q, actor.tenantId, eventId);
      await this.assertTaskRunPreparer(q, actor, admission);
      const prepared = await this.preparedTaskRun(q, admission);
      const withdrawn = await q.all(
        "SELECT 1 FROM outbox WHERE tenant_id=? AND event_id=? AND event_kind='task.run_withdrawn'",
        [actor.tenantId, `task_stop_${eventId.slice("task_run_".length)}`],
      );
      return {
        admission,
        prepared,
        withdrawn: !!withdrawn.length,
        prerequisites:
          prepared?.prerequisites ??
          (withdrawn.length
            ? []
            : await this.loadTaskPrerequisites(q, admission)),
      };
    }, "read");
    if (selected.withdrawn) return null;
    if (selected.prepared) return selected.prepared.admission;
    if (
      selected.prerequisites.some(
        (item) =>
          item.execution === "cancelled" ||
          (item.kind === "human" ? !item.response : !item.runtime),
      )
    )
      return null;
    let cursor = 0;
    let ready = true;
    const agentDependencies = selected.prerequisites.filter(
      (item) => item.kind === "agent",
    );
    await Promise.all(
      Array.from(
        { length: Math.min(4, agentDependencies.length) },
        async () => {
          while (cursor < agentDependencies.length) {
            const item = agentDependencies[cursor++]!;
            const status = await inspect(item.runtime!);
            if (
              status.source !== "runtime" ||
              fingerprint(status.runtime) !== fingerprint(item.runtime)
            )
              throw new PlatformStorageError(
                "conflict",
                "前置执行的 Runtime 引用不一致。",
              );
            if (
              status.schedule.status === "cancelled" ||
              ["failed", "cancelled"].includes(status.thread.lifecycle)
            )
              ready = false;
          }
        },
      ),
    );
    if (!ready) return null;
    const currentActor = await this.authorize(access);
    return this.transaction(async (q) => {
      const admission = await this.requestedTaskRun(
        q,
        currentActor.tenantId,
        eventId,
      );
      await this.assertTaskRunPreparer(q, currentActor, admission, true);
      const task = (
        await q.all<{ project_id: string; revision: number | string }>(
          `SELECT project_id,revision FROM tasks WHERE tenant_id=? AND task_id=? AND deleted_at IS NULL${this.backend.kind === "postgres" ? " FOR UPDATE" : ""}`,
          [currentActor.tenantId, admission.taskId],
        )
      )[0];
      if (!task || task.project_id !== admission.projectId)
        throw new PlatformStorageError("conflict", "事项所属项目已变化。");
      const earlier = await this.preparedTaskRun(q, admission);
      if (earlier) return earlier.admission;
      const stop = await q.all(
        "SELECT 1 AS withdrawn FROM outbox WHERE tenant_id=? AND event_id=? AND event_kind='task.run_withdrawn'",
        [
          currentActor.tenantId,
          `task_stop_${eventId.slice("task_run_".length)}`,
        ],
      );
      if (stop.length) return null;
      const latest = await this.loadTaskVersion(
        q,
        currentActor.tenantId,
        admission.taskId,
        safeInteger(task.revision, "事项修订"),
      );
      if (!latest || latest.run_requested !== admission.runNumber) return null;
      // A share lock prevents a concurrent dependency edit between the CAS
      // check and the compiled event commit, without blocking Runtime reads.
      if (this.backend.kind === "postgres" && selected.prerequisites.length)
        await q.all(
          `SELECT task_id FROM tasks WHERE tenant_id=? AND task_id IN (${selected.prerequisites.map(() => "?").join(",")}) ORDER BY task_id FOR SHARE`,
          [
            currentActor.tenantId,
            ...selected.prerequisites.map((item) => item.taskId),
          ],
        );
      const prerequisites = await this.loadTaskPrerequisites(q, admission);
      if (fingerprint(prerequisites) !== fingerprint(selected.prerequisites))
        return null;
      const prepared = preparedTaskRunSchema.parse({
        admission: prepareTaskAdmission(admission, prerequisites),
        prerequisites,
      });
      await q.change(
        "INSERT INTO outbox(tenant_id,event_id,aggregate_kind,aggregate_id,aggregate_revision,event_kind,payload,created_at) VALUES(?,?,'task',?,?,'task.run_prepared',?,?)",
        [
          currentActor.tenantId,
          taskPreparationEventId(eventId),
          admission.taskId,
          admission.taskRevision,
          JSON.stringify(prepared),
          new Date().toISOString(),
        ],
      );
      return prepared.admission;
    });
  }

  /** Authorized presentation and retry lookup; frozen references win after
   * preparation, so a later dependency rerun cannot retarget an old Schedule. */
  async taskRunPrerequisites(
    access: PlatformActor,
    taskId: string,
    runNumber: number,
  ) {
    const actor = await this.authorize(access);
    requireId(taskId, "事项标识");
    if (!Number.isSafeInteger(runNumber) || runNumber < 1)
      throw new PlatformStorageError("invalid", "执行序号无效。");
    const eventId = `task_run_${fingerprint([actor.tenantId, taskId, runNumber]).slice(0, 40)}`;
    return this.transaction(async (q) => {
      const admission = await this.requestedTaskRun(q, actor.tenantId, eventId);
      await this.assertProjectReader(q, actor, admission.projectId);
      const task = (
        await q.all<{ project_id: string }>(
          "SELECT project_id FROM tasks WHERE tenant_id=? AND task_id=? AND deleted_at IS NULL",
          [actor.tenantId, taskId],
        )
      )[0];
      if (!task || task.project_id !== admission.projectId)
        throw new PlatformStorageError("conflict", "事项所属项目已变化。");
      const prepared = await this.preparedTaskRun(q, admission);
      const withdrawn = await q.all(
        "SELECT 1 AS withdrawn FROM outbox WHERE tenant_id=? AND event_id=? AND event_kind='task.run_withdrawn'",
        [actor.tenantId, `task_stop_${eventId.slice("task_run_".length)}`],
      );
      return {
        admission: prepared?.admission ?? admission,
        prepared: !!prepared,
        withdrawn: !!withdrawn.length,
        prerequisites:
          prepared?.prerequisites ??
          (withdrawn.length
            ? []
            : await this.loadTaskPrerequisites(q, admission)),
      };
    }, "read");
  }

  /** A new Runtime Schedule cannot be POSTed before this transaction commits.
   * The outbox event is the durable admission, including the exact request to
   * retry after a lost acknowledgement. The trusted Host supplies a Session
   * already resolved for this Human and project; Clients never call this
   * store method with a model-selected Session. */
  async requestTaskRun(
    access: PlatformActor,
    request: {
      commandId: string;
      taskId: string;
      expectedRevision: number;
      sessionId: string;
      intent: string;
      modelAlias?: string | null;
      reasoningEffort?: string | null;
      notBefore: string;
      intervalSeconds?: number | null;
      now?: string;
    },
    priorRuntime?: PriorRuntimeObservation,
    readWatchSource?: TaskWatchSourceReader,
  ): Promise<TaskRunAdmission> {
    const actor = await this.authorize(access);
    requireId(request.commandId, "操作标识");
    requireId(request.taskId, "事项标识");
    const humanActantId =
      actor.kind === "human" ? actor.actantId : actor.initiatingHumanActantId;
    if (!humanActantId)
      throw new PlatformStorageError(
        "forbidden",
        "执行请求缺少原始 Human 身份。",
      );
    requireId(humanActantId, "原始 Human 标识");
    const human = await this.capabilities.resolveActant({
      tenantId: actor.tenantId,
      actantId: humanActantId,
    });
    if (human?.kind !== "human" || human.principalId !== actor.principalId)
      throw new PlatformStorageError(
        "forbidden",
        "执行请求的原始 Human 身份已变化。",
      );
    const hash = fingerprint({ actor, ...request, now: undefined });
    const now = request.now ?? new Date().toISOString();
    if (
      !Number.isSafeInteger(request.expectedRevision) ||
      request.expectedRevision < 1
    )
      throw new PlatformStorageError("invalid", "事项修订无效。");
    // Resolve receipts before app I/O. A retry must keep the original baseline,
    // even if the watched app acquired a newer version after the first commit.
    const { earlier, sources } = await this.transaction(async (q) => {
      const result = await this.replay(q, actor, request.commandId, hash);
      if (result) {
        const admission = await this.taskRunAdmission(
          q,
          actor.tenantId,
          result,
        );
        await this.assertProjectReader(q, actor, admission.projectId);
        return { earlier: admission, sources: [] };
      }
      const current = (
        await q.all<{ revision: number | string }>(
          "SELECT revision FROM tasks WHERE tenant_id=? AND task_id=? AND deleted_at IS NULL",
          [actor.tenantId, request.taskId],
        )
      )[0];
      if (!current) throw new PlatformStorageError("not_found", "事项不存在。");
      if (
        safeInteger(current.revision, "事项修订") !== request.expectedRevision
      )
        throw new PlatformStorageError("conflict", "事项已变化，请重新读取。");
      const task = await this.loadTaskVersion(
        q,
        actor.tenantId,
        request.taskId,
        request.expectedRevision,
      );
      if (!task)
        throw new PlatformStorageError("not_found", "事项版本不存在。");
      if (!task.project_id)
        throw new PlatformStorageError("invalid", "事项没有有效项目。");
      await this.assertProjectReader(q, actor, task.project_id);
      return {
        earlier: null,
        sources: await this.taskWatchSources(
          q,
          actor,
          task.project_id,
          task.watch_source_ids,
        ),
      };
    }, "read");
    if (earlier) return earlier;
    const versions: Array<TaskWatchSource & { versionRef: string }> = [];
    for (const source of sources) {
      const versionRef =
        source.kind === "task"
          ? String(source.revision)
          : readWatchSource
            ? await readWatchSource(access, source)
            : null;
      if (!versionRef || versionRef.length > 200)
        throw new PlatformStorageError(
          "invalid",
          "关注来源的应用精确版本尚不可读取。",
        );
      versions.push({ ...source, versionRef });
    }
    // App reads can await another process. Revoke/identity changes during that
    // await must invalidate admission as well as the source read itself.
    const currentActor = await this.authorize(access);
    if (fingerprint(currentActor) !== fingerprint(actor))
      throw new PlatformStorageError(
        "forbidden",
        "读取期间执行请求的身份已变化。",
      );
    return this.transaction(async (q) => {
      const earlier = await this.replay(q, actor, request.commandId, hash);
      if (earlier) return this.taskRunAdmission(q, actor.tenantId, earlier);
      const scope = (
        await q.all<{ project_id: string }>(
          "SELECT project_id FROM tasks WHERE tenant_id=? AND task_id=? AND deleted_at IS NULL",
          [actor.tenantId, request.taskId],
        )
      )[0];
      if (!scope) throw new PlatformStorageError("not_found", "事项不存在。");
      await this.assertMember(q, actor, scope.project_id);
      const current = (
        await q.all<{
          project_id: string;
          assignee_id: string;
          execution: string;
          revision: number | string;
        }>(
          `SELECT project_id,assignee_id,execution,revision FROM tasks WHERE tenant_id=? AND task_id=? AND deleted_at IS NULL${this.backend.kind === "postgres" ? " FOR UPDATE" : ""}`,
          [actor.tenantId, request.taskId],
        )
      )[0];
      if (!current) throw new PlatformStorageError("not_found", "事项不存在。");
      if (current.project_id !== scope.project_id)
        throw new PlatformStorageError("conflict", "事项所属项目已变化。");
      // A concurrent retry can arrive before the first transaction commits.
      // Read its durable receipt again after serializing on this task row.
      const committed = await this.replay(q, actor, request.commandId, hash);
      if (committed) return this.taskRunAdmission(q, actor.tenantId, committed);
      if (
        safeInteger(current.revision, "事项修订") !== request.expectedRevision
      )
        throw new PlatformStorageError("conflict", "事项已变化，请重新读取。");
      const assignee = await this.capabilities.resolveActant({
        tenantId: actor.tenantId,
        actantId: current.assignee_id,
      });
      if (!assignee || assignee.kind !== "agent")
        throw new PlatformStorageError(
          "invalid",
          "只有 Agent 事项可以请求 Runtime 执行。",
        );
      const assignedMember = await q.all(
        "SELECT 1 AS allowed FROM project_members WHERE tenant_id=? AND project_id=? AND principal_id=?",
        [actor.tenantId, current.project_id, assignee.principalId],
      );
      if (!assignedMember.length)
        throw new PlatformStorageError("forbidden", "负责人已不在这个项目中。");
      const previous = await this.loadTaskVersion(
        q,
        actor.tenantId,
        request.taskId,
        request.expectedRevision,
      );
      if (!previous) throw new Error("事项当前版本缺失，拒绝请求执行。");
      const currentSources = await this.taskWatchSources(
        q,
        actor,
        current.project_id,
        previous.watch_source_ids,
        true,
      );
      if (JSON.stringify(currentSources) !== JSON.stringify(sources))
        throw new PlatformStorageError(
          "conflict",
          "读取期间关注来源的身份、权限或目录版本已变化。",
        );
      if (previous.run_requested === 0) {
        if (["active", "waiting"].includes(current.execution))
          throw new PlatformStorageError("conflict", "事项已有执行在途。");
        if (priorRuntime)
          throw new PlatformStorageError("invalid", "该事项没有上一轮执行。");
      } else {
        const withdrawn = await q.all(
          "SELECT 1 AS withdrawn FROM outbox WHERE tenant_id=? AND event_id=? AND event_kind='task.run_withdrawn'",
          [
            actor.tenantId,
            `task_stop_${fingerprint([actor.tenantId, request.taskId, previous.run_requested]).slice(0, 40)}`,
          ],
        );
        const prior = (
          await q.all<{
            runtime_session_id: string;
            runtime_schedule_id: string;
            runtime_thread_id: string;
            request_interval_seconds: number | string | null;
            bridge_source_stopped: number | string;
            bridge_stop_requested: number | string;
          }>(
            "SELECT runtime_session_id,runtime_schedule_id,runtime_thread_id,request_interval_seconds,bridge_source_stopped,bridge_stop_requested FROM task_run_links WHERE tenant_id=? AND task_id=? AND run_number=?",
            [actor.tenantId, request.taskId, previous.run_requested],
          )
        )[0];
        const observed = priorRuntime;
        const sourceWatchOpen = prior
          ? await this.taskRunSourceWatchOpen(
              q,
              actor.tenantId,
              request.taskId,
              previous.run_requested,
              Number(prior.bridge_source_stopped) === 1,
            )
          : false;
        if (
          !withdrawn.length &&
          (!prior ||
            sourceWatchOpen ||
            observed?.source !== "runtime" ||
            prior.runtime_session_id !== observed.runtime.sessionId ||
            prior.runtime_schedule_id !== observed.runtime.scheduleId ||
            prior.runtime_thread_id !== observed.runtime.threadId ||
            Number(prior.bridge_stop_requested) === 1 ||
            (!["completed", "cancelled"].includes(observed.schedule.status) &&
              !(
                observed.schedule.status === "dispatched" &&
                prior.request_interval_seconds === null &&
                Number(prior.bridge_source_stopped) === 1
              )) ||
            !["completed", "failed", "cancelled"].includes(
              observed.thread.lifecycle,
            ))
        )
          throw new PlatformStorageError(
            "conflict",
            "上一轮执行尚未由 Runtime 确认结束。",
          );
      }
      // Reassignment clears the current execution selection, not its immutable
      // history. Allocate while holding the task row lock so a new owner can
      // never reuse an earlier admission/Schedule ID, even after withdrawal or
      // a lost POST acknowledgement (which need not have a task_run_link yet).
      const historicalRun = (
        await q.all<{ run_number: number | string | null }>(
          "SELECT MAX(run_requested) AS run_number FROM task_versions WHERE tenant_id=? AND task_id=?",
          [actor.tenantId, request.taskId],
        )
      )[0]?.run_number;
      const runNumber =
        Math.max(
          previous.run_requested,
          historicalRun === null || historicalRun === undefined
            ? 0
            : safeInteger(historicalRun, "历史执行序号"),
        ) + 1;
      const taskRevision = request.expectedRevision + 1;
      // The Runtime Schedule root must resolve to this immutable admission
      // even before the Host has received and confirmed its POST response.
      // Both IDs derive from the same task/run identity but remain distinct.
      const runKey = fingerprint([
        actor.tenantId,
        request.taskId,
        runNumber,
      ]).slice(0, 40);
      const eventId = `task_run_${runKey}`;
      const scheduleId = `task_${runKey}`;
      const admission = taskRunAdmissionSchema.parse({
        eventId,
        tenantId: actor.tenantId,
        taskId: request.taskId,
        projectId: current.project_id,
        runNumber,
        taskRevision,
        principalId: actor.principalId,
        humanActantId,
        sourceInputId: actor.runtimeInputId,
        sessionId: request.sessionId,
        request: {
          id: scheduleId,
          intent: request.intent,
          model_alias: request.modelAlias ?? null,
          reasoning_effort: request.reasoningEffort ?? null,
          response_annotations: "v2",
          not_before: request.notBefore,
          interval_seconds: request.intervalSeconds ?? null,
          dependency_thread_ids: [],
        },
        sourceSignature: JSON.stringify(versions),
        watchSourceIds: previous.watch_source_ids,
      });
      if (
        new Set(admission.request.dependency_thread_ids).size !==
        admission.request.dependency_thread_ids.length
      )
        throw new PlatformStorageError(
          "invalid",
          "执行依赖或关注来源基线无效。",
        );
      const changed = await q.change(
        "UPDATE tasks SET execution='waiting',revision=revision+1,updated_at=? WHERE tenant_id=? AND task_id=? AND revision=? AND project_id=?",
        [
          now,
          actor.tenantId,
          request.taskId,
          request.expectedRevision,
          current.project_id,
        ],
      );
      if (changed !== 1)
        throw new PlatformStorageError("conflict", "事项已变化，请重新读取。");
      await this.insertTaskVersion(q, actor.tenantId, {
        ...previous,
        revision: taskRevision,
        assignment: "accepted",
        execution: "waiting",
        delivery: "none",
        run_requested: runNumber,
        model_id: admission.request.model_alias,
        reasoning_effort: admission.request.reasoning_effort,
        not_before: admission.request.not_before,
        every_seconds: admission.request.interval_seconds,
        author_principal_id: actor.principalId,
        author_actant_id: actor.actantId,
        created_at: now,
      });
      await q.change(
        "INSERT INTO outbox(tenant_id,event_id,aggregate_kind,aggregate_id,aggregate_revision,event_kind,payload,created_at) VALUES(?,?,'task',?,?,'task.run_requested',?,?)",
        [
          actor.tenantId,
          eventId,
          request.taskId,
          taskRevision,
          JSON.stringify(admission),
          now,
        ],
      );
      // A dependency-free request is already final in the admission transaction.
      if (!previous.depends_on_ids.length)
        await q.change(
          "INSERT INTO outbox(tenant_id,event_id,aggregate_kind,aggregate_id,aggregate_revision,event_kind,payload,created_at) VALUES(?,?,'task',?,?,'task.run_prepared',?,?)",
          [
            actor.tenantId,
            taskPreparationEventId(eventId),
            request.taskId,
            taskRevision,
            JSON.stringify({ admission, prerequisites: [] }),
            now,
          ],
        );
      await this.receipt(
        q,
        actor,
        request.commandId,
        hash,
        "request-task-run",
        eventId,
        now,
      );
      return admission;
    });
  }

  /** Host-only drain source. Undelivered admissions block project retirement;
   * retrying an event must reuse its Schedule ID and immutable request. */
  async pendingTaskRuns(
    tenantId: string,
    limit = 50,
    afterEventId?: string,
  ): Promise<TaskRunAdmission[]> {
    requireId(tenantId, "租户标识");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new PlatformStorageError("invalid", "执行请求分页大小无效。");
    if (afterEventId !== undefined) requireId(afterEventId, "执行请求游标");
    return this.transaction(async (q) => {
      const cursor = afterEventId
        ? (
            await q.all<{ created_at: string }>(
              "SELECT created_at FROM outbox WHERE tenant_id=? AND event_id=? AND event_kind='task.run_requested'",
              [tenantId, afterEventId],
            )
          )[0]
        : undefined;
      if (afterEventId && !cursor)
        throw new PlatformStorageError("invalid", "执行请求游标不存在。");
      const rows = await q.all<{ event_id: string }>(
        `SELECT event_id FROM outbox WHERE tenant_id=? AND event_kind='task.run_requested' AND delivered_at IS NULL${cursor ? " AND (created_at>? OR (created_at=? AND event_id>?))" : ""} ORDER BY created_at,event_id LIMIT ?`,
        cursor
          ? [
              tenantId,
              cursor.created_at,
              cursor.created_at,
              afterEventId!,
              limit,
            ]
          : [tenantId, limit],
      );
      const admissions: TaskRunAdmission[] = [];
      for (const row of rows)
        admissions.push(await this.taskRunAdmission(q, tenantId, row.event_id));
      return admissions;
    }, "read");
  }

  /** Host-only lookup for a Runtime-verified Schedule root. This also works
   * while the Schedule POST is in flight: the admission was committed first,
   * and no scan or second provenance table is needed. It grants no authority
   * by itself; the caller must verify the exact Runtime Thread lineage and
   * current Human/project identity before issuing an Agent credential. */
  async taskRunAdmissionForRuntime(
    tenantId: string,
    sessionId: string,
    scheduleId: string,
  ): Promise<TaskRunAdmission> {
    requireId(tenantId, "租户标识");
    requireId(sessionId, "Runtime 会话标识");
    if (!/^task_[a-f0-9]{40}$/.test(scheduleId))
      throw new PlatformStorageError("not_found", "事项执行请求不存在。");
    const eventId = `task_run_${scheduleId.slice(5)}`;
    return this.transaction(async (q) => {
      const admission = await this.taskRunAdmission(q, tenantId, eventId);
      if (
        !(await this.preparedTaskRun(
          q,
          await this.requestedTaskRun(q, tenantId, eventId),
        ))
      )
        throw new PlatformStorageError(
          "conflict",
          "执行依赖尚未固定，不能证明 Runtime 来源。",
        );
      if (
        admission.sessionId !== sessionId ||
        admission.request.id !== scheduleId
      )
        throw new PlatformStorageError("not_found", "事项执行请求不存在。");
      return admission;
    }, "read");
  }

  /** Called only after the trusted Host has replayed the exact Runtime POST
   * and inspected its Schedule and Thread using the original Human identity.
   * Confirmation and link insertion share one Platform transaction. */
  async confirmTaskRun(
    tenantId: string,
    eventId: string,
    rawReceipt: TaskRunRuntimeReceipt,
  ): Promise<{ taskId: string; runNumber: number }> {
    requireId(tenantId, "租户标识");
    requireId(eventId, "执行事件标识");
    const receipt = taskRunRuntimeReceiptSchema.parse(rawReceipt);
    return this.transaction(async (q) => {
      const admission = await this.taskRunAdmission(q, tenantId, eventId);
      if (
        !(await this.preparedTaskRun(
          q,
          await this.requestedTaskRun(q, tenantId, eventId),
        ))
      )
        throw new PlatformStorageError(
          "conflict",
          "执行依赖尚未固定，不能确认 Runtime 回执。",
        );
      if (
        receipt.schedule.id !== admission.request.id ||
        receipt.schedule.thread_id !== receipt.thread.thread_id ||
        receipt.thread.session_id !== admission.sessionId ||
        receipt.thread.root_turn_id !==
          `client-schedule-${admission.request.id}`
      )
        throw new PlatformStorageError(
          "conflict",
          "Runtime 回执与事项执行请求不一致。",
        );
      const event = (
        await q.all<{ delivered_at: string | null }>(
          `SELECT delivered_at FROM outbox WHERE tenant_id=? AND event_id=?${this.backend.kind === "postgres" ? " FOR UPDATE" : ""}`,
          [tenantId, eventId],
        )
      )[0];
      if (!event) throw new Error("事项执行事件在确认期间消失。");
      if (event.delivered_at !== null) {
        const linked = await q.all<{ runtime_thread_id: string }>(
          "SELECT runtime_thread_id FROM task_run_links WHERE tenant_id=? AND task_id=? AND run_number=? AND runtime_schedule_id=?",
          [
            tenantId,
            admission.taskId,
            admission.runNumber,
            admission.request.id,
          ],
        );
        if (
          linked.length !== 1 ||
          linked[0]!.runtime_thread_id !== receipt.thread.thread_id
        )
          throw new Error("事项执行确认与持久关联不一致。");
        return { taskId: admission.taskId, runNumber: admission.runNumber };
      }
      // Serialize a stop requested before the Runtime receipt with link
      // insertion. A concurrent control call will then observe either the
      // pending admission or the confirmed link, never a gap between them.
      const task = await q.all(
        `SELECT task_id FROM tasks WHERE tenant_id=? AND task_id=?${this.backend.kind === "postgres" ? " FOR UPDATE" : ""}`,
        [tenantId, admission.taskId],
      );
      if (task.length !== 1) throw new Error("事项在执行确认期间消失。");
      const stopEventId = `task_stop_${eventId.slice("task_run_".length)}`;
      const pendingStop = await q.all(
        "SELECT 1 AS requested FROM outbox WHERE tenant_id=? AND event_id=? AND aggregate_kind='task' AND aggregate_id=? AND aggregate_revision=? AND event_kind='task.run_stop_requested' AND delivered_at IS NULL",
        [tenantId, stopEventId, admission.taskId, admission.taskRevision],
      );
      if (this.backend.kind === "postgres")
        await q.all(
          "SELECT tenant_id FROM tenants WHERE tenant_id=? FOR UPDATE",
          [tenantId],
        );
      const maximum = (
        await q.all<{ sequence: number | string | null }>(
          "SELECT MAX(sequence) AS sequence FROM task_run_links WHERE tenant_id=?",
          [tenantId],
        )
      )[0]?.sequence;
      const sequence =
        (maximum === null ? 0 : safeInteger(maximum!, "执行顺序")) + 1;
      if (!Number.isSafeInteger(sequence))
        throw new PlatformStorageError("conflict", "事项执行顺序超出范围。");
      await q.change(
        "INSERT INTO task_run_links(tenant_id,task_id,run_number,task_revision,sequence,runtime_session_id,runtime_schedule_id,runtime_thread_id,request_intent,request_model_alias,request_reasoning_effort,request_not_before,request_interval_seconds,observed_schedule_revision,observed_schedule_status,observed_schedule_not_before,observed_schedule_interval_seconds,observed_thread_status,source_signature,bridge_paused,bridge_source_stopped,bridge_stop_requested,bridge_control_revision,bridge_control_pending,bridge_error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
          tenantId,
          admission.taskId,
          admission.runNumber,
          admission.taskRevision,
          sequence,
          admission.sessionId,
          admission.request.id,
          receipt.thread.thread_id,
          admission.request.intent,
          admission.request.model_alias,
          admission.request.reasoning_effort,
          admission.request.not_before,
          admission.request.interval_seconds,
          receipt.schedule.revision,
          receipt.schedule.status,
          receipt.schedule.not_before,
          receipt.schedule.interval_seconds,
          receipt.thread.lifecycle,
          admission.sourceSignature,
          pendingStop.length ? 1 : 0,
          0,
          pendingStop.length ? 1 : 0,
          pendingStop.length ? 2 : 1,
          null,
          pendingStop.length ? "正在停止执行。" : "",
        ],
      );
      if (pendingStop.length)
        await q.change(
          "UPDATE outbox SET delivered_at=? WHERE tenant_id=? AND event_id=? AND delivered_at IS NULL",
          [new Date().toISOString(), tenantId, stopEventId],
        );
      for (const [
        ordinal,
        threadId,
      ] of admission.request.dependency_thread_ids.entries())
        await q.change(
          "INSERT INTO task_run_dependencies(tenant_id,task_id,run_number,ordinal,runtime_thread_id) VALUES(?,?,?,?,?)",
          [tenantId, admission.taskId, admission.runNumber, ordinal, threadId],
        );
      for (const [ordinal, objectId] of admission.watchSourceIds.entries())
        await q.change(
          "INSERT INTO task_run_watch_sources(tenant_id,task_id,run_number,ordinal,source_object_id) VALUES(?,?,?,?,?)",
          [tenantId, admission.taskId, admission.runNumber, ordinal, objectId],
        );
      const changed = await q.change(
        "UPDATE outbox SET delivered_at=? WHERE tenant_id=? AND event_id=? AND delivered_at IS NULL",
        [new Date().toISOString(), tenantId, eventId],
      );
      if (changed !== 1) throw new Error("事项执行确认状态发生并发变化。");
      await q.change(
        "UPDATE outbox SET delivered_at=? WHERE tenant_id=? AND event_id=? AND delivered_at IS NULL",
        [new Date().toISOString(), tenantId, taskPreparationEventId(eventId)],
      );
      return { taskId: admission.taskId, runNumber: admission.runNumber };
    });
  }

  /** The producer inspects only explicitly watched, current runs, in bounded
   * pages. This is not a file scanner or a scheduling authority. */
  async watchedTaskRuns(
    tenantId: string,
    limit = 50,
    afterSequence?: number,
  ): Promise<TaskSourceRun[]> {
    requireId(tenantId, "租户标识");
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (afterSequence !== undefined &&
        (!Number.isSafeInteger(afterSequence) || afterSequence < 1))
    )
      throw new PlatformStorageError("invalid", "来源执行分页无效。");
    return this.transaction(async (q) => {
      const rows = await q.all<{
        task_id: string;
        run_number: number | string;
        sequence: number | string;
        bridge_control_revision: number | string;
        source_signature: string;
        runtime_session_id: string;
        runtime_schedule_id: string;
        runtime_thread_id: string;
      }>(
        `SELECT l.task_id,l.run_number,l.sequence,l.bridge_control_revision,l.source_signature,l.runtime_session_id,l.runtime_schedule_id,l.runtime_thread_id FROM task_run_links l JOIN tasks t ON t.tenant_id=l.tenant_id AND t.task_id=l.task_id JOIN task_versions v ON v.tenant_id=t.tenant_id AND v.task_id=t.task_id AND v.revision=t.revision JOIN projects p ON p.tenant_id=t.tenant_id AND p.project_id=t.project_id WHERE l.tenant_id=? AND l.run_number=v.run_requested AND t.deleted_at IS NULL AND t.execution NOT IN ('completed','cancelled') AND p.deleted_at IS NULL AND p.archived_at IS NULL AND l.bridge_paused=0 AND l.bridge_source_stopped=0 AND l.bridge_stop_requested=0 AND l.bridge_control_pending IS NULL AND EXISTS(SELECT 1 FROM task_run_watch_sources w WHERE w.tenant_id=l.tenant_id AND w.task_id=l.task_id AND w.run_number=l.run_number)${afterSequence === undefined ? "" : " AND l.sequence>?"} ORDER BY l.sequence LIMIT ?`,
        [
          tenantId,
          ...(afterSequence === undefined ? [] : [afterSequence]),
          limit,
        ],
      );
      const result: TaskSourceRun[] = [];
      for (const row of rows)
        result.push({
          admission: await this.taskRunAdmission(
            q,
            tenantId,
            `task_run_${row.runtime_schedule_id.slice(5)}`,
          ),
          sequence: safeInteger(row.sequence, "来源执行顺序"),
          controlRevision: safeInteger(
            row.bridge_control_revision,
            "来源控制修订",
          ),
          sourceSignature: row.source_signature,
          runtime: {
            sessionId: row.runtime_session_id,
            scheduleId: row.runtime_schedule_id,
            threadId: row.runtime_thread_id,
          },
        });
      return result;
    }, "read");
  }

  private async currentTaskSourceRun(
    q: Query,
    actor: ResolvedActor,
    run: TaskSourceRun,
    pausedAllowed = false,
  ) {
    const { admission } = run;
    if (
      actor.tenantId !== admission.tenantId ||
      actor.principalId !== admission.principalId ||
      actor.actantId !== admission.humanActantId ||
      actor.kind !== "human"
    )
      throw new PlatformStorageError(
        "forbidden",
        "来源关注的原发起身份不一致。",
      );
    await this.assertProjectReader(q, actor, admission.projectId);
    // Explicitly take the same task → run-link → outbox order as controls,
    // reassignment and new-run admission. A JOIN lock list is not a row-lock
    // ordering guarantee across PostgreSQL query plans.
    if (this.backend.kind === "postgres")
      await q.all(
        "SELECT task_id FROM tasks WHERE tenant_id=? AND task_id=? FOR UPDATE",
        [actor.tenantId, admission.taskId],
      );
    const rows = await q.all<{
      source_signature: string;
      bridge_control_revision: number | string;
      bridge_paused: number | string;
      bridge_source_stopped: number | string;
      bridge_stop_requested: number | string;
      bridge_control_pending: string | null;
      project_id: string;
      assignee_id: string;
      execution: string;
      run_requested: number | string;
    }>(
      `SELECT l.source_signature,l.bridge_control_revision,l.bridge_paused,l.bridge_source_stopped,l.bridge_stop_requested,l.bridge_control_pending,t.project_id,t.assignee_id,t.execution,v.run_requested FROM task_run_links l JOIN tasks t ON t.tenant_id=l.tenant_id AND t.task_id=l.task_id JOIN task_versions v ON v.tenant_id=t.tenant_id AND v.task_id=t.task_id AND v.revision=t.revision WHERE l.tenant_id=? AND l.task_id=? AND l.run_number=? AND l.runtime_session_id=? AND l.runtime_schedule_id=? AND l.runtime_thread_id=? AND t.deleted_at IS NULL${this.backend.kind === "postgres" ? " FOR UPDATE OF l" : ""}`,
      [
        actor.tenantId,
        admission.taskId,
        admission.runNumber,
        run.runtime.sessionId,
        run.runtime.scheduleId,
        run.runtime.threadId,
      ],
    );
    const row = rows[0];
    if (
      !row ||
      row.project_id !== admission.projectId ||
      Number(row.run_requested) !== admission.runNumber ||
      ["completed", "cancelled"].includes(row.execution) ||
      Number(row.bridge_source_stopped) ||
      Number(row.bridge_stop_requested) ||
      (!pausedAllowed &&
        (Number(row.bridge_paused) || row.bridge_control_pending)) ||
      Number(row.bridge_control_revision) !== run.controlRevision
    )
      throw new PlatformStorageError(
        "conflict",
        "来源关注已暂停、停止或改派。",
      );
    const assignee = await this.capabilities.resolveActant({
      tenantId: actor.tenantId,
      actantId: row.assignee_id,
    });
    if (
      !assignee ||
      assignee.kind !== "agent" ||
      !(
        await q.all(
          "SELECT 1 FROM project_members WHERE tenant_id=? AND project_id=? AND principal_id=?",
          [actor.tenantId, admission.projectId, assignee.principalId],
        )
      ).length
    )
      throw new PlatformStorageError("forbidden", "关注事项负责人授权已失效。");
    return row;
  }

  /** Freeze one exact observation before IO; an uncertain POST must replay
   * this request, not today's source or a freshly chosen destination. */
  async prepareTaskSourceEvent(
    access: PlatformActor,
    run: TaskSourceRun,
    destination: TaskSourceDestination,
    readSource: TaskWatchSourceReader,
  ): Promise<TaskSourceEvent | null> {
    const actor = await this.authorize(access);
    const initial = await this.transaction(async (q) => {
      const row = await this.currentTaskSourceRun(q, actor, run);
      const pending = await q.all<{ payload: string }>(
        "SELECT payload FROM outbox WHERE tenant_id=? AND aggregate_kind='task' AND aggregate_id=? AND event_kind='task.source_changed' AND delivered_at IS NULL ORDER BY created_at,event_id LIMIT 1",
        [actor.tenantId, run.admission.taskId],
      );
      if (pending.length) {
        const event = taskSourceEventSchema.parse(
          JSON.parse(pending[0]!.payload).event,
        );
        if (event.runNumber !== run.admission.runNumber)
          throw new PlatformStorageError("conflict", "旧来源事件尚未核对。");
        return {
          pending: event,
          sources: [] as TaskWatchSource[],
          signature: row.source_signature,
        };
      }
      return {
        pending: null,
        sources: await this.taskWatchSources(
          q,
          actor,
          run.admission.projectId,
          run.admission.watchSourceIds,
        ),
        signature: row.source_signature,
      };
    });
    if (initial.pending) return initial.pending;
    const versions: Array<TaskWatchSource & { versionRef: string }> = [];
    for (const source of initial.sources) {
      const versionRef =
        source.kind === "task"
          ? String(source.revision)
          : await readSource(access, source);
      if (!versionRef || versionRef.length > 200)
        throw new PlatformStorageError("invalid", "关注来源精确版本无效。");
      versions.push({ ...source, versionRef });
    }
    const signature = JSON.stringify(versions);
    if (signature === initial.signature) return null;
    const currentActor = await this.authorize(access);
    if (fingerprint(currentActor) !== fingerprint(actor))
      throw new PlatformStorageError("forbidden", "来源读取期间身份已变化。");
    return this.transaction(async (q) => {
      const current = await this.currentTaskSourceRun(q, actor, run);
      if (current.source_signature !== initial.signature)
        throw new PlatformStorageError("conflict", "来源基线已变化。");
      const sources = await this.taskWatchSources(
        q,
        actor,
        run.admission.projectId,
        run.admission.watchSourceIds,
        true,
      );
      if (JSON.stringify(sources) !== JSON.stringify(initial.sources))
        throw new PlatformStorageError(
          "conflict",
          "来源读取期间目录或权限已变化。",
        );
      const pending = await q.all<{ payload: string }>(
        "SELECT payload FROM outbox WHERE tenant_id=? AND aggregate_id=? AND event_kind='task.source_changed' AND delivered_at IS NULL ORDER BY created_at,event_id LIMIT 1",
        [actor.tenantId, run.admission.taskId],
      );
      if (pending.length)
        return taskSourceEventSchema.parse(
          JSON.parse(pending[0]!.payload).event,
        );
      const previous = new Map(
        (
          JSON.parse(initial.signature) as Array<
            TaskWatchSource & { versionRef: string }
          >
        ).map((source) => [source.sourceId, source.versionRef]),
      );
      if (
        versions.every(
          (source) => previous.get(source.sourceId) === source.versionRef,
        )
      ) {
        // Catalog/provider authorization premises can change while the exact
        // app versions do not. Refresh that premise, not the Agent's work.
        await q.change(
          "UPDATE task_run_links SET source_signature=? WHERE tenant_id=? AND task_id=? AND run_number=? AND source_signature=?",
          [
            signature,
            actor.tenantId,
            run.admission.taskId,
            run.admission.runNumber,
            initial.signature,
          ],
        );
        return null;
      }
      const commands: string[] = [];
      for (const source of versions) {
        if (previous.get(source.sourceId) === source.versionRef) continue;
        const rows = await q.all<{ event_id: string; payload: string }>(
          `SELECT event_id,payload FROM outbox WHERE tenant_id=? AND aggregate_id=? AND aggregate_kind=? ${source.kind === "content" ? "AND event_kind='content.refreshed'" : "AND aggregate_revision=?"} ORDER BY aggregate_revision DESC,event_id LIMIT 1`,
          [
            actor.tenantId,
            source.sourceId,
            source.kind,
            ...(source.kind === "task" ? [source.revision] : []),
          ],
        );
        const observed =
          rows[0] && (JSON.parse(rows[0].payload) as Record<string, unknown>);
        if (source.kind === "content") {
          if (
            !observed ||
            observed.observedVersionRef !== source.versionRef ||
            typeof observed.appReceiptId !== "string"
          )
            throw new PlatformStorageError(
              "conflict",
              "来源目录尚未确认应用精确修订回执。",
            );
          commands.push(observed.appReceiptId);
        } else {
          if (!rows[0])
            throw new PlatformStorageError(
              "conflict",
              "来源事项精确修订缺少已提交回执。",
            );
          commands.push(rows[0].event_id);
        }
      }
      const data = {
        eventId: `task_source_${fingerprint([run.admission.eventId, run.controlRevision, initial.signature, signature, destination]).slice(0, 40)}`,
        admissionEventId: run.admission.eventId,
        tenantId: actor.tenantId,
        taskId: run.admission.taskId,
        runNumber: run.admission.runNumber,
        controlRevision: run.controlRevision,
        previousSignature: initial.signature,
        sourceSignature: signature,
        sourceCommandIds: [...new Set(commands)],
        sources: versions.map((source) => ({
          kind: source.kind,
          sourceId: source.sourceId,
          projectId: source.projectId,
          versionRef: source.versionRef,
          ...(source.kind === "content"
            ? {
                appId: source.appId,
                instanceId: source.instanceId,
                objectId: source.objectId,
              }
            : {}),
        })),
        destination,
        admission: run.admission,
      };
      const event = taskSourceEventSchema.parse({
        ...data,
        request: taskSourceRequest(data),
      });
      await q.change(
        "INSERT INTO outbox(tenant_id,event_id,aggregate_kind,aggregate_id,aggregate_revision,event_kind,payload,created_at) VALUES(?,?,'task',?,?,'task.source_changed',?,?) ON CONFLICT(tenant_id,event_id) DO NOTHING",
        [
          actor.tenantId,
          event.eventId,
          event.taskId,
          run.admission.taskRevision,
          JSON.stringify({ event, receipt: null }),
          new Date().toISOString(),
        ],
      );
      return event;
    });
  }

  async assertTaskSourceDelivery(access: PlatformActor, run: TaskSourceRun) {
    const actor = await this.authorize(access);
    await this.transaction((q) => this.currentTaskSourceRun(q, actor, run));
  }

  /** A 404 lookup is not proof that an in-flight POST cannot still commit.
   * Persist its uncertainty under the same task/control lock before IO. */
  async markTaskSourceDeliveryAttempt(
    access: PlatformActor,
    run: TaskSourceRun,
    event: TaskSourceEvent,
  ) {
    const actor = await this.authorize(access);
    return this.transaction(async (q) => {
      await this.currentTaskSourceRun(q, actor, run);
      const currentSources = await this.taskWatchSources(
        q,
        actor,
        run.admission.projectId,
        run.admission.watchSourceIds,
        true,
      );
      if (
        currentSources.length !== event.sources.length ||
        currentSources.some((source, index) => {
          const frozen = event.sources[index]!;
          return (
            source.kind !== frozen.kind ||
            source.sourceId !== frozen.sourceId ||
            source.projectId !== frozen.projectId ||
            (source.kind === "content" &&
              (source.appId !== frozen.appId ||
                source.instanceId !== frozen.instanceId ||
                source.objectId !== frozen.objectId))
          );
        })
      )
        throw new PlatformStorageError(
          "forbidden",
          "冻结来源的归属、应用或可见性已变化。",
        );
      const rows = await q.all<{ payload: string }>(
        `SELECT payload FROM outbox WHERE tenant_id=? AND event_id=? AND event_kind='task.source_changed' AND delivered_at IS NULL${this.backend.kind === "postgres" ? " FOR UPDATE" : ""}`,
        [actor.tenantId, event.eventId],
      );
      if (rows.length !== 1)
        throw new PlatformStorageError("conflict", "来源投递状态已变化。");
      const payload = JSON.parse(rows[0]!.payload);
      if (
        payload.discarded ||
        payload.receipt ||
        JSON.stringify(payload.event) !== JSON.stringify(event) ||
        event.taskId !== run.admission.taskId ||
        event.runNumber !== run.admission.runNumber
      )
        throw new PlatformStorageError(
          "conflict",
          "来源投递与冻结执行不一致。",
        );
      const attempts = z
        .array(z.string().uuid())
        .max(100)
        .parse(payload.deliveryAttempts ?? []);
      // A retry replays the same frozen request and token, never grows the
      // unknown set. Mark it so another Host's rejection cannot clear an
      // earlier in-flight POST. Only an accepted Runtime receipt settles it.
      if (attempts.length) {
        await q.change(
          "UPDATE outbox SET payload=? WHERE tenant_id=? AND event_id=? AND delivered_at IS NULL",
          [
            JSON.stringify({ ...payload, deliveryReplayed: true }),
            actor.tenantId,
            event.eventId,
          ],
        );
        return attempts[0]!;
      }
      const attemptId = randomUUID();
      await q.change(
        "UPDATE outbox SET payload=? WHERE tenant_id=? AND event_id=? AND delivered_at IS NULL",
        [
          JSON.stringify({
            ...payload,
            deliveryAttempts: [attemptId],
            deliveryReplayed: false,
          }),
          actor.tenantId,
          event.eventId,
        ],
      );
      return attemptId;
    });
  }

  /** Runtime returned a definitive non-acceptance response and an exact
   * lookup still found no event. Transport failure never reaches this path. */
  async clearRejectedTaskSourceAttempt(
    tenantId: string,
    event: TaskSourceEvent,
    attemptId: string,
  ) {
    z.string().uuid().parse(attemptId);
    await this.transaction(async (q) => {
      const rows = await q.all<{ payload: string }>(
        `SELECT payload FROM outbox WHERE tenant_id=? AND event_id=? AND event_kind='task.source_changed' AND delivered_at IS NULL${this.backend.kind === "postgres" ? " FOR UPDATE" : ""}`,
        [tenantId, event.eventId],
      );
      if (!rows.length) return;
      const payload = JSON.parse(rows[0]!.payload);
      if (JSON.stringify(payload.event) !== JSON.stringify(event))
        throw new PlatformStorageError(
          "conflict",
          "来源拒绝回执与冻结事件不一致。",
        );
      const attempts = z
        .array(z.string().uuid())
        .max(100)
        .parse(payload.deliveryAttempts ?? []);
      if (payload.deliveryReplayed) return;
      await q.change(
        "UPDATE outbox SET payload=? WHERE tenant_id=? AND event_id=? AND delivered_at IS NULL",
        [
          JSON.stringify({
            ...payload,
            deliveryAttempts: attempts.filter((id) => id !== attemptId),
          }),
          tenantId,
          event.eventId,
        ],
      );
    });
  }

  async taskRunSourceEventForRuntime(
    tenantId: string,
    sessionId: string,
    eventId: string,
  ) {
    requireId(tenantId, "租户标识");
    requireId(sessionId, "Session 标识");
    requireId(eventId, "来源事件标识");
    return this.transaction(async (q) => {
      const rows = await q.all<{ payload: string }>(
        "SELECT payload FROM outbox WHERE tenant_id=? AND event_id=? AND event_kind='task.source_changed'",
        [tenantId, eventId],
      );
      if (rows.length !== 1)
        throw new PlatformStorageError("not_found", "来源事件不存在。");
      const payload = JSON.parse(rows[0]!.payload);
      const event = taskSourceEventSchema.parse(payload.event);
      if (event.admission.sessionId !== sessionId || payload.discarded)
        throw new PlatformStorageError(
          "forbidden",
          "来源事件不属于这个 Session。",
        );
      const current = await q.all(
        "SELECT 1 FROM task_run_links l JOIN tasks t ON t.tenant_id=l.tenant_id AND t.task_id=l.task_id JOIN task_versions v ON v.tenant_id=t.tenant_id AND v.task_id=t.task_id AND v.revision=t.revision WHERE l.tenant_id=? AND l.task_id=? AND l.run_number=? AND v.run_requested=l.run_number AND t.project_id=? AND t.deleted_at IS NULL AND t.execution NOT IN ('completed','cancelled') AND l.bridge_stop_requested=0 AND l.bridge_source_stopped=0",
        [tenantId, event.taskId, event.runNumber, event.admission.projectId],
      );
      if (!current.length)
        throw new PlatformStorageError(
          "forbidden",
          "来源事项已停止、完成或改派。",
        );
      const admission = await this.taskRunAdmission(
        q,
        tenantId,
        event.admissionEventId,
      );
      if (JSON.stringify(admission) !== JSON.stringify(event.admission))
        throw new PlatformStorageError("conflict", "来源事件原准入已变化。");
      return {
        event,
        receipt: taskSourceReceiptSchema.nullable().parse(payload.receipt),
      };
    }, "read");
  }

  async taskRunSourceEvents(
    tenantId: string,
    taskId: string,
    runNumber: number,
    afterEventId?: string,
  ) {
    requireId(tenantId, "租户标识");
    requireId(taskId, "事项标识");
    if (!Number.isSafeInteger(runNumber) || runNumber < 1)
      throw new PlatformStorageError("invalid", "执行序号无效。");
    if (afterEventId !== undefined) requireId(afterEventId, "来源事件游标");
    return this.transaction(async (q) => {
      const rows = await q.all<{ payload: string }>(
        `SELECT o.payload FROM outbox o JOIN task_run_links l ON l.tenant_id=o.tenant_id AND l.task_id=o.aggregate_id AND l.task_revision=o.aggregate_revision WHERE o.tenant_id=? AND o.aggregate_kind='task' AND o.aggregate_id=? AND l.run_number=? AND o.event_kind='task.source_changed'${afterEventId ? " AND o.event_id>?" : ""} ORDER BY o.event_id LIMIT 100`,
        [tenantId, taskId, runNumber, ...(afterEventId ? [afterEventId] : [])],
      );
      return rows.map((row) => {
        const payload = JSON.parse(row.payload);
        const event = taskSourceEventSchema.parse(payload.event);
        if (event.runNumber !== runNumber)
          throw new PlatformStorageError("conflict", "来源事件执行归属损坏。");
        return {
          event,
          receipt: taskSourceReceiptSchema.nullable().parse(payload.receipt),
          discarded: payload.discarded === true,
          deliveryAttempted:
            z
              .array(z.string().uuid())
              .max(100)
              .parse(payload.deliveryAttempts ?? []).length > 0,
        };
      });
    }, "read");
  }

  /** Read-only provenance for the existing execution inspector. Unlike new
   * Agent work, completed/stopped runs remain readable by current project
   * readers. The event must belong to this exact original run, not merely a
   * model-supplied task ID or a shared Session. */
  async taskRunSourceEventForExecution(
    access: PlatformActor,
    taskId: string,
    projectId: string,
    ref: TaskRunLink["runtime"] & { projectId: string },
    eventId: string,
  ): Promise<{
    event: TaskSourceEvent;
    receipt: TaskSourceReceipt | null;
  } | null> {
    const actor = await this.authorize(access);
    requireId(taskId, "事项标识");
    requireId(projectId, "项目标识");
    requireId(eventId, "来源事件标识");
    return this.transaction(async (q) => {
      const task = (
        await q.all<{ project_id: string }>(
          "SELECT project_id FROM tasks WHERE tenant_id=? AND task_id=? AND deleted_at IS NULL",
          [actor.tenantId, taskId],
        )
      )[0];
      if (!task) throw new PlatformStorageError("not_found", "事项不存在。");
      await this.assertProjectReader(q, actor, task.project_id);
      const linked = (
        await q.all<{ project_id: string }>(
          "SELECT v.project_id FROM task_run_links l JOIN task_versions v ON v.tenant_id=l.tenant_id AND v.task_id=l.task_id AND v.revision=l.task_revision WHERE l.tenant_id=? AND l.task_id=? AND l.runtime_session_id=? AND l.runtime_schedule_id=? AND l.runtime_thread_id=?",
          [actor.tenantId, taskId, ref.sessionId, ref.scheduleId, ref.threadId],
        )
      )[0];
      if (!linked || linked.project_id !== ref.projectId)
        throw new PlatformStorageError("conflict", "执行引用与原准入不一致。");
      if (projectId !== task.project_id && projectId !== linked.project_id)
        throw new PlatformStorageError("forbidden", "执行不属于这个项目。");
      await this.assertProjectReader(q, actor, linked.project_id);
      const rows = await q.all<{
        payload: string;
        run_number: number | string;
        task_revision: number | string;
      }>(
        "SELECT o.payload,l.run_number,l.task_revision FROM outbox o JOIN task_run_links l ON l.tenant_id=o.tenant_id AND l.task_id=o.aggregate_id AND l.task_revision=o.aggregate_revision WHERE o.tenant_id=? AND o.aggregate_kind='task' AND o.aggregate_id=? AND o.event_id=? AND o.event_kind='task.source_changed' AND l.runtime_session_id=? AND l.runtime_schedule_id=? AND l.runtime_thread_id=?",
        [
          actor.tenantId,
          taskId,
          eventId,
          ref.sessionId,
          ref.scheduleId,
          ref.threadId,
        ],
      );
      if (!rows.length) return null;
      const payload = JSON.parse(rows[0]!.payload);
      if (payload.discarded === true) return null;
      const event = taskSourceEventSchema.parse(payload.event);
      const admission = await this.taskRunAdmission(
        q,
        actor.tenantId,
        event.admissionEventId,
      );
      if (
        event.tenantId !== actor.tenantId ||
        event.taskId !== taskId ||
        event.runNumber !== safeInteger(rows[0]!.run_number, "执行序号") ||
        event.admission.taskRevision !==
          safeInteger(rows[0]!.task_revision, "执行版本") ||
        event.admission.projectId !== ref.projectId ||
        event.admission.sessionId !== ref.sessionId ||
        event.admission.request.id !== ref.scheduleId ||
        JSON.stringify(event.admission) !== JSON.stringify(admission)
      )
        throw new PlatformStorageError(
          "conflict",
          "来源事件与原执行准入不一致。",
        );
      await this.assertProjectReader(q, actor, admission.projectId);
      return {
        event,
        receipt: taskSourceReceiptSchema.nullable().parse(payload.receipt),
      };
    }, "read");
  }

  async taskRunSourceExecutionEvents(
    access: PlatformActor,
    taskId: string,
    projectId: string,
    ref: TaskRunLink["runtime"] & { projectId: string },
    afterEventId?: string,
  ) {
    const current = await this.taskRunExecutionRef(
      access,
      taskId,
      projectId,
      ref.threadId,
    );
    if (
      current.sessionId !== ref.sessionId ||
      current.scheduleId !== ref.scheduleId ||
      current.projectId !== ref.projectId
    )
      throw new PlatformStorageError("conflict", "执行引用已变化。");
    const actor = await this.authorize(access);
    const runNumber = await this.transaction(async (q) => {
      const row = (
        await q.all<{ run_number: number | string }>(
          "SELECT run_number FROM task_run_links WHERE tenant_id=? AND task_id=? AND runtime_session_id=? AND runtime_schedule_id=? AND runtime_thread_id=?",
          [actor.tenantId, taskId, ref.sessionId, ref.scheduleId, ref.threadId],
        )
      )[0];
      if (!row) throw new PlatformStorageError("not_found", "执行记录不存在。");
      return safeInteger(row.run_number, "执行序号");
    }, "read");
    return this.taskRunSourceEvents(
      actor.tenantId,
      taskId,
      runNumber,
      afterEventId,
    );
  }

  async confirmTaskSourceEvent(
    tenantId: string,
    event: TaskSourceEvent,
    receipt: TaskSourceReceipt,
  ) {
    receipt = taskSourceReceiptSchema.parse(receipt);
    if (
      (event.destination.kind === "thread" &&
        (receipt.rootId !== `client-schedule-${event.admission.request.id}` ||
          receipt.threadId !== event.destination.threadId)) ||
      (event.destination.kind === "follow-up" &&
        receipt.rootId !== receipt.eventId)
    )
      throw new PlatformStorageError("conflict", "来源回执执行归属不一致。");
    return this.transaction(async (q) => {
      if (
        !(
          await q.all(
            `SELECT 1 FROM task_run_links WHERE tenant_id=? AND task_id=? AND run_number=?${this.backend.kind === "postgres" ? " FOR UPDATE" : ""}`,
            [tenantId, event.taskId, event.runNumber],
          )
        ).length
      )
        throw new PlatformStorageError("conflict", "来源执行关联不存在。");
      const rows = await q.all<{
        payload: string;
        delivered_at: string | null;
      }>(
        `SELECT payload,delivered_at FROM outbox WHERE tenant_id=? AND event_id=? AND event_kind='task.source_changed'${this.backend.kind === "postgres" ? " FOR UPDATE" : ""}`,
        [tenantId, event.eventId],
      );
      if (
        rows.length !== 1 ||
        JSON.stringify(JSON.parse(rows[0]!.payload).event) !==
          JSON.stringify(event)
      )
        throw new PlatformStorageError(
          "conflict",
          "来源回执与冻结事件不一致。",
        );
      const payload = JSON.parse(rows[0]!.payload);
      if (rows[0]!.delivered_at) {
        if (JSON.stringify(payload.receipt) !== JSON.stringify(receipt))
          throw new PlatformStorageError("conflict", "来源事件已有另一回执。");
        return;
      }
      await q.change(
        "UPDATE outbox SET payload=?,delivered_at=? WHERE tenant_id=? AND event_id=? AND delivered_at IS NULL",
        [
          JSON.stringify({ ...payload, receipt }),
          new Date().toISOString(),
          tenantId,
          event.eventId,
        ],
      );
      await q.change(
        "UPDATE task_run_links SET source_signature=? WHERE tenant_id=? AND task_id=? AND run_number=? AND source_signature=?",
        [
          event.sourceSignature,
          tenantId,
          event.taskId,
          event.runNumber,
          event.previousSignature,
        ],
      );
      const maximum = (
        await q.all<{ ordinal: number | string | null }>(
          "SELECT MAX(ordinal) AS ordinal FROM task_run_source_events WHERE tenant_id=? AND task_id=? AND run_number=?",
          [tenantId, event.taskId, event.runNumber],
        )
      )[0]!.ordinal;
      let ordinal =
        maximum === null ? 0 : safeInteger(maximum, "来源事件顺序") + 1;
      for (const commandId of event.sourceCommandIds) {
        if (
          !(
            await q.all(
              "SELECT 1 FROM task_run_source_events WHERE tenant_id=? AND task_id=? AND run_number=? AND command_id=?",
              [tenantId, event.taskId, event.runNumber, commandId],
            )
          ).length
        )
          await q.change(
            "INSERT INTO task_run_source_events(tenant_id,task_id,run_number,ordinal,command_id) VALUES(?,?,?,?,?)",
            [tenantId, event.taskId, event.runNumber, ordinal++, commandId],
          );
      }
    });
  }

  /** Only after Runtime proved this stable ID was never accepted. */
  async discardUnacceptedTaskSourceEvent(
    tenantId: string,
    event: TaskSourceEvent,
  ) {
    await this.transaction(async (q) => {
      const rows = await q.all<{ payload: string }>(
        `SELECT payload FROM outbox WHERE tenant_id=? AND event_id=? AND event_kind='task.source_changed' AND delivered_at IS NULL${this.backend.kind === "postgres" ? " FOR UPDATE" : ""}`,
        [tenantId, event.eventId],
      );
      if (!rows.length) return;
      const payload = JSON.parse(rows[0]!.payload);
      if (
        payload.receipt ||
        z
          .array(z.string().uuid())
          .max(100)
          .parse(payload.deliveryAttempts ?? []).length
      )
        throw new PlatformStorageError(
          "conflict",
          "来源投递尚未核对，不能丢弃或确认停止。",
        );
      if (JSON.stringify(payload.event) !== JSON.stringify(event))
        throw new PlatformStorageError(
          "conflict",
          "来源事件与冻结请求不一致。",
        );
      await q.change(
        "UPDATE outbox SET payload=?,delivered_at=? WHERE tenant_id=? AND event_id=? AND delivered_at IS NULL",
        [
          JSON.stringify({ ...payload, discarded: true }),
          new Date().toISOString(),
          tenantId,
          event.eventId,
        ],
      );
    });
  }

  /** Resolve one task's run history for a trusted Host. Runtime remains the
   * authority for current Schedule/Thread state; these observations cannot
   * authorize a new run, retry or control action. */
  async listTaskRunLinks(
    access: PlatformActor,
    taskId: string,
    options: { limit?: number; beforeRun?: number } = {},
  ): Promise<TaskRunLink[]> {
    const actor = await this.authorize(access);
    requireId(taskId, "事项标识");
    const limit = options.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new PlatformStorageError("invalid", "分页大小无效。");
    if (
      options.beforeRun !== undefined &&
      (!Number.isSafeInteger(options.beforeRun) || options.beforeRun < 1)
    )
      throw new PlatformStorageError("invalid", "执行游标无效。");
    return this.transaction(async (q) => {
      const task = (
        await q.all<{ project_id: string }>(
          "SELECT project_id FROM tasks WHERE tenant_id=? AND task_id=? AND deleted_at IS NULL",
          [actor.tenantId, taskId],
        )
      )[0];
      if (!task) throw new PlatformStorageError("not_found", "事项不存在。");
      await this.assertProjectReader(q, actor, task.project_id);
      const rows = await q.all<TaskRunLinkRow>(
        `SELECT task_id,run_number,task_revision,sequence,runtime_session_id,runtime_schedule_id,runtime_thread_id,request_intent,request_model_alias,request_reasoning_effort,request_not_before,request_interval_seconds,observed_schedule_revision,observed_schedule_status,observed_schedule_not_before,observed_schedule_interval_seconds,observed_thread_status,source_signature,bridge_paused,bridge_source_stopped,bridge_stop_requested,bridge_control_revision,bridge_control_pending,bridge_error FROM task_run_links WHERE tenant_id=? AND task_id=?${options.beforeRun === undefined ? "" : " AND run_number<?"} ORDER BY run_number DESC LIMIT ?`,
        [
          actor.tenantId,
          taskId,
          ...(options.beforeRun === undefined ? [] : [options.beforeRun]),
          limit,
        ],
      );
      if (!rows.length) return [];
      const numbers = rows.map((row) =>
        safeInteger(row.run_number, "事项执行序号"),
      );
      const placeholders = numbers.map(() => "?").join(",");
      const references = async (
        table:
          | "task_run_dependencies"
          | "task_run_watch_sources"
          | "task_run_source_events",
        column: "runtime_thread_id" | "source_object_id" | "command_id",
      ) => {
        const refs = await q.all<{
          run_number: number | string;
          ordinal: number | string;
          value: string;
        }>(
          `SELECT run_number,ordinal,${column} AS value FROM ${table} WHERE tenant_id=? AND task_id=? AND run_number IN (${placeholders}) ORDER BY run_number DESC,ordinal`,
          [actor.tenantId, taskId, ...numbers],
        );
        const grouped = new Map<number, string[]>();
        for (const ref of refs) {
          const runNumber = safeInteger(ref.run_number, "事项执行序号");
          const values = grouped.get(runNumber) ?? [];
          if (safeInteger(ref.ordinal, "引用顺序") !== values.length)
            throw new Error("事项执行引用顺序损坏。");
          values.push(ref.value);
          grouped.set(runNumber, values);
        }
        return grouped;
      };
      // All three reads share one transaction connection. Querying it
      // concurrently is unsupported by newer PostgreSQL drivers.
      const dependencies = await references(
        "task_run_dependencies",
        "runtime_thread_id",
      );
      const watched = await references(
        "task_run_watch_sources",
        "source_object_id",
      );
      const events = await references("task_run_source_events", "command_id");
      return rows.map((row) => {
        const runNumber = safeInteger(row.run_number, "事项执行序号");
        return {
          taskId: row.task_id,
          runNumber,
          taskRevision: safeInteger(row.task_revision, "事项版本"),
          sequence: safeInteger(row.sequence, "执行顺序"),
          runtime: {
            sessionId: row.runtime_session_id,
            scheduleId: row.runtime_schedule_id,
            threadId: row.runtime_thread_id,
          },
          request: {
            intent: row.request_intent,
            modelAlias: row.request_model_alias,
            reasoningEffort: row.request_reasoning_effort,
            notBefore: row.request_not_before,
            intervalSeconds: nullableSafeInteger(
              row.request_interval_seconds,
              "周期秒数",
            ),
            dependencyThreadIds: dependencies.get(runNumber) ?? [],
          },
          observed: {
            scheduleRevision: safeInteger(
              row.observed_schedule_revision,
              "已观察安排版本",
            ),
            scheduleStatus: row.observed_schedule_status,
            scheduleNotBefore: row.observed_schedule_not_before,
            scheduleIntervalSeconds: nullableSafeInteger(
              row.observed_schedule_interval_seconds,
              "已观察周期秒数",
            ),
            threadStatus: row.observed_thread_status,
          },
          bridge: {
            sourceSignature: row.source_signature,
            watchSourceIds: watched.get(runNumber) ?? [],
            sourceCommandIds: events.get(runNumber) ?? [],
            paused: row.bridge_paused === 1 || row.bridge_paused === "1",
            sourceStopped:
              row.bridge_source_stopped === 1 ||
              row.bridge_source_stopped === "1",
            stopRequested:
              row.bridge_stop_requested === 1 ||
              row.bridge_stop_requested === "1",
            controlRevision: safeInteger(
              row.bridge_control_revision,
              "执行控制版本",
            ),
            controlPending: row.bridge_control_pending,
            error: row.bridge_error,
          },
        };
      });
    }, "read");
  }

  /** Only an exact, authorized Runtime reference leaves Platform for a live
   * status read. The persisted observation is deliberately not returned here. */
  async taskRunRuntimeRef(
    access: PlatformActor,
    taskId: string,
    runNumber: number,
  ): Promise<TaskRunLink["runtime"]> {
    const actor = await this.authorize(access);
    requireId(taskId, "事项标识");
    if (!Number.isSafeInteger(runNumber) || runNumber < 1)
      throw new PlatformStorageError("invalid", "执行序号无效。");
    return this.transaction(async (q) => {
      const task = (
        await q.all<{ project_id: string }>(
          "SELECT project_id FROM tasks WHERE tenant_id=? AND task_id=? AND deleted_at IS NULL",
          [actor.tenantId, taskId],
        )
      )[0];
      if (!task) throw new PlatformStorageError("not_found", "事项不存在。");
      await this.assertProjectReader(q, actor, task.project_id);
      const link = (
        await q.all<{
          runtime_session_id: string;
          runtime_schedule_id: string;
          runtime_thread_id: string;
        }>(
          "SELECT runtime_session_id,runtime_schedule_id,runtime_thread_id FROM task_run_links WHERE tenant_id=? AND task_id=? AND run_number=?",
          [actor.tenantId, taskId, runNumber],
        )
      )[0];
      if (!link)
        throw new PlatformStorageError("not_found", "事项执行记录不存在。");
      return {
        sessionId: link.runtime_session_id,
        scheduleId: link.runtime_schedule_id,
        threadId: link.runtime_thread_id,
      };
    }, "read");
  }

  /** Resolve an execution panel's Thread through the exact Platform link.
   * The Client's project and Thread IDs are selectors, never authority. */
  async taskRunExecutionRef(
    access: PlatformActor,
    taskId: string,
    projectId: string,
    threadId: string,
  ): Promise<TaskRunLink["runtime"] & { projectId: string }> {
    const actor = await this.authorize(access);
    requireId(taskId, "事项标识");
    requireId(projectId, "项目标识");
    requireId(threadId, "执行分支标识");
    return this.transaction(async (q) => {
      const task = (
        await q.all<{ project_id: string }>(
          "SELECT project_id FROM tasks WHERE tenant_id=? AND task_id=? AND deleted_at IS NULL",
          [actor.tenantId, taskId],
        )
      )[0];
      if (!task) throw new PlatformStorageError("not_found", "事项不存在。");
      await this.assertProjectReader(q, actor, task.project_id);
      const link = (
        await q.all<{
          project_id: string;
          runtime_session_id: string;
          runtime_schedule_id: string;
          runtime_thread_id: string;
        }>(
          "SELECT v.project_id,l.runtime_session_id,l.runtime_schedule_id,l.runtime_thread_id FROM task_run_links l JOIN task_versions v ON v.tenant_id=l.tenant_id AND v.task_id=l.task_id AND v.revision=l.task_revision WHERE l.tenant_id=? AND l.task_id=? AND l.runtime_thread_id=?",
          [actor.tenantId, taskId, threadId],
        )
      )[0];
      if (!link)
        throw new PlatformStorageError("not_found", "执行记录不存在。");
      if (projectId !== task.project_id && projectId !== link.project_id)
        throw new PlatformStorageError("forbidden", "执行不属于这个项目。");
      await this.assertProjectReader(q, actor, link.project_id);
      return {
        projectId: link.project_id,
        sessionId: link.runtime_session_id,
        scheduleId: link.runtime_schedule_id,
        threadId: link.runtime_thread_id,
      };
    }, "read");
  }

  /** A stop request is durable before the Runtime side effect. Repeated
   * requests while stopping are safe; stale controls cannot target a new run. */
  async requestTaskRunControl(
    access: PlatformActor,
    taskId: string,
    runNumber: number,
    expectedControlRevision: number,
    action: "stop" | "pause" | "resume",
  ): Promise<void> {
    const actor = await this.authorize(access);
    if (actor.kind === "provider")
      throw new PlatformStorageError(
        "forbidden",
        "资源提供方不能控制事项执行。",
      );
    requireId(taskId, "事项标识");
    if (
      !Number.isSafeInteger(runNumber) ||
      runNumber < 1 ||
      !Number.isSafeInteger(expectedControlRevision) ||
      expectedControlRevision < 1
    )
      throw new PlatformStorageError("invalid", "执行控制版本无效。");
    await this.transaction(async (q) => {
      const task = (
        await q.all<{ project_id: string; revision: number | string }>(
          `SELECT project_id,revision FROM tasks WHERE tenant_id=? AND task_id=? AND deleted_at IS NULL${this.backend.kind === "postgres" ? " FOR UPDATE" : ""}`,
          [actor.tenantId, taskId],
        )
      )[0];
      if (!task) throw new PlatformStorageError("not_found", "事项不存在。");
      await this.assertMember(q, actor, task.project_id);
      const current = await this.loadTaskVersion(
        q,
        actor.tenantId,
        taskId,
        safeInteger(task.revision, "事项修订"),
      );
      if (!current || current.run_requested !== runNumber)
        throw new PlatformStorageError(
          "conflict",
          "执行已变化，请刷新后操作。",
        );
      const link = (
        await q.all<{
          runtime_schedule_id: string;
          bridge_stop_requested: number | string;
          bridge_source_stopped: number | string;
          bridge_control_pending: string | null;
          bridge_control_revision: number | string;
        }>(
          `SELECT runtime_schedule_id,bridge_stop_requested,bridge_source_stopped,bridge_control_pending,bridge_control_revision FROM task_run_links WHERE tenant_id=? AND task_id=? AND run_number=?${this.backend.kind === "postgres" ? " FOR UPDATE" : ""}`,
          [actor.tenantId, taskId, runNumber],
        )
      )[0];
      if (!link) {
        if (action !== "stop")
          throw new PlatformStorageError(
            "conflict",
            "执行安排尚未确认，请稍后重试。",
          );
        if (expectedControlRevision !== 1)
          throw new PlatformStorageError(
            "conflict",
            "执行控制已变化，请刷新后操作。",
          );
        const admissionEventId = `task_run_${fingerprint([
          actor.tenantId,
          taskId,
          runNumber,
        ]).slice(0, 40)}`;
        const stopEventId = `task_stop_${admissionEventId.slice("task_run_".length)}`;
        const withdrawn = await q.all(
          "SELECT 1 FROM outbox WHERE tenant_id=? AND event_id=? AND event_kind='task.run_withdrawn'",
          [actor.tenantId, stopEventId],
        );
        if (withdrawn.length) return;
        const admission = (
          await q.all<{
            event_id: string;
            aggregate_revision: number | string;
            delivered_at: string | null;
          }>(
            "SELECT event_id,aggregate_revision,delivered_at FROM outbox WHERE tenant_id=? AND event_id=? AND aggregate_kind='task' AND aggregate_id=? AND event_kind='task.run_requested'",
            [actor.tenantId, admissionEventId, taskId],
          )
        )[0];
        if (!admission || admission.delivered_at)
          throw new PlatformStorageError(
            "conflict",
            "执行安排状态已变化，请刷新后操作。",
          );
        const original = await this.requestedTaskRun(
          q,
          actor.tenantId,
          admission.event_id,
        );
        if (!(await this.preparedTaskRun(q, original))) {
          // No POST may precede preparation. This transaction locks the same
          // task row as the preparer, so local withdrawal cannot race delivery.
          const now = new Date().toISOString();
          await q.change(
            "UPDATE outbox SET delivered_at=? WHERE tenant_id=? AND event_id=? AND delivered_at IS NULL",
            [now, actor.tenantId, admission.event_id],
          );
          await q.change(
            "INSERT INTO outbox(tenant_id,event_id,aggregate_kind,aggregate_id,aggregate_revision,event_kind,payload,created_at,delivered_at) VALUES(?,?,'task',?,?,'task.run_withdrawn',?,?,?)",
            [
              actor.tenantId,
              stopEventId,
              taskId,
              original.taskRevision,
              JSON.stringify({ runNumber }),
              now,
              now,
            ],
          );
          const changed = await q.change(
            "UPDATE tasks SET execution='planned',revision=revision+1,updated_at=? WHERE tenant_id=? AND task_id=? AND revision=?",
            [now, actor.tenantId, taskId, current.revision],
          );
          if (changed !== 1)
            throw new PlatformStorageError(
              "conflict",
              "事项已变化，请刷新后操作。",
            );
          await this.insertTaskVersion(q, actor.tenantId, {
            ...current,
            revision: current.revision + 1,
            execution: "planned",
            author_principal_id: actor.principalId,
            author_actant_id: actor.actantId,
            created_at: now,
          });
          await this.advanceNavigation(q, actor.tenantId, ["tasks"]);
          return;
        }
        await q.change(
          "INSERT INTO outbox(tenant_id,event_id,aggregate_kind,aggregate_id,aggregate_revision,event_kind,payload,created_at) VALUES(?,?,'task',?,?,'task.run_stop_requested',?,?) ON CONFLICT(tenant_id,event_id) DO NOTHING",
          [
            actor.tenantId,
            stopEventId,
            taskId,
            safeInteger(admission.aggregate_revision, "事项执行修订"),
            JSON.stringify({ runNumber }),
            new Date().toISOString(),
          ],
        );
        return;
      }
      if (!/^task_[a-f0-9]{40}$/.test(link.runtime_schedule_id))
        throw new PlatformStorageError(
          "conflict",
          "执行安排没有可核对的 Platform 准入记录。",
        );
      if (action === "stop" && Number(link.bridge_stop_requested) === 1) return;
      if (Number(link.bridge_source_stopped) === 1)
        throw new PlatformStorageError("conflict", "这次执行已经停止。");
      if (action !== "stop" && link.bridge_control_pending === action) return;
      if (
        Number(link.bridge_stop_requested) === 1 ||
        link.bridge_control_pending
      )
        throw new PlatformStorageError(
          "conflict",
          "执行控制正在确认，请稍后重试。",
        );
      if (
        safeInteger(link.bridge_control_revision, "执行控制版本") !==
        expectedControlRevision
      )
        throw new PlatformStorageError(
          "conflict",
          "执行控制已变化，请刷新后操作。",
        );
      const changed =
        action === "stop"
          ? await q.change(
              "UPDATE task_run_links SET bridge_stop_requested=1,bridge_paused=1,bridge_control_revision=bridge_control_revision+1,bridge_error='正在停止执行。' WHERE tenant_id=? AND task_id=? AND run_number=? AND bridge_control_revision=? AND bridge_stop_requested=0",
              [actor.tenantId, taskId, runNumber, expectedControlRevision],
            )
          : await q.change(
              "UPDATE task_run_links SET bridge_control_pending=?,bridge_paused=?,bridge_control_revision=bridge_control_revision+1,bridge_error='正在确认执行控制。' WHERE tenant_id=? AND task_id=? AND run_number=? AND bridge_control_revision=? AND bridge_control_pending IS NULL AND bridge_stop_requested=0",
              [
                action,
                action === "pause" ? 1 : 0,
                actor.tenantId,
                taskId,
                runNumber,
                expectedControlRevision,
              ],
            );
      if (changed !== 1)
        throw new PlatformStorageError(
          "conflict",
          "执行控制已变化，请刷新后操作。",
        );
    });
  }

  requestTaskRunStop(
    access: PlatformActor,
    taskId: string,
    runNumber: number,
    expectedControlRevision: number,
  ) {
    return this.requestTaskRunControl(
      access,
      taskId,
      runNumber,
      expectedControlRevision,
      "stop",
    );
  }

  /** Pending-only presentation state; a confirmed run uses its link instead. */
  async taskRunPendingStop(
    access: PlatformActor,
    taskId: string,
  ): Promise<{
    runNumber: number;
    taskRevision: number;
  } | null> {
    const actor = await this.authorize(access);
    requireId(taskId, "事项标识");
    return this.transaction(async (q) => {
      const task = (
        await q.all<{ project_id: string; revision: number | string }>(
          "SELECT project_id,revision FROM tasks WHERE tenant_id=? AND task_id=? AND deleted_at IS NULL",
          [actor.tenantId, taskId],
        )
      )[0];
      if (!task) throw new PlatformStorageError("not_found", "事项不存在。");
      await this.assertProjectReader(q, actor, task.project_id);
      const taskRevision = safeInteger(task.revision, "事项修订");
      const current = await this.loadTaskVersion(
        q,
        actor.tenantId,
        taskId,
        taskRevision,
      );
      if (!current?.run_requested) return null;
      const stopEventId = `task_stop_${fingerprint([
        actor.tenantId,
        taskId,
        current.run_requested,
      ]).slice(0, 40)}`;
      const pending = (
        await q.all<{ aggregate_revision: number | string }>(
          "SELECT aggregate_revision FROM outbox WHERE tenant_id=? AND event_id=? AND aggregate_kind='task' AND aggregate_id=? AND event_kind='task.run_stop_requested' AND delivered_at IS NULL",
          [actor.tenantId, stopEventId, taskId],
        )
      )[0];
      return pending
        ? {
            runNumber: current.run_requested,
            taskRevision: safeInteger(
              pending.aggregate_revision,
              "事项执行修订",
            ),
          }
        : null;
    }, "read");
  }

  /** Host-only recovery source. The link itself is the durable stop intent. */
  async pendingTaskRunStops(
    tenantId: string,
    limit = 50,
    afterSequence?: number,
  ): Promise<PendingTaskRunStop[]> {
    requireId(tenantId, "租户标识");
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (afterSequence !== undefined &&
        (!Number.isSafeInteger(afterSequence) || afterSequence < 1))
    )
      throw new PlatformStorageError("invalid", "停止请求分页大小无效。");
    return this.transaction(async (q) => {
      const rows = await q.all<{
        task_id: string;
        run_number: number | string;
        sequence: number | string;
        bridge_control_revision: number | string;
        runtime_session_id: string;
        runtime_schedule_id: string;
        runtime_thread_id: string;
      }>(
        `SELECT task_id,run_number,sequence,bridge_control_revision,runtime_session_id,runtime_schedule_id,runtime_thread_id FROM task_run_links WHERE tenant_id=? AND bridge_stop_requested=1${afterSequence === undefined ? "" : " AND sequence>?"} ORDER BY sequence LIMIT ?`,
        [
          tenantId,
          ...(afterSequence === undefined ? [] : [afterSequence]),
          limit,
        ],
      );
      return rows.map((row) => ({
        taskId: row.task_id,
        runNumber: safeInteger(row.run_number, "执行序号"),
        sequence: safeInteger(row.sequence, "执行顺序"),
        controlRevision: safeInteger(
          row.bridge_control_revision,
          "执行控制版本",
        ),
        runtime: {
          sessionId: row.runtime_session_id,
          scheduleId: row.runtime_schedule_id,
          threadId: row.runtime_thread_id,
        },
      }));
    }, "read");
  }

  async pendingTaskRunScheduleControls(
    tenantId: string,
    limit = 50,
    afterSequence?: number,
  ): Promise<PendingTaskRunScheduleControl[]> {
    requireId(tenantId, "租户标识");
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (afterSequence !== undefined &&
        (!Number.isSafeInteger(afterSequence) || afterSequence < 1))
    )
      throw new PlatformStorageError("invalid", "控制请求分页大小无效。");
    return this.transaction(async (q) => {
      const rows = await q.all<{
        task_id: string;
        run_number: number | string;
        sequence: number | string;
        bridge_control_revision: number | string;
        bridge_control_pending: string;
        runtime_session_id: string;
        runtime_schedule_id: string;
        runtime_thread_id: string;
      }>(
        `SELECT task_id,run_number,sequence,bridge_control_revision,bridge_control_pending,runtime_session_id,runtime_schedule_id,runtime_thread_id FROM task_run_links WHERE tenant_id=? AND bridge_control_pending IS NOT NULL${afterSequence === undefined ? "" : " AND sequence>?"} ORDER BY sequence LIMIT ?`,
        [
          tenantId,
          ...(afterSequence === undefined ? [] : [afterSequence]),
          limit,
        ],
      );
      return rows.map((row) => {
        if (
          row.bridge_control_pending !== "pause" &&
          row.bridge_control_pending !== "resume"
        )
          throw new Error("不支持的执行控制待处理状态。");
        return {
          taskId: row.task_id,
          runNumber: safeInteger(row.run_number, "执行序号"),
          sequence: safeInteger(row.sequence, "执行顺序"),
          controlRevision: safeInteger(
            row.bridge_control_revision,
            "执行控制版本",
          ),
          action: row.bridge_control_pending,
          runtime: {
            sessionId: row.runtime_session_id,
            scheduleId: row.runtime_schedule_id,
            threadId: row.runtime_thread_id,
          },
        };
      });
    }, "read");
  }

  async confirmTaskRunScheduleControl(
    tenantId: string,
    request: PendingTaskRunScheduleControl,
    observed: TaskRunStopObservation,
    error = "",
  ): Promise<void> {
    requireId(tenantId, "租户标识");
    const sourceOnly =
      observed.schedule.intervalSeconds === null &&
      ["dispatched", "completed"].includes(observed.schedule.status);
    if (
      observed.source !== "runtime" ||
      JSON.stringify(observed.runtime) !== JSON.stringify(request.runtime) ||
      (request.action === "pause" &&
        !error &&
        observed.schedule.status !== "paused" &&
        !sourceOnly) ||
      (request.action === "resume" &&
        !error &&
        observed.schedule.status !== "queued" &&
        !sourceOnly)
    )
      throw new PlatformStorageError("conflict", "Runtime 尚未确认执行控制。");
    await this.transaction(async (q) => {
      if (
        sourceOnly &&
        !(
          await q.all(
            "SELECT 1 FROM task_run_watch_sources WHERE tenant_id=? AND task_id=? AND run_number=? LIMIT 1",
            [tenantId, request.taskId, request.runNumber],
          )
        ).length
      )
        throw new PlatformStorageError(
          "conflict",
          "已结束安排没有可控制的来源关注。",
        );
      const changed = await q.change(
        "UPDATE task_run_links SET bridge_control_pending=NULL,bridge_paused=?,bridge_control_revision=bridge_control_revision+1,bridge_error=?,observed_schedule_revision=?,observed_schedule_status=?,observed_schedule_not_before=?,observed_schedule_interval_seconds=?,observed_thread_status=? WHERE tenant_id=? AND task_id=? AND run_number=? AND bridge_control_revision=? AND bridge_control_pending=? AND bridge_stop_requested=0 AND runtime_session_id=? AND runtime_schedule_id=? AND runtime_thread_id=?",
        [
          sourceOnly
            ? request.action === "pause"
              ? 1
              : 0
            : observed.schedule.status === "paused"
              ? 1
              : 0,
          error,
          observed.schedule.revision,
          observed.schedule.status,
          observed.schedule.notBefore,
          observed.schedule.intervalSeconds,
          observed.thread.lifecycle,
          tenantId,
          request.taskId,
          request.runNumber,
          request.controlRevision,
          request.action,
          request.runtime.sessionId,
          request.runtime.scheduleId,
          request.runtime.threadId,
        ],
      );
      if (changed !== 1)
        throw new PlatformStorageError(
          "conflict",
          "执行控制已变化，请刷新后操作。",
        );
    });
  }

  /** A stale worker can only confirm the exact Runtime link and stop revision. */
  async confirmTaskRunStop(
    tenantId: string,
    request: PendingTaskRunStop,
    observed: TaskRunStopObservation,
  ): Promise<void> {
    requireId(tenantId, "租户标识");
    if (
      observed.source !== "runtime" ||
      JSON.stringify(observed.runtime) !== JSON.stringify(request.runtime) ||
      observed.thread.lifecycle === "open" ||
      ["queued", "paused"].includes(observed.schedule.status) ||
      (observed.schedule.status === "dispatched" &&
        observed.schedule.intervalSeconds !== null)
    )
      throw new PlatformStorageError(
        "conflict",
        "Runtime 尚未确认执行已停止。",
      );
    await this.transaction(async (q) => {
      const changed = await q.change(
        "UPDATE task_run_links SET bridge_stop_requested=0,bridge_source_stopped=1,bridge_paused=1,bridge_control_revision=bridge_control_revision+1,bridge_error='',observed_schedule_revision=?,observed_schedule_status=?,observed_schedule_not_before=?,observed_schedule_interval_seconds=?,observed_thread_status=? WHERE tenant_id=? AND task_id=? AND run_number=? AND bridge_control_revision=? AND bridge_stop_requested=1 AND runtime_session_id=? AND runtime_schedule_id=? AND runtime_thread_id=?",
        [
          observed.schedule.revision,
          observed.schedule.status,
          observed.schedule.notBefore,
          observed.schedule.intervalSeconds,
          observed.thread.lifecycle,
          tenantId,
          request.taskId,
          request.runNumber,
          request.controlRevision,
          request.runtime.sessionId,
          request.runtime.scheduleId,
          request.runtime.threadId,
        ],
      );
      if (changed !== 1)
        throw new PlatformStorageError(
          "conflict",
          "执行控制已变化，请刷新后操作。",
        );
    });
  }

  private async replay(
    q: Query,
    actor: ResolvedActor,
    commandId: string,
    hash: string,
  ): Promise<string | null> {
    // Concurrent PostgreSQL retries must serialize before either checks the
    // receipt. SQLite already serializes writers with BEGIN IMMEDIATE.
    if (this.backend.kind === "postgres")
      await q.all(
        "SELECT pg_advisory_xact_lock(hashtextextended(?, 0)) AS locked",
        [`${actor.tenantId}:${commandId}`],
      );
    const row = (
      await q.all<{ request_hash: string; result_ref: string }>(
        "SELECT request_hash,result_ref FROM command_receipts WHERE tenant_id=? AND command_id=?",
        [actor.tenantId, commandId],
      )
    )[0];
    if (!row) return null;
    if (row.request_hash !== hash)
      throw new PlatformStorageError(
        "conflict",
        "这个操作标识已经用于另一项请求。",
      );
    return row.result_ref;
  }

  /** Check a committed result before consulting an external authority again. */
  private async priorReceipt(
    actor: ResolvedActor,
    commandId: string,
    hash: string,
  ): Promise<string | null> {
    return this.transaction(async (q) => {
      const row = (
        await q.all<{ request_hash: string; result_ref: string }>(
          "SELECT request_hash,result_ref FROM command_receipts WHERE tenant_id=? AND command_id=?",
          [actor.tenantId, commandId],
        )
      )[0];
      if (!row) return null;
      if (row.request_hash !== hash)
        throw new PlatformStorageError(
          "conflict",
          "这个操作标识已经用于另一项请求。",
        );
      return row.result_ref;
    }, "read");
  }

  private async receipt(
    q: Query,
    actor: ResolvedActor,
    commandId: string,
    hash: string,
    operation: string,
    resultRef: string,
    now: string,
    runtimeInputId = actor.runtimeInputId,
    bumpNavigation = true,
  ) {
    await q.change(
      "INSERT INTO command_receipts(tenant_id,command_id,request_hash,actor_principal_id,actor_actant_id,runtime_input_id,operation,result_ref,committed_at) VALUES(?,?,?,?,?,?,?,?,?)",
      [
        actor.tenantId,
        commandId,
        hash,
        actor.principalId,
        actor.actantId,
        runtimeInputId,
        operation,
        resultRef,
        now,
      ],
    );
    if (!bumpNavigation) return;
    await this.advanceNavigation(
      q,
      actor.tenantId,
      this.navigationEffects(operation),
    );
  }

  /** Enumerate business effects, not event-name prefixes or outbox delivery.
   * The list is coupled to the committed write, so replay and rollback cannot
   * create a new invalidation revision. Runtime observations are independent. */
  private navigationEffects(operation: string): (keyof NavigationRevisions)[] {
    switch (operation) {
      case "create-project":
      case "create-project-for-content":
        return ["projects", "conversations"];
      case "rename-project":
        return ["projects"];
      case "change-project-state":
        return ["projects", "conversations", "tasks", "access"];
      case "start-conversation":
      case "update-conversation":
        return ["conversations"];
      case "create-task":
      case "revise-task":
      case "respond-task":
      case "set-task-completed":
      case "reorder-task":
      case "reorder-task-selection":
      case "request-task-run":
        return ["tasks"];
      case "record-content":
      case "refresh-content":
      case "move-content":
      case "link-work":
      case "publish-project-understanding":
      case "notifications-settings":
      case "notifications-read":
      case "install-ui-package":
      case "update-application-route":
        return [];
      default:
        throw new Error(`Platform 导航修订未定义操作影响：${operation}`);
    }
  }

  private async advanceNavigation(
    q: Query,
    tenantId: string,
    effects: readonly (keyof NavigationRevisions)[],
  ) {
    const columns = {
      projects: "projects_revision",
      conversations: "conversations_revision",
      tasks: "tasks_revision",
      access: "access_revision",
    } as const;
    const assignments = [
      "revision=revision+1",
      ...[...new Set(effects)].map(
        (effect) => `${columns[effect]}=${columns[effect]}+1`,
      ),
    ];
    const changed = await q.change(
      `UPDATE navigation_heads SET ${assignments.join(",")} WHERE tenant_id=?`,
      [tenantId],
    );
    if (changed !== 1)
      throw new PlatformStorageError(
        "conflict",
        "租户目录修订缺失，操作未提交。",
      );
  }

  /** A personal conversation may address another project only when it has
   * exactly the same live audience. A project-scoped input and a scheduled
   * task remain confined to their original project. Both memberships are
   * checked again by the caller for the requested read or write. */
  private async assertAgentInputScope(
    q: Query,
    actor: ResolvedActor,
    projectId: string,
    forWrite: boolean,
    executor?: PreparedExecutor,
  ) {
    if (
      actor.kind !== "agent" ||
      actor.scopeProjectId === undefined ||
      actor.scopeProjectId === projectId
    )
      return;
    const denied = () =>
      new PlatformStorageError(
        "forbidden",
        "Agent 操作超出原始输入的项目范围。",
      );
    if (actor.runtimeTaskRun) throw denied();
    const source = (
      await q.all<{
        kind: string;
        archived_at: string | null;
        deleted_at: string | null;
      }>(
        "SELECT kind,archived_at,deleted_at FROM projects WHERE tenant_id=? AND project_id=?",
        [actor.tenantId, actor.scopeProjectId],
      )
    )[0];
    if (
      !source ||
      !["desk", "inbox", "dialogue"].includes(source.kind) ||
      source.archived_at ||
      source.deleted_at
    )
      throw denied();
    if (forWrite)
      await this.lockProjectAudiences(q, actor.tenantId, [
        actor.scopeProjectId,
        projectId,
      ]);
    await this.assertProjectReader(q, actor, actor.scopeProjectId, executor);
    const audience = async (id: string) =>
      (
        await q.all<{ principal_id: string }>(
          "SELECT principal_id FROM project_members WHERE tenant_id=? AND project_id=? ORDER BY principal_id",
          [actor.tenantId, id],
        )
      ).map((row) => row.principal_id);
    const sourceMembers = await audience(actor.scopeProjectId);
    const targetMembers = await audience(projectId);
    if (JSON.stringify(sourceMembers) !== JSON.stringify(targetMembers))
      throw denied();
  }

  private async assertMember(
    q: Query,
    actor: ResolvedActor,
    projectId: string,
    forWrite = true,
    enforceInputScope = true,
    executor?: PreparedExecutor,
  ) {
    if (enforceInputScope)
      await this.assertAgentInputScope(q, actor, projectId, forWrite, executor);
    // A write must hold the project and membership rows until commit. A
    // concurrent archive or revocation must serialize after this command,
    // not slip between authorization and its business mutation. SQLite's
    // BEGIN IMMEDIATE provides the corresponding writer exclusion.
    const rows = await q.all(
      `SELECT 1 AS allowed FROM project_members m JOIN projects p ON p.tenant_id=m.tenant_id AND p.project_id=m.project_id WHERE m.tenant_id=? AND m.project_id=? AND m.principal_id=? AND p.deleted_at IS NULL AND p.archived_at IS NULL${forWrite && this.backend.kind === "postgres" ? " FOR SHARE OF m,p" : ""}`,
      [actor.tenantId, projectId, actor.principalId],
    );
    if (!rows.length)
      throw new PlatformStorageError("forbidden", "无权访问这个项目。");
    if (forWrite) await this.assertProjectNotRetiring(q, actor, projectId);
    await this.assertAgentExecutorMember(
      q,
      actor,
      projectId,
      forWrite,
      executor,
    );
  }

  private async assertProjectNotRetiring(
    q: Query,
    actor: ResolvedActor,
    projectId: string,
  ) {
    const rows = await q.all(
      "SELECT 1 AS pending FROM project_retirements WHERE tenant_id=? AND project_id=?",
      [actor.tenantId, projectId],
    );
    if (rows.length)
      throw new PlatformStorageError(
        "conflict",
        "项目正在归档或删除，暂不能继续写入。",
      );
  }

  /** Audience equality must not race a member insert or revocation. Lock
   * parent rows in stable order before reading either membership set; FK
   * checks on membership writes then wait for this transaction to finish. */
  private async lockProjectAudiences(
    q: Query,
    tenantId: string,
    projectIds: string[],
  ) {
    if (this.backend.kind !== "postgres") return;
    for (const projectId of [...new Set(projectIds)].sort()) {
      const rows = await q.all(
        "SELECT project_id FROM projects WHERE tenant_id=? AND project_id=? FOR UPDATE",
        [tenantId, projectId],
      );
      if (!rows.length)
        throw new PlatformStorageError("not_found", "目标项目不存在。");
    }
  }

  private async assertAgentExecutorMember(
    q: Query,
    actor: ResolvedActor,
    projectId: string,
    forWrite = false,
    preparedExecutor?: PreparedExecutor,
  ) {
    if (actor.kind !== "agent") return;
    if (
      preparedExecutor &&
      (preparedExecutor.tenantId !== actor.tenantId ||
        preparedExecutor.actantId !== actor.actantId)
    )
      throw new PlatformStorageError(
        "forbidden",
        "预检 Agent 身份与当前操作不符。",
      );
    const executor =
      preparedExecutor ??
      (await this.capabilities.resolveActant({
        tenantId: actor.tenantId,
        actantId: actor.actantId,
      }));
    if (!executor || executor.kind !== "agent")
      throw new PlatformStorageError("forbidden", "Agent 执行身份已失效。");
    const membership = await q.all(
      `SELECT 1 AS allowed FROM project_members WHERE tenant_id=? AND project_id=? AND principal_id=?${forWrite && this.backend.kind === "postgres" ? " FOR SHARE" : ""}`,
      [actor.tenantId, projectId, executor.principalId],
    );
    if (!membership.length)
      throw new PlatformStorageError(
        "forbidden",
        "Agent 已不在原始输入所属项目中。",
      );
  }

  /** Retired projects remain visible to members for recovery, but never
   * satisfy assertMember's active-work authorization. */
  private async assertProjectReader(
    q: Query,
    actor: ResolvedActor,
    projectId: string,
    executor?: PreparedExecutor,
  ) {
    await this.assertAgentInputScope(q, actor, projectId, false, executor);
    const membership = await q.all(
      "SELECT 1 AS allowed FROM project_members WHERE tenant_id=? AND project_id=? AND principal_id=?",
      [actor.tenantId, projectId, actor.principalId],
    );
    if (!membership.length)
      throw new PlatformStorageError("forbidden", "无权访问这个项目。");
    await this.assertAgentExecutorMember(q, actor, projectId, false, executor);
  }

  /** Before the first input is committed, only the project and recipient can
   * be checked. The Runtime outbox holds the input but must not dispatch it
   * until startConversation has committed the matching receipt.
   */
  async authorizeConversationStart(
    access: PlatformActor,
    request: {
      projectId: string;
      conversationId: string;
      targetActantId: string;
      firstInputId: string;
    },
  ): Promise<{ sharedDefault: false }> {
    const actor = await this.authorize(access);
    if (actor.kind !== "human")
      throw new PlatformStorageError("forbidden", "只有用户可以开始项目对话。");
    for (const value of [
      request.projectId,
      request.conversationId,
      request.targetActantId,
      request.firstInputId,
    ])
      requireId(value, "对话标识");
    if (request.conversationId === request.projectId)
      throw new PlatformStorageError("invalid", "新对话需要独立标识。");
    const target = await this.capabilities.resolveActant({
      tenantId: actor.tenantId,
      actantId: request.targetActantId,
    });
    if (!target)
      throw new PlatformStorageError("forbidden", "接收者身份已失效。");
    return this.transaction(async (q) => {
      await this.assertMember(q, actor, request.projectId, false);
      await this.assertProjectNotRetiring(q, actor, request.projectId);
      const project = (
        await q.all<{ kind: string }>(
          "SELECT kind FROM projects WHERE tenant_id=? AND project_id=?",
          [actor.tenantId, request.projectId],
        )
      )[0];
      if (project?.kind !== "project")
        throw new PlatformStorageError(
          "forbidden",
          "只能在项目内开始命名对话。",
        );
      const membership = await q.all(
        "SELECT 1 AS allowed FROM project_members WHERE tenant_id=? AND project_id=? AND principal_id=?",
        [actor.tenantId, request.projectId, target.principalId],
      );
      if (!membership.length)
        throw new PlatformStorageError("forbidden", "接收者不在项目范围内。");
      const existing = (
        await q.all<{ project_id: string; kind: string }>(
          "SELECT project_id,kind FROM conversations WHERE tenant_id=? AND conversation_id=?",
          [actor.tenantId, request.conversationId],
        )
      )[0];
      if (existing) {
        const receipt = (
          await q.all<{
            operation: string;
            result_ref: string;
            runtime_input_id: string | null;
            actor_principal_id: string;
            actor_actant_id: string;
          }>(
            "SELECT operation,result_ref,runtime_input_id,actor_principal_id,actor_actant_id FROM command_receipts WHERE tenant_id=? AND command_id=?",
            [actor.tenantId, request.firstInputId],
          )
        )[0];
        if (
          existing.project_id !== request.projectId ||
          existing.kind !== "named" ||
          receipt?.operation !== "start-conversation" ||
          receipt.result_ref !== request.conversationId ||
          receipt.runtime_input_id !== request.firstInputId ||
          receipt.actor_principal_id !== actor.principalId ||
          receipt.actor_actant_id !== actor.actantId
        )
          throw new PlatformStorageError("conflict", "对话标识已经被使用。");
      }
      return { sharedDefault: false as const };
    }, "read");
  }

  /** Authorize the work scope and conversation route of a Human input. The
   * Runtime owns the message itself; Platform never stores its body. Recheck
   * this route immediately before a queued message is sent to Runtime.
   */
  async authorizeMessageRoute(
    access: PlatformActor,
    request: {
      projectId: string;
      conversationId: string;
      targetActantId: string;
      firstInputId?: string;
    },
  ): Promise<{ sharedDefault: boolean }> {
    const actor = await this.authorize(access);
    if (actor.kind !== "human")
      throw new PlatformStorageError("forbidden", "只有用户可以发送这条消息。");
    requireId(request.projectId, "项目标识");
    requireId(request.conversationId, "对话标识");
    requireId(request.targetActantId, "接收者标识");
    const target = await this.capabilities.resolveActant({
      tenantId: actor.tenantId,
      actantId: request.targetActantId,
    });
    if (!target)
      throw new PlatformStorageError("forbidden", "接收者身份已失效。");
    return this.transaction(async (q) => {
      await this.assertMember(q, actor, request.projectId, false);
      await this.assertProjectNotRetiring(q, actor, request.projectId);
      const rows = await q.all<{
        project_id: string;
        kind: string;
        conversation_kind: string;
        owner_principal_id: string;
        archived_at: string | null;
        deleted_at: string | null;
      }>(
        "SELECT c.project_id,c.kind AS conversation_kind,p.kind,p.owner_principal_id,c.archived_at,p.deleted_at FROM conversations c JOIN projects p ON p.tenant_id=c.tenant_id AND p.project_id=c.project_id WHERE c.tenant_id=? AND c.conversation_id=?",
        [actor.tenantId, request.conversationId],
      );
      const conversation = rows[0];
      if (
        !conversation ||
        conversation.archived_at !== null ||
        conversation.deleted_at !== null
      )
        throw new PlatformStorageError(
          "conflict",
          "对话不可发送，请刷新后重试。",
        );
      const sharedDefault =
        conversation.project_id !== request.projectId &&
        conversation.kind === "dialogue" &&
        conversation.owner_principal_id === actor.principalId &&
        request.conversationId === conversation.project_id;
      if (conversation.project_id !== request.projectId && !sharedDefault)
        throw new PlatformStorageError("forbidden", "对话不属于这个项目。");
      if (request.firstInputId) {
        const first = (
          await q.all<{
            operation: string;
            result_ref: string;
            runtime_input_id: string | null;
            actor_principal_id: string;
            actor_actant_id: string;
          }>(
            "SELECT operation,result_ref,runtime_input_id,actor_principal_id,actor_actant_id FROM command_receipts WHERE tenant_id=? AND command_id=?",
            [actor.tenantId, request.firstInputId],
          )
        )[0];
        if (
          conversation.kind !== "project" ||
          conversation.conversation_kind !== "named" ||
          sharedDefault ||
          first?.operation !== "start-conversation" ||
          first.result_ref !== request.conversationId ||
          first.runtime_input_id !== request.firstInputId ||
          first.actor_principal_id !== actor.principalId ||
          first.actor_actant_id !== actor.actantId
        )
          throw new PlatformStorageError(
            "conflict",
            "首条消息尚未绑定到这个对话。",
          );
      }
      if (sharedDefault)
        await this.assertMember(q, actor, conversation.project_id, false);
      const memberships = await q.all(
        "SELECT project_id FROM project_members WHERE tenant_id=? AND principal_id=? AND project_id IN (?,?)",
        [
          actor.tenantId,
          target.principalId,
          request.projectId,
          conversation.project_id,
        ],
      );
      if (
        !memberships.some((row) => row.project_id === request.projectId) ||
        (sharedDefault &&
          !memberships.some(
            (row) => row.project_id === conversation.project_id,
          ))
      )
        throw new PlatformStorageError("forbidden", "接收者不在对话范围内。");
      return { sharedDefault };
    }, "read");
  }

  /** Read authorization is independent of write admission: archived projects
   * and conversations remain readable to their current members. A personal
   * default conversation may span projects, but only for its Human owner.
   */
  async authorizeConversationRead(
    access: PlatformActor,
    request: { projectId: string; conversationId: string },
  ): Promise<{ personalDefault: boolean; projectIds: string[] }> {
    const actor = await this.authorize(access);
    if (actor.kind !== "human")
      throw new PlatformStorageError("forbidden", "只有用户可以读取这段对话。");
    requireId(request.projectId, "项目标识");
    requireId(request.conversationId, "对话标识");
    return this.transaction(async (q) => {
      await this.assertProjectReader(q, actor, request.projectId);
      const rows = await q.all<{
        project_id: string;
        kind: string;
        owner_principal_id: string;
      }>(
        "SELECT c.project_id,p.kind,p.owner_principal_id FROM conversations c JOIN projects p ON p.tenant_id=c.tenant_id AND p.project_id=c.project_id WHERE c.tenant_id=? AND c.conversation_id=?",
        [actor.tenantId, request.conversationId],
      );
      const conversation = rows[0];
      if (!conversation)
        throw new PlatformStorageError("not_found", "对话不存在。");
      const personalDefault =
        conversation.kind === "dialogue" &&
        conversation.owner_principal_id === actor.principalId &&
        conversation.project_id === request.conversationId;
      if (conversation.project_id !== request.projectId) {
        if (!personalDefault)
          throw new PlatformStorageError("forbidden", "对话不属于这个项目。");
        await this.assertProjectReader(q, actor, conversation.project_id);
      }
      if (!personalDefault)
        return { personalDefault: false, projectIds: [request.projectId] };
      const memberships = await q.all<{ project_id: string }>(
        "SELECT project_id FROM project_members WHERE tenant_id=? AND principal_id=?",
        [actor.tenantId, actor.principalId],
      );
      return {
        personalDefault: true,
        projectIds: memberships.map((row) => row.project_id),
      };
    }, "read");
  }

  /** Host-only invalidation proof. Hash only currently readable metadata, not
   * tenant-wide counters: a private project's commit is not a visible change.
   * No object body, credential or hash is published by the workspace stream. */
  async workspaceChangeVersion(access: PlatformActor) {
    const actor = await this.authorize(access);
    if (actor.kind !== "human")
      throw new PlatformStorageError("forbidden", "工作区通知需要用户身份。");
    // Optional Runtime presentation must not close the entire workspace while
    // Runtime is offline. An unresolved Agent avatar is not readable metadata.
    let agent:
      | Awaited<
          ReturnType<
            NonNullable<PlatformAuthorityVerifier["resolveProfileAgent"]>
          >
        >
      | undefined;
    try {
      agent = await this.capabilities.resolveProfileAgent?.({
        tenantId: actor.tenantId,
        principalId: actor.principalId,
      });
    } catch {
      agent = undefined;
    }
    return this.transaction(async (q) => {
      const args = [actor.tenantId, actor.principalId];
      const projects = await q.all<{
        project_id: string;
        deleted_at: string | null;
      }>(
        "SELECT p.project_id,p.revision,p.archived_at,p.deleted_at,m.joined_at FROM projects p JOIN project_members m ON m.tenant_id=p.tenant_id AND m.project_id=p.project_id WHERE p.tenant_id=? AND m.principal_id=? ORDER BY p.project_id",
        args,
      );
      const members = await q.all(
        "SELECT x.project_id,x.principal_id FROM project_members x JOIN project_members mine ON mine.tenant_id=x.tenant_id AND mine.project_id=x.project_id WHERE x.tenant_id=? AND mine.principal_id=? ORDER BY x.project_id,x.principal_id",
        args,
      );
      const scope =
        " JOIN project_members m ON m.tenant_id=x.tenant_id AND m.project_id=x.project_id WHERE x.tenant_id=? AND m.principal_id=?";
      const conversations = await q.all(
        "SELECT x.conversation_id,x.project_id,x.revision,x.archived_at FROM conversations x" +
          scope +
          " ORDER BY x.conversation_id",
        args,
      );
      const tasks = await q.all(
        "SELECT x.task_id,x.project_id,x.revision,x.order_rank,x.deleted_at FROM tasks x" +
          scope +
          " ORDER BY x.task_id",
        args,
      );
      const content = await q.all<{
        app_id: string;
        app_object_id: string;
        availability: string;
        deleted_at: string | null;
      }>(
        "SELECT x.content_id,x.project_id,x.app_id,x.instance_id,x.app_object_id,x.revision,x.observed_version_ref,x.availability,x.deleted_at FROM content_entries x" +
          scope +
          " ORDER BY x.content_id",
        args,
      );
      const runs = await q.all(
        "SELECT r.task_id,r.run_number,r.observed_schedule_revision,r.observed_schedule_status,r.observed_thread_status,r.bridge_control_revision,r.bridge_error FROM task_run_links r JOIN tasks x ON x.tenant_id=r.tenant_id AND x.task_id=r.task_id" +
          scope +
          " ORDER BY r.task_id,r.run_number",
        args,
      );
      const views = await q.all(
        "SELECT x.view_id,x.project_id,x.revision,x.status FROM app_view_instances x" +
          scope +
          " AND x.owner_principal_id=? ORDER BY x.view_id",
        [...args, actor.principalId],
      );
      const installations = await q.all(
        "SELECT app_id,installation_id,state FROM app_installations WHERE tenant_id=? ORDER BY app_id",
        [actor.tenantId],
      );
      const routes = await q.all(
        "SELECT instance_id,revision,state FROM app_instances WHERE tenant_id=? ORDER BY instance_id",
        [actor.tenantId],
      );
      const packages = await q.all(
        "SELECT app_id,package_version,sha256 FROM app_ui_packages WHERE tenant_id=? AND installed_by_principal_id=? ORDER BY app_id,package_version",
        args,
      );
      const notifications = await q.all(
        "SELECT mode,revision FROM notification_preferences WHERE tenant_id=? AND principal_id=?",
        args,
      );
      const reads = await q.all(
        "SELECT notification_id,read_order FROM notification_reads WHERE tenant_id=? AND principal_id=? ORDER BY read_order",
        args,
      );
      const avatars = await q.all(
        "SELECT subject_kind,subject_id,revision FROM profile_avatar_heads WHERE tenant_id=? AND ((subject_kind='human' AND subject_id=?) OR (subject_kind='agent' AND subject_id=?)) ORDER BY subject_kind,subject_id",
        [actor.tenantId, actor.principalId, agent?.agentId ?? ""],
      );
      const understanding = await q.all(
        "SELECT x.project_id,MAX(x.revision) AS revision FROM project_understanding_versions x" +
          scope +
          " GROUP BY x.project_id ORDER BY x.project_id",
        args,
      );
      const digest = (value: unknown) =>
        createHash("sha256").update(JSON.stringify(value)).digest("hex");
      return {
        version: digest({
          projects,
          conversations,
          tasks,
          content,
          runs,
          views,
          installations,
          routes,
          packages,
          notifications,
          reads,
          avatars,
          understanding,
        }),
        accessVersion: digest({
          actor: [actor.tenantId, actor.principalId, actor.actantId],
          projects: projects.map((p) => [p.project_id, p.deleted_at]),
          members,
          routes,
        }),
        projectIds: projects
          .filter((p) => p.deleted_at === null)
          .map((p) => p.project_id),
        contentRefs: content
          .filter(
            (c) => c.deleted_at === null && c.availability === "available",
          )
          .map((c) => ({
            appId: c.app_id,
            instanceId: String((c as Record<string, unknown>).instance_id),
            objectId: c.app_object_id,
          })),
      };
    }, "read");
  }

  /** Trusted Host read for a compact Runtime navigation projection. It does
   * not expose project membership to the renderer or copy Runtime messages
   * into Platform. Revocation takes effect on the next read. */
  async conversationNavigation(access: PlatformActor): Promise<{
    projectIds: string[];
    catalogVersion: number;
    revisions: NavigationRevisions;
  }> {
    const actor = await this.authorize(access);
    if (actor.kind !== "human")
      throw new PlatformStorageError("forbidden", "只有用户可以读取对话导航。");
    return this.transaction(async (q) => {
      const rows = await q.all<{ project_id: string }>(
        "SELECT m.project_id FROM project_members m JOIN projects p ON p.tenant_id=m.tenant_id AND p.project_id=m.project_id WHERE m.tenant_id=? AND m.principal_id=? AND p.deleted_at IS NULL ORDER BY m.project_id",
        [actor.tenantId, actor.principalId],
      );
      const head = (
        await q.all<{
          revision: number | string;
          projects_revision: number | string;
          conversations_revision: number | string;
          tasks_revision: number | string;
          access_revision: number | string;
        }>(
          "SELECT revision,projects_revision,conversations_revision,tasks_revision,access_revision FROM navigation_heads WHERE tenant_id=?",
          [actor.tenantId],
        )
      )[0];
      if (!head)
        throw new PlatformStorageError("not_found", "租户目录尚未建立。");
      return {
        projectIds: rows.map((row) => row.project_id),
        catalogVersion: safeInteger(head.revision, "目录修订"),
        revisions: {
          projects: safeInteger(head.projects_revision, "项目导航修订"),
          conversations: safeInteger(
            head.conversations_revision,
            "对话导航修订",
          ),
          tasks: safeInteger(head.tasks_revision, "事项导航修订"),
          access: safeInteger(head.access_revision, "访问范围修订"),
        },
      };
    }, "read");
  }

  /** Authorized project metadata only; no App objects or Runtime Sessions. */
  async listProjects(
    access: PlatformActor,
    options: {
      status?: "active" | "archived" | "deleted" | "all";
      query?: string;
      offset?: number;
      limit?: number;
      after?: { updatedAt: string; projectId: string };
    } = {},
  ): Promise<ProjectRow[]> {
    const actor = await this.authorize(access);
    const status = options.status ?? "active";
    const limit = options.limit ?? 50;
    if (
      !["active", "archived", "deleted", "all"].includes(status) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new PlatformStorageError("invalid", "项目查询参数无效。");
    if (
      (options.query !== undefined &&
        (typeof options.query !== "string" || options.query.length > 200)) ||
      (options.offset !== undefined &&
        (!Number.isSafeInteger(options.offset) ||
          options.offset < 0 ||
          options.offset > 1_000_000)) ||
      (options.offset !== undefined && options.after !== undefined)
    )
      throw new PlatformStorageError("invalid", "项目查询参数无效。");
    if (options.after) {
      if (
        typeof options.after.updatedAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(
          options.after.updatedAt,
        ) ||
        options.after.updatedAt.length > 64 ||
        Number.isNaN(Date.parse(options.after.updatedAt))
      )
        throw new PlatformStorageError("invalid", "游标时间无效。");
      requireId(options.after.projectId, "游标项目标识");
    }
    return this.transaction(async (q) => {
      const values: Scalar[] = [actor.tenantId, actor.principalId];
      const conditions = ["p.tenant_id=?", "m.principal_id=?"];
      if (actor.kind === "agent") {
        await this.assertProjectReader(q, actor, actor.scopeProjectId!);
        const source = (
          await q.all<{
            kind: string;
            archived_at: string | null;
            deleted_at: string | null;
          }>(
            "SELECT kind,archived_at,deleted_at FROM projects WHERE tenant_id=? AND project_id=?",
            [actor.tenantId, actor.scopeProjectId!],
          )
        )[0];
        if (
          !actor.runtimeTaskRun &&
          source &&
          ["desk", "inbox", "dialogue"].includes(source.kind) &&
          !source.archived_at &&
          !source.deleted_at
        ) {
          // Both set differences must be empty. This filters before LIMIT so
          // pagination cannot hide a matching project behind other audiences.
          conditions.push(
            "NOT EXISTS (SELECT 1 FROM project_members sm WHERE sm.tenant_id=p.tenant_id AND sm.project_id=? AND NOT EXISTS (SELECT 1 FROM project_members tm WHERE tm.tenant_id=p.tenant_id AND tm.project_id=p.project_id AND tm.principal_id=sm.principal_id))",
            "NOT EXISTS (SELECT 1 FROM project_members tm WHERE tm.tenant_id=p.tenant_id AND tm.project_id=p.project_id AND NOT EXISTS (SELECT 1 FROM project_members sm WHERE sm.tenant_id=p.tenant_id AND sm.project_id=? AND sm.principal_id=tm.principal_id))",
          );
          values.push(actor.scopeProjectId!, actor.scopeProjectId!);
        } else {
          conditions.push("p.project_id=?");
          values.push(actor.scopeProjectId!);
        }
      }
      if (status === "active")
        conditions.push("p.archived_at IS NULL", "p.deleted_at IS NULL");
      else if (status === "archived")
        conditions.push("p.archived_at IS NOT NULL", "p.deleted_at IS NULL");
      else if (status === "deleted")
        conditions.push("p.deleted_at IS NOT NULL");
      if (options.query?.trim()) {
        conditions.push("LOWER(p.title) LIKE ? ESCAPE '\\'");
        values.push(
          `%${options.query
            .trim()
            .toLocaleLowerCase()
            .replace(/[\\%_]/g, "\\$&")}%`,
        );
      }
      if (options.after) {
        conditions.push(
          "(p.updated_at<? OR (p.updated_at=? AND p.project_id>?))",
        );
        values.push(
          options.after.updatedAt,
          options.after.updatedAt,
          options.after.projectId,
        );
      }
      values.push(limit, options.offset ?? 0);
      const rows = await q.all<Omit<ProjectRow, "member_principal_ids"> & Row>(
        `SELECT p.project_id,p.kind,p.owner_principal_id,p.title,p.revision,p.created_at,p.updated_at,p.archived_at,p.deleted_at FROM projects p JOIN project_members m ON m.tenant_id=p.tenant_id AND m.project_id=p.project_id WHERE ${conditions.join(" AND ")} ORDER BY p.updated_at DESC,p.project_id LIMIT ? OFFSET ?`,
        values,
      );
      if (!rows.length) return [];
      const memberships = await q.all<{
        project_id: string;
        principal_id: string;
      }>(
        `SELECT project_id,principal_id FROM project_members WHERE tenant_id=? AND project_id IN (${rows.map(() => "?").join(",")}) ORDER BY project_id,principal_id`,
        [actor.tenantId, ...rows.map((row) => row.project_id)],
      );
      const members = new Map<string, string[]>();
      for (const membership of memberships) {
        const principals = members.get(membership.project_id) ?? [];
        principals.push(membership.principal_id);
        members.set(membership.project_id, principals);
      }
      return rows.map((row) => ({
        ...row,
        member_principal_ids: members.get(row.project_id) ?? [],
        revision: safeInteger(row.revision, "项目修订"),
      }));
    }, "read");
  }

  async getProject(
    access: PlatformActor,
    projectId: string,
  ): Promise<ProjectRow> {
    const actor = await this.authorize(access);
    requireId(projectId, "项目标识");
    return this.transaction(async (q) => {
      const row = (
        await q.all<Omit<ProjectRow, "member_principal_ids"> & Row>(
          "SELECT project_id,kind,owner_principal_id,title,revision,created_at,updated_at,archived_at,deleted_at FROM projects WHERE tenant_id=? AND project_id=?",
          [actor.tenantId, projectId],
        )
      )[0];
      if (!row) throw new PlatformStorageError("not_found", "项目不存在。");
      await this.assertProjectReader(q, actor, projectId);
      const memberships = await q.all<{ principal_id: string }>(
        "SELECT principal_id FROM project_members WHERE tenant_id=? AND project_id=? ORDER BY principal_id",
        [actor.tenantId, projectId],
      );
      return {
        ...row,
        member_principal_ids: memberships.map((member) => member.principal_id),
        revision: safeInteger(row.revision, "项目修订"),
      };
    }, "read");
  }

  private async understandingVersion(
    q: Query,
    tenantId: string,
    projectId: string,
    revision?: number,
  ): Promise<ProjectUnderstandingVersion | null> {
    const row = (
      await q.all<ProjectUnderstandingRow & Row>(
        `SELECT project_id,revision,frame_id,frame_revision,mind_version,body,sources_json,published_by_principal_id,published_by_actant_id,published_at
         FROM project_understanding_versions WHERE tenant_id=? AND project_id=?${revision === undefined ? " ORDER BY revision DESC LIMIT 1" : " AND revision=?"}`,
        revision === undefined
          ? [tenantId, projectId]
          : [tenantId, projectId, revision],
      )
    )[0];
    if (!row) return null;
    let sources: UnderstandingSource[];
    try {
      sources = understandingSourcesSchema.parse(JSON.parse(row.sources_json));
    } catch {
      throw new PlatformStorageError(
        "conflict",
        "项目公开理解的来源记录已损坏，拒绝展示。",
      );
    }
    const currentSources = sources.length
      ? await q.all<{
          content_id: string;
          title: string;
          app_id: string;
        }>(
          `SELECT content_id,title,app_id FROM content_entries WHERE tenant_id=? AND project_id=? AND availability='available' AND content_id IN (${sources.map(() => "?").join(",")})`,
          [tenantId, projectId, ...sources.map((source) => source.contentId)],
        )
      : [];
    const sourceById = new Map(
      currentSources.map((source) => [source.content_id, source]),
    );
    return {
      projectId: row.project_id,
      revision: safeInteger(row.revision, "公开理解修订"),
      frameId: row.frame_id,
      frameRevision: safeInteger(row.frame_revision, "公开认知帧修订"),
      mindVersion: safeInteger(row.mind_version, "认知版本"),
      body: row.body,
      sources: sources.map((source) => ({
        ...source,
        title: sourceById.get(source.contentId)?.title ?? null,
        appId: sourceById.get(source.contentId)?.app_id ?? null,
      })),
      publishedByPrincipalId: row.published_by_principal_id,
      publishedByActantId: row.published_by_actant_id,
      publishedAt: row.published_at,
    };
  }

  /** Project-visible publication, not a content catalog entry. A removed
   * member cannot read either the latest view or an older exact version. */
  async getProjectUnderstanding(
    access: PlatformActor,
    projectId: string,
    revision?: number,
  ): Promise<ProjectUnderstandingVersion | null> {
    const actor = await this.authorize(access);
    requireId(projectId, "项目标识");
    if (
      revision !== undefined &&
      (!Number.isSafeInteger(revision) || revision < 1)
    )
      throw new PlatformStorageError("invalid", "公开理解修订无效。");
    return this.transaction(async (q) => {
      await this.assertProjectReader(q, actor, projectId);
      return this.understandingVersion(q, actor.tenantId, projectId, revision);
    }, "read");
  }

  /** A lost tool result can be recovered even if Runtime's public frame has
   * since advanced. This is a receipt lookup, never a second publication. */
  async replayProjectUnderstanding(
    access: PlatformActor,
    request: {
      commandId: string;
      projectId: string;
      expectedRevision: number;
      frameRevision: number;
      sources: UnderstandingSource[];
    },
  ): Promise<ProjectUnderstandingVersion | null> {
    const actor = await this.authorize(access);
    requireId(request.commandId, "操作标识");
    requireId(request.projectId, "项目标识");
    if (
      !Number.isSafeInteger(request.expectedRevision) ||
      request.expectedRevision < 0 ||
      !Number.isSafeInteger(request.frameRevision) ||
      request.frameRevision < 1 ||
      !understandingSourcesSchema.safeParse(request.sources).success
    )
      throw new PlatformStorageError("invalid", "公开理解重试参数无效。");
    if (actor.kind !== "agent" || !actor.runtimeInputId)
      throw new PlatformStorageError(
        "forbidden",
        "当前操作没有 Agent 输入来源。",
      );
    return this.transaction(async (q) => {
      await this.assertProjectReader(q, actor, request.projectId);
      const receipt = (
        await q.all<{
          operation: string;
          result_ref: string;
          actor_principal_id: string;
          actor_actant_id: string;
          runtime_input_id: string | null;
        }>(
          "SELECT operation,result_ref,actor_principal_id,actor_actant_id,runtime_input_id FROM command_receipts WHERE tenant_id=? AND command_id=?",
          [actor.tenantId, request.commandId],
        )
      )[0];
      if (!receipt) return null;
      if (
        receipt.operation !== "publish-project-understanding" ||
        receipt.actor_principal_id !== actor.principalId ||
        receipt.actor_actant_id !== actor.actantId ||
        receipt.runtime_input_id !== actor.runtimeInputId
      )
        throw new PlatformStorageError(
          "conflict",
          "这个操作标识已经用于另一项请求。",
        );
      const revision = Number(receipt.result_ref);
      const published = Number.isSafeInteger(revision)
        ? await this.understandingVersion(
            q,
            actor.tenantId,
            request.projectId,
            revision,
          )
        : null;
      if (!published)
        throw new PlatformStorageError(
          "conflict",
          "公开理解回执缺少对应版本。",
        );
      if (
        published.revision - 1 !== request.expectedRevision ||
        published.frameRevision !== request.frameRevision ||
        JSON.stringify(
          published.sources.map(({ contentId, versionRef }) => ({
            contentId,
            versionRef,
          })),
        ) !== JSON.stringify(request.sources)
      )
        throw new PlatformStorageError(
          "conflict",
          "这个操作标识已经用于另一项请求。",
        );
      return published;
    }, "read");
  }

  /** The Host has already fetched this exact committed Runtime public frame.
   * Platform serializes the project-visible projection and checks all source
   * catalog references in the same transaction as the durable receipt. */
  async publishProjectUnderstanding(
    access: PlatformActor,
    request: {
      commandId: string;
      projectId: string;
      expectedRevision: number;
      frameId: string;
      frameRevision: number;
      mindVersion: number;
      body: string;
      sources: UnderstandingSource[];
      now?: string;
    },
  ): Promise<ProjectUnderstandingVersion> {
    const actor = await this.authorize(access);
    if (actor.kind !== "agent" || !actor.runtimeInputId)
      throw new PlatformStorageError(
        "forbidden",
        "只有绑定到已保存输入的 Agent 可以发布当前理解。",
      );
    requireId(request.commandId, "操作标识");
    requireId(request.projectId, "项目标识");
    if (request.frameId !== `mw-public-${request.projectId}`)
      throw new PlatformStorageError("invalid", "公开认知帧范围不正确。");
    if (
      !Number.isSafeInteger(request.expectedRevision) ||
      request.expectedRevision < 0 ||
      !Number.isSafeInteger(request.frameRevision) ||
      request.frameRevision < 1 ||
      !Number.isSafeInteger(request.mindVersion) ||
      request.mindVersion < 1 ||
      typeof request.body !== "string" ||
      !request.body.trim() ||
      request.body.length > 30000
    )
      throw new PlatformStorageError("invalid", "公开理解版本或正文无效。");
    const parsed = understandingSourcesSchema.safeParse(request.sources);
    if (!parsed.success)
      throw new PlatformStorageError("invalid", "公开理解的来源格式无效。");
    const sources = parsed.data;
    if (
      new Set(sources.map((source) => JSON.stringify(source))).size !==
      sources.length
    )
      throw new PlatformStorageError("invalid", "公开理解的来源重复。");
    const sourcesJson = JSON.stringify(sources);
    if (sourcesJson.length > 40000)
      throw new PlatformStorageError("invalid", "公开理解的来源过长。");
    const hash = fingerprint({
      actor,
      commandId: request.commandId,
      projectId: request.projectId,
      expectedRevision: request.expectedRevision,
      frameId: request.frameId,
      frameRevision: request.frameRevision,
      mindVersion: request.mindVersion,
      body: request.body,
      sources,
    });
    const now = request.now ?? new Date().toISOString();
    return this.transaction(async (q) => {
      const project = await q.all(
        `SELECT project_id FROM projects WHERE tenant_id=? AND project_id=?${this.backend.kind === "postgres" ? " FOR UPDATE" : ""}`,
        [actor.tenantId, request.projectId],
      );
      if (!project.length)
        throw new PlatformStorageError("not_found", "项目不存在。");
      await this.assertMember(q, actor, request.projectId);
      const earlier = await this.replay(q, actor, request.commandId, hash);
      if (earlier) {
        const published = await this.understandingVersion(
          q,
          actor.tenantId,
          request.projectId,
          Number(earlier),
        );
        if (!published)
          throw new PlatformStorageError(
            "conflict",
            "公开理解回执缺少对应版本。",
          );
        return published;
      }
      const current = await this.understandingVersion(
        q,
        actor.tenantId,
        request.projectId,
      );
      if (
        request.expectedRevision !== (current?.revision ?? 0) ||
        (current && request.frameRevision <= current.frameRevision)
      )
        throw new PlatformStorageError(
          "conflict",
          "当前理解已更新，请读取最新版本后重新发布。",
        );
      if (sources.length) {
        const refs = await q.all<{
          content_id: string;
          project_id: string;
          availability: string;
          app_id: string;
          kind: string;
        }>(
          `SELECT content_id,project_id,availability,app_id,kind FROM content_entries WHERE tenant_id=? AND content_id IN (${sources.map(() => "?").join(",")})`,
          [actor.tenantId, ...sources.map((source) => source.contentId)],
        );
        const available = new Map(refs.map((ref) => [ref.content_id, ref]));
        for (const source of sources) {
          const ref = available.get(source.contentId);
          if (
            !ref ||
            ref.project_id !== request.projectId ||
            ref.availability !== "available" ||
            ref.app_id !== "morphz.objects" ||
            ref.kind !== "document" ||
            !/^[1-9][0-9]*$/.test(source.versionRef) ||
            !Number.isSafeInteger(Number(source.versionRef))
          )
            throw new PlatformStorageError(
              "forbidden",
              "公开理解引用了当前项目不可用的内容。",
            );
        }
      }
      const revision = (current?.revision ?? 0) + 1;
      await q.change(
        `INSERT INTO project_understanding_versions(tenant_id,project_id,revision,frame_id,frame_revision,mind_version,body,sources_json,published_by_principal_id,published_by_actant_id,published_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        [
          actor.tenantId,
          request.projectId,
          revision,
          request.frameId,
          request.frameRevision,
          request.mindVersion,
          request.body,
          sourcesJson,
          actor.principalId,
          actor.actantId,
          now,
        ],
      );
      await this.receipt(
        q,
        actor,
        request.commandId,
        hash,
        "publish-project-understanding",
        String(revision),
        now,
      );
      const published = await this.understandingVersion(
        q,
        actor.tenantId,
        request.projectId,
        revision,
      );
      if (!published)
        throw new PlatformStorageError(
          "conflict",
          "公开理解发布后未能读取版本。",
        );
      return published;
    });
  }

  async renameProject(
    access: PlatformActor,
    request: {
      commandId: string;
      projectId: string;
      expectedRevision: number;
      title: string;
      now?: string;
    },
  ): Promise<string> {
    const actor = await this.authorize(access);
    requireId(request.commandId, "操作标识");
    requireId(request.projectId, "项目标识");
    requireTitle(request.title);
    if (
      !Number.isSafeInteger(request.expectedRevision) ||
      request.expectedRevision < 1
    )
      throw new PlatformStorageError("invalid", "项目修订无效。");
    const hash = fingerprint({ actor, ...request, now: undefined });
    const now = request.now ?? new Date().toISOString();
    return this.transaction(async (q) => {
      const earlier = await this.replay(q, actor, request.commandId, hash);
      const current = (
        await q.all<ProjectRow & Row>(
          `SELECT project_id,kind,revision,archived_at,deleted_at FROM projects WHERE tenant_id=? AND project_id=?${this.backend.kind === "postgres" ? " FOR UPDATE" : ""}`,
          [actor.tenantId, request.projectId],
        )
      )[0];
      if (!current) throw new PlatformStorageError("not_found", "项目不存在。");
      await this.assertProjectReader(q, actor, request.projectId);
      if (earlier) return earlier;
      await this.assertProjectNotRetiring(q, actor, request.projectId);
      if (current.kind !== "project")
        throw new PlatformStorageError("forbidden", "默认空间不能重命名。");
      if (current.deleted_at !== null)
        throw new PlatformStorageError("conflict", "请先恢复项目。");
      if (
        safeInteger(current.revision, "项目修订") !== request.expectedRevision
      )
        throw new PlatformStorageError("conflict", "项目已更新，请重新读取。");
      const changed = await q.change(
        "UPDATE projects SET title=?,revision=revision+1,updated_at=? WHERE tenant_id=? AND project_id=? AND revision=? AND deleted_at IS NULL",
        [
          request.title,
          now,
          actor.tenantId,
          request.projectId,
          request.expectedRevision,
        ],
      );
      if (changed !== 1)
        throw new PlatformStorageError("conflict", "项目已更新，请重新读取。");
      await this.receipt(
        q,
        actor,
        request.commandId,
        hash,
        "rename-project",
        request.projectId,
        now,
      );
      return request.projectId;
    });
  }

  private async assertCognitiveRetirementQuiescent(
    q: Query,
    tenantId: string,
    projectId: string,
  ) {
    const commands = this.cognitiveCommands(q, tenantId);
    if (await commands.hasOpenCommands(projectId))
      throw new PlatformStorageError(
        "conflict",
        "项目仍有尚未确定结果的应用命令，不能归档或删除。",
      );
    if (await commands.hasPendingProjection(projectId))
      throw new PlatformStorageError(
        "conflict",
        "应用命令已提交，但原件目录尚未补齐，不能归档或删除。",
      );
  }

  /** Hold new work out while the trusted Host checks exact Runtime work.
   * A retry of the same command resumes the fence; another command cannot
   * replace it. No visible project state or revision changes here. */
  async beginProjectRetirement(
    access: PlatformActor,
    request: ProjectRetirementRequest,
  ): Promise<"fenced" | "completed"> {
    const actor = await this.authorize(access);
    requireId(request.commandId, "操作标识");
    requireId(request.projectId, "项目标识");
    if (
      !Number.isSafeInteger(request.expectedRevision) ||
      request.expectedRevision < 1 ||
      !["archived", "deleted"].includes(request.state)
    )
      throw new PlatformStorageError("invalid", "项目退役请求无效。");
    const hash = fingerprint({ actor, ...request, now: undefined });
    return this.transaction(async (q) => {
      const earlier = await this.replay(q, actor, request.commandId, hash);
      if (earlier) {
        if (earlier !== request.projectId)
          throw new PlatformStorageError("conflict", "操作回执与项目不一致。");
        return "completed" as const;
      }
      const current = (
        await q.all<ProjectRow & Row>(
          `SELECT project_id,kind,revision,archived_at,deleted_at FROM projects WHERE tenant_id=? AND project_id=?${this.backend.kind === "postgres" ? " FOR UPDATE" : ""}`,
          [actor.tenantId, request.projectId],
        )
      )[0];
      if (!current) throw new PlatformStorageError("not_found", "项目不存在。");
      await this.assertProjectReader(q, actor, request.projectId);
      if (current.kind !== "project")
        throw new PlatformStorageError("forbidden", "默认空间不能归档或删除。");
      if (
        safeInteger(current.revision, "项目修订") !== request.expectedRevision
      )
        throw new PlatformStorageError("conflict", "项目已更新，请重新读取。");
      if (
        (request.state === "archived" && current.archived_at !== null) ||
        current.deleted_at !== null
      )
        throw new PlatformStorageError("conflict", "项目状态未变化。");
      await this.assertCognitiveRetirementQuiescent(
        q,
        actor.tenantId,
        request.projectId,
      );
      const pending = (
        await q.all<{ command_id: string; request_hash: string }>(
          "SELECT command_id,request_hash FROM project_retirements WHERE tenant_id=? AND project_id=?",
          [actor.tenantId, request.projectId],
        )
      )[0];
      if (pending) {
        if (
          pending.command_id !== request.commandId ||
          pending.request_hash !== hash
        )
          throw new PlatformStorageError(
            "conflict",
            "项目正在处理另一次归档或删除。",
          );
        return "fenced" as const;
      }
      await q.change(
        "INSERT INTO project_retirements(tenant_id,project_id,command_id,request_hash,target_state,expected_revision,begun_at) VALUES(?,?,?,?,?,?,?)",
        [
          actor.tenantId,
          request.projectId,
          request.commandId,
          hash,
          request.state,
          request.expectedRevision,
          request.now ?? new Date().toISOString(),
        ],
      );
      return "fenced" as const;
    });
  }

  /** An inconclusive or blocked Runtime check restores admission without
   * changing project state. Retrying the abort is harmless. */
  async abortProjectRetirement(
    access: PlatformActor,
    request: ProjectRetirementRequest,
  ): Promise<void> {
    const actor = await this.authorize(access);
    requireId(request.commandId, "操作标识");
    requireId(request.projectId, "项目标识");
    const hash = fingerprint({ actor, ...request, now: undefined });
    await this.transaction(async (q) => {
      const pending = (
        await q.all<{ command_id: string; request_hash: string }>(
          "SELECT command_id,request_hash FROM project_retirements WHERE tenant_id=? AND project_id=?",
          [actor.tenantId, request.projectId],
        )
      )[0];
      if (!pending) return;
      await this.assertProjectReader(q, actor, request.projectId);
      if (
        pending.command_id !== request.commandId ||
        pending.request_hash !== hash
      )
        throw new PlatformStorageError("conflict", "项目退役请求已变化。");
      await q.change(
        "DELETE FROM project_retirements WHERE tenant_id=? AND project_id=? AND command_id=?",
        [actor.tenantId, request.projectId, request.commandId],
      );
    });
  }

  /** Host-only, paged provenance for a fenced project. A missing source or
   * unconfirmed admission is uncertainty, never evidence of quiescence. */
  async projectRetirementRuns(
    access: PlatformActor,
    projectId: string,
    commandId: string,
    afterSequence = 0,
  ): Promise<ProjectRetirementRun[]> {
    const actor = await this.authorize(access);
    requireId(projectId, "项目标识");
    requireId(commandId, "操作标识");
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
      throw new PlatformStorageError("invalid", "执行游标无效。");
    return this.transaction(async (q) => {
      await this.assertProjectReader(q, actor, projectId);
      const fence = await q.all(
        "SELECT 1 AS pending FROM project_retirements WHERE tenant_id=? AND project_id=? AND command_id=?",
        [actor.tenantId, projectId, commandId],
      );
      if (!fence.length)
        throw new PlatformStorageError("conflict", "项目退役栅栏不存在。");
      const pending = await q.all(
        "SELECT 1 AS pending FROM outbox o LEFT JOIN task_versions v ON v.tenant_id=o.tenant_id AND v.task_id=o.aggregate_id AND v.revision=o.aggregate_revision WHERE o.tenant_id=? AND o.event_kind='task.run_requested' AND o.delivered_at IS NULL AND (v.project_id=? OR v.project_id IS NULL) LIMIT 1",
        [actor.tenantId, projectId],
      );
      if (pending.length)
        throw new PlatformStorageError(
          "conflict",
          "项目仍有未确认的事项执行请求。",
        );
      const rows = await q.all<{
        sequence: number | string;
        project_id: string | null;
        runtime_session_id: string;
        runtime_schedule_id: string;
        runtime_thread_id: string;
      }>(
        "SELECT l.sequence,v.project_id,l.runtime_session_id,l.runtime_schedule_id,l.runtime_thread_id FROM task_run_links l LEFT JOIN task_versions v ON v.tenant_id=l.tenant_id AND v.task_id=l.task_id AND v.revision=l.task_revision WHERE l.tenant_id=? AND (v.project_id=? OR v.project_id IS NULL) AND l.sequence>? ORDER BY l.sequence LIMIT 50",
        [actor.tenantId, projectId, afterSequence],
      );
      const result: ProjectRetirementRun[] = [];
      for (const row of rows) {
        if (row.project_id !== projectId)
          throw new PlatformStorageError(
            "conflict",
            "事项执行缺少确切的项目来源，不能归档或删除。",
          );
        const scheduleId = row.runtime_schedule_id;
        if (!/^task_[a-f0-9]{40}$/.test(scheduleId))
          throw new PlatformStorageError("conflict", "事项执行引用不完整。");
        const admission = await this.taskRunAdmission(
          q,
          actor.tenantId,
          `task_run_${scheduleId.slice(5)}`,
        );
        if (
          admission.projectId !== projectId ||
          admission.sessionId !== row.runtime_session_id ||
          admission.request.id !== scheduleId
        )
          throw new PlatformStorageError(
            "conflict",
            "事项执行来源与项目不一致。",
          );
        result.push({
          sequence: safeInteger(row.sequence, "事项执行顺序"),
          runtime: {
            sessionId: row.runtime_session_id,
            scheduleId,
            threadId: row.runtime_thread_id,
          },
          access: {
            principalId: admission.principalId,
            actantId: admission.humanActantId,
          },
        });
      }
      return result;
    }, "read");
  }

  /** Only the trusted Host calls this after checking the fenced project's
   * exact Runtime input and Schedule/Thread references. */
  async completeProjectRetirement(
    access: PlatformActor,
    request: ProjectRetirementRequest,
  ): Promise<string> {
    const actor = await this.authorize(access);
    requireId(request.commandId, "操作标识");
    requireId(request.projectId, "项目标识");
    const hash = fingerprint({ actor, ...request, now: undefined });
    const now = request.now ?? new Date().toISOString();
    return this.transaction(async (q) => {
      const earlier = await this.replay(q, actor, request.commandId, hash);
      if (earlier) return earlier;
      const current = (
        await q.all<ProjectRow & Row>(
          `SELECT revision,archived_at,deleted_at FROM projects WHERE tenant_id=? AND project_id=?${this.backend.kind === "postgres" ? " FOR UPDATE" : ""}`,
          [actor.tenantId, request.projectId],
        )
      )[0];
      if (!current) throw new PlatformStorageError("not_found", "项目不存在。");
      await this.assertProjectReader(q, actor, request.projectId);
      const pending = (
        await q.all<{
          command_id: string;
          request_hash: string;
          target_state: string;
          expected_revision: number | string;
        }>(
          "SELECT command_id,request_hash,target_state,expected_revision FROM project_retirements WHERE tenant_id=? AND project_id=?",
          [actor.tenantId, request.projectId],
        )
      )[0];
      if (
        !pending ||
        pending.command_id !== request.commandId ||
        pending.request_hash !== hash ||
        pending.target_state !== request.state ||
        safeInteger(pending.expected_revision, "项目退役修订") !==
          request.expectedRevision ||
        safeInteger(current.revision, "项目修订") !== request.expectedRevision
      )
        throw new PlatformStorageError("conflict", "项目退役状态已变化。");
      await this.assertCognitiveRetirementQuiescent(
        q,
        actor.tenantId,
        request.projectId,
      );
      const changed = await q.change(
        "UPDATE projects SET archived_at=?,deleted_at=?,revision=revision+1,updated_at=? WHERE tenant_id=? AND project_id=? AND revision=?",
        [
          request.state === "archived" ? now : current.archived_at,
          request.state === "deleted" ? now : null,
          now,
          actor.tenantId,
          request.projectId,
          request.expectedRevision,
        ],
      );
      if (changed !== 1)
        throw new PlatformStorageError("conflict", "项目已更新，请重新读取。");
      await this.receipt(
        q,
        actor,
        request.commandId,
        hash,
        "change-project-state",
        request.projectId,
        now,
      );
      await q.change(
        "DELETE FROM project_retirements WHERE tenant_id=? AND project_id=? AND command_id=?",
        [actor.tenantId, request.projectId, request.commandId],
      );
      return request.projectId;
    });
  }

  /** Recovery is safe with the current authority boundary. Retirement goes
   * through the Host's fence and Runtime check, never this direct mutation. */
  async changeProjectState(
    access: PlatformActor,
    request: {
      commandId: string;
      projectId: string;
      expectedRevision: number;
      state: "active" | "archived" | "deleted";
      now?: string;
    },
  ): Promise<string> {
    const actor = await this.authorize(access);
    requireId(request.commandId, "操作标识");
    requireId(request.projectId, "项目标识");
    if (
      !Number.isSafeInteger(request.expectedRevision) ||
      request.expectedRevision < 1
    )
      throw new PlatformStorageError("invalid", "项目修订无效。");
    if (!["active", "archived", "deleted"].includes(request.state))
      throw new PlatformStorageError("invalid", "项目状态无效。");
    const hash = fingerprint({ actor, ...request, now: undefined });
    const now = request.now ?? new Date().toISOString();
    return this.transaction(async (q) => {
      const earlier = await this.replay(q, actor, request.commandId, hash);
      const current = (
        await q.all<ProjectRow & Row>(
          `SELECT project_id,kind,revision,archived_at,deleted_at FROM projects WHERE tenant_id=? AND project_id=?${this.backend.kind === "postgres" ? " FOR UPDATE" : ""}`,
          [actor.tenantId, request.projectId],
        )
      )[0];
      if (!current) throw new PlatformStorageError("not_found", "项目不存在。");
      await this.assertProjectReader(q, actor, request.projectId);
      if (earlier) return earlier;
      await this.assertProjectNotRetiring(q, actor, request.projectId);
      if (current.kind !== "project")
        throw new PlatformStorageError("forbidden", "默认空间不能归档或删除。");
      if (
        safeInteger(current.revision, "项目修订") !== request.expectedRevision
      )
        throw new PlatformStorageError("conflict", "项目已更新，请重新读取。");
      const currentState =
        current.deleted_at !== null
          ? "deleted"
          : current.archived_at !== null
            ? "archived"
            : "active";
      if (currentState === request.state)
        throw new PlatformStorageError("conflict", "项目状态未变化。");
      if (request.state !== "active")
        throw new PlatformStorageError(
          "conflict",
          "项目归档与删除尚未完成运行中工作校验；项目未改变。",
        );
      const changed = await q.change(
        "UPDATE projects SET archived_at=NULL,deleted_at=NULL,revision=revision+1,updated_at=? WHERE tenant_id=? AND project_id=? AND revision=?",
        [now, actor.tenantId, request.projectId, request.expectedRevision],
      );
      if (changed !== 1)
        throw new PlatformStorageError("conflict", "项目已更新，请重新读取。");
      await this.receipt(
        q,
        actor,
        request.commandId,
        hash,
        "change-project-state",
        request.projectId,
        now,
      );
      return request.projectId;
    });
  }

  /** General app/Session permission at a live project and provider route.
   * Creating a catalog original uses the narrower authorizeContentProject. */
  async authorizeApplicationProject(
    access: PlatformActor,
    instanceId: string,
    appId: string,
    projectId: string,
    provider?: ApplicationProviderRoute,
  ) {
    return this.authorizeAppProject(
      access,
      instanceId,
      appId,
      projectId,
      provider,
      false,
    );
  }

  /** New originals belong to a project or personal content desk. This is
   * deliberately narrower than app/Session access in a dialogue or inbox. */
  async authorizeContentProject(
    access: PlatformActor,
    instanceId: string,
    appId: string,
    projectId: string,
    provider?: ApplicationProviderRoute,
  ) {
    return this.authorizeAppProject(
      access,
      instanceId,
      appId,
      projectId,
      provider,
      true,
    );
  }

  private async assertContentDestination(
    q: Query,
    tenantId: string,
    projectId: string,
  ) {
    const project = (
      await q.all<{ kind: string }>(
        "SELECT kind FROM projects WHERE tenant_id=? AND project_id=? AND deleted_at IS NULL",
        [tenantId, projectId],
      )
    )[0];
    if (!project || !["project", "desk"].includes(project.kind))
      throw new PlatformStorageError("invalid", "内容只能归入项目或未归项目。");
  }

  private async authorizeAppProject(
    access: PlatformActor,
    instanceId: string,
    appId: string,
    projectId: string,
    provider: ApplicationProviderRoute | undefined,
    contentDestination: boolean,
  ) {
    const actor = await this.authorize(access);
    if (actor.kind === "provider")
      throw new PlatformStorageError(
        "forbidden",
        "资源提供方不能创建项目内容。",
      );
    requireId(projectId, "项目标识");
    requireId(instanceId, "应用实例标识");
    requireAppId(appId);
    await this.transaction(async (q) => {
      await this.assertMember(q, actor, projectId, false);
      if (contentDestination)
        await this.assertContentDestination(q, actor.tenantId, projectId);
      const instances = await q.all<{
        app_id: string;
        route_kind: string;
        route_ref: string;
        node_id: string | null;
      }>(
        "SELECT app_id,route_kind,route_ref,node_id FROM app_instances WHERE tenant_id=? AND instance_id=? AND state='active'",
        [actor.tenantId, instanceId],
      );
      if (!instances.length)
        throw new PlatformStorageError("not_found", "应用实例不可用。");
      if (instances[0]!.app_id !== appId)
        throw new PlatformStorageError("invalid", "应用实例与应用类型不符。");
      if (provider && !matchesApplicationProviderRoute(instances[0]!, provider))
        throw new PlatformStorageError(
          "conflict",
          "应用原件已不由当前保存方提供。",
        );
    }, "read");
    return {
      tenantId: actor.tenantId,
      principalId: actor.principalId,
      actantId: actor.actantId,
      kind: actor.kind,
      runtimeInputId: actor.runtimeInputId,
      runtimeTaskRunEventId: actor.runtimeTaskRun?.eventId ?? null,
    };
  }

  /** Resolve a live app-owned original through the Platform directory. This
   * grants access to the current project, not to a model-supplied object ID.
   * A read can inspect a retired project for recovery; a write requires an
   * active one.
   * The app still owns and checks its exact version before committing.
   */
  async authorizeApplicationObject(
    access: PlatformActor,
    instanceId: string,
    appId: string,
    objectId: string,
    operation: "read" | "write" = "write",
    provider?: ApplicationProviderRoute,
  ) {
    const actor = await this.authorize(access);
    if (actor.kind === "provider")
      throw new PlatformStorageError("forbidden", "资源提供方不能修改内容。");
    requireId(instanceId, "应用实例标识");
    requireAppId(appId);
    requireId(objectId, "应用原件标识");
    const entry = await this.transaction(
      (q) =>
        this.authorizeApplicationObjectRow(
          q,
          actor,
          instanceId,
          appId,
          objectId,
          operation,
          provider,
        ),
      "read",
    );
    return {
      tenantId: actor.tenantId,
      principalId: actor.principalId,
      actantId: actor.actantId,
      kind: actor.kind,
      runtimeInputId: actor.runtimeInputId,
      runtimeTaskRunEventId: actor.runtimeTaskRun?.eventId ?? null,
      contentId: entry.content_id,
      projectId: entry.project_id,
      objectKind: entry.kind,
      observedVersionRef: entry.observed_version_ref,
      catalogRevision: safeInteger(entry.revision, "目录修订"),
    };
  }

  /** Shared exact catalog guard. Legacy callers retain their existing policy;
   * new operation resolution also holds the live row and supplies its already
   * capabilities-verified executor, without identity I/O inside this q. */
  private async authorizeApplicationObjectRow(
    q: Query,
    actor: ResolvedActor,
    instanceId: string,
    appId: string,
    objectId: string,
    operation: "read" | "write",
    provider?: ApplicationProviderRoute,
    executor?: PreparedExecutor,
    forWrite = false,
  ) {
    const row = (
      await q.all<{
        content_id: string;
        project_id: string;
        kind: string;
        observed_version_ref: string | null;
        availability: string;
        revision: number | string;
        route_kind: string;
        route_ref: string;
        node_id: string | null;
      }>(
        `SELECT c.content_id,c.project_id,c.kind,c.observed_version_ref,c.availability,c.revision,i.route_kind,i.route_ref,i.node_id FROM content_entries c JOIN app_instances i ON i.tenant_id=c.tenant_id AND i.instance_id=c.instance_id AND i.app_id=c.app_id WHERE c.tenant_id=? AND c.instance_id=? AND c.app_id=? AND c.app_object_id=? AND c.deleted_at IS NULL AND i.state='active'${forWrite && this.backend.kind === "postgres" ? " FOR SHARE OF c,i" : ""}`,
        [actor.tenantId, instanceId, appId, objectId],
      )
    )[0];
    if (!row)
      throw new PlatformStorageError("not_found", "内容或应用实例不可用。");
    if (provider && !matchesApplicationProviderRoute(row, provider))
      throw new PlatformStorageError(
        "conflict",
        "应用原件已不由当前保存方提供。",
      );
    if (operation === "read")
      await this.assertProjectReader(q, actor, row.project_id, executor);
    else
      await this.assertMember(
        q,
        actor,
        row.project_id,
        forWrite,
        true,
        executor,
      );
    return row;
  }

  /** A previously pinned App citation may survive moving its source only
   * while every involved project still has the same live audience. A shared
   * database instance is never itself permission to cross project boundaries.
   */
  async projectAudiencesEqual(
    access: PlatformActor,
    projectIds: string[],
  ): Promise<boolean> {
    const actor = await this.authorize(access);
    if (actor.kind === "provider")
      throw new PlatformStorageError(
        "forbidden",
        "资源提供方不能引用项目内容。",
      );
    if (projectIds.length < 1 || projectIds.length > 3)
      throw new PlatformStorageError("invalid", "引用项目范围无效。");
    for (const id of projectIds) requireId(id, "项目 ID");
    const ids = [...new Set(projectIds)];
    return this.transaction(async (q) => {
      let audience: string | null = null;
      for (const id of ids) {
        await this.assertProjectReader(q, actor, id);
        const project = await q.all<{ deleted_at: string | null }>(
          "SELECT deleted_at FROM projects WHERE tenant_id=? AND project_id=?",
          [actor.tenantId, id],
        );
        if (project.length !== 1 || project[0]!.deleted_at) return false;
        const members = await q.all<{ principal_id: string }>(
          "SELECT principal_id FROM project_members WHERE tenant_id=? AND project_id=? ORDER BY principal_id",
          [actor.tenantId, id],
        );
        const signature = JSON.stringify(
          members.map((row) => row.principal_id),
        );
        if (audience !== null && signature !== audience) return false;
        audience = signature;
      }
      return true;
    }, "read");
  }

  private async insertTaskVersion(
    q: Query,
    tenantId: string,
    version: Omit<
      TaskVersionRow,
      "result_ids" | "depends_on_ids" | "watch_source_ids"
    > & {
      result_ids: string[];
      depends_on_ids: string[];
      watch_source_ids: string[];
    },
  ) {
    await q.change(
      "INSERT INTO task_versions(tenant_id,task_id,revision,project_id,title,description,assignee_id,model_id,reasoning_effort,legacy_priority,due_date,assignment,execution,delivery,run_requested,not_before,every_seconds,author_principal_id,author_actant_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        tenantId,
        version.task_id,
        version.revision,
        version.project_id,
        version.title,
        version.description,
        version.assignee_id,
        version.model_id,
        version.reasoning_effort,
        version.legacy_priority,
        version.due_date,
        version.assignment,
        version.execution,
        version.delivery,
        version.run_requested,
        version.not_before,
        version.every_seconds,
        version.author_principal_id,
        version.author_actant_id,
        version.created_at,
      ],
    );
    for (const [kind, refs] of [
      ["result", version.result_ids],
      ["dependency", version.depends_on_ids],
      ["watch_source", version.watch_source_ids],
    ] as const)
      for (const [ordinal, refId] of refs.entries())
        await q.change(
          "INSERT INTO task_version_refs(tenant_id,task_id,revision,ref_kind,ordinal,ref_id) VALUES(?,?,?,?,?,?)",
          [tenantId, version.task_id, version.revision, kind, ordinal, refId],
        );
  }

  /** Resolve only explicitly watched IDs. The initial read captures directory
   * premises; admission locks and validates those premises after app I/O. App
   * version authority stays with the app, not observed_version_ref. */
  private async taskWatchSources(
    q: Query,
    actor: ResolvedActor,
    projectId: string,
    ids: string[],
    lock = false,
  ): Promise<TaskWatchSource[]> {
    const sources: TaskWatchSource[] = [];
    const locking =
      lock && this.backend.kind === "postgres" ? " FOR SHARE" : "";
    for (const sourceId of ids) {
      const tasks = await q.all<{
        project_id: string;
        revision: number | string;
      }>(
        `SELECT project_id,revision FROM tasks WHERE tenant_id=? AND task_id=? AND deleted_at IS NULL${locking}`,
        [actor.tenantId, sourceId],
      );
      const content = await q.all<{
        project_id: string;
        app_id: string;
        instance_id: string;
        app_object_id: string;
        revision: number | string;
        provider_revision: number | string;
        observed_version_ref: string | null;
      }>(
        `SELECT c.project_id,c.app_id,c.instance_id,c.app_object_id,c.revision,i.revision AS provider_revision,c.observed_version_ref FROM content_entries c JOIN app_instances i ON i.tenant_id=c.tenant_id AND i.instance_id=c.instance_id AND i.app_id=c.app_id WHERE c.tenant_id=? AND c.content_id=? AND c.deleted_at IS NULL AND c.availability='available' AND i.state='active'${locking}`,
        [actor.tenantId, sourceId],
      );
      if (tasks.length + content.length !== 1)
        throw new PlatformStorageError(
          "not_found",
          "关注来源不存在或应用不可用。",
        );
      const sourceProjectId = tasks[0]?.project_id ?? content[0]!.project_id;
      if (sourceProjectId !== projectId)
        throw new PlatformStorageError(
          "forbidden",
          "关注来源已不在事项所属项目中。",
        );
      await this.assertProjectReader(q, actor, sourceProjectId);
      const task = tasks[0];
      if (task)
        sources.push({
          kind: "task",
          sourceId,
          projectId,
          revision: safeInteger(task.revision, "来源事项修订"),
        });
      else {
        const row = content[0]!;
        sources.push({
          kind: "content",
          sourceId,
          projectId,
          appId: row.app_id,
          instanceId: row.instance_id,
          objectId: row.app_object_id,
          catalogRevision: safeInteger(row.revision, "来源目录修订"),
          providerRevision: safeInteger(
            row.provider_revision,
            "来源保存方修订",
          ),
          observedVersionRef: row.observed_version_ref,
        });
      }
    }
    return sources;
  }

  private async validateTaskReferences(
    q: Query,
    tenantId: string,
    projectId: string,
    taskId: string,
    refs: {
      resultIds: string[];
      dependsOnIds: string[];
      watchSourceIds: string[];
    },
  ) {
    const groups = [
      ["result", refs.resultIds],
      ["dependency", refs.dependsOnIds],
      ["watch_source", refs.watchSourceIds],
    ] as const;
    for (const [, ids] of groups) {
      if (
        !Array.isArray(ids) ||
        ids.length > 100 ||
        new Set(ids).size !== ids.length
      )
        throw new PlatformStorageError("invalid", "事项关联对象无效或重复。");
      for (const id of ids) requireId(id, "事项关联对象标识");
    }
    if (
      refs.resultIds.length === 0 &&
      refs.dependsOnIds.length === 0 &&
      refs.watchSourceIds.length === 0
    )
      return;
    if (this.backend.kind === "postgres")
      await q.all(
        "SELECT pg_advisory_xact_lock(hashtextextended(?, 0)) AS locked",
        [`${tenantId}:task-graph:${projectId}`],
      );
    for (const [kind, ids] of groups) {
      for (const id of ids) {
        if (id === taskId && kind !== "watch_source")
          throw new PlatformStorageError("invalid", "事项不能依赖或交付自身。");
        const matches = await q.all<{ project_id: string; kind: string }>(
          "SELECT project_id,'task' AS kind FROM tasks WHERE tenant_id=? AND task_id=? AND deleted_at IS NULL UNION ALL SELECT project_id,'content' AS kind FROM content_entries WHERE tenant_id=? AND content_id=? AND deleted_at IS NULL",
          [tenantId, id, tenantId, id],
        );
        if (matches.length !== 1 || matches[0]!.project_id !== projectId)
          throw new PlatformStorageError(
            "invalid",
            "事项关联对象必须是当前项目中的唯一有效对象。",
          );
        if (kind === "dependency" && matches[0]!.kind !== "task")
          throw new PlatformStorageError("invalid", "事项只能依赖另一个事项。");
      }
    }
    if (refs.dependsOnIds.length) {
      const seeds = refs.dependsOnIds
        .map((_, index) => (index ? "UNION SELECT ?" : "SELECT ? AS task_id"))
        .join(" ");
      const cycle = await q.all(
        `WITH RECURSIVE reachable(task_id) AS (${seeds} UNION SELECT r.ref_id FROM reachable d JOIN tasks t ON t.tenant_id=? AND t.task_id=d.task_id AND t.deleted_at IS NULL JOIN task_version_refs r ON r.tenant_id=t.tenant_id AND r.task_id=t.task_id AND r.revision=t.revision AND r.ref_kind='dependency') SELECT 1 AS cycle FROM reachable WHERE task_id=? LIMIT 1`,
        [...refs.dependsOnIds, tenantId, taskId],
      );
      if (cycle.length)
        throw new PlatformStorageError("invalid", "事项依赖不能形成循环。");
    }
  }

  private async loadTaskVersion(
    q: Query,
    tenantId: string,
    taskId: string,
    revision: number,
  ): Promise<TaskVersionRow | null> {
    const row = (
      await q.all<
        Omit<
          TaskVersionRow,
          "result_ids" | "depends_on_ids" | "watch_source_ids"
        > &
          Row
      >(
        "SELECT * FROM task_versions WHERE tenant_id=? AND task_id=? AND revision=?",
        [tenantId, taskId, revision],
      )
    )[0];
    if (!row) return null;
    const refs = await q.all<{ ref_kind: string; ref_id: string }>(
      "SELECT ref_kind,ref_id FROM task_version_refs WHERE tenant_id=? AND task_id=? AND revision=? ORDER BY ref_kind,ordinal",
      [tenantId, taskId, revision],
    );
    return {
      ...row,
      revision: safeInteger(row.revision, "事项修订"),
      run_requested: safeInteger(row.run_requested, "执行轮次"),
      every_seconds:
        row.every_seconds === null
          ? null
          : safeInteger(row.every_seconds, "执行周期"),
      result_ids: refs
        .filter((ref) => ref.ref_kind === "result")
        .map((ref) => ref.ref_id),
      depends_on_ids: refs
        .filter((ref) => ref.ref_kind === "dependency")
        .map((ref) => ref.ref_id),
      watch_source_ids: refs
        .filter((ref) => ref.ref_kind === "watch_source")
        .map((ref) => ref.ref_id),
    };
  }

  /** Read the exact heads selected by one task page in two bounded queries.
   * The page and versions share one read snapshot on both backends. */
  private async attachTaskHeads(
    q: Query,
    tenantId: string,
    rows: Array<Omit<TaskListRow, "head_version">>,
  ): Promise<TaskListRow[]> {
    if (!rows.length) return [];
    const selected = `WITH selected(task_id,revision) AS (VALUES ${rows.map(() => "(?,CAST(? AS BIGINT))").join(",")})`;
    const parameters: Scalar[] = rows.flatMap((row) => [
      row.task_id,
      row.revision,
    ]);
    const versions = await q.all<
      Omit<
        TaskVersionRow,
        "result_ids" | "depends_on_ids" | "watch_source_ids"
      > &
        Row
    >(
      `${selected} SELECT v.* FROM selected s JOIN task_versions v ON v.tenant_id=? AND v.task_id=s.task_id AND v.revision=s.revision`,
      [...parameters, tenantId],
    );
    if (versions.length !== rows.length)
      throw new Error("事项目录与当前版本不一致，请重试。");
    const references = await q.all<{
      task_id: string;
      revision: number | string;
      ref_kind: string;
      ref_id: string;
    }>(
      `${selected} SELECT r.task_id,r.revision,r.ref_kind,r.ref_id FROM selected s JOIN task_version_refs r ON r.tenant_id=? AND r.task_id=s.task_id AND r.revision=s.revision ORDER BY r.task_id,r.revision,r.ref_kind,r.ordinal`,
      [...parameters, tenantId],
    );
    const key = (taskId: string, revision: number) =>
      `${taskId}\u0000${revision}`;
    const refs = new Map<
      string,
      Pick<TaskVersionRow, "result_ids" | "depends_on_ids" | "watch_source_ids">
    >();
    for (const ref of references) {
      const id = key(ref.task_id, safeInteger(ref.revision, "事项修订"));
      let entry = refs.get(id);
      if (!entry) {
        entry = { result_ids: [], depends_on_ids: [], watch_source_ids: [] };
        refs.set(id, entry);
      }
      if (ref.ref_kind === "result") entry.result_ids.push(ref.ref_id);
      else if (ref.ref_kind === "dependency")
        entry.depends_on_ids.push(ref.ref_id);
      else if (ref.ref_kind === "watch_source")
        entry.watch_source_ids.push(ref.ref_id);
      else throw new Error("事项版本引用类型无效。");
    }
    const heads = new Map<string, TaskVersionRow>();
    for (const version of versions) {
      const revision = safeInteger(version.revision, "事项修订");
      const id = key(version.task_id, revision);
      if (heads.has(id)) throw new Error("事项目录包含重复版本。");
      heads.set(id, {
        ...version,
        revision,
        run_requested: safeInteger(version.run_requested, "执行轮次"),
        every_seconds:
          version.every_seconds === null
            ? null
            : safeInteger(version.every_seconds, "执行周期"),
        ...(refs.get(id) ?? {
          result_ids: [],
          depends_on_ids: [],
          watch_source_ids: [],
        }),
      });
    }
    return rows.map((row) => {
      const head = heads.get(key(row.task_id, row.revision));
      if (
        !head ||
        head.title !== row.title ||
        (head.project_id !== null && head.project_id !== row.project_id)
      )
        throw new Error("事项目录与当前版本不一致，请重试。");
      return { ...row, head_version: head };
    });
  }

  async createProject(
    access: PlatformActor,
    request: {
      commandId: string;
      projectId: string;
      title: string;
      now?: string;
    },
  ): Promise<string> {
    const actor = await this.authorize(access);
    requireId(actor.tenantId, "租户标识");
    requireId(actor.principalId, "身份标识");
    requireId(request.commandId, "操作标识");
    requireId(request.projectId, "项目标识");
    requireTitle(request.title);
    if ("kind" in request)
      throw new PlatformStorageError(
        "invalid",
        "内置空间不能通过创建项目命令建立。",
      );
    const hash = fingerprint({ actor, ...request, now: undefined });
    const now = request.now ?? new Date().toISOString();
    if (actor.kind === "human") {
      const prior = await this.priorReceipt(actor, request.commandId, hash);
      if (prior) return prior;
    }
    const agent = await this.capabilities.resolveProjectAgent({
      tenantId: actor.tenantId,
    });
    if (!agent)
      throw new PlatformStorageError(
        "forbidden",
        "Morphz Agent 身份未获确认。",
      );
    requireId(agent.principalId, "Agent 主体标识");
    requireId(agent.actantId, "Agent 参与者标识");
    if (agent.principalId === actor.principalId)
      throw new PlatformStorageError(
        "invalid",
        "Agent 与发起用户不能共用主体。",
      );
    if (actor.kind === "agent" && actor.actantId !== agent.actantId)
      throw new PlatformStorageError(
        "forbidden",
        "只有当前 Morphz Agent 可代表用户创建项目。",
      );
    return this.transaction(async (q) => {
      const earlier = await this.replay(q, actor, request.commandId, hash);
      if (actor.kind === "agent")
        await this.assertMember(q, actor, actor.scopeProjectId!);
      if (earlier) return earlier;
      await q.change(
        "INSERT INTO projects(tenant_id,project_id,kind,owner_principal_id,title,revision,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)",
        [
          actor.tenantId,
          request.projectId,
          "project",
          actor.principalId,
          request.title,
          now,
          now,
        ],
      );
      for (const principalId of [actor.principalId, agent.principalId])
        await q.change(
          "INSERT INTO project_members(tenant_id,project_id,principal_id,joined_at) VALUES(?,?,?,?)",
          [actor.tenantId, request.projectId, principalId, now],
        );
      await q.change(
        "INSERT INTO conversations(tenant_id,conversation_id,project_id,kind,title,revision,created_at,updated_at) VALUES(?,?,?,'default',?,1,?,?)",
        [
          actor.tenantId,
          request.projectId,
          request.projectId,
          "默认对话",
          now,
          now,
        ],
      );
      await this.receipt(
        q,
        actor,
        request.commandId,
        hash,
        "create-project",
        request.projectId,
        now,
      );
      return request.projectId;
    });
  }

  async createTask(
    access: PlatformActor,
    request: {
      commandId: string;
      taskId: string;
      projectId: string;
      title: string;
      description?: string;
      assigneeId: string;
      modelId?: string | null;
      reasoningEffort?: "none" | "low" | "medium" | "high" | "max" | null;
      notBefore?: string | null;
      everySeconds?: number | null;
      dueDate?: string;
      resultIds?: string[];
      dependsOnIds?: string[];
      watchSourceIds?: string[];
      now?: string;
    },
  ): Promise<string> {
    const actor = await this.authorize(access);
    for (const value of [
      actor.tenantId,
      actor.principalId,
      request.commandId,
      request.taskId,
      request.projectId,
      request.assigneeId,
    ])
      requireId(value, "事项标识");
    requireTitle(request.title);
    if (
      (request.description?.length ?? 0) > 30_000 ||
      !validTaskAgentSettings(request) ||
      (request.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(request.dueDate))
    )
      throw new PlatformStorageError("invalid", "事项描述或日期无效。");
    const now = request.now ?? new Date().toISOString();
    const hash = fingerprint({ actor, ...request, now: undefined });
    const prior = await this.priorReceipt(actor, request.commandId, hash);
    if (prior) return prior;
    const assignee = await this.capabilities.resolveActant({
      tenantId: actor.tenantId,
      actantId: request.assigneeId,
    });
    if (!assignee)
      throw new PlatformStorageError("forbidden", "负责人身份未获确认。");
    if (
      assignee.kind !== "agent" &&
      (request.modelId != null ||
        request.reasoningEffort != null ||
        request.notBefore != null ||
        request.everySeconds != null)
    )
      throw new PlatformStorageError(
        "invalid",
        "人工事项不能设置 Agent 执行模型或时间。",
      );
    return this.transaction(async (q) => {
      const earlier = await this.replay(q, actor, request.commandId, hash);
      if (earlier) return earlier;
      await this.assertMember(q, actor, request.projectId);
      const membership = await q.all(
        "SELECT 1 AS assigned FROM project_members WHERE tenant_id=? AND project_id=? AND principal_id=?",
        [actor.tenantId, request.projectId, assignee.principalId],
      );
      if (!membership.length)
        throw new PlatformStorageError("forbidden", "负责人不在这个项目中。");
      const refs = {
        resultIds: request.resultIds ?? [],
        dependsOnIds: request.dependsOnIds ?? [],
        watchSourceIds: request.watchSourceIds ?? [],
      };
      await this.validateTaskReferences(
        q,
        actor.tenantId,
        request.projectId,
        request.taskId,
        refs,
      );
      const orderHead = (
        await q.all<{ revision: number | string }>(
          `SELECT revision FROM task_order_heads WHERE tenant_id=?${this.backend.kind === "postgres" ? " FOR UPDATE" : ""}`,
          [actor.tenantId],
        )
      )[0];
      if (!orderHead)
        throw new PlatformStorageError("not_found", "事项列表不存在。");
      const rank = (
        await q.all<{ max_rank: number | string | null }>(
          "SELECT MAX(order_rank) AS max_rank FROM tasks WHERE tenant_id=?",
          [actor.tenantId],
        )
      )[0]?.max_rank;
      const nextRank = Number(rank ?? 0) + 1024;
      if (!Number.isSafeInteger(nextRank))
        throw new PlatformStorageError("conflict", "事项顺序已达到范围上限。");
      await q.change(
        "INSERT INTO tasks(tenant_id,task_id,project_id,title,description,assignee_id,execution,due_date,order_rank,revision,created_by_principal_id,created_by_actant_id,origin_conversation_id,origin_project_id,source_body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
          actor.tenantId,
          request.taskId,
          request.projectId,
          request.title,
          request.description ?? "",
          request.assigneeId,
          "planned",
          request.dueDate ?? null,
          nextRank,
          1,
          actor.principalId,
          actor.actantId,
          null,
          null,
          null,
          now,
          now,
        ],
      );
      await this.insertTaskVersion(q, actor.tenantId, {
        task_id: request.taskId,
        revision: 1,
        project_id: request.projectId,
        title: request.title,
        description: request.description ?? "",
        assignee_id: request.assigneeId,
        model_id: request.modelId ?? null,
        reasoning_effort: request.reasoningEffort ?? null,
        legacy_priority: "normal",
        due_date: request.dueDate ?? null,
        assignment: "proposed",
        execution: "planned",
        delivery: "none",
        run_requested: 0,
        not_before: request.notBefore ?? null,
        every_seconds: request.everySeconds ?? null,
        author_principal_id: actor.principalId,
        author_actant_id: actor.actantId,
        created_at: now,
        result_ids: refs.resultIds,
        depends_on_ids: refs.dependsOnIds,
        watch_source_ids: refs.watchSourceIds,
      });
      await q.change(
        "UPDATE task_order_heads SET revision=revision+1 WHERE tenant_id=?",
        [actor.tenantId],
      );
      await this.receipt(
        q,
        actor,
        request.commandId,
        hash,
        "create-task",
        request.taskId,
        now,
      );
      return request.taskId;
    });
  }

  /** Only the trusted Host calls this after persisting the exact first input
   * in Runtime's outbox. The receipt binds the navigation record to that input;
   * Platform owns no copy of the message body or Runtime Session.
   */
  async startConversation(
    access: PlatformActor,
    request: {
      commandId: string;
      conversationId: string;
      projectId: string;
      title: string;
      inputFingerprint: string;
      now?: string;
    },
  ): Promise<string> {
    const actor = await this.authorize(access);
    if (actor.kind !== "human")
      throw new PlatformStorageError("forbidden", "只有用户可以开始项目对话。");
    for (const value of [
      request.commandId,
      request.conversationId,
      request.projectId,
    ])
      requireId(value, "对话标识");
    requireTitle(request.title);
    if (!/^[a-f0-9]{64}$/.test(request.inputFingerprint))
      throw new PlatformStorageError("invalid", "首条消息摘要无效。");
    if (request.conversationId === request.projectId)
      throw new PlatformStorageError("invalid", "新对话需要独立标识。");
    const hash = fingerprint({ actor, ...request, now: undefined });
    const now = request.now ?? new Date().toISOString();
    return this.transaction(async (q) => {
      const earlier = await this.replay(q, actor, request.commandId, hash);
      await this.assertMember(q, actor, request.projectId);
      if (earlier) return earlier;
      const project = (
        await q.all<{ kind: string }>(
          "SELECT kind FROM projects WHERE tenant_id=? AND project_id=?",
          [actor.tenantId, request.projectId],
        )
      )[0];
      if (project?.kind !== "project")
        throw new PlatformStorageError(
          "forbidden",
          "只能在项目内开始命名对话。",
        );
      if (this.backend.kind === "postgres")
        await q.all(
          "SELECT pg_advisory_xact_lock(hashtextextended(?, 0)) AS locked",
          [`${actor.tenantId}:conversation:${request.conversationId}`],
        );
      const used = await q.all(
        "SELECT 1 AS used FROM projects WHERE tenant_id=? AND project_id=? UNION ALL SELECT 1 AS used FROM conversations WHERE tenant_id=? AND conversation_id=?",
        [
          actor.tenantId,
          request.conversationId,
          actor.tenantId,
          request.conversationId,
        ],
      );
      if (used.length)
        throw new PlatformStorageError("conflict", "对话标识已经被使用。");
      await q.change(
        "INSERT INTO conversations(tenant_id,conversation_id,project_id,kind,title,revision,created_at,updated_at) VALUES(?,?,?,'named',?,1,?,?)",
        [
          actor.tenantId,
          request.conversationId,
          request.projectId,
          request.title,
          now,
          now,
        ],
      );
      await this.receipt(
        q,
        actor,
        request.commandId,
        hash,
        "start-conversation",
        request.conversationId,
        now,
        request.commandId,
      );
      return request.conversationId;
    });
  }

  /** Rename/archive an existing navigation record; Runtime messages remain untouched. */
  async updateConversation(
    access: PlatformActor,
    request: {
      commandId: string;
      conversationId: string;
      expectedRevision: number;
      title?: string;
      archived?: boolean;
      now?: string;
    },
  ): Promise<string> {
    const actor = await this.authorize(access);
    requireId(request.commandId, "操作标识");
    requireId(request.conversationId, "对话标识");
    if (
      !Number.isSafeInteger(request.expectedRevision) ||
      request.expectedRevision < 1 ||
      (request.title === undefined && request.archived === undefined) ||
      (request.title !== undefined && typeof request.title !== "string") ||
      (request.archived !== undefined && typeof request.archived !== "boolean")
    )
      throw new PlatformStorageError("invalid", "对话修改参数无效。");
    if (request.title !== undefined) requireTitle(request.title);
    const hash = fingerprint({ actor, ...request, now: undefined });
    const now = request.now ?? new Date().toISOString();
    return this.transaction(async (q) => {
      const earlier = await this.replay(q, actor, request.commandId, hash);
      if (earlier) return earlier;
      const current = (
        await q.all<ConversationRow & Row>(
          "SELECT conversation_id,project_id,kind,title,revision,archived_at FROM conversations WHERE tenant_id=? AND conversation_id=?",
          [actor.tenantId, request.conversationId],
        )
      )[0];
      if (!current) throw new PlatformStorageError("not_found", "对话不存在。");
      await this.assertMember(q, actor, current.project_id);
      if (
        safeInteger(current.revision, "对话修订") !== request.expectedRevision
      )
        throw new PlatformStorageError(
          "conflict",
          "对话已经更新，请重新读取。",
        );
      if (current.kind === "default" && request.archived === true)
        throw new PlatformStorageError("forbidden", "默认对话不能归档。");
      const changed = await q.change(
        "UPDATE conversations SET title=?,archived_at=?,revision=revision+1,updated_at=? WHERE tenant_id=? AND conversation_id=? AND revision=?",
        [
          request.title ?? current.title,
          request.archived === undefined
            ? current.archived_at
            : request.archived
              ? now
              : null,
          now,
          actor.tenantId,
          request.conversationId,
          request.expectedRevision,
        ],
      );
      if (changed !== 1)
        throw new PlatformStorageError(
          "conflict",
          "对话已经更新，请重新读取。",
        );
      await this.receipt(
        q,
        actor,
        request.commandId,
        hash,
        "update-conversation",
        request.conversationId,
        now,
      );
      return request.conversationId;
    });
  }

  /** Project-scoped navigation metadata, not Runtime messages or Sessions. */
  async listConversations(
    access: PlatformActor,
    projectId: string,
    options: {
      archived?: boolean;
      limit?: number;
      after?: { updatedAt: string; conversationId: string };
    } = {},
  ): Promise<ConversationRow[]> {
    const actor = await this.authorize(access);
    requireId(projectId, "项目标识");
    const limit = options.limit ?? 50;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (options.archived !== undefined && typeof options.archived !== "boolean")
    )
      throw new PlatformStorageError("invalid", "分页大小无效。");
    return this.transaction(async (q) => {
      await this.assertProjectReader(q, actor, projectId);
      const values: Scalar[] = [actor.tenantId, projectId];
      let cursor = "";
      if (options.after) {
        if (
          typeof options.after.updatedAt !== "string" ||
          typeof options.after.conversationId !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(
            options.after.updatedAt,
          ) ||
          options.after.updatedAt.length > 64 ||
          Number.isNaN(Date.parse(options.after.updatedAt))
        )
          throw new PlatformStorageError("invalid", "游标时间无效。");
        requireId(options.after.conversationId, "游标标识");
        cursor = " AND (updated_at<? OR (updated_at=? AND conversation_id>?))";
        values.push(
          options.after.updatedAt,
          options.after.updatedAt,
          options.after.conversationId,
        );
      }
      values.push(limit);
      const rows = await q.all<ConversationRow & Row>(
        `SELECT conversation_id,project_id,kind,title,revision,created_at,updated_at,archived_at FROM conversations WHERE tenant_id=? AND project_id=? AND archived_at IS ${options.archived ? "NOT NULL" : "NULL"}${cursor} ORDER BY updated_at DESC,conversation_id LIMIT ?`,
        values,
      );
      return rows.map((row) => ({
        ...row,
        revision: safeInteger(row.revision, "对话修订"),
      }));
    }, "read");
  }

  /** One authorized navigation page across projects. This avoids a request
   * per project when the existing sidebar renders all named conversations. */
  async listAccessibleConversations(
    access: PlatformActor,
    options: {
      limit?: number;
      after?: { updatedAt: string; conversationId: string };
    } = {},
  ): Promise<ConversationRow[]> {
    const actor = await this.authorize(access);
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new PlatformStorageError("invalid", "分页大小无效。");
    const values: Scalar[] = [actor.tenantId, actor.principalId];
    const conditions = [
      "c.tenant_id=?",
      "m.principal_id=?",
      "p.deleted_at IS NULL",
    ];
    if (actor.kind === "agent") {
      conditions.push("c.project_id=?");
      values.push(actor.scopeProjectId!);
    }
    if (options.after) {
      if (
        typeof options.after.updatedAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(
          options.after.updatedAt,
        ) ||
        options.after.updatedAt.length > 64 ||
        Number.isNaN(Date.parse(options.after.updatedAt))
      )
        throw new PlatformStorageError("invalid", "游标时间无效。");
      requireId(options.after.conversationId, "游标对话标识");
      conditions.push(
        "(c.updated_at<? OR (c.updated_at=? AND c.conversation_id>?))",
      );
      values.push(
        options.after.updatedAt,
        options.after.updatedAt,
        options.after.conversationId,
      );
    }
    values.push(limit);
    return this.transaction(async (q) => {
      if (actor.kind === "agent")
        await this.assertProjectReader(q, actor, actor.scopeProjectId!);
      const rows = await q.all<ConversationRow & Row>(
        `SELECT c.conversation_id,c.project_id,c.kind,c.title,c.revision,c.created_at,c.updated_at,c.archived_at FROM conversations c JOIN projects p ON p.tenant_id=c.tenant_id AND p.project_id=c.project_id JOIN project_members m ON m.tenant_id=c.tenant_id AND m.project_id=c.project_id WHERE ${conditions.join(" AND ")} ORDER BY c.updated_at DESC,c.conversation_id LIMIT ?`,
        values,
      );
      return rows.map((row) => ({
        ...row,
        revision: safeInteger(row.revision, "对话修订"),
      }));
    }, "read");
  }

  /** Counts for navigation and project cards. Aggregate under the same live
   * membership and active-project scope as listAccessibleTasks; no task body
   * or arbitrary caller-supplied principal is returned. */
  async taskCounts(access: PlatformActor): Promise<TaskCountSummary[]> {
    const actor = await this.authorize(access);
    return this.transaction(async (q) => {
      if (actor.kind === "agent") {
        if (!actor.scopeProjectId)
          throw new PlatformStorageError(
            "forbidden",
            "Agent 缺少原始输入的项目范围。",
          );
        await this.assertMember(q, actor, actor.scopeProjectId, false);
      }
      const scoped = actor.kind === "agent" ? " AND t.project_id=?" : "";
      const rows = await q.all<
        {
          project_id: string;
          total_count: number | string;
          pending_count: number | string;
          mine_open_count: number | string;
          latest_activity_at: string;
        } & Row
      >(
        `SELECT t.project_id,COUNT(*) AS total_count,
          SUM(CASE WHEN t.execution NOT IN ('completed','cancelled') THEN 1 ELSE 0 END) AS pending_count,
          SUM(CASE WHEN t.assignee_id=? AND t.execution NOT IN ('completed','cancelled') THEN 1 ELSE 0 END) AS mine_open_count,
          MAX(t.updated_at) AS latest_activity_at
        FROM tasks t JOIN project_members m ON m.tenant_id=t.tenant_id AND m.project_id=t.project_id
          JOIN projects p ON p.tenant_id=t.tenant_id AND p.project_id=t.project_id
        WHERE t.tenant_id=? AND m.principal_id=? AND t.deleted_at IS NULL
          AND p.archived_at IS NULL AND p.deleted_at IS NULL${scoped}
        GROUP BY t.project_id ORDER BY t.project_id`,
        [
          actor.actantId,
          actor.tenantId,
          actor.principalId,
          ...(actor.kind === "agent" ? [actor.scopeProjectId!] : []),
        ],
      );
      return rows.map((row) => ({
        projectId: row.project_id,
        total: safeInteger(row.total_count, "事项总数"),
        pending: safeInteger(row.pending_count, "待推进事项数"),
        mineOpen: safeInteger(row.mine_open_count, "本人未完成事项数"),
        latestActivityAt: row.latest_activity_at,
      }));
    }, "read");
  }

  /** Resolve a single current task after navigation or from a message link,
   * without enumerating the entire task directory. */
  async taskHead(access: PlatformActor, taskId: string): Promise<TaskListRow> {
    const actor = await this.authorize(access);
    requireId(taskId, "事项标识");
    return this.transaction(async (q) => {
      const row = (
        await q.all<Omit<TaskListRow, "head_version"> & Row>(
          "SELECT task_id,project_id,title,description,assignee_id,execution,due_date,order_rank,revision,updated_at,created_by_principal_id,created_by_actant_id,created_at FROM tasks WHERE tenant_id=? AND task_id=? AND deleted_at IS NULL",
          [actor.tenantId, taskId],
        )
      )[0];
      if (!row) throw new PlatformStorageError("not_found", "事项不存在。");
      await this.assertProjectReader(q, actor, row.project_id);
      const [head] = await this.attachTaskHeads(q, actor.tenantId, [
        {
          ...row,
          order_rank: safeInteger(row.order_rank, "事项顺序"),
          revision: safeInteger(row.revision, "事项修订"),
        },
      ]);
      if (!head) throw new PlatformStorageError("not_found", "事项不存在。");
      return head;
    }, "read");
  }

  async listTasks(
    access: PlatformActor,
    projectId: string,
    options: {
      limit?: number;
      after?: { orderRank: number; taskId: string };
    } & TaskListFilter = {},
  ): Promise<TaskListRow[]> {
    const actor = await this.authorize(access);
    requireId(projectId, "项目标识");
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new PlatformStorageError("invalid", "分页大小无效。");
    const filter = await this.taskListFilter(actor, options);
    return this.transaction(async (q) => {
      await this.assertProjectReader(q, actor, projectId);
      const values: Scalar[] = [actor.tenantId, projectId, ...filter.values];
      let cursor = "";
      if (options.after) {
        requireId(options.after.taskId, "游标标识");
        if (!Number.isSafeInteger(options.after.orderRank))
          throw new PlatformStorageError("invalid", "游标顺序无效。");
        cursor = " AND (t.order_rank>? OR (t.order_rank=? AND t.task_id>?))";
        values.push(
          options.after.orderRank,
          options.after.orderRank,
          options.after.taskId,
        );
      }
      values.push(limit);
      const rows = await q.all<Omit<TaskListRow, "head_version"> & Row>(
        `SELECT t.task_id,t.project_id,t.title,t.description,t.assignee_id,t.execution,t.due_date,t.order_rank,t.revision,t.updated_at,t.created_by_principal_id,t.created_by_actant_id,t.created_at FROM tasks t JOIN projects p ON p.tenant_id=t.tenant_id AND p.project_id=t.project_id WHERE t.tenant_id=? AND t.project_id=? AND t.deleted_at IS NULL${filter.sql}${cursor} ORDER BY t.order_rank,t.task_id LIMIT ?`,
        values,
      );
      const page = rows.map((row) => ({
        ...row,
        order_rank: safeInteger(row.order_rank, "事项顺序"),
        revision: safeInteger(row.revision, "事项修订"),
      }));
      return this.attachTaskHeads(q, actor.tenantId, page);
    }, "read");
  }

  /** The daily task view spans every active project the Human can currently
   * access. Agent reads stay bound to the persisted input's one project.
   * This uses the same tenant-wide order as project-scoped task views rather
   * than grouping results by project or loading a workspace snapshot.
   */
  async listAccessibleTasks(
    access: PlatformActor,
    options: {
      limit?: number;
      after?: { orderRank: number; taskId: string };
    } & TaskListFilter = {},
  ): Promise<TaskListRow[]> {
    const actor = await this.authorize(access);
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new PlatformStorageError("invalid", "分页大小无效。");
    const filter = await this.taskListFilter(actor, options);
    const values: Scalar[] = [
      actor.tenantId,
      actor.principalId,
      ...filter.values,
    ];
    const conditions = [
      "t.tenant_id=?",
      "m.principal_id=?",
      "t.deleted_at IS NULL",
      "p.archived_at IS NULL",
      "p.deleted_at IS NULL",
      ...filter.conditions,
    ];
    if (actor.kind === "agent") {
      if (!actor.scopeProjectId)
        throw new PlatformStorageError(
          "forbidden",
          "Agent 缺少原始输入的项目范围。",
        );
      conditions.push("t.project_id=?");
      values.push(actor.scopeProjectId);
    }
    if (options.after) {
      requireId(options.after.taskId, "游标标识");
      if (!Number.isSafeInteger(options.after.orderRank))
        throw new PlatformStorageError("invalid", "游标顺序无效。");
      conditions.push("(t.order_rank>? OR (t.order_rank=? AND t.task_id>?))");
      values.push(
        options.after.orderRank,
        options.after.orderRank,
        options.after.taskId,
      );
    }
    values.push(limit);
    return this.transaction(async (q) => {
      if (actor.kind === "agent")
        await this.assertMember(q, actor, actor.scopeProjectId!, false);
      const rows = await q.all<Omit<TaskListRow, "head_version"> & Row>(
        `SELECT t.task_id,t.project_id,t.title,t.description,t.assignee_id,t.execution,t.due_date,t.order_rank,t.revision,t.updated_at,t.created_by_principal_id,t.created_by_actant_id,t.created_at FROM tasks t JOIN project_members m ON m.tenant_id=t.tenant_id AND m.project_id=t.project_id JOIN projects p ON p.tenant_id=t.tenant_id AND p.project_id=t.project_id WHERE ${conditions.join(" AND ")} ORDER BY t.order_rank,t.task_id LIMIT ?`,
        values,
      );
      const page = rows.map((row) => ({
        ...row,
        order_rank: safeInteger(row.order_rank, "事项顺序"),
        revision: safeInteger(row.revision, "事项修订"),
      }));
      return this.attachTaskHeads(q, actor.tenantId, page);
    }, "read");
  }

  private async taskListFilter(
    actor: ResolvedActor,
    options: TaskListFilter,
  ): Promise<{ sql: string; conditions: string[]; values: Scalar[] }> {
    const owner = options.owner ?? "all";
    if (!["mine", "human", "agent", "all"].includes(owner))
      throw new PlatformStorageError("invalid", "负责人筛选无效。");
    if (
      options.query !== undefined &&
      (typeof options.query !== "string" || options.query.length > 200)
    )
      throw new PlatformStorageError("invalid", "事项搜索词无效。");
    const conditions: string[] = [];
    const values: Scalar[] = [];
    if (owner === "mine") {
      conditions.push("t.assignee_id=?");
      values.push(actor.actantId);
    } else if (owner === "human") {
      const humanActantId =
        actor.kind === "agent" ? actor.initiatingHumanActantId : actor.actantId;
      if (!humanActantId)
        throw new PlatformStorageError("forbidden", "原始 Human 身份不可用。");
      conditions.push("t.assignee_id=?");
      values.push(humanActantId);
    } else if (owner === "agent") {
      const agent = await this.capabilities.resolveProjectAgent({
        tenantId: actor.tenantId,
      });
      if (agent) {
        conditions.push("t.assignee_id=?");
        values.push(agent.actantId);
      } else {
        conditions.push("1=0");
      }
    }
    for (const word of (options.query ?? "")
      .trim()
      .toLocaleLowerCase()
      .split(/\s+/)
      .filter(Boolean)) {
      conditions.push(
        "LOWER(t.title || ' ' || t.description || ' ' || p.title) LIKE ? ESCAPE '\\'",
      );
      values.push(`%${word.replace(/[\\%_]/g, "\\$&")}%`);
    }
    return {
      sql: conditions.length ? ` AND ${conditions.join(" AND ")}` : "",
      conditions,
      values,
    };
  }

  async taskVersion(
    access: PlatformActor,
    taskId: string,
    revision?: number,
  ): Promise<TaskVersionRow> {
    const actor = await this.authorize(access);
    requireId(taskId, "事项标识");
    if (
      revision !== undefined &&
      (!Number.isSafeInteger(revision) || revision < 1)
    )
      throw new PlatformStorageError("invalid", "事项修订号无效。");
    return this.transaction(async (q) => {
      const task = (
        await q.all<{ project_id: string; revision: number | string }>(
          "SELECT project_id,revision FROM tasks WHERE tenant_id=? AND task_id=? AND deleted_at IS NULL",
          [actor.tenantId, taskId],
        )
      )[0];
      if (!task) throw new PlatformStorageError("not_found", "事项不存在。");
      await this.assertProjectReader(q, actor, task.project_id);
      const selected = revision ?? safeInteger(task.revision, "事项修订");
      const row = await this.loadTaskVersion(
        q,
        actor.tenantId,
        taskId,
        selected,
      );
      if (!row) throw new PlatformStorageError("not_found", "事项版本不存在。");
      return row;
    }, "read");
  }

  /** Bounded immutable history for one authorized task. The Client must not
   * reconstruct it with one request per revision or read the old workspace. */
  async listTaskVersions(
    access: PlatformActor,
    taskId: string,
    options: { limit?: number; beforeRevision?: number } = {},
  ): Promise<TaskVersionRow[]> {
    const actor = await this.authorize(access);
    requireId(taskId, "事项标识");
    const limit = options.limit ?? 50;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (options.beforeRevision !== undefined &&
        (!Number.isSafeInteger(options.beforeRevision) ||
          options.beforeRevision < 1))
    )
      throw new PlatformStorageError("invalid", "事项版本查询参数无效。");
    return this.transaction(async (q) => {
      const task = (
        await q.all<{ project_id: string }>(
          "SELECT project_id FROM tasks WHERE tenant_id=? AND task_id=? AND deleted_at IS NULL",
          [actor.tenantId, taskId],
        )
      )[0];
      if (!task) throw new PlatformStorageError("not_found", "事项不存在。");
      await this.assertProjectReader(q, actor, task.project_id);
      const revisions = await q.all<{ revision: number | string }>(
        `SELECT revision FROM task_versions WHERE tenant_id=? AND task_id=?${options.beforeRevision === undefined ? "" : " AND revision<?"} ORDER BY revision DESC LIMIT ?`,
        [
          actor.tenantId,
          taskId,
          ...(options.beforeRevision === undefined
            ? []
            : [options.beforeRevision]),
          limit,
        ],
      );
      const versions: TaskVersionRow[] = [];
      for (const item of revisions) {
        const version = await this.loadTaskVersion(
          q,
          actor.tenantId,
          taskId,
          safeInteger(item.revision, "事项修订"),
        );
        if (!version) throw new Error("事项版本在读取期间消失。");
        versions.push(version);
      }
      return versions;
    }, "read");
  }

  async reviseTask(
    access: PlatformActor,
    request: {
      commandId: string;
      taskId: string;
      expectedRevision: number;
      title?: string;
      description?: string;
      dueDate?: string | null;
      projectId?: string;
      assigneeId?: string;
      assignment?: "proposed" | "accepted" | "declined";
      modelId?: string | null;
      reasoningEffort?: "none" | "low" | "medium" | "high" | "max" | null;
      notBefore?: string | null;
      everySeconds?: number | null;
      execution?: "planned" | "active" | "waiting" | "completed" | "cancelled";
      resultIds?: string[];
      dependsOnIds?: string[];
      watchSourceIds?: string[];
      now?: string;
    },
    inspectRuntime?: (
      runtime: TaskRunLink["runtime"],
    ) => Promise<PriorRuntimeObservation>,
  ): Promise<string> {
    const actor = await this.authorize(access);
    requireId(request.commandId, "操作标识");
    requireId(request.taskId, "事项标识");
    if (
      !Number.isSafeInteger(request.expectedRevision) ||
      request.expectedRevision < 1 ||
      (request.title === undefined &&
        request.description === undefined &&
        request.dueDate === undefined &&
        request.projectId === undefined &&
        request.assigneeId === undefined &&
        request.assignment === undefined &&
        request.modelId === undefined &&
        request.reasoningEffort === undefined &&
        request.notBefore === undefined &&
        request.everySeconds === undefined &&
        request.execution === undefined &&
        request.resultIds === undefined &&
        request.dependsOnIds === undefined &&
        request.watchSourceIds === undefined)
    )
      throw new PlatformStorageError("invalid", "事项修改无效。");
    if (request.title !== undefined) requireTitle(request.title);
    if (
      (request.description?.length ?? 0) > 30_000 ||
      !validTaskAgentSettings(request) ||
      (request.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(request.dueDate)) ||
      (request.assignment !== undefined &&
        !["proposed", "accepted", "declined"].includes(request.assignment)) ||
      (request.execution !== undefined &&
        !["planned", "active", "waiting", "completed", "cancelled"].includes(
          request.execution,
        ))
    )
      throw new PlatformStorageError("invalid", "事项描述或日期无效。");
    if (request.projectId !== undefined)
      requireId(request.projectId, "目标项目标识");
    if (request.assigneeId !== undefined)
      requireId(request.assigneeId, "负责人标识");
    const assignee =
      request.assigneeId === undefined
        ? null
        : await this.capabilities.resolveActant({
            tenantId: actor.tenantId,
            actantId: request.assigneeId,
          });
    if (request.assigneeId !== undefined && !assignee)
      throw new PlatformStorageError("forbidden", "负责人身份未获确认。");
    const hash = fingerprint({ actor, ...request, now: undefined });
    const now = request.now ?? new Date().toISOString();
    // Runtime is authoritative for execution, not the task's board column.
    // Read outside the write lock; the exact admission/control binding is
    // checked again in the mutation transaction before changing its owner.
    const selected =
      request.assigneeId !== undefined || request.projectId !== undefined
        ? await this.transaction(async (q) => {
            const earlier = await this.replay(
              q,
              actor,
              request.commandId,
              hash,
            );
            if (earlier) return { earlier, execution: null };
            const task = (
              await q.all<{
                project_id: string;
                assignee_id: string;
                revision: number | string;
              }>(
                "SELECT project_id,assignee_id,revision FROM tasks WHERE tenant_id=? AND task_id=? AND deleted_at IS NULL",
                [actor.tenantId, request.taskId],
              )
            )[0];
            if (!task)
              throw new PlatformStorageError("not_found", "事项不存在。");
            await this.assertMember(q, actor, task.project_id, false);
            if (Number(task.revision) !== request.expectedRevision)
              throw new PlatformStorageError(
                "conflict",
                "事项已变化，请查看最新版本。",
              );
            return {
              earlier: null,
              execution:
                (request.assigneeId !== undefined &&
                  request.assigneeId !== task.assignee_id) ||
                (request.projectId !== undefined &&
                  request.projectId !== task.project_id)
                  ? await this.taskReassignmentExecution(
                      q,
                      actor,
                      request.taskId,
                      request.expectedRevision,
                    )
                  : null,
            };
          }, "read")
        : null;
    if (selected?.earlier) return selected.earlier;
    const observed =
      selected?.execution?.runtime && !selected.execution.confirmedStopped
        ? inspectRuntime
          ? await inspectRuntime(selected.execution.runtime)
          : null
        : null;
    const currentActor = selected?.execution
      ? await this.authorize(access)
      : actor;
    if (fingerprint(currentActor) !== fingerprint(actor))
      throw new PlatformStorageError(
        "forbidden",
        "核对执行期间操作身份已变化。",
      );
    return this.transaction(async (q) => {
      const earlier = await this.replay(q, actor, request.commandId, hash);
      if (earlier) return earlier;
      const current = (
        await q.all<TaskRow & Row>(
          `SELECT task_id,project_id,title,description,assignee_id,execution,due_date,revision FROM tasks WHERE tenant_id=? AND task_id=? AND deleted_at IS NULL${this.backend.kind === "postgres" ? " FOR UPDATE" : ""}`,
          [actor.tenantId, request.taskId],
        )
      )[0];
      if (!current) throw new PlatformStorageError("not_found", "事项不存在。");
      const targetProjectId = request.projectId ?? current.project_id;
      if (targetProjectId !== current.project_id)
        await this.lockProjectAudiences(q, actor.tenantId, [
          current.project_id,
          targetProjectId,
        ]);
      await this.assertMember(q, actor, current.project_id);
      if (targetProjectId !== current.project_id) {
        if (this.backend.kind === "postgres")
          await q.all(
            "SELECT pg_advisory_xact_lock(hashtextextended(?, 0)) AS locked",
            [`${actor.tenantId}:task-graph:${current.project_id}`],
          );
        await this.assertMember(q, actor, targetProjectId, true, false);
        const target = (
          await q.all<{ kind: string }>(
            "SELECT kind FROM projects WHERE tenant_id=? AND project_id=? AND archived_at IS NULL AND deleted_at IS NULL",
            [actor.tenantId, targetProjectId],
          )
        )[0];
        if (!target || !["project", "inbox"].includes(target.kind))
          throw new PlatformStorageError("invalid", "请选择项目或无项目。");
        const members = await q.all<{
          project_id: string;
          principal_id: string;
        }>(
          `SELECT project_id,principal_id FROM project_members WHERE tenant_id=? AND project_id IN (?,?) ORDER BY project_id,principal_id${this.backend.kind === "postgres" ? " FOR SHARE" : ""}`,
          [actor.tenantId, current.project_id, targetProjectId],
        );
        const audience = (projectId: string) =>
          members
            .filter((row) => row.project_id === projectId)
            .map((row) => row.principal_id);
        if (
          JSON.stringify(audience(current.project_id)) !==
          JSON.stringify(audience(targetProjectId))
        )
          throw new PlatformStorageError(
            "forbidden",
            "两个项目的访问成员不同，不能直接移动事项及其历史。",
          );
        const linked = await q.all(
          "SELECT 1 AS linked FROM task_version_refs WHERE tenant_id=? AND ((task_id=? AND revision=?) OR ref_id=?) LIMIT 1",
          [
            actor.tenantId,
            request.taskId,
            request.expectedRevision,
            request.taskId,
          ],
        );
        if (linked.length)
          throw new PlatformStorageError(
            "conflict",
            "此事项已有项目内关联或执行记录，请先处理关联再移动。",
          );
      }
      if (assignee) {
        const member = await q.all(
          "SELECT 1 AS assigned FROM project_members WHERE tenant_id=? AND project_id=? AND principal_id=?",
          [actor.tenantId, targetProjectId, assignee.principalId],
        );
        if (!member.length)
          throw new PlatformStorageError("forbidden", "负责人不在这个项目中。");
      }
      if (Number(current.revision) !== request.expectedRevision)
        throw new PlatformStorageError(
          "conflict",
          "事项已变化，请查看最新版本。",
        );
      const previous = await this.loadTaskVersion(
        q,
        actor.tenantId,
        request.taskId,
        request.expectedRevision,
      );
      if (!previous) throw new Error("事项当前版本缺失，拒绝覆盖。");
      const assigneeChanged =
        request.assigneeId !== undefined &&
        request.assigneeId !== current.assignee_id;
      const nextAssignee =
        assignee ??
        (await this.capabilities.resolveActant({
          tenantId: actor.tenantId,
          actantId: current.assignee_id,
        }));
      if (!nextAssignee)
        throw new PlatformStorageError("forbidden", "负责人身份未获确认。");
      if (assigneeChanged || targetProjectId !== current.project_id) {
        const execution = await this.taskReassignmentExecution(
          q,
          actor,
          request.taskId,
          request.expectedRevision,
          true,
        );
        if (fingerprint(execution) !== fingerprint(selected?.execution))
          throw new PlatformStorageError(
            "conflict",
            "核对期间执行状态已变化，请刷新后操作。",
          );
        const terminal =
          observed?.source === "runtime" &&
          fingerprint(observed.runtime) === fingerprint(execution.runtime) &&
          ["completed", "failed", "cancelled"].includes(
            observed.thread.lifecycle,
          ) &&
          ["completed", "cancelled"].includes(observed.schedule.status);
        if (
          execution.pendingControl ||
          execution.sourceWatchOpen ||
          execution.pendingAdmission ||
          (execution.requested &&
            !execution.withdrawn &&
            !execution.confirmedStopped &&
            !terminal) ||
          (execution.runtime && !execution.confirmedStopped && !terminal) ||
          (!execution.requested &&
            !execution.runtime &&
            ["active", "waiting"].includes(current.execution))
        )
          throw new PlatformStorageError(
            "conflict",
            "事项执行尚未确认结束，请先停止执行再更换负责人或项目。",
          );
      }
      const nextAssigneeId = request.assigneeId ?? current.assignee_id;
      if (
        previous.execution !== current.execution ||
        previous.assignee_id !== current.assignee_id
      )
        throw new Error("事项当前版本与索引不一致，拒绝覆盖。");
      const nextExecution =
        request.execution ?? (assigneeChanged ? "planned" : previous.execution);
      const nextModelId =
        request.modelId === undefined
          ? assigneeChanged
            ? null
            : previous.model_id
          : request.modelId;
      const nextReasoningEffort =
        request.reasoningEffort === undefined
          ? assigneeChanged
            ? null
            : previous.reasoning_effort
          : request.reasoningEffort;
      const nextNotBefore =
        request.notBefore === undefined
          ? assigneeChanged
            ? null
            : previous.not_before
          : request.notBefore;
      const nextEverySeconds =
        request.everySeconds === undefined
          ? assigneeChanged
            ? null
            : previous.every_seconds
          : request.everySeconds;
      const refs = {
        resultIds: request.resultIds ?? previous.result_ids,
        dependsOnIds: request.dependsOnIds ?? previous.depends_on_ids,
        watchSourceIds: request.watchSourceIds ?? previous.watch_source_ids,
      };
      if (
        request.resultIds !== undefined ||
        request.dependsOnIds !== undefined ||
        request.watchSourceIds !== undefined
      )
        await this.validateTaskReferences(
          q,
          actor.tenantId,
          targetProjectId,
          request.taskId,
          refs,
        );
      if (previous.delivery !== "none" && refs.resultIds.length === 0)
        throw new PlatformStorageError("invalid", "交付事项需要保留关联产物。");
      if (
        nextAssignee.kind !== "agent" &&
        (nextModelId !== null ||
          nextReasoningEffort !== null ||
          nextNotBefore !== null ||
          nextEverySeconds !== null)
      )
        throw new PlatformStorageError(
          "invalid",
          "人工事项不能设置 Agent 执行模型或时间。",
        );
      if (
        !assigneeChanged &&
        targetProjectId === current.project_id &&
        ["active", "waiting"].includes(current.execution) &&
        (nextModelId !== previous.model_id ||
          nextReasoningEffort !== previous.reasoning_effort ||
          nextNotBefore !== previous.not_before ||
          nextEverySeconds !== previous.every_seconds)
      )
        throw new PlatformStorageError(
          "conflict",
          "事项已有执行在途，请先停止执行再修改安排。",
        );
      const executionChanged =
        request.execution !== undefined &&
        request.execution !==
          (assigneeChanged ? "planned" : previous.execution);
      if (executionChanged) {
        await this.assertTaskExecutionTransition(
          q,
          actor,
          previous,
          nextAssigneeId,
          nextExecution,
        );
      }
      const nextAssignment =
        request.assignment ??
        (assigneeChanged || executionChanged
          ? "accepted"
          : previous.assignment);
      if (
        request.assignment !== undefined &&
        nextAssignment !== previous.assignment &&
        !assigneeChanged &&
        (previous.run_requested > 0 ||
          ["active", "waiting"].includes(previous.execution))
      )
        throw new PlatformStorageError(
          "conflict",
          "事项已有执行在途，不能修改分派状态。",
        );
      if (
        nextAssignment !== "accepted" &&
        ["active", "waiting", "completed"].includes(nextExecution)
      )
        throw new PlatformStorageError(
          "invalid",
          "进行中或已完成的事项必须是已接受状态。",
        );
      const changed = await q.change(
        "UPDATE tasks SET project_id=?,title=?,description=?,assignee_id=?,execution=?,due_date=?,origin_project_id=CASE WHEN project_id<>? THEN COALESCE(origin_project_id,project_id) ELSE origin_project_id END,revision=revision+1,updated_at=? WHERE tenant_id=? AND task_id=? AND revision=?",
        [
          targetProjectId,
          request.title ?? current.title,
          request.description ?? current.description,
          nextAssigneeId,
          nextExecution,
          request.dueDate === undefined ? current.due_date : request.dueDate,
          targetProjectId,
          now,
          actor.tenantId,
          request.taskId,
          request.expectedRevision,
        ],
      );
      if (changed !== 1)
        throw new PlatformStorageError(
          "conflict",
          "事项已变化，请查看最新版本。",
        );
      await this.insertTaskVersion(q, actor.tenantId, {
        ...previous,
        revision: request.expectedRevision + 1,
        project_id: targetProjectId,
        title: request.title ?? previous.title,
        description: request.description ?? previous.description,
        assignee_id: nextAssigneeId,
        model_id: nextModelId,
        reasoning_effort: nextReasoningEffort,
        due_date:
          request.dueDate === undefined ? previous.due_date : request.dueDate,
        assignment: nextAssignment,
        execution: nextExecution,
        run_requested: assigneeChanged ? 0 : previous.run_requested,
        not_before: nextNotBefore,
        every_seconds: nextEverySeconds,
        result_ids: refs.resultIds,
        depends_on_ids: refs.dependsOnIds,
        watch_source_ids: refs.watchSourceIds,
        author_principal_id: actor.principalId,
        author_actant_id: actor.actantId,
        created_at: now,
      });
      await this.receipt(
        q,
        actor,
        request.commandId,
        hash,
        "revise-task",
        request.taskId,
        now,
      );
      return request.taskId;
    });
  }

  /** Host-local stop flags are not Runtime terminal evidence. Only a committed
   * stop confirmation or a fresh terminal Runtime read permits reassignment.
   * The task row is already locked by the caller before this write-side read. */
  private async taskReassignmentExecution(
    q: Query,
    actor: ResolvedActor,
    taskId: string,
    revision: number,
    forWrite = false,
  ) {
    const version = await this.loadTaskVersion(
      q,
      actor.tenantId,
      taskId,
      revision,
    );
    if (!version) throw new Error("事项当前版本缺失，拒绝改派。");
    const run = version.run_requested;
    const withdrawn =
      run > 0 &&
      (
        await q.all(
          "SELECT 1 AS withdrawn FROM outbox WHERE tenant_id=? AND event_id=? AND event_kind='task.run_withdrawn'",
          [
            actor.tenantId,
            `task_stop_${fingerprint([actor.tenantId, taskId, run]).slice(0, 40)}`,
          ],
        )
      ).length > 0;
    const link = (
      await q.all<{
        run_number: number | string;
        runtime_session_id: string;
        runtime_schedule_id: string;
        runtime_thread_id: string;
        bridge_source_stopped: number | string;
        bridge_stop_requested: number | string;
        bridge_control_revision: number | string;
        bridge_control_pending: string | null;
        observed_schedule_status: string;
        observed_schedule_interval_seconds: number | string | null;
        observed_thread_status: string | null;
      }>(
        `SELECT run_number,runtime_session_id,runtime_schedule_id,runtime_thread_id,bridge_source_stopped,bridge_stop_requested,bridge_control_revision,bridge_control_pending,observed_schedule_status,observed_schedule_interval_seconds,observed_thread_status FROM task_run_links WHERE tenant_id=? AND task_id=? ORDER BY run_number DESC LIMIT 1${forWrite && this.backend.kind === "postgres" ? " FOR UPDATE" : ""}`,
        [actor.tenantId, taskId],
      )
    )[0];
    const pendingControl =
      !!link &&
      (Number(link.bridge_stop_requested) === 1 ||
        link.bridge_control_pending !== null);
    const confirmedStopped =
      !!link &&
      !pendingControl &&
      Number(link.bridge_source_stopped) === 1 &&
      ["completed", "failed", "cancelled"].includes(
        link.observed_thread_status ?? "",
      ) &&
      (["completed", "cancelled"].includes(link.observed_schedule_status) ||
        (link.observed_schedule_status === "dispatched" &&
          link.observed_schedule_interval_seconds === null));
    const sourceWatchOpen =
      !!link &&
      (await this.taskRunSourceWatchOpen(
        q,
        actor.tenantId,
        taskId,
        Number(link.run_number),
        Number(link.bridge_source_stopped) === 1,
      ));
    return {
      requested: run > 0,
      withdrawn,
      pendingAdmission:
        run > 0 && !withdrawn && (!link || Number(link.run_number) !== run),
      runtime: link
        ? {
            sessionId: link.runtime_session_id,
            scheduleId: link.runtime_schedule_id,
            threadId: link.runtime_thread_id,
          }
        : null,
      runNumber: link ? Number(link.run_number) : run,
      controlRevision: link ? Number(link.bridge_control_revision) : 0,
      pendingControl,
      sourceWatchOpen,
      confirmedStopped,
    };
  }

  /** The immutable admitted watch survives terminal original Threads and
   * edits to the task's current reference list. The existing stop channel
   * confirms all accepted/unknown source roots before releasing this fence. */
  private async taskRunSourceWatchOpen(
    q: Query,
    tenantId: string,
    taskId: string,
    runNumber: number,
    sourceStopped: boolean,
  ) {
    return (
      !sourceStopped &&
      (
        await q.all(
          "SELECT 1 AS watched FROM task_run_watch_sources WHERE tenant_id=? AND task_id=? AND run_number=? LIMIT 1",
          [tenantId, taskId, runNumber],
        )
      ).length > 0
    );
  }

  private async assertTaskExecutionTransition(
    q: Query,
    actor: ResolvedActor,
    previous: TaskVersionRow,
    assigneeId: string,
    execution: string,
  ) {
    if (actor.kind !== "human")
      throw new PlatformStorageError(
        "forbidden",
        "只能直接移动自己的事项；Morphz 的进度由实际执行更新。",
      );
    if (assigneeId !== actor.actantId) {
      if (execution !== "cancelled")
        throw new PlatformStorageError(
          "forbidden",
          "只能直接移动自己的事项；Morphz 的进度由实际执行更新。",
        );
      const assigned = await this.capabilities.resolveActant({
        tenantId: actor.tenantId,
        actantId: assigneeId,
      });
      if (
        assigned?.kind !== "agent" ||
        previous.execution !== "planned" ||
        previous.run_requested !== 0
      )
        throw new PlatformStorageError(
          "forbidden",
          "只能取消尚未开始的 Agent 事项；执行中请先停止。",
        );
    }
    if (execution === "completed") {
      const downstream = await q.all(
        "SELECT 1 AS linked FROM tasks t JOIN task_version_refs r ON r.tenant_id=t.tenant_id AND r.task_id=t.task_id AND r.revision=t.revision WHERE t.tenant_id=? AND t.deleted_at IS NULL AND t.execution NOT IN ('completed','cancelled') AND r.ref_kind='dependency' AND r.ref_id=? LIMIT 1",
        [actor.tenantId, previous.task_id],
      );
      if (downstream.length)
        throw new PlatformStorageError(
          "invalid",
          "此事项关联后续工作，请提交结果并完成。",
        );
    }
  }

  /** A Human assignee's response completes this exact task revision. It is
   * neither an Agent execution result nor a free-standing chat message.
   */
  async respondTask(
    access: PlatformActor,
    request: {
      commandId: string;
      taskId: string;
      expectedRevision: number;
      body: string;
      now?: string;
    },
  ): Promise<string> {
    const actor = await this.authorize(access);
    requireId(request.commandId, "操作标识");
    requireId(request.taskId, "事项标识");
    if (
      !Number.isSafeInteger(request.expectedRevision) ||
      request.expectedRevision < 1 ||
      typeof request.body !== "string" ||
      !request.body.trim() ||
      request.body.trim().length > 30_000
    )
      throw new PlatformStorageError("invalid", "事项回应无效。");
    await this.assertHumanTaskActor(actor);
    const body = request.body.trim();
    const hash = fingerprint({
      actor,
      commandId: request.commandId,
      taskId: request.taskId,
      expectedRevision: request.expectedRevision,
      body,
    });
    const now = request.now ?? new Date().toISOString();
    return this.transaction(async (q) => {
      const earlier = await this.replay(q, actor, request.commandId, hash);
      if (earlier) return earlier;
      const scope = (
        await q.all<{ project_id: string }>(
          "SELECT project_id FROM tasks WHERE tenant_id=? AND task_id=? AND deleted_at IS NULL",
          [actor.tenantId, request.taskId],
        )
      )[0];
      if (!scope) throw new PlatformStorageError("not_found", "事项不存在。");
      await this.assertMember(q, actor, scope.project_id);
      const current = (
        await q.all<{
          project_id: string;
          assignee_id: string;
          execution: string;
          revision: number | string;
        }>(
          `SELECT project_id,assignee_id,execution,revision FROM tasks WHERE tenant_id=? AND task_id=? AND deleted_at IS NULL${this.backend.kind === "postgres" ? " FOR UPDATE" : ""}`,
          [actor.tenantId, request.taskId],
        )
      )[0];
      if (!current) throw new PlatformStorageError("not_found", "事项不存在。");
      if (current.project_id !== scope.project_id)
        throw new PlatformStorageError("conflict", "事项所属项目已变化。");
      if (current.assignee_id !== actor.actantId)
        throw new PlatformStorageError(
          "forbidden",
          "只有当前负责人可以回应这件事项。",
        );
      if (
        safeInteger(current.revision, "事项修订") !== request.expectedRevision
      )
        throw new PlatformStorageError(
          "conflict",
          "事项已变化，请查看当前版本后操作。",
        );
      if (["completed", "cancelled"].includes(current.execution))
        throw new PlatformStorageError("conflict", "该事项已结束。");
      const previous = await this.loadTaskVersion(
        q,
        actor.tenantId,
        request.taskId,
        request.expectedRevision,
      );
      if (!previous) throw new Error("事项当前版本缺失，拒绝回应。");
      const changed = await q.change(
        "UPDATE tasks SET execution='completed',revision=revision+1,updated_at=? WHERE tenant_id=? AND task_id=? AND revision=? AND assignee_id=? AND execution NOT IN ('completed','cancelled')",
        [
          now,
          actor.tenantId,
          request.taskId,
          request.expectedRevision,
          actor.actantId,
        ],
      );
      if (changed !== 1)
        throw new PlatformStorageError(
          "conflict",
          "事项已变化，请查看当前版本后操作。",
        );
      await this.insertTaskVersion(q, actor.tenantId, {
        ...previous,
        revision: request.expectedRevision + 1,
        assignment: "accepted",
        execution: "completed",
        author_principal_id: actor.principalId,
        author_actant_id: actor.actantId,
        created_at: now,
      });
      await q.change(
        "INSERT INTO task_responses(tenant_id,response_id,task_id,task_revision,body,author_principal_id,author_actant_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
        [
          actor.tenantId,
          request.commandId,
          request.taskId,
          request.expectedRevision,
          body,
          actor.principalId,
          actor.actantId,
          now,
        ],
      );
      await this.receipt(
        q,
        actor,
        request.commandId,
        hash,
        "respond-task",
        request.taskId,
        now,
      );
      return request.taskId;
    });
  }

  /** Explicit Human completion/reopen keeps existing responses as history.
   * It does not create a response or claim an Agent run has finished.
   */
  async setTaskCompleted(
    access: PlatformActor,
    request: {
      commandId: string;
      taskId: string;
      expectedRevision: number;
      completed: boolean;
      now?: string;
    },
  ): Promise<string> {
    const actor = await this.authorize(access);
    requireId(request.commandId, "操作标识");
    requireId(request.taskId, "事项标识");
    if (
      !Number.isSafeInteger(request.expectedRevision) ||
      request.expectedRevision < 1 ||
      typeof request.completed !== "boolean"
    )
      throw new PlatformStorageError("invalid", "事项完成状态无效。");
    await this.assertHumanTaskActor(actor);
    const hash = fingerprint({ actor, ...request, now: undefined });
    const now = request.now ?? new Date().toISOString();
    return this.transaction(async (q) => {
      const earlier = await this.replay(q, actor, request.commandId, hash);
      if (earlier) return earlier;
      const scope = (
        await q.all<{ project_id: string }>(
          "SELECT project_id FROM tasks WHERE tenant_id=? AND task_id=? AND deleted_at IS NULL",
          [actor.tenantId, request.taskId],
        )
      )[0];
      if (!scope) throw new PlatformStorageError("not_found", "事项不存在。");
      await this.assertMember(q, actor, scope.project_id);
      const current = (
        await q.all<{
          project_id: string;
          assignee_id: string;
          execution: string;
          revision: number | string;
        }>(
          `SELECT project_id,assignee_id,execution,revision FROM tasks WHERE tenant_id=? AND task_id=? AND deleted_at IS NULL${this.backend.kind === "postgres" ? " FOR UPDATE" : ""}`,
          [actor.tenantId, request.taskId],
        )
      )[0];
      if (!current) throw new PlatformStorageError("not_found", "事项不存在。");
      if (current.project_id !== scope.project_id)
        throw new PlatformStorageError("conflict", "事项所属项目已变化。");
      if (current.assignee_id !== actor.actantId)
        throw new PlatformStorageError(
          "forbidden",
          "只有当前负责人可以操作这件事项。",
        );
      if (
        safeInteger(current.revision, "事项修订") !== request.expectedRevision
      )
        throw new PlatformStorageError(
          "conflict",
          "事项已变化，请查看当前版本后操作。",
        );
      if (current.execution === "cancelled")
        throw new PlatformStorageError(
          "conflict",
          "该事项已取消，请先重新安排。",
        );
      if ((current.execution === "completed") === request.completed)
        throw new PlatformStorageError(
          "conflict",
          "事项状态已变化，请查看当前版本后操作。",
        );
      if (request.completed) {
        const dependent = await q.all(
          "SELECT 1 AS present FROM tasks t JOIN task_version_refs r ON r.tenant_id=t.tenant_id AND r.task_id=t.task_id AND r.revision=t.revision WHERE t.tenant_id=? AND t.deleted_at IS NULL AND t.execution NOT IN ('completed','cancelled') AND r.ref_kind='dependency' AND r.ref_id=? LIMIT 1",
          [actor.tenantId, request.taskId],
        );
        if (dependent.length)
          throw new PlatformStorageError(
            "invalid",
            "此事项关联后续工作，请提交结果并完成。",
          );
      }
      const previous = await this.loadTaskVersion(
        q,
        actor.tenantId,
        request.taskId,
        request.expectedRevision,
      );
      if (!previous) throw new Error("事项当前版本缺失，拒绝更改状态。");
      const nextExecution = request.completed ? "completed" : "planned";
      const changed = await q.change(
        "UPDATE tasks SET execution=?,revision=revision+1,updated_at=? WHERE tenant_id=? AND task_id=? AND revision=? AND assignee_id=?",
        [
          nextExecution,
          now,
          actor.tenantId,
          request.taskId,
          request.expectedRevision,
          actor.actantId,
        ],
      );
      if (changed !== 1)
        throw new PlatformStorageError(
          "conflict",
          "事项已变化，请查看当前版本后操作。",
        );
      await this.insertTaskVersion(q, actor.tenantId, {
        ...previous,
        revision: request.expectedRevision + 1,
        assignment: request.completed ? "accepted" : previous.assignment,
        execution: nextExecution,
        author_principal_id: actor.principalId,
        author_actant_id: actor.actantId,
        created_at: now,
      });
      await this.receipt(
        q,
        actor,
        request.commandId,
        hash,
        "set-task-completed",
        request.taskId,
        now,
      );
      return request.taskId;
    });
  }

  async listTaskResponses(
    access: PlatformActor,
    taskId: string,
    options: {
      limit?: number;
      after?: { createdAt: string; responseId: string };
      responseId?: string;
    } = {},
  ): Promise<TaskResponseRow[]> {
    const actor = await this.authorize(access);
    requireId(taskId, "事项标识");
    const limit = options.limit ?? 50;
    if (options.responseId !== undefined)
      requireId(options.responseId, "答复标识");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new PlatformStorageError("invalid", "分页大小无效。");
    return this.transaction(async (q) => {
      const task = (
        await q.all<{ project_id: string }>(
          "SELECT project_id FROM tasks WHERE tenant_id=? AND task_id=? AND deleted_at IS NULL",
          [actor.tenantId, taskId],
        )
      )[0];
      if (!task) throw new PlatformStorageError("not_found", "事项不存在。");
      await this.assertProjectReader(q, actor, task.project_id);
      const values: Scalar[] = [actor.tenantId, taskId];
      let exact = "";
      if (options.responseId) {
        exact = " AND response_id=?";
        values.push(options.responseId);
      }
      let cursor = "";
      if (options.after) {
        if (
          typeof options.after.createdAt !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(
            options.after.createdAt,
          ) ||
          options.after.createdAt.length > 64 ||
          Number.isNaN(Date.parse(options.after.createdAt))
        )
          throw new PlatformStorageError("invalid", "游标时间无效。");
        requireId(options.after.responseId, "游标标识");
        cursor = " AND (created_at>? OR (created_at=? AND response_id>?))";
        values.push(
          options.after.createdAt,
          options.after.createdAt,
          options.after.responseId,
        );
      }
      values.push(limit);
      const rows = await q.all<TaskResponseRow & Row>(
        `SELECT response_id,task_id,task_revision,body,author_principal_id,author_actant_id,created_at FROM task_responses WHERE tenant_id=? AND task_id=?${exact}${cursor} ORDER BY created_at,response_id LIMIT ?`,
        values,
      );
      return rows.map((row) => ({
        ...row,
        task_revision: safeInteger(row.task_revision, "回应的事项修订"),
      }));
    }, "read");
  }

  async taskOrderRevision(
    access: PlatformActor,
    projectId?: string,
  ): Promise<number> {
    const actor = await this.authorize(access);
    if (projectId !== undefined) requireId(projectId, "项目标识");
    else if (actor.kind !== "human")
      throw new PlatformStorageError(
        "forbidden",
        "全局事项顺序只供当前用户读取。",
      );
    return this.transaction(async (q) => {
      if (projectId !== undefined) {
        await this.assertProjectReader(q, actor, projectId);
      } else {
        const membership = await q.all(
          "SELECT 1 AS allowed FROM project_members m JOIN projects p ON p.tenant_id=m.tenant_id AND p.project_id=m.project_id WHERE m.tenant_id=? AND m.principal_id=? AND p.archived_at IS NULL AND p.deleted_at IS NULL LIMIT 1",
          [actor.tenantId, actor.principalId],
        );
        if (!membership.length)
          throw new PlatformStorageError("forbidden", "没有可访问的事项空间。");
      }
      const row = (
        await q.all<{ revision: number | string }>(
          "SELECT revision FROM task_order_heads WHERE tenant_id=?",
          [actor.tenantId],
        )
      )[0];
      if (!row) throw new PlatformStorageError("not_found", "事项顺序不存在。");
      return safeInteger(row.revision, "事项顺序修订");
    }, "read");
  }

  /** Changes priority order only. It never starts or reschedules a task. */
  async reorderTask(
    access: PlatformActor,
    request: {
      commandId: string;
      /** Omit for the Human's cross-project task view. Agents remain scoped. */
      projectId?: string;
      taskId: string;
      beforeTaskId: string | null;
      expectedOrderRevision: number;
      now?: string;
    },
  ): Promise<string> {
    const actor = await this.authorize(access);
    for (const value of [
      actor.tenantId,
      actor.principalId,
      request.commandId,
      request.taskId,
    ])
      requireId(value, "事项顺序标识");
    if (request.projectId !== undefined)
      requireId(request.projectId, "项目标识");
    else if (actor.kind !== "human")
      throw new PlatformStorageError(
        "forbidden",
        "Agent 只能调整原始输入所属项目的事项。",
      );
    if (request.beforeTaskId) requireId(request.beforeTaskId, "目标事项标识");
    if (request.beforeTaskId === request.taskId)
      throw new PlatformStorageError("invalid", "不能将事项移动到自身之前。");
    if (
      !Number.isSafeInteger(request.expectedOrderRevision) ||
      request.expectedOrderRevision < 0
    )
      throw new PlatformStorageError("invalid", "事项顺序修订号无效。");
    const hash = fingerprint({ actor, ...request, now: undefined });
    const now = request.now ?? new Date().toISOString();
    return this.transaction(async (q) => {
      const earlier = await this.replay(q, actor, request.commandId, hash);
      if (earlier) return earlier;
      if (request.projectId !== undefined)
        await this.assertMember(q, actor, request.projectId);
      const head = (
        await q.all<{ revision: number | string }>(
          `SELECT revision FROM task_order_heads WHERE tenant_id=?${this.backend.kind === "postgres" ? " FOR UPDATE" : ""}`,
          [actor.tenantId],
        )
      )[0];
      if (!head || Number(head.revision) !== request.expectedOrderRevision)
        throw new PlatformStorageError(
          "conflict",
          "事项顺序已变化，请刷新后重试。",
        );
      const tasks = await q.all<{
        task_id: string;
        order_rank: number | string;
      }>(
        request.projectId !== undefined
          ? "SELECT task_id,order_rank FROM tasks WHERE tenant_id=? AND project_id=? AND deleted_at IS NULL ORDER BY order_rank,task_id"
          : "SELECT t.task_id,t.order_rank FROM tasks t JOIN project_members m ON m.tenant_id=t.tenant_id AND m.project_id=t.project_id JOIN projects p ON p.tenant_id=t.tenant_id AND p.project_id=t.project_id WHERE t.tenant_id=? AND m.principal_id=? AND t.deleted_at IS NULL AND p.archived_at IS NULL AND p.deleted_at IS NULL ORDER BY t.order_rank,t.task_id",
        [actor.tenantId, request.projectId ?? actor.principalId],
      );
      const item = tasks.find((task) => task.task_id === request.taskId);
      if (
        !item ||
        (request.beforeTaskId &&
          !tasks.some((task) => task.task_id === request.beforeTaskId))
      )
        throw new PlatformStorageError(
          "not_found",
          request.projectId === undefined
            ? "事项不在当前可访问的列表中。"
            : "事项不在这个项目中。",
        );
      const ordered = tasks.filter((task) => task.task_id !== request.taskId);
      const index =
        request.beforeTaskId === null
          ? ordered.length
          : ordered.findIndex((task) => task.task_id === request.beforeTaskId);
      ordered.splice(index, 0, item);
      // Permute only visible slots. A project filter cannot move other
      // projects; the Human's global view cannot change inaccessible tasks.
      const slots = tasks.map((task) =>
        safeInteger(task.order_rank, "事项顺序"),
      );
      for (const [position, task] of ordered.entries()) {
        const rank = slots[position]!;
        if (safeInteger(task.order_rank, "事项顺序") !== rank)
          await q.change(
            "UPDATE tasks SET order_rank=? WHERE tenant_id=? AND task_id=?",
            [rank, actor.tenantId, task.task_id],
          );
      }
      await q.change(
        "UPDATE task_order_heads SET revision=revision+1 WHERE tenant_id=? AND revision=?",
        [actor.tenantId, request.expectedOrderRevision],
      );
      await this.receipt(
        q,
        actor,
        request.commandId,
        hash,
        "reorder-task",
        request.taskId,
        now,
      );
      return request.taskId;
    });
  }

  /** Reorders exactly the selected visible slots; filtered-out tasks retain
   * both their rank and their relative position. Used by the existing list
   * and board drag operation, which sends the selected ordered IDs.
   */
  async reorderTaskSelection(
    access: PlatformActor,
    request: {
      commandId: string;
      projectId?: string;
      taskIds: string[];
      expectedOrderRevision: number;
      move?: {
        taskId: string;
        expectedRevision: number;
        execution: "planned" | "active" | "waiting" | "completed" | "cancelled";
      };
      now?: string;
    },
  ): Promise<string> {
    const actor = await this.authorize(access);
    requireId(request.commandId, "事项顺序命令");
    if (request.projectId !== undefined)
      requireId(request.projectId, "项目标识");
    else if (actor.kind !== "human")
      throw new PlatformStorageError(
        "forbidden",
        "Agent 只能调整原始输入所属项目的事项。",
      );
    if (
      request.taskIds.length < 1 ||
      request.taskIds.length > 500 ||
      new Set(request.taskIds).size !== request.taskIds.length
    )
      throw new PlatformStorageError(
        "invalid",
        "事项顺序不能为空、重复或超过 500 项。",
      );
    for (const taskId of request.taskIds) requireId(taskId, "事项标识");
    if (
      !Number.isSafeInteger(request.expectedOrderRevision) ||
      request.expectedOrderRevision < 0
    )
      throw new PlatformStorageError("invalid", "事项顺序修订号无效。");
    if (
      request.move &&
      (!request.taskIds.includes(request.move.taskId) ||
        !Number.isSafeInteger(request.move.expectedRevision) ||
        request.move.expectedRevision < 1 ||
        !["planned", "active", "waiting", "completed", "cancelled"].includes(
          request.move.execution,
        ))
    )
      throw new PlatformStorageError("invalid", "移动的事项、版本或状态无效。");
    const hash = fingerprint({ actor, ...request, now: undefined });
    const now = request.now ?? new Date().toISOString();
    return this.transaction(async (q) => {
      const earlier = await this.replay(q, actor, request.commandId, hash);
      if (earlier) return earlier;
      if (request.projectId !== undefined)
        await this.assertMember(q, actor, request.projectId);
      const head = (
        await q.all<{ revision: number | string }>(
          `SELECT revision FROM task_order_heads WHERE tenant_id=?${this.backend.kind === "postgres" ? " FOR UPDATE" : ""}`,
          [actor.tenantId],
        )
      )[0];
      if (!head || Number(head.revision) !== request.expectedOrderRevision)
        throw new PlatformStorageError(
          "conflict",
          "事项顺序已变化，请刷新后重试。",
        );
      const tasks = await q.all<{
        task_id: string;
        order_rank: number | string;
      }>(
        request.projectId !== undefined
          ? "SELECT task_id,order_rank FROM tasks WHERE tenant_id=? AND project_id=? AND deleted_at IS NULL ORDER BY order_rank,task_id"
          : "SELECT t.task_id,t.order_rank FROM tasks t JOIN project_members m ON m.tenant_id=t.tenant_id AND m.project_id=t.project_id JOIN projects p ON p.tenant_id=t.tenant_id AND p.project_id=t.project_id WHERE t.tenant_id=? AND m.principal_id=? AND t.deleted_at IS NULL AND p.archived_at IS NULL AND p.deleted_at IS NULL ORDER BY t.order_rank,t.task_id",
        [actor.tenantId, request.projectId ?? actor.principalId],
      );
      const visible = new Map(tasks.map((task) => [task.task_id, task]));
      if (request.taskIds.some((taskId) => !visible.has(taskId)))
        throw new PlatformStorageError(
          "not_found",
          "排序包含当前不可访问的事项。",
        );
      // A board drag is one command: status and visible-slot order either both
      // commit or both roll back. It cannot be split into two independent
      // receipts without leaving the UI in a partially moved state.
      if (request.move) {
        const move = request.move;
        const current = (
          await q.all<TaskRow & Row>(
            `SELECT task_id,project_id,title,description,assignee_id,execution,due_date,revision FROM tasks WHERE tenant_id=? AND task_id=? AND deleted_at IS NULL${this.backend.kind === "postgres" ? " FOR UPDATE" : ""}`,
            [actor.tenantId, move.taskId],
          )
        )[0];
        if (!current || !visible.has(move.taskId))
          throw new PlatformStorageError(
            "not_found",
            "移动的事项不在当前可访问的列表中。",
          );
        await this.assertMember(q, actor, current.project_id);
        if (safeInteger(current.revision, "事项修订") !== move.expectedRevision)
          throw new PlatformStorageError(
            "conflict",
            "事项已变化，请查看最新版本。",
          );
        const previous = await this.loadTaskVersion(
          q,
          actor.tenantId,
          move.taskId,
          move.expectedRevision,
        );
        if (
          !previous ||
          previous.execution !== current.execution ||
          previous.assignee_id !== current.assignee_id
        )
          throw new Error("事项当前版本与索引不一致，拒绝覆盖。");
        if (move.execution !== previous.execution) {
          await this.assertTaskExecutionTransition(
            q,
            actor,
            previous,
            current.assignee_id,
            move.execution,
          );
          const changed = await q.change(
            "UPDATE tasks SET execution=?,revision=revision+1,updated_at=? WHERE tenant_id=? AND task_id=? AND revision=?",
            [
              move.execution,
              now,
              actor.tenantId,
              move.taskId,
              move.expectedRevision,
            ],
          );
          if (changed !== 1)
            throw new PlatformStorageError(
              "conflict",
              "事项已变化，请查看最新版本。",
            );
          await this.insertTaskVersion(q, actor.tenantId, {
            ...previous,
            revision: move.expectedRevision + 1,
            assignment: "accepted",
            execution: move.execution,
            author_principal_id: actor.principalId,
            author_actant_id: actor.actantId,
            created_at: now,
          });
        }
      }
      const selected = new Set(request.taskIds);
      const slots = tasks.map((task) =>
        safeInteger(task.order_rank, "事项顺序"),
      );
      let nextSelected = 0;
      const reordered = tasks.map((task) =>
        selected.has(task.task_id)
          ? visible.get(request.taskIds[nextSelected++]!)!
          : task,
      );
      for (const [position, task] of reordered.entries()) {
        if (safeInteger(task.order_rank, "事项顺序") !== slots[position])
          await q.change(
            "UPDATE tasks SET order_rank=? WHERE tenant_id=? AND task_id=?",
            [slots[position]!, actor.tenantId, task.task_id],
          );
      }
      await q.change(
        "UPDATE task_order_heads SET revision=revision+1 WHERE tenant_id=? AND revision=?",
        [actor.tenantId, request.expectedOrderRevision],
      );
      await this.receipt(
        q,
        actor,
        request.commandId,
        hash,
        "reorder-task-selection",
        request.move?.taskId ?? request.taskIds[0]!,
        now,
      );
      return request.move?.taskId ?? request.taskIds[0]!;
    });
  }

  /** This Host only knows its configured embedded instances. Refuse a
   * deployment-ID change that would leave active originals without a route.
   */
  async assertEmbeddedInstanceCoverage(
    tenantId: string,
    expected: { objects: string; scriptStudio: string; reader: string },
  ) {
    requireId(tenantId, "租户标识");
    for (const value of Object.values(expected))
      requireId(value, "应用实例标识");
    return this.transaction(async (q) => {
      const unexpected = await q.all<{ app_id: string; instance_id: string }>(
        `SELECT app_id,instance_id FROM content_entries
         WHERE tenant_id=? AND deleted_at IS NULL AND (
           (app_id='morphz.objects' AND instance_id<>?) OR
           (app_id='morphz.script-studio' AND instance_id<>?) OR
           (app_id='morphz.reader' AND instance_id<>?)
         ) LIMIT 1`,
        [tenantId, expected.objects, expected.scriptStudio, expected.reader],
      );
      if (unexpected.length)
        throw new PlatformStorageError(
          "conflict",
          "目录中已有另一认知应用实例的原件；当前宿主没有该实例的路由，拒绝隐藏内容。",
        );
    }, "read");
  }

  /** Commit an executable UI package only after the trusted Host has published
   * and verified its immutable Store bytes. App professional data stays with
   * the App, and Platform keeps no executable body in a relational row.
   */
  async installUiPackage(
    access: PlatformActor,
    request: {
      commandId: string;
      header: UiPackageHeader;
      storeVersion: {
        storeId: string;
        artifactId: string;
        revision: number;
        sha256: string;
        byteLength: number;
      };
      now?: string;
    },
  ): Promise<string> {
    const actor = await this.authorize(access);
    if (actor.kind !== "human")
      throw new PlatformStorageError(
        "forbidden",
        "仅本人可以安装可执行界面包。",
      );
    requireId(request.commandId, "操作标识");
    const header = uiPackageHeaderSchema.parse(request.header);
    requireAppId(header.id);
    if (header.id.startsWith("morphz."))
      throw new PlatformStorageError("forbidden", "内置应用不可替换。");
    const version = request.storeVersion;
    requireId(version.storeId, "Store 标识");
    requireId(version.artifactId, "包字节标识");
    if (
      !Number.isSafeInteger(version.revision) ||
      version.revision !== 1 ||
      !/^[a-f0-9]{64}$/.test(version.sha256) ||
      !Number.isSafeInteger(version.byteLength) ||
      version.byteLength < 1 ||
      version.byteLength > 1_000_000
    )
      throw new PlatformStorageError("invalid", "安装包字节版本无效。");
    const manifestHeader = JSON.stringify(header);
    if (manifestHeader.length > 200_000)
      throw new PlatformStorageError("invalid", "安装包声明过大。");
    const hash = fingerprint({
      actor,
      commandId: request.commandId,
      header,
      storeVersion: version,
    });
    const result = `${header.id}@${header.version}`;
    const prior = await this.priorReceipt(actor, request.commandId, hash);
    if (prior) return prior;
    const installedAt = request.now ?? new Date().toISOString();
    return this.transaction(async (q) => {
      const replay = await this.replay(q, actor, request.commandId, hash);
      if (replay) return replay;
      const installationId = `install_ui_${fingerprint([actor.tenantId, header.id]).slice(0, 32)}`;
      const installation = await ensureApplicationInstallation(q, {
        tenantId: actor.tenantId,
        appId: header.id,
        proposedInstallationId: installationId,
        installedAt,
      });
      if (installation.state !== "active")
        throw new PlatformStorageError(
          "conflict",
          "应用安装状态已变化，不能覆盖。",
        );
      const existing = await q.all(
        "SELECT 1 AS present FROM app_ui_packages WHERE tenant_id=? AND app_id=? AND package_version=? LIMIT 1",
        [actor.tenantId, header.id, header.version],
      );
      if (existing.length)
        throw new PlatformStorageError(
          "conflict",
          "此应用版本已安装；修改后请使用新版本号。",
        );
      await q.change(
        "INSERT INTO app_ui_packages(tenant_id,app_id,package_version,installed_by_principal_id,manifest_header,store_id,artifact_id,artifact_revision,sha256,byte_length,installed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        [
          actor.tenantId,
          header.id,
          header.version,
          actor.principalId,
          manifestHeader,
          version.storeId,
          version.artifactId,
          version.revision,
          version.sha256,
          version.byteLength,
          installedAt,
        ],
      );
      await this.receipt(
        q,
        actor,
        request.commandId,
        hash,
        "install-ui-package",
        result,
        installedAt,
      );
      return result;
    });
  }

  /** Installation headers are scoped to the actual installer. A project tab
   * or a locally remembered window is never evidence of package authority.
   */
  async listUiPackages(access: PlatformActor): Promise<UiPackageVersion[]> {
    const actor = await this.authorize(access);
    return this.transaction(async (q) => {
      const rows = await q.all<{
        app_id: string;
        package_version: string;
        installed_by_principal_id: string;
        manifest_header: string;
        store_id: string;
        artifact_id: string;
        artifact_revision: number | string;
        sha256: string;
        byte_length: number | string;
        installed_at: string;
      }>(
        `SELECT p.app_id,p.package_version,p.installed_by_principal_id,p.manifest_header,
                p.store_id,p.artifact_id,p.artifact_revision,p.sha256,p.byte_length,p.installed_at
           FROM app_ui_packages p JOIN app_installations i
             ON i.tenant_id=p.tenant_id AND i.app_id=p.app_id
          WHERE p.tenant_id=? AND p.installed_by_principal_id=? AND i.state='active'
          ORDER BY p.installed_at,p.app_id,p.package_version LIMIT 101`,
        [actor.tenantId, actor.principalId],
      );
      if (rows.length > 100)
        throw new PlatformStorageError(
          "invalid",
          "已安装的界面包超过单页容量，需要分页读取。",
        );
      return rows.map((row) => ({
        appId: row.app_id,
        version: row.package_version,
        installedByPrincipalId: row.installed_by_principal_id,
        header: uiPackageHeaderSchema.parse(JSON.parse(row.manifest_header)),
        storeId: row.store_id,
        artifactId: row.artifact_id,
        artifactRevision: safeInteger(row.artifact_revision, "界面包版本"),
        sha256: row.sha256,
        byteLength: safeInteger(row.byte_length, "界面包字节数"),
        installedAt: row.installed_at,
      }));
    }, "read");
  }

  async uiPackage(
    access: PlatformActor,
    appId: string,
    version: string,
  ): Promise<UiPackageVersion> {
    requireAppId(appId);
    if (!/^\d+\.\d+\.\d+$/.test(version))
      throw new PlatformStorageError("invalid", "应用版本无效。");
    const actor = await this.authorize(access);
    const rows = await this.transaction(
      (q) =>
        q.all<{
          app_id: string;
          package_version: string;
          installed_by_principal_id: string;
          manifest_header: string;
          store_id: string;
          artifact_id: string;
          artifact_revision: number | string;
          sha256: string;
          byte_length: number | string;
          installed_at: string;
        }>(
          `SELECT p.app_id,p.package_version,p.installed_by_principal_id,p.manifest_header,
                  p.store_id,p.artifact_id,p.artifact_revision,p.sha256,p.byte_length,p.installed_at
             FROM app_ui_packages p JOIN app_installations i
               ON i.tenant_id=p.tenant_id AND i.app_id=p.app_id
            WHERE p.tenant_id=? AND p.installed_by_principal_id=?
              AND p.app_id=? AND p.package_version=? AND i.state='active'`,
          [actor.tenantId, actor.principalId, appId, version],
        ),
      "read",
    );
    const row = rows[0];
    if (!row)
      throw new PlatformStorageError("not_found", "应用包不存在或无权读取。");
    return {
      appId: row.app_id,
      version: row.package_version,
      installedByPrincipalId: row.installed_by_principal_id,
      header: uiPackageHeaderSchema.parse(JSON.parse(row.manifest_header)),
      storeId: row.store_id,
      artifactId: row.artifact_id,
      artifactRevision: safeInteger(row.artifact_revision, "界面包版本"),
      sha256: row.sha256,
      byteLength: safeInteger(row.byte_length, "界面包字节数"),
      installedAt: row.installed_at,
    };
  }

  /** Startup safety gate for a Host without the configured package Store. */
  async hasUiPackages(tenantId: string): Promise<boolean> {
    requireId(tenantId, "租户标识");
    return this.transaction(
      async (q) =>
        (
          await q.all(
            "SELECT 1 AS present FROM app_ui_packages WHERE tenant_id=? LIMIT 1",
            [tenantId],
          )
        ).length > 0,
      "read",
    );
  }

  /** Provisioning of an authenticated application service, not its data storage. */
  async registerApplication(
    tenantId: string,
    request: {
      appId: string;
      installationId: string;
      instanceId: string;
      routeRef: string;
      routeKind: "service" | "node";
      nodeId?: string;
      now?: string;
    },
  ) {
    requireAppId(request.appId);
    for (const [label, value] of [
      ["租户标识", tenantId],
      ["安装标识", request.installationId],
      ["实例标识", request.instanceId],
    ])
      requireId(value!, label!);
    if (!request.routeRef || request.routeRef.length > 1024)
      throw new PlatformStorageError("invalid", "应用路由无效。");
    if ((request.routeKind === "node") !== !!request.nodeId)
      throw new PlatformStorageError("invalid", "节点应用实例缺少节点标识。");
    if (request.nodeId) requireId(request.nodeId, "节点标识");
    const now = request.now ?? new Date().toISOString();
    await this.transaction(async (q) => {
      const installation = await ensureApplicationInstallation(q, {
        tenantId,
        appId: request.appId,
        proposedInstallationId: request.installationId,
        installedAt: now,
      });
      // Reserved builtins retain their exact Host provisioning identity. An
      // external application's UI and service reuse its first installation.
      if (
        installation.state !== "active" ||
        (request.appId.startsWith("morphz.") &&
          installation.installationId !== request.installationId)
      )
        throw new PlatformStorageError(
          "conflict",
          "应用安装记录与当前实例不一致。",
        );
      await q.change(
        "INSERT INTO app_instances(tenant_id,app_id,instance_id,route_kind,node_id,route_ref,revision,state,created_at) VALUES(?,?,?,?,?,?,1,'active',?) ON CONFLICT(tenant_id,instance_id) DO NOTHING",
        [
          tenantId,
          request.appId,
          request.instanceId,
          request.routeKind,
          request.nodeId ?? null,
          request.routeRef,
          now,
        ],
      );
      const instance = (
        await q.all<{
          app_id: string;
          route_kind: string;
          node_id: string | null;
          route_ref: string;
          state: string;
        }>(
          "SELECT app_id,route_kind,node_id,route_ref,state FROM app_instances WHERE tenant_id=? AND instance_id=?",
          [tenantId, request.instanceId],
        )
      )[0];
      if (
        instance?.app_id !== request.appId ||
        instance.route_kind !== request.routeKind ||
        instance.node_id !== (request.nodeId ?? null) ||
        instance.route_ref !== request.routeRef ||
        instance.state !== "active"
      )
        throw new PlatformStorageError(
          "conflict",
          "应用实例身份或路由与既有记录冲突。",
        );
    });
  }

  /** Reconnects a stable application data authority without reusing its identity. */
  async updateApplicationRoute(
    tenantId: string,
    request: {
      commandId: string;
      appId: string;
      instanceId: string;
      expectedRevision: number;
      routeRef: string;
      routeKind: "service" | "node";
      nodeId?: string;
    },
  ): Promise<number> {
    requireId(tenantId, "租户标识");
    requireId(request.commandId, "操作标识");
    requireAppId(request.appId);
    requireId(request.instanceId, "实例标识");
    if (
      !Number.isSafeInteger(request.expectedRevision) ||
      request.expectedRevision < 1
    )
      throw new PlatformStorageError("invalid", "应用实例修订无效。");
    if (
      !request.routeRef ||
      request.routeRef.length > 1024 ||
      (request.routeKind === "node") !== !!request.nodeId
    )
      throw new PlatformStorageError("invalid", "应用路由无效。");
    if (request.nodeId) requireId(request.nodeId, "节点标识");
    const actor: ResolvedActor = {
      tenantId,
      principalId: "platform-provisioner",
      actantId: "platform-provisioner",
      kind: "provider",
      runtimeInputId: null,
    };
    const hash = fingerprint({ actor, request });
    return this.transaction(async (q) => {
      const earlier = await this.replay(q, actor, request.commandId, hash);
      if (earlier) return safeInteger(earlier, "应用实例路由修订");
      const changed = await q.change(
        "UPDATE app_instances SET route_ref=?,route_kind=?,node_id=?,revision=revision+1 WHERE tenant_id=? AND app_id=? AND instance_id=? AND revision=? AND state='active'",
        [
          request.routeRef,
          request.routeKind,
          request.nodeId ?? null,
          tenantId,
          request.appId,
          request.instanceId,
          request.expectedRevision,
        ],
      );
      if (changed !== 1)
        throw new PlatformStorageError(
          "conflict",
          "应用实例路由已变化或不可用。",
        );
      await this.receipt(
        q,
        actor,
        request.commandId,
        hash,
        "update-application-route",
        String(request.expectedRevision + 1),
        new Date().toISOString(),
      );
      return request.expectedRevision + 1;
    });
  }

  async recordContent(
    access: PlatformActor,
    app: { instanceId: string; proof: string },
    request: {
      commandId: string;
      appReceiptId: string;
      contentId: string;
      objectId: string;
      projectId: string;
      kind: string;
      title: string;
      observedVersionRef: string;
      now?: string;
    },
  ): Promise<string> {
    return this.recordContentForActor(
      await this.authorize(access),
      true,
      app,
      request,
    );
  }

  /** Project only an already-committed App original. Membership was checked
   * by the App at its commit; revocation afterwards must not strand its
   * durable outbox. Reads still check current membership independently.
   */
  async recordCommittedContent(
    origin: CommittedAppOrigin,
    request: {
      objectId: string;
      projectId: string;
      kind: string;
      title: string;
      observedVersionRef: string;
      now?: string;
    },
  ): Promise<string> {
    const actor = this.committedAppActor(origin);
    return this.recordContentForActor(
      actor,
      false,
      { instanceId: origin.instanceId, proof: origin.receiptId },
      {
        commandId: `catalog_${fingerprint([
          origin.tenantId,
          origin.instanceId,
          origin.receiptId,
        ]).slice(0, 40)}`,
        appReceiptId: origin.receiptId,
        contentId: `content_${fingerprint([
          origin.tenantId,
          origin.instanceId,
          request.objectId,
        ]).slice(0, 40)}`,
        ...request,
      },
    );
  }

  private committedAppActor(origin: CommittedAppOrigin): ResolvedActor {
    for (const value of [
      origin.tenantId,
      origin.principalId,
      origin.actantId,
      origin.instanceId,
      origin.receiptId,
    ])
      requireId(value, "应用提交回执标识");
    if (origin.runtimeInputId !== null)
      requireId(origin.runtimeInputId, "应用提交输入标识");
    if (origin.runtimeTaskRunEventId)
      requireId(origin.runtimeTaskRunEventId, "应用提交事项执行标识");
    return {
      tenantId: origin.tenantId,
      principalId: origin.principalId,
      actantId: origin.actantId,
      runtimeInputId: origin.runtimeInputId,
      ...(origin.runtimeTaskRunEventId
        ? { committedTaskRunEventId: origin.runtimeTaskRunEventId }
        : {}),
      kind: "provider",
    };
  }

  private appTaskRunEventId(actor: ResolvedActor) {
    return (
      actor.runtimeTaskRun?.eventId ?? actor.committedTaskRunEventId ?? null
    );
  }

  private async recordContentForActor(
    actor: ResolvedActor,
    requireCurrentMember: boolean,
    app: { instanceId: string; proof: string },
    request: {
      commandId: string;
      appReceiptId: string;
      contentId: string;
      objectId: string;
      projectId: string;
      kind: string;
      title: string;
      observedVersionRef: string;
      now?: string;
    },
  ): Promise<string> {
    for (const value of [
      actor.tenantId,
      actor.principalId,
      app.instanceId,
      request.commandId,
      request.appReceiptId,
      request.contentId,
      request.objectId,
      request.projectId,
    ])
      requireId(value, "对象标识");
    requireTitle(request.title);
    if (
      !request.kind ||
      request.kind.length > 100 ||
      !request.observedVersionRef ||
      request.observedVersionRef.length > 200
    )
      throw new PlatformStorageError("invalid", "内容类型或版本无效。");
    const hash = fingerprint({
      origin: {
        tenantId: actor.tenantId,
        principalId: actor.principalId,
        actantId: actor.actantId,
        runtimeInputId: actor.runtimeInputId,
        ...(this.appTaskRunEventId(actor)
          ? { runtimeTaskRunEventId: this.appTaskRunEventId(actor) }
          : {}),
      },
      instanceId: app.instanceId,
      ...request,
      now: undefined,
    });
    const now = request.now ?? new Date().toISOString();
    const prior = await this.priorReceipt(actor, request.commandId, hash);
    if (prior) return prior;
    await this.transaction(async (q) => {
      if (requireCurrentMember)
        await this.assertMember(q, actor, request.projectId, false);
      await this.assertContentDestination(q, actor.tenantId, request.projectId);
      const instance = await q.all(
        "SELECT 1 AS active FROM app_instances WHERE tenant_id=? AND instance_id=? AND state='active'",
        [actor.tenantId, app.instanceId],
      );
      if (!instance.length)
        throw new PlatformStorageError("not_found", "应用实例不可用。");
    }, "read");
    if (
      !(await this.capabilities.verifyApplicationObject({
        tenantId: actor.tenantId,
        principalId: actor.principalId,
        actantId: actor.actantId,
        runtimeInputId: actor.runtimeInputId ?? null,
        runtimeTaskRunEventId: this.appTaskRunEventId(actor),
        instanceId: app.instanceId,
        objectId: request.objectId,
        versionRef: request.observedVersionRef,
        kind: request.kind,
        title: request.title,
        projectId: request.projectId,
        receiptId: request.appReceiptId,
        proof: app.proof,
      }))
    )
      throw new PlatformStorageError(
        "forbidden",
        "应用未确认此对象的提交回执。",
      );
    return this.transaction(async (q) => {
      if (this.backend.kind === "postgres")
        await q.all(
          "SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0)) AS locked",
          [`platform:${actor.tenantId}:${request.commandId}`],
        );
      const earlier = await this.replay(q, actor, request.commandId, hash);
      if (earlier) return earlier;
      if (requireCurrentMember)
        await this.assertMember(q, actor, request.projectId);
      await this.assertContentDestination(q, actor.tenantId, request.projectId);
      const instance = (
        await q.all<{ app_id: string }>(
          "SELECT app_id FROM app_instances WHERE tenant_id=? AND instance_id=? AND state='active'",
          [actor.tenantId, app.instanceId],
        )
      )[0];
      if (!instance)
        throw new PlatformStorageError("not_found", "应用实例不可用。");
      await q.change(
        "INSERT INTO content_entries(tenant_id,content_id,app_id,instance_id,app_object_id,project_id,kind,title,observed_version_ref,observed_at,availability,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'available',1,?,?)",
        [
          actor.tenantId,
          request.contentId,
          instance.app_id,
          app.instanceId,
          request.objectId,
          request.projectId,
          request.kind,
          request.title,
          request.observedVersionRef,
          now,
          now,
          now,
        ],
      );
      await this.receipt(
        q,
        actor,
        request.commandId,
        hash,
        "record-content",
        request.contentId,
        now,
      );
      await q.change(
        "INSERT INTO outbox(tenant_id,event_id,aggregate_kind,aggregate_id,aggregate_revision,event_kind,payload,created_at) VALUES(?,?,'content',?,1,'content.recorded',?,?)",
        [
          actor.tenantId,
          request.commandId,
          request.contentId,
          JSON.stringify({
            instanceId: app.instanceId,
            objectId: request.objectId,
            projectId: request.projectId,
            observedVersionRef: request.observedVersionRef,
          }),
          now,
        ],
      );
      return request.contentId;
    });
  }

  /** Refresh only the catalog projection after the owning App has committed
   * an exact version. The App, not Platform, remains the version authority.
   * The catalog revision fences concurrent project moves and later updates.
   */
  async refreshContent(
    access: PlatformActor,
    app: { instanceId: string; proof: string },
    request: {
      commandId: string;
      appReceiptId: string;
      contentId: string;
      expectedCatalogRevision: number;
      title: string;
      observedVersionRef: string;
      now?: string;
    },
  ): Promise<string> {
    return this.refreshContentForActor(
      await this.authorize(access),
      true,
      app,
      request,
    );
  }

  /** The only recovery input is an App outbox receipt. A project move may
   * advance the catalog revision while the App's previous version is still
   * observed; rebase that projection without rewriting the App original.
   */
  async refreshCommittedContent(
    origin: CommittedAppOrigin,
    request: {
      contentId?: string;
      objectId: string;
      previousVersionRef: string;
      title: string;
      observedVersionRef: string;
      now?: string;
    },
  ): Promise<string> {
    const actor = this.committedAppActor(origin);
    requireId(request.objectId, "应用原件标识");
    if (!request.previousVersionRef || request.previousVersionRef.length > 200)
      throw new PlatformStorageError("invalid", "应用原件基准版本无效。");
    const contentId =
      request.contentId ??
      (await this.transaction(async (q) => {
        const row = (
          await q.all<{ content_id: string }>(
            "SELECT content_id FROM content_entries WHERE tenant_id=? AND instance_id=? AND app_object_id=? AND deleted_at IS NULL",
            [origin.tenantId, origin.instanceId, request.objectId],
          )
        )[0];
        if (!row)
          throw new PlatformStorageError(
            "not_found",
            "应用原件尚未登记到内容目录。",
          );
        return row.content_id;
      }, "read"));
    return this.refreshContentForActor(
      actor,
      false,
      { instanceId: origin.instanceId, proof: origin.receiptId },
      {
        commandId: `catalog_${fingerprint([
          origin.tenantId,
          origin.instanceId,
          origin.receiptId,
        ]).slice(0, 40)}`,
        appReceiptId: origin.receiptId,
        contentId,
        title: request.title,
        observedVersionRef: request.observedVersionRef,
        now: request.now,
      },
      {
        objectId: request.objectId,
        previousVersionRef: request.previousVersionRef,
      },
    );
  }

  private async refreshContentForActor(
    actor: ResolvedActor,
    requireCurrentMember: boolean,
    app: { instanceId: string; proof: string },
    request: {
      commandId: string;
      appReceiptId: string;
      contentId: string;
      expectedCatalogRevision?: number;
      title: string;
      observedVersionRef: string;
      now?: string;
    },
    committed?: { objectId: string; previousVersionRef: string },
  ): Promise<string> {
    for (const value of [
      actor.tenantId,
      actor.principalId,
      app.instanceId,
      request.commandId,
      request.appReceiptId,
      request.contentId,
    ])
      requireId(value, "对象标识");
    requireTitle(request.title);
    if (
      (!committed &&
        (!Number.isSafeInteger(request.expectedCatalogRevision) ||
          request.expectedCatalogRevision! < 1)) ||
      !request.observedVersionRef ||
      request.observedVersionRef.length > 200
    )
      throw new PlatformStorageError("invalid", "目录修订或应用版本无效。");
    const hash = fingerprint({
      origin: {
        tenantId: actor.tenantId,
        principalId: actor.principalId,
        actantId: actor.actantId,
        runtimeInputId: actor.runtimeInputId,
        ...(this.appTaskRunEventId(actor)
          ? { runtimeTaskRunEventId: this.appTaskRunEventId(actor) }
          : {}),
      },
      instanceId: app.instanceId,
      ...request,
      expectedCatalogRevision: undefined,
      now: undefined,
    });
    const prior = await this.priorReceipt(actor, request.commandId, hash);
    if (prior) return prior;
    const source = await this.transaction(async (q) => {
      const row = (
        await q.all<{
          app_id: string;
          instance_id: string;
          app_object_id: string;
          project_id: string;
          kind: string;
          revision: number | string;
          observed_version_ref: string | null;
        }>(
          "SELECT c.app_id,c.instance_id,c.app_object_id,c.project_id,c.kind,c.revision,c.observed_version_ref FROM content_entries c JOIN app_instances i ON i.tenant_id=c.tenant_id AND i.instance_id=c.instance_id WHERE c.tenant_id=? AND c.content_id=? AND c.deleted_at IS NULL AND i.state='active'",
          [actor.tenantId, request.contentId],
        )
      )[0];
      if (
        !row ||
        row.instance_id !== app.instanceId ||
        (committed && row.app_object_id !== committed.objectId)
      )
        throw new PlatformStorageError("not_found", "内容或应用实例不可用。");
      if (requireCurrentMember)
        await this.assertMember(q, actor, row.project_id, false);
      if (
        committed
          ? row.observed_version_ref !== committed.previousVersionRef
          : Number(row.revision) !== request.expectedCatalogRevision
      )
        throw new PlatformStorageError("conflict", "目录已变化，请重新读取。");
      return row;
    }, "read");
    if (
      !(await this.capabilities.verifyApplicationObject({
        tenantId: actor.tenantId,
        principalId: actor.principalId,
        actantId: actor.actantId,
        runtimeInputId: actor.runtimeInputId ?? null,
        runtimeTaskRunEventId: this.appTaskRunEventId(actor),
        instanceId: app.instanceId,
        objectId: source.app_object_id,
        versionRef: request.observedVersionRef,
        kind: source.kind,
        title: request.title,
        projectId: source.project_id,
        receiptId: request.appReceiptId,
        proof: app.proof,
      }))
    )
      throw new PlatformStorageError(
        "forbidden",
        "应用未确认此版本的提交回执。",
      );
    const now = request.now ?? new Date().toISOString();
    return this.transaction(async (q) => {
      if (this.backend.kind === "postgres")
        await q.all(
          "SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0)) AS locked",
          [`platform:${actor.tenantId}:${request.commandId}`],
        );
      const earlier = await this.replay(q, actor, request.commandId, hash);
      if (earlier) return earlier;
      if (requireCurrentMember)
        await this.assertMember(q, actor, source.project_id);
      const changed = await q.change(
        "UPDATE content_entries SET title=?,observed_version_ref=?,observed_at=?,availability='available',revision=revision+1,updated_at=? WHERE tenant_id=? AND content_id=? AND instance_id=? AND app_object_id=? AND project_id=? AND revision=? AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM app_instances i WHERE i.tenant_id=content_entries.tenant_id AND i.instance_id=content_entries.instance_id AND i.state='active')",
        [
          request.title,
          request.observedVersionRef,
          now,
          now,
          actor.tenantId,
          request.contentId,
          app.instanceId,
          source.app_object_id,
          source.project_id,
          Number(source.revision),
        ],
      );
      if (changed !== 1)
        throw new PlatformStorageError("conflict", "目录已变化，请重新读取。");
      await this.receipt(
        q,
        actor,
        request.commandId,
        hash,
        "refresh-content",
        request.contentId,
        now,
      );
      await q.change(
        "INSERT INTO outbox(tenant_id,event_id,aggregate_kind,aggregate_id,aggregate_revision,event_kind,payload,created_at) VALUES(?,?,'content',?,?,'content.refreshed',?,?)",
        [
          actor.tenantId,
          request.commandId,
          request.contentId,
          Number(source.revision) + 1,
          JSON.stringify({
            instanceId: app.instanceId,
            objectId: source.app_object_id,
            projectId: source.project_id,
            observedVersionRef: request.observedVersionRef,
            appReceiptId: request.appReceiptId,
          }),
          now,
        ],
      );
      return request.contentId;
    });
  }

  async moveContent(
    access: PlatformActor,
    request: {
      commandId: string;
      contentId: string;
      targetProjectId: string;
      expectedRevision: number;
      now?: string;
    },
  ): Promise<string> {
    const actor = await this.authorize(access);
    for (const value of [
      actor.tenantId,
      actor.principalId,
      request.commandId,
      request.contentId,
      request.targetProjectId,
    ])
      requireId(value, "对象标识");
    if (
      !Number.isSafeInteger(request.expectedRevision) ||
      request.expectedRevision < 1
    )
      throw new PlatformStorageError("invalid", "内容修订号无效。");
    const hash = fingerprint({ actor, ...request, now: undefined });
    const now = request.now ?? new Date().toISOString();
    return this.transaction(async (q) => {
      const earlier = await this.replay(q, actor, request.commandId, hash);
      if (earlier) return earlier;
      const source = (
        await q.all<{ project_id: string; revision: number | string }>(
          "SELECT project_id,revision FROM content_entries WHERE tenant_id=? AND content_id=? AND deleted_at IS NULL",
          [actor.tenantId, request.contentId],
        )
      )[0];
      if (!source) throw new PlatformStorageError("not_found", "内容不存在。");
      await this.lockProjectAudiences(q, actor.tenantId, [
        source.project_id,
        request.targetProjectId,
      ]);
      await this.assertMember(q, actor, source.project_id);
      await this.assertMember(q, actor, request.targetProjectId, true, false);
      const destination = (
        await q.all<{ kind: string }>(
          "SELECT kind FROM projects WHERE tenant_id=? AND project_id=?",
          [actor.tenantId, request.targetProjectId],
        )
      )[0];
      if (!destination || !["project", "desk"].includes(destination.kind))
        throw new PlatformStorageError(
          "invalid",
          "内容只能归入项目或未归项目。",
        );
      if (Number(source.revision) !== request.expectedRevision)
        throw new PlatformStorageError(
          "conflict",
          "内容已变化，请查看最新版本。",
        );
      const sourceMembers = await q.all<{ principal_id: string }>(
        `SELECT principal_id FROM project_members WHERE tenant_id=? AND project_id=? ORDER BY principal_id${this.backend.kind === "postgres" ? " FOR SHARE" : ""}`,
        [actor.tenantId, source.project_id],
      );
      const targetMembers = await q.all<{ principal_id: string }>(
        `SELECT principal_id FROM project_members WHERE tenant_id=? AND project_id=? ORDER BY principal_id${this.backend.kind === "postgres" ? " FOR SHARE" : ""}`,
        [actor.tenantId, request.targetProjectId],
      );
      if (JSON.stringify(sourceMembers) !== JSON.stringify(targetMembers))
        throw new PlatformStorageError(
          "forbidden",
          "两个项目的访问成员不同，不能直接移动内容。",
        );
      await this.assertContentRelationsStayInProject(
        q,
        actor.tenantId,
        request.contentId,
        request.targetProjectId,
      );
      const changed = await q.change(
        "UPDATE content_entries SET project_id=?,revision=revision+1,updated_at=? WHERE tenant_id=? AND content_id=? AND revision=? AND deleted_at IS NULL",
        [
          request.targetProjectId,
          now,
          actor.tenantId,
          request.contentId,
          request.expectedRevision,
        ],
      );
      if (changed !== 1)
        throw new PlatformStorageError(
          "conflict",
          "内容已变化，请查看最新版本。",
        );
      await this.receipt(
        q,
        actor,
        request.commandId,
        hash,
        "move-content",
        request.contentId,
        now,
      );
      await q.change(
        "INSERT INTO outbox(tenant_id,event_id,aggregate_kind,aggregate_id,aggregate_revision,event_kind,payload,created_at) VALUES(?,?,'content',?,?,'content.moved',?,?)",
        [
          actor.tenantId,
          request.commandId,
          request.contentId,
          request.expectedRevision + 1,
          JSON.stringify({ projectId: request.targetProjectId }),
          now,
        ],
      );
      return request.contentId;
    });
  }

  /** Create the destination and move exactly one catalog entry in one Platform
   * transaction. No App original or other content is copied or rewritten. */
  async createProjectForContent(
    access: PlatformActor,
    request: {
      commandId: string;
      projectId: string;
      title: string;
      contentId: string;
      expectedRevision: number;
      now?: string;
    },
  ): Promise<string> {
    const actor = await this.authorize(access);
    for (const value of [
      actor.tenantId,
      actor.principalId,
      request.commandId,
      request.projectId,
      request.contentId,
    ])
      requireId(value, "对象标识");
    requireTitle(request.title);
    if (
      !Number.isSafeInteger(request.expectedRevision) ||
      request.expectedRevision < 1
    )
      throw new PlatformStorageError("invalid", "内容修订号无效。");
    const hash = fingerprint({ actor, ...request, now: undefined });
    const now = request.now ?? new Date().toISOString();
    return this.transaction(async (q) => {
      const earlier = await this.replay(q, actor, request.commandId, hash);
      if (earlier) return earlier;
      const source = (
        await q.all<{ project_id: string; revision: number | string }>(
          "SELECT project_id,revision FROM content_entries WHERE tenant_id=? AND content_id=? AND deleted_at IS NULL",
          [actor.tenantId, request.contentId],
        )
      )[0];
      if (!source) throw new PlatformStorageError("not_found", "内容不存在。");
      await this.lockProjectAudiences(q, actor.tenantId, [source.project_id]);
      await this.assertMember(q, actor, source.project_id);
      if (Number(source.revision) !== request.expectedRevision)
        throw new PlatformStorageError(
          "conflict",
          "内容已变化，请查看最新版本。",
        );
      await this.assertContentRelationsStayInProject(
        q,
        actor.tenantId,
        request.contentId,
        request.projectId,
      );
      const members = await q.all<{ principal_id: string }>(
        `SELECT principal_id FROM project_members WHERE tenant_id=? AND project_id=? ORDER BY principal_id${this.backend.kind === "postgres" ? " FOR SHARE" : ""}`,
        [actor.tenantId, source.project_id],
      );
      if (!members.length)
        throw new PlatformStorageError("forbidden", "原项目没有有效成员。");
      await q.change(
        "INSERT INTO projects(tenant_id,project_id,kind,owner_principal_id,title,revision,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)",
        [
          actor.tenantId,
          request.projectId,
          "project",
          actor.principalId,
          request.title,
          now,
          now,
        ],
      );
      for (const member of members)
        await q.change(
          "INSERT INTO project_members(tenant_id,project_id,principal_id,joined_at) VALUES(?,?,?,?)",
          [actor.tenantId, request.projectId, member.principal_id, now],
        );
      await q.change(
        "INSERT INTO conversations(tenant_id,conversation_id,project_id,kind,title,revision,created_at,updated_at) VALUES(?,?,?,'default',?,1,?,?)",
        [
          actor.tenantId,
          request.projectId,
          request.projectId,
          "默认对话",
          now,
          now,
        ],
      );
      const changed = await q.change(
        "UPDATE content_entries SET project_id=?,revision=revision+1,updated_at=? WHERE tenant_id=? AND content_id=? AND revision=? AND deleted_at IS NULL",
        [
          request.projectId,
          now,
          actor.tenantId,
          request.contentId,
          request.expectedRevision,
        ],
      );
      if (changed !== 1)
        throw new PlatformStorageError(
          "conflict",
          "内容已变化，请查看最新版本。",
        );
      await this.receipt(
        q,
        actor,
        request.commandId,
        hash,
        "create-project-for-content",
        request.projectId,
        now,
      );
      await q.change(
        "INSERT INTO outbox(tenant_id,event_id,aggregate_kind,aggregate_id,aggregate_revision,event_kind,payload,created_at) VALUES(?,?,'content',?,?,'content.moved',?,?)",
        [
          actor.tenantId,
          request.commandId,
          request.contentId,
          request.expectedRevision + 1,
          JSON.stringify({ projectId: request.projectId }),
          now,
        ],
      );
      return request.projectId;
    });
  }

  /** A live relation cannot be stranded across project boundaries. Retired
   * endpoints and impossible self-edges are not active dependencies. */
  private async assertContentRelationsStayInProject(
    q: Query,
    tenantId: string,
    contentId: string,
    targetProjectId: string,
  ) {
    const edge = await q.all(
      `SELECT r.relation_id FROM work_relations r
       LEFT JOIN tasks st ON st.tenant_id=r.tenant_id AND st.task_id=r.source_task_id AND st.deleted_at IS NULL
       LEFT JOIN content_entries sc ON sc.tenant_id=r.tenant_id AND sc.content_id=r.source_content_id AND sc.deleted_at IS NULL
       LEFT JOIN tasks tt ON tt.tenant_id=r.tenant_id AND tt.task_id=r.target_task_id AND tt.deleted_at IS NULL
       LEFT JOIN content_entries tc ON tc.tenant_id=r.tenant_id AND tc.content_id=r.target_content_id AND tc.deleted_at IS NULL
       JOIN projects sp ON sp.tenant_id=r.tenant_id AND sp.project_id=COALESCE(st.project_id,sc.project_id) AND sp.deleted_at IS NULL
       JOIN projects tp ON tp.tenant_id=r.tenant_id AND tp.project_id=COALESCE(tt.project_id,tc.project_id) AND tp.deleted_at IS NULL
       WHERE r.tenant_id=? AND (
         (r.source_content_id=? AND COALESCE(r.target_content_id,'')<>? AND tp.project_id<>?) OR
         (r.target_content_id=? AND COALESCE(r.source_content_id,'')<>? AND sp.project_id<>?)
       ) LIMIT 1`,
      [
        tenantId,
        contentId,
        contentId,
        targetProjectId,
        contentId,
        contentId,
        targetProjectId,
      ],
    );
    if (edge.length)
      throw new PlatformStorageError(
        "conflict",
        "此内容仍有关联对象，请先解除关联后再移动。",
      );
  }

  async content(access: PlatformActor, contentId: string): Promise<ContentRow> {
    const actor = await this.authorize(access);
    requireId(contentId, "内容标识");
    return this.transaction(async (q) => {
      const row = (
        await q.all<ContentRow & Row>(
          "SELECT c.content_id,c.app_id,c.instance_id,i.revision AS provider_revision,c.app_object_id,c.project_id,c.kind,c.title,c.observed_version_ref,c.availability,c.revision,c.created_at,c.updated_at FROM content_entries c JOIN app_instances i ON i.tenant_id=c.tenant_id AND i.instance_id=c.instance_id AND i.app_id=c.app_id JOIN project_members m ON m.tenant_id=c.tenant_id AND m.project_id=c.project_id JOIN projects p ON p.tenant_id=c.tenant_id AND p.project_id=c.project_id WHERE c.tenant_id=? AND c.content_id=? AND m.principal_id=? AND c.deleted_at IS NULL AND p.deleted_at IS NULL",
          [actor.tenantId, contentId, actor.principalId],
        )
      )[0];
      if (!row)
        throw new PlatformStorageError("not_found", "内容不存在或无权访问。");
      await this.assertProjectReader(q, actor, row.project_id);
      return {
        ...row,
        revision: safeInteger(row.revision, "内容修订"),
        provider_revision: safeInteger(row.provider_revision, "应用保存方修订"),
      };
    }, "read");
  }

  /** Resolve an App-owned object without scanning the catalog. App object IDs
   * are unique only within an instance; omit instanceId only when the visible
   * result is unambiguous. Never reveal objects outside the caller's projects. */
  async contentByAppObject(
    access: PlatformActor,
    request: { appId: string; appObjectId: string; instanceId?: string },
  ): Promise<ContentRow> {
    const actor = await this.authorize(access);
    requireAppId(request.appId);
    requireId(request.appObjectId, "应用对象标识");
    if (request.instanceId !== undefined)
      requireId(request.instanceId, "应用实例标识");
    return this.transaction(async (q) => {
      const values: Scalar[] = [
        actor.tenantId,
        request.appId,
        request.appObjectId,
        actor.principalId,
      ];
      let conditions = "";
      if (request.instanceId !== undefined) {
        conditions += " AND c.instance_id=?";
        values.push(request.instanceId);
      }
      if (actor.scopeProjectId !== undefined) {
        conditions += " AND c.project_id=?";
        values.push(actor.scopeProjectId);
      }
      const rows = await q.all<ContentRow & Row>(
        "SELECT c.content_id,c.app_id,c.instance_id,i.revision AS provider_revision,c.app_object_id,c.project_id,c.kind,c.title,c.observed_version_ref,c.availability,c.revision,c.created_at,c.updated_at FROM content_entries c JOIN app_instances i ON i.tenant_id=c.tenant_id AND i.instance_id=c.instance_id AND i.app_id=c.app_id JOIN project_members m ON m.tenant_id=c.tenant_id AND m.project_id=c.project_id JOIN projects p ON p.tenant_id=c.tenant_id AND p.project_id=c.project_id WHERE c.tenant_id=? AND c.app_id=? AND c.app_object_id=? AND m.principal_id=? AND c.deleted_at IS NULL AND p.deleted_at IS NULL" +
          conditions +
          " ORDER BY c.content_id LIMIT 2",
        values,
      );
      if (!rows.length)
        throw new PlatformStorageError("not_found", "内容不存在或无权访问。");
      if (rows.length > 1)
        throw new PlatformStorageError(
          "conflict",
          "多个应用实例有同名对象，请指定应用实例。",
        );
      const row = rows[0]!;
      await this.assertProjectReader(q, actor, row.project_id);
      return {
        ...row,
        revision: safeInteger(row.revision, "内容修订"),
        provider_revision: safeInteger(row.provider_revision, "应用保存方修订"),
      };
    }, "read");
  }

  private async workEndpoint(
    q: Query,
    actor: ResolvedActor,
    objectId: string,
    forWrite: boolean,
  ): Promise<{ kind: "task" | "content"; projectId: string }> {
    const [task, content] = await Promise.all([
      q.all<{ project_id: string }>(
        "SELECT project_id FROM tasks WHERE tenant_id=? AND task_id=? AND deleted_at IS NULL",
        [actor.tenantId, objectId],
      ),
      q.all<{ project_id: string }>(
        "SELECT project_id FROM content_entries WHERE tenant_id=? AND content_id=? AND deleted_at IS NULL",
        [actor.tenantId, objectId],
      ),
    ]);
    if (task.length + content.length !== 1)
      throw new PlatformStorageError(
        "not_found",
        "关联对象不存在或标识不唯一。",
      );
    const endpoint = task.length
      ? { kind: "task" as const, projectId: task[0]!.project_id }
      : { kind: "content" as const, projectId: content[0]!.project_id };
    if (forWrite) await this.assertMember(q, actor, endpoint.projectId);
    else await this.assertProjectReader(q, actor, endpoint.projectId);
    return endpoint;
  }

  /** A relation is Platform-owned; neither endpoint's application original is
   * copied. The persisted command ID also identifies a newly created edge. */
  async linkWork(
    access: PlatformActor,
    request: {
      commandId: string;
      fromId: string;
      toId: string;
      kind: "references" | "uses" | "produces";
      expectedProjectId?: string;
      now?: string;
    },
  ): Promise<string> {
    const actor = await this.authorize(access);
    for (const value of [request.commandId, request.fromId, request.toId])
      requireId(value, "关联标识");
    if (
      request.fromId === request.toId ||
      !["references", "uses", "produces"].includes(request.kind)
    )
      throw new PlatformStorageError(
        "invalid",
        "请选择另一对象和有效关联类型。",
      );
    const hash = fingerprint({ actor, ...request, now: undefined });
    const now = request.now ?? new Date().toISOString();
    return this.transaction(async (q) => {
      let from = await this.workEndpoint(q, actor, request.fromId, true);
      let to = await this.workEndpoint(q, actor, request.toId, true);
      // Either membership check may have waited on a concurrent move's
      // project lock. Re-read both endpoints after the shared locks are held;
      // a previously read project is not authority for the new relation.
      from = await this.workEndpoint(q, actor, request.fromId, true);
      to = await this.workEndpoint(q, actor, request.toId, true);
      if (from.projectId !== to.projectId)
        throw new PlatformStorageError("invalid", "只能关联同一项目内的对象。");
      if (
        request.expectedProjectId &&
        from.projectId !== request.expectedProjectId
      )
        throw new PlatformStorageError(
          "forbidden",
          "对象不属于本次输入的项目。",
        );
      const earlier = await this.replay(q, actor, request.commandId, hash);
      if (earlier) return earlier;
      if (this.backend.kind === "postgres")
        await q.all(
          "SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0)) AS locked",
          [
            `relation:${actor.tenantId}:${request.fromId}:${request.toId}:${request.kind}`,
          ],
        );
      const existing = (
        await q.all<{ relation_id: string }>(
          `SELECT relation_id FROM work_relations WHERE tenant_id=?
         AND source_${from.kind}_id=? AND target_${to.kind}_id=? AND kind=?
         ORDER BY relation_id LIMIT 1`,
          [actor.tenantId, request.fromId, request.toId, request.kind],
        )
      )[0];
      const relationId = existing?.relation_id ?? request.commandId;
      if (!existing)
        await q.change(
          `INSERT INTO work_relations
           (tenant_id,relation_id,source_task_id,source_content_id,source_version_ref,
            target_task_id,target_content_id,target_version_ref,kind,
            created_by_principal_id,created_by_actant_id,created_at)
           VALUES(?,?,?,?,NULL,?,?,NULL,?,?,?,?)`,
          [
            actor.tenantId,
            relationId,
            from.kind === "task" ? request.fromId : null,
            from.kind === "content" ? request.fromId : null,
            to.kind === "task" ? request.toId : null,
            to.kind === "content" ? request.toId : null,
            request.kind,
            actor.principalId,
            actor.actantId,
            now,
          ],
        );
      await this.receipt(
        q,
        actor,
        request.commandId,
        hash,
        "link-work",
        relationId,
        now,
      );
      return relationId;
    });
  }

  /** Read only one object's authorized edges, bounded by an indexed ID page. */
  async listWorkRelations(
    access: PlatformActor,
    objectId: string,
    options: {
      limit?: number;
      after?: string;
      expectedProjectId?: string;
    } = {},
  ) {
    const actor = await this.authorize(access);
    requireId(objectId, "对象标识");
    if (options.after) requireId(options.after, "关联游标");
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new PlatformStorageError("invalid", "关联分页大小无效。");
    return this.transaction(async (q) => {
      const endpoint = await this.workEndpoint(q, actor, objectId, false);
      if (
        options.expectedProjectId &&
        endpoint.projectId !== options.expectedProjectId
      )
        throw new PlatformStorageError(
          "forbidden",
          "对象不属于本次输入的项目。",
        );
      const column = endpoint.kind === "task" ? "task" : "content";
      const rows = await q.all<{
        relation_id: string;
        kind: string;
        source_task_id: string | null;
        source_content_id: string | null;
        target_task_id: string | null;
        target_content_id: string | null;
        source_project_id: string | null;
        target_project_id: string | null;
      }>(
        `SELECT r.relation_id,r.kind,r.source_task_id,r.source_content_id,
                r.target_task_id,r.target_content_id,
                COALESCE(st.project_id,sc.project_id) AS source_project_id,
                COALESCE(tt.project_id,tc.project_id) AS target_project_id
         FROM work_relations r
         LEFT JOIN tasks st ON st.tenant_id=r.tenant_id AND st.task_id=r.source_task_id AND st.deleted_at IS NULL
         LEFT JOIN content_entries sc ON sc.tenant_id=r.tenant_id AND sc.content_id=r.source_content_id AND sc.deleted_at IS NULL
         LEFT JOIN tasks tt ON tt.tenant_id=r.tenant_id AND tt.task_id=r.target_task_id AND tt.deleted_at IS NULL
         LEFT JOIN content_entries tc ON tc.tenant_id=r.tenant_id AND tc.content_id=r.target_content_id AND tc.deleted_at IS NULL
         WHERE r.tenant_id=? AND (r.source_${column}_id=? OR r.target_${column}_id=?)
           AND COALESCE(st.project_id,sc.project_id)=?
           AND COALESCE(tt.project_id,tc.project_id)=?
           ${options.after ? "AND r.relation_id>?" : ""}
         ORDER BY r.relation_id LIMIT ?`,
        options.after
          ? [
              actor.tenantId,
              objectId,
              objectId,
              endpoint.projectId,
              endpoint.projectId,
              options.after,
              limit,
            ]
          : [
              actor.tenantId,
              objectId,
              objectId,
              endpoint.projectId,
              endpoint.projectId,
              limit,
            ],
      );
      return rows.map((row) => ({
        id: row.relation_id,
        fromId: row.source_task_id ?? row.source_content_id!,
        toId: row.target_task_id ?? row.target_content_id!,
        type: row.kind as "references" | "uses" | "produces",
      }));
    }, "read");
  }

  private async contentFilter(
    q: Query,
    actor: ResolvedActor,
    options: ContentFilter,
  ): Promise<{ fromWhere: string; values: Scalar[] }> {
    if (options.projectId) requireId(options.projectId, "项目标识");
    if (options.contentIds !== undefined) {
      if (
        !Array.isArray(options.contentIds) ||
        options.contentIds.length < 1 ||
        options.contentIds.length > 50 ||
        new Set(options.contentIds).size !== options.contentIds.length
      )
        throw new PlatformStorageError("invalid", "内容标识筛选无效。");
      for (const id of options.contentIds) requireId(id, "内容标识");
    }
    if (options.appObjectIds !== undefined) {
      if (
        !options.appId ||
        !Array.isArray(options.appObjectIds) ||
        options.appObjectIds.length < 1 ||
        options.appObjectIds.length > 50 ||
        new Set(options.appObjectIds).size !== options.appObjectIds.length
      )
        throw new PlatformStorageError("invalid", "应用对象标识筛选无效。");
      for (const id of options.appObjectIds) requireId(id, "应用对象标识");
    }
    if (options.appId) requireAppId(options.appId);
    if (options.appIds !== undefined) {
      if (
        options.appId !== undefined ||
        !Array.isArray(options.appIds) ||
        options.appIds.length < 1 ||
        options.appIds.length > 16 ||
        new Set(options.appIds).size !== options.appIds.length
      )
        throw new PlatformStorageError("invalid", "应用筛选无效。");
      for (const appId of options.appIds) requireAppId(appId);
    }
    if (
      options.kind !== undefined &&
      (typeof options.kind !== "string" ||
        options.kind.length < 1 ||
        options.kind.length > 80)
    )
      throw new PlatformStorageError("invalid", "内容类型无效。");
    if (options.kinds !== undefined) {
      if (
        options.kind !== undefined ||
        !Array.isArray(options.kinds) ||
        options.kinds.length < 1 ||
        options.kinds.length > 16 ||
        new Set(options.kinds).size !== options.kinds.length ||
        options.kinds.some(
          (kind) => typeof kind !== "string" || !kind || kind.length > 80,
        )
      )
        throw new PlatformStorageError("invalid", "内容类型筛选无效。");
    }
    if (
      options.availability !== undefined &&
      (typeof options.availability !== "string" ||
        options.availability.length < 1 ||
        options.availability.length > 80)
    )
      throw new PlatformStorageError("invalid", "内容可用性筛选无效。");
    if (
      options.query !== undefined &&
      (typeof options.query !== "string" || options.query.length > 200)
    )
      throw new PlatformStorageError("invalid", "目录搜索内容无效。");
    if (actor.kind === "agent") {
      await this.assertProjectReader(q, actor, actor.scopeProjectId!);
      if (options.projectId !== undefined)
        await this.assertAgentInputScope(q, actor, options.projectId, false);
    }
    const values: Scalar[] = [actor.tenantId, actor.principalId];
    let where =
      "c.tenant_id=? AND m.principal_id=? AND c.deleted_at IS NULL AND p.deleted_at IS NULL";
    if (actor.kind === "agent") {
      const source = (
        await q.all<{
          kind: string;
          archived_at: string | null;
          deleted_at: string | null;
        }>(
          "SELECT kind,archived_at,deleted_at FROM projects WHERE tenant_id=? AND project_id=?",
          [actor.tenantId, actor.scopeProjectId!],
        )
      )[0];
      if (
        !actor.runtimeTaskRun &&
        source &&
        ["desk", "inbox", "dialogue"].includes(source.kind) &&
        !source.archived_at &&
        !source.deleted_at
      ) {
        // Match the already established personal-input object authorization.
        // Filter both audience set differences before pagination and counts;
        // project inputs and scheduled work still remain project-bound.
        where +=
          " AND NOT EXISTS (SELECT 1 FROM project_members sm WHERE sm.tenant_id=p.tenant_id AND sm.project_id=? AND NOT EXISTS (SELECT 1 FROM project_members tm WHERE tm.tenant_id=p.tenant_id AND tm.project_id=p.project_id AND tm.principal_id=sm.principal_id)) AND NOT EXISTS (SELECT 1 FROM project_members tm WHERE tm.tenant_id=p.tenant_id AND tm.project_id=p.project_id AND NOT EXISTS (SELECT 1 FROM project_members sm WHERE sm.tenant_id=p.tenant_id AND sm.project_id=? AND sm.principal_id=tm.principal_id))";
        values.push(actor.scopeProjectId!, actor.scopeProjectId!);
      } else {
        where += " AND c.project_id=?";
        values.push(actor.scopeProjectId!);
      }
    }
    if (options.projectId) {
      where += " AND c.project_id=?";
      values.push(options.projectId);
    }
    if (options.contentIds) {
      where += ` AND c.content_id IN (${options.contentIds.map(() => "?").join(",")})`;
      values.push(...options.contentIds);
    }
    if (options.appObjectIds) {
      where += ` AND c.app_object_id IN (${options.appObjectIds.map(() => "?").join(",")})`;
      values.push(...options.appObjectIds);
    }
    if (options.appId) {
      where += " AND c.app_id=?";
      values.push(options.appId);
    }
    if (options.appIds) {
      where += ` AND c.app_id IN (${options.appIds.map(() => "?").join(",")})`;
      values.push(...options.appIds);
    }
    if (options.kind) {
      where += " AND c.kind=?";
      values.push(options.kind);
    }
    if (options.kinds) {
      where += ` AND c.kind IN (${options.kinds.map(() => "?").join(",")})`;
      values.push(...options.kinds);
    }
    if (options.availability) {
      where += " AND c.availability=?";
      values.push(options.availability);
    }
    for (const word of options.query?.trim().split(/\s+/u).filter(Boolean) ??
      []) {
      where +=
        this.backend.kind === "postgres"
          ? " AND POSITION(LOWER(?) IN LOWER(c.title))>0"
          : " AND instr(lower(c.title),lower(?))>0";
      values.push(word);
    }
    return {
      fromWhere: `FROM content_entries c JOIN app_instances i ON i.tenant_id=c.tenant_id AND i.instance_id=c.instance_id AND i.app_id=c.app_id JOIN project_members m ON m.tenant_id=c.tenant_id AND m.project_id=c.project_id JOIN projects p ON p.tenant_id=c.tenant_id AND p.project_id=c.project_id WHERE ${where}`,
      values,
    };
  }

  async listContent(
    access: PlatformActor,
    options: ContentFilter & {
      sort?: ContentOrder;
      limit?: number;
      before?: { key: string; contentId: string };
    } = {},
  ): Promise<ContentRow[]> {
    const actor = await this.authorize(access);
    const limit = options.limit ?? 50;
    const sort = options.sort ?? "updated";
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new PlatformStorageError("invalid", "分页大小无效。");
    if (!["updated", "created", "title"].includes(sort))
      throw new PlatformStorageError("invalid", "内容排序无效。");
    return this.transaction(async (q) => {
      let { fromWhere, values } = await this.contentFilter(q, actor, options);
      const field =
        sort === "title"
          ? this.backend.kind === "postgres"
            ? 'c.title COLLATE "C"'
            : "c.title COLLATE BINARY"
          : sort === "created"
            ? "c.created_at"
            : "c.updated_at";
      const direction = sort === "title" ? "ASC" : "DESC";
      const comparison = sort === "title" ? ">" : "<";
      if (options.before) {
        requireId(options.before.contentId, "游标标识");
        if (
          typeof options.before.key !== "string" ||
          !options.before.key ||
          options.before.key.length > 180 ||
          (sort !== "title" &&
            (!Number.isFinite(Date.parse(options.before.key)) ||
              new Date(options.before.key).toISOString() !==
                options.before.key))
        )
          throw new PlatformStorageError("invalid", "内容游标无效。");
        fromWhere += ` AND (${field}${comparison}? OR (${field}=? AND c.content_id${comparison}?))`;
        values.push(
          options.before.key,
          options.before.key,
          options.before.contentId,
        );
      }
      values.push(limit);
      const rows = await q.all<ContentRow & Row>(
        `SELECT c.content_id,c.app_id,c.instance_id,i.revision AS provider_revision,c.app_object_id,c.project_id,c.kind,c.title,c.observed_version_ref,c.availability,c.revision,c.created_at,c.updated_at ${fromWhere} ORDER BY ${field} ${direction},c.content_id ${direction} LIMIT ?`,
        values,
      );
      return rows.map((row) => ({
        ...row,
        revision: safeInteger(row.revision, "内容修订"),
        provider_revision: safeInteger(row.provider_revision, "应用保存方修订"),
      }));
    }, "read");
  }

  /** Exact delivered versions are the intersection of a committed Platform
   * receipt and its immutable content event. Neither the current catalog head
   * nor model-authored reply text can reconstruct the version delivered then.
   * Content events paired with receipts are durable history, not a disposable
   * delivery queue; only outbox delivery metadata may change.
   */
  async contentDeliveries(
    access: PlatformActor,
    options: {
      inputIds: string[];
      limit?: number;
      after?: { committedAt: string; commandId: string };
    },
  ): Promise<ContentDeliveryRow[]> {
    const actor = await this.authorize(access);
    if (
      !Array.isArray(options.inputIds) ||
      options.inputIds.length < 1 ||
      options.inputIds.length > 50 ||
      new Set(options.inputIds).size !== options.inputIds.length
    )
      throw new PlatformStorageError("invalid", "交付输入范围无效。");
    for (const inputId of options.inputIds) requireId(inputId, "输入标识");
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new PlatformStorageError("invalid", "交付分页大小无效。");
    if (options.after) {
      requireId(options.after.commandId, "交付游标标识");
      if (
        !Number.isFinite(Date.parse(options.after.committedAt)) ||
        new Date(options.after.committedAt).toISOString() !==
          options.after.committedAt
      )
        throw new PlatformStorageError("invalid", "交付游标无效。");
    }
    const eventValue = (key: string) =>
      this.backend.kind === "postgres"
        ? `(o.payload::jsonb ->> '${key}')`
        : `json_extract(o.payload,'$.${key}')`;
    return this.transaction(async (q) => {
      if (actor.kind === "agent")
        await this.assertProjectReader(q, actor, actor.scopeProjectId!);
      const values: Scalar[] = [
        actor.principalId,
        actor.principalId,
        actor.tenantId,
        ...options.inputIds,
      ];
      let after = "";
      if (options.after) {
        after =
          " AND (r.committed_at>? OR (r.committed_at=? AND r.command_id>?))";
        values.push(
          options.after.committedAt,
          options.after.committedAt,
          options.after.commandId,
        );
      }
      const scoped =
        actor.kind === "agent" ? " AND c.project_id=? AND sp.project_id=?" : "";
      if (actor.kind === "agent")
        values.push(actor.scopeProjectId!, actor.scopeProjectId!);
      values.push(limit);
      return q.all<ContentDeliveryRow & Row>(
        `SELECT r.command_id,r.operation,r.runtime_input_id,
           ${eventValue("projectId")} AS source_project_id,
           c.content_id,c.project_id,c.app_id,c.app_object_id,c.kind,c.title,
           ${eventValue("observedVersionRef")} AS version_ref,
           r.committed_at
         FROM command_receipts r
         JOIN outbox o ON o.tenant_id=r.tenant_id AND o.event_id=r.command_id
           AND o.aggregate_kind='content' AND o.aggregate_id=r.result_ref
         JOIN content_entries c ON c.tenant_id=r.tenant_id AND c.content_id=r.result_ref
           AND c.deleted_at IS NULL AND c.availability='available'
         JOIN app_instances i ON i.tenant_id=c.tenant_id AND i.instance_id=c.instance_id
           AND i.app_id=c.app_id AND i.state='active'
         JOIN project_members cm ON cm.tenant_id=c.tenant_id
           AND cm.project_id=c.project_id AND cm.principal_id=?
         JOIN projects cp ON cp.tenant_id=c.tenant_id AND cp.project_id=c.project_id
           AND cp.deleted_at IS NULL
         JOIN project_members sm ON sm.tenant_id=r.tenant_id
           AND sm.project_id=${eventValue("projectId")} AND sm.principal_id=?
         JOIN projects sp ON sp.tenant_id=sm.tenant_id AND sp.project_id=sm.project_id
           AND sp.deleted_at IS NULL
         WHERE r.tenant_id=? AND r.runtime_input_id IN (${options.inputIds.map(() => "?").join(",")})
           AND ((r.operation='record-content' AND o.event_kind='content.recorded')
             OR (r.operation='refresh-content' AND o.event_kind='content.refreshed'))
           AND c.instance_id=${eventValue("instanceId")}
           AND c.app_object_id=${eventValue("objectId")}
           ${after}${scoped}
         ORDER BY r.committed_at,r.command_id LIMIT ?`,
        values,
      );
    }, "read");
  }

  async contentCounts(
    access: PlatformActor,
    options: ContentFilter = {},
  ): Promise<
    Array<{ projectId: string; count: number; latestActivityAt: string }>
  > {
    const actor = await this.authorize(access);
    return this.transaction(async (q) => {
      const { fromWhere, values } = await this.contentFilter(q, actor, options);
      const rows = await q.all<
        {
          project_id: string;
          item_count: number | string;
          latest_activity_at: string;
        } & Row
      >(
        `SELECT c.project_id,COUNT(*) AS item_count,MAX(c.updated_at) AS latest_activity_at ${fromWhere} GROUP BY c.project_id ORDER BY c.project_id`,
        values,
      );
      return rows.map((row) => ({
        projectId: row.project_id,
        count: safeInteger(row.item_count, "内容数量"),
        latestActivityAt: row.latest_activity_at,
      }));
    }, "read");
  }

  /** Search the authorized catalog's titles, not app-owned original bodies.
   * Count, page and catalog revision come from one database snapshot so a
   * Client never sees a count for content it is not allowed to list.
   */
  async searchContentTitles(
    access: PlatformActor,
    options: ContentFilter & { limit: number; offset: number },
  ): Promise<{
    rows: Array<ContentRow & { project_title: string }>;
    total: number;
    catalogVersion: number;
  }> {
    const actor = await this.authorize(access);
    if (
      !Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 50 ||
      !Number.isSafeInteger(options.offset) ||
      options.offset < 0 ||
      options.offset > 10000 ||
      !options.query?.trim()
    )
      throw new PlatformStorageError("invalid", "搜索分页或关键词无效。");
    return this.transaction(async (q) => {
      if (options.projectId)
        await this.assertProjectReader(q, actor, options.projectId);
      const { fromWhere, values } = await this.contentFilter(q, actor, options);
      const count = await q.all<{ count: number | string } & Row>(
        `SELECT COUNT(*) AS count ${fromWhere}`,
        values,
      );
      const rows = await q.all<ContentRow & { project_title: string } & Row>(
        `SELECT c.content_id,c.app_id,c.instance_id,i.revision AS provider_revision,c.app_object_id,c.project_id,c.kind,c.title,c.observed_version_ref,c.availability,c.revision,c.created_at,c.updated_at,p.title AS project_title ${fromWhere} ORDER BY c.updated_at DESC,c.content_id DESC LIMIT ? OFFSET ?`,
        [...values, options.limit, options.offset],
      );
      const head = await q.all<{ revision: number | string } & Row>(
        "SELECT revision FROM navigation_heads WHERE tenant_id=?",
        [actor.tenantId],
      );
      return {
        rows: rows.map((row) => ({
          ...row,
          revision: safeInteger(row.revision, "内容修订"),
          provider_revision: safeInteger(
            row.provider_revision,
            "应用保存方修订",
          ),
        })),
        total: safeInteger(count[0]?.count ?? 0, "内容数量"),
        catalogVersion: safeInteger(head[0]?.revision ?? 0, "目录修订"),
      };
    }, "read");
  }

  private async assertViewApplication(
    q: Query,
    actor: ResolvedActor,
    projectId: string,
    appId: string,
    packageVersion: string,
  ) {
    requireAppId(appId);
    if (!/^\d+\.\d+\.\d+$/.test(packageVersion))
      throw new PlatformStorageError("invalid", "应用版本无效。");
    if (
      builtinViewApps.some(
        (app) => app.id === appId && app.version === packageVersion,
      )
    )
      return;
    const installed = await q.all(
      `SELECT 1 AS present FROM app_ui_packages p
       JOIN app_installations i ON i.tenant_id=p.tenant_id AND i.app_id=p.app_id
       JOIN project_members m ON m.tenant_id=p.tenant_id AND m.project_id=? AND m.principal_id=p.installed_by_principal_id
       WHERE p.tenant_id=? AND p.app_id=? AND p.package_version=? AND i.state='active'`,
      [projectId, actor.tenantId, appId, packageVersion],
    );
    if (!installed.length)
      throw new PlatformStorageError("not_found", "应用版本未在这个项目安装。");
  }

  private async viewRow(
    q: Query,
    actor: ResolvedActor,
    viewId: string,
  ): Promise<AppViewRow> {
    const row = (
      await q.all<AppViewRow & Row>(
        "SELECT view_id,project_id,app_id,package_version,state_json,revision,status,created_at,updated_at FROM app_view_instances WHERE tenant_id=? AND owner_principal_id=? AND view_id=?",
        [actor.tenantId, actor.principalId, viewId],
      )
    )[0];
    if (!row)
      throw new PlatformStorageError("not_found", "应用窗口不存在或无权访问。");
    await this.assertMember(q, actor, row.project_id, false);
    return row;
  }

  /** UI windows belong to a Human and project, never to an App data route.
   * A real Agent acting on an accepted Human chat may discover that Human's
   * windows only in its original project. A background run has no UI mandate.
   */
  async listAppViews(access: PlatformActor): Promise<ApplicationInstance[]> {
    const actor = await this.authorize(access);
    if (
      actor.kind !== "human" &&
      (actor.kind !== "agent" ||
        !actor.runtimeInputId ||
        !actor.initiatingHumanActantId ||
        actor.runtimeTaskRun)
    )
      throw new PlatformStorageError("forbidden", "只有本人可以恢复应用窗口。");
    return this.transaction(async (q) => {
      if (actor.kind === "agent")
        await this.assertMember(q, actor, actor.scopeProjectId!, false);
      const builtin = builtinViewApps
        .map(() => "(v.app_id=? AND v.package_version=?)")
        .join(" OR ");
      const rows = await q.all<AppViewRow & Row>(
        `SELECT v.view_id,v.project_id,v.app_id,v.package_version,v.state_json,v.revision,v.status,v.created_at,v.updated_at
         FROM app_view_instances v
         JOIN project_members m ON m.tenant_id=v.tenant_id AND m.project_id=v.project_id AND m.principal_id=?
         JOIN projects pr ON pr.tenant_id=v.tenant_id AND pr.project_id=v.project_id
         WHERE v.tenant_id=? AND v.owner_principal_id=? AND v.status='open'
           ${actor.kind === "agent" ? "AND v.project_id=?" : ""}
           AND pr.archived_at IS NULL AND pr.deleted_at IS NULL
           AND (${builtin} OR EXISTS (
             SELECT 1 FROM app_ui_packages p
             JOIN app_installations i ON i.tenant_id=p.tenant_id AND i.app_id=p.app_id
             JOIN project_members installer ON installer.tenant_id=p.tenant_id AND installer.project_id=v.project_id AND installer.principal_id=p.installed_by_principal_id
             WHERE p.tenant_id=v.tenant_id AND p.app_id=v.app_id AND p.package_version=v.package_version AND i.state='active'
           ))
         ORDER BY v.created_at,v.view_id LIMIT 101`,
        [
          actor.principalId,
          actor.tenantId,
          actor.principalId,
          ...(actor.kind === "agent" ? [actor.scopeProjectId!] : []),
          ...builtinViewApps.flatMap((app) => [app.id, app.version]),
        ],
      );
      if (rows.length > 100)
        throw new PlatformStorageError(
          "conflict",
          "打开的应用窗口超过 100 个，请先关闭部分窗口。",
        );
      return rows.map(appView);
    }, "read");
  }

  async launchAppView(
    access: PlatformActor,
    request: {
      commandId: string;
      projectId: string;
      appId: string;
      packageVersion: string;
      state: Record<string, unknown>;
      now?: string;
    },
  ): Promise<ApplicationInstance> {
    const actor = await this.authorize(access);
    if (
      actor.kind !== "human" &&
      (actor.kind !== "agent" ||
        !actor.runtimeInputId ||
        !actor.initiatingHumanActantId ||
        actor.runtimeTaskRun ||
        actor.scopeProjectId !== request.projectId)
    )
      throw new PlatformStorageError("forbidden", "只有本人可以打开应用窗口。");
    requireId(request.commandId, "操作标识");
    requireId(request.projectId, "项目标识");
    const state = viewNavigationState(request.appId, request.state);
    const hash = fingerprint({ actor, ...request, now: undefined });
    const now = request.now ?? new Date().toISOString();
    return this.transaction(async (q) => {
      await this.assertMember(q, actor, request.projectId);
      await this.assertViewApplication(
        q,
        actor,
        request.projectId,
        request.appId,
        request.packageVersion,
      );
      if (this.backend.kind === "postgres")
        await q.all(
          "SELECT pg_advisory_xact_lock(hashtextextended(?, 0)) AS locked",
          [
            `${actor.tenantId}:${actor.principalId}:${request.projectId}:${request.appId}:${request.packageVersion}`,
          ],
        );
      const earlier = await this.replay(q, actor, request.commandId, hash);
      if (earlier) return appView(await this.viewRow(q, actor, earlier));
      const existing = (
        await q.all<AppViewRow & Row>(
          "SELECT view_id,project_id,app_id,package_version,state_json,revision,status,created_at,updated_at FROM app_view_instances WHERE tenant_id=? AND owner_principal_id=? AND project_id=? AND app_id=? AND package_version=?",
          [
            actor.tenantId,
            actor.principalId,
            request.projectId,
            request.appId,
            request.packageVersion,
          ],
        )
      )[0];
      let viewId: string;
      if (existing) {
        viewId = existing.view_id;
        if (existing.status === "closed") {
          const count = (
            await q.all<{ count: number | string }>(
              "SELECT COUNT(*) AS count FROM app_view_instances WHERE tenant_id=? AND owner_principal_id=? AND status='open'",
              [actor.tenantId, actor.principalId],
            )
          )[0];
          if (safeInteger(count?.count ?? 0, "应用窗口数量") >= 100)
            throw new PlatformStorageError(
              "conflict",
              "打开的应用窗口已达上限，请先关闭部分窗口。",
            );
        }
        const merged = viewNavigationState(request.appId, {
          ...JSON.parse(existing.state_json),
          ...state,
        });
        await q.change(
          "UPDATE app_view_instances SET status='open',state_json=?,revision=revision+1,updated_at=? WHERE tenant_id=? AND view_id=?",
          [JSON.stringify(merged), now, actor.tenantId, viewId],
        );
      } else {
        viewId = request.commandId;
        const count = (
          await q.all<{ count: number | string }>(
            "SELECT COUNT(*) AS count FROM app_view_instances WHERE tenant_id=? AND owner_principal_id=? AND status='open'",
            [actor.tenantId, actor.principalId],
          )
        )[0];
        if (safeInteger(count?.count ?? 0, "应用窗口数量") >= 100)
          throw new PlatformStorageError(
            "conflict",
            "打开的应用窗口已达上限，请先关闭部分窗口。",
          );
        await q.change(
          "INSERT INTO app_view_instances(tenant_id,view_id,owner_principal_id,project_id,app_id,package_version,state_json,revision,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,?,?,?)",
          [
            actor.tenantId,
            viewId,
            actor.principalId,
            request.projectId,
            request.appId,
            request.packageVersion,
            JSON.stringify(state),
            "open",
            now,
            now,
          ],
        );
      }
      await this.receipt(
        q,
        actor,
        request.commandId,
        hash,
        "launch-app-view",
        viewId,
        now,
        actor.runtimeInputId,
        false,
      );
      return appView(await this.viewRow(q, actor, viewId));
    });
  }

  async changeAppView(
    access: PlatformActor,
    request: {
      commandId: string;
      viewId: string;
      expectedRevision: number;
      state?: Record<string, unknown>;
      close?: true;
      now?: string;
    },
  ): Promise<ApplicationInstance> {
    const actor = await this.authorize(access);
    if (actor.kind !== "human")
      throw new PlatformStorageError("forbidden", "只有本人可以修改应用窗口。");
    requireId(request.commandId, "操作标识");
    requireId(request.viewId, "应用窗口标识");
    if (
      !Number.isSafeInteger(request.expectedRevision) ||
      request.expectedRevision < 1 ||
      !!request.close === (request.state !== undefined)
    )
      throw new PlatformStorageError("invalid", "应用窗口操作无效。");
    const hash = fingerprint({ actor, ...request, now: undefined });
    const now = request.now ?? new Date().toISOString();
    return this.transaction(async (q) => {
      const row = await this.viewRow(q, actor, request.viewId);
      const state =
        request.state === undefined
          ? undefined
          : viewNavigationState(row.app_id, request.state);
      const earlier = await this.replay(q, actor, request.commandId, hash);
      if (earlier) return appView(await this.viewRow(q, actor, earlier));
      if (
        row.status !== "open" ||
        safeInteger(row.revision, "应用窗口修订") !== request.expectedRevision
      )
        throw new PlatformStorageError(
          "conflict",
          "应用窗口已变化，请刷新后重试。",
        );
      const changed = await q.change(
        "UPDATE app_view_instances SET state_json=?,status=?,revision=revision+1,updated_at=? WHERE tenant_id=? AND owner_principal_id=? AND view_id=? AND revision=? AND status='open'",
        [
          state === undefined ? row.state_json : JSON.stringify(state),
          request.close ? "closed" : "open",
          now,
          actor.tenantId,
          actor.principalId,
          request.viewId,
          request.expectedRevision,
        ],
      );
      if (changed !== 1)
        throw new PlatformStorageError(
          "conflict",
          "应用窗口已变化，请刷新后重试。",
        );
      await this.receipt(
        q,
        actor,
        request.commandId,
        hash,
        request.close ? "close-app-view" : "save-app-view",
        request.viewId,
        now,
        actor.runtimeInputId,
        false,
      );
      return appView(await this.viewRow(q, actor, request.viewId));
    });
  }

  async close() {
    await this.gate;
    if (this.backend.kind === "sqlite") this.backend.database.close();
    else await this.backend.pool.end();
  }
}
