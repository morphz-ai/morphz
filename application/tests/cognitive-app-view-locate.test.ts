import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationRequestError } from "../packages/core/src/application-api.js";
import {
  parseCognitiveAppViewRequest,
  parseCognitiveAppViewResponse,
  type CognitiveAppViewLocation,
} from "../packages/core/src/cognitive-app-view-api.js";
import { withViewTransport } from "./fixtures/cognitive-app-view-transport-fixture.js";
import { prepareConnectionCreation } from "./fixtures/cognitive-connection-creation.js";
import {
  isolatedView,
  agent,
} from "./fixtures/cognitive-app-view-service-fixture.js";
import { CognitiveAppServiceError } from "../packages/application/src/cognitive-app-service.js";

// Actual IdentityCenter/HPA and both SQL engines. The fixture's explicit
// connection admission is setup evidence, not author-network or GUI proof.
type Fixture = Parameters<Parameters<typeof withViewTransport>[1]>[0];
const requestFor = (f: Fixture) => ({
  projectId: "project-a",
  appId: f.input.definition.id,
  version: f.input.definition.version,
  expectedDefinitionHash: f.installed.definitionHash,
});
const slotFor = (f: Fixture) => ({
  projectId: "project-a",
  appId: f.input.definition.id,
  version: f.input.definition.version,
  definitionHash: f.installed.definitionHash,
});
const cas = (receipt: {
  viewId: string;
  viewRevision: number;
  bindingRevision: number;
}) => ({
  viewId: receipt.viewId,
  expectedViewRevision: receipt.viewRevision,
  expectedBindingRevision: receipt.bindingRevision,
});
function adapters(f: Fixture) {
  return [
    { name: "Local", client: f.local, generation: f.localCsrf },
    { name: "HTTP", client: f.client, generation: f.httpCsrf },
    { name: "Remote", client: f.remote, generation: f.remoteCsrf },
  ] as const;
}
const failure = (statuses: number[]) => (error: unknown) => {
  assert.ok(error instanceof ApplicationRequestError);
  assert.ok(
    statuses.includes(error.status),
    `Unexpected status ${error.status}.`,
  );
  assert.equal(error.commandId, undefined);
  assert.doesNotMatch(
    error.message,
    /private_|credential|sqlite|postgres|127\.0\.0\.1|setup-/,
  );
  return true;
};
async function rows(f: Fixture) {
  const output: Record<string, unknown> = {};
  for (const table of [
    "navigation_heads",
    "app_installations",
    "app_ui_packages",
    "app_instances",
    "cognitive_app_registrations",
    "cognitive_app_versions",
    "cognitive_app_grants",
    "cognitive_app_connections",
    "cognitive_app_authorities",
    "app_view_instances",
    "cognitive_app_view_bindings",
    "cognitive_app_commands",
    "command_receipts",
    "outbox",
    "content_entries",
    "projects",
    "project_members",
    "team_login_sessions",
  ])
    output[table] = await f.q.all(`SELECT * FROM ${table}`);
  return output;
}
function guardIo(f: Fixture) {
  const calls: string[] = [],
    restore: (() => void)[] = [];
  const patch = (owner: object, key: string, replacement: unknown) => {
    const previous = Reflect.get(owner, key);
    Reflect.set(owner, key, replacement);
    restore.push(() => {
      Reflect.set(owner, key, previous);
    });
  };
  for (const [owner, keys] of [
    [f.host.service, ["describe", "invoke", "readObject", "recover"]],
    [f.ui, ["readCognitive", "readCognitiveDocument"]],
    [Reflect.get(f.ui, "store") as object, ["readRange"]],
  ] as const)
    for (const key of keys)
      patch(owner, key, () => {
        calls.push(key);
        throw new Error("Locate must not read UI bytes or author business.");
      });
  // Observe the actual native query path, not the snapshot client. Locate
  // must not select navigation, declaration or UI body columns.
  const backend = Reflect.get(f.platform, "backend");
  const checked = (value: unknown) => {
    const sql = typeof value === "string" ? value : "";
    if (
      /^\s*SELECT\b/i.test(sql) &&
      /\b(state_json|definition_json|manifest_header)\b/i.test(sql)
    ) {
      calls.push("body-column");
      throw new Error("Locate queried a body column.");
    }
  };
  if (backend.kind === "sqlite") {
    const database = backend.database,
      original = database.prepare;
    patch(database, "prepare", function (this: object, sql: unknown) {
      checked(sql);
      return Reflect.apply(original, this, [sql]);
    });
  } else {
    const pool = backend.pool,
      original = pool.connect,
      patched = new WeakSet<object>();
    patch(pool, "connect", async function (this: object, ...args: unknown[]) {
      const result = await Reflect.apply(original, this, args);
      assert.ok(result && typeof result === "object");
      const client: object = result;
      if (!patched.has(client)) {
        patched.add(client);
        const query = Reflect.get(client, "query");
        patch(client, "query", function (this: object, ...input: unknown[]) {
          checked(input[0]);
          return Reflect.apply(query, this, input);
        });
      }
      return client;
    });
  }
  return {
    calls,
    close() {
      for (const undo of restore.reverse()) undo();
    },
  };
}
async function locateAll(f: Fixture, expected: CognitiveAppViewLocation) {
  const before = await rows(f),
    guard = guardIo(f);
  try {
    for (const { client, generation } of adapters(f))
      assert.deepEqual(
        await client.call("cognitive-app-views.locate", requestFor(f), {
          identityGeneration: generation,
        }),
        expected,
      );
    assert.deepEqual(guard.calls, []);
    assert.equal(Reflect.get(f.human, "issued").size, 0);
    assert.equal(Reflect.get(f.ui, "scopes").size, 0);
  } finally {
    guard.close();
  }
  assert.deepEqual(await rows(f), before);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>) {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Actual barrier was not reached.")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("UNIT locate strict carrier requires exact hash and rejects identity, connection, body and lifecycle controls", () => {
  const request = {
    projectId: "project-a",
    appId: "example.notes",
    version: "1.0.0",
    expectedDefinitionHash: "a".repeat(64),
  };
  assert.deepEqual(parseCognitiveAppViewRequest("locate", request), request);
  for (const key of Object.keys(request)) {
    const invalid: Record<string, unknown> = { ...request };
    delete invalid[key];
    assert.throws(() => parseCognitiveAppViewRequest("locate", invalid));
  }
  for (const key of [
    "connectionId",
    "viewId",
    "commandId",
    "expectedViewRevision",
    "expectedBindingRevision",
    "state",
    "html",
    "tenantId",
    "principalId",
    "authority",
    "serviceId",
    "endpoint",
  ])
    assert.throws(() =>
      parseCognitiveAppViewRequest("locate", { ...request, [key]: "private" }),
    );
  const response = {
    slot: {
      projectId: request.projectId,
      appId: request.appId,
      version: request.version,
      definitionHash: request.expectedDefinitionHash,
    },
    view: null,
  };
  assert.deepEqual(parseCognitiveAppViewResponse("locate", response), response);
  for (const invalid of [
    { ...response, state: {} },
    { ...response, slot: { ...response.slot, principalId: "bob" } },
    {
      ...response,
      view: { viewId: "own", viewRevision: 0, status: "open", binding: null },
    },
    {
      ...response,
      view: {
        viewId: "own",
        viewRevision: 1,
        status: "open",
        binding: null,
        state: {},
      },
    },
    {
      ...response,
      view: {
        viewId: "own",
        viewRevision: 1,
        status: "open",
        binding: {
          bindingRevision: 1,
          connectionId: "c",
          instanceId: "i",
          serviceId: "s",
          dataAuthorityId: "d",
          hostBindingId: "private",
        },
      },
    },
  ])
    assert.throws(() => parseCognitiveAppViewResponse("locate", invalid));
});

