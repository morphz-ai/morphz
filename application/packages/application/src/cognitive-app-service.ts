import {
  parseCognitiveAppRequest,
  parseCognitiveAppCatalog,
  parseCognitiveAppDescription,
  parseCognitiveAppInstalled,
  parseCognitiveAppGrant,
  parseCognitiveAppConnection,
  parseCognitiveAppReadResult,
  parseCognitiveAppCommandResult,
  type CognitiveAppMethod,
  type CognitiveAppRequestMap,
  type CognitiveAppResponseMap,
} from "../../core/src/cognitive-app-api.js";
import { DomainError } from "../../core/src/model.js";
import {
  domainProtocol,
  parseWireJson,
} from "../../cognitive-app-sdk/src/protocol.js";
import {
  canonicalJsonBytes,
  parseDomainActor,
  parseObjectReadResponse,
  type DomainActor,
  type DomainAuthorityReference,
} from "../../cognitive-app-sdk/src/domain-wire.js";
import { parseBrowserCommandFacts } from "../../cognitive-app-sdk/src/browser-wire.js";
import {
  PlatformStorageError,
  type PlatformActor,
  type PlatformStore,
} from "../../platform/src/store.js";
import type { CognitiveAppCommandSnapshot } from "../../platform/src/cognitive-app-commands.js";
import type { CognitiveAppTargetSnapshot } from "../../platform/src/cognitive-app-registry.js";
import { cognitiveAppCatalogMetadata } from "../../platform/src/cognitive-app-registry.js";
import {
  CognitiveAppGatewayError,
  type CognitiveAppGatewayCommandResult,
  type createCognitiveAppGateway,
} from "./cognitive-app-gateway.js";
import type { UiPackageService } from "./ui-package-service.js";

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
  forbidden: "当前调用未获授权；已有命令事实不会因此回滚。",
  not_found: "当前应用或命令不可用。",
  conflict: "固定应用或命令事实冲突；不会自动重新发送。",
  busy: "应用连接正忙；不会自动重新发送，已有命令事实保留。",
  unavailable: "应用服务暂不可用；已有命令事实保留。",
  contract: "应用返回数据不符合固定契约。",
};
export class CognitiveAppServiceError extends Error {
  constructor(
    readonly reason: Reason,
    readonly commandId?: string,
  ) {
    super(messages[reason]);
    this.name = "CognitiveAppServiceError";
  }
}
function safe(error: unknown, commandId?: string) {
  if (
    error instanceof CognitiveAppServiceError ||
    error instanceof CognitiveAppGatewayError
  )
    return new CognitiveAppServiceError(
      error.reason,
      commandId ?? error.commandId,
    );
  if (error instanceof PlatformStorageError || error instanceof DomainError) {
    const reason = error.code;
    if (
      reason === "invalid" ||
      reason === "forbidden" ||
      reason === "not_found" ||
      reason === "conflict"
    )
      return new CognitiveAppServiceError(reason, commandId);
  }
  return new CognitiveAppServiceError("unavailable", commandId);
}
function same(a: unknown, b: unknown) {
  const first = canonicalJsonBytes(a),
    second = canonicalJsonBytes(b);
  return (
    first.length === second.length &&
    first.every((value, index) => value === second[index])
  );
}
function check(condition: unknown): asserts condition {
  if (!condition) throw new CognitiveAppServiceError("conflict");
}
function fixedAuthority(
  target: CognitiveAppTargetSnapshot,
): DomainAuthorityReference {
  const {
    appId,
    version,
    definitionHash,
    instanceId,
    serviceId,
    dataAuthorityId,
  } = target;
  return {
    appId,
    version,
    definitionHash,
    instanceId,
    serviceId,
    dataAuthorityId,
  };
}
function admission(command: CognitiveAppCommandSnapshot) {
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
  } = command;
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
function commandFacts(command: CognitiveAppCommandSnapshot) {
  const {
    commandId,
    operationId,
    effect,
    state,
    revision,
    projectionState,
    receiptRef,
    receiptHash,
    committedAt,
    objects,
    createdAt,
    updatedAt,
  } = command;
  return parseBrowserCommandFacts({
    commandId,
    operationId,
    effect,
    state,
    revision,
    projectionState,
    receiptRef,
    receiptHash,
    committedAt,
    objects,
    createdAt,
    updatedAt,
  });
}
function matchesRequest(
  command: CognitiveAppCommandSnapshot,
  request:
    CognitiveAppRequestMap["commandStatus"] | CognitiveAppRequestMap["invoke"],
) {
  check(
    command.projectId === request.projectId &&
      command.authority.appId === request.appId &&
      command.authority.version === request.version &&
      command.connectionId === request.connectionId,
  );
  if (request.commandId !== null)
    check(command.commandId === request.commandId);
  if (request.expectedDefinitionHash !== undefined)
    check(command.authority.definitionHash === request.expectedDefinitionHash);
  if ("operationId" in request)
    check(command.operationId === request.operationId);
}
export type CognitiveAppServicePlatform = PlatformStore;
const captureActor = (actor: DomainActor) =>
  parseDomainActor(
    JSON.parse(new TextDecoder().decode(canonicalJsonBytes(actor))),
  );
