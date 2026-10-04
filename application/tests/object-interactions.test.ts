import assert from "node:assert/strict";
import test from "node:test";
import { createObjectInteractions } from "../apps/web/src/data/object-interactions.js";
import { executePlatformOperation, type Boot } from "../apps/web/src/client.js";
import type { PlatformClient } from "../apps/web/src/platform-client.js";
import type { Operation, Workspace } from "../packages/core/src/model.js";
import {
  createFixedObjectInteractions,
  fixedExecuteObjectOperation,
} from "./fixtures/object-interactions-original.js";

// Actual current factory/Client gateway. Only the optional migration lane uses
// the independently frozen original algorithms. These ports are not HTTP/ACL.
const migration =
  process.env.MORPHZ_TEST_OBJECT_INTERACTIONS_MIGRATION_EQUIVALENCE === "1";
const note = (n: number): Workspace["annotations"][number] => ({
  id: "note-" + n,
  artifactId: "original-object",
  artifactRevision: 2,
  quote: "原文",
  page: 3,
  body: "批注 " + n,
  author: { principalId: "human", actantId: "human-actant" },
  createdAt: "2026-01-01T00:00:00.000Z",
});
const row = (ordinal: number) => ({ ordinal, annotation: note(ordinal) });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const identity = () => ({ workspace: { revision: 7 } }) as Boot;
const factory = (old: boolean) =>
  old ? createFixedObjectInteractions : createObjectInteractions;
async function compare<T>(run: (old: boolean) => Promise<T>) {
  const actual = await run(false);
  if (migration)
    assert.deepEqual(
      actual,
      await run(true),
      "explicit complete old/current algorithm ledger",
    );
  return actual;
}
const write = (
  old: boolean,
  source: PlatformClient,
  boot: Boot,
  operation: Extract<Operation, { type: "annotate" | "link-artifacts" }>,
  commandId = "command-one",
) =>
  old
    ? fixedExecuteObjectOperation(source, boot, { commandId, operation })
    : executePlatformOperation(source, boot, { commandId, operation }, false);
const annotation: Extract<Operation, { type: "annotate" }> = {
  type: "annotate",
  artifactId: "off-head-content",
  artifactRevision: 2,
  quote: "确切旧原文",
  page: 3,
  body: "批注原值",
};
function source(values: Record<string, unknown> = {}) {
  return {
    boot: { csrfToken: "original-csrf" },
    listObjectAnnotations: async () => [],
    allWorkRelations: async () => [],
    getContent: async () => ({
      id: "resolved-content",
      appId: "morphz.objects",
      availability: "available",
    }),
    annotateObject: async () => ({ ignored: true }),
    linkWork: async () => "existing-edge",
    ...values,
  } as unknown as PlatformClient;
}

