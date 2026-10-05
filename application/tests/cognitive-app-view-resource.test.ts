import { prepareConnectionCreation } from "./fixtures/cognitive-connection-creation.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { withViewTransport } from "./fixtures/cognitive-app-view-transport-fixture.js";
import { embeddedResources } from "../apps/desktop/application-host.js";
import { RemoteApplicationConnection } from "../apps/desktop/remote-host.js";
import { ApplicationRequestError } from "../packages/core/src/application-api.js";
import { ManagedArtifactStore } from "../packages/managed-artifact-store/src/store.js";
import {
  applicationViewPolicy,
  applicationViewPermissions,
} from "../packages/core/src/resource-policy.js";
import {
  cognitiveAppViewResourcePath,
  parseCognitiveAppViewResourceRequest,
  parseCognitiveAppViewResourceURL,
  parseCognitiveAppViewHtmlBytes,
  cognitiveAppViewHtmlResource,
  cognitiveAppViewResourceMime,
} from "../packages/core/src/cognitive-app-view-resource.js";

const cas = (r: {
  viewId: string;
  viewRevision: number;
  bindingRevision: number;
}) => ({
  viewId: r.viewId,
  expectedViewRevision: r.viewRevision,
  expectedBindingRevision: r.bindingRevision,
});
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const denied = (status: number) => (error: unknown) => {
  assert.ok(error instanceof ApplicationRequestError);
  assert.equal(error.status, status);
  assert.doesNotMatch(
    error.message,
    /PRIVATE|credential|host_binding|sqlite|postgres|127\.0\.0\.1/,
  );
  assert.equal("cause" in error, false);
  return true;
};
function headers(response: Response, length: number) {
  assert.equal(
    response.headers.get("content-type"),
    cognitiveAppViewResourceMime,
  );
  assert.equal(response.headers.get("content-length"), String(length));
  assert.equal(
    response.headers.get("content-security-policy"),
    applicationViewPolicy,
  );
  assert.equal(
    response.headers.get("permissions-policy"),
    applicationViewPermissions,
  );
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(
    response.headers.get("cross-origin-resource-policy"),
    "same-origin",
  );
}
async function launch(
  f: Parameters<Parameters<typeof withViewTransport>[1]>[0],
) {
  return cas(
    (
      await f.local.call("cognitive-app-views.launch", f.launch, {
        identityGeneration: f.localCsrf,
      })
    ).receipt,
  );
}

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `ACTUAL ${backend} bound UI resource: Local and Remote return original authenticated HTML bytes`,
    { timeout: 60000 },
    async () => {
      await withViewTransport(backend, async (f) => {
        const launched = await f.local.call(
          "cognitive-app-views.launch",
          f.launch,
          { identityGeneration: f.localCsrf },
        );
        const request = {
          viewId: launched.receipt.viewId,
          expectedViewRevision: launched.receipt.viewRevision,
          expectedBindingRevision: launched.receipt.bindingRevision,
        };
        const original = await f.local.call(
          "cognitive-app-views.read-ui",
          request,
          { identityGeneration: f.localCsrf },
        );
        assert.ok(original.manifest.ui.type === "sandbox");
        const bytes = new TextEncoder().encode(original.manifest.ui.html);
        for (const connection of [f.local, f.remote]) {
          const resource = await connection.cognitiveAppViewResource(request);
          assert.equal(resource.mime, "text/html; charset=utf-8");
          assert.deepEqual(resource.bytes, bytes);
        }
        const rows = async () => {
          const result: Record<string, unknown> = {};
          for (const table of [
            "app_ui_packages",
            "app_view_instances",
            "cognitive_app_view_bindings",
            "cognitive_app_commands",
            "content_entries",
          ])
            result[table] = await f.q.all(`SELECT * FROM ${table}`);
          return result;
        };
        const before = await rows();
        for (const method of ["GET", "HEAD"]) {
          const response = await fetch(
            f.origin + cognitiveAppViewResourcePath(request),
            { method, headers: { Cookie: f.cookie()! } },
          );
          assert.equal(response.status, 200);
          headers(response, bytes.byteLength);
          assert.deepEqual(
            new Uint8Array(await response.arrayBuffer()),
            method === "HEAD" ? new Uint8Array() : bytes,
          );
        }
        for (const connection of [f.local, f.remote]) {
          const resource = embeddedResources("/nonexistent", connection);
          for (const method of ["GET", "HEAD"]) {
            const beforeRequests = f.requests.length;
            const response = await resource(
              new Request(
                "morphz://app" + cognitiveAppViewResourcePath(request),
                { method },
              ),
            );
            assert.equal(response.status, 200);
            headers(response, bytes.byteLength);
            assert.deepEqual(
              new Uint8Array(await response.arrayBuffer()),
              method === "HEAD" ? new Uint8Array() : bytes,
            );
            if (connection === f.local)
              assert.equal(
                f.requests.length,
                beforeRequests,
                "embedded Local has no HTTP request",
              );
          }
        }
        assert.deepEqual(
          await rows(),
          before,
          "read/HEAD do not create business commands or mutate window/package/catalog",
        );
      });
    },
  );
  test(
    `ACTUAL ${backend} bound UI resource: leading BOM and exact one-million UTF-8 multibyte bytes survive every port`,
    { timeout: 60000 },
    async () => {
      const first = "\ufeff<!doctype html><p>😀中文\r\n",
        last = "</p>\r\n";
      const html =
        first +
        '"'.repeat(
          1_000_000 - new TextEncoder().encode(first + last).byteLength,
        ) +
        last;
      const expected = new TextEncoder().encode(html);
      await withViewTransport(
        backend,
        async (f) => {
          const request = await launch(f);
          for (const connection of [f.local, f.remote]) {
            const value = await connection.cognitiveAppViewResource(request);
            assert.deepEqual(value.bytes, expected);
            assert.equal(sha(value.bytes), f.input.definition.ui!.sha256);
            const response = await embeddedResources(
              "/nonexistent",
              connection,
            )(
              new Request(
                "morphz://app" + cognitiveAppViewResourcePath(request),
              ),
            );
            headers(response, 1_000_000);
            const bytes = new Uint8Array(await response.arrayBuffer());
            assert.deepEqual(bytes, expected);
            assert.equal(sha(bytes), f.input.definition.ui!.sha256);
          }
          const response = await fetch(
            f.origin + cognitiveAppViewResourcePath(request),
            { headers: { Cookie: f.cookie()! } },
          );
          headers(response, 1_000_000);
          assert.deepEqual(
            new Uint8Array(await response.arrayBuffer()),
            expected,
          );
        },
        { html },
      );
    },
  );
  test(
    `ACTUAL ${backend} bound UI resource: finite requests/getters and canonical URL deny before byte reads or new network`,
    { timeout: 60000 },
    async () =>
      withViewTransport(backend, async (f) => {
        const request = await launch(f),
          path = cognitiveAppViewResourcePath(request);
        let getters = 0,
          identityCalls = 0,
          reads = 0;
        f.control.beforeResolve = async () => {
          identityCalls++;
        };
        const read = f.ui.readCognitive.bind(f.ui);
        f.ui.readCognitive = async (...args) => {
          reads++;
          return read(...args);
        };
        const accessor = { ...request };
        Object.defineProperty(accessor, "viewId", {
          enumerable: true,
          get() {
            getters++;
            return request.viewId;
          },
        });
        const nested = {
          ...request,
          unexpected: {
            get address() {
              getters++;
              return "PRIVATE";
            },
          },
        };
        const prior = f.requests.length;
        for (const connection of [f.local, f.remote])
          for (const input of [
            accessor,
            nested,
            { ...request, owner: "alice" },
            { ...request, address: "PRIVATE" },
            { ...request, now: "2026-10-05" },
            { ...request, expectedViewRevision: 0 },
          ])
            await assert.rejects(
              connection.cognitiveAppViewResource(input),
              denied(400),
            );
        assert.equal(getters, 0);
        assert.equal(identityCalls, 0);
        assert.equal(f.requests.length, prior);
        const base = "/api/cognitive-app-view/" + request.viewId;
        const invalid = [
          `${base}?expectedViewRevision=01&expectedBindingRevision=1`,
          `${base}?expectedViewRevision=1e0&expectedBindingRevision=1`,
          `${base}?expectedViewRevision=+1&expectedBindingRevision=1`,
          `${base}?expectedViewRevision=9007199254740991&expectedBindingRevision=1`,
          `${base}?expectedViewRevision=1&expectedViewRevision=1&expectedBindingRevision=1`,
          `${base}?expectedViewRevision=1&expectedBindingRevision=1&owner=alice`,
          `${base}?expectedViewRevision=1`,
          `${base}/extra?expectedViewRevision=1&expectedBindingRevision=1`,
          `/api/cognitive-app-view/%76iew-bob?expectedViewRevision=1&expectedBindingRevision=1`,
        ];
        for (const candidate of invalid) {
          const response = await embeddedResources(
            "/nonexistent",
            f.local,
          )(new Request("morphz://app" + candidate));
          assert.equal(response.status, 400);
          const http = await fetch(f.origin + candidate, {
            headers: { Cookie: f.cookie()! },
          });
          assert.equal(http.status, 400);
        }
        assert.equal(
          reads,
          0,
          "invalid query/path never reaches actual UI byte reading",
        );
        const replacementHeaders: Array<Record<string, string>> = [
          { Cookie: "" },
          { Origin: "https://evil.invalid", Cookie: f.cookie()! },
          { "Sec-Fetch-Site": "cross-site", Cookie: f.cookie()! },
        ];
        for (const replacement of replacementHeaders) {
          for (const method of ["GET", "HEAD"]) {
            const response = await fetch(f.origin + path, {
              method,
              headers: replacement,
            });
            assert.equal(
              response.status,
              replacement.Cookie === "" ? 401 : 403,
            );
            if (method === "HEAD")
              assert.equal((await response.arrayBuffer()).byteLength, 0);
          }
        }
        const unsafe = await fetch(f.origin + path, {
          method: "DELETE",
          headers: { Cookie: f.cookie()! },
        });
        assert.equal(unsafe.status, 405);
      }),
  );
  test(
    `ACTUAL ${backend} bound UI resource: another owner's bound view is not a byte capability`,
    { timeout: 60000 },
    async () =>
      withViewTransport(backend, async (f) => {
        await f.platform.changeCognitiveAppGrant(
          { credential: "setup-alice" },
          {
            appId: f.launch.appId,
            version: f.launch.version,
            expectedRevision: 0,
            state: "active",
          },
        );
        const connection =
          await f.platform.createVerifiedCognitiveAppConnection(
            { credential: "setup-alice" },
            await prepareConnectionCreation(
              f.platform,
              { credential: "setup-alice" },
              {
                connectionId: "connection-alice",
                expectedRevision: 0,
                proof: {
                  purpose: "connection-setup",
                  appId: f.launch.appId,
                  version: f.launch.version,
                  definitionHash: f.installed.definitionHash,
                  serviceId: "service/notes",
                  dataAuthorityId: "database/alice",
                  hostBindingId: "PRIVATE-alice",
                },
              },
            ),
          );
        const receipt = await f.platform.launchCognitiveAppView(
          { credential: "setup-alice" },
          {
            ...f.launch,
            commandId: "alice-own-view",
            connectionId: connection.connectionId,
            expectedConnectionRevision: connection.revision,
          },
        );
        for (const connection of [f.local, f.remote])
          await assert.rejects(
            connection.cognitiveAppViewResource(cas(receipt.receipt)),
            denied(404),
          );
        for (const method of ["GET", "HEAD"]) {
          const response = await fetch(
            f.origin + cognitiveAppViewResourcePath(cas(receipt.receipt)),
            { method, headers: { Cookie: f.cookie()! } },
          );
          assert.equal(response.status, 404);
          assert.doesNotMatch(await response.text(), /PRIVATE|doctype|<p>/);
        }
      }),
  );
  for (const lane of ["local", "remote"] as const)
    for (const event of [
      "logout",
      "view-close",
      "rebind",
      "grant",
      "connection-close",
    ] as const) {
      test(
        `ACTUAL ${backend} ${lane} bound UI resource: ${event} during real Store byte wait retires disclosure`,
        { timeout: 60000 },
        async () =>
          withViewTransport(backend, async (f) => {
            const request = await launch(f),
              connection = lane === "local" ? f.local : f.remote;
            const store: unknown = Reflect.get(f.ui, "store");
            assert.ok(store instanceof ManagedArtifactStore);
            const read = store.readRange.bind(store);
            let entered!: () => void,
              release!: () => void,
              actualReads = 0;
            const entry = new Promise<void>((resolve) => (entered = resolve)),
              hold = new Promise<void>((resolve) => (release = resolve));
            store.readRange = async (...args) => {
              const value = await read(...args);
              actualReads++;
              assert.deepEqual(
                new Uint8Array(value.bytes),
                new TextEncoder().encode(f.input.manifest.ui.html),
              );
              entered();
              await hold;
              return value;
            };
            const pending = connection.cognitiveAppViewResource(request);
            // Observe rejection immediately. A failure before the controlled
            // Store wait must release/clean the fixture rather than hang entry.
            const outcome = pending.then(
              () => ({ ok: true }) as const,
              (error: unknown) => ({ ok: false, error }) as const,
            );
            try {
              await Promise.race([
                entry,
                outcome.then((result) => {
                  if (result.ok)
                    throw new Error("Expected the actual Store byte wait");
                  throw result.error;
                }),
              ]);
              if (event === "logout") {
                const session = f.identity.authenticate(
                  lane === "local"
                    ? f.local.authenticationCookie()
                    : f.cookie(),
                );
                assert.ok(session);
                await f.identity.logout(session.sessionHash);
              } else if (event === "view-close")
                await f.platform.changeCognitiveAppView(
                  { credential: "setup-bob" },
                  { ...request, commandId: "close-during-read", close: true },
                );
              else if (event === "rebind")
                await f.platform.bindCognitiveAppView(
                  { credential: "setup-bob" },
                  {
                    ...f.launch,
                    ...request,
                    commandId: "bind-during-read",
                    connectionId: f.other.connectionId,
                    expectedConnectionRevision: f.other.revision,
                  },
                );
              else if (event === "grant")
                await f.platform.changeCognitiveAppGrant(
                  { credential: "setup-bob" },
                  {
                    appId: f.launch.appId,
                    version: f.launch.version,
                    expectedRevision: 1,
                    state: "disabled",
                  },
                );
              else connection.close();
            } finally {
              release();
            }
            const result = await outcome;
            assert.equal(result.ok, false);
            if (!result.ok)
              denied(event === "view-close" || event === "rebind" ? 409 : 403)(
                result.error,
              );
            if (["view-close", "rebind", "grant"].includes(event)) {
              const head = await fetch(
                f.origin + cognitiveAppViewResourcePath(request),
                {
                  method: "HEAD",
                  headers: { Cookie: f.cookie()! },
                },
              );
              assert.equal(head.status, event === "grant" ? 403 : 409);
              assert.equal((await head.arrayBuffer()).byteLength, 0);
            }
            // HTTP may already have observed abort while its actual byte task is
            // still completing. Host close waits that real pending task, not sleep.
            await f.host.close();
            assert.equal(actualReads, 1);
            assert.equal(Reflect.get(f.ui, "scopes").size, 0);
            assert.deepEqual(
              await f.q.all("SELECT * FROM cognitive_app_commands"),
              [],
            );
          }),
      );
    }
  for (const lane of ["local", "remote"] as const)
    test(
      `ACTUAL ${backend} ${lane} bound UI resource: captured locator survives caller mutation across actual verifier await`,
      { timeout: 60000 },
      async () =>
        withViewTransport(backend, async (f) => {
          const request = await launch(f),
            input = { ...request };
          let entered!: () => void, release!: () => void;
          const entry = new Promise<void>((resolve) => (entered = resolve)),
            hold = new Promise<void>((resolve) => (release = resolve));
          f.control.beforeResolve = async () => {
            f.control.beforeResolve = undefined;
            entered();
            await hold;
          };
          const pending = (
            lane === "local" ? f.local : f.remote
          ).cognitiveAppViewResource(input);
          try {
            await entry;
            input.viewId = "foreign";
            input.expectedViewRevision = 999;
            input.expectedBindingRevision = 999;
          } finally {
            release();
          }
          const resource = await pending;
          assert.deepEqual(
            resource.bytes,
            new TextEncoder().encode(f.input.manifest.ui.html),
          );
        }),
    );
  test(
    `ACTUAL ${backend} embedded bound UI resource: preaborted Request reads no bytes, live abort retains no HTML`,
    { timeout: 60000 },
    async () =>
      withViewTransport(backend, async (f) => {
        const request = await launch(f),
          resource = embeddedResources("/nonexistent", f.local),
          url = "morphz://app" + cognitiveAppViewResourcePath(request);
        let reads = 0;
        const original = f.ui.readCognitive.bind(f.ui);
        f.ui.readCognitive = async (...args) => {
          reads++;
          return original(...args);
        };
        const before = new AbortController();
        before.abort();
        assert.equal(
          (await resource(new Request(url, { signal: before.signal }))).status,
          408,
        );
        assert.equal(reads, 0);
        let entered!: () => void, release!: () => void;
        const entry = new Promise<void>((resolve) => (entered = resolve)),
          hold = new Promise<void>((resolve) => (release = resolve));
        f.control.beforeResolve = async () => {
          f.control.beforeResolve = undefined;
          entered();
          await hold;
        };
        const controller = new AbortController();
        const pending = resource(
          new Request(url, { signal: controller.signal }),
        );
        try {
          await entry;
          controller.abort();
        } finally {
          release();
        }
        const response = await pending;
        assert.equal(response.status, 408);
        assert.doesNotMatch(await response.text(), /doctype|<p>|PRIVATE/);
      }),
  );
}

