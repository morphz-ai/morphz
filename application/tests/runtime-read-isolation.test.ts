import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";
import {
  acceptedRuntimeInput,
  runtimeTimeline,
} from "./runtime-http-evidence.js";
import { localAccess } from "../packages/core/src/model.js";

test("Runtime 断开或拒绝凭据不阻断已授权 Platform，只展示本 Host 未接收输入", async () => {
  type Mode = "healthy" | "network" | "malformed" | 401 | 403 | 503;
  let mode: Mode = "healthy";
  let posts = 0;
  let requests = 0;
  const sessions = new Map<
    string,
    {
      id: string;
      context_id: string;
      permission_mode?: string;
      sandbox_mode?: string | null;
    }
  >();
  const roots: ReturnType<typeof acceptedRuntimeInput>[] = [];
  const server = createServer(async (req, res) => {
    requests++;
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(part);
    const body = parts.length
      ? JSON.parse(Buffer.concat(parts).toString())
      : null;
    const url = new URL(req.url!, "http://localhost");
    const sessionId = url.pathname.split("/")[3]!;
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (mode === "network") return res.destroy();
    if (typeof mode === "number")
      return send(mode, { error: "Runtime unavailable" });
    if (mode === "malformed")
      return send(200, { not_a_runtime_response: true });
    if (url.pathname === "/api/status") return send(200, { model: "fixture" });
    if (url.pathname === "/api/runtime/inference")
      return send(200, { model: "fixture", models: [] });
    if (url.pathname === "/api/session-io/capabilities")
      return send(200, { enabled: true, client_metadata: true });
    if (url.pathname === "/api/approvals") return send(200, { approvals: [] });
    if (url.pathname === "/api/sessions" && req.method === "POST") {
      const value = { id: body.id, context_id: body.mount.context_id };
      sessions.set(value.id, value);
      return send(201, value);
    }
    if (!sessions.has(sessionId)) return send(404, {});
    if (url.pathname.endsWith("/principal"))
      return send(200, {
        principal_id: "fixture-principal",
        session_id: sessionId,
        context_id: sessions.get(sessionId)!.context_id,
      });
    if (url.pathname.endsWith("/messages")) {
      posts++;
      const root = acceptedRuntimeInput(
        body,
        sessionId,
        "root-" + body.client_message_id,
        posts,
      );
      roots.push(root);
      return send(200, { accepted: true, event_id: root.id });
    }
    if (url.pathname.endsWith("/events"))
      return send(200, { events: [], latest_sequence: roots.length });
    if (url.pathname.endsWith("/timeline"))
      return send(200, {
        entries: roots.flatMap((root) => runtimeTimeline(root, [])),
        next_before: null,
      });
    if (req.method === "PATCH") {
      assert.deepEqual(body, { permission_mode: "request_approval" });
      Object.assign(sessions.get(sessionId)!, {
        permission_mode: body.permission_mode,
        sandbox_mode: null,
      });
    }
    return send(200, sessions.get(sessionId));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const fixture = await platformRuntimeHostFixture({
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    namespace: randomUUID(),
    token: "read-isolation-fixture",
  });
  const send = (body: string) =>
    fixture.session().platformMessage({
      commandId: randomUUID(),
      operation: {
        type: "record-input",
        projectId: fixture.projectId,
        artifactId: null,
        artifactRevision: null,
        selection: "",
        body,
        targetActantId: "morphz-agent",
      },
    });
  const scope = {
    projectId: fixture.projectId,
    conversationId: fixture.projectId,
  };
  try {
    const accepted = await send("Runtime 已接收的输入");
    await fixture.enableDispatch();
    await fixture.runtime.tick();
    assert.equal(posts, 1);
    await fixture.runtime.stop();
    const pending = await send("仅本 Host 排队的输入");
    assert.equal(posts, 1);
    const initial = await fixture.runtime.platformConversationHistory(
      scope,
      localAccess,
    );
    assert.equal(initial.inputs.length, 2);
    assert.ok(initial.inputs.some((input) => input.id === accepted.entityId));
    for (const failure of ["network", 401, 403, 503] as const) {
      mode = failure;
      const navigation = await fixture
        .session()
        .platformRuntimeNavigation(scope);
      assert.equal(navigation.runtime.connected, false);
      assert.ok(navigation.runtime.error);
      const history = await fixture.runtime.platformConversationHistory(
        scope,
        localAccess,
      );
      assert.deepEqual(
        history.inputs.map((input) => input.id),
        [pending.entityId],
      );
      assert.equal(history.runtime.connected, false);
      assert.deepEqual(history.runtime.messages, []);
      assert.deepEqual(
        history.runtime.deliveries.map((delivery) => delivery.inputId),
        [pending.entityId],
      );
      assert.equal(history.nextCursor, null);
      assert.ok(
        (
          await fixture
            .session()
            .listPlatformProjects({ status: "all", limit: 100 })
        ).some((project) => project.id === fixture.projectId),
      );
      assert.equal(
        posts,
        1,
        "A failed read cannot replay or manufacture a submission",
      );
      const details = await fixture.runtime.inspectConnection(
        AbortSignal.timeout(2000),
      );
      assert.equal(
        details.state,
        failure === "network"
          ? "unreachable"
          : failure === 503
            ? "error"
            : "authentication-required",
      );
    }
    const beforeDenied = requests;
    await assert.rejects(
      fixture.runtime.platformConversationHistory(scope, {
        principalId: "morphz-service",
        actantId: "morphz-agent",
      }),
      /用户|身份|权限/,
    );
    assert.equal(
      requests,
      beforeDenied,
      "Platform denial must remain ahead of Runtime I/O",
    );
    mode = "malformed";
    await assert.rejects(fixture.session().platformRuntimeNavigation(scope));
    await assert.rejects(
      fixture.runtime.platformConversationHistory(scope, localAccess),
    );
    mode = "healthy";
    const restored = await fixture.runtime.platformConversationHistory(
      scope,
      localAccess,
    );
    assert.equal(restored.inputs.length, 2);
    assert.ok(restored.inputs.some((input) => input.id === accepted.entityId));
    assert.equal(posts, 1);
    await fixture.enableDispatch();
    await fixture.runtime.tick();
    assert.equal(
      posts,
      2,
      "Recovery dispatches only the genuine pending input",
    );
    assert.equal(
      roots.filter(
        (root) => root.payload.client_message_id === accepted.entityId,
      ).length,
      1,
    );
    assert.equal(
      roots.filter(
        (root) => root.payload.client_message_id === pending.entityId,
      ).length,
      1,
    );
    fixture.assertNoLegacyData();
  } finally {
    mode = "healthy";
    await fixture.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
