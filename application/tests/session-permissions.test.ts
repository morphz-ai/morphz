import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { createAppServer } from "../apps/service/src/http.js";
import { createServer as createProbe } from "node:net";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";
import {
  localAccess,
  morphzAgentAccess,
  DomainError,
} from "../packages/core/src/model.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";
import {
  sessionPermissionsSnapshotSchema,
  sessionPermissionsUpdateSchema,
} from "../packages/core/src/session-permissions.js";

type Policy = {
  id: string;
  context_id: string;
  permission_mode: string | null;
  sandbox_mode: string | null;
  default_target_id?: string | null;
};
type Internals = {
  stopped: boolean;
  config: { identityMode?: "trusted_gateway" };
  identity?: { allows: () => boolean };
  state: {
    sessions: Record<string, any>;
    deliveries: any[];
    namespace: string;
  };
  runtimeFetch(url: string, init: RequestInit): Promise<Response>;
  ensureSession(id: string): Promise<void>;
};
async function fixture() {
  const f = await platformRuntimeHostFixture();
  const internal = f.runtime as unknown as Internals;
  const policies = new Map<string, Policy>();
  const calls: { path: string; method: string; body: any }[] = [];
  const acceptedInputModes: string[] = [];
  let patchFailure = false,
    ignorePatch = false,
    lostCreation = false,
    creationConflict = false;
  let conflictPreset: string | null = null;
  let principal = "isolated-principal";
  let afterPatch: (() => void) | undefined;
  let defaults = {
    permission_mode: "full_access",
    sandbox_mode: "danger-full-access",
    reviewer: "deny",
  };
  const attach = () => {
    (f.runtime as unknown as Internals).runtimeFetch = async (url, init) => {
      const path = new URL(url).pathname;
      const method = init.method ?? "GET";
      const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ path, method, body });
      const reply = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      if (path === "/api/status")
        return reply({ model: "isolated-model", ...defaults });
      if (path === "/api/runtime/inference")
        return reply({ model: "isolated-model", models: ["isolated-model"] });
      if (path === "/api/session-io/capabilities")
        return reply({ enabled: true, client_metadata: true });
      if (path === "/api/approvals") return reply({ approvals: [] });
      if (path === "/api/sessions" && method === "POST") {
        const record = {
          id: body.id,
          context_id: body.mount.context_id,
          permission_mode: creationConflict ? conflictPreset : null,
          sandbox_mode: null,
        };
        policies.set(body.id, record);
        if (lostCreation) {
          lostCreation = false;
          throw new Error("lost creation response");
        }
        if (creationConflict) return reply({}, 409);
        return reply(record, 201);
      }
      const id = path.split("/")[3]!;
      const record = policies.get(id);
      if (!record) return reply({}, 404);
      if (path.endsWith("/io/messages") && method === "POST") {
        assert.ok(
          record.permission_mode,
          "never accept an input before safe initialization or explicit Runtime choice",
        );
        acceptedInputModes.push(record.permission_mode);
        return reply({
          accepted: true,
          event_id: "root-" + body.client_message_id,
        });
      }
      if (path.endsWith("/events")) return reply({ events: [] });
      if (path.endsWith("/timeline"))
        return reply({ entries: [], next_before: null });
      if (path.endsWith("/principal"))
        return reply({
          session_id: id,
          context_id: record.context_id,
          principal_id: principal,
          capabilities: [],
        });
      if (path.endsWith("/execution-targets"))
        return reply({
          session_id: id,
          effective_target_id: "effective-edge",
          ready: true,
          reason: "ready",
          targets: [
            {
              id: "not-selected",
              name: "其他节点",
              workspace_root: "/wrong-directory",
            },
            {
              id: "effective-edge",
              name: "当前执行节点",
              workspace_root: "/actual-agent-workspace",
            },
          ],
        });
      if (method === "PATCH") {
        assert.deepEqual(
          Object.keys(body),
          ["permission_mode"],
          "must not combine a legacy sandbox override",
        );
        if (patchFailure) return reply({}, 503);
        if (!ignorePatch) {
          record.permission_mode = body.permission_mode;
          record.sandbox_mode = null;
        }
        afterPatch?.();
      }
      return reply(record);
    };
  };
  attach();
  const { dialogueId } = await f.session().ensurePlatformSpaces();
  const globalScope = { projectId: f.projectId, conversationId: dialogueId };
  const projectScope = { projectId: f.projectId, conversationId: f.projectId };
  const read = (scope = globalScope) =>
    f.session().readSessionPermissions(scope);
  const seed = async (
    mode: string | null = "request_approval",
    scope = globalScope,
  ) => {
    await read(scope);
    const id = calls
      .filter((call) => /^\/api\/sessions\/[^/]+$/.test(call.path))
      .at(-1)!
      .path.split("/")[3]!;
    const record: Policy = {
      id,
      context_id: `mw-context-${internal.state.namespace}`,
      permission_mode: mode,
      sandbox_mode: null,
    };
    policies.set(id, record);
    return record;
  };
  const queue = async (scope = globalScope) => {
    await f.session().platformMessage({
      commandId: randomUUID(),
      operation: {
        type: "record-input",
        ...scope,
        artifactId: null,
        artifactRevision: null,
        selection: "",
        body: "TEST 会话审批",
        targetActantId: "morphz-agent",
      },
    });
    return (f.runtime as unknown as Internals).state.deliveries.at(-1)!
      .sessionId as string;
  };
  return {
    f,
    calls,
    policies,
    acceptedInputModes,
    globalScope,
    projectScope,
    seed,
    read,
    queue,
    attach,
    get internal() {
      return f.runtime as unknown as Internals;
    },
    set patchFailure(value: boolean) {
      patchFailure = value;
    },
    set ignorePatch(value: boolean) {
      ignorePatch = value;
    },
    set lostCreation(value: boolean) {
      lostCreation = value;
    },
    set creationConflict(value: boolean) {
      creationConflict = value;
    },
    set conflictPreset(value: string | null) {
      conflictPreset = value;
    },
    set principal(value: string) {
      principal = value;
    },
    set afterPatch(value: (() => void) | undefined) {
      afterPatch = value;
    },
    set defaults(value: typeof defaults) {
      defaults = value;
    },
  };
}
const denied = (error: unknown) =>
  error instanceof DomainError && error.code === "forbidden";
