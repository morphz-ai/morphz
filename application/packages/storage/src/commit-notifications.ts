import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client, type ClientConfig } from "pg";

/** Host-only, opaque storage identity. Connection details never enter a hint. */
export type SqlChangeSource = Readonly<{
  driver: "sqlite" | "postgres";
  identity: string;
}>;
export type SqlChangeHint = Readonly<{ reason: "commit" | "resync" }>;
export type SqlChangeSubscription = {
  /** Subscribe first, await ready, then read the authoritative initial snapshot. */
  ready: Promise<void>;
  close(): Promise<void>;
};
type SourceDetails =
  | { driver: "sqlite"; database: DatabaseSync; filename: string | null }
  | { driver: "postgres"; config: ClientConfig; schema: string };
const details = new WeakMap<SqlChangeSource, SourceDetails>();
const sqliteSources = new WeakMap<DatabaseSync, SqlChangeSource>();
const sqliteBus = new Map<string, Set<() => void>>();
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export function sqliteChangeSource(database: DatabaseSync): SqlChangeSource {
  const known = sqliteSources.get(database);
  if (known) return known;
  const location = database.location();
  const filename = location ? realpathSync(location) : null;
  const source = Object.freeze({
    driver: "sqlite" as const,
    identity: hash(filename ?? `memory:${randomUUID()}`),
  });
  details.set(source, { driver: "sqlite", database, filename });
  sqliteSources.set(database, source);
  return source;
}

export function postgresChangeSource(
  config: ClientConfig,
  schema: string,
): SqlChangeSource {
  postgresCommitChannel(schema);
  const connectionIdentity =
    config.connectionString ??
    JSON.stringify({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
    });
  const source = Object.freeze({
    driver: "postgres" as const,
    identity: hash(`${connectionIdentity}\0${schema}`),
  });
  details.set(source, { driver: "postgres", config: { ...config }, schema });
  return source;
}

/** PostgreSQL channels are already scoped to a database. Never include a role,
 * password, SQL text or row contents in the channel or empty notification. */
export function postgresCommitChannel(schema: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema))
    throw new Error("变化通知的数据库 schema 名称无效。");
  return `morphz_commit_${hash(schema).slice(0, 32)}`;
}

export function sqlChangeSchema(source: SqlChangeSource): string | null {
  const value = details.get(source);
  if (!value) throw new Error("变化通知来源未注册。");
  return value.driver === "postgres" ? value.schema : null;
}

/** Only transaction owners call this AFTER a successful SQLite COMMIT. The
 * observer is asynchronous; a snapshot read cannot block the committing gate. */
export function publishSqliteCommit(source: SqlChangeSource): void {
  const value = details.get(source);
  if (!value || value.driver !== "sqlite") return;
  if (value.database.isTransaction)
    throw new Error("不能在事务提交前发布变化通知。");
  const listeners = sqliteBus.get(source.identity);
  if (listeners)
    for (const listener of [...listeners]) queueMicrotask(listener);
}

/** Hints invalidate a snapshot; they are NOT a durable event, state, result or
 * authorization. SQLite file watching is best effort across processes: startup,
 * reconnect and focus must still verify current revisions. No periodic SQL is
 * used while healthy. PostgreSQL has a dedicated LISTEN connection, not a pool
 * checkout; only a lost connection starts a bounded-backoff reconnect timer. */
