import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer as createProbe } from "node:net";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";
import { createAppServer } from "../apps/service/src/http.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import {
  DomainError,
  localAccess,
  morphzAgentAccess,
} from "../packages/core/src/model.js";
import {
  sessionEvaluationSnapshotSchema,
  sessionEvaluationUpdateSchema,
  type SessionEvaluationDefaults,
} from "../packages/core/src/session-evaluation.js";

type Policy = {
  id: string;
  context_id: string;
  model_alias: string | null;
  reasoning_effort: string | null;
  permission_mode?: string | null;
  sandbox_mode?: string | null;
};
async function fixture() {
  const f = await platformRuntimeHostFixture();
  const internal = f.runtime as unknown as {
    config: { identityMode?: "trusted_gateway" };
    identity?: { allows(): boolean };
    state: {
      namespace: string;
      sessions: Record<string, { runtimePrincipalId: string | null }>;
      deliveries: Array<{
        inputId: string;
        sessionId: string;
        request: Record<string, any>;
        initialSessionEvaluation?: SessionEvaluationDefaults;
      }>;
    };
    runtimeFetch(url: string, init: RequestInit): Promise<Response>;
    ensureSession(
      id: string,
      initial?: SessionEvaluationDefaults,
    ): Promise<void>;
  };
  const records = new Map<string, Policy>();
  const calls: { path: string; method: string; body: any }[] = [];
  let patch: "normal" | "fail" | "ignore" | "lost" | "overwrite" = "normal";
  let principal = "isolated-principal";
  let onCatalog: (() => void) | undefined;
  let initialCapability = true;
  let loseCreation = false;
  const attach = () => {
    (f.runtime as unknown as typeof internal).runtimeFetch = async (
      url,
      init,
    ) => {
      const path = new URL(url).pathname;
      const method = init.method ?? "GET";
      const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ path, method, body });
      if (path === "/api/runtime/inference") {
        onCatalog?.();
        return Response.json({
          model: "isolated-model",
          reasoning_effort: "low",
          initial_session_evaluation: initialCapability,
          model_options: [
            {
              id: "isolated-model",
              label: "First",
              supported_reasoning_efforts: ["none", "low", "high", "max"],
            },
            {
              id: "alternate-model",
              label: "Alternate",
              supported_reasoning_efforts: ["none", "high"],
            },
          ],
        });
      }
      if (path === "/api/sessions" && method === "POST") {
        const record: Policy = {
          id: body.id,
          context_id: body.mount.context_id,
          model_alias: body.initial_evaluation?.model_alias ?? null,
          reasoning_effort: body.initial_evaluation?.reasoning_effort ?? null,
          permission_mode: null,
          sandbox_mode: null,
        };
        records.set(record.id, record);
        if (loseCreation) {
          loseCreation = false;
          throw new Error("isolated lost atomic creation response");
        }
        return Response.json(record, { status: 201 });
      }
      const id = path.split("/")[3]!;
      const record = records.get(id);
      if (!record) return Response.json({}, { status: 404 });
      if (path.endsWith("/principal"))
        return Response.json({
          principal_id: principal,
          session_id: id,
          context_id: record.context_id,
        });
      if (method === "PATCH") {
        if (body.permission_mode) {
          assert.deepEqual(Object.keys(body), ["permission_mode"]);
          record.permission_mode = body.permission_mode;
          record.sandbox_mode = null;
          return Response.json(record);
        }
        assert.deepEqual(Object.keys(body), [
          "model_alias",
          "reasoning_effort",
        ]);
        if (patch === "fail") return Response.json({}, { status: 503 });
        if (patch !== "ignore") {
          record.model_alias = body.model_alias || null;
          record.reasoning_effort = body.reasoning_effort || null;
        }
        if (patch === "lost") throw new Error("isolated lost PATCH receipt");
        if (patch === "overwrite") record.reasoning_effort = "none";
      }
      return Response.json(record);
    };
  };
  attach();
  const { dialogueId } = await f.session().ensurePlatformSpaces();
  const scope = { projectId: f.projectId, conversationId: dialogueId };
  const read = (target = scope) => f.session().readSessionEvaluation(target);
  const seed = async (target = scope) => {
    await read(target);
    const id = calls
      .filter((c) => /^\/api\/sessions\/[^/]+$/.test(c.path))
      .at(-1)!
      .path.split("/")[3]!;
    const record: Policy = {
      id,
      context_id: `mw-context-${internal.state.namespace}`,
      model_alias: null,
      reasoning_effort: null,
    };
    records.set(id, record);
    return record;
  };
  const update = async (
    defaults: SessionEvaluationDefaults,
    target = scope,
  ) => {
    const before = await read(target);
    return f.session().updateSessionEvaluation({
      ...target,
      defaults,
      expectedFingerprint: before.fingerprint,
    });
  };
  return {
    f,
    get internal() {
      return f.runtime as unknown as typeof internal;
    },
    attach,
    scope,
    records,
    calls,
    read,
    seed,
    update,
    set initialCapability(value: boolean) {
      initialCapability = value;
    },
    set loseCreation(value: boolean) {
      loseCreation = value;
    },
    set patch(value: typeof patch) {
      patch = value;
    },
    set principal(value: string) {
      principal = value;
    },
    set onCatalog(value: typeof onCatalog) {
      onCatalog = value;
    },
  };
}
const denied = (e: unknown) =>
  e instanceof DomainError && e.code === "forbidden";
