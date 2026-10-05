import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  domainProtocol,
  isPortableText,
  parseOperationResources,
  parseProtocolValue,
  validateOperationValue,
  type JsonValue,
} from "../../cognitive-app-sdk/src/protocol.js";
import {
  canonicalInvokeIdentityBytes,
  canonicalJsonBytes,
  parseDescribeRequest,
  parseDescribeResponse,
  parseInvokeRequest,
  parseInvokeResponse,
  parseObjectReadRequest,
  parseObjectReadResponse,
  parseReceiptReadRequest,
  parseDomainReceipt,
  type DomainActor,
  type DomainAuthorityReference,
  type DomainCommittedReceipt,
  type DomainObjectReadResponse,
  type DomainReceipt,
  type DomainReceiptBinding,
} from "../../cognitive-app-sdk/src/domain-wire.js";
import {
  PlatformStorageError,
  type PlatformActor,
  type PlatformStore,
  type CognitiveAppCommandRequest,
  type PreparedCognitiveAppCommand,
} from "../../platform/src/store.js";
import type { CognitiveAppCommandSnapshot } from "../../platform/src/cognitive-app-commands.js";
import type { CognitiveAppTargetSnapshot } from "../../platform/src/cognitive-app-registry.js";
import { CognitiveAppBindings } from "./cognitive-app-bindings.js";
import {
  CognitiveAppTransport,
  type CognitiveAppTransportLease,
} from "./cognitive-app-transport.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const opaque = z.string().min(1).max(200).refine(isPortableText);
const revision = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER - 1);
const target = z.object({
  appId: z.string().regex(/^[a-z][a-z0-9.-]{2,80}$/),
  version: z
    .string()
    .max(100)
    .regex(/^\d+\.\d+\.\d+$/),
  connectionId: id,
  expectedDefinitionHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  expectedGrantRevision: revision.optional(),
  expectedConnectionRevision: revision.optional(),
});
const invokeShape = target
  .extend({
    projectId: id,
    operationId: opaque,
    parameters: z.unknown(),
    resources: z.unknown(),
    commandId: id.optional(),
  })
  .strict();
const objectReadShape = target
  .extend({
    projectId: id,
    object: z.object({ objectId: opaque, versionRef: opaque }).strict(),
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(256 * 1024),
  })
  .strict();
const connectShape = z
  .object({
    appId: target.shape.appId,
    version: target.shape.version,
    expectedDefinitionHash: target.shape.expectedDefinitionHash,
    expectedGrantRevision: target.shape.expectedGrantRevision,
    connectionId: id,
    expectedRevision: z.literal(0),
    serviceId: opaque,
    dataAuthorityId: opaque,
  })
  .strict();
const hostCommand = z.object({ tenantId: id, commandId: id }).strict();
const recoveryPage = z
  .object({
    tenantId: id,
    limit: z.number().int().min(1).max(32).optional(),
    afterCommandId: id.optional(),
  })
  .strict();
const connectionStateShape = z
  .object({
    appId: target.shape.appId,
    version: target.shape.version,
    connectionId: id,
    expectedRevision: revision,
    state: z.enum(["active", "disabled", "unavailable"]),
    expectedDefinitionHash: target.shape.expectedDefinitionHash,
    expectedGrantRevision: target.shape.expectedGrantRevision,
    now: z.string().max(64).pipe(z.iso.datetime()).optional(),
  })
  .strict();
function detached<S extends z.ZodType>(shape: S, input: unknown): z.output<S> {
  try {
    // Validate before serialization, then capture independent finite JSON before
    // the first await. z.unknown() must not retain caller parameters/resources.
    const value: unknown = JSON.parse(
      new TextDecoder().decode(canonicalJsonBytes(input)),
    );
    return shape.parse(value);
  } catch {
    throw new CognitiveAppGatewayError("invalid");
  }
}
function captured<T>(value: T): T {
  return JSON.parse(new TextDecoder().decode(canonicalJsonBytes(value))) as T;
}

export type CognitiveAppGatewayInvokeRequest = z.infer<typeof invokeShape>;
export type CognitiveAppGatewayObjectReadRequest = z.infer<
  typeof objectReadShape
