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
import { createHash, randomUUID } from "node:crypto";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest, type Server } from "node:http";
import { createServer as createPortProbe } from "node:net";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import {
  createCognitiveAppService,
  CognitiveAppServiceError,
  type CognitiveAppServicePlatform,
} from "../packages/application/src/cognitive-app-service.js";
import {
  createCognitiveAppGateway,
  CognitiveAppGatewayError,
  type CognitiveAppGatewayInvokeRequest,
  type CognitiveAppGatewayInvokeResult,
} from "../packages/application/src/cognitive-app-gateway.js";
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
import { CognitiveAppTransport } from "../packages/application/src/cognitive-app-transport.js";
import { UiPackageService } from "../packages/application/src/ui-package-service.js";
import { Application } from "../packages/application/src/application.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";
import { HumanPlatformAuthority } from "../packages/application/src/human-platform-authority.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { IdentityCenter } from "../packages/application/src/identity.js";
import { createAppServer } from "../apps/service/src/http.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { ApplicationRequestError } from "../packages/core/src/application-api.js";
import {
  parseCognitiveAppCatalog,
  parseCognitiveAppCommandResult,
  parseCognitiveAppDescription,
  parseCognitiveAppReadResult,
  parseCognitiveAppInstalled,
  parseCognitiveAppGrant,
  parseCognitiveAppConnection,
} from "../packages/core/src/cognitive-app-api.js";
import { parseBrowserCommandFacts } from "../packages/cognitive-app-sdk/src/browser-wire.js";
import type { CognitiveAppCommandSnapshot } from "../packages/platform/src/cognitive-app-commands.js";
import {
  parseCognitiveAppDefinition,
  domainProtocol,
  parseWireJson,
  validateOperationValue,
} from "../packages/cognitive-app-sdk/src/protocol.js";
import {
  canonicalJsonBytes,
  parseDomainActor,
  parseDomainReceipt,
  parseObjectReadResponse,
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
const access = { credential: "unit_authenticated_credential" };
const at = "2026-10-05T00:00:00.000Z";
const actor = parseDomainActor({
  tenantId: "tenant",
  principalId: "alice",
  actantId: "alice_human",
  kind: "human",
  source: { kind: "human" },
});
const authority = {
  appId: definition.id,
  version: definition.version,
  definitionHash,
  instanceId: "instance",
  serviceId: "service",
  dataAuthorityId: "data",
};
const request = (commandId: string | null = "command") => ({
  appId: definition.id,
  version: definition.version,
  connectionId: "connection",
  projectId: "project",
  operationId: commandId === null ? "notes.list" : "notes.create",
  parameters:
    commandId === null
      ? { limit: 1 }
      : { title: "Original", markdown: "Private original" },
  resources: [],
  commandId,
});
const statusRequest = () => ({
  projectId: "project",
  appId: definition.id,
  version: definition.version,
  connectionId: "connection",
  commandId: "command",
});
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const fail = (reason: string, commandId?: string) => (error: unknown) => {
  assert.ok(error instanceof CognitiveAppServiceError);
  assert.equal(error.reason, reason);
  assert.equal(error.commandId, commandId);
  assert.equal(Reflect.has(error, "cause"), false);
  assert.doesNotMatch(error.message, /private-secret|credential|route/);
  return true;
};
function command(
  state: CognitiveAppCommandSnapshot["state"] = "committed",
): CognitiveAppCommandSnapshot {
  const committed = state === "committed",
    terminal = committed || state === "rejected";
  return {
    commandId: "command",
    requestHash: "a".repeat(64),
    authority,
    actor,
    projectId: "project",
    operationId: "notes.create",
    effect: "write",
    operationScope: "project",
    resources: [],
    connectionId: "connection",
    connectionRevision: 1,
    grantRevision: 1,
    revision: committed ? 4 : 3,
    state,
    receiptRef: terminal ? "receipt" : null,
    receiptHash: terminal ? "b".repeat(64) : null,
    committedAt: committed ? at : null,
    objects: committed ? [] : null,
    projectionState: committed ? "projected" : "none",
    createdAt: at,
    updatedAt: at,
  };
}

function publicFields(value: unknown): Record<string, unknown> {
  const parsed = parseWireJson(value);
  assert.ok(
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed),
  );
  return parsed as Record<string, unknown>;
}
function publicCsrf(value: unknown): string {
  const token = publicFields(value).csrfToken;
  assert.equal(typeof token, "string");
  assert.match(token as string, /^[a-f0-9]{64}$/);
  return token as string;
}
function publicFailure(status: number, commandId?: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ApplicationRequestError);
    assert.equal(error.status, status);
    assert.equal(error.commandId, commandId);
    assert.doesNotMatch(
      error.message,
      /PRIVATE-BUSINESS-BODY|127\.0\.0\.1|credential|bindings\.json/,
    );
    return true;
  };
}

/** ACTUAL public ingress, not UNIT fakeService: one real Facade/Gateway instance
 * is shared by both Application hosts, using durable IdentityCenter sessions,
 * live HPA assertions, the actual Platform backend and separately packed author.
 * Node fetch needs a cookie jar; this adapter only transports actual Set-Cookie
 * bytes and leaves all HTTP bodies/statuses and the client's Origin/CSRF intact.
 * Runtime identities remain the explicit resolver in actualFixture, not a Rust
 * Runtime or renderer/Agent registration acceptance claim. */
async function actualPublicFixture(
  backend: "sqlite" | "postgres",
  run: (
    f: ActualFixture,
    open: () => Promise<Awaited<ReturnType<typeof openPublicIngress>>>,
  ) => Promise<void>,
) {
  const workspace = new WorkspaceStore(":memory:", { mode: "transport" });
  const token = "e".repeat(64);
  const configuration = {
    version: 1,
    members: [
      {
        principalId: "alice",
        actantId: "alice-human",
        enabled: true,
        loginTokenHash: createHash("sha256").update(token).digest("hex"),
      },
    ],
  };
  let identity = new IdentityCenter(workspace, configuration);
  const humanAuthority = new HumanPlatformAuthority(
    workspace.identity(),
    (access) => identity.allowsShared(access),
  );
  const opened: Array<Awaited<ReturnType<typeof openPublicIngress>>> = [];
  try {
    await actualFixture(
      backend,
      async (f) => {
        const open = async () => {
          identity = new IdentityCenter(workspace, configuration);
          await identity.bindPlatform(f.store, workspace.identity());
          const entry = await openPublicIngress(
            f,
            workspace,
            identity,
            humanAuthority,
            token,
          );
          opened.push(entry);
          return entry;
        };
        try {
          await run(f, open);
        } finally {
          for (const entry of opened) await entry.close();
        }
      },
      { tenantId: workspace.identity(), humanAuthority },
    );
  } finally {
    workspace.close();
  }
}