/** Reconcile only actual same-admission facts observed after network work. This
 * cannot make a non-durable author commit durable or invent delivery IDs.
 */
function publicCommand(
  result: CognitiveAppGatewayCommandResult,
  after: CognitiveAppCommandSnapshot,
) {
  check(same(admission(result.command), admission(after)));
  if (
    result.command.state === "committed" ||
    result.command.state === "rejected"
  ) {
    check(
      after.state === result.command.state &&
        same(
          {
            ref: after.receiptRef,
            hash: after.receiptHash,
            at: after.committedAt,
            objects: after.objects,
          },
          {
            ref: result.command.receiptRef,
            hash: result.command.receiptHash,
            at: result.command.committedAt,
            objects: result.command.objects,
          },
        ),
    );
  }
  let observed = result.observedCommitted,
    hostIssue = result.hostIssue,
    persistence = result.persistence;
  if (
    observed &&
    (after.state === "committed" ||
      after.state === "rejected" ||
      after.state === "cancelled")
  ) {
    check(
      after.state === "committed" &&
        same(
          {
            receiptId: after.receiptRef,
            receiptHash: after.receiptHash,
            committedAt: after.committedAt,
            objects: after.objects,
          },
          observed,
        ),
    );
    observed = undefined;
    persistence = undefined;
    hostIssue = undefined;
  }
  if (
    hostIssue === "projection-pending" &&
    after.projectionState === "projected"
  )
    hostIssue = undefined;
  if (
    hostIssue === "unconfirmed" &&
    ["committed", "rejected", "cancelled"].includes(after.state)
  )
    hostIssue = undefined;
  const contentIds =
    result.command.state === "committed" &&
    result.command.projectionState === "projected" &&
    after.state === "committed" &&
    after.projectionState === "projected"
      ? result.contentIds
      : undefined;
  return parseCognitiveAppCommandResult({
    kind: "command",
    commandId: after.commandId,
    command: commandFacts(after),
    ...(result.result === undefined ? {} : { result: result.result }),
    ...(result.contractIssue === undefined
      ? {}
      : { contractIssue: result.contractIssue }),
    ...(hostIssue === undefined ? {} : { hostIssue }),
    ...(contentIds === undefined ? {} : { contentIds }),
    ...(observed === undefined
      ? {}
      : { observedCommitted: observed, persistence }),
  });
}

/** Thin shared business facade. Authenticated PlatformActor comes from the
 * existing Host ingress; this factory creates neither authority nor transport.
 * No Host-only recovery paging, private route or mutable ledger port is public.
 */
