import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PlatformStore,
  type PlatformAuthorityVerifier,
} from "../packages/platform/src/store.js";
import { PlatformTaskRunDispatcher } from "../packages/application/src/platform-task-run-dispatcher.js";
import { RuntimeBridge } from "../packages/application/src/runtime.js";
import { WorkspaceStore } from "../packages/application/src/store.js";

const tenantId = "task-dispatch-tenant";
const human = { credential: "human" };
const verifier: PlatformAuthorityVerifier = {
  async resolveActor({ credential }) {
    return credential === "human"
      ? {
          tenantId,
          principalId: "alice",
          actantId: "alice",
          kind: "human" as const,
          runtimeInputId: null,
        }
      : null;
  },
  async resolveActant({ actantId }) {
    if (actantId === "alice")
      return { principalId: "alice", kind: "human" as const };
    if (actantId === "agent-one")
      return { principalId: "morphz-service", kind: "agent" as const };
    return null;
  },
  async resolveProjectAgent() {
    return { principalId: "morphz-service", actantId: "agent-one" };
  },
  async verifyApplicationObject() {
    return false;
  },
};

async function createAdmission(
  platform: PlatformStore,
  taskId: string,
  sessionId = "session-one",
) {
  await platform.createTask(human, {
    commandId: `create-${taskId}`,
    taskId,
    projectId: "project-one",
    title: taskId,
    assigneeId: "agent-one",
  });
  return platform.requestTaskRun(human, {
    commandId: `start-${taskId}`,
    taskId,
    expectedRevision: 1,
    sessionId,
    intent: `执行 ${taskId}`,
    notBefore: "2026-09-26T12:00:00.000Z",
  });
}

test("Platform pending admissions use a stable cursor even after an earlier event is confirmed", async () => {
  const platform = await PlatformStore.sqlite(":memory:", verifier);
  try {
    await platform.provisionTenant(tenantId);
    await platform.createProject(human, {
      commandId: "create-project",
      projectId: "project-one",
      title: "工作",
    });
    const first = await createAdmission(platform, "task-one");
    const second = await createAdmission(platform, "task-two");
    assert.deepEqual(await platform.pendingTaskRuns(tenantId, 1), [first]);
    assert.deepEqual(
      await platform.pendingTaskRuns(tenantId, 1, first.eventId),
      [second],
    );
    assert.deepEqual(
      await platform.pendingTaskRuns(tenantId, 1, second.eventId),
      [],
    );
    await assert.rejects(
      platform.pendingTaskRuns(tenantId, 1, "missing-event"),
      /游标不存在/,
    );
    await platform.confirmTaskRun(tenantId, first.eventId, {
      schedule: {
        id: first.request.id,
        thread_id: "first-thread",
        revision: 1,
        status: "queued",
        not_before: first.request.not_before,
        interval_seconds: null,
      },
      thread: {
        thread_id: "first-thread",
        session_id: first.sessionId,
        root_turn_id: `client-schedule-${first.request.id}`,
        lifecycle: "open",
      },
    });
    assert.deepEqual(
      await platform.pendingTaskRuns(tenantId, 1, first.eventId),
      [second],
    );
  } finally {
    await platform.close();
  }
});

test("a pre-receipt stop survives Platform restart and binds only to its admitted run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-task-stop-"));
  const filename = join(directory, "platform.sqlite");
  let platform: PlatformStore | undefined;
  try {
    platform = await PlatformStore.sqlite(filename, verifier);
    await platform.provisionTenant(tenantId);
    await platform.createProject(human, {
      commandId: "create-project",
      projectId: "project-one",
      title: "工作",
    });
    const admission = await createAdmission(platform, "task-one");
    await platform.reviseTask(human, {
      commandId: "retitle-task-one",
      taskId: admission.taskId,
      expectedRevision: admission.taskRevision,
      title: "修改后的事项名称",
    });
    await platform.requestTaskRunStop(
      human,
      admission.taskId,
      admission.runNumber,
      1,
    );
    assert.deepEqual(
      await platform.taskRunPendingStop(human, admission.taskId),
      {
        runNumber: 1,
        taskRevision: admission.taskRevision,
      },
    );
    await platform.close();
    platform = await PlatformStore.sqlite(filename, verifier);
    await platform.confirmTaskRun(tenantId, admission.eventId, {
      schedule: {
        id: admission.request.id,
        thread_id: "thread-one",
        revision: 1,
        status: "queued",
        not_before: admission.request.not_before,
        interval_seconds: null,
      },
      thread: {
        thread_id: "thread-one",
        session_id: admission.sessionId,
        root_turn_id: `client-schedule-${admission.request.id}`,
        lifecycle: "open",
      },
    });
    assert.equal(
      await platform.taskRunPendingStop(human, admission.taskId),
      null,
    );
    const [stop] = await platform.pendingTaskRunStops(tenantId);
    assert.equal(stop?.taskId, admission.taskId);
    assert.equal(stop?.runNumber, admission.runNumber);
    assert.equal(stop?.runtime.scheduleId, admission.request.id);
    await platform.requestTaskRunStop(
      human,
      admission.taskId,
      admission.runNumber,
      1,
    );
    assert.equal((await platform.pendingTaskRunStops(tenantId)).length, 1);
  } finally {
    await platform?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a blocked first page cannot starve later persisted task requests", async () => {
  const platform = await PlatformStore.sqlite(":memory:", verifier);
  try {
    await platform.provisionTenant(tenantId);
    await platform.createProject(human, {
      commandId: "create-project",
      projectId: "project-one",
      title: "工作",
    });
    for (let index = 0; index < 51; index++)
      await createAdmission(platform, `task-${index}`);
    const pending = await platform.pendingTaskRuns(tenantId, 100);
    assert.equal(pending.length, 51);
    const tail = pending[50]!;
    const failures: string[] = [];
    const delivered: string[] = [];
    const dispatcher = new PlatformTaskRunDispatcher(
      platform,
      tenantId,
      {
        async stopPlatformTaskRun() {
          throw new Error("这个测试没有停止请求");
        },
        async controlPlatformTaskRunSchedule() {
          throw new Error("这个测试没有安排控制请求");
        },
        async deliverTaskRun(admission) {
          if (admission.eventId !== tail.eventId)
            throw new Error("Runtime 暂不可用");
          delivered.push(admission.eventId);
          return {
            schedule: {
              id: admission.request.id,
              thread_id: "tail-thread",
              revision: 1,
              status: "queued",
              not_before: admission.request.not_before,
              interval_seconds: null,
            },
            thread: {
              thread_id: "tail-thread",
              session_id: admission.sessionId,
              root_turn_id: `client-schedule-${admission.request.id}`,
              lifecycle: "open",
            },
          };
        },
      },
      async () => ({ principalId: "alice", actantId: "alice" }),
      (admission) =>
        platform.prepareTaskRun(human, admission.eventId, async () => {
          throw new Error("无依赖不应查询 Runtime");
        }),
      (_error, eventId) => failures.push(eventId!),
    );
    await dispatcher.drain();
    assert.equal(failures.length, 50);
    assert.deepEqual(delivered, []);
    await dispatcher.drain();
    assert.deepEqual(delivered, [tail.eventId]);
    assert.equal((await platform.pendingTaskRuns(tenantId, 100)).length, 50);
    assert.equal(
      (await platform.listTaskRunLinks(human, tail.taskId)).length,
      1,
    );
  } finally {
    await platform.close();
  }
});

