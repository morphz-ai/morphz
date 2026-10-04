import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  createBookmarkInteractions,
  type BookmarkInteractionIdentity,
  type BookmarkInteractionPorts,
} from "../apps/web/src/data/bookmark-interactions.js";
import { RequestError } from "../apps/web/src/application-transport.js";
import { draftKey } from "../apps/web/src/local-preferences.js";
import type { BookmarkOperation } from "../packages/core/src/bookmarks.js";
import {
  createOriginalBookmarkInteractions,
  originalBookmarkMetadata,
} from "./fixtures/bookmark-interactions-original.js";

const migration =
  process.env.MORPHZ_TEST_BOOKMARK_MIGRATION_EQUIVALENCE === "1";
const actor: BookmarkInteractionIdentity = {
  centerId: "center-A",
  principalId: "human-A",
  actantId: "actant-A",
  csrfToken: "csrf-A",
  capabilities: { browserBookmarks: true },
};
const operation: BookmarkOperation = {
  type: "bookmark-add",
  title: "原题目",
  url: "https://example.com/原路径",
};
const row = {
  id: "bookmark-A",
  ownerPrincipalId: "human-A",
  title: "原题目",
  url: "https://example.com/page",
  revision: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  createdBy: { principalId: "human-A", actantId: "actant-A" },
  updatedBy: { principalId: "human-A", actantId: "actant-A" },
  deletedAt: null,
};
const copy = <T>(value: T): T => structuredClone(value);
const scopeOf = (
  identity: Omit<BookmarkInteractionIdentity, "csrfToken" | "capabilities">,
) => `${identity.centerId}:${identity.principalId}:${identity.actantId}`;
const pendingKey = (value: BookmarkOperation, identity = actor) =>
  "morphz:" +
  scopeOf(identity) +
  ":" +
  draftKey(
    "pending:bookmark:" +
      createHash("sha256").update(JSON.stringify(value)).digest("hex"),
  );
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function reachedWithin(promise: Promise<void>) {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Error("TEST held phase not reached")),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Real scopedStorage/draftKey/schema/RequestError, with narrow controlled call
// ports only. This does not claim actual Client or HTTP/SQL authority coverage.
async function withFamily<T>(
  fixed: boolean,
  run: (context: {
    family: ReturnType<typeof createBookmarkInteractions>;
    rows: Map<string, string>;
    trace: unknown[][];
    setIdentity(value: BookmarkInteractionIdentity | null): void;
    setCall(value: BookmarkInteractionPorts["call"]): void;
    failStorage(value: "read" | "initial" | "clear" | null): void;
    failDigest(value: boolean): void;
    holdDigest(): { reached: Promise<void>; release(): void };
  }) => Promise<T>,
) {
  const descriptors = [
    [globalThis, "localStorage"],
    [crypto, "randomUUID"],
    [crypto.subtle, "digest"],
    [AbortSignal, "timeout"],
  ].map(([target, name]) => ({
    target: target as object,
    name: name as string,
    descriptor: Object.getOwnPropertyDescriptor(target, name as string),
  }));
  const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  const rows = new Map<string, string>(),
    trace: unknown[][] = [];
  const releases: (() => void)[] = [];
  const timeouts = new WeakMap<AbortSignal, number>();
  let identity: BookmarkInteractionIdentity | null = copy(actor),
    construction = true,
    sequence = 0,
    storageFailure: "read" | "initial" | "clear" | null = null,
    digestFailure = false,
    held:
      | { reached: () => void; pending: Promise<void>; release: () => void }
      | undefined;
  let call: BookmarkInteractionPorts["call"] = async (method) =>
    method === "bookmarks.list"
      ? [copy(row)]
      : { id: "receipt-A", revision: 1 };
  const store: Storage = {
    get length() {
      return rows.size;
    },
    clear() {
      rows.clear();
    },
    key(index) {
      return [...rows.keys()][index] ?? null;
    },
    getItem(key) {
      trace.push(["read", key]);
      if (storageFailure === "read") throw Error("TEST storage read");
      return rows.get(key) ?? null;
    },
    setItem(key, value) {
      trace.push(["write", key, JSON.parse(value)]);
      if (storageFailure === (value === "null" ? "clear" : "initial"))
        throw Error("TEST storage " + storageFailure);
      rows.set(key, value);
    },
    removeItem(key) {
      trace.push(["remove", key]);
      rows.delete(key);
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: store,
  });
  Object.defineProperty(crypto, "randomUUID", {
    configurable: true,
    value: () => {
      const id = `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
      trace.push(["uuid", id]);
      return id;
    },
  });
  Object.defineProperty(AbortSignal, "timeout", {
    configurable: true,
    value: (ms: number) => {
      const signal = nativeTimeout(ms);
      timeouts.set(signal, ms);
      return signal;
    },
  });
  Object.defineProperty(crypto.subtle, "digest", {
    configurable: true,
    value: async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
      trace.push(["digest", algorithm, new TextDecoder().decode(data)]);
      if (digestFailure) throw Error("TEST digest failure");
      const hash = await nativeDigest(algorithm, data);
      if (held) {
        const wait = held;
        held = undefined;
        wait.reached();
        await wait.pending;
      }
      return hash;
    },
  });
  const options: BookmarkInteractionPorts = {
    current: {
      get current() {
        assert(!construction, "factory must not read identity");
        trace.push(["identity", identity?.csrfToken ?? null]);
        return identity;
      },
    },
    savedInputScope(value) {
      assert(!construction, "factory must not resolve storage scope");
      trace.push(["scope", copy(value)]);
      return scopeOf(value);
    },
    call: async (method, params, options) => {
      assert(!construction, "factory must not issue a request");
      trace.push([
        "call",
        method,
        copy(params),
        options?.identityGeneration,
        options?.signal ? timeouts.get(options.signal) : null,
        options?.signal?.aborted,
      ]);
      return call(method, params, options);
    },
  };
  try {
    const family = (
      fixed ? createOriginalBookmarkInteractions : createBookmarkInteractions
    )(options);
    assert.equal(trace.length, 0);
    construction = false;
    // Observe the original Promise without replacing it or changing its result.
    // Complete migration ledgers include outcome/error and event order, not
    // only request payloads or summary hashes.
    const observe = <T>(name: string, promise: Promise<T>) => {
      void promise.then(
        (value) => trace.push(["resolved", name, copy(value)]),
        (error: unknown) =>
          trace.push([
            "rejected",
            name,
            {
              name: error instanceof Error ? error.name : typeof error,
              message: error instanceof Error ? error.message : String(error),
              status: error instanceof RequestError ? error.status : null,
            },
          ]),
      );
      return promise;
    };
    const originalList = family.bookmarkList,
      originalCommand = family.bookmarkCommand;
    family.bookmarkList = (request) =>
      observe("bookmarkList", originalList(request));
    family.bookmarkCommand = (operation) =>
      observe("bookmarkCommand", originalCommand(operation));
    const result = await run({
      family,
      rows,
      trace,
      setIdentity(value) {
        identity = value;
      },
      setCall(value) {
        call = value;
      },
      failStorage(value) {
        storageFailure = value;
      },
      failDigest(value) {
        digestFailure = value;
      },
      holdDigest() {
        assert.equal(held, undefined);
        const reached = deferred(),
          pending = deferred();
        held = {
          reached: reached.resolve,
          pending: pending.promise,
          release: pending.resolve,
        };
        releases.push(pending.resolve);
        return { reached: reached.promise, release: pending.resolve };
      },
    });
    return { result, trace, storage: [...rows] };
  } finally {
    for (const release of releases) release();
    for (const { target, name, descriptor } of descriptors) {
      if (descriptor) Object.defineProperty(target, name, descriptor);
      else Reflect.deleteProperty(target, name);
    }
  }
}
const reports: { name: string; current: unknown; original?: unknown }[] = [];
async function scenario(name: string, run: Parameters<typeof withFamily>[1]) {
  const current = await withFamily(false, run);
  const original = migration ? await withFamily(true, run) : undefined;
  if (original)
    assert.deepEqual(current, original, name + ": complete old/new ledger");
  reports.push({ name, current, ...(original ? { original } : {}) });
}
const calls = (trace: unknown[][]) =>
  trace.filter((entry) => entry[0] === "call");

test(
  "bookmark family is inert, reads current identity lazily and passes all exact list fields/schema",
  { timeout: 10000 },
  async () => {
    await scenario(
      "lazy-list",
      async ({ family, setIdentity, setCall, trace }) => {
        setIdentity(null);
        await assert.rejects(family.bookmarkList(), /应用尚未就绪/);
        await assert.rejects(family.bookmarkCommand(operation), /应用尚未就绪/);
        setIdentity({ ...actor, capabilities: { browserBookmarks: false } });
        await assert.rejects(family.bookmarkList(), /浏览器收藏尚未接通/);
        await assert.rejects(
          family.bookmarkCommand(operation),
          /浏览器收藏尚未接通/,
        );
        assert.equal(calls(trace).length, 0);
        setIdentity({ ...actor, csrfToken: "current-token" });
        assert.deepEqual(await family.bookmarkList(), [row]);
        const request = {
          query: "题 目",
          url: row.url,
          deleted: true,
          offset: 51,
          limit: 7,
        };
        assert.deepEqual(await family.bookmarkList(request), [row]);
        assert.deepEqual(
          calls(trace).map((r) => r.slice(1)),
          [
            ["bookmarks.list", {}, "current-token", 8000, false],
            ["bookmarks.list", request, "current-token", 8000, false],
          ],
        );
        setCall(async () => [{ ...row, revision: 0 }]);
        await assert.rejects(family.bookmarkList(), /Too small/);
        const failure = new RequestError(403, "TEST denied list");
        setCall(async () => {
          throw failure;
        });
        await assert.rejects(
          family.bookmarkList(),
          (error) => error === failure,
        );
      },
    );
  },
);

test(
  "bookmark SHA/raw JSON, exact actant/window scope, stable whole-command retry and new success ID",
  { timeout: 10000 },
  async () => {
    await scenario(
      "whole-pending",
      async ({ family, trace, rows, setCall }) => {
        const failure = new RequestError(503, "TEST unknown receipt");
        setCall(async () => {
          throw failure;
        });
        await assert.rejects(
          family.bookmarkCommand(operation),
          (e) => e === failure,
        );
        const key = pendingKey(operation),
          saved = JSON.parse(rows.get(key)!);
        assert.deepEqual(saved.operation, operation);
        assert.match(
          key,
          /center-A:human-A:actant-A:draft:.*:pending:bookmark:[a-f0-9]{64}$/,
        );
        // A stored whole command is the retry input, including its original ID.
        setCall(async () => ({ id: "receipt-A", revision: 1 }));
        assert.deepEqual(await family.bookmarkCommand(copy(operation)), {
          id: "receipt-A",
          revision: 1,
        });
        assert.deepEqual(calls(trace)[1]![2], saved);
        assert.equal(rows.get(key), "null");
        await family.bookmarkCommand(copy(operation));
        assert.notEqual(
          (calls(trace)[2]![2] as { commandId: string }).commandId,
          saved.commandId,
        );
        assert.equal(
          trace.some((r) => r[0] === "remove" || r[0] === "refresh"),
          false,
        );
        assert(calls(trace).every((r) => r[4] === 8000));
      },
    );
  },
);

test(
  "bookmark digest checks captured identity before any pending read/write/send; digest failure sends nothing",
  { timeout: 10000 },
  async () => {
    await scenario(
      "digest-switch",
      async ({ family, holdDigest, setIdentity, trace, rows, failDigest }) => {
        const held = holdDigest();
        const pending = family.bookmarkCommand(operation);
        const rejection = assert.rejects(pending, /身份已切换，操作未发送。/);
        try {
          await reachedWithin(held.reached);
          setIdentity({ ...actor, csrfToken: "new-token" });
        } finally {
          held.release();
        }
        await rejection;
        assert.equal(rows.size, 0);
        assert.equal(calls(trace).length, 0);
        assert.equal(
          trace.some((r) => r[0] === "read" || r[0] === "write"),
          false,
        );
        setIdentity(actor);
        failDigest(true);
        await assert.rejects(
          family.bookmarkCommand(operation),
          /TEST digest failure/,
        );
        assert.equal(rows.size, 0);
        assert.equal(calls(trace).length, 0);
      },
    );
  },
);

test(
  "bookmark explicit rejection clears; 408/5xx/general/abort preserve pending and exact error identity",
  { timeout: 10000 },
  async () => {
    await scenario("error-policy", async ({ family, rows, setCall, trace }) => {
      for (const status of [400, 401, 404, 409, 429, 408, 500, 503]) {
        const op: BookmarkOperation = {
          ...operation,
          title: "status-" + status,
        };
        const error = new RequestError(status, "TEST status " + status);
        setCall(async () => {
          throw error;
        });
        await assert.rejects(family.bookmarkCommand(op), (e) => e === error);
        assert.equal(
          rows.get(pendingKey(op)) === "null",
          status < 500 && status !== 408,
        );
      }
      for (const error of [
        Error("TEST transport failure"),
        new DOMException("TEST aborted", "AbortError"),
      ]) {
        const op: BookmarkOperation = { ...operation, title: error.name };
        setCall(async () => {
          throw error;
        });
        await assert.rejects(family.bookmarkCommand(op), (e) => e === error);
        assert.notEqual(rows.get(pendingKey(op)), "null");
      }
      return calls(trace).map((r) => r[2]);
    });
  },
);

test(
  "bookmark real storage fallback and initial/success/error-clear failure ordering is preserved",
  { timeout: 10000 },
  async () => {
    await scenario(
      "storage-order",
      async ({ family, rows, setCall, failStorage, trace }) => {
        failStorage("initial");
        await assert.rejects(
          family.bookmarkCommand(operation),
          /TEST storage initial/,
        );
        assert.equal(calls(trace).length, 0);
        failStorage("read");
        await family.bookmarkCommand(operation); // readLocal's deliberate fallback
        assert.equal(rows.get(pendingKey(operation)), "null");
        failStorage("clear");
        await assert.rejects(
          family.bookmarkCommand(operation),
          /TEST storage clear/,
        );
        const saved = JSON.parse(rows.get(pendingKey(operation))!);
        failStorage(null);
        await family.bookmarkCommand(operation);
        assert.deepEqual(calls(trace).at(-1)![2], saved);
        const error = new RequestError(409, "TEST original rejection");
        setCall(async () => {
          throw error;
        });
        failStorage("clear");
        await assert.rejects(
          family.bookmarkCommand(operation),
          /TEST storage clear/,
        );
        assert.notEqual(rows.get(pendingKey(operation)), "null");
      },
    );
  },
);

test(
  "bookmark concurrent retries share whole command, while operation and all identity scope fields remain separate",
  { timeout: 10000 },
  async () => {
    await scenario(
      "concurrency-scopes",
      async ({ family, trace, rows, setCall, setIdentity }) => {
        const receipt = deferred(),
          reached = deferred();
        let count = 0;
        setCall(async () => {
          if (++count === 2) reached.resolve();
          await receipt.promise;
          return { id: "receipt-A", revision: 1 };
        });
        const one = family.bookmarkCommand(operation),
          two = family.bookmarkCommand(copy(operation));
        try {
          await reachedWithin(reached.promise);
          assert.deepEqual(calls(trace)[0]![2], calls(trace)[1]![2]);
        } finally {
          receipt.resolve();
        }
        await Promise.all([one, two]);
        setCall(async () => {
          throw new RequestError(408, "TEST uncertain");
        });
        for (const identity of [
          actor,
          { ...actor, centerId: "center-B" },
          { ...actor, principalId: "human-B" },
          { ...actor, actantId: "actant-B" },
        ]) {
          setIdentity(identity);
          await assert.rejects(
            family.bookmarkCommand(operation),
            /TEST uncertain/,
          );
          assert.notEqual(rows.get(pendingKey(operation, identity)), "null");
        }
        setIdentity(actor);
        const next = { ...operation, title: "different operation" };
        await assert.rejects(family.bookmarkCommand(next), /TEST uncertain/);
        assert.notEqual(
          JSON.parse(rows.get(pendingKey(next))!).commandId,
          JSON.parse(rows.get(pendingKey(operation))!).commandId,
        );
      },
    );
  },
);

test(
  "bookmark current bounded receipts and optional full legacy late-result observations remain distinct",
  { timeout: 10000 },
  async () => {
    await scenario("direct-receipt", async ({ family, setCall, rows }) => {
      const receipt = {
        id: "receipt-A",
        revision: 1,
        extension: "unparsed receipt",
      };
      setCall(async () => receipt);
      assert.equal(await family.bookmarkCommand(operation), receipt);
      assert.equal(rows.get(pendingKey(operation)), "null");
    });
    // Historical migration observations, not permanent policy for a future fix.
    if (migration)
      await scenario(
        "legacy-late-result",
        async ({ family, setCall, setIdentity, rows, trace }) => {
          const wait = deferred(),
            reached = deferred();
          setCall(async () => {
            reached.resolve();
            await wait.promise;
            return { id: "late", revision: 1 };
          });
          const pending = family.bookmarkCommand(operation);
          try {
            await reachedWithin(reached.promise);
            setIdentity({ ...actor, csrfToken: "retired" });
          } finally {
            wait.resolve();
          }
          assert.deepEqual(await pending, { id: "late", revision: 1 });
          assert.equal(rows.get(pendingKey(operation)), "null");
          const mutable = copy(operation),
            digest = createHash("sha256")
              .update(JSON.stringify(mutable))
              .digest("hex");
          setIdentity(actor);
          const response = family.bookmarkCommand(mutable);
          mutable.title = "changed after hash capture";
          await response;
          assert.equal(
            rows.get(
              "morphz:" +
                scopeOf(actor) +
                ":" +
                draftKey("pending:bookmark:" + digest),
            ),
            "null",
          );
          const corrupted = {
            commandId: "unvalidated-saved-command",
            operation: { type: "legacy-unvalidated" },
          };
          rows.set(pendingKey(operation), JSON.stringify(corrupted));
          await family.bookmarkCommand(operation);
          assert.deepEqual(calls(trace).at(-1)![2], corrupted);
        },
      );
    const evidence = process.env.MORPHZ_TEST_BOOKMARK_EVIDENCE_DIR;
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      writeFileSync(
        join(evidence, "behavior-ledgers.json"),
        JSON.stringify(
          { provenance: originalBookmarkMetadata, migration, reports },
          null,
          2,
        ),
      );
    }
    console.log(
      JSON.stringify({
        bookmarkBehavior: reports.map(({ name, current, original }) => ({
          name,
          sha256: createHash("sha256")
            .update(JSON.stringify(current))
            .digest("hex"),
          paired: !!original,
        })),
      }),
    );
  },
);
