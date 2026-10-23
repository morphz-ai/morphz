import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { localAccess } from "../packages/core/src/model.js";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";
import {
  acceptedRuntimeInput,
  runtimeTimeline,
} from "./runtime-http-evidence.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Real Host ingress, SQLite outbox, RuntimeBridge and authorization; only the
// Runtime HTTP is controlled. A held timeline is the snapshot taken *before*
// input acceptance, not a model result or a fabricated Host delivery state.
for (const acceptedByRuntime of [true, false])
  test(`input stays in history when a pre-acceptance timeline returns after ${acceptedByRuntime ? "acceptance" : "dispatch failure"}`, async () => {
    const sessions = new Map<
      string,
      {
        id: string;
        context_id: string;
        permission_mode?: string;
        sandbox_mode?: null;
      }
    >();
    let accepted: ReturnType<typeof acceptedRuntimeInput> | undefined;
    let posts = 0;
    let holdNextTimeline = false;
    const reached = deferred<void>(),
      release = deferred<void>();
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString())
        : null;
      const url = new URL(request.url!, "http://localhost");
      const sessionId = url.pathname.split("/")[3]!;
      const send = (status: number, value: unknown) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (url.pathname === "/api/status")
        return send(200, { model: "handoff-fixture" });
      if (url.pathname === "/api/runtime/inference")
        return send(200, {
          model: "handoff-fixture",
          models: ["handoff-fixture"],
        });
      if (url.pathname === "/api/session-io/capabilities")
        return send(200, { enabled: true, client_metadata: true });
      if (url.pathname === "/api/approvals")
        return send(200, { approvals: [] });
      if (url.pathname === "/api/sessions" && request.method === "POST") {
        const session = { id: body.id, context_id: body.mount.context_id };
        sessions.set(session.id, session);
        return send(201, session);
      }
      if (url.pathname.endsWith("/timeline")) {
        const snapshot = accepted ? runtimeTimeline(accepted, []) : [];
        if (holdNextTimeline) {
          holdNextTimeline = false;
          reached.resolve();
          await release.promise;
        }
        return send(200, { entries: snapshot, next_before: null });
      }
      if (!sessions.has(sessionId)) return send(404, {});
      if (request.method === "PATCH") {
        Object.assign(sessions.get(sessionId)!, {
          permission_mode: body.permission_mode,
          sandbox_mode: null,
        });
        return send(200, sessions.get(sessionId));
      }
      if (url.pathname.endsWith("/principal"))
        return send(200, {
          principal_id: "fixture-principal",
          session_id: sessionId,
          context_id: sessions.get(sessionId)!.context_id,
        });
      if (url.pathname.endsWith("/messages")) {
        posts++;
        if (!acceptedByRuntime)
          return send(400, { error: "TEST controlled dispatch rejection" });
        accepted = acceptedRuntimeInput(body, sessionId, "handoff-root");
        return send(200, { accepted: true, event_id: accepted.id });
      }
      if (url.pathname.endsWith("/events"))
        return send(200, { events: [], latest_sequence: accepted ? 1 : 0 });
      return send(200, sessions.get(sessionId));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const fixture = await platformRuntimeHostFixture({
      url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      token: "handoff-fixture",
      namespace: randomUUID(),
    });
    try {
      const commandId = randomUUID();
      await fixture.session().platformMessage({
        commandId,
        operation: {
          type: "record-input",
          projectId: fixture.projectId,
          artifactId: null,
          artifactRevision: null,
          selection: "",
          body: "TEST continuous message visibility",
          targetActantId: "morphz-agent",
        },
      });
      await fixture.enableDispatch();
      const scope = {
        projectId: fixture.projectId,
        conversationId: fixture.projectId,
      };
      const read = () =>
        fixture.runtime.platformConversationHistory(scope, localAccess);
      const before = await read();
      assert.equal(before.inputs.length, 1);
      assert.equal(before.inputs[0]!.id, commandId);
      assert.equal(posts, 0);

      holdNextTimeline = true;
      const crossing = read();
      await reached.promise;
      await fixture.runtime.tick();
      assert.equal(posts, 1, "the actual Host dispatched exactly once");
      assert.equal(Boolean(accepted), acceptedByRuntime);
      release.resolve();
      const during = await crossing;
      assert.deepEqual(
        during.inputs,
        before.inputs,
        "a read crossing acceptance must retain the same input, not an empty gap",
      );
      assert.equal(during.runtime.deliveries.length, 1);
      assert.equal(during.runtime.deliveries[0]!.inputId, commandId);
      if (!acceptedByRuntime)
        assert.equal(during.runtime.deliveries[0]!.state, "failed");

      const after = await read();
      assert.deepEqual(
        after.inputs,
        before.inputs,
        "the authoritative same-ID row takes over without duplication or timestamp changes",
      );
      assert.equal(posts, 1, "history does not resubmit the message");
      await assert.rejects(
        fixture.runtime.platformConversationHistory(scope, {
          principalId: "other",
          actantId: "other",
        }),
        /用户|身份|权限/,
      );
      fixture.assertNoLegacyData();
    } finally {
      release.resolve();
      await fixture.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
