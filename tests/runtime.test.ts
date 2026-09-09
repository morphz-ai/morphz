import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import {
  RuntimeBridge,
  settles,
  attributedDelivery,
} from "../apps/service/src/runtime.js";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { localAccess } from "../packages/core/src/model.js";

test("Runtime 真实 HTTP 协议：丢回执后幂等重试、版本固定、重启恢复与凭据隔离", async () => {
  const store = new WorkspaceStore(":memory:");
  const namespace = randomUUID(),
    token = "test-server-private-token";
  const sessions = new Map<string, { id: string; context_id: string }>();
  const received = new Map<
    string,
    {
      text: string;
      object: { artifact_id: string; revision: number };
      root: string;
      sessionId: string;
    }
  >();
  let attempts = 0;
  const fake = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : null;
    const path = new URL(request.url!, "http://localhost").pathname;
    response.setHeader("Content-Type", "application/json");
    const send = (status: number, data: unknown) => {
      response.writeHead(status);
      response.end(JSON.stringify(data));
    };
    if (path === "/api/status") return send(200, { model: "test-model" });
    if (path === "/api/runtime/inference")
      return send(200, {
        model: "test-model",
        models: ["test-model", "other-model"],
        model_options: [
          { id: "test-model", label: "当前模型" },
          { id: "other-model", label: "另一模型" },
        ],
      });
    if (path === "/api/sessions" && request.method === "POST") {
      if (!sessions.size && body.mount.type === "existing_context")
        return send(404, { error: "Context does not exist" });
      const session = { id: body.id, context_id: body.mount.context_id };
      sessions.set(body.id, session);
      return send(201, session);
    }
    const id = path.split("/")[3]!;
    if (path.endsWith("/principal"))
      return send(200, {
        principal_id: "test-principal",
        session_id: id,
        context_id: sessions.get(id)!.context_id,
      });
    if (path.endsWith("/messages")) {
      assert.equal(
        body.activation.model_alias,
        "other-model",
        "显式选择只绑定这条输入",
      );
      assert.ok(path.endsWith("/io/messages"));
      attempts++;
      const previous = received.get(body.client_message_id);
      if (!previous) {
        received.set(body.client_message_id, {
          text: body.message.content.value.text,
          object: body.message.content.value.object,
          root: "root-" + body.client_message_id,
          sessionId: id,
        });
        return send(500, {
          error: "Simulated lost acknowledgement after accept",
        });
      }
      assert.equal(body.message.content.value.text, previous.text);
      assert.deepEqual(body.message.content.value.object, previous.object);
      return send(200, {
        accepted: true,
        duplicate: true,
        event_id: previous.root,
      });
    }
    if (path.endsWith("/events")) {
      const item = [...received.values()].find(
        (value) => value.sessionId === id,
      )!;
      const after = Number(
        new URL(request.url!, "http://localhost").searchParams.get(
          "after_sequence",
        ),
      );
      return send(200, {
        events:
          after > 0
            ? []
            : [
                {
                  id: "reply-" + item.root,
                  sequence: 1,
                  timestamp: new Date().toISOString(),
                  topic: "chat/reply",
                  payload: {
                    session_id: id,
                    root_turn_id: item.root,
                    text: "真实接口返回的测试回复",
                  },
                },
              ],
      });
    }
    if (request.method === "PATCH") {
      assert.equal(body.permission_mode, "request_approval");
      assert.equal(body.sandbox_mode, "workspace-write");
    }
    return send(sessions.has(id) ? 200 : 404, sessions.get(id) ?? {});
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const config = {
    url: `http://127.0.0.1:${(fake.address() as { port: number }).port}`,
    token,
    namespace,
  };
  let bridge = new RuntimeBridge(store, config);
  try {
    const artifact = store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "create-artifact",
          projectId: "first-project",
          title: "对象",
          content: { kind: "document", markdown: "版本一" },
        },
      },
      localAccess,
    );
    const input = store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "record-input",
          projectId: "first-project",
          artifactId: artifact.entityId,
          artifactRevision: 1,
          selection: "",
          body: "请解读",
          model: "other-model",
          targetActantId: "morphz-agent",
        },
      },
      localAccess,
    );
    bridge.enqueue(input.entityId);
    assert.deepEqual(await bridge.models(), {
      current: "test-model",
      options: [
        { id: "test-model", label: "当前模型" },
        { id: "other-model", label: "另一模型" },
      ],
    });
    await bridge.validateModel("other-model");
    await assert.rejects(() => bridge.validateModel("made-up-model"));
    store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "revise-artifact",
          artifactId: artifact.entityId,
          expectedRevision: 1,
          title: "对象",
          content: { kind: "document", markdown: "版本二" },
        },
      },
      localAccess,
    );
    await bridge.tick();
    assert.equal(bridge.snapshot().deliveries[0]!.state, "failed");
    assert.equal(bridge.snapshot().deliveries[0]!.retryable, true);
    await bridge.stop();
    bridge = new RuntimeBridge(store, config);
    bridge.enqueue(input.entityId);
    bridge.enqueue(input.entityId);
    await bridge.tick();
    assert.equal(received.size, 1);
    assert.equal(attempts, 2);
    assert.equal([...received.values()][0]!.text, "请解读");
    assert.deepEqual([...received.values()][0]!.object, {
      artifact_id: artifact.entityId,
      revision: 1,
    });
    assert.equal(bridge.snapshot().deliveries[0]!.state, "completed");
    assert.equal(bridge.snapshot().messages[0]!.text, "真实接口返回的测试回复");
    assert.equal(bridge.snapshot().messages[0]!.inputId, input.entityId);
    assert.equal(
      bridge.snapshot().messages[0]!.rootId,
      [...received.values()][0]!.root,
    );
    assert.ok(!JSON.stringify(bridge.snapshot()).includes(token));
    assert.ok(!JSON.stringify(bridge.snapshot()).includes("client_message_id"));
    await bridge.stop();
    bridge = new RuntimeBridge(store, config);
    bridge.enqueue(input.entityId);
    await bridge.tick();
    assert.equal(attempts, 2);
    assert.equal(bridge.snapshot().messages.length, 1);
  } finally {
    await bridge.stop();
    await new Promise<void>((resolve) => fake.close(() => resolve()));
    store.close();
  }
});

