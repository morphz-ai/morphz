import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { Collaboration } from "../packages/application/src/collaboration.js";
import {
  contentSchema,
  localAccess,
  currentTaskResponse,
  orderedTasks,
  type Operation,
  type TaskContent,
} from "../packages/core/src/model.js";
import {
  taskPresentation,
  taskRunBusy,
  taskRuntimeSchema,
} from "../packages/core/src/task-runtime.js";
const content = (extra: Partial<TaskContent> = {}) =>
  contentSchema.parse({
    kind: "task",
    description: "合成验收",
    assigneeId: "local-human",
    model: null,
    priority: "normal",
    dueDate: null,
    assignment: "accepted",
    execution: "planned",
    delivery: "none",
    resultIds: [],
    ...extra,
  }) as TaskContent;
const execute = (s: WorkspaceStore, operation: Operation) =>
  s.execute({ commandId: randomUUID(), operation }, localAccess);
const create = (s: WorkspaceStore, extra: Partial<TaskContent> = {}) =>
  execute(s, {
    type: "create-artifact",
    projectId: "first-project",
    conversationId: "first-project",
    title: "TEST 安排",
    content: content(extra),
  }).entityId;

test("顺序就是优先级：部分排序保留未列出的事项，Human 与 Agent 共享 CAS 和幂等回执", () => {
  const s = new WorkspaceStore(":memory:");
  try {
    const a = create(s),
      b = create(s),
      c = create(s);
    const original = orderedTasks(s.snapshot()).map((a) => a.id);
    const selected = original.slice(0, 2).reverse();
    const command = {
      commandId: randomUUID(),
      operation: {
        type: "reorder-tasks" as const,
        taskIds: selected,
        expectedOrderRevision: 0,
      },
    };
    const result = s.execute(command, localAccess);
    assert.deepEqual(s.execute(command, localAccess), result);
    assert.deepEqual(
      orderedTasks(s.snapshot()).map((a) => a.id),
      [...selected, original[2]],
    );
    assert.equal(
      s.snapshot().artifacts.every((a) => a.revision === 1),
      true,
    );
    assert.throws(
      () =>
        s.execute(
          { ...command, commandId: randomUUID() },
          { principalId: "morphz-service", actantId: "morphz-agent" },
        ),
      /顺序已变化/,
    );
    execute(s, {
      type: "reorder-tasks",
      taskIds: [c, b, a],
      expectedOrderRevision: 1,
      move: { taskId: a, expectedRevision: 1, execution: "active" },
    });
    assert.equal(
      s.snapshot().artifacts.find((t) => t.id === a)!.content.kind,
      "task",
    );
    assert.deepEqual(
      orderedTasks(s.snapshot()).map((a) => a.id),
      [c, b, a],
    );
    assert.equal(s.snapshot().inputs.length, 0);
  } finally {
    s.close();
  }
});

test("就地安排：同一对象移动项目、撤销、无项目、版本和原始会话不改写；拒绝跨权限与断开关联", () => {
  const s = new WorkspaceStore(":memory:");
  try {
    const id = create(s),
      original = s.snapshot().artifacts.find((a) => a.id === id)!;
    const command = {
      commandId: randomUUID(),
      operation: {
        type: "arrange-task" as const,
        taskId: id,
        expectedRevision: 1,
        changes: {
          projectId: "local-inbox",
          dueDate: "2026-09-17",
          priority: "high" as const,
        },
      },
    };
    const receipt = s.execute(command, localAccess);
    assert.deepEqual(s.execute(command, localAccess), receipt);
    let task = s.snapshot().artifacts.find((a) => a.id === id)!;
    assert.equal(task.projectId, "local-inbox");
    assert.equal(task.originProjectId, "first-project");
    assert.equal(task.originConversationId, "first-project");
    assert.deepEqual(task.versions[0], original.versions[0]);
    assert.throws(
      () => execute(s, { ...command.operation, changes: { priority: "low" } }),
      /已变化/,
    );
    execute(s, {
      ...command.operation,
      expectedRevision: 2,
      changes: {
        projectId: "first-project",
        dueDate: null,
        priority: "normal",
      },
    });
    task = s.snapshot().artifacts.find((a) => a.id === id)!;
    assert.equal(task.id, id);
    assert.equal(task.revision, 3);
    assert.equal(task.projectId, "first-project");
    create(s, { dependsOnIds: [id] });
    assert.throws(
      () => execute(s, { ...command.operation, expectedRevision: 3 }),
      /关联/,
    );
    assert.equal(s.snapshot().artifacts.find((a) => a.id === id)!.revision, 3);
    assert.throws(
      () =>
        execute(s, {
          ...command.operation,
          expectedRevision: 3,
          changes: { projectId: "missing" },
        }),
      /不存在/,
    );
  } finally {
    s.close();
  }
});

