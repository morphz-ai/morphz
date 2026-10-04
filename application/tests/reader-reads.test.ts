import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createReaderReads,
  type ReaderReadPorts,
} from "../apps/web/src/data/reader-reads.js";
import { createFixedReaderReads } from "./fixtures/reader-reads-39cf13cf.js";
import {
  fixedReaderHashes,
  parseReaderSources,
  readerFunctionHashes,
  readerMethods,
} from "./fixtures/reader-reads-contract.js";

type Factory = typeof createReaderReads;
type Method = (typeof readerMethods)[number];
const factories = [createFixedReaderReads, createReaderReads];
const now = "2026-10-04T00:00:00.000Z";
const location = {
  sourceId: "book_a@3",
  sectionId: "section_a",
  start: 2,
  end: 8,
};
const preferences = { fontSize: 20, font: "serif", theme: "system" };
const mark = {
  id: "mark_a",
  location,
  quote: "原文",
  kind: "note",
  color: "green",
  note: "批注",
  revision: 2,
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
};
const rawPosition = { location, preferences, revision: 4, updatedAt: now };
function rawFor(method: Method): unknown {
  if (method === "readReading")
    return {
      id: "section_a",
      title: "章节",
      html: "<p>原文</p>",
      text: "原文",
      sourceId: "book_a@3",
      book: { title: "原件", author: "", edition: "", format: "markdown" },
    };
  if (method === "readingContents")
    return [{ id: "section_a", title: "章节", characters: 30 }];
  if (method === "readingState")
    return { position: structuredClone(rawPosition) };
  return {
    marks: [structuredClone(mark)],
    nextCursor: "next-original-page",
    hasMore: true,
  };
}
function deferred() {
  let resolve!: (value: unknown) => void, reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function harness(factory: Factory) {
  const identity = { csrfToken: "identity_a", principalId: "reader_a" };
  const current = { current: identity as typeof identity | null },
    protectedReadGeneration = { current: 0 };
  const calls: Array<{
    method: string;
    params: unknown;
    options: Parameters<ReaderReadPorts["call"]>[2];
    pending: ReturnType<typeof deferred>;
  }> = [];
  const reads = factory({
    current,
    protectedReadGeneration,
    call: (method, params, options) => {
      const pending = deferred();
      calls.push({ method, params, options, pending });
      return pending.promise;
    },
  });
  const invoke = (
    method: Method,
    signal?: AbortSignal,
    request = {
      artifactId: "book_a",
      revision: 3,
      sectionId: "section_a",
      start: 2,
      end: 8,
      after: "original_cursor",
      limit: 50,
    },
  ) => {
    if (method === "readReading")
      return reads.readReading("book_a", 3, "section_a", signal);
    if (method === "readingContents")
      return reads.readingContents("book_a", 3, signal);
    if (method === "readingState")
      return reads.readingState("book_a", 3, signal);
    return reads.readingMarks(request, signal);
  };
  return { current, protectedReadGeneration, calls, reads, invoke };
}
function observe(promise: Promise<unknown>) {
  return promise.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
}
function errorShape(error: unknown) {
  assert.ok(error instanceof Error);
  return { name: error.name, message: error.message };
}
test("the embedded four Git 39cf13cf algorithms retain independently pinned AST hashes", () => {
  const source = readFileSync(
    new URL("./fixtures/reader-reads-39cf13cf.ts", import.meta.url),
    "utf8",
  );
  const parsed = parseReaderSources({ Fixed: source }).get("Fixed")!;
  assert.deepEqual(readerFunctionHashes(parsed), fixedReaderHashes);
  const changed = parseReaderSources({
    Fixed: source.replace("raw.marks.length > 50", "raw.marks.length > 51"),
  }).get("Fixed")!;
  assert.notDeepEqual(readerFunctionHashes(changed), fixedReaderHashes);
});
test("construction borrows refs without reading identity, doing I/O, or creating a projection", () => {
  for (const factory of factories) {
    let identityReads = 0,
      generationReads = 0,
      calls = 0;
    const current = {
      get current() {
        identityReads++;
        return null;
      },
    };
    const protectedReadGeneration = {
      get current() {
        generationReads++;
        return 0;
      },
    };
    const reads = factory({
      current,
      protectedReadGeneration,
      call: async () => {
        calls++;
        return null;
      },
    });
    assert.deepEqual(Object.keys(reads), readerMethods);
    assert.deepEqual([identityReads, generationReads, calls], [0, 0, 0]);
  }
});
for (const method of readerMethods) {
  test(
    method +
      ": original scope, generation and exact caller signal are forwarded once; results retain provenance",
    async () => {
      const outputs: unknown[] = [];
      for (const factory of factories) {
        const h = harness(factory),
          abort = new AbortController();
        const pending = h.invoke(method, abort.signal);
        assert.equal(h.calls.length, 1);
        const call = h.calls[0]!;
        assert.equal(
          call.method,
          {
            readReading: "reader.read",
            readingContents: "reader.contents",
            readingState: "reader.state",
            readingMarks: "reader.marks",
          }[method],
        );
        assert.equal(
          call.options?.signal,
          abort.signal,
          "no timeout or AbortSignal.any wrapper",
        );
        assert.equal(call.options?.identityGeneration, "identity_a");
        assert.deepEqual(Object.keys(call.options!), [
          "identityGeneration",
          "signal",
        ]);
        assert.deepEqual(
          call.params,
          method === "readReading"
            ? { artifactId: "book_a", revision: 3, sectionId: "section_a" }
            : method === "readingMarks"
              ? {
                  artifactId: "book_a",
                  revision: 3,
                  deleted: false,
                  sectionId: "section_a",
                  start: 2,
                  end: 8,
                  after: "original_cursor",
                  offset: 0,
                  limit: 50,
                }
              : { artifactId: "book_a", revision: 3 },
        );
        const raw = rawFor(method);
        call.pending.resolve(raw);
        const value = await pending;
        if (method === "readReading" || method === "readingContents")
          assert.equal(value, raw, "original result reference");
        if (method === "readingState")
          assert.deepEqual(value, {
            position: {
              ...rawPosition,
              artifactId: "book_a",
              artifactRevision: 3,
              ownerPrincipalId: "reader_a",
            },
          });
        if (method === "readingMarks")
          assert.deepEqual(value, {
            marks: [
              {
                ...mark,
                artifactId: "book_a",
                artifactRevision: 3,
                ownerPrincipalId: "reader_a",
              },
            ],
            nextCursor: "next-original-page",
            hasMore: true,
          });
        assert.equal(h.current.current?.principalId, "reader_a");
        assert.equal(h.protectedReadGeneration.current, 0);
        assert.equal(
          h.calls.length,
          1,
          "no refresh or eager continuation read",
        );
        outputs.push(value);
      }
      assert.deepEqual(outputs[1], outputs[0]);
    },
  );
  test(
    method + ": absent identity fails before request validation or transport",
    async () => {
      for (const factory of factories) {
        const h = harness(factory);
        h.current.current = null;
        const outcome = await observe(h.invoke(method));
        assert.deepEqual(errorShape(outcome.error), {
          name: "Error",
          message: "应用尚未就绪，请稍后重试。",
        });
        assert.equal(h.calls.length, 0);
        if (method === "readingMarks")
          await assert.rejects(
            h.reads.readingMarks({ artifactId: "", revision: 0 }),
            /应用尚未就绪/,
          );
      }
    },
  );
  for (const change of [
    "abort",
    "csrf",
    "retired",
    "regrant",
    "same-identity-refresh",
  ] as const) {
    test(
      method + ": preserves original completion policy after " + change,
      async () => {
        const outcomes: unknown[] = [];
        for (const factory of factories) {
          const h = harness(factory),
            abort = new AbortController();
          const outcome = observe(h.invoke(method, abort.signal));
          if (change === "abort") abort.abort(new Error("caller cancellation"));
          if (change === "csrf")
            h.current.current = {
              csrfToken: "identity_b",
              principalId: "reader_b",
            };
          if (change === "retired") h.current.current = null;
          if (change === "regrant") {
            h.protectedReadGeneration.current++;
            h.current.current = null;
            h.protectedReadGeneration.current++;
            h.current.current = {
              csrfToken: "identity_a",
              principalId: "reader_a",
            };
          }
          if (change === "same-identity-refresh")
            h.current.current = { ...h.current.current! };
          h.calls[0]!.pending.resolve(rawFor(method));
          const settled = await outcome;
          // This fake transport deliberately returns even after cancellation. The
          // directory historically relies on the real transport, unlike the other three.
          if (
            method === "readingContents" ||
            change === "same-identity-refresh"
          ) {
            assert.equal(settled.error, undefined);
            outcomes.push(settled.value);
          } else {
            assert.deepEqual(errorShape(settled.error), {
              name: "Error",
              message: "阅读权限已变化，请重新读取。",
            });
            outcomes.push(errorShape(settled.error));
          }
          assert.equal(h.calls.length, 1);
        }
        assert.deepEqual(outcomes[1], outcomes[0]);
      },
    );
  }
  test(
    method +
      ": original transport rejection identity wins over later authorization state",
    async () => {
      for (const factory of factories) {
        const h = harness(factory),
          failure = new Error("actual transport failure");
        const outcome = observe(h.invoke(method));
        h.current.current = null;
        h.calls[0]!.pending.reject(failure);
        assert.equal((await outcome).error, failure);
      }
    },
  );
}
test("state preserves null and rejects malformed authoritative location/preferences only after permission check", async () => {
  for (const factory of factories) {
    const h = harness(factory);
    const empty = h.reads.readingState("book_a", 3);
    h.calls[0]!.pending.resolve({ position: null });
    assert.deepEqual(await empty, { position: null });
    const malformed = observe(h.reads.readingState("book_a", 3));
    h.calls[1]!.pending.resolve({
      position: { ...rawPosition, preferences: { fontSize: 99 } },
    });
    assert.equal(errorShape((await malformed).error).name, "ZodError");
    const late = observe(h.reads.readingState("book_a", 3));
    h.protectedReadGeneration.current++;
    h.calls[2]!.pending.resolve({
      get position(): never {
        throw new Error("malformed response was accessed too soon");
      },
    });
    assert.match(errorShape((await late).error).message, /阅读权限已变化/);
  }
});
test("marks defaults and parsed query retain original book/version even when the caller mutates its request", async () => {
  for (const factory of factories) {
    const h = harness(factory);
    const request = { artifactId: "book_a", revision: 3 };
    const pending = h.reads.readingMarks(request);
    const call = h.calls[0]!;
    assert.deepEqual(call.params, {
      artifactId: "book_a",
      revision: 3,
      deleted: false,
      offset: 0,
      limit: 50,
    });
    assert.notEqual(call.params, request);
    request.artifactId = "book_b";
    request.revision = 9;
    const raw = {
      marks: [
        {
          ...mark,
          artifactId: "spoofed_book",
          artifactRevision: 99,
          ownerPrincipalId: "other_reader",
        },
      ],
      nextCursor: null,
      hasMore: false,
    };
    call.pending.resolve(raw);
    const result = await pending;
    assert.deepEqual(result.marks[0], {
      ...mark,
      artifactId: "book_a",
      artifactRevision: 3,
      ownerPrincipalId: "reader_a",
    });
    assert.deepEqual([result.nextCursor, result.hasMore], [null, false]);
  }
});
test("marks invalid requests fail before transport and do not expand visible-range/cursor scope", async () => {
  for (const factory of factories) {
    const h = harness(factory);
    for (const request of [
      { artifactId: "book_a", revision: 3, limit: 51 },
      { artifactId: "book_a", revision: 3, start: 1, end: 2 },
      {
        artifactId: "book_a",
        revision: 3,
        sectionId: "section_a",
        start: 8,
        end: 2,
      },
      { artifactId: "book_a", revision: 3, after: "cursor", offset: 1 },
      { artifactId: "book_a", revision: 3, extraScope: "book_b" },
    ])
      await assert.rejects(
        h.reads.readingMarks(request),
        (error: unknown) => error instanceof Error && error.name === "ZodError",
      );
    assert.equal(h.calls.length, 0);
  }
});
test("marks page/mark validation remains bounded and permission failure precedes inspecting an obsolete response", async () => {
  for (const factory of factories) {
    const h = harness(factory);
    for (const raw of [
      {
        marks: Array.from({ length: 51 }, () => mark),
        nextCursor: null,
        hasMore: false,
      },
      { marks: [], nextCursor: null, hasMore: "yes" },
      { marks: [], nextCursor: 42, hasMore: false },
    ]) {
      const outcome = observe(
        h.reads.readingMarks({ artifactId: "book_a", revision: 3 }),
      );
      h.calls.at(-1)!.pending.resolve(raw);
      assert.deepEqual(errorShape((await outcome).error), {
        name: "Error",
        message: "标注分页结果无效。",
      });
    }
    const invalidMark = observe(
      h.reads.readingMarks({ artifactId: "book_a", revision: 3 }),
    );
    h.calls.at(-1)!.pending.resolve({
      marks: [{ ...mark, revision: 0 }],
      nextCursor: null,
      hasMore: false,
    });
    assert.equal(errorShape((await invalidMark).error).name, "ZodError");
    const late = observe(
      h.reads.readingMarks({ artifactId: "book_a", revision: 3 }),
    );
    h.protectedReadGeneration.current++;
    h.calls.at(-1)!.pending.resolve({
      get marks(): never {
        throw new Error("obsolete page accessed too soon");
      },
    });
    assert.match(errorShape((await late).error).message, /阅读权限已变化/);
  }
});
test("the family performs independent reads without cache/coalescing or automatic next-page I/O", async () => {
  for (const factory of factories) {
    const h = harness(factory);
    for (const method of readerMethods) {
      const first = h.invoke(method),
        second = h.invoke(method);
      assert.notEqual(first, second);
      const calls = h.calls.slice(-2);
      assert.equal(calls.length, 2);
      assert.notEqual(calls[0]!.pending, calls[1]!.pending);
      assert.deepEqual(calls[0]!.options, {
        identityGeneration: "identity_a",
        signal: undefined,
      });
      calls[1]!.pending.resolve(rawFor(method));
      calls[0]!.pending.resolve(rawFor(method));
      assert.deepEqual(await first, await second);
    }
    assert.equal(
      h.calls.length,
      8,
      "hasMore never causes an extra Client read",
    );
  }
});
test("marks accepts exactly fifty ordered rows and preserves deleted/point/cursor semantics", async () => {
  for (const factory of factories) {
    const h = harness(factory);
    const pending = h.reads.readingMarks({
      artifactId: "book_a",
      revision: 3,
      deleted: true,
      sectionId: "section_a",
      start: 5,
      end: 5,
      after: "bound_cursor",
      limit: 50,
    });
    assert.deepEqual(h.calls[0]!.params, {
      artifactId: "book_a",
      revision: 3,
      deleted: true,
      sectionId: "section_a",
      start: 5,
      end: 5,
      after: "bound_cursor",
      offset: 0,
      limit: 50,
    });
    const marks = Array.from({ length: 50 }, (_, index) => ({
      ...mark,
      id: "mark_" + index,
      deletedAt: now,
    }));
    h.calls[0]!.pending.resolve({
      marks,
      hasMore: true,
      nextCursor: "next_scope_cursor",
    });
    const result = await pending;
    assert.deepEqual(
      result.marks.map((row) => [row.id, row.deletedAt]),
      marks.map((row) => [row.id, row.deletedAt]),
    );
    assert.deepEqual(
      [result.hasMore, result.nextCursor],
      [true, "next_scope_cursor"],
    );
    assert.equal(h.calls.length, 1);
  }
});