const conflicted = (e: unknown) =>
  e instanceof DomainError && e.code === "conflict";

test("全局会话模型由对话所有者读取，跨工作页面的授权项目仍指向同一Runtime设置", async () => {
  const t = await fixture();
  try {
    await t.seed();
    const owner = {
      projectId: t.scope.conversationId,
      conversationId: t.scope.conversationId,
    };
    const a = await t.read(),
      b = await t.read(owner);
    assert.equal(a.runtimeSessionId, b.runtimeSessionId);
    assert.equal(b.scope.kind, "global");
    const settings = {
      model: "alternate-model",
      reasoningEffort: "high" as const,
    };
    await t.update(settings, owner);
    assert.deepEqual((await t.read()).defaults, settings);
    assert.deepEqual((await t.read(owner)).defaults, settings);
  } finally {
    await t.f.close();
  }
});

async function queueInitial(t: Awaited<ReturnType<typeof fixture>>) {
  const command = {
    commandId: randomUUID(),
    operation: {
      type: "record-input" as const,
      ...t.scope,
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body: "TEST 首建模型不固化为任务设置",
      targetActantId: "morphz-agent",
      initialSessionEvaluation: {
        model: "alternate-model",
        reasoningEffort: "high" as const,
      },
    },
  };
  await t.f.session().platformMessage(command);
  const delivery = t.internal.state.deliveries.find(
    (d) => d.inputId === command.commandId,
  )!;
  assert.ok(delivery);
  assert.equal(delivery.request.activation.model_alias, undefined);
  assert.equal(delivery.request.activation.reasoning_effort, undefined);
  return { command, delivery };
}

test("首建模型收据跨Host重启保留，Runtime原子创建而不变成任务覆盖，同ID不同设置拒绝", async () => {
  const t = await fixture();
  try {
    const { command, delivery } = await queueInitial(t);
    const envelope = structuredClone(delivery.request);
    await assert.rejects(
      t.f.session().platformMessage({
        ...command,
        operation: {
          ...command.operation,
          initialSessionEvaluation: {
            model: "alternate-model",
            reasoningEffort: "none",
          },
        },
      }),
      conflicted,
    );
    await t.f.reopen();
    t.attach();
    const retained = t.internal.state.deliveries.find(
      (d) => d.inputId === command.commandId,
    )!;
    assert.deepEqual(retained.request, envelope);
    assert.deepEqual(
      retained.initialSessionEvaluation,
      command.operation.initialSessionEvaluation,
    );
    await t.f.session().platformMessage(command);
    await t.internal.ensureSession(
      retained.sessionId,
      retained.initialSessionEvaluation,
    );
    const record = t.records.get(retained.sessionId)!;
    assert.equal(record.model_alias, "alternate-model");
    assert.equal(record.reasoning_effort, "high");
    assert.equal(record.permission_mode, "request_approval");
    const creates = t.calls.filter(
      (c) => c.path === "/api/sessions" && c.method === "POST",
    );
    assert.equal(creates.length, 1);
    assert.deepEqual(creates[0]!.body.initial_evaluation, {
      model_alias: "alternate-model",
      reasoning_effort: "high",
    });
    assert.ok(
      t.calls
        .filter((c) => c.method === "PATCH")
        .every((c) => Object.keys(c.body).join() === "permission_mode"),
    );
    assert.deepEqual(retained.request, envelope);
  } finally {
    await t.f.close();
  }
});

