import assert from "node:assert/strict";
import test from "node:test";
import { embeddedResources } from "../apps/desktop/application-host.js";
import { RemoteApplicationConnection } from "../apps/desktop/remote-host.js";
import { ApplicationRequestError } from "../packages/core/src/application-api.js";
import {
  cognitiveAppDocumentResourceMime,
  cognitiveAppDocumentResourcePath,
  maxCognitiveAppDocumentHtmlBytes,
} from "../packages/core/src/cognitive-app-document-resource.js";
import {
  applicationViewPermissions,
  applicationViewPolicy,
} from "../packages/core/src/resource-policy.js";
import {
  cognitiveDocumentBootstrapPolicy,
  createCognitiveDocumentBootstrapFromBytes,
} from "../packages/application/src/cognitive-document-bootstrap.js";
import { withViewTransport } from "./fixtures/cognitive-app-view-transport-fixture.js";

const proof = "document-proof_01234567890123456789";
const request = {
  viewId: "view",
  expectedViewRevision: 1,
  expectedBindingRevision: 1,
  documentProof: proof,
};
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
const documentHeaders = (length: number) => ({
  "Content-Type": cognitiveAppDocumentResourceMime,
  "Content-Length": String(length),
  "Content-Security-Policy": cognitiveDocumentBootstrapPolicy,
  "Permissions-Policy": applicationViewPermissions,
});
function assertHeaders(response: Response, length: number) {
  for (const [name, value] of Object.entries(documentHeaders(length)))
    assert.equal(response.headers.get(name), value);
  for (const [name, value] of Object.entries({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "Cross-Origin-Resource-Policy": "same-origin",
  }))
    assert.equal(response.headers.get(name), value);
  assert.doesNotMatch(
    response.headers.get("Content-Security-Policy")!,
    /(?:^|;)\s*sandbox/,
  );
}
async function launch(
  f: Parameters<Parameters<typeof withViewTransport>[1]>[0],
) {
  const result = await f.local.call("cognitive-app-views.launch", f.launch, {
    identityGeneration: f.localCsrf,
  });
  return {
    viewId: result.receipt.viewId,
    expectedViewRevision: result.receipt.viewRevision,
    expectedBindingRevision: result.receipt.bindingRevision,
    documentProof: proof,
  };
}

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `ACTUAL ${backend} document carrier: Local/HTTP/Remote/embedded return the same authorized shared-builder bytes; no Local HTTP or business writes`,
    { timeout: 60000 },
    async () => {
      await withViewTransport(
        backend,
        async (f) => {
          const input = await launch(f);
          const { documentProof: _, ...cas } = input;
          const raw = await f.local.cognitiveAppViewResource(cas);
          const expected = await createCognitiveDocumentBootstrapFromBytes(
            raw.bytes,
            proof,
          );
          assert.notDeepEqual(expected.bytes, raw.bytes);
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
          for (const connection of [f.local, f.remote]) {
            const count = f.requests.length;
            const value = await connection.cognitiveAppDocumentResource(input);
            assert.equal(value.mime, cognitiveAppDocumentResourceMime);
            assert.deepEqual(value.bytes, expected.bytes);
            if (connection === f.local) assert.equal(f.requests.length, count);
            const embedded = embeddedResources("/nonexistent", connection);
            for (const method of ["GET", "HEAD"]) {
              const count = f.requests.length;
              const response = await embedded(
                new Request(
                  "morphz://app" + cognitiveAppDocumentResourcePath(input),
                  { method },
                ),
              );
              assert.equal(response.status, 200);
              assertHeaders(response, expected.bytes.byteLength);
              assert.deepEqual(
                new Uint8Array(await response.arrayBuffer()),
                method === "HEAD" ? new Uint8Array() : expected.bytes,
              );
              if (connection === f.local)
                assert.equal(
                  f.requests.length,
                  count,
                  "embedded Local does not start or call an HTTP application service",
                );
            }
          }
          for (const method of ["GET", "HEAD"]) {
            const response = await fetch(
              f.origin + cognitiveAppDocumentResourcePath(input),
              { method, headers: { Cookie: f.cookie()! } },
            );
            assert.equal(response.status, 200);
            assertHeaders(response, expected.bytes.byteLength);
            assert.deepEqual(
              new Uint8Array(await response.arrayBuffer()),
              method === "HEAD" ? new Uint8Array() : expected.bytes,
            );
          }
          assert.deepEqual(await rows(), before);
          assert.deepEqual(
            (await f.local.cognitiveAppViewResource(cas)).bytes,
            raw.bytes,
            "the unchanged raw port still returns original author bytes",
          );
        },
        { html: "\uFEFF<!doctype html><p>作者原字节 😀 中文\r\n</p>" },
      );
    },
  );

  test(
    `ACTUAL ${backend} document carrier: stale view CAS and disabled live grant reject through real Local/Remote and embedded ports`,
    { timeout: 60000 },
    async () => {
      await withViewTransport(backend, async (f) => {
        const input = await launch(f);
        for (const connection of [f.local, f.remote])
          await assert.rejects(
            connection.cognitiveAppDocumentResource({
              ...input,
              expectedViewRevision: input.expectedViewRevision + 1,
            }),
            denied(409),
          );
        await f.platform.changeCognitiveAppGrant(
          { credential: "setup-bob" },
          {
            appId: f.launch.appId,
            version: f.launch.version,
            expectedRevision: 1,
            state: "disabled",
          },
        );
        for (const connection of [f.local, f.remote]) {
          await assert.rejects(
            connection.cognitiveAppDocumentResource(input),
            denied(403),
          );
          for (const method of ["GET", "HEAD"]) {
            const response = await embeddedResources(
              "/nonexistent",
              connection,
            )(
              new Request(
                "morphz://app" + cognitiveAppDocumentResourcePath(input),
                { method },
              ),
            );
            assert.equal(response.status, 403);
            assert.doesNotMatch(
              await response.text(),
              /PRIVATE|doctype|作者原字节/,
            );
          }
        }
      });
    },
  );
}

