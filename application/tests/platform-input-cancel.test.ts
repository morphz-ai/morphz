import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../packages/application/src/application.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";
import { RuntimeBridge } from "../packages/application/src/runtime.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { localAccess } from "../packages/core/src/model.js";
import { assertNoLegacyBusinessTables } from "./host-transport-invariant.js";

const projectId = "platform-cancel-project";
const sessionId = "platform-cancel-session";
const inputId = "platform-cancel-input";
const source = {
  projectId,
  conversationId: projectId,
  targetActantId: "morphz-agent",
  author: localAccess,
  createdAt: "2026-09-27T00:00:00.000Z",
  sharedDefault: false,
  body: "请继续处理",
};

function runtimeState(
  namespace: string,
  endpoint: string,
  state: "queued" | "running",
) {
  return {
    namespace,
    endpoint,
    connected: false,
    model: "",
    error: "",
    sessions: {
      [sessionId]: {
        id: sessionId,
        projectId,
        conversationId: projectId,
        artifactId: null,
        cursor: 0,
        events: [],
        platform: true,
        turnControl: true,
        hasWork: false,
      },
    },
    deliveries: [
      {
        inputId,
        sessionId,
        rootId: state === "running" ? "root-one" : null,
        runtimePostAttempted: state === "running",
        state,
        error: null,
        retryable: false,
        cancelRequested: false,
        request: {},
        platformSource: source,
      },
    ],
  };
}

test("formal Host stops a queued Platform input without looking in the old workspace", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-platform-cancel-"));
  const store = new WorkspaceStore(join(directory, "workspace.sqlite"));
  let domains:
    Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
  let runtime: RuntimeBridge | undefined;
  let connection: LocalApplicationConnection | undefined;
  let authority:
    | ReturnType<
        Awaited<ReturnType<typeof openApplicationDomainsHost>>["bindRuntime"]
      >["authority"]
    | undefined;
  try {
    const namespace = randomUUID();
    const endpoint = "http://127.0.0.1:1";
    store.saveRuntimeState(runtimeState(namespace, endpoint, "queued"));
    runtime = new RuntimeBridge(
      store,
      { namespace, url: endpoint, token: "test-only" },
      undefined,
      false,
    );
    domains = await openApplicationDomainsHost(directory, store);
    authority = domains.bindRuntime(runtime).authority;
    await domains.work.authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        domains!.work.service.createProject(actor, {
          commandId: randomUUID(),
          projectId,
          title: "停止新消息",
        }),
    );
    connection = new LocalApplicationConnection(
      new Application(store, {
        runtime,
        platformWork: domains.work,
      }),
    );
    const boot = (await connection.call("platform.bootstrap")) as {
      csrfToken: string;
    };
    const options = { identityGeneration: boot.csrfToken };
    assert.deepEqual(await connection.call("input.cancel", inputId, options), {
      accepted: true,
    });
    assert.equal(Reflect.has(store, "snapshot"), false);
    assertNoLegacyBusinessTables(join(directory, "workspace.sqlite"));
    assert.equal(
      (store.runtimeState() as { deliveries: Array<{ state: string }> })
        .deliveries[0]!.state,
      "cancelled",
    );
    await assert.rejects(
      connection.call("input.cancel", inputId, options),
      /没有正在进行的处理/,
    );
  } finally {
    connection?.close();
    if (domains && authority) await domains.unbindRuntime(authority);
    await domains?.close();
    await runtime?.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Platform cancellation rechecks author and scope, then controls only the exact Runtime root", async () => {
  const paths: string[] = [];
  let postCount = 0;
  const server = createServer((request, response) => {
    const path = new URL(request.url!, "http://localhost").pathname;
    paths.push(`${request.method} ${path}`);
    response.setHeader("Content-Type", "application/json");
    if (path === "/api/status")
      return response.end(JSON.stringify({ model: "fixture" }));
    if (path === "/api/session-io/capabilities")
      return response.end(
        JSON.stringify({ enabled: false, directed_input: false, formats: [] }),
      );
    if (path.endsWith("/turns/root-one/thread")) {
      if (request.method === "POST") postCount++;
      return response.end(
        JSON.stringify({
          thread_id: "thread-one",
          session_id: sessionId,
          root_turn_id: "root-one",
          revision: postCount + 1,
          lifecycle: postCount ? "cancelled" : "open",
        }),
      );
    }
    if (path.endsWith("/events"))
      return response.end(JSON.stringify({ events: [] }));
    if (path.endsWith("/scheduler"))
      return response.end(JSON.stringify({ threads: [] }));
    if (path === "/api/approvals")
      return response.end(JSON.stringify({ approvals: [] }));
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const store = new WorkspaceStore(":memory:");
  const namespace = randomUUID();
  store.saveRuntimeState(runtimeState(namespace, endpoint, "running"));
  const bridge = new RuntimeBridge(
    store,
    { namespace, url: endpoint, token: "test-only" },
    undefined,
    false,
  );
  let readable = false;
  bridge.bindPlatformReadAuthority(async () => {
    if (!readable) throw new Error("authorization revoked");
    return { personalDefault: false, projectIds: [projectId] };
  });
  try {
    await assert.rejects(
      bridge.cancelPlatformInput(inputId, {
        principalId: "another",
        actantId: "another",
      }),
      /只能停止自己发送的消息/,
    );
    await assert.rejects(
      bridge.cancelPlatformInput(inputId, localAccess),
      /authorization revoked/,
    );
    assert.equal(paths.length, 0);
    readable = true;
    await bridge.cancelPlatformInput(inputId, localAccess);
    await bridge.tick();
    assert.equal(postCount, 1);
    assert.equal(
      (store.runtimeState() as { deliveries: Array<{ state: string }> })
        .deliveries[0]!.state,
      "cancelled",
    );
    assert.ok(
      paths.includes(`GET /api/sessions/${sessionId}/turns/root-one/thread`),
    );
    assert.ok(
      paths.includes(`POST /api/sessions/${sessionId}/turns/root-one/thread`),
    );
    assert.equal(
      paths.some((path) => path.endsWith("/cancel")),
      false,
    );
  } finally {
    await bridge.stop();
    store.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
