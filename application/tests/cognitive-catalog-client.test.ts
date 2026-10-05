import test from "node:test";
import assert from "node:assert/strict";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import {
  ApplicationRequestError,
  type ApplicationCaller,
  type ApplicationMethod,
} from "../packages/core/src/application-api.js";
import { parseCognitiveAppDefinition } from "../packages/cognitive-app-sdk/src/protocol.js";
import { withViewTransport } from "./fixtures/cognitive-app-view-transport-fixture.js";

// Real frontend PlatformClient -> three public adapters -> IdentityCenter/HPA
// -> isolated SQLite/PostgreSQL. Connection setup is the fixture's explicit
// proof, not author networking or acceptance of the user's original window.
type Fixture = Parameters<Parameters<typeof withViewTransport>[1]>[0];
async function clients(f: Fixture) {
  const calls: {
    port: string;
    method: ApplicationMethod;
    params: unknown;
    identityGeneration?: string;
    signal?: AbortSignal;
  }[] = [];
  const values = [];
  for (const [port, caller] of [
    ["Local", f.local],
    ["HTTP", f.client],
    ["Remote", f.remote],
  ] as const) {
    const tracked: ApplicationCaller = {
      async call(method, params, options) {
        calls.push({
          port,
          method,
          params: structuredClone(params),
          identityGeneration: options?.identityGeneration,
          signal: options?.signal,
        });
        return caller.call(method, params, options);
      },
    };
    values.push({ port, client: await PlatformClient.connect(tracked) });
  }
  return { values, calls };
}
async function uiFacts(f: Fixture) {
  const facts = [];
  for (const table of [
    "app_ui_packages",
    "app_view_instances",
    "cognitive_app_view_bindings",
    "cognitive_app_connections",
    "cognitive_app_commands",
    "content_entries",
  ])
    facts.push(await f.q.all(`SELECT * FROM ${table}`));
  return facts;
}

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `ACTUAL ${backend} typed PlatformClient Local/HTTP/Remote preserves registration without implicit consent or UI`,
    { timeout: 60_000 },
    async () =>
      withViewTransport(backend, async (f) => {
        const { values, calls } = await clients(f);
        const definition = parseCognitiveAppDefinition({
          ...f.input.definition,
          id: "author.client-headless",
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
        const protectedBefore = await uiFacts(f);
        const signal = AbortSignal.timeout(20_000);
        for (const { port, client } of values) {
          assert.equal(client.boot.centerId, f.tenantId);
          assert.equal(client.boot.principalId, "bob");
          assert.equal(
            client.boot.csrfToken,
            port === "Local" ? f.localCsrf : f.httpCsrf,
          );
          assert.deepEqual(
            await client.cognitiveApps.allCatalog(
              { appId: definition.id },
              signal,
            ),
            { versions: [], connections: [] },
          );
        }
        for (const { client } of values) {
          assert.deepEqual(
            await client.cognitiveApps.call(
              "install",
              {
                mode: "register-installed",
                commandId: "register-through-typed-client",
                ...exact,
              },
              signal,
            ),
            exact,
          );
          const catalog = await client.cognitiveApps.allCatalog(
            { appId: definition.id },
            signal,
          );
          assert.equal(catalog.versions.length, 1);
          const metadata = catalog.versions[0]!;
          assert.equal(metadata.grant, null);
          assert.equal(metadata.ui, null);
          assert.equal(metadata.installationState, "active");
          const inspection = {
            mode: "registered-management" as const,
            appId: exact.appId,
            version: exact.version,
            expectedDefinitionHash: exact.definitionHash,
          };
          assert.deepEqual(
            await client.cognitiveApps.call("describe", inspection, signal),
            {
              mode: "registered-management",
              definition,
              definitionHash: exact.definitionHash,
              registeredAt: metadata.registeredAt,
              installationState: "active",
              grant: null,
            },
          );
          await assert.rejects(
            client.cognitiveApps.call("describe", {
              appId: exact.appId,
              version: exact.version,
              projectId: "project-a",
            }),
            (error: unknown) =>
              error instanceof ApplicationRequestError && error.status === 403,
          );
          await assert.rejects(
            client.cognitiveApps.call("describe", {
              ...inspection,
              expectedDefinitionHash: "0".repeat(64),
            }),
          );
          const beforeInvalid = calls.length;
          await assert.rejects(
            client.cognitiveApps.call("describe", {
              ...inspection,
              projectId: "project-a",
            } as typeof inspection),
          );
          assert.equal(
            calls.length,
            beforeInvalid,
            "invalid input never leaves the Client",
          );
        }
        assert.deepEqual(await uiFacts(f), protectedBefore);
        assert.deepEqual(
          await f.q.all("SELECT * FROM cognitive_app_grants WHERE app_id=?", [
            exact.appId,
          ]),
          [],
        );
        assert.equal(
          (
            await f.q.all("SELECT * FROM command_receipts WHERE command_id=?", [
              "register-through-typed-client",
            ])
          ).length,
          1,
        );
        for (const request of calls.filter((c) =>
          c.method.startsWith("cognitive-apps."),
        )) {
          assert.equal(
            request.identityGeneration,
            request.port === "Local" ? f.localCsrf : f.httpCsrf,
          );
          assert.equal(
            Reflect.has(request.params as object, "credential"),
            false,
          );
        }
        assert.ok(
          calls.some(
            (c) => c.method === "cognitive-apps.list" && c.signal === signal,
          ),
        );
        assert.ok(
          !calls.some((c) =>
            /grant|connect|invoke|app-views|platform.message/.test(c.method),
          ),
        );

        // Consent is a distinct explicit Human call, never a list side effect.
        const granted = await values[0]!.client.cognitiveApps.call("grant", {
          appId: exact.appId,
          version: exact.version,
          expectedRevision: 0,
          state: "active",
        });
        assert.equal(granted.revision, 1);
        const disabled = await values[1]!.client.cognitiveApps.call("grant", {
          appId: exact.appId,
          version: exact.version,
          expectedRevision: 1,
          state: "disabled",
        });
        assert.equal(disabled.revision, 2);
        const retained = await values[2]!.client.cognitiveApps.allCatalog({
          appId: exact.appId,
        });
        assert.deepEqual(retained.versions[0]!.grant, disabled);
        assert.deepEqual(await uiFacts(f), protectedBefore);
      }),
  );

  test(
    `ACTUAL ${backend} typed Client drains budget-short pages and either paired stream EOF on all three adapters`,
    { timeout: 60_000 },
    async () =>
      withViewTransport(backend, async (f) => {
        const { values, calls } = await clients(f);
        // Wire-valid maximum-size icon fixture. This is exact-byte metadata
        // preservation, not a claim that these synthetic bytes render as PNG.
        const iconImage = "data:image/png;base64," + "A".repeat(179_976);
        for (let index = 1; index <= 4; index++) {
          await values[0]!.client.cognitiveApps.call("install", {
            definition: parseCognitiveAppDefinition({
              ...f.input.definition,
              id: "author.client-pages",
              version: `${index}.0.0`,
              title: "完整中文😀应用",
              iconImage,
              ui: null,
            }),
          });
        }
        const short = await values[0]!.client.cognitiveApps.call("list", {
          appId: "author.client-pages",
          limit: 100,
        });
        assert.ok(short.versions.length > 0 && short.versions.length < 100);
        assert.ok(short.nextVersionsAfter, "a budget-short page is not EOF");
        assert.equal(short.nextConnectionsAfter, null);
        for (const { client } of values) {
          const before = calls.length;
          const catalog = await client.cognitiveApps.allCatalog({ limit: 100 });
          assert.equal(catalog.versions.length, 5);
          assert.equal(catalog.connections.length, 2);
          const large = catalog.versions.filter(
            (v) => v.appId === "author.client-pages",
          );
          assert.equal(large.length, 4);
          assert.ok(
            large.every(
              (v) =>
                v.iconImage === iconImage && v.ui === null && v.grant === null,
            ),
          );
          const reads = calls
            .slice(before)
            .filter((c) => c.method === "cognitive-apps.list");
          assert.ok(reads.length > 1);
          for (const read of reads.slice(1)) {
            const params = read.params as {
              versionsAfter?: string;
              connectionsAfter?: string;
            };
            assert.ok(params.versionsAfter || params.connectionsAfter);
            assert.ok(
              !(params.versionsAfter && params.connectionsAfter),
              "one current token carries both streams",
            );
          }
          const single = await client.cognitiveApps.allCatalog({ limit: 1 });
          assert.deepEqual(single, catalog);
          assert.equal(
            new Set(single.connections.map((c) => c.connectionId)).size,
            2,
          );
        }
      }),
  );
}