test("UNIT Remote document: exact fixed endpoint, detached ingress, authentication/no-store/redirect and independent 1.5MB UTF-8 budget", async () => {
  const first = new TextEncoder().encode("\uFEFF中文 😀");
  const bytes = new Uint8Array(maxCognitiveAppDocumentHtmlBytes).fill(120);
  bytes.set(first);
  let entered!: () => void, release!: () => void;
  const entry = new Promise<void>((resolve) => (entered = resolve)),
    held = new Promise<void>((resolve) => (release = resolve));
  const urls: string[] = [];
  const remote = new RemoteApplicationConnection(
    "https://unit.invalid",
    async (url, init) => {
      urls.push(String(url));
      assert.equal(init?.credentials, "include");
      assert.equal(init?.redirect, "error");
      assert.equal(init?.cache, "no-store");
      assert.ok(init?.signal);
      entered();
      await held;
      return new Response(bytes, {
        headers: documentHeaders(bytes.byteLength),
      });
    },
  );
  try {
    const mutable = { ...request };
    const pending = remote.cognitiveAppDocumentResource(mutable);
    await entry;
    mutable.viewId = "replacement";
    mutable.documentProof = "replacement_01234567890123456789";
    release();
    assert.deepEqual((await pending).bytes, bytes);
    assert.deepEqual(urls, [
      "https://unit.invalid" + cognitiveAppDocumentResourcePath(request),
    ]);
    assert.equal(Reflect.get(remote, "requests").size, 0);
    await assert.rejects(
      remote.cognitiveAppViewResource({
        viewId: "view",
        expectedViewRevision: 1,
        expectedBindingRevision: 1,
      }),
      denied(502),
      "raw requires its original sandbox CSP, never accepts carrier CSP",
    );
  } finally {
    release();
    remote.close();
  }
});