const conflicted = (error: unknown) =>
  error instanceof DomainError && error.code === "conflict";

test("读取未开始会话只给安全默认，不创建Host binding、Platform会话、Runtime Session或输入", async () => {
  const t = await fixture();
  try {
    const before = structuredClone(t.f.store.runtimeState());
    const result = sessionPermissionsSnapshotSchema.parse(await t.read());
    assert.equal(result.permissionMode, "request_approval");
    assert.equal(result.source, "safe_default");
    assert.equal(result.canUpdate, false);
    assert.equal(result.readOnlyReason, "not_started");
    assert.equal(result.runtimeSessionId, null);
    assert.equal(result.fingerprint, null);
    assert.deepEqual(t.f.store.runtimeState(), before);
    assert.ok(t.calls.every((call) => call.method === "GET"));
    await assert.rejects(
      t.f.session().updateSessionPermissions({
        ...t.globalScope,
        permissionMode: "auto_review",
        expectedFingerprint: "a".repeat(64),
      }),
      conflicted,
    );
    assert.ok(t.calls.every((call) => call.method === "GET"));
    await assert.rejects(
      t.read({
        projectId: "foreign-project",
        conversationId: "foreign-conversation",
      }),
    );
  } finally {
    await t.f.close();
  }
});

test("审批按canonical全局Session跨项目共享；项目会话独立；默认目录读实际有效执行节点", async () => {
  const t = await fixture();
  try {
    const record = await t.seed("auto_review");
    const value = await t.read();
    assert.equal(value.scope.kind, "global");
    assert.equal(value.runtimeSessionId, record.id);
    assert.equal(value.permissionMode, "auto_review");
    assert.equal(value.reviewer, "auto_review");
    assert.deepEqual(value.workspace, {
      targetId: "effective-edge",
      targetName: "当前执行节点",
      workspaceRoot: "/actual-agent-workspace",
      ready: true,
      reason: null,
    });
    await t.f.session().createPlatformProject({
      commandId: randomUUID(),
      projectId: "second-project",
      title: "TEST 另一个项目",
    });
    assert.equal(
      (
        await t.read({
          projectId: "second-project",
          conversationId: t.globalScope.conversationId,
        })
      ).runtimeSessionId,
      record.id,
    );
    const project = await t.seed("request_approval", t.projectScope);
    assert.notEqual(project.id, record.id);
    assert.equal((await t.read(t.projectScope)).scope.kind, "conversation");
  } finally {
    await t.f.close();
  }
});

