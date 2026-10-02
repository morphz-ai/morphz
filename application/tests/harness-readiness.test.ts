import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { scriptStudioApplication } from "../packages/core/src/applications.js";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";

test("应用执行包未加载或无法核实时不发送；加载精确版本后只重试原输入", async () => {
  let harnesses: { id: string; version: string }[] | undefined = [];
  const sent: string[] = [];
  const sessions = new Map<
    string,
    {
      id: string;
      context_id: string;
      permission_mode?: string;
      sandbox_mode?: string | null;
    }
  >();
  let policyWrites = 0;
  let policyReadbacks = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : null;
    const path = new URL(request.url!, "http://localhost").pathname;
    const send = (code: number, value: unknown) => {
      response.writeHead(code, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (path === "/api/status") return send(200, { model: "synthetic" });
    if (path === "/api/session-io/capabilities")
      return send(200, { enabled: true, client_metadata: true, harnesses });
    if (path === "/api/sessions" && request.method === "POST") {
      const session = { id: body.id, context_id: body.mount.context_id };
      sessions.set(session.id, session);
      return send(201, session);
    }
    const session = sessions.get(path.split("/")[3]!);
    if (session && path === `/api/sessions/${session.id}`) {
      if (request.method === "PATCH") {
        assert.deepEqual(body, { permission_mode: "request_approval" });
        policyWrites++;
        Object.assign(session, {
          permission_mode: "request_approval",
          sandbox_mode: null,
        });
      } else if (request.method === "GET" && session.permission_mode) {
        policyReadbacks++;
      }
      return send(200, session);
    }
    if (path.endsWith("/principal"))
      return send(200, {
        principal_id: "synthetic-user",
        session_id: session!.id,
        context_id: session!.context_id,
      });
    if (path.endsWith("/io/messages")) {
      assert.equal(session!.permission_mode, "request_approval");
      assert.equal(policyWrites, 1);
      assert.ok(
        policyReadbacks >= 1,
        "The new Session's safe policy must be read back before input POST",
      );
      assert.deepEqual(body.activation.harness, {
        id: "morphz.script-studio",
        version: "1.4.0",
      });
      sent.push(body.client_message_id);
      return send(200, { accepted: true, event_id: "synthetic-root" });
    }
    if (path.endsWith("/events")) return send(200, { events: [] });
    return send(session ? 200 : 404, session ?? {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const f = await platformRuntimeHostFixture({
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    token: "synthetic",
    namespace: randomUUID(),
  });
  try {
    const receipt = await f.session().platformMessage({
      commandId: randomUUID(),
      operation: {
        type: "record-input",
        projectId: f.projectId,
        artifactId: null,
        artifactRevision: null,
        selection: "",
        body: "TEST 构思，不调用模型",
        targetActantId: "morphz-agent",
        application: {
          id: scriptStudioApplication.id,
          version: scriptStudioApplication.version,
        },
      },
    });
    const inputId = receipt.entityId;
    await f.enableDispatch();
    const bridge = f.runtime;
    const outboxDelivery = () =>
      (
        f.store.runtimeState() as {
          deliveries: {
            inputId: string;
            state: string;
            error: string | null;
          }[];
        }
      ).deliveries.find((delivery) => delivery.inputId === inputId)!;
    for (const loaded of [
      [],
      undefined,
      [{ id: "morphz.script-studio", version: "0.9.0" }],
      [{ id: "morphz.script-studio", version: "1.0.0" }],
      [{ id: "morphz.script-studio", version: "1.1.0" }],
      [{ id: "morphz.script-studio", version: "1.2.1" }],
    ]) {
      harnesses = loaded;
      if (outboxDelivery().state === "failed")
        await bridge.retryPlatformInput(inputId);
      await bridge.tick();
      const delivery = outboxDelivery();
      assert.equal(delivery.state, "failed");
      assert.match(delivery.error!, /就绪检查|尚未加载/);
      assert.equal(sent.length, 0);
    }
    harnesses = [{ id: "morphz.script-studio", version: "1.4.0" }];
    await bridge.tick();
    assert.equal(
      sent.length,
      0,
      "Readiness recovery is not authority to resend",
    );
    await bridge.retryPlatformInput(inputId);
    await bridge.tick();
    assert.deepEqual(sent, [inputId]);
    assert.equal(
      policyWrites,
      1,
      "Retry must not reinitialize an existing Session policy",
    );
    assert.deepEqual(bridge.platformStatus().harnesses, harnesses);
    await assert.rejects(bridge.retryPlatformInput(inputId), /已发送/);
    await bridge.tick();
    assert.deepEqual(sent, [inputId]);
    assert.equal(
      (f.store.runtimeState() as { deliveries: unknown[] }).deliveries.length,
      1,
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