test("指派不会启动 Agent；禁止手工伪造 Agent 看板状态，执行请求幂等，未提交调度前可撤回", () => {
  const s = new WorkspaceStore(":memory:");
  try {
    const id = create(s);
    execute(s, {
      type: "arrange-task",
      taskId: id,
      expectedRevision: 1,
      changes: { assigneeId: "morphz-agent" },
    });
    let a = s.snapshot().artifacts.find((a) => a.id === id)!;
    assert.equal((a.content as TaskContent).runRequested, 0);
    assert.throws(
      () =>
        execute(s, {
          type: "arrange-task",
          taskId: id,
          expectedRevision: 2,
          changes: { execution: "active" },
        }),
      /实际执行/,
    );
    execute(s, { type: "request-task-run", taskId: id, expectedRevision: 2 });
    assert.throws(
      () =>
        execute(s, {
          type: "request-task-run",
          taskId: id,
          expectedRevision: 3,
        }),
      /重复启动/,
    );
    assert.throws(
      () =>
        execute(s, {
          type: "arrange-task",
          taskId: id,
          expectedRevision: 3,
          changes: { assigneeId: "local-human" },
        }),
      /先停止/,
    );
    execute(s, { type: "cancel-task", taskId: id, expectedRevision: 3 });
    execute(s, {
      type: "arrange-task",
      taskId: id,
      expectedRevision: 4,
      changes: { assigneeId: "local-human" },
    });
    a = s.snapshot().artifacts.find((a) => a.id === id)!;
    assert.equal((a.content as TaskContent).execution, "planned");
    assert.equal((a.content as TaskContent).runRequested, 0);
  } finally {
    s.close();
  }
});

test("旧执行仍开放时，即使 Agent 已交接并重置 runRequested，也不能改派、撤回或重复启动", () => {
  const s = new WorkspaceStore(":memory:");
  try {
    const id = create(s, { assigneeId: "morphz-agent" });
    s.saveServiceState("collaboration", {
      runs: [
        {
          taskId: id,
          run: 1,
          artifactRevision: 1,
          record: {
            revision: 1,
            thread_id: "old-run",
            status: "dispatched",
            interval_seconds: null,
          },
          controlRevision: 0,
          threadState: "open",
          sourceStopped: true,
        },
      ],
    });
    for (const operation of [
      {
        type: "arrange-task",
        taskId: id,
        expectedRevision: 1,
        changes: { assigneeId: "local-human" },
      },
      { type: "request-task-run", taskId: id, expectedRevision: 1 },
      { type: "cancel-task", taskId: id, expectedRevision: 1 },
    ] as Operation[])
      assert.throws(() => execute(s, operation), /先停止/);
    assert.equal(s.snapshot().artifacts[0]!.revision, 1);
  } finally {
    s.close();
  }
});

