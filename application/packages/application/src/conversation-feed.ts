import WebSocket from "ws";
import { z } from "zod";
import {
  LiveConversationProjection,
  type ConversationStream,
  type LiveMessage,
  type StreamEvent,
} from "../../../packages/core/src/live-conversation.js";

const eventSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  topic: z.string(),
  type: z.string().optional(),
  sequence: z.number().optional(),
  payload: z.record(z.string(), z.unknown()),
});
type Connection = {
  socket?: WebSocket;
  projection: LiveConversationProjection;
  cursor: number;
  ready: boolean;
  retryAt: number;
  loading?: Promise<void>;
};
/** Read-only, per-authorized-conversation observer. Credentials never reach the renderer.
 * WebSocket supplies deltas; durable pagination repairs gaps without replaying work. */
export class ConversationFeed {
  private connections = new Map<string, Connection>();
  private disposed = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private catchupTimer?: ReturnType<typeof setTimeout>;
  private synchronizing?: Promise<void>;
  private syncAgain = false;
  private notifyTimer?: ReturnType<typeof setTimeout>;
  constructor(
    private options: {
      sessions: () => string[];
      initialCursor?: (sessionId: string) => number;
      messageLimit?: number;
      url: string;
      headers: () => Record<string, string>;
      request: (path: string) => Promise<unknown>;
      route: (
        sessionId: string,
        event: StreamEvent,
      ) => Omit<LiveMessage, "id" | "text" | "kind" | "createdAt">;
      onEvent?: (sessionId: string, event: StreamEvent) => void;
      changed: (snapshot: ConversationStream) => void;
      authorize: () => void | Promise<void>;
      failed: () => void;
    },
  ) {
    void this.sync();
  }
  private active(id: string, connection: Connection) {
    return (
      !this.disposed &&
      this.connections.get(id) === connection &&
      this.options.sessions().includes(id)
    );
  }
  private scheduleRetry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    if (this.disposed) return;
    const retryAt = [...this.connections.entries()]
      .filter(([id, c]) => this.active(id, c) && !c.ready && !c.loading)
      .map(([, c]) => c.retryAt);
    if (!retryAt.length) return;
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = undefined;
        void this.sync();
      },
      Math.max(0, Math.min(...retryAt) - Date.now()),
    );
  }
  private notify() {
    if (this.disposed || this.notifyTimer) return;
    this.notifyTimer = setTimeout(async () => {
      this.notifyTimer = undefined;
      if (this.disposed) return;
      try {
        await this.options.authorize();
        if (this.disposed) return;
        const authorized = new Set(this.options.sessions());
        const current = [...this.connections.entries()].filter(([id]) =>
          authorized.has(id),
        );
        const messages = current.flatMap(([sessionId, c]) =>
          c.projection.snapshot().map((message) => ({
            ...message,
            id: message.id.startsWith("tool:")
              ? `tool:${sessionId}:${message.id.slice(5)}`
              : message.id.startsWith("stream:")
                ? `stream:${sessionId}:${message.id.slice(7)}`
                : message.id,
          })),
        );
        this.options.changed({
          connected: current.every(([, c]) => c.ready),
          messages: this.options.messageLimit
            ? messages
                .sort(
                  (a, b) =>
                    a.createdAt.localeCompare(b.createdAt) ||
                    a.id.localeCompare(b.id),
                )
                .slice(-this.options.messageLimit)
            : messages,
        });
      } catch {
        this.close();
      }
    }, 50);
  }
  async sync() {
    if (this.disposed) return;
    if (this.synchronizing) {
      this.syncAgain = true;
      return this.synchronizing;
    }
    this.synchronizing = Promise.resolve().then(async () => {
      try {
        do {
          this.syncAgain = false;
          await this.synchronizeOnce();
        } while (this.syncAgain && !this.disposed);
      } finally {
        // Clear in the same continuation as the last dirty check. An outer
        // .finally leaves a microtask gap where a new hint joins a finished
        // drain and is never read once healthy polling has been removed.
        this.synchronizing = undefined;
        this.scheduleRetry();
      }
    });
    return this.synchronizing;
  }
  private async synchronizeOnce() {
    if (this.disposed) return;
    try {
      await this.options.authorize();
      if (this.disposed) return;
    } catch {
      this.close();
      return;
    }
    const sessionIds = this.options.sessions();
    const authorized = new Set(sessionIds);
    for (const [id, connection] of this.connections) {
      if (authorized.has(id)) continue;
      this.connections.delete(id);
      connection.socket?.terminate();
    }
    await Promise.all(
      sessionIds.map((id) => {
        let c = this.connections.get(id);
        if (!c) {
          c = {
            projection: new LiveConversationProjection((e) =>
              this.options.route(id, e),
            ),
            cursor: Math.max(0, this.options.initialCursor?.(id) ?? 0),
            ready: false,
            retryAt: 0,
          };
          this.connections.set(id, c);
        }
        if (!c.loading)
          c.loading = this.update(id, c).finally(() => {
            c!.loading = undefined;
          });
        return c.loading;
      }),
    );
    this.notify();
  }
  private accept(id: string, c: Connection, raw: unknown) {
    if (!this.active(id, c)) return;
    const parsed = eventSchema.safeParse(raw);
    if (!parsed.success) return;
    const event = parsed.data;
    if (event.payload.session_id !== id) return;
    this.options.onEvent?.(id, event);
    c.projection.consume(event);
    this.notify();
  }
  private async update(id: string, c: Connection) {
    try {
      if (!this.active(id, c)) return;
      if (!c.socket && Date.now() >= c.retryAt) {
        // The existing HTTP principal-claim path must succeed before subscribing.
        await this.options.request(`/api/sessions/${encodeURIComponent(id)}`);
        if (!this.active(id, c)) return;
        const url = new URL("/ws", this.options.url);
        url.protocol = "ws:";
        url.searchParams.set("session_id", id);
        const ws = new WebSocket(url, {
          headers: this.options.headers(),
          handshakeTimeout: 1500,
          maxPayload: 4 * 1024 * 1024,
        });
        c.socket = ws;
        ws.on("message", async (data) => {
          if (this.active(id, c) && c.socket === ws) {
            try {
              await this.options.authorize();
              if (!this.active(id, c) || c.socket !== ws) return;
              this.accept(id, c, JSON.parse(data.toString()));
            } catch {
              this.close();
            }
          }
        });
        ws.on("error", () => ws.terminate());
        ws.on("unexpected-response", (_req, res) => {
          res.resume();
          ws.terminate();
        });
        ws.on("close", () => {
          if (c.socket !== ws) return;
          c.socket = undefined;
          c.ready = false;
          c.retryAt = Date.now() + 2000;
          c.projection.reconnect();
          this.notify();
          this.scheduleRetry();
        });
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1600);
          const done = () => {
            clearTimeout(timer);
            resolve();
          };
          ws.once("open", () => {
            if (!this.active(id, c)) {
              ws.terminate();
              done();
              return;
            }
            c.ready = true;
            done();
            this.notify();
          });
          ws.once("close", done);
        });
      }
      // Subscribe before history; use the durable cursor, never transient sequences.
      // Yield between pages so long histories do not delay sending new input.
      if (!this.active(id, c)) return;
      const data = z
        .object({ events: z.array(eventSchema) })
        .parse(
          await this.options.request(
            `/api/sessions/${encodeURIComponent(id)}/events?after_sequence=${c.cursor}&limit=1000`,
          ),
        );
      if (!this.active(id, c)) return;
      for (const event of data.events.sort(
        (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0),
      )) {
        if (event.payload.session_id !== id) continue;
        this.accept(id, c, event);
        c.cursor = Math.max(c.cursor, event.sequence ?? 0);
      }
      c.ready = c.socket?.readyState === WebSocket.OPEN;
      if (data.events.length === 1000 && !this.disposed && !this.catchupTimer)
        this.catchupTimer = setTimeout(() => {
          this.catchupTimer = undefined;
          void this.sync();
        }, 0);
    } catch {
      if (!this.active(id, c)) return;
      c.ready = false;
      c.retryAt = Date.now() + 2000;
      this.notify();
    }
  }
  close() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.catchupTimer);
    clearTimeout(this.notifyTimer);
    for (const c of this.connections.values()) c.socket?.terminate();
    this.connections.clear();
    this.options.failed();
  }
}
