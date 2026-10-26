import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createServer as portProbe } from "node:net";
import { createAppServer } from "../apps/service/src/http.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { localAccess } from "../packages/core/src/model.js";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";

const stamp = "2026-10-26T00:00:00Z";
const data = (v: any): any =>
  v === null
    ? { type: "null" }
    : Array.isArray(v)
      ? { type: "array", value: v.map(data) }
      : typeof v === "object"
        ? {
            type: "object",
            value: Object.fromEntries(
              Object.entries(v).map(([k, x]) => [k, data(x)]),
            ),
          }
        : { type: typeof v, value: typeof v === "number" ? String(v) : v };
async function fixture() {
  const f = await platformRuntimeHostFixture();
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
      body: "TEST exact control authority",
      targetActantId: "morphz-agent",
    },
  });
  const internal = f.runtime as any;
  const delivery = internal.state.deliveries[0];
  delivery.rootId = "root-input";
  internal.state.connected = true;
  const contextId = `mw-context-${(f.store.runtimeState() as any).namespace}`;
  const thread = {
    id: "thread",
    session_id: delivery.sessionId,
    context_id: contextId,
    root_turn_id: delivery.rootId,
    initiating_principal_id: localAccess.principalId,
    parent_thread_id: null,
    generation: 1,
    revision: 1,
    lifecycle: "open",
    control_state: "active",
    phase: "waiting",
    kind: "execution",
    created_at: stamp,
    updated_at: stamp,
    intent: "TEST",
  };
  const root = {
    id: delivery.rootId,
    actor: "Human",
    type: "session_message",
    topic: "chat/user_message",
    timestamp: stamp,
    sequence: 1,
    payload: {
      session_id: delivery.sessionId,
      context_id: contextId,
      client_message_id: delivery.inputId,
      root_turn_id: delivery.rootId,
      session_io: {
        request: {
          ...delivery.request,
          client_metadata: data(delivery.request.client_metadata),
          message: {
            ...delivery.request.message,
            content: {
              encoding: "json",
              value: data(delivery.request.message.content.value),
            },
          },
        },
      },
    },
  };
  const scope = {
    projectId: f.projectId,
    conversationId: dialogueId,
    inputId: delivery.inputId,
    threadId: thread.id,
    artifactId: null,
  };
  const pointer = {
    runtime: { sessionId: delivery.sessionId, contextId },
    threadId: thread.id,
    artifactId: null,
  };
  const records = () => ({
    session_id: delivery.sessionId,
    context_id: contextId,
    selected_thread_id: thread.id,
    source_root_id: delivery.rootId,
    limit: 100,
    has_more_jobs: false,
    threads_truncated: false,
    jobs: [],
    threads: [thread],
  });
  const scheduler = (schedules: unknown[] = []) => ({
    threads: [
      {
        thread,
        intent: thread.intent,
        phase: thread.phase,
        source: {
          event_id: delivery.rootId,
          context_id: contextId,
          session_id: delivery.sessionId,
          root_turn_id: delivery.rootId,
          activation_id: null,
        },
      },
    ],
    objectives: [],
    schedules,
    detail_bounds: {
      limit: 200,
      has_more_threads: false,
      has_more_objectives: false,
      has_more_schedules: false,
    },
  });
  return {
    f,
    internal,
    delivery,
    contextId,
    thread,
    root,
    scope,
    pointer,
    records,
    scheduler,
  };
}