test("UNIT Remote document: malformed finite ingress rejects before transport and never falls back to raw or legacy resources", async () => {
  let calls = 0,
    getters = 0;
  const remote = new RemoteApplicationConnection(
    "https://unit.invalid",
    async () => {
      calls++;
      throw Error("Unexpected request");
    },
  );
  const accessor = { ...request };
  Object.defineProperty(accessor, "documentProof", {
    enumerable: true,
    get() {
      getters++;
      return proof;
    },
  });
  try {
    for (const value of [
      accessor,
      { ...request, documentProof: "short" },
      { ...request, expectedBindingRevision: 0 },
      { ...request, url: "https://PRIVATE.invalid/" },
      { ...request, principalId: "other-human" },
      { ...request, expectedViewRevision: Number.MAX_SAFE_INTEGER + 1 },
    ])
      await assert.rejects(
        remote.cognitiveAppDocumentResource(value),
        denied(400),
      );
    assert.equal(calls, 0);
    assert.equal(getters, 0);
  } finally {
    remote.close();
  }
});

test("UNIT Remote document: exact policy/MIME/length/fatal UTF-8, stream budget and safe upstream failures", async () => {
  const cases: [Response, number][] = [
    [new Response("PRIVATE", { status: 403 }), 403],
    [
      new Response("ok", {
        headers: { ...documentHeaders(2), "Content-Type": "text/plain" },
      }),
      502,
    ],
    [
      new Response("ok", {
        headers: {
          ...documentHeaders(2),
          "Content-Security-Policy": applicationViewPolicy,
        },
      }),
      502,
    ],
    [
      new Response("ok", {
        headers: { ...documentHeaders(2), "Permissions-Policy": "" },
      }),
      502,
    ],
    [new Response("ok", { headers: documentHeaders(3) }), 502],
    [
      new Response(new Uint8Array([0xc3, 0x28]), {
        headers: documentHeaders(2),
      }),
      502,
    ],
    [
      new Response(new Uint8Array(1_500_001), {
        headers: documentHeaders(1_500_000),
      }),
      413,
    ],
    [new Response("ok", { headers: documentHeaders(1_500_001) }), 413],
    [
      new Response("ok", {
        headers: { ...documentHeaders(2), "Content-Length": "02" },
      }),
      413,
    ],
    [new Response(null, { headers: documentHeaders(2) }), 502],
  ];
  for (const [response, status] of cases) {
    const remote = new RemoteApplicationConnection(
      "https://unit.invalid",
      async () => response,
    );
    try {
      await assert.rejects(
        remote.cognitiveAppDocumentResource(request),
        denied(status),
      );
      assert.equal(Reflect.get(remote, "requests").size, 0);
    } finally {
      remote.close();
    }
  }
  const remote = new RemoteApplicationConnection(
    "https://unit.invalid",
    async () => {
      throw Error("PRIVATE credential failure");
    },
  );
  try {
    await assert.rejects(
      remote.cognitiveAppDocumentResource(request),
      denied(503),
    );
  } finally {
    remote.close();
  }
});

test("UNIT Remote document: monotonic 30s deadline still gates fetch/body/cleanup despite delayed timers", async (context) => {
  const original = Object.getOwnPropertyDescriptor(performance, "now");
  let elapsed = 0;
  Object.defineProperty(performance, "now", {
    configurable: true,
    value: () => elapsed,
  });
  try {
    for (const phase of ["fetch", "body", "cleanup"] as const) {
      elapsed = 0;
      let part = 0,
        cancels = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (phase === "body") elapsed = 30_001;
            if (part++ === 0)
              controller.enqueue(new TextEncoder().encode("ok"));
            else controller.close();
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
          if (phase === "fetch") elapsed = 30_001;
          return new Response(body, { headers: documentHeaders(2) });
        },
      );
      if (phase === "cleanup") {
        const cancel = ReadableStreamDefaultReader.prototype.cancel;
        context.mock.method(
          ReadableStreamDefaultReader.prototype,
          "cancel",
          function (
            this: ReadableStreamDefaultReader<Uint8Array>,
            reason?: unknown,
          ) {
            const result = cancel.call(this, reason);
            elapsed = 30_001;
            return result;
          },
        );
      }
      try {
        await assert.rejects(
          remote.cognitiveAppDocumentResource(request),
          denied(408),
        );
        assert.equal(body.locked, false);
        assert.equal(Reflect.get(remote, "requests").size, 0);
        if (phase !== "cleanup") assert.equal(cancels, 1);
      } finally {
        remote.close();
        context.mock.restoreAll();
      }
    }
  } finally {
    if (original) Object.defineProperty(performance, "now", original);
    else Reflect.deleteProperty(performance, "now");
  }
});

