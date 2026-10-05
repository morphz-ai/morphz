import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash, webcrypto } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { buildSync } from "esbuild";
import {
  applicationStoragePrefix,
  legacyApplicationStoragePrefix,
  applicationWindowKey,
} from "../packages/core/src/application-names.js";
import type { CognitiveAppRequestMap } from "../packages/core/src/cognitive-app-api.js";
import { parseCognitiveAppDefinition } from "../packages/cognitive-app-sdk/src/protocol.js";
import { canonicalJsonBytes } from "../packages/cognitive-app-sdk/src/domain-wire.js";
import type { prepareCognitiveInstallation } from "../apps/web/src/data/cognitive-installation-retry.js";

type Install = CognitiveAppRequestMap["install"];
type Prepared = Awaited<ReturnType<typeof prepareCognitiveInstallation>>;
const scope = "center:human";
const definition = parseCognitiveAppDefinition(
  JSON.parse(
    readFileSync(
      new URL("../examples/cognitive-notes/definition.json", import.meta.url),
      "utf8",
    ),
  ),
);
const code = buildSync({
  stdin: {
    contents: `export { prepareCognitiveInstallation } from "./apps/web/src/data/cognitive-installation-retry.ts";
      export { draftOwner, draftKey, storageScope } from "./apps/web/src/local-preferences.ts";`,
    resolveDir: new URL("../", import.meta.url).pathname,
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  globalName: "installationModule",
  platform: "browser",
  target: "es2023",
  write: false,
}).outputFiles[0]!.text;

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  writes = 0;
  reads = 0;
  removes = 0;
  failGet = false;
  failSet = false;
  failRemove = false;
  ignoreSet = false;
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string) {
    this.reads++;
    if (this.failGet) throw new Error("storage read unavailable");
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.writes++;
    if (this.failSet) throw new Error("storage quota exceeded");
    if (!this.ignoreSet) this.values.set(key, value);
  }
  removeItem(key: string) {
    this.removes++;
    if (this.failRemove) throw new Error("storage cleanup unavailable");
    this.values.delete(key);
  }
}

function windowModule(
  local = new MemoryStorage(),
  session = new MemoryStorage(),
  digest: (bytes: Uint8Array) => Promise<ArrayBuffer> = (bytes) =>
    webcrypto.subtle.digest("SHA-256", Uint8Array.from(bytes)),
) {
  let generated = 0;
  const context = createContext({
    localStorage: local,
    sessionStorage: session,
    TextEncoder,
    TextDecoder,
    crypto: {
      randomUUID: () => `window_${++generated}`,
      subtle: {
        digest(algorithm: string, bytes: Uint8Array) {
          assert.equal(algorithm, "SHA-256");
          return digest(bytes);
        },
      },
    },
  });
  runInContext(code, context);
  const module = runInContext("installationModule", context) as {
    prepareCognitiveInstallation: typeof prepareCognitiveInstallation;
    draftOwner: string;
    storageScope(center: string, principal: string): void;
  };
  // Each load executes the actual complete bundle in a fresh window realm;
  // storage is controlled, not the production identity/canonical algorithm.
  const own = (input: Install): Install =>
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
    generated: () => generated,
    prepare: (
      input: Install,
      selectedScope = scope,
      signal = new AbortController().signal,
    ) => module.prepareCognitiveInstallation(own(input), selectedScope, signal),
  };
}

