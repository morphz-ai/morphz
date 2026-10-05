import { createHash } from "node:crypto";
import { z } from "zod";
import {
  parseOperationResources,
  parsePortableText,
  parseWireJson,
  type OperationResourceReference,
  type OperationScope,
} from "../../cognitive-app-sdk/src/protocol.js";
import {
  canonicalJsonBytes,
  parseDomainActor,
  parseDomainAuthority,
  parseDomainReceipt,
  type DomainActor,
  type DomainAuthorityReference,
  type DomainObjectSummary,
  type DomainReceiptBinding,
} from "../../cognitive-app-sdk/src/domain-wire.js";
import {
  safeInteger,
  type SqlQuery,
  type SqlRow,
} from "../../storage/src/sql.js";
import { createCognitiveAppRegistry } from "./cognitive-app-registry.js";

/** Internal ledger only. Store/Host resolves real identity before its transaction
 * and checks project/member/input/fence policy with this same q BEFORE calls.
 * This module opens no database/transaction, sends nothing and grants no ACL.
 */
export type CognitiveAppCommandsContext = {
  q: SqlQuery;
  backend: "sqlite" | "postgres";
  tenantId: string;
  fail(
    code: "invalid" | "forbidden" | "not_found" | "conflict",
    message: string,
  ): never;
};
export type CognitiveAppAdmission = {
  commandId: string;
  requestHash: string;
  authority: DomainAuthorityReference;
  actor: DomainActor;
  projectId: string;
  operationId: string;
  effect: "write" | "execute";
  operationScope: OperationScope;
  resources: readonly OperationResourceReference[];
  connectionId: string;
  connectionRevision: number;
  grantRevision: number;
};
export type CognitiveAppCommandState =
  | "admitted"
  | "dispatching"
  | "unknown"
  | "committed"
  | "rejected"
  | "cancelled";
export type CognitiveAppCommandSnapshot = CognitiveAppAdmission & {
  revision: number;
  state: CognitiveAppCommandState;
  receiptRef: string | null;
  receiptHash: string | null;
  committedAt: string | null;
  objects: readonly DomainObjectSummary[] | null;
  projectionState: "none" | "pending" | "projected";
  createdAt: string;
  updatedAt: string;
};
export type CognitiveAppCommandPage = {
  afterCommandId?: string;
  limit?: number;
};
const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const revision = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER - 1);
const reference = z.string().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().max(64).pipe(z.iso.datetime());
const admissionShape = z
  .object({
    commandId: id,
    requestHash: hash,
    authority: z.unknown(),
    actor: z.unknown(),
    projectId: id,
    operationId: reference,
    effect: z.enum(["write", "execute"]),
    operationScope: z.enum(["project", "objects"]),
    resources: z.unknown(),
    connectionId: id,
    connectionRevision: revision,
    grantRevision: revision,
  })
  .strict();
const summaryShape = z
  .array(
    z
      .object({
        objectId: reference,
        versionRef: reference,
        kind: z
          .string()
          .min(1)
          .max(100)
          .refine((v) => v.trim().length > 0),
        title: z
          .string()
          .min(1)
          .max(180)
          .refine((v) => v.trim().length > 0),
      })
      .strict(),
  )
  .max(32);
const columns =
  "command_id,app_id,version,definition_hash,instance_id,service_id,data_authority_id,connection_id,connection_revision,grant_revision,project_id,operation_id,operation_scope,effect,actor_kind,actor_principal_id,actor_actant_id,initiating_human_actant_id,source_kind,runtime_input_id,runtime_session_id,runtime_schedule_id,runtime_task_run_event_id,request_hash,resources_json,revision,state,receipt_ref,receipt_hash,receipt_summary_json,committed_at,projection_state,created_at,updated_at";
