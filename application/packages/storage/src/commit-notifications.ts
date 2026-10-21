import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
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
  | { driver: "sqlite"; database: DatabaseSync }
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
  details.set(source, { driver: "sqlite", database });
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
 * authorization. SQLite observes explicit commits within this Host process only;
 * it does not watch database files or discover external-process writes. Consumers
 * still read authoritative state on subscription/reconnect. PostgreSQL has a
 * dedicated LISTEN connection, not a pool checkout; only a lost connection starts
 * a bounded-backoff reconnect timer. */
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
    const knownCommit = () => enqueue("commit");
    const listeners = sqliteBus.get(source.identity) ?? new Set<() => void>();
    listeners.add(knownCommit);
    sqliteBus.set(source.identity, listeners);
    enqueue("resync");
    return {
      ready: Promise.resolve(),
      async close() {
        if (closed) return;
        closed = true;
        listeners.delete(knownCommit);
        if (!listeners.size) sqliteBus.delete(source.identity);
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
