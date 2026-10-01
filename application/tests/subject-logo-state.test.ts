import test from "node:test";
import assert from "node:assert/strict";
import {
  activitySchema,
  conversationRuntimeSchema,
  type ConversationRuntime,
  type ExecutionActivity,
} from "../packages/core/src/conversation.js";
import { subjectLogoState } from "../apps/web/src/subject-sidebar-model.js";

type Thread = ExecutionActivity["threads"][number];
const stamp = "2026-10-01T12:00:00.000Z";
function thread(overrides: Partial<Thread> = {}): Thread {
  return activitySchema.shape.threads.element.parse({
    id: "logo-thread",
    kind: "execution",
    projectId: "logo-project",
    conversationId: "logo-conversation",
    inputId: "logo-input",
    rootId: "logo-root",
    sessionId: "logo-session",
    title: "TEST 实际工作状态样本",
    phase: "running",
    lifecycle: "open",
    controlState: "active",
    revision: 1,
    updatedAt: stamp,
    ...overrides,
  });
}
function runtime(overrides: Partial<ConversationRuntime> = {}) {
  return conversationRuntimeSchema.parse({
    configured: true,
    connected: true,
    model: "test-model",
    error: "",
    deliveries: [],
    messages: [],
    activity: { available: true, truncated: false, threads: [] },
    attention: { available: true, approvals: [] },
    ...overrides,
  });
}
const snapshot = (threads: Thread[]) =>
  runtime({ activity: { available: true, truncated: false, threads } });
function check(
  value: ConversationRuntime,
  state: ReturnType<typeof subjectLogoState>["state"],
  working = false,
  online = true,
) {
  const result = subjectLogoState(value, online);
  assert.equal(result.state, state);
  assert.equal(result.working, working);
  assert.equal(result.view, state === "approval" ? "permissions" : "activity");
  assert.ok(result.label.trim());
}
const approvals: NonNullable<ConversationRuntime["attention"]>["approvals"] = [
  {
    scope: {
      projectId: "logo-project",
      artifactId: null,
      inputId: "logo-input",
    },
    approval: {
      fingerprint: "a".repeat(64),
      requested_at: stamp,
      request: {
        approval_id: "logo-approval",
        session_id: "logo-session",
        context_id: "logo-context",
        justification: "TEST 实际授权请求样本",
        action: {},
        requested: {},
      },
    },
  },
];

test("对话和后台执行仅在实际running时灵动，终态不重现活动", () => {
  for (const kind of ["execution", "dialogue_turn"]) {
    check(snapshot([thread({ kind })]), "working", true);
    for (const phase of ["runnable", "waiting", "idle"])
      check(snapshot([thread({ kind, phase })]), "waiting");
    for (const lifecycle of ["completed", "failed", "cancelled"])
      check(snapshot([thread({ kind, lifecycle })]), "idle");
  }
});

test("暂停后仍运行的当前步骤不能称已暂停，混合等待不称全部暂停", () => {
  check(snapshot([thread({ controlState: "paused" })]), "working", true);
  check(
    snapshot([thread({ phase: "waiting", controlState: "paused" })]),
    "paused",
  );
  for (const phase of ["runnable", "waiting"])
    check(
      snapshot([
        thread({ id: "paused", phase: "waiting", controlState: "paused" }),
        thread({ id: "advancing", phase }),
      ]),
      "waiting",
    );
});

test("新鲜审批优先进入授权，但并行running保留灵动", () => {
  for (const threads of [[], [thread()]])
    check(
      runtime({
        activity: { available: true, truncated: false, threads },
        attention: { available: true, approvals },
      }),
      "approval",
      threads.length > 0,
    );
  check(runtime({ attention: { available: false, approvals } }), "unknown");
});

test("断线、缺快照、读取失败、截断空和审批未知均不冒充空闲", () => {
  check(runtime(), "unknown", false, false);
  check(runtime({ connected: false }), "unknown");
  check(runtime({ activity: undefined }), "unknown");
  check(
    runtime({
      activity: { available: false, truncated: false, threads: [thread()] },
    }),
    "unknown",
  );
  check(
    runtime({ activity: { available: true, truncated: true, threads: [] } }),
    "unknown",
  );
  check(
    runtime({
      activity: {
        available: true,
        truncated: false,
        objectivesTruncated: true,
        threads: [],
      },
    }),
    "unknown",
  );
  check(runtime({ attention: undefined }), "unknown");
  check(runtime({ attention: { available: false, approvals: [] } }), "unknown");
  check(runtime(), "idle");
});

test("未终态delivery只是待处理提示，不证明实际执行", () => {
  for (const state of ["queued", "sending", "running"] as const)
    check(
      runtime({
        deliveries: [
          { inputId: "logo-input", state, error: null, retryable: false },
        ],
      }),
      "waiting",
    );
  for (const state of ["completed", "failed", "cancelled"] as const)
    check(
      runtime({
        deliveries: [
          { inputId: "logo-input", state, error: null, retryable: false },
        ],
      }),
      "idle",
    );
});

test("单个Objective不能把整个主体称暂停或正在执行，未知类型保持未知", () => {
  for (const status of ["active", "paused", "blocked", "future-status"]) {
    const goal = activitySchema.shape.objectives.unwrap().element.parse({
      id: "logo-objective",
      projectId: "logo-project",
      conversationId: "logo-conversation",
      inputId: "logo-input",
      rootId: "logo-root",
      sessionId: "logo-session",
      title: "TEST 目标样本",
      status,
      statusReason: null,
      readiness: "waiting",
      parentId: null,
      threadIds: [],
      updatedAt: stamp,
    });
    check(
      runtime({
        activity: {
          available: true,
          truncated: false,
          threads: [],
          objectives: [goal],
        },
      }),
      status === "future-status" ? "unknown" : "waiting",
    );
  }
  check(snapshot([thread({ kind: "future-kind" })]), "unknown");
  check(snapshot([thread({ kind: undefined })]), "unknown");
  check(snapshot([thread({ phase: "future-phase" })]), "unknown");
});
