import { createHash } from "node:crypto";
import { z } from "zod";
import {
  canonicalJsonBytes,
  type DomainObjectSummary,
} from "../../cognitive-app-sdk/src/domain-wire.js";
import {
  type SqlQuery,
  type SqlRow,
  safeInteger,
} from "../../storage/src/sql.js";
import {
  createCognitiveAppCommands,
  type CognitiveAppCommandSnapshot,
} from "./cognitive-app-commands.js";
import { createCognitiveAppRegistry } from "./cognitive-app-registry.js";

/** Internal committed-fact projection only. The owner supplies one transaction
 * and authenticated policy; this module opens no transaction or network and
 * grants no read/write permission. Disabling access does not erase an original
 * commit. Only the exact persisted, verified command can reach this purpose.
 */
export type CognitiveAppProjectionContext = {
  q: SqlQuery;
  backend: "sqlite" | "postgres";
  tenantId: string;
  fail(
    code: "invalid" | "forbidden" | "not_found" | "conflict",
    message: string,
  ): never;
};
export type CognitiveAppProjectionRequest = {
  commandId: string;
  expectedRevision: number;
  now?: string;
};
export type CognitiveAppProjectionResult = {
  command: CognitiveAppCommandSnapshot;
  contentIds: string[];
  /** Catalog changes only, not delivery/projection bookkeeping. The owner
   * advances existing navigation/commit notifications in the same transaction.
   */
  changed: boolean;
};
type CatalogRow = SqlRow & {
  content_id: string;
  app_id: string;
  project_id: string;
  kind: string;
  observed_version_ref: string | null;
  revision: number | string;
  deleted_at: string | null;
  availability: string;
};
type Plan = {
  object: DomainObjectSummary;
  contentId: string;
  previous: CatalogRow | null;
  revision: number;
  changed: boolean;
  eventId: string;
  operation: "record-content" | "refresh-content";
  eventKind: "content.recorded" | "content.refreshed";
  payload: string;
  requestHash: string;
};
const requestShape = z
  .object({
    commandId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
    expectedRevision: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER - 1),
    now: z.string().max(64).pipe(z.iso.datetime()).optional(),
  })
  .strict();
const committedProof = z
  .object({
    receiptRef: z.string().min(1).max(200),
    receiptHash: z.string().regex(/^[a-f0-9]{64}$/),
    committedAt: z.string().max(64).pipe(z.iso.datetime()),
  })
  .strict();
const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown) =>
  new TextDecoder().decode(canonicalJsonBytes(value));
// Match existing content identity, without changing or imposing it on legacy IDs.
const contentIdFor = (tenant: string, instance: string, object: string) =>
  `content_${digest(JSON.stringify([tenant, instance, object])).slice(0, 40)}`;