test("修改日期或兼容优先级字段不使已提交的人工答复失效；重新打开则需要新答复", () => {
  const s = new WorkspaceStore(":memory:");
  try {
    const id = create(s);
    execute(s, {
      type: "respond-task",
      taskId: id,
      expectedRevision: 1,
      body: "确认",
    });
    execute(s, {
      type: "arrange-task",
      taskId: id,
      expectedRevision: 2,
      changes: { dueDate: "2026-09-14", priority: "high" },
    });
    assert.equal(
      currentTaskResponse(s.snapshot(), s.snapshot().artifacts[0]!)?.body,
      "确认",
    );
    execute(s, {
      type: "arrange-task",
      taskId: id,
      expectedRevision: 3,
      changes: { execution: "planned" },
    });
    execute(s, {
      type: "arrange-task",
      taskId: id,
      expectedRevision: 4,
      changes: { execution: "completed" },
    });
    assert.equal(
      currentTaskResponse(s.snapshot(), s.snapshot().artifacts[0]!),
      undefined,
    );
  } finally {
    s.close();
  }
});

test("实际执行优先于对象声明，失败可以显式重试而不丢失成果", () => {
  const s = new WorkspaceStore(":memory:");
  try {
    const id = create(s, { assigneeId: "morphz-agent", runRequested: 1 });
    const runtime = taskRuntimeSchema.parse({
      runs: [
        {
          run: 1,
          artifactRevision: 1,
          record: {
            revision: 1,
            status: "dispatched",
            thread_id: "run-1",
            interval_seconds: null,
          },
          controlRevision: 1,
          threadState: "open",
        },
      ],
    });
    const declaredDone = content({
      assigneeId: "morphz-agent",
      runRequested: 1,
      execution: "completed",
    });
    assert.equal(
      taskPresentation(declaredDone, false, runtime).state,
      "active",
    );
    runtime.runs[0]!.threadState = "failed";
    assert.equal(
      taskPresentation(declaredDone, false, runtime).label,
      "执行失败",
    );
    assert.equal(
      taskPresentation(declaredDone, false, runtime).state,
      "planned",
    );
    assert.equal(taskRunBusy(declaredDone, runtime), false);
    s.saveServiceState("collaboration", {
      runs: runtime.runs.map((r) => ({ ...r, taskId: id })),
    });
    execute(s, { type: "request-task-run", taskId: id, expectedRevision: 1 });
    const next = s.snapshot().artifacts.find((a) => a.id === id)!;
    assert.equal((next.content as TaskContent).runRequested, 2);
    assert.equal(next.versions.length, 2);
  } finally {
    s.close();
  }
});

test("等待仅表达前置条件或确认；失败、执行结束和连接异常不进入等待列", () => {
  const task = content({ assigneeId: "morphz-agent", runRequested: 1 });
  const runtime = taskRuntimeSchema.parse({
    runs: [
      {
        run: 1,
        artifactRevision: 1,
        controlRevision: 1,
        threadState: "completed",
        record: {
          revision: 1,
          thread_id: "thread-1",
          status: "completed",
          interval_seconds: null,
        },
      },
    ],
  });
  assert.equal(taskPresentation(task, false, runtime).state, "planned");
  assert.match(taskPresentation(task, false, runtime).label, /事项未完成/);
  runtime.runs[0]!.threadState = "open";
  runtime.approvalCount = 1;
  assert.equal(taskPresentation(task, false, runtime).label, "等待你的确认");
  runtime.runs[0]!.stopRequested = true;
  assert.equal(taskPresentation(task, false, runtime).label, "正在停止");
  assert.equal(
    taskPresentation(
      task,
      false,
      taskRuntimeSchema.parse({ error: "连接异常，日志里也可能包含依赖二字" }),
    ).state,
    "planned",
  );
  assert.match(
    taskPresentation(content({ execution: "waiting" }), false).label,
    /未说明原因/,
  );
});

