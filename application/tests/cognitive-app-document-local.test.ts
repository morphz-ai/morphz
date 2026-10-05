import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import {
  ApplicationRequestError,
  applicationMethods,
} from "../packages/core/src/application-api.js";
import { parseCognitiveAppDocumentResourceRequest } from "../packages/core/src/cognitive-app-document-resource.js";
import { withViewTransport } from "./fixtures/cognitive-app-view-transport-fixture.js";
import { createCognitiveDocumentBootstrapFromBytes } from "../packages/application/src/cognitive-document-bootstrap.js";

const proof = "document_local_proof_0123456789";
type Fixture = Parameters<Parameters<typeof withViewTransport>[1]>[0];
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

function digestHold(t: TestContext, author: Uint8Array) {
  const actual = crypto.subtle.digest.bind(crypto.subtle);
  let enter!: () => void,
    release!: () => void,
    calls = 0;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const hold = new Promise<void>((resolve) => (release = resolve));
  const digest = t.mock.method(
    crypto.subtle,
    "digest",
    async (...args: Parameters<typeof crypto.subtle.digest>) => {
      // Compute real native SHA first; only its actual returned result is held.
      const result = await actual(...args);
      assert.equal(
        Buffer.from(result).toString("hex"),
        createHash("sha256").update(author).digest("hex"),
      );
      calls++;
      enter();
      await hold;
      return result;
    },
  );
  return {
    entered,
    release,
    calls: () => calls,
    restore: () => digest.mock.restore(),
  };
}
function denied(error: unknown, status: number) {
  assert.ok(error instanceof ApplicationRequestError);
  assert.equal(error.status, status);
  assert.doesNotMatch(
    error.message,
    /PRIVATE|credential|setup-|doctype|database\/|service\//,
  );
  return true;
}
function clean(f: Fixture) {
  assert.equal(Reflect.get(f.ui, "scopes").size, 0);
  assert.equal(Reflect.get(f.human, "issued").size, 0);
  assert.equal(Reflect.get(f.local, "requests").size, 0);
}

for (const backend of ["sqlite", "postgres"] as const)
  test(
    `ACTUAL ${backend} Local document: shared authenticated wrapper preserves original raw bytes and leaves SQL unchanged`,
    { timeout: 60000 },
    async () => {
      await withViewTransport(backend, async (f) => {
        const request = await launch(f);
        const author = new TextEncoder().encode(f.input.manifest.ui.html);
        const expected = await createCognitiveDocumentBootstrapFromBytes(
          author,
          proof,
        );
        assert.equal(
          expected.authorSha256,
          createHash("sha256").update(author).digest("hex"),
        );
        const rows = async () => {
          const result: Record<string, unknown> = {};
          for (const table of [
            "app_ui_packages",
            "app_view_instances",
            "cognitive_app_view_bindings",
            "cognitive_app_commands",
            "content_entries",
            "cognitive_app_grants",
            "cognitive_app_connections",
          ])
            result[table] = await f.q.all(`SELECT * FROM ${table}`);
          return result;
        };
        const before = await rows();
        const document = await f.local.cognitiveAppDocumentResource(request);
        assert.deepEqual(Object.keys(document).sort(), ["bytes", "mime"]);
        assert.equal(document.mime, expected.mime);
        assert.deepEqual(document.bytes, expected.bytes);
        const raw = await f.local.cognitiveAppViewResource({
          viewId: request.viewId,
          expectedViewRevision: request.expectedViewRevision,
          expectedBindingRevision: request.expectedBindingRevision,
        });
        assert.deepEqual(raw.bytes, author);
        assert.deepEqual(await rows(), before);
        clean(f);
      });
    },
  );