type Row = SqlRow & {
  command_id: string;
  app_id: string;
  version: string;
  definition_hash: string;
  instance_id: string;
  service_id: string;
  data_authority_id: string;
  connection_id: string;
  connection_revision: number | string;
  grant_revision: number | string;
  project_id: string;
  operation_id: string;
  operation_scope: OperationScope;
  effect: "write" | "execute";
  actor_kind: "human" | "agent";
  actor_principal_id: string;
  actor_actant_id: string;
  initiating_human_actant_id: string;
  source_kind: "human" | "input" | "task-run";
  runtime_input_id: string | null;
  runtime_session_id: string | null;
  runtime_schedule_id: string | null;
  runtime_task_run_event_id: string | null;
  request_hash: string;
  resources_json: string;
  revision: number | string;
  state: CognitiveAppCommandState;
  receipt_ref: string | null;
  receipt_hash: string | null;
  receipt_summary_json: string | null;
  committed_at: string | null;
  projection_state: CognitiveAppCommandSnapshot["projectionState"];
  created_at: string;
  updated_at: string;
};

export function createCognitiveAppCommands(ctx: CognitiveAppCommandsContext) {
  const { q, backend, tenantId, fail } = ctx;
  id.parse(tenantId);
  const exclusive = backend === "postgres" ? " FOR UPDATE" : "";
  const same = (a: unknown, b: unknown) =>
    Buffer.from(canonicalJsonBytes(a)).equals(
      Buffer.from(canonicalJsonBytes(b)),
    );
  function time(value: string) {
    try {
      timestamp.parse(value);
    } catch {
      fail("invalid", "命令操作时间无效。");
    }
  }
  function checkId(value: string) {
    try {
      id.parse(value);
    } catch {
      fail("invalid", "命令标识无效。");
    }
  }
  function checkRevision(value: number) {
    try {
      revision.parse(value);
    } catch {
      fail("invalid", "命令修订前提无效。");
    }
  }
  function boundedJson(value: unknown, maxBytes: number) {
    const bytes = canonicalJsonBytes(value);
    if (bytes.byteLength > maxBytes)
      fail("invalid", "命令引用或回执摘要超过固定 UTF-8 预算。");
    return new TextDecoder().decode(bytes);
  }
  function normalize(input: unknown): CognitiveAppAdmission {
    try {
      parseWireJson(input);
      const request = admissionShape.parse(input);
      parsePortableText(request.operationId);
      const resources = parseOperationResources(
        request.operationScope,
        request.resources,
      );
      boundedJson(resources, 32 * 1024);
      return {
        ...request,
        authority: parseDomainAuthority(request.authority),
        actor: parseDomainActor(request.actor),
        resources,
      };
    } catch {
      return fail("invalid", "命令受理绑定不符合固定有界契约。");
    }
  }
  function objects(input: unknown): readonly DomainObjectSummary[] {
    const value = summaryShape.parse(parseWireJson(input));
    for (const object of value)
      for (const text of [
        object.objectId,
        object.versionRef,
        object.kind,
        object.title,
      ])
        parsePortableText(text);
    // Receipt summaries have their own 64KiB budget, not admission's 32KiB
    // resource budget. Never reject or drop valid committed catalog evidence.
    if (new Set(value.map(({ objectId }) => objectId)).size !== value.length)
      fail("invalid", "回执摘要中的原对象标识不能重复。");
    boundedJson(value, 64 * 1024);
    return value;
  }
  function admission(
    snapshot: CognitiveAppCommandSnapshot,
  ): CognitiveAppAdmission {
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
    } = snapshot;
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
  function dto(row: Row): CognitiveAppCommandSnapshot {
    try {
      const actor = parseDomainActor({
        tenantId,
        principalId: row.actor_principal_id,
        actantId: row.actor_actant_id,
        kind: row.actor_kind,
        source:
          row.source_kind === "human"
            ? { kind: "human" }
            : row.source_kind === "input"
              ? {
                  kind: "input",
                  inputId: row.runtime_input_id,
                  humanActantId: row.initiating_human_actant_id,
                }
              : {
                  kind: "task-run",
                  sessionId: row.runtime_session_id,
                  scheduleId: row.runtime_schedule_id,
                  eventId: row.runtime_task_run_event_id,
                  sourceInputId: row.runtime_input_id,
                  humanActantId: row.initiating_human_actant_id,
                },
      });
      const immutable = normalize({
        commandId: row.command_id,
        requestHash: row.request_hash,
        authority: {
          appId: row.app_id,
          version: row.version,
          definitionHash: row.definition_hash,
          instanceId: row.instance_id,
          serviceId: row.service_id,
          dataAuthorityId: row.data_authority_id,
        },
        actor,
        projectId: row.project_id,
        operationId: row.operation_id,
        effect: row.effect,
        operationScope: row.operation_scope,
        resources: JSON.parse(row.resources_json),
        connectionId: row.connection_id,
        connectionRevision: safeInteger(
          row.connection_revision,
          "命令连接修订",
        ),
        grantRevision: safeInteger(row.grant_revision, "命令许可修订"),
      });
      return {
        ...immutable,
        revision: safeInteger(row.revision, "命令修订"),
        state: row.state,
        receiptRef:
          row.receipt_ref === null
            ? null
            : reference.parse(parsePortableText(row.receipt_ref)),
        receiptHash: row.receipt_hash,
        committedAt: row.committed_at,
        objects:
          row.receipt_summary_json === null
            ? null
            : objects(JSON.parse(row.receipt_summary_json)),
        projectionState: row.projection_state,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    } catch {
      return fail("conflict", "持久命令事实不符合固定契约，不能重建或改绑。");
    }
  }
  async function load(commandId: string, lock = "") {
    checkId(commandId);
    const row = (
      await q.all<Row>(
        `SELECT ${columns} FROM cognitive_app_commands WHERE tenant_id=? AND command_id=?${lock}`,
        [tenantId, commandId],
      )
    )[0];
    return row ? dto(row) : null;
  }
  async function lock(commandId: string) {
    checkId(commandId);
    // Every mutating path locks command identity BEFORE registry target locks.
    // A key lock also covers absent rows, so concurrent first admission is exact.
    if (backend === "postgres")
      await q.all(
        "SELECT pg_advisory_xact_lock(hashtextextended(?,0)) AS locked",
        [JSON.stringify(["cognitive-command/v1", tenantId, commandId])],
      );
    return load(commandId, exclusive);
  }
  async function required(commandId: string) {
    const current = await lock(commandId);
    if (!current) return fail("not_found", "命令尚未受理。");
    return current;
  }
  async function target(request: CognitiveAppAdmission) {
    if (request.actor.tenantId !== tenantId)
      fail("forbidden", "命令来源与租户绑定不一致。");
    const registry = createCognitiveAppRegistry({
      q,
      backend,
      tenantId,
      principalId: request.actor.principalId,
      fail,
    });
    const active = await registry.lockCurrentTarget({
      appId: request.authority.appId,
      version: request.authority.version,
      connectionId: request.connectionId,
      expectedDefinitionHash: request.authority.definitionHash,
      expectedGrantRevision: request.grantRevision,
      expectedConnectionRevision: request.connectionRevision,
    });
    const {
      appId,
      version,
      definitionHash,
      instanceId,
      serviceId,
      dataAuthorityId,
    } = active;
    if (
      !same(request.authority, {
        appId,
        version,
        definitionHash,
        instanceId,
        serviceId,
        dataAuthorityId,
      })
    )
      fail("conflict", "命令的精确定义或稳定保存方不一致。");
    const operation = active.definition.operations.find(
      (op) => op.id === request.operationId,
    );
    if (
      !operation ||
      operation.effect !== request.effect ||
      operation.scope !== request.operationScope
    )
      fail("conflict", "命令效果或资源范围不属于已同意的不可变操作。");
  }
  async function admit(
    input: CognitiveAppAdmission,
    now = new Date().toISOString(),
  ) {
    time(now);
    const request = normalize(input);
    const prior = await lock(request.commandId);
    if (prior) {
      if (!same(admission(prior), request))
        fail("conflict", "同一命令标识已固定另一份不可变来源、目标或请求。");
      return prior;
    }
    await target(request);
    const { authority: a, actor, resources } = request;
    const source = actor.source;
    const humanActantId =
      source.kind === "human" ? actor.actantId : source.humanActantId;
    const runtimeInput =
      source.kind === "input"
        ? source.inputId
        : source.kind === "task-run"
          ? source.sourceInputId
          : null;
    await q.change(
      `INSERT INTO cognitive_app_commands(tenant_id,command_id,app_id,version,definition_hash,instance_id,service_id,data_authority_id,connection_id,connection_revision,grant_principal_id,grant_revision,project_id,operation_id,operation_scope,effect,actor_kind,actor_principal_id,actor_actant_id,initiating_human_actant_id,source_kind,runtime_input_id,runtime_session_id,runtime_schedule_id,runtime_task_run_event_id,request_hash,resources_json,revision,state,receipt_ref,receipt_hash,receipt_summary_json,committed_at,projection_state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,'admitted',NULL,NULL,NULL,NULL,'none',?,?)`,
      [
        tenantId,
        request.commandId,
        a.appId,
        a.version,
        a.definitionHash,
        a.instanceId,
        a.serviceId,
        a.dataAuthorityId,
        request.connectionId,
        request.connectionRevision,
        actor.principalId,
        request.grantRevision,
        request.projectId,
        request.operationId,
        request.operationScope,
        request.effect,
        actor.kind,
        actor.principalId,
        actor.actantId,
        humanActantId,
        source.kind,
        runtimeInput,
        source.kind === "task-run" ? source.sessionId : null,
        source.kind === "task-run" ? source.scheduleId : null,
        source.kind === "task-run" ? source.eventId : null,
        request.requestHash,
        boundedJson(resources, 32 * 1024),
        now,
        now,
      ],
    );
    return (await load(request.commandId))!;
  }
  async function dispatch(
    commandId: string,
    expectedRevision: number,
    now = new Date().toISOString(),
  ) {
    time(now);
    checkRevision(expectedRevision);
    const current = await required(commandId);
    if (current.state !== "admitted" || current.revision !== expectedRevision)
      return null;
    await target(current);
    const changed = await q.change(
      "UPDATE cognitive_app_commands SET state='dispatching',revision=revision+1,updated_at=? WHERE tenant_id=? AND command_id=? AND state='admitted' AND revision=?",
      [now, tenantId, commandId, expectedRevision],
    );
    return changed === 1 ? load(commandId) : null;
  }
  async function transition(
    commandId: string,
    expectedRevision: number,
    from: "admitted" | "dispatching",
    to: "cancelled" | "unknown",
    now: string,
  ) {
    time(now);
    checkRevision(expectedRevision);
    const current = await required(commandId);
    if (current.state !== from || current.revision !== expectedRevision)
      return null;
    const changed = await q.change(
      "UPDATE cognitive_app_commands SET state=?,revision=revision+1,updated_at=? WHERE tenant_id=? AND command_id=? AND state=? AND revision=?",
      [to, now, tenantId, commandId, from, expectedRevision],
    );
    return changed === 1 ? load(commandId) : null;
  }
  /** Host has authenticated the service; strict expected binding is rechecked here.
   * Business output-schema validation is separate and never rewrites committed fact.
   */
  async function recordReceipt(
    commandId: string,
    input: unknown,
    now = new Date().toISOString(),
  ) {
    time(now);
    const current = await required(commandId);
    const expected: DomainReceiptBinding = {
      authority: current.authority,
      actor: current.actor,
      projectId: current.projectId,
      operationId: current.operationId,
      commandId,
      requestHash: current.requestHash,
    };
    let parsed: ReturnType<typeof parseDomainReceipt>;
    let summary: string | null;
    try {
      parsed = parseDomainReceipt(input, expected);
      if (parsed.status === "unknown")
        return fail(
          "invalid",
          "未知结果不是可持久终态回执，不能转为拒绝或重新发送。",
        );
      summary =
        parsed.status === "committed"
          ? boundedJson(objects(parsed.objects), 64 * 1024)
          : null;
    } catch {
      return fail("invalid", "回执未满足完整原命令绑定与固定证据契约。");
    }
    const receiptHash = createHash("sha256")
      .update(canonicalJsonBytes(parsed))
      .digest("hex");
    if (current.state === "committed" || current.state === "rejected") {
      if (
        current.state !== parsed.status ||
        current.receiptRef !== parsed.receiptId ||
        current.receiptHash !== receiptHash
      )
        fail("conflict", "命令已固定不同的终态或回执证据。");
      return current;
    }
    if (current.state !== "dispatching" && current.state !== "unknown")
      fail("conflict", "尚未发送或确知取消的命令不能写入服务终态。");
    const changed = await q.change(
      "UPDATE cognitive_app_commands SET state=?,receipt_ref=?,receipt_hash=?,receipt_summary_json=?,committed_at=?,projection_state=?,revision=revision+1,updated_at=? WHERE tenant_id=? AND command_id=? AND revision=? AND state IN ('dispatching','unknown')",
      [
        parsed.status,
        parsed.receiptId,
        receiptHash,
        summary,
        parsed.status === "committed" ? parsed.committedAt : null,
        parsed.status === "committed" ? "pending" : "none",
        now,
        tenantId,
        commandId,
        current.revision,
      ],
    );
    if (changed !== 1) fail("conflict", "命令回执的持久修订前提已改变。");
    return (await load(commandId))!;
  }
  /** Internal acknowledgement only: Store must complete the actual content catalog
   * writes with this SAME q before calling it; no caller-supplied string is proof.
   */
  async function markProjected(
    commandId: string,
    expectedRevision: number,
    now = new Date().toISOString(),
  ) {
    time(now);
    checkRevision(expectedRevision);
    const current = await required(commandId);
    if (
      current.state !== "committed" ||
      current.projectionState !== "pending" ||
      current.revision !== expectedRevision
    )
      return null;
    const changed = await q.change(
      "UPDATE cognitive_app_commands SET projection_state='projected',revision=revision+1,updated_at=? WHERE tenant_id=? AND command_id=? AND state='committed' AND projection_state='pending' AND revision=?",
      [now, tenantId, commandId, expectedRevision],
    );
    return changed === 1 ? load(commandId) : null;
  }
  async function page(
    states: "recovery" | "projection",
    request: CognitiveAppCommandPage = {},
  ) {
    const parsed = z
      .object({
        afterCommandId: id.optional(),
        limit: z.number().int().min(1).max(32).default(32),
      })
      .strict()
      .safeParse(request);
    if (!parsed.success) return fail("invalid", "命令恢复分页前提无效。");
    const condition =
      states === "recovery"
        ? "state IN ('dispatching','unknown')"
        : "state='committed' AND projection_state='pending'";
    const rows = await q.all<Row>(
      `SELECT ${columns} FROM cognitive_app_commands WHERE tenant_id=? AND ${condition}${parsed.data.afterCommandId ? " AND command_id>?" : ""} ORDER BY command_id LIMIT ?`,
      [
        tenantId,
        ...(parsed.data.afterCommandId ? [parsed.data.afterCommandId] : []),
        parsed.data.limit,
      ],
    );
    return rows.map(dto);
  }
  async function hasOpenCommands(projectId: string) {
    checkId(projectId);
    return (
      (
        await q.all(
          "SELECT 1 AS present FROM cognitive_app_commands WHERE tenant_id=? AND project_id=? AND state IN ('admitted','dispatching','unknown') LIMIT 1",
          [tenantId, projectId],
        )
      ).length > 0
    );
  }
  async function hasPendingProjection(projectId: string) {
    checkId(projectId);
    return (
      (
        await q.all(
          "SELECT 1 AS present FROM cognitive_app_commands WHERE tenant_id=? AND project_id=? AND state='committed' AND projection_state='pending' LIMIT 1",
          [tenantId, projectId],
        )
      ).length > 0
    );
  }
  return {
    admit,
    dispatch,
    recordReceipt,
    markProjected,
    read: (commandId: string) => load(commandId),
    cancelAdmitted: (
      commandId: string,
      expectedRevision: number,
      now = new Date().toISOString(),
    ) => transition(commandId, expectedRevision, "admitted", "cancelled", now),
    markUnknown: (
      commandId: string,
      expectedRevision: number,
      now = new Date().toISOString(),
    ) => transition(commandId, expectedRevision, "dispatching", "unknown", now),
    listRecoverable: (request?: CognitiveAppCommandPage) =>
      page("recovery", request),
    listPendingProjection: (request?: CognitiveAppCommandPage) =>
      page("projection", request),
    hasOpenCommands,
    hasPendingProjection,
    /** Internal coordination only: caller holds actual project/source policy
     * before taking command identity, then mutable registry/catalog locks.
     * Reentrant admit/dispatch in this same q retain their exact checks. */
    lockForAdmission: lock,
  };
}
