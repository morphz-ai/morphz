import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  cognitiveAppDocumentResourceMime,
  cognitiveAppDocumentResourcePath,
  cognitiveAppDocumentResourcePrefix,
  cognitiveAppDocumentHtmlResource,
  maxCognitiveAppDocumentHtmlBytes,
  parseCognitiveAppDocumentHtmlBytes,
  parseCognitiveAppDocumentResourceRequest,
  parseCognitiveAppDocumentResourceURL,
} from "../packages/core/src/cognitive-app-document-resource.js";
import {
  createCognitiveDocumentBootstrap,
  createCognitiveDocumentBootstrapFromBytes,
  cognitiveDocumentBootstrapPolicy,
  cognitiveDocumentBootstrapProtocol,
  cognitiveDocumentFacadeName,
} from "../packages/application/src/cognitive-document-bootstrap.js";
import * as prototypeCompatibility from "../apps/web/src/host/cognitive-document-bootstrap.js";
import {
  cognitiveAppViewResourcePath,
  parseCognitiveAppViewResourceRequest,
  parseCognitiveAppViewResourceURL,
} from "../packages/core/src/cognitive-app-view-resource.js";
import {
  applicationViewPermissions,
  applicationViewPolicy,
  appContentSecurityPolicy,
} from "../packages/core/src/resource-policy.js";

const proof = "per_document_transport_nonce_1234";
const request = {
  viewId: "original_view",
  expectedViewRevision: 4,
  expectedBindingRevision: 2,
  documentProof: proof,
};
const cas = {
  viewId: request.viewId,
  expectedViewRevision: request.expectedViewRevision,
  expectedBindingRevision: request.expectedBindingRevision,
};
const origin = "https://host.invalid";
const bytes = (value: string) => new TextEncoder().encode(value);
const sha = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

function authorPayload(html: string): Uint8Array {
  const matches = [...html.matchAll(/atob\("([A-Za-z0-9+/=]+)"\)/g)];
  assert.equal(
    matches.length,
    1,
    "Actual fixed wrapper has exactly its encoded author payload.",
  );
  return new Uint8Array(Buffer.from(matches[0]![1]!, "base64"));
}

test("Shared document resource: detached exact readUi CAS plus transport proof, no business authority or new raw endpoint fields", () => {
  const parsed = parseCognitiveAppDocumentResourceRequest(request);
  assert.deepEqual(parsed, request);
  assert.notEqual(parsed, request);
  const nullPrototype = Object.assign(Object.create(null), request);
  assert.deepEqual(
    parseCognitiveAppDocumentResourceRequest(nullPrototype),
    request,
  );
  assert.deepEqual(parseCognitiveAppViewResourceRequest(cas), cas);
  assert.throws(() => parseCognitiveAppViewResourceRequest(request));
  const rawURL = new URL(origin + cognitiveAppViewResourcePath(cas));
  assert.deepEqual(parseCognitiveAppViewResourceURL(rawURL), cas);
  assert.equal(parseCognitiveAppDocumentResourceURL(rawURL), null);
});

