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
  private timer: ReturnType<typeof setInterval>;
  private notifyTimer?: ReturnType<typeof setTimeout>;
  constructor(
    private options: {
      sessions: () => string[];
      url: string;
      headers: () => Record<string, string>;
      request: (path: string) => Promise<unknown>;
      route: (
        sessionId: string,
        event: StreamEvent,
      ) => Omit<LiveMessage, "id" | "text" | "kind" | "createdAt">;
      changed: (snapshot: ConversationStream) => void;
      authorize: () => void;
      failed: () => void;
    },
  ) {
    this.timer = setInterval(() => void this.sync(), 1200);
    void this.sync();
  }
  private notify() {
    if (this.disposed || this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      if (this.disposed) return;
      try {
        this.options.authorize();
        this.options.changed({
          connected: [...this.connections.values()].every((c) => c.ready),
          messages: [...this.connections.entries()].flatMap(([sessionId, c]) =>
            c.projection
              .snapshot()
              .map((message) => ({
                ...message,
                id: message.id.startsWith("tool:")
                  ? `tool:${sessionId}:${message.id.slice(5)}`
                  : message.id.startsWith("stream:")
                    ? `stream:${sessionId}:${message.id.slice(7)}`
                    : message.id,
              })),
          ),
        });
      } catch {
        this.close();
        this.options.failed();
      }
    }, 50);
  }
  async sync() {
    if (this.disposed) return;
    try {
      this.options.authorize();
    } catch {
      this.close();
      this.options.failed();
      return;
    }
    await Promise.all(
      this.options.sessions().map((id) => {
        let c = this.connections.get(id);
        if (!c) {
          c = {
            projection: new LiveConversationProjection((e) =>
              this.options.route(id, e),
            ),
            cursor: 0,
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
    const parsed = eventSchema.safeParse(raw);
    if (!parsed.success) return;
    const event = parsed.data;
    if (event.payload.session_id !== id) return;
    c.projection.consume(event);
    this.notify();
  }
  private async update(id: string, c: Connection) {
    try {
      if (!c.socket && Date.now() >= c.retryAt) {
        // The existing HTTP principal-claim path must succeed before subscribing.
        await this.options.request(`/api/sessions/${encodeURIComponent(id)}`);
        if (this.disposed) return;
        const url = new URL("/ws", this.options.url);
        url.protocol = "ws:";
        url.searchParams.set("session_id", id);
        const ws = new WebSocket(url, {
          headers: this.options.headers(),
          handshakeTimeout: 1500,
          maxPayload: 4 * 1024 * 1024,
        });
        c.socket = ws;
        ws.on("message", (data) => {
          if (!this.disposed && c.socket === ws) {
            try {
              this.options.authorize();
              this.accept(id, c, JSON.parse(data.toString()));
            } catch {
              this.close();
              this.options.failed();
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
        });
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1600);
          const done = () => {
            clearTimeout(timer);
            resolve();
          };
          ws.once("open", () => {
            c.ready = true;
            done();
            this.notify();
          });
          ws.once("close", done);
        });
      }
      // Subscribe before history; use the durable cursor, never transient sequences.
      // Yield between pages so long histories do not delay sending new input.
      if (this.disposed) return;
      const data = z
        .object({ events: z.array(eventSchema) })
        .parse(
          await this.options.request(
            `/api/sessions/${encodeURIComponent(id)}/events?after_sequence=${c.cursor}&limit=1000`,
          ),
        );
      for (const event of data.events.sort(
        (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0),
      )) {
        if (event.payload.session_id !== id) continue;
        this.accept(id, c, event);
        c.cursor = Math.max(c.cursor, event.sequence ?? 0);
      }
      if (data.events.length === 1000 && !this.disposed)
        setTimeout(() => void this.sync(), 0);
    } catch {
      c.ready = false;
      this.notify();
    }
  }
  close() {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    clearTimeout(this.notifyTimer);
    for (const c of this.connections.values()) c.socket?.terminate();
    this.connections.clear();
    this.options.failed();
  }
}
