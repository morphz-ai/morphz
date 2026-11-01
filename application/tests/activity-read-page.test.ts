import test from "node:test";
import assert from "node:assert/strict";
import {
  ActivityReadPages,
  type ActivityReadDemand,
} from "../packages/application/src/activity-read-page.js";
const complete = {
  has_more_threads: false,
  has_more_objectives: false,
  has_more_schedules: false,
};
const sources = Array.from(
  { length: 1200 },
  (_, i) => `TEST-context-${String(i).padStart(4, "0")}`,
);
const accepted = (d: ActivityReadDemand) =>
  d.observed?.({
    currentAvailable: true,
    historyAvailable: true,
    current: complete,
    history: complete,
  });
test("each Activity reader owns one explicit physical source page, including empty sources", async () => {
  const pages = new ActivityReadPages(),
    calls: string[] = [];
  const options = {
    owner: () => ["TEST-user", sources],
    contexts: sources,
    read: async (ctx: string, d: ActivityReadDemand) => {
      calls.push(ctx);
      assert.equal(d.limit, 50);
      accepted(d);
    },
  };
  const first = await pages.read(options);
  assert.deepEqual(calls, [sources[0]]);
  assert.equal(first.hasMore, true);
  const other = await pages.read(options);
  assert.deepEqual(calls, [sources[0], sources[0]]);
  await pages.read({ ...options, cursor: first.nextCursor! });
  assert.equal(calls.at(-1), sources[1]);
  await pages.read({ ...options, cursor: other.nextCursor! });
  assert.equal(calls.at(-1), sources[1]);
  assert.equal(
    calls.length,
    4,
    "another reader cannot advance this reader's cursor, and empty pages are never drained",
  );
});
test("child continuations are independent, advance once and retain their originating Context", async () => {
  const pages = new ActivityReadPages(),
    calls: ActivityReadDemand[] = [];
  const options = {
    owner: () => ["TEST-owner"],
    contexts: sources,
    read: async (ctx: string, d: ActivityReadDemand) => {
      assert.equal(ctx, sources[0]);
      calls.push(d);
      d.observed?.({
        currentAvailable: true,
        historyAvailable: true,
        current: {
          ...complete,
          ...(d.cursors?.thread_cursor
            ? {}
            : { has_more_threads: true, next_thread_cursor: "TEST-threads" }),
          ...(!d.cursors?.objective_cursor
            ? { has_more_objectives: true, next_objective_cursor: "TEST-goals" }
            : {}),
        },
        history: complete,
      });
    },
  };
  let page = await pages.read(options);
  page = await pages.read({ ...options, cursor: page.nextCursor! });
  assert.deepEqual(calls[1]?.cursors, { thread_cursor: "TEST-threads" });
  assert.equal(calls[1]?.history, false);
  await pages.read({ ...options, cursor: page.nextCursor! });
  assert.deepEqual(calls[2]?.cursors, { objective_cursor: "TEST-goals" });
  assert.equal(calls[2]?.append, true);
  assert.equal(calls.length, 3);
});
test("a failed page keeps the exact coordinate for explicit retry without a timer", async () => {
  const pages = new ActivityReadPages();
  let fail = false,
    reads = 0;
  const options = {
    owner: () => ["TEST-owner"],
    contexts: sources,
    read: async (_c: string, d: ActivityReadDemand) => {
      reads++;
      if (fail)
        d.observed?.({ currentAvailable: false, historyAvailable: false });
      else accepted(d);
    },
  };
  const head = await pages.read(options);
  fail = true;
  const failed = await pages.read({ ...options, cursor: head.nextCursor! });
  assert.equal(failed.nextCursor, head.nextCursor);
  assert.equal(failed.retry, true);
  assert.equal(reads, 2);
  fail = false;
  await pages.read({ ...options, cursor: failed.nextCursor! });
  assert.equal(reads, 3);
});
test("read coordinates recheck current identity and source grants before and after I/O", async () => {
  const pages = new ActivityReadPages();
  let actor = "TEST-a",
    reads = 0,
    change = false;
  const options = {
    owner: () => [actor, sources],
    contexts: sources,
    read: async (_c: string, d: ActivityReadDemand) => {
      reads++;
      accepted(d);
      if (change) actor = "TEST-b";
    },
  };
  const head = await pages.read(options);
  actor = "TEST-b";
  await assert.rejects(
    pages.read({ ...options, cursor: head.nextCursor! }),
    /读取范围已变化/,
  );
  assert.equal(reads, 1);
  actor = "TEST-a";
  change = true;
  await assert.rejects(
    pages.read({ ...options, cursor: head.nextCursor! }),
    /读取身份已变化/,
  );
  assert.equal(reads, 2);
});
test("a nonadvancing native cursor cannot turn a More action into an unbounded loop", async () => {
  const pages = new ActivityReadPages();
  const options = {
    owner: () => ["TEST"],
    contexts: sources,
    read: async (_c: string, d: ActivityReadDemand) =>
      d.observed?.({
        currentAvailable: true,
        historyAvailable: true,
        current: {
          ...complete,
          has_more_threads: true,
          next_thread_cursor: "TEST-same",
        },
        history: complete,
      }),
  };
  const first = await pages.read(options);
  await assert.rejects(
    pages.read({ ...options, cursor: first.nextCursor! }),
    /未能推进/,
  );
});