test("首建响应丢失后尊重Runtime后续选择，重启不PATCH旧模型、不重复创建", async () => {
  const t = await fixture();
  try {
    const { command, delivery } = await queueInitial(t);
    const envelope = structuredClone(delivery.request);
    t.loseCreation = true;
    await assert.rejects(
      t.internal.ensureSession(
        delivery.sessionId,
        delivery.initialSessionEvaluation,
      ),
      /lost atomic creation response/,
    );
    const record = t.records.get(delivery.sessionId)!;
    assert.equal(record.model_alias, "alternate-model");
    assert.equal(record.reasoning_effort, "high");
    record.model_alias = null;
    record.reasoning_effort = null;
    record.permission_mode = "auto_review";
    await t.f.reopen();
    t.attach();
    const retained = t.internal.state.deliveries.find(
      (d) => d.inputId === command.commandId,
    )!;
    await t.internal.ensureSession(
      retained.sessionId,
      retained.initialSessionEvaluation,
    );
    assert.equal(record.model_alias, null);
    assert.equal(record.reasoning_effort, null);
    assert.equal(record.permission_mode, "auto_review");
    assert.equal(t.calls.filter((c) => c.method === "POST").length, 1);
    assert.ok(!t.calls.some((c) => c.method === "PATCH"));
    assert.deepEqual(retained.request, envelope);
  } finally {
    await t.f.close();
  }
});

test("后来的输入首建收据不重置既有Session的模型、强度或权限", async () => {
  const t = await fixture();
  try {
    const record = await t.seed();
    record.model_alias = "isolated-model";
    record.reasoning_effort = "none";
    record.permission_mode = "full_access";
    const { delivery } = await queueInitial(t);
    await t.internal.ensureSession(
      delivery.sessionId,
      delivery.initialSessionEvaluation,
    );
    assert.equal(record.model_alias, "isolated-model");
    assert.equal(record.reasoning_effort, "none");
    assert.equal(record.permission_mode, "full_access");
    assert.ok(t.calls.every((c) => c.method === "GET"));
  } finally {
    await t.f.close();
  }
});

test("旧Runtime未声明原子首建能力就停止，不静默忽略设置或退回任务固定模型", async () => {
  const t = await fixture();
  try {
    const { delivery } = await queueInitial(t);
    t.initialCapability = false;
    await assert.rejects(
      t.internal.ensureSession(
        delivery.sessionId,
        delivery.initialSessionEvaluation,
      ),
      /尚不支持首建会话模型设置/,
    );
    assert.equal(t.records.size, 0);
    assert.ok(t.calls.every((c) => c.method === "GET"));
    assert.equal(delivery.request.activation.model_alias, undefined);
  } finally {
    await t.f.close();
  }
});

test("会话模型读取未开始范围不创建Session、Host账本或输入；写入不伪造首建", async () => {
  const t = await fixture();
  try {
    const before = structuredClone(t.f.store.runtimeState());
    const snapshot = sessionEvaluationSnapshotSchema.parse(await t.read());
    assert.equal(snapshot.source, "not_started");
    assert.equal(snapshot.canUpdate, false);
    assert.deepEqual(snapshot.defaults, { model: null, reasoningEffort: null });
    assert.deepEqual(t.f.store.runtimeState(), before);
    await assert.rejects(
      t.f.session().updateSessionEvaluation({
        ...t.scope,
        defaults: snapshot.defaults,
        expectedFingerprint: "a".repeat(64),
      }),
      conflicted,
    );
    assert.ok(t.calls.every((c) => c.method === "GET"));
    await assert.rejects(
      t.read({ projectId: "foreign", conversationId: "foreign" }),
    );
  } finally {
    await t.f.close();
  }
});

