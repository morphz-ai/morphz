import { DatabaseSync } from "node:sqlite";

type Row = { key: string; body: string };
type Rows = Map<string, string>;
type BridgeEventCursor = { events: unknown[]; persisted: number };
/** The live Host explicitly marks every changed local delivery. An absent
 * delta means a complete state replacement; an empty delta changes none.
 * Existing deliveries are never removed or reordered by this append/update API.
 */
export type BridgeDeliveryChanges = ReadonlyMap<string, unknown>;
function* parsedRows(rows: Iterable<readonly [string, string]>) {
  for (const [key, body] of rows) yield [key, JSON.parse(body)] as const;
}
const domains = {
  sessions: "runtime_sessions",
  deliveries: "runtime_deliveries",
  publications: "runtime_publications",
  threadBindings: "runtime_thread_bindings",
  events: "runtime_session_events",
} as const;
const rowDomains = [
  domains.sessions,
  domains.deliveries,
  domains.publications,
  domains.threadBindings,
] as const;
type RowDomain = (typeof rowDomains)[number];

/** Host transport state. Runtime remains authoritative for Sessions and Events;
 * these relations retain local delivery/replay cursors, not a second Runtime.
 * The legacy runtime_state row is now only a small envelope and never contains
 * an entire conversation or a queued request body.
 */
export class RuntimeLedger {
  private cached: Record<RowDomain, Rows> | null = null;
  private header: string | null = null;
  private eventCounts: Map<string, number> | null = null;
  private eventSnapshots = new Map<
    string,
    { events: unknown[]; count: number; last: unknown }
  >();
  private lastReadState: unknown = null;
  private lastBridgeReadState: unknown = null;
  private bridgeEventCursors: Map<string, BridgeEventCursor> | null = null;

