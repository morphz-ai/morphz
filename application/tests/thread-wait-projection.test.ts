import test from "node:test";
import assert from "node:assert/strict";
import { threadWaitProjection } from "../packages/application/src/thread-wait-projection.js";
import {
  executionActivityStatus,
  executionActivitySummary,
} from "../apps/web/src/execution-activity.js";
import { arrangementTime } from "../apps/web/src/subject-schedules-model.js";

const until = "2026-10-23T01:00:00Z";
const thread = {
  id: "thread",
  session_id: "session",
  context_id: "context",
  lifecycle: "open",
};
const schedule = {
  thread_id: thread.id,
  status: "queued",
  not_before: until,
  dependency_thread_ids: [],
};
const job = {
  thread_id: thread.id,
  session_id: thread.session_id,
  context_id: thread.context_id,
  status: "waiting_approval",
};

test("等待来自同一线程自己的定时事实，保留确切日期而非父目标的等待原因", () => {
  for (const phase of ["idle", "waiting"]) {
    const facts = threadWaitProjection({
      thread,
      phase,
      schedules: [schedule],
    });
    assert.deepEqual(facts, { waitKinds: ["timer"], waitUntil: until });
    assert.equal(
      executionActivityStatus({ ...facts, lifecycle: "open", phase }, true)
        .label,
      `等待定时触发 · ${arrangementTime(until)}`,
    );
  }
  assert.deepEqual(
    threadWaitProjection({
      thread,
      phase: "waiting",
      schedules: [{ ...schedule, thread_id: "other" }],
    }),
    {},
  );
});

test("结束、执行中及待执行不会被历史定时或审批覆盖；断线与暂停状态优先", () => {
  for (const lifecycle of ["completed", "failed", "cancelled"])
    assert.deepEqual(
      threadWaitProjection({
        thread: { ...thread, lifecycle },
        phase: "idle",
        schedules: [schedule],
      }),
      {},
    );
  for (const phase of ["running", "runnable"])
    assert.deepEqual(
      threadWaitProjection({ thread, phase, schedules: [schedule] }),
      {},
    );
  const value = {
    lifecycle: "open",
    phase: "waiting",
    waitKinds: ["timer"],
    waitUntil: until,
  };
  assert.equal(executionActivityStatus(value, false).label, "状态待核对");
  assert.equal(
    executionActivityStatus({ ...value, controlState: "paused" }, true).label,
    "已暂停",
  );
});

test("审批须核对实际 Job 的 Thread、Session、Context 与等待状态", () => {
  const project = (nextJob: typeof job) =>
    threadWaitProjection({
      thread,
      phase: "waiting",
      activations: [{ jobs: [{ job: nextJob }] }],
    });
  assert.deepEqual(project(job), { waitKinds: ["permission"] });
  for (const field of [
    "thread_id",
    "session_id",
    "context_id",
    "status",
  ] as const)
    assert.deepEqual(project({ ...job, [field]: "other" }), {});
});

test("暂停、已派发和失效定时不冒充下一次触发，多个等待保留各自事实", () => {
  const project = (schedules: (typeof schedule)[]) =>
    threadWaitProjection({ thread, phase: "waiting", schedules });
  assert.deepEqual(project([{ ...schedule, status: "paused" }]), {
    waitKinds: ["schedule_resume"],
  });
  for (const status of ["dispatched", "completed", "cancelled"])
    assert.deepEqual(project([{ ...schedule, status }]), {});
  assert.deepEqual(project([{ ...schedule, not_before: "not-a-date" }]), {});
  assert.deepEqual(
    threadWaitProjection({
      thread,
      phase: "waiting",
      activations: [{ jobs: [{ job }] }],
      schedules: [
        schedule,
        { ...schedule, not_before: "2026-10-24T01:00:00Z" },
      ],
    }),
    { waitKinds: ["permission", "timer"], waitUntil: until },
  );
});

test("模型等待必须来自当前线程代次的必需待满足依赖，显示线路而不冒称等用户", () => {
  const edge = {
    owner_kind: "thread",
    owner_id: thread.id,
    owner_generation: 2,
    dependency_kind: "resource",
    dependency_id: "model-route:kimi-k3-256k",
    required: true,
    status: "pending",
  };
  const value = {
    thread: { ...thread, generation: 2 },
    phase: "waiting",
    dependencies: [edge],
  };
  const facts = threadWaitProjection(value);
  assert.deepEqual(facts, {
    waitKinds: ["resource"],
    waitResources: ["model-route:kimi-k3-256k"],
  });
  const activity = {
    ...facts,
    id: thread.id,
    projectId: null,
    conversationId: null,
    inputId: null,
    rootId: "root",
    sessionId: thread.session_id,
    title: "原有标题",
    lifecycle: "open",
    phase: "waiting",
    revision: 1,
    updatedAt: until,
  };
  assert.equal(
    executionActivityStatus(activity, true).label,
    "等待模型恢复 · kimi-k3-256k",
  );
  assert.equal(
    executionActivitySummary(activity, true),
    "等待模型恢复 · kimi-k3-256k",
  );
  assert.equal(
    executionActivitySummary({ ...activity, summary: "实际进展" }, true),
    "实际进展",
  );
  assert.equal(executionActivitySummary(activity, false), "");
  assert.equal(
    executionActivitySummary({ ...activity, phase: "running" }, true),
    "",
  );
  assert.equal(
    executionActivitySummary({ ...activity, controlState: "paused" }, true),
    "",
  );
  for (const patch of [
    { owner_kind: "objective" },
    { owner_id: "other" },
    { owner_generation: 1 },
    { status: "satisfied" },
    { status: "cancelled" },
    { required: false },
  ])
    assert.deepEqual(
      threadWaitProjection({ ...value, dependencies: [{ ...edge, ...patch }] }),
      {},
    );
  assert.deepEqual(threadWaitProjection({ ...value, thread }), {});
  for (const lifecycle of ["completed", "failed", "cancelled"])
    assert.deepEqual(
      threadWaitProjection({
        ...value,
        thread: { ...value.thread, lifecycle },
      }),
      {},
    );
});