for (const backend of ["sqlite", "postgres"] as const) {
  for (const event of [
    "grant",
    "grant-cycle",
    "connection",
    "member",
    "view-close",
    "rebind",
    "package-metadata",
    "logout",
    "connection-close",
    "abort",
    "hpa-expiry",
    "host-close",
  ] as const)
    test(
      `ACTUAL ${backend} Local document: ${event} after actual SHA computation retires disclosure under the SAME HPA`,
      { timeout: 60000 },
      async (t) => {
        await withViewTransport(backend, async (f) => {
          const request = await launch(f);
          const author = new TextEncoder().encode(f.input.manifest.ui.html);
          const hold = digestHold(t, author),
            abort = new AbortController();
          const credentials: string[] = [];
          const prepare = f.platform.prepareCognitiveAppUiRead.bind(f.platform);
          f.platform.prepareCognitiveAppUiRead = async (actor, input) => {
            credentials.push(actor.credential);
            return prepare(actor, input);
          };
          let now = 1000;
          Reflect.set(f.human, "now", () => now);
          let serviceCalls = 0;
          t.mock.method(f.host.service, "invoke", async () => {
            serviceCalls++;
            throw new Error("Unexpected business service call");
          });
          const pending = f.local.cognitiveAppDocumentResource(
            request,
            abort.signal,
          );
          const outcome = pending.then(
            () => ({ ok: true }) as const,
            (error: unknown) => ({ ok: false, error }) as const,
          );
          let closing: Promise<void> | undefined;
          try {
            await Promise.race([
              hold.entered,
              outcome.then((result) => {
                if (result.ok) throw new Error("Expected held actual digest");
                throw result.error;
              }),
            ]);
            assert.equal(
              Reflect.get(f.human, "issued").size,
              1,
              "same authority remains alive across SHA await",
            );
            assert.equal(Reflect.get(f.ui, "scopes").size, 1);
            assert.equal(Reflect.get(f.local, "requests").size, 1);
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
            } else if (event === "connection") {
              await f.platform.changeCognitiveAppConnectionState(
                { credential: "setup-bob" },
                {
                  appId: f.launch.appId,
                  version: f.launch.version,
                  expectedDefinitionHash: f.installed.definitionHash,
                  expectedGrantRevision: 1,
                  connectionId: f.connection.connectionId,
                  expectedRevision: f.connection.revision,
                  state: "disabled",
                },
              );
            } else if (event === "member") {
              await f.q.change(
                "DELETE FROM project_members WHERE tenant_id=? AND project_id='project-a' AND principal_id='bob'",
                [f.tenantId],
              );
            } else if (event === "view-close") {
              const { documentProof: _proof, ...cas } = request;
              await f.platform.changeCognitiveAppView(
                { credential: "setup-bob" },
                { ...cas, commandId: "close-during-document", close: true },
              );
            } else if (event === "rebind") {
              const { documentProof: _proof, ...cas } = request;
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
            } else if (event === "package-metadata") {
              await f.q.change(
                "UPDATE app_ui_packages SET installed_at=? WHERE tenant_id=? AND app_id=? AND package_version=?",
                [
                  "2040-01-01T00:00:00.000Z",
                  f.tenantId,
                  f.launch.appId,
                  f.launch.version,
                ],
              );
            } else if (event === "logout") {
              const identity = f.identity.authenticate(
                f.local.authenticationCookie(),
              );
              assert.ok(identity);
              await f.identity.logout(identity.sessionHash);
            } else if (event === "connection-close") f.local.close();
            else if (event === "abort") abort.abort();
            else if (event === "hpa-expiry") now += 60000;
            else {
              let closed = false;
              closing = f.host.close().then(() => {
                closed = true;
              });
              await setImmediate();
              assert.equal(
                closed,
                false,
                "Host close awaits actual held task cleanup, not just socket abortion",
              );
            }
          } finally {
            hold.release();
            hold.restore();
          }
          const result = await outcome;
          assert.equal(
            result.ok,
            false,
            "no stale prepared HTML may escape after any actual gate change",
          );
          if (!result.ok)
            denied(
              result.error,
              event === "abort"
                ? 408
                : [
                      "grant-cycle",
                      "view-close",
                      "rebind",
                      "package-metadata",
                    ].includes(event)
                  ? 409
                  : 403,
            );
          await closing;
          assert.equal(hold.calls(), 1);
          assert.equal(
            new Set(credentials).size,
            1,
            "post-digest full gate must reuse the SAME actual HPA credential",
          );
          assert.ok(
            credentials.length >=
              (event === "abort" || event === "host-close" ? 2 : 3),
          );
          clean(f);
          assert.equal(serviceCalls, 0);
          assert.deepEqual(
            await f.q.all("SELECT * FROM cognitive_app_commands"),
            [],
          );
          assert.deepEqual(await f.q.all("SELECT * FROM content_entries"), []);
        });
      },
    );

  test(
    `ACTUAL ${backend} Local document: strict DTO rejects accessors/authority, aborts before identity and snapshots proof across real verifier wait`,
    { timeout: 60000 },
    async () => {
      await withViewTransport(backend, async (f) => {
        const request = await launch(f);
        let getters = 0,
          resolves = 0;
        f.control.beforeResolve = async () => {
          resolves++;
        };
        const accessor = { ...request };
        Object.defineProperty(accessor, "documentProof", {
          enumerable: true,
          get() {
            getters++;
            return proof;
          },
        });
        for (const raw of [
          accessor,
          { ...request, actor: { credential: "setup-alice" } },
          { ...request, documentProof: "x" },
          { ...request, expectedViewRevision: 0 },
        ])
          await assert.rejects(
            f.local.cognitiveAppDocumentResource(raw),
            (error) => denied(error, 400),
          );
        const abort = new AbortController();
        abort.abort();
        await assert.rejects(
          f.local.cognitiveAppDocumentResource(request, abort.signal),
          (error) => denied(error, 408),
        );
        assert.equal(getters, 0);
        assert.equal(resolves, 0);
        assert.equal(
          applicationMethods.some((method) =>
            /document-resource|cognitive-app-document/.test(method),
          ),
          false,
        );
        let enter!: () => void, release!: () => void;
        const entered = new Promise<void>((resolve) => (enter = resolve)),
          hold = new Promise<void>((resolve) => (release = resolve));
        let first = true;
        f.control.beforeResolve = async () => {
          if (first) {
            first = false;
            enter();
            await hold;
          }
        };
        const expectedRequest =
          parseCognitiveAppDocumentResourceRequest(request);
        const pending = f.local.cognitiveAppDocumentResource(request);
        const outcome = pending.then(
          (value) => ({ ok: true, value }) as const,
          (error: unknown) => ({ ok: false, error }) as const,
        );
        try {
          await Promise.race([
            entered,
            outcome.then((result) => {
              if (result.ok) throw new Error("Expected actual verifier await");
              throw result.error;
            }),
          ]);
          request.documentProof = "different_proof_0123456789012345";
          request.viewId = "other-view";
          request.expectedViewRevision = 999;
        } finally {
          release();
        }
        const result = await outcome;
        assert.ok(result.ok);
        const expected = await createCognitiveDocumentBootstrapFromBytes(
          new TextEncoder().encode(f.input.manifest.ui.html),
          expectedRequest.documentProof,
        );
        assert.deepEqual(result.value.bytes, expected.bytes);
        clean(f);
      });
    },
  );

  test(
    `ACTUAL ${backend} Local document: 64 actual held digests occupy the original shared request budget and all abort cleanly`,
    { timeout: 60000 },
    async (t) => {
      await withViewTransport(backend, async (f) => {
        const request = await launch(f),
          abort = new AbortController();
        const author = new TextEncoder().encode(f.input.manifest.ui.html);
        const digest = crypto.subtle.digest.bind(crypto.subtle);
        let release!: () => void,
          enter!: () => void,
          calls = 0;
        const hold = new Promise<void>((resolve) => (release = resolve)),
          entered = new Promise<void>((resolve) => (enter = resolve));
        const patched = t.mock.method(
          crypto.subtle,
          "digest",
          async (...args: Parameters<typeof crypto.subtle.digest>) => {
            const result = await digest(...args);
            assert.equal(
              Buffer.from(result).toString("hex"),
              createHash("sha256").update(author).digest("hex"),
            );
            if (++calls === 64) enter();
            await hold;
            return result;
          },
        );
        const outcomes = Array.from({ length: 64 }, () =>
          f.local.cognitiveAppDocumentResource(request, abort.signal).then(
            () => ({ ok: true }) as const,
            (error: unknown) => ({ ok: false, error }) as const,
          ),
        );
        try {
          await Promise.race([
            entered,
            ...outcomes.map((outcome) =>
              outcome.then((result) => {
                if (result.ok)
                  throw new Error("Expected all actual digests held");
                throw result.error;
              }),
            ),
          ]);
          assert.equal(Reflect.get(f.local, "requests").size, 64);
          assert.equal(Reflect.get(f.human, "issued").size, 64);
          assert.equal(Reflect.get(f.ui, "scopes").size, 64);
          await assert.rejects(
            f.local.cognitiveAppDocumentResource(request),
            (error) => denied(error, 429),
          );
          const { documentProof: _proof, ...cas } = request;
          await assert.rejects(f.local.cognitiveAppViewResource(cas), (error) =>
            denied(error, 429),
          );
          await assert.rejects(
            f.local.call("cognitive-app-views.read-ui", cas, {
              identityGeneration: f.localCsrf,
            }),
            // The original public invocation contract reports a saturated or
            // duplicate request as invalid/400; preserve it, do not silently
            // change that behavior while adding the private document carrier.
            (error) => denied(error, 400),
          );
          assert.equal(Reflect.get(f.local, "requests").size, 64);
          abort.abort();
        } finally {
          release();
          patched.mock.restore();
        }
        for (const result of await Promise.all(outcomes)) {
          assert.equal(result.ok, false);
          if (!result.ok) denied(result.error, 408);
        }
        clean(f);
        const { documentProof: _proof, ...cas } = request;
        assert.deepEqual(
          (await f.local.cognitiveAppViewResource(cas)).bytes,
          author,
        );
        assert.deepEqual(
          await f.q.all("SELECT * FROM cognitive_app_commands"),
          [],
        );
      });
    },
  );

  test(
    `ACTUAL ${backend} private document: actual actor and nonce snapshot survive real verifier suspension`,
    { timeout: 60000 },
    async () => {
      await withViewTransport(backend, async (f) => {
        const request = await launch(f),
          actor = { credential: "setup-bob" };
        let release!: () => void,
          enter!: () => void,
          first = true;
        const hold = new Promise<void>((resolve) => (release = resolve)),
          entered = new Promise<void>((resolve) => (enter = resolve));
        f.control.beforeResolve = async () => {
          if (first) {
            first = false;
            enter();
            await hold;
          }
        };
        const pending = f.ui.readCognitiveDocument(actor, request);
        const outcome = pending.then(
          (value) => ({ ok: true, value }) as const,
          (error: unknown) => ({ ok: false, error }) as const,
        );
        try {
          await Promise.race([
            entered,
            outcome.then((result) => {
              if (result.ok) throw new Error("Expected actual verifier wait");
              throw result.error;
            }),
          ]);
          actor.credential = "setup-alice";
          request.documentProof = "different_proof_0123456789012345";
          request.viewId = "foreign-view";
        } finally {
          release();
        }
        const result = await outcome;
        assert.ok(result.ok);
        const expected = await createCognitiveDocumentBootstrapFromBytes(
          new TextEncoder().encode(f.input.manifest.ui.html),
          proof,
        );
        assert.deepEqual(result.value.bytes, expected.bytes);
        clean(f);
      });
    },
  );

  test(
    `ACTUAL ${backend} Local document: BOM and exact one-million multibyte author bytes retain original SHA under the separate wrapper budget`,
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
      await withViewTransport(
        backend,
        async (f) => {
          const request = {
            ...(await launch(f)),
            documentProof: "p".repeat(128),
          };
          const bytes = new TextEncoder().encode(html);
          const expected = await createCognitiveDocumentBootstrapFromBytes(
            bytes,
            request.documentProof,
          );
          assert.equal(bytes.byteLength, 1_000_000);
          assert.equal(expected.authorSha256, f.input.definition.ui!.sha256);
          assert.deepEqual(expected.authorBytes, bytes);
          const result = await f.local.cognitiveAppDocumentResource(request);
          assert.deepEqual(result.bytes, expected.bytes);
          assert.ok(
            result.bytes.byteLength > bytes.byteLength &&
              result.bytes.byteLength <= 1_500_000,
          );
          clean(f);
        },
        { html },
      );
    },
  );
}
