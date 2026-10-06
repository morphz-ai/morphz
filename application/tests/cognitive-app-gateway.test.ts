import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest, type Server } from "node:http";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { createHash, randomUUID } from "node:crypto";
import {
  createCognitiveAppGateway,
  CognitiveAppGatewayError,
  type CognitiveAppGatewayPlatform,
  type CognitiveAppGatewayInvokeRequest,
  type CognitiveAppGatewayObjectReadRequest,
} from "../packages/application/src/cognitive-app-gateway.js";
import {
  CognitiveAppTransport,
  isCognitiveAppTransportLease,
} from "../packages/application/src/cognitive-app-transport.js";
import {
  PlatformStore,
  PlatformStorageError,
  type PlatformAuthorityVerifier,
} from "../packages/platform/src/store.js";
import {
  sqliteQuery,
  postgresQuery,
  type SqlQuery,
} from "../packages/storage/src/sql.js";
import { CognitiveAppBindings } from "../packages/application/src/cognitive-app-bindings.js";
import type { CognitiveAppCommandSnapshot } from "../packages/platform/src/cognitive-app-commands.js";
import type {
  CognitiveAppConnection,
  CognitiveAppTargetSnapshot,
} from "../packages/platform/src/cognitive-app-registry.js";
import {
  parseCognitiveAppDefinition,
  parseOperationResources,
  validateOperationValue,
  parseWireJson,
  domainProtocol,
} from "../packages/cognitive-app-sdk/src/protocol.js";
import {
  canonicalJsonBytes,
  parseDomainActor,
  parseDomainReceipt,
  parseInvokeRequest,
  parseObjectReadRequest,
  parseReceiptReadRequest,
  type DomainActor,
  type DomainAuthorityReference,
  type DomainInvokeRequest,
} from "../packages/cognitive-app-sdk/src/domain-wire.js";

const definition = parseCognitiveAppDefinition(
  JSON.parse(
    readFileSync(
      new URL("../examples/cognitive-notes/definition.json", import.meta.url),
      "utf8",
    ),
  ),
);
const definitionHash = createHash("sha256")
  .update(canonicalJsonBytes(definition))
  .digest("hex");
const human = parseDomainActor({
  tenantId: "tenant",
  principalId: "alice",
  actantId: "human_alice",
  kind: "human",
  source: { kind: "human" },
});
const access = { credential: "unit-private-platform-credential" };
const at = "2026-10-05T01:00:00.000Z";
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const digest = (value: unknown) =>
  createHash("sha256").update(canonicalJsonBytes(value)).digest("hex");
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
/** Explicit FakePort unit layer. It is not Platform authorization, author SQL,
 * an HTTP service, Runtime-source verification or App acceptance. Real transport
 * permits are retained so unit tests also detect quota/lease lifecycle mistakes. */