test("raw Runtime Thread controls use fresh ownership and Platform grants, never pointer authority or history", async () => {
  const x = await fixture();
  try {
    const writes: any[] = [],
      reads: string[] = [];
    x.internal.request = async (path: string, method = "GET", body: any) => {
      if (method === "POST") {
        writes.push({ path, body });
        assert.equal(body.expected_revision, x.thread.revision);
        x.thread.revision++;
        x.thread.control_state = body.action === "pause" ? "paused" : "active";
        if (path.endsWith("/supersede")) {
          x.thread.generation++;
          x.thread.intent = body.intent;
        }
        return { updated: true, thread: x.thread };
      }
      reads.push(path);
      if (path.includes("/execution-records?")) return x.records();
      if (path.includes("/threads/")) return { snapshot: { thread: x.thread } };
      if (path.startsWith("/api/delegations?"))
        return { delegations: [], has_more: false };
      if (path.includes("/scheduler?")) return x.scheduler();
      throw new Error(`Unexpected non-point read ${path}`);
    };
    for (const type of [
      "pause-thread",
      "resume-thread",
      "supersede-thread",
    ] as const) {
      await x.f.session().executionControl({
        scope: x.pointer,
        action: {
          type,
          threadId: x.thread.id,
          revision: x.thread.revision,
          ...(type === "supersede-thread"
            ? { intent: "TEST corrected intent" }
            : {}),
        },
      });
    }
    assert.equal(writes.length, 3);
    assert.ok(
      writes.every(({ path }) =>
        path.startsWith(`/api/contexts/${x.contextId}/threads/thread`),
      ),
    );
    assert.ok(
      !reads.some(
        (path) => path.includes("/events?") || path.includes("/history"),
      ),
    );
    // The shared HTTP carrier must fit the same 64k intent contract as IPC,
    // including UTF-8 Chinese, without weakening the schema or source checks.
    const probe = portProbe();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const server = createAppServer(x.f.store, {
      ...x.f.application.options,
      port,
      webRoot: "/nonexistent",
    });
    await new Promise<void>((resolve) =>
      server.listen(port, "127.0.0.1", resolve),
    );
    try {
      const remote = new HttpApplicationClient(`http://127.0.0.1:${port}`);
      const boot = (await remote.call("platform.bootstrap")) as {
        csrfToken: string;
      };
      const intent = "TEST 修正中文执行要求。".repeat(1800);
      await remote.call(
        "execution.control",
        {
          scope: x.pointer,
          action: {
            type: "supersede-thread",
            threadId: x.thread.id,
            revision: x.thread.revision,
            intent,
          },
        },
        { identityGeneration: boot.csrfToken },
      );
      assert.equal(writes.length, 4);
      assert.equal(writes[3].body.intent, intent);
      await assert.rejects(
        remote.call(
          "execution.control",
          {
            scope: x.pointer,
            action: {
              type: "supersede-thread",
              threadId: x.thread.id,
              revision: x.thread.revision,
              intent: "字".repeat(64001),
            },
          },
          { identityGeneration: boot.csrfToken },
        ),
      );
      assert.equal(writes.length, 4);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    x.thread.initiating_principal_id = "foreign";
    await assert.rejects(
      x.f.session().executionControl({
        scope: x.pointer,
        action: {
          type: "pause-thread",
          threadId: x.thread.id,
          revision: x.thread.revision,
        },
      }),
      /身份/,
    );
    assert.equal(writes.length, 4);
  } finally {
    await x.f.close();
  }
});

test("revocation during physical Thread reads fences the subsequent mutation", async () => {
  const x = await fixture();
  try {
    let revoked = false,
      writes = 0,
      reads = 0;
    const authorize = x.internal.authorizePlatformRead;
    x.internal.authorizePlatformRead = async (...args: any[]) => {
      if (revoked) throw new Error("TEST revoked");
      return authorize(...args);
    };
    x.internal.request = async (path: string, method = "GET") => {
      if (method === "POST") writes++;
      if (path.includes("/execution-records?")) {
        if (++reads === 2) revoked = true;
        return x.records();
      }
      if (path.includes("/threads/")) {
        revoked = true;
        return { snapshot: { thread: x.thread } };
      }
      throw new Error(`Unexpected ${path}`);
    };
    await assert.rejects(
      x.f.session().executionControl({
        scope: x.pointer,
        action: { type: "pause-thread", threadId: x.thread.id, revision: 1 },
      }),
      /TEST revoked/,
    );
    assert.equal(writes, 0);
  } finally {
    await x.f.close();
  }
});

test("native Schedule facade revalidates immutable input and exact scoped CAS; forged input cannot mutate", async () => {
  const x = await fixture();
  try {
    let record = {
      id: "timer",
      thread_id: x.thread.id,
      source_turn_id: x.delivery.rootId,
      revision: 1,
      status: "queued",
      intent: "TEST future timer",
      not_before: "2099-01-01T00:00:00Z",
      interval_seconds: null,
      dependency_thread_ids: [],
      updated_at: stamp,
    };
    const writes: any[] = [];
    x.internal.request = async (path: string, method = "GET", body: any) => {
      if (method === "POST") {
        writes.push({ path, body });
        assert.equal(
          path,
          `/api/sessions/${x.delivery.sessionId}/schedules/timer`,
        );
        assert.equal(body.expected_revision, record.revision);
        record = {
          ...record,
          revision: record.revision + 1,
          status: body.action === "pause" ? "paused" : "queued",
        };
        return record;
      }
      if (path.includes("/scheduler?")) return x.scheduler([record]);
      if (path.startsWith("/api/delegations?"))
        return { delegations: [], has_more: false };
      if (path.endsWith("/events/root-input")) return { event: x.root };
      if (path.endsWith("/schedules/timer")) return record;
      if (path.includes("/threads/")) return { snapshot: { thread: x.thread } };
      throw new Error(`Unexpected ${path}`);
    };
    await x.internal.refreshActivity();
    assert.equal(x.internal.state.activity.schedules.length, 1);
    await x.f.session().scheduleControl({
      scope: x.scope,
      scheduleId: "timer",
      revision: 1,
      action: "pause",
    });
    assert.equal(record.status, "paused");
    const probe = portProbe();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const server = createAppServer(x.f.store, {
      ...x.f.application.options,
      port,
      webRoot: "/nonexistent",
    });
    await new Promise<void>((resolve) =>
      server.listen(port, "127.0.0.1", resolve),
    );
    try {
      const remote = new HttpApplicationClient(`http://127.0.0.1:${port}`);
      const boot = (await remote.call("platform.bootstrap")) as {
        csrfToken: string;
      };
      await remote.call(
        "schedule.control",
        { scope: x.scope, scheduleId: "timer", revision: 2, action: "resume" },
        { identityGeneration: boot.csrfToken },
      );
      assert.equal(record.status, "queued");
      await assert.rejects(
        remote.call(
          "schedule.control",
          { scope: x.scope, scheduleId: "timer", revision: 3, action: "pause" },
          { identityGeneration: "retired-token" },
        ),
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await assert.rejects(
      x.f.session().scheduleControl({
        scope: { ...x.scope, inputId: "forged" },
        scheduleId: "timer",
        revision: 2,
        action: "resume",
      }),
    );
    await assert.rejects(
      x.f.session().scheduleControl({
        scope: x.scope,
        scheduleId: "timer",
        revision: 1,
        action: "resume",
      }),
      /已变化/,
    );
    assert.equal(writes.length, 2);
  } finally {
    await x.f.close();
  }
});

test("real sub-agent cancellation follows its original delegation edge, not its Thread endpoint", async () => {
  const x = await fixture();
  try {
    // Personal Runtime identity is distinct from the Platform user identity.
    const owner = "runtime-human";
    x.internal.state.sessions[x.delivery.sessionId].runtimePrincipalId = owner;
    const record = {
      id: "delegate",
      parent_context_id: x.contextId,
      parent_session_id: x.delivery.sessionId,
      child_context_id: "child-context",
      child_session_id: "child-session",
      initiating_principal_id: owner,
      task: "TEST delegation",
      status: "running",
      created_at: stamp,
      updated_at: stamp,
    };
    const event = {
      id: "delegate-event",
      actor: "Runtime",
      type: "agent_call",
      topic: "chat/delegate",
      timestamp: stamp,
      sequence: 2,
      payload: {
        delegation_id: record.id,
        parent_context_id: x.contextId,
        context_id: x.contextId,
        parent_session_id: x.delivery.sessionId,
        session_id: x.delivery.sessionId,
        child_context_id: record.child_context_id,
        child_session_id: record.child_session_id,
        principal_id: owner,
        thread_id: x.thread.id,
        root_turn_id: x.delivery.rootId,
      },
    };
    const scope = {
      runtime: {
        sessionId: record.child_session_id,
        contextId: record.child_context_id,
        delegation: {
          id: record.id,
          requestEventId: event.id,
          parentSessionId: record.parent_session_id,
          parentContextId: record.parent_context_id,
          parentThreadId: x.thread.id,
        },
      },
      artifactId: null,
      threadId: "child-thread",
    };
    const writes: string[] = [];
    x.internal.refreshActivity = async () => {};
    x.internal.request = async (path: string, method = "GET") => {
      if (method === "POST") {
        writes.push(path);
        assert.equal(path, "/api/delegations/delegate/cancel");
        record.status = "cancelled";
        return { cancelled: true, delegation: record };
      }
      if (path === "/api/delegations/delegate") return record;
      if (path.endsWith("/events/delegate-event")) return { event };
      if (path.endsWith("/events/root-input")) return { event: x.root };
      if (path === "/api/sessions/child-session/threads/child-thread")
        return {
          snapshot: {
            thread: {
              id: "child-thread",
              session_id: record.child_session_id,
              context_id: record.child_context_id,
              initiating_principal_id: owner,
            },
          },
        };
      throw new Error(`Unexpected ${path}`);
    };
    await assert.rejects(
      x.f.session().executionControl({
        scope,
        action: {
          type: "cancel-thread",
          threadId: "child-thread",
          revision: 1,
        },
      }),
    );
    assert.equal(writes.length, 0);
    const receipt = await x.f
      .session()
      .executionControl({ scope, action: { type: "cancel-delegation" } });
    assert.deepEqual(receipt, { accepted: true, status: "cancelled" });
    assert.deepEqual(writes, ["/api/delegations/delegate/cancel"]);
  } finally {
    await x.f.close();
  }
});
