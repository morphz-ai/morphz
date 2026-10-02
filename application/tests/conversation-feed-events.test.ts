import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { ConversationFeed } from "../packages/application/src/conversation-feed.js";
import type {
  ConversationStream,
  StreamEvent,
} from "../packages/core/src/live-conversation.js";

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
async function wait(check: () => boolean) {
  const until = Date.now() + 7000;
  while (!check()) {
    if (Date.now() > until) throw new Error("feed event fixture timed out");
    await pause(10);
  }
}
const reply = (
  id: string,
  sequence: number,
  session = "owned",
): StreamEvent => ({
  id,
  sequence,
  timestamp: "2026-10-02T13:00:00.000Z",
  topic: "chat/reply",
  payload: { session_id: session, root_turn_id: "root", text: id },
});
async function fixture() {
  const server = createServer((_request, response) => response.end("{}"));
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    assert.equal(request.headers.authorization, "Bearer fixture-credential");
    assert.equal(
      new URL(request.url!, "http://localhost").searchParams.get("session_id"),
      "owned",
    );
    sockets.handleUpgrade(request, socket, head, (ws) =>
      sockets.emit("connection", ws),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const requests: string[] = [],
    accepted: string[] = [];
  let snapshot: ConversationStream = { connected: false, messages: [] };
  let sessions = ["owned"],
    authorized = true,
    failed = false;
  const durable: StreamEvent[] = [];
  let gate: (() => Promise<void>) | undefined;
  const feed = new ConversationFeed({
    sessions: () => sessions,
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    headers: () => ({ Authorization: "Bearer fixture-credential" }),
    request: async (path) => {
      requests.push(path);
      const events = [...durable];
      const pending = gate;
      gate = undefined;
      if (pending) await pending();
      return path.includes("/events") ? { events } : {};
    },
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
    onEvent: (_id, event) => accepted.push(event.id),
    changed: (value) => {
      snapshot = value;
    },
    failed: () => {
      failed = true;
    },
  });
  await wait(() => sockets.clients.size === 1 && snapshot.connected);
  return {
    feed,
    requests,
    accepted,
    durable,
    sockets,
    snapshot: () => snapshot,
    failed: () => failed,
    sessions: (value: string[]) => {
      sessions = value;
    },
    authorize: (value: boolean) => {
      authorized = value;
    },
    gate: (value: () => Promise<void>) => {
      gate = value;
    },
    async close() {
      feed.close();
      for (const ws of sockets.clients) ws.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("健康连接不再每1.2秒查history，WS变化直接呈现，变更hint按需修复", async () => {
  const f = await fixture();
  try {
    const initialReads = f.requests.filter((path) =>
      path.includes("/events"),
    ).length;
    for (const ws of f.sockets.clients)
      ws.send(JSON.stringify(reply("websocket-result", 1)));
    await wait(() =>
      f
        .snapshot()
        .messages.some((message) => message.text === "websocket-result"),
    );
    await pause(1400);
    assert.equal(
      f.requests.filter((path) => path.includes("/events")).length,
      initialReads,
    );
    f.durable.push(
      reply("hint-result", 2),
      reply("foreign-result", 3, "foreign"),
    );
    await f.feed.sync();
    await wait(() =>
      f.snapshot().messages.some((message) => message.text === "hint-result"),
    );
    assert.equal(
      f.requests.filter((path) => path.includes("/events")).length,
      initialReads + 1,
    );
    assert.ok(!f.accepted.includes("foreign-result"));
  } finally {
    await f.close();
  }
});

test("最后一次读取完成的微任务边界收到hint仍会再读，不丢尾部变更", async () => {
  const f = await fixture();
  try {
    await f.feed.sync();
    await Promise.resolve();
    // Keep real authorization/history/WS handling. Only control when the next
    // committed-change hint reaches the production single-flight drain.
    const controlled = f.feed as unknown as {
      synchronizeOnce(): Promise<void>;
    };
    const read = controlled.synchronizeOnce.bind(f.feed);
    let passes = 0;
    controlled.synchronizeOnce = async () => {
      await read();
      passes++;
      if (passes === 1)
        queueMicrotask(() =>
          queueMicrotask(() => {
            f.durable.push(reply("tail-commit", 1));
            void f.feed.sync();
          }),
        );
    };
    const initial = f.requests.filter((path) =>
      path.includes("/events"),
    ).length;
    await f.feed.sync();
    await wait(() =>
      f.snapshot().messages.some((message) => message.text === "tail-commit"),
    );
    assert.equal(passes, 2);
    assert.equal(
      f.requests.filter((path) => path.includes("/events")).length,
      initial + 2,
    );
    assert.ok(f.accepted.includes("tail-commit"));
  } finally {
    await f.close();
  }
});

test("读取期间的变更hint合并后再读一次，不漏晚到提交，也不并发扫描", async () => {
  const f = await fixture();
  try {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    f.gate(async () => {
      started = true;
      await held;
    });
    const before = f.requests.length;
    const first = f.feed.sync();
    await wait(() => started);
    f.durable.push(reply("late-result", 1));
    const second = f.feed.sync(),
      third = f.feed.sync();
    assert.equal(f.requests.length, before + 1);
    release();
    await Promise.all([first, second, third]);
    await wait(() =>
      f.snapshot().messages.some((message) => message.text === "late-result"),
    );
    assert.equal(f.requests.length, before + 2);
  } finally {
    await f.close();
  }
});

test("Session移除时丢弃在途历史与WS结果，后续不会重连旧Session", async () => {
  const f = await fixture();
  try {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    f.durable.push(reply("removed-result", 1));
    f.gate(async () => {
      started = true;
      await held;
    });
    const pending = f.feed.sync();
    await wait(() => started);
    f.sessions([]);
    for (const ws of f.sockets.clients)
      ws.send(JSON.stringify(reply("removed-websocket", 2)));
    const removed = f.feed.sync();
    release();
    await Promise.all([pending, removed]);
    await wait(() => f.sockets.clients.size === 0);
    assert.ok(!f.accepted.includes("removed-result"));
    assert.ok(!f.accepted.includes("removed-websocket"));
    const requests = f.requests.length;
    await pause(2100);
    assert.equal(f.requests.length, requests);
  } finally {
    await f.close();
  }
});

test("健康Feed在撤权hint后关闭，关闭后的在途请求不再发布", async () => {
  const f = await fixture();
  try {
    f.authorize(false);
    await f.feed.sync();
    await wait(() => f.failed() && f.sockets.clients.size === 0);
    const requests = f.requests.length;
    await f.feed.sync();
    assert.equal(f.requests.length, requests);
  } finally {
    await f.close();
  }
});
