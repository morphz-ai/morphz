import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import test from "node:test";
import { buildSync } from "esbuild";
import type {
  findCognitiveConnectionRetry,
  prepareCognitiveConnection,
} from "../apps/web/src/data/cognitive-connection-retry.js";
import {
  applicationStoragePrefix,
  legacyApplicationStoragePrefix,
  applicationWindowKey,
} from "../packages/core/src/application-names.js";
import {
  parseCognitiveAppRequest,
  type CognitiveAppRequestMap,
} from "../packages/core/src/cognitive-app-api.js";
import { canonicalJsonBytes } from "../packages/cognitive-app-sdk/src/domain-wire.js";

// Actual production browser bundle + fresh window realms + actual WebCrypto.
// Controlled Storage/digest scheduling is not native UI, SQL, HPA or networking.
type Connect = CognitiveAppRequestMap["connect"];
type Prepared = Awaited<ReturnType<typeof prepareCognitiveConnection>>;
const scope = "center:human";
const base: Connect = {
  appId: "example.notes",
  version: "1.0.0",
  expectedDefinitionHash: "a".repeat(64),
  expectedGrantRevision: 7,
  connectionId: "original_A",
  expectedRevision: 0,
  serviceId: "author/service-原件",
  dataAuthorityId: "author/data-原件",
};
const code = buildSync({
  stdin: {
    contents: `export { prepareCognitiveConnection, findCognitiveConnectionRetry } from "./apps/web/src/data/cognitive-connection-retry.ts";
  export { draftOwner, storageScope } from "./apps/web/src/local-preferences.ts";`,
    resolveDir: new URL("../", import.meta.url).pathname,
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  globalName: "connectionModule",
  platform: "browser",
  target: "es2023",
  write: false,
}).outputFiles[0]!.text;
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const sha = (value: unknown) =>
  createHash("sha256").update(canonicalJsonBytes(value)).digest("hex");
const lookup = (input: Connect) => {
  const { connectionId, expectedGrantRevision, ...target } = input;
  void connectionId;
  void expectedGrantRevision;
  return sha(target);
};
class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  reads = 0;
  writes = 0;
  removes = 0;
  failGet = false;
  failSet = false;
  failRemove = false;
  ignoreSet = false;
  onGet: ((key: string, count: number) => void) | null = null;
  onSet: ((key: string, value: string) => void) | null = null;
  get length() {
    return this.values.size;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    this.reads++;
    this.onGet?.(key, this.reads);
    if (this.failGet) throw Error("controlled storage unavailable");
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.writes++;
    if (this.failSet) throw Error("controlled quota exceeded");
    if (!this.ignoreSet) this.values.set(key, value);
    this.onSet?.(key, value);
  }
  removeItem(key: string) {
    this.removes++;
    if (this.failRemove) throw Error("controlled cleanup unavailable");
    this.values.delete(key);
  }
}
type Digest = (bytes: Uint8Array, index: number) => Promise<ArrayBuffer>;
const realDigest: Digest = (bytes) =>
  webcrypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
