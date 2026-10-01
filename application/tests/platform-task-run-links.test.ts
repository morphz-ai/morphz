import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import {
  PlatformStore,
  type PlatformAuthorityVerifier,
  type TaskRunLink,
} from "../packages/platform/src/store.js";
import type {
  TaskRunAdmission,
  TaskRunRuntimeReceipt,
} from "../packages/platform/src/task-run-admission.js";

const tenantId = "task-run-tenant";
const owner = { credential: "owner" };
const postgresUrl = process.env.MORPHZ_TEST_POSTGRES_URL;
const authority: PlatformAuthorityVerifier = {
  async resolveActor({ credential }) {
    if (credential === "owner" || credential === "outsider")
      return {
        tenantId,
        principalId: credential === "owner" ? "local-owner" : "outsider",
        actantId: "local-human",
        kind: "human",
        runtimeInputId: null,
      };
    if (credential === "agent" || credential === "wrong-scope")
      return {
        tenantId,
        principalId: "local-owner",
        actantId: "morphz-agent",
        kind: "agent",
        runtimeInputId: "input-one",
        scopeProjectId:
          credential === "agent" ? "first-project" : "other-project",
        initiatingHumanActantId: "local-human",
      };
    if (credential === "other-tenant")
      return {
        tenantId: "other-tenant",
        principalId: "local-owner",
        actantId: "local-human",
        kind: "human",
        runtimeInputId: null,
      };
    return null;
  },
  async resolveActant({ tenantId: scope, actantId }) {
    if (scope !== tenantId) return null;
    if (actantId === "morphz-agent")
      return { principalId: "morphz-service", kind: "agent" };
    if (actantId === "local-human")
      return { principalId: "local-owner", kind: "human" };
    return null;
  },
  async resolveProjectAgent({ tenantId: scope }) {
    return scope === tenantId
      ? { principalId: "morphz-service", actantId: "morphz-agent" }
      : null;
  },
  async verifyApplicationObject(request) {
    return (
      request.instanceId === "objects-one" && request.proof === "app-proof"
    );
  },
};

/** Controlled Runtime receipts exercise Platform's real write contract.
 * Real Runtime dispatch is verified separately; no old workspace is imported. */
function receipt(
  admission: TaskRunAdmission,
  threadId: string,
): TaskRunRuntimeReceipt {
  return {
    schedule: {
      id: admission.request.id,
      thread_id: threadId,
      revision: 3,
      status: "completed",
      not_before: null,
      interval_seconds: null,
    },
    thread: {
      thread_id: threadId,
      session_id: admission.sessionId,
      root_turn_id: `client-schedule-${admission.request.id}`,
      lifecycle: "completed",
    },
  };
}
function observation(runtime: TaskRunLink["runtime"]) {
  return {
    source: "runtime" as const,
    runtime,
    schedule: { status: "completed" },
    thread: { lifecycle: "completed" },
  };
}

