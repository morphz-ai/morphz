import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import {
  PlatformStore,
  PlatformStorageError,
  type PlatformActor,
  type HostVerifiedCognitiveConnectionCreate,
  type PlatformAuthorityVerifier,
} from "../packages/platform/src/store.js";
import {
  parseCognitiveAppRequest,
  parseCognitiveAppConnection,
  type CognitiveAppRequestMap,
} from "../packages/core/src/cognitive-app-api.js";
import {
  ApplicationRequestError,
  type ApplicationMethod,
} from "../packages/core/src/application-api.js";
import { canonicalJsonBytes } from "../packages/cognitive-app-sdk/src/domain-wire.js";
import {
  createCognitiveAppGateway,
  CognitiveAppGatewayError,
} from "../packages/application/src/cognitive-app-gateway.js";
import { CognitiveAppBindings } from "../packages/application/src/cognitive-app-bindings.js";
import { CognitiveAppTransport } from "../packages/application/src/cognitive-app-transport.js";
import { withViewTransport } from "./fixtures/cognitive-app-view-transport-fixture.js";

// Actual isolated SQL, IdentityCenter/HPA and public Local/HTTP/Remote paths.
// Explicit setup proofs are not author-network evidence. The final two tests
// additionally use a controlled loopback HTTP author, not a production author,
// native window or Runtime. No business profile or credential is accessed.
type Fixture = Parameters<Parameters<typeof withViewTransport>[1]>[0];
type Request = CognitiveAppRequestMap["connect"];
const human: PlatformActor = { credential: "setup-bob" };
const operation = "cognitive-app-connect-create/v1";
const digest = (value: unknown) =>
  createHash("sha256").update(canonicalJsonBytes(value)).digest("hex");
