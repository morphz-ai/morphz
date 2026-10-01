import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import { Application } from "../packages/application/src/application.js";
import { RuntimeBridge } from "../packages/application/src/runtime.js";
import {
  acceptedRuntimeInput,
  runtimeTimeline,
} from "./runtime-http-evidence.js";
import {
  discussionId,
  localAccess,
  type AccessContext,
  type Operation,
} from "../packages/core/src/model.js";

const input = (projectId: string, conversationId?: string): Operation => ({
  type: "record-input",
  projectId,
  ...(conversationId ? { conversationId } : {}),
  artifactId: null,
  artifactRevision: null,
  selection: "",
  body: "测试消息",
  targetActantId: "morphz-agent",
});

test("首条 Human 输入创建会话：校验失败不留空记录，精确重试不重复，不能改绑", async () => {
  const f = await platformRuntimeHostFixture();
  try {
    const id = randomUUID();
    const request = {
      commandId: randomUUID(),
      operation: {
        ...input(f.projectId, id),
        newConversation: { title: "对话 1" },
      },
    };
    const list = () =>
      f
        .session()
        .listPlatformConversations({ projectId: f.projectId, limit: 20 });
    const before = await list();
    const outboxBefore = structuredClone(f.store.runtimeState());
    await assert.rejects(
      f.session().platformMessage({
        ...request,
        operation: { ...request.operation, artifactId: "missing" },
      }),
    );
    assert.deepEqual(await list(), before);
    assert.deepEqual(f.store.runtimeState(), outboxBefore);
    await assert.rejects(
      f.session().platformMessage({
        ...request,
        operation: { ...request.operation, body: " " },
      }),
    );
    assert.deepEqual(await list(), before);
    assert.deepEqual(f.store.runtimeState(), outboxBefore);
    await assert.rejects(async () =>
      f
        .session({ principalId: "morphz-service", actantId: "morphz-agent" })
        .platformMessage(request),
    );
    assert.deepEqual(await list(), before);
    assert.deepEqual(f.store.runtimeState(), outboxBefore);
    const receipt = await f.session().platformMessage(request);
    assert.deepEqual(await f.session().platformMessage(request), receipt);
    const after = await list();
    assert.equal(after.length, before.length + 1);
    assert.equal(after.find((c) => c.id === id)!.title, "对话 1");
    const deliveries = () =>
      (
        f.store.runtimeState() as {
          deliveries: {
            inputId: string;
            platformSource: { projectId: string; conversationId: string };
          }[];
        }
      ).deliveries;
    assert.equal(deliveries().length, 1);
    assert.equal(deliveries()[0]!.inputId, receipt.entityId);
    assert.equal(discussionId(deliveries()[0]!.platformSource), id);
    const projectId = randomUUID();
    await f.session().createPlatformProject({
      commandId: randomUUID(),
      projectId,
      title: "另一个项目",
    });
    await assert.rejects(
      f.session().platformMessage({
        commandId: randomUUID(),
        operation: {
          ...input(projectId, id),
          newConversation: { title: "不能改绑" },
        },
      }),
      /不属于|已经被使用/,
    );
    await assert.rejects(
      f.session().platformMessage({
        commandId: randomUUID(),
        operation: {
          ...input(f.projectId, f.projectId),
          newConversation: { title: "不能占用默认" },
        },
      }),
      /独立/,
    );
    await assert.rejects(
      f.session().platformMessage({
        ...request,
        operation: { ...request.operation, body: "不能用相同标识提交不同消息" },
      }),
      /已用于另一条输入/,
    );
    await f.session().platformMessage({
      commandId: randomUUID(),
      operation: input(f.projectId, id),
    });
    assert.equal((await list()).length, after.length);
    assert.equal(deliveries().length, 2);
    assert.equal(
      (await f.session().listPlatformConversations({ projectId, limit: 20 }))
        .length,
      1,
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("项目默认和命名对话：真实身份权限、CAS、归档恢复与成员授权撤销", async () => {
  const alice = { principalId: "alice", actantId: "alice-human" };
  const f = await agentDomainFixture({ additionalHumans: [alice] });
  const runtime = new RuntimeBridge(
    f.transport,
    {
      namespace: randomUUID(),
      url: "http://127.0.0.1:1",
      token: "isolated-test",
      identityMode: "trusted_gateway",
    },
    f.identity,
    false,
  );
  await runtime.stop();
  const binding = f.domains.bindRuntime(runtime);
  const application = new Application(f.transport, {
    identity: f.identity,
    runtime,
    platformWork: f.domains.work,
    platformDocuments: f.domains.content,
  });
  const session = (access: AccessContext = localAccess) =>
    application.session(access);
  try {
    const p = f.projectId;
    assert.ok(
      (
        await session().listPlatformConversations({ projectId: p, limit: 20 })
      ).some((c) => c.id === p && c.projectId === p),
    );
    const c = randomUUID();
    const first = await session().platformMessage({
      commandId: randomUUID(),
      operation: { ...input(p, c), newConversation: { title: "设计讨论" } },
    });
    const firstDelivery = (
      f.transport.runtimeState() as {
        deliveries: {
          inputId: string;
          platformSource: { projectId: string; conversationId: string };
        }[];
      }
    ).deliveries.find((entry) => entry.inputId === first.entityId)!;
    assert.equal(discussionId(firstDelivery.platformSource), c);
    const foreign = randomUUID();
    await session().createPlatformProject({
      commandId: randomUUID(),
      projectId: foreign,
      title: "另一项目",
    });
    await assert.rejects(
      session().platformMessage({
        commandId: randomUUID(),
        operation: input(foreign, c),
      }),
      /不属于/,
    );
    const spaces = await session().ensurePlatformSpaces();
    await assert.rejects(
      session().platformMessage({
        commandId: randomUUID(),
        operation: {
          ...input(spaces.dialogueId, randomUUID()),
          newConversation: { title: "不可创建" },
        },
      }),
      /只能在项目内/,
    );
    await assert.rejects(async () =>
      session({
        principalId: "morphz-service",
        actantId: "morphz-agent",
      }).platformMessage({
        commandId: randomUUID(),
        operation: {
          ...input(p, randomUUID()),
          newConversation: { title: "不可创建" },
        },
      }),
    );
    const archive = {
      commandId: randomUUID(),
      conversationId: c,
      expectedRevision: 1,
      title: "设计与实现",
      archived: true,
    };
    await session().updatePlatformConversation(archive);
    assert.deepEqual(await session().updatePlatformConversation(archive), c);
    const archived = (
      await session().listPlatformConversations({
        projectId: p,
        limit: 20,
        archived: true,
      })
    ).find((row) => row.id === c)!;
    assert.ok(archived.archivedAt);
    await assert.rejects(
      session().platformMessage({
        commandId: randomUUID(),
        operation: input(p, c),
      }),
      /对话不可发送/,
    );
    await assert.rejects(
      session().updatePlatformConversation({
        commandId: randomUUID(),
        conversationId: c,
        expectedRevision: 1,
        title: "旧名称",
      }),
      { code: "conflict" },
    );
    await assert.rejects(
      session().updatePlatformConversation({
        commandId: randomUUID(),
        conversationId: p,
        expectedRevision: 1,
        archived: true,
      }),
      /默认对话/,
    );
    await session().updatePlatformConversation({
      commandId: randomUUID(),
      conversationId: c,
      expectedRevision: 2,
      archived: false,
    });
    await session().platformMessage({
      commandId: randomUUID(),
      operation: input(p, c),
    });
    await f.domains.content.platform.reconcileOperatorMembers(
      f.transport.identity(),
      [
        { ...localAccess, projectIds: [p, foreign], enabled: true },
        { ...alice, projectIds: [p], enabled: true },
      ],
    );
    assert.ok(
      (
        await session(alice).listPlatformConversations({
          projectId: p,
          limit: 20,
        })
      ).some((row) => row.id === c),
    );
    assert.ok(
      !(
        await session(alice).listAccessiblePlatformConversations({ limit: 20 })
      ).some((row) => row.id === spaces.dialogueId),
    );
    await assert.rejects(
      session(alice).platformMessage({
        commandId: randomUUID(),
        operation: input(spaces.dialogueId),
      }),
      { code: "forbidden" },
    );
    await f.domains.content.platform.reconcileOperatorMembers(
      f.transport.identity(),
      [
        { ...localAccess, projectIds: [p, foreign], enabled: true },
        { ...alice, projectIds: [], enabled: true },
      ],
    );
    assert.ok(
      !(
        await session(alice).listAccessiblePlatformConversations({ limit: 20 })
      ).some((row) => row.id === c),
    );
    await assert.rejects(
      session(alice).updatePlatformConversation({
        commandId: randomUUID(),
        conversationId: c,
        expectedRevision: 3,
        title: "无权更改",
      }),
      { code: "forbidden" },
    );
    const current = (
      await session().listPlatformConversations({ projectId: p, limit: 20 })
    ).find((row) => row.id === c)!;
    assert.equal(current.revision, 3);
    assert.equal(current.title, "设计与实现");
    assert.equal(current.archivedAt, null);
    f.assertNoLegacyData();
  } finally {
    await runtime.stop();
    await f.domains.unbindRuntime(binding.authority);
    await f.close();
  }
});

test("个人默认对话、精确输入请求和回执冷重启保持；创建项目不改写既有路由", async () => {
  const f = await platformRuntimeHostFixture();
  try {
    const spaces = await f.session().ensurePlatformSpaces();
    const request = {
      commandId: randomUUID(),
      operation: input(spaces.deskId, spaces.dialogueId),
    };
    const receipt = await f.session().platformMessage(request);
    const first = structuredClone(f.store.runtimeState()) as {
      deliveries: {
        inputId: string;
        platformSource: { projectId: string; conversationId: string };
      }[];
    };
    assert.equal(first.deliveries[0]!.platformSource.projectId, spaces.deskId);
    assert.equal(
      discussionId(first.deliveries[0]!.platformSource),
      spaces.dialogueId,
    );
    await f.session().createPlatformProject({
      commandId: randomUUID(),
      projectId: randomUUID(),
      title: "独立项目",
    });
    assert.deepEqual(await f.session().ensurePlatformSpaces(), spaces);
    assert.deepEqual(f.store.runtimeState(), first);
    await f.reopen();
    assert.deepEqual(await f.session().ensurePlatformSpaces(), spaces);
    assert.deepEqual(f.store.runtimeState(), first);
    assert.deepEqual(await f.session().platformMessage(request), receipt);
    assert.deepEqual(f.store.runtimeState(), first);
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("多对话使用不同 Session 与同一授权 Context；旧路由不变，归档后迟到回复与执行仍归原对话", async () => {
  const sessions = new Map<string, { id: string; context_id: string }>();
  const received: {
    id: string;
    session: string;
    event: ReturnType<typeof acceptedRuntimeInput>;
  }[] = [];
  const queried: string[] = [];
  let finish = false;
  const fake = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : null;
    const url = new URL(req.url!, "http://localhost"),
      path = url.pathname,
      id = path.split("/")[3]!;
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (path === "/api/status") return send(200, { model: "fixture" });
    if (path === "/api/session-io/capabilities")
      return send(200, { enabled: true, client_metadata: true });
    if (path === "/api/sessions" && req.method === "POST") {
      const s = { id: body.id, context_id: body.mount.context_id };
      sessions.set(s.id, s);
      return send(201, s);
    }
    if (path === "/api/approvals") return send(200, { approvals: [] });
    if (path === "/api/execution-jobs") {
      queried.push(url.searchParams.get("session_id")!);
      return send(200, { jobs: [] });
    }
    if (!sessions.has(id)) return send(404, {});
    if (path.endsWith("/principal"))
      return send(200, {
        principal_id: "fixture-principal",
        session_id: id,
        context_id: sessions.get(id)!.context_id,
      });
    if (path.endsWith("/messages")) {
      assert.equal(body.activation.dispatch_mode, "parallel");
      received.push({
        id: body.client_message_id,
        session: id,
        event: acceptedRuntimeInput(body, id, "root-" + body.client_message_id),
      });
      return send(200, {
        accepted: true,
        event_id: "root-" + body.client_message_id,
      });
    }
    const roots = received.filter((i) => i.session === id);
    const replies = finish
      ? roots.map((i, n) => ({
          id: "reply-" + i.id,
          sequence: n + 1,
          timestamp: i.event.timestamp,
          topic: "chat/reply",
          payload: { root_turn_id: i.event.id, text: "回复 " + i.id },
        }))
      : [];
    if (path.endsWith("/events"))
      return send(200, {
        events: replies.filter(
          (event) =>
            event.sequence > Number(url.searchParams.get("after_sequence")),
        ),
      });
    if (path.endsWith("/timeline"))
      return send(200, {
        entries: roots.flatMap((i) =>
          runtimeTimeline(
            i.event,
            replies.filter(
              (reply) => reply.payload.root_turn_id === i.event.id,
            ),
          ),
        ),
        next_before: null,
      });
    return send(200, sessions.get(id));
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const config = {
    namespace: randomUUID(),
    token: "fixture",
    url: `http://127.0.0.1:${(fake.address() as { port: number }).port}`,
  };
  const f = await platformRuntimeHostFixture(config);
  try {
    const c = randomUUID();
    const a = (
      await f.session().platformMessage({
        commandId: randomUUID(),
        operation: input(f.projectId),
      })
    ).entityId;
    const b = (
      await f.session().platformMessage({
        commandId: randomUUID(),
        operation: {
          ...input(f.projectId, c),
          newConversation: { title: "另一条工作线" },
        },
      })
    ).entityId;
    await f.enableDispatch();
    await f.runtime.tick();
    assert.equal(received.length, 2);
    const original = `mw-${config.namespace.slice(0, 8)}-${createHash("sha256")
      .update(JSON.stringify([f.projectId, null]))
      .digest("hex")
      .slice(0, 24)}`;
    assert.equal(received[0]!.session, original);
    assert.notEqual(received[1]!.session, original);
    assert.equal(
      new Set([...sessions.values()].map((value) => value.context_id)).size,
      1,
    );
    const scope = {
      projectId: f.projectId,
      artifactId: null,
      conversationId: c,
    };
    const viewer = await f.runtime.platformExecutionControls(
      scope,
      localAccess,
    );
    await viewer.snapshot();
    assert.deepEqual(queried, [received[1]!.session]);
    await f.session().updatePlatformConversation({
      commandId: randomUUID(),
      conversationId: c,
      expectedRevision: 1,
      archived: true,
    });
    await f.reopen(false);
    finish = true;
    await f.runtime.tick();
    assert.equal(received.length, 2);
    const originalHistory = await f.runtime.platformConversationHistory(
      { projectId: f.projectId, conversationId: f.projectId },
      localAccess,
    );
    const archivedHistory = await f.runtime.platformConversationHistory(
      { projectId: f.projectId, conversationId: c },
      localAccess,
    );
    assert.equal(
      originalHistory.runtime.messages.find((message) => message.inputId === a)
        ?.conversationId,
      f.projectId,
    );
    assert.equal(
      archivedHistory.runtime.messages.find((message) => message.inputId === b)
        ?.conversationId,
      c,
    );
    assert.equal(
      originalHistory.runtime.messages.some((message) => message.inputId === b),
      false,
    );
    assert.equal(
      archivedHistory.runtime.messages.some((message) => message.inputId === a),
      false,
    );
    assert.ok(
      (
        f.store.runtimeState() as { deliveries: { state: string }[] }
      ).deliveries.every((delivery) => delivery.state === "completed"),
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
    fake.closeAllConnections();
    await new Promise<void>((resolve) => fake.close(() => resolve()));
  }
});
