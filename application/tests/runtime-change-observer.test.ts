import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { RuntimeChangeObserver } from "../packages/application/src/runtime-change-observer.js";
import { createObservedRead } from "../apps/web/src/observed-read.js";
import {
  deferred,
  pause,
  runtimeChangeFixture,
  until,
} from "./runtime-change-fixture.js";

const typedState = z.object({
  jobs: z.array(
    z.object({
      id: z.string(),
      revision: z.number().int().positive(),
      status: z.string(),
      progress: z.number(),
    }),
  ),
  approvals: z.array(
    z.object({
      id: z.string(),
      revision: z.number().int().positive(),
      status: z.string(),
    }),
  ),
  schedules: z.array(
    z.object({
      id: z.string(),
      revision: z.number().int().positive(),
      status: z.string(),
    }),
  ),
});

test("committed WS events wake authoritative typed HTTP reads without a message; healthy idle, foreign, duplicate and transient frames do not read", async () => {
  const peer = await runtimeChangeFixture();
  const published: z.infer<typeof typedState>[] = [];
  const failures: unknown[] = [];
  const read = createObservedRead({
    read: async () =>
      typedState.parse(
        await peer.request("/api/sessions/session-one/typed-state"),
      ),
    publish: (value) => published.push(value),
    failed: (error) => failures.push(error),
  });
  const observer = new RuntimeChangeObserver({
    url: peer.origin,
    sessions: () => [{ id: "session-one", cursor: 0 }],
    headers: () => ({ Authorization: `Bearer ${peer.token}` }),
    request: peer.request,
    changed: () => void read.request(),
  });
  const typedReads = () =>
    peer.requests.filter((request) => request.path.endsWith("/typed-state"))
      .length;
  try {
    await observer.sync();
    await until(() => published.length > 0, "initial typed read not published");
    await pause(30);
    const baseline = typedReads();
    const transportBaseline = peer.requests.length;
    await pause(3300);
    assert.equal(typedReads(), baseline, "no 2s/3s healthy query loop");
    assert.equal(
      peer.requests.length,
      transportBaseline,
      "no idle history replay",
    );
    assert.equal(peer.opens.length, 1);
    assert.deepEqual(failures, []);

    const mutate = async (topic: string, change: () => void) => {
      const before = typedReads();
      change();
      const event = peer.append("session-one", topic, { entity_revision: 2 });
      await until(
        () => typedReads() === before + 1,
        `${topic} did not wake HTTP`,
      );
      await until(
        () => JSON.stringify(published.at(-1)) === JSON.stringify(peer.state),
        `${topic} authoritative response was not published`,
      );
      await pause(30);
      assert.equal(
        typedReads(),
        before + 1,
        "one distinct event => one settled read",
      );
      return event;
    };
    const job = await mutate("runtime/execution_progress", () => {
      peer.state.jobs[0]!.revision = 2;
      peer.state.jobs[0]!.progress = 0.5;
    });
    await mutate("runtime/approval_requested", () => {
      peer.state.approvals.push({
        id: "approval-one",
        revision: 2,
        status: "pending",
      });
    });
    await mutate("runtime/schedule_updated", () => {
      peer.state.schedules[0]!.revision = 2;
      peer.state.schedules[0]!.status = "completed";
    });
    assert.equal(
      [...peer.events.values()]
        .flat()
        .some((event) => event.topic.startsWith("chat/")),
      false,
      "no chat Event is used to manufacture the wake",
    );

    const beforeIgnored = typedReads();
    peer.send("session-one", job); // Duplicate and old cursor.
    peer.send("session-one", {
      ...job,
      sequence: 100,
      payload: { session_id: "foreign" },
    });
    peer.send("session-one", {
      ...job,
      sequence: 0,
      topic: "runtime/model_stream",
    });
    const { sequence: _sequence, ...transient } = job;
    peer.send("session-one", { ...transient, topic: "runtime/model_stream" });
    peer.send("session-one", {
      ...job,
      sequence: null,
      topic: "runtime/model_stream",
    });
    peer.send("session-one", "{bad-json");
    await pause(120);
    assert.equal(typedReads(), beforeIgnored);
    await observer.sync();
    assert.equal(
      peer.opens.length,
      1,
      "sync reuses the healthy session subscription",
    );
    assert.equal(
      peer.requests.filter((request) => request.path.includes("/events?"))
        .length,
      1,
      "sync never replays history while connected",
    );
    for (const request of peer.requests)
      assert.equal(request.headers.authorization, `Bearer ${peer.token}`);
    assert.equal(peer.opens[0]!.headers.authorization, `Bearer ${peer.token}`);

    observer.close();
    read.close();
    await until(
      () => peer.active() === 0,
      "disposal did not close Runtime socket",
    );
    const afterClose = peer.requests.length;
    peer.append("session-one", "runtime/execution_finished");
    await pause(120);
    assert.equal(
      peer.requests.length,
      afterClose,
      "disposed view cannot read or reconnect",
    );
  } finally {
    observer.close();
    read.close();
    await peer.close();
  }
});

