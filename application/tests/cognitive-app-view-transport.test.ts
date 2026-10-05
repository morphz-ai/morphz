import test from "node:test";
import assert from "node:assert/strict";
import { parseCognitiveAppViewResponse } from "../packages/core/src/cognitive-app-view-api.js";
import {
  type ApplicationMethod,
  ApplicationRequestError,
} from "../packages/core/src/application-api.js";
import { withViewTransport } from "./fixtures/cognitive-app-view-transport-fixture.js";

const failure = (status: number, commandId?: string) => (error: unknown) => {
  assert.ok(error instanceof ApplicationRequestError);
  assert.equal(error.status, status);
  assert.equal(error.commandId, commandId);
  assert.doesNotMatch(
    error.message,
    /private_|credential|sqlite|postgres|127\.0\.0\.1/,
  );
  return true;
};
const cas = (receipt: {
  viewId: string;
  viewRevision: number;
  bindingRevision: number;
}) => ({
  viewId: receipt.viewId,
  expectedViewRevision: receipt.viewRevision,
  expectedBindingRevision: receipt.bindingRevision,
});

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `ACTUAL ${backend} Remote over authenticated HTTP: all six exact view facts, safe original ID and abort without resend`,
    { timeout: 60000 },
    async () =>
      withViewTransport(backend, async (f) => {
        const options = { identityGeneration: f.remoteCsrf };
        const launched = await f.remote.call(
          "cognitive-app-views.launch",
          f.launch,
          options,
        );
        const saved = await f.remote.call(
          "cognitive-app-views.save",
          {
            ...cas(launched.receipt),
            commandId: "remote-save",
            state: { view: "list" },
          },
          options,
        );
        assert.equal(
          (
            await f.remote.call(
              "cognitive-app-views.read",
              { viewId: "view-bob" },
              options,
            )
          ).view.revision,
          2,
        );
        const ui = await f.remote.call(
          "cognitive-app-views.read-ui",
          cas(saved.receipt),
          options,
        );
        assert.ok(ui.manifest.ui.type === "sandbox");
        assert.equal(ui.manifest.ui.html, f.input.manifest.ui.html);
        const bound = await f.remote.call(
          "cognitive-app-views.bind",
          {
            ...f.launch,
            ...cas(saved.receipt),
            commandId: "remote-bind",
            connectionId: f.other.connectionId,
            expectedConnectionRevision: f.other.revision,
          },
          options,
        );
        assert.equal(bound.receipt.bindingRevision, 2);
        const close = { ...cas(bound.receipt), commandId: "remote-close" };
        const closed = await f.remote.call(
          "cognitive-app-views.close",
          close,
          options,
        );
        assert.deepEqual(
          await f.remote.call("cognitive-app-views.close", close, options),
          { receipt: closed.receipt, replayed: true },
        );
        await assert.rejects(
          f.remote.call(
            "cognitive-app-views.save",
            { ...cas(bound.receipt), commandId: "remote-forbidden", state: {} },
            { identityGeneration: "stale" },
          ),
          failure(403, "remote-forbidden"),
        );
        const controller = new AbortController();
        controller.abort();
        const before = f.requests.length;
        await assert.rejects(
          f.remote.call(
            "cognitive-app-views.close",
            { ...cas(bound.receipt), commandId: "remote-aborted" },
            { ...options, signal: controller.signal },
          ),
          failure(408, "remote-aborted"),
        );
        assert.equal(f.requests.length, before);
        f.remote.close();
        await assert.rejects(
          f.remote.call(
            "cognitive-app-views.close",
            { ...cas(bound.receipt), commandId: "remote-closed" },
            options,
          ),
          failure(408, "remote-closed"),
        );
      }),
  );
  test(
    `ACTUAL ${backend} HTTP/Remote: original one-million-byte UTF-8 UI uses dedicated carrier, not domain 512 KiB`,
    { timeout: 60000 },
    async () => {
      const prefix = "<!doctype html><p>😀",
        suffix = "</p>";
      const html =
        prefix +
        '"'.repeat(
          1_000_000 - new TextEncoder().encode(prefix + suffix).byteLength,
        ) +
        suffix;
      await withViewTransport(
        backend,
        async (f) => {
          const launched = await f.client.call(
            "cognitive-app-views.launch",
            f.launch,
            { identityGeneration: f.httpCsrf },
          );
          for (const client of [f.client, f.remote]) {
            const ui = await client.call(
              "cognitive-app-views.read-ui",
              cas(launched.receipt),
              { identityGeneration: f.httpCsrf },
            );
            assert.ok(ui.manifest.ui.type === "sandbox");
            assert.equal(ui.manifest.ui.html, html);
            assert.equal(
              new TextEncoder().encode(ui.manifest.ui.html).byteLength,
              1_000_000,
            );
          }
        },
        { html },
      );
    },
  );
  test(
    `ACTUAL ${backend} Host: close awaits view mutation and rejects late/public disclosure without erasing saved fact`,
    { timeout: 60000 },
    async () =>
      withViewTransport(backend, async (f) => {
        const launched = await f.local.call(
          "cognitive-app-views.launch",
          f.launch,
          { identityGeneration: f.localCsrf },
        );
        let entered!: () => void, release!: () => void;
        const entry = new Promise<void>((resolve) => {
            entered = resolve;
          }),
          hold = new Promise<void>((resolve) => {
            release = resolve;
          });
        const original = f.platform.changeCognitiveAppView.bind(f.platform);
        f.platform.changeCognitiveAppView = async (...args) => {
          const value = await original(...args);
          entered();
          await hold;
          return value;
        };
        const pending = f.local.call(
          "cognitive-app-views.save",
          {
            ...cas(launched.receipt),
            commandId: "host-closing-save",
            state: { view: "list" },
          },
          { identityGeneration: f.localCsrf },
        );
        await entry;
        let closed = false;
        const closing = f.host.close().then(() => {
          closed = true;
        });
        try {
          await Promise.resolve();
          assert.equal(closed, false);
          await assert.rejects(
            f.local.call(
              "cognitive-app-views.read",
              { viewId: "view-bob" },
              { identityGeneration: f.localCsrf },
            ),
            failure(503),
          );
        } finally {
          release();
        }
        await assert.rejects(pending, failure(503, "host-closing-save"));
        await closing;
        assert.equal(closed, true);
        assert.deepEqual(
          (
            await f.platform.readCognitiveAppView(
              { credential: "setup-bob" },
              { viewId: "view-bob" },
            )
          ).view.state,
          { view: "list" },
        );
      }),
  );
  for (const lane of ["local", "http"] as const) {
    test(
      `ACTUAL ${backend} ${lane}: six Human view methods share durable identity, HPA, SQL and exact UI bytes`,
      { timeout: 60000 },
      async () =>
        withViewTransport(backend, async (f) => {
          const client = lane === "local" ? f.local : f.client,
            generation = lane === "local" ? f.localCsrf : f.httpCsrf;
          const call = (suffix: string, input: unknown) =>
            client.call(
              `cognitive-app-views.${suffix}` as ApplicationMethod,
              input,
              { identityGeneration: generation },
            );
          const packages = await f.q.all("SELECT * FROM app_ui_packages");
          const launched = parseCognitiveAppViewResponse(
            "launch",
            await call("launch", f.launch),
          );
          assert.deepEqual(launched, {
            receipt: {
              viewId: "view-bob",
              viewRevision: 1,
              bindingRevision: 1,
            },
            replayed: false,
          });
          const save = {
            ...cas(launched.receipt),
            commandId: "save-original",
            state: { view: "list" },
          };
          const saved = parseCognitiveAppViewResponse(
            "save",
            await call("save", save),
          );
          const metadata = parseCognitiveAppViewResponse(
            "read",
            await call("read", { viewId: "view-bob" }),
          );
          assert.deepEqual(metadata.view.state, save.state);
          assert.equal(metadata.view.revision, 2);
          assert.equal("installedByPrincipalId" in metadata, false);
          const bytes = parseCognitiveAppViewResponse(
            "readUi",
            await call("read-ui", cas(saved.receipt)),
          );
          assert.deepEqual(bytes.manifest, f.input.manifest);
          assert.deepEqual(bytes.definition, f.input.definition);
          assert.equal(
            bytes.authority.definitionHash,
            f.installed.definitionHash,
          );
          assert.equal(bytes.authority.instanceId, f.connection.instanceId);
          const bound = parseCognitiveAppViewResponse(
            "bind",
            await call("bind", {
              ...f.launch,
              ...cas(saved.receipt),
              commandId: "bind-other",
              connectionId: f.other.connectionId,
              expectedConnectionRevision: f.other.revision,
            }),
          );
          assert.equal(bound.receipt.bindingRevision, 2);
          assert.equal(
            parseCognitiveAppViewResponse(
              "readUi",
              await call("read-ui", cas(bound.receipt)),
            ).authority.dataAuthorityId,
            "database/other",
          );
          await assert.rejects(
            call("read-ui", cas(saved.receipt)),
            failure(409),
          );
          assert.deepEqual(await call("launch", f.launch), {
            receipt: launched.receipt,
            replayed: true,
          });
          assert.equal(
            parseCognitiveAppViewResponse(
              "read",
              await call("read", { viewId: "view-bob" }),
            ).view.revision,
            3,
          );
          const close = { ...cas(bound.receipt), commandId: "close-original" };
          const closed = parseCognitiveAppViewResponse(
            "close",
            await call("close", close),
          );
          assert.deepEqual(await call("close", close), {
            receipt: closed.receipt,
            replayed: true,
          });
          assert.equal(
            parseCognitiveAppViewResponse(
              "read",
              await call("read", { viewId: "view-bob" }),
            ).view.status,
            "closed",
          );
          assert.deepEqual(
            await f.q.all("SELECT * FROM app_ui_packages"),
            packages,
          );
          assert.deepEqual(
            await f.q.all("SELECT * FROM cognitive_app_commands"),
            [],
          );
          if (lane === "http")
            for (const request of f.requests.filter((r) =>
              r.path.startsWith("/api/platform/cognitive-app-views/"),
            )) {
              assert.equal(request.method, "POST");
              assert.equal(request.origin, f.origin);
              assert.equal(request.csrf, f.httpCsrf);
              assert.equal(request.cookie, true);
            }
        }),
    );
    test(
      `ACTUAL ${backend} ${lane}: invalid/accessor requests are rejected before HPA or transport; original CAS failure keeps commandId`,
      { timeout: 60000 },
      async () =>
        withViewTransport(backend, async (f) => {
          const client = lane === "local" ? f.local : f.client,
            generation = lane === "local" ? f.localCsrf : f.httpCsrf;
          let getters = 0,
            resolved = 0;
          f.control.beforeResolve = async () => {
            resolved++;
          };
          const malformed = { ...f.launch };
          Object.defineProperty(malformed, "connectionId", {
            enumerable: true,
            get() {
              getters++;
              return "connection-bob";
            },
          });
          const calls = f.requests.length;
          for (const input of [
            malformed,
            { ...f.launch, actor: {} },
            { ...f.launch, ownerPrincipalId: "alice" },
            { ...f.launch, endpoint: "https://private.invalid" },
            { ...f.launch, now: "2026-10-05T00:00:00Z" },
          ])
            await assert.rejects(
              client.call(
                "cognitive-app-views.launch" as ApplicationMethod,
                input,
                { identityGeneration: generation },
              ),
              failure(400),
            );
          assert.equal(getters, 0);
          assert.equal(resolved, 0);
          assert.equal(f.requests.length, calls);
          const launched = parseCognitiveAppViewResponse(
            "launch",
            await client.call(
              "cognitive-app-views.launch" as ApplicationMethod,
              f.launch,
              { identityGeneration: generation },
            ),
          );
          await assert.rejects(
            client.call(
              "cognitive-app-views.save" as ApplicationMethod,
              {
                ...cas(launched.receipt),
                expectedViewRevision: 99,
                commandId: "conflict-original",
                state: {},
              },
              { identityGeneration: generation },
            ),
            failure(409, "conflict-original"),
          );
          await assert.rejects(
            client.call(
              "cognitive-app-views.close" as ApplicationMethod,
              { ...cas(launched.receipt), commandId: "wrong-generation" },
              { identityGeneration: "stale" },
            ),
            failure(403, "wrong-generation"),
          );
          assert.equal(
            (
              await f.platform.readCognitiveAppView(
                { credential: "setup-bob" },
                { viewId: "view-bob" },
              )
            ).view.revision,
            1,
          );
        }),
    );
    test(
      `ACTUAL ${backend} ${lane}: session revoked after durable save blocks response, preserves original receipt and never retries`,
      { timeout: 60000 },
      async () =>
        withViewTransport(backend, async (f) => {
          const client = lane === "local" ? f.local : f.client,
            generation = lane === "local" ? f.localCsrf : f.httpCsrf;
          const launched = parseCognitiveAppViewResponse(
            "launch",
            await client.call(
              "cognitive-app-views.launch" as ApplicationMethod,
              f.launch,
              { identityGeneration: generation },
            ),
          );
          const original = f.platform.changeCognitiveAppView.bind(f.platform);
          let changes = 0;
          f.platform.changeCognitiveAppView = async (...args) => {
            const result = await original(...args);
            changes++;
            const session = f.identity.authenticate(
              lane === "local" ? f.local.authenticationCookie() : f.cookie(),
            );
            assert.ok(session);
            await f.identity.logout(session.sessionHash);
            return result;
          };
          await assert.rejects(
            client.call(
              "cognitive-app-views.save" as ApplicationMethod,
              {
                ...cas(launched.receipt),
                commandId: "revoked-save-original",
                state: { view: "list" },
              },
              { identityGeneration: generation },
            ),
            failure(403, "revoked-save-original"),
          );
          assert.equal(changes, 1);
          const persisted = await f.platform.readCognitiveAppView(
            { credential: "setup-bob" },
            { viewId: "view-bob" },
          );
          assert.equal(persisted.view.revision, 2);
          assert.deepEqual(persisted.view.state, { view: "list" });
          assert.equal(
            f.requests.filter((r) =>
              r.path.endsWith("/cognitive-app-views/save"),
            ).length,
            lane === "http" ? 1 : 0,
          );
        }),
    );
    test(
      `ACTUAL ${backend} ${lane}: session revoked after real UI bytes denies HTML at the public response gate`,
      { timeout: 60000 },
      async () =>
        withViewTransport(backend, async (f) => {
          const client = lane === "local" ? f.local : f.client,
            generation = lane === "local" ? f.localCsrf : f.httpCsrf;
          const launched = parseCognitiveAppViewResponse(
            "launch",
            await client.call(
              "cognitive-app-views.launch" as ApplicationMethod,
              f.launch,
              { identityGeneration: generation },
            ),
          );
          const original = f.ui.readCognitive.bind(f.ui);
          let reads = 0;
          f.ui.readCognitive = async (...args) => {
            const result = await original(...args);
            reads++;
            assert.ok(result.manifest.ui.type === "sandbox");
            assert.equal(result.manifest.ui.html, f.input.manifest.ui.html);
            const session = f.identity.authenticate(
              lane === "local" ? f.local.authenticationCookie() : f.cookie(),
            );
            assert.ok(session);
            await f.identity.logout(session.sessionHash);
            return result;
          };
          await assert.rejects(
            client.call(
              "cognitive-app-views.read-ui" as ApplicationMethod,
              cas(launched.receipt),
              { identityGeneration: generation },
            ),
            failure(403),
          );
          assert.equal(reads, 1);
          assert.equal(Reflect.get(f.ui, "scopes").size, 0);
        }),
    );
    test(
      `ACTUAL ${backend} ${lane}: caller mutation during real identity await cannot change captured navigation`,
      { timeout: 60000 },
      async () =>
        withViewTransport(backend, async (f) => {
          const client = lane === "local" ? f.local : f.client,
            generation = lane === "local" ? f.localCsrf : f.httpCsrf;
          const launched = parseCognitiveAppViewResponse(
            "launch",
            await client.call(
              "cognitive-app-views.launch" as ApplicationMethod,
              f.launch,
              { identityGeneration: generation },
            ),
          );
          let entered!: () => void, release!: () => void;
          const entry = new Promise<void>((resolve) => {
              entered = resolve;
            }),
            hold = new Promise<void>((resolve) => {
              release = resolve;
            });
          f.control.beforeResolve = async () => {
            f.control.beforeResolve = undefined;
            entered();
            await hold;
          };
          const input = {
            ...cas(launched.receipt),
            commandId: "captured-save",
            state: { view: "list" },
          };
          const pending = client.call(
            "cognitive-app-views.save" as ApplicationMethod,
            input,
            { identityGeneration: generation },
          );
          try {
            await entry;
            input.commandId = "changed-save";
            input.viewId = "foreign";
            input.state.view = "changed";
          } finally {
            release();
          }
          const saved = parseCognitiveAppViewResponse("save", await pending);
          assert.equal(saved.receipt.viewId, "view-bob");
          assert.deepEqual(
            (
              await f.platform.readCognitiveAppView(
                { credential: "setup-bob" },
                { viewId: "view-bob" },
              )
            ).view.state,
            { view: "list" },
          );
        }),
    );
  }
  test(
    `ACTUAL ${backend} HTTP: six routes require cookie, exact Origin/CSRF, fixed path/query and fatal UTF-8`,
    { timeout: 60000 },
    async () =>
      withViewTransport(backend, async (f) => {
        const route = f.origin + "/api/platform/cognitive-app-views/launch";
        const json = JSON.stringify(f.launch);
        const headers = {
          "Content-Type": "application/json",
          Origin: f.origin,
          "X-Morphz-Token": f.httpCsrf,
          Cookie: f.cookie()!,
        };
        for (const replacement of [
          { Cookie: "" },
          { Origin: "http://evil.invalid" },
          { "X-Morphz-Token": "wrong" },
        ]) {
          const response = await fetch(route, {
            method: "POST",
            headers: { ...headers, ...replacement },
            body: json,
          });
          assert.equal(response.status, "Cookie" in replacement ? 401 : 403);
        }
        for (const [path, expected] of [
          ["/launch?endpoint=secret", 400],
          ["/recover", 404],
        ] as const) {
          const response = await fetch(
            f.origin + "/api/platform/cognitive-app-views" + path,
            { method: "POST", headers, body: json },
          );
          assert.equal(response.status, expected);
        }
        const utf8 = await fetch(route, {
          method: "POST",
          headers,
          body: new Uint8Array([0xc3, 0x28]),
        });
        assert.equal(utf8.status, 400);
        const large = await fetch(route, {
          method: "POST",
          headers,
          body: JSON.stringify({
            ...f.launch,
            unknown: "x".repeat(512 * 1024),
          }),
        });
        assert.equal(large.status, 400);
        assert.deepEqual(await f.q.all("SELECT * FROM app_view_instances"), []);
      }),
  );
}
