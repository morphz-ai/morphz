import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { RuntimeBridge } from "../apps/service/src/runtime.js";
import {
  AgentTools,
  type HostInvocation,
} from "../apps/service/src/agent-tools.js";
import {
  localAccess,
  inConversation,
  type Operation,
} from "../packages/core/src/model.js";

test("持续默认会话：跨项目输入共用 Session，工具按真实执行根落入各自项目，重启和旧投递保留", async () => {
  const store = new WorkspaceStore(":memory:");
  const run = (operation: Operation) =>
    store.execute({ commandId: randomUUID(), operation }, localAccess).entityId;
  const projectB = run({ type: "create-project", title: "第二个项目" });
  const named = run({
    type: "create-conversation",
    projectId: projectB,
    title: "独立讨论",
  });
  const sessions = new Map<string, { id: string; context_id: string }>();
  const received = new Map<
    string,
    { sessionId: string; root: string; text: string }
  >();
  const threadRoots = new Map<string, string>();
  let schedulerDown = false;
  let approvalsDown = false;
  let approvalReads = 0;
  let pendingApprovals: unknown[] = [];
  const fake = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : null;
    const url = new URL(req.url!, "http://localhost"),
      path = url.pathname;
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (path === "/api/status") return send(200, { model: "test" });
    if (path === "/api/sessions" && req.method === "POST") {
      sessions.set(body.id, { id: body.id, context_id: body.mount.context_id });
      return send(201, sessions.get(body.id));
    }
    const sid = path.split("/")[3]!;
    if (path.endsWith("/scheduler")) {
      if (schedulerDown) return send(503, {});
      return send(200, {
        threads: [...threadRoots].map(([id, root]) => {
          const item = [...received.values()].find((r) => r.root === root)!;
          return {
            phase: "running",
            intent: "后台分支",
            thread: {
              id,
              session_id: item.sessionId,
              context_id: sessions.get(item.sessionId)!.context_id,
              root_turn_id: root,
              lifecycle: "open",
              revision: 1,
              updated_at: "2026-09-09T00:00:00Z",
            },
          };
        }),
      });
    }
    if (path.includes("/threads/")) {
      const threadId = path.split("/").at(-1)!,
        root = threadRoots.get(threadId);
      const item = [...received.values()].find((r) => r.root === root);
      return send(200, {
        snapshot: {
          thread: {
            id: threadId,
            session_id: item?.sessionId,
            context_id: item && sessions.get(item.sessionId)?.context_id,
            root_turn_id: root,
            initiating_principal_id: "test-principal",
          },
        },
      });
    }
    if (path.endsWith("/principal"))
      return send(200, {
        principal_id: "test-principal",
        session_id: sid,
        context_id: sessions.get(sid)?.context_id,
        capabilities: ["session_turn_control"],
      });
    if (path.endsWith("/messages")) {
      received.set(body.client_message_id, {
        sessionId: sid,
        root: "root-" + body.client_message_id,
        text: body.text,
      });
      return send(200, {
        accepted: true,
        event_id: "root-" + body.client_message_id,
      });
    }
    if (path.endsWith("/events")) return send(200, { events: [] });
    if (path === "/api/approvals") {
      approvalReads++;
      return send(approvalsDown ? 503 : 200, { approvals: pendingApprovals });
    }
    return send(sessions.has(sid) ? 200 : 404, sessions.get(sid) ?? {});
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const config = {
    url: `http://127.0.0.1:${(fake.address() as { port: number }).port}`,
    token: "test",
    namespace: randomUUID(),
  };
  let bridge = new RuntimeBridge(store, config);
  const input = (projectId: string, conversationId = "local-dialogue") => {
    const id = run({
      type: "record-input",
      projectId,
      conversationId,
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body: "创建文档",
      targetActantId: "morphz-agent",
    });
    bridge.enqueue(id);
    return id;
  };
  try {
    const old = input("first-project", "first-project");
    await bridge.tick();
    const a = input("first-project"),
      b = input(projectB),
      c = input(projectB, named);
    await bridge.tick();
    assert.equal(received.get(a)!.sessionId, received.get(b)!.sessionId);
    assert.notEqual(received.get(a)!.sessionId, received.get(c)!.sessionId);
    assert.notEqual(received.get(a)!.sessionId, received.get(old)!.sessionId);
    const tools = new AgentTools(store, "test", (route) =>
      bridge.toolScope(route),
    );
    for (const [inputId, projectId] of [
      [a, "first-project"],
      [b, projectB],
    ]) {
      const record = received.get(inputId!)!,
        threadId = "thread-" + inputId;
      threadRoots.set(threadId, record.root);
      const route: HostInvocation = {
        job_id: "job-" + inputId,
        tool_call_id: "call-" + inputId,
        session_id: record.sessionId,
        context_id: sessions.get(record.sessionId)!.context_id,
        thread_id: threadId,
        principal_id: "test-principal",
        agent_id: "agent",
        target_id: "local",
      };
      const result = (await tools.call({
        protocol: 1,
        tool: "host_morphz_work",
        invocation: route,
        arguments: {
          action: "create-document",
          title: "实际交付",
          markdown: "正文",
        },
      })) as { artifactId: string };
      const artifact = store
        .snapshot()
        .artifacts.find((x) => x.id === result.artifactId)!;
      assert.equal(artifact.projectId, projectId);
      assert.equal(artifact.originConversationId, "local-dialogue");
      await assert.rejects(
        async () => bridge.toolScope({ ...route, principal_id: "forged" }),
        /授权/,
      );
    }
    const before = store.runtimeState();
    const pending = (inputId: string) => ({
      requested_at: "2026-09-09T00:00:00Z",
      request: {
        approval_id: "approval-" + inputId,
        session_id: received.get(inputId)!.sessionId,
        context_id: sessions.get(received.get(inputId)!.sessionId)!.context_id,
        thread_id: "thread-" + inputId,
        root_turn_id: received.get(inputId)!.root,
        justification: "读取测试目录",
        action: {
          kind: "tool_operation",
          tool: "read",
          operation: "read",
          target: "/fixture",
        },
        requested: { read_roots: ["/fixture"], network: false },
      },
    });
    pendingApprovals = [
      pending(a),
      pending(b),
      {
        ...pending(a),
        request: {
          ...pending(a).request,
          approval_id: "unattributed",
          root_turn_id: "unknown-root",
          thread_id: "unknown-thread",
        },
      },
      {
        ...pending(a),
        request: {
          ...pending(a).request,
          approval_id: "foreign-context",
          context_id: "foreign",
        },
      },
      {
        ...pending(a),
        request: {
          ...pending(a).request,
          approval_id: "inconsistent-root",
          root_turn_id: received.get(b)!.root,
        },
      },
    ];
    const reads = approvalReads;
    await bridge.tick();
    assert.equal(
      approvalReads - reads,
      1,
      "全局摘要只读取一次审批，不按消息展开工具历史",
    );
    const attention = bridge.snapshot().attention!;
    assert.equal(attention.available, true);
    assert.deepEqual(
      attention.approvals.map((entry) => [
        entry.scope.projectId,
        entry.scope.inputId,
      ]),
      [
        ["first-project", a],
        [projectB, b],
      ],
    );
    assert.ok(
      attention.approvals.every((entry) =>
        /^[a-f0-9]{64}$/.test(entry.approval.fingerprint),
      ),
    );
    assert.deepEqual(
      bridge.snapshot({ principalId: "not-a-member", actantId: "test" })
        .attention?.approvals,
      [],
    );
    approvalsDown = true;
    await bridge.tick();
    assert.equal(bridge.snapshot().attention?.available, false);
    assert.equal(
      bridge.snapshot().attention?.approvals.length,
      2,
      "失联保留待核对记录，不返回假零审批",
    );
    approvalsDown = false;
    assert.equal(bridge.snapshot().activity?.available, true);
    assert.deepEqual(
      new Set(bridge.snapshot().activity?.threads.map((t) => t.projectId)),
      new Set(["first-project", projectB]),
    );
    schedulerDown = true;
    await bridge.tick();
    assert.equal(bridge.snapshot().activity?.available, false);
    assert.equal(
      bridge.snapshot().activity?.threads.length,
      2,
      "失联保留分支但不得冒充最新状态",
    );
    schedulerDown = false;
    await bridge.stop();
    bridge = new RuntimeBridge(store, config);
    assert.deepEqual(
      bridge.snapshot().attention,
      { available: false, approvals: [] },
      "重启不把缓存审批当作实时状态",
    );
    bridge.enqueue(a);
    await bridge.tick();
    assert.equal(received.size, 4);
    assert.equal(bridge.snapshot().deliveries.length, 4);
    assert.ok(before);
    assert.ok(
      inConversation(
        store.snapshot(),
        "local-dialogue",
        { projectId: "first-project" },
        true,
      ),
    );
    assert.ok(
      !inConversation(
        store.snapshot(),
        "local-dialogue",
        { projectId: projectB, conversationId: named },
        true,
      ),
    );
  } finally {
    await bridge.stop();
    fake.closeAllConnections();
    await new Promise<void>((r) => fake.close(() => r()));
    store.close();
  }
});
