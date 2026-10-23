import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs, { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer, type Socket } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { Client, Pool } from "pg";
import {
  observeSqlChanges,
  postgresChangeSource,
  postgresCommitChannel,
  publishSqliteCommit,
  sqliteChangeSource,
  type SqlChangeHint,
} from "../packages/storage/src/commit-notifications.js";
import {
  hasSqlChanges,
  postgresQuery,
  prepareSqlCommit,
  publishSqlCommit,
  sqliteQuery,
} from "../packages/storage/src/sql.js";
import {
  BrowserStore,
  type BrowserBookmarkAuthority,
} from "../packages/browser/src/store.js";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline)
      throw new Error("Expected change notification did not arrive");
    await pause(10);
  }
}

test("SQLite 同进程订阅不打开文件监听、不查询版本；反复订阅和关闭保持异步通知", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-commit-local-"));
  const db = new DatabaseSync(join(directory, "local.sqlite"));
  db.exec("CREATE TABLE items(id INTEGER PRIMARY KEY)");
  const source = sqliteChangeSource(db);
  const subscriptions: ReturnType<typeof observeSqlChanges>[] = [];
  const hints: SqlChangeHint[][] = [];
  let watchCalls = 0;
  const rejectWatch = () => {
    watchCalls++;
    throw new Error("SQLite notifications must stay within the Host process");
  };
  t.mock.method(fs, "watch", rejectWatch);
  t.mock.method(fs, "watchFile", rejectWatch);
  syncBuiltinESMExports();
  const prepare = DatabaseSync.prototype.prepare;
  let sqlReads = 0;
  t.mock.method(
    DatabaseSync.prototype,
    "prepare",
    function (this: DatabaseSync, sql: string) {
      sqlReads++;
      return prepare.call(this, sql);
    },
  );
  try {
    for (let index = 0; index < 6; index++) {
      const received: SqlChangeHint[] = [];
      hints.push(received);
      subscriptions.push(
        observeSqlChanges(source, (hint) => {
          received.push(hint);
        }),
      );
    }
    assert.ok(hints.every((received) => received.length === 0));
    await Promise.all(subscriptions.map((subscription) => subscription.ready));
    assert.ok(
      hints.every(
        (received) => received.length === 1 && received[0]?.reason === "resync",
      ),
    );
    for (const received of hints) received.length = 0;
    publishSqliteCommit(source);
    assert.ok(hints.every((received) => received.length === 0));
    await until(() => hints.every((received) => received.length === 1));
    assert.ok(hints.every((received) => received[0]?.reason === "commit"));
    await pause(650);
    assert.equal(watchCalls, 0);
    assert.equal(
      sqlReads,
      0,
      "subscription, commit hints and idle time need no observer SQL",
    );
    await Promise.all(
      subscriptions.map((subscription) => subscription.close()),
    );
    publishSqliteCommit(source);
    await pause(0);
    assert.ok(hints.every((received) => received.length === 1));
    assert.equal(sqlReads, 0);
  } finally {
    await Promise.all(
      subscriptions.map((subscription) => subscription.close()),
    );
    t.mock.restoreAll();
    syncBuiltinESMExports();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite 同进程提示合并；关闭取消排队回调，观察者异常不影响其他订阅", async () => {
  const db = new DatabaseSync(":memory:");
  const source = sqliteChangeSource(db);
  const hints: SqlChangeHint[] = [];
  const cancelled: SqlChangeHint[] = [];
  const immediatelyClosed = observeSqlChanges(source, (hint) => {
    cancelled.push(hint);
  });
  const first = observeSqlChanges(source, (hint) => {
    hints.push(hint);
  });
  let unaffected = 0;
  const survivor = observeSqlChanges(source, () => {
    unaffected++;
  });
  const throwing = observeSqlChanges(source, () => {
    throw new Error("consumer read failed");
  });
  const rejecting = observeSqlChanges(source, async () => {
    throw new Error("async consumer read failed");
  });
  const subscriptions = [
    immediatelyClosed,
    first,
    survivor,
    throwing,
    rejecting,
  ];
  try {
    await immediatelyClosed.close();
    await Promise.all(subscriptions.map((subscription) => subscription.ready));
    assert.deepEqual(cancelled, []);
    assert.deepEqual(hints, [{ reason: "resync" }]);
    assert.equal(unaffected, 1);
    hints.length = 0;
    for (let index = 0; index < 3; index++) publishSqliteCommit(source);
    await until(() => hints.length === 1);
    assert.deepEqual(hints, [{ reason: "commit" }]);
    assert.equal(unaffected, 2);
    publishSqliteCommit(source);
    await first.close();
    await until(() => unaffected === 3);
    assert.equal(
      hints.length,
      1,
      "closing one consumer does not close the others",
    );
    await Promise.all(
      subscriptions.map((subscription) => subscription.close()),
    );
    publishSqliteCommit(source);
    await pause(0);
    assert.equal(unaffected, 3);
    const reopened = observeSqlChanges(source, (hint) => {
      hints.push(hint);
    });
    subscriptions.push(reopened);
    await reopened.ready;
    publishSqliteCommit(source);
    await until(() => hints.length === 3);
    assert.deepEqual(hints, [
      { reason: "commit" },
      { reason: "resync" },
      { reason: "commit" },
    ]);
  } finally {
    await Promise.all(
      subscriptions.map((subscription) => subscription.close()),
    );
    db.close();
  }
});

