import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
import { viewModelFixture } from "./view-model-fixture.js";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";

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
  fixture: ReturnType<typeof viewModelFixture>,
  title: string,
  extra: Partial<TaskContent> = {},
) =>
  fixture.seedArtifact({
    projectId: "first-project",
    title,
    content: content(extra),
  }).id;

test("事项视图按负责人和状态独立过滤、日期分组且逾期优先，不修改日期或数据", () => {
  const fixture = viewModelFixture();
  create(fixture, "晚到期高优先级", {
    dueDate: "2026-09-15",
    priority: "high",
  });
  create(fixture, "逾期低优先级", { dueDate: "2026-09-12", priority: "low" });
  create(fixture, "今天", { dueDate: "2026-09-13" });
  create(fixture, "无日期");
  create(fixture, "Agent执行", {
    assigneeId: "morphz-agent",
    execution: "active",
  });
  create(fixture, "已完成", { execution: "completed", dueDate: "2025-01-01" });
  create(fixture, "已取消", { execution: "cancelled" });
  const before = structuredClone(fixture.state);
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
  assert.deepEqual(fixture.state, before);
  assert.equal(localDay(new Date(2026, 0, 2, 0, 1)), "2026-01-02");
  assert.deepEqual(
    taskListOptions({ owner: "bad" as "mine", status: "bad" as "open" }),
    defaultTaskList,
  );
});

test("本人勾选完成与重新打开保留版本、回应和幂等回执；拒绝冒领、取消与陈旧版本", async () => {
  const fixture = await platformRuntimeHostFixture();
  const createTask = async (
    title: string,
    extra: { assigneeId?: string; dependsOnIds?: string[] } = {},
  ) => {
    const taskId = randomUUID();
    await fixture.session().createPlatformTask({
      commandId: randomUUID(),
      taskId,
      projectId: fixture.projectId,
      title,
      assigneeId: localAccess.actantId,
      ...extra,
    });
    return taskId;
  };
  try {
    const id = await createTask("本人事项");
    const command = {
      commandId: randomUUID(),
      taskId: id,
      expectedRevision: 1,
      completed: true,
    };
    await assert.rejects(
      fixture
        .session({
          principalId: "morphz-service",
          actantId: "morphz-agent",
        })
        .completePlatformTask(command),
      (error: unknown) =>
        !!error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "forbidden",
    );
    const receipt = await fixture.session().completePlatformTask(command);
    assert.deepEqual(
      await fixture.session().completePlatformTask(command),
      receipt,
    );
    const done = await fixture.session().getPlatformTaskVersion({ taskId: id });
    assert.equal(done.execution, "completed");
    assert.equal(done.revision, 2);
    assert.equal(
      (await fixture.session().listPlatformTaskResponses({ taskId: id }))
        .length,
      0,
    );
    assert.equal(
      (fixture.store.runtimeState() as { deliveries?: unknown[] } | null)
        ?.deliveries?.length ?? 0,
      0,
    );
    await assert.rejects(
      fixture
        .session()
        .completePlatformTask({ ...command, commandId: randomUUID() }),
      /已变化/,
    );
    await fixture.session().completePlatformTask({
      ...command,
      commandId: randomUUID(),
      expectedRevision: 2,
      completed: false,
    });
    await fixture.reopen();
    assert.equal(
      (await fixture.session().getPlatformTaskVersion({ taskId: id }))
        .execution,
      "planned",
    );
    assert.equal(
      (
        await fixture
          .session()
          .getPlatformTaskVersion({ taskId: id, revision: 2 })
      ).execution,
      "completed",
    );
    assert.deepEqual(
      await fixture.session().completePlatformTask(command),
      receipt,
    );
    assert.equal(
      (await fixture.session().getPlatformTaskVersion({ taskId: id })).revision,
      3,
    );
    const agentId = await createTask("Agent事项", {
      assigneeId: "morphz-agent",
    });
    await assert.rejects(
      fixture.session().completePlatformTask({
        ...command,
        commandId: randomUUID(),
        taskId: agentId,
      }),
      /只有当前负责人/,
    );
    const cancelledId = await createTask("取消事项");
    await fixture.session().revisePlatformTask({
      commandId: randomUUID(),
      taskId: cancelledId,
      expectedRevision: 1,
      execution: "cancelled",
    });
    await assert.rejects(
      fixture.session().completePlatformTask({
        ...command,
        commandId: randomUUID(),
        taskId: cancelledId,
        expectedRevision: 2,
      }),
      /已取消/,
    );
    const handoff = await createTask("需要交接");
    await createTask("已安排的后续工作", {
      assigneeId: "morphz-agent",
      dependsOnIds: [handoff],
    });
    await assert.rejects(
      fixture.session().completePlatformTask({
        ...command,
        commandId: randomUUID(),
        taskId: handoff,
      }),
      /提交结果/,
    );
    fixture.assertNoLegacyData();
  } finally {
    await fixture.close();
  }
});
