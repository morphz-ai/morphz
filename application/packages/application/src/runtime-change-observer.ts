import WebSocket from "ws";
import { z } from "zod";

const eventSchema = z.object({
  id: z.string().min(1),
  sequence: z.number().int().positive(),
  topic: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
const wireEventSchema = eventSchema.extend({
  sequence: z.number().int().positive().optional(),
});
type Connection = {
  socket?: WebSocket;
  cursor: number;
  ready: boolean;
  retryAt: number;
  loading?: Promise<void>;
  seen: Set<string>;
};

/** Host-only invalidation, not another execution ledger. Runtime's committed
 * events wake authorized views; transient token deltas never cause reads.
 * One observer is shared by the Host's workspace subscriptions. */
export class RuntimeChangeObserver {
  private connections = new Map<string, Connection>();
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private draining?: Promise<void>;
  private dirty = false;
  constructor(
    private readonly options: {
      url: string;
      sessions: () => { id: string; cursor: number }[];
      headers: () => Record<string, string>;
      request: (path: string) => Promise<unknown>;
      changed: (sessionId: string) => void;
    },
  ) {
    void this.sync();
  }

  private active(id: string, connection: Connection) {
    return (
      !this.stopped &&
      this.connections.get(id) === connection &&
      this.options.sessions().some((session) => session.id === id)
    );
  }
  private wake(id: string, connection: Connection) {
    if (this.active(id, connection)) this.options.changed(id);
  }
  private accept(id: string, connection: Connection, raw: unknown) {
    if (!this.active(id, connection)) return;
    const parsed = wireEventSchema.safeParse(raw);
    // The live EventBus may omit a physical sequence on a committed Event.
    // Such a frame is a read hint, never a receipt or a replay cursor. Token
    // streams and ephemeral model snapshots belong to the conversation feed.
    if (
      !parsed.success ||
      parsed.data.payload.session_id !== id ||
      [
        "runtime/model_stream",
        "runtime/model_request_snapshot",
        "runtime/model_attempt_snapshot",
      ].includes(parsed.data.topic) ||
      (parsed.data.sequence !== undefined &&
        parsed.data.sequence <= connection.cursor)
    )
      return;
    if (parsed.data.sequence !== undefined)
      connection.cursor = parsed.data.sequence;
    if (connection.seen.has(parsed.data.id)) return;
    connection.seen.add(parsed.data.id);
    if (connection.seen.size > 1000)
      connection.seen.delete(connection.seen.values().next().value!);
    this.wake(id, connection);
  }
  private scheduleRetry() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopped) return;
    const retries = [...this.connections.entries()]
      .filter(([id, c]) => this.active(id, c) && !c.ready && !c.loading)
      .map(([, c]) => c.retryAt);
    if (!retries.length) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.sync();
      },
      Math.max(0, Math.min(...retries) - Date.now()),
    );
    this.timer.unref?.();
  }
  async sync() {
    if (this.stopped) return;
    if (this.draining) {
      this.dirty = true;
      return this.draining;
    }
    this.draining = Promise.resolve().then(async () => {
      try {
        do {
          this.dirty = false;
          const sessions = this.options.sessions();
          const ids = new Set(sessions.map((session) => session.id));
          for (const [id, c] of this.connections) {
            if (ids.has(id)) continue;
            this.connections.delete(id);
            c.socket?.terminate();
          }
          await Promise.all(
            sessions.map((session) => {
              let c = this.connections.get(session.id);
              if (!c) {
                c = {
                  cursor: Math.max(0, session.cursor),
                  ready: false,
                  retryAt: 0,
                  seen: new Set(),
                };
                this.connections.set(session.id, c);
              }
              if (!c.ready && !c.loading && Date.now() >= c.retryAt) {
                const current = c;
                c.loading = this.connect(session.id, c).finally(() => {
                  current.loading = undefined;
                });
              }
              return c.loading;
            }),
          );
        } while (this.dirty && !this.stopped);
      } finally {
        this.draining = undefined;
        this.scheduleRetry();
      }
    });
    return this.draining;
  }
  private async connect(id: string, c: Connection) {
    try {
      const session = z
        .object({ id: z.literal(id) })
        .parse(
          await this.options.request(`/api/sessions/${encodeURIComponent(id)}`),
        );
      if (!this.active(session.id, c)) return;
      const after = c.cursor;
      const url = new URL("/ws", this.options.url);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("session_id", id);
      const ws = new WebSocket(url, {
        headers: this.options.headers(),
        handshakeTimeout: 1500,
        maxPayload: 4 * 1024 * 1024,
      });
      c.socket = ws;
      ws.on("message", (data) => {
        if (c.socket !== ws) return;
        try {
          this.accept(id, c, JSON.parse(data.toString()));
        } catch {
          /* Invalid frame is not a wake. */
        }
      });
      ws.on("error", () => ws.terminate());
      ws.on("unexpected-response", (_request, response) => {
        response.resume();
        ws.terminate();
      });
      ws.on("close", () => {
        if (c.socket !== ws) return;
        c.socket = undefined;
        c.ready = false;
        c.retryAt = Date.now() + 2000;
        this.wake(id, c);
        this.scheduleRetry();
      });
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          ws.removeListener("open", opened);
          ws.removeListener("close", closed);
        };
        const opened = () => {
          done();
          resolve();
        };
        const closed = () => {
          done();
          reject(new Error("Runtime change stream closed"));
        };
        ws.once("open", opened);
        ws.once("close", closed);
      });
      if (!this.active(id, c) || c.socket !== ws) {
        ws.terminate();
        return;
      }
      // Subscribe before catching up. Use a separate history cursor so a live
      // frame arriving during the read cannot skip the preceding committed page.
      let cursor = after;
      for (;;) {
        const { events } = z
          .object({ events: z.array(eventSchema) })
          .parse(
            await this.options.request(
              `/api/sessions/${encodeURIComponent(id)}/events?after_sequence=${cursor}&limit=1000`,
            ),
          );
        if (!this.active(id, c) || c.socket !== ws) return;
        for (const event of events) {
          if (event.payload.session_id !== id)
            throw new Error("Runtime returned another Session's event");
          this.accept(id, c, event);
        }
        const next = Math.max(cursor, ...events.map((event) => event.sequence));
        if (events.length < 1000) break;
        if (next === cursor)
          throw new Error("Runtime event cursor did not advance");
        cursor = next;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      if (
        this.active(id, c) &&
        c.socket === ws &&
        ws.readyState === WebSocket.OPEN
      ) {
        c.ready = true;
        this.wake(id, c); // Restore a view even when the missed work emitted no new frame.
      }
    } catch {
      if (!this.active(id, c)) return;
      const ws = c.socket;
      c.socket = undefined;
      ws?.terminate();
      c.ready = false;
      c.retryAt = Date.now() + 2000;
      this.wake(id, c);
    }
  }
  close() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    for (const c of this.connections.values()) c.socket?.terminate();
    this.connections.clear();
  }
}
