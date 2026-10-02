import test from "node:test";
import assert from "node:assert/strict";
import { initialWorkspace } from "../packages/core/src/model.js";
import { jobSchema } from "../packages/core/src/execution.js";
import {
  executionActivityStatus,
  executionActivitySummary,
  executionActivityTime,
  type ActivityThread,
} from "../apps/web/src/execution-activity.js";
import { executionJobPresentation } from "../apps/web/src/execution-presentation.js";

const stamp = "2026-10-02T12:00:00.000Z";
function thread(overrides: Partial<ActivityThread> = {}): ActivityThread {
  return {
    id: "TEST-annotated-thread",
    kind: "execution",
    projectId: "first-project",
    conversationId: "first-project",
    inputId: "TEST-input",
    rootId: "TEST-root",
    sessionId: "TEST-session",
    title: "核对运行环境",
    summary: "已读取系统版本，继续核对架构",
    phase: "running",
    lifecycle: "open",
    revision: 3,
    updatedAt: stamp,
    ...overrides,
  };
}
function job(overrides: Record<string, unknown> = {}) {
  return jobSchema.parse({
    id: "TEST-job-one",
    revision: 2,
    session_id: "TEST-session",
    context_id: "TEST-context",
    thread_id: "TEST-annotated-thread",
    tool_name: "read",
    target_id: "local",
    request: { path: "TEST-readme.md" },
    status: "succeeded",
    created_at: stamp,
    updated_at: stamp,
    result_event_id: "TEST-receipt-one",
    ...overrides,
  });
}

test("注解阶段只在开放执行的新鲜快照显示，不改变Runtime状态或时间", () => {
  const current = thread();
  assert.equal(executionActivitySummary(current, true), current.summary);
  assert.equal(executionActivitySummary(current, false), "");
  assert.deepEqual(executionActivityStatus(current, false), {
    kind: "unknown",
    label: "状态待核对",
  });
  assert.equal(executionActivityTime(current), stamp);
  assert.equal(current.lifecycle, "open");
});

test("终态注解不冒充成功，真实失败、取消和结束时间仍具有权威性", () => {
  const endedAt = "2026-10-02T12:01:00.000Z";
  for (const [lifecycle, kind, label] of [
    ["completed", "ended", "已结束"],
    ["failed", "failed", "执行失败"],
    ["cancelled", "cancelled", "已取消"],
  ] as const) {
    const current = thread({
      lifecycle,
      summary: "模型提供的结果说明不是执行状态",
      outcome: {
        terminalKind: lifecycle,
        disposition: "ended",
        summary: null,
        createdAt: endedAt,
      },
    });
    assert.equal(executionActivitySummary(current, false), current.summary);
    assert.deepEqual(executionActivityStatus(current, true), { kind, label });
    assert.equal(executionActivityTime(current), endedAt);
  }
});

test("旧无注解线程和空字符串不新增空的摘要行", () => {
  assert.equal(
    executionActivitySummary(thread({ summary: undefined }), true),
    "",
  );
  assert.equal(
    executionActivitySummary(thread({ summary: "  \n " }), true),
    "",
  );
});

test("步骤意图优先于确定性动作名，回执解读只来自当前Job的typed注解", () => {
  const current = job({
    annotation: { intent: "确认项目的运行要求", result: "项目要求 Node 24" },
  });
  assert.deepEqual(executionJobPresentation(current, initialWorkspace()), {
    title: "确认项目的运行要求",
    detail: "TEST-readme.md",
    result: "项目要求 Node 24",
  });
  assert.equal(current.result_event_id, "TEST-receipt-one");
  assert.equal(current.status, "succeeded");
});

test("无真实回执时不展示结果解读，失败状态和原错误不被注解改写", () => {
  const current = job({
    status: "failed",
    error: "读取权限不足",
    result_event_id: null,
    annotation: { intent: "读取必要资料", result: "这个结果尚不能显示" },
  });
  assert.equal(
    executionJobPresentation(current, initialWorkspace()).result,
    null,
  );
  assert.equal(current.status, "failed");
  assert.equal(current.error, "读取权限不足");
});

test("旧步骤保留原确定性展示，不从原参数JSON解析注解或复制命令机密", () => {
  const current = job({
    tool_name: "exec",
    request: {
      command: "SECRET=do-not-display command",
      cwd: "/TEST-workspace",
      _morphz_annotation: {
        intent: "未验证的原始参数不得变成标题",
        observations: [{ ref: "@nearby", result: "不得关联邻近回执" }],
      },
    },
  });
  assert.deepEqual(executionJobPresentation(current, initialWorkspace()), {
    title: "执行命令",
    detail: "/TEST-workspace",
    result: null,
  });
  assert.equal(
    executionJobPresentation(
      job({ annotation: { intent: "  ", result: "  " } }),
      initialWorkspace(),
    ).title,
    "读取文件",
  );
});