test("Human明确切换审批只PATCH原Session策略并真实读回；完全访问必须显式确认", async () => {
  const t = await fixture();
  try {
    const record = await t.seed();
    record.sandbox_mode = "workspace-write";
    const before = await t.read();
    assert.equal(
      sessionPermissionsUpdateSchema.safeParse({
        ...t.globalScope,
        permissionMode: "full_access",
        expectedFingerprint: before.fingerprint,
      }).success,
      false,
    );
    const result = await t.f.session().updateSessionPermissions({
      ...t.globalScope,
      permissionMode: "full_access",
      expectedFingerprint: before.fingerprint,
      confirmation: true,
    });
    assert.equal(result.permissionMode, "full_access");
    assert.equal(result.sandboxMode, "danger-full-access");
    assert.equal(result.reviewer, "deny");
    assert.equal(record.sandbox_mode, null);
    assert.ok(
      t.calls
        .filter((call) => call.method !== "GET")
        .every(
          (call) =>
            call.method === "PATCH" &&
            call.path === `/api/sessions/${record.id}`,
        ),
    );
    assert.equal(t.internal.state.deliveries.length, 0);
    assert.equal(Object.keys(t.internal.state.sessions).length, 0);
    const again = await t.read();
    assert.equal(again.fingerprint, result.fingerprint);
  } finally {
    await t.f.close();
  }
});

test("错误scope、Agent自扩权、团队写和撤销身份全部拒绝，不发PATCH", async () => {
  const t = await fixture();
  try {
    const record = await t.seed();
    const before = await t.read();
    const request = {
      ...t.globalScope,
      permissionMode: "auto_review",
      expectedFingerprint: before.fingerprint,
    };
    await assert.rejects(
      t.f.session(morphzAgentAccess).updateSessionPermissions(request),
      denied,
    );
    await assert.rejects(
      t.f
        .session({ principalId: "foreign", actantId: "foreign-human" })
        .updateSessionPermissions(request),
      denied,
    );
    await assert.rejects(
      t.f
        .session()
        .updateSessionPermissions({ ...request, projectId: "foreign-project" }),
    );
    t.internal.config.identityMode = "trusted_gateway";
    t.internal.identity = { allows: () => true };
    record.context_id +=
      "-" +
      createHash("sha256")
        .update(t.globalScope.conversationId)
        .digest("hex")
        .slice(0, 24);
    const team = await t.read();
    assert.equal(team.canUpdate, false);
    assert.equal(team.readOnlyReason, "team_managed");
    assert.ok(
      !t.calls.some((call) => call.path === "/api/status"),
      "explicit team preset does not borrow operator status",
    );
    await assert.rejects(
      t.f.session().updateSessionPermissions(request),
      denied,
    );
    delete t.internal.config.identityMode;
    await assert.rejects(
      t.f.application
        .session(localAccess, () => {
          throw new DomainError("forbidden", "identity revoked");
        })
        .updateSessionPermissions(request),
      denied,
    );
    assert.ok(t.calls.every((call) => call.method === "GET"));
  } finally {
    delete t.internal.config.identityMode;
    await t.f.close();
  }
});

