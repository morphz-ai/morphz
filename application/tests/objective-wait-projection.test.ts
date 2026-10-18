import test from "node:test";
import assert from "node:assert/strict";
import { objectiveWaitKinds } from "../packages/application/src/objective-wait-projection.js";
import { executionWaitLabel } from "../apps/web/src/execution-wait-label.js";
import { executionActivityStatus } from "../apps/web/src/execution-activity.js";
import { objectiveDetailStatus } from "../apps/web/src/subject-sidebar-model.js";

test("waiting reasons use only exact required pending edges in the current owner generation", () => {
  const edge = {
    id: "edge",
    owner_kind: "objective",
    owner_id: "goal",
    owner_generation: 2,
    dependency_kind: "user_input",
    required: true,
    status: "pending",
  };
  const value = {
    readiness: { state: "waiting", dependency_ids: ["edge"] },
    objective: { id: "goal", generation: 2 },
    dependencies: [edge],
  };
  assert.deepEqual(objectiveWaitKinds(value), ["user_input"]);
  for (const patch of [
    { owner_kind: "thread" },
    { owner_id: "other" },
    { owner_generation: 1 },
    { required: false },
    { status: "satisfied" },
    { id: "another" },
  ])
    assert.deepEqual(
      objectiveWaitKinds({ ...value, dependencies: [{ ...edge, ...patch }] }),
      [],
    );
  assert.deepEqual(
    objectiveWaitKinds({
      ...value,
      readiness: { state: "waiting", dependency_ids: ["edge", "missing"] },
    }),
    [],
  );
  assert.equal(
    objectiveWaitKinds({ ...value, readiness: { state: "leased" } }),
    undefined,
  );
});
test("Human input, approval, tasks, timer and unknown are distinct; terminal/running/stale state wins", () => {
  for (const [kind, text] of [
    ["user_input", "等待你回复"],
    ["permission", "等待你批准"],
    ["timer", "等待定时触发"],
    ["thread_group", "等待子任务结果"],
    ["tool_task", "等待工具结果"],
    ["external_event", "等待外部事件"],
  ]) {
    assert.equal(executionWaitLabel([kind!]), text);
    assert.equal(objectiveDetailStatus("active", "waiting", [kind!]), text);
    assert.equal(
      executionActivityStatus(
        {
          lifecycle: "open",
          phase: "idle",
          controlState: "active",
          waitKinds: [kind!],
        },
        true,
      ).label,
      text,
    );
  }
  assert.equal(executionWaitLabel(), "等待中（未提供具体原因）");
  assert.equal(executionWaitLabel(["future"]), "等待其他条件");
  assert.equal(
    executionWaitLabel(["user_input", "timer"]),
    "等待你回复、定时触发",
  );
  assert.equal(
    executionActivityStatus(
      { lifecycle: "open", phase: "running", waitKinds: ["user_input"] },
      true,
    ).label,
    "执行中",
  );
  assert.equal(
    executionActivityStatus(
      { lifecycle: "completed", phase: "idle", waitKinds: ["user_input"] },
      true,
    ).label,
    "已结束",
  );
  assert.equal(
    executionActivityStatus(
      { lifecycle: "open", phase: "idle", waitKinds: ["user_input"] },
      false,
    ).label,
    "状态待核对",
  );
});
