import test from "node:test";
import assert from "node:assert/strict";
import { runtimeHintReadPlan as plan } from "../packages/application/src/runtime-hint-read-plan.js";
test("usage and model reasoning do not invalidate unrelated work or authorization inventories", () => {
  for (const topic of [
    "runtime/model_usage",
    "runtime/model_reasoning_summary",
    "runtime/model_stream",
    "runtime/model_request_snapshot",
  ])
    assert.deepEqual(plan(topic), {
      history: false,
      activity: false,
      attention: false,
    });
  assert.deepEqual(plan("runtime/thread_phase_changed"), {
    history: false,
    activity: true,
    attention: false,
  });
  assert.deepEqual(plan("runtime/approval_decision"), {
    history: false,
    activity: true,
    attention: true,
  });
  assert.deepEqual(plan("runtime/thread_completed"), {
    history: true,
    activity: true,
    attention: false,
  });
  assert.deepEqual(plan(), { history: true, activity: true, attention: true });
});