test("旧读回指纹、PATCH失败、不匹配读回或写后权限撤销不报告成功", async () => {
  const t = await fixture();
  try {
    const record = await t.seed();
    const before = await t.read();
    const request = {
      ...t.globalScope,
      permissionMode: "auto_review",
      expectedFingerprint: before.fingerprint,
    };
    record.permission_mode = "full_access";
    await assert.rejects(
      t.f.session().updateSessionPermissions(request),
      conflicted,
    );
    assert.equal(t.calls.filter((call) => call.method === "PATCH").length, 0);
    record.permission_mode = "request_approval";
    t.patchFailure = true;
    await assert.rejects(t.f.session().updateSessionPermissions(request));
    t.patchFailure = false;
    t.ignorePatch = true;
    await assert.rejects(
      t.f.session().updateSessionPermissions(request),
      conflicted,
    );
    t.ignorePatch = false;
    let active = true;
    t.afterPatch = () => {
      active = false;
    };
    await assert.rejects(
      t.f.application
        .session(localAccess, () => {
          if (!active) throw new DomainError("forbidden", "identity revoked");
        })
        .updateSessionPermissions(request),
      denied,
    );
  } finally {
    await t.f.close();
  }
});

test("同Host同Session串行核对旧读回，不能两个旧指纹写入均成功", async () => {
  const t = await fixture();
  try {
    await t.seed();
    const before = await t.read();
    const results = await Promise.allSettled([
      t.f.session().updateSessionPermissions({
        ...t.globalScope,
        permissionMode: "auto_review",
        expectedFingerprint: before.fingerprint,
      }),
      t.f.session().updateSessionPermissions({
        ...t.globalScope,
        permissionMode: "full_access",
        expectedFingerprint: before.fingerprint,
        confirmation: true,
      }),
    ]);
    assert.equal(
      results.filter((item) => item.status === "fulfilled").length,
      1,
    );
    assert.equal(t.calls.filter((call) => call.method === "PATCH").length, 1);
  } finally {
    await t.f.close();
  }
});

for (const mode of ["auto_review", "full_access"])
  test(`已存在${mode}会话再次发送前ensure不会重置策略`, async () => {
    const t = await fixture();
    try {
      const record = await t.seed(mode);
      const id = await t.queue();
      assert.equal(id, record.id);
      await t.internal.ensureSession(id);
      await t.internal.ensureSession(id);
      assert.equal(record.permission_mode, mode);
      assert.ok(!t.calls.some((call) => call.method === "PATCH"));
    } finally {
      await t.f.close();
    }
  });

for (const failure of ["lost-create", "failed-patch", "wrong-readback"])
  test(`首建${failure}持久安全回执跨Host重启，重试不继承full access`, async () => {
    const t = await fixture();
    try {
      const id = await t.queue();
      if (failure === "lost-create") t.lostCreation = true;
      if (failure === "failed-patch") t.patchFailure = true;
      if (failure === "wrong-readback") t.ignorePatch = true;
      await assert.rejects(t.internal.ensureSession(id));
      assert.equal(
        (t.f.store.runtimeState() as any).sessions[id]
          .permissionInitializationRequired,
        true,
      );
      const readonly = await t.read();
      assert.equal(readonly.canUpdate, false);
      assert.equal(readonly.readOnlyReason, "not_started");
      await t.f.reopen();
      t.attach();
      assert.equal(
        t.internal.state.sessions[id].permissionInitializationRequired,
        true,
      );
      t.patchFailure = false;
      t.ignorePatch = false;
      await t.internal.ensureSession(id);
      assert.equal(t.policies.get(id)!.permission_mode, "request_approval");
      assert.equal(
        (t.f.store.runtimeState() as any).sessions[id]
          .permissionInitializationRequired,
        undefined,
      );
      assert.ok(
        !t.calls.some((call) => call.path.endsWith("/io/messages")),
        "settings/initialization do not send inputs",
      );
    } finally {
      await t.f.close();
    }
  });

for (const override of ["preset", "sandbox"])
  test(`首建回执已丢但Runtime显式${override}已存在时尊重其权威，不重置`, async () => {
    const t = await fixture();
    try {
      const id = await t.queue();
      t.lostCreation = true;
      await assert.rejects(t.internal.ensureSession(id));
      if (override === "preset")
        t.policies.get(id)!.permission_mode = "full_access";
      else t.policies.get(id)!.sandbox_mode = "workspace-write";
      await t.f.reopen();
      t.attach();
      await t.internal.ensureSession(id);
      if (override === "preset")
        assert.equal(t.policies.get(id)!.permission_mode, "full_access");
      else assert.equal(t.policies.get(id)!.sandbox_mode, "workspace-write");
      assert.ok(!t.calls.some((call) => call.method === "PATCH"));
      assert.equal(
        t.internal.state.sessions[id].permissionInitializationRequired,
        undefined,
      );
    } finally {
      await t.f.close();
    }
  });