test("SQLite COMMIT 后异步提示，rollback/零行重放/只读无提示，独立 memory 不串线", async () => {
  const a = new DatabaseSync(":memory:"),
    b = new DatabaseSync(":memory:");
  a.exec("CREATE TABLE items(id INTEGER PRIMARY KEY, title TEXT)");
  const source = sqliteChangeSource(a),
    other = sqliteChangeSource(b);
  assert.equal(source, sqliteChangeSource(a));
  assert.notEqual(source.identity, other.identity);
  const hints: SqlChangeHint[] = [],
    others: SqlChangeHint[] = [];
  const subscription = observeSqlChanges(source, (hint) => {
    hints.push(hint);
  });
  const unrelated = observeSqlChanges(other, (hint) => {
    others.push(hint);
  });
  try {
    await subscription.ready;
    await unrelated.ready;
    await pause(0);
    assert.deepEqual(hints, [{ reason: "resync" }]);
    hints.length = others.length = 0;
    a.exec("BEGIN");
    const q = sqliteQuery(a);
    assert.equal(hasSqlChanges(q), false);
    await q.change("INSERT INTO items VALUES(?,?)", [1, "不出提示的正文"]);
    assert.throws(() => publishSqlCommit(q, source), /提交前/);
    assert.equal(hints.length, 0);
    a.exec("COMMIT");
    publishSqlCommit(q, source);
    assert.equal(hints.length, 0, "callback must not run inside commit gate");
    publishSqlCommit(q, source);
    await until(() => hints.length === 1);
    assert.deepEqual(hints, [{ reason: "commit" }]);
    assert.equal(others.length, 0);
    hints.length = 0;
    a.exec("BEGIN");
    const rollback = sqliteQuery(a);
    await rollback.change("INSERT INTO items VALUES(?,?)", [2, "rollback"]);
    a.exec("ROLLBACK");
    a.exec("BEGIN");
    const replay = sqliteQuery(a);
    assert.equal(
      await replay.change("INSERT OR IGNORE INTO items VALUES(?,?)", [
        1,
        "replay",
      ]),
      0,
    );
    assert.equal(hasSqlChanges(replay), false);
    a.exec("COMMIT");
    publishSqlCommit(replay, source);
    const read = sqliteQuery(a);
    await read.all("SELECT * FROM items");
    assert.equal(hasSqlChanges(read), false);
    await pause(30);
    assert.equal(hints.length, 0);
    assert.deepEqual(Object.keys(source).sort(), ["driver", "identity"]);
  } finally {
    await subscription.close();
    await unrelated.close();
    a.close();
    b.close();
  }
});

