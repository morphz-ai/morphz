import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  statSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  inspectRuntimeConnection,
  LocalRuntimeConnection,
  runtimeOrigin,
} from "../packages/application/src/runtime-connection.js";
import {
  RuntimeBridge,
  loadRuntimeConfig,
} from "../packages/application/src/runtime.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { Application } from "../packages/application/src/application.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";
import { AgentTools } from "../packages/application/src/agent-tools.js";
import { localAccess } from "../packages/core/src/model.js";
import { unconfiguredConnection } from "../packages/core/src/connection.js";
import { createAppServer } from "../apps/service/src/http.js";
import { openEmbeddedApplication } from "../apps/desktop/application-host.js";

async function runtimeFixture() {
  const received: { method: string; path: string; principal?: string }[] = [];
  const state = {
    token: "fixture-private-token",
    model: "fixture-model",
    status: 200,
    modelStatus: 200,
    malformed: false,
    delay: false,
  };
  const server = createServer((req, res) => {
    received.push({
      method: req.method!,
      path: req.url!,
      principal: req.headers["x-morphz-principal"] as string | undefined,
    });
    if (state.delay) return;
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== `Bearer ${state.token}`) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: state.token }));
      return;
    }
    if (req.url === "/api/runtime/inference") {
      res.writeHead(state.modelStatus);
      res.end(
        JSON.stringify({
          model: state.model,
          models: state.model ? [state.model] : [],
        }),
      );
    } else if (req.url === "/api/sessions") {
      res.end(JSON.stringify({ sessions: [] }));
    } else {
      res.writeHead(state.status);
      res.end(
        JSON.stringify(
          state.malformed
            ? { notRuntime: true }
            : { model: state.model, identity_mode: "default" },
        ),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const config = {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    token: state.token,
    namespace: randomUUID(),
  };
  return {
    state,
    received,
    config,
    server,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("连接诊断只读并区分未授权、服务故障、模型未配置与无效地址响应", async () => {
  const fixture = await runtimeFixture();
  try {
    let details = await inspectRuntimeConnection(fixture.config);
    assert.equal(details.state, "connected");
    assert.equal(details.modelState, "configured");
    assert.equal(details.configurable, false);
    assert.equal(JSON.stringify(details).includes(fixture.config.token), false);
    fixture.state.model = "";
    assert.equal(
      (await inspectRuntimeConnection(fixture.config)).modelState,
      "not-configured",
    );
    fixture.state.modelStatus = 503;
    details = await inspectRuntimeConnection(fixture.config);
    assert.equal(details.state, "connected");
    assert.equal(details.modelState, "unavailable");
    fixture.state.modelStatus = 401;
    assert.equal(
      (await inspectRuntimeConnection(fixture.config)).state,
      "authentication-required",
    );
    fixture.state.status = 503;
    assert.equal(
      (await inspectRuntimeConnection(fixture.config)).state,
      "error",
    );
    fixture.state.status = 200;
    fixture.state.malformed = true;
    assert.equal(
      (await inspectRuntimeConnection(fixture.config)).state,
      "error",
    );
    details = await inspectRuntimeConnection({
      ...fixture.config,
      token: "wrong",
    });
    assert.equal(details.state, "authentication-required");
    assert.equal(JSON.stringify(details).includes(fixture.config.token), false);
    assert.ok(
      fixture.received.every(
        (r) =>
          r.method === "GET" &&
          ["/api/status", "/api/runtime/inference"].includes(r.path),
      ),
    );
  } finally {
    await fixture.close();
  }
  assert.equal(
    (await inspectRuntimeConnection(fixture.config)).state,
    "unreachable",
  );
});

test("多人连接诊断使用实际网关身份，不读取管理员模型配置或返回 Session 内容", async () => {
  const fixture = await runtimeFixture();
  try {
    const result = await inspectRuntimeConnection(
      { ...fixture.config, identityMode: "trusted_gateway" },
      undefined,
      "mapped-principal",
    );
    assert.equal(result.state, "connected");
    assert.equal(result.modelState, "unknown");
    assert.deepEqual(fixture.received, [
      { method: "GET", path: "/api/sessions", principal: "mapped-principal" },
    ]);
    assert.equal("sessions" in result, false);
  } finally {
    await fixture.close();
  }
});

test("本地连接设置：验证后原子保存私有配置，重连保留命名空间，拒绝跨服务/过期覆盖", async () => {
  const fixture = await runtimeFixture();
  const directory = mkdtempSync(join(tmpdir(), "morphz-connection-"));
  const store = new WorkspaceStore(join(directory, "workspace.sqlite"));
  let commits = 0;
  const setup = new LocalRuntimeConnection(directory, store, async () => ({
    commit() {
      commits++;
    },
    async discard() {},
  }));
  const file = join(directory, "runtime.json");
  const signal = new AbortController().signal;
  try {
    assert.equal(setup.details().version, "unconfigured");
    const params = {
      endpoint: fixture.config.url,
      token: fixture.state.token,
      expectedVersion: "unconfigured",
    };
    await assert.rejects(
      setup.configure({ ...params, token: "wrong" }, () => {}, signal),
      /凭据/,
    );
    assert.equal(commits, 0);
    assert.equal(existsSync(file), false);
    const first = await setup.configure(params, () => {}, signal);
    assert.equal(first.modelSettingsAvailable, true);
    assert.equal(first.configurable, true);
    assert.equal(first.state, "connected");
    assert.equal(JSON.stringify(first).includes(fixture.state.token), false);
    assert.equal(statSync(file).mode & 0o077, 0);
    assert.equal(loadRuntimeConfig(directory)?.namespace, store.identity());
    await assert.rejects(
      setup.configure(params, () => {}, signal),
      /已变化/,
    );
    await assert.rejects(
      setup.configure(
        {
          ...params,
          expectedVersion: first.version!,
          endpoint: "http://127.0.0.1:1",
        },
        () => {},
        signal,
      ),
      /不能.*切换/,
    );
    fixture.state.token = "replacement-fixture-token";
    const second = await setup.configure(
      {
        ...params,
        token: fixture.state.token,
        expectedVersion: first.version!,
      },
      () => {},
      signal,
    );
    assert.notEqual(second.version, first.version);
    assert.equal(commits, 2);
    assert.equal(loadRuntimeConfig(directory)?.namespace, store.identity());
    assert.equal(loadRuntimeConfig(directory)?.token, fixture.state.token);
    for (const endpoint of [
      "https://example.com",
      "http://10.0.0.1:80",
      "http://secret@127.0.0.1",
      "http://127.0.0.1/x",
      "http://127.0.0.1/?token=secret",
    ])
      assert.throws(() => runtimeOrigin(endpoint));
    assert.ok(fixture.received.every((r) => r.method === "GET"));
  } finally {
    store.close();
    await fixture.close();
    rmSync(directory, { recursive: true });
  }
});

test("取消与并发身份失效不覆盖配置；准备资源失败后仍可重试", async () => {
  const fixture = await runtimeFixture();
  const directory = mkdtempSync(join(tmpdir(), "morphz-connection-cancel-"));
  const store = new WorkspaceStore(join(directory, "workspace.sqlite"));
  const cancelled = new AbortController();
  let discard = 0,
    commit = 0,
    cancel = true;
  const setup = new LocalRuntimeConnection(directory, store, async () => {
    if (cancel) cancelled.abort();
    return {
      commit() {
        commit++;
      },
      async discard() {
        discard++;
      },
    };
  });
  const params = {
    endpoint: fixture.config.url,
    token: fixture.state.token,
    expectedVersion: "unconfigured",
  };
  try {
    await assert.rejects(setup.configure(params, () => {}, cancelled.signal));
    assert.equal(discard, 1);
    assert.equal(commit, 0);
    assert.ok(
      readdirSync(directory).every((name) => !name.startsWith("runtime.json")),
    );
    cancel = false;
    await assert.rejects(
      setup.configure(
        params,
        () => {
          throw Error("identity expired");
        },
        new AbortController().signal,
      ),
      /identity expired/,
    );
    assert.equal(existsSync(join(directory, "runtime.json")), false);
    await setup.configure(params, () => {}, new AbortController().signal);
    assert.equal(commit, 1);
  } finally {
    store.close();
    await fixture.close();
    rmSync(directory, { recursive: true });
  }
});

test("检查和更新凭据不 tick、不投递输入、不改变会话或执行回执", async () => {
  const fixture = await runtimeFixture();
  const store = new WorkspaceStore(":memory:");
  const bridge = new RuntimeBridge(store, fixture.config);
  try {
    const input = store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "record-input",
          projectId: "first-project",
          artifactId: null,
          artifactRevision: null,
          selection: "",
          body: "留在队列，不能因检查重发",
          targetActantId: "morphz-agent",
        },
      },
      localAccess,
    );
    bridge.enqueue(input.entityId);
    const before = JSON.stringify(store.runtimeState());
    const objects = JSON.stringify(store.snapshot());
    assert.equal((await bridge.inspectConnection()).state, "connected");
    fixture.state.token = "new-token";
    bridge.updateConnection({ ...fixture.config, token: fixture.state.token });
    assert.equal((await bridge.inspectConnection()).state, "connected");
    assert.equal(JSON.stringify(store.runtimeState()), before);
    assert.equal(JSON.stringify(store.snapshot()), objects);
    assert.ok(fixture.received.every((r) => r.method === "GET"));
    assert.throws(
      () =>
        bridge.updateConnection({ ...fixture.config, namespace: randomUUID() }),
      /不匹配/,
    );
  } finally {
    await bridge.stop();
    store.close();
    await fixture.close();
  }
});