>;
export type CognitiveAppGatewayConnectRequest = z.infer<typeof connectShape>;
/** Distinct real Platform read port, not a fabricated domain operation. */
export type CognitiveAppResolvedObjectRead = {
  actor: DomainActor;
  target: CognitiveAppTargetSnapshot;
  object: CognitiveAppGatewayObjectReadRequest["object"];
  maxBytes: number;
};
export type CognitiveAppGatewayProjection = {
  command: CognitiveAppCommandSnapshot;
  contentIds: string[];
  changed: boolean;
};
/** Host-internal typed ports. No q, credential resolver, state setter or author
 * URL is offered to a Client/model. The required projector performs real same-q
 * catalog writes before acknowledging; this module cannot acknowledge itself. */
export type CognitiveAppGatewayPlatform = Pick<
  PlatformStore,
  | "readCognitiveAppConnectionCreation"
  | "prepareCognitiveAppConnection"
  | "createVerifiedCognitiveAppConnection"
  | "changeCognitiveAppConnectionState"
  | "getCognitiveAppHostConnection"
  | "resolveCognitiveAppOperation"
  | "admitCognitiveAppCommand"
  | "dispatchCognitiveAppCommand"
  | "inspectCognitiveAppCommand"
  | "prepareCognitiveAppReceiptRecovery"
  | "recordCognitiveAppCommandReceipt"
  | "markCognitiveAppCommandUnknown"
  | "cancelAdmittedCognitiveAppCommand"
  | "listRecoverableCognitiveAppCommands"
  | "listPendingCognitiveAppCommandProjections"
> & {
  resolveCognitiveAppObjectRead(
    access: PlatformActor,
    request: CognitiveAppGatewayObjectReadRequest,
  ): Promise<CognitiveAppResolvedObjectRead>;
  projectCognitiveAppCommand(request: {
    tenantId: string;
    commandId: string;
    expectedCommandRevision: number;
  }): Promise<CognitiveAppGatewayProjection | null>;
};
type Issue = "invalid-output";
export type CognitiveAppGatewayCommandResult = {
  kind: "command";
  commandId: string;
  /** Last actual Platform snapshot, never fabricated into a terminal state. */
  command: CognitiveAppCommandSnapshot;
  result?: JsonValue;
  contractIssue?: Issue;
  hostIssue?: "receipt-storage" | "projection-pending" | "unconfirmed";
  contentIds?: readonly string[];
  /** A validated author fact is separate from failed Host durable storage. */
  observedCommitted?: {
    receiptId: string;
    receiptHash: string;
    committedAt: string;
    objects: DomainCommittedReceipt["objects"];
  };
  persistence?: "pending";
};
export type CognitiveAppGatewayInvokeResult =
  | {
      kind: "read";
      authority: DomainAuthorityReference;
      operationId: string;
      result: JsonValue;
      command: null;
    }
  | CognitiveAppGatewayCommandResult;
type Reason =
  | "invalid"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "busy"
  | "unavailable"
  | "contract";
const messages: Record<Reason, string> = {
  invalid: "应用请求不符合固定契约。",
  forbidden: "应用调用未获授权；已有或已发出的命令不会因此回滚。",
  not_found: "当前应用或命令不可用。",
  conflict: "调用前提或固定命令身份冲突；不会自动重新发送。",
  busy: "应用连接正忙；尚未受理新的调用。",
  unavailable: "应用服务暂不可用；已有命令事实保留。",
  contract: "应用返回的数据不符合已同意的契约。",
};
/** Safe API error: no external cause, route, alias, secret or body. */
export class CognitiveAppGatewayError extends Error {
  constructor(
    readonly reason: Reason,
    readonly commandId?: string,
  ) {
    super(messages[reason]);
    this.name = "CognitiveAppGatewayError";
  }
}
const safe = (error: unknown, commandId?: string): CognitiveAppGatewayError => {
  if (error instanceof CognitiveAppGatewayError)
    return new CognitiveAppGatewayError(
      error.reason,
      commandId ?? error.commandId,
    );
  if (
    error instanceof PlatformStorageError &&
    ["invalid", "forbidden", "not_found", "conflict"].includes(error.code)
  )
    return new CognitiveAppGatewayError(error.code as Reason, commandId);
  return new CognitiveAppGatewayError("unavailable", commandId);
};
const same = (a: unknown, b: unknown) =>
  Buffer.from(canonicalJsonBytes(a)).equals(Buffer.from(canonicalJsonBytes(b)));