test("disconnect replays committed events after the accepted cursor and resyncs; successful recovery returns to idle", async () => {
  const peer = await runtimeChangeFixture();
  const changed: string[] = [];
  const observer = new RuntimeChangeObserver({
    url: peer.origin,
    sessions: () => [{ id: "session-one", cursor: 0 }],
    headers: () => ({ Authorization: `Bearer ${peer.token}` }),
    request: peer.request,
    changed: (id) => changed.push(id),
  });
  try {
    await observer.sync();
    const initial = changed.length;
    peer.append("session-one", "runtime/approval_requested");
    await until(
      () => changed.length === initial + 1,
      "first committed event missing",
    );
    peer.disconnect("session-one");
    await until(
      () => changed.length === initial + 2,
      "disconnect did not invalidate freshness",
    );
    peer.append("session-one", "runtime/approval_decision", {}, false);
    peer.append("session-one", "runtime/thread_terminal", {}, false);
    await until(
      () => peer.opens.length === 2,
      "disconnect did not reopen Runtime WS",
    );
    await until(
      () => changed.length === initial + 5,
      "missed events plus resync were not delivered",
    );
    assert.deepEqual(
      peer.requests
        .filter((request) => request.path.includes("/events?"))
        .map((request) => request.path),
      [
        "/api/sessions/session-one/events?after_sequence=0&limit=1000",
        "/api/sessions/session-one/events?after_sequence=1&limit=1000",
      ],
    );
    assert.equal(peer.active(), 1);
    const baseline = peer.requests.length;
    await pause(2300);
    assert.equal(
      peer.opens.length,
      2,
      "successful recovery cancels the retry cadence",
    );
    assert.equal(peer.requests.length, baseline);
  } finally {
    observer.close();
    await peer.close();
  }
});

test("subscribing before paginated catchup prevents a concurrent live event from skipping an older committed page", async () => {
  const peer = await runtimeChangeFixture();
  for (let i = 0; i < 1001; i++)
    peer.append("session-one", "runtime/thread_terminal", {}, false);
  const gate = deferred();
  let catchingUp = false;
  peer.intercept(async (path) => {
    if (path.endsWith("events?after_sequence=0&limit=1000")) {
      const firstPage = peer.events.get("session-one")!.slice(0, 1000);
      catchingUp = true;
      await gate.promise;
      return { body: { events: firstPage } };
    }
  });
  const changed: string[] = [];
  const observer = new RuntimeChangeObserver({
    url: peer.origin,
    sessions: () => [{ id: "session-one", cursor: 0 }],
    headers: () => ({ Authorization: `Bearer ${peer.token}` }),
    request: peer.request,
    changed: (id) => changed.push(id),
  });
  try {
    await until(() => catchingUp, "initial event page was not requested");
    assert.equal(peer.active(), 1, "WS must be subscribed before HTTP catchup");
    peer.append("session-one", "runtime/approval_requested");
    await until(() => changed.length === 1, "live event blocked by catchup");
    gate.resolve();
    await observer.sync();
    assert.deepEqual(
      peer.requests
        .filter((request) => request.path.includes("/events?"))
        .map((request) => request.path),
      [
        "/api/sessions/session-one/events?after_sequence=0&limit=1000",
        "/api/sessions/session-one/events?after_sequence=1000&limit=1000",
      ],
      "the history cursor must not jump to the live sequence 1002",
    );
    assert.equal(
      changed.length,
      2,
      "coarse live invalidation and final authoritative resync suffice",
    );
    peer.disconnect("session-one");
    await until(
      () => peer.opens.length === 2,
      "cursor verification reconnect did not open",
    );
    await until(
      () =>
        peer.requests.some((request) =>
          request.path.endsWith("events?after_sequence=1002&limit=1000"),
        ),
      "recovery did not preserve accepted live cursor",
    );
  } finally {
    gate.resolve();
    observer.close();
    await peer.close();
  }
});