for (const mode of [null, "auto_review"])
  test(`POST409已有${mode ?? "inherited"}会话按Runtime实际策略安全接续`, async () => {
    const t = await fixture();
    try {
      const id = await t.queue();
      t.creationConflict = true;
      t.conflictPreset = mode;
      await t.internal.ensureSession(id);
      assert.equal(
        t.policies.get(id)!.permission_mode,
        mode ?? "request_approval",
      );
      assert.equal(
        t.calls.filter((call) => call.method === "PATCH").length,
        mode ? 0 : 1,
      );
      assert.equal(
        t.internal.state.sessions[id].permissionInitializationRequired,
        undefined,
      );
    } finally {
      await t.f.close();
    }
  });

test("已知持久Runtime principal变化阻止settings read/update，零PATCH", async () => {
  const t = await fixture();
  try {
    await t.seed();
    const id = await t.queue();
    await t.internal.ensureSession(id);
    const before = await t.read();
    t.principal = "foreign-principal";
    await assert.rejects(t.read(), denied);
    await assert.rejects(
      t.f.session().updateSessionPermissions({
        ...t.globalScope,
        permissionMode: "auto_review",
        expectedFingerprint: before.fingerprint,
      }),
      denied,
    );
    assert.ok(!t.calls.some((call) => call.method === "PATCH"));
  } finally {
    await t.f.close();
  }
});

test("有效profile精确镜像Runtime：custom忽略sandbox，同值继承保留preset，异值才custom", async () => {
  const t = await fixture();
  try {
    t.defaults = {
      permission_mode: "auto_review",
      sandbox_mode: "workspace-write",
      reviewer: "auto_review",
    };
    const record = await t.seed(null);
    record.sandbox_mode = "workspace-write";
    assert.equal((await t.read()).permissionMode, "auto_review");
    record.sandbox_mode = "danger-full-access";
    const legacy = await t.read();
    assert.equal(legacy.permissionMode, "custom");
    assert.equal(legacy.sandboxMode, "danger-full-access");
    assert.equal(legacy.reviewer, "auto_review");
    record.permission_mode = "custom";
    const custom = await t.read();
    assert.equal(custom.permissionMode, "auto_review");
    assert.equal(custom.sandboxMode, "workspace-write");
  } finally {
    await t.f.close();
  }
});

