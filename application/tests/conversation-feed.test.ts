import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { ConversationFeed } from "../apps/service/src/conversation-feed.js";
import type { ConversationStream } from "../packages/core/src/live-conversation.js";

test("实时订阅使用服务端凭据、隔离 Session、修复断线且撤销即关闭", async () => {
  const server = createServer((_req, res) => res.end("{}"));
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    assert.equal(req.headers.authorization, "Bearer private-test-token");
    assert.equal(
      new URL(req.url!, "http://localhost").searchParams.get("session_id"),
      "owned",
    );
    assert.ok(!req.url!.includes("private-test-token"));
    sockets.handleUpgrade(req, socket, head, (ws) =>
      sockets.emit("connection", ws),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  let authorized = true,
    failed = false,
    count = 0;
  let snapshot: ConversationStream = { connected: false, messages: [] };
  const durable: unknown[] = [];
  const message = (session: string, stream: unknown) =>
    JSON.stringify({
      id: `event-${++count}`,
      timestamp: "2026-09-09T00:00:00Z",
      topic: "runtime/model_stream",
      payload: {
        session_id: session,
        attempt_id: "a",
        activation_id: "a",
        root_turn_id: "root",
        stream,
      },
    });
  let connections = 0;
  sockets.on("connection", (ws) => {
    connections++;
    ws.send(message("foreign", { kind: "started" }));
    ws.send(
      message("foreign", {
        kind: "text_delta",
        text: "secret foreign content",
      }),
    );
    if (connections === 1) ws.send(message("owned", { kind: "started" }));
    ws.send(
      message("owned", {
        kind: "text_delta",
        text: connections === 1 ? "partial" : "missing-prefix-suffix",
      }),
    );
  });
  const feed = new ConversationFeed({
    sessions: () => ["owned"],
    url: `http://127.0.0.1:${port}`,
    headers: () => ({ Authorization: "Bearer private-test-token" }),
    request: async (path) =>
      path.includes("/events") ? { events: durable } : {},
    authorize: () => {
      if (!authorized) throw new Error("revoked");
    },
    route: () => ({
      projectId: "p",
      conversationId: "c",
      artifactId: null,
      inputId: "input",
      rootId: "root",
    }),
    changed: (value) => {
      snapshot = value;
    },
    failed: () => {
      failed = true;
    },
  });
  const wait = async (check: () => boolean) => {
    const until = Date.now() + 7000;
    while (!check()) {
      if (Date.now() > until) throw new Error("feed timed out");
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  try {
    await wait(() => snapshot.messages.some((m) => m.text === "partial"));
    assert.ok(snapshot.connected);
    assert.ok(!JSON.stringify(snapshot).includes("secret"));
    assert.ok(!JSON.stringify(snapshot).includes("private-test-token"));
    for (const ws of sockets.clients) ws.terminate();
    await wait(() => !snapshot.connected);
    assert.equal(
      snapshot.messages.find((m) => m.text === "partial")?.streaming,
      false,
    );
    await wait(() => connections === 2 && snapshot.connected);
    assert.ok(
      !snapshot.messages.some((m) => m.text.includes("missing-prefix")),
    );
    durable.push({
      id: "final",
      sequence: 1,
      timestamp: "2026-09-09T00:00:01Z",
      topic: "chat/reply",
      payload: {
        session_id: "owned",
        attempt_id: "a",
        root_turn_id: "root",
        text: "durable final",
      },
    });
    await feed.sync();
    await wait(() => snapshot.messages.some((m) => m.text === "durable final"));
    authorized = false;
    await feed.sync();
    await wait(() => failed && sockets.clients.size === 0);
  } finally {
    feed.close();
    for (const ws of sockets.clients) ws.terminate();
    await new Promise<void>((r) => sockets.close(() => r()));
    await new Promise<void>((r) => server.close(() => r()));
  }
});