test("UNIT bound UI finite contract: exact canonical keys/revisions, no getters; fatal UTF8/BOM/limits without normalization", () => {
  const request = {
    viewId: "view",
    expectedViewRevision: 1,
    expectedBindingRevision: 2,
  };
  assert.deepEqual(
    parseCognitiveAppViewResourceURL(
      new URL("https://unit.invalid" + cognitiveAppViewResourcePath(request)),
    ),
    request,
  );
  assert.equal(
    parseCognitiveAppViewResourceURL(
      new URL("https://unit.invalid/api/application-view/example.app@1.0.0"),
    ),
    null,
  );
  assert.throws(() =>
    parseCognitiveAppViewResourceURL(
      new URL(
        "https://unit.invalid" +
          cognitiveAppViewResourcePath(request) +
          "#fragment",
      ),
    ),
  );
  let calls = 0;
  const hostile = { ...request };
  Object.defineProperty(hostile, "viewId", {
    enumerable: true,
    get() {
      calls++;
      throw new Error("PRIVATE");
    },
  });
  assert.throws(() => parseCognitiveAppViewResourceRequest(hostile));
  assert.equal(calls, 0);
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x61]);
  assert.deepEqual(parseCognitiveAppViewHtmlBytes(bom), bom);
  assert.notEqual(parseCognitiveAppViewHtmlBytes(bom), bom);
  assert.deepEqual(cognitiveAppViewHtmlResource("\ufeffa").bytes, bom);
  for (const bytes of [
    new Uint8Array(),
    new Uint8Array([0xc3, 0x28]),
    new Uint8Array([0xed, 0xa0, 0x80]),
    new Uint8Array(1_000_001),
  ])
    assert.throws(() => parseCognitiveAppViewHtmlBytes(bytes));
  assert.throws(() => cognitiveAppViewHtmlResource("\ud800"));
  assert.equal(
    parseCognitiveAppViewHtmlBytes(
      new TextEncoder().encode("a".repeat(1_000_000)),
    ).byteLength,
    1_000_000,
  );
});
const remoteRequest = {
  viewId: "view",
  expectedViewRevision: 1,
  expectedBindingRevision: 1,
};
const validHeaders = (length: number) => ({
  "Content-Type": cognitiveAppViewResourceMime,
  "Content-Length": String(length),
  "Content-Security-Policy": applicationViewPolicy,
  "Permissions-Policy": applicationViewPermissions,
});
test("UNIT Remote bound UI: exact MIME/full policies/length/fatal bytes, chunk limit, redirect and safe private errors", async () => {
  const samples: [Response, number][] = [
    [new Response("PRIVATE", { status: 403 }), 403],
    [
      new Response("ok", {
        headers: { ...validHeaders(2), "Content-Type": "text/plain" },
      }),
      502,
    ],
    [
      new Response("ok", {
        headers: {
          ...validHeaders(2),
          "Content-Security-Policy": "sandbox allow-scripts",
        },
      }),
      502,
    ],
    [
      new Response("ok", {
        headers: { ...validHeaders(2), "Permissions-Policy": "" },
      }),
      502,
    ],
    [new Response("ok", { headers: validHeaders(3) }), 502],
    [
      new Response(new Uint8Array([0xc3, 0x28]), { headers: validHeaders(2) }),
      502,
    ],
    [
      new Response(new Uint8Array(1_000_001), {
        headers: validHeaders(1_000_000),
      }),
      413,
    ],
    [new Response("ok", { headers: validHeaders(1_000_001) }), 413],
  ];
  for (const [response, status] of samples) {
    let calls = 0;
    const remote = new RemoteApplicationConnection(
      "https://unit.invalid",
      async (url, init) => {
        calls++;
        assert.equal(
          String(url),
          "https://unit.invalid" + cognitiveAppViewResourcePath(remoteRequest),
        );
        assert.equal(init?.redirect, "error");
        assert.equal(init?.credentials, "include");
        return response;
      },
    );
    try {
      await assert.rejects(
        remote.cognitiveAppViewResource(remoteRequest),
        denied(status),
      );
      assert.equal(calls, 1);
    } finally {
      remote.close();
    }
  }
  const unavailable = new RemoteApplicationConnection(
    "https://unit.invalid",
    async () => {
      throw new Error("PRIVATE-credential");
    },
  );
  try {
    await assert.rejects(
      unavailable.cognitiveAppViewResource(remoteRequest),
      denied(503),
    );
  } finally {
    unavailable.close();
  }
});

