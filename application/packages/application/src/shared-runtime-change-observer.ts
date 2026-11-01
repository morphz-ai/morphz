import WebSocket from "ws";
import { z } from "zod";

const hintSchema = z.object({
  id: z.string().min(1).max(512),
  topic: z.string().max(256),
  payload: z.object({
    session_id: z.string().max(512).optional(),
    context_id: z.string().max(512).optional(),
  }),
});
const terminalHintSchema = hintSchema.shape.payload
  .extend({
    terminal_id: z.string().min(1).max(512).optional(),
    principal_id: z.string().min(1).max(512).optional(),
    root_turn_id: z.string().max(512).optional(),
    scope_ref: z.string().max(512).optional(),
    kind: z.enum(["output", "screen", "catalog", "resync"]),
  })
  .refine(
    (value) =>
      value.kind === "resync" ||
      !!(
        value.session_id &&
        value.context_id &&
        value.terminal_id &&
        value.principal_id
      ),
  );
export type RuntimeChangeHint = z.infer<typeof hintSchema>["payload"] &
  Partial<z.infer<typeof terminalHintSchema>>;
const ephemeral = new Set([
  "runtime/model_stream",
  "runtime/model_request_snapshot",
  "runtime/model_attempt_snapshot",
]);

/** Operator Host invalidations. One bounded metadata stream, never one socket
 * or a historical Event drain per registered Session. No hint is authority. */
export class SharedRuntimeChangeObserver {
  private socket?: WebSocket;
  private stopped = false;
  private ready = false;
  private connecting?: Promise<void>;
  private retry?: ReturnType<typeof setTimeout>;
  private known = new Set<string>();
  private seen = new Set<string>();
  constructor(
    private readonly options: {
      url: string;
      sessions: () => { id: string; contextId: string }[];
      headers: () => Record<string, string>;
      changed: (
        sessionIds: readonly string[],
        topic?: string,
        hint?: RuntimeChangeHint,
      ) => void;
    },
  ) {
    void this.sync();
  }
  // This observer never maintains a durable delivery cursor. The delivery
  // owner acknowledges its own HTTP delta independently.
  acknowledge(_id: string, _sequence: number) {}
  async sync() {
    if (this.stopped) return;
    const ids = new Set(this.options.sessions().map((s) => s.id));
    const added = [...ids].filter((id) => !this.known.has(id));
    this.known = ids;
    if (this.ready) {
      if (added.length)
        this.options.changed(added, "runtime/observer_scope_added");
      return;
    }
    if (this.connecting) return this.connecting;
    clearTimeout(this.retry);
    this.connecting = this.connect().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }
  private async connect() {
    const url = new URL("/ws", this.options.url);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("changes_only", "true");
    const ws = new WebSocket(url, {
      headers: this.options.headers(),
      handshakeTimeout: 1500,
      maxPayload: 16 * 1024,
    });
    this.socket = ws;
    ws.on("error", () => ws.terminate());
    ws.on("unexpected-response", (_request, response) => {
      response.resume();
      ws.terminate();
    });
    ws.on("message", (data) => {
      if (this.stopped || this.socket !== ws) return;
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        return;
      }
      const parsed = hintSchema.safeParse(raw);
      if (
        !parsed.success ||
        ephemeral.has(parsed.data.topic) ||
        this.seen.has(parsed.data.id)
      )
        return;
      let hint: RuntimeChangeHint = parsed.data.payload;
      if (parsed.data.topic === "runtime/terminal_changed") {
        const terminal = terminalHintSchema.safeParse(
          (raw as { payload: unknown }).payload,
        );
        if (!terminal.success) return;
        hint = terminal.data;
      }
      const { session_id, context_id } = hint;
      const ids = this.options
        .sessions()
        .filter((session) =>
          session_id
            ? session.id === session_id
            : context_id && session.contextId === context_id,
        )
        .map((session) => session.id);
      if (
        !ids.length &&
        !(
          parsed.data.topic === "runtime/terminal_changed" &&
          hint.kind === "resync"
        )
      )
        return;
      this.seen.add(parsed.data.id);
      if (this.seen.size > 1024)
        this.seen.delete(this.seen.values().next().value!);
      this.options.changed(ids, parsed.data.topic, hint);
    });
    ws.once("close", () => {
      if (this.socket !== ws) return;
      this.socket = undefined;
      this.ready = false;
      if (!this.stopped) {
        this.retry = setTimeout(() => {
          this.retry = undefined;
          void this.sync();
        }, 2000);
        this.retry.unref?.();
      }
    });
    await new Promise<void>((resolve) => {
      const closed = () => {
        ws.off("open", opened);
        resolve();
      };
      const opened = () => {
        ws.off("close", closed);
        if (!this.stopped && this.socket === ws) {
          this.ready = true;
          // A reconnect gap invalidates current typed state. It is not a
          // reason to replay every historical message of every Session.
          this.options.changed([...this.known]);
        }
        resolve();
      };
      ws.once("open", opened);
      ws.once("close", closed);
    });
  }
  close() {
    this.stopped = true;
    this.ready = false;
    clearTimeout(this.retry);
    const ws = this.socket;
    this.socket = undefined;
    ws?.terminate();
  }
}