const authority = (
  value: CognitiveAppTargetSnapshot,
): DomainAuthorityReference => {
  const {
    appId,
    version,
    definitionHash,
    instanceId,
    serviceId,
    dataAuthorityId,
  } = value;
  return {
    appId,
    version,
    definitionHash,
    instanceId,
    serviceId,
    dataAuthorityId,
  };
};
// Compare immutable read premises, not mutable permission revisions. Each
// fresh Platform resolution checks current policy and any caller-supplied CAS.
const operationReadPremises = (
  resolved: Awaited<
    ReturnType<CognitiveAppGatewayPlatform["resolveCognitiveAppOperation"]>
  >,
) => ({
  actor: resolved.actor,
  authority: authority(resolved.target),
  connectionId: resolved.target.connectionId,
  operation: resolved.operation,
  parameters: resolved.parameters,
  resources: resolved.resources,
});
const objectReadPremises = (resolved: CognitiveAppResolvedObjectRead) => ({
  actor: resolved.actor,
  authority: authority(resolved.target),
  connectionId: resolved.target.connectionId,
  object: resolved.object,
  maxBytes: resolved.maxBytes,
});
const expected = (
  command: CognitiveAppCommandSnapshot,
): DomainReceiptBinding => ({
  authority: command.authority,
  actor: command.actor,
  projectId: command.projectId,
  operationId: command.operationId,
  commandId: command.commandId,
  requestHash: command.requestHash,
});
const commandResult = (
  command: CognitiveAppCommandSnapshot,
): CognitiveAppGatewayCommandResult => ({
  kind: "command",
  commandId: command.commandId,
  command,
});
const key = (tenantId: string, connectionId: string) =>
  JSON.stringify(["morphz-cognitive-connection/v1", tenantId, connectionId]);
const expiresAt = () => new Date(Date.now() + 30_000).toISOString();