test("UNIT Remote bound UI: monotonic deadline defeats delayed timer at fetch, body and cleanup, without publishing bytes", async (context) => {
  const real = performance.now.bind(performance);
  let elapsed = 0;
  const original = Object.getOwnPropertyDescriptor(performance, "now");
  Object.defineProperty(performance, "now", {
    configurable: true,
    value: () => elapsed,
  });
  try {
    for (const phase of ["fetch", "body", "cleanup"]) {
      elapsed = 0;
      let calls = 0,
        cancels = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (phase === "body") elapsed = 30_001;
            controller.enqueue(new TextEncoder().encode("ok"));
          },
          cancel() {
            cancels++;
            if (phase === "cleanup") elapsed = 30_001;
          },
        },
        { highWaterMark: 0 },
      );
      const remote = new RemoteApplicationConnection(
        "https://unit.invalid",
        async () => {
          calls++;
          if (phase === "fetch") elapsed = 30_001;
          return new Response(body, { headers: validHeaders(2) });
        },
      );
      // Body/cleanup: do not close the controlled stream. A later next pull
      // needs explicit completion so cleanup, not an endless reader, is tested.
      if (phase === "cleanup") {
        let part = 0;
        const response = new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                if (part++ === 0)
                  controller.enqueue(new TextEncoder().encode("ok"));
                else controller.close();
              },
              cancel() {
                elapsed = 30_001;
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: validHeaders(2) },
        );
        const remoteCleanup = new RemoteApplicationConnection(
          "https://unit.invalid",
          async () => response,
        );
        // Closed native streams do not execute an underlying cancel callback.
        // The reader.cancel promise itself is the controlled synchronous hook.
        const cancel = ReadableStreamDefaultReader.prototype.cancel;
        context.mock.method(
          ReadableStreamDefaultReader.prototype,
          "cancel",
          function (
            this: ReadableStreamDefaultReader<Uint8Array>,
            reason?: unknown,
          ) {
            const cancelled = cancel.call(this, reason);
            elapsed = 30_001;
            return cancelled;
          },
        );
        try {
          await assert.rejects(
            remoteCleanup.cognitiveAppViewResource(remoteRequest),
            denied(408),
          );
        } finally {
          remoteCleanup.close();
          remote.close();
        }
        context.mock.restoreAll();
      } else
        try {
          await assert.rejects(
            remote.cognitiveAppViewResource(remoteRequest),
            denied(408),
          );
          assert.equal(calls, 1);
          assert.equal(cancels, 1);
          assert.equal(body.locked, false);
          assert.equal(Reflect.get(remote, "requests").size, 0);
        } finally {
          remote.close();
        }
    }
  } finally {
    if (original) Object.defineProperty(performance, "now", original);
    else Reflect.deleteProperty(performance, "now");
    assert.ok(real() >= 0);
  }
});