test("等待快照来自真实前置事项与有效答复，不以 completed 字段或错误文案猜测", () => {
  const s = new WorkspaceStore(":memory:");
  try {
    const prerequisite = create(s);
    const taskId = create(s, {
      assigneeId: "morphz-agent",
      runRequested: 1,
      dependsOnIds: [prerequisite],
    });
    const collaboration = new Collaboration(s, {
      session: async () => "unused",
      request: async () => {
        throw Error("不得联网");
      },
      enqueue: () => {},
    });
    let runtime = collaboration.snapshot(taskId);
    assert.equal(runtime.blockers[0]!.reason, "response");
    assert.equal(runtime.blockers[0]!.taskId, prerequisite);
    assert.match(
      taskPresentation(
        s.snapshot().artifacts.find((a) => a.id === taskId)!
          .content as TaskContent,
        false,
        runtime,
      ).label,
      /提交结果：TEST 安排/,
    );
    execute(s, {
      type: "respond-task",
      taskId: prerequisite,
      expectedRevision: 1,
      body: "合成验证已完成，可以继续。",
    });
    assert.equal(collaboration.snapshot(taskId).blockers.length, 0);
    execute(s, {
      type: "arrange-task",
      taskId: prerequisite,
      expectedRevision: 2,
      changes: { execution: "planned" },
    });
    assert.equal(
      collaboration.snapshot(taskId).blockers[0]!.reason,
      "response",
    );
    assert.throws(() =>
      collaboration.snapshot(taskId, {
        principalId: "outside",
        actantId: "outside",
      }),
    );
  } finally {
    s.close();
  }
});

test("停止针对真实 Thread，丢回执后恢复核对；确认停止前不允许改派或重复执行", async () => {
  const s = new WorkspaceStore(":memory:");
  let lifecycle = "open",
    threadRevision = 4,
    lost = true,
    cancels = 0;
  const record = {
    id: "",
    revision: 1,
    thread_id: "thread-test",
    status: "dispatched",
    not_before: null,
    interval_seconds: null,
  };
  const port = {
    session: async () => "session-test",
    enqueue: () => {},
    request: async (
      path: string,
      method = "GET",
      body?: unknown,
    ): Promise<unknown> => {
      const data = body as {
        id?: string;
        action?: string;
        expected_revision?: number;
      };
      if (path.endsWith("/schedules") && method === "POST") {
        record.id = data.id!;
        return { ...record };
      }
      if (path.includes("/schedules/")) return { ...record };
      if (path.endsWith("/turns/client-schedule-" + record.id + "/thread"))
        return { thread_id: record.thread_id, lifecycle };
      if (path === "/api/sessions/session-test")
        return { context_id: "context-test" };
      if (path === "/api/contexts/context-test/threads/thread-test") {
        if (method === "POST") {
          assert.equal(data.action, "cancel");
          assert.equal(data.expected_revision, threadRevision);
          lifecycle = "cancelled";
          threadRevision++;
          cancels++;
          if (lost) {
            lost = false;
            throw Error("lost reply");
          }
          return { updated: true, thread: { id: record.thread_id, lifecycle } };
        }
        return {
          snapshot: {
            thread: {
              id: record.thread_id,
              session_id: "session-test",
              context_id: "context-test",
              revision: threadRevision,
              lifecycle,
            },
          },
        };
      }
      throw Error(path);
    },
  };
  try {
    const id = create(s, { assigneeId: "morphz-agent" });
    execute(s, { type: "request-task-run", taskId: id, expectedRevision: 1 });
    let c = new Collaboration(s, port);
    await c.reconcile();
    const run = c.snapshot(id).runs[0]!;
    assert.equal(run.threadState, "open");
    const stopped = await c.control(id, run.run, run.controlRevision, "stop");
    assert.equal(stopped.runs[0]!.stopRequested, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.throws(
      () =>
        execute(s, {
          type: "arrange-task",
          taskId: id,
          expectedRevision: 2,
          changes: { assigneeId: "local-human" },
        }),
      /先停止/,
    );
    c = new Collaboration(s, port);
    await c.reconcile();
    const view = taskRuntimeSchema.parse(c.snapshot(id)),
      task = s.snapshot().artifacts.find((a) => a.id === id)!
        .content as TaskContent;
    assert.equal(view.runs[0]!.threadState, "cancelled");
    assert.equal(view.runs[0]!.stopRequested, false);
    assert.equal(cancels, 1);
    assert.equal(taskRunBusy(task, view), false);
    assert.equal(taskPresentation(task, false, view).label, "已停止");
    execute(s, {
      type: "arrange-task",
      taskId: id,
      expectedRevision: 2,
      changes: { assigneeId: "local-human" },
    });
  } finally {
    s.close();
  }
});