function fixture(actualActor: DomainActor = human) {
  const commands = new Map<string, CognitiveAppCommandSnapshot>();
  const events: string[] = [],
    keys: string[] = [];
  const target: CognitiveAppTargetSnapshot = {
    appId: definition.id,
    version: definition.version,
    definitionHash,
    definition,
    installationId: "installation",
    instanceId: "instance",
    serviceId: "author_service",
    dataAuthorityId: "author_data",
    connectionId: "connection",
    connectionRevision: 1,
    grantRevision: 1,
  };
  const control = {
    actor: clone(actualActor),
    target,
    resolveCalls: 0,
    admitCalls: 0,
    dispatchCalls: 0,
    posts: 0,
    receiptReads: 0,
    objectReads: 0,
    records: 0,
    projections: 0,
    creates: 0,
    rejectDispatch: false,
    throwInvoke: false,
    badBinding: false,
    badResult: false,
    malformedReceipt: false,
    unknownReceipt: false,
    throwRecord: false,
    recordCode: undefined as "invalid" | "conflict" | undefined,
    authorReject: false,
    throwProjection: false,
    wrongDescribe: false,
    badObject: false,
    blockCapacity: false,
    onResolve: undefined as
      undefined | ((call: number) => void | Promise<void>),
    onObject: undefined as undefined | ((call: number) => void | Promise<void>),
    objectResolves: 0,
    wire: undefined as unknown,
    knownResolveForbidden: false,
    retainedReceipt: undefined as
      ReturnType<typeof parseDomainReceipt> | undefined,
    invokeGate: undefined as Promise<void> | undefined,
  };
  const authority = (): DomainAuthorityReference => {
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
  };
  const connection = (): CognitiveAppConnection => ({
    appId: target.appId,
    instanceId: target.instanceId,
    serviceId: target.serviceId,
    dataAuthorityId: target.dataAuthorityId,
    connectionId: target.connectionId,
    state: "active",
    revision: target.connectionRevision,
    createdAt: at,
    updatedAt: at,
  });
  const fail = (
    code: "forbidden" | "not_found" | "conflict",
    message = "unit-private-error https://secret.invalid/token",
  ) => {
    throw new PlatformStorageError(code, message);
  };
  const lookup = (operationId: string) => {
    const operation = definition.operations.find((op) => op.id === operationId);
    assert.ok(operation);
    return operation;
  };
  const semantic = (
    request: Omit<CognitiveAppGatewayInvokeRequest, "commandId">,
    actor: DomainActor,
    auth: DomainAuthorityReference,
  ) =>
    digest({
      protocol: domainProtocol,
      authority: auth,
      actor,
      projectId: request.projectId,
      operationId: request.operationId,
      parameters: request.parameters,
      resources: request.resources,
    });
  const platform: CognitiveAppGatewayPlatform = {
    // This bounded unit fixture has no SQL receipt owner; actual replay is
    // exercised separately through the genuine Store and both SQL backends.
    async readCognitiveAppConnectionCreation() {
      return null;
    },
    async prepareCognitiveAppConnection(_access, request) {
      if (control.actor.kind !== "human") fail("forbidden");
      assert.equal(request.appId, definition.id);
      return {
        actor: clone(control.actor),
        version: {
          appId: definition.id,
          version: definition.version,
          installationId: "installation",
          definitionHash,
          definition,
          installedByPrincipalId: "alice",
          installedAt: at,
        },
        grant: {
          appId: definition.id,
          version: definition.version,
          state: "active",
          revision: 1,
          consentedAt: at,
          updatedAt: at,
        },
      };
    },
    async createVerifiedCognitiveAppConnection(_access, request) {
      control.creates++;
      events.push("create-connection");
      assert.equal(request.proof.definitionHash, definitionHash);
      assert.equal(request.proof.hostBindingId, "unit-private-alias");
      assert.equal(request.request.connectionId, "connection");
      assert.equal(request.verifiedGrantRevision, 1);
      assert.deepEqual(request.verifiedActor, control.actor);
      return connection();
    },
    async changeCognitiveAppConnectionState() {
      return connection();
    },
    async getCognitiveAppHostConnection() {
      return { ...connection(), hostBindingId: "unit-private-alias" };
    },
    async resolveCognitiveAppOperation(_access, request) {
      control.resolveCalls++;
      events.push("resolve");
      if (control.knownResolveForbidden) fail("forbidden");
      await control.onResolve?.(control.resolveCalls);
      const operation = lookup(request.operationId);
      return {
        actor: control.actor,
        target,
        operation,
        parameters: validateOperationValue(
          operation.inputSchema,
          request.parameters,
        ),
        resources: parseOperationResources(operation.scope, request.resources),
      };
    },
    async admitCognitiveAppCommand(_access, request) {
      control.admitCalls++;
      events.push("admit");
      const operation = lookup(request.operationId);
      assert.notEqual(operation.effect, "read");
      const parameters = validateOperationValue(
        operation.inputSchema,
        request.parameters,
      );
      const resources = parseOperationResources(
        operation.scope,
        request.resources,
      );
      const previous = commands.get(request.commandId);
      const actor = clone(control.actor),
        auth = authority();
      if (previous) {
        if (
          !Buffer.from(canonicalJsonBytes(previous.actor)).equals(
            Buffer.from(canonicalJsonBytes(actor)),
          ) ||
          semantic(
            { ...request, parameters, resources },
            actor,
            previous.authority,
          ) !== previous.requestHash ||
          previous.connectionId !== request.connectionId
        )
          fail("conflict");
        return { command: clone(previous), operation, parameters };
      }
      const command: CognitiveAppCommandSnapshot = {
        commandId: request.commandId,
        requestHash: semantic(
          { ...request, parameters, resources },
          actor,
          auth,
        ),
        authority: auth,
        actor,
        projectId: request.projectId,
        operationId: request.operationId,
        effect: operation.effect as "write" | "execute",
        operationScope: operation.scope,
        resources,
        connectionId: target.connectionId,
        connectionRevision: target.connectionRevision,
        grantRevision: target.grantRevision,
        revision: 1,
        state: "admitted",
        receiptRef: null,
        receiptHash: null,
        committedAt: null,
        objects: null,
        projectionState: "none",
        createdAt: at,
        updatedAt: at,
      };
      commands.set(command.commandId, command);
      return { command: clone(command), operation, parameters };
    },
    async dispatchCognitiveAppCommand(_access, request) {
      control.dispatchCalls++;
      events.push("dispatch");
      if (control.rejectDispatch) fail("forbidden");
      const command = commands.get(request.commandId);
      assert.ok(command);
      if (
        command.state !== "admitted" ||
        command.revision !== request.expectedCommandRevision
      )
        return null;
      if (
        command.grantRevision !== target.grantRevision ||
        command.connectionRevision !== target.connectionRevision
      )
        fail("conflict");
      command.state = "dispatching";
      command.revision++;
      const operation = lookup(command.operationId);
      return {
        command: clone(command),
        operation,
        parameters: validateOperationValue(
          operation.inputSchema,
          request.parameters,
        ),
      };
    },
    async inspectCognitiveAppCommand(_access, request) {
      const command = commands.get(request.commandId);
      if (!command || command.projectId !== request.projectId)
        return fail("not_found");
      return clone(command);
    },
    async prepareCognitiveAppReceiptRecovery(request) {
      const command = commands.get(request.commandId);
      assert.ok(command);
      return {
        command: clone(command),
        definition,
        connection: { ...connection(), hostBindingId: "unit-private-alias" },
      };
    },
    async recordCognitiveAppCommandReceipt(request) {
      control.records++;
      events.push("record");
      if (control.throwRecord) throw new Error("unit-private-storage-secret");
      if (control.recordCode)
        throw new PlatformStorageError(
          control.recordCode,
          "unit-secret-ledger",
        );
      const command = commands.get(request.commandId);
      assert.ok(command);
      const receipt = parseDomainReceipt(request.receipt, {
        authority: command.authority,
        actor: command.actor,
        projectId: command.projectId,
        operationId: command.operationId,
        commandId: command.commandId,
        requestHash: command.requestHash,
      });
      assert.notEqual(receipt.status, "unknown");
      if (receipt.status === "unknown") throw new Error("unit bad receipt");
      if (command.state === "committed" || command.state === "rejected") {
        if (
          command.state !== receipt.status ||
          command.receiptHash !== digest(receipt)
        )
          fail("conflict");
        return clone(command);
      }
      command.state = receipt.status;
      command.revision++;
      command.receiptRef = receipt.receiptId;
      command.receiptHash = digest(receipt);
      command.committedAt =
        receipt.status === "committed" ? receipt.committedAt : null;
      command.objects = receipt.status === "committed" ? receipt.objects : null;
      command.projectionState =
        receipt.status === "committed" ? "pending" : "none";
      return clone(command);
    },
    async markCognitiveAppCommandUnknown(request) {
      const command = commands.get(request.commandId);
      assert.ok(command);
      if (
        command.state !== "dispatching" ||
        command.revision !== request.expectedCommandRevision
      )
        return null;
      command.state = "unknown";
      command.revision++;
      return clone(command);
    },
    async cancelAdmittedCognitiveAppCommand() {
      throw new Error("unit cancellation is not automatically invoked");
    },
    async listRecoverableCognitiveAppCommands(request) {
      return [...commands.values()]
        .filter((c) => c.state === "unknown" || c.state === "dispatching")
        .slice(0, request.limit ?? 32)
        .map(clone);
    },
    async listPendingCognitiveAppCommandProjections(request) {
      return [...commands.values()]
        .filter((c) => c.projectionState === "pending")
        .slice(0, request.limit ?? 32)
        .map(clone);
    },
    async projectCognitiveAppCommand(request) {
      control.projections++;
      events.push("project");
      if (control.throwProjection)
        throw new Error("unit-private-catalog-secret");
      const command = commands.get(request.commandId);
      assert.ok(command);
      if (
        command.projectionState !== "pending" ||
        command.revision !== request.expectedCommandRevision
      )
        return null;
      command.projectionState = "projected";
      command.revision++;
      return {
        command: clone(command),
        contentIds: ["unit-content"],
        changed: true,
      };
    },
    async resolveCognitiveAppObjectRead(_access, request) {
      control.objectResolves++;
      await control.onObject?.(control.objectResolves);
      return {
        actor: control.actor,
        target,
        object: request.object,
        maxBytes: request.maxBytes,
      };
    },
  };
  const transport = new CognitiveAppTransport();
  const gateway = createCognitiveAppGateway({
    platform,
    transport: {
      tryAcquire(actualKey) {
        keys.push(actualKey);
        events.push("lease");
        return control.blockCapacity ? null : transport.tryAcquire(actualKey);
      },
    },
    bindings: {
      prepareConnection() {
        return {
          purpose: "connection-setup",
          issuer: "host_issuer",
          hostBindingId: "unit-private-alias",
          async describe(lease, payload) {
            assert.ok(isCognitiveAppTransportLease(lease));
            events.push("describe");
            const raw = payload as { protocol: string; definition: unknown };
            return parseWireJson({
              ...raw,
              serviceId: control.wrongDescribe ? "different" : target.serviceId,
              dataAuthorityId: target.dataAuthorityId,
            });
          },
        };
      },
      resolveConnection() {
        return {
          purpose: "active-connection",
          issuer: "host_issuer",
          hostBindingId: "unit-private-alias",
          async invoke(lease, payload) {
            assert.ok(isCognitiveAppTransportLease(lease));
            control.posts++;
            events.push("invoke");
            control.wire = clone(payload);
            if (control.throwInvoke)
              throw new Error("unit-private-network-url-token");
            await control.invokeGate;
            const raw = payload as DomainInvokeRequest,
              op = lookup(raw.delegation.operationId);
            const wire = parseInvokeRequest(payload, op.effect, op.scope),
              d = wire.delegation;
            if (op.effect === "read")
              return parseWireJson({
                protocol: domainProtocol,
                authority: d.authority,
                operationId: op.id,
                result: { objects: [] },
              });
            assert.ok(d.command);
            const receipt = {
              protocol: domainProtocol,
              binding: {
                authority: d.authority,
                actor: d.actor,
                projectId: d.projectId,
                operationId: d.operationId,
                ...d.command,
              },
              status: "committed",
              receiptId: "receipt",
              committedAt: at,
              result: control.badResult
                ? { unexpected: "field" }
                : {
                    objectId: "note",
                    versionRef: "version1",
                    ...(wire.parameters as { title: string; markdown: string }),
                  },
              objects: [
                {
                  objectId: "note",
                  versionRef: "version1",
                  kind: "document",
                  title: "Original",
                },
              ],
            };
            if (control.malformedReceipt)
              return parseWireJson({ ...receipt, receiptId: null });
            if (control.badBinding)
              return parseWireJson({
                ...receipt,
                binding: {
                  ...receipt.binding,
                  authority: { ...d.authority, dataAuthorityId: "wrong" },
                },
              });
            if (control.unknownReceipt)
              return parseWireJson({
                protocol: domainProtocol,
                binding: receipt.binding,
                status: "unknown",
                reason: { code: "not_seen", message: "unit unknown" },
              });
            if (control.authorReject) {
              const rejected = parseDomainReceipt({
                protocol: domainProtocol,
                binding: receipt.binding,
                status: "rejected",
                receiptId: "rejected-receipt",
                reason: { code: "conflict", message: "unit author refusal" },
              });
              control.retainedReceipt = rejected;
              return parseWireJson(rejected);
            }
            control.retainedReceipt = parseDomainReceipt(receipt);
            return parseWireJson(receipt);
          },
          async readObject(lease, payload) {
            assert.ok(isCognitiveAppTransportLease(lease));
            control.objectReads++;
            control.wire = clone(payload);
            const wire = parseObjectReadRequest(payload);
            return parseWireJson({
              protocol: domainProtocol,
              authority: wire.delegation.authority,
              object: control.badObject
                ? { ...wire.object, versionRef: "wrong" }
                : wire.object,
              kind: "document",
              title: "Historical",
              content: {
                format: "json",
                value: { markdown: "exact old body" },
              },
            });
          },
        };
      },
      resolveReceipt() {
        return {
          purpose: "receipt-recovery",
          issuer: "historical_host",
          hostBindingId: "unit-private-alias",
          async readReceipt(lease, payload) {
            assert.ok(isCognitiveAppTransportLease(lease));
            control.receiptReads++;
            control.wire = clone(payload);
            const wire = parseReceiptReadRequest(payload);
            if (control.retainedReceipt)
              return parseWireJson(control.retainedReceipt);
            return parseWireJson({
              protocol: domainProtocol,
              binding: {
                authority: wire.delegation.authority,
                actor: wire.delegation.actor,
                projectId: wire.delegation.projectId,
                operationId: wire.delegation.originalOperationId,
                ...wire.delegation.historicalAdmission,
              },
              status: "unknown",
              reason: { code: "not_seen", message: "unit not seen" },
            });
          },
        };
      },
    },
  });
  const request = (
    commandId: string | null = "command",
  ): CognitiveAppGatewayInvokeRequest => ({
    appId: definition.id,
    version: definition.version,
    connectionId: target.connectionId,
    projectId: "project",
    operationId: "notes.create",
    parameters: { title: "Original", markdown: "exact original" },
    resources: [],
    ...(commandId ? { commandId } : {}),
  });
  const readRequest = (): CognitiveAppGatewayInvokeRequest => ({
    ...request(null),
    operationId: "notes.list",
    parameters: { limit: 1 },
  });
  const objectRequest = (): CognitiveAppGatewayObjectReadRequest => ({
    appId: definition.id,
    version: definition.version,
    connectionId: target.connectionId,
    projectId: "project",
    object: { objectId: "note", versionRef: "old-version" },
    maxBytes: 262144,
  });
  return {
    gateway,
    platform,
    control,
    commands,
    events,
    keys,
    request,
    readRequest,
    objectRequest,
  };
}

test("Host cognitive gateway owns the fixed typed flow", () => {
  assert.equal(typeof createCognitiveAppGateway, "function");
});

