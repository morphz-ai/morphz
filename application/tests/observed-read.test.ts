import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createObservedRead } from "../apps/web/src/observed-read.js";

function timers() {
  const scheduled = new Map<
    ReturnType<typeof setTimeout>,
    { callback: () => void; delay: number }
  >();
  let sequence = 0;
  return {
    scheduled,
    schedule(callback: () => void, delay: number) {
      const id = ++sequence as unknown as ReturnType<typeof setTimeout>;
      scheduled.set(id, { callback, delay });
      return id;
    },
    unschedule(id: ReturnType<typeof setTimeout>) {
      scheduled.delete(id);
    },
    fire() {
      const [id, timer] = [...scheduled.entries()][0]!;
      scheduled.delete(id);
      timer.callback();
      return timer.delay;
    },
  };
}

test("authoritative HTTP reads are idle after success; an external change invalidates without periodic requests", async () => {
  let version = 1,
    requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ version }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const clock = timers(),
    values: number[] = [];
  const read = createObservedRead({
    ...clock,
    read: async (signal) =>
      (
        await fetch(`http://127.0.0.1:${address.port}`, { signal })
      ).json() as Promise<{ version: number }>,
    publish: (value) => values.push(value.version),
    failed: (cause) => assert.fail(String(cause)),
  });
  try {
    await read.request();
    assert.equal(requests, 1);
    assert.equal(
      clock.scheduled.size,
      0,
      "healthy idle must never schedule another read",
    );
    version = 2;
    await Promise.all(Array.from({ length: 20 }, () => read.request()));
    assert.equal(requests, 2, "a simultaneous burst is one authoritative read");
    assert.deepEqual(values, [1, 2]);
    assert.equal(clock.scheduled.size, 0);
  } finally {
    read.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("invalidation arriving while a stale read is in flight is reconciled by one tail read", async () => {
  let release!: () => void,
    calls = 0,
    version = 1,
    firstSignal: AbortSignal | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const published: number[] = [],
    clock = timers();
  const observer = createObservedRead({
    ...clock,
    read: async (signal) => {
      const captured = version;
      if (++calls === 1) {
        firstSignal = signal;
        await held;
      }
      return captured;
    },
    publish: (value) => published.push(value),
    failed: (error) => assert.fail(String(error)),
  });
  const first = observer.request();
  await Promise.resolve();
  version = 2;
  const second = observer.request();
  assert.equal(
    firstSignal?.aborted,
    true,
    "only the obsolete read token is cancelled",
  );
  assert.equal(first, second);
  release();
  await first;
  assert.deepEqual(
    published,
    [2],
    "an invalidated in-flight snapshot is never published",
  );
  assert.equal(calls, 2);
  assert.equal(clock.scheduled.size, 0);
  observer.close();
});

test("a hint in the completion microtask starts a fresh drain rather than joining a settled read", async () => {
  let calls = 0;
  const observer = createObservedRead({
    read: async () => ++calls,
    publish: () => {},
    failed: (error) => assert.fail(String(error)),
  });
  await observer.request().then(() => observer.request());
  assert.equal(calls, 2);
  observer.close();
});

test("execution coalescing publishes under continuous changes, allows one trailing read and stays idle afterwards", async () => {
  const clock = timers(),
    published: number[] = [];
  const held: { signal: AbortSignal; resolve: (value: number) => void }[] = [];
  const observer = createObservedRead({
    ...clock,
    invalidation: "coalesce",
    read: (signal) =>
      new Promise<number>((resolve) => held.push({ signal, resolve })),
    publish: (value) => published.push(value),
    failed: (error) => assert.fail(String(error)),
  });
  const drain = observer.request();
  await Promise.resolve();
  for (let page = 1; page <= 12; page++) {
    assert.equal(held.length, page, "never more than one in-flight read");
    for (let hint = 0; hint < 20; hint++)
      assert.equal(observer.request(), drain);
    assert.equal(
      held[page - 1]!.signal.aborted,
      false,
      "ordinary updates do not abort authorized reads",
    );
    held[page - 1]!.resolve(page);
    await Promise.resolve();
    assert.equal(
      published.at(-1),
      page,
      "first and subsequent results remain visible even before updates stop",
    );
  }
  assert.equal(
    held.length,
    13,
    "each burst contributes exactly one trailing read",
  );
  held[12]!.resolve(13);
  await drain;
  assert.deepEqual(
    published,
    Array.from({ length: 13 }, (_, i) => i + 1),
  );
  assert.equal(clock.scheduled.size, 0);
  observer.close();
});

test("coalescing never delays scope retirement or publishes old private data after revocation", async () => {
  const values: string[] = [];
  let settle!: (value: string) => void, signal!: AbortSignal;
  const observer = createObservedRead({
    invalidation: "coalesce",
    read: (current) => {
      signal = current;
      return new Promise<string>((resolve) => {
        settle = resolve;
      });
    },
    publish: (value) => values.push(value),
    failed: (error) => assert.fail(String(error)),
  });
  const pending = observer.request();
  await Promise.resolve();
  void observer.request();
  assert.equal(signal.aborted, false);
  observer.close();
  assert.equal(
    signal.aborted,
    true,
    "retirement aborts immediately, even with a pending update",
  );
  settle("private old scope");
  assert.equal(await pending, false);
  assert.equal(await observer.request(), false);
  assert.deepEqual(values, []);
});

test("only failed reads schedule exponential recovery and a successful read removes retry", async () => {
  let failing = true,
    calls = 0;
  const clock = timers(),
    errors: unknown[] = [];
  const observer = createObservedRead({
    ...clock,
    read: async () => {
      calls++;
      if (failing) throw new Error("read unavailable");
      return calls;
    },
    publish: () => {},
    failed: (error) => errors.push(error),
  });
  await observer.request();
  assert.equal([...clock.scheduled.values()][0]!.delay, 1000);
  clock.fire();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal([...clock.scheduled.values()][0]!.delay, 2000);
  failing = false;
  await observer.request();
  assert.equal(calls, 3);
  assert.equal(errors.length, 2);
  assert.equal(clock.scheduled.size, 0);
  observer.close();
});

test("closing a scope aborts publication, stops retries and never restarts the work", async () => {
  let resolve!: (value: number) => void,
    signal!: AbortSignal,
    calls = 0;
  const values: number[] = [],
    clock = timers();
  const observer = createObservedRead({
    ...clock,
    read: (current) => {
      signal = current;
      calls++;
      return new Promise<number>((done) => {
        resolve = done;
      });
    },
    publish: (value) => values.push(value),
    failed: (error) => assert.fail(String(error)),
  });
  const pending = observer.request();
  await Promise.resolve();
  observer.close();
  assert.equal(signal.aborted, true);
  resolve(1);
  await pending;
  await observer.request();
  assert.equal(calls, 1);
  assert.deepEqual(values, []);
  assert.equal(clock.scheduled.size, 0);
});
