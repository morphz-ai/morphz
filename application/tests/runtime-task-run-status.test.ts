import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { localAccess } from "../packages/core/src/model.js";
import { RuntimeBridge } from "../packages/application/src/runtime.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import {
  RuntimeTaskRunStatusError,
  RuntimeTaskRunStatusReader,
} from "../packages/application/src/runtime-task-run-status.js";

const runtime = {
  sessionId: "session-one",
  scheduleId: "schedule-one",
  threadId: "thread-one",
};
const schedule = {
  id: runtime.scheduleId,
  thread_id: runtime.threadId,
  revision: 3,
  status: "completed",
  not_before: null,
  interval_seconds: null,
};
const thread = {
  thread_id: runtime.threadId,
  session_id: runtime.sessionId,
  root_turn_id: "client-schedule-schedule-one",
  revision: 4,
  lifecycle: "completed",
};

test("exact Runtime Schedule and Thread are sampled separately from Platform history", async () => {
  const paths: string[] = [];
  const reader = new RuntimeTaskRunStatusReader(
    async (path, access) => {
      assert.deepEqual(access, localAccess);
      paths.push(path);
      return path.endsWith("/thread") ? thread : schedule;
    },
    () => "2026-09-26T00:00:00.000Z",
  );
  assert.deepEqual(await reader.inspect(runtime, localAccess), {
    source: "runtime",
    runtime,
    sampledAt: "2026-09-26T00:00:00.000Z",
    schedule: {
      revision: 3,
      status: "completed",
      notBefore: null,
      intervalSeconds: null,
    },
    thread: { revision: 4, lifecycle: "completed" },
  });
  assert.deepEqual(paths, [
    "/api/sessions/session-one/schedules/schedule-one",
    "/api/sessions/session-one/turns/client-schedule-schedule-one/thread",
  ]);
});

test("Runtime status fails closed on missing or inconsistent execution identity", async () => {
  for (const [bad, reason] of [
    [{ ...schedule, thread_id: "other-thread" }, "mismatch"],
    [{ ...schedule, revision: 0 }, "mismatch"],
  ] as const) {
    const reader = new RuntimeTaskRunStatusReader(async () => bad);
    await assert.rejects(
      reader.inspect(runtime, localAccess),
      (error: unknown) =>
        error instanceof RuntimeTaskRunStatusError && error.reason === reason,
    );
  }
  const wrongThread = new RuntimeTaskRunStatusReader(async (path) =>
    path.endsWith("/thread")
      ? { ...thread, session_id: "another-session" }
      : schedule,
  );
  await assert.rejects(
    wrongThread.inspect(runtime, localAccess),
    (error: unknown) =>
      error instanceof RuntimeTaskRunStatusError && error.reason === "mismatch",
  );
  const unavailable = new RuntimeTaskRunStatusReader(async () => {
    throw new Error("Runtime offline or permission denied");
  });
  await assert.rejects(
    unavailable.inspect(runtime, localAccess),
    (error: unknown) =>
      error instanceof RuntimeTaskRunStatusError &&
      error.reason === "unavailable" &&
      !error.message.includes("permission denied"),
  );
  const forbidden = new RuntimeTaskRunStatusReader(async () => {
    throw Object.assign(new Error("secret Runtime response"), { status: 403 });
  });
  await assert.rejects(
    forbidden.inspect(runtime, localAccess),
    (error: unknown) =>
      error instanceof RuntimeTaskRunStatusError &&
      error.reason === "forbidden" &&
      !error.message.includes("secret"),
  );
  let calls = 0;
  const invalidRef = new RuntimeTaskRunStatusReader(async () => {
    calls++;
    return schedule;
  });
  await assert.rejects(
    invalidRef.inspect({ ...runtime, sessionId: "../../other" }, localAccess),
    (error: unknown) =>
      error instanceof RuntimeTaskRunStatusError && error.reason === "mismatch",
  );
  assert.equal(calls, 0);
});

test("configured local Runtime bridge reads exact status without treating a migrated Session as a legacy project", async () => {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer test-runtime-token");
    paths.push(request.url ?? "");
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify(request.url?.endsWith("/thread") ? thread : schedule),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  const namespace = randomUUID();
  const store = new WorkspaceStore(":memory:");
  try {
    store.saveRuntimeState({
      namespace,
      endpoint: origin,
      connected: false,
      model: "",
      error: "",
      sessions: {
        "session-one": {
          id: "session-one",
          projectId: "legacy-project-no-longer-owned",
          artifactId: null,
          cursor: 0,
          events: [],
        },
      },
      deliveries: [],
    });
    const bridge = new RuntimeBridge(
      store,
      { url: origin, token: "test-runtime-token", namespace },
      undefined,
      false,
    );
    const live = await bridge
      .taskRunStatusReader()
      .inspect(runtime, localAccess);
    assert.equal(live.schedule.status, "completed");
    assert.equal(live.thread.lifecycle, "completed");
    assert.deepEqual(paths, [
      "/api/sessions/session-one/schedules/schedule-one",
      "/api/sessions/session-one/turns/client-schedule-schedule-one/thread",
    ]);
  } finally {
    store.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("project retirement refuses unproved message dispatch and verifies exact Runtime roots", async () => {
  let lifecycle: "open" | "completed" = "completed";
  let wrongRoot = false;
  let unavailable = false;
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    response.setHeader("Content-Type", "application/json");
    response.statusCode = unavailable ? 503 : 200;
    response.end(JSON.stringify(unavailable ? { error: "unavailable" } : {
      session_id: "session-one",
      root_turn_id: wrongRoot ? "other-root" : "root-one",
      lifecycle,
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const source = {
    projectId: "project-one",
    conversationId: "project-one",
    targetActantId: "morphz-agent",
    author: localAccess,
    createdAt: "2026-09-27T00:00:00.000Z",
    sharedDefault: true,
  };
  const delivery = {
    inputId: "input-one",
    sessionId: "session-one",
    rootId: null as string | null,
    state: "failed",
    error: "dispatch failed",
    retryable: false,
    cancelRequested: false,
    request: {},
    platformSource: source,
  };
  const check = async (raw: object) => {
    const store = new WorkspaceStore(":memory:");
    try {
      const namespace = randomUUID();
      store.saveRuntimeState({
        namespace, endpoint: origin, connected: false, model: "", error: "",
        sessions: {}, deliveries: [raw],
      });
      return await new RuntimeBridge(
        store, { url: origin, token: "test-runtime-token", namespace },
        undefined, false,
      ).assertProjectInputsSettled("project-one");
    } finally {
      store.close();
    }
  };
  try {
    await check({ ...delivery, runtimePostAttempted: false });
    await assert.rejects(check(delivery), /发送结果尚未确认/);
    await assert.rejects(check({ ...delivery, runtimePostAttempted: true }), /发送结果尚未确认/);
    await assert.rejects(check({ ...delivery, state: "queued", runtimePostAttempted: false }), /正在处理/);
    await assert.rejects(check({ ...delivery, platformSource: undefined, state: "running" }), /来源未确认/);
    const accepted = { ...delivery, state: "completed", rootId: "root-one", runtimePostAttempted: true };
    await check(accepted);
    assert.deepEqual(paths, ["/api/sessions/session-one/turns/root-one/thread"]);
    lifecycle = "open";
    await assert.rejects(check(accepted), /仍在执行/);
    lifecycle = "completed";
    wrongRoot = true;
    await assert.rejects(check(accepted), /状态不明确/);
    wrongRoot = false;
    unavailable = true;
    await assert.rejects(check(accepted), /暂时无法确认/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