test("同一 canonical SQLite 的独立 Store 收到提交，重放不失效，callback 读不锁死 gate", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-commit-store-"));
  const filename = join(directory, "browser.sqlite");
  const authority: BrowserBookmarkAuthority = {
    async authorize() {
      return {
        tenantId: "tenant",
        ownerPrincipalId: "alice",
        principalId: "alice",
        actantId: "human",
        kind: "human",
        runtimeInputId: null,
      };
    },
  };
  const writer = await BrowserStore.sqlite(filename, authority);
  const alias = join(directory, "alias.sqlite");
  symlinkSync(filename, alias);
  const reader = await BrowserStore.sqlite(alias, authority);
  assert.equal(writer.changeSource().identity, reader.changeSource().identity);
  const hints: SqlChangeHint[] = [];
  let visible = 0;
  const subscription = observeSqlChanges(
    reader.changeSource(),
    async (hint) => {
      hints.push(hint);
      visible = (await reader.listBookmarks({ credential: "alice" })).length;
    },
  );
  const command = {
    credential: "alice",
    commandId: "commit-bookmark",
    operation: {
      type: "bookmark-add" as const,
      title: "标题",
      url: "https://example.test/commit",
    },
  };
  try {
    await subscription.ready;
    await pause(40);
    hints.length = 0;
    await writer.command(command);
    await until(() => visible === 1);
    assert.ok(hints.some((hint) => hint.reason === "commit"));
    await pause(60);
    hints.length = 0;
    await writer.command(command);
    await pause(60);
    assert.deepEqual(hints, []);
    await assert.rejects(
      writer.command({
        ...command,
        operation: { ...command.operation, title: "冲突重放" },
      }),
    );
    await pause(40);
    assert.deepEqual(hints, []);
  } finally {
    await subscription.close();
    await reader.close();
    await writer.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

const postgresUrl = process.env.MORPHZ_TEST_POSTGRES_URL;
// Only reconnect readiness includes the existing production connection attempt
// (5s), first backoff (100ms) and a finite scheduling/inspection margin (500ms).
// Ordinary COMMIT/ROLLBACK/notification assertions retain their original budget.
const listenerReconnectBudget = 5_000 + 100 + 500;
type ListenerStage = {
  ms: number;
  phase: string;
  attempt?: number;
  pid?: number;
  errorClass?: string;
  code?: string;
};
function listenerWitness(t: TestContext, name: string) {
  const started = Date.now(),
    stages: ListenerStage[] = [];
  const record = (
    phase: string,
    fields: Omit<ListenerStage, "ms" | "phase"> = {},
  ) => {
    if (stages.length < 40)
      stages.push({ ms: Date.now() - started, phase, ...fields });
  };
  let attempts = 0;
  const original = Client.prototype.connect;
  t.mock.method(
    Client.prototype,
    "connect",
    function (this: Client, ...args: unknown[]) {
      const client = this as Client & {
        connectionParameters: { application_name?: string };
        processID: number;
      };
      const result = Reflect.apply(original, client, args);
      if (client.connectionParameters.application_name === name) {
        const attempt = ++attempts;
        record("connect-attempt", { attempt });
        void Promise.resolve(result).then(
          () => record("connect-completed", { attempt, pid: client.processID }),
          (error: unknown) => {
            const value = error as { name?: unknown; code?: unknown };
            record("connect-rejected", {
              attempt,
              errorClass:
                typeof value?.name === "string" &&
                /^[A-Za-z0-9_]{1,40}$/.test(value.name)
                  ? value.name
                  : "Error",
              code:
                typeof value?.code === "string" &&
                /^[A-Z0-9_]{1,16}$/.test(value.code)
                  ? value.code
                  : "none",
            });
          },
        );
      }
      return result;
    },
  );
  return {
    stages,
    record,
    report() {
      t.diagnostic(JSON.stringify({ listenerStages: stages }));
    },
  };
}
async function listenerProxy(delayStartup: (attempt: number) => number | null) {
  const origin = new URL(postgresUrl!);
  const sockets = new Set<Socket>(),
    timers = new Set<ReturnType<typeof setTimeout>>();
  let attempts = 0;
  const server = createServer((downstream) => {
    const attempt = ++attempts;
    const upstream = connect({
      host: origin.hostname,
      port: Number(origin.port || "5432"),
    });
    for (const socket of [downstream, upstream]) {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
    }
    downstream.on("close", () => upstream.destroy());
    downstream.on("end", () => upstream.destroy());
    upstream.on("close", () => downstream.destroy());
    upstream.pipe(downstream);
    // Consume, but do not forward, the real startup bytes. Pausing reads would
    // also hide the peer's FIN and manufacture an unclosable proxy connection.
    const startup: Buffer[] = [];
    let startupBytes = 0;
    const buffer = (chunk: Buffer) => {
      startupBytes += chunk.length;
      if (startupBytes > 64 * 1024) {
        downstream.destroy();
        upstream.destroy();
      } else startup.push(chunk);
    };
    downstream.on("data", buffer);
    const delay = delayStartup(attempt);
    const forward = () => {
      downstream.removeListener("data", buffer);
      for (const chunk of startup) upstream.write(chunk);
      startup.length = 0;
      downstream.pipe(upstream);
    };
    if (delay === 0) forward();
    else if (delay !== null) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        forward();
      }, delay);
      timers.add(timer);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = new URL(origin);
  url.port = String((server.address() as { port: number }).port);
  return {
    url: url.href,
    attempts: () => attempts,
    sockets: () => sockets.size,
    async close() {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
test(
  "PG 独立 LISTEN 不占 max1 查询池；仅 COMMIT 通知、schema 隔离、断线恢复校验、无健康探活",
  { skip: !postgresUrl },
  async (t) => {
    const schema = `notify_${randomUUID().replaceAll("-", "")}`;
    const name = `notify-listener-${randomUUID()}`;
    const witness = listenerWitness(t, name);
    const pool = new Pool({ connectionString: postgresUrl!, max: 1 });
    const writer = await pool.connect();
    const source = postgresChangeSource(
      { connectionString: postgresUrl!, application_name: name },
      schema,
    );
    const hints: SqlChangeHint[] = [],
      otherHints: SqlChangeHint[] = [];
    const subscription = observeSqlChanges(source, (hint) => {
      hints.push(hint);
    });
    const other = observeSqlChanges(
      postgresChangeSource({ connectionString: postgresUrl! }, `${schema}_b`),
      (hint) => {
        otherHints.push(hint);
      },
    );
    let lastListener: { pid: number; listening: boolean } | null = null;
    const listener = async () => {
      const row = (
        await writer.query<{ pid: number; query: string }>(
          "SELECT pid,query FROM pg_stat_activity WHERE application_name=$1",
          [name],
        )
      ).rows[0];
      lastListener = row
        ? { pid: row.pid, listening: row.query.startsWith("LISTEN") }
        : null;
      return row;
    };
    try {
      await writer.query(
        `CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}".items(id INTEGER PRIMARY KEY)`,
      );
      await Promise.race([
        Promise.all([subscription.ready, other.ready]),
        pause(1500).then(() => {
          throw new Error("listener incorrectly borrowed occupied max1 pool");
        }),
      ]);
      await pause(30);
      hints.length = otherHints.length = 0;
      assert.equal(pool.totalCount, 1);
      const initial = await listener();
      assert.ok(initial);
      assert.ok(initial.query.startsWith("LISTEN"));
      await pause(150);
      assert.equal((await listener())?.query, initial.query);
      await writer.query("BEGIN");
      const rollback = postgresQuery(writer);
      await rollback.change(`INSERT INTO "${schema}".items VALUES(?)`, [1]);
      await prepareSqlCommit(rollback, source);
      await pause(40);
      assert.equal(hints.length, 0);
      await writer.query("ROLLBACK");
      await pause(40);
      assert.equal(hints.length, 0);
      await writer.query("BEGIN");
      const commit = postgresQuery(writer);
      await commit.all(
        `INSERT INTO "${schema}".items VALUES(?) RETURNING id`,
        [2],
      );
      assert.equal(hasSqlChanges(commit), true);
      await prepareSqlCommit(commit, source);
      await writer.query("COMMIT");
      await until(() => hints.length === 1);
      assert.deepEqual(hints, [{ reason: "commit" }]);
      assert.deepEqual(otherHints, []);
      hints.length = 0;
      await writer.query("BEGIN");
      const replay = postgresQuery(writer);
      await replay.change(
        `INSERT INTO "${schema}".items VALUES(?) ON CONFLICT DO NOTHING`,
        [2],
      );
      assert.equal(hasSqlChanges(replay), false);
      await prepareSqlCommit(replay, source);
      await writer.query("COMMIT");
      await pause(40);
      assert.equal(hints.length, 0);
      await writer.query("SELECT pg_terminate_backend($1)", [initial.pid]);
      witness.record("terminate-requested", { pid: initial.pid });
      await until(async () => {
        const next = await listener();
        return (
          !!next && next.pid !== initial.pid && next.query.startsWith("LISTEN")
        );
      }, listenerReconnectBudget);
      witness.record("replacement-listen-observed", {
        pid: (await listener())!.pid,
      });
      assert.ok(hints.some((hint) => hint.reason === "resync"));
      await pause(20);
      hints.length = 0;
      await writer.query("BEGIN");
      const resumed = postgresQuery(writer);
      await resumed.change(`INSERT INTO "${schema}".items VALUES(?)`, [3]);
      await prepareSqlCommit(resumed, source);
      await writer.query("COMMIT");
      await until(() => hints.some((hint) => hint.reason === "commit"));
      assert.equal(postgresCommitChannel(schema).includes(schema), false);
      assert.deepEqual(Object.keys(source).sort(), ["driver", "identity"]);
      assert.ok(hints.every((hint) => Object.keys(hint).join() === "reason"));
    } catch (error) {
      // Cached stage witness only: failure reporting must not issue another
      // potentially blocked SQL request or reveal a query/URL/credential.
      t.diagnostic(JSON.stringify({ lastListener }));
      witness.report();
      throw error;
    } finally {
      await subscription.close();
      await other.close();
      await writer.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      writer.release();
      await pool.end();
    }
  },
);

test(
  "PG permanently blocked startup reaches the real connection deadline, never claims ready, and closes every owned socket and retry",
  { skip: !postgresUrl, timeout: 15_000 },
  async (t) => {
    const name = `notify-blocked-${randomUUID()}`;
    const schema = `notify_${randomUUID().replaceAll("-", "")}`;
    const witness = listenerWitness(t, name);
    const proxy = await listenerProxy(() => null);
    const subscription = observeSqlChanges(
      postgresChangeSource(
        { connectionString: proxy.url, application_name: name },
        schema,
      ),
      () => {},
    );
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let ready = false;
    const readyPromise = subscription.ready.then(() => {
      ready = true;
    });
    try {
      const notReady = new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () => reject(Error("bounded reconnect readiness expired")),
          listenerReconnectBudget,
        );
      });
      await assert.rejects(
        Promise.race([readyPromise, notReady]),
        /bounded reconnect readiness expired/,
      );
      assert.equal(
        ready,
        false,
        "a failed handshake cannot claim LISTEN readiness",
      );
      assert.equal(
        witness.stages.filter((stage) => stage.phase === "connect-completed")
          .length,
        0,
      );
      const rejected = witness.stages.find(
        (stage) => stage.phase === "connect-rejected",
      );
      assert.ok(
        rejected,
        "the production pg Client's actual 5s connect deadline must fire",
      );
      assert.ok(
        rejected.ms >= 4_500,
        "this is not an immediate refused endpoint or fabricated rejection",
      );
      // Observe the retry in its own phase after the actual connect rejection.
      // A delayed event loop can process the 5s rejection near the readiness
      // deadline, before its newly scheduled 100ms backoff has had a turn.
      await until(() => proxy.attempts() >= 2, 100 + 500);
      assert.ok(
        proxy.attempts() >= 2,
        "the real observer attempts its configured reconnect after failure",
      );
      await subscription.close();
      await subscription.close();
      await until(() => proxy.sockets() === 0);
      const closedAttempts = proxy.attempts();
      await pause(250);
      assert.equal(
        proxy.attempts(),
        closedAttempts,
        "close cancels a pending reconnect, not only the current socket",
      );
    } catch (error) {
      witness.report();
      throw error;
    } finally {
      clearTimeout(deadline);
      await subscription.close();
      await proxy.close();
    }
  },
);

test(
  "PG reconnect waits for one real legal delayed startup, then receives COMMIT without changing notification deadlines",
  { skip: !postgresUrl, timeout: 15_000 },
  async (t) => {
    const name = `notify-delayed-${randomUUID()}`;
    const schema = `notify_${randomUUID().replaceAll("-", "")}`;
    const witness = listenerWitness(t, name);
    const proxy = await listenerProxy((attempt) => (attempt === 2 ? 3200 : 0));
    const writer = new Client({ connectionString: postgresUrl! });
    const hints: SqlChangeHint[] = [];
    const subscription = observeSqlChanges(
      postgresChangeSource(
        { connectionString: proxy.url, application_name: name },
        schema,
      ),
      (hint) => {
        hints.push(hint);
      },
    );
    try {
      await writer.connect();
      const listener = async () =>
        (
          await writer.query<{ pid: number; query: string }>(
            "SELECT pid,query FROM pg_stat_activity WHERE application_name=$1",
            [name],
          )
        ).rows[0];
      await subscription.ready;
      const initial = await listener();
      assert.ok(initial);
      assert.ok(initial.query.startsWith("LISTEN"));
      await writer.query("SELECT pg_terminate_backend($1)", [initial.pid]);
      witness.record("terminate-requested", { pid: initial.pid });
      await until(async () => {
        const row = await listener();
        return (
          !!row && row.pid !== initial.pid && row.query.startsWith("LISTEN")
        );
      }, listenerReconnectBudget);
      const row = (await listener())!;
      witness.record("replacement-listen-observed", { pid: row.pid });
      assert.equal(
        proxy.attempts(),
        2,
        "one reconnect, not a retry-until-green third connection",
      );
      assert.equal(
        witness.stages.filter((stage) => stage.phase === "connect-rejected")
          .length,
        0,
      );
      await pause(20);
      hints.length = 0;
      await writer.query("BEGIN");
      await writer.query("SELECT pg_notify($1,'')", [
        postgresCommitChannel(schema),
      ]);
      assert.equal(hints.length, 0);
      await writer.query("COMMIT");
      await until(() => hints.some((hint) => hint.reason === "commit"));
      witness.record("commit-notification-observed");
      await subscription.close();
      await subscription.close();
      await until(() => proxy.sockets() === 0);
    } catch (error) {
      witness.report();
      throw error;
    } finally {
      await subscription.close();
      await writer.end();
      await proxy.close();
    }
  },
);
