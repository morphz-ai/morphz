import test from "node:test";
import assert from "node:assert/strict";
import {
  activitySchema,
  conversationRuntimeSchema,
  type ConversationRuntime,
  type ExecutionActivity,
} from "../packages/core/src/conversation.js";
import {
  taskRuntimeSchema,
  type TaskRuntime,
} from "../packages/core/src/task-runtime.js";
import {
  liveArrangement,
  objectiveStatus,
  objectiveDetailStatus,
  subjectStatus,
} from "../apps/web/src/subject-sidebar-model.js";

type Thread = ExecutionActivity["threads"][number];
test("目标说明来自结构化状态，不解析或伪造 Runtime 原始原因", () => {
  for (const [readiness, label] of [
    ["runnable", "等待推进"],
    ["waiting", "等待关联工作或条件"],
    ["leased", "正在评估进展"],
    ["suspended", "等待恢复推进"],
  ])
    assert.equal(objectiveDetailStatus("active", readiness!), label);
  assert.equal(objectiveDetailStatus("completed", "waiting"), "已完成");
  assert.equal(objectiveDetailStatus("paused", "runnable"), "已暂停");
  assert.equal(objectiveDetailStatus("active", "future-state"), "状态待核对");
});
const stamp = "2026-10-01T12:00:00.000Z";
function thread(overrides: Partial<Thread> = {}): Thread {
  return activitySchema.shape.threads.element.parse({
    id: "thread-one",
    kind: "execution",
    projectId: "project-one",
    conversationId: "conversation-one",
    inputId: "input-one",
    rootId: "root-one",
    sessionId: "session-one",
    title: "原始工作意图",
    phase: "running",
    lifecycle: "open",
    controlState: "active",
    revision: 1,
    updatedAt: stamp,
    ...overrides,
  });
}
function runtime(
  overrides: Partial<ConversationRuntime> = {},
): ConversationRuntime {
  return conversationRuntimeSchema.parse({
    configured: true,
    connected: true,
    model: "test-model",
    error: "",
    deliveries: [],
    messages: [],
    activity: { available: true, truncated: false, threads: [] },
    ...overrides,
  });
}
type Run = TaskRuntime["runs"][number];
function run(overrides: Partial<Run> = {}): Run {
  return taskRuntimeSchema.shape.runs.unwrap().element.parse({
    run: 2,
    artifactRevision: 4,
    record: { revision: 1, status: "queued", interval_seconds: null },
    controlRevision: 1,
    threadState: null,
    ...overrides,
  });
}
function task(
  observed: Run,
  overrides: Partial<TaskRuntime> = {},
): TaskRuntime {
  return taskRuntimeSchema.parse({ runs: [observed], ...overrides });
}

test("主体状态只使用新鲜且在线的执行快照，缺失和陈旧不伪报空闲", () => {
  assert.equal(subjectStatus(runtime(), false), "暂未连接");
  assert.equal(subjectStatus(runtime({ connected: false }), true), "暂未连接");
  assert.equal(
    subjectStatus(runtime({ activity: undefined }), true),
    "状态待核对",
  );
  assert.equal(
    subjectStatus(
      runtime({
        activity: { available: false, truncated: false, threads: [thread()] },
      }),
      true,
    ),
    "状态待核对",
  );
  assert.equal(
    subjectStatus(
      runtime({ activity: { available: true, truncated: true, threads: [] } }),
      true,
    ),
    "状态待核对",
  );
  assert.equal(subjectStatus(runtime(), true), "目前没有进行中的执行");
  assert.equal(
    subjectStatus(
      runtime({
        activity: {
          available: true,
          truncated: true,
          objectivesTruncated: true,
          openWorkComplete: true,
          threads: [],
        },
      }),
      true,
    ),
    "目前没有进行中的执行",
  );
  assert.equal(
    subjectStatus(
      runtime({
        activity: {
          available: true,
          truncated: false,
          openWorkComplete: false,
          threads: [],
        },
      }),
      true,
    ),
    "状态待核对",
  );
});

test("主体不把暂停、等待、对话或终态执行称为正在推进", () => {
  const status = (threads: Thread[], truncated = false) =>
    subjectStatus(
      runtime({ activity: { available: true, truncated, threads } }),
      true,
    );
  assert.equal(status([thread({ controlState: "paused" })]), "1 项工作已暂停");
  assert.equal(
    status([thread({ controlState: "paused" })], true),
    "至少 1 项工作已暂停",
  );
  assert.equal(status([thread({ phase: "waiting" })]), "1 项工作等待后续条件");
  assert.equal(status([thread({ phase: "idle" })]), "1 项工作等待后续条件");
  assert.equal(status([thread()]), "1 项工作正在推进");
  assert.equal(
    status([thread(), thread({ id: "paused", controlState: "paused" })]),
    "1 项工作正在推进",
  );
  assert.equal(
    status([
      thread({ kind: "dialogue_turn" }),
      thread({ lifecycle: "completed" }),
      thread({ lifecycle: "failed" }),
      thread({ lifecycle: "cancelled" }),
    ]),
    "目前没有进行中的执行",
  );
});

