import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { Pool } from "pg";
import { Application } from "../packages/application/src/application.js";
import { HumanPlatformAuthority } from "../packages/application/src/human-platform-authority.js";
import { ExecutionControls } from "../packages/application/src/execution.js";
import { RuntimeTaskRunStatusReader } from "../packages/application/src/runtime-task-run-status.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { createAppServer } from "../apps/service/src/http.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { taskRuntimeSchema } from "../packages/core/src/task-runtime.js";
import type { RuntimeBridge } from "../packages/application/src/runtime.js";
import { localAccess } from "../packages/core/src/model.js";
import {
  PlatformStore,
  type PlatformAuthorityVerifier,
} from "../packages/platform/src/store.js";

const noOtherAuthority: PlatformAuthorityVerifier = {
  async resolveActor() {
    return null;
  },
  async resolveActant() {
    return null;
  },
  async resolveProjectAgent() {
    return null;
  },
  async verifyApplicationObject() {
    return false;
  },
};

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("事项执行历史共用 Desktop 本机与 Web HTTP 业务入口，旧执行快照不冒充新权威", async () => {
  const workspace = new WorkspaceStore(":memory:", { mode: "transport" });
  let humanValid = true;
  const human = new HumanPlatformAuthority(
    "run-history-tenant",
    (access) =>
      humanValid &&
      access.principalId === localAccess.principalId &&
      access.actantId === localAccess.actantId,
  );
  const platform = await PlatformStore.sqlite(
    ":memory:",
    human.verifier({
      ...noOtherAuthority,
      async resolveActant({ actantId }) {
        if (actantId === localAccess.actantId)
          return { principalId: localAccess.principalId, kind: "human" };
        if (actantId === "morphz-agent")
          return { principalId: "morphz-service", kind: "agent" };
        return null;
      },
      async resolveProjectAgent() {
        return { principalId: "morphz-service", actantId: "morphz-agent" };
      },
    }),
  );
  try {
    const taskId = randomUUID();
    await platform.provisionTenant("run-history-tenant");
    const admission = await human.withSession(
      localAccess,
      () => {},
      async (actor) => {
        await platform.createProject(actor, {
          commandId: randomUUID(),
          projectId: "first-project",
          title: "执行历史",
        });
        await platform.createTask(actor, {
          commandId: randomUUID(),
          taskId,
          projectId: "first-project",
          title: "有历史运行的事项",
          assigneeId: "morphz-agent",
          description: "核对执行路径",
        });
        return platform.requestTaskRun(actor, {
          commandId: randomUUID(),
          taskId,
          expectedRevision: 1,
          sessionId: "session-one",
          intent: "处理原始请求",
          notBefore: "2026-09-26T00:00:00.000Z",
          reasoningEffort: "high",
        });
      },
    );
    await platform.confirmTaskRun("run-history-tenant", admission.eventId, {
      schedule: {
        id: admission.request.id,
        thread_id: "thread-one",
        revision: 2,
        status: "dispatched",
        not_before: null,
        interval_seconds: null,
      },
      thread: {
        thread_id: "thread-one",
        session_id: "session-one",
        root_turn_id: `client-schedule-${admission.request.id}`,
        lifecycle: "completed",
      },
    });
    const unavailable = new LocalApplicationConnection(
      new Application(workspace),
    );
    const unavailableBoot = (await unavailable.call("platform.bootstrap")) as {
      csrfToken: string;
    };
    await assert.rejects(
      unavailable.call(
        "task.run-history",
        { taskId },
        {
          identityGeneration: unavailableBoot.csrfToken,
        },
      ),
      (error: unknown) =>
        error instanceof Error && "status" in error && error.status === 503,
    );
    unavailable.close();
    const runtimePaths: string[] = [];
    let revokeDuringRead = false;
    const domain = {
      authority: human,
      store: platform,
      runtimeStatus: new RuntimeTaskRunStatusReader(
        async (path) => {
          runtimePaths.push(path);
          if (path.endsWith("/thread") && revokeDuringRead) humanValid = false;
          return path.endsWith("/thread")
            ? {
                thread_id: "thread-one",
                session_id: "session-one",
                root_turn_id: `client-schedule-${admission.request.id}`,
                revision: 4,
                lifecycle: "completed",
              }
            : {
                id: admission.request.id,
                thread_id: "thread-one",
                revision: 5,
                status: "completed",
                not_before: null,
                interval_seconds: null,
              };
        },
        () => "2026-09-26T00:00:00.000Z",
      ),
    };
    const local = new LocalApplicationConnection(
      new Application(workspace, { platformTaskRuns: domain }),
    );
    const boot = (await local.call("platform.bootstrap")) as {
      csrfToken: string;
    };
    const params = { taskId, limit: 1 };
    const options = { identityGeneration: boot.csrfToken };
    const history = (await local.call("task.run-history", params, {
      ...options,
    })) as Array<{
      runtime: { scheduleId: string; threadId: string };
      observed: { scheduleStatus: string };
    }>;
    assert.equal(history.length, 1);
    assert.deepEqual(history[0]!.runtime, {
      sessionId: "session-one",
      scheduleId: admission.request.id,
      threadId: "thread-one",
    });
    assert.equal(history[0]!.observed.scheduleStatus, "dispatched");
    const live = (await local.call(
      "task.run-status",
      { taskId, runNumber: 1 },
      options,
    )) as {
      source: string;
      schedule: { status: string };
      thread: { lifecycle: string };
    };
    assert.equal(live.source, "runtime");
    assert.equal(live.schedule.status, "completed");
    assert.equal(live.thread.lifecycle, "completed");
    assert.equal(runtimePaths.length, 2);
    revokeDuringRead = true;
    await assert.rejects(
      local.call("task.run-status", { taskId, runNumber: 1 }, options),
      (error: unknown) =>
        error instanceof Error && "status" in error && error.status === 403,
    );
    humanValid = true;
    revokeDuringRead = false;
    assert.equal(runtimePaths.length, 4);
    await assert.rejects(
      local.call("task.run-status", { taskId, runNumber: 2 }, options),
      /不存在/,
    );
    await assert.rejects(
      local.call(
        "task.run-status",
        { taskId, runNumber: 1 },
        {
          identityGeneration: "stale",
        },
      ),
      /身份已切换/,
    );
    assert.equal(runtimePaths.length, 4);
    assert.deepEqual(
      await local.call("task.run-history", { taskId, beforeRun: 1 }, options),
      [],
    );
    await assert.rejects(
      local.call(
        "task.run-history",
        { ...params, credential: "forged" },
        options,
      ),
      /请求格式无效/,
    );
    await assert.rejects(
      local.call("task.run-history", params, {
        identityGeneration: "stale",
      }),
      /身份已切换/,
    );
    const taskSnapshot = (await local.call(
      "task.snapshot",
      taskId,
      options,
    )) as {
      runs: Array<{
        run: number;
        record: { status: string; thread_id: string };
        threadState: string;
      }>;
    };
    assert.equal(taskSnapshot.runs.length, 1);
    assert.equal(taskSnapshot.runs[0]!.run, 1);
    assert.equal(taskSnapshot.runs[0]!.record.status, "completed");
    assert.equal(taskSnapshot.runs[0]!.record.thread_id, "thread-one");
    assert.equal(taskSnapshot.runs[0]!.threadState, "completed");

    const executionRefs: string[] = [];
    const runtime = {
      platformTaskExecutionControls: async (
        projectId: string,
        ref: { threadId: string },
      ) => {
        executionRefs.push(`${projectId}:${ref.threadId}`);
        return {
          snapshot: async () => ({ jobs: [], approvals: [], limit: 100 }),
          result: async () => ({
            text: "",
            truncated: false,
            available: false,
          }),
          control: async () => ({ accepted: true }),
        };
      },
    } as unknown as RuntimeBridge;
    const executionScope = {
      projectId: "first-project",
      artifactId: taskId,
      threadId: "thread-one",
      taskRun: true,
    };
    const executionLocal = new LocalApplicationConnection(
      new Application(workspace, { runtime, platformTaskRuns: domain }),
    );
    const executionBoot = (await executionLocal.call("platform.bootstrap")) as {
      csrfToken: string;
    };
    const executionOptions = { identityGeneration: executionBoot.csrfToken };
    assert.deepEqual(
      await executionLocal.call(
        "execution.snapshot",
        executionScope,
        executionOptions,
      ),
      { jobs: [], approvals: [], limit: 100 },
    );
    assert.deepEqual(executionRefs, ["first-project:thread-one"]);
    await assert.rejects(
      executionLocal.call(
        "execution.snapshot",
        {
          ...executionScope,
          threadId: "forged-thread",
        },
        executionOptions,
      ),
      /执行记录不存在/,
    );
    executionLocal.close();

    const port = await freePort();
    const server = createAppServer(workspace, {
      port,
      webRoot: "/nonexistent",
      platformTaskRuns: domain,
      runtime,
    });
    await new Promise<void>((resolve) =>
      server.listen(port, "127.0.0.1", resolve),
    );
    try {
      const remote = new HttpApplicationClient(`http://127.0.0.1:${port}`);
      assert.deepEqual(await remote.call("task.run-history", params), history);
      assert.deepEqual(
        await remote.call("task.run-status", { taskId, runNumber: 1 }),
        live,
      );
      assert.deepEqual(
        await remote.call("task.snapshot", taskId),
        taskSnapshot,
      );
      assert.deepEqual(
        await remote.call("execution.snapshot", executionScope),
        { jobs: [], approvals: [], limit: 100 },
      );
      assert.deepEqual(
        await remote.call("task.run-history", { taskId, beforeRun: 1 }),
        [],
      );
      await assert.rejects(
        remote.call("task.run-history", { taskId, limit: 51 }),
        /请求格式无效/,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    local.close();
  } finally {
    await platform.close();
    workspace.close();
  }
});

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `正式 ${backend} 事项审批数量使用真实领域记录与精确 Runtime 作用域，失联不伪装零，撤权不泄露`,
    {
      skip: backend === "postgres" && !process.env.MORPHZ_TEST_POSTGRES_URL,
    },
    async () => {
      const tenantId = randomUUID();
      let humanValid = true;
      const authority = new HumanPlatformAuthority(tenantId, () => humanValid);
      const verifier = authority.verifier({
        ...noOtherAuthority,
        resolveActant: async ({ tenantId: scope, actantId }) =>
          scope !== tenantId
            ? null
            : actantId === localAccess.actantId
              ? { principalId: localAccess.principalId, kind: "human" as const }
              : actantId === "morphz-agent"
                ? { principalId: "morphz-service", kind: "agent" as const }
                : null,
        resolveProjectAgent: async ({ tenantId: scope }) =>
          scope === tenantId
            ? { principalId: "morphz-service", actantId: "morphz-agent" }
            : null,
      });
      const schema = `task_approval_${randomUUID().replaceAll("-", "")}`;
      const pg =
        backend === "postgres"
          ? new Pool({
              connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
            })
          : null;
      if (pg) await pg.query(`CREATE SCHEMA "${schema}"`);
      const platform =
        backend === "sqlite"
          ? await PlatformStore.sqlite(":memory:", verifier)
          : await PlatformStore.postgres(
              {
                connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
                schema,
              },
              verifier,
            );
      const transport = new WorkspaceStore(":memory:", { mode: "transport" });
      const taskId = randomUUID();
      const paths: string[] = [];
      let offline = false;
      let statusOffline = false;
      let revokeDuringRead = false;
      let pending = true;
      try {
        await platform.provisionTenant(tenantId);
        const admission = await authority.withSession(
          localAccess,
          () => {},
          async (actor) => {
            await platform.createProject(actor, {
              commandId: randomUUID(),
              projectId: "project-one",
              title: "审批状态验收",
            });
            await platform.createTask(actor, {
              commandId: randomUUID(),
              taskId,
              projectId: "project-one",
              title: "核对审批",
              assigneeId: "morphz-agent",
            });
            return platform.requestTaskRun(actor, {
              commandId: randomUUID(),
              taskId,
              expectedRevision: 1,
              sessionId: "session-one",
              intent: "核对审批",
              notBefore: "2026-09-30T00:00:00.000Z",
            });
          },
        );
        await platform.confirmTaskRun(tenantId, admission.eventId, {
          schedule: {
            id: admission.request.id,
            thread_id: "thread-one",
            revision: 1,
            status: "dispatched",
            not_before: null,
            interval_seconds: null,
          },
          thread: {
            thread_id: "thread-one",
            session_id: admission.sessionId,
            root_turn_id: `client-schedule-${admission.request.id}`,
            lifecycle: "open",
          },
        });
        const runtime = {
          platformTaskExecutionControls: async (
            projectId: string,
            ref: { sessionId: string; threadId: string; scheduleId: string },
          ) => {
            assert.equal(projectId, "project-one");
            assert.deepEqual(ref, {
              sessionId: admission.sessionId,
              threadId: "thread-one",
              scheduleId: admission.request.id,
            });
            const binding = {
              sessionId: admission.sessionId,
              contextId: "context-one",
              threadId: "thread-one",
              rootId: `client-schedule-${admission.request.id}`,
            };
            return new ExecutionControls(
              async (path, method) => {
                assert.equal(path, "/api/approvals");
                assert.equal(method, undefined);
                paths.push(path);
                if (offline)
                  throw new Error(
                    "private upstream detail must not reach Client",
                  );
                if (revokeDuringRead) humanValid = false;
                const approval = {
                  requested_at: "2026-09-30T00:00:00.000Z",
                  request: {
                    approval_id: "approval-one",
                    session_id: binding.sessionId,
                    context_id: binding.contextId,
                    root_turn_id: binding.rootId,
                    thread_id: binding.threadId,
                    justification: "一次文件写入",
                    action: {},
                    requested: {},
                  },
                };
                return {
                  approvals: pending
                    ? [
                        approval,
                        ...[
                          { session_id: "other-session" },
                          { context_id: "other-context" },
                          { root_turn_id: "other-root" },
                          { thread_id: "other-thread" },
                        ].map((change) => ({
                          ...approval,
                          request: { ...approval.request, ...change },
                        })),
                      ]
                    : [],
                };
              },
              () => binding,
            );
          },
        } as unknown as RuntimeBridge;
        const local = new LocalApplicationConnection(
          new Application(transport, {
            runtime,
            platformTaskRuns: {
              authority,
              store: platform,
              runtimeStatus: new RuntimeTaskRunStatusReader(async (path) => {
                if (statusOffline) throw new Error("Runtime offline");
                return path.endsWith("/thread")
                  ? {
                      thread_id: "thread-one",
                      session_id: admission.sessionId,
                      root_turn_id: `client-schedule-${admission.request.id}`,
                      revision: 1,
                      lifecycle: "open",
                    }
                  : {
                      id: admission.request.id,
                      thread_id: "thread-one",
                      revision: 1,
                      status: "dispatched",
                      not_before: null,
                      interval_seconds: null,
                    };
              }),
            },
          }),
        );
        try {
          const { csrfToken } = (await local.call("platform.bootstrap")) as {
            csrfToken: string;
          };
          const options = { identityGeneration: csrfToken };
          const read = async () =>
            taskRuntimeSchema.parse(
              await local.call("task.snapshot", taskId, options),
            );
          const first = await read();
          assert.equal(first.approvalCount, 1);
          assert.equal(first.runs[0]!.threadState, "open");
          assert.equal(first.error, "");
          pending = false;
          assert.equal((await read()).approvalCount, 0);
          offline = true;
          const unknown = await read();
          assert.equal(unknown.approvalCount, undefined);
          assert.match(unknown.error, /暂时无法确认/);
          assert.ok(!JSON.stringify(unknown).includes("private upstream"));
          statusOffline = true;
          const unavailable = await read();
          assert.equal(unavailable.approvalCount, undefined);
          assert.ok(unavailable.error);
          assert.equal(paths.length, 3, "状态失联后不读取未验证作用域的审批");
          offline = false;
          statusOffline = false;
          revokeDuringRead = true;
          await assert.rejects(
            read(),
            (error: unknown) =>
              error instanceof Error &&
              "status" in error &&
              error.status === 403,
          );
        } finally {
          local.close();
        }
      } finally {
        await platform.close();
        transport.close();
        if (backend === "postgres") {
          try {
            await pg!.query(`DROP SCHEMA "${schema}" CASCADE`);
          } finally {
            await pg!.end();
          }
        }
      }
    },
  );
}