export function createCognitiveAppProjection(
  context: CognitiveAppProjectionContext,
) {
  const { q, backend, tenantId, fail } = context;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(tenantId))
    fail("invalid", "目录投影租户无效。");
  const commands = createCognitiveAppCommands(context);
  const shared = backend === "postgres" ? " FOR SHARE" : "";
  const exclusive = backend === "postgres" ? " FOR UPDATE" : "";
  const conflict: () => never = () =>
    fail("conflict", "已提交原件与保留目录或来源事实不一致，不能覆盖或改绑。");

  async function retainedAuthority(command: CognitiveAppCommandSnapshot) {
    const authority = command.authority;
    const registry = createCognitiveAppRegistry({
      ...context,
      principalId: command.actor.principalId,
    });
    const version = await registry.lockRetainedVersion({
      appId: authority.appId,
      version: authority.version,
      expectedDefinitionHash: authority.definitionHash,
    });
    const operation = version.definition.operations.find(
      (op) => op.id === command.operationId,
    );
    if (
      !operation ||
      operation.effect !== command.effect ||
      operation.scope !== command.operationScope
    )
      conflict();
    // Follow registry's installation -> grant -> instance -> connection order.
    // Revisions/states are intentionally current, not replacements for original
    // admission snapshots. This is not a dispatch or a new business write.
    const grants = await q.all(
      `SELECT principal_id FROM cognitive_app_grants WHERE tenant_id=? AND principal_id=? AND app_id=? AND version=?${shared}`,
      [tenantId, command.actor.principalId, authority.appId, authority.version],
    );
    if (grants.length !== 1) conflict();
    const instance = (
      await q.all<
        SqlRow & {
          route_kind: string;
          node_id: string | null;
          route_ref: string;
          service_id: string;
          data_authority_id: string;
        }
      >(
        `SELECT i.route_kind,i.node_id,i.route_ref,a.service_id,a.data_authority_id FROM app_instances i JOIN cognitive_app_authorities a ON a.tenant_id=i.tenant_id AND a.app_id=i.app_id AND a.instance_id=i.instance_id WHERE i.tenant_id=? AND i.app_id=? AND i.instance_id=?${backend === "postgres" ? " FOR SHARE OF i,a" : ""}`,
        [tenantId, authority.appId, authority.instanceId],
      )
    )[0];
    if (
      !instance ||
      instance.route_kind !== "service" ||
      instance.node_id !== null ||
      instance.service_id !== authority.serviceId ||
      instance.data_authority_id !== authority.dataAuthorityId ||
      instance.route_ref !==
        `cognitive_authority_${digest(JSON.stringify([tenantId, authority.appId, authority.serviceId, authority.dataAuthorityId]))}`
    )
      conflict();
    const connections = await q.all(
      `SELECT connection_id FROM cognitive_app_connections WHERE tenant_id=? AND connection_id=? AND owner_principal_id=? AND app_id=? AND instance_id=? AND service_id=? AND data_authority_id=?${shared}`,
      [
        tenantId,
        command.connectionId,
        command.actor.principalId,
        authority.appId,
        authority.instanceId,
        authority.serviceId,
        authority.dataAuthorityId,
      ],
    );
    if (connections.length !== 1) conflict();
  }

  async function planObject(
    command: CognitiveAppCommandSnapshot,
    object: DomainObjectSummary,
  ): Promise<Plan> {
    const authority = command.authority;
    if (backend === "postgres")
      await q.all(
        "SELECT pg_advisory_xact_lock(hashtextextended(?,0)) AS locked",
        [
          JSON.stringify([
            "cognitive-catalog/v1",
            tenantId,
            authority.instanceId,
            object.objectId,
          ]),
        ],
      );
    const previous =
      (
        await q.all<CatalogRow>(
          `SELECT content_id,app_id,project_id,kind,observed_version_ref,revision,deleted_at,availability FROM content_entries WHERE tenant_id=? AND instance_id=? AND app_object_id=?${exclusive}`,
          [tenantId, authority.instanceId, object.objectId],
        )
      )[0] ?? null;
    let revision = 1;
    let changed = true;
    if (previous) {
      if (
        previous.app_id !== authority.appId ||
        previous.project_id !== command.projectId ||
        previous.kind !== object.kind ||
        previous.deleted_at !== null ||
        previous.availability === "deleted"
      )
        conflict();
      try {
        revision = safeInteger(previous.revision, "目录修订");
      } catch {
        return conflict();
      }
      if (revision < 1 || revision >= Number.MAX_SAFE_INTEGER) conflict();
      if (previous.observed_version_ref === object.versionRef) {
        // Same opaque version does not authorize rewriting manual presentation.
        changed = false;
      } else {
        const baseline = command.resources.find(
          (resource) => resource.objectId === object.objectId,
        );
        if (!baseline || baseline.versionRef !== previous.observed_version_ref)
          conflict();
        revision++;
      }
    }
    const contentId =
      previous?.content_id ??
      contentIdFor(tenantId, authority.instanceId, object.objectId);
    const eventId = `cognitive_delivery_${digest(JSON.stringify([tenantId, command.commandId, command.receiptHash, object.objectId])).slice(0, 40)}`;
    const operation = previous ? "refresh-content" : "record-content";
    const eventKind = previous ? "content.refreshed" : "content.recorded";
    const payload = canonical({
      instanceId: authority.instanceId,
      objectId: object.objectId,
      projectId: command.projectId,
      observedVersionRef: object.versionRef,
      appReceiptId: command.receiptRef,
      cognitiveCommandId: command.commandId,
      authority,
      actor: command.actor,
      requestHash: command.requestHash,
      receiptHash: command.receiptHash,
      committedAt: command.committedAt,
      kind: object.kind,
      title: object.title,
    });
    if (Buffer.byteLength(payload, "utf8") > 16 * 1024) conflict();
    return {
      object,
      contentId,
      previous,
      revision,
      changed,
      eventId,
      operation,
      eventKind,
      payload,
      requestHash: digest(payload),
    };
  }

  const sourceInput = (command: CognitiveAppCommandSnapshot) => {
    const source = command.actor.source;
    return source.kind === "input"
      ? source.inputId
      : source.kind === "task-run"
        ? source.sourceInputId
        : null;
  };
  async function verifyDeliveryCollision(
    command: CognitiveAppCommandSnapshot,
    plan: Plan,
  ) {
    const receipt = (
      await q.all<SqlRow>(
        `SELECT request_hash,actor_principal_id,actor_actant_id,runtime_input_id,operation,result_ref,committed_at FROM command_receipts WHERE tenant_id=? AND command_id=?${exclusive}`,
        [tenantId, plan.eventId],
      )
    )[0];
    const event = (
      await q.all<SqlRow>(
        `SELECT aggregate_kind,aggregate_id,aggregate_revision,event_kind,payload,created_at FROM outbox WHERE tenant_id=? AND event_id=?${exclusive}`,
        [tenantId, plan.eventId],
      )
    )[0];
    if (!receipt && !event) return;
    if (
      !receipt ||
      !event ||
      receipt.request_hash !== plan.requestHash ||
      receipt.actor_principal_id !== command.actor.principalId ||
      receipt.actor_actant_id !== command.actor.actantId ||
      receipt.runtime_input_id !== sourceInput(command) ||
      receipt.operation !== plan.operation ||
      receipt.result_ref !== plan.contentId ||
      receipt.committed_at !== command.committedAt ||
      event.aggregate_kind !== "content" ||
      event.aggregate_id !== plan.contentId ||
      Number(event.aggregate_revision) !== plan.revision ||
      event.event_kind !== plan.eventKind ||
      event.payload !== plan.payload ||
      event.created_at !== command.committedAt
    )
      conflict();
  }

  async function writePlan(command: CognitiveAppCommandSnapshot, plan: Plan) {
    const { object, previous } = plan;
    if (!previous) {
      const inserted = await q.change(
        "INSERT INTO content_entries(tenant_id,content_id,app_id,instance_id,app_object_id,project_id,kind,title,observed_version_ref,observed_at,availability,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'available',1,?,?) ON CONFLICT DO NOTHING",
        [
          tenantId,
          plan.contentId,
          command.authority.appId,
          command.authority.instanceId,
          object.objectId,
          command.projectId,
          object.kind,
          object.title,
          object.versionRef,
          command.committedAt,
          command.committedAt,
          command.committedAt,
        ],
      );
      // Another writer may use legacy paths without our identity key lock. Never
      // merge its different ownership/version or pretend this insert succeeded.
      if (inserted !== 1) conflict();
    } else if (plan.changed) {
      const updated = await q.change(
        "UPDATE content_entries SET title=?,observed_version_ref=?,observed_at=?,availability='available',revision=revision+1,updated_at=? WHERE tenant_id=? AND content_id=? AND app_id=? AND instance_id=? AND app_object_id=? AND project_id=? AND kind=? AND revision=? AND observed_version_ref=? AND deleted_at IS NULL AND availability<>'deleted'",
        [
          object.title,
          object.versionRef,
          command.committedAt,
          command.committedAt,
          tenantId,
          plan.contentId,
          command.authority.appId,
          command.authority.instanceId,
          object.objectId,
          command.projectId,
          object.kind,
          plan.revision - 1,
          previous.observed_version_ref,
        ],
      );
      if (updated !== 1) conflict();
    }
    await q.change(
      "INSERT INTO command_receipts(tenant_id,command_id,request_hash,actor_principal_id,actor_actant_id,runtime_input_id,operation,result_ref,committed_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
      [
        tenantId,
        plan.eventId,
        plan.requestHash,
        command.actor.principalId,
        command.actor.actantId,
        sourceInput(command),
        plan.operation,
        plan.contentId,
        command.committedAt,
      ],
    );
    await q.change(
      "INSERT INTO outbox(tenant_id,event_id,aggregate_kind,aggregate_id,aggregate_revision,event_kind,payload,created_at) VALUES(?,?,'content',?,?,?,?,?) ON CONFLICT DO NOTHING",
      [
        tenantId,
        plan.eventId,
        plan.contentId,
        plan.revision,
        plan.eventKind,
        plan.payload,
        command.committedAt,
      ],
    );
    // Also verify collisions that arrived after the preflight read. Never update
    // an existing receipt, source or delivery flag to make a retry appear exact.
    await verifyDeliveryCollision(command, plan);
  }

  async function projectCommitted(
    request: CognitiveAppProjectionRequest,
  ): Promise<CognitiveAppProjectionResult | null> {
    let parsed: z.infer<typeof requestShape>;
    try {
      parsed = requestShape.parse(request);
    } catch {
      return fail("invalid", "目录投影必须指定确切命令和修订。");
    }
    // Locate immutable project without taking the command lock first: all Store
    // policy/retirement paths use project -> command -> registry -> catalog.
    const located = await commands.read(parsed.commandId);
    if (!located) return fail("not_found", "命令尚未受理。");
    const projects = await q.all<{ kind: string }>(
      `SELECT kind FROM projects WHERE tenant_id=? AND project_id=?${shared}`,
      [tenantId, located.projectId],
    );
    if (
      projects.length !== 1 ||
      !["project", "desk"].includes(projects[0]!.kind)
    )
      conflict();
    const command = await commands.lockForAdmission(parsed.commandId);
    if (!command || command.projectId !== located.projectId) conflict();
    if (
      command.state !== "committed" ||
      command.projectionState !== "pending" ||
      command.revision !== parsed.expectedRevision
    )
      return null;
    try {
      committedProof.parse({
        receiptRef: command.receiptRef,
        receiptHash: command.receiptHash,
        committedAt: command.committedAt,
      });
    } catch {
      return conflict();
    }
    if (command.objects === null) conflict();
    await retainedAuthority(command);
    const plans: Plan[] = [];
    for (const object of [...command.objects].sort((a, b) =>
      a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0,
    ))
      plans.push(await planObject(command, object));
    // All collision/premise checks precede writes; any later SQL or mark failure
    // must roll back the owner's whole transaction, including all object rows.
    for (const plan of plans) await verifyDeliveryCollision(command, plan);
    for (const plan of plans) await writePlan(command, plan);
    const projected = await commands.markProjected(
      command.commandId,
      command.revision,
      parsed.now ?? new Date().toISOString(),
    );
    if (!projected) conflict();
    return {
      command: projected,
      contentIds: plans.map((plan) => plan.contentId),
      changed: plans.some((plan) => plan.changed),
    };
  }
  return { projectCommitted };
}
