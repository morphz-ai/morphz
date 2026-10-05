import test from "node:test";
import assert from "node:assert/strict";
import {
  ApplicationRequestError,
  type ApplicationMethod,
} from "../packages/core/src/application-api.js";
import {
  parseCognitiveAppCatalog,
  parseCognitiveAppDescription,
  parseCognitiveAppGrant,
  parseCognitiveAppInstalled,
} from "../packages/core/src/cognitive-app-api.js";
import { parseCognitiveAppDefinition } from "../packages/cognitive-app-sdk/src/protocol.js";
import { withViewTransport } from "./fixtures/cognitive-app-view-transport-fixture.js";

// Actual IdentityCenter/HPA, SQL and all three public application adapters.
// The existing isolated fixture supplies a trusted setup identity and a fixed
// connection proof; this is not author-network, native-window or Runtime proof.
type Fixture = Parameters<Parameters<typeof withViewTransport>[1]>[0];
type Adapter = {
  name: string;
  call(method: ApplicationMethod, params: unknown): Promise<unknown>;
};
const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5l7z0AAAAASUVORK5CYII=";
function adapters(f: Fixture): Adapter[] {
  return [
    {
      name: "Local",
      call: (method, params) =>
        f.local.call(method, params, { identityGeneration: f.localCsrf }),
    },
    {
      name: "HTTP",
      call: (method, params) =>
        f.client.call(method, params, { identityGeneration: f.httpCsrf }),
    },
    {
      name: "Remote",
      call: (method, params) =>
        f.remote.call(method, params, { identityGeneration: f.remoteCsrf }),
    },
  ];
}
const rejected =
  (statuses: number[], commandId?: string) => (error: unknown) => {
    assert.ok(error instanceof ApplicationRequestError);
    assert.ok(statuses.includes(error.status), String(error.status));
    if (commandId !== undefined) assert.equal(error.commandId, commandId);
    assert.doesNotMatch(
      error.message,
      /setup-|private_|credential|sqlite|postgres|127\.0\.0\.1/,
    );
    return true;
  };
