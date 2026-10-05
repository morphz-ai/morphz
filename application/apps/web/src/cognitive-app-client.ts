import {
  ApplicationRequestError,
  cognitiveAppApplicationMethods,
  cognitiveAppApplicationRoutes,
} from "../../../packages/core/src/application-api.js";
import {
  parseCognitiveAppRequest,
  parseCognitiveAppCatalog,
  parseCognitiveAppDescription,
  parseCognitiveAppInstalled,
  parseCognitiveAppGrant,
  parseCognitiveAppConnection,
  parseCognitiveAppReadResult,
  parseCognitiveAppCommandResult,
  type CognitiveAppCatalogDto,
  type CognitiveAppDescriptionDto,
  type CognitiveAppRegisteredDescriptionDto,
  type CognitiveAppMethod,
  type CognitiveAppRequestMap,
  type CognitiveAppResponseMap,
} from "../../../packages/core/src/cognitive-app-api.js";
import {
  parseObjectReadResponse,
  type DomainAuthorityReference,
} from "../../../packages/cognitive-app-sdk/src/domain-wire.js";
import { parseBrowserCommandFacts } from "../../../packages/cognitive-app-sdk/src/browser-wire.js";
import { parseWireJson } from "../../../packages/cognitive-app-sdk/src/protocol.js";

export type CognitiveAppTransportMethod =
  keyof typeof cognitiveAppApplicationRoutes;
export type CognitiveAppTransport = (
  method: CognitiveAppTransportMethod,
  params: CognitiveAppRequestMap[CognitiveAppMethod],
  signal?: AbortSignal,
) => Promise<unknown>;
export type CognitiveAppCatalogSnapshot = Pick<
  CognitiveAppCatalogDto,
  "versions" | "connections"
>;
export type CognitiveAppCatalogQuery = Partial<
  Pick<CognitiveAppRequestMap["list"], "limit" | "appId">
>;
type ManagementDescriptionRequest = Extract<
  CognitiveAppRequestMap["describe"],
  { mode: "registered-management" }
>;
export type CognitiveAppDescribeResponse<
  R extends CognitiveAppRequestMap["describe"],
> = R extends ManagementDescriptionRequest
  ? CognitiveAppRegisteredDescriptionDto
  : CognitiveAppDescriptionDto;

/** Aggregate guard, not a new wire limit or a truncated catalogue. A hundred
 * maximum author icons (~18 MB) fit; many small entries may span many pages.
 * Exceeding any bound fails the whole load so the caller can use paging/filter.
 */
export const cognitiveAppCatalogLimits = Object.freeze({
  pages: 1024,
  entries: 10000,
  bytes: 64 * 1024 * 1024,
});
const utf8 = new TextEncoder();
const cancelled = (commandId?: string) =>
  new ApplicationRequestError(
    408,
    "请求已取消；已提交的操作不会回滚。",
    "cancelled",
    commandId,
  );
function notAborted(signal?: AbortSignal, commandId?: string) {
  if (signal?.aborted) throw cancelled(commandId);
}
function check(condition: unknown): asserts condition {
  if (!condition) throw new Error("Invalid cognitive response association.");
}
function matchesDefinition(
  result: Pick<
    DomainAuthorityReference,
    "appId" | "version" | "definitionHash"
  >,
  request: { appId: string; version: string; expectedDefinitionHash?: string },
) {
  check(result.appId === request.appId && result.version === request.version);
  if (request.expectedDefinitionHash !== undefined)
    check(result.definitionHash === request.expectedDefinitionHash);
}

/** Decode existing public contracts. These associations reject mismatched
 * acknowledgements, not grant authority; the actual Host still checks policy.
 */