function register(
  commandId = "candidate_A",
): Extract<Install, { mode: "register-installed" }> {
  return {
    mode: "register-installed",
    commandId,
    appId: definition.id,
    version: definition.version,
    definitionHash: "a".repeat(64),
  };
}
function gui(
  commandId = "gui_A",
  html = "<h1>原文</h1>\n",
): Extract<Install, { manifest: unknown }> {
  return {
    definition: {
      ...definition,
      ui: { packageVersion: definition.version, sha256: "a".repeat(64) },
    },
    manifest: {
      format: "morphz-app/v1",
      id: definition.id,
      version: definition.version,
      title: definition.title,
      description: definition.description,
      icon: definition.icon,
      permissions: [],
      harness: null,
      ui: { type: "sandbox", html },
    },
    commandId,
  };
}
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const onlyRecord = (storage: MemoryStorage) => {
  assert.equal(storage.length, 1);
  const [key, bytes] = [...storage.values][0]!;
  const value = JSON.parse(bytes) as { requestSha: string; commandId: string };
  assert.deepEqual(Object.keys(value).sort(), ["commandId", "requestSha"]);
  assert.match(value.requestSha, /^[a-f0-9]{64}$/);
  return { key, bytes, value };
};
const sha = (value: unknown) =>
  createHash("sha256").update(canonicalJsonBytes(value)).digest("hex");