async function catalog(adapter: Adapter, appId: string) {
  return parseCognitiveAppCatalog(
    await adapter.call("cognitive-apps.list", { appId, limit: 100 }),
  );
}
const protectedTables = [
  "app_ui_packages",
  "app_view_instances",
  "cognitive_app_view_bindings",
  "cognitive_app_connections",
  "cognitive_app_commands",
  "content_entries",
] as const;
async function protectedFacts(f: Fixture) {
  // One fixture query owns one PostgreSQL client; serialize these reads rather
  // than queue concurrent queries on that single connection.
  const facts = [];
  for (const table of protectedTables)
    facts.push(await f.q.all(`SELECT * FROM ${table}`));
  return facts;
}
async function accessRevision(f: Fixture) {
  const row = (
    await f.q.all(
      "SELECT access_revision FROM navigation_heads WHERE tenant_id=?",
      [f.tenantId],
    )
  )[0];
  assert.ok(row);
  return Number(row.access_revision);
}

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `ACTUAL ${backend} Local/HTTP/Remote: register and inspect before consent without author dispatch, then retain disabled facts`,
    { timeout: 60000 },
    async () =>
      withViewTransport(backend, async (f) => {
        const definition = parseCognitiveAppDefinition({
          ...f.input.definition,
          id: "example.managed-headless",
          version: "2.0.0",
          title: "独立无界面应用",
          iconImage: png,
          ui: null,
        });
        const installed = await f.platform.installCognitiveApp(
          { credential: "setup-alice" },
          { definition },
        );
        const exact = {
          appId: installed.appId,
          version: installed.version,
          definitionHash: installed.definitionHash,
        };
        const ports = adapters(f);
        const protectedBefore = await protectedFacts(f);
        const before = await accessRevision(f);
        for (const adapter of ports)
          assert.deepEqual(
            (await catalog(adapter, definition.id)).versions,
            [],
          );

        const registration = {
          mode: "register-installed",
          commandId: "public-register-headless",
          ...exact,
        };
        for (const adapter of ports)
          assert.deepEqual(
            parseCognitiveAppInstalled(
              await adapter.call("cognitive-apps.install", registration),
            ),
            exact,
            `${adapter.name} must preserve the same receipt`,
          );
        assert.equal(await accessRevision(f), before + 1);
        assert.equal(
          (
            await f.q.all(
              "SELECT * FROM command_receipts WHERE command_id='public-register-headless'",
            )
          ).length,
          1,
        );

        const inspection = {
          mode: "registered-management",
          appId: exact.appId,
          version: exact.version,
          expectedDefinitionHash: exact.definitionHash,
        };
        for (const adapter of ports) {
          const directory = await catalog(adapter, definition.id);
          assert.equal(directory.versions.length, 1);
          const metadata = directory.versions[0]!;
          assert.equal(metadata.grant, null);
          assert.equal(metadata.iconImage, png);
          assert.equal(metadata.installationState, "active");
          assert.ok(Number.isFinite(Date.parse(metadata.registeredAt)));
          for (const field of [
            "definition",
            "installedByPrincipalId",
            "installationId",
            "hostBindingId",
            "credential",
          ])
            assert.equal(Reflect.has(metadata, field), false);
          const preview = parseCognitiveAppDescription(
            await adapter.call("cognitive-apps.describe", inspection),
          );
          assert.deepEqual(preview, {
            mode: "registered-management",
            definition,
            definitionHash: exact.definitionHash,
            registeredAt: metadata.registeredAt,
            installationState: "active",
            grant: null,
          });
          await assert.rejects(
            adapter.call("cognitive-apps.describe", {
              appId: exact.appId,
              version: exact.version,
              projectId: "project-a",
            }),
            rejected([403]),
          );
          await assert.rejects(
            adapter.call("cognitive-apps.connect", {
              appId: exact.appId,
              version: exact.version,
              connectionId: `unconsented-${adapter.name}`,
              expectedRevision: 0,
              serviceId: "service/notes",
              dataAuthorityId: "database/notes",
            }),
            rejected([403]),
          );
          await assert.rejects(
            adapter.call("cognitive-apps.describe", {
              ...inspection,
              projectId: "project-a",
            }),
            rejected([400]),
          );
        }
        assert.equal(await accessRevision(f), before + 1);
        assert.deepEqual(await protectedFacts(f), protectedBefore);
        assert.deepEqual(
          await f.q.all("SELECT * FROM cognitive_app_grants WHERE app_id=?", [
            exact.appId,
          ]),
          [],
        );

        const grant = parseCognitiveAppGrant(
          await ports[1]!.call("cognitive-apps.grant", {
            appId: exact.appId,
            version: exact.version,
            expectedRevision: 0,
            state: "active",
          }),
        );
        assert.equal(grant.revision, 1);
        assert.equal(grant.state, "active");
        assert.deepEqual(
          parseCognitiveAppDescription(
            await ports[0]!.call("cognitive-apps.describe", {
              appId: exact.appId,
              version: exact.version,
              projectId: "project-a",
              expectedDefinitionHash: exact.definitionHash,
              expectedGrantRevision: grant.revision,
            }),
          ),
          {
            definition,
            definitionHash: exact.definitionHash,
            grantRevision: 1,
          },
        );
        const disabled = parseCognitiveAppGrant(
          await ports[2]!.call("cognitive-apps.grant", {
            appId: exact.appId,
            version: exact.version,
            expectedRevision: grant.revision,
            state: "disabled",
          }),
        );
        assert.equal(disabled.revision, 2);
        for (const adapter of ports) {
          const directory = await catalog(adapter, definition.id);
          assert.deepEqual(directory.versions[0]!.grant, disabled);
          const preview = parseCognitiveAppDescription(
            await adapter.call("cognitive-apps.describe", inspection),
          );
          assert.ok("mode" in preview);
          assert.equal(preview.mode, "registered-management");
          assert.deepEqual(Reflect.get(preview, "grant"), disabled);
          // Old registration receipt must not silently re-enable a later grant.
          assert.deepEqual(
            parseCognitiveAppInstalled(
              await adapter.call("cognitive-apps.install", registration),
            ),
            exact,
          );
          await assert.rejects(
            adapter.call("cognitive-apps.describe", {
              appId: exact.appId,
              version: exact.version,
              projectId: "project-a",
            }),
            rejected([403]),
          );
        }
        assert.deepEqual(await protectedFacts(f), protectedBefore);
        const owner = (
          await f.q.all(
            "SELECT installed_by_principal_id FROM cognitive_app_versions WHERE app_id=?",
            [exact.appId],
          )
        )[0];
        assert.equal(owner?.installed_by_principal_id, "alice");
      }),
  );

  test(
    `ACTUAL ${backend} public management of another installer's exact GUI changes no original byte ownership or view`,
    { timeout: 60000 },
    async () =>
      withViewTransport(backend, async (f) => {
        const input = {
          definition: {
            ...f.input.definition,
            version: "2.0.0",
            ui: {
              ...f.input.definition.ui,
              packageVersion: "2.0.0",
            },
          },
          manifest: { ...f.input.manifest, version: "2.0.0" },
        };
        const installed = await f.ui.installCognitive(
          { credential: "setup-alice" },
          "alice-public-management-ui",
          input,
        );
        const exact = {
          appId: installed.appId,
          version: installed.version,
          definitionHash: installed.definitionHash,
        };
        const before = await protectedFacts(f);
        const ports = adapters(f);
        assert.equal(
          (await catalog(ports[1]!, exact.appId)).versions.some(
            (v) => v.version === exact.version,
          ),
          false,
        );
        const registration = {
          mode: "register-installed",
          commandId: "bob-public-management-ui",
          ...exact,
        };
        for (const adapter of ports) {
          assert.deepEqual(
            parseCognitiveAppInstalled(
              await adapter.call("cognitive-apps.install", registration),
            ),
            exact,
          );
          const preview = parseCognitiveAppDescription(
            await adapter.call("cognitive-apps.describe", {
              mode: "registered-management",
              appId: exact.appId,
              version: exact.version,
              expectedDefinitionHash: exact.definitionHash,
            }),
          );
          assert.equal(
            preview.definition.ui?.sha256,
            input.definition.ui.sha256,
          );
          assert.equal(Reflect.get(preview, "grant"), null);
          assert.equal(Reflect.has(preview, "html"), false);
        }
        await assert.rejects(
          f.ui.read({ credential: "setup-bob" }, exact.appId, exact.version),
        );
        assert.deepEqual(await protectedFacts(f), before);
        assert.deepEqual(
          await f.q.all(
            "SELECT * FROM cognitive_app_grants WHERE app_id=? AND version=?",
            [exact.appId, exact.version],
          ),
          [],
        );
        await assert.rejects(
          f.client.call(
            "cognitive-apps.install",
            {
              ...registration,
              commandId: "stale-public-management",
            },
            { identityGeneration: "stale" },
          ),
          rejected([403], "stale-public-management"),
        );
        assert.deepEqual(
          await f.q.all(
            "SELECT * FROM command_receipts WHERE command_id='stale-public-management'",
          ),
          [],
        );
        const definitions = await f.q.all(
          "SELECT installed_by_principal_id FROM cognitive_app_versions WHERE app_id=? AND version=?",
          [exact.appId, exact.version],
        );
        assert.equal(definitions[0]?.installed_by_principal_id, "alice");
      }),
  );

  test(
    `ACTUAL ${backend} public catalog continuations do not restart an exhausted version or connection stream`,
    { timeout: 60000 },
    async () =>
      withViewTransport(backend, async (f) => {
        const ports = adapters(f);
        const first = parseCognitiveAppCatalog(
          await ports[0]!.call("cognitive-apps.list", { limit: 1 }),
        );
        assert.equal(first.versions.length, 1);
        assert.equal(first.nextVersionsAfter, null);
        assert.equal(first.connections.length, 1);
        assert.ok(first.nextConnectionsAfter);
        const continued = {
          limit: 1,
          connectionsAfter: first.nextConnectionsAfter,
        };
        const second = parseCognitiveAppCatalog(
          await ports[1]!.call("cognitive-apps.list", continued),
        );
        assert.deepEqual(second.versions, []);
        assert.equal(second.connections.length, 1);
        assert.notEqual(
          second.connections[0]!.connectionId,
          first.connections[0]!.connectionId,
        );
        assert.equal(second.nextVersionsAfter, null);
        assert.equal(second.nextConnectionsAfter, null);
        assert.deepEqual(
          parseCognitiveAppCatalog(
            await ports[2]!.call("cognitive-apps.list", continued),
          ),
          second,
        );
        await assert.rejects(
          ports[2]!.call("cognitive-apps.list", {
            limit: 1,
            versionsAfter: first.nextConnectionsAfter,
          }),
          rejected([400]),
        );

        for (let index = 0; index < 3; index++)
          await ports[0]!.call("cognitive-apps.install", {
            definition: parseCognitiveAppDefinition({
              ...f.input.definition,
              id: "example.public-pagination",
              version: `${index}.0.0`,
              ui: null,
            }),
          });
        await assert.rejects(
          ports[1]!.call("cognitive-apps.list", continued),
          rejected([400]),
        );
        const seenVersions = new Set<string>();
        const seenConnections = new Set<string>();
        let page = parseCognitiveAppCatalog(
          await ports[0]!.call("cognitive-apps.list", { limit: 1 }),
        );
        assert.ok(page.nextVersionsAfter);
        assert.ok(page.nextConnectionsAfter);
        const oldConnectionCheckpoint = page.nextConnectionsAfter;
        let reachedEnd = false;
        for (let number = 0; number < 8; number++) {
          for (const v of page.versions) {
            const key = `${v.appId}@${v.version}`;
            assert.equal(seenVersions.has(key), false);
            seenVersions.add(key);
          }
          for (const connection of page.connections) {
            assert.equal(seenConnections.has(connection.connectionId), false);
            seenConnections.add(connection.connectionId);
          }
          if (
            page.nextVersionsAfter === null &&
            page.nextConnectionsAfter === null
          ) {
            reachedEnd = true;
            break;
          }
          if (number === 1) {
            assert.ok(page.nextVersionsAfter);
            assert.equal(page.nextConnectionsAfter, null);
            await assert.rejects(
              ports[2]!.call("cognitive-apps.list", {
                limit: 1,
                versionsAfter: page.nextVersionsAfter,
                connectionsAfter: oldConnectionCheckpoint,
              }),
              rejected([400]),
            );
          }
          // Any one current token carries both positions. The ended stream
          // stays ended even when its own next token is null.
          page = parseCognitiveAppCatalog(
            await ports[number % ports.length]!.call("cognitive-apps.list", {
              limit: 1,
              ...(page.nextVersionsAfter
                ? { versionsAfter: page.nextVersionsAfter }
                : { connectionsAfter: page.nextConnectionsAfter! }),
            }),
          );
        }
        assert.equal(reachedEnd, true);
        assert.equal(seenVersions.size, 4);
        assert.equal(seenConnections.size, 2);
      }),
  );
}