export function observeSqlChanges(
  source: SqlChangeSource,
  onHint: (hint: SqlChangeHint) => void | Promise<void>,
): SqlChangeSubscription {
  const value = details.get(source);
  if (!value) throw new Error("变化通知来源未注册。");
  let closed = false;
  let pending: SqlChangeHint["reason"] | null = null;
  const enqueue = (reason: SqlChangeHint["reason"]) => {
    if (closed) return;
    if (pending) {
      if (reason === "resync") pending = reason;
      return;
    }
    pending = reason;
    queueMicrotask(() => {
      if (closed) return;
      const hint = Object.freeze({ reason: pending! });
      pending = null;
      // Consumer errors must never turn an already committed command into a
      // failure or escape as an unhandled rejection. Host owns read failures.
      try {
        Promise.resolve(onHint(hint)).catch(() => undefined);
      } catch {
        /* Host owns errors. */
      }
    });
  };
  if (value.driver === "sqlite") {
    let observer: DatabaseSync | null = null;
    let watcher: FSWatcher | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let baseline = 0;
    let fileIdentity = "";
    let recoveryPending = false;
    const fileWatchers = new Map<
      string,
      { identity: string; watcher: FSWatcher }
    >();
    const readVersion = () =>
      Number(
        (
          observer!.prepare("PRAGMA data_version").get() as {
            data_version: number;
          }
        ).data_version,
      );
    const openObserver = () => {
      if (!value.filename) return;
      const stat = statSync(value.filename);
      fileIdentity = `${stat.dev}:${stat.ino}`;
      observer?.close();
      observer = new DatabaseSync(value.filename, { readOnly: true });
      baseline = readVersion();
    };
    const checkVersion = () => {
      if (closed || !value.filename) return false;
      try {
        const stat = statSync(value.filename);
        if (`${stat.dev}:${stat.ino}` !== fileIdentity || !observer) {
          openObserver();
          enqueue("resync");
          return true;
        }
        const version = readVersion();
        if (version !== baseline) {
          baseline = version;
          enqueue("commit");
        }
      } catch {
        enqueue("resync");
      }
      return false;
    };
    const knownCommit = () => {
      if (closed) return;
      // Updating the observer baseline suppresses the later WAL echo. This SQL
      // runs only after a known commit, never on an idle health timer.
      if (observer)
        try {
          baseline = readVersion();
        } catch {
          enqueue("resync");
        }
      enqueue("commit");
    };
    const listeners = sqliteBus.get(source.identity) ?? new Set<() => void>();
    listeners.add(knownCommit);
    sqliteBus.set(source.identity, listeners);
    const closeWatchers = () => {
      const directoryWatcher = watcher;
      watcher = null;
      const files = [...fileWatchers.values()];
      fileWatchers.clear();
      directoryWatcher?.close();
      for (const file of files) file.watcher.close();
    };
    const lost = () => {
      if (closed) return;
      closeWatchers();
      if (timer) clearTimeout(timer);
      timer = null;
      recoveryPending = true;
      enqueue("resync");
      if (!retry) {
        retry = setTimeout(() => {
          retry = null;
          attach();
        }, 500);
        retry.unref();
      }
    };
    const scheduleCheck = () => {
      if (closed || timer) return;
      timer = setTimeout(() => {
        timer = null;
        try {
          reconcileFiles();
          // Opening a replacement observer can create its WAL/SHM. Subscribe
          // to the new sidecar once, without looping over version reads.
          if (checkVersion()) reconcileFiles();
        } catch {
          lost();
        }
      }, 20);
      timer.unref();
    };
    const reconcileFiles = () => {
      if (closed || !value.filename) return;
      for (const filename of [
        value.filename,
        `${value.filename}-wal`,
        `${value.filename}-journal`,
      ]) {
        const current = fileWatchers.get(filename);
        let identity: string;
        try {
          const stat = statSync(filename);
          identity = `${stat.dev}:${stat.ino}`;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          if (current) {
            fileWatchers.delete(filename);
            current.watcher.close();
          }
          // Absent sidecars are normal. Only registration and actual events
          // discover them; no healthy timer scans for future files.
          continue;
        }
        if (current?.identity === identity) continue;
        if (current) {
          fileWatchers.delete(filename);
          current.watcher.close();
        }
        let next: FSWatcher;
        try {
          next = watch(filename, { persistent: false }, () => {
            if (fileWatchers.get(filename)?.watcher !== next) return;
            scheduleCheck();
          });
        } catch (error) {
          // A short-lived journal can disappear between stat and watch.
          if (
            filename !== value.filename &&
            (error as NodeJS.ErrnoException).code === "ENOENT"
          )
            continue;
          throw error;
        }
        fileWatchers.set(filename, { identity, watcher: next });
        next.on("error", () => {
          if (fileWatchers.get(filename)?.watcher !== next) return;
          lost();
        });
      }
    };
    const attach = () => {
      if (closed || !value.filename) return;
      try {
        if (!observer) openObserver();
        const name = basename(value.filename);
        const next: FSWatcher = watch(
          dirname(value.filename),
          { persistent: false },
          (_event, entry) => {
            if (watcher !== next) return;
            if (
              entry &&
              ![name, `${name}-wal`, `${name}-journal`].includes(String(entry))
            )
              return;
            scheduleCheck();
          },
        );
        watcher = next;
        next.on("error", () => {
          if (watcher !== next) return;
          lost();
        });
        // Direct file subscriptions keep WAL commits observable even when a
        // successfully registered directory watcher delivers no callbacks.
        reconcileFiles();
        // The observer baseline is read before registration. A writer can
        // commit in that gap, or while a failed watcher is reconnecting. Check
        // once after successful registration, never on a healthy idle timer.
        if (checkVersion()) reconcileFiles();
        if (recoveryPending) {
          recoveryPending = false;
          // A lost subscription also invalidates the consumer's snapshot,
          // even when this connection's data_version did not change.
          enqueue("resync");
        }
      } catch {
        lost();
      }
    };
    attach();
    enqueue("resync");
    return {
      ready: Promise.resolve(),
      async close() {
        if (closed) return;
        closed = true;
        listeners.delete(knownCommit);
        if (!listeners.size) sqliteBus.delete(source.identity);
        if (timer) clearTimeout(timer);
        if (retry) clearTimeout(retry);
        closeWatchers();
        observer?.close();
      },
    };
  }
  let client: Client | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let delay = 100;
  let readyResolve!: () => void;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  const reconnect = () => {
    if (closed || retry) return;
    retry = setTimeout(() => {
      retry = null;
      void connect();
    }, delay);
    retry.unref();
    delay = Math.min(delay * 2, 10_000);
  };
  const connect = async () => {
    if (closed) return;
    const next = new Client({
      connectionTimeoutMillis: 5_000,
      ...value.config,
    });
    client = next;
    const lost = () => {
      if (closed || client !== next) return;
      client = null;
      enqueue("resync");
      void next.end().catch(() => undefined);
      reconnect();
    };
    next.on("error", lost);
    next.on("end", lost);
    next.on("notification", (message) => {
      if (message.channel === postgresCommitChannel(value.schema))
        enqueue("commit");
    });
    try {
      await next.connect();
      if (closed || client !== next) {
        await next.end();
        return;
      }
      await next.query(`LISTEN "${postgresCommitChannel(value.schema)}"`);
      delay = 100;
      readyResolve();
      enqueue("resync");
    } catch {
      lost();
    }
  };
  void connect();
  return {
    ready,
    async close() {
      if (closed) return;
      closed = true;
      if (retry) clearTimeout(retry);
      const current = client;
      client = null;
      await current?.end().catch(() => undefined);
      readyResolve();
    },
  };
}