test("只有新鲜审批触发等待批准；未知Objective状态不能编造含义", () => {
  const approvals = [
    {
      scope: {
        projectId: "project-one",
        artifactId: null,
        inputId: "input-one",
      },
      approval: {
        fingerprint: "a".repeat(64),
        requested_at: stamp,
        request: {
          approval_id: "approval-one",
          session_id: "session-one",
          context_id: "context-one",
          justification: "真实审批",
          action: {},
          requested: {},
        },
      },
    },
  ];
  assert.equal(
    subjectStatus(runtime({ attention: { available: true, approvals } }), true),
    "等待你的批准",
  );
  assert.equal(
    subjectStatus(
      runtime({ attention: { available: false, approvals } }),
      true,
    ),
    "目前没有进行中的执行",
  );
  assert.equal(objectiveStatus("paused"), "已暂停");
  assert.equal(objectiveStatus("completed"), "已完成");
  assert.equal(objectiveStatus("future-status"), "状态待核对");
});

test("事项安排按确切run和真实record确认；无record或读取失败不造计划", () => {
  assert.equal(liveArrangement(task(run()), 1), null);
  assert.equal(liveArrangement(task(run({ record: null })), 2), null);
  assert.equal(
    liveArrangement(task(run({ error: "Runtime unavailable" })), 2),
    null,
  );
  assert.equal(
    liveArrangement(task(run(), { error: "State unverified" }), 2),
    null,
  );
  const older = run({
    run: 1,
    record: { revision: 2, status: "queued", interval_seconds: 60 },
  });
  const latest = run({
    record: { revision: 3, status: "completed", interval_seconds: null },
  });
  assert.equal(
    liveArrangement(task(latest, { runs: [older, latest] }), 2),
    null,
  );
  assert.equal(
    liveArrangement(task(older, { runs: [older, latest] }), 1)?.run,
    1,
  );
});

test("已取消或正式停止的安排不因保留interval/watch字段重新出现", () => {
  for (const interval of [null, 60])
    for (const watch of [false, true]) {
      const observed = run({
        record: {
          revision: 2,
          status: "cancelled",
          interval_seconds: interval,
        },
        hasSourceWatch: watch,
      });
      assert.equal(liveArrangement(task(observed), 2), null);
    }
  assert.equal(
    liveArrangement(
      task(run({ sourceStopped: true, hasSourceWatch: true })),
      2,
    ),
    null,
  );
});

test("完成不等于仍有重复计划；真实持续关注和重复dispatched可继续展示", () => {
  assert.equal(
    liveArrangement(
      task(
        run({
          record: { revision: 2, status: "completed", interval_seconds: 60 },
        }),
      ),
      2,
    ),
    null,
  );
  assert.equal(
    liveArrangement(
      task(
        run({
          record: { revision: 2, status: "completed", interval_seconds: null },
          hasSourceWatch: true,
        }),
      ),
      2,
    )?.hasSourceWatch,
    true,
  );
  assert.equal(
    liveArrangement(
      task(
        run({
          record: { revision: 2, status: "dispatched", interval_seconds: null },
        }),
      ),
      2,
    ),
    null,
  );
  assert.equal(
    liveArrangement(
      task(
        run({
          record: { revision: 2, status: "dispatched", interval_seconds: 60 },
        }),
      ),
      2,
    )?.record?.interval_seconds,
    60,
  );
  assert.ok(
    liveArrangement(
      task(
        run({
          record: { revision: 2, status: "dispatched", interval_seconds: null },
          hasSourceWatch: true,
        }),
      ),
      2,
    ),
  );
});

test("暂停与尚未收敛的停止/控制请求保留真实标志，不冒充已停止", () => {
  const paused = run({
    paused: true,
    record: { revision: 2, status: "paused", interval_seconds: 120 },
  });
  assert.equal(liveArrangement(task(paused), 2)?.paused, true);
  const stopping = run({
    stopRequested: true,
    controlPending: "stop",
    hasSourceWatch: true,
  });
  assert.equal(liveArrangement(task(stopping), 2)?.stopRequested, true);
  assert.equal(liveArrangement(task(stopping), 2)?.controlPending, "stop");
});
