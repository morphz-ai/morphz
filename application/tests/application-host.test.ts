import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:net";
import { Application } from "../packages/application/src/application.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { IdentityCenter } from "../packages/application/src/identity.js";
import { localAccess } from "../packages/core/src/model.js";
import type {
  ApplicationMethod,
  ApplicationReply,
} from "../packages/core/src/application-api.js";
import { createAppServer } from "../apps/service/src/http.js";

function value(reply: ApplicationReply): any {
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.ok ? reply.value : undefined;
}
function failure(reply: ApplicationReply, status: number) {
  assert.equal(reply.ok, false);
  if (!reply.ok) assert.equal(reply.error.status, status, reply.error.message);
}
const invoke = (
  host: LocalApplicationConnection,
  method: ApplicationMethod,
  params?: unknown,
  identityGeneration?: string,
) => host.invoke({ id: randomUUID(), method, params, identityGeneration });

test("共享业务层：本地调用与 Web HTTP 复用同一命令回执、修订与文件权限", async () => {
  assert.match(createAppServer.toString(), /new Application/);
  const store = new WorkspaceStore(":memory:");
  const host = new LocalApplicationConnection(new Application(store));
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const server = createAppServer(store, { port, webRoot: "/nonexistent" });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${port}`;
  try {
    const local = value(await invoke(host, "workspace"));
    const remote = await (await fetch(origin + "/api/workspace")).json();
    assert.deepEqual(local.workspace, remote.workspace);
    assert.equal(local.centerId, remote.centerId);
    const request = {
      commandId: randomUUID(),
      operation: {
        type: "create-artifact",
        projectId: "first-project",
        title: "共享业务验收",
        content: { kind: "document", markdown: "两个宿主，同一回执" },
      },
    };
    const receipt = value(
      await invoke(host, "command", request, local.csrfToken),
    );
    const post = (data: unknown) =>
      fetch(origin + "/api/commands", {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "X-Morphz-Token": remote.csrfToken,
        },
        body: JSON.stringify(data),
      });
    assert.deepEqual(await (await post(request)).json(), receipt);
    const artifact = value(
      await invoke(
        host,
        "artifact.read",
        { id: receipt.entityId },
        local.csrfToken,
      ),
    );
    assert.deepEqual(
      await (await fetch(origin + "/api/artifacts/" + receipt.entityId)).json(),
      artifact,
    );
    const stale = {
      commandId: randomUUID(),
      operation: {
        type: "revise-artifact",
        artifactId: receipt.entityId,
        expectedRevision: 99,
        title: "冲突",
        content: { kind: "document", markdown: "不应写入" },
      },
    };
    // Stale revisions receive identical conflict responses; neither host mutates state.
    const before = store.snapshot();
    failure(await invoke(host, "command", stale, local.csrfToken), 409);
    assert.equal((await post(stale)).status, 409);
    assert.deepEqual(store.snapshot(), before);
    const uploaded = value(
      await invoke(
        host,
        "asset.add",
        new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]),
        local.csrfToken,
      ),
    );
    assert.throws(
      () => host.resource("assets", uploaded.assetId),
      /文件不存在/,
    );
    assert.equal(
      (await fetch(origin + "/api/assets/" + uploaded.assetId)).status,
      404,
    );
    failure(
      await host.invoke({
        id: randomUUID(),
        method: "command",
        params: request,
        principalId: "forged",
        identityGeneration: local.csrfToken,
      }),
      400,
    );
    failure(
      await host.invoke({ id: randomUUID(), method: "sql", params: "DELETE" }),
      400,
    );
  } finally {
    host.close();
    server.closeStreams();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});

test("本地桥：身份由主进程持有，旧请求、越权读取、退出和撤销都失败", async () => {
  const store = new WorkspaceStore(":memory:");
  const other = { principalId: "other", actantId: "other-human" };
  store.provisionMembers([
    { ...other, name: "另一成员", projectIds: [], enabled: true },
  ]);
  const privateId = store.execute(
    {
      commandId: randomUUID(),
      operation: {
        type: "create-artifact",
        projectId: "first-project",
        title: "私有对象",
        content: { kind: "document", markdown: "不可泄露" },
      },
    },
    localAccess,
  ).entityId;
  const tokens = ["a".repeat(64), "b".repeat(64)];
  const config = {
    version: 1,
    members: [localAccess, other].map((access, i) => ({
      ...access,
      loginTokenHash: createHash("sha256").update(tokens[i]!).digest("hex"),
      enabled: true,
    })),
  };
  const identity = new IdentityCenter(store, config);
  const host = new LocalApplicationConnection(
    new Application(store, { identity }),
  );
  try {
    failure(await invoke(host, "workspace"), 401);
    value(await invoke(host, "login", { token: tokens[0] }));
    const first = value(await invoke(host, "workspace"));
    value(await invoke(host, "login", { token: tokens[1] }));
    const second = value(await invoke(host, "workspace"));
    assert.equal(second.principalId, other.principalId);
    assert.ok(!JSON.stringify(second).includes("不可泄露"));
    failure(
      await invoke(host, "artifact.read", { id: privateId }, first.csrfToken),
      403,
    );
    failure(
      await invoke(host, "artifact.read", { id: privateId }, second.csrfToken),
      403,
    );
    const restored = new LocalApplicationConnection(
      new Application(store, { identity }),
      host.authenticationCookie(),
    );
    assert.equal(
      value(await invoke(restored, "workspace")).principalId,
      other.principalId,
    );
    restored.close();
    identity.replaceConfiguration({
      ...config,
      members: config.members.map((m) => ({
        ...m,
        enabled: m.principalId !== other.principalId,
      })),
    });
    failure(await invoke(host, "workspace"), 401);
    value(await invoke(host, "login", { token: tokens[0] }));
    const next = value(await invoke(host, "workspace"));
    value(await invoke(host, "logout", undefined, next.csrfToken));
    failure(await invoke(host, "workspace"), 401);
  } finally {
    host.close();
    store.close();
  }
});

test("本地桥：取消传到提供方，迟到结果不返回，失效后关闭订阅且不写入", async () => {
  const store = new WorkspaceStore(":memory:");
  let release!: (s: string) => void;
  let providerSignal: AbortSignal | undefined;
  const speech = {
    provider: { id: "fixture", label: "Fixture" },
    configured: () => true,
    transcribe: async (
      _principal: string,
      _wav: Uint8Array,
      signal: AbortSignal,
    ) => {
      providerSignal = signal;
      return new Promise<string>((r) => {
        release = r;
      });
    },
    synthesize: async () => Buffer.from([]),
  };
  const host = new LocalApplicationConnection(
    new Application(store, { speech }),
  );
  try {
    const boot = value(await invoke(host, "workspace"));
    const id = randomUUID();
    const pending = host.invoke({
      id,
      method: "speech.transcribe",
      params: {
        scope: { projectId: "first-project" },
        data: new Uint8Array([0]),
      },
      identityGeneration: boot.csrfToken,
    });
    assert.ok(providerSignal);
    host.cancel(id);
    assert.ok(providerSignal.aborted);
    release("迟到文字");
    failure(await pending, 408);
    let closed = 0,
      events = 0;
    host.observe(
      randomUUID(),
      { projectId: "first-project", conversationId: "first-project" },
      boot.csrfToken,
      () => events++,
      () => closed++,
    );
    assert.equal(events, 1);
    host.invalidate();
    assert.equal(closed, 1);
    const before = store.snapshot();
    failure(
      await invoke(
        host,
        "command",
        {
          commandId: randomUUID(),
          operation: { type: "create-project", title: "不会保存" },
        },
        boot.csrfToken,
      ),
      403,
    );
    assert.deepEqual(store.snapshot(), before);
  } finally {
    host.close();
    store.close();
  }
});
