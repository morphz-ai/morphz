import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WorkspaceStore } from "../packages/application/src/store.js";
import {
  contentSchema,
  localAccess,
  type TaskContent,
} from "../packages/core/src/model.js";
import {
  taskGroups,
  defaultTaskList,
  localDay,
  taskListOptions,
} from "../apps/web/src/task-list.js";

const content = (extra: Partial<TaskContent> = {}) =>
  contentSchema.parse({
    kind: "task",
    description: "TEST",
    assigneeId: "local-human",
    model: null,
    priority: "normal",
    dueDate: null,
    assignment: "accepted",
    execution: "planned",
    delivery: "none",
    resultIds: [],
    ...extra,
  });
const create = (
  store: WorkspaceStore,
  title: string,
  extra: Partial<TaskContent> = {},
) =>
  store.execute(
    {
      commandId: randomUUID(),
      operation: {
        type: "create-artifact",
        projectId: "first-project",
        title,
        content: content(extra),
      },
    },
    localAccess,
  ).entityId;

test("事项视图按负责人和状态独立过滤、日期分组且逾期优先，不修改日期或数据", () => {
  const store = new WorkspaceStore(":memory:");
  try {
    create(store, "晚到期高优先级", {
      dueDate: "2026-09-15",
      priority: "high",
    });
    create(store, "逾期低优先级", { dueDate: "2026-09-12", priority: "low" });
    create(store, "今天", { dueDate: "2026-09-13" });
    create(store, "无日期");
    create(store, "Agent执行", {
      assigneeId: "morphz-agent",
      execution: "active",
    });
    create(store, "已完成", { execution: "completed", dueDate: "2025-01-01" });
    create(store, "已取消", { execution: "cancelled" });
    const before = store.snapshot();
    const groups = taskGroups(
      before,
      localAccess.principalId,
      defaultTaskList,
      "2026-09-13",
    );
    assert.deepEqual(
      groups.map((g) => g.label),
      ["已逾期", "今天到期", "之后到期", "未设截止日期"],
    );
    assert.deepEqual(
      groups.flatMap((g) => g.tasks.map((t) => t.title)),
      ["逾期低优先级", "今天", "晚到期高优先级", "无日期"],
    );
    const agents = taskGroups(
      before,
      localAccess.principalId,
      { ...defaultTaskList, owner: "agent", status: "active" },
      "2026-09-13",
    );
    assert.deepEqual(
      agents.flatMap((g) => g.tasks.map((t) => t.title)),
      ["Agent执行"],
    );
    assert.deepEqual(
      taskGroups(
        before,
        localAccess.principalId,
        { ...defaultTaskList, query: "逾期 低" },
        "2026-09-13",
      )[0]?.tasks.map((t) => t.title),
      ["逾期低优先级"],
    );
    assert.equal(
      taskGroups(
        before,
        "unauthorized",
        { ...defaultTaskList, owner: "all" },
        "2026-09-13",
      ).length,
      0,
    );
    assert.deepEqual(store.snapshot(), before);
    assert.equal(localDay(new Date(2026, 0, 2, 0, 1)), "2026-01-02");
    assert.deepEqual(
      taskListOptions({ owner: "bad" as "mine", status: "bad" as "open" }),
      defaultTaskList,
    );
  } finally {
    store.close();
  }
});

test("本人勾选完成与重新打开保留版本、回应和幂等回执；拒绝冒领、取消与陈旧版本", () => {
  const store = new WorkspaceStore(":memory:");
  try {
    const id = create(store, "本人事项");
    const command = {
      commandId: randomUUID(),
      operation: {
        type: "set-task-completed" as const,
        taskId: id,
        expectedRevision: 1,
        completed: true,
      },
    };
    assert.throws(
      () =>
        store.execute(command, {
          principalId: "morphz-service",
          actantId: "morphz-agent",
        }),
      /只有本人/,
    );
    const receipt = store.execute(command, localAccess);
    assert.deepEqual(store.execute(command, localAccess), receipt);
    const done = store.snapshot().artifacts.find((a) => a.id === id)!;
    assert.equal(
      done.content.kind === "task" && done.content.execution,
      "completed",
    );
    assert.equal(done.revision, 2);
    assert.equal(store.snapshot().taskResponses.length, 0);
    assert.equal(store.snapshot().inputs.length, 0);
    assert.throws(
      () => store.execute({ ...command, commandId: randomUUID() }, localAccess),
      /已变化/,
    );
    store.execute(
      {
        commandId: randomUUID(),
        operation: {
          ...command.operation,
          expectedRevision: 2,
          completed: false,
        },
      },
      localAccess,
    );
    const reopened = store.snapshot().artifacts.find((a) => a.id === id)!;
    assert.equal(
      reopened.content.kind === "task" && reopened.content.execution,
      "planned",
    );
    assert.equal(
      reopened.versions[1]?.content.kind === "task" &&
        reopened.versions[1].content.execution,
      "completed",
    );
    const agentId = create(store, "Agent事项", { assigneeId: "morphz-agent" });
    assert.throws(
      () =>
        store.execute(
          {
            commandId: randomUUID(),
            operation: { ...command.operation, taskId: agentId },
          },
          localAccess,
        ),
      /只有本人/,
    );
    const cancelledId = create(store, "取消事项", { execution: "cancelled" });
    assert.throws(
      () =>
        store.execute(
          {
            commandId: randomUUID(),
            operation: { ...command.operation, taskId: cancelledId },
          },
          localAccess,
        ),
      /已取消/,
    );
    const handoff = create(store, "需要交接");
    create(store, "已安排的后续工作", {
      assigneeId: "morphz-agent",
      dependsOnIds: [handoff],
    });
    assert.throws(
      () =>
        store.execute(
          {
            commandId: randomUUID(),
            operation: { ...command.operation, taskId: handoff },
          },
          localAccess,
        ),
      /提交结果/,
    );
  } finally {
    store.close();
  }
});