export function createCognitiveAppService(options: {
  platform: CognitiveAppServicePlatform;
  gateway: ReturnType<typeof createCognitiveAppGateway>;
  uiPackages?: UiPackageService;
}) {
  const { platform, gateway, uiPackages } = options;
  async function run<M extends CognitiveAppMethod>(
    method: M,
    actor: PlatformActor,
    input: unknown,
    work: (
      access: PlatformActor,
      request: CognitiveAppRequestMap[M],
    ) => Promise<CognitiveAppResponseMap[M]>,
  ): Promise<CognitiveAppResponseMap[M]> {
    let commandId: string | undefined;
    try {
      let request: CognitiveAppRequestMap[M];
      try {
        request = parseCognitiveAppRequest(method, input);
      } catch {
        throw new CognitiveAppServiceError("invalid");
      }
      if ("commandId" in request && typeof request.commandId === "string")
        commandId = request.commandId;
      // The credential is supplied by trusted authenticated ingress, never the
      // public JSON request. Capture it before the first asynchronous boundary.
      const access = { credential: actor.credential };
      return await work(access, request);
    } catch (error) {
      throw safe(error, commandId);
    }
  }
  return {
    list(actor: PlatformActor, input: unknown) {
      return run("list", actor, input, async (access, request) => {
        const result = await platform.listCognitiveApps(access, request);
        return parseCognitiveAppCatalog({
          versions: result.versions.map(cognitiveAppCatalogMetadata),
          connections: result.connections,
          nextVersionsAfter: result.nextVersionsAfter,
          nextConnectionsAfter: result.nextConnectionsAfter,
        });
      });
    },
    describe(actor: PlatformActor, input: unknown) {
      return run("describe", actor, input, async (access, request) => {
        if ("mode" in request) {
          const { mode, ...exact } = request;
          const registered = await platform.describeRegisteredCognitiveApp(
            access,
            exact,
          );
          return parseCognitiveAppDescription({
            mode,
            definition: registered.definition,
            definitionHash: registered.definitionHash,
            registeredAt: registered.registeredAt,
            installationState: registered.installationState,
            grant: registered.grant,
          });
        }
        const { definition, definitionHash, grantRevision } =
          await platform.resolveCognitiveAppDescription(access, request);
        return parseCognitiveAppDescription({
          definition,
          definitionHash,
          grantRevision,
        });
      });
    },
    install(actor: PlatformActor, input: unknown) {
      return run("install", actor, input, async (access, request) => {
        if ("mode" in request) {
          const { mode: _mode, ...exact } = request;
          const registered = await platform.registerCognitiveApp(access, exact);
          return parseCognitiveAppInstalled({
            appId: registered.appId,
            version: registered.version,
            definitionHash: registered.definitionHash,
          });
        }
        const result =
          request.definition.ui === null
            ? await platform.installCognitiveApp(access, {
                definition: request.definition,
              })
            : await (async () => {
                if (!uiPackages)
                  throw new CognitiveAppServiceError("unavailable");
                check(
                  request.manifest !== undefined &&
                    request.commandId !== undefined,
                );
                return uiPackages.installCognitive(access, request.commandId, {
                  definition: request.definition,
                  manifest: request.manifest,
                });
              })();
        return parseCognitiveAppInstalled({
          appId: result.appId,
          version: result.version,
          definitionHash: result.definitionHash,
        });
      });
    },
    grant(actor: PlatformActor, input: unknown) {
      return run("grant", actor, input, async (access, request) =>
        parseCognitiveAppGrant(
          await platform.changeCognitiveAppGrant(access, {
            ...request,
            now: new Date().toISOString(),
          }),
        ),
      );
    },
    connect(actor: PlatformActor, input: unknown) {
      return run("connect", actor, input, async (access, request) =>
        parseCognitiveAppConnection(await gateway.connect(access, request)),
      );
    },
    connectionState(actor: PlatformActor, input: unknown) {
      return run("connectionState", actor, input, async (access, request) =>
        parseCognitiveAppConnection(
          await gateway.changeConnectionState(access, {
            ...request,
            now: new Date().toISOString(),
          }),
        ),
      );
    },
    invoke(actor: PlatformActor, input: unknown) {
      return run("invoke", actor, input, async (access, request) => {
        if (request.commandId === null) {
          const before = await platform.resolveCognitiveAppDescription(
            access,
            request,
          );
          const operation = before.definition.operations.find(
            (op) => op.id === request.operationId,
          );
          if (!operation || operation.effect !== "read")
            throw new CognitiveAppServiceError("invalid");
          const { commandId: _readOnly, ...invoke } = request;
          const result = await gateway.invoke(access, invoke);
          check(result.kind === "read");
          const after = await platform.resolveCognitiveAppOperation(
            access,
            invoke,
          );
          check(
            same(before.actor, after.actor) &&
              same(fixedAuthority(after.target), result.authority) &&
              before.definitionHash === after.target.definitionHash &&
              result.operationId === request.operationId,
          );
          return parseCognitiveAppReadResult({
            protocol: domainProtocol,
            authority: result.authority,
            operationId: result.operationId,
            result: result.result,
          });
        }
        // Disclosure checks do not atomically cancel a side effect. First send
        // still belongs to Gateway/Platform's real admission/dispatch fence.
        // Historical commands deliberately do not resolve current consent first.
        let caller: DomainActor;
        try {
          const before = await platform.inspectCognitiveAppCommandDisclosure(
            access,
            { projectId: request.projectId, commandId: request.commandId },
          );
          matchesRequest(before.command, request);
          caller = captureActor(before.actor);
        } catch (error) {
          if (!(
            error instanceof PlatformStorageError && error.code === "not_found"
          ))
            throw error;
          // Only a missing original command is fresh: a read-only current
          // resolution supplies the caller, without admitting or sending it.
          const fresh = await platform.resolveCognitiveAppOperation(
            access,
            request,
          );
          if (fresh.operation.effect === "read")
            throw new CognitiveAppServiceError("invalid");
          caller = captureActor(fresh.actor);
        }
        const result = await gateway.invoke(access, {
          ...request,
          commandId: request.commandId,
        });
        check(result.kind === "command");
        const after = await platform.inspectCognitiveAppCommandDisclosure(
          access,
          { projectId: request.projectId, commandId: request.commandId },
        );
        matchesRequest(after.command, request);
        check(same(caller, after.actor));
        return publicCommand(result, after.command);
      });
    },
    readObject(actor: PlatformActor, input: unknown) {
      return run("readObject", actor, input, async (access, request) => {
        const before = await platform.resolveCognitiveAppObjectRead(
          access,
          request,
        );
        const result = await gateway.readObject(access, request);
        const after = await platform.resolveCognitiveAppObjectRead(
          access,
          request,
        );
        check(
          same(before.actor, after.actor) &&
            same(fixedAuthority(before.target), fixedAuthority(after.target)) &&
            before.target.connectionId === after.target.connectionId &&
            same(result.authority, fixedAuthority(after.target)) &&
            same(result.object, request.object),
        );
        const parsed = parseObjectReadResponse(
          JSON.parse(JSON.stringify(parseWireJson(result))),
        );
        const bytes = new TextEncoder().encode(
          parsed.content.format === "json"
            ? JSON.stringify(parsed.content.value)
            : parsed.content.text,
        ).byteLength;
        if (bytes > request.maxBytes)
          throw new CognitiveAppServiceError("contract");
        return parsed;
      });
    },
    commandStatus(actor: PlatformActor, input: unknown) {
      return run("commandStatus", actor, input, async (access, request) => {
        const result = await platform.inspectCognitiveAppCommandDisclosure(
          access,
          { projectId: request.projectId, commandId: request.commandId },
        );
        matchesRequest(result.command, request);
        return commandFacts(result.command);
      });
    },
    recover(actor: PlatformActor, input: unknown) {
      return run("recover", actor, input, async (access, request) => {
        const before = await platform.inspectCognitiveAppCommandDisclosure(
          access,
          { projectId: request.projectId, commandId: request.commandId },
        );
        matchesRequest(before.command, request);
        const caller = captureActor(before.actor);
        const result = await gateway.recoverCommand({
          tenantId: before.command.actor.tenantId,
          commandId: before.command.commandId,
        });
        check(same(admission(before.command), admission(result.command)));
        const after = await platform.inspectCognitiveAppCommandDisclosure(
          access,
          { projectId: request.projectId, commandId: request.commandId },
        );
        matchesRequest(after.command, request);
        check(
          same(caller, after.actor) &&
            same(admission(before.command), admission(after.command)),
        );
        return publicCommand(result, after.command);
      });
    },
  };
}
export type CognitiveAppService = ReturnType<typeof createCognitiveAppService>;