function windowModule(
  local = new MemoryStorage(),
  session = new MemoryStorage(),
  digest: Digest = realDigest,
) {
  let generated = 0,
    hashes = 0,
    networkCalls = 0;
  const context = createContext({
    localStorage: local,
    sessionStorage: session,
    TextEncoder,
    TextDecoder,
    fetch() {
      networkCalls++;
      throw Error("The preparation leaf must not perform network calls");
    },
    crypto: {
      randomUUID: () => "window_" + ++generated,
      subtle: {
        digest(algorithm: string, bytes: Uint8Array) {
          assert.equal(algorithm, "SHA-256");
          return digest(bytes, ++hashes);
        },
      },
    },
  });
  runInContext(code, context);
  const module = runInContext("connectionModule", context) as {
    prepareCognitiveConnection: typeof prepareCognitiveConnection;
    findCognitiveConnectionRetry: typeof findCognitiveConnectionRetry;
    draftOwner: string;
    storageScope(center: string, human: string): void;
  };
  const own = (input: unknown): Connect =>
    runInContext(
      `JSON.parse(${JSON.stringify(JSON.stringify(input))})`,
      context,
    );
  return {
    local,
    session,
    context,
    module,
    own,
    hashes: () => hashes,
    generated: () => generated,
    networkCalls: () => networkCalls,
    prepare: (
      input: Connect = base,
      fixedScope = scope,
      signal = new AbortController().signal,
    ) => module.prepareCognitiveConnection(own(input), fixedScope, signal),
    find: (
      input: Connect = base,
      fixedScope = scope,
      signal = new AbortController().signal,
    ) => module.findCognitiveConnectionRetry(own(input), fixedScope, signal),
  };
}
function record(storage: MemoryStorage) {
  assert.equal(storage.length, 1);
  const [key, bytes] = [...storage.values][0]!;
  const value = JSON.parse(bytes) as { requestSha: string; request: Connect };
  assert.deepEqual(Object.keys(value).sort(), ["request", "requestSha"]);
  return { key, bytes, value };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

test("actual connection preparation bundle: immutable original public request, strict persisted identity, no network", async (t) => {
  await t.test(
    "lookup excludes only candidate ID and grant revision while full record binds original ID and CAS",
    async () => {
      const env = windowModule();
      const prepared: Prepared = await env.prepare();
      const stored = record(env.local);
      assert.equal(prepared.recovered, false);
      assert.deepEqual(plain(prepared.request), base);
      assert.equal(stored.value.requestSha, sha(base));
      assert.deepEqual(stored.value.request, base);
      assert.equal(
        stored.key,
        `${applicationStoragePrefix}${scope}:draft:${env.module.draftOwner}:cognitive-connection:${lookup(base)}`,
      );
      assert.equal(env.local.writes, 1);
      assert.equal(env.generated(), 1);
      assert.equal("commandId" in stored.value.request, false);
      assert.equal("credential" in stored.value.request, false);
    },
  );
  await t.test(
    "fresh candidate and changed current grant recover full original DTO/CAS without silently upgrading",
    async () => {
      const env = windowModule();
      await env.prepare();
      const original = record(env.local);
      const recovered = await env.prepare({
        ...base,
        connectionId: "candidate_B",
        expectedGrantRevision: 999,
      });
      assert.equal(recovered.recovered, true);
      assert.deepEqual(plain(recovered.request), base);
      assert.equal(record(env.local).bytes, original.bytes);
      assert.equal(env.local.writes, 1);
      const reordered = Object.fromEntries(
        Object.entries({ ...base, connectionId: "candidate_C" }).reverse(),
      ) as Connect;
      assert.deepEqual(plain((await env.prepare(reordered)).request), base);
    },
  );
  await t.test(
    "cold bundle reload in persisted window recovers original request, not a fresh candidate",
    async () => {
      const first = windowModule();
      await first.prepare();
      const second = windowModule(first.local, first.session);
      assert.equal(second.generated(), 0);
      assert.equal(second.module.draftOwner, first.module.draftOwner);
      const recovered = await second.prepare({
        ...base,
        connectionId: "after_reload",
        expectedGrantRevision: 9,
      });
      assert.equal(recovered.recovered, true);
      assert.deepEqual(plain(recovered.request), base);
    },
  );
  await t.test(
    "target, optional hash absence, center, Human and actual window are distinct lookup identities",
    async () => {
      const env = windowModule();
      await env.prepare();
      for (const changed of [
        { ...base, serviceId: "author/service-other" },
        { ...base, dataAuthorityId: "author/data-other" },
        { ...base, appId: "example.other" },
        { ...base, version: "2.0.0" },
        { ...base, expectedDefinitionHash: "b".repeat(64) },
      ]) {
        const p = await env.prepare(changed);
        assert.equal(p.recovered, false);
      }
      const { expectedDefinitionHash, ...withoutHash } = base;
      void expectedDefinitionHash;
      assert.equal((await env.prepare(withoutHash)).recovered, false);
      assert.equal(
        (await env.prepare(base, "other-center:human")).recovered,
        false,
      );
      assert.equal(
        (await env.prepare(base, "center:other-human")).recovered,
        false,
      );
      const otherWindow = windowModule(env.local, new MemoryStorage());
      // Distinct real persisted window owner, not a reset renderer-global scope.
      otherWindow.session.values.set(applicationWindowKey, "window_other");
      const actualOther = windowModule(env.local, otherWindow.session);
      assert.equal((await actualOther.prepare()).recovered, false);
      assert.equal(env.local.length, 10);
    },
  );
  await t.test(
    "Core detach happens before hashing; caller mutation and late global preference scope cannot alter saved original",
    async () => {
      const pause = deferred();
      const env = windowModule(undefined, undefined, async (bytes, index) => {
        if (index === 1) await pause.promise;
        return realDigest(bytes, index);
      });
      const input = env.own(base);
      const pending = env.module.prepareCognitiveConnection(
        input,
        scope,
        new AbortController().signal,
      );
      input.serviceId = "mutated-after-first-await";
      input.connectionId = "mutated_ID";
      env.module.storageScope("late-center", "late-human");
      pause.resolve();
      const p = await pending;
      assert.deepEqual(plain(p.request), base);
      const stored = record(env.local);
      assert.ok(stored.key.startsWith(applicationStoragePrefix + scope + ":"));
      p.request.connectionId = "caller-mutates-prepared";
      p.acknowledge();
      assert.equal(env.local.length, 0);
    },
  );
  await t.test(
    "largest bounded portable UTF-8 identifiers survive exactly; illegal scopes/IDs and unknown fields fail closed",
    async () => {
      const env = windowModule();
      const large = {
        ...base,
        serviceId: "界".repeat(200),
        dataAuthorityId: "𠮷".repeat(100),
        connectionId: "A".repeat(100),
      };
      const p = await env.prepare(large);
      assert.deepEqual(plain(p.request), large);
      assert.equal(record(env.local).value.requestSha, sha(large));
      for (const input of [
        { ...base, serviceId: "界".repeat(201) },
        { ...base, connectionId: "forbidden/id" },
        { ...base, expectedRevision: 1 },
        { ...base, expectedGrantRevision: 0 },
        { ...base, credential: "NEVER_STORE" },
      ])
        await assert.rejects(
          env.module.prepareCognitiveConnection(
            env.own(input),
            scope,
            new AbortController().signal,
          ),
        );
      await assert.rejects(env.prepare(base, ""));
      assert.equal(env.local.length, 1);
    },
  );
  await t.test(
    "original envelope accessors/toJSON/proxy-free exotic objects never execute during Core ingress",
    async () => {
      const env = windowModule();
      let getters = 0,
        serializers = 0;
      const input = env.own(base);
      Object.defineProperty(input, "serviceId", {
        enumerable: true,
        get() {
          getters++;
          return "author/s";
        },
      });
      await assert.rejects(
        env.module.prepareCognitiveConnection(
          input,
          scope,
          new AbortController().signal,
        ),
      );
      const serialized = env.own(base);
      Object.defineProperty(serialized, "toJSON", {
        value() {
          serializers++;
          return base;
        },
      });
      await assert.rejects(
        env.module.prepareCognitiveConnection(
          serialized,
          scope,
          new AbortController().signal,
        ),
      );
      const exotic = runInContext("new Date()", env.context) as Connect;
      await assert.rejects(
        env.module.prepareCognitiveConnection(
          exotic,
          scope,
          new AbortController().signal,
        ),
      );
      assert.equal(getters, 0);
      assert.equal(serializers, 0);
      assert.equal(env.hashes(), 0);
      assert.equal(env.local.length, 0);
    },
  );
  await t.test(
    "missing versus stored null/malformed/unknown envelope fields and strict storage failure never become absence",
    async () => {
      const env = windowModule();
      await env.prepare();
      const original = record(env.local);
      for (const bytes of [
        "null",
        "{bad",
        "[]",
        "{}",
        JSON.stringify({ ...original.value, extra: true }),
        JSON.stringify({ ...original.value, requestSha: "bad" }),
        JSON.stringify({
          ...original.value,
          request: { ...base, extra: true },
        }),
      ]) {
        env.local.values.set(original.key, bytes);
        await assert.rejects(
          env.prepare({ ...base, connectionId: "never_replace" }),
        );
        assert.equal(env.local.values.get(original.key), bytes);
        assert.equal(env.local.writes, 1);
      }
      env.local.failGet = true;
      await assert.rejects(env.prepare());
      assert.equal(env.local.writes, 1);
    },
  );
  await t.test(
    "full digest, request body and intent-key tampering are independently rejected without rewriting record",
    async () => {
      const env = windowModule();
      await env.prepare();
      const original = record(env.local);
      const mismatches = [
        { ...original.value, requestSha: "f".repeat(64) },
        {
          ...original.value,
          request: { ...base, connectionId: "tampered_original" },
        },
        { ...original.value, request: { ...base, expectedGrantRevision: 8 } },
        {
          requestSha: sha({ ...base, serviceId: "wrong-target" }),
          request: { ...base, serviceId: "wrong-target" },
        },
      ];
      for (const value of mismatches) {
        const bytes = JSON.stringify(value);
        env.local.values.set(original.key, bytes);
        await assert.rejects(env.prepare());
        assert.equal(env.local.values.get(original.key), bytes);
      }
      assert.equal(env.local.writes, 1);
    },
  );
  await t.test(
    "legacy strict prefix fallback is verified and ACK removes only its exact original key",
    async () => {
      const env = windowModule();
      await env.prepare();
      const original = record(env.local);
      env.local.values.delete(original.key);
      const legacy = original.key.replace(
        applicationStoragePrefix,
        legacyApplicationStoragePrefix,
      );
      env.local.values.set(legacy, original.bytes);
      const p = await env.prepare({ ...base, connectionId: "new-candidate" });
      assert.equal(p.recovered, true);
      assert.deepEqual(plain(p.request), base);
      p.acknowledge();
      assert.equal(env.local.length, 0);
    },
  );
  await t.test(
    "quota failure and no-op writes cannot produce sendable prepared requests",
    async () => {
      for (const kind of ["quota", "ignore"] as const) {
        const local = new MemoryStorage();
        local.failSet = kind === "quota";
        local.ignoreSet = kind === "ignore";
        const env = windowModule(local);
        await assert.rejects(env.prepare());
        assert.equal(local.length, 0);
      }
    },
  );
  await t.test(
    "real persistent owner is required at entry and after await; temporary fallback UUID never authorizes storage",
    async () => {
      const brokenSession = new MemoryStorage();
      brokenSession.failGet = true;
      const broken = windowModule(undefined, brokenSession);
      await assert.rejects(broken.prepare());
      assert.equal(broken.local.writes, 0);
      const env = windowModule();
      env.session.values.delete(applicationWindowKey);
      await assert.rejects(env.prepare());
      assert.equal(env.local.writes, 0);
      const pause = deferred();
      const late = windowModule(undefined, undefined, async (bytes, index) => {
        if (index === 1) await pause.promise;
        return realDigest(bytes, index);
      });
      const pending = late.prepare();
      late.session.values.set(
        applicationWindowKey,
        "different-persisted-owner",
      );
      pause.resolve();
      await assert.rejects(pending);
      assert.equal(late.local.writes, 0);
    },
  );
  await t.test(
    "cancelled entry, every hash stage and read/write boundary fail closed without deleting original attempts",
    async () => {
      const entry = windowModule();
      const cancelled = new AbortController();
      cancelled.abort();
      await assert.rejects(entry.prepare(base, scope, cancelled.signal));
      assert.equal(entry.hashes(), 0);
      for (const stage of [1, 2, 3]) {
        const controller = new AbortController();
        const env = windowModule(undefined, undefined, async (bytes, index) => {
          if (index === stage) controller.abort();
          return realDigest(bytes, index);
        });
        await assert.rejects(env.prepare(base, scope, controller.signal));
        assert.equal(env.local.removes, 0);
        assert.equal(env.local.writes, stage === 3 ? 1 : 0);
      }
      const duringRead = windowModule(),
        c = new AbortController();
      duringRead.local.onGet = () => c.abort();
      await assert.rejects(duringRead.prepare(base, scope, c.signal));
      assert.equal(duringRead.local.writes, 0);
      const duringWrite = windowModule(),
        w = new AbortController();
      duringWrite.local.onSet = () => w.abort();
      await assert.rejects(duringWrite.prepare(base, scope, w.signal));
      assert.equal(duringWrite.local.length, 1);
      assert.equal(duringWrite.local.removes, 0);
    },
  );
  await t.test(
    "WebCrypto rejection at each stage is surfaced, never a successful preparation",
    async () => {
      for (const stage of [1, 2, 3]) {
        const env = windowModule(undefined, undefined, async (bytes, index) => {
          if (index === stage) throw Error("controlled hash failure");
          return realDigest(bytes, index);
        });
        await assert.rejects(env.prepare(), /controlled hash failure/);
        assert.equal(env.local.removes, 0);
      }
    },
  );
  await t.test(
    "concurrent preparations for the same target retain whichever actual original is persisted first",
    async () => {
      const pause = deferred();
      const env = windowModule(undefined, undefined, async (bytes, index) => {
        if (index === 2) await pause.promise;
        return realDigest(bytes, index);
      });
      const first = env.prepare();
      while (env.hashes() < 2)
        await new Promise<void>((done) => setImmediate(done));
      const second = await env.prepare({
        ...base,
        connectionId: "second_finishes_first",
        expectedGrantRevision: 19,
      });
      assert.equal(second.recovered, false);
      pause.resolve();
      const recovered = await first;
      assert.equal(recovered.recovered, true);
      assert.deepEqual(plain(recovered.request), plain(second.request));
      assert.equal(env.local.writes, 1);
    },
  );
  await t.test(
    "replacement during final digest verification blocks return instead of silently preparing another ID",
    async () => {
      let env!: ReturnType<typeof windowModule>;
      env = windowModule(undefined, undefined, async (bytes, index) => {
        if (index === 3) {
          const original = record(env.local);
          const other = { ...base, connectionId: "replacement" };
          env.local.values.set(
            original.key,
            JSON.stringify({ requestSha: sha(other), request: other }),
          );
        }
        return realDigest(bytes, index);
      });
      await assert.rejects(env.prepare());
      assert.equal(record(env.local).value.request.connectionId, "replacement");
    },
  );
  await t.test(
    "ACK cleanup uses captured full original record and scope; another target/ID/CAS cannot be deleted",
    async () => {
      const env = windowModule();
      const p = await env.prepare();
      const original = record(env.local);
      env.module.storageScope("other-center", "other-human");
      for (const other of [
        { ...base, connectionId: "other_original" },
        { ...base, expectedGrantRevision: 8 },
      ]) {
        const bytes = JSON.stringify({
          requestSha: sha(other),
          request: other,
        });
        env.local.values.set(original.key, bytes);
        assert.throws(() => p.acknowledge(), /另一尝试/);
        assert.equal(env.local.values.get(original.key), bytes);
      }
      env.local.values.set(original.key, original.bytes);
      await env.prepare({
        ...base,
        serviceId: "other-target",
        connectionId: "other_target",
      });
      p.acknowledge();
      assert.equal(env.local.length, 1);
      assert.equal(
        record(env.local).value.request.connectionId,
        "other_target",
      );
      p.acknowledge();
      assert.equal(env.local.length, 1);
    },
  );
  await t.test(
    "ACK corrupt record/read/remove failures throw but never remove another pending request",
    async () => {
      const env = windowModule();
      const p = await env.prepare();
      const original = record(env.local);
      env.local.values.set(original.key, "null");
      assert.throws(() => p.acknowledge());
      assert.equal(env.local.removes, 0);
      env.local.values.set(original.key, original.bytes);
      env.local.failGet = true;
      assert.throws(() => p.acknowledge());
      env.local.failGet = false;
      env.local.failRemove = true;
      assert.throws(() => p.acknowledge());
      assert.equal(env.local.values.get(original.key), original.bytes);
    },
  );
  await t.test(
    "exact Core oracle accepts the saved DTO and preserves optional field absence rather than filling current facts",
    async () => {
      const {
        expectedDefinitionHash,
        expectedGrantRevision,
        ...withoutOptionals
      } = base;
      void expectedDefinitionHash;
      void expectedGrantRevision;
      const env = windowModule();
      const p = await env.prepare(withoutOptionals);
      assert.deepEqual(
        parseCognitiveAppRequest("connect", plain(p.request)),
        withoutOptionals,
      );
      const recovered = await env.prepare({
        ...withoutOptionals,
        connectionId: "fresh",
        expectedGrantRevision: 100,
      });
      assert.deepEqual(plain(recovered.request), withoutOptionals);
      assert.equal(recovered.recovered, true);
      assert.equal("expectedGrantRevision" in recovered.request, false);
    },
  );
  await t.test(
    "explicit forget removes only its captured full original, is not an ACK, network call or fresh ID",
    async () => {
      const env = windowModule();
      const p = await env.prepare();
      const original = record(env.local);
      const generated = env.generated(),
        hashes = env.hashes();
      await env.prepare({
        ...base,
        serviceId: "other-forget-target",
        connectionId: "other_original",
      });
      env.module.storageScope("late-center", "late-human");
      const beforeForgetHashes = env.hashes();
      p.forgetRetry();
      assert.equal(env.local.length, 1);
      assert.equal(env.local.values.has(original.key), false);
      assert.equal(
        record(env.local).value.request.connectionId,
        "other_original",
      );
      assert.equal(env.generated(), generated);
      assert.equal(env.hashes(), beforeForgetHashes);
      assert.ok(beforeForgetHashes > hashes);
      assert.equal(env.networkCalls(), 0);
      p.forgetRetry();
      assert.equal(env.local.length, 1);
      const next = await env.prepare({
        ...base,
        connectionId: "explicit_new_candidate",
        expectedGrantRevision: 9,
      });
      assert.equal(next.recovered, false);
      assert.equal(next.request.connectionId, "explicit_new_candidate");
      assert.equal(next.request.expectedGrantRevision, 9);
      assert.equal(env.networkCalls(), 0);
    },
  );
  await t.test(
    "explicit forget detects replacement ID, body, digest or target and never deletes another attempt",
    async () => {
      const env = windowModule();
      const p = await env.prepare();
      const original = record(env.local);
      for (const changed of [
        { ...base, connectionId: "other_ID" },
        { ...base, expectedGrantRevision: 9 },
        { ...base, serviceId: "different-target" },
      ]) {
        const bytes = JSON.stringify({
          requestSha: sha(changed),
          request: changed,
        });
        env.local.values.set(original.key, bytes);
        assert.throws(() => p.forgetRetry());
        assert.equal(env.local.values.get(original.key), bytes);
      }
      const badSha = JSON.stringify({
        ...original.value,
        requestSha: "f".repeat(64),
      });
      env.local.values.set(original.key, badSha);
      assert.throws(() => p.forgetRetry());
      assert.equal(env.local.values.get(original.key), badSha);
      assert.equal(env.local.removes, 0);
      assert.equal(env.networkCalls(), 0);
    },
  );
  await t.test(
    "aborted or changed-window forget capability is rejected, while a known ACK may still clean its original fixed scope",
    async () => {
      const env = windowModule();
      const controller = new AbortController();
      const p = await env.prepare(base, scope, controller.signal);
      controller.abort();
      assert.throws(() => p.forgetRetry());
      assert.equal(env.local.length, 1);
      p.acknowledge();
      assert.equal(env.local.length, 0);
      const another = windowModule();
      const kept = await another.prepare();
      another.session.values.set(
        applicationWindowKey,
        "different-window-owner",
      );
      assert.throws(() => kept.forgetRetry());
      assert.equal(another.local.length, 1);
      kept.acknowledge();
      assert.equal(another.local.length, 0);
    },
  );
  await t.test(
    "recovered-record hash cancellation retains its original ID and does not create a new attempt",
    async () => {
      for (const stage of [2, 3]) {
        const initial = windowModule();
        await initial.prepare();
        const original = record(initial.local);
        const controller = new AbortController();
        const recovered = windowModule(
          initial.local,
          initial.session,
          async (bytes, index) => {
            if (index === stage) controller.abort();
            return realDigest(bytes, index);
          },
        );
        await assert.rejects(
          recovered.prepare(
            {
              ...base,
              connectionId: "new_candidate",
              expectedGrantRevision: 99,
            },
            scope,
            controller.signal,
          ),
        );
        assert.equal(record(recovered.local).bytes, original.bytes);
        assert.equal(recovered.local.writes, 1);
        assert.equal(recovered.networkCalls(), 0);
      }
    },
  );
  await t.test(
    "paired canonical/legacy cleanup cannot remove another pending attempt hidden by prefix preference",
    async () => {
      for (const cleanup of ["acknowledge", "forgetRetry"] as const) {
        const env = windowModule();
        const p = await env.prepare();
        const original = record(env.local);
        const legacy = original.key.replace(
          applicationStoragePrefix,
          legacyApplicationStoragePrefix,
        );
        const other = {
          ...base,
          connectionId: "another_legacy_ID",
          expectedGrantRevision: 9,
        };
        const otherBytes = JSON.stringify({
          requestSha: sha(other),
          request: other,
        });
        env.local.values.set(legacy, otherBytes);
        assert.throws(
          () => p[cleanup](),
          "legacy secondary record is a conflicting attempt, not disposable alias bytes",
        );
        assert.equal(env.local.values.get(original.key), original.bytes);
        assert.equal(env.local.values.get(legacy), otherBytes);
        assert.equal(env.local.removes, 0);
        env.local.values.set(legacy, "{malformed");
        assert.throws(() => p[cleanup]());
        assert.equal(env.local.removes, 0);
        env.local.values.set(legacy, original.bytes);
        p[cleanup]();
        assert.equal(
          env.local.length,
          0,
          "both exact original aliases may be cleared",
        );
      }
    },
  );
  await t.test(
    "read-only lookup of absent records does not write, allocate an ID or prepare a candidate",
    async () => {
      const env = windowModule();
      const generated = env.generated();
      env.local.failSet = true;
      for (const expectedGrantRevision of [undefined, 1, 99]) {
        const input = { ...base, connectionId: "lookup_only" };
        if (expectedGrantRevision === undefined)
          delete input.expectedGrantRevision;
        else input.expectedGrantRevision = expectedGrantRevision;
        assert.equal(await env.find(input), null);
      }
      assert.equal(
        env.hashes(),
        3,
        "only the target digest is needed for absence",
      );
      assert.equal(env.local.length, 0);
      assert.equal(env.local.writes, 0);
      assert.equal(env.local.removes, 0);
      assert.equal(env.generated(), generated);
      assert.equal(env.networkCalls(), 0);
    },
  );
  await t.test(
    "cold read-only lookup with a changed or disabled-looking grant recovers the full original ID/CAS and fixed cleanup capability",
    async () => {
      const initial = windowModule();
      await initial.prepare();
      const original = record(initial.local);
      const cold = windowModule(initial.local, initial.session);
      cold.module.storageScope("late-center", "late-human");
      const p = await cold.find({
        ...base,
        connectionId: "lookup_only",
        expectedGrantRevision: 99,
      });
      assert.ok(p);
      assert.equal(p.recovered, true);
      assert.deepEqual(plain(p.request), base);
      assert.equal(cold.generated(), 0);
      assert.equal(cold.local.writes, 1, "only the original preparation wrote");
      assert.equal(record(cold.local).bytes, original.bytes);
      p.request.expectedGrantRevision = 100;
      p.acknowledge();
      assert.equal(cold.local.length, 0);
      assert.equal(cold.networkCalls(), 0);
    },
  );
  await t.test(
    "lookup still uses strict complete Core ingress and snapshots before hashing, without executing accessors or serialization",
    async () => {
      const pause = deferred();
      const env = windowModule(undefined, undefined, async (bytes, index) => {
        if (index === 1) await pause.promise;
        return realDigest(bytes, index);
      });
      const input = env.own(base);
      const pending = env.module.findCognitiveConnectionRetry(
        input,
        scope,
        new AbortController().signal,
      );
      input.serviceId = "changed-after-await";
      env.module.storageScope("late-center", "late-human");
      pause.resolve();
      assert.equal(await pending, null);
      assert.equal(env.local.writes, 0);
      let getters = 0,
        serializers = 0;
      const getter = env.own(base);
      Object.defineProperty(getter, "serviceId", {
        enumerable: true,
        get() {
          getters++;
          return base.serviceId;
        },
      });
      const toJSON = env.own(base);
      Object.defineProperty(toJSON, "toJSON", {
        value() {
          serializers++;
          return base;
        },
      });
      for (const invalid of [
        getter,
        toJSON,
        env.own({ ...base, expectedRevision: 1 }),
        env.own({ ...base, expectedGrantRevision: 0 }),
        env.own({ ...base, connectionId: "bad/id" }),
        env.own({ ...base, serviceId: undefined }),
        env.own({ ...base, credential: "NEVER_ACCEPT" }),
      ])
        await assert.rejects(
          env.module.findCognitiveConnectionRetry(
            invalid,
            scope,
            new AbortController().signal,
          ),
        );
      assert.equal(getters, 0);
      assert.equal(serializers, 0);
      assert.equal(env.hashes(), 1);
      assert.equal(env.local.writes, 0);
      assert.equal(env.networkCalls(), 0);
    },
  );
  await t.test(
    "lookup verifies legacy and large UTF-8 original requests without restorage and fails closed on malformed or tampered bodies",
    async () => {
      const env = windowModule();
      const large = {
        ...base,
        serviceId: "界".repeat(200),
        dataAuthorityId: "𠮷".repeat(100),
      };
      await env.prepare(large);
      const original = record(env.local);
      env.local.values.delete(original.key);
      const legacy = original.key.replace(
        applicationStoragePrefix,
        legacyApplicationStoragePrefix,
      );
      env.local.values.set(legacy, original.bytes);
      const p = await env.find({
        ...large,
        connectionId: "lookup_only",
        expectedGrantRevision: 99,
      });
      assert.ok(p);
      assert.equal(p.recovered, true);
      assert.deepEqual(plain(p.request), large);
      assert.equal(env.local.writes, 1);
      for (const bytes of [
        "null",
        "{broken",
        JSON.stringify({ ...original.value, requestSha: "f".repeat(64) }),
        JSON.stringify({
          ...original.value,
          request: { ...large, expectedGrantRevision: 99 },
        }),
        JSON.stringify({
          requestSha: sha({ ...large, serviceId: "different-target" }),
          request: { ...large, serviceId: "different-target" },
        }),
      ]) {
        env.local.values.set(legacy, bytes);
        await assert.rejects(env.find(large));
        assert.equal(env.local.values.get(legacy), bytes);
      }
      assert.equal(env.local.writes, 1);
      assert.equal(env.local.removes, 0);
      assert.equal(env.networkCalls(), 0);
    },
  );
  await t.test(
    "lookup cancellation, failed storage and changed persisted window reject without rewriting or deleting the original",
    async () => {
      for (const stage of [1, 2, 3]) {
        const initial = windowModule();
        await initial.prepare();
        const original = record(initial.local);
        const controller = new AbortController();
        const env = windowModule(
          initial.local,
          initial.session,
          async (bytes, index) => {
            if (index === stage) controller.abort();
            return realDigest(bytes, index);
          },
        );
        await assert.rejects(env.find(base, scope, controller.signal));
        assert.equal(record(env.local).bytes, original.bytes);
        assert.equal(env.local.writes, 1);
        assert.equal(env.local.removes, 0);
      }
      const env = windowModule();
      await env.prepare();
      const original = record(env.local);
      env.local.failGet = true;
      await assert.rejects(env.find());
      env.local.failGet = false;
      const cancelled = new AbortController();
      cancelled.abort();
      await assert.rejects(env.find(base, scope, cancelled.signal));
      env.session.values.set(applicationWindowKey, "changed-window-owner");
      await assert.rejects(env.find());
      assert.equal(record(env.local).bytes, original.bytes);
      assert.equal(env.local.writes, 1);
      assert.equal(env.local.removes, 0);
      assert.equal(env.networkCalls(), 0);
    },
  );
  await t.test(
    "lookup refuses a late valid replacement at final verification, without publishing another original or restoring storage",
    async () => {
      const initial = windowModule();
      await initial.prepare();
      const original = record(initial.local);
      const other = { ...base, connectionId: "replacement_after_lookup" };
      const replacement = JSON.stringify({
        requestSha: sha(other),
        request: other,
      });
      const env = windowModule(
        initial.local,
        initial.session,
        async (bytes, index) => {
          if (index === 3) env.local.values.set(original.key, replacement);
          return realDigest(bytes, index);
        },
      );
      await assert.rejects(env.find());
      assert.equal(env.local.values.get(original.key), replacement);
      assert.equal(env.local.writes, 1);
      assert.equal(env.local.removes, 0);
      assert.equal(env.networkCalls(), 0);
    },
  );
});