  constructor(
    private readonly db: DatabaseSync,
    oldVersion: number,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_sessions (
        key TEXT PRIMARY KEY, body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_deliveries (
        key TEXT PRIMARY KEY, ordinal INTEGER NOT NULL,
        session_id TEXT, project_id TEXT, state TEXT,
        body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runtime_deliveries_by_project_state
        ON runtime_deliveries(project_id,state,key);
      CREATE INDEX IF NOT EXISTS runtime_deliveries_by_session
        ON runtime_deliveries(session_id,state,key);
      CREATE INDEX IF NOT EXISTS runtime_deliveries_by_ordinal
        ON runtime_deliveries(ordinal,key);
      CREATE TABLE IF NOT EXISTS runtime_publications (
        key TEXT PRIMARY KEY, body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_thread_bindings (
        key TEXT PRIMARY KEY, body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_session_events (
        key TEXT PRIMARY KEY, session_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL, sequence INTEGER,
        body TEXT NOT NULL, UNIQUE(session_id,ordinal)
      );
      CREATE INDEX IF NOT EXISTS runtime_events_by_session_sequence
        ON runtime_session_events(session_id,sequence);
    `);
    // One transactional upgrade of existing profile data. There is no legacy
    // read path or dual write after this version has been installed.
    if (oldVersion < 17) {
      const row = db
        .prepare("SELECT body FROM runtime_state WHERE id=1")
        .get() as { body: string } | undefined;
      if (row) this.write(JSON.parse(row.body));
    }
    if (oldVersion < 19) this.backfillDeliveryEvents();
  }

  read(): unknown {
    return this.readState(true);
  }

  readEnvelope(): unknown {
    const row = this.db
      .prepare("SELECT body FROM runtime_state WHERE id=1")
      .get() as { body: string } | undefined;
    return row ? JSON.parse(row.body) : null;
  }

  /** The live bridge needs delivery cursors, not a second in-memory copy of
   * Runtime's complete history. Legacy callers can still request Events on
   * demand through read() or sessionEvents(). */
  readBridge(): unknown {
    return this.readState(false);
  }

  sessionEvents(sessionId: string): unknown[] {
    return Array.from(
      this.db
        .prepare(
          "SELECT body FROM runtime_session_events WHERE session_id=? ORDER BY ordinal",
        )
        .iterate(sessionId) as Iterable<{ body: string }>,
      (row) => JSON.parse(row.body),
    );
  }

  private readState(includeEvents: boolean): unknown {
    const row = this.db
      .prepare("SELECT body FROM runtime_state WHERE id=1")
      .get() as { body: string } | undefined;
    if (!row) {
      this.cached = null;
      this.header = null;
      this.eventCounts = null;
      this.eventSnapshots.clear();
      this.lastReadState = null;
      if (!includeEvents) {
        this.lastBridgeReadState = null;
        this.bridgeEventCursors = new Map();
      }
      return null;
    }
    const state = JSON.parse(row.body) as Record<string, unknown>;
    const cached = Object.fromEntries(
      rowDomains.map((table) => [table, new Map<string, string>()]),
    ) as Record<RowDomain, Rows>;
    for (const name of [
      "sessions",
      "publications",
      "threadBindings",
    ] as const) {
      const rows = cached[domains[name]];
      for (const item of this.db
        .prepare(`SELECT key,body FROM ${domains[name]}`)
        .iterate() as Iterable<Row>)
        rows.set(item.key, item.body);
      if (name in state) state[name] = Object.fromEntries(parsedRows(rows));
    }
    const deliveries: unknown[] = [];
    for (const item of this.db
      .prepare("SELECT key,body FROM runtime_deliveries ORDER BY ordinal")
      .iterate() as Iterable<Row>) {
      cached[domains.deliveries].set(item.key, item.body);
      if ("deliveries" in state) deliveries.push(JSON.parse(item.body));
    }
    if ("deliveries" in state) state.deliveries = deliveries;
    const sessions =
      "sessions" in state
        ? (state.sessions as Record<string, Record<string, unknown>>)
        : null;
    const eventCounts = new Map<string, number>();
    if (includeEvents) {
      for (const item of this.db
        .prepare(
          "SELECT session_id,ordinal,body FROM runtime_session_events ORDER BY session_id,ordinal",
        )
        .iterate() as Iterable<{
        session_id: string;
        ordinal: number;
        body: string;
      }>) {
        eventCounts.set(item.session_id, item.ordinal + 1);
        const session = sessions?.[item.session_id];
        if (session) (session.events as unknown[]).push(JSON.parse(item.body));
      }
    } else {
      const count = this.db.prepare(
        "SELECT COALESCE(MAX(ordinal)+1,0) AS count FROM runtime_session_events WHERE session_id=?",
      );
      for (const sessionId of Object.keys(sessions ?? {})) {
        const item = count.get(sessionId) as { count: number };
        eventCounts.set(sessionId, item.count);
      }
    }
    const eventSnapshots = new Map<
      string,
      { events: unknown[]; count: number; last: unknown }
    >();
    if (sessions) {
      for (const [sessionId, session] of Object.entries(sessions)) {
        const events = session.events;
        if (Array.isArray(events))
          eventSnapshots.set(sessionId, {
            events,
            count: events.length,
            last: events.at(-1),
          });
      }
    }
    // The first post-restart save compares against the rows already read;
    // it does not fetch a second copy of the row domains or event counts.
    this.cached = cached;
    this.header = row.body;
    this.eventCounts = eventCounts;
    if (includeEvents) {
      this.eventSnapshots = eventSnapshots;
      this.lastReadState = state;
    } else {
      this.lastBridgeReadState = state;
      this.bridgeEventCursors = new Map(
        Object.entries(sessions ?? {}).map(([id, session]) => [
          id,
          {
            events: session.events as unknown[],
            persisted: eventCounts.get(id) ?? 0,
          },
        ]),
      );
    }
    return state;
  }

  /** The bridge validates and clones the just-read state before its first
   * save. Its Event arrays still represent exactly the rows we loaded, so
   * rebind the append-only cursor instead of comparing the whole history.
   * This is only valid for that one read and its immediately validated copy.
   */
  adoptValidatedEvents(
    source: unknown,
    validated: { sessions: Record<string, { events: unknown[] }> },
  ) {
    if (source === this.lastBridgeReadState && this.bridgeEventCursors) {
      const originals = (source as typeof validated).sessions;
      const cursors = new Map<string, BridgeEventCursor>();
      for (const [sessionId, session] of Object.entries(validated.sessions)) {
        const loaded = this.bridgeEventCursors.get(sessionId);
        if (
          !loaded ||
          originals?.[sessionId]?.events !== loaded.events ||
          session.events.length !== 0
        )
          return;
        cursors.set(sessionId, {
          events: session.events,
          persisted: loaded.persisted,
        });
      }
      if (cursors.size !== this.bridgeEventCursors.size) return;
      this.bridgeEventCursors = cursors;
      this.lastBridgeReadState = null;
      return;
    }
    if (source !== this.lastReadState || !source || typeof source !== "object")
      return;
    const originals = (source as typeof validated).sessions;
    if (!originals) return;
    const snapshots = new Map<
      string,
      { events: unknown[]; count: number; last: unknown }
    >();
    for (const [sessionId, session] of Object.entries(validated.sessions)) {
      const original = originals[sessionId]?.events;
      const loaded = this.eventSnapshots.get(sessionId);
      if (
        !Array.isArray(original) ||
        !Array.isArray(session.events) ||
        loaded?.events !== original ||
        loaded.count !== session.events.length
      )
        return;
      snapshots.set(sessionId, {
        events: session.events,
        count: loaded.count,
        last: session.events.at(-1),
      });
    }
    if (snapshots.size !== this.eventSnapshots.size) return;
    this.eventSnapshots = snapshots;
    this.lastReadState = null;
  }

  save(value: unknown, appendOnlyEvents = false) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.write(value, appendOnlyEvents);
      this.db.exec("COMMIT");
      this.lastReadState = null;
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.cached = null;
      this.header = null;
      this.eventCounts = null;
      this.eventSnapshots.clear();
      this.lastReadState = null;
      throw error;
    }
  }

  /** Commit bridge metadata and only Events observed since its last commit.
   * The SQLite transaction protects the cursor and delivery settlement as one
   * unit; a crash before COMMIT causes the same Runtime page to be fetched
   * again. Never truncate historical rows just because the bridge did not
   * materialize them. */
  saveBridge(value: unknown, deliveries?: BridgeDeliveryChanges) {
    const cursors = this.bridgeEventCursors;
    if (!cursors) throw new Error("Runtime Bridge 的事件游标未初始化。");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.write(value, true, cursors, deliveries);
      this.db.exec("COMMIT");
      const sessions = (
        value as { sessions: Record<string, { events: unknown[] }> }
      ).sessions;
      for (const [id, session] of Object.entries(sessions)) {
        const cursor = cursors.get(id) ?? {
          events: session.events,
          persisted: 0,
        };
        // Platform conversations are read from Runtime's authorized timeline.
        // New local Event rows belong only to legacy conversation projection;
        // the Platform bridge commits its cursor and delivery state instead.
        if (!(session as { platform?: boolean }).platform)
          cursor.persisted += session.events.length;
        session.events.length = 0;
        cursors.set(id, cursor);
      }
      this.lastReadState = null;
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.cached = null;
      this.header = null;
      this.eventCounts = null;
      this.eventSnapshots.clear();
      throw error;
    }
  }

  private readRows(table: RowDomain): Rows {
    const rows = new Map<string, string>();
    for (const row of this.db
      .prepare(
        `SELECT key,body FROM ${table}${table === domains.deliveries ? " ORDER BY ordinal" : ""}`,
      )
      .iterate() as Iterable<Row>)
      rows.set(row.key, row.body);
    return rows;
  }

  private current() {
    if (!this.cached) {
      this.cached = Object.fromEntries(
        rowDomains.map((table) => [table, this.readRows(table)]),
      ) as Record<RowDomain, Rows>;
      this.eventCounts = new Map(
        (
          this.db
            .prepare(
              "SELECT session_id,MAX(ordinal)+1 AS count FROM runtime_session_events GROUP BY session_id",
            )
            .all() as { session_id: string; count: number }[]
        ).map((row) => [row.session_id, row.count]),
      );
      this.header =
        (
          this.db.prepare("SELECT body FROM runtime_state WHERE id=1").get() as
            { body: string } | undefined
        )?.body ?? null;
    }
    return this.cached;
  }

  private syncRows(table: RowDomain, next: Rows) {
    const previous = this.current()[table];
    const remove = this.db.prepare(`DELETE FROM ${table} WHERE key=?`);
    for (const key of previous.keys()) if (!next.has(key)) remove.run(key);
    const earlierOrder =
      table === domains.deliveries
        ? new Map([...previous.keys()].map((key, ordinal) => [key, ordinal]))
        : null;
    let ordinal = 0;
    for (const [key, body] of next) {
      const prior = previous.get(key);
      if (prior === body && earlierOrder?.get(key) === ordinal) {
        ordinal++;
        continue;
      }
      if (prior === body && !earlierOrder) continue;
      if (table === domains.deliveries) {
        const item = JSON.parse(body) as {
          sessionId?: string;
          state?: string;
          platformSource?: { projectId?: string };
        };
        this.db
          .prepare(
            `INSERT INTO runtime_deliveries(key,ordinal,session_id,project_id,state,body)
           VALUES(?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET
           ordinal=excluded.ordinal,session_id=excluded.session_id,project_id=excluded.project_id,
           state=excluded.state,body=excluded.body`,
          )
          .run(
            key,
            ordinal,
            item.sessionId ?? null,
            item.platformSource?.projectId ?? null,
            item.state ?? null,
            body,
          );
      } else {
        this.db
          .prepare(
            `INSERT INTO ${table}(key,body) VALUES(?,?)
           ON CONFLICT(key) DO UPDATE SET body=excluded.body`,
          )
          .run(key, body);
      }
      ordinal++;
    }
    this.current()[table] = next;
  }

  /** Commit only explicitly dirty deliveries. Ordering is preserved for an
   * existing identity; the first new identity obtains the next durable ordinal.
   * No queue scan, reference-identity cache or terminal-history deletion occurs.
   * A failed transaction invalidates cached rows in saveBridge, while its caller
   * keeps this exact dirty set until a successful commit.
   */
  private syncDeliveryChanges(changes: BridgeDeliveryChanges) {
    if (!changes.size) return;
    const previous = this.current()[domains.deliveries];
    const ordinal = this.db.prepare(
      "SELECT ordinal FROM runtime_deliveries WHERE key=?",
    );
    const upsert = this.db.prepare(
      `INSERT INTO runtime_deliveries(key,ordinal,session_id,project_id,state,body)
       VALUES(?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET
       session_id=excluded.session_id,project_id=excluded.project_id,
       state=excluded.state,body=excluded.body`,
    );
    let nextOrdinal: number | undefined;
    for (const [key, delivery] of changes) {
      if (!delivery || typeof delivery !== "object" || Array.isArray(delivery))
        throw new Error("Runtime 投递变更不是有效记录。");
      const item = delivery as {
        inputId?: string;
        sessionId?: string;
        platformSource?: { projectId?: string };
        state?: string;
      };
      if (!key || item.inputId !== key)
        throw new Error("Runtime 投递变更标识与原始输入不一致。");
      const body = JSON.stringify(delivery);
      if (previous.get(key) === body) continue;
      const existing = ordinal.get(key) as { ordinal: number } | undefined;
      if (!existing && nextOrdinal === undefined)
        nextOrdinal = (
          this.db
            .prepare(
              "SELECT COALESCE(MAX(ordinal)+1,0) AS next FROM runtime_deliveries",
            )
            .get() as { next: number }
        ).next;
      const order = existing ? existing.ordinal : nextOrdinal!;
      if (!existing) nextOrdinal = order + 1;
      upsert.run(
        key,
        order,
        item.sessionId ?? null,
        item.platformSource?.projectId ?? null,
        item.state ?? null,
        body,
      );
      previous.set(key, body);
    }
  }

  /** Runtime Events are append-only. The live bridge retains the same event
   * array and only pushes immutable events; that hot path serializes/writes
   * the new tail. Replaced arrays (imports/tests) are compared in full.
   */
  private syncEvents(
    bySession: Map<string, unknown[]>,
    appendOnlyEvents: boolean,
  ) {
    this.current();
    const counts = this.eventCounts!;
    const remove = this.db.prepare(
      "DELETE FROM runtime_session_events WHERE session_id=?",
    );
    for (const sessionId of counts.keys()) {
      if (bySession.has(sessionId)) continue;
      remove.run(sessionId);
      counts.delete(sessionId);
      this.eventSnapshots.delete(sessionId);
    }
    const upsert = this.db.prepare(
      `INSERT INTO runtime_session_events(key,session_id,ordinal,sequence,body)
       VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET
       sequence=excluded.sequence,body=excluded.body`,
    );
    const removeTail = this.db.prepare(
      "DELETE FROM runtime_session_events WHERE session_id=? AND ordinal>=?",
    );
    for (const [sessionId, events] of bySession) {
      const priorCount = counts.get(sessionId) ?? 0;
      const snapshot = this.eventSnapshots.get(sessionId);
      const appendOnly =
        appendOnlyEvents &&
        snapshot?.events === events &&
        snapshot.count === priorCount &&
        events.length >= snapshot.count &&
        (snapshot.count === 0 || events[snapshot.count - 1] === snapshot.last);
      const previous = appendOnly
        ? null
        : new Map(
            (
              this.db
                .prepare(
                  "SELECT ordinal,body FROM runtime_session_events WHERE session_id=? ORDER BY ordinal",
                )
                .all(sessionId) as { ordinal: number; body: string }[]
            ).map((row) => [row.ordinal, row.body]),
          );
      const start = appendOnly ? priorCount : 0;
      for (let ordinal = start; ordinal < events.length; ordinal++) {
        const key = JSON.stringify([sessionId, ordinal]);
        const body = JSON.stringify(events[ordinal]);
        if (previous?.get(ordinal) === body) continue;
        const event = events[ordinal] as { sequence?: number };
        upsert.run(key, sessionId, ordinal, event?.sequence ?? null, body);
      }
      if (events.length < priorCount) {
        removeTail.run(sessionId, events.length);
      }
      counts.set(sessionId, events.length);
      this.eventSnapshots.set(sessionId, {
        events,
        count: events.length,
        last: events.at(-1),
      });
    }
  }

  private syncBridgeEvents(
    bySession: Map<string, unknown[]>,
    cursors: Map<string, BridgeEventCursor>,
    platformSessions: Set<string>,
  ) {
    const upsert = this.db.prepare(
      `INSERT INTO runtime_session_events(key,session_id,ordinal,sequence,body)
       VALUES(?,?,?,?,?)`,
    );
    for (const [sessionId, events] of bySession) {
      const cursor = cursors.get(sessionId);
      if (cursor && cursor.events !== events)
        throw new Error("Runtime Bridge 的事件数组已被替换，拒绝改写历史。");
      // A Platform input and its answer are already durable in Runtime. Do
      // not grow a second, Host-local message archive while polling them.
      if (platformSessions.has(sessionId)) continue;
      const persisted = cursor?.persisted ?? 0;
      const actual = this.db
        .prepare(
          "SELECT COALESCE(MAX(ordinal)+1,0) AS count FROM runtime_session_events WHERE session_id=?",
        )
        .get(sessionId) as { count: number };
      if (actual.count !== persisted)
        throw new Error("Runtime Bridge 的事件游标已变化，拒绝覆盖历史。");
      for (let index = 0; index < events.length; index++) {
        const ordinal = persisted + index;
        const event = events[index] as { sequence?: number };
        upsert.run(
          JSON.stringify([sessionId, ordinal]),
          sessionId,
          ordinal,
          event?.sequence ?? null,
          JSON.stringify(event),
        );
      }
    }
  }

  /** One-time projection of the old local Event mirror. Subsequent starts only
   * read delivery rows and Event counts. No reply body is copied into the
   * projection: each delivery retains only its last activity time and causal
   * thread IDs needed to settle a later combined terminal result. */
  private backfillDeliveryEvents() {
    type DeliveryRow = {
      key: string;
      body: string;
      value: {
        sessionId?: string;
        rootId?: string | null;
        platformSource?: unknown;
        causalThreadIds?: string[];
        lastActivityAt?: string;
      };
      changed: boolean;
    };
    const bySessionRoot = new Map<string, Map<string, DeliveryRow[]>>();
    const deliveries = new Map<string, DeliveryRow>();
    for (const row of this.db
      .prepare("SELECT key,body FROM runtime_deliveries ORDER BY ordinal")
      .iterate() as Iterable<Row>) {
      const value = JSON.parse(row.body) as DeliveryRow["value"];
      const item: DeliveryRow = { ...row, value, changed: false };
      deliveries.set(row.key, item);
      if (!value.sessionId || !value.rootId) continue;
      const roots = bySessionRoot.get(value.sessionId) ?? new Map();
      const owners = roots.get(value.rootId) ?? [];
      owners.push(item);
      roots.set(value.rootId, owners);
      bySessionRoot.set(value.sessionId, roots);
    }
    const bySessionThread = new Map<string, Map<string, Set<string>>>();
    const eventRows = () =>
      this.db
        .prepare(
          "SELECT session_id,body FROM runtime_session_events ORDER BY session_id,ordinal",
        )
        .iterate() as Iterable<{ session_id: string; body: string }>;
    const routeValue = (payload: Record<string, unknown>, key: string) => {
      const route =
        payload.route && typeof payload.route === "object"
          ? (payload.route as Record<string, unknown>)
          : null;
      const value = payload[key] ?? route?.[key];
      return typeof value === "string" ? value : null;
    };
    for (const row of eventRows()) {
      const event = JSON.parse(row.body) as {
        topic?: string;
        payload?: Record<string, unknown>;
      };
      if (event.topic !== "runtime/thread_result" || !event.payload) continue;
      const root = routeValue(event.payload, "root_turn_id");
      const thread = routeValue(event.payload, "thread_id");
      if (!root || !thread) continue;
      const owners = bySessionRoot.get(row.session_id)?.get(root);
      if (!owners?.length) continue;
      const threads = bySessionThread.get(row.session_id) ?? new Map();
      const mapped = threads.get(thread) ?? new Set<string>();
      for (const owner of owners) {
        mapped.add(owner.key);
        const ids = owner.value.causalThreadIds ?? [];
        if (!ids.includes(thread)) {
          owner.value.causalThreadIds = [...ids, thread];
          owner.changed = true;
        }
      }
      threads.set(thread, mapped);
      bySessionThread.set(row.session_id, threads);
    }
    const activityTopics = new Set([
      "chat/reply",
      "chat/outbound_message",
      "chat/progress",
      "chat/runtime_error",
      "session/io_state",
      "runtime/response_protocol_fused",
    ]);
    for (const row of eventRows()) {
      const event = JSON.parse(row.body) as {
        topic?: string;
        timestamp?: string;
        payload?: Record<string, unknown>;
      };
      if (
        !event.topic ||
        !activityTopics.has(event.topic) ||
        !event.payload ||
        !event.timestamp ||
        !["text", "error", "message"].some((key) =>
          routeValue(event.payload!, key),
        )
      )
        continue;
      const roots = bySessionRoot.get(row.session_id);
      let owner: DeliveryRow | undefined;
      let direct = false;
      for (const key of [
        "root_turn_id",
        "trigger_event_id",
        "source_turn_id",
      ]) {
        const root = routeValue(event.payload, key);
        const matches = root ? roots?.get(root) : undefined;
        if (!matches) continue;
        direct = true;
        owner = matches.length === 1 ? matches[0] : undefined;
        break;
      }
      if (!direct) {
        const keys = new Set<string>();
        for (const value of [event.payload.covers, event.payload.defer_covers])
          if (Array.isArray(value))
            for (const thread of value)
              if (typeof thread === "string")
                for (const key of bySessionThread
                  .get(row.session_id)
                  ?.get(thread) ?? [])
                  keys.add(key);
        if (keys.size === 1) owner = deliveries.get([...keys][0]!);
      }
      if (
        owner?.value.platformSource &&
        (!owner.value.lastActivityAt ||
          owner.value.lastActivityAt < event.timestamp)
      ) {
        owner.value.lastActivityAt = event.timestamp;
        owner.changed = true;
      }
    }
    const update = this.db.prepare(
      "UPDATE runtime_deliveries SET body=? WHERE key=?",
    );
    for (const row of deliveries.values())
      if (row.changed) update.run(JSON.stringify(row.value), row.key);
  }

  private write(
    value: unknown,
    appendOnlyEvents = false,
    bridgeEventCursors?: Map<string, BridgeEventCursor>,
    deliveryChanges?: BridgeDeliveryChanges,
  ) {
    const state =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    const header = state ? { ...state } : null;
    const collections: Record<RowDomain, Rows> = {
      [domains.sessions]: new Map(),
      [domains.deliveries]: new Map(),
      [domains.publications]: new Map(),
      [domains.threadBindings]: new Map(),
    };
    const eventsBySession = new Map<string, unknown[]>();
    const platformSessions = new Set<string>();
    if (state && header) {
      for (const name of [
        "sessions",
        "publications",
        "threadBindings",
      ] as const) {
        if (!(name in state)) continue;
        const source = state[name] as Record<string, unknown>;
        for (const [key, item] of Object.entries(source)) {
          if (name === "sessions" && item && typeof item === "object") {
            const session = item as Record<string, unknown>;
            const events = session.events;
            collections[domains.sessions].set(
              key,
              JSON.stringify({
                ...session,
                ...(Array.isArray(events) ? { events: [] } : {}),
              }),
            );
            if (Array.isArray(events)) eventsBySession.set(key, events);
            if (session.platform === true) platformSessions.add(key);
          } else collections[domains[name]].set(key, JSON.stringify(item));
        }
        header[name] = {};
      }
      if (Array.isArray(state.deliveries)) {
        if (!deliveryChanges)
          state.deliveries.forEach((delivery, ordinal) => {
            const item = delivery as { inputId?: string };
            const key = item.inputId ?? `ordinal:${ordinal}`;
            if (collections[domains.deliveries].has(key))
              throw new Error(`Runtime 投递标识重复：${key}`);
            collections[domains.deliveries].set(key, JSON.stringify(delivery));
          });
        header.deliveries = [];
      }
    }
    const body = header === null ? null : JSON.stringify(header);
    if (body !== this.header) {
      if (body === null)
        this.db.prepare("DELETE FROM runtime_state WHERE id=1").run();
      else
        this.db
          .prepare(
            "INSERT INTO runtime_state(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
          )
          .run(body);
      this.header = body;
    }
    for (const table of rowDomains)
      if (table === domains.deliveries && deliveryChanges)
        this.syncDeliveryChanges(deliveryChanges);
      else this.syncRows(table, collections[table]);
    if (bridgeEventCursors)
      this.syncBridgeEvents(
        eventsBySession,
        bridgeEventCursors,
        platformSessions,
      );
    else this.syncEvents(eventsBySession, appendOnlyEvents);
  }
}
