import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { RuntimeBridge } from "../packages/application/src/runtime.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { localAccess, type Operation } from "../packages/core/src/model.js";

test("应用执行包未加载或无法核实时不发送；加载精确版本后只重试原输入", async () => {
  const store = new WorkspaceStore(":memory:");
  const execute = (operation: Operation) =>
    store.execute({ commandId: randomUUID(), operation }, localAccess).entityId;
  const instanceId = execute({
    type: "launch-application",
    workspaceId: "first-project",
    applicationId: "morphz.script-studio",
    applicationVersion: "1.0.0",
  });
  const inputId = execute({
    type: "record-input",
    projectId: "first-project",
    artifactId: null,
    artifactRevision: null,
    selection: "",
    body: "TEST 构思，不调用模型",
    targetActantId: "morphz-agent",
    applicationInstanceId: instanceId,
  });
  let harnesses: { id: string; version: string }[] | undefined = [];
  const sent: string[] = [];
  const sessions = new Map<string, { id: string; context_id: string }>();
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
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
      return send(200, { enabled: true, harnesses });
    if (path === "/api/sessions" && request.method === "POST") {
      const session = { id: body.id, context_id: body.mount.context_id };
      sessions.set(session.id, session);
      return send(201, session);
    }
    const session = sessions.get(path.split("/")[3]!);
    if (path.endsWith("/principal"))
      return send(200, {
        principal_id: "synthetic-user",
        session_id: session!.id,
        context_id: session!.context_id,
      });
    if (path.endsWith("/io/messages")) {
      assert.deepEqual(body.activation.harness, {
        id: "morphz.script-studio",
        version: "1.1.1",
      });
      sent.push(body.client_message_id);
      return send(200, { accepted: true, event_id: "synthetic-root" });
    }
    if (path.endsWith("/events")) return send(200, { events: [] });
    return send(session ? 200 : 404, session ?? {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const bridge = new RuntimeBridge(store, {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    token: "synthetic",
    namespace: randomUUID(),
  });
  try {
    for (const loaded of [
      [],
      undefined,
      [{ id: "morphz.script-studio", version: "0.9.0" }],
      [{ id: "morphz.script-studio", version: "1.0.0" }],
      [{ id: "morphz.script-studio", version: "1.1.0" }],
    ]) {
      harnesses = loaded;
      bridge.enqueue(inputId);
      await bridge.tick();
      assert.equal(bridge.snapshot().deliveries[0]!.state, "failed");
      assert.match(
        bridge.snapshot().deliveries[0]!.error!,
        /就绪检查|尚未加载/,
      );
      assert.equal(sent.length, 0);
    }
    harnesses = [{ id: "morphz.script-studio", version: "1.1.1" }];
    await bridge.tick(); // Readiness recovery alone must not resend failed inputs.
    assert.equal(sent.length, 0);
    bridge.enqueue(inputId);
    await bridge.tick();
    assert.deepEqual(sent, [inputId]);
    assert.deepEqual(bridge.snapshot().harnesses, harnesses);
    bridge.enqueue(inputId);
    await bridge.tick();
    assert.deepEqual(sent, [inputId]);
    assert.equal(store.snapshot().inputs.length, 1);
  } finally {
    await bridge.stop();
    store.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
