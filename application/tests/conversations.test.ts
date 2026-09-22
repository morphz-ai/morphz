import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { RuntimeBridge } from "../apps/service/src/runtime.js";
import { workspaceFor } from "../apps/service/src/identity.js";
import {
  discussionId,
  localAccess,
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
function commands(store: WorkspaceStore) {
  return (operation: Operation, actor = localAccess) =>
    store.execute({ commandId: randomUUID(), operation }, actor).entityId;
}

test("首条输入原子创建会话：校验失败不留空记录，重试不重复，不能越权改绑", () => {
  const store = new WorkspaceStore(":memory:");
  try {
    const id = randomUUID();
    const request = {
      commandId: randomUUID(),
      operation: {
        ...input("first-project", id),
        newConversation: { title: "对话 1" },
      },
    };
    const before = store.snapshot();
    assert.throws(() =>
      store.execute(
        {
          ...request,
          operation: { ...request.operation, artifactId: "missing" },
        },
        localAccess,
      ),
    );
    assert.deepEqual(store.snapshot(), before);
    assert.throws(() =>
      store.execute(
        { ...request, operation: { ...request.operation, body: " " } },
        localAccess,
      ),
    );
    assert.deepEqual(store.snapshot(), before);
    assert.throws(
      () =>
        store.execute(request, {
          principalId: "morphz-service",
          actantId: "morphz-agent",
        }),
      /项目成员/,
    );
    assert.deepEqual(store.snapshot(), before);
    const receipt = store.execute(request, localAccess);
    assert.deepEqual(store.execute(request, localAccess), receipt);
    const after = store.snapshot();
    assert.equal(after.conversations.length, before.conversations.length + 1);
    assert.equal(after.inputs.length, before.inputs.length + 1);
    assert.equal(after.inputs.at(-1)!.conversationId, id);
    assert.equal(after.conversations.find((c) => c.id === id)!.title, "对话 1");
    const project = commands(store)({
      type: "create-project",
      title: "另一个项目",
    });
    assert.throws(
      () =>
        commands(store)({
          ...input(project, id),
          newConversation: { title: "不能改绑" },
        } as Operation),
      /不属于/,
    );
    assert.throws(
      () =>
        commands(store)({
          ...input("first-project", "first-project"),
          newConversation: { title: "不能占用默认" },
        } as Operation),
      /独立/,
    );
    assert.throws(
      () =>
        store.execute(
          {
            ...request,
            operation: {
              ...request.operation,
              body: "不能用相同标识提交不同消息",
            },
          },
          localAccess,
        ),
      /另一项/,
    );
    commands(store)(input("first-project", id));
    assert.equal(
      store.snapshot().conversations.length,
      after.conversations.length + 1,
    ); // new project default only
  } finally {
    store.close();
  }
});

test("项目默认对话和多对话：权限、版本、归档恢复与后台接续", () => {
  const store = new WorkspaceStore(":memory:"),
    run = commands(store);
  try {
    const p = run({ type: "create-project", title: "对话测试项目" });
    assert.ok(
      store
        .snapshot()
        .conversations.some((c) => c.id === p && c.projectId === p),
    );
    const c = run({
      type: "create-conversation",
      projectId: p,
      title: "设计讨论",
    });
    const first = run(input(p, c));
    assert.equal(
      discussionId(store.snapshot().inputs.find((i) => i.id === first)!),
      c,
    );
    assert.throws(() => run(input("first-project", c)), /不属于/);
    assert.throws(
      () =>
        run({
          type: "create-conversation",
          projectId: "local-dialogue",
          title: "不可创建",
        }),
      /项目成员/,
    );
    assert.throws(
      () =>
        run(
          { type: "create-conversation", projectId: p, title: "不可创建" },
          { principalId: "morphz-service", actantId: "morphz-agent" },
        ),
      /项目成员/,
    );
    run({
      type: "update-conversation",
      conversationId: c,
      expectedRevision: 1,
      title: "设计与实现",
      archived: true,
    });
    assert.throws(() => run(input(p, c)), /归档/);
    assert.throws(
      () =>
        run({
          type: "update-conversation",
          conversationId: c,
          expectedRevision: 1,
          title: "旧名称",
        }),
      /变化/,
    );
    assert.throws(
      () =>
        run({
          type: "update-conversation",
          conversationId: p,
          expectedRevision: 1,
          archived: true,
        }),
      /默认对话/,
    );
    const continuation = run(input(p, c), {
      principalId: "morphz-service",
      actantId: "morphz-agent",
    });
    assert.equal(
      discussionId(store.snapshot().inputs.find((i) => i.id === continuation)!),
      c,
    );
    run({
      type: "update-conversation",
      conversationId: c,
      expectedRevision: 2,
      archived: false,
    });
    run(input(p, c));
    store.provisionMembers([
      {
        principalId: "alice",
        actantId: "alice-human",
        name: "Alice",
        projectIds: [p],
        enabled: true,
      },
    ]);
    const alice = { principalId: "alice", actantId: "alice-human" };
    assert.ok(
      workspaceFor(store.snapshot(), alice).conversations.some(
        (x) => x.id === c,
      ),
    );
    assert.ok(
      !workspaceFor(store.snapshot(), alice).conversations.some(
        (x) => x.id === "local-dialogue",
      ),
    );
    assert.throws(() => run(input("local-dialogue"), alice), /没有访问/);
    store.provisionMembers([
      {
        principalId: "alice",
        actantId: "alice-human",
        name: "Alice",
        projectIds: [],
        enabled: true,
      },
    ]);
    assert.ok(
      !workspaceFor(store.snapshot(), alice).conversations.some(
        (x) => x.id === c,
      ),
    );
    assert.throws(
      () =>
        run(
          {
            type: "update-conversation",
            conversationId: c,
            expectedRevision: 3,
            title: "无权更改",
          },
          alice,
        ),
      /没有访问/,
    );
  } finally {
    store.close();
  }
});

test("v11 升级不重写历史命令或 Runtime 账本；全局对话不随工作台保存转移", () => {
  const dir = mkdtempSync(join(tmpdir(), "mw-conversations-")),
    path = join(dir, "workspace.sqlite");
  let store = new WorkspaceStore(path);
  try {
    const request = {
      commandId: randomUUID(),
      operation: input("local-worktable"),
    };
    const receipt = store.execute(request, localAccess);
    const old = store.snapshot();
    const raw: any = { ...old };
    delete raw.conversations;
    raw.projects = raw.projects.filter((p: any) => p.kind !== "dialogue");
    raw.inputs.forEach((i: any) => delete i.conversationId);
    store.saveRuntimeState({ legacy: "preserve exactly" });
    store.close();
    const db = new DatabaseSync(path);
    db.prepare("UPDATE workspace SET body=?").run(JSON.stringify(raw));
    db.exec("PRAGMA user_version=11");
    db.close();
    store = new WorkspaceStore(path);
    assert.deepEqual(store.execute(request, localAccess), receipt);
    assert.deepEqual(store.snapshot().inputs, raw.inputs);
    assert.deepEqual(store.runtimeState(), { legacy: "preserve exactly" });
    const run = commands(store),
      global = store.snapshot().projects.find((p) => p.kind === "dialogue")!.id;
    run(input(global));
    run({
      type: "create-project",
      title: "独立项目",
    });
    assert.equal(
      store.snapshot().projects.find((p) => p.kind === "dialogue")!.id,
      global,
    );
    assert.equal(store.snapshot().inputs[0]!.projectId, "local-worktable");
    assert.equal(discussionId(store.snapshot().inputs[0]!), "local-worktable");
    assert.equal(store.snapshot().inputs[1]!.projectId, global);
    const before = store.snapshot();
    store.close();
    store = new WorkspaceStore(path);
    assert.deepEqual(store.snapshot(), before);
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});

test("多对话使用不同 Session 与同一授权 Context；旧路由不变，归档后迟到回复与执行仍归原对话", async () => {
  const store = new WorkspaceStore(":memory:"),
    run = commands(store);
  const sessions = new Map<string, { id: string; context_id: string }>();
  const received: { id: string; session: string }[] = [];
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
      received.push({ id: body.client_message_id, session: id });
      return send(200, {
        accepted: true,
        event_id: "root-" + body.client_message_id,
      });
    }
    if (path.endsWith("/events"))
      return send(200, {
        events:
          finish && !Number(url.searchParams.get("after_sequence"))
            ? received
                .filter((i) => i.session === id)
                .map((i, n) => ({
                  id: "reply-" + i.id,
                  sequence: n + 1,
                  timestamp: new Date().toISOString(),
                  topic: "chat/reply",
                  payload: {
                    root_turn_id: "root-" + i.id,
                    text: "回复 " + i.id,
                  },
                }))
            : [],
      });
    return send(200, sessions.get(id));
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const config = {
    namespace: randomUUID(),
    token: "fixture",
    url: `http://127.0.0.1:${(fake.address() as { port: number }).port}`,
  };
  let bridge = new RuntimeBridge(store, config);
  try {
    const c = run({
      type: "create-conversation",
      projectId: "first-project",
      title: "另一条工作线",
    });
    const a = run(input("first-project")),
      b = run(input("first-project", c));
    bridge.enqueue(a);
    bridge.enqueue(b);
    await bridge.tick();
    assert.equal(received.length, 2);
    const original = `mw-${config.namespace.slice(0, 8)}-${createHash("sha256")
      .update(JSON.stringify(["first-project", null]))
      .digest("hex")
      .slice(0, 24)}`;
    assert.equal(received[0]!.session, original);
    assert.notEqual(received[1]!.session, original);
    assert.equal(
      new Set([...sessions.values()].map((s) => s.context_id)).size,
      1,
    );
    await bridge.executions.snapshot({
      projectId: "first-project",
      artifactId: null,
      conversationId: c,
    });
    assert.deepEqual(queried, [received[1]!.session]);
    run({
      type: "update-conversation",
      conversationId: c,
      expectedRevision: 1,
      archived: true,
    });
    await bridge.stop();
    bridge = new RuntimeBridge(store, config);
    bridge.enqueue(a);
    bridge.enqueue(b);
    finish = true;
    await bridge.tick();
    assert.equal(received.length, 2);
    assert.equal(
      bridge.snapshot().messages.find((m) => m.inputId === a)?.conversationId,
      "first-project",
    );
    assert.equal(
      bridge.snapshot().messages.find((m) => m.inputId === b)?.conversationId,
      c,
    );
    assert.ok(
      bridge.snapshot().deliveries.every((d) => d.state === "completed"),
    );
  } finally {
    await bridge.stop();
    await new Promise<void>((resolve) => fake.close(() => resolve()));
    store.close();
  }
});
