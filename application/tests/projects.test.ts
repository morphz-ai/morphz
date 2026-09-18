import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { AgentTools } from "../packages/application/src/agent-tools.js";
import { localAccess, type Operation } from "../packages/core/src/model.js";
import {
  projectActivity,
  projectStatus,
} from "../packages/core/src/projects.js";
import { RuntimeBridge } from "../packages/application/src/runtime.js";
const agent = { principalId: "morphz-service", actantId: "morphz-agent" };
const input = (projectId: string, conversationId?: string): Operation => ({
  type: "record-input",
  projectId,
  conversationId,
  artifactId: null,
  artifactRevision: null,
  body: "测试项目管理",
  selection: "",
  targetActantId: "morphz-agent",
});
function fixture() {
  const store = new WorkspaceStore(":memory:");
  const run = (operation: Operation) =>
    store.execute({ commandId: randomUUID(), operation }, localAccess).entityId;
  return { store, run };
}

test("项目生命周期保留原数据、独立版本和历史，删除不删除个人持续会话或外部文件", () => {
  const { store, run } = fixture();
  try {
    const id = run({ type: "create-project", title: "项目" });
    const doc = store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "create-artifact",
          projectId: id,
          title: "生命周期结果",
          content: { kind: "document", markdown: "原文" },
        },
      },
      agent,
    ).entityId;
    run(input(id));
    const before = store.snapshot();
    run({
      type: "update-project",
      projectId: id,
      expectedRevision: 1,
      title: "改名",
    });
    assert.throws(
      () =>
        run({
          type: "update-project",
          projectId: id,
          expectedRevision: 1,
          state: "deleted",
        }),
      /变化/,
    );
    const command = {
      commandId: randomUUID(),
      operation: {
        type: "update-project" as const,
        projectId: id,
        expectedRevision: 2,
        state: "archived" as const,
      },
    };
    const receipt = store.execute(command, localAccess);
    assert.deepEqual(store.execute(command, localAccess), receipt);
    assert.throws(() => run(input(id)), /恢复/);
    run({
      type: "update-project",
      projectId: id,
      expectedRevision: 3,
      state: "deleted",
    });
    assert.equal(
      store.search({ query: "生命周期结果", offset: 0, limit: 20 }, localAccess)
        .total,
      0,
    );
    assert.deepEqual(store.snapshot().artifacts, before.artifacts);
    assert.deepEqual(store.snapshot().inputs, before.inputs);
    assert.deepEqual(store.snapshot().conversations, before.conversations);
    assert.equal(
      store.snapshot().artifacts.find((a) => a.id === doc)!.content.kind,
      "document",
    );
    run({
      type: "update-project",
      projectId: id,
      expectedRevision: 4,
      state: "active",
    });
    assert.equal(
      store.search({ query: "生命周期结果", offset: 0, limit: 20 }, localAccess)
        .total,
      1,
    );
    assert.equal(
      projectStatus(store.snapshot().projects.find((p) => p.id === id)!),
      "active",
    );
    for (const p of ["local-dialogue", "local-worktable", "local-inbox"])
      assert.throws(
        () =>
          run({
            type: "update-project",
            projectId: p,
            expectedRevision: 1,
            state: "deleted",
          }),
        /默认工作空间/,
      );
  } finally {
    store.close();
  }
});