test("Desktop Host retries the same persisted Runtime Schedule after a lost acknowledgement and restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-task-dispatch-"));
  const filename = join(directory, "platform.sqlite");
  const namespace = randomUUID();
  const posted: unknown[] = [];
  let failFirstPost = true;
  const runtimeServer = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer test-runtime-token");
    const path = request.url ?? "";
    if (request.method === "GET" && path === "/api/sessions/session-one") {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          id: "session-one",
          context_id: `mw-context-${namespace}`,
        }),
      );
      return;
    }
    if (request.method === "GET" && path === "/api/sessions/session-mismatch") {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          id: "session-mismatch",
          context_id: "another-project-context",
        }),
      );
      return;
    }
    if (
      request.method === "POST" &&
      path === "/api/sessions/session-one/schedules"
    ) {
      let body = "";
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body) as { id: string; not_before: string };
      posted.push(payload);
      if (failFirstPost) {
        failFirstPost = false;
        response.destroy();
        return;
      }
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          id: payload.id,
          thread_id: "runtime-thread-one",
          source_turn_id: `client-schedule-${payload.id}`,
          revision: 1,
          status: "queued",
          not_before: payload.not_before,
          interval_seconds: null,
        }),
      );
      return;
    }
    if (
      request.method === "GET" &&
      path.startsWith("/api/sessions/session-one/turns/client-schedule-") &&
      path.endsWith("/thread")
    ) {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          thread_id: "runtime-thread-one",
          session_id: "session-one",
          root_turn_id: path.split("/")[5],
          lifecycle: "open",
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) =>
    runtimeServer.listen(0, "127.0.0.1", resolve),
  );
  const port = (runtimeServer.address() as { port: number }).port;
  const workspace = new WorkspaceStore(":memory:");
  const runtime = new RuntimeBridge(
    workspace,
    {
      url: `http://127.0.0.1:${port}`,
      token: "test-runtime-token",
      namespace,
    },
    undefined,
    false,
  );
  let platform: PlatformStore | undefined;
  const failures: string[] = [];
  try {
    platform = await PlatformStore.sqlite(filename, verifier);
    await platform.provisionTenant(tenantId);
    await platform.createProject(human, {
      commandId: "create-project",
      projectId: "project-one",
      title: "工作",
    });
    const admission = await createAdmission(platform, "task-one");
    const dispatcher = (store: PlatformStore) =>
      new PlatformTaskRunDispatcher(
        store,
        tenantId,
        runtime,
        async () => ({ principalId: "alice", actantId: "alice" }),
        (admission) =>
          store.prepareTaskRun(human, admission.eventId, async () => {
            throw new Error("无依赖不应查询 Runtime");
          }),
        (_error, eventId) => failures.push(eventId ?? "queue"),
      );
    await dispatcher(platform).drain();
    assert.deepEqual(await platform.pendingTaskRuns(tenantId), [admission]);
    assert.deepEqual(failures, [admission.eventId]);
    await platform.close();
    platform = await PlatformStore.sqlite(filename, verifier);
    await dispatcher(platform).drain();
    assert.deepEqual(await platform.pendingTaskRuns(tenantId), []);
    assert.deepEqual(posted, [admission.request, admission.request]);
    const links = await platform.listTaskRunLinks(human, admission.taskId);
    assert.equal(links.length, 1);
    assert.equal(links[0]!.runtime.threadId, "runtime-thread-one");
    const wrongSession = await createAdmission(
      platform,
      "task-two",
      "session-mismatch",
    );
    await dispatcher(platform).drain();
    assert.deepEqual(await platform.pendingTaskRuns(tenantId), [wrongSession]);
    assert.deepEqual(posted, [admission.request, admission.request]);
    assert.deepEqual(failures, [admission.eventId, wrongSession.eventId]);
  } finally {
    await platform?.close();
    workspace.close();
    await new Promise<void>((resolve) => runtimeServer.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