test("actual installation retry leaf: fixed identity, strict persistence and exact bytes", async (t) => {
  await t.test(
    "unknown result keeps original ID across same-payload candidates, key order and a real bundle reload",
    async () => {
      const first = windowModule();
      const prepared = await first.prepare(register());
      const record = onlyRecord(first.local);
      assert.equal(prepared.request.commandId, "candidate_A");
      assert.equal(
        record.value.requestSha,
        sha({
          mode: "register-installed",
          appId: definition.id,
          version: definition.version,
          definitionHash: "a".repeat(64),
        }),
      );
      assert.equal(
        record.key,
        `${applicationStoragePrefix}${scope}:draft:${first.module.draftOwner}:cognitive-installation:${record.value.requestSha}`,
      );
      const next = await first.prepare(register("candidate_B"));
      assert.equal(next.request.commandId, "candidate_A");
      const reversed = Object.fromEntries(
        Object.entries(register("candidate_C")).reverse(),
      ) as Install;
      assert.equal(
        (await first.prepare(reversed)).request.commandId,
        "candidate_A",
      );
      const reloaded = windowModule(first.local, first.session);
      assert.equal(reloaded.module.draftOwner, first.module.draftOwner);
      assert.equal(reloaded.generated(), 0);
      assert.equal(
        (await reloaded.prepare(register("candidate_D"))).request.commandId,
        "candidate_A",
      );
      assert.equal(onlyRecord(first.local).bytes, record.bytes);
    },
  );

  await t.test(
    "changed payload, center, Human and separate window never reuse the first identity",
    async () => {
      const env = windowModule();
      await env.prepare(register());
      const changed = {
        ...register("changed"),
        definitionHash: "b".repeat(64),
      } as Install;
      assert.equal((await env.prepare(changed)).request.commandId, "changed");
      assert.equal(
        (await env.prepare(register("center_B"), "center_b:human")).request
          .commandId,
        "center_B",
      );
      assert.equal(
        (await env.prepare(register("human_B"), "center:human_b")).request
          .commandId,
        "human_B",
      );
      const otherSession = new MemoryStorage();
      otherSession.setItem(applicationWindowKey, "other_window");
      const other = windowModule(env.local, otherSession);
      assert.equal(
        (await other.prepare(register("other_window_command"))).request
          .commandId,
        "other_window_command",
      );
      assert.equal(env.local.length, 5);
    },
  );

  await t.test(
    "scope is captured before hash, never read from the later global preference scope",
    async () => {
      let release!: (bytes: ArrayBuffer) => void;
      const env = windowModule(
        undefined,
        undefined,
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const pending = env.prepare(register());
      env.module.storageScope("later-center", "later-human");
      release(
        await webcrypto.subtle.digest(
          "SHA-256",
          canonicalJsonBytes({
            mode: "register-installed",
            appId: definition.id,
            version: definition.version,
            definitionHash: "a".repeat(64),
          }),
        ),
      );
      await pending;
      assert.ok(
        onlyRecord(env.local).key.startsWith(
          `${applicationStoragePrefix}${scope}:`,
        ),
      );
    },
  );

  await t.test(
    "headless installation detaches original request without allocating any retry ID or storage record",
    async () => {
      let hashes = 0;
      const env = windowModule(undefined, undefined, async () => {
        hashes++;
        return new ArrayBuffer(32);
      });
      env.local.failGet = env.local.failSet = env.session.failGet = true;
      const prepared = await env.prepare({ definition });
      assert.deepEqual(plain(prepared.request), { definition });
      assert.equal(Object.hasOwn(prepared.request, "commandId"), false);
      prepared.acknowledge();
      assert.equal(hashes, 0);
      assert.equal(env.local.reads, 0);
      assert.equal(env.local.writes, 0);
      assert.equal(env.generated(), 1); // Existing preference initialization only.
    },
  );

  await t.test(
    "cancel while SHA is pending leaves no prepared request or retry record",
    async () => {
      let release!: (value: ArrayBuffer) => void;
      const env = windowModule(
        undefined,
        undefined,
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const controller = new AbortController();
      const pending = env.prepare(register(), scope, controller.signal);
      controller.abort();
      release(new ArrayBuffer(32));
      await assert.rejects(pending, { name: "AbortError" });
      assert.equal(env.local.length, 0);
    },
  );

  await t.test(
    "cancel before parsing completes or return does not yield a sendable request",
    async () => {
      const controller = new AbortController();
      controller.abort();
      const env = windowModule();
      await assert.rejects(env.prepare(register(), scope, controller.signal), {
        name: "AbortError",
      });
      assert.equal(env.local.length, 0);
      const final = new AbortController();
      const originalSet = env.local.setItem.bind(env.local);
      env.local.setItem = (key, value) => {
        originalSet(key, value);
        final.abort();
      };
      await assert.rejects(env.prepare(register(), scope, final.signal), {
        name: "AbortError",
      });
      assert.equal(onlyRecord(env.local).value.commandId, "candidate_A");
    },
  );

  await t.test(
    "window identity must really persist and remain the same after hashing; no ephemeral fallback",
    async () => {
      for (const mode of ["missing", "changed", "read-error", "write-error"]) {
        const session = new MemoryStorage();
        if (mode === "write-error") session.failSet = true;
        const env = windowModule(undefined, session);
        if (mode === "missing") session.values.clear();
        if (mode === "changed")
          session.values.set(applicationWindowKey, "new_window");
        if (mode === "read-error") session.failGet = true;
        const writes = session.writes;
        await assert.rejects(env.prepare(register()), /重试标识|storage read/);
        assert.equal(env.local.length, 0);
        assert.equal(session.writes, writes);
      }
      let release!: (value: ArrayBuffer) => void;
      const env = windowModule(
        undefined,
        undefined,
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const pending = env.prepare(register());
      env.session.values.set(applicationWindowKey, "new_window");
      release(new ArrayBuffer(32));
      await assert.rejects(pending, /重试标识/);
      assert.equal(env.local.length, 0);
    },
  );

  await t.test(
    "malformed JSON and all corrupt metadata fail closed without silently inventing a new command",
    async () => {
      for (const replacement of [
        "",
        "{broken",
        "null",
        "[]",
        '"text"',
        "{}",
        '{"requestSha":"wrong","commandId":"candidate_A"}',
        ...["", "invalid command", "x".repeat(101), 1, null].map(
          (commandId) => ({ commandId }),
        ),
        { extra: "payload" },
      ]) {
        const env = windowModule();
        await env.prepare(register());
        const record = onlyRecord(env.local);
        const bytes =
          typeof replacement === "string"
            ? replacement
            : JSON.stringify({ ...record.value, ...replacement });
        env.local.values.set(record.key, bytes);
        const writes = env.local.writes;
        await assert.rejects(env.prepare(register("new_candidate")));
        assert.equal(env.local.values.get(record.key), bytes);
        assert.equal(env.local.writes, writes);
      }
    },
  );

  await t.test(
    "local IO, quota and ineffective writes block preparation, never fall back to unsaved UUIDs",
    async () => {
      for (const mode of ["read", "quota", "ignored"]) {
        const env = windowModule();
        if (mode === "read") env.local.failGet = true;
        if (mode === "quota") env.local.failSet = true;
        if (mode === "ignored") env.local.ignoreSet = true;
        await assert.rejects(env.prepare(register()), /storage|无法保存/);
        assert.equal(env.local.length, 0);
      }
    },
  );

  await t.test(
    "legacy saved metadata retains its original command and ACK removes only that exact receipt",
    async () => {
      const env = windowModule();
      await env.prepare(register());
      const record = onlyRecord(env.local);
      env.local.values.delete(record.key);
      const legacyKey =
        legacyApplicationStoragePrefix +
        record.key.slice(applicationStoragePrefix.length);
      env.local.values.set(legacyKey, record.bytes);
      const prepared = await env.prepare(register("replacement"));
      assert.equal(prepared.request.commandId, "candidate_A");
      prepared.acknowledge();
      assert.equal(env.local.length, 0);
    },
  );

  await t.test(
    "valid >512 KiB GUI keeps original HTML bytes and stores neither HTML nor definition",
    async () => {
      const html = '\u0001"\\\n原始内容'.repeat(30000);
      const input = gui("large_gui", html);
      assert.ok(
        new TextEncoder().encode(JSON.stringify(input)).byteLength > 512 * 1024,
      );
      assert.ok(new TextEncoder().encode(html).byteLength < 1_000_000);
      let hashed = "";
      const env = windowModule(undefined, undefined, async (bytes) => {
        hashed = new TextDecoder().decode(bytes);
        return webcrypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
      });
      const prepared = await env.prepare(input);
      assert.deepEqual(plain(prepared.request), input);
      const identity = JSON.parse(hashed) as Record<string, unknown>;
      assert.equal(Object.hasOwn(identity, "commandId"), false);
      assert.deepEqual(identity, {
        definition: "definition" in input ? input.definition : null,
        manifest: "manifest" in input ? input.manifest : null,
      });
      const record = onlyRecord(env.local);
      assert.ok(record.bytes.length < 200);
      assert.equal(record.bytes.includes("原始内容"), false);
      assert.equal(
        record.value.requestSha,
        createHash("sha256").update(hashed).digest("hex"),
      );
    },
  );

  await t.test(
    "only TOP LEVEL commandId is excluded; nested schema commandId and literal HTML remain fingerprinted",
    async () => {
      const env = windowModule();
      const input = gui("top_A");
      assert.ok("definition" in input);
      input.definition = {
        ...input.definition,
        operations: input.definition.operations.map((op, index) =>
          index === 0
            ? {
                ...op,
                inputSchema: {
                  type: "object",
                  properties: {
                    commandId: { type: "string", enum: ["nested_A"] },
                  },
                  required: ["commandId"],
                  additionalProperties: false,
                },
              }
            : op,
        ),
      };
      await env.prepare(input);
      assert.equal(
        (await env.prepare({ ...input, commandId: "top_B" })).request.commandId,
        "top_A",
      );
      const changed = plain(input);
      assert.ok("definition" in changed);
      changed.definition = {
        ...changed.definition,
        operations: changed.definition.operations.map((op, index) =>
          index === 0
            ? {
                ...op,
                inputSchema: {
                  type: "object",
                  properties: {
                    commandId: { type: "string", enum: ["nested_B"] },
                  },
                  required: ["commandId"],
                  additionalProperties: false,
                },
              }
            : op,
        ),
      };
      assert.equal(
        (await env.prepare({ ...changed, commandId: "nested_changed" })).request
          .commandId,
        "nested_changed",
      );
      const changedHtml = gui(
        "html_changed",
        '<script>const commandId="literal";</script>',
      );
      assert.equal(
        (await env.prepare(changedHtml)).request.commandId,
        "html_changed",
      );
      assert.equal(env.local.length, 3);
    },
  );

  await t.test(
    "Core own-data validation runs before await and never invokes caller accessors/toJSON",
    async () => {
      let calls = 0;
      const env = windowModule();
      env.context.observe = () => {
        calls++;
      };
      for (const source of [
        'Object.defineProperty({mode:"register-installed",commandId:"candidate",appId:"example.notes",version:"1.0.0",definitionHash:"a".repeat(64)},"mode",{enumerable:true,get(){observe();return "register-installed"}})',
        "({...JSON.parse(inputJson),toJSON(){observe();return {}}})",
      ]) {
        env.context.inputJson = JSON.stringify(register());
        const invalid = runInContext(source, env.context) as Install;
        await assert.rejects(
          env.module.prepareCognitiveInstallation(
            invalid,
            scope,
            new AbortController().signal,
          ),
        );
      }
      assert.equal(calls, 0);
      assert.equal(env.local.length, 0);
      let release!: (value: ArrayBuffer) => void;
      const held = windowModule(
        undefined,
        undefined,
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const original = held.own(gui());
      const pending = held.module.prepareCognitiveInstallation(
        original,
        scope,
        new AbortController().signal,
      );
      assert.ok(
        "manifest" in original && original.manifest?.ui.type === "sandbox",
      );
      original.manifest.ui.html = "caller changed while hashing";
      original.commandId = "changed";
      release(new ArrayBuffer(32));
      const prepared = await pending;
      assert.deepEqual(plain(prepared.request), gui());
    },
  );

  await t.test(
    "ACK removes matching metadata once; newer command or another payload/scope stays untouched",
    async () => {
      const env = windowModule();
      const prepared = await env.prepare(register());
      const record = onlyRecord(env.local);
      env.local.values.set(
        record.key,
        JSON.stringify({ ...record.value, commandId: "newer_command" }),
      );
      prepared.acknowledge();
      assert.equal(onlyRecord(env.local).value.commandId, "newer_command");
      const newer = await env.prepare(register("candidate_B"));
      await env.prepare(register("other_human"), "center:other");
      await env.prepare({
        ...register("other_payload"),
        definitionHash: "b".repeat(64),
      } as Install);
      newer.acknowledge();
      newer.acknowledge();
      assert.equal(env.local.length, 2);
      assert.equal(env.local.values.has(record.key), false);
    },
  );

  await t.test(
    "ACK never erases a different hidden legacy attempt under the same full-request key",
    async () => {
      const env = windowModule();
      const prepared = await env.prepare(register());
      const record = onlyRecord(env.local);
      const legacy = record.key.replace(
        applicationStoragePrefix,
        legacyApplicationStoragePrefix,
      );
      const other = JSON.stringify({
        ...record.value,
        commandId: "other_legacy",
      });
      env.local.values.set(legacy, other);
      assert.throws(() => prepared.acknowledge(), /另一操作/);
      assert.equal(
        env.local.values.get(record.key),
        JSON.stringify(record.value),
      );
      assert.equal(env.local.values.get(legacy), other);
      env.local.values.set(legacy, JSON.stringify(record.value));
      prepared.acknowledge();
      assert.equal(env.local.length, 0);
    },
  );

  await t.test(
    "cleanup failure is a distinct synchronous error and retains the original retry identity after real ACK",
    async () => {
      const env = windowModule();
      const prepared: Prepared = await env.prepare(register());
      const acknowledgedByTransport = { ...prepared.request }; // Consumer's ACK is independent of this leaf.
      env.local.failRemove = true;
      assert.throws(() => prepared.acknowledge(), /cleanup/);
      assert.equal(acknowledgedByTransport.commandId, "candidate_A");
      assert.equal(
        (await env.prepare(register("wrong_retry"))).request.commandId,
        "candidate_A",
      );
      env.local.failRemove = false;
      prepared.acknowledge();
      assert.equal(env.local.length, 0);
    },
  );
});