function response<M extends CognitiveAppMethod>(
  method: M,
  raw: unknown,
  request: CognitiveAppRequestMap[M],
): CognitiveAppResponseMap[M] {
  // Own-data guard must precede any discriminator access; detach nested values
  // so a transport-owned response cannot later mutate the presented original.
  const value: unknown = JSON.parse(JSON.stringify(parseWireJson(raw)));
  let result: CognitiveAppResponseMap[CognitiveAppMethod];
  switch (method) {
    case "list": {
      const input = request as CognitiveAppRequestMap["list"];
      const parsed = parseCognitiveAppCatalog(value);
      check(
        parsed.versions.length <= input.limit &&
          parsed.connections.length <= input.limit,
      );
      if (input.appId !== undefined)
        check(
          parsed.versions.every((v) => v.appId === input.appId) &&
            parsed.connections.every((v) => v.appId === input.appId),
        );
      result = parsed;
      break;
    }
    case "describe": {
      const input = request as CognitiveAppRequestMap["describe"];
      const parsed = parseCognitiveAppDescription(value);
      check("mode" in parsed === "mode" in input);
      matchesDefinition(
        {
          appId: parsed.definition.id,
          version: parsed.definition.version,
          definitionHash: parsed.definitionHash,
        },
        input,
      );
      result = parsed;
      break;
    }
    case "install": {
      const input = request as CognitiveAppRequestMap["install"];
      const parsed = parseCognitiveAppInstalled(value);
      matchesDefinition(
        parsed,
        "mode" in input
          ? { ...input, expectedDefinitionHash: input.definitionHash }
          : { appId: input.definition.id, version: input.definition.version },
      );
      result = parsed;
      break;
    }
    case "grant": {
      const input = request as CognitiveAppRequestMap["grant"];
      const parsed = parseCognitiveAppGrant(value);
      check(
        parsed.appId === input.appId &&
          parsed.version === input.version &&
          parsed.state === input.state,
      );
      result = parsed;
      break;
    }
    case "connect":
    case "connectionState": {
      const input = request as
        | CognitiveAppRequestMap["connect"]
        | CognitiveAppRequestMap["connectionState"];
      const parsed = parseCognitiveAppConnection(value);
      check(
        parsed.appId === input.appId &&
          parsed.connectionId === input.connectionId,
      );
      if ("serviceId" in input)
        check(
          parsed.serviceId === input.serviceId &&
            parsed.dataAuthorityId === input.dataAuthorityId,
        );
      else check(parsed.state === input.state);
      result = parsed;
      break;
    }
    case "invoke": {
      const input = request as CognitiveAppRequestMap["invoke"];
      if (input.commandId === null) {
        const parsed = parseCognitiveAppReadResult(value);
        matchesDefinition(parsed.authority, input);
        check(parsed.operationId === input.operationId);
        result = parsed;
      } else {
        const parsed = parseCognitiveAppCommandResult(value);
        check(
          parsed.commandId === input.commandId &&
            parsed.command.operationId === input.operationId,
        );
        result = parsed;
      }
      break;
    }
    case "readObject": {
      const input = request as CognitiveAppRequestMap["readObject"];
      const parsed = parseObjectReadResponse(value);
      matchesDefinition(parsed.authority, input);
      check(
        parsed.object.objectId === input.object.objectId &&
          parsed.object.versionRef === input.object.versionRef &&
          utf8.encode(
            parsed.content.format === "json"
              ? JSON.stringify(parsed.content.value)
              : parsed.content.text,
          ).byteLength <= input.maxBytes,
      );
      result = parsed;
      break;
    }
    case "commandStatus": {
      const input = request as CognitiveAppRequestMap["commandStatus"];
      const parsed = parseBrowserCommandFacts(value);
      check(parsed.commandId === input.commandId);
      result = parsed;
      break;
    }
    case "recover": {
      const input = request as CognitiveAppRequestMap["recover"];
      const parsed = parseCognitiveAppCommandResult(value);
      check(parsed.commandId === input.commandId);
      result = parsed;
      break;
    }
    default:
      throw new Error("Unsupported cognitive method.");
  }
  return result as CognitiveAppResponseMap[M];
}