async function fixture(backend: "sqlite" | "postgres") {
  const directory = mkdtempSync(join(tmpdir(), "morphz-task-run-links-"));
  const schema = `task_run_${randomUUID().replaceAll("-", "")}`;
  const admin =
    backend === "postgres" ? new Pool({ connectionString: postgresUrl }) : null;
  let store: PlatformStore | undefined;
  const open = () =>
    backend === "sqlite"
      ? PlatformStore.sqlite(join(directory, "platform.sqlite"), authority)
      : PlatformStore.postgres(
          { connectionString: postgresUrl!, schema },
          authority,
        );
  try {
    if (admin) await admin.query(`CREATE SCHEMA "${schema}"`);
    store = await open();
    await store.provisionTenant(tenantId);
    await store.createProject(owner, {
      commandId: "create-project",
      projectId: "first-project",
      title: "执行历史",
    });
    await store.registerApplication(tenantId, {
      appId: "morphz.objects",
      installationId: "objects-installation",
      instanceId: "objects-one",
      routeKind: "service",
      routeRef: "fixture://objects",
    });
    await store.recordContent(
      owner,
      { instanceId: "objects-one", proof: "app-proof" },
      {
        commandId: "source-one",
        appReceiptId: "source-one-receipt",
        contentId: "source-one",
        objectId: "source-one",
        projectId: "first-project",
        title: "关注的原件",
        kind: "document",
        observedVersionRef: "1",
      },
    );
    for (const taskId of ["dependency-task", "task-one"])
      await store.createTask(owner, {
        commandId: `create-${taskId}`,
        taskId,
        projectId: "first-project",
        title: taskId,
        description: "按来源变化检查",
        assigneeId: "morphz-agent",
        ...(taskId === "task-one"
          ? {
              dependsOnIds: ["dependency-task"],
              watchSourceIds: ["source-one"],
            }
          : {}),
      });
  } catch (error) {
    await store?.close();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    get store() {
      return store!;
    },
    async reopen() {
      await store!.close();
      store = await open();
    },
    async start(taskId: string, prior?: TaskRunLink) {
      const version = await store!.taskVersion(owner, taskId);
      return store!.requestTaskRun(
        owner,
        {
          commandId: `start-${taskId}-${version.revision}`,
          taskId,
          expectedRevision: version.revision,
          sessionId: "session-one",
          intent: `处理准确的历史请求 ${version.revision}`,
          reasoningEffort: "high",
          notBefore: "2026-09-26T00:00:00.000Z",
        },
        prior ? observation(prior.runtime) : undefined,
        async () => "1",
      );
    },
    async prepare(admission: TaskRunAdmission) {
      const prepared = await store!.prepareTaskRun(
        owner,
        admission.eventId,
        async (runtime) => observation(runtime),
      );
      assert.ok(prepared);
      return prepared;
    },
    async close() {
      await store!.close();
      if (admin) {
        try {
          await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        } finally {
          await admin.end();
        }
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function started(f: Fixture) {
  const dependency = await f.start("dependency-task");
  await f.store.confirmTaskRun(
    tenantId,
    dependency.eventId,
    receipt(dependency, "dependency-thread-one"),
  );
  const requested = await f.start("task-one");
  const prepared = await f.prepare(requested);
  assert.deepEqual(prepared.request.dependency_thread_ids, [
    "dependency-thread-one",
  ]);
  return prepared;
}

async function authorizedRead(
  store: PlatformStore,
  admission: TaskRunAdmission,
) {
  const taskId = admission.taskId;
  const history = await store.listTaskRunLinks(owner, taskId, { limit: 1 });
  assert.deepEqual(history, [
    {
      taskId,
      runNumber: 1,
      taskRevision: admission.taskRevision,
      sequence: 2,
      runtime: {
        sessionId: admission.sessionId,
        scheduleId: admission.request.id,
        threadId: "runtime-thread-one",
      },
      request: {
        intent: admission.request.intent,
        modelAlias: null,
        reasoningEffort: "high",
        notBefore: "2026-09-26T00:00:00.000Z",
        intervalSeconds: null,
        dependencyThreadIds: ["dependency-thread-one"],
      },
      observed: {
        scheduleRevision: 3,
        scheduleStatus: "completed",
        scheduleNotBefore: null,
        scheduleIntervalSeconds: null,
        threadStatus: "completed",
      },
      bridge: {
        sourceSignature: admission.sourceSignature,
        watchSourceIds: ["source-one"],
        sourceCommandIds: [],
        paused: false,
        sourceStopped: false,
        stopRequested: false,
        controlRevision: 1,
        controlPending: null,
        error: "",
      },
    },
  ]);
  assert.deepEqual(
    await store.taskRunRuntimeRef(owner, taskId, 1),
    history[0]!.runtime,
  );
  await assert.rejects(
    () => store.taskRunRuntimeRef(owner, taskId, 2),
    /不存在/,
  );
  assert.deepEqual(
    await store.listTaskRunLinks({ credential: "agent" }, taskId),
    history,
  );
  assert.deepEqual(
    await store.listTaskRunLinks(owner, taskId, { beforeRun: 1 }),
    [],
  );
  for (const credential of ["outsider", "wrong-scope", "other-tenant"]) {
    await assert.rejects(
      () => store.taskRunRuntimeRef({ credential }, taskId, 1),
      /无权|超出|不存在/,
    );
    await assert.rejects(
      () => store.listTaskRunLinks({ credential }, taskId),
      /无权|超出|不存在/,
    );
  }
  await assert.rejects(
    () => store.listTaskRunLinks(owner, taskId, { limit: 51 }),
    /分页大小/,
  );
  await assert.rejects(
    () => store.listTaskRunLinks(owner, taskId, { beforeRun: 0 }),
    /游标/,
  );
}

for (const backend of ["sqlite", "postgres"] as const) {
  const options = { skip: backend === "postgres" && !postgresUrl };
  test(
    `${backend}: 正式执行回执保存精确请求、版本和 Runtime 引用，重开和重试不改历史`,
    options,
    async () => {
      const f = await fixture(backend);
      try {
        const admission = await started(f);
        const accepted = receipt(admission, "runtime-thread-one");
        const result = { taskId: "task-one", runNumber: 1 };
        assert.deepEqual(
          await f.store.confirmTaskRun(tenantId, admission.eventId, accepted),
          result,
        );
        assert.deepEqual(
          await f.store.confirmTaskRun(tenantId, admission.eventId, accepted),
          result,
        );
        assert.deepEqual(await f.store.pendingTaskRuns(tenantId), []);
        await authorizedRead(f.store, admission);
        await f.reopen();
        await authorizedRead(f.store, admission);
        assert.deepEqual(await f.prepare(admission), admission);
      } finally {
        await f.close();
      }
    },
  );

  test(
    `${backend}: 错误 Runtime 回执和过时事项版本不能产生执行关系，失败后可按原请求重试`,
    options,
    async () => {
      const f = await fixture(backend);
      try {
        const admission = await started(f);
        const accepted = receipt(admission, "runtime-thread-one");
        const mutations: Array<(value: TaskRunRuntimeReceipt) => void> = [
          (value) => {
            value.schedule.id = "other-schedule";
          },
          (value) => {
            value.thread.session_id = "other-session";
          },
          (value) => {
            value.thread.root_turn_id = "other-root";
          },
          (value) => {
            value.thread.thread_id = "other-thread";
          },
        ];
        for (const mutate of mutations) {
          const wrong = structuredClone(accepted);
          mutate(wrong);
          await assert.rejects(
            () => f.store.confirmTaskRun(tenantId, admission.eventId, wrong),
            /Runtime|回执|请求/,
          );
          assert.deepEqual(
            await f.store.listTaskRunLinks(owner, admission.taskId),
            [],
          );
          assert.deepEqual(await f.store.pendingTaskRuns(tenantId), [
            admission,
          ]);
        }
        await assert.rejects(
          () =>
            f.store.requestTaskRun(owner, {
              commandId: "stale-run",
              taskId: admission.taskId,
              expectedRevision: 1,
              sessionId: "session-one",
              intent: "不能以旧版本开始下一轮",
              notBefore: "2026-09-26T00:00:00.000Z",
            }),
          /事项已变化/,
        );
        await f.store.confirmTaskRun(tenantId, admission.eventId, accepted);
        // A stored terminal observation does not authorize a new run without a
        // fresh matching Runtime observation of the exact previous execution.
        await assert.rejects(
          () => f.start("task-one"),
          /上一轮执行尚未由 Runtime 确认结束/,
        );
        await authorizedRead(f.store, admission);
      } finally {
        await f.close();
      }
    },
  );

  test(
    `${backend}: 执行历史按序号分页，固定依赖与关注来源不串到相邻运行`,
    options,
    async () => {
      const f = await fixture(backend);
      try {
        const first = await started(f);
        await f.store.confirmTaskRun(
          tenantId,
          first.eventId,
          receipt(first, "runtime-thread-one"),
        );
        const dependencyPrior = (
          await f.store.listTaskRunLinks(owner, "dependency-task")
        )[0]!;
        const dependency = await f.start("dependency-task", dependencyPrior);
        await f.store.confirmTaskRun(
          tenantId,
          dependency.eventId,
          receipt(dependency, "dependency-thread-two"),
        );
        const prior = (await f.store.listTaskRunLinks(owner, "task-one"))[0]!;
        await assert.rejects(
          () => f.start("task-one", prior),
          /上一轮执行尚未由 Runtime 确认结束/,
          "原 Thread 终态不能隐式停止仍订阅中的来源关注",
        );
        await f.store.requestTaskRunControl(
          owner,
          "task-one",
          prior.runNumber,
          prior.bridge.controlRevision,
          "stop",
        );
        const stop = (await f.store.pendingTaskRunStops(tenantId)).find(
          (request) => request.taskId === "task-one",
        );
        assert.ok(stop);
        await assert.rejects(
          () => f.start("task-one", prior),
          /上一轮执行尚未由 Runtime 确认结束/,
          "停止待确认时也不能进入下一轮",
        );
        await f.store.confirmTaskRunStop(tenantId, stop, {
          source: "runtime",
          runtime: prior.runtime,
          schedule: {
            revision: 4,
            status: "completed",
            notBefore: null,
            intervalSeconds: null,
          },
          thread: { lifecycle: "completed" },
        });
        const stopped = (await f.store.listTaskRunLinks(owner, "task-one"))[0]!;
        assert.equal(stopped.bridge.sourceStopped, true);
        assert.equal(stopped.bridge.stopRequested, false);
        assert.deepEqual(
          stopped.bridge.watchSourceIds,
          prior.bridge.watchSourceIds,
        );
        assert.deepEqual(
          stopped.request.dependencyThreadIds,
          prior.request.dependencyThreadIds,
        );
        const second = await f.prepare(await f.start("task-one", prior));
        await f.store.confirmTaskRun(
          tenantId,
          second.eventId,
          receipt(second, "runtime-thread-two"),
        );
        const both = await f.store.listTaskRunLinks(owner, "task-one");
        assert.deepEqual(
          both.map((run) => [run.runNumber, run.taskRevision, run.sequence]),
          [
            [2, 3, 4],
            [1, 2, 2],
          ],
        );
        assert.deepEqual(
          both.map((run) => run.request.dependencyThreadIds),
          [["dependency-thread-two"], ["dependency-thread-one"]],
        );
        assert.deepEqual(
          both.map((run) => run.bridge.watchSourceIds),
          [["source-one"], ["source-one"]],
        );
        assert.deepEqual(
          both.map((run) => run.bridge.sourceSignature),
          [second.sourceSignature, first.sourceSignature],
        );
        const latest = await f.store.listTaskRunLinks(owner, "task-one", {
          limit: 1,
        });
        const older = await f.store.listTaskRunLinks(owner, "task-one", {
          limit: 1,
          beforeRun: latest[0]!.runNumber,
        });
        assert.deepEqual([...latest, ...older], both);
        await f.reopen();
        assert.deepEqual(
          await f.store.listTaskRunLinks(owner, "task-one"),
          both,
        );
      } finally {
        await f.close();
      }
    },
  );
}