test("持续模型按规范全局Session跨项目共享，命名范围独立，旧读写不固化输入", async () => {
  const t = await fixture();
  try {
    const record = await t.seed();
    const value = await t.update({
      model: "alternate-model",
      reasoningEffort: "high",
    });
    assert.equal(value.scope.kind, "global");
    assert.equal(value.runtimeSessionId, record.id);
    assert.deepEqual(value.defaults, {
      model: "alternate-model",
      reasoningEffort: "high",
    });
    await t.f.session().createPlatformProject({
      commandId: randomUUID(),
      projectId: "second-project",
      title: "TEST 第二项目",
    });
    const shared = await t.read({
      projectId: "second-project",
      conversationId: t.scope.conversationId,
    });
    assert.equal(shared.runtimeSessionId, record.id);
    assert.deepEqual(shared.defaults, value.defaults);
    const separate = {
      projectId: t.f.projectId,
      conversationId: t.f.projectId,
    };
    const other = await t.seed(separate);
    assert.notEqual(other.id, record.id);
    assert.equal((await t.read(separate)).scope.kind, "conversation");
    assert.deepEqual((await t.read(separate)).defaults, {
      model: null,
      reasoningEffort: null,
    });
    assert.ok(
      t.calls
        .filter((c) => c.method !== "GET")
        .every((c) => c.method === "PATCH"),
    );
    assert.equal(t.f.store.runtimeState(), null);
  } finally {
    await t.f.close();
  }
});

test("Session默认清除和none不混同，不新增任务层provider_default语义", async () => {
  const t = await fixture();
  try {
    await t.seed();
    for (const reasoningEffort of ["none", null] as const) {
      const defaults = { model: "alternate-model", reasoningEffort };
      assert.deepEqual((await t.update(defaults)).defaults, defaults);
    }
    assert.equal(
      sessionEvaluationUpdateSchema.safeParse({
        ...t.scope,
        defaults: {
          model: "alternate-model",
          reasoningEffort: "provider_default",
        },
        expectedFingerprint: (await t.read()).fingerprint,
      }).success,
      false,
    );
    assert.deepEqual(
      (await t.update({ model: null, reasoningEffort: null })).defaults,
      { model: null, reasoningEffort: null },
    );
    assert.deepEqual(t.calls.filter((c) => c.method === "PATCH").at(-1)!.body, {
      model_alias: "",
      reasoning_effort: "",
    });
  } finally {
    await t.f.close();
  }
});

test("未知模型和不支持强度拒绝，目录读取期间变化不覆盖，过期指纹拒绝", async () => {
  const t = await fixture();
  try {
    const record = await t.seed();
    const before = await t.read();
    await assert.rejects(
      t.update({ model: "unknown", reasoningEffort: "high" }),
      /所选模型当前不可用/,
    );
    await assert.rejects(
      t.update({ model: "alternate-model", reasoningEffort: "max" }),
      /不支持此推理强度/,
    );
    t.onCatalog = () => {
      record.model_alias = "alternate-model";
    };
    await assert.rejects(
      t.update({ model: "isolated-model", reasoningEffort: "high" }),
      conflicted,
    );
    t.onCatalog = undefined;
    await assert.rejects(
      t.f.session().updateSessionEvaluation({
        ...t.scope,
        defaults: { model: null, reasoningEffort: null },
        expectedFingerprint: before.fingerprint,
      }),
      conflicted,
    );
    assert.ok(!t.calls.some((c) => c.method === "PATCH"));
  } finally {
    await t.f.close();
  }
});

