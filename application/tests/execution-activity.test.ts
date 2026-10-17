import test from "node:test";
import assert from "node:assert/strict";
import {
  initialWorkspace,
  type RecordedInput,
} from "../packages/core/src/model.js";
import {
  disconnectedRuntime,
  type ConversationRuntime,
  type RuntimeSchedule,
} from "../packages/core/src/conversation.js";
import { scriptOutputSchema } from "../packages/core/src/script-delivery.js";
import {
  executionActivityDateGroups,
  executionActivityIsDeferred,
  executionActivityOrigin,
  executionActivityOverview,
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

function scheduledRuntime(t: ActivityThread): ConversationRuntime {
  return {
    ...disconnectedRuntime,
    configured: true,
    connected: true,
    activity: {
      available: true,
      truncated: false,
      schedulesAvailable: true,
      threads: [t],
      schedules: [
        {
          scheduleId: "schedule-one",
          threadId: t.id,
          sessionId: t.sessionId,
          contextId: t.contextId!,
          rootId: t.rootId,
          inputId: t.inputId!,
          sourceTurnId: "source-turn",
          sourceRootId: "source-root",
          projectId: t.projectId!,
          conversationId: t.conversationId!,
          status: "queued",
          revision: 1,
          notBefore: "2026-10-23T01:00:00Z",
          intervalSeconds: null,
          dependencyThreadIds: [],
          intent: "按时提醒",
          updatedAt: stamp,
        },
      ],
    },
  };
}

test("统一活动跨作品保留真实执行，待触发定时任务不冒充进行中或历史", () => {
  const waiting = thread({ phase: "waiting", contextId: "context-one" });
  const runtime = scheduledRuntime(waiting);
  const elsewhere = thread({
    id: "elsewhere",
    projectId: "other-project",
    conversationId: "other-conversation",
  });
  const finished = thread({ id: "finished", lifecycle: "completed" });
  const overview = executionActivityOverview(
    state(),
    [waiting, elsewhere, finished],
    scope,
    true,
    false,
    runtime,
  );
  assert.deepEqual(
    overview.active.map((t) => t.id),
    ["elsewhere"],
  );
  assert.deepEqual(
    overview.recent.flatMap((g) => g.threads.map((t) => t.id)),
    ["finished"],
  );
  assert.equal(overview.activeCount, 1);
  assert.equal(
    overview.activityThreads.length,
    3,
    "retain deferred identity for detail and schedule navigation",
  );
  assert.equal(
    runtime.activity!.schedules![0]!.status,
    "queued",
    "classification is read-only",
  );
  for (const alternate of [
    { ...scope, artifactId: "another-work" },
    { projectId: "elsewhere", artifactId: null },
  ])
    assert.deepEqual(
      executionActivityOverview(
        state(),
        [waiting, elsewhere, finished],
        alternate,
        true,
        false,
        runtime,
      ).active,
      overview.active,
    );
});

test("定时分类只接受新鲜快照和逐项一致的持久身份，运行或待执行优先", () => {
  const waiting = thread({ phase: "waiting", contextId: "context-one" });
  const runtime = scheduledRuntime(waiting);
  assert.equal(executionActivityIsDeferred(waiting, runtime), true);
  assert.equal(
    executionActivityIsDeferred({ ...waiting, phase: "idle" }, runtime),
    true,
  );
  for (const field of [
    "threadId",
    "inputId",
    "projectId",
    "conversationId",
    "sessionId",
    "rootId",
    "contextId",
  ] as const) {
    const changed = structuredClone(runtime);
    changed.activity!.schedules![0]![field] = "another-identity";
    assert.equal(executionActivityIsDeferred(waiting, changed), false, field);
  }
  for (const status of [
    "dispatched",
    "completed",
    "cancelled",
  ] as RuntimeSchedule["status"][]) {
    const changed = structuredClone(runtime);
    changed.activity!.schedules![0]!.status = status;
    assert.equal(executionActivityIsDeferred(waiting, changed), false, status);
  }
  for (const phase of ["running", "runnable"] as const)
    assert.equal(
      executionActivityIsDeferred({ ...waiting, phase }, runtime),
      false,
      phase,
    );
  assert.equal(
    executionActivityIsDeferred(
      { ...waiting, lifecycle: "completed" },
      runtime,
    ),
    false,
  );
  assert.equal(
    executionActivityIsDeferred(waiting, { ...runtime, connected: false }),
    false,
  );
  assert.equal(
    executionActivityIsDeferred(waiting, {
      ...runtime,
      activity: { ...runtime.activity!, available: false },
    }),
    false,
  );
  assert.equal(
    executionActivityIsDeferred(waiting, {
      ...runtime,
      activity: { ...runtime.activity!, schedulesAvailable: false },
    }),
    false,
  );
  assert.equal(
    executionActivityIsDeferred(waiting, {
      ...runtime,
      activity: { ...runtime.activity!, schedules: [] },
    }),
    false,
  );
});

test("父任务有真正执行的子任务时仍可见；普通等待不被当作定时任务隐藏", () => {
  const parent = thread({ phase: "waiting", contextId: "context-one" });
  const runtime = scheduledRuntime(parent);
  const child = thread({
    id: "child",
    parentThreadId: parent.id,
    contextId: parent.contextId,
  });
  const result = executionActivityOverview(
    state(),
    [parent, child],
    scope,
    true,
    false,
    runtime,
  );
  assert.deepEqual(
    result.active.map((t) => t.id),
    [parent.id],
  );
  assert.equal(result.activityThreads.length, 2);
  const plainWaiting = thread({ id: "plain-wait", phase: "waiting" });
  assert.deepEqual(
    executionActivityOverview(
      state(),
      [plainWaiting],
      scope,
      true,
      false,
      runtime,
    ).active,
    [plainWaiting],
  );
  const onlyScheduledChild = structuredClone(runtime);
  onlyScheduledChild.activity!.schedules!.push({
    ...runtime.activity!.schedules![0]!,
    scheduleId: "child-schedule",
    threadId: child.id,
  });
  assert.equal(
    executionActivityOverview(
      state(),
      [parent, { ...child, phase: "waiting" }],
      scope,
      true,
      false,
      onlyScheduledChild,
    ).active.length,
    0,
  );
});

test("活动来源使用原输入的对象和交付回执，不猜标题、不显示空项目", () => {
  const workspace = state();
  const desk = workspace.projects.find((p) => p.kind === "desk")!;
  const execution = thread({ projectId: desk.id, conversationId: desk.id });
  workspace.inputs.push(input({ projectId: desk.id, conversationId: desk.id }));
  const catalog = [
    { id: "artifact-one", projectId: desk.id, title: "一碗面换一间铺" },
  ];
  const origin = (t = execution) =>
    executionActivityOrigin(t, workspace, catalog, [], []);
  assert.equal(origin(), "一碗面换一间铺");
  workspace.inputs[0]!.conversationId = "other-conversation";
  assert.equal(origin(), "", "another conversation's input is not the source");
  workspace.inputs[0]!.conversationId = desk.id;
  workspace.inputs[0]!.artifactId = null;
  assert.equal(
    origin(),
    "",
    "no project placeholder and no title/prose guessing",
  );
  const receipt = {
    commandId: "receipt",
    inputId: execution.inputId!,
    projectId: desk.id,
    artifactId: "artifact-one",
    revision: 1,
    createdAt: stamp,
  };
  assert.equal(
    executionActivityOrigin(
      execution,
      workspace,
      catalog,
      [receipt, receipt],
      [],
    ),
    "一碗面换一间铺",
  );
  assert.equal(
    executionActivityOrigin(
      execution,
      workspace,
      catalog,
      [{ ...receipt, inputId: "other-input" }],
      [],
    ),
    "",
  );
  assert.equal(
    executionActivityOrigin(
      execution,
      workspace,
      catalog,
      [{ ...receipt, projectId: "other-project" }],
      [],
    ),
    "",
  );
  const script = scriptOutputSchema.parse({
    commandId: "script-receipt",
    inputId: execution.inputId!,
    projectId: desk.id,
    productionId: "production-one",
    kind: "production",
    title: "全剧大纲",
    productionTitle: "领证前夜",
    createdAt: stamp,
  });
  assert.equal(
    executionActivityOrigin(execution, workspace, [], [], [script]),
    "领证前夜",
  );
  assert.equal(
    executionActivityOrigin(
      execution,
      workspace,
      [],
      [],
      [{ ...script, inputId: "another-input" }],
    ),
    "",
  );
  const project = workspace.projects.find(
    (p) => (p.kind ?? "project") === "project",
  )!;
  assert.equal(
    origin({
      ...execution,
      projectId: project.id,
      conversationId: project.id,
      inputId: null,
    }),
    project.title,
  );
});

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
    executionActivityStatus(
      thread({ controlState: "paused", phase: "waiting" }),
      true,
    ).kind,
    "paused",
  );
  assert.deepEqual(
    executionActivityStatus(thread({ controlState: "paused" }), true),
    { kind: "running", label: "执行中 · 后续已暂停" },
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
