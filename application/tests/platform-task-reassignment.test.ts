import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { setTimeout as delay } from "node:timers/promises";
import {
  PlatformStore,
  type PlatformAuthorityVerifier,
  type PriorRuntimeObservation,
  type TaskRunLink,
} from "../packages/platform/src/store.js";
import type { TaskRunAdmission } from "../packages/platform/src/task-run-admission.js";

const postgresUrl = process.env.MORPHZ_TEST_POSTGRES_URL;
const owner = { credential: "owner" };

/** Actual Platform databases and authority checks. Runtime observations below
 * are controlled Host protocol evidence, not a simulated storage backend. */
async function fixture(backend: "sqlite" | "postgres") {
  const directory = mkdtempSync(join(tmpdir(), "morphz-task-reassign-"));
  const tenantId = `tenant-${randomUUID()}`;
  const schema = `task_reassign_${randomUUID().replaceAll("-", "")}`;
  const storeUrl = postgresUrl ? new URL(postgresUrl) : null;
  storeUrl?.searchParams.set("application_name", schema);
  const admin =
    backend === "postgres" ? new Pool({ connectionString: postgresUrl }) : null;
  let authorized = true;
  const authority: PlatformAuthorityVerifier = {
    async resolveActor({ credential }) {
      return credential === "owner" && authorized
        ? {
            tenantId,
            principalId: "owner-principal",
            actantId: "owner-human",
            kind: "human",
            runtimeInputId: null,
          }
        : null;
    },
    async resolveActant({ tenantId: scope, actantId }) {
      if (scope !== tenantId) return null;
      if (actantId === "owner-human")
        return { principalId: "owner-principal", kind: "human" };
      if (actantId === "morphz-agent")
        return { principalId: "agent-principal", kind: "agent" };
      return null;
    },
    async resolveProjectAgent({ tenantId: scope }) {
      return scope === tenantId
        ? { principalId: "agent-principal", actantId: "morphz-agent" }
        : null;
    },
    async verifyApplicationObject() {
      return false;
    },
  };
  const open = () =>
    backend === "sqlite"
      ? PlatformStore.sqlite(join(directory, "platform.sqlite"), authority)
      : PlatformStore.postgres(
          { connectionString: storeUrl!.toString(), schema },
          authority,
        );
  let store: PlatformStore | undefined;
  try {
    if (admin) await admin.query(`CREATE SCHEMA "${schema}"`);
    store = await open();
    await store.provisionTenant(tenantId);
    await store.createProject(owner, {
      commandId: "project",
      projectId: "project",
      title: "执行改派验收",
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
    tenantId,
    get store() {
      return store!;
    },
    async holdTaskRow(taskId: string) {
      if (!admin) return null;
      const lock = await admin.connect();
      await lock.query("BEGIN");
      await lock.query(
        `SELECT task_id FROM "${schema}".tasks WHERE tenant_id=$1 AND task_id=$2 FOR UPDATE`,
        [tenantId, taskId],
      );
      return {
        async waitForWriters(count: number) {
          for (let attempt = 0; attempt < 200; attempt++) {
            const result = await admin.query<{ waiting: string }>(
              "SELECT count(*) AS waiting FROM pg_stat_activity WHERE application_name=$1 AND state='active' AND wait_event_type='Lock'",
              [schema],
            );
            if (Number(result.rows[0]?.waiting) === count) return;
            await delay(10);
          }
          throw Error(
            `Expected ${count} actual PostgreSQL writers to wait for the task row`,
          );
        },
        async release() {
          try {
            await lock.query("ROLLBACK");
          } finally {
            lock.release();
          }
        },
      };
    },
    revoke() {
      authorized = false;
    },
    restore() {
      authorized = true;
    },
    async reopen() {
      await store!.close();
      store = await open();
    },
    async create() {
      const taskId = randomUUID();
      await store!.createTask(owner, {
        commandId: randomUUID(),
        taskId,
        projectId: "project",
        title: "实际事项",
        description: "Runtime 终态决定是否允许改派",
        assigneeId: "morphz-agent",
      });
      return taskId;
    },
    start(
      taskId: string,
      expectedRevision: number,
      extra: { commandId?: string; intervalSeconds?: number } = {},
    ) {
      return store!.requestTaskRun(owner, {
        commandId: extra.commandId ?? randomUUID(),
        taskId,
        expectedRevision,
        sessionId: "session-one",
        intent: "实际执行准入",
        notBefore: "2026-09-30T00:00:00.000Z",
        ...(extra.intervalSeconds
          ? { intervalSeconds: extra.intervalSeconds }
          : {}),
      });
    },
    async confirm(admission: TaskRunAdmission) {
      const runtime = {
        sessionId: admission.sessionId,
        scheduleId: admission.request.id,
        threadId: `thread-${admission.taskId}-${admission.runNumber}`,
      };
      await store!.confirmTaskRun(tenantId, admission.eventId, {
        schedule: {
          id: runtime.scheduleId,
          thread_id: runtime.threadId,
          revision: 1,
          status: admission.request.interval_seconds
            ? "dispatched"
            : "completed",
          not_before: admission.request.not_before,
          interval_seconds: admission.request.interval_seconds,
        },
        thread: {
          thread_id: runtime.threadId,
          session_id: runtime.sessionId,
          root_turn_id: `client-schedule-${runtime.scheduleId}`,
          lifecycle: "completed",
        },
      });
      return runtime;
    },
    version(taskId: string, revision?: number) {
      return store!.taskVersion(owner, taskId, revision);
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
const terminal = (
  runtime: TaskRunLink["runtime"],
): PriorRuntimeObservation => ({
  source: "runtime",
  runtime,
  schedule: { status: "completed" },
  thread: { lifecycle: "completed" },
});
const reassign = (taskId: string, expectedRevision = 2) => ({
  commandId: randomUUID(),
  taskId,
  expectedRevision,
  assigneeId: "owner-human",
});
async function running(f: Fixture, intervalSeconds?: number) {
  const taskId = await f.create();
  const admission = await f.start(taskId, 1, { intervalSeconds });
  return { taskId, admission, runtime: await f.confirm(admission) };
}

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip:
      backend === "postgres" && !postgresUrl
        ? "MORPHZ_TEST_POSTGRES_URL not set"
        : false,
  };
  test(
    `${backend}: current Runtime binding and terminal evidence authorize reassignment; cached status does not`,
    options,
    async () => {
      const f = await fixture(backend);
      try {
        const { taskId, runtime } = await running(f),
          request = reassign(taskId);
        await assert.rejects(f.store.reviseTask(owner, request), /执行.*结束/);
        await assert.rejects(
          f.store.reviseTask(owner, request, async () => ({
            ...terminal(runtime),
            thread: { lifecycle: "open" },
          })),
          /执行.*结束/,
        );
        await assert.rejects(
          f.store.reviseTask(owner, request, async () =>
            terminal({ ...runtime, threadId: "another-thread" }),
          ),
          /执行.*结束/,
        );
        assert.equal((await f.version(taskId)).revision, 2);
        await f.store.reviseTask(owner, request, async (selected) => {
          assert.deepEqual(selected, runtime);
          return terminal(runtime);
        });
        assert.equal((await f.version(taskId)).assignee_id, "owner-human");
        await f.reopen();
        assert.equal(
          await f.store.reviseTask(owner, request, async () => {
            throw Error("exact retry must not inspect Runtime again");
          }),
          taskId,
        );
        assert.equal((await f.version(taskId)).revision, 3);
      } finally {
        await f.close();
      }
    },
  );

  test(
    `${backend}: identity revocation during asynchronous Runtime inspection aborts without a task mutation`,
    options,
    async () => {
      const f = await fixture(backend);
      try {
        const { taskId, runtime } = await running(f);
        await assert.rejects(
          f.store.reviseTask(owner, reassign(taskId), async () => {
            f.revoke();
            return terminal(runtime);
          }),
          /身份|授权|权限/,
        );
        f.restore();
        assert.equal((await f.version(taskId)).revision, 2);
        assert.equal((await f.version(taskId)).assignee_id, "morphz-agent");
      } finally {
        f.restore();
        await f.close();
      }
    },
  );

  test(
    `${backend}: revision changes during Runtime inspection fail the second transactional check`,
    options,
    async () => {
      const f = await fixture(backend);
      try {
        const { taskId, runtime } = await running(f);
        await assert.rejects(
          f.store.reviseTask(owner, reassign(taskId), async () => {
            await f.store.reviseTask(owner, {
              commandId: randomUUID(),
              taskId,
              expectedRevision: 2,
              title: "concurrent edit",
            });
            return terminal(runtime);
          }),
          /事项已变化/,
        );
        assert.equal((await f.version(taskId)).revision, 3);
        assert.equal((await f.version(taskId)).title, "concurrent edit");
        assert.equal((await f.version(taskId)).assignee_id, "morphz-agent");
      } finally {
        await f.close();
      }
    },
  );

  test(
    `${backend}: concurrent identical terminal reassignments return one durable result and create one revision`,
    options,
    async () => {
      const f = await fixture(backend);
      try {
        const { taskId, runtime } = await running(f),
          request = reassign(taskId);
        let reads = 0,
          release!: () => void;
        const ready = new Promise<void>((resolve) => {
          release = resolve;
        });
        const inspect = async () => {
          if (++reads === 2) release();
          await ready;
          return terminal(runtime);
        };
        // Hold the actual PG row until both requests wait behind the existing
        // task/advisory locks. This makes retry serialization observable without
        // replacing Platform queries or its transaction implementation.
        const held = await f.holdTaskRow(taskId);
        const pending = Promise.allSettled([
          f.store.reviseTask(owner, request, inspect),
          f.store.reviseTask(owner, request, inspect),
        ]);
        try {
          await held?.waitForWriters(2);
        } finally {
          await held?.release();
        }
        assert.deepEqual(await pending, [
          { status: "fulfilled", value: taskId },
          { status: "fulfilled", value: taskId },
        ]);
        assert.equal(reads, 2);
        assert.equal((await f.version(taskId)).revision, 3);
        assert.equal((await f.version(taskId, 3)).assignee_id, "owner-human");
        const history = await f.store.listTaskVersions(owner, taskId);
        assert.deepEqual(
          history.map((version) => version.revision),
          [3, 2, 1],
        );
        assert.deepEqual(
          await f.store.listTaskVersions(owner, taskId, {
            limit: 1,
            beforeRevision: 3,
          }),
          [history[1]],
        );
        await f.reopen();
        assert.deepEqual(
          await f.store.listTaskVersions(owner, taskId),
          history,
        );
      } finally {
        await f.close();
      }
    },
  );

  test(
    `${backend}: concurrent distinct reassignment commands preserve CAS instead of replacing the winning owner`,
    options,
    async () => {
      const f = await fixture(backend);
      try {
        const { taskId, runtime } = await running(f);
        let reads = 0,
          release!: () => void;
        const ready = new Promise<void>((resolve) => {
          release = resolve;
        });
        const inspect = async () => {
          if (++reads === 2) release();
          await ready;
          return terminal(runtime);
        };
        const results = await Promise.allSettled([
          f.store.reviseTask(owner, reassign(taskId), inspect),
          f.store.reviseTask(owner, reassign(taskId), inspect),
        ]);
        assert.equal(
          results.filter((result) => result.status === "fulfilled").length,
          1,
        );
        const rejected = results.find((result) => result.status === "rejected");
        assert.ok(rejected && rejected.reason.code === "conflict");
        assert.equal((await f.version(taskId)).revision, 3);
        assert.equal((await f.version(taskId)).assignee_id, "owner-human");
      } finally {
        await f.close();
      }
    },
  );

  test(
    `${backend}: a paused periodic Schedule is not a finished execution and pending stop blocks reassignment`,
    options,
    async () => {
      const f = await fixture(backend);
      try {
        const { taskId, runtime } = await running(f, 60),
          request = reassign(taskId);
        await f.store.requestTaskRunControl(owner, taskId, 1, 1, "pause");
        const [control] = await f.store.pendingTaskRunScheduleControls(
          f.tenantId,
        );
        assert.ok(control);
        await f.store.confirmTaskRunScheduleControl(f.tenantId, control, {
          source: "runtime",
          runtime,
          schedule: {
            revision: 2,
            status: "paused",
            notBefore: null,
            intervalSeconds: 60,
          },
          thread: { lifecycle: "completed" },
        });
        await assert.rejects(
          f.store.reviseTask(owner, request, async () => ({
            ...terminal(runtime),
            schedule: { status: "paused" },
          })),
          /执行.*结束/,
        );
        assert.equal((await f.version(taskId)).assignee_id, "morphz-agent");
        await f.store.requestTaskRunStop(owner, taskId, 1, 3);
        await assert.rejects(
          f.store.reviseTask(owner, request, async () => terminal(runtime)),
          /执行.*结束/,
        );
        const [stop] = await f.store.pendingTaskRunStops(f.tenantId);
        assert.ok(stop);
        await f.store.confirmTaskRunStop(f.tenantId, stop, {
          source: "runtime",
          runtime,
          schedule: {
            revision: 3,
            status: "cancelled",
            notBefore: null,
            intervalSeconds: 60,
          },
          thread: { lifecycle: "completed" },
        });
        await f.store.reviseTask(owner, request, async () => {
          throw Error(
            "committed stop confirmation already authorizes this binding",
          );
        });
        assert.equal((await f.version(taskId)).assignee_id, "owner-human");
      } finally {
        await f.close();
      }
    },
  );

  test(
    `${backend}: execution control racing with Runtime inspection blocks the stale terminal reassignment`,
    options,
    async () => {
      const f = await fixture(backend);
      try {
        const { taskId, runtime } = await running(f);
        await assert.rejects(
          f.store.reviseTask(owner, reassign(taskId), async () => {
            await f.store.requestTaskRunStop(owner, taskId, 1, 1);
            return terminal(runtime);
          }),
          /核对期间执行状态已变化/,
        );
        assert.equal((await f.version(taskId)).revision, 2);
        assert.equal((await f.store.pendingTaskRunStops(f.tenantId)).length, 1);
      } finally {
        await f.close();
      }
    },
  );

  test(
    `${backend}: Agent-Human-Agent cold reopen preserves monotonic admission identity and concurrent retry`,
    options,
    async () => {
      const f = await fixture(backend);
      try {
        const { taskId, admission, runtime } = await running(f);
        await f.store.reviseTask(owner, reassign(taskId), async () =>
          terminal(runtime),
        );
        await f.store.reviseTask(
          owner,
          {
            commandId: randomUUID(),
            taskId,
            expectedRevision: 3,
            assigneeId: "morphz-agent",
          },
          async () => terminal(runtime),
        );
        await f.reopen();
        const commandId = randomUUID();
        const [first, retry] = await Promise.all([
          f.start(taskId, 4, { commandId }),
          f.start(taskId, 4, { commandId }),
        ]);
        assert.deepEqual(retry, first);
        assert.equal(first.runNumber, 2);
        assert.notEqual(first.eventId, admission.eventId);
        assert.notEqual(first.request.id, admission.request.id);
        assert.equal((await f.version(taskId)).revision, 5);
        assert.equal(
          (await f.version(taskId, admission.taskRevision)).run_requested,
          1,
        );
        await f.reopen();
        assert.deepEqual(await f.start(taskId, 4, { commandId }), first);
        await assert.rejects(
          f.store.reviseTask(owner, reassign(taskId, 5), async () =>
            terminal(runtime),
          ),
          /执行.*结束/,
        );
        assert.equal(
          (await f.version(taskId)).run_requested,
          2,
          "unconfirmed new admission cannot use an old terminal link",
        );
      } finally {
        await f.close();
      }
    },
  );
}