test("同Host并发修改只有首个原指纹写入成功，不重试、不覆盖第二选择", async () => {
  const t = await fixture();
  try {
    await t.seed();
    const before = await t.read();
    const requests = ["high", "none"].map((reasoningEffort) =>
      t.f.session().updateSessionEvaluation({
        ...t.scope,
        defaults: { model: "alternate-model", reasoningEffort },
        expectedFingerprint: before.fingerprint,
      }),
    );
    const results = await Promise.allSettled(requests);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const rejection = results.find(
      (r) => r.status === "rejected",
    ) as PromiseRejectedResult;
    assert.ok(conflicted(rejection.reason));
    assert.equal(t.calls.filter((c) => c.method === "PATCH").length, 1);
    assert.equal((await t.read()).defaults.reasoningEffort, "high");
  } finally {
    await t.f.close();
  }
});

for (const mode of ["fail", "ignore", "lost", "overwrite"] as const)
  test(`会话模型PATCH ${mode} 不报告成功、不自动重放，重读真实状态`, async () => {
    const t = await fixture();
    try {
      await t.seed();
      t.patch = mode;
      await assert.rejects(
        t.update({ model: "alternate-model", reasoningEffort: "high" }),
      );
      assert.equal(t.calls.filter((c) => c.method === "PATCH").length, 1);
      const actual = await t.read();
      assert.equal(
        actual.defaults.model,
        ["lost", "overwrite"].includes(mode) ? "alternate-model" : null,
      );
      assert.equal(
        actual.defaults.reasoningEffort,
        mode === "lost" ? "high" : mode === "overwrite" ? "none" : null,
      );
    } finally {
      await t.f.close();
    }
  });

test("模型设置拒绝伪造scope、错误Context/Principal、非本人及授权中途失效", async () => {
  const t = await fixture();
  try {
    const record = await t.seed();
    const before = await t.read();
    assert.equal(
      sessionEvaluationUpdateSchema.safeParse({
        ...t.scope,
        sessionId: record.id,
        defaults: before.defaults,
        expectedFingerprint: before.fingerprint,
      }).success,
      false,
    );
    await assert.rejects(
      t.f.session(morphzAgentAccess).updateSessionEvaluation({
        ...t.scope,
        defaults: before.defaults,
        expectedFingerprint: before.fingerprint,
      }),
      denied,
    );
    const context = record.context_id;
    record.context_id = "foreign-context";
    await assert.rejects(t.read(), denied);
    record.context_id = context;
    await t.f.session().platformMessage({
      commandId: randomUUID(),
      operation: {
        type: "record-input",
        ...t.scope,
        artifactId: null,
        artifactRevision: null,
        selection: "",
        body: "TEST Principal 绑定",
        targetActantId: "morphz-agent",
      },
    });
    t.internal.state.sessions[record.id]!.runtimePrincipalId =
      "isolated-principal";
    t.principal = "foreign-principal";
    await assert.rejects(t.read(), denied);
    t.principal = "isolated-principal";
    let writes = 0;
    await assert.rejects(
      t.f.runtime.updateSessionEvaluation(
        {
          ...t.scope,
          defaults: { model: "alternate-model", reasoningEffort: "high" },
          expectedFingerprint: before.fingerprint!,
        },
        localAccess,
        async () => {
          if (++writes >= 3)
            throw new DomainError(
              "forbidden",
              "isolated revoked authorization",
            );
        },
      ),
      denied,
    );
    assert.ok(!t.calls.some((c) => c.method === "PATCH"));
  } finally {
    await t.f.close();
  }
});