test("项目归档和删除在事务中阻止在途、未确认与周期执行；从不隐式停止任务", () => {
  const { store, run } = fixture();
  try {
    const id = run({ type: "create-project", title: "执行保护" });
    const i = run(input(id));
    store.saveRuntimeState({ deliveries: [{ inputId: i, state: "running" }] });
    for (const state of ["archived", "deleted"] as const)
      assert.throws(
        () =>
          run({
            type: "update-project",
            projectId: id,
            expectedRevision: 1,
            state,
          }),
        /先停止/,
      );
    store.saveRuntimeState({
      deliveries: [{ inputId: i, state: "completed" }],
    });
    const task = run({
      type: "create-artifact",
      projectId: id,
      title: "周期任务",
      content: {
        kind: "task",
        description: "合成",
        assigneeId: "morphz-agent",
        model: null,
        priority: "normal",
        dueDate: null,
        assignment: "accepted",
        execution: "planned",
        delivery: "none",
        resultIds: [],
        runRequested: 1,
        everySeconds: 60,
        notBefore: null,
        dependsOnIds: [],
        watchSourceIds: [],
      },
    });
    assert.throws(
      () =>
        run({
          type: "update-project",
          projectId: id,
          expectedRevision: 1,
          state: "deleted",
        }),
      /周期任务/,
    );
    store.saveServiceState("collaboration", {
      runs: [
        {
          taskId: task,
          run: 1,
          artifactRevision: 1,
          controlRevision: 1,
          record: { revision: 1, status: "completed", interval_seconds: 60 },
          threadState: "completed",
        },
      ],
    });
    assert.throws(
      () =>
        run({
          type: "update-project",
          projectId: id,
          expectedRevision: 1,
          state: "archived",
        }),
      /先停止/,
    );
    store.saveServiceState("collaboration", {
      runs: [
        {
          taskId: task,
          run: 1,
          artifactRevision: 1,
          controlRevision: 2,
          sourceStopped: true,
          record: { revision: 2, status: "cancelled", interval_seconds: 60 },
          threadState: "cancelled",
        },
      ],
    });
    run({
      type: "update-project",
      projectId: id,
      expectedRevision: 1,
      state: "deleted",
    });
    assert.equal(
      store.snapshot().artifacts.find((a) => a.id === task)!.revision,
      1,
    );
  } finally {
    store.close();
  }
});

test("智能体管理共用命令、实际用户授权、版本和持久幂等；不同成员项目不可见不可改", () => {
  const { store, run } = fixture();
  try {
    const inputId = run(input("local-dialogue"));
    const tools = new AgentTools(store, "t", () => ({
      projectId: "local-dialogue",
      inputId,
      access: agent,
    }));
    const envelope = (action: string, management: unknown) => ({
      protocol: 1,
      tool: "host_morphz_work",
      invocation: {
        job_id: randomUUID(),
        tool_call_id: "call",
        session_id: "s",
        context_id: "c",
        principal_id: "spoof",
        agent_id: "a",
        target_id: "local",
        thread_id: "t",
      },
      arguments: { action, management },
    });
    const command = envelope("projects", {
      action: "create",
      title: "智能体项目",
    });
    const created = tools.call(command) as any;
    assert.deepEqual(tools.call(command), created);
    const id = created.project.id;
    assert.equal(created.project.ownerPrincipalId, localAccess.principalId);
    tools.call(
      envelope("projects", {
        action: "rename",
        projectId: id,
        revision: 1,
        title: "同一项目",
      }),
    );
    assert.throws(
      () =>
        tools.call(
          envelope("projects", {
            action: "rename",
            projectId: id,
            revision: 1,
            title: "旧版",
          }),
        ),
      /变化/,
    );
    const c = run({
      type: "create-conversation",
      projectId: id,
      title: "会话",
    });
    run(input(id, c));
    const otherProject = run({ type: "create-project", title: "另一个项目" });
    assert.throws(
      () =>
        tools.call(
          envelope("conversations", {
            action: "rename",
            projectId: otherProject,
            conversationId: c,
            revision: 1,
            title: "错误归属",
          }),
        ),
      /会话 ID/,
    );
    assert.equal(
      store.snapshot().conversations.find((x) => x.id === c)!.title,
      "会话",
    );
    tools.call(
      envelope("conversations", {
        action: "archive",
        conversationId: c,
        revision: 1,
      }),
    );
    assert.ok(
      store.snapshot().conversations.find((x) => x.id === c)!.archivedAt,
    );
    tools.call(
      envelope("conversations", {
        action: "restore",
        conversationId: c,
        revision: 2,
      }),
    );
    tools.call(
      envelope("projects", { action: "delete", projectId: id, revision: 2 }),
    );
    const defaultConversations = tools.call(
      envelope("conversations", { action: "list" }),
    ) as any;
    assert.ok(!defaultConversations.items.some((x: any) => x.id === c));
    for (const filter of [{ status: "all" }, { projectId: id }]) {
      const history = tools.call(
        envelope("conversations", { action: "list", ...filter }),
      ) as any;
      assert.equal(
        history.items.find((x: any) => x.id === c)!.projectStatus,
        "deleted",
      );
    }
    tools.call(
      envelope("projects", { action: "restore", projectId: id, revision: 3 }),
    );
    store.provisionMembers([
      {
        principalId: "alice",
        actantId: "alice-human",
        name: "Alice",
        projectIds: [id],
        enabled: true,
      },
    ]);
    const listed = tools.call(
      envelope("projects", { action: "list", status: "all" }),
    ) as any;
    assert.ok(!listed.items.some((p: any) => p.id === id));
    assert.throws(
      () =>
        tools.call(
          envelope("projects", {
            action: "rename",
            projectId: id,
            revision: 4,
            title: "越界",
          }),
        ),
      /不同成员/,
    );
    const anonymous = new AgentTools(store, "t", () => ({
      projectId: "local-dialogue",
      access: agent,
    }));
    assert.throws(
      () => anonymous.call(envelope("projects", { action: "list" })),
      /实际输入/,
    );
  } finally {
    store.close();
  }
});

