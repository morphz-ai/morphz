import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import test from "node:test";
import {
  cognitiveAppDocumentResourceMime,
  cognitiveAppDocumentResourcePath,
  maxCognitiveAppDocumentHtmlBytes,
  type CognitiveAppDocumentResourceRequest,
} from "../packages/core/src/cognitive-app-document-resource.js";
import { cognitiveAppViewResourcePath } from "../packages/core/src/cognitive-app-view-resource.js";
import { applicationMethods } from "../packages/core/src/application-api.js";
import {
  applicationViewPermissions,
  applicationViewPolicy,
} from "../packages/core/src/resource-policy.js";
import { cognitiveDocumentBootstrapPolicy } from "../packages/application/src/cognitive-document-bootstrap.js";
import { ApplicationSession } from "../packages/application/src/application.js";
import { ManagedArtifactStore } from "../packages/managed-artifact-store/src/store.js";
import { withViewTransport } from "./fixtures/cognitive-app-view-transport-fixture.js";
import { prepareConnectionCreation } from "./fixtures/cognitive-connection-creation.js";

type Fixture = Parameters<Parameters<typeof withViewTransport>[1]>[0];
const proof = "http_document_transport_proof_12345";
const encode = (value: string) => new TextEncoder().encode(value);
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
async function launch(f: Fixture) {
  const { receipt } = await f.local.call(
    "cognitive-app-views.launch",
    f.launch,
    {
      identityGeneration: f.localCsrf,
    },
  );
  return {
    viewId: receipt.viewId,
    expectedViewRevision: receipt.viewRevision,
    expectedBindingRevision: receipt.bindingRevision,
    documentProof: proof,
  };
}
async function rows(f: Fixture) {
  const result: Record<string, unknown> = {};
  for (const table of [
    "app_ui_packages",
    "app_installations",
    "cognitive_app_versions",
    "cognitive_app_grants",
    "cognitive_app_connections",
    "app_view_instances",
    "cognitive_app_view_bindings",
    "cognitive_app_commands",
    "content_entries",
    "command_receipts",
    "projects",
    "project_members",
    "team_identity_config",
    "team_login_sessions",
    "cognitive_app_authorities",
    "app_instances",
  ])
    result[table] = await f.q.all(`SELECT * FROM ${table}`);
  return result;
}
function watchBusiness(f: Fixture) {
  const calls: string[] = [];
  for (const method of ["describe", "invoke", "readObject", "recover"]) {
    const original = Reflect.get(f.host.service, method);
    Reflect.set(f.host.service, method, (...args: unknown[]) => {
      calls.push(method);
      return Reflect.apply(original, f.host.service, args);
    });
  }
  return calls;
}
function headers(response: Response, length: number) {
  assert.equal(
    response.headers.get("content-type"),
    cognitiveAppDocumentResourceMime,
  );
  assert.equal(response.headers.get("content-length"), String(length));
  assert.equal(
    response.headers.get("content-security-policy"),
    cognitiveDocumentBootstrapPolicy,
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
  assert.equal(
    (response.headers.get("content-security-policy") ?? "")
      .split(";")
      .some((directive) => /^sandbox(?:\s|$)/.test(directive.trim())),
    false,
    "The fixed outer wrapper does not inherit the raw author's CSP sandbox directive.",
  );
}
function authorPayload(bytes: Uint8Array) {
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  const matches = [...text.matchAll(/atob\("([A-Za-z0-9+/=]+)"\)/g)];
  assert.equal(
    matches.length,
    1,
    "Read the actual fixed builder's encoded author bytes.",
  );
  return new Uint8Array(Buffer.from(matches[0]![1]!, "base64"));
}
function cleanCapabilities(f: Fixture) {
  assert.equal(Reflect.get(f.ui, "scopes").size, 0);
  assert.equal(Reflect.get(f.human, "issued").size, 0);
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, label: string) {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Missing actual ${label}`)),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
/** Preserve actual WebCrypto's result; only delay delivery after the real
 * SHA-256 has completed. This covers the new await, not the old Store wait. */
function holdActualDigest(expected: Uint8Array) {
  const original = crypto.subtle.digest;
  const entry = deferred(),
    hold = deferred();
  let calls = 0;
  crypto.subtle.digest = async function (algorithm, data) {
    const digest = await original.call(this, algorithm, data);
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    if (sha(bytes) === sha(expected)) {
      assert.deepEqual(bytes, expected);
      assert.equal(Buffer.from(digest).toString("hex"), sha(expected));
      calls++;
      entry.resolve();
      await hold.promise;
    }
    return digest;
  };
  return {
    entry: entry.promise,
    release: () => hold.resolve(),
    calls: () => calls,
    restore: () => {
      crypto.subtle.digest = original;
    },
  };
}
type Retirement =
  | "grant"
  | "grant-cycle"
  | "view-close"
  | "rebind"
  | "connection"
  | "membership"
  | "logout";
async function retire(
  f: Fixture,
  request: CognitiveAppDocumentResourceRequest,
  event: Retirement,
) {
  const { documentProof: _proof, ...cas } = request;
  if (event === "grant" || event === "grant-cycle") {
    await f.platform.changeCognitiveAppGrant(
      { credential: "setup-bob" },
      {
        appId: f.launch.appId,
        version: f.launch.version,
        expectedRevision: 1,
        state: "disabled",
      },
    );
    if (event === "grant-cycle")
      await f.platform.changeCognitiveAppGrant(
        { credential: "setup-bob" },
        {
          appId: f.launch.appId,
          version: f.launch.version,
          expectedRevision: 2,
          state: "active",
        },
      );
  } else if (event === "view-close") {
    await f.platform.changeCognitiveAppView(
      { credential: "setup-bob" },
      { ...cas, commandId: "close-during-document", close: true },
    );
  } else if (event === "rebind") {
    await f.platform.bindCognitiveAppView(
      { credential: "setup-bob" },
      {
        ...f.launch,
        ...cas,
        commandId: "rebind-during-document",
        connectionId: f.other.connectionId,
        expectedConnectionRevision: f.other.revision,
      },
    );
  } else if (event === "connection") {
    await f.platform.changeCognitiveAppConnectionState(
      { credential: "setup-bob" },
      {
        appId: f.launch.appId,
        version: f.launch.version,
        connectionId: f.connection.connectionId,
        expectedRevision: f.connection.revision,
        state: "disabled",
      },
    );
  } else if (event === "membership") {
    // Isolated authority fixture mutation, not a public delete/permission API.
    await f.q.change(
      "DELETE FROM project_members WHERE tenant_id=? AND project_id=? AND principal_id=?",
      [f.tenantId, "project-a", "bob"],
    );
  } else {
    const session = f.identity.authenticate(f.cookie());
    assert.ok(session);
    await f.identity.logout(session.sessionHash);
  }
}

// Actual dedicated SQLite/PostgreSQL, IdentityCenter, HPA, Managed Store and
// HTTP. Connection describe admission is the existing fixture port, not real
// author-network, Runtime, Electron or original-user-window acceptance.
for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `ACTUAL ${backend} document HTTP GET/HEAD: fixed wrapper, exact original bytes and unchanged raw/public contract`,
    { timeout: 60000 },
    async () =>
      withViewTransport(
        backend,
        async (f) => {
          const request = await launch(f);
          const business = watchBusiness(f);
          const before = await rows(f);
          const path = cognitiveAppDocumentResourcePath(request);
          const response = await fetch(f.origin + path, {
            headers: { Cookie: f.cookie()! },
          });
          assert.equal(
            response.status,
            200,
            "The genuine document HTTP ingress must exist.",
          );
          const wrapped = new Uint8Array(await response.arrayBuffer());
          assert.ok(
            wrapped.byteLength > encode(f.input.manifest.ui.html).byteLength,
          );
          assert.ok(wrapped.byteLength <= maxCognitiveAppDocumentHtmlBytes);
          headers(response, wrapped.byteLength);
          const author = authorPayload(wrapped);
          assert.deepEqual(author, encode(f.input.manifest.ui.html));
          assert.equal(sha(author), f.input.definition.ui!.sha256);
          const head = await fetch(f.origin + path, {
            method: "HEAD",
            headers: { Cookie: f.cookie()! },
          });
          assert.equal(head.status, 200);
          headers(head, wrapped.byteLength);
          assert.equal((await head.arrayBuffer()).byteLength, 0);
          const { documentProof: _proof, ...cas } = request;
          const original = await f.local.call(
            "cognitive-app-views.read-ui",
            cas,
            { identityGeneration: f.localCsrf },
          );
          assert.deepEqual(original.manifest, f.input.manifest);
          const raw = await fetch(
            f.origin + cognitiveAppViewResourcePath(cas),
            { headers: { Cookie: f.cookie()! } },
          );
          assert.equal(raw.status, 200);
          assert.equal(
            raw.headers.get("content-security-policy"),
            applicationViewPolicy,
          );
          assert.deepEqual(new Uint8Array(await raw.arrayBuffer()), author);
          assert.equal(
            applicationMethods.some((method) =>
              method.includes("cognitive-app-document"),
            ),
            false,
          );
          assert.deepEqual(await rows(f), before);
          assert.deepEqual(business, []);
          cleanCapabilities(f);
        },
        {
          html: '\ufeff<!doctype html><meta charset="utf-8"><h1>原作者 😀中文\r\n</h1>',
        },
      ),
  );

  test(
    `ACTUAL ${backend} document HTTP: strict finite URL, identity/site gates and unsafe methods never reach the document pipeline`,
    { timeout: 60000 },
    async () =>
      withViewTransport(backend, async (f) => {
        const request = await launch(f);
        const path = cognitiveAppDocumentResourcePath(request);
        const base = "/api/cognitive-app-document/" + request.viewId;
        const suffix = "&documentProof=" + proof;
        const invalid = [
          "/api/cognitive-app-document",
          "/api/cognitive-app-document/",
          `${base}?expectedViewRevision=01&expectedBindingRevision=1${suffix}`,
          `${base}?expectedViewRevision=1e0&expectedBindingRevision=1${suffix}`,
          `${base}?expectedViewRevision=+1&expectedBindingRevision=1${suffix}`,
          `${base}?expectedViewRevision=9007199254740991&expectedBindingRevision=1${suffix}`,
          `${path}&expectedViewRevision=1`,
          `${path}&documentProof=${proof}`,
          `${path}&owner=alice`,
          `${base}?expectedViewRevision=1&expectedBindingRevision=1`,
          `${base}?expectedViewRevision=1&documentProof=${proof}`,
          `${base}?expectedViewRevision=1&expectedBindingRevision=1&documentProof=short`,
          `${base}?expectedViewRevision=1&expectedBindingRevision=1&documentProof=${"a".repeat(129)}`,
          `${base}?expectedViewRevision=1&expectedBindingRevision=1&documentProof=${proof}%2F`,
          `${base}/extra?expectedViewRevision=1&expectedBindingRevision=1${suffix}`,
          `/api/cognitive-app-document/%76iew-bob?expectedViewRevision=1&expectedBindingRevision=1${suffix}`,
        ];
        let pipelineCalls = 0;
        const original =
          ApplicationSession.prototype.cognitiveAppDocumentResource;
        ApplicationSession.prototype.cognitiveAppDocumentResource = function (
          ...args
        ) {
          pipelineCalls++;
          return original.apply(this, args);
        };
        const business = watchBusiness(f),
          before = await rows(f);
        try {
          for (const candidate of invalid)
            for (const method of ["GET", "HEAD"]) {
              const response = await fetch(f.origin + candidate, {
                method,
                headers: { Cookie: f.cookie()! },
              });
              assert.equal(response.status, 400, candidate);
              if (method === "HEAD")
                assert.equal((await response.arrayBuffer()).byteLength, 0);
              else assert.equal((await response.json()).code, "invalid");
            }
          // Fetch omits URL fragments; hash rejection is only a Core-parser test,
          // never claimed as an HTTP observation here.
          const replacements: Array<Record<string, string>> = [
            { Cookie: "" },
            { Cookie: f.cookie()!, Origin: "https://evil.invalid" },
            { Cookie: f.cookie()!, "Sec-Fetch-Site": "cross-site" },
          ];
          for (const replacement of replacements)
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
              else await response.arrayBuffer();
            }
          // Node fetch does not guarantee a supplied Host override reaches the
          // wire. Use real http.request for this transport-header assertion.
          for (const method of ["GET", "HEAD"])
            await new Promise<void>((resolve, reject) => {
              const client = httpRequest(
                f.origin + path,
                {
                  method,
                  headers: { Cookie: f.cookie()!, Host: "wrong.invalid" },
                },
                (response) => {
                  try {
                    assert.equal(response.statusCode, 403);
                  } catch (error) {
                    reject(error);
                  }
                  let length = 0;
                  response.on("data", (chunk) => {
                    length += chunk.length;
                  });
                  response.once("end", () => {
                    try {
                      if (method === "HEAD") assert.equal(length, 0);
                      resolve();
                    } catch (error) {
                      reject(error);
                    }
                  });
                },
              );
              client.once("error", reject);
              client.end();
            });
          for (const method of ["POST", "PUT", "DELETE", "PATCH"])
            assert.equal(
              (
                await fetch(f.origin + path, {
                  method,
                  headers: { Cookie: f.cookie()! },
                })
              ).status,
              405,
            );
          assert.equal(pipelineCalls, 0);
          assert.deepEqual(await rows(f), before);
          assert.deepEqual(business, []);
          cleanCapabilities(f);
        } finally {
          ApplicationSession.prototype.cognitiveAppDocumentResource = original;
        }
      }),
  );

  test(
    `ACTUAL ${backend} document HTTP: foreign owner and stale CAS cannot disclose even with a valid correlation proof`,
    { timeout: 60000 },
    async () =>
      withViewTransport(backend, async (f) => {
        const own = await launch(f);
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
                  hostBindingId: "private_alice",
                },
              },
            ),
          );
        const foreign = await f.platform.launchCognitiveAppView(
          { credential: "setup-alice" },
          {
            ...f.launch,
            commandId: "alice-document-view",
            connectionId: connection.connectionId,
            expectedConnectionRevision: connection.revision,
          },
        );
        const candidates = [
          {
            request: {
              viewId: foreign.receipt.viewId,
              expectedViewRevision: foreign.receipt.viewRevision,
              expectedBindingRevision: foreign.receipt.bindingRevision,
              documentProof: proof,
            },
            status: 404,
          },
          {
            request: {
              ...own,
              expectedViewRevision: own.expectedViewRevision + 1,
            },
            status: 409,
          },
          {
            request: {
              ...own,
              expectedBindingRevision: own.expectedBindingRevision + 1,
            },
            status: 409,
          },
        ];
        const business = watchBusiness(f),
          before = await rows(f);
        const store: unknown = Reflect.get(f.ui, "store");
        assert.ok(store instanceof ManagedArtifactStore);
        const read = store.readRange.bind(store),
          digest = crypto.subtle.digest;
        let actualReads = 0,
          actualDigests = 0;
        store.readRange = async (...args) => {
          actualReads++;
          return read(...args);
        };
        crypto.subtle.digest = async function (...args) {
          actualDigests++;
          return digest.apply(this, args);
        };
        try {
          for (const candidate of candidates)
            for (const method of ["GET", "HEAD"]) {
              const response = await fetch(
                f.origin + cognitiveAppDocumentResourcePath(candidate.request),
                { method, headers: { Cookie: f.cookie()! } },
              );
              assert.equal(response.status, candidate.status);
              const body = await response.text();
              if (method === "HEAD") assert.equal(body, "");
              else {
                assert.equal(
                  JSON.parse(body).code,
                  candidate.status === 404 ? "not_found" : "conflict",
                );
                assert.doesNotMatch(
                  body,
                  /doctype|atob|private_|database\/|service\/|credential|artifact_id/i,
                );
              }
            }
          assert.equal(actualReads, 0);
          assert.equal(actualDigests, 0);
          assert.deepEqual(await rows(f), before);
          assert.deepEqual(business, []);
          cleanCapabilities(f);
        } finally {
          store.readRange = read;
          crypto.subtle.digest = digest;
        }
      }),
  );

  test(
    `ACTUAL ${backend} document HTTP: the unchanged one-million-byte author expands inside the independent wrapper budget`,
    { timeout: 60000 },
    async () => {
      const first = '\ufeff<!doctype html><meta charset="utf-8"><p>😀中文\r\n',
        last = "</p>\r\n";
      const html =
        first + "x".repeat(1_000_000 - encode(first + last).byteLength) + last;
      await withViewTransport(
        backend,
        async (f) => {
          const request = await launch(f),
            before = await rows(f);
          const response = await fetch(
            f.origin + cognitiveAppDocumentResourcePath(request),
            { headers: { Cookie: f.cookie()! } },
          );
          assert.equal(response.status, 200);
          const bytes = new Uint8Array(await response.arrayBuffer());
          assert.ok(
            bytes.byteLength > 1_000_000 &&
              bytes.byteLength <= maxCognitiveAppDocumentHtmlBytes,
          );
          headers(response, bytes.byteLength);
          assert.deepEqual(authorPayload(bytes), encode(html));
          const head = await fetch(
            f.origin + cognitiveAppDocumentResourcePath(request),
            { method: "HEAD", headers: { Cookie: f.cookie()! } },
          );
          assert.equal(head.status, 200);
          headers(head, bytes.byteLength);
          assert.equal((await head.arrayBuffer()).byteLength, 0);
          assert.deepEqual(await rows(f), before);
          cleanCapabilities(f);
        },
        { html },
      );
    },
  );

  for (const method of ["GET", "HEAD"] as const)
    for (const event of [
      "grant",
      "grant-cycle",
      "view-close",
      "rebind",
      "connection",
      "membership",
      "logout",
    ] as const)
      test(
        `ACTUAL ${backend} document HTTP ${method}: ${event} after real digest completes retires disclosure`,
        { timeout: 60000 },
        async () =>
          withViewTransport(backend, async (f) => {
            const request = await launch(f),
              business = watchBusiness(f);
            const gate = holdActualDigest(encode(f.input.manifest.ui.html));
            const pending = fetch(
              f.origin + cognitiveAppDocumentResourcePath(request),
              { method, headers: { Cookie: f.cookie()! } },
            );
            const outcome = pending.then(
              (response) => ({ response }),
              (error) => ({ error }),
            );
            try {
              await bounded(
                Promise.race([
                  gate.entry,
                  outcome.then((result) => {
                    throw "error" in result
                      ? result.error
                      : new Error(
                          `No actual digest: HTTP ${result.response.status}`,
                        );
                  }),
                ]),
                "digest barrier",
              );
              await retire(f, request, event);
              const afterDeliberateMutation = await rows(f);
              gate.release();
              const result = await bounded(outcome, "HTTP retirement result");
              if ("error" in result) throw result.error;
              const expected = ["view-close", "rebind", "grant-cycle"].includes(
                event,
              )
                ? 409
                : 403;
              assert.equal(result.response.status, expected);
              assert.notEqual(
                result.response.headers.get("content-security-policy"),
                cognitiveDocumentBootstrapPolicy,
              );
              const body = await result.response.text();
              if (method === "HEAD") assert.equal(body, "");
              else {
                assert.equal(
                  JSON.parse(body).code,
                  expected === 409 ? "conflict" : "forbidden",
                );
                assert.doesNotMatch(
                  body,
                  /doctype|atob|private_|database\/|service\/|credential|artifact_id|<h1>/i,
                );
              }
              await f.host.close();
              assert.equal(gate.calls(), 1);
              assert.deepEqual(
                await rows(f),
                afterDeliberateMutation,
                "The document task adds no rows or permission changes after intentional retirement.",
              );
              assert.deepEqual(business, []);
              cleanCapabilities(f);
            } finally {
              gate.release();
              await outcome;
              gate.restore();
            }
          }),
      );

  test(
    `ACTUAL ${backend} document HTTP: socket abort at the actual digest wait reaches the same task signal and releases scopes`,
    { timeout: 60000 },
    async () =>
      withViewTransport(backend, async (f) => {
        const request = await launch(f),
          business = watchBusiness(f),
          before = await rows(f);
        const gate = holdActualDigest(encode(f.input.manifest.ui.html));
        const completed = deferred(),
          aborted = deferred();
        const original =
          ApplicationSession.prototype.cognitiveAppDocumentResource;
        let actualSignal: AbortSignal | undefined,
          calls = 0;
        ApplicationSession.prototype.cognitiveAppDocumentResource =
          async function (...args) {
            calls++;
            actualSignal = args[1];
            actualSignal?.addEventListener("abort", () => aborted.resolve(), {
              once: true,
            });
            try {
              return await original.apply(this, args);
            } finally {
              completed.resolve();
            }
          };
        let status: number | undefined;
        const client = httpRequest(
          f.origin + cognitiveAppDocumentResourcePath(request),
          { headers: { Cookie: f.cookie()! } },
        );
        const stopped = new Promise<void>((resolve, reject) => {
          client.once("response", (response) => {
            status = response.statusCode;
            response.resume();
            response.once("end", resolve);
          });
          client.once("error", (error) => {
            if ((error as NodeJS.ErrnoException).code === "ECONNRESET")
              resolve();
            else reject(error);
          });
        });
        const outcome = stopped.then(
          () => ({ ok: true }) as const,
          (error) => ({ ok: false, error }) as const,
        );
        client.end();
        try {
          await bounded(
            Promise.race([
              gate.entry,
              outcome.then(() => {
                throw new Error("Socket finished before actual digest");
              }),
            ]),
            "socket digest barrier",
          );
          assert.ok(actualSignal instanceof AbortSignal);
          client.destroy();
          await bounded(aborted.promise, "server-side cancellation signal");
          assert.equal(actualSignal.aborted, true);
          gate.release();
          await bounded(completed.promise, "actual session task completion");
          const result = await outcome;
          if (!result.ok) throw result.error;
          await f.host.close();
          assert.equal(
            status,
            undefined,
            "An aborted peer did not receive document response headers.",
          );
          assert.equal(calls, 1);
          assert.equal(gate.calls(), 1);
          assert.deepEqual(await rows(f), before);
          assert.deepEqual(business, []);
          cleanCapabilities(f);
        } finally {
          client.destroy();
          gate.release();
          await outcome;
          await f.host.close();
          gate.restore();
          ApplicationSession.prototype.cognitiveAppDocumentResource = original;
        }
      }),
  );
}