test("Shared document DTO rejects unknown, omitted, wrong-type and out-of-range fields without accessors", () => {
  for (const input of [
    null,
    undefined,
    [],
    "request",
    1,
    { ...request, documentProof: undefined },
    { ...cas },
    { ...request, documentProof: "x".repeat(21) },
    { ...request, documentProof: "x".repeat(129) },
    { ...request, documentProof: "x".repeat(22) + "=" },
    { ...request, documentProof: " nonce_not_allowed_here " },
    { ...request, documentProof: "这不是 ASCII 的传输随机数…………" },
    { ...request, actor: "human" },
    { ...request, endpoint: "https://author.invalid" },
    { ...request, html: "<html>author</html>" },
    { ...request, viewId: "../another-view" },
    { ...request, expectedViewRevision: 0 },
    { ...request, expectedBindingRevision: -1 },
    { ...request, expectedViewRevision: 1.5 },
    { ...request, expectedBindingRevision: "2" },
    { ...request, expectedViewRevision: Number.MAX_SAFE_INTEGER },
    { ...request, expectedBindingRevision: Infinity },
    Object.create(request),
    Object.defineProperty({ ...request }, "hidden", { value: "extra" }),
    { ...request, [Symbol("secret")]: "extra" },
  ])
    assert.throws(() => parseCognitiveAppDocumentResourceRequest(input));
  let reads = 0;
  for (const key of Object.keys(request)) {
    const accessor = Object.defineProperty({ ...request }, key, {
      enumerable: true,
      get() {
        reads++;
        return request[key as keyof typeof request];
      },
    });
    assert.throws(() => parseCognitiveAppDocumentResourceRequest(accessor));
  }
  const coercion = {
    ...request,
    toJSON() {
      reads++;
      return request;
    },
  };
  assert.throws(() => parseCognitiveAppDocumentResourceRequest(coercion));
  assert.equal(reads, 0);
  for (const length of [22, 128])
    assert.equal(
      parseCognitiveAppDocumentResourceRequest({
        ...request,
        documentProof: "a".repeat(length),
      }).documentProof.length,
      length,
    );
  assert.equal(
    parseCognitiveAppDocumentResourceRequest({
      ...request,
      expectedViewRevision: Number.MAX_SAFE_INTEGER - 1,
    }).expectedViewRevision,
    Number.MAX_SAFE_INTEGER - 1,
  );
});

test("Shared document URL: one dedicated prefix, exactly three unique keys and canonical positive revisions", () => {
  const path = cognitiveAppDocumentResourcePath(request);
  assert.equal(
    path,
    `${cognitiveAppDocumentResourcePrefix}${request.viewId}?expectedViewRevision=4&expectedBindingRevision=2&documentProof=${proof}`,
  );
  for (const host of [origin, "morphz://app"])
    assert.deepEqual(
      parseCognitiveAppDocumentResourceURL(new URL(host + path)),
      request,
    );
  const reverse = new URL(
    origin +
      `${cognitiveAppDocumentResourcePrefix}${request.viewId}?documentProof=${proof}&expectedBindingRevision=2&expectedViewRevision=4`,
  );
  assert.deepEqual(parseCognitiveAppDocumentResourceURL(reverse), request);
  for (const unrelated of [
    "/api/other",
    "/api/cognitive-app-documentary/original_view",
    "/api/cognitive-app-view/original_view",
  ])
    assert.equal(
      parseCognitiveAppDocumentResourceURL(new URL(origin + unrelated)),
      null,
    );
  for (const invalid of [
    origin + cognitiveAppDocumentResourcePrefix.slice(0, -1),
    origin + cognitiveAppDocumentResourcePrefix,
    origin + path + "/",
    origin + path + "#fragment",
    origin + path + "&extra=1",
    origin + path + "&documentProof=" + proof,
    origin + path + "&expectedViewRevision=4",
    origin + path + "&expectedBindingRevision=2",
    origin + path + "&%64ocumentProof=" + proof,
    (origin + path).replace(
      "expectedViewRevision=4",
      "expectedViewRevision=04",
    ),
    (origin + path).replace("expectedViewRevision=4", "expectedViewRevision=0"),
    (origin + path).replace(
      "expectedBindingRevision=2",
      "expectedBindingRevision=2.0",
    ),
    (origin + path).replace(
      "expectedBindingRevision=2",
      "expectedBindingRevision=9007199254740991",
    ),
    (origin + path).replace(
      "expectedBindingRevision=2",
      "expectedBindingRevision=+2",
    ),
    (origin + path).replace(
      "expectedBindingRevision=2",
      "expectedBindingRevision=2e0",
    ),
    (origin + path).replace("documentProof=" + proof, "documentProof="),
    (origin + path).replace("documentProof=" + proof, "proof=" + proof),
    (origin + path).replace(
      "documentProof=" + proof,
      "documentProof=%0A" + proof,
    ),
    (origin + path).replace("/original_view?", "/original_view/child?"),
    (origin + path).replace("/original_view?", "/%6Friginal_view?"),
    (origin + path).replace("https://", "https://user:secret@"),
  ])
    assert.throws(
      () => parseCognitiveAppDocumentResourceURL(new URL(invalid)),
      invalid,
    );
});