test("unit FakePort: lease precedes admission, first dispatch precedes one invoke, receipt precedes required projection", async () => {
  const f = fixture();
  const result = await f.gateway.invoke(access, f.request());
  assert.ok(result.kind === "command");
  assert.equal(result.command.state, "committed");
  assert.equal(result.command.projectionState, "projected");
  assert.deepEqual(result.result, {
    objectId: "note",
    versionRef: "version1",
    title: "Original",
    markdown: "exact original",
  });
  for (const [a, b] of [
    ["lease", "admit"],
    ["admit", "dispatch"],
    ["dispatch", "invoke"],
    ["invoke", "record"],
    ["record", "project"],
  ])
    assert.ok(f.events.indexOf(a!) < f.events.indexOf(b!));
  assert.deepEqual(f.keys, [
    JSON.stringify(["morphz-cognitive-connection/v1", "tenant", "connection"]),
  ]);
  assert.equal(f.control.posts, 1);
});
test("unit FakePort: capacity and safe authorization errors preserve generated stable command identity without admission", async () => {
  const f = fixture();
  f.control.blockCapacity = true;
  await assert.rejects(
    f.gateway.invoke(access, f.request(null)),
    (error: unknown) => {
      assert.ok(error instanceof CognitiveAppGatewayError);
      assert.equal(error.reason, "busy");
      assert.match(error.commandId!, /^cognitive_command_/);
      assert.equal(error.message.includes("secret"), false);
      return true;
    },
  );
  assert.equal(f.control.admitCalls, 0);
  assert.equal(f.control.posts, 0);
  f.control.blockCapacity = false;
  f.control.rejectDispatch = true;
  await assert.rejects(
    f.gateway.invoke(access, f.request()),
    (error: unknown) => {
      assert.ok(error instanceof CognitiveAppGatewayError);
      assert.equal(error.reason, "forbidden");
      assert.equal(error.commandId, "command");
      assert.equal(error.message.includes("secret.invalid"), false);
      return true;
    },
  );
  assert.equal(f.control.posts, 0);
  assert.equal(f.commands.get("command")!.state, "admitted");
});
test(
  "unit FakePort: concurrent same command has only one dispatch winner and terminal replay never invokes",
  { timeout: 10000 },
  async () => {
    const f = fixture(),
      gate = deferred();
    f.control.invokeGate = gate.promise;
    const first = f.gateway.invoke(access, f.request());
    while (!f.control.posts)
      await new Promise<void>((resolve) => setImmediate(resolve));
    const second = await f.gateway.invoke(access, f.request());
    assert.ok(second.kind === "command");
    assert.equal(second.command.state, "dispatching");
    gate.resolve();
    await first;
    f.control.knownResolveForbidden = true;
    const replay = await f.gateway.invoke(access, f.request());
    assert.ok(replay.kind === "command");
    assert.equal(replay.command.state, "committed");
    assert.equal(f.control.posts, 1);
    const changed = f.request();
    changed.parameters = { title: "Changed", markdown: "other" };
    await assert.rejects(
      f.gateway.invoke(access, changed),
      CognitiveAppGatewayError,
    );
    assert.equal(f.control.posts, 1);
  },
);
test("unit FakePort: transport/wire/binding failures and not_seen stay unknown and never reinvoke", async () => {
  for (const flag of [
    "throwInvoke",
    "malformedReceipt",
    "badBinding",
    "unknownReceipt",
  ] as const) {
    const f = fixture();
    f.control[flag] = true;
    const result = await f.gateway.invoke(access, f.request());
    assert.ok(result.kind === "command");
    assert.equal(result.command.state, "unknown");
    assert.equal(f.control.records, 0);
    f.control.knownResolveForbidden = true;
    await f.gateway.invoke(access, f.request());
    assert.equal(f.control.posts, 1);
    const recovered = await f.gateway.recoverCommand({
      tenantId: "tenant",
      commandId: "command",
    });
    assert.equal(recovered.command.state, "unknown");
    assert.equal(f.control.posts, 1);
  }
});
test("unit FakePort: committed output schema failure still records and projects committed fact before reporting contract issue", async () => {
  const f = fixture();
  f.control.badResult = true;
  const result = await f.gateway.invoke(access, f.request());
  assert.ok(result.kind === "command");
  assert.equal(result.command.state, "committed");
  assert.equal(result.command.projectionState, "projected");
  assert.equal(result.contractIssue, "invalid-output");
  assert.equal(Object.hasOwn(result, "result"), false);
  assert.equal(f.control.records, 1);
  assert.equal(f.control.projections, 1);
});
test("unit FakePort: validated author committed with failed durable storage is observedCommitted, not fake durable or unknown", async () => {
  const f = fixture();
  f.control.throwRecord = true;
  const result = await f.gateway.invoke(access, f.request());
  assert.ok(result.kind === "command");
  assert.equal(result.command.state, "dispatching");
  assert.equal(result.persistence, "pending");
  assert.equal(result.hostIssue, "receipt-storage");
  assert.equal(result.observedCommitted!.receiptId, "receipt");
  assert.match(result.observedCommitted!.receiptHash, /^[a-f0-9]{64}$/);
  assert.equal(f.control.projections, 0);
  assert.equal(f.commands.get("command")!.state, "dispatching");
  await f.gateway.invoke(access, f.request());
  assert.equal(f.control.posts, 1);
});
test("unit FakePort: catalog failure cannot rewrite durable committed into failed write", async () => {
  const f = fixture();
  f.control.throwProjection = true;
  const result = await f.gateway.invoke(access, f.request());
  assert.ok(result.kind === "command");
  assert.equal(result.command.state, "committed");
  assert.equal(result.command.projectionState, "pending");
  assert.equal(result.hostIssue, "projection-pending");
  assert.ok(result.result);
  assert.equal(f.control.posts, 1);
});
test("unit FakePort: deterministic invalid/conflict ledger rejection is not an infrastructure pending observation", async () => {
  for (const code of ["invalid", "conflict"] as const) {
    const f = fixture();
    f.control.recordCode = code;
    await assert.rejects(
      f.gateway.invoke(access, f.request()),
      (error: unknown) => {
        assert.ok(error instanceof CognitiveAppGatewayError);
        assert.equal(error.reason, code);
        assert.equal(error.commandId, "command");
        assert.equal(error.message.includes("unit-secret"), false);
        assert.equal(Object.hasOwn(error, "observedCommitted"), false);
        return true;
      },
    );
    assert.equal(f.commands.get("command")!.state, "dispatching");
    assert.equal(f.control.projections, 0);
    assert.equal(f.control.posts, 1);
  }
});
test("unit FakePort: a different valid bound terminal receipt cannot replace an already committed or rejected fact", async () => {
  for (const original of ["committed", "rejected"] as const) {
    for (const change of ["terminal", "receipt-id", "evidence"] as const) {
      const f = fixture();
      f.control.authorReject = original === "rejected";
      await f.gateway.invoke(access, f.request());
      const before = clone(f.commands.get("command")!);
      const prior = f.control.retainedReceipt!;
      assert.equal(prior.status, original);
      const opposite =
        original === "committed"
          ? {
              protocol: domainProtocol,
              binding: prior.binding,
              status: "rejected",
              receiptId: "other-terminal",
              reason: { code: "conflict", message: "author now refuses" },
            }
          : {
              protocol: domainProtocol,
              binding: prior.binding,
              status: "committed",
              receiptId: "other-terminal",
              committedAt: at,
              result: {
                objectId: "note",
                versionRef: "version1",
                title: "Original",
                markdown: "exact original",
              },
              objects: [
                {
                  objectId: "note",
                  versionRef: "version1",
                  kind: "document",
                  title: "Original",
                },
              ],
            };
      f.control.retainedReceipt = parseDomainReceipt(
        change === "terminal"
          ? opposite
          : change === "receipt-id"
            ? {
                ...prior,
                receiptId: "different-receipt",
              }
            : prior.status === "committed"
              ? {
                  ...prior,
                  result: {
                    objectId: "note",
                    versionRef: "version1",
                    title: "Changed",
                    markdown: "other",
                  },
                }
              : {
                  ...prior,
                  reason: {
                    code: "conflict",
                    message: "different authoritative reason",
                  },
                },
      );
      await assert.rejects(
        f.gateway.recoverCommand({ tenantId: "tenant", commandId: "command" }),
        (error: unknown) => {
          assert.ok(error instanceof CognitiveAppGatewayError);
          assert.equal(error.reason, "conflict");
          assert.equal(error.commandId, "command");
          assert.equal(Object.hasOwn(error, "observedCommitted"), false);
          return true;
        },
      );
      assert.deepEqual(f.commands.get("command"), before);
      assert.equal(f.control.posts, 1);
      assert.equal(f.control.receiptReads, 1);
    }
  }
});
test("unit FakePort: connection state entry rejects extra authority and safely classifies internal errors", async () => {
  const f = fixture();
  const request = {
    appId: definition.id,
    version: definition.version,
    connectionId: "connection",
    expectedRevision: 1,
    state: "disabled" as const,
  };
  assert.equal(
    (await f.gateway.changeConnectionState(access, request)).connectionId,
    "connection",
  );
  await assert.rejects(
    f.gateway.changeConnectionState(access, {
      ...request,
      hostBindingId: "private",
    } as typeof request),
    (error: unknown) =>
      error instanceof CognitiveAppGatewayError && error.reason === "invalid",
  );
  f.platform.changeCognitiveAppConnectionState = async () => {
    throw new PlatformStorageError("conflict", "private SQL/token detail");
  };
  await assert.rejects(
    f.gateway.changeConnectionState(access, request),
    (error: unknown) => {
      assert.ok(error instanceof CognitiveAppGatewayError);
      assert.equal(error.reason, "conflict");
      assert.equal(error.message.includes("SQL/token"), false);
      return true;
    },
  );
});
test("unit FakePort: read has null command/no ledger and exact object read uses its distinct port and purpose", async () => {
  const f = fixture();
  const result = await f.gateway.invoke(access, f.readRequest());
  assert.equal(result.kind, "read");
  assert.ok(result.kind === "read");
  assert.equal(result.command, null);
  assert.equal(
    (f.control.wire as DomainInvokeRequest).delegation.command,
    null,
  );
  assert.equal(f.control.admitCalls, 0);
  assert.equal(f.control.dispatchCalls, 0);
  assert.equal(f.control.resolveCalls, 3);
  const old = await f.gateway.readObject(access, f.objectRequest());
  assert.equal(old.object.versionRef, "old-version");
  assert.equal(f.control.objectReads, 1);
  assert.equal(f.control.posts, 1);
  assert.equal(f.control.objectResolves, 3);
  f.control.badObject = true;
  await assert.rejects(
    f.gateway.readObject(access, f.objectRequest()),
    (error: unknown) =>
      error instanceof CognitiveAppGatewayError && error.reason === "contract",
  );
});
test("unit FakePort: immutable owner/authority/source drift rejects before sending or after reading without re-sending", async () => {
  const agent = parseDomainActor({
    ...human,
    actantId: "agent",
    kind: "agent",
    source: { kind: "input", inputId: "input1", humanActantId: "human_alice" },
  });
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.control.actor = parseDomainActor({ ...agent, tenantId: "other" });
    },
    (f: ReturnType<typeof fixture>) => {
      f.control.actor = parseDomainActor({ ...agent, principalId: "bob" });
    },
    (f: ReturnType<typeof fixture>) => {
      f.control.actor = parseDomainActor({ ...agent, actantId: "other_agent" });
    },
    (f: ReturnType<typeof fixture>) => {
      f.control.actor = parseDomainActor({
        ...agent,
        source: {
          kind: "input",
          inputId: "input2",
          humanActantId: "human_alice",
        },
      });
    },
    ...(
      [
        "appId",
        "version",
        "definitionHash",
        "instanceId",
        "serviceId",
        "dataAuthorityId",
        "connectionId",
      ] as const
    ).map((field) => (f: ReturnType<typeof fixture>) => {
      f.control.target[field] =
        field === "definitionHash"
          ? "f".repeat(64)
          : field === "version"
            ? "1.0.1"
            : "different";
    }),
  ]) {
    for (const phase of [2, 3]) {
      const f = fixture(agent);
      f.control.onResolve = (call) => {
        if (call === phase) mutate(f);
      };
      await assert.rejects(
        f.gateway.invoke(access, f.readRequest()),
        (error: unknown) =>
          error instanceof CognitiveAppGatewayError &&
          error.reason === "conflict",
      );
      assert.equal(f.control.posts, phase === 2 ? 0 : 1);
      const o = fixture(agent);
      o.control.onObject = (call) => {
        if (call === phase) mutate(o);
      };
      await assert.rejects(
        o.gateway.readObject(access, o.objectRequest()),
        (error: unknown) =>
          error instanceof CognitiveAppGatewayError &&
          error.reason === "conflict",
      );
      assert.equal(o.control.objectReads, phase === 2 ? 0 : 1);
    }
  }
  const f = fixture();
  f.control.onResolve = (call) => {
    if (call === 2) {
      f.control.target.connectionRevision++;
      f.control.target.grantRevision++;
    }
  };
  assert.equal((await f.gateway.invoke(access, f.readRequest())).kind, "read");
});
test("unit FakePort: ingress params/resources/scalars and exact object reference are detached before asynchronous resolution", async () => {
  const f = fixture(),
    entered = deferred(),
    release = deferred();
  f.control.onResolve = async () => {
    entered.resolve();
    await release.promise;
  };
  const request = f.request();
  const result = f.gateway.invoke(access, request);
  await entered.promise;
  (request.parameters as { title: string }).title = "mutated";
  (request.resources as unknown[]).push({
    objectId: "hidden",
    versionRef: "latest",
  });
  request.projectId = "different";
  release.resolve();
  const answer = await result;
  assert.ok(answer.kind === "command");
  assert.equal(answer.command.projectId, "project");
  assert.equal(
    (f.control.wire as DomainInvokeRequest).parameters &&
      ((f.control.wire as DomainInvokeRequest).parameters as { title: string })
        .title,
    "Original",
  );
  assert.deepEqual(answer.command.resources, []);
  const o = fixture(),
    ready = deferred(),
    resume = deferred();
  o.control.onObject = async (call) => {
    if (call === 1) {
      ready.resolve();
      await resume.promise;
    }
  };
  const object = o.objectRequest();
  const reading = o.gateway.readObject(access, object);
  await ready.promise;
  object.object.versionRef = "mutated";
  object.maxBytes = 1;
  resume.resolve();
  assert.equal((await reading).object.versionRef, "old-version");
});
test("unit FakePort: recovery retains actual Agent task-run with input and never reclassifies to a Human/input call", async () => {
  const actor = parseDomainActor({
    ...human,
    actantId: "agent",
    kind: "agent",
    source: {
      kind: "task-run",
      sessionId: "session",
      scheduleId: "schedule",
      eventId: "event",
      sourceInputId: "original_input",
      humanActantId: "human_alice",
    },
  });
  const f = fixture(actor);
  f.control.throwInvoke = true;
  await f.gateway.invoke(access, f.request());
  f.control.throwInvoke = false;
  f.control.knownResolveForbidden = true;
  await f.gateway.recoverCommand({ tenantId: "tenant", commandId: "command" });
  const wire = parseReceiptReadRequest(f.control.wire);
  assert.deepEqual(wire.delegation.actor, actor);
  assert.equal(wire.delegation.purpose, "receipt-recovery");
  assert.equal(f.control.posts, 1);
  assert.equal(f.control.receiptReads, 1);
});
test("unit FakePort: Human describe setup strictly checks service tuple before relational create and rejects authority-bearing request extras", async () => {
  const f = fixture();
  const request = {
    appId: definition.id,
    version: definition.version,
    connectionId: "connection",
    expectedRevision: 0 as const,
    serviceId: "author_service",
    dataAuthorityId: "author_data",
  };
  f.control.wrongDescribe = true;
  await assert.rejects(
    f.gateway.connect(access, request),
    CognitiveAppGatewayError,
  );
  assert.equal(f.control.creates, 0);
  f.control.wrongDescribe = false;
  await f.gateway.connect(access, request);
  assert.equal(f.control.creates, 1);
  assert.ok(
    f.events.indexOf("describe") < f.events.indexOf("create-connection"),
  );
  await assert.rejects(
    f.gateway.invoke(access, {
      ...f.request(),
      endpoint: "https://secret.invalid",
    } as CognitiveAppGatewayInvokeRequest),
    (error: unknown) =>
      error instanceof CognitiveAppGatewayError && error.reason === "invalid",
  );
  await assert.rejects(
    f.gateway.readObject(access, {
      ...f.objectRequest(),
      principalId: "bob",
    } as CognitiveAppGatewayObjectReadRequest),
    CognitiveAppGatewayError,
  );
  await assert.rejects(
    f.gateway.recoverPage({ tenantId: "tenant", limit: 33 }),
    CognitiveAppGatewayError,
  );
});

