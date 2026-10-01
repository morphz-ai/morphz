import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { request as httpRequest, createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { createAppServer } from "../apps/service/src/http.js";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { RuntimeBridge } from "../packages/application/src/runtime.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
async function freePort() {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}
async function platformHttp(withRuntime = false) {
  const directory = mkdtempSync(join(tmpdir(), "morphz-http-platform-"));
  const filename = join(directory, "workspace.sqlite");
  const store = new WorkspaceStore(filename, { mode: "transport" });
  const domains = await openApplicationDomainsHost(directory, store);
  const modelServer = withRuntime
    ? createHttpServer((request, response) => {
        response.setHeader("Content-Type", "application/json");
        if (request.url !== "/api/status") response.writeHead(404);
        response.end(JSON.stringify({ model: "isolated-http-model" }));
      })
    : undefined;
  if (modelServer)
    await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const runtime = withRuntime
    ? new RuntimeBridge(store, {
        url: `http://127.0.0.1:${(modelServer!.address() as { port: number }).port}`,
        token: "isolated-test-only",
        namespace: randomUUID(),
      })
    : undefined;
  // This case verifies the real durable local ingress, not model execution.
  // Disable dispatch before any input is accepted; only the controlled default
  // setting is read, and no model endpoint is contacted.
  await runtime?.stop();
  const binding = runtime ? domains.bindRuntime(runtime) : undefined;
  const port = await freePort();
  const server = createAppServer(store, {
    port,
    webRoot: "/nonexistent",
    runtime,
    platformWork: domains.work,
    platformDocuments: domains.content,
  });
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  const origin = `http://127.0.0.1:${port}`;
  const client = await PlatformClient.connect(
    new HttpApplicationClient(origin),
  );
  const headers = {
    Origin: origin,
    "Content-Type": "application/json",
    "X-Morphz-Token": client.boot.csrfToken,
  };
  return {
    store,
    client,
    origin,
    headers,
    assertNoLegacyTables() {
      const db = new DatabaseSync(filename, { readOnly: true });
      try {
        assert.deepEqual(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workspace', 'assets')",
            )
            .all(),
          [],
        );
      } finally {
        db.close();
      }
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await runtime?.stop();
      if (modelServer)
        await new Promise<void>((resolve) => modelServer.close(() => resolve()));
      if (binding) await domains.unbindRuntime(binding.authority);
      await domains.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
test("健康检查只读取连接状态，不展开旧工作区或会话历史", async () => {
  const port = await freePort();
  const store = new WorkspaceStore(":memory:", { mode: "transport" });
  let statusReads = 0;
  const runtime = {
    get isConnected() {
      statusReads++;
      return true;
    },
    snapshot() {
      throw new Error("健康检查不得读取完整会话快照");
    },
  } as unknown as RuntimeBridge;
  const server = createAppServer(store, {
    port,
    webRoot: "/nonexistent",
    runtime,
  });
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  try {
    for (let index = 0; index < 3; index++) {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        application: "morphz",
        protocol: 1,
        runtimeConnected: true,
      });
    }
    assert.equal(statusReads, 3);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
test("首发建会话 HTTP 契约：无效输入不创建，丢回执重试返回同一记录", async () => {
  const f = await platformHttp(true);
  try {
    const projectId = `project_${randomUUID().replaceAll("-", "")}`;
    await f.client.createProject("首发会话", randomUUID(), projectId);
    const request = {
      commandId: randomUUID(),
      operation: {
        type: "record-input",
        projectId,
        conversationId: randomUUID(),
        newConversation: { title: "对话 1" },
        body: "HTTP 首发验收",
        selection: "",
        artifactId: null,
        artifactRevision: null,
        targetActantId: "morphz-agent",
      },
    };
    const post = (data: unknown) =>
      fetch(f.origin + "/api/platform/messages", {
        method: "POST",
        headers: f.headers,
        body: JSON.stringify(data),
      });
    const before = await f.client.conversations(projectId);
    assert.equal(
      (
        await post({
          ...request,
          operation: { ...request.operation, body: " " },
        })
      ).status,
      400,
    );
    assert.deepEqual(await f.client.conversations(projectId), before);
    const queuedInputs = () =>
      z
        .object({ deliveries: z.array(z.unknown()) })
        .parse(f.store.runtimeBridgeState()).deliveries;
    assert.equal(queuedInputs().length, 0);
    const first = await post(request);
    assert.equal(first.status, 202);
    const receipt = await first.json();
    assert.deepEqual(await (await post(request)).json(), receipt);
    const after = await f.client.conversations(projectId);
    assert.equal(after.items.length, before.items.length + 1);
    assert.equal(after.items[0]?.id, request.operation.conversationId);
    assert.equal(queuedInputs().length, 1);
    f.assertNoLegacyTables();
  } finally {
    await f.close();
  }
});
test("语音能力状态由提供方报告，不绑定豆包或暴露配置凭据", async () => {
  const port = await freePort();
  const store = new WorkspaceStore(":memory:", { mode: "transport" });
  const server = createAppServer(store, {
    port,
    webRoot: "/nonexistent",
    speech: {
      provider: { id: "test-engine", label: "测试语音" },
      configured: () => true,
      synthesize: async () => {
        throw new Error("status must not synthesize");
      },
      transcribe: async () => {
        throw new Error("status must not record");
      },
    },
  });
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/speech/status`);
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.configured, true);
    assert.equal(status.provider, "test-engine");
    assert.equal(status.providerLabel, "测试语音");
    assert.deepEqual(Object.keys(status).sort(), [
      "configured",
      "provider",
      "providerLabel",
      "segmentSeconds",
      "streaming",
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
test("本机 API 的请求校验、幂等和 HTTP 修订冲突", async () => {
  const f = await platformHttp();
  const { origin } = f;
  try {
    const spaces = await f.client.ensurePersonalSpaces();
    const request = {
      commandId: randomUUID(),
      objectId: `document_${randomUUID().replaceAll("-", "")}`,
      projectId: spaces.deskId,
      title: "API 对象",
      markdown: "正文",
    };
    const post = (
      value: unknown,
      overrides = {},
      path = "/api/platform/documents",
    ) =>
      fetch(origin + path, {
        method: "POST",
        headers: { ...f.headers, ...overrides },
        body: JSON.stringify(value),
      });
    assert.equal(
      (await post(request, { Origin: "https://evil.example" })).status,
      403,
    );
    assert.equal((await post(request, { "X-Morphz-Token": "" })).status, 403);
    const badHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(
        origin + "/api/platform/bootstrap",
        { headers: { Host: "evil.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(badHost, 403);
    assert.equal(
      (
        await fetch(origin + "/api/platform/bootstrap", {
          headers: { Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    const response = await post(request),
      receipt = (await response.json()) as { contentId: string };
    assert.equal(response.status, 200);
    assert.deepEqual(await (await post(request)).json(), receipt);
    const revision = {
      commandId: randomUUID(),
      contentId: receipt.contentId,
      expectedRevision: 1,
      title: "新的",
      markdown: "新正文",
    };
    const revisePath = "/api/platform/documents/revise";
    assert.equal((await post(revision, {}, revisePath)).status, 200);
    assert.equal(
      (await post({ ...revision, commandId: randomUUID() }, {}, revisePath))
        .status,
      409,
    );
    assert.equal(
      (
        await post({
          ...request,
          commandId: randomUUID(),
          principalId: "admin",
        })
      ).status,
      400,
    );
    const original = z
      .object({ title: z.string(), markdown: z.string() })
      .parse(await f.client.readDocument(receipt.contentId, 2));
    assert.equal(original.title, "新的");
    assert.equal(original.markdown, "新正文");
    const snapshot = await fetch(origin + "/api/platform/bootstrap");
    assert.match(
      snapshot.headers.get("content-security-policy")!,
      /object-src 'none'/,
    );
    assert.equal((await fetch(origin + "/%2e%2e%2fpackage.json")).status, 403);
    f.assertNoLegacyTables();
  } finally {
    await f.close();
  }
});

test("没有 Platform 配置也不能恢复旧业务读取、写入或会话订阅 HTTP 入口", async () => {
  const port = await freePort();
  const store = new WorkspaceStore(":memory:", { mode: "transport" });
  const server = createAppServer(store, { port, webRoot: "/nonexistent" });
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  const origin = `http://127.0.0.1:${port}`;
  try {
    const boot = await (await fetch(origin + "/api/platform/bootstrap")).json();
    for (const path of [
      "/api/workspace",
      "/api/artifacts/old-object",
      "/api/conversation/stream?projectId=first-project&conversationId=first-project",
    ])
      assert.equal((await fetch(origin + path)).status, 404, path);
    for (const path of ["/api/commands", "/api/messages"])
      assert.equal(
        (
          await fetch(origin + path, {
            method: "POST",
            headers: {
              Origin: origin,
              "Content-Type": "application/json",
              "X-Morphz-Token": boot.csrfToken,
            },
            body: JSON.stringify({ commandId: randomUUID() }),
          })
        ).status,
        404,
      );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