test("真实HTTP Session读取解析严格scope且远端只读，持有效CSRF也不能改审批", async () => {
  const t = await fixture();
  const probe = createProbe();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const server = createAppServer(t.f.store, {
    ...t.f.application.options,
    port,
    webRoot: "/nonexistent",
  });
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  const origin = `http://127.0.0.1:${port}`;
  try {
    await t.seed();
    const query = new URLSearchParams(t.globalScope);
    const response = await fetch(`${origin}/api/session-permissions?${query}`);
    assert.equal(response.status, 200);
    const snapshot = sessionPermissionsSnapshotSchema.parse(
      await response.json(),
    );
    assert.equal(snapshot.permissionMode, "request_approval");
    assert.equal(snapshot.canUpdate, false);
    assert.equal(snapshot.readOnlyReason, "local_only");
    assert.equal(
      (
        await fetch(
          `${origin}/api/session-permissions?${query}&sessionId=forged`,
        )
      ).status,
      400,
    );
    const bootstrap = await (
      await fetch(`${origin}/api/platform/bootstrap`)
    ).json();
    const update = await fetch(`${origin}/api/session-permissions/update`, {
      method: "POST",
      headers: {
        Origin: origin,
        "X-Morphz-Token": bootstrap.csrfToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...t.globalScope,
        permissionMode: "full_access",
        expectedFingerprint: snapshot.fingerprint,
        confirmation: true,
      }),
    });
    assert.equal(update.status, 403);
    assert.ok(!t.calls.some((call) => call.method === "PATCH"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await t.f.close();
  }
});

test("首建409碰到旧binding不同Runtime principal时不先修改权限", async () => {
  const t = await fixture();
  try {
    const id = await t.queue();
    t.internal.state.sessions[id].runtimePrincipalId = "isolated-principal";
    t.creationConflict = true;
    t.principal = "foreign-principal";
    await assert.rejects(
      t.internal.ensureSession(id),
      /Runtime 会话身份发生变化/,
    );
    assert.ok(!t.calls.some((call) => call.method === "PATCH"));
    assert.equal(
      t.internal.state.sessions[id].permissionInitializationRequired,
      true,
    );
  } finally {
    await t.f.close();
  }
});

test("logical Session设置方法同样走内嵌身份generation和HTTP adapter，不新增IPC频道", async () => {
  const t = await fixture();
  const host = new LocalApplicationConnection(t.f.application);
  try {
    const boot = await host.invoke({
      id: randomUUID(),
      method: "platform.bootstrap",
    });
    assert.equal(boot.ok, true);
    const generation = (boot as { ok: true; value: { csrfToken: string } })
      .value.csrfToken;
    const reply = await host.invoke({
      id: randomUUID(),
      method: "session-permissions.read",
      params: t.globalScope,
      identityGeneration: generation,
    });
    assert.equal(reply.ok, true);
    const stale = await host.invoke({
      id: randomUUID(),
      method: "session-permissions.read",
      params: t.globalScope,
      identityGeneration: "invalid",
    });
    assert.equal(stale.ok, false);
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const client = new HttpApplicationClient(
      "https://fixture.invalid",
      async (input, init) => {
        requests.push({ url: String(input), init });
        return Response.json({ accepted: true });
      },
    );
    await client.call("session-permissions.read", t.globalScope);
    await client.call(
      "session-permissions.update",
      {
        ...t.globalScope,
        permissionMode: "request_approval",
        expectedFingerprint: "a".repeat(64),
      },
      { identityGeneration: "fixture-generation" },
    );
    assert.equal(
      new URL(requests[0]!.url).pathname,
      "/api/session-permissions",
    );
    assert.equal(
      new URL(requests[0]!.url).searchParams.get("conversationId"),
      t.globalScope.conversationId,
    );
    assert.equal(requests[1]!.init!.method, "POST");
    assert.equal(
      new URL(requests[1]!.url).pathname,
      "/api/session-permissions/update",
    );
  } finally {
    host.close();
    await t.f.close();
  }
});

for (const mode of ["auto_review", "full_access"])
  test(`真实Host outbox两次IO投递均保留${mode}，不重置Session策略`, async () => {
    const t = await fixture();
    try {
      await t.seed(mode);
      await t.queue();
      t.internal.stopped = false;
      await t.f.runtime.tick();
      await t.f.runtime.stop();
      await t.queue();
      t.internal.stopped = false;
      await t.f.runtime.tick();
      assert.deepEqual(t.acceptedInputModes, [mode, mode]);
      assert.ok(!t.calls.some((call) => call.method === "PATCH"));
    } finally {
      await t.f.close();
    }
  });

test("真实Host outbox首建初始化失败零IO，重启重试必须先持久manual读回才发送", async () => {
  const t = await fixture();
  try {
    const id = await t.queue();
    const inputId = t.internal.state.deliveries[0]!.inputId;
    t.patchFailure = true;
    t.internal.stopped = false;
    await t.f.runtime.tick();
    assert.deepEqual(t.acceptedInputModes, []);
    assert.equal(
      (t.f.store.runtimeState() as any).sessions[id]
        .permissionInitializationRequired,
      true,
    );
    assert.equal(t.internal.state.deliveries[0]!.rootId, null);
    await t.f.reopen();
    t.attach();
    t.patchFailure = false;
    await t.f.session().sendInput(inputId);
    t.internal.stopped = false;
    await t.f.runtime.tick();
    assert.deepEqual(t.acceptedInputModes, ["request_approval"]);
    assert.equal(
      (t.f.store.runtimeState() as any).sessions[id]
        .permissionInitializationRequired,
      undefined,
    );
    assert.equal(t.internal.state.deliveries[0]!.rootId, "root-" + inputId);
  } finally {
    await t.f.close();
  }
});
