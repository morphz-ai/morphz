import test from "node:test";
import assert from "node:assert/strict";
import {
  initialWorkspace,
  type RecordedInput,
} from "../packages/core/src/model.js";
import {
  executionActivityDateGroups,
  executionActivityScope,
  executionActivityStatus,
  executionActivityThreads,
  executionActivityTime,
  type ActivityThread,
} from "../apps/web/src/execution-activity.js";

const stamp = "2026-10-01T12:00:00.000Z";
const state = () => initialWorkspace(stamp);
const scope = {
  projectId: "first-project",
  conversationId: "first-project",
  artifactId: null,
};
function thread(overrides: Partial<ActivityThread> = {}): ActivityThread {
  return {
    id: "execution-one",
    kind: "execution",
    projectId: "first-project",
    conversationId: "first-project",
    inputId: "input-one",
    rootId: "root-one",
    sessionId: "session-one",
    title: "检查下载进度",
    phase: "running",
    lifecycle: "open",
    controlState: "active",
    revision: 1,
    updatedAt: stamp,
    ...overrides,
  };
}
function input(overrides: Partial<RecordedInput> = {}): RecordedInput {
  return {
    id: "input-one",
    projectId: "first-project",
    conversationId: "first-project",
    artifactId: "artifact-one",
    artifactRevision: null,
    selection: "",
    body: "原消息不是工作标题",
    author: { principalId: "local-owner", actantId: "local-human" },
    targetActantId: "morphz-agent",
    status: "recorded",
    createdAt: stamp,
    ...overrides,
  };
}

test("活动保留真实执行分支，不把每条消息或对话线程包装成工作", () => {
  const source = [
    thread(),
    thread({ id: "execution-two" }),
    thread({ id: "dialogue", kind: "dialogue" }),
    thread({ id: "untyped", kind: undefined }),
  ];
  const entries = executionActivityThreads(
    state(),
    source,
    scope,
    false,
    false,
  );
  assert.deepEqual(
    entries.map((t) => t.id),
    ["execution-one", "execution-two"],
  );
  assert.equal(entries[0]!.title, "检查下载进度");
  assert.equal(source.length, 4);
});

test("历史只按同一线程身份去重，开放执行置前，不因同一 input/root 合并兄弟", () => {
  const newer = thread({
    lifecycle: "completed",
    revision: 3,
    updatedAt: "2026-10-01T13:00:00.000Z",
  });
  const running = thread({
    id: "execution-two",
    updatedAt: "2026-09-30T12:00:00.000Z",
  });
  const entries = executionActivityThreads(
    state(),
    [thread(), newer, running],
    scope,
    false,
    false,
  );
  assert.deepEqual(
    entries.map((t) => t.id),
    ["execution-two", "execution-one"],
  );
  assert.equal(entries[1]!.revision, 3);
});

test("默认个人对话的共享范围遵循既有权限逻辑，具名 Session 不混入", () => {
  const global = {
    ...scope,
    projectId: "local-dialogue",
    conversationId: "local-dialogue",
  };
  const named = thread({ id: "named", conversationId: "named-session" });
  assert.deepEqual(
    executionActivityThreads(
      state(),
      [thread(), named],
      global,
      false,
      true,
    ).map((t) => t.id),
    ["execution-one"],
  );
  assert.equal(
    executionActivityThreads(state(), [thread()], global, false, false).length,
    0,
  );
  assert.equal(
    executionActivityThreads(state(), [thread(), named], global, true, false)
      .length,
    2,
  );
});

test("对象范围只读取可信 input 关联，不从意图文本或别的项目猜来源", () => {
  const workspace = state();
  workspace.inputs.push(input());
  const artifactScope = { ...scope, artifactId: "artifact-one" };
  const unrelated = thread({
    id: "other-project",
    projectId: "local-worktable",
  });
  assert.deepEqual(
    executionActivityThreads(
      workspace,
      [thread(), unrelated],
      artifactScope,
      false,
      false,
    ).map((t) => t.id),
    ["execution-one"],
  );
  assert.equal(
    executionActivityThreads(
      workspace,
      [thread({ inputId: null })],
      artifactScope,
      false,
      false,
    ).length,
    0,
  );
});

test("点击范围保留真实线程、消息、Session 与对象身份", () => {
  const workspace = state();
  workspace.inputs.push(input());
  assert.deepEqual(executionActivityScope(thread(), workspace), {
    ...scope,
    artifactId: "artifact-one",
    inputId: "input-one",
    threadId: "execution-one",
  });
  assert.deepEqual(
    executionActivityScope(thread({ inputId: null }), workspace),
    { ...scope, threadId: "execution-one" },
  );
});

test("已结束不等于任务成功；失败、取消、暂停及断连不能假装运行", () => {
  assert.deepEqual(
    executionActivityStatus(
      thread({
        lifecycle: "completed",
        outcome: {
          terminalKind: "completed",
          disposition: "respond",
          summary: "成功",
          createdAt: stamp,
        },
      }),
      true,
    ),
    { kind: "ended", label: "已结束" },
  );
  assert.equal(
    executionActivityStatus(thread({ lifecycle: "failed" }), false).kind,
    "failed",
  );
  assert.equal(
    executionActivityStatus(thread({ lifecycle: "cancelled" }), true).kind,
    "cancelled",
  );
  assert.equal(
    executionActivityStatus(thread({ controlState: "paused" }), true).kind,
    "paused",
  );
  assert.equal(executionActivityStatus(thread(), false).kind, "unknown");
  assert.equal(
    executionActivityStatus(thread({ phase: "new-phase" }), true).kind,
    "unknown",
  );
});

test("日期分组使用匹配终态的结束时间，不采信冲突 Outcome", () => {
  const now = new Date(2026, 9, 1, 15);
  const yesterday = new Date(2026, 8, 30, 15).toISOString();
  const finished = thread({
    lifecycle: "completed",
    outcome: {
      terminalKind: "completed",
      disposition: "respond",
      summary: null,
      createdAt: now.toISOString(),
    },
    updatedAt: yesterday,
  });
  const previous = thread({
    id: "previous",
    lifecycle: "failed",
    updatedAt: yesterday,
    outcome: {
      terminalKind: "completed",
      disposition: "respond",
      summary: null,
      createdAt: now.toISOString(),
    },
  });
  const groups = executionActivityDateGroups(
    [finished, previous, thread({ id: "invalid", updatedAt: "invalid" })],
    now,
  );
  assert.deepEqual(
    groups.map((group) => group.label),
    ["今天", "昨天", "时间待核对"],
  );
  assert.equal(executionActivityTime(previous), yesterday);
});

test("时间排序比较真实时刻，而非不同时区的时间字符串", () => {
  const older = thread({ id: "older", updatedAt: "2026-10-01T14:00:00+08:00" });
  const newer = thread({ id: "newer", updatedAt: "2026-10-01T12:00:00Z" });
  assert.deepEqual(
    executionActivityThreads(state(), [older, newer], scope, false, false).map(
      (t) => t.id,
    ),
    ["newer", "older"],
  );
});