test("项目最近活动包括会话与准确来源回复，不把共享默认会话的其他项目消息混入", () => {
  const { store, run } = fixture();
  try {
    const id = run({ type: "create-project", title: "活动" });
    const i = run(input(id));
    const state = store.snapshot(),
      p = state.projects.find((p) => p.id === id)!;
    assert.equal(
      projectActivity(state, p, [
        {
          inputId: i,
          projectId: "local-dialogue",
          createdAt: "2099-01-01T00:00:00Z",
        },
      ]),
      "2099-01-01T00:00:00Z",
    );
    assert.notEqual(
      projectActivity(state, p, [
        { inputId: "other", projectId: id, createdAt: "2099-01-01T00:00:00Z" },
      ]),
      "2099-01-01T00:00:00Z",
    );
  } finally {
    store.close();
  }
});

test("已保存但尚未投递的输入不能在归档后启动，恢复后沿用原输入", async () => {
  const { store, run } = fixture();
  const bridge = new RuntimeBridge(store, {
    url: "http://127.0.0.1:1",
    token: "isolated-test",
    namespace: randomUUID(),
  });
  try {
    const id = run({ type: "create-project", title: "投递边界" }),
      i = run(input(id));
    run({
      type: "update-project",
      projectId: id,
      expectedRevision: 1,
      state: "archived",
    });
    assert.throws(() => bridge.enqueue(i), /恢复/);
    run({
      type: "update-project",
      projectId: id,
      expectedRevision: 2,
      state: "active",
    });
    bridge.enqueue(i);
    assert.throws(
      () =>
        run({
          type: "update-project",
          projectId: id,
          expectedRevision: 3,
          state: "deleted",
        }),
      /先停止/,
    );
  } finally {
    await bridge.stop();
    store.close();
  }
});

test("管理输入只豁免自己的运行，不能绕过其他在途工作；授权撤销后不能重放回执", () => {
  const { store, run } = fixture();
  try {
    const id = run({ type: "create-project", title: "管理边界" }),
      origin = run(input(id)),
      other = run(input(id));
    store.saveRuntimeState({
      deliveries: [
        { inputId: origin, state: "running" },
        { inputId: other, state: "running" },
      ],
    });
    const command = {
      commandId: randomUUID(),
      operation: {
        type: "update-project" as const,
        projectId: id,
        expectedRevision: 1,
        state: "archived" as const,
      },
    };
    assert.throws(() => store.execute(command, agent, origin), /先停止/);
    store.saveRuntimeState({
      deliveries: [
        { inputId: origin, state: "running" },
        { inputId: other, state: "completed" },
      ],
    });
    const receipt = store.execute(command, agent, origin);
    assert.deepEqual(store.execute(command, agent, origin), receipt);
    assert.throws(
      () =>
        store.execute(
          {
            ...command,
            commandId: randomUUID(),
            operation: {
              type: "create-artifact",
              projectId: id,
              title: "不可继续写入",
              content: { kind: "document", markdown: "原文" },
            },
          },
          agent,
          origin,
        ),
      /恢复/,
    );
    store.provisionMembers([
      { ...localAccess, name: "本地用户", projectIds: [], enabled: false },
    ]);
    assert.throws(
      () => store.execute(command, agent, origin),
      /权限|实际输入|不匹配/,
    );
  } finally {
    store.close();
  }
});
