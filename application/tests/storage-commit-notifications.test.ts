import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs, { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
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
test(
  "PG 独立 LISTEN 不占 max1 查询池；仅 COMMIT 通知、schema 隔离、断线恢复校验、无健康探活",
  { skip: !postgresUrl },
  async () => {
    const schema = `notify_${randomUUID().replaceAll("-", "")}`;
    const name = `notify-listener-${randomUUID()}`;
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
    const listener = async () =>
      (
        await writer.query<{ pid: number; query: string }>(
          "SELECT pid,query FROM pg_stat_activity WHERE application_name=$1",
          [name],
        )
      ).rows[0];
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
      await until(async () => {
        const next = await listener();
        return (
          !!next && next.pid !== initial.pid && next.query.startsWith("LISTEN")
        );
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
    } finally {
      await subscription.close();
      await other.close();
      await writer.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      writer.release();
      await pool.end();
    }
  },
);