async function openPublicIngress(
  f: ActualFixture,
  workspace: WorkspaceStore,
  identity: IdentityCenter,
  authority: HumanPlatformAuthority,
  token: string,
) {
  const service = actualService(f);
  const options = { identity, cognitiveApps: { authority, service } };
  const localApplication = new Application(workspace, options);
  const local = new LocalApplicationConnection(localApplication);
  // HTTP's allowlisted Host/Origin includes its actual ephemeral port.
  const probe = createPortProbe();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const server = createAppServer(workspace, {
    ...options,
    port,
    webRoot: "/nonexistent",
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${port}`;
  let cookie: string | undefined;
  const requests: Array<{
    path: string;
    method: string;
    origin: string | null;
    csrf: string | null;
    hasCookie: boolean;
  }> = [];
  const client = new HttpApplicationClient(origin, async (input, init) => {
    const headers = new Headers(init?.headers);
    if (cookie) headers.set("Cookie", cookie);
    requests.push({
      path: new URL(String(input)).pathname,
      method: init?.method ?? "GET",
      origin: headers.get("Origin"),
      csrf: headers.get("X-Morphz-Token"),
      hasCookie: headers.has("Cookie"),
    });
    const response = await fetch(input, { ...init, headers });
    const current = response.headers
      .getSetCookie()
      .find((value) => value.startsWith(identity.cookieName + "="));
    if (current) cookie = current.split(";")[0]!;
    return response;
  });
  let closed = false;
  return {
    service,
    identity,
    localApplication,
    local,
    server,
    client,
    origin,
    requests,
    cookie: () => cookie,
    async login() {
      assert.deepEqual(await local.call("login", { token }), {
        connected: true,
      });
      const localCsrf = publicCsrf(await local.call("platform.bootstrap"));
      assert.deepEqual(await client.call("login", { token }), {
        connected: true,
      });
      const httpCsrf = publicCsrf(await client.call("platform.bootstrap"));
      assert.notEqual(
        localCsrf,
        httpCsrf,
        "Two actual sessions have independent CSRF generations.",
      );
      assert.ok(cookie && identity.authenticate(cookie));
      assert.ok(identity.authenticate(local.authenticationCookie()));
      return { localCsrf, httpCsrf };
    },
    async close() {
      if (closed) return;
      closed = true;
      local.close();
      localApplication.speechStreams.close();
      server.closeStreams();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `ACTUAL public Local + HTTP + packed author + ${backend}: same Facade, live cookie/HPA, exact original read and stable write replay`,
    { timeout: 120000 },
    async () => {
      await actualPublicFixture(backend, async (f, open) => {
        const p = await open(),
          { localCsrf, httpCsrf } = await p.login();
        assert.equal(
          p.localApplication.options.cognitiveApps?.service,
          p.service,
        );
        assert.equal(p.localApplication.options.identity, p.identity);
        const catalog = parseCognitiveAppCatalog(
          await p.client.call(
            "cognitive-apps.list",
            { limit: 10 },
            { identityGeneration: httpCsrf },
          ),
        );
        assert.equal(catalog.versions.length, 1);
        const description = parseCognitiveAppDescription(
          await p.local.call(
            "cognitive-apps.describe",
            {
              projectId: "project-a",
              appId: definition.id,
              version: definition.version,
            },
            { identityGeneration: localCsrf },
          ),
        );
        assert.equal(description.definitionHash, definitionHash);
        assert.equal(description.definition.ui, null);
        const input = f.request("public_actual_create");
        const created = parseCognitiveAppCommandResult(
          await p.local.call("cognitive-apps.invoke", input, {
            identityGeneration: localCsrf,
          }),
        );
        assert.equal(created.command.state, "committed");
        assert.equal(created.command.projectionState, "projected");
        assert.equal(created.contentIds?.length, 1);
        const original = originalFromResult(created.result);
        const durable = await f.store.inspectCognitiveAppCommand(
          { credential: "alice" },
          { projectId: "project-a", commandId: input.commandId! },
        );
        assert.equal(
          durable.actor.tenantId,
          p.localApplication.store.identity(),
        );
        assert.equal(durable.actor.principalId, "alice");
        assert.equal(durable.actor.actantId, "alice-human");
        assert.deepEqual(durable.actor.source, { kind: "human" });
        const objectRead = parseObjectReadResponse(
          await p.client.call(
            "cognitive-apps.read-object",
            {
              appId: definition.id,
              version: definition.version,
              connectionId: f.connectionId,
              projectId: "project-a",
              object: {
                objectId: original.objectId,
                versionRef: original.versionRef,
              },
              maxBytes: 262144,
            },
            { identityGeneration: httpCsrf },
          ),
        );
        assert.deepEqual(objectRead.object, {
          objectId: original.objectId,
          versionRef: original.versionRef,
        });
        assert.deepEqual(objectRead.authority, durable.authority);
        assert.deepEqual(objectRead.content, {
          format: "json",
          value: { title: original.title, markdown: original.markdown },
        });
        const read = parseCognitiveAppReadResult(
          await p.client.call(
            "cognitive-apps.invoke",
            {
              ...input,
              commandId: null,
              operationId: "notes.list",
              parameters: { limit: 32 },
              resources: [],
            },
            { identityGeneration: httpCsrf },
          ),
        );
        assert.equal(publicFields(read.result).objects instanceof Array, true);
        assert.equal(
          (publicFields(read.result).objects as unknown[]).length,
          1,
        );
        assert.equal(Reflect.has(read, "command"), false);
        const writes = f.control.paths.filter(
          (path) => path === "/invoke",
        ).length;
        const replay = parseCognitiveAppCommandResult(
          await p.client.call("cognitive-apps.invoke", input, {
            identityGeneration: httpCsrf,
          }),
        );
        assert.deepEqual(replay.command, created.command);
        assert.equal(
          f.control.paths.filter((path) => path === "/invoke").length,
          writes,
        );
        assert.equal(f.authorRows("SELECT * FROM notes").length, 1);
        const status = parseBrowserCommandFacts(
          await p.client.call(
            "cognitive-apps.command-status",
            actualStatus(f, input.commandId!),
            { identityGeneration: httpCsrf },
          ),
        );
        assert.deepEqual(status, replay.command);
        await assert.rejects(
          p.client.call(
            "cognitive-apps.invoke",
            { ...input, parameters: { title: "changed", markdown: "changed" } },
            { identityGeneration: httpCsrf },
          ),
          publicFailure(409, input.commandId!),
        );
        assert.equal(
          f.control.paths.filter((path) => path === "/invoke").length,
          writes,
        );
        const recovered = parseCognitiveAppCommandResult(
          await p.client.call(
            "cognitive-apps.recover",
            actualStatus(f, input.commandId!),
            { identityGeneration: httpCsrf },
          ),
        );
        assert.deepEqual(recovered.command, status);
        assert.equal(
          f.control.paths.filter((path) => path === "/invoke").length,
          writes,
        );
        for (const record of p.requests.filter((record) =>
          record.path.startsWith("/api/platform/cognitive-apps/"),
        )) {
          assert.equal(record.method, "POST");
          assert.equal(record.origin, p.origin);
          assert.equal(record.csrf, httpCsrf);
          assert.equal(record.hasCookie, true);
        }
        const installed = parseCognitiveAppInstalled(
          await p.local.call(
            "cognitive-apps.install",
            { definition: { ...definition, version: "1.0.1" } },
            { identityGeneration: localCsrf },
          ),
        );
        assert.equal(installed.version, "1.0.1");
        const grant = parseCognitiveAppGrant(
          await p.client.call(
            "cognitive-apps.grant",
            {
              appId: definition.id,
              version: "1.0.1",
              expectedRevision: 0,
              state: "active",
            },
            { identityGeneration: httpCsrf },
          ),
        );
        assert.equal(grant.state, "active");
        assert.equal(grant.revision, 1);
        const connected = parseCognitiveAppConnection(
          await p.client.call(
            "cognitive-apps.connect",
            {
              appId: definition.id,
              version: definition.version,
              expectedDefinitionHash: definitionHash,
              expectedGrantRevision: 1,
              connectionId: "public-secondary-connection",
              expectedRevision: 0,
              serviceId: durable.authority.serviceId,
              dataAuthorityId: durable.authority.dataAuthorityId,
            },
            { identityGeneration: httpCsrf },
          ),
        );
        assert.equal(connected.instanceId, durable.authority.instanceId);
        assert.equal(connected.connectionId, "public-secondary-connection");
        assert.equal(connected.revision, 1);
        const disabled = parseCognitiveAppConnection(
          await p.local.call(
            "cognitive-apps.connection-state",
            {
              appId: definition.id,
              version: definition.version,
              connectionId: connected.connectionId,
              expectedRevision: 1,
              state: "disabled",
            },
            { identityGeneration: localCsrf },
          ),
        );
        assert.equal(disabled.state, "disabled");
        assert.equal(disabled.revision, 2);
        assert.equal(
          f.control.paths.filter((path) => path === "/invoke").length,
          writes,
        );
        assert.equal(f.authorRows("SELECT * FROM notes").length, 1);
        await noBusinessSql(f);
      });
    },
  );

  test(
    `ACTUAL public Local + HTTP + packed author + ${backend}: anonymous, Origin/CSRF/cookie mismatch and private routes never reach author or ledger`,
    { timeout: 120000 },
    async () => {
      await actualPublicFixture(backend, async (f, open) => {
        const p = await open(),
          input = f.request("unauthorized_public_command");
        await assert.rejects(
          p.local.call("platform.bootstrap"),
          publicFailure(401),
        );
        await assert.rejects(
          p.local.call("cognitive-apps.invoke", input),
          publicFailure(403, input.commandId!),
        );
        await assert.rejects(
          p.client.call("cognitive-apps.invoke", input),
          publicFailure(401, input.commandId!),
        );
        const { localCsrf, httpCsrf } = await p.login();
        const before = f.control.paths.length;
        await assert.rejects(
          p.local.call("cognitive-apps.invoke", input, {
            identityGeneration: "stale",
          }),
          publicFailure(403, input.commandId!),
        );
        await assert.rejects(
          p.client.call("cognitive-apps.invoke", input, {
            identityGeneration: localCsrf,
          }),
          publicFailure(403, input.commandId!),
        );
        const post = (path: string, extra: Record<string, string> = {}) =>
          fetch(p.origin + path, {
            method: "POST",
            headers: {
              Cookie: p.cookie()!,
              Origin: p.origin,
              "Content-Type": "application/json",
              "X-Morphz-Token": httpCsrf,
              ...extra,
            },
            body: JSON.stringify(input),
          });
        assert.equal(
          (
            await post("/api/platform/cognitive-apps/invoke", {
              Origin: "https://foreign.invalid",
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await post("/api/platform/cognitive-apps/invoke", {
              "X-Morphz-Token": "stale",
            })
          ).status,
          403,
        );
        assert.equal(
          (await post("/api/platform/cognitive-apps/invoke", { Origin: "" }))
            .status,
          403,
        );
        for (const suffix of [
          "record-receipt",
          "prepare-recovery",
          "list-recoverable",
          "sql",
        ]) {
          assert.equal(
            (await post(`/api/platform/cognitive-apps/${suffix}`)).status,
            404,
          );
          const local = await p.local.invoke({
            id: randomUUID(),
            method: `cognitive-apps.${suffix}`,
            params: input,
            identityGeneration: localCsrf,
          });
          assert.equal(local.ok, false);
        }
        assert.notEqual(
          (
            await fetch(p.origin + "/api/platform/cognitive-apps/invoke", {
              headers: { Cookie: p.cookie()! },
            })
          ).status,
          200,
        );
        assert.equal(f.control.paths.length, before);
        assert.equal(
          (await f.q.all("SELECT * FROM cognitive_app_commands")).length,
          0,
        );
        assert.equal(f.authorRows("SELECT * FROM notes").length, 0);
        await p.identity.logout(
          p.identity.authenticate(p.cookie())!.sessionHash,
        );
        await assert.rejects(
          p.client.call("cognitive-apps.invoke", input, {
            identityGeneration: httpCsrf,
          }),
          publicFailure(401, input.commandId!),
        );
        assert.equal(f.control.paths.length, before);
      });
    },
  );

  test(
    `ACTUAL public Local + HTTP + packed author + ${backend}: post-COMMIT response loss, both cold stores and new login recover original command without reinvoke`,
    { timeout: 120000 },
    async () => {
      await actualPublicFixture(backend, async (f, open) => {
        let p = await open();
        const firstSession = await p.login();
        const input = f.request("public_lost_response");
        f.control.dropNextInvoke = true;
        const first = parseCognitiveAppCommandResult(
          await p.client.call("cognitive-apps.invoke", input, {
            identityGeneration: firstSession.httpCsrf,
          }),
        );
        assert.equal(first.commandId, input.commandId);
        assert.equal(first.command.state, "unknown");
        assert.equal(first.command.receiptRef, null);
        assert.equal(first.hostIssue, "unconfirmed");
        assert.equal(f.authorRows("SELECT * FROM notes").length, 1);
        const actualReceipt = f.control.droppedReceipts[0]!;
        assert.equal(actualReceipt.status, "committed");
        assert.equal(
          f.control.paths.filter((path) => path === "/invoke").length,
          1,
        );
        await p.close();
        await f.restartAuthor();
        await f.reopen();
        p = await open();
        const current = await p.login();
        assert.notEqual(current.httpCsrf, firstSession.httpCsrf);
        const recovered = parseCognitiveAppCommandResult(
          await p.local.call(
            "cognitive-apps.recover",
            actualStatus(f, input.commandId!),
            { identityGeneration: current.localCsrf },
          ),
        );
        assert.equal(recovered.command.state, "committed");
        assert.equal(recovered.command.projectionState, "projected");
        assert.equal(
          recovered.command.receiptRef,
          actualReceipt.status === "committed" ? actualReceipt.receiptId : null,
        );
        assert.equal(
          recovered.command.committedAt,
          actualReceipt.status === "committed"
            ? actualReceipt.committedAt
            : null,
        );
        const status = parseBrowserCommandFacts(
          await p.client.call(
            "cognitive-apps.command-status",
            actualStatus(f, input.commandId!),
            { identityGeneration: current.httpCsrf },
          ),
        );
        assert.deepEqual(status, recovered.command);
        const replay = parseCognitiveAppCommandResult(
          await p.client.call("cognitive-apps.invoke", input, {
            identityGeneration: current.httpCsrf,
          }),
        );
        assert.deepEqual(replay.command, status);
        assert.equal(
          f.control.paths.filter((path) => path === "/invoke").length,
          1,
        );
        assert.ok(f.control.paths.includes("/receipts/read"));
        assert.equal(f.authorRows("SELECT * FROM notes").length, 1);
        await noBusinessSql(f);
      });
    },
  );

  test(
    `ACTUAL public Local + HTTP + packed author + ${backend}: real live-session revocation after author commit suppresses reply without erasing durable fact`,
    { timeout: 120000 },
    async () => {
      await actualPublicFixture(backend, async (f, open) => {
        const p = await open();
        let current = await p.login();
        for (const transport of ["local", "http"] as const) {
          const input = f.request(`public_${transport}_revoked`);
          const cookie =
            transport === "local" ? p.local.authenticationCookie() : p.cookie();
          const session = p.identity.authenticate(cookie)!;
          assert.equal(session.access.principalId, "alice");
          let revocations = 0;
          f.control.afterResponse = async (path) => {
            if (path !== "/invoke") return;
            revocations++;
            await p.identity.logout(session.sessionHash);
            assert.equal(p.identity.authenticate(cookie), null);
          };
          const pending =
            transport === "local"
              ? p.local.call("cognitive-apps.invoke", input, {
                  identityGeneration: current.localCsrf,
                })
              : p.client.call("cognitive-apps.invoke", input, {
                  identityGeneration: current.httpCsrf,
                });
          await assert.rejects(pending, publicFailure(403, input.commandId!));
          assert.equal(revocations, 1);
          f.control.afterResponse = undefined;
          const stored = await f.store.inspectCognitiveAppCommand(
            { credential: "alice" },
            { projectId: "project-a", commandId: input.commandId! },
          );
          assert.equal(stored.state, "committed");
          assert.ok(stored.receiptRef);
          current = await p.login();
          const before = f.control.paths.filter(
            (path) => path === "/invoke",
          ).length;
          const recovered = parseCognitiveAppCommandResult(
            await p.client.call(
              "cognitive-apps.recover",
              actualStatus(f, input.commandId!),
              { identityGeneration: current.httpCsrf },
            ),
          );
          assert.equal(recovered.command.state, "committed");
          assert.equal(recovered.command.receiptRef, stored.receiptRef);
          assert.equal(
            f.control.paths.filter((path) => path === "/invoke").length,
            before,
          );
        }
        assert.equal(f.authorRows("SELECT * FROM notes").length, 2);
        assert.equal(
          f.control.paths.filter((path) => path === "/invoke").length,
          2,
        );
        await noBusinessSql(f);
      });
    },
  );
}
/** Explicit FakePort units: authorization/network/SQL below are simulated.
 * Separate actual Store + independently packed author tests follow below.
 */
function unit() {
  const events: string[] = [];
  const state = {
    command: command(),
    actor: clone(actor),
    denyInspect: false,
    denyDescribe: false,
    descriptions: 0,
    invocations: 0,
    inspections: 0,
    recoveries: 0,
    beforeReturn: undefined as (() => void | Promise<void>) | undefined,
    gatewayResult: undefined as
      | Awaited<
          ReturnType<ReturnType<typeof createCognitiveAppGateway>["invoke"]>
        >
      | undefined,
  };
  const target = {
    ...authority,
    definition,
    installationId: "installation",
    connectionId: "connection",
    connectionRevision: 1,
    grantRevision: 1,
  };
  const grant = {
    appId: definition.id,
    version: definition.version,
    state: "active" as const,
    revision: 1,
    consentedAt: at,
    updatedAt: at,
  };
  const connection = {
    appId: definition.id,
    instanceId: "instance",
    serviceId: "service",
    dataAuthorityId: "data",
    connectionId: "connection",
    state: "active" as const,
    revision: 1,
    createdAt: at,
    updatedAt: at,
  };
  const platformPorts: Partial<CognitiveAppServicePlatform> = {
    async resolveCognitiveAppDescription() {
      events.push("describe");
      state.descriptions++;
      if (state.denyDescribe)
        throw new PlatformStorageError("forbidden", "private-secret");
      return {
        actor: state.actor,
        definition,
        definitionHash,
        grantRevision: 1,
      };
    },
    async resolveCognitiveAppOperation(_access, input) {
      events.push("resolve-read");
      return {
        actor: state.actor,
        target,
        operation: definition.operations.find(
          (op) => op.id === input.operationId,
        )!,
        parameters: input.parameters as {},
        resources: [],
      };
    },
    async resolveCognitiveAppObjectRead(_access, input) {
      events.push("resolve-object");
      return {
        actor: state.actor,
        target,
        object: input.object,
        maxBytes: input.maxBytes,
      };
    },
    async inspectCognitiveAppCommand() {
      events.push("inspect");
      state.inspections++;
      if (state.denyInspect)
        throw new PlatformStorageError("forbidden", "private-secret");
      return clone(state.command);
    },
    async inspectCognitiveAppCommandDisclosure() {
      events.push("disclosure");
      state.inspections++;
      if (state.denyInspect)
        throw new PlatformStorageError("forbidden", "private-secret");
      return { command: clone(state.command), actor: clone(state.actor) };
    },
    async listCognitiveApps() {
      return {
        versions: [
          {
            appId: definition.id,
            version: definition.version,
            definitionHash,
            definition,
            installationId: "private_installation",
            installedByPrincipalId: "private_owner",
            installedAt: at,
            grant,
          },
        ],
        connections: [connection],
        nextVersionsAfter: "same_original_cursor",
        nextConnectionsAfter: null,
      };
    },
    async installCognitiveApp(_access, input) {
      return {
        appId: definition.id,
        version: definition.version,
        definitionHash,
        definition: parseCognitiveAppDefinition(input.definition),
        installationId: "private_installation",
        installedByPrincipalId: "private_owner",
        installedAt: at,
      };
    },
    async changeCognitiveAppGrant(_access, input) {
      assert.equal(Reflect.has(input, "now"), true);
      assert.ok(Date.parse(input.now!) > 0);
      return { ...grant, state: input.state };
    },
  };
  const gateway: ReturnType<typeof createCognitiveAppGateway> = {
    async invoke(_access, input): Promise<CognitiveAppGatewayInvokeResult> {
      events.push("invoke");
      state.invocations++;
      assert.notEqual(input.commandId as unknown, null);
      await state.beforeReturn?.();
      if (state.gatewayResult) return state.gatewayResult;
      if (input.commandId)
        return {
          kind: "command",
          commandId: input.commandId,
          command: clone(state.command),
          result: {
            objectId: "o",
            versionRef: "v",
            title: "Original",
            markdown: "private",
          },
          contentIds: ["content"],
        };
      return {
        kind: "read",
        authority,
        operationId: input.operationId,
        result: { objects: [] },
        command: null,
      };
    },
    async readObject(_access, input) {
      await state.beforeReturn?.();
      return {
        protocol: domainProtocol,
        authority,
        object: input.object,
        kind: "note",
        title: "Original",
        content: { format: "text", text: "private" },
      };
    },
    async recoverCommand() {
      events.push("recover");
      state.recoveries++;
      await state.beforeReturn?.();
      const result = state.gatewayResult;
      if (result && result.kind === "command") return result;
      return {
        kind: "command",
        commandId: "command",
        command: clone(state.command),
      };
    },
    async connect() {
      return connection;
    },
    async changeConnectionState(_access, input) {
      return { ...connection, state: input.state };
    },
    async recoverPage() {
      throw new Error("Host-only must not be called");
    },
    async projectPending() {
      throw new Error("Host-only must not be called");
    },
  };
  const service = createCognitiveAppService({
    platform: platformPorts as CognitiveAppServicePlatform,
    gateway,
  });
  return { service, state, events, platformPorts, gateway };
}

test("the shared cognitive service exposes one finite facade, not a transport or authority source", () => {
  assert.equal(typeof createCognitiveAppService, "function");
  assert.deepEqual(
    Object.keys(unit().service).sort(),
    [
      "commandStatus",
      "connect",
      "connectionState",
      "describe",
      "grant",
      "install",
      "invoke",
      "list",
      "readObject",
      "recover",
    ].sort(),
  );
});

test("UNIT: safe metadata/description whitelist excludes private owner, installation, operations and alias", async () => {
  const f = unit(),
    list = await f.service.list(access, { limit: 1 });
  assert.equal(list.nextVersionsAfter, "same_original_cursor");
  assert.deepEqual(
    Object.keys(list.versions[0]!).sort(),
    [
      "appId",
      "version",
      "definitionHash",
      "title",
      "description",
      "icon",
      "harness",
      "ui",
      "grant",
    ].sort(),
  );
  assert.equal(JSON.stringify(list).includes("private_"), false);
  const description = await f.service.describe(access, {
    projectId: "project",
    appId: definition.id,
    version: definition.version,
  });
  assert.deepEqual(description, {
    definition,
    definitionHash,
    grantRevision: 1,
  });
});
test("UNIT: null command requires actual read description; nonnull historical writes never current-resolve first", async () => {
  const f = unit();
  await assert.rejects(
    f.service.invoke(access, { ...request(), commandId: null }),
    fail("invalid"),
  );
  assert.equal(f.state.invocations, 0);
  const read = await f.service.invoke(access, request(null));
  assert.equal("kind" in read, false);
  assert.equal("protocol" in read ? read.protocol : null, domainProtocol);
  f.state.denyDescribe = true;
  const result = await f.service.invoke(access, request());
  assert.ok("kind" in result && result.kind === "command");
  assert.equal(f.state.descriptions, 2);
  await assert.rejects(
    f.service.invoke(access, {
      ...request(null),
      commandId: "stable_wrong_read",
    }),
    fail("conflict", "stable_wrong_read"),
  );
});
test("UNIT: public command whitelist retains exact actual facts, output and deliveries, never owner/source/parameters", async () => {
  const f = unit(),
    result = await f.service.invoke(access, request());
  assert.ok("kind" in result && result.kind === "command");
  assert.deepEqual(result.contentIds, ["content"]);
  assert.equal(result.command.state, "committed");
  for (const field of [
    "actor",
    "source",
    "authority",
    "resources",
    "requestHash",
    "connectionId",
    "parameters",
  ])
    assert.equal(Reflect.has(result.command, field), false);
  assert.equal(JSON.stringify(result).includes("unit_authenticated"), false);
  await assert.rejects(
    f.service.commandStatus(access, {
      ...statusRequest(),
      connectionId: "other",
    }),
    fail("conflict", "command"),
  );
});
test("UNIT: real post-network inspection denies new publication after authorization loss without erasing durable commit", async () => {
  const f = unit();
  f.state.beforeReturn = () => {
    f.state.denyInspect = true;
  };
  await assert.rejects(
    f.service.invoke(access, request()),
    fail("forbidden", "command"),
  );
  assert.equal(f.state.command.state, "committed");
  assert.equal(f.state.invocations, 1);
  await assert.rejects(
    f.service.recover(access, statusRequest()),
    fail("forbidden", "command"),
  );
  assert.equal(f.state.recoveries, 0);
});
test("UNIT: post-network current actor/source changes fail before exposing read/object content", async () => {
  const f = unit();
  f.state.beforeReturn = () => {
    f.state.actor = { ...actor, principalId: "other" };
  };
  await assert.rejects(
    f.service.invoke(access, request(null)),
    fail("conflict"),
  );
  f.state.actor = clone(actor);
  await assert.rejects(
    f.service.readObject(access, {
      ...statusRequest(),
      commandId: undefined,
      object: { objectId: "o", versionRef: "v" },
      maxBytes: 100,
    }),
    fail("invalid"),
  );
  const { commandId: _ignored, ...target } = statusRequest();
  await assert.rejects(
    f.service.readObject(access, {
      ...target,
      object: { objectId: "o", versionRef: "v" },
      maxBytes: 100,
    }),
    fail("conflict"),
  );
});
test("UNIT: observed committed persistence-pending is retained independently of actual unresolved ledger", async () => {
  const f = unit();
  f.state.command = command("unknown");
  f.state.gatewayResult = {
    kind: "command",
    commandId: "command",
    command: clone(f.state.command),
    observedCommitted: {
      receiptId: "receipt",
      receiptHash: "b".repeat(64),
      committedAt: at,
      objects: [],
    },
    hostIssue: "receipt-storage",
    persistence: "pending",
    result: { actual: "author" },
  };
  const result = await f.service.recover(access, statusRequest());
  assert.equal(result.command.state, "unknown");
  assert.equal(result.persistence, "pending");
  assert.equal(result.observedCommitted?.receiptId, "receipt");
});
test("UNIT: observed fact merges only into the exact concurrent durable receipt; projection upgrade invents no content IDs", async () => {
  const f = unit();
  const unresolved = command("unknown"),
    durable = command();
  f.state.command = unresolved;
  f.state.gatewayResult = {
    kind: "command",
    commandId: "command",
    command: clone(unresolved),
    observedCommitted: {
      receiptId: "receipt",
      receiptHash: "b".repeat(64),
      committedAt: at,
      objects: [],
    },
    hostIssue: "receipt-storage",
    persistence: "pending",
    contractIssue: "invalid-output",
  };
  f.state.beforeReturn = () => {
    f.state.command = durable;
  };
  const result = await f.service.recover(access, statusRequest());
  assert.equal(result.command.state, "committed");
  assert.equal(result.observedCommitted, undefined);
  assert.equal(result.persistence, undefined);
  assert.equal(result.hostIssue, undefined);
  assert.equal(result.contentIds, undefined);
  assert.equal(result.contractIssue, "invalid-output");
  f.state.command = unresolved;
  f.state.beforeReturn = () => {
    f.state.command = { ...durable, receiptHash: "c".repeat(64) };
  };
  await assert.rejects(
    f.service.recover(access, statusRequest()),
    fail("conflict", "command"),
  );
  assert.equal(f.state.command.receiptHash, "c".repeat(64));
});
test("UNIT: recover uses original actual tenant and checks admission/source again after network", async () => {
  const f = unit();
  f.state.beforeReturn = () => {
    f.state.command = {
      ...f.state.command,
      authority: { ...authority, dataAuthorityId: "changed" },
    };
  };
  await assert.rejects(
    f.service.recover(access, statusRequest()),
    fail("conflict", "command"),
  );
  await assert.rejects(
    f.service.recover(access, { ...statusRequest(), tenantId: "injected" }),
    fail("invalid"),
  );
});
test("UNIT: bounded independent snapshots precede every await and never run caller getters", async () => {
  const f = unit();
  let calls = 0;
  const hostile = Object.defineProperty({ ...request() }, "parameters", {
    enumerable: true,
    get() {
      calls++;
      return {};
    },
  });
  await assert.rejects(f.service.invoke(access, hostile), fail("invalid"));
  assert.equal(calls, 0);
  assert.equal(f.state.invocations, 0);
  const input = request();
  let received: unknown;
  f.gateway.invoke = async (_actor, req) => {
    received = clone(req);
    return {
      kind: "command",
      commandId: "command",
      command: clone(f.state.command),
    };
  };
  const result = f.service.invoke(access, input);
  (input.parameters as { title: string }).title = "mutated";
  await result;
  assert.equal(
    (received as { parameters: { title: string } }).parameters.title,
    "Original",
  );
});
test("UNIT: headless install/grant preserve Human-only Store checks; optional UI service absence never silently installs GUI", async () => {
  const f = unit();
  const installed = await f.service.install(access, { definition });
  assert.deepEqual(installed, {
    appId: definition.id,
    version: definition.version,
    definitionHash,
  });
  assert.equal(
    (
      await f.service.grant(access, {
        appId: definition.id,
        version: definition.version,
        state: "active",
        expectedRevision: 0,
      })
    ).state,
    "active",
  );
  const uiDefinition = {
    ...definition,
    ui: { packageVersion: definition.version, sha256: "a".repeat(64) },
  };
  const manifest = {
    format: "morphz-app/v1",
    id: definition.id,
    version: definition.version,
    title: definition.title,
    description: definition.description,
    icon: definition.icon,
    harness: null,
    permissions: [],
    ui: { type: "sandbox", html: "<p>UI</p>" },
  };
  await assert.rejects(
    f.service.install(access, {
      definition: uiDefinition,
      manifest,
      commandId: "ui_command",
    }),
    fail("unavailable", "ui_command"),
  );
});
test("UNIT: unknown and Gateway failures expose only fixed safe classification and original command identity", async () => {
  const f = unit();
  f.gateway.invoke = async () => {
    throw new Error("private-secret with route and credential");
  };
  await assert.rejects(
    f.service.invoke(access, request()),
    fail("unavailable", "command"),
  );
  f.gateway.invoke = async () => {
    throw new CognitiveAppGatewayError("busy", "command");
  };
  await assert.rejects(
    f.service.invoke(access, request()),
    fail("busy", "command"),
  );
  f.platformPorts.inspectCognitiveAppCommandDisclosure = async () => {
    throw new PlatformStorageError("conflict", "private-secret");
  };
  await assert.rejects(
    f.service.commandStatus(access, statusRequest()),
    fail("conflict", "command"),
  );
});

test("UNIT: actual caller before/after write and recovery is distinct from old Agent admission, with drift rejected", async () => {
  const f = unit();
  f.state.command.actor = parseDomainActor({
    tenantId: "tenant",
    principalId: "alice",
    actantId: "agent",
    kind: "agent",
    source: { kind: "input", inputId: "input", humanActantId: "alice_human" },
  });
  assert.equal(
    (await f.service.commandStatus(access, statusRequest())).state,
    "committed",
    "Human may read own old Agent facts.",
  );
  assert.equal(
    (await f.service.recover(access, statusRequest())).command.state,
    "committed",
  );
  const before = clone(f.state.command);
  f.state.beforeReturn = () => {
    f.state.actor = { ...f.state.actor, actantId: "different_human" };
  };
  await assert.rejects(
    f.service.invoke(access, request()),
    fail("conflict", "command"),
  );
  assert.deepEqual(f.state.command, before);
  f.state.actor = clone(actor);
  await assert.rejects(
    f.service.recover(access, statusRequest()),
    fail("conflict", "command"),
  );
  assert.deepEqual(f.state.command, before);
});

test("UNIT: concurrent actual terminal snapshot clears stale unconfirmed without inventing output, deliveries or ledger mutation", async () => {
  for (const terminal of ["committed", "rejected", "cancelled"] as const) {
    const f = unit(),
      unresolved = command("unknown"),
      durable = command(terminal);
    f.state.command = unresolved;
    f.state.gatewayResult = {
      kind: "command",
      commandId: "command",
      command: clone(unresolved),
      hostIssue: "unconfirmed",
    };
    f.state.beforeReturn = () => {
      f.state.command = clone(durable);
    };
    const result = await f.service.recover(access, statusRequest());
    assert.equal(result.command.state, terminal);
    assert.equal(result.hostIssue, undefined);
    assert.equal(result.result, undefined);
    assert.equal(result.contentIds, undefined);
    assert.equal(result.observedCommitted, undefined);
    assert.deepEqual(f.state.command, durable);
  }
});
test("UNIT: exact observed commit becomes actual durable pending projection, retaining invalid-output issue but not inventing projected facts", async () => {
  const f = unit(),
    unresolved = command("unknown"),
    durable = { ...command(), projectionState: "pending" as const };
  f.state.command = unresolved;
  f.state.gatewayResult = {
    kind: "command",
    commandId: "command",
    command: clone(unresolved),
    observedCommitted: {
      receiptId: "receipt",
      receiptHash: "b".repeat(64),
      committedAt: at,
      objects: [],
    },
    hostIssue: "receipt-storage",
    persistence: "pending",
    contractIssue: "invalid-output",
  };
  f.state.beforeReturn = () => {
    f.state.command = clone(durable);
  };
  const result = await f.service.recover(access, statusRequest());
  assert.equal(result.command.state, "committed");
  assert.equal(result.command.projectionState, "pending");
  assert.equal(result.contractIssue, "invalid-output");
  assert.equal(result.observedCommitted, undefined);
  assert.equal(result.persistence, undefined);
  assert.equal(result.hostIssue, undefined);
  assert.equal(result.result, undefined);
  assert.equal(result.contentIds, undefined);
});

// Actual integration fixture is copied from the committed e0ff6355 Gateway
// fixture (not its test module), with the same safe child env/real packed SDK,
// independent author DB and actual Store. It does not verify real Runtime
// credentials, shared Application registration, GUI or original App acceptance.
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
    assert.equal(filename, "morphz-cognitive-app-sdk-0.1.0.tgz");
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
    afterResponse?: (path: string, body: unknown) => Promise<void>;
  };
  identities: Map<
    string,
    NonNullable<Awaited<ReturnType<PlatformAuthorityVerifier["resolveActor"]>>>
  >;
  request(commandId: string): CognitiveAppGatewayInvokeRequest;
  reopen(): Promise<void>;
  restartAuthor(): Promise<void>;
  authorRows(sql: string): Record<string, unknown>[];
  openUi(): Promise<UiPackageService>;
};
async function actualFixture(
  backend: "sqlite" | "postgres",
  run: (f: ActualFixture) => Promise<void>,
  options: { tenantId?: string; humanAuthority?: HumanPlatformAuthority } = {},
) {
  const tenantId = options.tenantId ?? "tenant-a";
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
          tenantId,
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
        tenantId,
        principalId: "alice",
        actantId: "alice-human",
        kind: "human",
        runtimeInputId: null,
      },
    ],
    [
      "bob",
      {
        tenantId,
        principalId: "bob",
        actantId: "bob-human",
        kind: "human",
        runtimeInputId: null,
      },
    ],
    [
      "agent",
      {
        tenantId,
        principalId: "alice",
        actantId: "agent-one",
        kind: "agent",
        runtimeInputId: "input-one",
        initiatingHumanActantId: "alice-human",
        scopeProjectId: "project-a",
      },
    ],
  ]);
  const remainingCapabilities: PlatformAuthorityVerifier = {
    async resolveActor(access) {
      return identities.get(access.credential) ?? null;
    },
    async resolveActant({ tenantId: actualTenantId, actantId }) {
      return actualTenantId !== tenantId
        ? null
        : actantId === "alice-human" || actantId === "alice-second-human"
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
  const capabilities = options.humanAuthority
    ? options.humanAuthority.verifier(remainingCapabilities)
    : remainingCapabilities;
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
            const deliver = async () => {
              await control.afterResponse?.(
                request.url!,
                JSON.parse(body.toString("utf8")),
              );
              const headers = {
                ...received.headers,
                "content-length": String(body.length),
              };
              delete headers["transfer-encoding"];
              response.writeHead(received.statusCode!, headers);
              response.end(body);
            };
            void deliver().catch(() => response.destroy());
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
            tenantId,
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
    await store.provisionTenant(tenantId, at);
    for (const projectId of ["project-a", "project-b"]) {
      await q.change(
        "INSERT INTO projects(tenant_id,project_id,kind,owner_principal_id,title,revision,created_at,updated_at) VALUES(?,?,'project','alice',?,1,?,?)",
        [tenantId, projectId, projectId, at, at],
      );
      for (const member of ["alice", "agent-service"])
        await q.change(
          "INSERT INTO project_members(tenant_id,project_id,principal_id) VALUES(?,?,?)",
          [tenantId, projectId, member],
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
      openUi() {
        return UiPackageService.open({
          root: join(directory, "ui-packages"),
          tenantId,
          platform: store!,
          verifier: capabilities,
        });
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

function actualService(f: ActualFixture, uiPackages?: UiPackageService) {
  return createCognitiveAppService({
    platform: f.store,
    gateway: f.gateway,
    uiPackages,
  });
}
const actualStatus = (f: ActualFixture, commandId: string) => ({
  appId: definition.id,
  version: definition.version,
  connectionId: f.connectionId,
  projectId: "project-a",
  commandId,
});
function originalFromResult(value: unknown) {
  return validateOperationValue(
    definition.operations.find((op) => op.id === "notes.create")!.outputSchema,
    value,
  ) as {
    objectId: string;
    versionRef: string;
    title: string;
    markdown: string;
  };
}
async function taskActor(f: ActualFixture) {
  await f.store.createTask(
    { credential: "alice" },
    {
      commandId: "create_task",
      taskId: "task",
      projectId: "project-a",
      title: "Scheduled notes",
      assigneeId: "agent-one",
      now: at,
    },
  );
  const admitted = await f.store.requestTaskRun(
    { credential: "agent" },
    {
      commandId: "run_task",
      taskId: "task",
      expectedRevision: 1,
      sessionId: "session-one",
      intent: "Create note",
      notBefore: at,
      now: at,
    },
  );
  const runtimeTaskRun = {
    sessionId: admitted.sessionId,
    scheduleId: admitted.request.id,
    eventId: admitted.eventId,
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
  return runtimeTaskRun;
}
async function noBusinessSql(f: ActualFixture) {
  const rows = await f.q.all<Record<string, unknown>>(
    "SELECT * FROM cognitive_app_commands",
  );
  const serialized = JSON.stringify(rows);
  assert.doesNotMatch(
    serialized,
    /PRIVATE-BUSINESS-BODY|markdown|credential|127\.0\.0\.1/,
  );
  assert.equal(
    rows.every((row) => !("parameters" in row) && !("result" in row)),
    true,
  );
}
for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `ACTUAL packed independent author + ${backend}: valid Human actant and Agent-to-own-Human changes during write/recovery refuse disclosure, not commit`,
    { timeout: 120000 },
    async (t) => {
      for (const phase of ["invoke", "recover"] as const)
        for (const role of ["human", "agent"] as const)
          await t.test(`${phase}/${role}`, async () =>
            actualFixture(backend, async (f) => {
              const runtimeTaskRun =
                role === "agent" ? await taskActor(f) : null;
              const credential = role === "agent" ? "task-run" : "alice",
                before = clone(f.identities.get(credential)!);
              const commandId = `drift_${phase}_${role}`,
                service = actualService(f),
                request = f.request(commandId);
              if (phase === "recover") {
                f.control.dropNextInvoke = true;
                const first = await service.invoke({ credential }, request);
                assert.ok("kind" in first);
                assert.equal(first.command.state, "unknown");
              }
              f.control.afterResponse = async (path, body) => {
                if (
                  path !== (phase === "invoke" ? "/invoke" : "/receipts/read")
                )
                  return;
                assert.equal((body as { status: string }).status, "committed");
                f.identities.set(
                  credential,
                  role === "human"
                    ? { ...before, actantId: "alice-second-human" }
                    : clone(f.identities.get("alice")!),
                );
              };
              await assert.rejects(
                phase === "invoke"
                  ? service.invoke({ credential }, request)
                  : service.recover({ credential }, actualStatus(f, commandId)),
                fail("conflict", commandId),
              );
              const [row] = await f.q.all<Record<string, unknown>>(
                "SELECT state,actor_kind,actor_actant_id,source_kind FROM cognitive_app_commands WHERE command_id=?",
                [commandId],
              );
              assert.equal(row!.state, "committed");
              assert.equal(row!.actor_kind, role);
              assert.equal(row!.actor_actant_id, before.actantId);
              assert.equal(
                row!.source_kind,
                role === "agent" ? "task-run" : "human",
              );
              assert.equal(
                f.control.paths.filter((path) => path === "/invoke").length,
                1,
              );
              assert.equal(f.authorRows("SELECT * FROM notes").length, 1);
              f.identities.set(credential, before);
              if (role === "agent") {
                const facts = await service.commandStatus(
                  { credential: "alice" },
                  actualStatus(f, commandId),
                );
                assert.equal(
                  facts.state,
                  "committed",
                  "Human can inspect own old Agent facts without masquerading as their actor.",
                );
                const snapshot = await f.store.inspectCognitiveAppCommand(
                  { credential },
                  { projectId: "project-a", commandId },
                );
                assert.deepEqual(snapshot.actor.source, {
                  kind: "task-run",
                  ...runtimeTaskRun,
                  sourceInputId: "input-one",
                  humanActantId: "alice-human",
                });
              }
              await noBusinessSql(f);
            }),
          );
    },
  );
  test(
    `ACTUAL packed independent author + ${backend}: metadata and headless schema discovery share real own consent/project policy`,
    { timeout: 120000 },
    async () =>
      actualFixture(backend, async (f) => {
        const service = actualService(f),
          catalog = await service.list({ credential: "alice" }, { limit: 1 });
        assert.equal(catalog.versions.length, 1);
        assert.equal(catalog.connections.length, 1);
        assert.equal(Reflect.has(catalog.versions[0]!, "definition"), false);
        const description = await service.describe(
          { credential: "alice" },
          {
            projectId: "project-a",
            appId: definition.id,
            version: definition.version,
          },
        );
        assert.equal(description.definition.ui, null);
        assert.equal(description.definitionHash, definitionHash);
        const agentDescription = await service.describe(
          { credential: "agent" },
          {
            projectId: "project-a",
            appId: definition.id,
            version: definition.version,
          },
        );
        assert.deepEqual(agentDescription, description);
        await assert.rejects(
          service.describe(
            { credential: "agent" },
            {
              projectId: "project-b",
              appId: definition.id,
              version: definition.version,
            },
          ),
          fail("forbidden"),
        );
        await assert.rejects(
          service.describe(
            { credential: "bob" },
            {
              projectId: "project-a",
              appId: definition.id,
              version: definition.version,
            },
          ),
          fail("forbidden"),
        );
        await assert.rejects(
          service.grant(
            { credential: "agent" },
            {
              appId: definition.id,
              version: definition.version,
              expectedRevision: 1,
              state: "disabled",
            },
          ),
          fail("forbidden"),
        );
        await service.connectionState(
          { credential: "alice" },
          {
            appId: definition.id,
            version: definition.version,
            connectionId: f.connectionId,
            expectedRevision: 1,
            state: "disabled",
          },
        );
        assert.deepEqual(
          await service.describe(
            { credential: "alice" },
            {
              projectId: "project-a",
              appId: definition.id,
              version: definition.version,
            },
          ),
          description,
          "Discovery requires no active connection or GUI.",
        );
        await service.grant(
          { credential: "alice" },
          {
            appId: definition.id,
            version: definition.version,
            expectedRevision: 1,
            state: "disabled",
          },
        );
        await assert.rejects(
          service.describe(
            { credential: "alice" },
            {
              projectId: "project-a",
              appId: definition.id,
              version: definition.version,
            },
          ),
          fail("forbidden"),
        );
      }),
  );
  test(
    `ACTUAL packed independent author + ${backend}: explicit read/null, write stable replay, exact object reads and real projection`,
    { timeout: 120000 },
    async () =>
      actualFixture(backend, async (f) => {
        const service = actualService(f),
          alice = { credential: "alice" };
        await assert.rejects(
          service.invoke(alice, {
            ...f.request("never_admitted"),
            commandId: null,
          }),
          fail("invalid"),
        );
        assert.equal(
          (await f.q.all("SELECT * FROM cognitive_app_commands")).length,
          0,
        );
        assert.equal(f.control.paths.includes("/invoke"), false);
        const created = await service.invoke(alice, f.request("actual_create"));
        assert.ok("kind" in created && created.kind === "command");
        assert.equal(created.command.state, "committed");
        assert.equal(created.command.projectionState, "projected");
        assert.equal(created.contentIds?.length, 1);
        for (const key of [
          "actor",
          "source",
          "authority",
          "requestHash",
          "resources",
          "connectionId",
        ])
          assert.equal(Reflect.has(created.command, key), false);
        const original = originalFromResult(created.result);
        const { commandId: _command, ...target } = f.request("read");
        const read = await service.invoke(alice, {
          ...target,
          operationId: "notes.list",
          parameters: { limit: 32 },
          resources: [],
          commandId: null,
        });
        assert.ok("protocol" in read);
        assert.equal(Reflect.has(read, "command"), false);
        assert.equal((read.result as { objects: unknown[] }).objects.length, 1);
        const object = await service.readObject(alice, {
          appId: definition.id,
          version: definition.version,
          connectionId: f.connectionId,
          projectId: "project-a",
          object: {
            objectId: original.objectId,
            versionRef: original.versionRef,
          },
          maxBytes: 262144,
        });
        assert.deepEqual(object.content, {
          format: "json",
          value: { title: original.title, markdown: original.markdown },
        });
        const posts = f.control.paths.filter(
          (path) => path === "/invoke",
        ).length;
        await service.grant(alice, {
          appId: definition.id,
          version: definition.version,
          expectedRevision: 1,
          state: "disabled",
        });
        const replay = await service.invoke(alice, f.request("actual_create"));
        assert.ok("kind" in replay);
        assert.equal(replay.command.state, "committed");
        assert.equal(
          f.control.paths.filter((path) => path === "/invoke").length,
          posts,
        );
        await assert.rejects(
          service.invoke(alice, {
            ...f.request("actual_create"),
            parameters: { title: "changed", markdown: "changed" },
          }),
          fail("conflict", "actual_create"),
        );
        await assert.rejects(
          service.commandStatus(alice, {
            ...actualStatus(f, "actual_create"),
            connectionId: "other",
          }),
          fail("conflict", "actual_create"),
        );
        await noBusinessSql(f);
      }),
  );
  test(
    `ACTUAL packed independent author + ${backend}: post-COMMIT loss and cold author/Platform restart recover same fact without reinvoke`,
    { timeout: 120000 },
    async () =>
      actualFixture(backend, async (f) => {
        f.control.dropNextInvoke = true;
        const first = await actualService(f).invoke(
          { credential: "alice" },
          f.request("lost_response"),
        );
        assert.ok("kind" in first);
        assert.equal(first.command.state, "unknown");
        assert.equal(first.command.receiptRef, null);
        assert.equal(f.authorRows("SELECT * FROM notes").length, 1);
        const committed = f.control.droppedReceipts[0]!;
        assert.equal(committed.status, "committed");
        await actualService(f).grant(
          { credential: "alice" },
          {
            appId: definition.id,
            version: definition.version,
            expectedRevision: 1,
            state: "disabled",
          },
        );
        await f.restartAuthor();
        await f.reopen();
        const before = f.control.paths.filter(
          (path) => path === "/invoke",
        ).length;
        const recovered = await actualService(f).recover(
          { credential: "alice" },
          actualStatus(f, "lost_response"),
        );
        assert.equal(recovered.command.state, "committed");
        assert.equal(
          committed.status === "committed"
            ? recovered.command.receiptRef
            : null,
          committed.status === "committed" ? committed.receiptId : null,
        );
        assert.equal(
          f.control.paths.filter((path) => path === "/invoke").length,
          before,
        );
        assert.equal(
          (
            await actualService(f).commandStatus(
              { credential: "alice" },
              actualStatus(f, "lost_response"),
            )
          ).state,
          "committed",
        );
        await noBusinessSql(f);
      }),
  );
  test(
    `ACTUAL packed independent author + ${backend}: source/project revoked during actual author commit blocks publication but not durable fact`,
    { timeout: 120000 },
    async () =>
      actualFixture(backend, async (f) => {
        f.control.afterResponse = async (path, body) => {
          if (path !== "/invoke") return;
          assert.equal((body as { status: string }).status, "committed");
          await f.q.change(
            "DELETE FROM project_members WHERE tenant_id='tenant-a' AND project_id='project-a' AND principal_id='alice'",
          );
        };
        await assert.rejects(
          actualService(f).invoke(
            { credential: "alice" },
            f.request("revoked_after_commit"),
          ),
          fail("forbidden", "revoked_after_commit"),
        );
        const [row] = await f.q.all<Record<string, unknown>>(
          "SELECT state,receipt_ref FROM cognitive_app_commands WHERE command_id='revoked_after_commit'",
        );
        assert.equal(row!.state, "committed");
        assert.equal(typeof row!.receipt_ref, "string");
        assert.equal(f.authorRows("SELECT * FROM notes").length, 1);
        assert.equal(
          f.control.paths.filter((path) => path === "/invoke").length,
          1,
        );
        await noBusinessSql(f);
      }),
  );
  test(
    `ACTUAL packed independent author + ${backend}: public recovery rechecks current caller/project after actual receipt HTTP, with durable original commit retained`,
    { timeout: 120000 },
    async () =>
      actualFixture(backend, async (f) => {
        f.control.dropNextInvoke = true;
        const first = await actualService(f).invoke(
          { credential: "alice" },
          f.request("recovery_revoke"),
        );
        assert.ok("kind" in first);
        assert.equal(first.command.state, "unknown");
        f.control.afterResponse = async (path, body) => {
          if (path !== "/receipts/read") return;
          assert.equal((body as { status: string }).status, "committed");
          await f.q.change(
            "DELETE FROM project_members WHERE tenant_id='tenant-a' AND project_id='project-a' AND principal_id='alice'",
          );
        };
        await assert.rejects(
          actualService(f).recover(
            { credential: "alice" },
            actualStatus(f, "recovery_revoke"),
          ),
          fail("forbidden", "recovery_revoke"),
        );
        const [row] = await f.q.all<Record<string, unknown>>(
          "SELECT state,receipt_ref FROM cognitive_app_commands WHERE command_id='recovery_revoke'",
        );
        assert.equal(row!.state, "committed");
        assert.equal(typeof row!.receipt_ref, "string");
        assert.equal(f.authorRows("SELECT * FROM notes").length, 1);
        assert.equal(
          f.control.paths.filter((path) => path === "/invoke").length,
          1,
        );
        await noBusinessSql(f);
      }),
  );
  test(
    `ACTUAL packed independent author + ${backend}: caller request mutation after author commit cannot change captured target/parameters`,
    { timeout: 120000 },
    async () =>
      actualFixture(backend, async (f) => {
        const input = f.request("captured_request");
        f.control.afterResponse = async (path) => {
          if (path !== "/invoke") return;
          input.connectionId = "other";
          input.projectId = "project-b";
          (input.parameters as { title: string }).title = "mutated";
          input.commandId = "different";
        };
        const result = await actualService(f).invoke(
          { credential: "alice" },
          input,
        );
        assert.ok("kind" in result);
        assert.equal(result.commandId, "captured_request");
        assert.equal(result.command.state, "committed");
        assert.equal(
          originalFromResult(result.result).title,
          "Actual original",
        );
        const stored = await f.store.inspectCognitiveAppCommand(
          { credential: "alice" },
          { projectId: "project-a", commandId: "captured_request" },
        );
        assert.equal(stored.connectionId, f.connectionId);
        assert.equal(stored.projectId, "project-a");
        assert.equal(f.authorRows("SELECT * FROM notes").length, 1);
        await noBusinessSql(f);
      }),
  );
  test(
    `ACTUAL packed independent author + ${backend}: verified commit with invalid business output persists fact, terminal recovery conflict cannot erase it`,
    { timeout: 120000 },
    async () =>
      actualFixture(backend, async (f) => {
        f.control.responseMode = "bad-output";
        const first = await actualService(f).invoke(
          { credential: "alice" },
          f.request("bad_output"),
        );
        assert.ok("kind" in first);
        assert.equal(first.command.state, "committed");
        assert.equal(first.contractIssue, "invalid-output");
        const before = await f.store.inspectCognitiveAppCommand(
          { credential: "alice" },
          { projectId: "project-a", commandId: "bad_output" },
        );
        f.control.recoveryMode = "terminal";
        await assert.rejects(
          actualService(f).recover(
            { credential: "alice" },
            actualStatus(f, "bad_output"),
          ),
          fail("conflict", "bad_output"),
        );
        assert.deepEqual(
          await f.store.inspectCognitiveAppCommand(
            { credential: "alice" },
            { projectId: "project-a", commandId: "bad_output" },
          ),
          before,
        );
        assert.equal(f.authorRows("SELECT * FROM notes").length, 1);
        await noBusinessSql(f);
      }),
  );
  test(
    `ACTUAL packed independent author + ${backend}: malformed/binding/auth failures remain unknown, never fake rejected or expose private transport`,
    { timeout: 120000 },
    async () =>
      actualFixture(backend, async (f) => {
        const service = actualService(f);
        for (const mode of ["malformed", "bad-binding"] as const) {
          f.control.responseMode = mode;
          const commandId = `wire_${mode.replaceAll("-", "_")}`;
          const result = await service.invoke(
            { credential: "alice" },
            f.request(commandId),
          );
          assert.ok("kind" in result);
          assert.equal(result.command.state, "unknown");
          assert.equal(result.command.receiptRef, null);
          assert.equal(result.result, undefined);
          f.control.responseMode = "exact";
          const recovered = await service.recover(
            { credential: "alice" },
            actualStatus(f, commandId),
          );
          assert.equal(recovered.command.state, "committed");
        }
        f.control.credential =
          "wrong_author_credential_abcdefghijklmnopqrstuvwxyz";
        const result = await service.invoke(
          { credential: "alice" },
          f.request("auth_failure"),
        );
        assert.ok("kind" in result);
        assert.equal(result.command.state, "unknown");
        assert.equal(result.command.receiptRef, null);
        assert.equal(result.result, undefined);
        assert.doesNotMatch(
          JSON.stringify(result),
          /wrong_author_credential|127\.0\.0\.1|hostBindingId|privateConfig/,
        );
        assert.equal(f.authorRows("SELECT * FROM notes").length, 2);
        await noBusinessSql(f);
      }),
  );
  test(
    `ACTUAL packed independent author + ${backend}: real persisted task-run source is not reclassified as Human/input and safe status remains bounded`,
    { timeout: 120000 },
    async () =>
      actualFixture(backend, async (f) => {
        await f.store.createTask(
          { credential: "alice" },
          {
            commandId: "create_task",
            taskId: "task",
            projectId: "project-a",
            title: "Scheduled notes",
            assigneeId: "agent-one",
            now: at,
          },
        );
        const admitted = await f.store.requestTaskRun(
          { credential: "agent" },
          {
            commandId: "run_task",
            taskId: "task",
            expectedRevision: 1,
            sessionId: "session-one",
            intent: "Create note",
            notBefore: at,
            now: at,
          },
        );
        const runtimeTaskRun = {
          sessionId: admitted.sessionId,
          scheduleId: admitted.request.id,
          eventId: admitted.eventId,
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
        const service = actualService(f);
        const description = await service.describe(
          { credential: "task-run" },
          {
            projectId: "project-a",
            appId: definition.id,
            version: definition.version,
          },
        );
        assert.equal(description.definitionHash, definitionHash);
        const result = await service.invoke(
          { credential: "task-run" },
          f.request("task_command"),
        );
        assert.ok("kind" in result);
        assert.equal(result.command.state, "committed");
        const persisted = await f.store.inspectCognitiveAppCommand(
          { credential: "task-run" },
          { projectId: "project-a", commandId: "task_command" },
        );
        assert.deepEqual(persisted.actor.source, {
          kind: "task-run",
          ...runtimeTaskRun,
          sourceInputId: "input-one",
          humanActantId: "alice-human",
        });
        await assert.rejects(
          service.commandStatus(
            { credential: "agent" },
            actualStatus(f, "task_command"),
          ),
          fail("forbidden", "task_command"),
        );
        assert.equal(Reflect.has(result.command, "source"), false);
        await noBusinessSql(f);
      }),
  );
  test(
    `ACTUAL packed independent author + ${backend}: exact UI installation uses real Managed Store bytes with full million-byte escaped capacity and no implicit grant/view`,
    { timeout: 120000 },
    async () =>
      actualFixture(backend, async (f) => {
        const ui = await f.openUi();
        try {
          const html = "\u0001".repeat(1_000_000),
            version = "1.0.1";
          const uiDefinition = {
            ...definition,
            version,
            ui: {
              packageVersion: version,
              sha256: createHash("sha256").update(html).digest("hex"),
            },
          };
          const manifest = {
            format: "morphz-app/v1",
            id: definition.id,
            version,
            title: definition.title,
            description: definition.description,
            icon: definition.icon,
            harness: null,
            permissions: [],
            ui: { type: "sandbox", html },
          };
          const service = actualService(f, ui),
            input = {
              definition: uiDefinition,
              manifest,
              commandId: "actual_ui_install",
            };
          const installed = await service.install(
            { credential: "alice" },
            input,
          );
          assert.equal(installed.version, version);
          assert.deepEqual(
            await service.install({ credential: "alice" }, input),
            installed,
          );
          assert.deepEqual(
            await ui.read({ credential: "alice" }, definition.id, version),
            manifest,
          );
          const entry = await f.store.uiPackage(
            { credential: "alice" },
            definition.id,
            version,
          );
          assert.equal(entry.byteLength, 1_000_000);
          assert.equal(entry.sha256, uiDefinition.ui.sha256);
          const grants = await f.q.all(
            "SELECT * FROM cognitive_app_grants WHERE app_id=? AND version=?",
            [definition.id, version],
          );
          assert.equal(grants.length, 0);
          const views = await f.q.all(
            "SELECT * FROM cognitive_app_view_bindings",
          );
          assert.equal(views.length, 0);
          await assert.rejects(
            service.install(
              { credential: "agent" },
              { definition: { ...definition, id: "example.agent-install" } },
            ),
            fail("forbidden"),
          );
          assert.equal(f.control.paths.includes("/invoke"), false);
        } finally {
          await ui.close();
        }
      }),
  );
}
