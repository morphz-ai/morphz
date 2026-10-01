import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { viewModelFixture } from "./view-model-fixture.js";
import { RuntimeTaskRunStatusReader } from "../packages/application/src/runtime-task-run-status.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import { localAccess, type Operation } from "../packages/core/src/model.js";
import {
  projectActivity,
  projectDirectoryMetrics,
  projectStatus,
} from "../packages/core/src/projects.js";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";
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

test("项目生命周期保留原件版本和持续对话，归档／删除不删除应用私库", async () => {
  const f = await platformRuntimeHostFixture();
  try {
    const id = f.projectId;
    const doc = await f.session().createPlatformDocument({
      commandId: randomUUID(),
      objectId: "lifecycle-document",
      projectId: id,
      title: "生命周期结果",
      markdown: "原文",
    });
    const spaces = await f.session().ensurePlatformSpaces();
    const receipt = await f.session().platformMessage({
      commandId: randomUUID(),
      operation: input(id, spaces.dialogueId),
    });
    await f.session().cancelInput(receipt.entityId);
    const before = structuredClone(f.store.runtimeState());
    const original = await f
      .session()
      .readPlatformDocument({ contentId: doc.contentId, revision: 1 });
    await f.session().renamePlatformProject({
      commandId: randomUUID(),
      projectId: id,
      expectedRevision: 1,
      title: "改名",
    });
    await assert.rejects(
      f.session().changePlatformProjectState({
        commandId: randomUUID(),
        projectId: id,
        expectedRevision: 1,
        state: "deleted",
      }),
      /已更新/,
    );
    const archive = {
      commandId: randomUUID(),
      projectId: id,
      expectedRevision: 2,
      state: "archived",
    };
    assert.equal(await f.session().changePlatformProjectState(archive), id);
    assert.equal(await f.session().changePlatformProjectState(archive), id);
    await assert.rejects(
      f.session().platformMessage({
        commandId: randomUUID(),
        operation: input(id, spaces.dialogueId),
      }),
      { code: "forbidden" },
    );
    await f.session().changePlatformProjectState({
      commandId: randomUUID(),
      projectId: id,
      expectedRevision: 3,
      state: "deleted",
    });
    assert.equal(
      (
        await f
          .session()
          .search({ query: "生命周期结果", offset: 0, limit: 20 })
      ).total,
      0,
    );
    await assert.rejects(
      f
        .session()
        .readPlatformDocument({ contentId: doc.contentId, revision: 1 }),
      { code: "not_found" },
    );
    assert.deepEqual(f.store.runtimeState(), before);
    await f.session().changePlatformProjectState({
      commandId: randomUUID(),
      projectId: id,
      expectedRevision: 4,
      state: "active",
    });
    assert.equal(
      (
        await f
          .session()
          .search({ query: "生命周期结果", offset: 0, limit: 20 })
      ).total,
      1,
    );
    const restored = await f.session().getPlatformProject({ projectId: id });
    assert.equal(
      projectStatus({
        ...restored,
        members: restored.memberPrincipalIds,
        ownerPrincipalId: restored.ownerPrincipalId ?? undefined,
      }),
      "active",
    );
    for (const projectId of [spaces.dialogueId, spaces.deskId, spaces.inboxId])
      await assert.rejects(
        f.session().changePlatformProjectState({
          commandId: randomUUID(),
          projectId,
          expectedRevision: 1,
          state: "deleted",
        }),
        /默认空间/,
      );
    await f.reopen();
    assert.deepEqual(
      await f
        .session()
        .readPlatformDocument({ contentId: doc.contentId, revision: 1 }),
      original,
    );
    assert.deepEqual(f.store.runtimeState(), before);
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("项目归档和删除阻止在途、未确认与周期执行；从不隐式停止任务", async () => {
  const f = await platformRuntimeHostFixture();
  try {
    const id = f.projectId;
    const pending = await f.session().platformMessage({
      commandId: randomUUID(),
      operation: input(id),
    });
    const retire = (state: "archived" | "deleted") =>
      f.session().changePlatformProjectState({
        commandId: randomUUID(),
        projectId: id,
        expectedRevision: 1,
        state,
      });
    for (const state of ["archived", "deleted"] as const)
      await assert.rejects(retire(state), /正在处理/);
    assert.equal(
      (await f.session().getPlatformProject({ projectId: id })).revision,
      1,
    );
    await f.session().cancelInput(pending.entityId);
    const taskId = "periodic-task";
    await f.session().createPlatformTask({
      commandId: randomUUID(),
      taskId,
      projectId: id,
      title: "周期任务",
      description: "合成",
      assigneeId: "morphz-agent",
      everySeconds: 60,
    });
    const admission = await f.domains.work.authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        f.domains.content.platform.requestTaskRun(actor, {
          commandId: randomUUID(),
          taskId,
          expectedRevision: 1,
          sessionId: "controlled-periodic-session",
          intent: "合成执行",
          notBefore: "2026-09-30T00:00:00.000Z",
        }),
    );
    const original = await f.session().getPlatformTaskVersion({ taskId });
    await assert.rejects(retire("deleted"), /未确认的事项执行请求/);
    assert.deepEqual(
      await f.session().getPlatformTaskVersion({ taskId }),
      original,
    );
    const receipt = {
      schedule: {
        id: admission.request.id,
        thread_id: "controlled-periodic-thread",
        revision: 1,
        status: "queued" as const,
        not_before: admission.request.not_before,
        interval_seconds: 60,
      },
      thread: {
        thread_id: "controlled-periodic-thread",
        session_id: admission.sessionId,
        root_turn_id: "client-schedule-" + admission.request.id,
        lifecycle: "open" as const,
      },
    };
    await f.domains.content.platform.confirmTaskRun(
      f.store.identity(),
      admission.eventId,
      receipt,
    );
    // Only the Runtime read transport is controlled. Status parsing, exact
    // schedule/thread provenance, retirement fencing and persistence are real.
    let scheduleStatus: "queued" | "completed" | "cancelled" = "queued";
    let lifecycle: "open" | "completed" | "cancelled" = "open";
    f.runtime.taskRunStatusReader = () =>
      new RuntimeTaskRunStatusReader(async (path, access) => {
        assert.deepEqual(access, localAccess);
        if (path.endsWith("/schedules/" + admission.request.id))
          return { ...receipt.schedule, revision: 2, status: scheduleStatus };
        assert.ok(
          path.endsWith(
            "/turns/client-schedule-" + admission.request.id + "/thread",
          ),
        );
        return { ...receipt.thread, revision: 2, lifecycle };
      });
    await assert.rejects(retire("archived"), /进行中或周期性的事项执行/);
    scheduleStatus = "completed";
    lifecycle = "completed";
    await assert.rejects(retire("archived"), /进行中或周期性的事项执行/);
    assert.deepEqual(
      await f.session().getPlatformTaskVersion({ taskId }),
      original,
    );
    scheduleStatus = "cancelled";
    lifecycle = "cancelled";
    await retire("deleted");
    assert.deepEqual(
      await f.session().getPlatformTaskVersion({ taskId }),
      original,
    );
    assert.ok(
      (await f.session().getPlatformProject({ projectId: id })).deletedAt,
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("智能体管理共用真实 Platform 命令、用户授权、版本和持久幂等；不同成员项目不可见不可改", async () => {
  const checked: string[] = [];
  const f = await agentDomainFixture({
    additionalHumans: [{ principalId: "alice", actantId: "alice-human" }],
    assertProjectInputsSettled: async (projectId) => {
      checked.push(projectId);
    },
  });
  try {
    const spaces = await f.withHuman((actor) =>
      f.domains.work.service.ensurePersonalSpaces(actor),
    );
    const personalRoute = f.input(spaces.dialogueId);
    const call = <T>(args: unknown, invocation = personalRoute) =>
      f.call<T>(args, invocation);
    const command = f.envelope(
      {
        action: "projects",
        management: { action: "create", title: "智能体项目" },
      },
      personalRoute,
    );
    const created = (await f.tools.call(command)) as {
      project: { id: string };
    };
    assert.deepEqual(await f.tools.call(command), created);
    const id = created.project.id;
    const project = await f.withHuman((actor) =>
      f.domains.work.service.getProject(actor, { projectId: id }),
    );
    assert.equal(project.ownerPrincipalId, localAccess.principalId);
    await call({
      action: "projects",
      management: {
        action: "rename",
        projectId: id,
        revision: 1,
        title: "同一项目",
      },
    });
    await assert.rejects(
      call({
        action: "projects",
        management: {
          action: "rename",
          projectId: id,
          revision: 1,
          title: "旧版",
        },
      }),
      /已更新/,
    );
    const conversationId = `conversation_${randomUUID().replaceAll("-", "")}`;
    await f.withHuman((actor) =>
      f.domains.work.service.startConversation(actor, {
        commandId: randomUUID(),
        conversationId,
        projectId: id,
        title: "会话",
        inputFingerprint: "a".repeat(64),
      }),
    );
    const projectRoute = f.input(id);
    await assert.rejects(
      call(
        {
          action: "conversations",
          management: {
            action: "rename",
            projectId: f.projectId,
            conversationId,
            revision: 1,
            title: "错误归属",
          },
        },
        projectRoute,
      ),
      /另一项目/,
    );
    const conversations = await f.withHuman((actor) =>
      f.domains.work.service.listConversations(actor, {
        projectId: id,
        limit: 20,
      }),
    );
    assert.equal(conversations[0]!.title, "会话");
    const archive = f.envelope(
      {
        action: "conversations",
        management: { action: "archive", conversationId, revision: 1 },
      },
      projectRoute,
    );
    const archivedReceipt = await f.tools.call(archive);
    assert.deepEqual(await f.tools.call(archive), archivedReceipt);
    const archived = await call<{ items: { id: string }[] }>(
      {
        action: "conversations",
        management: { action: "list", status: "archived" },
      },
      projectRoute,
    );
    assert.equal(archived.items[0]!.id, conversationId);
    await call(
      {
        action: "conversations",
        management: { action: "restore", conversationId, revision: 2 },
      },
      projectRoute,
    );
    await call({
      action: "projects",
      management: { action: "delete", projectId: id, revision: 2 },
    });
    assert.ok(checked.includes(id));
    const deleted = await f.withHuman((actor) =>
      f.domains.work.service.getProject(actor, { projectId: id }),
    );
    assert.ok(deleted.deletedAt);
    // A deleted scope stays readable to its Human, but is not new Agent
    // execution authority. The same named conversation is retained.
    const retained = await f.withHuman((actor) =>
      f.domains.work.service.listConversations(actor, {
        projectId: id,
        limit: 20,
      }),
    );
    assert.equal(retained[0]!.id, conversationId);
    await assert.rejects(
      call({ action: "list" }, projectRoute),
      /发起来源的 Human 身份已失效/,
    );
    await call({
      action: "projects",
      management: { action: "restore", projectId: id, revision: 3 },
    });
    await f.reopen();
    assert.deepEqual(await f.tools.call(command), created);
    assert.equal(
      (
        await f.withHuman((actor) =>
          f.domains.work.service.getProject(actor, { projectId: id }),
        )
      ).revision,
      4,
    );
    await f.domains.content.platform.reconcileOperatorMembers(
      f.transport.identity(),
      [
        {
          principalId: "alice",
          actantId: "alice-human",
          projectIds: [id],
          enabled: true,
        },
      ],
    );
    const listed = await call<{ items: { id: string }[] }>({
      action: "projects",
      management: { action: "list", status: "all" },
    });
    assert.ok(!listed.items.some((p) => p.id === id));
    await assert.rejects(
      call({
        action: "projects",
        management: {
          action: "rename",
          projectId: id,
          revision: 4,
          title: "越界",
        },
      }),
      /成员|权限|范围/,
    );
    await assert.rejects(
      call(
        {
          action: "projects",
          management: { action: "list" },
        },
        { ...f.route, thread_id: "missing-root" },
      ),
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("项目活动按准确输入来源归属，不改变共享 Session 的消息显示", () => {
  const model = viewModelFixture();
  {
    const id = model.seedProject({
      title: "活动",
      members: ["local-owner", "morphz-service"],
    }).id;
    const i = model.seedInput({
      projectId: id,
      artifactId: null,
      artifactRevision: null,
      body: "测试项目管理",
      selection: "",
      targetActantId: "morphz-agent",
    }).id;
    const state = model.state,
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
  }
});

test("项目目录一次聚合与逐项目活动语义一致，待推进数量不计已完成任务", () => {
  const model = viewModelFixture();
  {
    const first = model.seedProject({
      title: "甲",
      members: ["local-owner", "morphz-service"],
    }).id;
    const second = model.seedProject({
      title: "乙",
      members: ["local-owner", "morphz-service"],
    }).id;
    const firstInput = model.seedInput({
      projectId: first,
      artifactId: null,
      artifactRevision: null,
      body: "测试项目管理",
      selection: "",
      targetActantId: "morphz-agent",
    }).id;
    const secondInput = model.seedInput({
      projectId: second,
      artifactId: null,
      artifactRevision: null,
      body: "测试项目管理",
      selection: "",
      targetActantId: "morphz-agent",
    }).id;
    const taskId = model.seedArtifact({
      projectId: first,
      title: "待推进事项",
      content: {
        kind: "task",
        description: "待办",
        assigneeId: "morphz-agent",
        model: null,
        priority: "normal",
        dueDate: null,
        assignment: "accepted",
        execution: "planned",
        delivery: "none",
        resultIds: [],
        runRequested: 0,
        notBefore: null,
        everySeconds: null,
        dependsOnIds: [],
        watchSourceIds: [],
      },
    }).id;
    const state = model.state;
    const task = state.artifacts.find((artifact) => artifact.id === taskId)!;
    assert.equal(task.content.kind, "task");
    if (task.content.kind === "task")
      state.artifacts.push({
        ...task,
        id: randomUUID(),
        content: { ...task.content, execution: "completed" },
      });
    const messages = [
      {
        inputId: firstInput,
        projectId: second,
        createdAt: "2099-01-01T00:00:00Z",
      },
      {
        inputId: "unknown-input",
        projectId: first,
        createdAt: "2099-02-01T00:00:00Z",
      },
      {
        inputId: secondInput,
        projectId: first,
        createdAt: "2099-03-01T00:00:00Z",
      },
      { projectId: first, createdAt: "2099-04-01T00:00:00Z" },
    ];
    const metrics = projectDirectoryMetrics(state, messages);
    for (const project of state.projects)
      assert.equal(
        metrics.get(project.id)?.activityAt,
        projectActivity(state, project, messages),
      );
    assert.equal(metrics.get(first)?.pendingTasks, 1);
    assert.equal(metrics.get(second)?.pendingTasks, 0);
  }
});

test("已保存未投递的输入阻止项目归档，明确取消后可归档／恢复且不重发", async () => {
  const f = await platformRuntimeHostFixture();
  try {
    const command = { commandId: randomUUID(), operation: input(f.projectId) };
    const receipt = await f.session().platformMessage(command);
    const archive = {
      commandId: randomUUID(),
      projectId: f.projectId,
      expectedRevision: 1,
      state: "archived",
    };
    await assert.rejects(
      f.session().changePlatformProjectState(archive),
      /正在处理/,
    );
    assert.equal(
      (await f.session().getPlatformProject({ projectId: f.projectId }))
        .revision,
      1,
    );
    await f.session().cancelInput(receipt.entityId);
    await f.session().changePlatformProjectState(archive);
    await assert.rejects(f.session().platformMessage(command), {
      code: "forbidden",
    });
    await f.session().changePlatformProjectState({
      commandId: randomUUID(),
      projectId: f.projectId,
      expectedRevision: 2,
      state: "active",
    });
    assert.deepEqual(await f.session().platformMessage(command), receipt);
    const ledger = f.store.runtimeState() as {
      deliveries: { inputId: string; state: string }[];
    };
    assert.equal(ledger.deliveries.length, 1);
    assert.equal(ledger.deliveries[0]!.state, "cancelled");
    await f.session().platformMessage({
      commandId: randomUUID(),
      operation: input(f.projectId),
    });
    await assert.rejects(
      f.session().changePlatformProjectState({
        commandId: randomUUID(),
        projectId: f.projectId,
        expectedRevision: 3,
        state: "deleted",
      }),
      /正在处理/,
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});
test("管理请求不能绕过目标项目的在途工作；撤销发起用户授权后不能重放回执", async () => {
  let otherInputRunning = true;
  const f = await agentDomainFixture({
    assertProjectInputsSettled: async (projectId) => {
      assert.equal(projectId, f.projectId);
      if (otherInputRunning) throw new Error("项目输入正在处理，请先停止。");
    },
  });
  try {
    const spaces = await f.withHuman((actor) =>
      f.domains.work.service.ensurePersonalSpaces(actor),
    );
    // Management comes from a valid persistent personal Session input, not
    // from arbitrary shared-Agent identity or a manufactured old workspace.
    const management = f.input(spaces.dialogueId, "归档我的项目");
    const command = f.envelope(
      {
        action: "projects",
        management: { action: "archive", projectId: f.projectId, revision: 1 },
      },
      management,
    );
    await assert.rejects(async () => f.tools.call(command), /正在处理/);
    assert.equal(
      (
        await f.withHuman((actor) =>
          f.domains.work.service.getProject(actor, { projectId: f.projectId }),
        )
      ).revision,
      1,
    );
    otherInputRunning = false;
    const receipt = await f.tools.call(command);
    assert.deepEqual(await f.tools.call(command), receipt);
    assert.ok(
      (
        await f.withHuman((actor) =>
          f.domains.work.service.getProject(actor, { projectId: f.projectId }),
        )
      ).archivedAt,
    );
    const archivedSource = f.input(f.projectId);
    await assert.rejects(
      f.call(
        { action: "create-document", title: "不可继续写入", markdown: "原文" },
        archivedSource,
      ),
      { code: "forbidden" },
    );
    await f.domains.content.platform.reconcileOperatorMembers(
      f.transport.identity(),
      [{ ...localAccess, projectIds: [], enabled: false }],
    );
    await assert.rejects(
      async () => f.tools.call(command),
      /权限|失效|身份|授权/,
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});
