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
import { conversationRuntimeSchema } from "../packages/core/src/conversation.js";

test("Runtime 已公开的部分回复通过授权历史保留原身份，Host 重开不会丢失", async () => {
  const sessions = new Map<string, { id: string; context_id: string }>();
  let accepted: ReturnType<typeof acceptedRuntimeInput> | undefined;
  let posts = 0;
  let complete = false;
  let truncated = false;
  const visibleAt = "2026-09-30T01:02:03.456789Z";
  const attempt = "fixture-public-attempt";
  const server = createServer(async (req, res) => {
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
    if (url.pathname === "/api/status") return send(200, { model: "fixture" });
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
      accepted = acceptedRuntimeInput(body, sessionId, "fixture-public-root");
      return send(200, { accepted: true, event_id: accepted.id });
    }
    if (url.pathname.endsWith("/events"))
      return send(200, { events: [], latest_sequence: accepted ? 2 : 0 });
    if (url.pathname.endsWith("/timeline")) {
      assert.ok(accepted);
      const publication = {
        id: "model_public_output_" + attempt,
        sequence: 2,
        timestamp: "2026-09-30T01:03:00.000Z",
        topic: "runtime/model_public_output",
        payload: {
          root_turn_id: accepted.id,
          attempt_id: attempt,
          text: "已向用户展示、但尚未完成的回复",
          first_visible_at: visibleAt,
          complete,
          truncated,
        },
      };
      const entries = runtimeTimeline(accepted, [publication]);
      Object.assign(entries[1]!, {
        entry_id: "publication:" + attempt,
        attempt_id: attempt,
        display_kind: "progress",
        final_event: false,
        visible_at: visibleAt,
        visible_at_micros: 1790720523456789,
      });
      return send(200, { entries, next_before: null });
    }
    return send(200, sessions.get(sessionId));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const fixture = await platformRuntimeHostFixture({
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    namespace: randomUUID(),
    token: "public-output-fixture",
  });
  try {
    const receipt = await fixture.session().platformMessage({
      commandId: randomUUID(),
      operation: {
        type: "record-input",
        projectId: fixture.projectId,
        artifactId: null,
        artifactRevision: null,
        selection: "",
        body: "请解释这段",
        targetActantId: "morphz-agent",
      },
    });
    await fixture.enableDispatch();
    await fixture.runtime.tick();
    assert.equal(posts, 1);
    const scope = {
      projectId: fixture.projectId,
      conversationId: fixture.projectId,
    };
    const read = async () => {
      const value = await fixture.runtime.platformConversationHistory(
        scope,
        localAccess,
      );
      const parsed = conversationRuntimeSchema.parse(value.runtime);
      assert.equal(parsed.messages.length, 1);
      const message = parsed.messages[0]!;
      assert.equal(message.inputId, receipt.entityId);
      assert.equal(message.id, "stream:" + attempt);
      assert.equal(message.publicationKey, attempt);
      assert.equal(message.createdAt, visibleAt);
      assert.equal(message.kind, "reply");
      assert.equal(message.incomplete, !complete);
      assert.equal(message.truncated, truncated);
      return message;
    };
    const before = await read();
    await fixture.reopen(true);
    assert.deepEqual(await read(), before);
    assert.equal(posts, 1, "A history read/reopen must never replay an input");
    truncated = true;
    assert.equal((await read()).truncated, true);
    complete = true;
    assert.equal((await read()).incomplete, false);
    await assert.rejects(
      fixture.runtime.platformConversationHistory(scope, {
        principalId: "morphz-service",
        actantId: "morphz-agent",
      }),
      /用户|身份|权限/,
    );
    fixture.assertNoLegacyData();
  } finally {
    await fixture.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