test("Shared wrapper resource budget is separately 1,500,000 actual UTF-8 bytes, detached and BOM-preserving", () => {
  assert.equal(maxCognitiveAppDocumentHtmlBytes, 1_500_000);
  assert.equal(cognitiveAppDocumentResourceMime, "text/html; charset=utf-8");
  const original = bytes("\uFEFF" + "😀".repeat(374_999) + "x");
  assert.equal(original.byteLength, 1_500_000);
  const parsed = parseCognitiveAppDocumentHtmlBytes(original);
  assert.deepEqual(parsed, original);
  assert.notEqual(parsed, original);
  original.fill(0);
  assert.equal(parsed[0], 0xef);
  assert.deepEqual(
    cognitiveAppDocumentHtmlResource("\uFEFF中文 😀").bytes,
    bytes("\uFEFF中文 😀"),
  );
  for (const invalid of [
    new Uint8Array(),
    new Uint8Array(1_500_001),
    new Uint8Array([0xff]),
    new Uint8Array([0xf0, 0x9f]),
    new ArrayBuffer(4),
    "bytes",
  ])
    assert.throws(() =>
      parseCognitiveAppDocumentHtmlBytes(invalid as Uint8Array),
    );
  assert.throws(() => cognitiveAppDocumentHtmlResource("\ud800"));
  assert.throws(() => cognitiveAppDocumentHtmlResource("😀".repeat(375_001)));
  assert.throws(() => cognitiveAppDocumentHtmlResource(""));
});

test("Shared fixed builder: exact author bytes/BOM/SHA retain original 1,000,000-byte limit; wrapper uses its own validated bytes", async () => {
  const original = bytes("\uFEFF" + "x".repeat(999_997));
  assert.equal(original.byteLength, 1_000_000);
  const wrapped = await createCognitiveDocumentBootstrapFromBytes(
    original,
    "p".repeat(128),
  );
  assert.deepEqual(wrapped.authorBytes, original);
  assert.equal(wrapped.authorSha256, sha(original));
  assert.deepEqual(authorPayload(wrapped.html), original);
  assert.equal(wrapped.mime, cognitiveAppDocumentResourceMime);
  assert.deepEqual(wrapped.bytes, bytes(wrapped.html));
  assert.ok(wrapped.bytes.byteLength > 1_000_000);
  assert.ok(wrapped.bytes.byteLength <= maxCognitiveAppDocumentHtmlBytes);
  assert.equal(wrapped.contentSecurityPolicy, cognitiveDocumentBootstrapPolicy);
  assert.doesNotMatch(wrapped.contentSecurityPolicy, /(?:^|;)\s*sandbox/);
  assert.equal(wrapped.permissionsPolicy, applicationViewPermissions);
  assert.match(applicationViewPolicy, /^sandbox allow-scripts;/);
  assert.doesNotMatch(
    appContentSecurityPolicy,
    /script-src[^;]*'unsafe-inline'/,
  );
  for (const invalid of [
    new Uint8Array(),
    bytes("x".repeat(1_000_001)),
    new Uint8Array([0xff]),
    new Uint8Array([0xe2, 0x82]),
  ])
    await assert.rejects(
      createCognitiveDocumentBootstrapFromBytes(invalid, proof),
    );
  const author =
    '\uFEFF<!doctype html><html><body>中文 😀 </script><script>window.author="untrusted"</script></body></html>';
  const stringApi = await createCognitiveDocumentBootstrap(author, proof);
  const byteApi = await createCognitiveDocumentBootstrapFromBytes(
    bytes(author),
    proof,
  );
  assert.deepEqual(stringApi, byteApi);
  assert.equal(stringApi.html.includes(author), false);
  assert.deepEqual(authorPayload(stringApi.html), bytes(author));
  for (const invalid of ["", "\ud800"])
    await assert.rejects(createCognitiveDocumentBootstrap(invalid, proof));
  for (const invalid of ["short", "x".repeat(129), "</script>"])
    await assert.rejects(
      createCognitiveDocumentBootstrapFromBytes(bytes("author"), invalid),
    );
});