test("UNIT Remote document: close/identity epoch/abort discard a late fetch body before any pull and release its slot", async () => {
  for (const retirement of ["close", "invalidate", "abort"] as const) {
    let pulls = 0,
      cancels = 0;
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>(
      {
        pull(stream) {
          pulls++;
          stream.enqueue(new TextEncoder().encode("PRIVATE"));
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
        else if (retirement === "invalidate") remote.invalidate();
        else controller.abort();
        return new Response(body, { headers: documentHeaders(7) });
      },
    );
    try {
      await assert.rejects(
        remote.cognitiveAppDocumentResource(request, controller.signal),
        denied(retirement === "abort" ? 408 : 403),
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

test("UNIT Remote document: shares the bounded 64-request owner, rejects excess before fetch, and releases every retired request", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  const remote = new RemoteApplicationConnection(
    "https://unit.invalid",
    async () => {
      calls++;
      await held;
      return new Response("ok", { headers: documentHeaders(2) });
    },
  );
  const pending: Promise<unknown>[] = [];
  try {
    for (let count = 0; count < 64; count++)
      pending.push(
        remote.cognitiveAppDocumentResource(request).then(
          () => {
            throw Error("Retired carrier was published");
          },
          (error: unknown) => {
            assert.ok(denied(403)(error));
          },
        ),
      );
    assert.equal(calls, 64);
    assert.equal(Reflect.get(remote, "requests").size, 64);
    await assert.rejects(
      remote.cognitiveAppDocumentResource(request),
      denied(429),
    );
    assert.equal(calls, 64);
    remote.invalidate();
    release();
    await Promise.all(pending);
    assert.equal(Reflect.get(remote, "requests").size, 0);
  } finally {
    remote.close();
    release();
    await Promise.allSettled(pending);
  }
});

test("UNIT Remote document: abort while consuming a stream drops accumulated bytes; preabort never sends", async () => {
  for (const preabort of [false, true]) {
    let calls = 0,
      cancels = 0;
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>(
      {
        pull(stream) {
          stream.enqueue(new TextEncoder().encode("PRIVATE"));
          controller.abort();
        },
        cancel() {
          cancels++;
        },
      },
      { highWaterMark: 0 },
    );
    if (preabort) controller.abort();
    const remote = new RemoteApplicationConnection(
      "https://unit.invalid",
      async () => {
        calls++;
        return new Response(body, { headers: documentHeaders(7) });
      },
    );
    try {
      await assert.rejects(
        remote.cognitiveAppDocumentResource(request, controller.signal),
        denied(408),
      );
      assert.equal(calls, preabort ? 0 : 1);
      assert.equal(cancels, preabort ? 0 : 1);
      assert.equal(body.locked, false);
      assert.equal(Reflect.get(remote, "requests").size, 0);
    } finally {
      remote.close();
    }
  }
});

test("UNIT Remote document: nonsettling cancel cannot hold request capacity or publish bytes", async () => {
  let cancels = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancels++;
      return new Promise<void>(() => {});
    },
  });
  const remote = new RemoteApplicationConnection(
    "https://unit.invalid",
    async () =>
      new Response(body, {
        headers: { ...documentHeaders(7), "Content-Type": "text/plain" },
      }),
  );
  try {
    await Promise.race([
      assert.rejects(remote.cognitiveAppDocumentResource(request), denied(502)),
      new Promise<never>((_, reject) =>
        setImmediate(() =>
          reject(Error("Cancellation retained the request slot")),
        ),
      ),
    ]);
    assert.equal(cancels, 1);
    assert.equal(body.locked, false);
    assert.equal(Reflect.get(remote, "requests").size, 0);
  } finally {
    remote.close();
  }
});

test("UNIT embedded document: strict method/host/three-query scope, missing optional port and preabort have no raw/legacy fallback", async () => {
  let calls = 0,
    raw = 0,
    legacy = 0;
  const connection = {
    async cognitiveAppDocumentResource(input: unknown) {
      calls++;
      assert.deepEqual(input, request);
      return {
        mime: cognitiveAppDocumentResourceMime,
        bytes: new TextEncoder().encode("carrier"),
      } as const;
    },
    async cognitiveAppViewResource() {
      raw++;
      throw Error("Unexpected raw fallback");
    },
    async resource() {
      legacy++;
      throw Error("Unexpected legacy fallback");
    },
  };
  const read = embeddedResources("/nonexistent", connection);
  const url = "morphz://app" + cognitiveAppDocumentResourcePath(request);
  for (const [input, status] of [
    [new Request(url, { method: "POST" }), 405],
    [new Request(url.replace("morphz://app", "morphz://other")), 403],
    [new Request(url + "&url=https://PRIVATE.invalid"), 400],
    [new Request(url + "&documentProof=" + proof), 400],
    [
      new Request(
        url.replace("expectedViewRevision=1", "expectedViewRevision=01"),
      ),
      400,
    ],
    [new Request(url.replace(/\?.*/, "")), 400],
    [new Request(url.replace("/view?", "/view/extra?")), 400],
    [new Request(url + "#fragment"), 400],
  ] as const)
    assert.equal((await read(input)).status, status);
  const abort = new AbortController();
  abort.abort();
  assert.equal(
    (await read(new Request(url, { signal: abort.signal }))).status,
    408,
  );
  assert.equal(
    (
      await embeddedResources("/nonexistent", {
        resource: connection.resource,
        cognitiveAppViewResource: connection.cognitiveAppViewResource,
      })(new Request(url))
    ).status,
    503,
  );
  assert.equal(calls, 0);
  assert.equal(raw, 0);
  assert.equal(legacy, 0);
  for (const method of ["GET", "HEAD"]) {
    const response = await read(new Request(url, { method }));
    assert.equal(response.status, 200);
    assertHeaders(response, 7);
    assert.equal(await response.text(), method === "HEAD" ? "" : "carrier");
  }
  assert.equal(calls, 2);
  assert.equal(raw, 0);
  assert.equal(legacy, 0);
});

test("UNIT embedded document: late cancellation preserves its actual Request signal and withholds returned carrier bytes", async () => {
  const abort = new AbortController();
  const input = new Request(
    "morphz://app" + cognitiveAppDocumentResourcePath(request),
    { signal: abort.signal },
  );
  const read = embeddedResources("/nonexistent", {
    async cognitiveAppDocumentResource(value, signal) {
      assert.deepEqual(value, request);
      assert.equal(signal, input.signal);
      abort.abort();
      return {
        mime: cognitiveAppDocumentResourceMime,
        bytes: new TextEncoder().encode("PRIVATE"),
      };
    },
    async resource() {
      throw Error("No fallback");
    },
  });
  const response = await read(input);
  assert.equal(response.status, 408);
  assert.doesNotMatch(await response.text(), /PRIVATE|doctype/);
});

test("UNIT embedded document: invalid returned MIME/UTF-8/size fails safely, without author HTML or storage fallbacks", async () => {
  const cases = [
    { mime: "text/plain", bytes: new TextEncoder().encode("PRIVATE") },
    {
      mime: cognitiveAppDocumentResourceMime,
      bytes: new Uint8Array([0xc3, 0x28]),
    },
    {
      mime: cognitiveAppDocumentResourceMime,
      bytes: new Uint8Array(1_500_001),
    },
    { mime: cognitiveAppDocumentResourceMime, bytes: new Uint8Array() },
  ];
  for (const value of cases) {
    const read = embeddedResources("/nonexistent", {
      cognitiveAppDocumentResource: async () =>
        value as {
          mime: typeof cognitiveAppDocumentResourceMime;
          bytes: Uint8Array;
        },
      async resource() {
        throw Error("No fallback");
      },
    });
    const response = await read(
      new Request("morphz://app" + cognitiveAppDocumentResourcePath(request)),
    );
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /PRIVATE|doctype/);
  }
});