for (const backend of ["sqlite", "postgres"] as const) {
  test(`ACTUAL ${backend} Local/HTTP/Remote locate: missing exact own slot is read-only`, async () =>
    withViewTransport(backend, (f) =>
      locateAll(f, { slot: slotFor(f), view: null }),
    ));
  test(`ACTUAL ${backend} all three locate adapters retain actual binding/closed/disabled facts without body or opening`, async () =>
    withViewTransport(backend, async (f) => {
      const options = { identityGeneration: f.localCsrf };
      const open = await f.local.call(
        "cognitive-app-views.launch",
        f.launch,
        options,
      );
      const expected: CognitiveAppViewLocation = {
        slot: slotFor(f),
        view: {
          viewId: open.receipt.viewId,
          viewRevision: open.receipt.viewRevision,
          status: "open",
          binding: {
            bindingRevision: open.receipt.bindingRevision,
            connectionId: f.connection.connectionId,
            instanceId: f.connection.instanceId,
            serviceId: f.connection.serviceId,
            dataAuthorityId: f.connection.dataAuthorityId,
          },
        },
      };
      await locateAll(f, expected);
      const rebound = await f.local.call(
        "cognitive-app-views.bind",
        {
          ...f.launch,
          ...cas(open.receipt),
          commandId: "bind-other-original",
          connectionId: f.other.connectionId,
          expectedConnectionRevision: f.other.revision,
        },
        options,
      );
      expected.view!.viewRevision = rebound.receipt.viewRevision;
      expected.view!.binding = {
        bindingRevision: rebound.receipt.bindingRevision,
        connectionId: f.other.connectionId,
        instanceId: f.other.instanceId,
        serviceId: f.other.serviceId,
        dataAuthorityId: f.other.dataAuthorityId,
      };
      await locateAll(f, expected); // There is no desired-connection filter.
      const closed = await f.local.call(
        "cognitive-app-views.close",
        {
          ...cas(rebound.receipt),
          commandId: "close-original",
        },
        options,
      );
      expected.view!.status = "closed";
      expected.view!.viewRevision = closed.receipt.viewRevision;
      await f.local.call(
        "cognitive-apps.grant",
        {
          appId: f.input.definition.id,
          version: f.input.definition.version,
          state: "disabled",
          expectedRevision: 1,
        },
        options,
      );
      await f.local.call(
        "cognitive-apps.connection-state",
        {
          appId: f.input.definition.id,
          version: f.input.definition.version,
          connectionId: f.other.connectionId,
          state: "disabled",
          expectedRevision: 1,
        },
        options,
      );
      // Controlled authoritative SQL installation-state setup, not a new API.
      await f.q.change(
        "UPDATE app_installations SET state='disabled' WHERE tenant_id=? AND app_id=?",
        [f.tenantId, f.input.definition.id],
      );
      await locateAll(f, expected);
      assert.equal(
        (await f.q.all("SELECT status FROM app_view_instances"))[0]!.status,
        "closed",
      );
    }));
  test(`ACTUAL ${backend} locate returns a controlled retained-unbound SQL slot, never absent or its invalid navigation`, async () =>
    withViewTransport(backend, async (f) => {
      const now = new Date().toISOString();
      // Legal historical schema shape which current legacy launch denies.
      // Its canary is not valid cognitive navigation: locate must not select it.
      await f.q.change(
        "INSERT INTO app_view_instances VALUES(?,?,?,?,?,?,?,7,'open',?,?)",
        [
          f.tenantId,
          "retained-unbound",
          "bob",
          "project-a",
          f.input.definition.id,
          f.input.definition.version,
          '{"private":"NAVIGATION-MUST-NOT-BE-READ"}',
          now,
          now,
        ],
      );
      await locateAll(f, {
        slot: slotFor(f),
        view: {
          viewId: "retained-unbound",
          viewRevision: 7,
          status: "open",
          binding: null,
        },
      });
      const before = await rows(f);
      await assert.rejects(
        f.local.call("cognitive-app-views.launch", f.launch, {
          identityGeneration: f.localCsrf,
        }),
        (error) => {
          assert.ok(error instanceof ApplicationRequestError);
          assert.equal(error.status, 409);
          return true;
        },
      );
      assert.deepEqual(await rows(f), before);
    }));
  test(`ACTUAL ${backend} own locator excludes another Human/tenant and unauthorized project, not another version`, async () =>
    withViewTransport(backend, async (f) => {
      const alice = { credential: "setup-alice" };
      await f.platform.changeCognitiveAppGrant(alice, {
        appId: f.input.definition.id,
        version: f.input.definition.version,
        state: "active",
        expectedRevision: 0,
      });
      const connection = await f.platform.createVerifiedCognitiveAppConnection(
        alice,
        await prepareConnectionCreation(f.platform, alice, {
          connectionId: "alice-connection",
          expectedRevision: 0,
          proof: {
            purpose: "connection-setup",
            appId: f.input.definition.id,
            version: f.input.definition.version,
            definitionHash: f.installed.definitionHash,
            serviceId: "service/notes",
            dataAuthorityId: "database/alice",
            hostBindingId: "private_alice",
          },
        }),
      );
      await f.platform.launchCognitiveAppView(alice, {
        ...f.launch,
        commandId: "alice-view",
        connectionId: connection.connectionId,
      });
      await f.platform.provisionTenant("foreign-tenant");
      const now = new Date().toISOString();
      await f.q.change(
        "INSERT INTO projects(tenant_id,project_id,kind,owner_principal_id,title,revision,created_at,updated_at) VALUES(?,'not-a-member','project','alice','Private project',1,?,?)",
        [f.tenantId, now, now],
      );
      await f.q.change(
        "INSERT INTO project_members(tenant_id,project_id,principal_id) VALUES(?,'not-a-member','alice')",
        [f.tenantId],
      );
      await f.q.change(
        "INSERT INTO app_view_instances VALUES(?,'private-project-view','alice','not-a-member',?,?,'{}',1,'open',?,?)",
        [
          f.tenantId,
          f.input.definition.id,
          f.input.definition.version,
          now,
          now,
        ],
      );
      await f.q.change(
        "INSERT INTO projects(tenant_id,project_id,kind,owner_principal_id,title,revision,created_at,updated_at) VALUES('foreign-tenant','project-a','project','bob','Foreign',1,?,?)",
        [now, now],
      );
      await f.q.change(
        "INSERT INTO app_view_instances VALUES('foreign-tenant','foreign-view','bob','project-a',?,?,'{}',1,'open',?,?)",
        [f.input.definition.id, f.input.definition.version, now, now],
      );
      await locateAll(f, { slot: slotFor(f), view: null });
      for (const { client, generation } of adapters(f)) {
        const before = await rows(f);
        await assert.rejects(
          client.call(
            "cognitive-app-views.locate",
            { ...requestFor(f), projectId: "not-a-member" },
            { identityGeneration: generation },
          ),
          failure([403]),
        );
        await assert.rejects(
          client.call(
            "cognitive-app-views.locate",
            { ...requestFor(f), version: "2.0.0" },
            { identityGeneration: generation },
          ),
          failure([404]),
        );
        await assert.rejects(
          client.call(
            "cognitive-app-views.locate",
            { ...requestFor(f), expectedDefinitionHash: "0".repeat(64) },
            { identityGeneration: generation },
          ),
          failure([404]),
        );
        assert.deepEqual(await rows(f), before);
      }
    }));
  test(`ACTUAL ${backend} archived/deleted project slot is recovery metadata, not active readUi/launch permission`, async () =>
    withViewTransport(backend, async (f) => {
      const open = await f.local.call("cognitive-app-views.launch", f.launch, {
        identityGeneration: f.localCsrf,
      });
      const expected: CognitiveAppViewLocation = {
        slot: slotFor(f),
        view: {
          viewId: open.receipt.viewId,
          viewRevision: 1,
          status: "open",
          binding: {
            bindingRevision: 1,
            connectionId: f.connection.connectionId,
            instanceId: f.connection.instanceId,
            serviceId: f.connection.serviceId,
            dataAuthorityId: f.connection.dataAuthorityId,
          },
        },
      };
      for (const column of ["archived_at", "deleted_at"] as const) {
        // Explicit authoritative lifecycle setup, not a simulated read result.
        await f.q.change(
          "UPDATE projects SET archived_at=NULL,deleted_at=NULL WHERE tenant_id=? AND project_id='project-a'",
          [f.tenantId],
        );
        await f.q.change(
          `UPDATE projects SET ${column}=? WHERE tenant_id=? AND project_id='project-a'`,
          [new Date().toISOString(), f.tenantId],
        );
        await locateAll(f, expected);
        const before = await rows(f);
        for (const { client, generation } of adapters(f)) {
          await assert.rejects(
            client.call("cognitive-app-views.read-ui", cas(open.receipt), {
              identityGeneration: generation,
            }),
            failure([403]),
          );
          await assert.rejects(
            client.call(
              "cognitive-app-views.launch",
              { ...f.launch, commandId: `forbidden-${column}` },
              { identityGeneration: generation },
            ),
            (error) => {
              assert.ok(error instanceof ApplicationRequestError);
              assert.equal(error.status, 403);
              return true;
            },
          );
        }
        assert.deepEqual(await rows(f), before);
      }
    }));
  test(`ACTUAL ${backend} locate cannot race-create or silently reopen/retarget; old close/rebind CAS stays rejected`, async () =>
    withViewTransport(backend, async (f) => {
      await locateAll(f, { slot: slotFor(f), view: null });
      const outcomes = await Promise.allSettled([
        f.local.call(
          "cognitive-app-views.launch",
          { ...f.launch, commandId: "race-local" },
          { identityGeneration: f.localCsrf },
        ),
        f.remote.call(
          "cognitive-app-views.launch",
          { ...f.launch, commandId: "race-remote" },
          { identityGeneration: f.remoteCsrf },
        ),
      ]);
      const successes = outcomes.filter(
          (value) => value.status === "fulfilled",
        ),
        errors = outcomes.filter((value) => value.status === "rejected");
      assert.equal(successes.length, 1);
      assert.equal(errors.length, 1);
      assert.ok(errors[0]!.reason instanceof ApplicationRequestError);
      assert.equal(errors[0]!.reason.status, 409);
      const initial = successes[0]!.value.receipt;
      assert.equal(
        (await f.q.all("SELECT * FROM app_view_instances")).length,
        1,
      );
      assert.equal(
        (
          await f.q.all(
            "SELECT * FROM command_receipts WHERE operation='launch-cognitive-view'",
          )
        ).length,
        1,
      );
      const closed = await f.local.call(
        "cognitive-app-views.close",
        { ...cas(initial), commandId: "race-close" },
        { identityGeneration: f.localCsrf },
      );
      const located = await f.local.call(
        "cognitive-app-views.locate",
        requestFor(f),
        { identityGeneration: f.localCsrf },
      );
      assert.equal(located.view!.status, "closed");
      assert.equal(located.view!.viewRevision, closed.receipt.viewRevision);
      const before = await rows(f);
      await assert.rejects(
        f.remote.call("cognitive-app-views.read-ui", cas(initial), {
          identityGeneration: f.remoteCsrf,
        }),
        failure([409]),
      );
      assert.deepEqual(await rows(f), before);
      const reopened = await f.local.call(
        "cognitive-app-views.launch",
        {
          ...f.launch,
          expectedViewRevision: closed.receipt.viewRevision,
          expectedBindingRevision: closed.receipt.bindingRevision,
          commandId: "explicit-reopen",
        },
        { identityGeneration: f.localCsrf },
      );
      const rebound = await f.local.call(
        "cognitive-app-views.bind",
        {
          ...f.launch,
          ...cas(reopened.receipt),
          commandId: "explicit-rebind",
          connectionId: f.other.connectionId,
        },
        { identityGeneration: f.localCsrf },
      );
      const after = await rows(f);
      await assert.rejects(
        f.remote.call("cognitive-app-views.read-ui", cas(reopened.receipt), {
          identityGeneration: f.remoteCsrf,
        }),
        failure([409]),
      );
      assert.deepEqual(await rows(f), after);
      const latest = await f.remote.call(
        "cognitive-app-views.locate",
        requestFor(f),
        { identityGeneration: f.remoteCsrf },
      );
      assert.equal(latest.view!.viewId, initial.viewId);
      assert.equal(latest.view!.viewRevision, rebound.receipt.viewRevision);
      assert.equal(latest.view!.binding!.connectionId, f.other.connectionId);
    }));
  test(`ACTUAL ${backend} locate HTTP requires cookie/Origin/CSRF, strict bounded JSON and fixed query`, async () =>
    withViewTransport(backend, async (f) => {
      const route = f.origin + "/api/platform/cognitive-app-views/locate",
        body = JSON.stringify(requestFor(f));
      const headers = {
        "Content-Type": "application/json",
        Origin: f.origin,
        "X-Morphz-Token": f.httpCsrf,
        Cookie: f.cookie()!,
      };
      const before = await rows(f);
      for (const replacement of [
        { Cookie: "" },
        { Origin: "https://foreign.invalid" },
        { "X-Morphz-Token": "stale" },
      ] as Array<Record<string, string>>) {
        const response = await fetch(route, {
          method: "POST",
          headers: { ...headers, ...replacement },
          body,
        });
        assert.equal(response.status, "Cookie" in replacement ? 401 : 403);
      }
      for (const [path, payload] of [
        [route + "?connectionId=other", body],
        [route, JSON.stringify({ ...requestFor(f), connectionId: "other" })],
        [route, new Uint8Array([0xc3, 0x28])],
        [
          route,
          JSON.stringify({ ...requestFor(f), html: "x".repeat(512 * 1024) }),
        ],
      ] as const) {
        const response = await fetch(path, {
          method: "POST",
          headers,
          body: payload,
        });
        assert.equal(response.status, 400);
      }
      for (const { client, generation } of adapters(f)) {
        const sent = f.requests.length;
        await assert.rejects(
          client.call(
            "cognitive-app-views.locate",
            { ...requestFor(f), tenantId: "foreign" } as never,
            { identityGeneration: generation },
          ),
          failure([400]),
        );
        assert.equal(f.requests.length, sent);
      }
      assert.deepEqual(await rows(f), before);
    }));
  test(`ACTUAL ${backend} exact own slots distinguish actual registered versions and projects, not the latest open row`, async () =>
    withViewTransport(backend, async (f) => {
      const original = await f.local.call(
        "cognitive-app-views.launch",
        f.launch,
        { identityGeneration: f.localCsrf },
      );
      const now = new Date().toISOString();
      await f.q.change(
        "INSERT INTO projects(tenant_id,project_id,kind,owner_principal_id,title,revision,created_at,updated_at) VALUES(?,'project-b','project','bob','Another own project',1,?,?)",
        [f.tenantId, now, now],
      );
      await f.q.change(
        "INSERT INTO project_members(tenant_id,project_id,principal_id) VALUES(?,'project-b','bob')",
        [f.tenantId],
      );
      const second = {
        manifest: { ...f.input.manifest, version: "2.0.0" },
        definition: {
          ...f.input.definition,
          version: "2.0.0",
          ui: { ...f.input.definition.ui, packageVersion: "2.0.0" },
        },
      };
      const installed = await f.ui.installCognitive(
        { credential: "setup-alice" },
        "install-second-exact",
        second,
      );
      await f.platform.changeCognitiveAppGrant(
        { credential: "setup-bob" },
        {
          appId: second.definition.id,
          version: "2.0.0",
          state: "active",
          expectedRevision: 0,
        },
      );
      const request = {
        ...requestFor(f),
        version: "2.0.0",
        expectedDefinitionHash: installed.definitionHash,
      };
      const before = await rows(f),
        guard = guardIo(f);
      try {
        for (const { client, generation } of adapters(f)) {
          const old = await client.call(
            "cognitive-app-views.locate",
            requestFor(f),
            { identityGeneration: generation },
          );
          assert.equal(old.view!.viewId, original.receipt.viewId);
          assert.deepEqual(
            await client.call("cognitive-app-views.locate", request, {
              identityGeneration: generation,
            }),
            {
              slot: {
                projectId: request.projectId,
                appId: request.appId,
                version: request.version,
                definitionHash: request.expectedDefinitionHash,
              },
              view: null,
            },
          );
          assert.deepEqual(
            await client.call(
              "cognitive-app-views.locate",
              { ...requestFor(f), projectId: "project-b" },
              { identityGeneration: generation },
            ),
            { slot: { ...slotFor(f), projectId: "project-b" }, view: null },
          );
          await assert.rejects(
            client.call(
              "cognitive-app-views.locate",
              {
                ...request,
                expectedDefinitionHash: f.installed.definitionHash,
              },
              { identityGeneration: generation },
            ),
            failure([404]),
          );
        }
        assert.deepEqual(guard.calls, []);
      } finally {
        guard.close();
      }
      assert.deepEqual(await rows(f), before);
      const v2 = await f.remote.call(
        "cognitive-app-views.launch",
        { ...f.launch, ...request, commandId: "version-two-slot" },
        { identityGeneration: f.remoteCsrf },
      );
      const projectB = await f.local.call(
        "cognitive-app-views.launch",
        { ...f.launch, projectId: "project-b", commandId: "project-b-slot" },
        { identityGeneration: f.localCsrf },
      );
      assert.notEqual(v2.receipt.viewId, original.receipt.viewId);
      assert.notEqual(projectB.receipt.viewId, original.receipt.viewId);
      assert.equal(
        (await f.q.all("SELECT view_id FROM app_view_instances")).length,
        3,
      );
      const after = await rows(f);
      for (const { client, generation } of adapters(f)) {
        assert.equal(
          (
            await client.call("cognitive-app-views.locate", request, {
              identityGeneration: generation,
            })
          ).view!.viewId,
          v2.receipt.viewId,
        );
        assert.equal(
          (
            await client.call(
              "cognitive-app-views.locate",
              { ...requestFor(f), projectId: "project-b" },
              { identityGeneration: generation },
            )
          ).view!.viewId,
          projectB.receipt.viewId,
        );
        assert.equal(
          (
            await client.call("cognitive-app-views.locate", requestFor(f), {
              identityGeneration: generation,
            })
          ).view!.viewId,
          original.receipt.viewId,
        );
      }
      assert.deepEqual(await rows(f), after);
    }));
  test(`ACTUAL ${backend} global installation and known own view never substitute for current own registration`, async () =>
    withViewTransport(backend, async (f) => {
      await f.local.call("cognitive-app-views.launch", f.launch, {
        identityGeneration: f.localCsrf,
      });
      // Controlled actual metadata withdrawal; no unregister API is invented.
      await f.q.change(
        "DELETE FROM cognitive_app_registrations WHERE tenant_id=? AND principal_id='bob' AND app_id=? AND version=?",
        [f.tenantId, f.input.definition.id, f.input.definition.version],
      );
      const before = await rows(f),
        guard = guardIo(f);
      try {
        for (const { client, generation } of adapters(f))
          await assert.rejects(
            client.call("cognitive-app-views.locate", requestFor(f), {
              identityGeneration: generation,
            }),
            failure([404]),
          );
        assert.deepEqual(guard.calls, []);
      } finally {
        guard.close();
      }
      assert.deepEqual(await rows(f), before);
      assert.equal(
        (await f.q.all("SELECT view_id FROM app_view_instances")).length,
        1,
      );
      assert.equal(
        (await f.q.all("SELECT app_id FROM cognitive_app_versions")).length,
        1,
      );
    }));
  for (const lane of ["Local", "HTTP", "Remote"] as const) {
    test(`ACTUAL ${backend} ${lane} original adapter identity epoch rejects post-read locate after actual new login`, async () =>
      withViewTransport(backend, async (f) => {
        const { client, generation } = adapters(f).find(
          (adapter) => adapter.name === lane,
        )!;
        const original = f.platform.locateCognitiveAppView.bind(f.platform);
        const entered = deferred(),
          release = deferred();
        let reads = 0;
        f.platform.locateCognitiveAppView = async (...args) => {
          const result = await original(...args);
          reads++;
          entered.resolve();
          await release.promise;
          return result;
        };
        const rejected = assert.rejects(
          client.call("cognitive-app-views.locate", requestFor(f), {
            identityGeneration: generation,
          }),
          failure([403, 408]),
        );
        let before: Awaited<ReturnType<typeof rows>>;
        try {
          await bounded(entered.promise);
          // Same real fixture Human, different persisted login + client epoch.
          // This is not a claim about the later renderer owner generation.
          await client.call("login", { token: "b".repeat(64) });
          before = await rows(f);
        } finally {
          release.resolve();
        }
        await rejected;
        assert.equal(reads, 1);
        assert.deepEqual(await rows(f), before!);
      }));
    test(`ACTUAL ${backend} ${lane} locate captures original strict input before real identity await`, async () =>
      withViewTransport(backend, async (f) => {
        const { client, generation } = adapters(f).find(
          (adapter) => adapter.name === lane,
        )!;
        const entered = deferred(),
          release = deferred();
        let arrivals = 0;
        f.control.beforeResolve = async () => {
          arrivals++;
          entered.resolve();
          await release.promise;
        };
        const request = requestFor(f),
          before = await rows(f);
        const pending = client.call("cognitive-app-views.locate", request, {
          identityGeneration: generation,
        });
        // Install a handler immediately; retain original rejection if the
        // real authority barrier is not reached.
        const observed = pending.then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        try {
          await bounded(entered.promise);
          request.projectId = "not-the-original-project";
          request.expectedDefinitionHash = "0".repeat(64);
        } finally {
          release.resolve();
        }
        const outcome = await observed;
        if ("error" in outcome) throw outcome.error;
        assert.deepEqual(outcome.value, { slot: slotFor(f), view: null });
        assert.equal(arrivals, 1);
        assert.deepEqual(await rows(f), before);
      }));
    test(`ACTUAL ${backend} ${lane} locate does not disclose after actual persisted login revocation post-read`, async () =>
      withViewTransport(backend, async (f) => {
        const { client, generation } = adapters(f).find(
          (adapter) => adapter.name === lane,
        )!;
        const original = f.platform.locateCognitiveAppView.bind(f.platform);
        const entered = deferred(),
          release = deferred();
        let readCount = 0;
        f.platform.locateCognitiveAppView = async (...args) => {
          const result = await original(...args);
          readCount++;
          entered.resolve();
          await release.promise;
          return result;
        };
        const rejected = assert.rejects(
          client.call("cognitive-app-views.locate", requestFor(f), {
            identityGeneration: generation,
          }),
          failure([401, 403, 408]),
        );
        let before: Awaited<ReturnType<typeof rows>>;
        try {
          await bounded(entered.promise);
          const cookie =
            lane === "Local" ? f.local.authenticationCookie() : f.cookie();
          const session = await f.identity.authenticate(cookie);
          assert.ok(session);
          await f.identity.logout(session.sessionHash);
          before = await rows(f); // Compare after the intentional logout.
        } finally {
          release.resolve();
        }
        await rejected;
        assert.equal(readCount, 1);
        assert.deepEqual(await rows(f), before!);
        assert.equal(Reflect.get(f.human, "issued").size, 0);
      }));
    test(`ACTUAL ${backend} ${lane} locate abort after real SQL read rejects without retry or rows`, async () =>
      withViewTransport(backend, async (f) => {
        const { client, generation } = adapters(f).find(
          (adapter) => adapter.name === lane,
        )!;
        const original = f.platform.locateCognitiveAppView.bind(f.platform);
        const entered = deferred(),
          release = deferred(),
          returned = deferred();
        let readCount = 0;
        f.platform.locateCognitiveAppView = async (...args) => {
          const result = await original(...args);
          readCount++;
          entered.resolve();
          await release.promise;
          returned.resolve();
          return result;
        };
        const controller = new AbortController(),
          before = await rows(f);
        const rejected = assert.rejects(
          client.call("cognitive-app-views.locate", requestFor(f), {
            identityGeneration: generation,
            signal: controller.signal,
          }),
          failure([408]),
        );
        try {
          await bounded(entered.promise);
          controller.abort();
        } finally {
          release.resolve();
        }
        await rejected;
        await bounded(returned.promise);
        assert.equal(readCount, 1);
        assert.deepEqual(await rows(f), before);
        // HTTP fetch rejection is not proof of server finally completion.
        // Deliberately no server-pending/HPA-clear claim from this barrier.
      }));
  }
  test(`ACTUAL ${backend} all three locate adapters reject pre-abort/stale identity without locate queries or HPA`, async () =>
    withViewTransport(backend, async (f) => {
      let queries = 0;
      const original = f.platform.locateCognitiveAppView.bind(f.platform);
      f.platform.locateCognitiveAppView = async (...args) => {
        queries++;
        return original(...args);
      };
      const before = await rows(f),
        controller = new AbortController();
      controller.abort();
      for (const { client, generation } of adapters(f)) {
        const requests = f.requests.length;
        await assert.rejects(
          client.call("cognitive-app-views.locate", requestFor(f), {
            identityGeneration: generation,
            signal: controller.signal,
          }),
          failure([408]),
        );
        assert.equal(f.requests.length, requests);
        await assert.rejects(
          client.call("cognitive-app-views.locate", requestFor(f), {
            identityGeneration: "stale",
          }),
          failure([403]),
        );
      }
      assert.equal(queries, 0);
      assert.equal(Reflect.get(f.human, "issued").size, 0);
      assert.deepEqual(await rows(f), before);
    }));
  test(`ACTUAL ${backend} Service withholds a controlled contradictory valid DTO from the real read, not caller-retargeted slot`, async () =>
    withViewTransport(backend, async (f) => {
      const original = f.platform.locateCognitiveAppView.bind(f.platform);
      f.platform.locateCognitiveAppView = async (...args) => {
        const result = await original(...args);
        // Controlled return-port fault after native read, not a SQL-produced
        // contradictory row or evidence of a reachable production bug.
        return {
          ...result,
          slot: { ...result.slot, projectId: "another-project" },
        };
      };
      const before = await rows(f);
      for (const { client, generation } of adapters(f))
        await assert.rejects(
          client.call("cognitive-app-views.locate", requestFor(f), {
            identityGeneration: generation,
          }),
          (error) => {
            failure([502])(error);
            assert.ok(error instanceof ApplicationRequestError);
            assert.equal(error.code, "contract");
            return true;
          },
        );
      assert.deepEqual(await rows(f), before);
      assert.equal(Reflect.get(f.human, "issued").size, 0);
    }));
  test(`ACTUAL ${backend} tracked Host close waits for locate and rejects its late public disclosure`, async () =>
    withViewTransport(backend, async (f) => {
      const original = f.platform.locateCognitiveAppView.bind(f.platform);
      const entered = deferred(),
        release = deferred();
      f.platform.locateCognitiveAppView = async (...args) => {
        const value = await original(...args);
        entered.resolve();
        await release.promise;
        return value;
      };
      const before = await rows(f);
      const rejected = assert.rejects(
        f.local.call("cognitive-app-views.locate", requestFor(f), {
          identityGeneration: f.localCsrf,
        }),
        failure([503]),
      );
      await bounded(entered.promise);
      let closed = false;
      const closing = f.host.close().then(() => {
        closed = true;
      });
      try {
        await Promise.resolve();
        assert.equal(closed, false);
      } finally {
        release.resolve();
      }
      await rejected;
      await closing;
      assert.equal(closed, true);
      assert.deepEqual(await rows(f), before);
      assert.equal(Reflect.get(f.human, "issued").size, 0);
    }));
  test(`ACTUAL ${backend} known Agent fixture actor cannot use Human-only locate`, async () =>
    isolatedView(backend, async (f) => {
      const before = await f.q.all("SELECT * FROM app_view_instances");
      await assert.rejects(
        f.service.locate(agent, {
          projectId: "project-a",
          appId: "example.notes",
          version: "1.0.0",
          expectedDefinitionHash: "a".repeat(64),
        }),
        (error) => {
          assert.ok(error instanceof CognitiveAppServiceError);
          assert.equal(error.reason, "forbidden");
          assert.equal(error.commandId, undefined);
          return true;
        },
      );
      assert.deepEqual(
        await f.q.all("SELECT * FROM app_view_instances"),
        before,
      );
    }));
}