test("本地 IPC 有身份代际保护；凭据设置只允许本人，智能体只有脱敏只读检查", async () => {
  const store = new WorkspaceStore(":memory:");
  const app = new Application(store);
  const host = new LocalApplicationConnection(app);
  try {
    const boot = (await host.call("workspace")) as any;
    await assert.rejects(host.call("connection.check"));
    assert.deepEqual(
      await host.call("connection.check", undefined, {
        identityGeneration: boot.csrfToken,
      }),
      unconfiguredConnection,
    );
    await assert.rejects(
      host.call("connection.configure", {}, { identityGeneration: "stale" }),
    );
    await assert.rejects(
      app
        .session({ principalId: "morphz-service", actantId: "morphz-agent" })
        .configureConnection({}, new AbortController().signal),
      /本人/,
    );
    const tools = new AgentTools(
      store,
      "host-token",
      () => ({
        projectId: "first-project",
        access: { principalId: "morphz-service", actantId: "morphz-agent" },
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      async () => unconfiguredConnection,
    );
    const invocation = {
      job_id: "job",
      tool_call_id: "call",
      session_id: "s",
      context_id: "c",
      principal_id: "untrusted",
      agent_id: "a",
      target_id: "local",
      thread_id: "t",
    };
    assert.deepEqual(
      await tools.call({
        protocol: 1,
        tool: "host_morphz",
        invocation,
        arguments: { action: "connection-status" },
      }),
      { ok: true, connection: unconfiguredConnection },
    );
    assert.throws(() =>
      tools.call({
        protocol: 1,
        tool: "host_morphz",
        invocation,
        arguments: { action: "connection-configure", token: "no" },
      }),
    );
  } finally {
    host.close();
    store.close();
  }
});

test("HTTP 检查继续验证 CSRF，远端不能配置本机连接", async () => {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const store = new WorkspaceStore(":memory:");
  const server = createAppServer(store, { port, webRoot: "/nonexistent" });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${port}`;
  try {
    const boot = await (await fetch(origin + "/api/workspace")).json();
    const headers = {
      Origin: origin,
      "X-MorphzWork-Token": boot.csrfToken,
      "Content-Type": "application/json",
    };
    assert.equal(
      (await fetch(origin + "/api/connection/check", { method: "POST" }))
        .status,
      403,
    );
    const result = await (
      await fetch(origin + "/api/connection/check", { method: "POST", headers })
    ).json();
    assert.deepEqual(result, unconfiguredConnection);
    for (const path of [
      "/api/model-settings/read",
      "/api/model-settings/update",
    ]) {
      assert.equal(
        (await fetch(origin + path, { method: "POST", headers, body: "{}" }))
          .status,
        403,
      );
    }
    assert.equal(
      (
        await fetch(origin + "/api/connection/configure", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
      403,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});

test("真实内嵌宿主首次配置与重开保持中心/对象，不用重启桌面即可连接", async () => {
  const fixture = await runtimeFixture();
  const directory = mkdtempSync(join(tmpdir(), "morphz-connection-host-"));
  const oldEnv = process.env.MORPHZ_APP_ENV_FILE;
  process.env.MORPHZ_APP_ENV_FILE = "";
  let host: Awaited<ReturnType<typeof openEmbeddedApplication>> | undefined;
  try {
    host = await openEmbeddedApplication(directory, join(directory, "profile"));
    const boot = (await host.connection.call("workspace")) as any;
    const identityGeneration = boot.csrfToken;
    const details = (await host.connection.call("connection.check", undefined, {
      identityGeneration,
    })) as any;
    assert.equal(details.configurable, true);
    await host.connection.call(
      "connection.configure",
      {
        endpoint: fixture.config.url,
        token: fixture.state.token,
        expectedVersion: details.version,
      },
      { identityGeneration },
    );
    const connected = (await host.connection.call("workspace")) as any;
    assert.equal(connected.centerId, boot.centerId);
    assert.equal(connected.runtime.configured, true);
    assert.deepEqual(connected.workspace, boot.workspace);
    assert.ok(host.manifestPath);
    assert.equal(
      JSON.stringify(connected).includes(fixture.config.token),
      false,
    );
    const saved = readFileSync(join(directory, "runtime.json"), "utf8");
    await host.close();
    host = await openEmbeddedApplication(directory, join(directory, "profile"));
    const reopened = (await host.connection.call("workspace")) as any;
    assert.equal(reopened.centerId, boot.centerId);
    // Bridge health checkpoints may advance the center revision; objects and work are unchanged.
    assert.deepEqual(
      { ...reopened.workspace, revision: boot.workspace.revision },
      boot.workspace,
    );
    assert.equal(readFileSync(join(directory, "runtime.json"), "utf8"), saved);
    assert.ok(fixture.received.every((r) => r.method === "GET"));
  } finally {
    await host?.close();
    await fixture.close();
    if (oldEnv === undefined) delete process.env.MORPHZ_APP_ENV_FILE;
    else process.env.MORPHZ_APP_ENV_FILE = oldEnv;
    rmSync(directory, { recursive: true });
  }
});