test("object construction reads no borrowed refs; exact admission differs by family", async () => {
  await compare(async (old) => {
    const events: string[] = [],
      ports = {
        get current() {
          events.push("current");
          return null;
        },
      };
    const readers = factory(old)({
      current: ports,
      platform: {
        get current() {
          events.push("platform");
          return null;
        },
      },
    });
    assert.deepEqual(events, []);
    assert.deepEqual(Object.keys(readers), [
      "listObjectAnnotations",
      "workRelationsFor",
    ]);
    await assert.rejects(
      readers.listObjectAnnotations("content"),
      /身份已变化，批注未读取/,
    );
    await assert.rejects(
      readers.workRelationsFor("object"),
      /身份已变化，关联未读取/,
    );
    const calls: string[] = [],
      read = factory(old)({
        current: { current: { csrfToken: "different" } },
        platform: {
          current: source({
            listObjectAnnotations: async () => {
              calls.push("annotation");
              return [];
            },
            allWorkRelations: async () => {
              calls.push("relation");
              return [];
            },
          }),
        },
      });
    await assert.rejects(read.listObjectAnnotations("content"));
    await assert.rejects(read.workRelationsFor("object"));
    assert.deepEqual(calls, []);
    return { events, calls };
  });
});
test("object annotation exact ordinal pages: first omit cursor, short before cursor, full cursor progression and 100x100 overflow", async () => {
  await compare(async (old) => {
    const cases = [];
    for (const mode of [
      "empty",
      "short",
      "full-short",
      "short-old-cursor",
      "stalled",
      "overflow",
    ]) {
      const calls: { id: string; options: unknown }[] = [],
        signal = new AbortController().signal;
      const readers = factory(old)({
        current: { current: { csrfToken: "original-csrf" } },
        platform: {
          current: source({
            listObjectAnnotations: async (
              id: string,
              options: unknown,
              given: AbortSignal,
            ) => {
              assert.equal(given, signal);
              const page = calls.length;
              calls.push({ id, options });
              if (mode === "empty") return [];
              if (mode === "short") return [row(0)];
              if (page === 0 || mode === "overflow" || mode === "stalled")
                return Array.from({ length: 100 }, (_, n) =>
                  row(mode === "stalled" ? n : page * 100 + n),
                );
              return mode === "short-old-cursor" ? [row(0)] : [row(100)];
            },
          }),
        },
      });
      let count: number | null = null,
        error: string | null = null;
      try {
        count = (
          await readers.listObjectAnnotations("off-head-content", signal)
        ).length;
      } catch (e) {
        assert(e instanceof Error);
        error = e.message;
      }
      assert.deepEqual(calls[0], {
        id: "off-head-content",
        options: { limit: 100 },
      });
      if (mode === "overflow") {
        assert.equal(calls.length, 100);
        assert.equal(error, "批注数量超过当前可读取范围。");
      } else if (mode === "stalled") {
        assert.equal(calls.length, 2);
        assert.equal(error, "批注分页游标未推进。");
      } else {
        assert.equal(error, null);
        assert.equal(count, mode === "empty" ? 0 : mode === "short" ? 1 : 101);
      }
      if (calls.length > 1)
        assert.deepEqual(calls[1]!.options, { limit: 100, afterOrdinal: 99 });
      cases.push({ mode, count, error, calls });
    }
    return cases;
  });
});
test("object annotation schema and transport errors propagate; held reads retain original source/signal with no new post-await guard", async () => {
  await compare(async (old) => {
    const failure = Error("原请求失败"),
      signal = new AbortController().signal,
      held = deferred<unknown[]>(),
      events: unknown[] = [];
    const current: { current: { csrfToken: string } | null } = {
        current: { csrfToken: "original-csrf" },
      },
      platform = {
        current: source({
          listObjectAnnotations: async (
            id: string,
            options: unknown,
            given: AbortSignal,
          ) => {
            assert.equal(given, signal);
            events.push([id, options]);
            return held.promise;
          },
        }) as PlatformClient | null,
      };
    const readers = factory(old)({ current, platform });
    const pending = readers.listObjectAnnotations("original-id", signal);
    current.current = { csrfToken: "new-csrf" };
    platform.current = source({ boot: { csrfToken: "new-csrf" } });
    held.resolve([row(0)]);
    assert.deepEqual(await pending, [note(0)]);
    const errors: string[] = [];
    for (const value of [
      [{ ...row(0), ordinal: -1 }],
      [{ ...row(0), annotation: { ...note(0), body: "" } }],
    ]) {
      platform.current = source({
        boot: { csrfToken: "new-csrf" },
        listObjectAnnotations: async () => value,
      });
      await assert.rejects(readers.listObjectAnnotations("new-id"), (e) => {
        assert(e instanceof Error);
        errors.push(e.constructor.name);
        return e.constructor.name === "ZodError";
      });
    }
    platform.current = source({
      boot: { csrfToken: "new-csrf" },
      listObjectAnnotations: async () => {
        throw failure;
      },
    });
    await assert.rejects(
      readers.listObjectAnnotations("new-id"),
      (e) => e === failure,
    );
    return { events, errors };
  });
});
test("object relation read directly delegates exact object/signal and preserves result identity and original error", async () => {
  await compare(async (old) => {
    const relations = [
        { id: "edge", fromId: "original-object", toId: "other-object" },
      ],
      signal = new AbortController().signal,
      events: unknown[] = [];
    const failure = Error("原关系页失败"),
      platform = {
        current: source({
          allWorkRelations: async (id: string, given: AbortSignal) => {
            assert.equal(given, signal);
            events.push(id);
            return relations;
          },
        }),
      };
    const readers = factory(old)({
      current: { current: { csrfToken: "original-csrf" } },
      platform,
    });
    assert.equal(
      await readers.workRelationsFor("original-object", signal),
      relations,
    );
    platform.current = source({
      allWorkRelations: async () => {
        throw failure;
      },
    });
    await assert.rejects(
      readers.workRelationsFor("original-object"),
      (e) => e === failure,
    );
    return events;
  });
});
test("object Client dispatch annotation borrows exact resolved ID/historical revision/page; done reads captured identity object at completion", async () => {
  await compare(async (old) => {
    const events: unknown[] = [],
      held = deferred<unknown>(),
      boot = identity();
    const actualSource = source({
      getContent: async (id: string) => {
        events.push(["getContent", id]);
        return {
          id: "resolved-content",
          appId: "morphz.objects",
          availability: "available",
        };
      },
      annotateObject: async (value: unknown) => {
        events.push(["annotateObject", value]);
        return held.promise;
      },
    });
    const pending = write(old, actualSource, boot, annotation);
    await Promise.resolve();
    assert.equal(events.length, 2);
    boot.workspace.revision = 9;
    held.resolve({ id: "ignored-server-result" });
    const receipt = await pending;
    assert.deepEqual(receipt, {
      commandId: "command-one",
      entityId: "command-one",
      workspaceRevision: 10,
    });
    assert.deepEqual(events, [
      ["getContent", "off-head-content"],
      [
        "annotateObject",
        {
          commandId: "command-one",
          contentId: "resolved-content",
          revision: 2,
          quote: annotation.quote,
          page: 3,
          body: annotation.body,
        },
      ],
    ]);
    const omitted: unknown[] = [],
      noPage = { ...annotation };
    delete noPage.page;
    await write(
      old,
      source({
        annotateObject: async (value: unknown) => {
          omitted.push(value);
        },
      }),
      identity(),
      noPage,
    );
    assert.equal(Object.hasOwn(omitted[0] as object, "page"), false);
    return { events, receipt, omitted };
  });
});
test("object Client dispatch preserves unsent original class and zero write; relation uses returned edge ID without annotation pre-read", async () => {
  await compare(async (old) => {
    const errors: [string, string][] = [],
      calls: unknown[] = [];
    for (const entry of [
      { id: "id", appId: "morphz.reader", availability: "available" },
      { id: "id", appId: "morphz.objects", availability: "unavailable" },
    ])
      await assert.rejects(
        write(
          old,
          source({
            getContent: async () => entry,
            annotateObject: async () => {
              throw Error("must not write");
            },
          }),
          identity(),
          annotation,
        ),
        (e) => {
          assert(e instanceof Error);
          errors.push([e.constructor.name, e.message]);
          return e.constructor.name === "UnsentOperationError";
        },
      );
    const failure = Error("原link失败"),
      operation: Extract<Operation, { type: "link-artifacts" }> = {
        type: "link-artifacts",
        fromId: "from",
        toId: "to",
        relation: "references",
      };
    const receipt = await write(
      old,
      source({
        getContent: async () => {
          throw Error("no relation pre-read");
        },
        linkWork: async (value: unknown) => {
          calls.push(value);
          return "existing-edge";
        },
      }),
      identity(),
      operation,
    );
    assert.equal(receipt.entityId, "existing-edge");
    assert.deepEqual(calls, [
      {
        commandId: "command-one",
        fromId: "from",
        toId: "to",
        kind: "references",
      },
    ]);
    await assert.rejects(
      write(
        old,
        source({
          linkWork: async () => {
            throw failure;
          },
        }),
        identity(),
        operation,
      ),
      (e) => e === failure,
    );
    return { errors, calls, receipt };
  });
});
