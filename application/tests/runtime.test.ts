import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import {
  settles,
  attributedDelivery,
  sessionDeliveryAttribution,
  terminalResultsByRoot,
} from "../apps/service/src/runtime.js";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";
import {
  acceptedRuntimeInput,
  runtimeTimeline,
} from "./runtime-http-evidence.js";
import { localAccess } from "../packages/core/src/model.js";

test("Runtime 真实 HTTP 协议：丢回执后幂等重试、版本固定、重启恢复与凭据隔离", async () => {
  const namespace = randomUUID(),
    token = "test-server-private-token";
  const sessions = new Map<
    string,
    {
      id: string;
      context_id: string;
      permission_mode?: string;
      sandbox_mode?: string | null;
    }
  >();
  const received = new Map<
    string,
    {
      text: string;
      object: { artifact_id: string; revision: number };
      root: string;
      sessionId: string;
      event: ReturnType<typeof acceptedRuntimeInput>;
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
    if (path === "/api/session-io/capabilities")
      return send(200, { enabled: true, client_metadata: true });
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
      assert.equal(
        body.activation.reasoning_effort,
        "high",
        "强度绑定到本次 activation，重试不丢失",
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
          event: acceptedRuntimeInput(
            body,
            id,
            "root-" + body.client_message_id,
          ),
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
    if (path.endsWith("/events") || path.endsWith("/timeline")) {
      const item = [...received.values()].find(
        (value) => value.sessionId === id,
      );
      const replies = item
        ? [
            {
              id: "reply-" + item.root,
              sequence: 2,
              timestamp: item.event.timestamp,
              topic: "chat/reply",
              payload: {
                session_id: id,
                root_turn_id: item.root,
                text: "真实接口返回的测试回复",
              },
            },
          ]
        : [];
      if (path.endsWith("/timeline"))
        return send(200, {
          entries: item ? runtimeTimeline(item.event, replies) : [],
          next_before: null,
        });
      const after = Number(
        new URL(request.url!, "http://localhost").searchParams.get(
          "after_sequence",
        ),
      );
      return send(200, {
        events: replies.filter((event) => event.sequence > after),
      });
    }
    if (request.method === "PATCH") {
      assert.equal(body.permission_mode, "request_approval");
      assert.deepEqual(body, { permission_mode: "request_approval" });
      Object.assign(sessions.get(id)!, {
        permission_mode: body.permission_mode,
        sandbox_mode: null,
      });
    }
    return send(sessions.has(id) ? 200 : 404, sessions.get(id) ?? {});
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const config = {
    url: `http://127.0.0.1:${(fake.address() as { port: number }).port}`,
    token,
    namespace,
  };
  const f = await platformRuntimeHostFixture(config);
  const scope = { projectId: f.projectId, conversationId: f.projectId };
  const history = () =>
    f.runtime.platformConversationHistory(scope, localAccess);
  try {
    const artifact = await f.session().createPlatformDocument({
      commandId: randomUUID(),
      projectId: f.projectId,
      objectId: randomUUID(),
      title: "对象",
      markdown: "版本一",
    });
    const command = {
      commandId: randomUUID(),
      operation: {
        type: "record-input" as const,
        projectId: f.projectId,
        artifactId: artifact.contentId,
        artifactRevision: 1,
        selection: "",
        body: "请解读",
        model: "other-model",
        reasoningEffort: "high",
        targetActantId: "morphz-agent",
      },
    };
    const input = await f.session().platformMessage(command);
    assert.deepEqual(await f.runtime.models(), {
      current: "test-model",
      reasoning: {
        current: null,
        levels: ["none", "low", "medium", "high", "max"],
      },
      options: [
        { id: "test-model", label: "当前模型" },
        { id: "other-model", label: "另一模型" },
      ],
    });
    await f.runtime.validateModel("other-model");
    await assert.rejects(() => f.runtime.validateModel("made-up-model"));
    await f.session().revisePlatformDocument({
      commandId: randomUUID(),
      contentId: artifact.contentId,
      expectedRevision: 1,
      title: "对象",
      markdown: "版本二",
    });
    await f.enableDispatch();
    await f.runtime.tick();
    const failed = await history();
    assert.equal(failed.runtime.deliveries[0]!.state, "failed");
    assert.equal(failed.runtime.deliveries[0]!.retryable, true);
    await f.reopen(false);
    assert.deepEqual(await f.session().platformMessage(command), input);
    assert.deepEqual(await f.session().platformMessage(command), input);
    await f.runtime.tick();
    assert.equal(received.size, 1);
    assert.equal(attempts, 2);
    assert.equal([...received.values()][0]!.text, "请解读");
    assert.deepEqual([...received.values()][0]!.object, {
      artifact_id: artifact.contentId,
      revision: 1,
    });
    const accepted = await history();
    assert.equal(accepted.runtime.deliveries[0]!.state, "completed");
    assert.equal(accepted.runtime.messages[0]!.text, "真实接口返回的测试回复");
    assert.equal(accepted.runtime.messages[0]!.sequence, 2);
    assert.equal(accepted.runtime.messages[0]!.inputId, input.entityId);
    assert.equal(
      accepted.runtime.messages[0]!.rootId,
      [...received.values()][0]!.root,
    );
    assert.ok(!JSON.stringify(accepted).includes(token));
    assert.ok(!JSON.stringify(accepted).includes("client_message_id"));
    await f.reopen(false);
    assert.deepEqual(await f.session().platformMessage(command), input);
    await f.runtime.tick();
    assert.equal(attempts, 2);
    assert.deepEqual(
      (await history()).runtime.messages,
      accepted.runtime.messages,
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
    fake.closeAllConnections();
    await new Promise<void>((resolve) => fake.close(() => resolve()));
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
  const runningRoots = new Set(["root-a", "root-b"]);
  for (const events of [
    [thread, second, combined],
    [combined, thread, second],
  ]) {
    const results = terminalResultsByRoot(events, runningRoots);
    assert.equal(results.get("root-a"), combined);
    assert.equal(results.get("root-b"), combined);
    for (const root of runningRoots)
      assert.equal(
        results.get(root),
        events.find((event) => settles(event, root, events)),
      );
  }
  let eventPasses = 0;
  const trackedEvents = new Proxy([thread, second, combined], {
    get(target, key, receiver) {
      if (key === Symbol.iterator) eventPasses++;
      return Reflect.get(target, key, receiver);
    },
  });
  terminalResultsByRoot(trackedEvents, runningRoots);
  assert.equal(eventPasses, 2, "并发投递不得逐条重扫整段事件");
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

test("批量历史归属与逐条因果规则一致，且不为每条消息重扫投递", () => {
  const timestamp = "2026-09-28T00:00:00.000Z";
  const event = (
    id: string,
    topic: string,
    payload: Record<string, unknown>,
  ) => ({
    id,
    sequence: Number(id.replace(/\D/g, "")) || 1,
    timestamp,
    topic,
    payload,
  });
  const events = [
    event("thread-1", "runtime/thread_result", {
      thread_id: "thread-a",
      root_turn_id: "root-a",
    }),
    event("thread-2", "runtime/thread_result", {
      thread_id: "thread-b",
      root_turn_id: "root-b",
    }),
    event("reply-1", "chat/reply", { root_turn_id: "root-a", text: "A" }),
    event("reply-2", "chat/reply", { covers: ["thread-a"], text: "A" }),
    event("reply-3", "chat/reply", {
      defer_covers: ["thread-b"],
      text: "B",
    }),
    event("reply-4", "chat/reply", {
      covers: ["thread-a", "thread-b"],
      text: "combined",
    }),
    event("reply-5", "chat/reply", {
      root_turn_id: "unknown",
      trigger_event_id: "root-b",
      covers: ["thread-a"],
      text: "B",
    }),
    event("reply-6", "chat/reply", {
      root_turn_id: "duplicate",
      text: "ambiguous",
    }),
    event("progress-1", "chat/progress", { covers: ["thread-a"] }),
  ];
  const deliveries = [
    { sessionId: "s", rootId: "root-a" },
    { sessionId: "s", rootId: "root-b" },
    { sessionId: "s", rootId: "duplicate" },
    { sessionId: "s", rootId: "duplicate" },
    { sessionId: "other", rootId: "root-a" },
  ];
  let deliveryScans = 0;
  const tracked = new Proxy(deliveries, {
    get(target, key, receiver) {
      if (key === Symbol.iterator) {
        deliveryScans++;
        return target[Symbol.iterator].bind(target);
      }
      return Reflect.get(target, key, receiver);
    },
  });
  const resolve = sessionDeliveryAttribution("s", tracked, events);
  for (const item of events)
    assert.equal(
      resolve(item),
      attributedDelivery("s", item, deliveries, events),
      `event ${item.id}`,
    );
  assert.equal(deliveryScans, 1);
});

test("按输入停止：排队不发送、并发 root 隔离、丢回执后重启确认", async () => {
  const sessions = new Map<string, string>();
  const permissionModes = new Map<string, string>();
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
    if (path === "/api/session-io/capabilities")
      return send(200, { enabled: true, client_metadata: true });
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
    if (req.method === "PATCH") {
      assert.deepEqual(body, { permission_mode: "request_approval" });
      permissionModes.set(sid, body.permission_mode);
    }
    return send(sessions.has(sid) ? 200 : 404, {
      id: sid,
      context_id: sessions.get(sid),
      permission_mode: permissionModes.get(sid) ?? null,
      sandbox_mode: null,
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  const config = {
    url: `http://127.0.0.1:${(fake.address() as { port: number }).port}`,
    token: "private-test",
    namespace: randomUUID(),
  };
  const f = await platformRuntimeHostFixture(config);
  const input = async (body: string) =>
    (
      await f.session().platformMessage({
        commandId: randomUUID(),
        operation: {
          type: "record-input",
          projectId: f.projectId,
          artifactId: null,
          artifactRevision: null,
          selection: "",
          body,
          targetActantId: "morphz-agent",
        },
      })
    ).entityId;
  const delivery = (id: string) =>
    (
      f.store.runtimeState() as {
        deliveries: {
          inputId: string;
          state: string;
          cancelRequested: boolean;
        }[];
      }
    ).deliveries.find((value) => value.inputId === id)!;
  try {
    const skipped = await input("skip");
    await f.session().cancelInput(skipped);
    await f.enableDispatch();
    await f.runtime.tick();
    assert.equal(roots.size, 0);
    await f.reopen();
    const a = await input("a"),
      b = await input("b");
    await f.enableDispatch();
    await f.runtime.tick();
    assert.equal(roots.size, 2);
    assert.equal(sessions.size, 1);
    await f.session().cancelInput(a);
    await f.runtime.stop();
    assert.equal(writes, 1);
    assert.equal(delivery(a).cancelRequested, true);
    await f.reopen(false);
    await f.runtime.tick();
    assert.equal(delivery(a).state, "cancelled");
    assert.equal(delivery(b).state, "running");
    assert.equal(writes, 1);
    f.assertNoLegacyData();
  } finally {
    await f.close();
    fake.closeAllConnections();
    await new Promise<void>((resolve) => fake.close(() => resolve()));
  }
});
