import { createServer, type IncomingHttpHeaders } from "node:http";
import { randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";

export const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function until(check: () => boolean, message: string, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await pause(10);
  }
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export type CommittedEvent = {
  id: string;
  sequence: number;
  timestamp: string;
  actor: string;
  type: string;
  topic: string;
  payload: Record<string, unknown>;
};

/** A real HTTP and WebSocket peer with controlled Runtime replies. This does
 * not start Rust or pretend the fixture's typed state is Runtime authority. */
export async function runtimeChangeFixture(sessionIds = ["session-one"]) {
  const token = "observer-runtime-secret";
  const sessions = new Set(sessionIds);
  const events = new Map<string, CommittedEvent[]>();
  const clients = new Map<WebSocket, string>();
  const requests: { path: string; headers: IncomingHttpHeaders }[] = [];
  const opens: { sessionId: string; headers: IncomingHttpHeaders }[] = [];
  const state = {
    jobs: [{ id: "job-one", revision: 1, status: "running", progress: 0 }],
    approvals: [] as { id: string; revision: number; status: string }[],
    schedules: [{ id: "schedule-one", revision: 1, status: "active" }],
  };
  let hook:
    | ((path: string) => Promise<{ status?: number; body: unknown } | void>)
    | undefined;
  const server = createServer(async (request, response) => {
    const path = request.url ?? "";
    requests.push({ path, headers: { ...request.headers } });
    response.setHeader("Content-Type", "application/json");
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    try {
      const intercepted = await hook?.(path);
      if (intercepted) {
        response.statusCode = intercepted.status ?? 200;
        response.end(JSON.stringify(intercepted.body));
        return;
      }
      const url = new URL(path, "http://fixture.invalid");
      const match = /^\/api\/sessions\/([^/]+)(.*)$/.exec(url.pathname);
      const id = match?.[1] ? decodeURIComponent(match[1]) : undefined;
      if (!id || !sessions.has(id)) {
        response.writeHead(404).end(JSON.stringify({ error: "not_found" }));
        return;
      }
      if (match?.[2] === "") response.end(JSON.stringify({ id }));
      else if (match?.[2] === "/events") {
        const after = Number(url.searchParams.get("after_sequence") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 1000);
        response.end(
          JSON.stringify({
            events: (events.get(id) ?? [])
              .filter((event) => event.sequence > after)
              .slice(0, limit),
          }),
        );
      } else if (match?.[2] === "/typed-state")
        response.end(JSON.stringify(state));
      else response.writeHead(404).end(JSON.stringify({ error: "not_found" }));
    } catch {
      response.writeHead(500).end(JSON.stringify({ error: "fixture_failed" }));
    }
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "", "http://fixture.invalid");
    const sessionId = url.searchParams.get("session_id") ?? "";
    if (
      url.pathname !== "/ws" ||
      request.headers.authorization !== `Bearer ${token}` ||
      !sessions.has(sessionId)
    ) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      clients.set(ws, sessionId);
      opens.push({ sessionId, headers: { ...request.headers } });
      ws.once("close", () => clients.delete(ws));
      ws.on("error", () => {});
      sockets.emit("connection", ws, request);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const send = (sessionId: string, raw: unknown) => {
    for (const [ws, id] of clients)
      if (id === sessionId && ws.readyState === WebSocket.OPEN)
        ws.send(typeof raw === "string" ? raw : JSON.stringify(raw));
  };
  const append = (
    sessionId: string,
    topic: string,
    payload: Record<string, unknown> = {},
    live = true,
  ) => {
    const history = events.get(sessionId) ?? [];
    const event: CommittedEvent = {
      id: randomUUID(),
      sequence: (history.at(-1)?.sequence ?? 0) + 1,
      timestamp: "2026-10-02T12:00:00.000Z",
      actor: "runtime",
      type: topic.split("/").at(-1) ?? "change",
      topic,
      payload: { ...payload, session_id: sessionId },
    };
    history.push(event);
    events.set(sessionId, history);
    if (live) send(sessionId, event);
    return event;
  };
  return {
    origin,
    token,
    sessions,
    state,
    requests,
    opens,
    events,
    send,
    append,
    active: (id?: string) =>
      [...clients.values()].filter((sessionId) => !id || id === sessionId)
        .length,
    intercept(next: typeof hook) {
      hook = next;
    },
    disconnect(id: string) {
      for (const [ws, sessionId] of clients)
        if (id === sessionId) ws.terminate();
    },
    async request(path: string) {
      const response = await fetch(origin + path, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok)
        throw new Error(`Runtime fixture HTTP ${response.status}`);
      return response.json() as Promise<unknown>;
    },
    async close() {
      for (const ws of clients.keys()) ws.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