function original(f: Fixture, connectionId: string): Request {
  return parseCognitiveAppRequest("connect", {
    appId: f.input.definition.id,
    version: f.input.definition.version,
    expectedDefinitionHash: f.installed.definitionHash,
    expectedGrantRevision: 1,
    connectionId,
    expectedRevision: 0,
    serviceId: "service/notes",
    dataAuthorityId: "database/notes",
  });
}
async function envelope(
  f: Fixture,
  request: Request,
): Promise<HostVerifiedCognitiveConnectionCreate> {
  const prepared = await f.platform.prepareCognitiveAppConnection(
    human,
    request,
  );
  return {
    request,
    proof: {
      purpose: "connection-setup",
      appId: request.appId,
      version: request.version,
      definitionHash: prepared.version.definitionHash,
      serviceId: request.serviceId,
      dataAuthorityId: request.dataAuthorityId,
      hostBindingId: `isolated_${request.connectionId}`,
    },
    verifiedActor: prepared.actor,
    verifiedGrantRevision: prepared.grant.revision,
  };
}
function identity(f: Fixture, request: Request) {
  return {
    key: `cognitive.connect.v1:${digest([
      operation,
      f.tenantId,
      "bob",
      request.connectionId,
    ])}`,
    hash: digest({
      operation,
      owner: { tenantId: f.tenantId, principalId: "bob", kind: "human" },
      request,
    }),
  };
}
async function access(f: Fixture) {
  const rows = await f.q.all(
    "SELECT access_revision FROM navigation_heads WHERE tenant_id=?",
    [f.tenantId],
  );
  assert.equal(rows.length, 1);
  return Number(rows[0]!.access_revision);
}
async function facts(f: Fixture, request: Request) {
  const rows = await f.q.all(
    "SELECT * FROM cognitive_app_connections WHERE tenant_id=? AND connection_id=?",
    [f.tenantId, request.connectionId],
  );
  const receipts = await f.q.all(
    "SELECT * FROM command_receipts WHERE tenant_id=? AND command_id=?",
    [f.tenantId, identity(f, request).key],
  );
  return { rows, receipts };
}
const rejected = (code: string) => (error: unknown) => {
  assert.ok(error instanceof PlatformStorageError);
  assert.equal(error.code, code);
  return true;
};
const publicRejected = (status: number) => (error: unknown) => {
  assert.ok(error instanceof ApplicationRequestError);
  assert.equal(error.status, status);
  assert.doesNotMatch(
    error.message,
    /isolated_|setup-|credential|binding|sqlite/i,
  );
  return true;
};
function adapters(f: Fixture) {
  const make = (
    name: string,
    call: (method: ApplicationMethod, request: unknown) => Promise<unknown>,
  ) => ({ name, call });
  return [
    make("Local", (method, request) =>
      f.local.call(method, request, { identityGeneration: f.localCsrf }),
    ),
    make("HTTP", (method, request) =>
      f.client.call(method, request, { identityGeneration: f.httpCsrf }),
    ),
    make("Remote", (method, request) =>
      f.remote.call(method, request, { identityGeneration: f.remoteCsrf }),
    ),
  ];
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
async function withAuthor(
  f: Fixture,
  work: (
    gateway: ReturnType<typeof createCognitiveAppGateway>,
    control: {
      calls: number;
      secretReads: number;
      beforeReply?: (index: number) => Promise<void>;
      wrongAuthority: boolean;
      denySecret: boolean;
    },
  ) => Promise<void>,
) {
  const control = {
    calls: 0,
    secretReads: 0,
    beforeReply: undefined as ((index: number) => Promise<void>) | undefined,
    wrongAuthority: false,
    denySecret: false,
  };
  const server = createServer((incoming, response) => {
    void (async () => {
      assert.equal(incoming.method, "POST");
      assert.equal(incoming.url, "/describe");
      assert.equal(
        incoming.headers.authorization,
        "Bearer isolated-author-secret",
      );
      let bytes = "";
      for await (const part of incoming) bytes += String(part);
      const request = JSON.parse(bytes);
      assert.deepEqual(request, {
        protocol: "morphz-domain/v1",
        definition: {
          appId: f.input.definition.id,
          version: f.input.definition.version,
          definitionHash: f.installed.definitionHash,
        },
      });
      const index = ++control.calls;
      await control.beforeReply?.(index);
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          ...request,
          serviceId: "service/notes",
          dataAuthorityId: control.wrongAuthority
            ? "wrong/authority"
            : "database/notes",
        }),
      );
    })().catch((error: unknown) => {
      response.destroy(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const filename = join(f.root, "isolated-creation-bindings.json");
  writeFileSync(
    filename,
    JSON.stringify({
      format: "morphz-host-cognitive-bindings/v1",
      issuer: "isolated-creation-host",
      bindings: [
        {
          tenantId: f.tenantId,
          principalId: "bob",
          appId: f.input.definition.id,
          serviceId: "service/notes",
          dataAuthorityId: "database/notes",
          baseUrl: `http://127.0.0.1:${address.port}`,
          credentialEnv: "MORPHZ_APP_COGNITIVE_CREDENTIAL_CREATION_TEST",
          current: true,
          approvedLoopback: { host: "127.0.0.1", port: address.port },
        },
      ],
    }),
    { mode: 0o600 },
  );
  const transport = new CognitiveAppTransport();
  const gateway = createCognitiveAppGateway({
    platform: f.platform,
    transport,
    bindings: new CognitiveAppBindings({
      filename,
      readSecret() {
        control.secretReads++;
        if (control.denySecret)
          throw new Error("isolated credential unavailable");
        return "isolated-author-secret";
      },
    }),
  });
  try {
    await work(gateway, control);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done, fail) =>
      server.close((error) => (error ? fail(error) : done())),
    );
  }
}

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `actual ${backend} public Local/HTTP/Remote recover committed creation without a configured author and never reactivate`,
    { timeout: 60000 },
    async () =>
      withViewTransport(backend, async (f) => {
        const request = original(f, "creation-public"),
          input = await envelope(f, request),
          before = await access(f),
          created = await f.platform.createVerifiedCognitiveAppConnection(
            human,
            input,
          );
        assert.equal(await access(f), before + 1);
        // A client that never observed the first ACK repeats the exact request.
        // No author is configured on this actual Host: accidental describe fails.
        for (const adapter of adapters(f))
          assert.deepEqual(
            parseCognitiveAppConnection(
              await adapter.call("cognitive-apps.connect", request),
            ),
            created,
            adapter.name,
          );
        for (const adapter of adapters(f)) {
          for (const extra of [
            { proof: input.proof },
            { verifiedActor: input.verifiedActor },
            { verifiedGrantRevision: input.verifiedGrantRevision },
            { commandId: identity(f, request).key },
          ])
            await assert.rejects(
              adapter.call("cognitive-apps.connect", { ...request, ...extra }),
              publicRejected(400),
            );
        }
        assert.equal(await access(f), before + 1);
        const committed = await facts(f, request);
        assert.equal(committed.rows.length, 1);
        assert.equal(committed.receipts.length, 1);
        assert.equal(
          committed.receipts[0]!.request_hash,
          identity(f, request).hash,
        );
        assert.equal(committed.receipts[0]!.actor_principal_id, "bob");
        assert.equal(committed.receipts[0]!.actor_actant_id, "bob-human");
        assert.equal(committed.receipts[0]!.result_ref, request.connectionId);
        assert.equal(committed.receipts[0]!.operation, operation);
        assert.equal(committed.receipts[0]!.runtime_input_id, null);
        const local = adapters(f)[0]!;
        const disabled = parseCognitiveAppConnection(
          await local.call("cognitive-apps.connection-state", {
            appId: request.appId,
            version: request.version,
            connectionId: request.connectionId,
            expectedRevision: 1,
            state: "disabled",
          }),
        );
        await local.call("cognitive-apps.grant", {
          appId: request.appId,
          version: request.version,
          expectedRevision: 1,
          state: "disabled",
        });
        await f.q.change(
          "UPDATE app_installations SET state='disabled' WHERE tenant_id=? AND app_id=?",
          [f.tenantId, request.appId],
        );
        await f.q.change(
          "UPDATE app_instances SET state='unavailable' WHERE tenant_id=? AND instance_id=?",
          [f.tenantId, created.instanceId],
        );
        const retiredRevision = await access(f);
        for (const adapter of adapters(f)) {
          const result = parseCognitiveAppConnection(
            await adapter.call("cognitive-apps.connect", request),
          );
          assert.deepEqual(result, disabled, adapter.name);
          assert.equal("hostBindingId" in result, false);
          assert.equal("grantRevision" in result, false);
        }
        const unavailable = await f.platform.changeCognitiveAppConnectionState(
          human,
          {
            appId: request.appId,
            version: request.version,
            connectionId: request.connectionId,
            expectedRevision: disabled.revision,
            state: "unavailable",
          },
        );
        const unavailableRevision = await access(f);
        assert.equal(unavailableRevision, retiredRevision + 1);
        for (const adapter of adapters(f))
          assert.deepEqual(
            parseCognitiveAppConnection(
              await adapter.call("cognitive-apps.connect", request),
            ),
            unavailable,
          );
        assert.equal(await access(f), unavailableRevision);
        assert.equal((await facts(f, request)).receipts.length, 1);
      }),
  );

  test(
    `actual ${backend} simultaneous creation commits one row/receipt/access revision`,
    { timeout: 60000 },
    async () =>
      withViewTransport(backend, async (f) => {
        const request = original(f, "creation-race"),
          input = await envelope(f, request),
          before = await access(f);
        const results = await Promise.all(
          Array.from({ length: 8 }, () =>
            f.platform.createVerifiedCognitiveAppConnection(human, input),
          ),
        );
        for (const result of results) assert.deepEqual(result, results[0]);
        assert.equal(await access(f), before + 1);
        // A successful replay does not consume a later setup proof or silently
        // replace its original Host binding with a newly available route.
        assert.deepEqual(
          await f.platform.createVerifiedCognitiveAppConnection(human, {
            ...input,
            proof: { ...input.proof, hostBindingId: "new_private_route" },
            verifiedGrantRevision: 999,
          }),
          results[0],
        );
        const current = await facts(f, request);
        assert.equal(current.rows.length, 1);
        assert.equal(current.receipts.length, 1);
        assert.equal(
          current.rows[0]!.host_binding_id,
          input.proof.hostBindingId,
        );
        assert.equal(await access(f), before + 1);
      }),
  );

  test(
    `actual ${backend} reauthenticated same-principal Human can replay but cannot consume an old uncommitted handshake`,
    { timeout: 60000 },
    async () =>
      withViewTransport(backend, async (f) => {
        const request = original(f, "creation-rotated"),
          input = await envelope(f, request),
          missing = original(f, "creation-rotated-new"),
          missingInput = await envelope(f, missing);
        const created = await f.platform.createVerifiedCognitiveAppConnection(
          human,
          input,
        );
        const disabled = await f.platform.changeCognitiveAppConnectionState(
          human,
          {
            appId: request.appId,
            version: request.version,
            connectionId: created.connectionId,
            expectedRevision: 1,
            state: "disabled",
          },
        );
        await f.platform.changeCognitiveAppGrant(human, {
          appId: request.appId,
          version: request.version,
          expectedRevision: 1,
          state: "disabled",
        });
        const verifier: PlatformAuthorityVerifier = {
          async resolveActor({ credential }) {
            return credential === "reauthenticated-bob"
              ? {
                  tenantId: f.tenantId,
                  principalId: "bob",
                  actantId: "bob-human-new",
                  kind: "human",
                  runtimeInputId: null,
                }
              : null;
          },
          async resolveActant({ tenantId, actantId }) {
            return tenantId === f.tenantId && actantId === "bob-human-new"
              ? { principalId: "bob", kind: "human" }
              : null;
          },
          async resolveProjectAgent() {
            return null;
          },
          async verifyApplicationObject() {
            return false;
          },
        };
        // Actual second Store against this same isolated SQL, with a genuinely
        // re-resolved trusted Human actor. This is not a renderer/HPA mock claim.
        const schema =
          backend === "postgres"
            ? String(
                (await f.q.all("SELECT current_schema() AS name"))[0]!.name,
              )
            : undefined;
        const rotated =
          backend === "postgres"
            ? await PlatformStore.postgres(
                {
                  connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
                  schema: schema!,
                },
                verifier,
              )
            : await PlatformStore.sqlite(
                join(f.root, "platform.sqlite"),
                verifier,
              );
        const reauthenticated = { credential: "reauthenticated-bob" },
          before = await access(f);
        try {
          assert.deepEqual(
            await rotated.readCognitiveAppConnectionCreation(
              reauthenticated,
              request,
            ),
            disabled,
          );
          // Simulate the final transaction's raced-receipt branch with the old
          // handshake stamp, not only the Gateway's earlier successful lookup.
          assert.deepEqual(
            await rotated.createVerifiedCognitiveAppConnection(
              reauthenticated,
              input,
            ),
            disabled,
          );
          await assert.rejects(
            rotated.createVerifiedCognitiveAppConnection(
              reauthenticated,
              missingInput,
            ),
            rejected("forbidden"),
          );
          assert.equal(await access(f), before);
          assert.equal((await facts(f, missing)).rows.length, 0);
          assert.equal((await facts(f, missing)).receipts.length, 0);
          assert.equal(
            (await facts(f, request)).receipts[0]!.actor_actant_id,
            "bob-human",
          );
        } finally {
          await rotated.close();
        }
      }),
  );

  test(
    `actual ${backend} original optional premises and every public target field stay part of creation identity`,
    { timeout: 60000 },
    async () =>
      withViewTransport(backend, async (f) => {
        const complete = original(f, "creation-absent"),
          {
            expectedGrantRevision: _grant,
            expectedDefinitionHash: _hash,
            ...request
          } = complete;
        const input = await envelope(f, request);
        const created = await f.platform.createVerifiedCognitiveAppConnection(
          human,
          input,
        );
        assert.deepEqual(
          await f.platform.readCognitiveAppConnectionCreation(human, request),
          created,
        );
        const variants: Request[] = [
          { ...request, expectedGrantRevision: 1 },
          { ...request, expectedDefinitionHash: f.installed.definitionHash },
          { ...request, appId: "example.other" },
          { ...request, version: "9.0.0" },
          { ...request, serviceId: "service/elsewhere" },
          { ...request, dataAuthorityId: "database/elsewhere" },
        ];
        const before = await access(f);
        for (const changed of variants) {
          await assert.rejects(
            f.platform.readCognitiveAppConnectionCreation(human, changed),
            rejected("conflict"),
          );
          for (const adapter of adapters(f))
            await assert.rejects(
              adapter.call("cognitive-apps.connect", changed),
              publicRejected(409),
            );
        }
        assert.equal(await access(f), before);
        assert.equal((await facts(f, request)).rows.length, 1);
      }),
  );

  test(
    `actual ${backend} wrong receipt fields, missing connection and legacy no-receipt cannot be adopted or recreated`,
    { timeout: 60000 },
    async () =>
      withViewTransport(backend, async (f) => {
        const request = original(f, "creation-integrity"),
          input = await envelope(f, request);
        await f.platform.createVerifiedCognitiveAppConnection(human, input);
        const { key, hash } = identity(f, request),
          before = await access(f);
        for (const [field, bad, good] of [
          ["operation", "other-operation", operation],
          ["actor_principal_id", "alice", "bob"],
          ["result_ref", "connection-other", request.connectionId],
          ["request_hash", "0".repeat(64), hash],
        ] as const) {
          await f.q.change(
            `UPDATE command_receipts SET ${field}=? WHERE tenant_id=? AND command_id=?`,
            [bad, f.tenantId, key],
          );
          await assert.rejects(
            f.platform.readCognitiveAppConnectionCreation(human, request),
            rejected("conflict"),
          );
          await assert.rejects(
            f.platform.createVerifiedCognitiveAppConnection(human, input),
            rejected("conflict"),
          );
          await f.q.change(
            `UPDATE command_receipts SET ${field}=? WHERE tenant_id=? AND command_id=?`,
            [good, f.tenantId, key],
          );
        }
        assert.equal(await access(f), before);
        // Explicit isolated integrity fault, not a product hard-delete operation.
        await f.q.change(
          "DELETE FROM command_receipts WHERE tenant_id=? AND command_id=?",
          [f.tenantId, key],
        );
        assert.equal(
          await f.platform.readCognitiveAppConnectionCreation(human, request),
          null,
        );
        await assert.rejects(
          f.platform.createVerifiedCognitiveAppConnection(human, input),
          rejected("conflict"),
        );
        assert.equal((await facts(f, request)).rows.length, 1);
        assert.equal((await facts(f, request)).receipts.length, 0);
        const missing = original(f, "creation-missing"),
          missingInput = await envelope(f, missing);
        await f.platform.createVerifiedCognitiveAppConnection(
          human,
          missingInput,
        );
        await f.q.change(
          "DELETE FROM cognitive_app_connections WHERE tenant_id=? AND connection_id=?",
          [f.tenantId, missing.connectionId],
        );
        const after = await access(f);
        await assert.rejects(
          f.platform.readCognitiveAppConnectionCreation(human, missing),
          rejected("not_found"),
        );
        await assert.rejects(
          f.platform.createVerifiedCognitiveAppConnection(human, missingInput),
          rejected("not_found"),
        );
        assert.equal((await facts(f, missing)).rows.length, 0);
        assert.equal(await access(f), after);
      }),
  );

  test(
    `actual ${backend} trusted handshake tuple, Human stamp and prepared grant CAS cannot be substituted`,
    { timeout: 60000 },
    async () =>
      withViewTransport(backend, async (f) => {
        const request = original(f, "creation-witness"),
          input = await envelope(f, request),
          before = await access(f);
        for (const proof of [
          { ...input.proof, appId: "example.other" },
          { ...input.proof, version: "9.0.0" },
          { ...input.proof, definitionHash: "0".repeat(64) },
          { ...input.proof, serviceId: "service/other" },
          { ...input.proof, dataAuthorityId: "database/other" },
        ])
          await assert.rejects(
            f.platform.createVerifiedCognitiveAppConnection(human, {
              ...input,
              proof,
            }),
            rejected("conflict"),
          );
        const alice = await f.platform.prepareCognitiveAppConnection(
          { credential: "setup-bob" },
          request,
        );
        await assert.rejects(
          f.platform.createVerifiedCognitiveAppConnection(human, {
            ...input,
            verifiedActor: {
              ...alice.actor,
              principalId: "alice",
              actantId: "alice-human",
            },
          }),
          rejected("forbidden"),
        );
        await assert.rejects(
          f.platform.createVerifiedCognitiveAppConnection(
            { credential: "setup-alice" },
            input,
          ),
          rejected("forbidden"),
        );
        assert.equal(
          await f.platform.readCognitiveAppConnectionCreation(
            { credential: "setup-alice" },
            request,
          ),
          null,
        );
        assert.equal(await access(f), before);
        assert.equal((await facts(f, request)).rows.length, 0);
        await f.platform.changeCognitiveAppGrant(human, {
          appId: request.appId,
          version: request.version,
          expectedRevision: 1,
          state: "active",
        });
        const afterGrant = await access(f);
        const { expectedGrantRevision: _originalPremise, ...withoutPremise } =
          request;
        await assert.rejects(
          f.platform.createVerifiedCognitiveAppConnection(human, {
            ...input,
            request: withoutPremise,
          }),
          rejected("conflict"),
        );
        assert.equal(await access(f), afterGrant);
        assert.equal((await facts(f, request)).rows.length, 0);
        assert.equal((await facts(f, request)).receipts.length, 0);
      }),
  );

  test(
    `actual ${backend} original request/proof/actor/CAS capture precedes await and rejects accessors without invoking them`,
    { timeout: 60000 },
    async () =>
      withViewTransport(backend, async (f) => {
        const request = original(f, "creation-capture"),
          input = await envelope(f, request),
          entered = deferred(),
          release = deferred();
        f.control.beforeResolve = async () => {
          entered.resolve();
          await release.promise;
        };
        const pending = f.platform.createVerifiedCognitiveAppConnection(
          human,
          input,
        );
        await entered.promise;
        input.request.serviceId = "late/service";
        input.proof.hostBindingId = "late_route";
        input.proof.dataAuthorityId = "late/data";
        input.verifiedGrantRevision = 999;
        (input.verifiedActor as { principalId: string }).principalId = "alice";
        release.resolve();
        const created = await pending;
        delete f.control.beforeResolve;
        assert.equal(created.serviceId, "service/notes");
        assert.equal(created.dataAuthorityId, "database/notes");
        assert.equal(
          (await facts(f, original(f, "creation-capture"))).rows[0]!
            .host_binding_id,
          "isolated_creation-capture",
        );
        let getterReads = 0,
          verifierReads = 0;
        f.control.beforeResolve = async () => {
          verifierReads++;
        };
        const good = await envelope(f, original(f, "creation-accessor"));
        verifierReads = 0;
        const bad = { ...good, proof: { ...good.proof } };
        Object.defineProperty(bad.proof, "hostBindingId", {
          enumerable: true,
          get() {
            getterReads++;
            return "accessor_route";
          },
        });
        await assert.rejects(
          f.platform.createVerifiedCognitiveAppConnection(human, bad),
          rejected("invalid"),
        );
        await assert.rejects(
          f.platform.createVerifiedCognitiveAppConnection(human, {
            ...good,
            extra: "not-a-host-field",
          } as HostVerifiedCognitiveConnectionCreate),
          rejected("invalid"),
        );
        assert.equal(getterReads, 0);
        assert.equal(verifierReads, 0);
        assert.equal((await facts(f, good.request)).rows.length, 0);
        delete f.control.beforeResolve;
      }),
  );

  test(
    `actual ${backend} two real describe requests racing a committed creation and revocation return current metadata`,
    { timeout: 60000 },
    async () =>
      withViewTransport(backend, (f) =>
        withAuthor(f, async (gateway, control) => {
          const request = original(f, "creation-late-describe"),
            firstEntered = deferred(),
            secondEntered = deferred(),
            firstReply = deferred(),
            secondReply = deferred();
          control.beforeReply = async (index) => {
            (index === 1 ? firstEntered : secondEntered).resolve();
            await (index === 1 ? firstReply : secondReply).promise;
          };
          const first = gateway.connect(human, request);
          await firstEntered.promise;
          const second = gateway.connect(human, request);
          await secondEntered.promise;
          const before = await access(f);
          firstReply.resolve();
          const created = await first;
          assert.equal(await access(f), before + 1);
          const disabled = await f.platform.changeCognitiveAppConnectionState(
            human,
            {
              appId: request.appId,
              version: request.version,
              connectionId: created.connectionId,
              expectedRevision: 1,
              state: "disabled",
            },
          );
          await f.platform.changeCognitiveAppGrant(human, {
            appId: request.appId,
            version: request.version,
            expectedRevision: 1,
            state: "disabled",
          });
          const retired = await access(f);
          secondReply.resolve();
          assert.deepEqual(await second, disabled);
          assert.equal(await access(f), retired);
          assert.equal(control.calls, 2);
          const reads = control.secretReads;
          control.denySecret = true;
          assert.deepEqual(await gateway.connect(human, request), disabled);
          assert.equal(control.secretReads, reads);
          assert.equal(control.calls, 2);
          assert.equal((await facts(f, request)).rows.length, 1);
          assert.equal((await facts(f, request)).receipts.length, 1);
        }),
      ),
  );

  test(
    `actual ${backend} rejected author proof and cancelled describe leave no success receipt; explicit original-ID retry succeeds`,
    { timeout: 60000 },
    async () =>
      withViewTransport(backend, (f) =>
        withAuthor(f, async (gateway, control) => {
          const request = original(f, "creation-explicit-retry"),
            before = await access(f);
          control.wrongAuthority = true;
          await assert.rejects(
            gateway.connect(human, request),
            (error: unknown) => {
              assert.ok(error instanceof CognitiveAppGatewayError);
              assert.equal(error.reason, "contract");
              return true;
            },
          );
          assert.deepEqual(await facts(f, request), { rows: [], receipts: [] });
          assert.equal(await access(f), before);
          control.wrongAuthority = false;
          const entered = deferred(),
            reply = deferred(),
            abort = new AbortController();
          control.beforeReply = async () => {
            entered.resolve();
            await reply.promise;
          };
          const pending = gateway.connect(human, request, abort.signal);
          await entered.promise;
          abort.abort();
          await assert.rejects(pending, (error: unknown) => {
            assert.ok(error instanceof CognitiveAppGatewayError);
            assert.equal(error.reason, "unavailable");
            return true;
          });
          reply.resolve();
          delete control.beforeReply;
          assert.deepEqual(await facts(f, request), { rows: [], receipts: [] });
          assert.equal(await access(f), before);
          const calls = control.calls;
          const created = await gateway.connect(human, request);
          assert.equal(created.connectionId, request.connectionId);
          assert.equal(control.calls, calls + 1);
          assert.equal(await access(f), before + 1);
          assert.equal((await facts(f, request)).receipts.length, 1);
          assert.deepEqual(await gateway.connect(human, request), created);
          assert.equal(control.calls, calls + 1);
        }),
      ),
  );

  test(
    `actual ${backend} receipt persistence failure rolls back the newly inserted connection and every navigation effect`,
    { timeout: 60000 },
    async () =>
      withViewTransport(backend, (f) =>
        withAuthor(f, async (gateway, control) => {
          const request = original(f, "creation-rollback"),
            before = await access(f);
          if (backend === "sqlite") {
            await f.q.exec(
              "CREATE TRIGGER isolated_creation_receipt_failure BEFORE INSERT ON command_receipts WHEN NEW.operation='cognitive-app-connect-create/v1' AND NEW.result_ref='creation-rollback' BEGIN SELECT RAISE(ABORT,'isolated receipt fault'); END",
            );
          } else {
            await f.q.exec(
              "CREATE FUNCTION isolated_creation_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operation='cognitive-app-connect-create/v1' AND NEW.result_ref='creation-rollback' THEN RAISE EXCEPTION 'isolated receipt fault'; END IF; RETURN NEW; END $$",
            );
            await f.q.exec(
              "CREATE TRIGGER isolated_creation_receipt_failure BEFORE INSERT ON command_receipts FOR EACH ROW EXECUTE FUNCTION isolated_creation_receipt_failure()",
            );
          }
          await assert.rejects(
            gateway.connect(human, request),
            (error: unknown) => {
              assert.ok(error instanceof CognitiveAppGatewayError);
              assert.equal(error.reason, "unavailable");
              assert.doesNotMatch(
                error.message,
                /isolated|receipt fault|postgres|sqlite/,
              );
              return true;
            },
          );
          assert.deepEqual(await facts(f, request), { rows: [], receipts: [] });
          assert.equal(await access(f), before);
          if (backend === "sqlite")
            await f.q.exec("DROP TRIGGER isolated_creation_receipt_failure");
          else {
            await f.q.exec(
              "DROP TRIGGER isolated_creation_receipt_failure ON command_receipts",
            );
            await f.q.exec("DROP FUNCTION isolated_creation_receipt_failure()");
          }
          const created = await gateway.connect(human, request);
          assert.equal(created.connectionId, request.connectionId);
          assert.equal(control.calls, 2);
          assert.equal((await facts(f, request)).rows.length, 1);
          assert.equal((await facts(f, request)).receipts.length, 1);
          assert.equal(await access(f), before + 1);
        }),
      ),
  );
}
