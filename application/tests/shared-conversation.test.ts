import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { RuntimeBridge } from "../packages/application/src/runtime.js";
import { Application } from "../packages/application/src/application.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import { resolveRuntimeInputEvidence } from "../packages/application/src/runtime-input-evidence.js";
import {
  runtimeAgentTools,
  type HostInvocation,
} from "../packages/application/src/agent-tools.js";
import { localAccess, type Command } from "../packages/core/src/model.js";
import { storedData } from "./platform-local-input-fixture.js";

test("Platform 持续会话：跨项目完整历史、真实执行根、独立 Session、审批失联和重启幂等", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-shared-session-"));
  const filename = join(directory, "transport.sqlite");
  const store = new WorkspaceStore(filename, { mode: "transport" });
  const domains = await openApplicationDomainsHost(directory, store);
  const projectB = "shared-session-project-b";
  const named = randomUUID();
  const isolated = randomUUID();
  let dialogueId = "";
  const commands = new Map<string, Command>();
  const sessions = new Map<string, { id: string; context_id: string }>();
  const received = new Map<
    string,
    { sessionId: string; root: string; text: string; request: unknown }
  >();
  const threadRoots = new Map<string, string>();
  const inferThreads = new Map<string, Record<string, unknown>>();
  let inferEvents: Record<string, unknown>[] = [];
  const exactEventReads: string[] = [];
  let schedulerDown = false;
  let approvalsDown = false;
  let approvalReads = 0;
  let pendingApprovals: unknown[] = [];
  const rootEvent = (inputId: string) => {
    const item = received.get(inputId)!;
    const request = item.request as {
      client_metadata: unknown;
      message: { content: { value: unknown } };
    };
    return {
      id: item.root,
      sequence: [...received.keys()].indexOf(inputId) + 1,
      timestamp: "2026-09-30T00:00:00Z",
      actor: "Session-Client",
      type: "session_message",
      topic: "chat/user_message",
      payload: {
        session_id: item.sessionId,
        context_id: sessions.get(item.sessionId)!.context_id,
        principal_id: "test-principal",
        client_message_id: inputId,
        session_io: {
          request: {
            ...request,
            client_metadata: storedData(request.client_metadata),
            message: {
              ...request.message,
              content: {
                ...request.message.content,
                value: storedData(request.message.content.value),
              },
            },
          },
        },
      },
    };
  };
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
    if (path === "/api/session-io/capabilities")
      return send(200, {
        enabled: true,
        client_metadata: true,
        formats: [
          { definition: { id: "morphz.application.input", version: "4" } },
        ],
      });
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
              kind: "execution",
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
          thread: inferThreads.get(threadId) ?? {
            id: threadId,
            session_id: item?.sessionId,
            context_id: item && sessions.get(item.sessionId)?.context_id,
            root_turn_id: root,
            initiating_principal_id: "test-principal",
            agent_id: "agent",
            executor_kind: "self",
            executor_id: null,
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
    if (path.includes("/messages/by-client-id/")) {
      const id = path.split("/").at(-1)!;
      return received.get(id)?.sessionId === sid
        ? send(200, { event: rootEvent(id) })
        : send(404, { error: "not found" });
    }
    if (path.endsWith("/messages") && req.method === "POST") {
      received.set(body.client_message_id, {
        sessionId: sid,
        root: "root-" + body.client_message_id,
        text: body.text,
        request: body,
      });
      return send(200, {
        accepted: true,
        event_id: "root-" + body.client_message_id,
      });
    }
    if (path.startsWith(`/api/sessions/${sid}/events/`)) {
      const eventId = path.split("/").at(-1)!;
      exactEventReads.push(eventId);
      const infer = inferEvents.find((event) => event.id === eventId);
      if (infer) return send(200, { event: infer });
      const input = [...received.entries()].find(
        ([, value]) => value.sessionId === sid && value.root === eventId,
      );
      if (!input) return send(404, { error: "not found" });
      return send(200, { event: rootEvent(input[0]) });
    }
    if (path.endsWith("/timeline")) {
      const entries = [...received]
        .filter(([, item]) => item.sessionId === sid)
        .map(([id, item]) => ({
          entry_id: id,
          visible_at: "2026-09-30T00:00:00Z",
          visible_at_micros: Date.parse("2026-09-30T00:00:00Z") * 1000,
          root_turn_id: item.root,
          attempt_id: null,
          display_kind: "input",
          final_event: false,
          event: rootEvent(id),
          root_event: null,
        }));
      return send(200, { entries, next_before: null });
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
  let binding = domains.bindRuntime(bridge);
  const session = () =>
    new Application(store, {
      runtime: bridge,
      platformWork: domains.work,
      platformDocuments: domains.content,
    }).session(localAccess);
  const navigation = async () =>
    (await session().platformRuntimeNavigation()).runtime;
  const input = async (
    projectId: string,
    conversationId = dialogueId,
    title?: string,
  ) => {
    const command: Command = {
      commandId: randomUUID(),
      operation: {
        type: "record-input",
        projectId,
        conversationId,
        ...(title ? { newConversation: { title } } : {}),
        artifactId: null,
        artifactRevision: null,
        selection: "",
        body: "创建文档",
        targetActantId: "morphz-agent",
      },
    };
    const { entityId: id } = await session().platformMessage(command);
    commands.set(id, command);
    return id;
  };
  const waitForInputs = async (...ids: string[]) => {
    const deadline = Date.now() + 5000;
    while (ids.some((id) => !received.has(id))) {
      assert.ok(Date.now() < deadline, "Runtime must accept each original input");
      await bridge.tick();
    }
  };
  try {
    dialogueId = (await session().ensurePlatformSpaces()).dialogueId;
    for (const [projectId, title] of [
      ["first-project", "第一个项目"],
      [projectB, "第二个项目"],
    ])
      await session().createPlatformProject({
        commandId: randomUUID(),
        projectId,
        title,
      });
    const old = await input("first-project", isolated, "独立讨论 A");
    await bridge.tick();
    const a = await input("first-project"),
      b = await input(projectB),
      c = await input(projectB, named, "独立讨论 B");
    await waitForInputs(old, a, b, c);
    assert.equal(received.get(a)!.sessionId, received.get(b)!.sessionId);
    assert.notEqual(received.get(a)!.sessionId, received.get(c)!.sessionId);
    assert.notEqual(received.get(a)!.sessionId, received.get(old)!.sessionId);
    const tools = runtimeAgentTools(bridge, "test", {
      authority: binding.authority,
      work: domains.work.service,
      content: domains.content,
    });
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
      const evidence = await resolveRuntimeInputEvidence(
        route,
        bridge.inputEvidenceReader(),
      );
      assert.equal(evidence.inputId, inputId);
      assert.equal(evidence.projectId, projectId);
      assert.ok(exactEventReads.includes(record.root));
      const result = (await tools.call({
        protocol: 1,
        tool: "host_morphz",
        invocation: route,
        arguments: {
          action: "create-document",
          title: "实际交付",
          markdown: "正文",
        },
      })) as { contentId: string };
      const content = await domains.work.authority.withSession(
        localAccess,
        () => {},
        (actor) => domains.content.platform.content(actor, result.contentId),
      );
      assert.equal(content.project_id, projectId);
      const original = await domains.work.authority.withSession(
        localAccess,
        () => {},
        (actor) =>
          domains.content.objects.readObject({
            credential: actor.credential,
            objectId: content.app_object_id,
          }),
      );
      assert.equal(original.title, "实际交付");
      assert.equal(original.author.actantId, "morphz-agent");
      await assert.rejects(
        async () => bridge.toolScope({ ...route, principal_id: "forged" }),
        /授权/,
      );
      const child = {
        id: "infer-child",
        session_id: route.session_id,
        context_id: route.context_id,
        root_turn_id: "infer-event",
        initiating_principal_id: route.principal_id,
        agent_id: route.agent_id,
        executor_kind: "plan_infer",
        executor_id: "plan-1",
      };
      inferThreads.set(child.id, child);
      const event = {
        id: "infer-event",
        sequence: 1,
        timestamp: new Date().toISOString(),
        actor: "Runtime-Yao",
        type: "infer_request",
        topic: "chat/infer_request",
        payload: {
          ...route,
          root_turn_id: child.root_turn_id,
          plan_execution_id: child.executor_id,
          parent_thread_id: threadId,
        },
      };
      inferEvents = [event];
      const childRoute = { ...route, thread_id: child.id };
      const childScope = await bridge.toolScope(childRoute);
      assert.ok(exactEventReads.includes("infer-event"));
      assert.equal(
        childScope.inputId,
        inputId,
        "Yao infer 工具继承真实原始输入而非捕获的 inputId",
      );
      assert.equal(childScope.projectId, projectId);
      for (const mutation of [
        { actor: "model" },
        { type: "chat" },
        { topic: "chat/message" },
        ...[
          "session_id",
          "context_id",
          "principal_id",
          "agent_id",
          "plan_execution_id",
          "root_turn_id",
        ].map((key) => ({
          payload: { ...event.payload, [key]: "forged" },
        })),
        { payload: { ...event.payload, parent_thread_id: child.id } },
      ]) {
        inferEvents = [{ ...event, ...mutation }];
        await assert.rejects(
          async () => bridge.toolScope(childRoute),
          /可验证|授权/,
        );
      }
      inferEvents = [event];
      inferThreads.set(child.id, { ...child, agent_id: "foreign-agent" });
      await assert.rejects(async () => bridge.toolScope(childRoute));
      inferThreads.set(child.id, child);
      const nested = {
        ...child,
        id: "infer-nested",
        root_turn_id: "nested-event",
        executor_id: "plan-2",
      };
      inferThreads.set(nested.id, nested);
      inferEvents.push({
        ...event,
        id: nested.root_turn_id,
        sequence: 2,
        payload: {
          ...event.payload,
          root_turn_id: nested.root_turn_id,
          plan_execution_id: nested.executor_id,
          parent_thread_id: child.id,
        },
      });
      assert.equal(
        (await bridge.toolScope({ ...route, thread_id: nested.id })).inputId,
        inputId,
      );
      inferEvents = [];
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
    assert.equal((await navigation()).activity?.threads[0]?.kind, "execution");
    const attention = (await navigation()).attention!;
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
      bridge.platformNavigationSnapshot(
        { principalId: "not-a-member", actantId: "test" },
        ["first-project", projectB],
      ).runtime.attention?.approvals,
      [],
    );
    approvalsDown = true;
    await bridge.tick();
    assert.equal((await navigation()).attention?.available, false);
    assert.equal(
      (await navigation()).attention?.approvals.length,
      2,
      "失联保留待核对记录，不返回假零审批",
    );
    approvalsDown = false;
    assert.equal((await navigation()).activity?.available, true);
    assert.deepEqual(
      new Set((await navigation()).activity?.threads.map((t) => t.projectId)),
      new Set(["first-project", projectB]),
    );
    schedulerDown = true;
    await bridge.tick();
    assert.equal((await navigation()).activity?.available, false);
    assert.equal(
      (await navigation()).activity?.threads.length,
      2,
      "失联保留分支但不得冒充最新状态",
    );
    schedulerDown = false;
    await bridge.stop();
    await domains.unbindRuntime(binding.authority);
    bridge = new RuntimeBridge(store, config);
    binding = domains.bindRuntime(bridge);
    assert.deepEqual(
      (await navigation()).attention,
      { available: false, approvals: [] },
      "重启不把缓存审批当作实时状态",
    );
    await session().platformMessage(commands.get(a)!);
    await bridge.tick();
    assert.equal(received.size, 4);
    assert.equal(
      (store.runtimeState() as { deliveries: unknown[] }).deliveries.length,
      4,
    );
    assert.ok(before);
    for (const projectId of ["first-project", projectB]) {
      const history = await session().platformConversationHistory({
        projectId,
        conversationId: dialogueId,
        limit: 100,
      });
      assert.deepEqual(
        new Set(history.inputs.map((entry) => entry.id)),
        new Set([a, b]),
        "共享默认历史不能按所选项目过滤",
      );
    }
    const namedHistory = await session().platformConversationHistory({
      projectId: projectB,
      conversationId: named,
      limit: 100,
    });
    assert.deepEqual(
      namedHistory.inputs.map((entry) => entry.id),
      [c],
    );
    const isolatedHistory = await session().platformConversationHistory({
      projectId: "first-project",
      conversationId: isolated,
      limit: 100,
    });
    assert.deepEqual(
      isolatedHistory.inputs.map((entry) => entry.id),
      [old],
    );
    const db = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.deepEqual(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workspace','commands','assets','artifact_outputs')",
          )
          .all(),
        [],
        "传输库不能保留旧业务表",
      );
    } finally {
      db.close();
    }
  } finally {
    await bridge.stop();
    await domains.unbindRuntime(binding.authority);
    await domains.close();
    fake.closeAllConnections();
    await new Promise<void>((r) => fake.close(() => r()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