test("并发回复通过因果 root 或 covers 对齐，不能拿另一条线程的回复结算", () => {
  const base = { sequence: 1, timestamp: new Date().toISOString() };
  const thread = {
    ...base,
    id: "thread",
    topic: "runtime/thread_result",
    payload: { thread_id: "thread-a", root_turn_id: "root-a" },
  };
  const reply = {
    ...base,
    id: "reply",
    topic: "chat/reply",
    payload: { root_turn_id: "delivery-root", covers: ["thread-a"] },
  };
  assert.equal(settles(reply, "root-a", [thread, reply]), true);
  assert.equal(settles(reply, "root-b", [thread, reply]), false);
  const second = {
    ...thread,
    id: "thread-b",
    payload: { thread_id: "thread-b", root_turn_id: "root-b" },
  };
  const combined = { ...reply, payload: { covers: ["thread-a", "thread-b"] } };
  const deliveries = [
    { sessionId: "s", rootId: "root-a" },
    { sessionId: "s", rootId: "root-b" },
  ];
  assert.equal(
    attributedDelivery("s", combined, deliveries, [thread, second, combined]),
    undefined,
  );
  const causal = {
    ...combined,
    payload: { ...combined.payload, root_turn_id: "root-b" },
  };
  assert.equal(
    attributedDelivery("s", causal, deliveries, [thread, second, causal])
      ?.rootId,
    "root-b",
  );
  assert.equal(
    attributedDelivery("other", causal, deliveries, [thread, second, causal]),
    undefined,
  );
});

test("按输入停止：排队不发送、并发 root 隔离、丢回执后重启确认", async () => {
  const store = new WorkspaceStore(":memory:");
  const sessions = new Map<string, string>();
  const roots = new Map<
    string,
    {
      thread_id: string;
      session_id: string;
      root_turn_id: string;
      revision: number;
      lifecycle: string;
    }
  >();
  let writes = 0;
  const fake = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : null;
    const path = new URL(req.url!, "http://localhost").pathname,
      sid = path.split("/")[3]!;
    const send = (code: number, value: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    assert.equal(req.headers.authorization, "Bearer private-test");
    assert.ok(!path.endsWith("/cancel"), "must never cancel an entire session");
    if (path === "/api/status") return send(200, { model: "fixture" });
    if (path === "/api/sessions") {
      sessions.set(body.id, body.mount.context_id);
      return send(201, { id: body.id, context_id: body.mount.context_id });
    }
    if (path.endsWith("/principal"))
      return send(200, {
        principal_id: "principal",
        session_id: sid,
        context_id: sessions.get(sid),
        capabilities: ["session_turn_control"],
      });
    if (path.endsWith("/messages")) {
      const root = "root-" + body.client_message_id;
      roots.set(root, {
        thread_id: "t-" + root,
        session_id: sid,
        root_turn_id: root,
        revision: 1,
        lifecycle: "open",
      });
      return send(200, { accepted: true, event_id: root });
    }
    if (path.endsWith("/thread")) {
      const entry = roots.get(path.split("/")[5]!)!;
      assert.equal(sid, entry.session_id);
      if (req.method === "POST") {
        writes++;
        assert.equal(body.expected_revision, entry.revision);
        entry.lifecycle = "cancelled";
        entry.revision++;
        return send(500, { error: "lost reply" });
      }
      return send(200, entry);
    }
    if (path.endsWith("/events")) return send(200, { events: [] });
    return send(sessions.has(sid) ? 200 : 404, {
      id: sid,
      context_id: sessions.get(sid),
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  const config = {
    url: `http://127.0.0.1:${(fake.address() as { port: number }).port}`,
    token: "private-test",
    namespace: randomUUID(),
  };
  let bridge = new RuntimeBridge(store, config);
  const input = (body: string) =>
    store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "record-input",
          projectId: "first-project",
          artifactId: null,
          artifactRevision: null,
          selection: "",
          body,
          targetActantId: "morphz-agent",
        },
      },
      localAccess,
    ).entityId;
  try {
    const skipped = input("skip");
    bridge.enqueue(skipped);
    bridge.cancelInput(skipped);
    await bridge.tick();
    assert.equal(roots.size, 0);
    const a = input("a"),
      b = input("b");
    bridge.enqueue(a);
    bridge.enqueue(b);
    await bridge.tick();
    assert.equal(roots.size, 2);
    assert.equal(sessions.size, 1);
    bridge.cancelInput(a);
    await bridge.stop();
    assert.equal(writes, 1);
    assert.equal(
      bridge.snapshot().deliveries.find((d) => d.inputId === a)
        ?.cancelRequested,
      true,
    );
    bridge = new RuntimeBridge(store, config);
    await bridge.tick();
    assert.equal(
      bridge.snapshot().deliveries.find((d) => d.inputId === a)?.state,
      "cancelled",
    );
    assert.equal(
      bridge.snapshot().deliveries.find((d) => d.inputId === b)?.state,
      "running",
    );
    assert.equal(writes, 1);
  } finally {
    await bridge.stop();
    await new Promise<void>((r) => fake.close(() => r()));
    store.close();
  }
});
