import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  createReaderInteractions,
  type ReaderInteractionIdentity,
  type ReaderInteractionPorts,
} from "../apps/web/src/data/reader-interactions.js";
import { RequestError } from "../apps/web/src/application-transport.js";
import type { ReaderCommand } from "../packages/core/src/reader.js";
import {
  createFixedReaderInteractions,
  fixedReaderInteractions,
} from "./fixtures/reader-interactions-21cb34dc-behavior.js";

const migration =
  process.env.MORPHZ_TEST_READER_INTERACTIONS_MIGRATION_EQUIVALENCE === "1";
const identityA = {
  centerId: "center-A",
  principalId: "human-A",
  csrfToken: "csrf-A",
};
const status = {
  available: true,
  installed: false,
  downloadBytes: 1,
  state: "idle" as const,
};
const position: ReaderCommand = {
  action: "save-position",
  artifactId: "book-A",
  artifactRevision: 2,
  location: { sourceId: "source-A", sectionId: "section-A", start: 0, end: 0 },
  preferences: { fontSize: 20, font: "sans", theme: "paper" },
  expectedRevision: 0,
};
const book = () =>
  new File(["# 章节\n\n确切原件。"], "TEST-reading.md", {
    type: "text/markdown",
  });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
    assert.fail("expected rejection");
  } catch (error) {
    assert(error instanceof Error);
    return error.message;
  }
}

