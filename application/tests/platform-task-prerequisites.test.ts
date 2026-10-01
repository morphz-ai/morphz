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
import { PlatformTaskRunDispatcher } from "../packages/application/src/platform-task-run-dispatcher.js";
import { Application } from "../packages/application/src/application.js";
import { HumanPlatformAuthority } from "../packages/application/src/human-platform-authority.js";
import { RuntimeTaskRunStatusReader } from "../packages/application/src/runtime-task-run-status.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { ExecutionControls } from "../packages/application/src/execution.js";
import type { RuntimeBridge } from "../packages/application/src/runtime.js";
import { localAccess } from "../packages/core/src/model.js";

const human = { credential: "alice" };
const postgresUrl = process.env.MORPHZ_TEST_POSTGRES_URL;

async function fixture(backend: "sqlite" | "postgres") {
  const tenantId = `tenant-${randomUUID()}`;
  const directory = mkdtempSync(join(tmpdir(), "morphz-task-prerequisites-"));
  const schema = `task_prerequisites_${randomUUID().replaceAll("-", "")}`;
  const admin =
    backend === "postgres" ? new Pool({ connectionString: postgresUrl }) : null;
  let authorized = true;
  const access = { ...localAccess, principalId: "alice", actantId: "alice" };
  const authority = new HumanPlatformAuthority(
    tenantId,
    (current) =>
      authorized &&
      current.principalId === "alice" &&
      current.actantId === "alice",
  );
  const verifier: PlatformAuthorityVerifier = {
    async resolveActor({ credential }) {
      return authorized && credential === "alice"
        ? {
            tenantId,
            principalId: "alice",
            actantId: "alice",
            kind: "human",
            runtimeInputId: null,
          }
        : null;
    },
    async resolveActant({ tenantId: scope, actantId }) {
      if (scope !== tenantId) return null;
      return actantId === "alice"
        ? { principalId: "alice", kind: "human" }
        : actantId === "agent-one"
          ? { principalId: "morphz-service", kind: "agent" }
          : null;
    },
    async resolveProjectAgent() {
      return { principalId: "morphz-service", actantId: "agent-one" };
    },
    async verifyApplicationObject() {
      return false;
    },
  };
  let platform: PlatformStore | undefined;
  const open = () =>
    backend === "sqlite"
      ? PlatformStore.sqlite(
          join(directory, "platform.sqlite"),
          authority.verifier(verifier),
        )
      : PlatformStore.postgres(
          { connectionString: postgresUrl!, schema },
          authority.verifier(verifier),
        );
  try {
    if (admin) await admin.query(`CREATE SCHEMA "${schema}"`);
    platform = await open();
    await platform.provisionTenant(tenantId);
    await platform.createProject(human, {
      commandId: "project-create",
      projectId: "project-one",
      title: "前置工作",
    });
  } catch (error) {
    await platform?.close();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    tenantId,
    authority,
    access,
    get platform() {
      return platform!;
    },
    revoke() {
      authorized = false;
    },
    async reopen() {
      await platform!.close();
      platform = await open();
    },
    async create(
      taskId: string,
      kind: "human" | "agent",
      dependsOnIds: string[] = [],
    ) {
      return platform!.createTask(human, {
        commandId: `create-${taskId}`,
        taskId,
        projectId: "project-one",
        title: taskId,
        description: `要求 ${taskId}`,
        assigneeId: kind === "human" ? "alice" : "agent-one",
        dependsOnIds,
      });
    },
    async start(taskId: string) {
      const current = await platform!.taskVersion(human, taskId);
      return platform!.requestTaskRun(human, {
        commandId: `start-${taskId}-${current.revision}`,
        taskId,
        expectedRevision: current.revision,
        sessionId: "project-task-session",
        intent: `原始工作要求 ${taskId}`,
        notBefore: "2030-01-01T00:00:00.000Z",
      });
    },
    async close() {
      await platform!.close();
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

function receipt(
  admission: TaskRunAdmission,
  threadId = `thread-${admission.taskId}`,
): TaskRunRuntimeReceipt {
  return {
    schedule: {
      id: admission.request.id,
      thread_id: threadId,
      revision: 1,
      status: "queued",
      not_before: admission.request.not_before,
      interval_seconds: null,
    },
    thread: {
      thread_id: threadId,
      session_id: admission.sessionId,
      root_turn_id: `client-schedule-${admission.request.id}`,
      lifecycle: "open",
    },
  };
}
function observation(
  runtime: TaskRunLink["runtime"],
  lifecycle: "open" | "completed" | "failed" | "cancelled" = "completed",
) {
  return {
    source: "runtime" as const,
    runtime,
    schedule: {
      status:
        lifecycle === "open"
          ? "dispatched"
          : lifecycle === "cancelled"
            ? "cancelled"
            : "completed",
    },
    thread: { lifecycle },
  };
}
const noRuntime = async () => {
  throw new Error("人工依赖不得查询 Runtime");
};

for (const backend of ["sqlite", "postgres"] as const) {
  const options = { skip: backend === "postgres" && !postgresUrl };
  test(
    `${backend}: 正式事项快照显示实际等待与排队，固定依赖不随后来答复变化，撤权后拒绝返回`,
    options,
    async () => {
      const f = await fixture(backend);
      const transport = new WorkspaceStore(":memory:", { mode: "transport" });
      const records = new Map<string, TaskRunRuntimeReceipt>();
      let reads = 0;
      let revokeDuringRead = false;
      let offline = false;
      const runtimeStatus = new RuntimeTaskRunStatusReader(async (path) => {
        reads++;
        if (offline) throw new Error("private upstream detail");
        if (revokeDuringRead) f.revoke();
        const isThread = path.endsWith("/thread");
        const scheduleId = path.split("/")[5]!.replace(/^client-schedule-/, "");
        const stored = records.get(scheduleId);
        assert.ok(stored, `必须读取真实绑定：${path}`);
        return isThread ? { ...stored.thread, revision: 1 } : stored.schedule;
      });
      const runtime = {
        platformTaskExecutionControls: async (
          _projectId: string,
          ref: { sessionId: string; scheduleId: string; threadId: string },
        ) =>
          new ExecutionControls(
            async () => ({ approvals: [] }),
            () => ({
              sessionId: ref.sessionId,
              contextId: "context-one",
              threadId: ref.threadId,
              rootId: `client-schedule-${ref.scheduleId}`,
            }),
          ),
      } as unknown as RuntimeBridge;
      const read = (taskId: string) =>
        new Application(transport, {
          runtime,
          platformTaskRuns: {
            authority: f.authority,
            store: f.platform,
            runtimeStatus,
          },
        })
          .session(f.access)
          .taskSnapshot(taskId);
      try {
        await f.create("human-source", "human");
        await f.create("agent-source", "agent");
        await f.create("agent-target", "agent", [
          "human-source",
          "agent-source",
        ]);
        const admission = await f.start("agent-target");
        let view = await read("agent-target");
        assert.deepEqual(
          view.blockers?.map((item) => [item.taskId, item.reason]),
          [
            ["human-source", "response"],
            ["agent-source", "not-started"],
          ],
        );
        assert.equal(
          view.runs[0]!.threadState,
          null,
          "未投递时不能伪造执行中的 Thread",
        );
        assert.equal(reads, 0, "没有 Runtime 绑定时不猜测线程或读取审批");
        const source = await f.start("agent-source");
        const sourceReceipt = receipt(source);
        await f.platform.confirmTaskRun(
          f.tenantId,
          source.eventId,
          sourceReceipt,
        );
        records.set(source.request.id, sourceReceipt);
        await f.platform.respondTask(human, {
          commandId: "human-result",
          taskId: "human-source",
          expectedRevision: 1,
          body: "确定的人工结果",
        });
        view = await read("agent-target");
        assert.deepEqual(
          view.blockers?.map((item) => item.reason),
          ["running"],
        );
        const compiled = await f.platform.prepareTaskRun(
          human,
          admission.eventId,
          (ref) => runtimeStatus.inspect(ref, f.access),
        );
        assert.ok(compiled);
        assert.deepEqual(compiled.request.dependency_thread_ids, [
          sourceReceipt.thread.thread_id,
        ]);
        const targetReceipt = receipt(compiled);
        await f.platform.confirmTaskRun(
          f.tenantId,
          admission.eventId,
          targetReceipt,
        );
        records.set(compiled.request.id, targetReceipt);
        await f.platform.setTaskCompleted(human, {
          commandId: "later-reopen",
          taskId: "human-source",
          expectedRevision: 2,
          completed: false,
        });
        await f.reopen();
        view = await read("agent-target");
        assert.deepEqual(
          view.blockers?.map((item) => item.reason),
          ["running"],
          "已投递执行仍使用当时确认的答复，不被后来重新打开偷换",
        );
        assert.equal(view.runs[0]!.record?.status, "queued");
        sourceReceipt.thread.lifecycle = "completed";
        sourceReceipt.schedule.status = "completed";
        view = await read("agent-target");
        assert.deepEqual(view.blockers, []);
        assert.equal(
          view.runs[0]!.record?.status,
          "queued",
          "依赖完成不伪造当前执行已经开始",
        );
        offline = true;
        const unavailable = await read("agent-target");
        assert.ok(unavailable.error);
        assert.equal(unavailable.approvalCount, undefined);
        assert.ok(!JSON.stringify(unavailable).includes("private upstream"));
        offline = false;
        // Withdrawal of another unprepared run never contacts Runtime.
        await f.create("stopped-target", "agent", ["human-source"]);
        await f.start("stopped-target");
        await f.platform.requestTaskRunStop(human, "stopped-target", 1, 1);
        const countBeforeStopRead = reads;
        const stopped = await read("stopped-target");
        assert.deepEqual(stopped.blockers, []);
        assert.equal(stopped.runs[0]!.sourceStopped, true);
        assert.equal(reads, countBeforeStopRead);
        revokeDuringRead = true;
        await assert.rejects(read("agent-target"), /身份|授权/);
      } finally {
        transport.close();
        await f.close();
      }
    },
  );
  test(
    `${backend}: 人工答复按负责人和要求有效性核对，准备后只引用原答复，重启不换依据`,
    options,
    async () => {
      const f = await fixture(backend);
      try {
        await f.create("human-source", "human");
        await f.create("agent-target", "agent", ["human-source"]);
        const admission = await f.start("agent-target");
        assert.equal(
          await f.platform.prepareTaskRun(human, admission.eventId, noRuntime),
          null,
        );
        await assert.rejects(
          f.platform.confirmTaskRun(
            f.tenantId,
            admission.eventId,
            receipt(admission),
          ),
          /依赖尚未固定/,
        );
        await assert.rejects(
          f.platform.taskRunAdmissionForRuntime(
            f.tenantId,
            admission.sessionId,
            admission.request.id,
          ),
          /依赖尚未固定/,
        );
        await f.platform.respondTask(human, {
          commandId: "response-old",
          taskId: "human-source",
          expectedRevision: 1,
          body: "旧结果",
        });
        await f.platform.reviseTask(human, {
          commandId: "retitle",
          taskId: "human-source",
          expectedRevision: 2,
          title: "仅改名称",
        });
        let state = await f.platform.taskRunPrerequisites(
          human,
          admission.taskId,
          1,
        );
        assert.equal(
          state.prerequisites[0]!.response?.responseId,
          "response-old",
        );
        await f.platform.setTaskCompleted(human, {
          commandId: "reopen-source",
          taskId: "human-source",
          expectedRevision: 3,
          completed: false,
        });
        assert.equal(
          await f.platform.prepareTaskRun(human, admission.eventId, noRuntime),
          null,
          "重开后旧答复不能自动有效",
        );
        await f.platform.respondTask(human, {
          commandId: "response-current",
          taskId: "human-source",
          expectedRevision: 4,
          body: "当前结果正文",
        });
        const prepared = await f.platform.prepareTaskRun(
          human,
          admission.eventId,
          noRuntime,
        );
        assert.ok(prepared);
        assert.ok(prepared.request.intent.startsWith(admission.request.intent));
        assert.ok(
          prepared.request.intent.includes('"responseId":"response-current"'),
        );
        assert.ok(
          !prepared.request.intent.includes("当前结果正文"),
          "不把完整人工结果重复装入请求",
        );
        assert.deepEqual(
          await f.platform.listTaskResponses(human, "human-source", {
            responseId: "response-current",
          }),
          [(await f.platform.listTaskResponses(human, "human-source")).at(-1)],
        );
        await f.platform.setTaskCompleted(human, {
          commandId: "later-reopen",
          taskId: "human-source",
          expectedRevision: 5,
          completed: false,
        });
        await f.reopen();
        assert.deepEqual(
          await f.platform.prepareTaskRun(human, admission.eventId, noRuntime),
          prepared,
        );
        assert.deepEqual(
          (await f.platform.pendingTaskRuns(f.tenantId))[0],
          prepared,
        );
        await f.platform.confirmTaskRun(
          f.tenantId,
          admission.eventId,
          receipt(prepared),
        );
        state = await f.platform.taskRunPrerequisites(
          human,
          admission.taskId,
          1,
        );
        assert.equal(
          state.prerequisites[0]!.response?.responseId,
          "response-current",
        );
        assert.deepEqual(await f.platform.pendingTaskRuns(f.tenantId), []);
      } finally {
        await f.close();
      }
    },
  );

  test(
    `${backend}: Agent 依赖必须有精确 Runtime 关联；失败、取消、失联及迟到版本不批准投递`,
    options,
    async () => {
      const f = await fixture(backend);
      try {
        await f.create("agent-source", "agent");
        await f.create("agent-target", "agent", ["agent-source"]);
        const admission = await f.start("agent-target");
        let reads = 0;
        assert.equal(
          await f.platform.prepareTaskRun(
            human,
            admission.eventId,
            async (ref) => {
              reads++;
              return observation(ref);
            },
          ),
          null,
        );
        assert.equal(reads, 0);
        const source = await f.start("agent-source");
        await f.platform.confirmTaskRun(
          f.tenantId,
          source.eventId,
          receipt(source),
        );
        for (const lifecycle of ["failed", "cancelled"] as const)
          assert.equal(
            await f.platform.prepareTaskRun(
              human,
              admission.eventId,
              async (ref) => observation(ref, lifecycle),
            ),
            null,
          );
        await assert.rejects(
          f.platform.prepareTaskRun(human, admission.eventId, async () => {
            throw new Error("Runtime unavailable");
          }),
          /Runtime unavailable/,
        );
        await assert.rejects(
          f.platform.prepareTaskRun(human, admission.eventId, async (ref) =>
            observation({ ...ref, threadId: "unrelated-thread" }),
          ),
          /引用不一致/,
        );
        const changed = await f.platform.prepareTaskRun(
          human,
          admission.eventId,
          async (ref) => {
            await f.platform.reviseTask(human, {
              commandId: "edit-during-read",
              taskId: "agent-source",
              expectedRevision: source.taskRevision,
              title: "新的名称",
            });
            return observation(ref);
          },
        );
        assert.equal(changed, null, "外部读取期间依赖版本改变，下一次重新准备");
        const compiled = await Promise.all([
          f.platform.prepareTaskRun(human, admission.eventId, async (ref) =>
            observation(ref, "open"),
          ),
          f.platform.prepareTaskRun(human, admission.eventId, async (ref) =>
            observation(ref, "open"),
          ),
        ]);
        assert.ok(compiled[0]);
        assert.deepEqual(compiled[0], compiled[1], "并发 Host 固定同一请求");
        assert.deepEqual(compiled[0].request.dependency_thread_ids, [
          "thread-agent-source",
        ]);
        await f.platform.confirmTaskRun(
          f.tenantId,
          admission.eventId,
          receipt(compiled[0]),
        );
        assert.deepEqual(
          (await f.platform.listTaskRunLinks(human, "agent-target"))[0]!.request
            .dependencyThreadIds,
          ["thread-agent-source"],
        );
      } finally {
        await f.close();
      }
    },
  );

  test(
    `${backend}: 未准备执行可以直接撤回，等待中停止不创建 Schedule，下一轮仍使用新身份`,
    options,
    async () => {
      const f = await fixture(backend);
      try {
        await f.create("human-source", "human");
        await f.create("agent-target", "agent", ["human-source"]);
        const admission = await f.start("agent-target");
        await f.platform.requestTaskRunStop(human, admission.taskId, 1, 1);
        const stoppedVersion = await f.platform.taskVersion(
          human,
          admission.taskId,
        );
        await f.platform.requestTaskRunStop(human, admission.taskId, 1, 1);
        assert.deepEqual(
          await f.platform.taskVersion(human, admission.taskId),
          stoppedVersion,
          "停止回执丢失后重试不再生成事项版本",
        );
        assert.deepEqual(await f.platform.pendingTaskRuns(f.tenantId), []);
        assert.deepEqual(await f.platform.pendingTaskRunStops(f.tenantId), []);
        let state = await f.platform.taskRunPrerequisites(
          human,
          admission.taskId,
          1,
        );
        assert.equal(state.withdrawn, true);
        assert.deepEqual(
          state.prerequisites,
          [],
          "停止后不再读取失效的前置安排",
        );
        await f.platform.respondTask(human, {
          commandId: "response",
          taskId: "human-source",
          expectedRevision: 1,
          body: "结果",
        });
        await f.reopen();
        assert.equal(
          await f.platform.prepareTaskRun(human, admission.eventId, noRuntime),
          null,
          "撤回后不因依赖后来完成而重启",
        );
        const second = await f.start("agent-target");
        assert.equal(second.runNumber, 2);
        assert.notEqual(second.request.id, admission.request.id);
        await assert.rejects(
          f.platform.requestTaskRunStop(human, admission.taskId, 1, 1),
          /执行已变化/,
          "旧停止重试不能撤销新一轮执行",
        );
        assert.ok(
          await f.platform.prepareTaskRun(human, second.eventId, noRuntime),
        );
        f.revoke();
        await assert.rejects(
          f.platform.prepareTaskRun(human, second.eventId, noRuntime),
          /身份|授权/,
        );
        await assert.rejects(
          f.platform.taskRunPrerequisites(human, second.taskId, 2),
          /身份|授权/,
        );
      } finally {
        await f.close();
      }
    },
  );

  test(
    `${backend}: 外部读取时撤权或停止拒绝提交，未准备请求不影响其他事项的投递`,
    options,
    async () => {
      const f = await fixture(backend);
      try {
        await f.create("agent-source", "agent");
        const source = await f.start("agent-source");
        await f.platform.confirmTaskRun(
          f.tenantId,
          source.eventId,
          receipt(source),
        );
        await f.create("agent-target", "agent", ["agent-source"]);
        const admission = await f.start("agent-target");
        let release!: () => void;
        let entered!: () => void;
        const enteredPromise = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const paused = new Promise<void>((resolve) => {
          release = resolve;
        });
        const preparing = f.platform.prepareTaskRun(
          human,
          admission.eventId,
          async (ref) => {
            entered();
            await paused;
            return observation(ref);
          },
        );
        await enteredPromise;
        await f.platform.requestTaskRunStop(human, admission.taskId, 1, 1);
        release();
        assert.equal(await preparing, null);
        const second = await f.start("agent-target");
        await assert.rejects(
          f.platform.prepareTaskRun(human, second.eventId, async (ref) => {
            f.revoke();
            return observation(ref);
          }),
          /身份|授权/,
        );
      } finally {
        await f.close();
      }
    },
  );

  test(
    `${backend}: 同一投递队列等待人工答复，满足后自动投递，丢回执重启不换结果或请求`,
    options,
    async () => {
      const f = await fixture(backend);
      try {
        await f.create("human-source", "human");
        await f.create("agent-target", "agent", ["human-source"]);
        const admission = await f.start("agent-target");
        await f.create("independent", "agent");
        const independent = await f.start("independent");
        const posted: TaskRunAdmission[] = [];
        const failures: string[] = [];
        let loseReceipt = true;
        const dispatcher = () =>
          new PlatformTaskRunDispatcher(
            f.platform,
            f.tenantId,
            {
              async deliverTaskRun(prepared) {
                posted.push(prepared);
                if (prepared.taskId === admission.taskId && loseReceipt) {
                  loseReceipt = false;
                  throw new Error("lost acknowledgement");
                }
                return receipt(prepared);
              },
              async stopPlatformTaskRun() {
                throw new Error("无停止请求");
              },
              async controlPlatformTaskRunSchedule() {
                throw new Error("无控制请求");
              },
            },
            async () => ({ principalId: "alice", actantId: "alice" }),
            (pending) =>
              f.platform.prepareTaskRun(human, pending.eventId, noRuntime),
            (_error, id) => failures.push(id!),
          );
        const activeDispatcher = dispatcher();
        await activeDispatcher.drain();
        assert.deepEqual(
          posted.map((item) => item.eventId),
          [independent.eventId],
        );
        assert.deepEqual(failures, []);
        await f.platform.respondTask(human, {
          commandId: "response",
          taskId: "human-source",
          expectedRevision: 1,
          body: "提交结果",
        });
        await activeDispatcher.drain();
        assert.deepEqual(failures, [admission.eventId]);
        const exact = posted.at(-1)!;
        await f.platform.setTaskCompleted(human, {
          commandId: "reopen-later",
          taskId: "human-source",
          expectedRevision: 2,
          completed: false,
        });
        await f.reopen();
        await dispatcher().drain();
        assert.deepEqual(posted.at(-1), exact);
        assert.equal(
          (await f.platform.listTaskRunLinks(human, admission.taskId)).length,
          1,
        );
        assert.deepEqual(await f.platform.pendingTaskRuns(f.tenantId), []);
      } finally {
        await f.close();
      }
    },
  );
}
