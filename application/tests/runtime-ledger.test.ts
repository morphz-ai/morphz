import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { RuntimeBridge } from "../packages/application/src/runtime.js";
import {
  localAccess,
  morphzAgentAccess,
  type RecordedInput,
} from "../packages/core/src/model.js";

test("Runtime bridge persists deliveries and events outside the singleton envelope", () => {
  const folder = mkdtempSync(join(tmpdir(), "morphz-ledger-"));
  const filename = join(folder, "workspace.sqlite");
  const event = {
    id: "event-1",
    sequence: 1,
    timestamp: "2026-09-27T00:00:00.000Z",
    topic: "chat/reply",
    payload: { text: "one" },
  };
  const original = {
    namespace: "namespace-1",
    endpoint: "http://127.0.0.1:1",
    connected: false,
    sessions: {
      "session-1": {
        id: "session-1",
        projectId: "project-1",
        cursor: 1,
        events: [event],
      },
    },
    deliveries: [
      {
        inputId: "input-1",
        sessionId: "session-1",
        rootId: "event-1",
        state: "running",
        platformSource: { projectId: "project-1" },
        request: { message: { content: { value: { text: "queued body" } } } },
      },
    ],
    publications: {
      "attempt-1": { id: "publication-1", createdAt: event.timestamp },
    },
    threadBindings: { "thread-1": { id: "thread-1" } },
  };
  try {
    const store = new WorkspaceStore(filename);
    store.saveRuntimeState(original);
    assert.deepEqual(store.runtimeState(), original);
    const changed = structuredClone(original);
    changed.deliveries[0]!.state = "completed";
    store.saveRuntimeState(changed);
    assert.deepEqual(store.runtimeState(), changed);
    assert.throws(
      () =>
        store.saveRuntimeState({
          ...changed,
          deliveries: [changed.deliveries[0], changed.deliveries[0]],
        }),
      /投递标识重复/,
    );
    assert.deepEqual(store.runtimeState(), changed, "invalid save is atomic");
    store.close();

    const db = new DatabaseSync(filename);
    const envelope = db
      .prepare("SELECT body FROM runtime_state WHERE id=1")
      .get() as { body: string };
    assert.ok(!envelope.body.includes("queued body"));
    assert.ok(!envelope.body.includes("chat/reply"));
    assert.equal(
      (
        db.prepare("SELECT count(*) AS n FROM runtime_deliveries").get() as {
          n: number;
        }
      ).n,
      1,
    );
    assert.equal(
      (
        db
          .prepare("SELECT count(*) AS n FROM runtime_session_events")
          .get() as { n: number }
      ).n,
      1,
    );
    assert.equal(
      (db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
      20,
    );
    db.close();

    const reopened = new WorkspaceStore(filename);
    assert.deepEqual(reopened.runtimeState(), changed);
    reopened.close();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("version 16 Runtime transport data migrates once without replaying input", () => {
  const folder = mkdtempSync(join(tmpdir(), "morphz-ledger-upgrade-"));
  const filename = join(folder, "workspace.sqlite");
  try {
    const initial = new WorkspaceStore(filename);
    initial.close();
    const old = {
      namespace: "old-namespace",
      endpoint: "http://127.0.0.1:1",
      sessions: {
        "session-1": {
          id: "session-1",
          events: [{ id: "event-1", sequence: 1 }],
        },
      },
      deliveries: [
        {
          inputId: "input-1",
          sessionId: "session-1",
          state: "queued",
          request: { text: "keep" },
        },
      ],
    };
    const db = new DatabaseSync(filename);
    db.prepare("INSERT INTO runtime_state(id,body) VALUES(1,?)").run(
      JSON.stringify(old),
    );
    db.exec("PRAGMA user_version=16");
    db.close();
    const upgraded = new WorkspaceStore(filename);
    assert.deepEqual(upgraded.runtimeState(), old);
    upgraded.close();
    const again = new WorkspaceStore(filename);
    assert.deepEqual(again.runtimeState(), old);
    again.close();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("live Runtime event persistence serializes only the appended tail", () => {
  const store = new WorkspaceStore(":memory:");
  let serializations = 0;
  const event = (sequence: number) => ({
    toJSON() {
      serializations++;
      return { id: `event-${sequence}`, sequence };
    },
  });
  const events = [event(1)];
  const state = {
    sessions: { session: { id: "session", events } },
    deliveries: [],
  };
  try {
    store.saveRuntimeState(state, true);
    assert.equal(serializations, 1);
    store.saveRuntimeState(state, true);
    assert.equal(
      serializations,
      1,
      "unchanged history is not serialized again",
    );
    events.push(event(2));
    store.saveRuntimeState(state, true);
    assert.equal(serializations, 2, "only the appended event is serialized");
    assert.deepEqual(
      (store.runtimeState() as { sessions: { session: { events: unknown[] } } })
        .sessions.session.events,
      [
        { id: "event-1", sequence: 1 },
        { id: "event-2", sequence: 2 },
      ],
    );
  } finally {
    store.close();
  }
});

test("restarted Runtime bridge appends without reserializing historical events", () => {
  const folder = mkdtempSync(join(tmpdir(), "morphz-ledger-restart-tail-"));
  const filename = join(folder, "workspace.sqlite");
  try {
    const first = new WorkspaceStore(filename);
    first.saveRuntimeState(
      {
        sessions: {
          session: {
            id: "session",
            events: Array.from({ length: 1000 }, (_, index) => ({
              id: `event-${index}`,
              sequence: index + 1,
            })),
          },
        },
        deliveries: [],
      },
      true,
    );
    first.close();

    const reopened = new WorkspaceStore(filename);
    const loaded = reopened.runtimeState() as {
      sessions: {
        session: {
          events: Array<{
            id: string;
            sequence: number;
            toJSON?: () => unknown;
          }>;
        };
      };
      deliveries: unknown[];
    };
    let oldSerializations = 0;
    for (const event of loaded.sessions.session.events)
      event.toJSON = () => {
        oldSerializations++;
        return { id: event.id, sequence: event.sequence };
      };
    let newSerializations = 0;
    loaded.sessions.session.events.push({
      id: "event-1000",
      sequence: 1001,
      toJSON: () => {
        newSerializations++;
        return { id: "event-1000", sequence: 1001 };
      },
    });
    reopened.saveRuntimeState(loaded, true);
    assert.equal(oldSerializations, 0);
    assert.equal(newSerializations, 1);
    reopened.close();

    const verified = new WorkspaceStore(filename);
    const history = verified.runtimeState() as typeof loaded;
    assert.equal(history.sessions.session.events.length, 1001);
    assert.deepEqual(history.sessions.session.events.at(-1), {
      id: "event-1000",
      sequence: 1001,
    });
    verified.close();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("Platform bridge persists delivery cursors without mirroring Runtime messages", () => {
  const folder = mkdtempSync(join(tmpdir(), "morphz-platform-ledger-"));
  const filename = join(folder, "workspace.sqlite");
  const event = (id: string, sequence: number) => ({
    id,
    sequence,
    timestamp: "2026-09-29T00:00:00.000Z",
    topic: "chat/reply",
    payload: { text: id },
  });
  try {
    const first = new WorkspaceStore(filename, { mode: "transport" });
    first.saveRuntimeState({
      sessions: {
        platform: { id: "platform", platform: true, cursor: 0, events: [] },
        legacy: { id: "legacy", cursor: 0, events: [] },
      },
      deliveries: [{ inputId: "input-1", state: "running" }],
    });
    const live = first.runtimeBridgeState() as {
      sessions: Record<
        string,
        { cursor: number; events: ReturnType<typeof event>[] }
      >;
      deliveries: Array<{ inputId: string; state: string }>;
    };
    live.sessions.platform!.events.push(event("platform-reply-1", 1));
    live.sessions.legacy!.events.push(event("legacy-reply-1", 1));
    live.sessions.platform!.cursor = 1;
    live.sessions.legacy!.cursor = 1;
    live.deliveries[0]!.state = "completed";
    first.saveRuntimeBridgeState(live);
    assert.deepEqual(first.runtimeSessionEvents("platform"), []);
    assert.deepEqual(first.runtimeSessionEvents("legacy"), [
      event("legacy-reply-1", 1),
    ]);
    assert.equal(live.sessions.platform!.events.length, 0);
    assert.equal(live.sessions.legacy!.events.length, 0);
    first.close();

    const reopened = new WorkspaceStore(filename, { mode: "transport" });
    const resumed = reopened.runtimeBridgeState() as typeof live;
    assert.equal(resumed.sessions.platform!.cursor, 1);
    assert.equal(resumed.sessions.legacy!.cursor, 1);
    assert.equal(resumed.deliveries[0]!.state, "completed");
    resumed.sessions.platform!.events.push(event("platform-reply-2", 2));
    resumed.sessions.legacy!.events.push(event("legacy-reply-2", 2));
    resumed.sessions.platform!.cursor = 2;
    resumed.sessions.legacy!.cursor = 2;
    reopened.saveRuntimeBridgeState(resumed);
    assert.deepEqual(reopened.runtimeSessionEvents("platform"), []);
    assert.deepEqual(reopened.runtimeSessionEvents("legacy"), [
      event("legacy-reply-1", 1),
      event("legacy-reply-2", 2),
    ]);
    reopened.close();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("Platform bridge leaves previously mirrored events untouched", () => {
  const store = new WorkspaceStore(":memory:", { mode: "transport" });
  try {
    const old = { id: "old", sequence: 1 };
    store.saveRuntimeState({
      sessions: {
        platform: { id: "platform", platform: true, cursor: 1, events: [old] },
      },
      deliveries: [],
    });
    const live = store.runtimeBridgeState() as {
      sessions: {
        platform: {
          cursor: number;
          events: Array<{ id: string; sequence: number }>;
        };
      };
    };
    live.sessions.platform.events.push({ id: "new", sequence: 2 });
    live.sessions.platform.cursor = 2;
    store.saveRuntimeBridgeState(live);
    assert.deepEqual(store.runtimeSessionEvents("platform"), [old]);
    assert.equal(
      (store.runtimeBridgeState() as typeof live).sessions.platform.cursor,
      2,
    );
  } finally {
    store.close();
  }
});

test("Runtime bridge validation keeps the append-only Event cursor across restart", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "morphz-ledger-bridge-"));
  const filename = join(folder, "workspace.sqlite");
  const config = {
    url: "http://127.0.0.1:1",
    namespace: "bridge-startup-test",
    token: "test",
  };
  try {
    const first = new WorkspaceStore(filename);
    new RuntimeBridge(first, config);
    const state = first.runtimeState() as {
      sessions: Record<string, unknown>;
      deliveries: unknown[];
    };
    state.sessions.session = {
      id: "session",
      projectId: "project",
      artifactId: null,
      cursor: 1000,
      events: Array.from({ length: 1000 }, (_, index) => ({
        id: `event-${index}`,
        sequence: index + 1,
        timestamp: "2026-09-28T00:00:00.000Z",
        topic: "chat/reply",
        payload: { text: `reply-${index}` },
      })),
    };
    first.saveRuntimeState(state, true);
    first.close();

    const reopened = new WorkspaceStore(filename);
    const db = (reopened as unknown as { db: DatabaseSync }).db;
    const prepare = db.prepare.bind(db);
    let historyComparisons = 0;
    let fullHistoryReads = 0;
    let globalHistoryCounts = 0;
    t.mock.method(db, "prepare", (sql: string) => {
      if (sql.includes("SELECT ordinal,body FROM runtime_session_events"))
        historyComparisons++;
      if (
        sql.includes(
          "SELECT session_id,ordinal,body FROM runtime_session_events",
        )
      )
        fullHistoryReads++;
      if (sql.includes("FROM runtime_session_events GROUP BY session_id"))
        globalHistoryCounts++;
      return prepare(sql);
    });
    const readRuntimeState = reopened.runtimeBridgeState.bind(reopened);
    let loadedEvents: unknown[] | undefined;
    t.mock.method(reopened, "runtimeBridgeState", () => {
      const loaded = readRuntimeState() as typeof state;
      loadedEvents = (loaded.sessions.session as { events: unknown[] }).events;
      return loaded;
    });
    const bridge = new RuntimeBridge(reopened, config);
    const bridgedState = (bridge as unknown as { state: typeof state }).state;
    assert.strictEqual(
      (bridgedState.sessions.session as { events: unknown[] }).events,
      loadedEvents,
      "validating the live bridge must retain its bounded Event tail",
    );
    assert.equal(
      loadedEvents!.length,
      0,
      "startup must not materialize history",
    );
    assert.equal(fullHistoryReads, 0, "startup must not scan Event bodies");
    assert.equal(globalHistoryCounts, 0, "startup must not count every Event");
    (bridgedState.sessions.session as { events: unknown[] }).events.push({
      id: "event-1000",
      sequence: 1001,
      timestamp: "2026-09-28T00:00:01.000Z",
      topic: "chat/reply",
      payload: { text: "new reply" },
    });
    reopened.saveRuntimeBridgeState(bridgedState);
    assert.equal(
      (bridgedState.sessions.session as { events: unknown[] }).events.length,
      0,
      "committed Event tails must not accumulate in Host memory",
    );
    assert.equal(
      historyComparisons,
      0,
      "startup and the next append must not rescan immutable Event rows",
    );
    const loaded = reopened.runtimeState() as typeof state;
    assert.equal(
      (loaded.sessions.session as { events: unknown[] }).events.length,
      1001,
    );
    reopened.close();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("正式 Runtime 状态不读取旧本机事件正文或把它当成会话历史", () => {
  const store = new WorkspaceStore(":memory:", { mode: "transport" });
  const config = {
    url: "http://127.0.0.1:1",
    namespace: "bridge-validation-test",
    token: "test",
  };
  try {
    new RuntimeBridge(store, config);
    const state = store.runtimeState() as { sessions: Record<string, unknown> };
    state.sessions.session = {
      id: "session",
      projectId: "project",
      artifactId: null,
      cursor: 1,
      events: [
        {
          id: "event-1",
          sequence: 1,
          timestamp: "2026-09-28T00:00:00.000Z",
          topic: "chat/reply",
          payload: "invalid historical payload",
        },
      ],
    };
    store.saveRuntimeState(state);
    store.runtimeSessionEvents = () => {
      throw new Error("Local history must not be read");
    };
    const bridge = new RuntimeBridge(store, config, undefined, false);
    assert.deepEqual(bridge.platformStatus().messages, []);
    assert.deepEqual(bridge.platformStatus().deliveries, []);
    assert.equal(
      (store.runtimeState() as typeof state).sessions.session !== undefined,
      true,
    );
  } finally {
    store.close();
  }
});
test("non-append Runtime reconciliation replaces, truncates and removes exact session rows", () => {
  const store = new WorkspaceStore(":memory:");
  try {
    const original = {
      sessions: {
        first: { id: "first", events: [{ id: "a", sequence: 1, text: "old" }] },
        second: {
          id: "second",
          events: [{ id: "b", sequence: 1, text: "keep" }],
        },
      },
      deliveries: [],
    };
    store.saveRuntimeState(original);
    const changed = {
      sessions: {
        first: {
          id: "first",
          events: [
            { id: "a", sequence: 1, text: "revised" },
            { id: "c", sequence: 2, text: "new" },
          ],
        },
      },
      deliveries: [],
    };
    store.saveRuntimeState(changed);
    assert.deepEqual(store.runtimeState(), changed);
    const shortened = {
      sessions: {
        first: {
          ...changed.sessions.first,
          events: changed.sessions.first.events.slice(0, 1),
        },
      },
      deliveries: [],
    };
    store.saveRuntimeState(shortened);
    assert.deepEqual(store.runtimeState(), shortened);
  } finally {
    store.close();
  }
});

test("version 18 Event mirror becomes compact per-input activity and causal links", () => {
  const folder = mkdtempSync(join(tmpdir(), "morphz-ledger-projection-"));
  const filename = join(folder, "workspace.sqlite");
  const event = (
    sequence: number,
    topic: string,
    timestamp: string,
    payload: Record<string, unknown>,
  ) => ({
    id: `event-${sequence}`,
    sequence,
    timestamp,
    topic,
    payload,
  });
  try {
    const initial = new WorkspaceStore(filename);
    initial.saveRuntimeState({
      sessions: {
        shared: {
          id: "shared",
          events: [
            event(1, "runtime/thread_result", "2026-09-28T00:00:00.000Z", {
              root_turn_id: "root-a",
              thread_id: "thread-a",
            }),
            event(2, "runtime/thread_result", "2026-09-28T00:00:00.000Z", {
              root_turn_id: "root-b",
              thread_id: "thread-b",
            }),
            event(3, "chat/reply", "2026-09-28T00:00:01.000Z", {
              covers: ["thread-a", "thread-b"],
              text: "ambiguous",
            }),
            event(4, "chat/reply", "2026-09-28T00:00:02.000Z", {
              root_turn_id: "root-a",
              text: "project a",
            }),
            event(5, "chat/reply", "2026-09-28T00:00:03.000Z", {
              covers: ["thread-b"],
              text: "project b",
            }),
          ],
        },
      },
      deliveries: [
        {
          inputId: "input-a",
          sessionId: "shared",
          rootId: "root-a",
          platformSource: { projectId: "project-a" },
        },
        {
          inputId: "input-b",
          sessionId: "shared",
          rootId: "root-b",
          platformSource: { projectId: "project-b" },
        },
      ],
    });
    initial.close();
    const db = new DatabaseSync(filename);
    db.exec("PRAGMA user_version=18");
    db.close();

    const migrated = new WorkspaceStore(filename);
    const compact = migrated.runtimeBridgeState() as {
      sessions: { shared: { events: unknown[] } };
      deliveries: Array<{
        causalThreadIds: string[];
        lastActivityAt: string;
      }>;
    };
    assert.deepEqual(compact.sessions.shared.events, []);
    assert.deepEqual(compact.deliveries[0]!.causalThreadIds, ["thread-a"]);
    assert.deepEqual(compact.deliveries[1]!.causalThreadIds, ["thread-b"]);
    assert.equal(
      compact.deliveries[0]!.lastActivityAt,
      "2026-09-28T00:00:02.000Z",
    );
    assert.equal(
      compact.deliveries[1]!.lastActivityAt,
      "2026-09-28T00:00:03.000Z",
    );
    assert.equal(migrated.runtimeSessionEvents("shared").length, 5);
    migrated.close();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("failed Event projection upgrade rolls back without changing local deliveries", () => {
  const folder = mkdtempSync(join(tmpdir(), "morphz-ledger-projection-fail-"));
  const filename = join(folder, "workspace.sqlite");
  try {
    const original = new WorkspaceStore(filename);
    original.saveRuntimeState({
      sessions: {
        session: { id: "session", events: [{ id: "old", sequence: 1 }] },
      },
      deliveries: [{ inputId: "pending", sessionId: "session", rootId: "old" }],
    });
    original.close();
    const corrupt = new DatabaseSync(filename);
    const before = corrupt
      .prepare("SELECT body FROM runtime_deliveries WHERE key='pending'")
      .get() as { body: string };
    corrupt
      .prepare(
        "UPDATE runtime_session_events SET body='not-json' WHERE session_id='session'",
      )
      .run();
    corrupt.exec("PRAGMA user_version=18");
    corrupt.close();

    assert.throws(() => new WorkspaceStore(filename), /JSON|position|token/);
    const check = new DatabaseSync(filename);
    assert.equal(
      (check.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
      18,
    );
    assert.deepEqual(
      check
        .prepare("SELECT body FROM runtime_deliveries WHERE key='pending'")
        .get(),
      before,
    );
    check.close();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

for (const count of [1000, 10000])
  test(`Host delivery delta preserves ${count} rows without serializing the queue`, () => {
    const store = new WorkspaceStore(":memory:", { mode: "transport" });
    type Delivery = {
      inputId: string;
      state: string;
      request: { text: string };
      resourceUploads: Array<{ ready: boolean }>;
    };
    try {
      store.saveRuntimeState({
        sessions: { platform: { id: "platform", platform: true, events: [] } },
        deliveries: Array.from({ length: count }, (_, index) => ({
          inputId: `input-${index}`,
          state: "queued",
          request: { text: "原始请求".repeat(128) },
          resourceUploads: [{ ready: false }],
        })),
      });
      const live = store.runtimeBridgeState() as {
        sessions: { platform: { events: unknown[] } };
        deliveries: Delivery[];
      };
      assert.equal(
        live.deliveries.length,
        count,
        "No outstanding input is truncated",
      );
      let serializations = 0;
      for (const delivery of live.deliveries)
        Object.defineProperty(delivery, "toJSON", {
          value: () => {
            serializations++;
            return { ...delivery };
          },
          enumerable: false,
        });
      const replacementMs = [];
      for (let index = 0; index < 20; index++) {
        const start = performance.now();
        store.saveRuntimeBridgeState(live);
        replacementMs.push(performance.now() - start);
      }
      assert.equal(serializations, count * 20);
      serializations = 0;
      // Poison array traversal after the initial real read. An empty/single-row
      // delta must not iterate it, even to discover "which record changed".
      for (const method of ["forEach", Symbol.iterator])
        Object.defineProperty(live.deliveries, method, {
          value: () => {
            throw new Error("Delta commit traversed the entire queue");
          },
          configurable: true,
        });
      store.saveRuntimeBridgeState(live, new Map());
      assert.equal(
        serializations,
        0,
        "A cursor-only commit reads no request body",
      );
      const selected = live.deliveries[Math.floor(count / 2)]!;
      const changedMs = [];
      for (let index = 0; index < 20; index++) {
        selected.resourceUploads[0]!.ready = index % 2 === 0;
        selected.state = index % 2 === 0 ? "running" : "queued";
        const start = performance.now();
        store.saveRuntimeBridgeState(
          live,
          new Map([[selected.inputId, selected]]),
        );
        changedMs.push(performance.now() - start);
      }
      assert.equal(
        serializations,
        20,
        "Only explicitly dirty, including nested, rows serialize",
      );
      const db = (store as unknown as { db: DatabaseSync }).db;
      assert.equal(
        (
          db.prepare("SELECT count(*) AS n FROM runtime_deliveries").get() as {
            n: number;
          }
        ).n,
        count,
      );
      const row = db
        .prepare("SELECT ordinal,body FROM runtime_deliveries WHERE key=?")
        .get(selected.inputId) as { ordinal: number; body: string };
      assert.equal(row.ordinal, Math.floor(count / 2));
      assert.equal(JSON.parse(row.body).resourceUploads[0].ready, false);
      assert.equal(JSON.parse(row.body).state, "queued");
      const stats = (values: number[]) => {
        const ordered = [...values].sort((a, b) => a - b);
        return {
          samples: ordered.length,
          p50: ordered[Math.ceil(ordered.length * 0.5) - 1],
          p95: ordered[Math.ceil(ordered.length * 0.95) - 1],
        };
      };
      console.log(
        "HOST_DELIVERY_DELTA_PERFORMANCE",
        JSON.stringify({
          records: count,
          fullReplacementMs: stats(replacementMs),
          oneChangedDeliveryMs: stats(changedMs),
          fullReplacementSerializations: count * 20,
          deltaSerializations: serializations,
        }),
      );
    } finally {
      store.close();
    }
  });

test("Host delivery delta rollback retains exact requests, ordinals and Event tails for retry", (t) => {
  const store = new WorkspaceStore(":memory:", { mode: "transport" });
  try {
    store.saveRuntimeState({
      sessions: { session: { id: "session", cursor: 0, events: [] } },
      deliveries: [
        {
          inputId: "first",
          sessionId: "session",
          state: "queued",
          request: { client_message_id: "first" },
          resourceUploads: [{ ready: false }],
        },
        {
          inputId: "second",
          state: "running",
          request: { client_message_id: "second" },
        },
      ],
    });
    const live = store.runtimeBridgeState() as {
      sessions: { session: { cursor: number; events: unknown[] } };
      deliveries: Array<{
        inputId: string;
        state: string;
        request: unknown;
        resourceUploads?: Array<{ ready: boolean }>;
      }>;
    };
    const first = live.deliveries[0]!;
    first.state = "running";
    first.resourceUploads![0]!.ready = true;
    const added = {
      inputId: "third",
      state: "queued",
      request: { client_message_id: "third" },
    };
    live.deliveries.push(added);
    live.sessions.session.cursor = 1;
    live.sessions.session.events.push({ id: "new", sequence: 1 });
    const changes = new Map<string, unknown>([
      ["first", first],
      ["third", added],
    ]);
    const db = (store as unknown as { db: DatabaseSync }).db;
    const exec = db.exec.bind(db);
    let failCommit = true;
    t.mock.method(db, "exec", (sql: string) => {
      if (sql === "COMMIT" && failCommit) {
        failCommit = false;
        throw new Error("Controlled SQLite commit failure");
      }
      return exec(sql);
    });
    assert.throws(
      () => store.saveRuntimeBridgeState(live, changes),
      /commit failure/,
    );
    const persisted = () =>
      db
        .prepare(
          "SELECT key,ordinal,body FROM runtime_deliveries ORDER BY ordinal",
        )
        .all() as Array<{ key: string; ordinal: number; body: string }>;
    assert.deepEqual(
      persisted().map((row) => [row.key, row.ordinal]),
      [
        ["first", 0],
        ["second", 1],
      ],
    );
    assert.equal(
      JSON.parse(persisted()[0]!.body).resourceUploads[0].ready,
      false,
    );
    assert.equal(
      live.sessions.session.events.length,
      1,
      "Rollback does not consume uncommitted Events",
    );
    assert.deepEqual(store.runtimeSessionEvents("session"), []);
    store.saveRuntimeBridgeState(live, changes);
    assert.deepEqual(
      persisted().map((row) => [row.key, row.ordinal]),
      [
        ["first", 0],
        ["second", 1],
        ["third", 2],
      ],
    );
    assert.equal(
      JSON.parse(persisted()[0]!.body).resourceUploads[0].ready,
      true,
    );
    assert.deepEqual(store.runtimeSessionEvents("session"), [
      { id: "new", sequence: 1 },
    ]);
    assert.equal(live.sessions.session.events.length, 0);
    store.saveRuntimeBridgeState(live, changes);
    assert.equal(persisted().length, 3, "Retry is not a second enqueue");
    assert.equal(store.runtimeSessionEvents("session").length, 1);
    assert.throws(
      () =>
        store.saveRuntimeBridgeState(
          live,
          new Map([["first", { inputId: "different" }]]),
        ),
      /标识.*不一致/,
    );
    assert.equal(persisted().length, 3);
  } finally {
    store.close();
  }
});

function ledgerInput(id: string): RecordedInput {
  return {
    id,
    projectId: "ledger-project",
    conversationId: "ledger-project",
    artifactId: null,
    artifactRevision: null,
    selection: "",
    body: "保留同一个本机原始请求",
    author: localAccess,
    targetActantId: morphzAgentAccess.actantId,
    // Ledger tests deliberately keep Runtime offline; model admission itself
    // is covered with a live controlled endpoint in input-model-freeze tests.
    model: "isolated-ledger-model",
    status: "recorded",
    createdAt: "2026-09-30T00:00:00.000Z",
  };
}

test("actual RuntimeBridge cancellation marks dirty and retries a failed local commit", async (t) => {
  const store = new WorkspaceStore(":memory:", { mode: "transport" });
  const bridge = new RuntimeBridge(store, {
    url: "http://127.0.0.1:1",
    namespace: "delta-cancel",
    token: "test",
  });
  const tick = bridge.tick.bind(bridge);
  try {
    t.mock.method(bridge, "tick", async () => {});
    t.mock.method(
      bridge as unknown as { request: (path: string) => Promise<unknown> },
      "request",
      async () => {
        throw new Error("Controlled offline Runtime");
      },
    );
    bridge.bindPlatformInputAuthority(async () => ({ sharedDefault: false }));
    bridge.bindPlatformReadAuthority(async () => ({
      personalDefault: false,
      projectIds: ["ledger-project"],
    }));
    await bridge.enqueuePlatformInput(ledgerInput("cancel-input"), {
      title: "本机队列测试",
    });
    const save = store.saveRuntimeBridgeState.bind(store);
    const dirtySets: string[][] = [];
    let fail = true;
    t.mock.method(
      store,
      "saveRuntimeBridgeState",
      (value: unknown, changes?: ReadonlyMap<string, unknown>) => {
        dirtySets.push([...(changes?.keys() ?? [])]);
        if (fail) {
          fail = false;
          throw new Error("Controlled local persistence failure");
        }
        return save(value, changes);
      },
    );
    await assert.rejects(
      bridge.cancelPlatformInput("cancel-input", localAccess),
      /persistence failure/,
    );
    const db = (store as unknown as { db: DatabaseSync }).db;
    const persisted = () =>
      JSON.parse(
        (
          db
            .prepare(
              "SELECT body FROM runtime_deliveries WHERE key='cancel-input'",
            )
            .get() as { body: string }
        ).body,
      );
    assert.equal(
      persisted().state,
      "queued",
      "Failed commit did not settle input",
    );
    await tick();
    assert.equal(persisted().state, "cancelled");
    assert.deepEqual(dirtySets, [["cancel-input"], ["cancel-input"]]);
    assert.equal(persisted().request.client_message_id, "cancel-input");
    await tick();
    assert.deepEqual(
      dirtySets.at(-1),
      [],
      "Cursor-only poll does not reserialize settled inputs",
    );
  } finally {
    await bridge.stop();
    store.close();
  }
});

test("actual RuntimeBridge persists upload readiness, causality and terminal result as delivery deltas", async (t) => {
  const store = new WorkspaceStore(":memory:", { mode: "transport" });
  const config = {
    url: "http://127.0.0.1:1",
    namespace: "delta-upload",
    token: "test",
  };
  const initial = new RuntimeBridge(store, config);
  let bridge: RuntimeBridge | undefined;
  try {
    initial.bindPlatformInputAuthority(async () => ({ sharedDefault: false }));
    await initial.enqueuePlatformInput(ledgerInput("upload-input"), {
      title: "本机上传恢复",
    });
    await initial.stop();
    const seed = store.runtimeState() as {
      deliveries: Array<{
        inputId: string;
        state: string;
        sessionId: string;
        resourceUploads?: unknown[];
        request: Record<string, unknown>;
      }>;
    };
    // Controlled crash fixture: an existing admissible transport request, not
    // an injected Runtime Human message or another delivery authority.
    const payload = Buffer.from("controlled persisted upload");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    seed.deliveries[0]!.state = "sending";
    seed.deliveries[0]!.resourceUploads = [
      {
        stageId: "stage-one",
        name: "one.png",
        mediaType: "image/png",
        dataBase64: payload.toString("base64"),
        sha256,
        ready: false,
      },
    ];
    store.saveRuntimeState(seed);
    bridge = new RuntimeBridge(store, config);
    const sessionId = seed.deliveries[0]!.sessionId;
    const contextId = "mw-context-delta-upload";
    bridge.bindPlatformInputAuthority(async () => ({ sharedDefault: false }));
    const tick = bridge.tick.bind(bridge);
    t.mock.method(bridge, "tick", async () => {});
    const db = (store as unknown as { db: DatabaseSync }).db;
    const persisted = () =>
      JSON.parse(
        (
          db
            .prepare(
              "SELECT body FROM runtime_deliveries WHERE key='upload-input'",
            )
            .get() as { body: string }
        ).body,
      );
    assert.equal(
      persisted().state,
      "queued",
      "Recovery's sending -> queued transition commits locally",
    );
    let postCount = 0;
    t.mock.method(
      bridge as unknown as {
        request: (
          path: string,
          method?: string,
          body?: unknown,
        ) => Promise<unknown>;
      },
      "request",
      async (path: string, method?: string) => {
        if (path === "/api/status") return { model: "controlled" };
        if (path === "/api/session-io/capabilities")
          return {
            enabled: true,
            resources: true,
            client_metadata: true,
            formats: [],
          };
        if (path === `/api/sessions/${sessionId}/principal`)
          return {
            session_id: sessionId,
            context_id: contextId,
            principal_id: "runtime-human",
            capabilities: [],
          };
        if (path === `/api/sessions/${sessionId}`)
          return method === "PATCH"
            ? {}
            : { id: sessionId, context_id: contextId };
        if (path.endsWith("/attachment-stages"))
          return { offset: 0, status: "uploading" };
        if (path.endsWith("/attachment-stages/stage-one/content"))
          return { offset: payload.length, status: "ready", sha256 };
        if (path.endsWith("/io/messages") || path.endsWith("/messages")) {
          postCount++;
          assert.equal(
            persisted().resourceUploads[0].ready,
            true,
            "Nested readiness was committed before POST",
          );
          assert.equal(persisted().runtimePostAttempted, true);
          return { accepted: true, event_id: "accepted-root" };
        }
        if (path.includes("/events?"))
          return {
            events: [
              {
                id: "thread-event",
                sequence: 1,
                timestamp: "2026-09-30T00:00:01.000Z",
                topic: "runtime/thread_result",
                payload: {
                  session_id: sessionId,
                  root_turn_id: "accepted-root",
                  thread_id: "causal-thread",
                },
              },
              {
                id: "reply-event",
                sequence: 2,
                timestamp: "2026-09-30T00:00:02.000Z",
                topic: "chat/reply",
                payload: {
                  session_id: sessionId,
                  root_turn_id: "accepted-root",
                  text: "controlled result",
                },
              },
            ],
          };
        if (path.includes("/scheduler?")) return { threads: [] };
        if (path === "/api/approvals") return { approvals: [] };
        throw new Error(`Unexpected controlled Runtime read ${path}`);
      },
    );
    await bridge.releasePlatformInput("upload-input");
    assert.equal(persisted().platformHeld, false);
    await tick();
    assert.equal(postCount, 1);
    assert.equal(persisted().state, "completed");
    assert.deepEqual(persisted().causalThreadIds, ["causal-thread"]);
    assert.equal(persisted().lastActivityAt, "2026-09-30T00:00:02.000Z");
    assert.equal(persisted().resourceUploads[0].ready, true);
    assert.equal(persisted().request.client_message_id, "upload-input");
    assert.deepEqual(
      store.runtimeSessionEvents(sessionId),
      [],
      "No Platform reply mirror is created",
    );
    await tick();
    assert.equal(postCount, 1, "A settled request is not POSTed again");
  } finally {
    await bridge?.stop();
    await initial.stop();
    store.close();
  }
});
