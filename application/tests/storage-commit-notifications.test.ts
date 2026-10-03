import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs, {
  mkdtempSync,
  existsSync,
  realpathSync,
  rmSync,
  symlinkSync,
  type FSWatcher,
  type WatchListener,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import {
  observeSqlChanges,
  postgresChangeSource,
  postgresCommitChannel,
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

function interceptChangeWatch(
  filename: string,
  intercept: (
    target: string,
    open: () => FSWatcher,
    listener: WatchListener<string>,
  ) => FSWatcher,
) {
  const original = fs.watch;
  const directory = realpathSync(dirname(filename));
  const canonical = join(directory, basename(filename));
  const targets = new Set([
    directory,
    canonical,
    `${canonical}-wal`,
    `${canonical}-journal`,
  ]);
  fs.watch = ((...args: Parameters<typeof fs.watch>) => {
    const open = () => Reflect.apply(original, fs, args) as FSWatcher;
    const target = String(args[0]);
    if (!targets.has(target)) {
      assert.ok(
        !target.startsWith(`${directory}/`),
        `unexpected isolated watcher target: ${target}`,
      );
      return open();
    }
    const listener = args.find((argument) => typeof argument === "function");
    assert.equal(typeof listener, "function");
    return intercept(target, open, listener as WatchListener<string>);
  }) as typeof fs.watch;
  syncBuiltinESMExports();
  return () => {
    fs.watch = original;
    syncBuiltinESMExports();
  };
}

class ControlledWatcher extends EventEmitter implements FSWatcher {
  closeCalls = 0;
  constructor(
    readonly target: string,
    readonly deliver: WatchListener<string>,
  ) {
    super();
  }
  close() {
    this.closeCalls++;
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}

function controlledChangeWatches(filename: string) {
  const directory = realpathSync(dirname(filename));
  const canonical = join(directory, basename(filename));
  const watchers: ControlledWatcher[] = [];
  const restore = interceptChangeWatch(filename, (target, _open, listener) => {
    const watcher = new ControlledWatcher(target, listener);
    watchers.push(watcher);
    return watcher;
  });
  const current = (target: string) => {
    const watcher = watchers.findLast(
      (watcher) => watcher.target === target && watcher.closeCalls === 0,
    );
    assert.ok(watcher, `active isolated watcher missing: ${target}`);
    return watcher;
  };
  return { directory, canonical, watchers, restore, current };
}

function countVersionReads() {
  const original = DatabaseSync.prototype.prepare;
  let count = 0;
  DatabaseSync.prototype.prepare = function (sql: string) {
    if (sql === "PRAGMA data_version") count++;
    return original.call(this, sql);
  };
  return {
    get count() {
      return count;
    },
    restore() {
      DatabaseSync.prototype.prepare = original;
    },
  };
}

async function assertExternalTransactions(
  filename: string,
  hints: SqlChangeHint[],
) {
  const script = `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN IMMEDIATE');db.prepare('INSERT INTO items VALUES(?)').run(Number(process.argv[2]));process.send('staged');process.once('message', mode=>{db.exec(mode==='commit'?'COMMIT':'ROLLBACK');db.close();process.disconnect();});`;
  for (const [id, mode] of [
    [1, "rollback"],
    [2, "commit"],
  ] as const) {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", script, filename, String(id)],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    try {
      await once(child, "message");
      await pause(80);
      assert.equal(hints.length, 0, "uncommitted writes are not a commit");
      const exited = once(child, "exit");
      child.send(mode);
      const [code] = await exited;
      assert.equal(code, 0);
      if (mode === "commit")
        await until(() => hints.some((hint) => hint.reason === "commit"));
      else {
        await pause(70);
        assert.deepEqual(hints, []);
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  }
}

async function externalInsert(filename: string, id: number) {
  const script = `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN IMMEDIATE');db.prepare('INSERT INTO items VALUES(?)').run(Number(process.argv[2]));db.exec('COMMIT');db.close();`;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", script, filename, String(id)],
    { stdio: "ignore" },
  );
  try {
    const [code] = await once(child, "exit");
    assert.equal(code, 0, "the isolated external transaction must commit");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

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

test("SQLite 真实文件监听跨进程以 data_version 校验提交，未提交和 rollback 不报变化", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-commit-process-"));
  const filename = join(directory, "external.sqlite"),
    db = new DatabaseSync(filename);
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE items(id INTEGER PRIMARY KEY)",
  );
  const hints: SqlChangeHint[] = [];
  const original = DatabaseSync.prototype.prepare;
  let versionReads = 0;
  DatabaseSync.prototype.prepare = function (sql: string) {
    if (sql === "PRAGMA data_version") versionReads++;
    return original.call(this, sql);
  };
  const subscription = observeSqlChanges(sqliteChangeSource(db), (hint) => {
    hints.push(hint);
  });
  const childScript = `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN IMMEDIATE');db.prepare('INSERT INTO items VALUES(?)').run(Number(process.argv[2]));process.send('staged');process.once('message', mode=>{db.exec(mode==='commit'?'COMMIT':'ROLLBACK');db.close();process.disconnect();});`;
  try {
    await subscription.ready;
    await pause(50);
    hints.length = 0;
    for (const [id, mode] of [
      [1, "rollback"],
      [2, "commit"],
    ] as const) {
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", childScript, filename, String(id)],
        { stdio: ["ignore", "ignore", "pipe", "ipc"] },
      );
      try {
        await once(child, "message");
        await pause(80);
        assert.equal(
          hints.length,
          0,
          "uncommitted WAL writes are not a commit",
        );
        const exited = once(child, "exit");
        child.send(mode);
        await exited;
        if (mode === "commit")
          await until(() => hints.some((hint) => hint.reason === "commit"));
        else {
          await pause(70);
          assert.equal(hints.length, 0);
        }
      } finally {
        if (child.exitCode === null) child.kill();
      }
    }
    assert.ok(versionReads > 1);
    assert.deepEqual(
      db
        .prepare("SELECT id FROM items")
        .all()
        .map((row) => row.id),
      [2],
    );
  } finally {
    await subscription.close();
    DatabaseSync.prototype.prepare = original;
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite 观察器基线与文件监听注册之间的提交在注册后只校准一次", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-commit-register-"));
  const filename = join(directory, "registration.sqlite"),
    db = new DatabaseSync(filename),
    writer = new DatabaseSync(filename);
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE items(id INTEGER PRIMARY KEY)",
  );
  const original = DatabaseSync.prototype.prepare;
  let versionReads = 0;
  DatabaseSync.prototype.prepare = function (sql: string) {
    if (sql === "PRAGMA data_version") versionReads++;
    return original.call(this, sql);
  };
  let registrations = 0;
  const restoreWatch = interceptChangeWatch(filename, (target, open) => {
    if (target !== realpathSync(directory)) return open();
    registrations++;
    assert.equal(versionReads, 1, "the old baseline predates registration");
    writer.exec("INSERT INTO items VALUES(2)");
    return open();
  });
  const hints: SqlChangeHint[] = [];
  const subscription = observeSqlChanges(sqliteChangeSource(db), (hint) => {
    hints.push(hint);
  });
  try {
    assert.equal(registrations, 1);
    assert.equal(versionReads, 2, "one bounded post-registration calibration");
    await subscription.ready;
    assert.deepEqual(hints, [{ reason: "resync" }]);
    assert.deepEqual(
      db
        .prepare("SELECT id FROM items")
        .all()
        .map((row) => row.id),
      [2],
    );
  } finally {
    await subscription.close();
    restoreWatch();
    DatabaseSync.prototype.prepare = original;
    writer.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite 可控文件事件按20ms合并校验，初始和提交后静默零SQL，close取消读取和提示", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-commit-events-"));
  const filename = join(directory, "controlled.sqlite"),
    db = new DatabaseSync(filename),
    writer = new DatabaseSync(filename);
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE items(id INTEGER PRIMARY KEY)",
  );
  const original = DatabaseSync.prototype.prepare;
  let versionReads = 0;
  DatabaseSync.prototype.prepare = function (sql: string) {
    if (sql === "PRAGMA data_version") versionReads++;
    return original.call(this, sql);
  };
  const watches = controlledChangeWatches(filename);
  // No OS callback is delivered in a quiet phase. This is the precise idle
  // precondition; native fs.watch may deliver late or duplicate WAL events.
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const hints: SqlChangeHint[] = [];
  const subscription = observeSqlChanges(sqliteChangeSource(db), (hint) => {
    hints.push(hint);
  });
  const deliverBatch = () => {
    watches
      .current(watches.directory)
      .deliver("change", "controlled.sqlite-wal");
    watches.current(watches.canonical).deliver("change", "controlled.sqlite");
    watches
      .current(`${watches.canonical}-wal`)
      .deliver("change", "controlled.sqlite-wal");
  };
  try {
    assert.equal(versionReads, 2);
    assert.deepEqual(
      watches.watchers.map((watcher) => watcher.target).sort(),
      [watches.directory, watches.canonical, `${watches.canonical}-wal`].sort(),
      "all exact subscriptions are controlled; absent journal needs no watcher",
    );
    await subscription.ready;
    assert.deepEqual(hints, [{ reason: "resync" }]);
    hints.length = 0;
    const initialReads = versionReads;
    t.mock.timers.tick(150);
    await Promise.resolve();
    assert.equal(versionReads, initialReads, "no initial healthy SQL polling");
    assert.deepEqual(hints, []);

    watches
      .current(watches.directory)
      .deliver("change", "controlled.sqlite-shm");
    watches
      .current(watches.directory)
      .deliver("change", "unrelated.sqlite-wal");
    t.mock.timers.tick(150);
    assert.equal(
      versionReads,
      initialReads,
      "irrelevant entries do not read SQL",
    );

    writer.exec("BEGIN IMMEDIATE; INSERT INTO items VALUES(1)");
    deliverBatch();
    t.mock.timers.tick(19);
    assert.equal(versionReads, initialReads, "no check before 20ms");
    t.mock.timers.tick(1);
    await Promise.resolve();
    assert.equal(versionReads, initialReads + 1, "one check per event batch");
    assert.deepEqual(hints, [], "uncommitted WAL writes are not a commit");
    writer.exec("ROLLBACK");
    deliverBatch();
    t.mock.timers.tick(20);
    await Promise.resolve();
    assert.equal(versionReads, initialReads + 2);
    assert.deepEqual(hints, [], "rollback does not change data_version");

    await externalInsert(filename, 2);
    const beforeCommitEvent = versionReads;
    assert.deepEqual(hints, [], "SQL alone does not start a healthy timer");
    deliverBatch();
    t.mock.timers.tick(19);
    assert.equal(versionReads, beforeCommitEvent);
    t.mock.timers.tick(1);
    await Promise.resolve();
    assert.equal(versionReads, beforeCommitEvent + 1);
    assert.deepEqual(hints, [{ reason: "commit" }]);
    assert.deepEqual(
      db
        .prepare("SELECT id FROM items")
        .all()
        .map((row) => row.id),
      [2],
    );

    hints.length = 0;
    const idleReads = versionReads;
    t.mock.timers.tick(150);
    await Promise.resolve();
    assert.equal(
      versionReads,
      idleReads,
      "no healthy SQL polling after commit",
    );
    assert.deepEqual(hints, []);

    deliverBatch();
    await subscription.close();
    assert.ok(watches.watchers.every((watcher) => watcher.closeCalls === 1));
    // Also tolerate a callback already queued when the native watcher closed.
    for (const watcher of watches.watchers) {
      watcher.deliver("change", basename(watcher.target));
      watcher.emit("error", new Error("TEST retired subscription error"));
    }
    t.mock.timers.tick(600);
    await Promise.resolve();
    assert.equal(
      versionReads,
      idleReads,
      "close cancels pending version checks",
    );
    assert.deepEqual(hints, [], "close cancels pending hints");
    assert.equal(watches.watchers.length, 3, "close also cancels recovery");
  } finally {
    await subscription.close();
    t.mock.timers.reset();
    watches.restore();
    DatabaseSync.prototype.prepare = original;
    writer.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const journalMode of ["WAL", "DELETE"] as const) {
  test(`SQLite ${journalMode}目录回调失声时真实文件订阅仍校验跨进程commit和rollback`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "morphz-commit-silent-dir-"));
    const filename = join(directory, "silent.sqlite"),
      db = new DatabaseSync(filename);
    db.exec(
      `PRAGMA journal_mode=${journalMode}; CREATE TABLE items(id INTEGER PRIMARY KEY)`,
    );
    const canonicalDirectory = realpathSync(directory);
    const registrations: string[] = [],
      closedTargets: string[] = [];
    const restoreWatch = interceptChangeWatch(
      filename,
      (target, open, listener) => {
        registrations.push(target);
        if (target === canonicalDirectory) {
          const watcher = new ControlledWatcher(target, listener);
          const close = watcher.close.bind(watcher);
          watcher.close = () => {
            closedTargets.push(target);
            close();
          };
          return watcher;
        }
        const watcher = open();
        const close = watcher.close.bind(watcher);
        watcher.close = () => {
          closedTargets.push(target);
          close();
        };
        return watcher;
      },
    );
    const hints: SqlChangeHint[] = [];
    const subscription = observeSqlChanges(sqliteChangeSource(db), (hint) => {
      hints.push(hint);
    });
    try {
      await subscription.ready;
      await pause(50);
      hints.length = 0;
      await assertExternalTransactions(filename, hints);
      assert.deepEqual(
        db
          .prepare("SELECT id FROM items")
          .all()
          .map((row) => row.id),
        [2],
      );
      assert.ok(
        registrations.includes(join(canonicalDirectory, "silent.sqlite")),
      );
      if (journalMode === "WAL")
        assert.ok(
          registrations.includes(join(canonicalDirectory, "silent.sqlite-wal")),
        );
      await subscription.close();
      assert.deepEqual(closedTargets.sort(), registrations.sort());
    } finally {
      await subscription.close();
      restoreWatch();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("SQLite 初始缺席WAL在只读观察器基线后创建并订阅，静默不反复发现侧车", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-commit-initial-wal-"));
  const filename = join(directory, "initial.sqlite");
  const setup = new DatabaseSync(filename);
  setup.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE items(id INTEGER PRIMARY KEY)",
  );
  setup.close();
  assert.equal(existsSync(`${filename}-wal`), false);
  const db = new DatabaseSync(filename);
  const watches = controlledChangeWatches(filename);
  const reads = countVersionReads();
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const subscription = observeSqlChanges(sqliteChangeSource(db), () => {});
  try {
    assert.equal(existsSync(`${filename}-wal`), true);
    assert.ok(watches.current(`${watches.canonical}-wal`));
    assert.equal(reads.count, 2);
    const count = watches.watchers.length;
    await subscription.ready;
    t.mock.timers.tick(1200);
    assert.equal(
      reads.count,
      2,
      "no periodic SQL while all event sources are quiet",
    );
    assert.equal(watches.watchers.length, count, "no timed sidecar scans");
  } finally {
    await subscription.close();
    assert.ok(watches.watchers.every((watcher) => watcher.closeCalls === 1));
    t.mock.timers.reset();
    reads.restore();
    watches.restore();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite journal创建、消失和inode替换仅按真实事件收敛，旧实例迟到回调和error无效", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-commit-journal-"));
  const filename = join(directory, "journal.sqlite"),
    db = new DatabaseSync(filename),
    writer = new DatabaseSync(filename);
  db.exec(
    "PRAGMA journal_mode=DELETE; CREATE TABLE items(id INTEGER PRIMARY KEY)",
  );
  const watches = controlledChangeWatches(filename);
  const reads = countVersionReads();
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const hints: SqlChangeHint[] = [];
  const subscription = observeSqlChanges(sqliteChangeSource(db), (hint) => {
    hints.push(hint);
  });
  const journal = `${watches.canonical}-journal`;
  try {
    await subscription.ready;
    hints.length = 0;
    assert.equal(watches.watchers.length, 2, "absent journal is not watched");
    writer.exec("BEGIN IMMEDIATE; INSERT INTO items VALUES(1)");
    assert.equal(existsSync(journal), true);
    watches.current(watches.directory).deliver("rename", basename(journal));
    t.mock.timers.tick(20);
    await Promise.resolve();
    const transactionJournal = watches.current(journal);
    assert.equal(reads.count, 3);
    assert.deepEqual(
      hints,
      [],
      "creating an uncommitted journal is not a commit",
    );
    writer.exec("ROLLBACK");
    assert.equal(existsSync(journal), false);
    transactionJournal.deliver("rename", basename(journal));
    t.mock.timers.tick(20);
    await Promise.resolve();
    assert.equal(transactionJournal.closeCalls, 1);
    assert.deepEqual(hints, []);

    // Empty, non-hot journals are safe filesystem lifecycle fixtures. SQLite
    // remains authoritative; no database or WAL bytes are edited.
    fs.writeFileSync(journal, "");
    watches.current(watches.directory).deliver("rename", basename(journal));
    t.mock.timers.tick(20);
    await Promise.resolve();
    const old = watches.current(journal);
    fs.renameSync(journal, join(directory, "retired-journal"));
    fs.writeFileSync(journal, "");
    old.deliver("rename", basename(journal));
    t.mock.timers.tick(20);
    await Promise.resolve();
    const replacement = watches.current(journal);
    assert.notEqual(replacement, old);
    assert.equal(old.closeCalls, 1);
    const idleReads = reads.count,
      registrations = watches.watchers.length;
    for (const retired of [transactionJournal, old]) {
      retired.deliver("change", basename(journal));
      retired.emit("error", new Error("TEST error from retired inode"));
    }
    t.mock.timers.tick(1200);
    await Promise.resolve();
    assert.equal(reads.count, idleReads, "retired callbacks do not sample SQL");
    assert.equal(
      watches.watchers.length,
      registrations,
      "retired error cannot reconnect",
    );
    assert.equal(
      replacement.closeCalls,
      0,
      "retired error cannot close replacement",
    );
    assert.deepEqual(hints, []);
  } finally {
    if (writer.isTransaction) writer.exec("ROLLBACK");
    await subscription.close();
    assert.ok(watches.watchers.every((watcher) => watcher.closeCalls === 1));
    t.mock.timers.reset();
    reads.restore();
    watches.restore();
    writer.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite DB替换重新打开观察器后收敛新WAL一次，旧DB和WAL实例不能影响新订阅", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-commit-replace-"));
  const filename = join(directory, "replace.sqlite"),
    db = new DatabaseSync(filename);
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE items(id INTEGER PRIMARY KEY)",
  );
  const replacementFile = join(directory, "replacement.sqlite");
  const setup = new DatabaseSync(replacementFile);
  setup.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE items(id INTEGER PRIMARY KEY); INSERT INTO items VALUES(7)",
  );
  setup.close();
  assert.equal(existsSync(`${replacementFile}-wal`), false);
  const watches = controlledChangeWatches(filename);
  const reads = countVersionReads();
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const hints: SqlChangeHint[] = [];
  const subscription = observeSqlChanges(sqliteChangeSource(db), (hint) => {
    hints.push(hint);
  });
  let sourceClosed = false;
  try {
    await subscription.ready;
    hints.length = 0;
    const oldDb = watches.current(watches.canonical),
      oldWal = watches.current(`${watches.canonical}-wal`);
    db.close();
    sourceClosed = true;
    for (const suffix of ["", "-wal", "-shm"]) {
      fs.renameSync(
        `${filename}${suffix}`,
        join(directory, `retired.sqlite${suffix}`),
      );
    }
    fs.renameSync(replacementFile, filename);
    assert.equal(existsSync(`${filename}-wal`), false);
    oldDb.deliver("rename", basename(filename));
    t.mock.timers.tick(20);
    await Promise.resolve();
    assert.equal(
      reads.count,
      3,
      "replacement opens one baseline, not a read loop",
    );
    assert.deepEqual(hints, [{ reason: "resync" }]);
    assert.equal(existsSync(`${filename}-wal`), true);
    const newDb = watches.current(watches.canonical),
      newWal = watches.current(`${watches.canonical}-wal`);
    assert.notEqual(newDb, oldDb);
    assert.notEqual(newWal, oldWal);
    assert.equal(oldDb.closeCalls, 1);
    assert.equal(oldWal.closeCalls, 1);
    const verify = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.deepEqual(
        verify
          .prepare("SELECT id FROM items")
          .all()
          .map((row) => row.id),
        [7],
      );
    } finally {
      verify.close();
    }
    hints.length = 0;
    const registrations = watches.watchers.length;
    for (const old of [oldDb, oldWal]) {
      old.deliver("change", basename(old.target));
      old.emit("error", new Error("TEST retired DB/WAL error"));
    }
    t.mock.timers.tick(1200);
    await Promise.resolve();
    assert.equal(reads.count, 3);
    assert.equal(watches.watchers.length, registrations);
    assert.equal(newDb.closeCalls, 0);
    assert.equal(newWal.closeCalls, 0);
    assert.deepEqual(hints, []);
  } finally {
    await subscription.close();
    assert.ok(watches.watchers.every((watcher) => watcher.closeCalls === 1));
    t.mock.timers.reset();
    reads.restore();
    watches.restore();
    if (!sourceClosed) db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const errorCode of ["ENOENT", "EMFILE"] as const) {
  test(`SQLite ${errorCode}侧车注册空窗遵守缺席/错误恢复边界且旧目录error不能关闭新实例`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "morphz-commit-file-error-"));
    const filename = join(directory, "error.sqlite"),
      db = new DatabaseSync(filename);
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE items(id INTEGER PRIMARY KEY)",
    );
    const canonicalDirectory = realpathSync(directory),
      canonical = join(canonicalDirectory, "error.sqlite");
    const watchers: ControlledWatcher[] = [];
    let failed = false;
    const restoreWatch = interceptChangeWatch(
      filename,
      (target, _open, listener) => {
        if (target === `${canonical}-wal` && !failed) {
          failed = true;
          throw Object.assign(new Error("TEST sidecar registration gap"), {
            code: errorCode,
          });
        }
        const watcher = new ControlledWatcher(target, listener);
        watchers.push(watcher);
        return watcher;
      },
    );
    const reads = countVersionReads();
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const hints: SqlChangeHint[] = [];
    const subscription = observeSqlChanges(sqliteChangeSource(db), (hint) => {
      hints.push(hint);
    });
    try {
      await subscription.ready;
      hints.length = 0;
      const oldDirectory = watchers[0]!;
      if (errorCode === "ENOENT") {
        assert.equal(reads.count, 2);
        assert.ok(watchers.every((watcher) => watcher.closeCalls === 0));
        t.mock.timers.tick(1200);
        await Promise.resolve();
        assert.equal(reads.count, 2);
        assert.equal(
          watchers.length,
          2,
          "absent sidecar does not start timed discovery",
        );
        oldDirectory.deliver("rename", "error.sqlite-wal");
        t.mock.timers.tick(20);
        await Promise.resolve();
        assert.equal(reads.count, 3);
        assert.equal(
          watchers.length,
          3,
          "a real event discovers the available sidecar",
        );
        assert.deepEqual(hints, []);
      } else {
        assert.equal(reads.count, 1);
        assert.ok(watchers.every((watcher) => watcher.closeCalls === 1));
        t.mock.timers.tick(499);
        assert.equal(watchers.length, 2);
        assert.equal(reads.count, 1);
        t.mock.timers.tick(1);
        await Promise.resolve();
        assert.equal(watchers.length, 5);
        assert.equal(reads.count, 2, "one post-recovery calibration");
        assert.deepEqual(
          hints,
          [{ reason: "resync" }],
          "restored watcher invalidates even unchanged data_version",
        );
        hints.length = 0;
        oldDirectory.deliver("change", "error.sqlite-wal");
        oldDirectory.emit("error", new Error("TEST retired directory error"));
        t.mock.timers.tick(1200);
        await Promise.resolve();
        assert.equal(reads.count, 2);
        assert.equal(watchers.length, 5);
        assert.ok(
          watchers.slice(2).every((watcher) => watcher.closeCalls === 0),
        );
        assert.deepEqual(hints, []);
      }
    } finally {
      await subscription.close();
      assert.ok(watchers.every((watcher) => watcher.closeCalls === 1));
      t.mock.timers.reset();
      reads.restore();
      restoreWatch();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("SQLite 活跃文件订阅error只触发500ms恢复，恢复读取空窗提交且旧实例和close不再读SQL", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-commit-active-error-"));
  const filename = join(directory, "active.sqlite"),
    db = new DatabaseSync(filename);
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE items(id INTEGER PRIMARY KEY)",
  );
  const watches = controlledChangeWatches(filename);
  const reads = countVersionReads();
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const hints: SqlChangeHint[] = [];
  const subscription = observeSqlChanges(sqliteChangeSource(db), (hint) => {
    hints.push(hint);
  });
  try {
    await subscription.ready;
    hints.length = 0;
    const retired = [...watches.watchers];
    watches
      .current(`${watches.canonical}-wal`)
      .emit("error", new Error("TEST lost active WAL subscription"));
    await Promise.resolve();
    assert.deepEqual(hints, [{ reason: "resync" }]);
    assert.ok(retired.every((watcher) => watcher.closeCalls === 1));
    assert.equal(reads.count, 2);
    hints.length = 0;
    await externalInsert(filename, 2);
    t.mock.timers.tick(499);
    assert.equal(
      reads.count,
      2,
      "no SQL or healthy checks inside the lost subscription gap",
    );
    assert.equal(watches.watchers.length, 3);
    t.mock.timers.tick(1);
    await Promise.resolve();
    assert.equal(reads.count, 3, "one calibration reads the missed commit");
    assert.equal(watches.watchers.length, 6);
    assert.deepEqual(hints, [{ reason: "resync" }]);
    assert.deepEqual(
      db
        .prepare("SELECT id FROM items")
        .all()
        .map((row) => row.id),
      [2],
    );
    hints.length = 0;
    for (const watcher of retired) {
      watcher.deliver("change", basename(watcher.target));
      watcher.emit("error", new Error("TEST late error from old subscription"));
    }
    t.mock.timers.tick(1200);
    await Promise.resolve();
    assert.equal(reads.count, 3);
    assert.equal(watches.watchers.length, 6);
    assert.ok(
      watches.watchers.slice(3).every((watcher) => watcher.closeCalls === 0),
    );
    assert.deepEqual(hints, []);
    watches
      .current(`${watches.canonical}-wal`)
      .deliver("change", "active.sqlite-wal");
    t.mock.timers.tick(19);
    await subscription.close();
    for (const watcher of watches.watchers) {
      watcher.deliver("change", basename(watcher.target));
      watcher.emit("error", new Error("TEST callback after close"));
    }
    t.mock.timers.tick(1200);
    await Promise.resolve();
    assert.equal(reads.count, 3);
    assert.equal(watches.watchers.length, 6);
    assert.deepEqual(hints, []);
  } finally {
    await subscription.close();
    assert.ok(watches.watchers.every((watcher) => watcher.closeCalls === 1));
    t.mock.timers.reset();
    reads.restore();
    watches.restore();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const gap of ["registration", "disconnect"] as const) {
  test(`SQLite ${gap}空窗内的跨进程提交在监听恢复后提示重新读取权威版本`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "morphz-commit-reconnect-"));
    const filename = join(directory, "reconnect.sqlite"),
      db = new DatabaseSync(filename);
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE items(id INTEGER PRIMARY KEY)",
    );
    let accepting = gap === "disconnect";
    const watchers: FSWatcher[] = [];
    const restoreWatch = interceptChangeWatch(filename, (target, open) => {
      if (!accepting)
        throw Object.assign(new Error("TEST isolated watcher unavailable"), {
          code: "EMFILE",
        });
      const watcher = open();
      if (target === realpathSync(directory)) watchers.push(watcher);
      return watcher;
    });
    const resyncRegistrations: number[] = [];
    let visible: unknown[] = [];
    const subscription = observeSqlChanges(sqliteChangeSource(db), (hint) => {
      if (hint.reason === "resync") resyncRegistrations.push(watchers.length);
      visible = db
        .prepare("SELECT id FROM items")
        .all()
        .map((row) => row.id);
    });
    try {
      await subscription.ready;
      await pause(0);
      assert.deepEqual(visible, []);
      if (gap === "disconnect") {
        accepting = false;
        watchers[0]!.emit("error", new Error("TEST lost file subscription"));
        await pause(0);
      }
      const before = watchers.length;
      await externalInsert(filename, 2);
      assert.equal(
        watchers.length,
        before,
        "commit occurred without a watcher",
      );
      resyncRegistrations.length = 0;
      accepting = true;
      await until(
        () =>
          watchers.length === before + 1 &&
          resyncRegistrations.includes(watchers.length) &&
          visible.length === 1,
      );
      assert.deepEqual(visible, [2]);
      assert.deepEqual(resyncRegistrations, [before + 1]);
    } finally {
      await subscription.close();
      restoreWatch();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("SQLite 失败注册的恢复在close后取消，不重新监听或输出提示", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-commit-cancel-"));
  const filename = join(directory, "cancel.sqlite"),
    db = new DatabaseSync(filename);
  db.exec("CREATE TABLE items(id INTEGER PRIMARY KEY)");
  let attempts = 0;
  const restoreWatch = interceptChangeWatch(filename, () => {
    attempts++;
    throw new Error("TEST isolated watcher unavailable");
  });
  const hints: SqlChangeHint[] = [];
  const subscription = observeSqlChanges(sqliteChangeSource(db), (hint) => {
    hints.push(hint);
  });
  try {
    await subscription.ready;
    await pause(0);
    hints.length = 0;
    await subscription.close();
    await pause(600);
    assert.equal(attempts, 1);
    assert.deepEqual(hints, []);
  } finally {
    await subscription.close();
    restoreWatch();
    db.close();
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