test("UNIT Remote bound UI: never-settling body cancellation cannot hold a request slot or leak private bytes", async () => {
  let calls = 0,
    cancels = 0,
    pulls = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls++;
        controller.enqueue(new TextEncoder().encode("PRIVATE-HTML"));
      },
      cancel() {
        cancels++;
        return new Promise<void>(() => {});
      },
    },
    { highWaterMark: 0 },
  );
  const remote = new RemoteApplicationConnection(
    "https://unit.invalid",
    async () => {
      calls++;
      return new Response(body, {
        headers: { ...validHeaders(12), "Content-Type": "text/plain" },
      });
    },
  );
  try {
    await Promise.race([
      assert.rejects(
        remote.cognitiveAppViewResource(remoteRequest),
        denied(502),
      ),
      new Promise<never>((_, reject) =>
        setImmediate(() =>
          reject(new Error("Body cleanup retained the request")),
        ),
      ),
    ]);
    assert.equal(calls, 1);
    assert.equal(cancels, 1);
    assert.equal(pulls, 0);
    assert.equal(body.locked, false);
    assert.equal(Reflect.get(remote, "requests").size, 0);
  } finally {
    remote.close();
  }
});

test("UNIT Remote bound UI: a late fetch body is cancelled exactly once on epoch close or abort before any byte is read", async () => {
  for (const retirement of ["close", "abort"] as const) {
    let cancels = 0,
      pulls = 0;
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>(
      {
        pull(stream) {
          pulls++;
          stream.enqueue(new TextEncoder().encode("ok"));
        },
        cancel() {
          cancels++;
        },
      },
      { highWaterMark: 0 },
    );
    const remote = new RemoteApplicationConnection(
      "https://unit.invalid",
      async () => {
        if (retirement === "close") remote.close();
        else controller.abort();
        // This UNIT transport deliberately ignores abort and returns the actual
        // native Response late. No document bytes may escape or remain locked.
        return new Response(body, { headers: validHeaders(2) });
      },
    );
    try {
      await assert.rejects(
        remote.cognitiveAppViewResource(remoteRequest, controller.signal),
        denied(retirement === "close" ? 403 : 408),
      );
      assert.equal(pulls, 0);
      assert.equal(cancels, 1);
      assert.equal(body.locked, false);
      assert.equal(Reflect.get(remote, "requests").size, 0);
    } finally {
      remote.close();
    }
  }
});

test("UNIT Remote bound UI: malformed already-locked response fails safely and never publishes bytes", async () => {
  const response = new Response("PRIVATE-HTML", { headers: validHeaders(12) });
  const owner = response.body!.getReader();
  const remote = new RemoteApplicationConnection(
    "https://unit.invalid",
    async () => response,
  );
  try {
    await assert.rejects(
      remote.cognitiveAppViewResource(remoteRequest),
      denied(503),
    );
    assert.equal(Reflect.get(remote, "requests").size, 0);
  } finally {
    await owner.cancel();
    owner.releaseLock();
    remote.close();
  }
});
