import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";

test("a Session delta timeout preserves healthy transport, exact cursor and readable activity, with redacted recoverable evidence", async () => {
  const f = await platformRuntimeHostFixture();
  try {
    const { dialogueId } = await f.session().ensurePlatformSpaces();
    await f.session().platformMessage({
      commandId: randomUUID(),
      operation: {
        type: "record-input",
        projectId: f.projectId,
        conversationId: dialogueId,
        artifactId: null,
        artifactRevision: null,
        selection: "",
        body: "TEST read failure",
        targetActantId: "morphz-agent",
      },
    });
    const runtime = f.runtime as any;
    const delivery = runtime.state.deliveries[0];
    delivery.state = "completed";
    delivery.rootId = "TEST-read-root";
    const session = runtime.state.sessions[delivery.sessionId];
    session.hasWork = true;
    const cursor = session.cursor;
    const contextId = runtime.contextId(f.projectId);
    let fail = true;
    const methods: string[] = [];
    runtime.host.request = async (url: string, init: RequestInit) => {
      methods.push(init.method ?? "GET");
      const path = new URL(String(url)).pathname;
      if (path === "/api/status")
        return Response.json({ model: "isolated-model" });
      if (path === "/api/runtime/inference")
        return Response.json({
          model: "isolated-model",
          models: ["isolated-model"],
        });
      if (path.endsWith("/capabilities"))
        return Response.json({ enabled: true, client_metadata: true });
      if (path.endsWith("/events")) {
        if (fail)
          throw new DOMException(
            "SECRET Bearer token and private body",
            "TimeoutError",
          );
        return Response.json({ events: [] });
      }
      if (path.endsWith("/scheduler"))
        return Response.json({
          context_id: contextId,
          detail_bounds: {
            limit: 200,
            has_more_threads: false,
            has_more_objectives: false,
            has_more_schedules: false,
          },
          threads: [],
          objectives: [],
          schedules: [],
        });
      if (path === "/api/delegations")
        return Response.json({ delegations: [], has_more: false });
      if (path === "/api/approvals") return Response.json({ approvals: [] });
      return Response.json({});
    };
    runtime.stopped = false;
    await runtime.tick();
    assert.equal(runtime.state.connected, true);
    assert.equal(session.cursor, cursor);
    assert.equal(runtime.state.activity.available, true);
    const details = await runtime.inspectConnection();
    assert.equal(details.state, "connected");
    assert.equal(details.lastReadFailure.operation, "session-events");
    assert.equal(details.lastReadFailure.code, "TimeoutError");
    assert.equal(details.lastReadFailure.timeoutMs, 8000);
    assert.equal(details.lastReadFailure.recoveredAt, undefined);
    assert.doesNotMatch(
      JSON.stringify(details),
      /SECRET|Bearer|private body|isolated-storage-test|TEST-read-root/,
    );
    fail = false;
    await runtime.tick();
    const recovered = await runtime.inspectConnection();
    assert.equal(recovered.lastReadFailure.at, details.lastReadFailure.at);
    assert.ok(recovered.lastReadFailure.recoveredAt);
    assert.equal(session.cursor, cursor);
    assert.ok(
      methods.every((method) => method === "GET"),
      "Read recovery must never replay input",
    );
    assert.equal(runtime.state.deliveries.length, 1);
  } finally {
    await f.close();
  }
});