export function createCognitiveAppGateway(options: {
  platform: CognitiveAppGatewayPlatform;
  bindings: Pick<
    CognitiveAppBindings,
    "prepareConnection" | "resolveConnection" | "resolveReceipt"
  >;
  transport: Pick<CognitiveAppTransport, "tryAcquire">;
}) {
  const { platform, bindings, transport } = options;
  if (typeof platform.projectCognitiveAppCommand !== "function")
    throw new CognitiveAppGatewayError("unavailable");
  const acquire = (
    tenantId: string,
    connectionId: string,
    commandId?: string,
  ) => {
    const lease = transport.tryAcquire(key(tenantId, connectionId));
    if (!lease) throw new CognitiveAppGatewayError("busy", commandId);
    return lease;
  };
  async function active(
    access: PlatformActor,
    actor: DomainActor,
    target: DomainAuthorityReference & { connectionId: string },
    projectId: string,
  ) {
    const connection = await platform.getCognitiveAppHostConnection(access, {
      appId: target.appId,
      instanceId: target.instanceId,
      serviceId: target.serviceId,
      dataAuthorityId: target.dataAuthorityId,
      connectionId: target.connectionId,
      projectId,
    });
    return bindings.resolveConnection(
      {
        tenantId: actor.tenantId,
        principalId: actor.principalId,
        appId: target.appId,
        serviceId: target.serviceId,
        dataAuthorityId: target.dataAuthorityId,
      },
      connection.hostBindingId,
    );
  }
  async function unknown(command: CognitiveAppCommandSnapshot) {
    try {
      const marked =
        command.state === "dispatching"
          ? await platform.markCognitiveAppCommandUnknown({
              tenantId: command.actor.tenantId,
              commandId: command.commandId,
              expectedCommandRevision: command.revision,
            })
          : null;
      return {
        ...commandResult(marked ?? command),
        hostIssue: "unconfirmed" as const,
      };
    } catch {
      // Do not invent a durable update if storage was unavailable. Dispatching
      // is already uncertain and cannot be invoked again by this Gateway.
      return { ...commandResult(command), hostIssue: "unconfirmed" as const };
    }
  }
  async function project(command: CognitiveAppCommandSnapshot) {
    if (command.state !== "committed" || command.projectionState !== "pending")
      return commandResult(command);
    try {
      const projection = await platform.projectCognitiveAppCommand({
        tenantId: command.actor.tenantId,
        commandId: command.commandId,
        expectedCommandRevision: command.revision,
      });
      if (projection)
        return {
          ...commandResult(projection.command),
          contentIds: projection.contentIds,
        };
    } catch {
      /* Known committed fact is not rewritten by catalog failure. */
    }
    return {
      ...commandResult(command),
      hostIssue: "projection-pending" as const,
    };
  }
  async function terminal(
    command: CognitiveAppCommandSnapshot,
    receipt: Exclude<DomainReceipt, { status: "unknown" }>,
    operation: PreparedCognitiveAppCommand["operation"],
  ): Promise<CognitiveAppGatewayCommandResult> {
    let recorded: CognitiveAppCommandSnapshot;
    try {
      recorded = await platform.recordCognitiveAppCommandReceipt({
        tenantId: command.actor.tenantId,
        commandId: command.commandId,
        receipt,
      });
    } catch (error) {
      // A deterministic ledger rejection is not an unavailable write. In
      // particular, a different receipt must not cover an earlier terminal fact
      // with a new "observed committed" account of the same command.
      if (
        receipt.status !== "committed" ||
        error instanceof PlatformStorageError ||
        error instanceof CognitiveAppGatewayError
      )
        throw safe(error, command.commandId);
      const observed: CognitiveAppGatewayCommandResult = {
        ...commandResult(command),
        persistence: "pending",
        hostIssue: "receipt-storage",
        observedCommitted: {
          receiptId: receipt.receiptId,
          receiptHash: createHash("sha256")
            .update(canonicalJsonBytes(receipt))
            .digest("hex"),
          committedAt: receipt.committedAt,
          objects: receipt.objects,
        },
      };
      try {
        observed.result = validateOperationValue(
          operation.outputSchema,
          receipt.result,
        );
      } catch {
        observed.contractIssue = "invalid-output";
      }
      return observed;
    }
    const answer = await project(recorded);
    if (receipt.status === "committed") {
      try {
        answer.result = validateOperationValue(
          operation.outputSchema,
          receipt.result,
        );
      } catch {
        answer.contractIssue = "invalid-output";
      }
    }
    return answer;
  }
  async function connect(
    access: PlatformActor,
    input: CognitiveAppGatewayConnectRequest,
    signal?: AbortSignal,
  ) {
    let lease: CognitiveAppTransportLease | undefined;
    try {
      const request = detached(connectShape, input);
      const committed = await platform.readCognitiveAppConnectionCreation(
        access,
        request,
      );
      if (committed) return committed;
      const prepared = await platform.prepareCognitiveAppConnection(access, {
        appId: request.appId,
        version: request.version,
        expectedDefinitionHash: request.expectedDefinitionHash,
        expectedGrantRevision: request.expectedGrantRevision,
      });
      const handle = bindings.prepareConnection({
        tenantId: prepared.actor.tenantId,
        principalId: prepared.actor.principalId,
        appId: prepared.version.appId,
        serviceId: request.serviceId,
        dataAuthorityId: request.dataAuthorityId,
      });
      lease = acquire(prepared.actor.tenantId, request.connectionId);
      const describe = parseDescribeRequest({
        protocol: domainProtocol,
        definition: {
          appId: prepared.version.appId,
          version: prepared.version.version,
          definitionHash: prepared.version.definitionHash,
        },
      });
      const raw = await handle.describe(lease, describe, signal);
      let response: ReturnType<typeof parseDescribeResponse>;
      try {
        response = parseDescribeResponse(raw, describe);
      } catch {
        throw new CognitiveAppGatewayError("contract");
      }
      if (
        response.serviceId !== request.serviceId ||
        response.dataAuthorityId !== request.dataAuthorityId
      )
        throw new CognitiveAppGatewayError("contract");
      return await platform.createVerifiedCognitiveAppConnection(access, {
        request,
        verifiedGrantRevision: prepared.grant.revision,
        verifiedActor: prepared.actor,
        proof: {
          purpose: "connection-setup",
          ...response.definition,
          serviceId: response.serviceId,
          dataAuthorityId: response.dataAuthorityId,
          hostBindingId: handle.hostBindingId,
        },
      });
    } catch (error) {
      throw safe(error);
    } finally {
      lease?.release();
    }
  }
  async function invoke(
    access: PlatformActor,
    input: CognitiveAppGatewayInvokeRequest,
    signal?: AbortSignal,
  ): Promise<CognitiveAppGatewayInvokeResult> {
    let commandId: string | undefined,
      lease: CognitiveAppTransportLease | undefined;
    try {
      const request = detached(invokeShape, input);
      commandId = request.commandId;
      try {
        request.parameters = parseProtocolValue(request.parameters);
        request.resources = parseOperationResources(
          "project",
          request.resources,
        );
      } catch {
        throw new CognitiveAppGatewayError("invalid", commandId);
      }
      let known: CognitiveAppCommandSnapshot | undefined;
      if (commandId) {
        try {
          known = await platform.inspectCognitiveAppCommand(access, {
            projectId: request.projectId,
            commandId,
          });
        } catch (error) {
          if (!(
            error instanceof PlatformStorageError && error.code === "not_found"
          ))
            throw error;
        }
      }
      if (known) {
        // Only a real own snapshot selects this key. Historical admission still
        // compares the actual actor/source, parameters and all immutable fields.
        lease = acquire(known.actor.tenantId, known.connectionId, commandId);
        const prepared = await platform.admitCognitiveAppCommand(access, {
          ...request,
          commandId: commandId!,
        });
        if (prepared.command.state !== "admitted")
          return await project(prepared.command);
        return await dispatch(
          access,
          { ...request, commandId: commandId! },
          prepared,
          lease,
          signal,
        );
      }
      let resolved = await platform.resolveCognitiveAppOperation(
        access,
        request,
      );
      if (resolved.operation.effect === "read") {
        if (commandId) throw new CognitiveAppGatewayError("invalid", commandId);
        lease = acquire(resolved.actor.tenantId, resolved.target.connectionId);
        const bound = captured(operationReadPremises(resolved));
        const handle = await active(
          access,
          bound.actor,
          { ...bound.authority, connectionId: bound.connectionId },
          request.projectId,
        );
        resolved = await platform.resolveCognitiveAppOperation(access, request);
        if (!same(bound, operationReadPremises(resolved)))
          throw new CognitiveAppGatewayError("conflict");
        if (resolved.operation.effect !== "read")
          throw new CognitiveAppGatewayError("conflict");
        const wire = parseInvokeRequest(
          {
            protocol: domainProtocol,
            delegation: {
              issuer: handle.issuer,
              expiresAt: expiresAt(),
              purpose: "invoke",
              authority: authority(resolved.target),
              actor: resolved.actor,
              projectId: request.projectId,
              operationId: resolved.operation.id,
              resources: resolved.resources,
              command: null,
            },
            parameters: resolved.parameters,
          },
          "read",
          resolved.operation.scope,
        );
        const raw = await handle.invoke(lease, wire, signal);
        // Use the concrete read overload rather than a union/fake command.
        let result: JsonValue;
        try {
          const read = parseInvokeResponse(raw, "read", {
            authority: wire.delegation.authority,
            operationId: resolved.operation.id,
          });
          result = validateOperationValue(
            resolved.operation.outputSchema,
            read.result,
          );
        } catch {
          throw new CognitiveAppGatewayError("contract");
        }
        // The authenticated author has already returned data, not a write.
        // Network wait must not preserve revoked disclosure authority. Recheck
        // current policy in its own completed transaction before returning any
        // result, keeping the original actor/source/target and request exact.
        const current = await platform.resolveCognitiveAppOperation(
          access,
          request,
        );
        if (!same(bound, operationReadPremises(current)))
          throw new CognitiveAppGatewayError("conflict");
        return {
          kind: "read",
          authority: wire.delegation.authority,
          operationId: wire.delegation.operationId,
          result,
          command: null,
        };
      }
      commandId ??= `cognitive_command_${randomUUID()}`;
      lease = acquire(
        resolved.actor.tenantId,
        resolved.target.connectionId,
        commandId,
      );
      // Detect missing private current route before creating a fresh admission.
      await active(access, resolved.actor, resolved.target, request.projectId);
      const prepared = await platform.admitCognitiveAppCommand(access, {
        ...request,
        commandId,
      });
      if (prepared.command.state !== "admitted")
        return await project(prepared.command);
      return await dispatch(
        access,
        { ...request, commandId },
        prepared,
        lease,
        signal,
      );
    } catch (error) {
      throw safe(error, commandId);
    } finally {
      lease?.release();
    }
  }
  async function dispatch(
    access: PlatformActor,
    request: CognitiveAppCommandRequest,
    prepared: PreparedCognitiveAppCommand,
    lease: CognitiveAppTransportLease,
    signal?: AbortSignal,
  ) {
    const c = prepared.command;
    const handle = await active(
      access,
      c.actor,
      { ...c.authority, connectionId: c.connectionId },
      c.projectId,
    );
    const dispatched = await platform.dispatchCognitiveAppCommand(access, {
      ...request,
      expectedCommandRevision: c.revision,
    });
    if (!dispatched)
      return commandResult(
        await platform.inspectCognitiveAppCommand(access, {
          projectId: c.projectId,
          commandId: c.commandId,
        }),
      );
    const command = dispatched.command,
      operation = dispatched.operation;
    // From this point, any failure is uncertain. Never call invoke a second time.
    let receipt: DomainReceipt;
    try {
      if (
        !same(expected(c), expected(command)) ||
        c.connectionId !== command.connectionId
      )
        throw new CognitiveAppGatewayError("conflict", command.commandId);
      const wire = parseInvokeRequest(
        {
          protocol: domainProtocol,
          delegation: {
            issuer: handle.issuer,
            expiresAt: expiresAt(),
            purpose: "invoke",
            authority: command.authority,
            actor: command.actor,
            projectId: command.projectId,
            operationId: command.operationId,
            resources: command.resources,
            command: {
              commandId: command.commandId,
              requestHash: command.requestHash,
            },
          },
          parameters: dispatched.parameters,
        },
        command.effect,
        command.operationScope,
      );
      if (
        createHash("sha256")
          .update(
            canonicalInvokeIdentityBytes(
              wire,
              command.effect,
              command.operationScope,
            ),
          )
          .digest("hex") !== command.requestHash
      )
        throw new CognitiveAppGatewayError("conflict", command.commandId);
      receipt = parseInvokeResponse(
        await handle.invoke(lease, wire, signal),
        command.effect,
        expected(command),
      );
    } catch {
      return unknown(command);
    }
    if (receipt.status === "unknown") return unknown(command);
    return terminal(command, receipt, operation);
  }
  async function readObject(
    access: PlatformActor,
    input: CognitiveAppGatewayObjectReadRequest,
    signal?: AbortSignal,
  ): Promise<DomainObjectReadResponse> {
    let lease: CognitiveAppTransportLease | undefined;
    try {
      const request = detached(objectReadShape, input);
      let resolved = await platform.resolveCognitiveAppObjectRead(
        access,
        request,
      );
      lease = acquire(resolved.actor.tenantId, resolved.target.connectionId);
      const bound = captured(objectReadPremises(resolved));
      const handle = await active(
        access,
        bound.actor,
        { ...bound.authority, connectionId: bound.connectionId },
        request.projectId,
      );
      resolved = await platform.resolveCognitiveAppObjectRead(access, request);
      if (!same(bound, objectReadPremises(resolved)))
        throw new CognitiveAppGatewayError("conflict");
      const wire = parseObjectReadRequest({
        protocol: domainProtocol,
        delegation: {
          issuer: handle.issuer,
          expiresAt: expiresAt(),
          purpose: "object-read",
          authority: authority(resolved.target),
          actor: resolved.actor,
          projectId: request.projectId,
          resource: resolved.object,
        },
        object: resolved.object,
        maxBytes: resolved.maxBytes,
      });
      const raw = await handle.readObject(lease, wire, signal);
      let result: DomainObjectReadResponse;
      try {
        result = parseObjectReadResponse(raw, wire);
      } catch {
        throw new CognitiveAppGatewayError("contract");
      }
      const current = await platform.resolveCognitiveAppObjectRead(
        access,
        request,
      );
      if (!same(bound, objectReadPremises(current)))
        throw new CognitiveAppGatewayError("conflict");
      return result;
    } catch (error) {
      throw safe(error);
    } finally {
      lease?.release();
    }
  }
  async function recoverCommand(
    input: { tenantId: string; commandId: string },
    signal?: AbortSignal,
  ): Promise<CognitiveAppGatewayCommandResult> {
    let lease: CognitiveAppTransportLease | undefined,
      command: CognitiveAppCommandSnapshot | undefined;
    try {
      const request = detached(hostCommand, input);
      const prepared =
        await platform.prepareCognitiveAppReceiptRecovery(request);
      command = prepared.command;
      const operation = prepared.definition.operations.find(
        (op) => op.id === command!.operationId,
      );
      if (
        !operation ||
        operation.effect !== command.effect ||
        operation.scope !== command.operationScope
      )
        throw new CognitiveAppGatewayError("conflict", command.commandId);
      const handle = bindings.resolveReceipt(
        {
          tenantId: command.actor.tenantId,
          principalId: command.actor.principalId,
          appId: command.authority.appId,
          serviceId: command.authority.serviceId,
          dataAuthorityId: command.authority.dataAuthorityId,
        },
        prepared.connection.hostBindingId,
      );
      lease = acquire(
        command.actor.tenantId,
        command.connectionId,
        command.commandId,
      );
      const wire = parseReceiptReadRequest({
        protocol: domainProtocol,
        delegation: {
          issuer: handle.issuer,
          expiresAt: expiresAt(),
          purpose: "receipt-recovery",
          authority: command.authority,
          actor: command.actor,
          projectId: command.projectId,
          originalOperationId: command.operationId,
          originalResources: command.resources,
          historicalAdmission: {
            commandId: command.commandId,
            requestHash: command.requestHash,
          },
        },
      });
      const receipt = parseDomainReceipt(
        await handle.readReceipt(lease, wire, signal),
        expected(command),
      );
      if (receipt.status === "unknown") return unknown(command);
      return await terminal(command, receipt, operation);
    } catch (error) {
      if (error instanceof CognitiveAppGatewayError)
        throw safe(error, command?.commandId);
      if (
        command &&
        (command.state === "dispatching" || command.state === "unknown")
      )
        return unknown(command);
      throw safe(
        error,
        command?.commandId ??
          (id.safeParse(input?.commandId).success
            ? input.commandId
            : undefined),
      );
    } finally {
      lease?.release();
    }
  }
  async function recoverPage(
    input: { tenantId: string; limit?: number; afterCommandId?: string },
    signal?: AbortSignal,
  ) {
    try {
      const request = detached(recoveryPage, input);
      const commands =
        await platform.listRecoverableCognitiveAppCommands(request);
      if (commands.length > (request.limit ?? 32))
        throw new CognitiveAppGatewayError("contract");
      const results: Array<
        | CognitiveAppGatewayCommandResult
        | { commandId: string; hostIssue: "unavailable" }
      > = [];
      for (const command of commands) {
        if (signal?.aborted) break;
        try {
          results.push(
            await recoverCommand(
              { tenantId: request.tenantId, commandId: command.commandId },
              signal,
            ),
          );
        } catch {
          results.push({
            commandId: command.commandId,
            hostIssue: "unavailable",
          });
        }
      }
      return results;
    } catch (error) {
      throw safe(error);
    }
  }
  async function projectPending(input: {
    tenantId: string;
    limit?: number;
    afterCommandId?: string;
  }) {
    try {
      const request = detached(recoveryPage, input);
      const commands =
        await platform.listPendingCognitiveAppCommandProjections(request);
      if (commands.length > (request.limit ?? 32))
        throw new CognitiveAppGatewayError("contract");
      return await Promise.all(commands.map(project));
    } catch (error) {
      throw safe(error);
    }
  }
  return {
    connect,
    invoke,
    readObject,
    recoverCommand,
    recoverPage,
    projectPending,
    async changeConnectionState(
      access: PlatformActor,
      input: z.infer<typeof connectionStateShape>,
    ) {
      try {
        return await platform.changeCognitiveAppConnectionState(
          access,
          detached(connectionStateShape, input),
        );
      } catch (error) {
        throw safe(error);
      }
    },
  };
}