function send(
  transport: CognitiveAppTransport,
  method: CognitiveAppTransportMethod,
  params: CognitiveAppRequestMap[CognitiveAppMethod],
  signal?: AbortSignal,
  commandId?: string,
): Promise<unknown> {
  notAborted(signal, commandId);
  if (!signal) return transport(method, params, signal);
  // Honour cancellation even if an injected transport ignores its signal. A
  // late response is discarded; an already sent write is never retried here.
  return new Promise((resolve, reject) => {
    let active = true;
    const finish = (done: (value: unknown) => void, value: unknown) => {
      if (!active) return;
      active = false;
      signal.removeEventListener("abort", abort);
      done(value);
    };
    const abort = () => finish(reject, cancelled(commandId));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) return abort();
    try {
      Promise.resolve(transport(method, params, signal)).then(
        (value) => {
          if (signal.aborted) abort();
          else finish(resolve, value);
        },
        (error: unknown) => {
          if (signal.aborted) abort();
          else finish(reject, error);
        },
      );
    } catch (error) {
      if (signal.aborted) abort();
      else finish(reject, error);
    }
  });
}

/** A presentation facade over the existing authenticated logical caller. No
 * identity, endpoint, private binding, registry or authorization is held here.
 */
export function createCognitiveAppClient(transport: CognitiveAppTransport) {
  async function call<M extends CognitiveAppMethod>(
    method: M,
    input: CognitiveAppRequestMap[M],
    signal?: AbortSignal,
  ): Promise<CognitiveAppResponseMap[M]> {
    let request: CognitiveAppRequestMap[M];
    try {
      request = parseCognitiveAppRequest(method, input);
    } catch {
      throw new ApplicationRequestError(400, "请求格式无效。", "invalid");
    }
    const commandId =
      "commandId" in request && typeof request.commandId === "string"
        ? request.commandId
        : undefined;
    const logicalMethod = cognitiveAppApplicationMethods.find(
      (logical) => cognitiveAppApplicationRoutes[logical].method === method,
    );
    check(logicalMethod !== undefined);
    const raw = await send(
      transport,
      logicalMethod,
      request,
      signal,
      commandId,
    );
    notAborted(signal, commandId);
    let parsed: CognitiveAppResponseMap[M];
    try {
      parsed = response(method, raw, request);
    } catch {
      notAborted(signal, commandId);
      throw new ApplicationRequestError(
        503,
        "应用响应不符合固定契约。",
        "contract",
        commandId,
      );
    }
    notAborted(signal, commandId);
    return parsed;
  }

  async function allCatalog(
    options: CognitiveAppCatalogQuery = {},
    signal?: AbortSignal,
  ): Promise<CognitiveAppCatalogSnapshot> {
    let base: CognitiveAppRequestMap["list"];
    try {
      const selected = parseWireJson(options);
      check(
        selected !== null &&
          typeof selected === "object" &&
          !Array.isArray(selected) &&
          !("versionsAfter" in selected) &&
          !("connectionsAfter" in selected),
      );
      base = parseCognitiveAppRequest("list", { limit: 100, ...selected });
    } catch {
      throw new ApplicationRequestError(400, "目录请求格式无效。", "invalid");
    }
    const snapshot: CognitiveAppCatalogSnapshot = {
      versions: [],
      connections: [],
    };
    let bytes = utf8.encode(JSON.stringify(snapshot)).byteLength;
    const versions = new Set<string>(),
      connections = new Set<string>(),
      cursors = new Set<string>();
    let request = base,
      versionsEnded = false,
      connectionsEnded = false;
    const contract = () =>
      new ApplicationRequestError(
        503,
        "应用目录分页不符合固定契约。",
        "contract",
      );
    const budget = () =>
      new ApplicationRequestError(
        503,
        "应用目录超出完整加载范围，请使用分页或筛选入口。",
        "unavailable",
      );
    for (let index = 0; index < cognitiveAppCatalogLimits.pages; index++) {
      notAborted(signal);
      const current = await call("list", request, signal);
      notAborted(signal);
      if (
        (versionsEnded &&
          (current.versions.length || current.nextVersionsAfter !== null)) ||
        (connectionsEnded &&
          (current.connections.length || current.nextConnectionsAfter !== null))
      )
        throw contract();
      for (const [kind, items, after] of [
        ["versions", current.versions, current.nextVersionsAfter],
        ["connections", current.connections, current.nextConnectionsAfter],
      ] as const) {
        if (after !== null) {
          const key = `${kind}:${after}`;
          if (!items.length || cursors.has(key)) throw contract();
          cursors.add(key);
        }
      }
      for (const item of current.versions) {
        const key = JSON.stringify([item.appId, item.version]);
        if (versions.has(key)) throw contract();
        versions.add(key);
        bytes +=
          utf8.encode(JSON.stringify(item)).byteLength +
          (snapshot.versions.length ? 1 : 0);
        if (
          versions.size + connections.size >
            cognitiveAppCatalogLimits.entries ||
          bytes > cognitiveAppCatalogLimits.bytes
        )
          throw budget();
        snapshot.versions.push(item);
      }
      for (const item of current.connections) {
        if (connections.has(item.connectionId)) throw contract();
        connections.add(item.connectionId);
        bytes +=
          utf8.encode(JSON.stringify(item)).byteLength +
          (snapshot.connections.length ? 1 : 0);
        if (
          versions.size + connections.size >
            cognitiveAppCatalogLimits.entries ||
          bytes > cognitiveAppCatalogLimits.bytes
        )
          throw budget();
        snapshot.connections.push(item);
      }
      versionsEnded = current.nextVersionsAfter === null;
      connectionsEnded = current.nextConnectionsAfter === null;
      if (versionsEnded && connectionsEnded) return snapshot;
      // Each public token carries the same two-stream checkpoint. Pick one
      // token from this page only; never reuse another page's paired token or
      // treat a byte-short page as EOF. The Host validates its opaque scope.
      request =
        current.nextVersionsAfter !== null
          ? { ...base, versionsAfter: current.nextVersionsAfter }
          : { ...base, connectionsAfter: current.nextConnectionsAfter! };
    }
    throw budget();
  }

  return {
    call,
    list: (input: CognitiveAppRequestMap["list"], signal?: AbortSignal) =>
      call("list", input, signal),
    describe: <R extends CognitiveAppRequestMap["describe"]>(
      input: R,
      signal?: AbortSignal,
    ) =>
      call("describe", input, signal) as Promise<
        CognitiveAppDescribeResponse<R>
      >,
    install: (input: CognitiveAppRequestMap["install"], signal?: AbortSignal) =>
      call("install", input, signal),
    grant: (input: CognitiveAppRequestMap["grant"], signal?: AbortSignal) =>
      call("grant", input, signal),
    connect: (input: CognitiveAppRequestMap["connect"], signal?: AbortSignal) =>
      call("connect", input, signal),
    connectionState: (
      input: CognitiveAppRequestMap["connectionState"],
      signal?: AbortSignal,
    ) => call("connectionState", input, signal),
    invoke: (input: CognitiveAppRequestMap["invoke"], signal?: AbortSignal) =>
      call("invoke", input, signal),
    readObject: (
      input: CognitiveAppRequestMap["readObject"],
      signal?: AbortSignal,
    ) => call("readObject", input, signal),
    commandStatus: (
      input: CognitiveAppRequestMap["commandStatus"],
      signal?: AbortSignal,
    ) => call("commandStatus", input, signal),
    recover: (input: CognitiveAppRequestMap["recover"], signal?: AbortSignal) =>
      call("recover", input, signal),
    allCatalog,
  };
}
