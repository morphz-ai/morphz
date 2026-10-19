import assert from "node:assert/strict";
import test from "node:test";
import { executionModelSchema } from "../packages/core/src/inference.js";
import {
  executionModelLabel,
  executionModelDescription,
} from "../apps/web/src/execution-model.js";
import { executionRecordThread } from "../packages/application/src/execution-thread-tree.js";

const physical = executionModelSchema.parse({
  model_attempt_id: "physical-attempt",
  activation_id: "actual-activation",
  model: "gpt-6.1-sol",
  requested_alias: "审阅者",
  reasoning_effort: "max",
  observed_at: "2026-10-19T06:52:00Z",
  endpoint: "must-not-project",
  auth_account_id: "must-not-project",
});
test("activity model labels use only physical recorded facts, with explicit unknown/default distinctions", () => {
  assert.equal(executionModelLabel(physical), "gpt-6.1-sol · 思考：max");
  assert.match(executionModelDescription(physical), /最近一次实际调用/);
  assert.match(executionModelDescription(physical), /请求名：审阅者/);
  assert.equal(
    executionModelLabel({ ...physical, reasoning_effort: null }),
    "gpt-6.1-sol · 思考：default",
  );
  assert.equal(
    executionModelLabel({ ...physical, reasoning_effort: "none" }),
    "gpt-6.1-sol · 思考：none",
  );
  assert.equal(executionModelLabel(null), "模型信息未记录");
  assert.equal(executionModelLabel(undefined), "模型信息未记录");
  assert.ok(!JSON.stringify(physical).includes("must-not-project"));
});
test("execution record preserves per-child physical configuration without borrowing a parent or today's default", () => {
  const row = {
    id: "child",
    session_id: "s",
    context_id: "c",
    root_turn_id: "r",
    parent_thread_id: "parent",
    generation: 1,
    revision: 1,
    lifecycle: "completed",
    control_state: "active",
    phase: "completed",
    created_at: physical.observed_at,
    updated_at: physical.observed_at,
    intent: "审阅",
    execution_model: physical,
  };
  assert.deepEqual(executionRecordThread(row).executionModel, physical);
  assert.equal(
    executionRecordThread({ ...row, execution_model: null }).executionModel,
    undefined,
  );
  const child = {
    ...physical,
    model: "deepseek-flash",
    requested_alias: "盲审",
    reasoning_effort: null,
  };
  assert.equal(
    executionRecordThread({ ...row, execution_model: child }).executionModel
      ?.model,
    "deepseek-flash",
  );
});