// Narrow per-scenario ports and browser primitives; not a replacement Client.
// Actual HTTP/private-store coverage is in reader-interactions-client.test.ts.
async function withFamily<T>(
  fixed: boolean,
  run: (fixture: {
    family: ReturnType<typeof createReaderInteractions>;
    rows: Map<string, string>;
    trace: unknown[][];
    setIdentity(value: ReaderInteractionIdentity | null): void;
    setCall(value: ReaderInteractionPorts["call"]): void;
    setRefresh(value: () => Promise<boolean>): void;
    failStorage(value: "write" | "remove" | null): void;
    holdDigest(index: number): { reached: Promise<void>; release(): void };
  }) => Promise<T>,
) {
  const storageDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "localStorage",
    ),
    uuid = Object.getOwnPropertyDescriptor(crypto, "randomUUID"),
    digest = Object.getOwnPropertyDescriptor(crypto.subtle, "digest"),
    timeout = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
  const nativeDigest = crypto.subtle.digest.bind(crypto.subtle),
    nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  const rows = new Map<string, string>(),
    trace: unknown[][] = [],
    timeouts = new WeakMap<AbortSignal, number>();
  let sequence = 0,
    identity: ReaderInteractionIdentity | null = identityA,
    construction = true,
    reads = 0,
    failure: "write" | "remove" | null = null,
    digestCount = 0,
    held:
      | { index: number; reached: () => void; promise: Promise<void> }
      | undefined;
  const store: Storage = {
    get length() {
      return rows.size;
    },
    clear() {
      rows.clear();
    },
    key(i) {
      return [...rows.keys()][i] ?? null;
    },
    getItem(key) {
      return rows.get(key) ?? null;
    },
    setItem(key, value) {
      trace.push(["write", key, JSON.parse(value)]);
      if (failure === "write") throw Error("storage write failure");
      rows.set(key, value);
    },
    removeItem(key) {
      trace.push(["remove", key]);
      if (failure === "remove") throw Error("storage remove failure");
      rows.delete(key);
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: store,
  });
  Object.defineProperty(crypto, "randomUUID", {
    configurable: true,
    value: () =>
      `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
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
    value: async (...args: Parameters<SubtleCrypto["digest"]>) => {
      const result = await nativeDigest(...args);
      digestCount++;
      if (held?.index === digestCount) {
        held.reached();
        await held.promise;
      }
      return result;
    },
  });
  let call: ReaderInteractionPorts["call"] = async (method) =>
    method === "reader.ocr"
      ? status
      : method === "reader.import"
        ? { entityId: "book-A" }
        : { id: "receipt-A", revision: 1 };
  let refresh = async () => true;
  const options: ReaderInteractionPorts = {
    current: {
      get current() {
        reads++;
        if (construction) throw Error("constructor identity read");
        return identity;
      },
    },
    call: async (method, params, options) => {
      trace.push([
        "call",
        method,
        params,
        options?.identityGeneration,
        options?.signal ? (timeouts.get(options.signal) ?? "borrowed") : null,
        options?.signal?.aborted ?? false,
      ]);
      return call(method, params, options);
    },
    refreshAfterMutation: async () => {
      trace.push(["refresh"]);
      return refresh();
    },
  };
  try {
    const family = (
      fixed ? createFixedReaderInteractions : createReaderInteractions
    )(options);
    construction = false;
    assert.equal(reads, 0);
    assert.equal(trace.length, 0);
    return await run({
      family,
      rows,
      trace,
      setIdentity(value) {
        identity = value;
      },
      setCall(value) {
        call = value;
      },
      setRefresh(value) {
        refresh = value;
      },
      failStorage(value) {
        failure = value;
      },
      holdDigest(index) {
        const gate = deferred<void>(),
          reached = deferred<void>();
        held = {
          index: digestCount + index,
          reached: () => reached.resolve(),
          promise: gate.promise,
        };
        return {
          reached: reached.promise,
          release() {
            gate.resolve();
          },
        };
      },
    });
  } finally {
    if (storageDescriptor)
      Object.defineProperty(globalThis, "localStorage", storageDescriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
    for (const [owner, key, descriptor] of [
      [crypto, "randomUUID", uuid],
      [crypto.subtle, "digest", digest],
      [AbortSignal, "timeout", timeout],
    ] as const) {
      if (descriptor) Object.defineProperty(owner, key, descriptor);
      else Reflect.deleteProperty(owner, key);
    }
  }
}
async function lanes<T>(run: Parameters<typeof withFamily<T>>[1]) {
  const current = await withFamily(false, run);
  if (migration)
    assert.deepEqual(
      await withFamily(true, run),
      current,
      "complete original/current family observation",
    );
}

test("independent Git21cb complete three-method archive has original raw hashes", () => {
  assert.equal(
    fixedReaderInteractions.git,
    "21cb34dc4d3c975247feda810d4d15f70c678737",
  );
  assert.deepEqual(Object.keys(fixedReaderInteractions.methods), [
    "importReading",
    "readingOcr",
    "readerCommand",
  ]);
  for (const method of Object.values(fixedReaderInteractions.methods))
    assert.equal(
      createHash("sha256").update(method.raw).digest("hex"),
      method.sha256,
    );
});
test("inert owner, not-ready rejection and three original call/refresh/timeout contracts", async () => {
  await lanes(async ({ family, trace, setIdentity }) => {
    setIdentity(null);
    for (const invoke of [
      () => family.importReading(book(), "project-A"),
      () => family.readerCommand("book-A", 2, position),
      () =>
        family.readingOcr({
          operation: "status",
          artifactId: "book-A",
          revision: 2,
          page: 1,
        }),
    ])
      assert.match(await errorOf(invoke()), /应用尚未就绪/);
    assert.equal(trace.length, 0);
    setIdentity(identityA);
    assert.deepEqual(await family.importReading(book(), "project-A"), {
      entityId: "book-A",
    });
    assert.deepEqual(await family.readerCommand("book-A", 2, position), {
      id: "receipt-A",
      revision: 1,
    });
    const abort = new AbortController();
    assert.equal(
      await family.readingOcr(
        { operation: "status", artifactId: "book-A", revision: 2, page: 1 },
        abort.signal,
        "csrf-A",
      ),
      status,
    );
    const calls = trace.filter(([kind]) => kind === "call");
    assert.deepEqual(
      calls.map(([, method, , , ms]) => [method, ms]),
      [
        ["reader.import", 35000],
        ["reader.command", 12000],
        ["reader.ocr", "borrowed"],
      ],
    );
    assert.equal(
      trace.filter(([kind]) => kind === "refresh").length,
      1,
      "only import confirms catalog",
    );
    assert.equal(
      (calls[0]![2] as { relativePath: string }).relativePath,
      "TEST-reading.md",
    );
    assert.deepEqual((calls[1]![2] as { command: unknown }).command, position);
    return trace;
  });
});
test("import lost receipt, confirmation false/error, retry ID and new explicit success ID", async () => {
  await lanes(async ({ family, rows, trace, setCall, setRefresh }) => {
    let lose = true;
    setCall(async () => {
      if (lose) {
        lose = false;
        throw Error("lost import receipt");
      }
      return { entityId: "book-A" };
    });
    assert.match(
      await errorOf(family.importReading(book(), "project-A")),
      /lost import/,
    );
    assert.equal(rows.size, 1);
    const first = [...rows.values()][0]!;
    setRefresh(async () => false);
    assert.match(
      await errorOf(family.importReading(book(), "project-A")),
      /目录尚未刷新/,
    );
    assert.equal([...rows.values()][0], first);
    setRefresh(async () => {
      throw Error("refresh rejected");
    });
    assert.match(
      await errorOf(family.importReading(book(), "project-A")),
      /refresh rejected/,
    );
    assert.equal([...rows.values()][0], first);
    setRefresh(async () => true);
    await family.importReading(book(), "project-A");
    assert.equal(rows.size, 0);
    await family.importReading(book(), "project-A");
    const ids = trace
      .filter(([, method]) => method === "reader.import")
      .map(([, , params]) => (params as { commandId: string }).commandId);
    assert.deepEqual(ids.slice(0, 4), [ids[0], ids[0], ids[0], ids[0]]);
    assert.notEqual(ids[4], ids[0]);
    for (const code of [400, 403, 408, 500, 503]) {
      setCall(async () => {
        throw new RequestError(code, "import request failure");
      });
      await errorOf(family.importReading(book(), "project-A"));
      const pending = [...rows.values()][0];
      assert(
        pending,
        "import retains every unconfirmed error, unlike reader commands",
      );
      setCall(async () => ({ entityId: "book-A" }));
      await family.importReading(book(), "project-A");
      const last = trace
        .filter(([, method]) => method === "reader.import")
        .slice(-2);
      assert.equal(
        (last[0]![2] as { commandId: string }).commandId,
        (last[1]![2] as { commandId: string }).commandId,
      );
      assert.equal(rows.size, 0);
    }
    return { ids, trace };
  });
});
test("import file/each digest identity interleaving and post-confirmation authority", async () => {
  await lanes(
    async ({ family, trace, rows, setIdentity, setRefresh, holdDigest }) => {
      const bytes = deferred<ArrayBuffer>();
      const fake = book();
      Object.defineProperty(fake, "arrayBuffer", {
        value: () => bytes.promise,
      });
      let outcome = family.importReading(fake, "project-A").then(
        () => "unexpected",
        (e) => e.message,
      );
      setIdentity({
        centerId: "center-B",
        principalId: "human-B",
        csrfToken: "csrf-B",
      });
      bytes.resolve(new TextEncoder().encode("book").buffer);
      assert.match(await outcome, /文件未发送/);
      assert.equal(trace.filter(([kind]) => kind === "call").length, 0);
      for (const index of [1, 2]) {
        setIdentity(identityA);
        const held = holdDigest(index);
        outcome = family.importReading(book(), "project-digest-" + index).then(
          () => "unexpected",
          (e) => e.message,
        );
        await held.reached;
        setIdentity({ ...identityA, csrfToken: "csrf-B" });
        held.release();
        assert.match(await outcome, /文件未发送/);
      }
      setIdentity(identityA);
      setRefresh(async () => {
        setIdentity({ ...identityA, csrfToken: "csrf-B" });
        return true;
      });
      assert.match(
        await errorOf(family.importReading(book(), "project-confirm")),
        /导入结果尚未确认/,
      );
      assert.equal(
        rows.size,
        4,
        "all original unconfirmed identities remain durable",
      );
      for (const key of rows.keys())
        assert(
          key.includes("center-A:human-A:"),
          "storage uses captured owner, not the new identity",
        );
      return trace;
    },
  );
});
test("reader command status-specific ID cleanup and no refresh/post-completion guard", async () => {
  await lanes(async ({ family, trace, rows, setCall, setIdentity }) => {
    const seen: string[] = [];
    let fail: number | null = 400;
    setCall(async (_method, params) => {
      seen.push((params as { commandId: string }).commandId);
      if (fail !== null) throw new RequestError(fail, "request failure");
      return { id: "mark-A", revision: 1 };
    });
    for (const status of [400, 401, 403, 409, 408, 500, 503]) {
      rows.clear();
      fail = status;
      await errorOf(family.readerCommand("book-A", 2, position));
      assert.equal(
        [...rows.values()].some((v) => v !== "null"),
        status === 408 || status >= 500,
      );
      const previous = seen.at(-1);
      fail = null;
      await family.readerCommand("book-A", 2, position);
      if (status === 408 || status >= 500) assert.equal(seen.at(-1), previous);
      else assert.notEqual(seen.at(-1), previous);
      assert.deepEqual([...rows.values()], ["null"]);
      await family.readerCommand("book-A", 2, position);
      assert.notEqual(seen.at(-1), seen.at(-2));
    }
    assert.equal(trace.filter(([kind]) => kind === "refresh").length, 0);
    if (migration) {
      setCall(async () => {
        setIdentity({ ...identityA, csrfToken: "csrf-B" });
        return { id: "captured-old-receipt", revision: 1 };
      });
      assert.deepEqual(
        await family.readerCommand("book-A", 2, position),
        { id: "captured-old-receipt", revision: 1 },
        "old command has no owner post-identity guard; transport has its own epoch guard",
      );
    }
    return trace;
  });
});
test("reader digest identity switch, storage durability/finalization failures and fingerprints", async () => {
  await lanes(
    async ({
      family,
      rows,
      trace,
      setIdentity,
      setCall,
      failStorage,
      holdDigest,
    }) => {
      const held = holdDigest(1);
      const outcome = family.readerCommand("book-A", 2, position).then(
        () => "unexpected",
        (e) => e.message,
      );
      await held.reached;
      setIdentity({ ...identityA, csrfToken: "csrf-B" });
      held.release();
      assert.match(await outcome, /阅读操作未发送/);
      assert.equal(trace.filter(([kind]) => kind === "call").length, 0);
      setIdentity(identityA);
      failStorage("write");
      assert.match(
        await errorOf(family.readerCommand("book-A", 2, position)),
        /storage write/,
      );
      assert.match(
        await errorOf(family.importReading(book(), "project-A")),
        /storage write/,
      );
      assert.equal(trace.filter(([kind]) => kind === "call").length, 0);
      failStorage(null);
      setCall(async () => {
        failStorage("write");
        return { id: "mark-A", revision: 1 };
      });
      assert.match(
        await errorOf(family.readerCommand("book-A", 2, position)),
        /storage write/,
      );
      assert([...rows.values()].some((v) => v !== "null"));
      failStorage(null);
      setCall(async () => {
        failStorage("remove");
        return { entityId: "book-A" };
      });
      assert.match(
        await errorOf(family.importReading(book(), "project-A")),
        /storage remove/,
      );
      assert([...rows.keys()].some((k) => k.includes("pending:file-import:")));
      failStorage(null);
      setCall(async () => {
        throw Error("uncertain");
      });
      rows.clear();
      for (const [id, revision, command] of [
        ["book-A", 2, position],
        ["book-A", 3, position],
        ["book-B", 2, position],
        ["book-A", 2, { ...position, expectedRevision: 1 }],
      ] as const)
        await errorOf(family.readerCommand(id, revision, command));
      assert.equal(rows.size, 4);
      for (const key of rows.keys())
        assert.match(key, /pending:reader:[a-f0-9]{64}$/);
      return trace;
    },
  );
});
test("OCR exact borrowed signal/generation, original no timeout, late abort/identity and failures", async () => {
  await lanes(async ({ family, trace, setIdentity, setCall }) => {
    const request = {
      operation: "status" as const,
      artifactId: "book-A",
      revision: 2,
      page: 1,
    };
    assert.match(
      await errorOf(family.readingOcr(request, undefined, "wrong")),
      /阅读权限已变化/,
    );
    assert.equal(trace.length, 0);
    const signal = new AbortController();
    let same = false;
    setCall(async (_method, params, options) => {
      same = params === request && options?.signal === signal.signal;
      signal.abort();
      return status;
    });
    assert.match(
      await errorOf(family.readingOcr(request, signal.signal)),
      /阅读权限已变化/,
    );
    assert.equal(same, true);
    setCall(async () => {
      setIdentity({ ...identityA, csrfToken: "csrf-B" });
      return status;
    });
    assert.match(await errorOf(family.readingOcr(request)), /阅读权限已变化/);
    setIdentity(identityA);
    setCall(async () => {
      throw Error("OCR port failure");
    });
    assert.match(await errorOf(family.readingOcr(request)), /OCR port failure/);
    setCall(async () => status);
    assert.equal(await family.readingOcr(request), status);
    assert(
      trace
        .filter(([kind]) => kind === "call")
        .every(
          ([, method, , , ms]) =>
            method === "reader.ocr" && (ms === null || ms === "borrowed"),
        ),
    );
    assert.equal(trace.filter(([kind]) => kind === "refresh").length, 0);
    return trace;
  });
});