test("removing a session during its permission read cannot open the old socket or emit an old-identity wake", async () => {
  const peer = await runtimeChangeFixture(["session-one", "session-two"]);
  const gate = deferred();
  let readStarted = false;
  peer.intercept(async (path) => {
    if (path === "/api/sessions/session-one") {
      readStarted = true;
      await gate.promise;
      return { body: { id: "session-one" } };
    }
  });
  let sessions = [{ id: "session-one", cursor: 0 }];
  const changed: string[] = [];
  const observer = new RuntimeChangeObserver({
    url: peer.origin,
    sessions: () => sessions,
    headers: () => ({ Authorization: `Bearer ${peer.token}` }),
    request: peer.request,
    changed: (id) => changed.push(id),
  });
  try {
    await until(() => readStarted, "old permission read did not start");
    sessions = [{ id: "session-two", cursor: 0 }];
    const replacement = observer.sync();
    gate.resolve();
    await replacement;
    assert.deepEqual(
      peer.opens.map((open) => open.sessionId),
      ["session-two"],
    );
    assert.deepEqual(changed, ["session-two"]);
    sessions = [];
    await observer.sync();
    await until(
      () => peer.active() === 0,
      "removed session socket did not close",
    );
    peer.send("session-two", {
      id: "late",
      sequence: 1,
      topic: "runtime/approval_requested",
      payload: { session_id: "session-two" },
    });
    await pause(50);
    assert.deepEqual(changed, ["session-two"]);
  } finally {
    gate.resolve();
    observer.close();
    await peer.close();
  }
});

test("disposal during a held permission read creates no socket and no wake after the HTTP reply", async () => {
  const peer = await runtimeChangeFixture();
  const gate = deferred();
  let started = false;
  peer.intercept(async (path) => {
    if (path === "/api/sessions/session-one") {
      started = true;
      await gate.promise;
    }
  });
  let wakes = 0;
  const observer = new RuntimeChangeObserver({
    url: peer.origin,
    sessions: () => [{ id: "session-one", cursor: 0 }],
    headers: () => ({ Authorization: `Bearer ${peer.token}` }),
    request: peer.request,
    changed: () => wakes++,
  });
  try {
    const reading = observer.sync();
    await until(() => started, "permission read did not start");
    observer.close();
    gate.resolve();
    await reading;
    await pause(40);
    assert.equal(wakes, 0);
    assert.equal(peer.opens.length, 0);
    assert.equal(peer.requests.length, 1);
  } finally {
    gate.resolve();
    observer.close();
    await peer.close();
  }
});

test("committed EventBus wire hints without a sequence wake once per ID, never advance replay cursor, and reconcile with sequenced durable history", async () => {
  const peer = await runtimeChangeFixture();
  const changed: string[] = [];
  const observer = new RuntimeChangeObserver({
    url: peer.origin,
    sessions: () => [{ id: "session-one", cursor: 0 }],
    headers: () => ({ Authorization: `Bearer ${peer.token}` }),
    request: peer.request,
    changed: (id) => changed.push(id),
  });
  try {
    await observer.sync();
    const initial = changed.length;
    const committed = peer.append(
      "session-one",
      "chat/tool_output",
      { job_id: "job-one", revision: 2 },
      false,
    );
    const { sequence: _sequence, ...wire } = committed;
    peer.send("session-one", { ...wire, payload: { session_id: "foreign" } });
    peer.send("session-one", wire);
    await until(
      () => changed.length === initial + 1,
      "unsequenced committed wire did not wake",
    );
    peer.send("session-one", wire);
    peer.send("session-one", wire);
    for (const topic of [
      "runtime/model_stream",
      "runtime/model_request_snapshot",
      "runtime/model_attempt_snapshot",
    ]) {
      peer.send("session-one", { ...wire, id: "ephemeral-" + topic, topic });
      peer.send("session-one", {
        ...wire,
        id: "sequenced-ephemeral-" + topic,
        topic,
        sequence: 500,
      });
    }
    await pause(80);
    assert.equal(
      changed.length,
      initial + 1,
      "same ID or model telemetry must not reread",
    );
    peer.disconnect("session-one");
    await until(
      () => changed.length === initial + 2,
      "disconnect freshness hint missing",
    );
    peer.append("session-one", "runtime/approval_decision", {}, false);
    await until(() => peer.opens.length === 2, "recovery WS missing");
    await until(
      () => changed.length === initial + 4,
      "durable replay plus resync incomplete",
    );
    assert.deepEqual(
      peer.requests
        .filter((request) => request.path.includes("/events?"))
        .map((request) => request.path),
      [
        "/api/sessions/session-one/events?after_sequence=0&limit=1000",
        "/api/sessions/session-one/events?after_sequence=0&limit=1000",
      ],
      "an unsequenced hint (and even sequenced model telemetry) cannot skip durable replay",
    );
    assert.equal(
      changed.length,
      initial + 4,
      "replayed already-seen ID advances cursor without a duplicate wake",
    );
    peer.disconnect("session-one");
    await until(
      () => peer.opens.length === 3,
      "second cursor-check connection missing",
    );
    await until(
      () =>
        peer.requests.some((request) =>
          request.path.endsWith("events?after_sequence=2&limit=1000"),
        ),
      "only strictly sequenced durable replay should advance the recovery cursor",
    );
  } finally {
    observer.close();
    await peer.close();
  }
});