test("Shared fixed builder captures author bytes synchronously before digest await and never observes later caller mutations", async (t) => {
  const original = bytes(
      "\uFEFF<!doctype html><html><body>原件 😀</body></html>",
    ),
    snapshot = new Uint8Array(original);
  const nativeDigest = crypto.subtle.digest;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let hashing = false;
  t.mock.method(
    crypto.subtle,
    "digest",
    async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
      hashing = true;
      const input = new Uint8Array(
        data instanceof ArrayBuffer ? data : data.buffer,
        data instanceof ArrayBuffer ? 0 : data.byteOffset,
        data.byteLength,
      );
      assert.deepEqual(input, snapshot);
      await held;
      return Reflect.apply(nativeDigest, crypto.subtle, [
        algorithm,
        data,
      ]) as Promise<ArrayBuffer>;
    },
  );
  const pending = createCognitiveDocumentBootstrapFromBytes(original, proof);
  assert.equal(
    hashing,
    true,
    "Raw validation and detached digest input happen before caller resumes.",
  );
  original.fill(0x78);
  release();
  const wrapped = await pending;
  assert.deepEqual(wrapped.authorBytes, snapshot);
  assert.deepEqual(authorPayload(wrapped.html), snapshot);
  assert.equal(wrapped.authorSha256, sha(snapshot));
});

test("Shared fixed builder rejects invalid bytes, proof and HTML without digest or caller coercion; old API remains asynchronously rejecting", async (t) => {
  let digestCalls = 0,
    coercionCalls = 0;
  t.mock.method(crypto.subtle, "digest", () => {
    digestCalls++;
    throw new Error("Unexpected digest.");
  });
  const coerced = {
    toString() {
      coercionCalls++;
      return "author";
    },
    toJSON() {
      coercionCalls++;
      return "author";
    },
  };
  for (const invalid of [
    null,
    undefined,
    "author",
    coerced,
    new Uint8Array(),
    new Uint8Array([0xff]),
    new Uint8Array(1_000_001),
  ]) {
    const pending = createCognitiveDocumentBootstrapFromBytes(
      invalid as Uint8Array,
      proof,
    );
    assert.ok(pending instanceof Promise);
    await assert.rejects(pending);
  }
  for (const invalid of [
    null,
    undefined,
    "short",
    "a".repeat(129),
    "</script>",
    coerced,
  ])
    await assert.rejects(
      createCognitiveDocumentBootstrapFromBytes(
        bytes("author"),
        invalid as string,
      ),
    );
  for (const invalid of ["", "\ud800", coerced]) {
    const pending = createCognitiveDocumentBootstrap(invalid as string, proof);
    assert.ok(pending instanceof Promise);
    await assert.rejects(pending);
  }
  assert.equal(digestCalls, 0);
  assert.equal(coercionCalls, 0);
});

test("Web prototype import is a compatibility reexport of one shared fixed source, not a second builder or policy", () => {
  assert.equal(
    prototypeCompatibility.createCognitiveDocumentBootstrap,
    createCognitiveDocumentBootstrap,
  );
  assert.equal(
    prototypeCompatibility.cognitiveDocumentBootstrapPolicy,
    cognitiveDocumentBootstrapPolicy,
  );
  assert.equal(
    prototypeCompatibility.cognitiveDocumentBootstrapProtocol,
    cognitiveDocumentBootstrapProtocol,
  );
  assert.equal(
    prototypeCompatibility.cognitiveDocumentFacadeName,
    cognitiveDocumentFacadeName,
  );
});