// Second evidence layer: a real offline-packed SDK, separate Node author process,
// author-owned SQLite originals and the actual Platform Store on both backends.
// Only the authenticated ingress authority resolver is an explicit test fixture;
// this is not real Runtime credential/source verification or original App proof.
const repoApplication = fileURLToPath(new URL("../", import.meta.url));
const integrationCredential =
  "isolated_gateway_author_credential_abcdefghijklmnopqrstuvwxyz";
let packedDirectory: string | undefined;
let packedAuthor: Promise<string> | undefined;
function safeChildEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_NO_WARNINGS: "1" };
  for (const name of ["PATH", "HOME", "TMPDIR", "SYSTEMROOT"])
    if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
}
function preparePackedAuthor(): Promise<string> {
  return (packedAuthor ??= Promise.resolve().then(() => {
    packedDirectory = mkdtempSync(join(tmpdir(), "morphz-gateway-packed-"));
    const sdkRoot = join(packedDirectory, "sdk"),
      authorRoot = join(packedDirectory, "author");
    mkdirSync(join(sdkRoot, "src"), { recursive: true });
    mkdirSync(authorRoot);
    for (const file of [
      "package.json",
      "tsconfig.build.json",
      "README.md",
      "LICENSE",
    ])
      copyFileSync(
        join(repoApplication, "packages/cognitive-app-sdk", file),
        join(sdkRoot, file),
      );
    const sdkSource = join(repoApplication, "packages/cognitive-app-sdk/src");
    for (const file of readdirSync(sdkSource, { withFileTypes: true }))
      if (file.isFile() && file.name.endsWith(".ts"))
        copyFileSync(
          join(sdkSource, file.name),
          join(sdkRoot, "src", file.name),
        );
    for (const file of [
      "package.json",
      "service.mjs",
      "definition.json",
      "README.md",
      "MODEL.md",
    ])
      copyFileSync(
        join(repoApplication, "examples/cognitive-notes", file),
        join(authorRoot, file),
      );
    const userConfig = join(packedDirectory, "npm-user.cfg"),
      globalConfig = join(packedDirectory, "npm-global.cfg");
    writeFileSync(userConfig, "");
    writeFileSync(globalConfig, "");
    const cli = process.env.npm_execpath;
    assert.ok(cli, "formal npm test supplies the installed npm CLI");
    const npm = (cwd: string, args: string[]) =>
      execFileSync(process.execPath, [cli, ...args], {
        cwd,
        encoding: "utf8",
        timeout: 60000,
        env: {
          ...safeChildEnvironment(),
          npm_config_cache: join(homedir(), ".npm"),
          npm_config_userconfig: userConfig,
          npm_config_globalconfig: globalConfig,
          npm_config_registry: "https://registry.npmjs.org/",
          npm_config_offline: "true",
          npm_config_audit: "false",
          npm_config_fund: "false",
          npm_config_update_notifier: "false",
        },
      });
    npm(sdkRoot, [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ]);
    const packed: unknown = JSON.parse(
      npm(sdkRoot, ["pack", "--offline", "--json", "--silent"]),
    );
    assert.ok(Array.isArray(packed) && packed.length === 1);
    const filename: unknown = Reflect.get(packed[0] as object, "filename");
    assert.equal(filename, "morphz-cognitive-app-sdk-0.3.0.tgz");
    npm(authorRoot, [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(sdkRoot, String(filename)),
    ]);
    const serviceSource = readFileSync(join(authorRoot, "service.mjs"), "utf8");
    assert.ok(serviceSource.includes('from "@morphz/cognitive-app-sdk"'));
    assert.equal(
      /packages\/(application|platform)|\.\.\//.test(serviceSource),
      false,
    );
    return authorRoot;
  }));
}
after(() => {
  if (packedDirectory)
    rmSync(packedDirectory, { recursive: true, force: true });
});
type Ready = {
  port: number;
  serviceId: string;
  dataAuthorityId: string;
  definition: { appId: string; version: string; definitionHash: string };
};
async function startAuthor(authorRoot: string, db: string, config: string) {
  const child = spawn(
    process.execPath,
    [
      join(authorRoot, "service.mjs"),
      "--db",
      db,
      "--config",
      config,
      "--port",
      "0",
    ],
    {
      cwd: authorRoot,
      env: safeChildEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  try {
    const ready = await new Promise<Ready>((resolve, reject) => {
      let out = "",
        err = "";
      const timer = setTimeout(
        () => reject(new Error("isolated author startup timeout")),
        10000,
      );
      const cleanup = () => clearTimeout(timer);
      child.stderr!.on("data", (part: Buffer) => {
        err += part.toString("utf8");
      });
      child.stdout!.on("data", (part: Buffer) => {
        out += part.toString("utf8");
        if (!out.includes("\n")) return;
        try {
          const parsed = parseWireJson(JSON.parse(out.split("\n")[0]!));
          assert.ok(
            parsed && typeof parsed === "object" && !Array.isArray(parsed),
          );
          const value = parsed as Record<string, unknown>;
          assert.ok(
            Number.isSafeInteger(value.port) &&
              Number(value.port) > 0 &&
              Number(value.port) <= 65535,
          );
          assert.equal(typeof value.serviceId, "string");
          assert.equal(typeof value.dataAuthorityId, "string");
          assert.deepEqual(value.definition, {
            appId: definition.id,
            version: definition.version,
            definitionHash,
          });
          cleanup();
          resolve(value as Ready);
        } catch (error) {
          cleanup();
          reject(error);
        }
      });
      child.once("error", (error) => {
        cleanup();
        reject(error);
      });
      child.once("exit", (code) => {
        cleanup();
        reject(new Error(`isolated author exited ${code}: ${err}`));
      });
    });
    return { child, ready };
  } catch (error) {
    await stopAuthor(child);
    throw error;
  }
}
async function stopAuthor(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}
type ActualFixture = {
  store: PlatformStore;
  gateway: ReturnType<typeof createCognitiveAppGateway>;
  q: SqlQuery;
  connectionId: string;
  privateConfig: string;
  control: {
    dropNextInvoke: boolean;
    responseMode: "exact" | "malformed" | "bad-binding" | "bad-output";
    recoveryMode: "exact" | "terminal" | "receipt-id" | "evidence";
    credential: string;
    paths: string[];
    droppedReceipts: Array<ReturnType<typeof parseDomainReceipt>>;
    heldRead?: {
      path: "/invoke" | "/objects/read";
      received(value: { statusCode: number; body: unknown }): void;
      released: Promise<void>;
    };
  };
  identities: Map<
    string,
    NonNullable<Awaited<ReturnType<PlatformAuthorityVerifier["resolveActor"]>>>
  >;
  request(commandId: string): CognitiveAppGatewayInvokeRequest;
  reopen(): Promise<void>;
  restartAuthor(): Promise<void>;
  authorRows(sql: string): Record<string, unknown>[];
  holdNextRead(path: "/invoke" | "/objects/read"): {
    received: Promise<{ statusCode: number; body: unknown }>;
    release(): void;
  };
};
async function actualFixture(
  backend: "sqlite" | "postgres",
  run: (f: ActualFixture) => Promise<void>,
) {
  const authorRoot = await preparePackedAuthor();
  const directory = mkdtempSync(join(tmpdir(), "morphz-gateway-integration-"));
  const authorDb = join(directory, "author.sqlite"),
    config = join(directory, "bootstrap.json");
  writeFileSync(
    config,
    JSON.stringify({
      format: "cognitive-notes-bootstrap/v1",
      integrations: [
        {
          credentialSha256: createHash("sha256")
            .update(integrationCredential)
            .digest("hex"),
          issuer: "trusted_host",
          tenantId: "tenant-a",
          principalId: "alice",
          humanActantId: "alice-human",
          agentActantIds: ["agent-one"],
          projects: [
            { projectId: "project-a", read: true, write: true },
            { projectId: "project-b", read: true, write: true },
          ],
        },
      ],
    }),
    { mode: 0o600 },
  );
  let author: Awaited<ReturnType<typeof startAuthor>> | undefined,
    proxy: Server | undefined;
  const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
  const pool =
    backend === "postgres"
      ? new Pool({ connectionString: process.env.MORPHZ_TEST_POSTGRES_URL! })
      : null;
  let store: PlatformStore | undefined,
    database: DatabaseSync | undefined,
    releaseAdmin: (() => void) | undefined;
  const identities = new Map<
    string,
    NonNullable<Awaited<ReturnType<PlatformAuthorityVerifier["resolveActor"]>>>
  >([
    [
      "alice",
      {
        tenantId: "tenant-a",
        principalId: "alice",
        actantId: "alice-human",
        kind: "human",
        runtimeInputId: null,
      },
    ],
    [
      "bob",
      {
        tenantId: "tenant-a",
        principalId: "bob",
        actantId: "bob-human",
        kind: "human",
        runtimeInputId: null,
      },
    ],
    [
      "agent",
      {
        tenantId: "tenant-a",
        principalId: "alice",
        actantId: "agent-one",
        kind: "agent",
        runtimeInputId: "input-one",
        initiatingHumanActantId: "alice-human",
        scopeProjectId: "project-a",
      },
    ],
  ]);
  const capabilities: PlatformAuthorityVerifier = {
    async resolveActor(access) {
      return identities.get(access.credential) ?? null;
    },
    async resolveActant({ tenantId, actantId }) {
      return tenantId !== "tenant-a"
        ? null
        : actantId === "alice-human"
          ? { principalId: "alice", kind: "human" }
          : actantId === "bob-human"
            ? { principalId: "bob", kind: "human" }
            : actantId === "agent-one"
              ? { principalId: "agent-service", kind: "agent" }
              : null;
    },
    async resolveProjectAgent() {
      return { principalId: "agent-service", actantId: "agent-one" };
    },
    async verifyApplicationObject() {
      return false;
    },
  };
  const control: ActualFixture["control"] = {
    dropNextInvoke: false,
    responseMode: "exact",
    recoveryMode: "exact",
    credential: integrationCredential,
    paths: [],
    droppedReceipts: [],
  };
  try {
    author = await startAuthor(authorRoot, authorDb, config);
    // Test-only external proxy: it forwards real requests to the independent
    // process. Loss happens only AFTER its actual commit and complete response;
    // corrupted-response cases remain explicitly adversarial network witnesses.
    proxy = createServer((request, response) => {
      control.paths.push(request.url!);
      const upstream = httpRequest(
        {
          hostname: "127.0.0.1",
          port: author!.ready.port,
          path: request.url,
          method: request.method,
          headers: request.headers,
          agent: false,
        },
        (received) => {
          const chunks: Buffer[] = [];
          received.on("data", (part: Buffer) => chunks.push(part));
          received.once("end", () => {
            let body = Buffer.concat(chunks);
            if (
              request.url === "/invoke" &&
              control.dropNextInvoke &&
              received.statusCode === 200
            ) {
              control.dropNextInvoke = false;
              control.droppedReceipts.push(
                parseDomainReceipt(JSON.parse(body.toString("utf8"))),
              );
              response.destroy();
              return;
            }
            if (
              request.url === "/invoke" &&
              received.statusCode === 200 &&
              control.responseMode !== "exact"
            ) {
              const original = JSON.parse(body.toString("utf8"));
              body = Buffer.from(
                JSON.stringify(
                  control.responseMode === "malformed"
                    ? { ...original, receiptId: null }
                    : control.responseMode === "bad-binding"
                      ? {
                          ...original,
                          binding: {
                            ...original.binding,
                            authority: {
                              ...original.binding.authority,
                              dataAuthorityId: "wrong-authority",
                            },
                          },
                        }
                      : {
                          ...original,
                          result: { unexpected: "invalid actual wire output" },
                        },
                ),
              );
            }
            if (
              request.url === "/receipts/read" &&
              received.statusCode === 200 &&
              control.recoveryMode !== "exact"
            ) {
              const original = parseDomainReceipt(
                JSON.parse(body.toString("utf8")),
              );
              assert.notEqual(original.status, "unknown");
              if (original.status === "unknown")
                throw new Error("fixture expected actual terminal");
              const opposite =
                original.status === "committed"
                  ? {
                      protocol: domainProtocol,
                      binding: original.binding,
                      status: "rejected",
                      receiptId: "network-different-terminal",
                      reason: {
                        code: "conflict",
                        message: "different authoritative refusal",
                      },
                    }
                  : {
                      protocol: domainProtocol,
                      binding: original.binding,
                      status: "committed",
                      receiptId: "network-different-terminal",
                      committedAt: at,
                      objects: [],
                      result: {
                        objectId: "other-object",
                        versionRef: "other-version",
                        title: "Network claims commit",
                        markdown: "different result",
                      },
                    };
              const mutated = parseDomainReceipt(
                control.recoveryMode === "terminal"
                  ? opposite
                  : control.recoveryMode === "receipt-id"
                    ? {
                        ...original,
                        receiptId: "network-different-receipt-id",
                      }
                    : original.status === "committed"
                      ? {
                          ...original,
                          result: { unexpected: "changed evidence" },
                        }
                      : {
                          ...original,
                          reason: {
                            code: "conflict",
                            message: "changed authoritative reason",
                          },
                        },
                original.binding,
              );
              body = Buffer.from(JSON.stringify(mutated));
            }
            const headers = {
              ...received.headers,
              "content-length": String(body.length),
            };
            delete headers["transfer-encoding"];
            const send = () => {
              response.writeHead(received.statusCode!, headers);
              response.end(body);
            };
            const hold = control.heldRead;
            if (
              hold &&
              hold.path === request.url &&
              received.statusCode === 200
            ) {
              control.heldRead = undefined;
              // Hold only after the separate author process returned its real,
              // complete response. Policy changes below are actual Store writes,
              // not a fake read resolver or post-dispatch cancellation.
              hold.received({
                statusCode: received.statusCode,
                body: parseWireJson(JSON.parse(body.toString("utf8"))),
              });
              void hold.released.then(send);
            } else send();
          });
          received.once("error", () => response.destroy());
        },
      );
      upstream.once("error", () => response.destroy());
      request.once("error", () => upstream.destroy());
      request.pipe(upstream);
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const address = proxy.address();
    assert.ok(address && typeof address !== "string");
    const privateConfig = join(directory, "bindings.json");
    writeFileSync(
      privateConfig,
      JSON.stringify({
        format: "morphz-host-cognitive-bindings/v1",
        issuer: "trusted_host",
        bindings: [
          {
            tenantId: "tenant-a",
            principalId: "alice",
            appId: definition.id,
            serviceId: author.ready.serviceId,
            dataAuthorityId: author.ready.dataAuthorityId,
            baseUrl: `http://127.0.0.1:${address.port}`,
            credentialEnv: "MORPHZ_APP_COGNITIVE_CREDENTIAL_ISOLATED",
            current: true,
            approvedLoopback: { host: "127.0.0.1", port: address.port },
          },
        ],
      }),
      { mode: 0o600 },
    );
    const bindings = new CognitiveAppBindings({
      filename: privateConfig,
      readSecret: (name) => {
        assert.equal(name, "MORPHZ_APP_COGNITIVE_CREDENTIAL_ISOLATED");
        return control.credential;
      },
    });
    let q: SqlQuery;
    if (pool) {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      store = await PlatformStore.postgres(
        { connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!, schema },
        capabilities,
      );
      const client = await pool.connect();
      await client.query(`SET search_path TO "${schema}",pg_catalog`);
      q = postgresQuery(client);
      releaseAdmin = () => client.release();
    } else {
      store = await PlatformStore.sqlite(
        join(directory, "platform.sqlite"),
        capabilities,
      );
      database = new DatabaseSync(join(directory, "platform.sqlite"));
      database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
      q = sqliteQuery(database);
    }
    await store.provisionTenant("tenant-a", at);
    for (const projectId of ["project-a", "project-b"]) {
      await q.change(
        "INSERT INTO projects(tenant_id,project_id,kind,owner_principal_id,title,revision,created_at,updated_at) VALUES('tenant-a',?,'project','alice',?,1,?,?)",
        [projectId, projectId, at, at],
      );
      for (const member of ["alice", "agent-service"])
        await q.change(
          "INSERT INTO project_members(tenant_id,project_id,principal_id) VALUES('tenant-a',?,?)",
          [projectId, member],
        );
    }
    const version = await store.installCognitiveApp(
      { credential: "alice" },
      { definition, now: at },
    );
    assert.equal(version.definitionHash, definitionHash);
    await store.changeCognitiveAppGrant(
      { credential: "alice" },
      {
        appId: definition.id,
        version: definition.version,
        expectedRevision: 0,
        state: "active",
        now: at,
      },
    );
    const makeGateway = () =>
      createCognitiveAppGateway({
        platform: store!,
        bindings,
        transport: new CognitiveAppTransport(),
      });
    const gateway = makeGateway();
    const connection = await gateway.connect(
      { credential: "alice" },
      {
        appId: definition.id,
        version: definition.version,
        expectedDefinitionHash: version.definitionHash,
        expectedGrantRevision: 1,
        connectionId: "real-connection",
        expectedRevision: 0,
        serviceId: author.ready.serviceId,
        dataAuthorityId: author.ready.dataAuthorityId,
      },
    );
    const f: ActualFixture = {
      store,
      gateway,
      q,
      connectionId: connection.connectionId,
      privateConfig,
      control,
      identities,
      request(commandId) {
        return {
          appId: definition.id,
          version: definition.version,
          connectionId: connection.connectionId,
          projectId: "project-a",
          operationId: "notes.create",
          commandId,
          resources: [],
          parameters: {
            title: "Actual original",
            markdown: "PRIVATE-BUSINESS-BODY-仅作者保管",
          },
        };
      },
      async reopen() {
        await store!.close();
        store = pool
          ? await PlatformStore.postgres(
              {
                connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
                schema,
              },
              capabilities,
            )
          : await PlatformStore.sqlite(
              join(directory, "platform.sqlite"),
              capabilities,
            );
        f.store = store;
        f.gateway = makeGateway();
      },
      async restartAuthor() {
        const before = author!.ready;
        await stopAuthor(author!.child);
        author = await startAuthor(authorRoot, authorDb, config);
        assert.deepEqual({ ...author.ready, port: before.port }, before);
      },
      authorRows(sql) {
        const db = new DatabaseSync(authorDb);
        try {
          return db.prepare(sql).all() as Record<string, unknown>[];
        } finally {
          db.close();
        }
      },
      holdNextRead(path) {
        assert.equal(control.heldRead, undefined);
        const released = deferred();
        let receive!: (value: { statusCode: number; body: unknown }) => void;
        const received = new Promise<{ statusCode: number; body: unknown }>(
          (resolve) => {
            receive = resolve;
          },
        );
        control.heldRead = {
          path,
          received: receive,
          released: released.promise,
        };
        return { received, release: released.resolve };
      },
    };
    await run(f);
  } finally {
    proxy?.closeAllConnections();
    if (proxy?.listening)
      await new Promise<void>((resolve) => proxy!.close(() => resolve()));
    if (author) await stopAuthor(author.child);
    releaseAdmin?.();
    await store?.close();
    database?.close();
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
    rmSync(directory, { recursive: true, force: true });
  }
}
function returnedObject(value: unknown): {
  objectId: string;
  versionRef: string;
  title: string;
  markdown: string;
} {
  const parsed = validateOperationValue(
    definition.operations.find((op) => op.id === "notes.create")!.outputSchema,
    value,
  );
  return parsed as {
    objectId: string;
    versionRef: string;
    title: string;
    markdown: string;
  };
}
async function assertNoBusinessBodyInPlatform(f: ActualFixture) {
  const commands = await f.q.all<Record<string, unknown>>(
    "SELECT * FROM cognitive_app_commands",
    [],
  );
  const catalog = await f.q.all<Record<string, unknown>>(
    "SELECT * FROM content_entries",
    [],
  );
  assert.equal(
    JSON.stringify([commands, catalog]).includes("PRIVATE-BUSINESS-BODY"),
    false,
  );
  assert.ok(
    commands.every(
      (row) =>
        !["parameters", "result", "body"].some((key) =>
          Object.hasOwn(row, key),
        ),
    ),
  );
}
for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `real packed author + ${backend}: reads recheck current policy after a complete held HTTP response before disclosing data`,
    { timeout: 120000 },
    async (t) =>
      actualFixture(backend, async (f) => {
        const humanAccess = { credential: "alice" };
        const created = await f.gateway.invoke(
          humanAccess,
          f.request("disclosure-original"),
        );
        assert.ok(created.kind === "command");
        const first = returnedObject(created.result);
        const revised = await f.gateway.invoke(humanAccess, {
          ...f.request("disclosure-revised"),
          operationId: "notes.revise",
          resources: [
            { objectId: first.objectId, versionRef: first.versionRef },
          ],
          parameters: {
            objectId: first.objectId,
            baselineVersionRef: first.versionRef,
            title: "Current private title",
            markdown: "PRIVATE-BUSINESS-BODY-newer-not-the-requested-history",
          },
        });
        assert.ok(revised.kind === "command");
        const second = returnedObject(revised.result);
        let grantRevision = 1,
          connectionRevision = 1;
        const grant = async (state: "active" | "disabled") => {
          const result = await f.store.changeCognitiveAppGrant(humanAccess, {
            appId: definition.id,
            version: definition.version,
            expectedRevision: grantRevision,
            state,
            now: at,
          });
          grantRevision = result.revision;
        };
        const connection = async (state: "active" | "disabled") => {
          const result = await f.gateway.changeConnectionState(humanAccess, {
            appId: definition.id,
            version: definition.version,
            connectionId: f.connectionId,
            expectedRevision: connectionRevision,
            state,
          });
          connectionRevision = result.revision;
        };
        const read = (
          path: "/invoke" | "/objects/read",
          credential: string,
          explicitRevisions = false,
        ) => {
          const target = {
            appId: definition.id,
            version: definition.version,
            connectionId: f.connectionId,
            projectId: "project-a",
            ...(explicitRevisions
              ? {
                  expectedGrantRevision: grantRevision,
                  expectedConnectionRevision: connectionRevision,
                }
              : {}),
          };
          return path === "/invoke"
            ? f.gateway.invoke(
                { credential },
                {
                  ...target,
                  operationId: "notes.list",
                  resources: [],
                  parameters: { limit: 32 },
                },
              )
            : f.gateway.readObject(
                { credential },
                {
                  ...target,
                  object: {
                    objectId: first.objectId,
                    versionRef: first.versionRef,
                  },
                  maxBytes: 262144,
                },
              );
        };
        const cases = [
          {
            name: "grant disabled in actual Platform",
            credential: "alice",
            mutate: () => grant("disabled"),
            restore: () => grant("active"),
            reason: "forbidden",
          },
          {
            name: "actual project membership removed",
            credential: "alice",
            mutate: async () => {
              await f.q.change(
                "DELETE FROM project_members WHERE tenant_id='tenant-a' AND project_id='project-a' AND principal_id='alice'",
                [],
              );
            },
            restore: async () => {
              await f.q.change(
                "INSERT INTO project_members(tenant_id,project_id,principal_id) VALUES('tenant-a','project-a','alice')",
                [],
              );
            },
            reason: "forbidden",
          },
          {
            name: "本人 connection disabled in actual Platform",
            credential: "alice",
            mutate: () => connection("disabled"),
            restore: () => connection("active"),
            reason: "forbidden",
          },
          {
            name: "ingress credential removed by explicit test authority port",
            credential: "alice",
            mutate: async () => {
              f.identities.delete("alice");
            },
            restore: async () => {
              f.identities.set("alice", {
                tenantId: "tenant-a",
                principalId: "alice",
                actantId: "alice-human",
                kind: "human",
                runtimeInputId: null,
              });
            },
            reason: "forbidden",
          },
          {
            name: "valid original Agent input source changed by explicit test authority port",
            credential: "agent",
            mutate: async () => {
              const before = f.identities.get("agent")!;
              f.identities.set("agent", {
                ...before,
                runtimeInputId: "input-two",
              });
            },
            restore: async () => {
              const before = f.identities.get("agent")!;
              f.identities.set("agent", {
                ...before,
                runtimeInputId: "input-one",
              });
            },
            reason: "conflict",
          },
        ] as const;
        for (const path of ["/invoke", "/objects/read"] as const) {
          for (const change of cases) {
            await t.test(`${path}: ${change.name}`, async () => {
              const posts = f.control.paths.filter(
                (item) => item === path,
              ).length;
              const hold = f.holdNextRead(path);
              const outcome = read(path, change.credential).then(
                (value) => ({ ok: true as const, value }),
                (error: unknown) => ({ ok: false as const, error }),
              );
              try {
                const authorResponse = await hold.received;
                assert.equal(authorResponse.statusCode, 200);
                assert.equal(
                  f.control.paths.filter((item) => item === path).length,
                  posts + 1,
                  "The actual HTTP read already reached the packed independent author.",
                );
                assert.ok(
                  JSON.stringify(authorResponse.body).includes(
                    path === "/invoke" ? second.title : first.markdown,
                  ),
                  "The held body is the real author's private data, not a fake denial fixture.",
                );
                await change.mutate();
                hold.release();
                const answer = await outcome;
                assert.equal(
                  answer.ok,
                  false,
                  "No previously read data may be disclosed after loss/change of current authority.",
                );
                assert.ok(!answer.ok);
                assert.ok(answer.error instanceof CognitiveAppGatewayError);
                assert.equal(answer.error.reason, change.reason);
                assert.equal(
                  JSON.stringify(answer.error).includes(first.markdown),
                  false,
                );
                assert.equal(
                  String(answer.error).includes(second.title),
                  false,
                );
              } finally {
                hold.release();
                await outcome;
                await change.restore();
              }
              assert.equal(
                f.control.paths.filter((item) => item === path).length,
                posts + 1,
                "Reads are not resent by the disclosure gate.",
              );
            });
          }
          for (const explicitRevisions of [false, true]) {
            await t.test(
              `${path}: still-active exact identity with ${explicitRevisions ? "explicit CAS rejects revision drift" : "no CAS accepts mutable revision drift and exact history"}`,
              async () => {
                const hold = f.holdNextRead(path);
                const outcome = read(path, "alice", explicitRevisions).then(
                  (value) => ({ ok: true as const, value }),
                  (error: unknown) => ({ ok: false as const, error }),
                );
                await hold.received;
                try {
                  await grant("disabled");
                  await grant("active");
                  await connection("disabled");
                  await connection("active");
                  hold.release();
                  const answer = await outcome;
                  if (explicitRevisions) {
                    assert.equal(answer.ok, false);
                    assert.ok(
                      !answer.ok &&
                        answer.error instanceof CognitiveAppGatewayError,
                    );
                    assert.equal(answer.error.reason, "conflict");
                  } else {
                    assert.equal(answer.ok, true);
                    assert.ok(answer.ok);
                    if ("content" in answer.value) {
                      assert.equal(
                        answer.value.object.versionRef,
                        first.versionRef,
                      );
                      assert.notEqual(
                        answer.value.object.versionRef,
                        second.versionRef,
                      );
                      assert.deepEqual(answer.value.content, {
                        format: "json",
                        value: { title: first.title, markdown: first.markdown },
                      });
                    } else {
                      assert.equal(answer.value.kind, "read");
                      assert.ok(answer.value.kind === "read");
                      assert.equal(answer.value.command, null);
                    }
                  }
                } finally {
                  hold.release();
                  await outcome;
                }
              },
            );
          }
        }
        assert.equal(f.authorRows("SELECT * FROM notes").length, 1);
        assert.equal(f.authorRows("SELECT * FROM note_versions").length, 2);
        assert.equal(
          f.authorRows("SELECT * FROM author_commands").length,
          2,
          "Read rejection never cancels or replays the two real writes.",
        );
        await assertNoBusinessBodyInPlatform(f);
      }),
  );
  test(
    `real packed author + ${backend}: create/read/revise/exact old object and cold reopen retain originals only in author`,
    { timeout: 120000 },
    async () =>
      actualFixture(backend, async (f) => {
        const created = await f.gateway.invoke(
          { credential: "alice" },
          f.request("real-create"),
        );
        assert.ok(created.kind === "command");
        assert.equal(created.command.state, "committed");
        assert.equal(created.command.projectionState, "projected");
        const first = returnedObject(created.result);
        const readRequest = {
          ...f.request("unused"),
          operationId: "notes.list",
          parameters: { limit: 32 },
        };
        delete (readRequest as Partial<typeof readRequest>).commandId;
        const listing = await f.gateway.invoke(
          { credential: "alice" },
          readRequest,
        );
        assert.ok(listing.kind === "read");
        assert.equal(listing.command, null);
        assert.deepEqual(listing.result, {
          objects: [
            {
              objectId: first.objectId,
              versionRef: first.versionRef,
              title: first.title,
            },
          ],
        });
        const revision = await f.gateway.invoke(
          { credential: "alice" },
          {
            ...f.request("real-revise"),
            operationId: "notes.revise",
            resources: [
              { objectId: first.objectId, versionRef: first.versionRef },
            ],
            parameters: {
              objectId: first.objectId,
              baselineVersionRef: first.versionRef,
              title: "Revised",
              markdown: "PRIVATE-BUSINESS-BODY-second",
            },
          },
        );
        assert.ok(revision.kind === "command");
        assert.equal(revision.command.state, "committed");
        assert.equal(revision.command.projectionState, "projected");
        const second = returnedObject(revision.result);
        assert.notEqual(second.versionRef, first.versionRef);
        const old = await f.gateway.readObject(
          { credential: "alice" },
          {
            appId: definition.id,
            version: definition.version,
            connectionId: f.connectionId,
            projectId: "project-a",
            object: { objectId: first.objectId, versionRef: first.versionRef },
            maxBytes: 262144,
          },
        );
        assert.deepEqual(old.content, {
          format: "json",
          value: { title: first.title, markdown: first.markdown },
        });
        assert.equal(f.authorRows("SELECT * FROM notes").length, 1);
        assert.equal(f.authorRows("SELECT * FROM note_versions").length, 2);
        const before = clone(revision.command),
          posts = f.control.paths.filter((path) => path === "/invoke").length;
        await f.restartAuthor();
        await f.reopen();
        const recovered = await f.gateway.recoverCommand({
          tenantId: "tenant-a",
          commandId: "real-revise",
        });
        assert.deepEqual(recovered.command, before);
        assert.equal(
          f.control.paths.filter((path) => path === "/invoke").length,
          posts,
        );
        await assertNoBusinessBodyInPlatform(f);
      }),
  );
  test(
    `real packed author + ${backend}: actual post-COMMIT response loss and cold restart recover without invoke or current grant`,
    { timeout: 120000 },
    async () =>
      actualFixture(backend, async (f) => {
        f.control.dropNextInvoke = true;
        const first = await f.gateway.invoke(
          { credential: "alice" },
          f.request("lost-response"),
        );
        assert.ok(first.kind === "command");
        assert.equal(first.command.state, "unknown");
        assert.equal(first.command.receiptRef, null);
        assert.equal(f.control.droppedReceipts.length, 1);
        assert.equal(f.authorRows("SELECT * FROM notes").length, 1);
        const realReceipt = f.control.droppedReceipts[0]!;
        assert.equal(realReceipt.status, "committed");
        await f.store.changeCognitiveAppGrant(
          { credential: "alice" },
          {
            appId: definition.id,
            version: definition.version,
            expectedRevision: 1,
            state: "disabled",
            now: at,
          },
        );
        await f.restartAuthor();
        await f.reopen();
        const recovered = await f.gateway.recoverCommand({
          tenantId: "tenant-a",
          commandId: "lost-response",
        });
        assert.equal(recovered.command.state, "committed");
        assert.equal(recovered.command.projectionState, "projected");
        assert.equal(
          recovered.command.receiptRef,
          realReceipt.status === "committed" ? realReceipt.receiptId : null,
        );
        assert.equal(recovered.command.receiptHash, digest(realReceipt));
        const replay = await f.gateway.invoke(
          { credential: "alice" },
          f.request("lost-response"),
        );
        assert.ok(replay.kind === "command");
        assert.equal(replay.command.state, "committed");
        assert.equal(
          f.control.paths.filter((path) => path === "/invoke").length,
          1,
        );
        assert.equal(f.authorRows("SELECT * FROM author_commands").length, 1);
        await assertNoBusinessBodyInPlatform(f);
      }),
  );
  test(
    `real packed author + ${backend}: actual first-dispatch revoked grant and actual source/project fences prevent HTTP`,
    { timeout: 120000 },
    async () =>
      actualFixture(backend, async (f) => {
        const request = {
          ...f.request("revoked-admitted"),
          commandId: "revoked-admitted",
        };
        const admitted = await f.store.admitCognitiveAppCommand(
          { credential: "alice" },
          request,
        );
        assert.equal(admitted.command.state, "admitted");
        await f.store.changeCognitiveAppGrant(
          { credential: "alice" },
          {
            appId: definition.id,
            version: definition.version,
            expectedRevision: 1,
            state: "disabled",
            now: at,
          },
        );
        await assert.rejects(
          f.gateway.invoke({ credential: "alice" }, request),
          (error: unknown) =>
            error instanceof CognitiveAppGatewayError &&
            (error.reason === "forbidden" || error.reason === "conflict"),
        );
        assert.equal(
          (
            await f.store.inspectCognitiveAppCommand(
              { credential: "alice" },
              { projectId: "project-a", commandId: request.commandId! },
            )
          ).state,
          "admitted",
        );
        assert.equal(
          f.control.paths.filter((path) => path === "/invoke").length,
          0,
        );
        await f.store.changeCognitiveAppGrant(
          { credential: "alice" },
          {
            appId: definition.id,
            version: definition.version,
            expectedRevision: 2,
            state: "active",
            now: at,
          },
        );
        await assert.rejects(
          f.gateway.invoke({ credential: "bob" }, f.request("bob-write")),
          CognitiveAppGatewayError,
        );
        await assert.rejects(
          f.gateway.invoke(
            { credential: "agent" },
            { ...f.request("agent-cross-project"), projectId: "project-b" },
          ),
          CognitiveAppGatewayError,
        );
        assert.equal(
          f.control.paths.filter((path) => path === "/invoke").length,
          0,
        );
        assert.equal(f.authorRows("SELECT * FROM notes").length, 0);
      }),
  );
  test(
    `real packed author + ${backend}: actual same-command race has one HTTP dispatch and persisted task-run source survives recovery`,
    { timeout: 120000 },
    async () =>
      actualFixture(backend, async (f) => {
        await f.store.createTask(
          { credential: "alice" },
          {
            commandId: "create-actual-task",
            taskId: "task-one",
            projectId: "project-a",
            title: "Actual scheduled operation",
            assigneeId: "agent-one",
            now: at,
          },
        );
        const admittedTask = await f.store.requestTaskRun(
          { credential: "agent" },
          {
            commandId: "actual-run-request",
            taskId: "task-one",
            expectedRevision: 1,
            sessionId: "session-one",
            intent: "Exact operation",
            notBefore: at,
            now: at,
          },
        );
        const runtimeTaskRun = {
          sessionId: admittedTask.sessionId,
          scheduleId: admittedTask.request.id,
          eventId: admittedTask.eventId,
        };
        f.identities.set("task-run", {
          tenantId: "tenant-a",
          principalId: "alice",
          actantId: "agent-one",
          kind: "agent",
          runtimeInputId: "input-one",
          initiatingHumanActantId: "alice-human",
          scopeProjectId: "project-a",
          runtimeTaskRun,
        });
        const request = f.request("task-race");
        await Promise.all([
          f.gateway.invoke({ credential: "task-run" }, request),
          f.gateway.invoke({ credential: "task-run" }, request),
        ]);
        assert.equal(
          f.control.paths.filter((path) => path === "/invoke").length,
          1,
        );
        const before = await f.store.inspectCognitiveAppCommand(
          { credential: "task-run" },
          { projectId: "project-a", commandId: request.commandId! },
        );
        assert.equal(before.state, "committed");
        assert.deepEqual(before.actor.source, {
          kind: "task-run",
          ...runtimeTaskRun,
          sourceInputId: "input-one",
          humanActantId: "alice-human",
        });
        f.identities.delete("task-run");
        await f.restartAuthor();
        await f.reopen();
        const recovered = await f.gateway.recoverCommand({
          tenantId: "tenant-a",
          commandId: request.commandId!,
        });
        assert.deepEqual(recovered.command.actor, before.actor);
        assert.equal(
          f.control.paths.filter((path) => path === "/invoke").length,
          1,
        );
        assert.equal(f.authorRows("SELECT * FROM author_commands").length, 1);
      }),
  );
  test(
    `real packed author + ${backend}: malformed or cross-binding real responses remain unknown, genuine recovery preserves committed fact`,
    { timeout: 120000 },
    async () =>
      actualFixture(backend, async (f) => {
        for (const mode of ["malformed", "bad-binding"] as const) {
          f.control.responseMode = mode;
          const result = await f.gateway.invoke(
            { credential: "alice" },
            f.request(mode),
          );
          assert.ok(result.kind === "command");
          assert.equal(result.command.state, "unknown");
          assert.equal(result.command.receiptRef, null);
          f.control.responseMode = "exact";
          const recovered = await f.gateway.recoverCommand({
            tenantId: "tenant-a",
            commandId: mode,
          });
          assert.equal(recovered.command.state, "committed");
          assert.equal(recovered.command.projectionState, "projected");
        }
        f.control.responseMode = "bad-output";
        const result = await f.gateway.invoke(
          { credential: "alice" },
          f.request("bad-output"),
        );
        assert.ok(result.kind === "command");
        assert.equal(result.command.state, "committed");
        assert.equal(result.command.projectionState, "projected");
        assert.equal(result.contractIssue, "invalid-output");
        assert.equal(Object.hasOwn(result, "result"), false);
        const before = clone(result.command);
        f.control.responseMode = "exact";
        await assert.rejects(
          f.gateway.recoverCommand({
            tenantId: "tenant-a",
            commandId: "bad-output",
          }),
          (error: unknown) =>
            error instanceof CognitiveAppGatewayError &&
            error.reason === "conflict",
        );
        assert.deepEqual(
          await f.store.inspectCognitiveAppCommand(
            { credential: "alice" },
            { projectId: "project-a", commandId: "bad-output" },
          ),
          before,
        );
        assert.equal(
          f.control.paths.filter((path) => path === "/invoke").length,
          3,
        );
        assert.equal(f.authorRows("SELECT * FROM author_commands").length, 3);
        await assertNoBusinessBodyInPlatform(f);
      }),
  );
  test(
    `real packed author + ${backend}: actual author authorization failure is never a fake rejected receipt`,
    { timeout: 120000 },
    async () =>
      actualFixture(backend, async (f) => {
        f.control.credential =
          "wrong_isolated_author_credential_abcdefghijklmnopqrstuvwxyz";
        const result = await f.gateway.invoke(
          { credential: "alice" },
          f.request("auth-failure"),
        );
        assert.ok(result.kind === "command");
        assert.equal(result.command.state, "unknown");
        assert.equal(result.command.receiptRef, null);
        assert.equal(f.authorRows("SELECT * FROM author_commands").length, 0);
        f.control.credential = integrationCredential;
        const recovered = await f.gateway.recoverCommand({
          tenantId: "tenant-a",
          commandId: "auth-failure",
        });
        assert.equal(recovered.command.state, "unknown");
        await f.gateway.invoke(
          { credential: "alice" },
          f.request("auth-failure"),
        );
        assert.equal(
          f.control.paths.filter((path) => path === "/invoke").length,
          1,
        );
        assert.equal(f.authorRows("SELECT * FROM notes").length, 0);
      }),
  );
  test(
    `real packed author + ${backend}: different valid bound recovery terminal or evidence cannot overwrite actual committed or rejected ledger`,
    { timeout: 120000 },
    async () =>
      actualFixture(backend, async (f) => {
        for (const original of ["committed", "rejected"] as const) {
          const commandId = `original-${original}`;
          const request = f.request(commandId);
          if (original === "rejected")
            request.parameters = {
              title: " ",
              markdown: "PRIVATE-BUSINESS-BODY-author-refuses-title",
            };
          const result = await f.gateway.invoke(
            { credential: "alice" },
            request,
          );
          assert.ok(result.kind === "command");
          assert.equal(result.command.state, original);
          const before = clone(result.command);
          for (const change of [
            "terminal",
            "receipt-id",
            "evidence",
          ] as const) {
            f.control.recoveryMode = change;
            await assert.rejects(
              f.gateway.recoverCommand({ tenantId: "tenant-a", commandId }),
              (error: unknown) => {
                assert.ok(error instanceof CognitiveAppGatewayError);
                assert.equal(error.reason, "conflict");
                assert.equal(error.commandId, commandId);
                assert.equal(Object.hasOwn(error, "observedCommitted"), false);
                return true;
              },
            );
            assert.deepEqual(
              await f.store.inspectCognitiveAppCommand(
                { credential: "alice" },
                { projectId: "project-a", commandId },
              ),
              before,
            );
          }
          f.control.recoveryMode = "exact";
          assert.deepEqual(
            (
              await f.gateway.recoverCommand({
                tenantId: "tenant-a",
                commandId,
              })
            ).command,
            before,
          );
        }
        assert.equal(
          f.control.paths.filter((path) => path === "/invoke").length,
          2,
        );
        assert.equal(f.authorRows("SELECT * FROM notes").length, 1);
        assert.equal(f.authorRows("SELECT * FROM author_commands").length, 2);
        await assertNoBusinessBodyInPlatform(f);
      }),
  );
}