test("an unsequenced persisted history page is rejected; bounded failure recovery re-reads the same cursor", async () => {
  const peer = await runtimeChangeFixture();
  const committed = peer.append(
    "session-one",
    "runtime/approval_requested",
    {},
    false,
  );
  const { sequence: _sequence, ...invalidHistory } = committed;
  let first = true;
  peer.intercept(async (path) => {
    if (path.includes("/events?") && first) {
      first = false;
      return { body: { events: [invalidHistory] } };
    }
  });
  const changed: string[] = [];
  const observer = new RuntimeChangeObserver({
    url: peer.origin,
    sessions: () => [{ id: "session-one", cursor: 0 }],
    headers: () => ({ Authorization: `Bearer ${peer.token}` }),
    request: peer.request,
    changed: (id) => changed.push(id),
  });
  try {
    await observer.sync();
    assert.equal(
      changed.length,
      1,
      "invalid persisted history may invalidate availability, not act as a durable event",
    );
    await until(
      () => peer.active() === 0,
      "invalid replay did not close its socket",
    );
    await until(
      () => peer.opens.length === 2,
      "bounded failed-replay retry missing",
    );
    await until(
      () => changed.length === 3,
      "valid durable event and successful resync missing",
    );
    assert.deepEqual(
      peer.requests
        .filter((request) => request.path.includes("/events?"))
        .map((request) => request.path),
      [
        "/api/sessions/session-one/events?after_sequence=0&limit=1000",
        "/api/sessions/session-one/events?after_sequence=0&limit=1000",
      ],
    );
    assert.equal(peer.active(), 1);
  } finally {
    observer.close();
    await peer.close();
  }
});

test("a denied Runtime session permission read opens no socket; only failed reads retry and restored access becomes idle", async () => {
  const peer = await runtimeChangeFixture();
  let denied = true;
  peer.intercept(async (path) => {
    if (denied && path === "/api/sessions/session-one")
      return { status: 403, body: { error: "forbidden" } };
  });
  let wakes = 0;
  const observer = new RuntimeChangeObserver({
    url: peer.origin,
    sessions: () => [{ id: "session-one", cursor: 0 }],
    headers: () => ({ Authorization: `Bearer ${peer.token}` }),
    request: peer.request,
    changed: () => wakes++,
  });
  try {
    await observer.sync();
    assert.equal(wakes, 1);
    assert.equal(
      peer.opens.length,
      0,
      "permission is checked before WS upgrade",
    );
    assert.equal(peer.requests.length, 1);
    denied = false;
    await until(
      () => peer.opens.length === 1,
      "permission recovery did not subscribe",
    );
    await until(
      () => wakes === 2,
      "permission recovery lacks authoritative resync",
    );
    assert.equal(
      peer.requests.length,
      3,
      "failed session read, successful session read, one replay",
    );
    await pause(2300);
    assert.equal(peer.requests.length, 3);
    assert.equal(peer.opens.length, 1);
  } finally {
    observer.close();
    await peer.close();
  }
});