test("团队模型设置只读；写后身份失效不把已经提交的结果冒充确认回执", async () => {
  const t = await fixture();
  try {
    const record = await t.seed();
    const before = await t.read();
    const defaults = {
      model: "alternate-model",
      reasoningEffort: "high" as const,
    };
    let authorizations = 0;
    await assert.rejects(
      t.f.runtime.updateSessionEvaluation(
        { ...t.scope, defaults, expectedFingerprint: before.fingerprint! },
        localAccess,
        async () => {
          if (++authorizations >= 5)
            throw new DomainError(
              "forbidden",
              "isolated identity revoked after write",
            );
        },
      ),
      denied,
    );
    assert.deepEqual((await t.read()).defaults, defaults);
    assert.equal(t.calls.filter((c) => c.method === "PATCH").length, 1);
    t.internal.config.identityMode = "trusted_gateway";
    t.internal.identity = { allows: () => true };
    record.context_id +=
      "-" +
      createHash("sha256")
        .update(t.scope.conversationId)
        .digest("hex")
        .slice(0, 24);
    const team = await t.read();
    assert.equal(team.canUpdate, false);
    assert.equal(team.readOnlyReason, "team_managed");
    await assert.rejects(
      t.f.session().updateSessionEvaluation({
        ...t.scope,
        defaults,
        expectedFingerprint: team.fingerprint,
      }),
      denied,
    );
    assert.equal(t.calls.filter((c) => c.method === "PATCH").length, 1);
  } finally {
    delete t.internal.config.identityMode;
    await t.f.close();
  }
});

test("内嵌Session模型方法受identity generation保护；HTTP adapter保持有类型scope", async () => {
  const t = await fixture();
  const host = new LocalApplicationConnection(t.f.application);
  try {
    await t.seed();
    const boot = await host.invoke({
      id: randomUUID(),
      method: "platform.bootstrap",
    });
    assert.equal(boot.ok, true);
    const generation = (boot as { ok: true; value: { csrfToken: string } })
      .value.csrfToken;
    const params = {
      ...t.scope,
      defaults: { model: "alternate-model", reasoningEffort: "high" },
      expectedFingerprint: (await t.read()).fingerprint,
    };
    assert.equal(
      (
        await host.invoke({
          id: randomUUID(),
          method: "session-evaluation.update",
          params,
          identityGeneration: "stale",
        })
      ).ok,
      false,
    );
    assert.equal(
      (
        await host.invoke({
          id: randomUUID(),
          method: "session-evaluation.update",
          params,
          identityGeneration: generation,
        })
      ).ok,
      true,
    );
    const requests: { url: string; init?: RequestInit }[] = [];
    const client = new HttpApplicationClient(
      "https://fixture.invalid",
      async (input, init) => {
        requests.push({ url: String(input), init });
        return Response.json({});
      },
    );
    await client.call("session-evaluation.read", t.scope);
    await client.call("session-evaluation.update", params, {
      identityGeneration: "fixture-generation",
    });
    assert.equal(new URL(requests[0]!.url).pathname, "/api/session-evaluation");
    assert.equal(
      new URL(requests[0]!.url).searchParams.get("conversationId"),
      t.scope.conversationId,
    );
    assert.equal(
      new URL(requests[1]!.url).pathname,
      "/api/session-evaluation/update",
    );
    assert.equal(requests[1]!.init!.method, "POST");
  } finally {
    host.close();
    await t.f.close();
  }
});

test("真实HTTP会话模型只读且拒绝额外scope字段，有效CSRF也不赋予本机写权限", async () => {
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
    const query = new URLSearchParams(t.scope);
    const response = await fetch(`${origin}/api/session-evaluation?${query}`);
    assert.equal(response.status, 200);
    const snapshot = sessionEvaluationSnapshotSchema.parse(
      await response.json(),
    );
    assert.equal(snapshot.canUpdate, false);
    assert.equal(snapshot.readOnlyReason, "local_only");
    assert.equal(
      (
        await fetch(
          `${origin}/api/session-evaluation?${query}&sessionId=forged`,
        )
      ).status,
      400,
    );
    const bootstrap = await (
      await fetch(`${origin}/api/platform/bootstrap`)
    ).json();
    const update = await fetch(`${origin}/api/session-evaluation/update`, {
      method: "POST",
      headers: {
        Origin: origin,
        "X-Morphz-Token": bootstrap.csrfToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...t.scope,
        defaults: { model: "alternate-model", reasoningEffort: "high" },
        expectedFingerprint: snapshot.fingerprint,
      }),
    });
    assert.equal(update.status, 403);
    assert.ok(!t.calls.some((c) => c.method === "PATCH"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await t.f.close();
  }
});
