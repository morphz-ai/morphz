import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { viewModelFixture } from "./view-model-fixture.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import { Application } from "../packages/application/src/application.js";
import { RuntimeBridge } from "../packages/application/src/runtime.js";
import { PlatformTaskRunDispatcher } from "../packages/application/src/platform-task-run-dispatcher.js";
import { RuntimeTaskRunStatusReader } from "../packages/application/src/runtime-task-run-status.js";
import {
  contentSchema,
  localAccess,
  currentTaskResponse,
  type TaskContent,
} from "../packages/core/src/model.js";
import {
  taskPresentation,
  taskRunBusy,
  taskRuntimeSchema,
} from "../packages/core/src/task-runtime.js";
import type { TaskRunAdmission } from "../packages/platform/src/task-run-admission.js";
import type { PriorRuntimeObservation } from "../packages/platform/src/store.js";

const content = (extra: Partial<TaskContent> = {}) =>
  contentSchema.parse({
    kind: "task",
    description: "合成验收",
    assigneeId: "local-human",
    model: null,
    priority: "normal",
    dueDate: null,
    assignment: "accepted",
    execution: "planned",
    delivery: "none",
    resultIds: [],
    ...extra,
  }) as TaskContent;

async function arrangementFixture() {
  const fixture = await agentDomainFixture();
  const human = fixture.withHuman;
  const version = (taskId: string, revision?: number) =>
    human((actor) =>
      fixture.domains.work.service.taskVersion(actor, {
        taskId,
        ...(revision ? { revision } : {}),
      }),
    );
  const create = async (
    extra: { assigneeId?: string; dependsOnIds?: string[] } = {},
  ) => {
    const taskId = randomUUID();
    await human((actor) =>
      fixture.domains.work.service.createTask(actor, {
        commandId: randomUUID(),
        taskId,
        projectId: fixture.projectId,
        title: "TEST 安排",
        description: "合成验收",
        assigneeId: localAccess.actantId,
        ...extra,
      }),
    );
    return taskId;
  };
  const revise = (
    request: Parameters<typeof fixture.domains.work.service.reviseTask>[1],
    inspect?: Parameters<typeof fixture.domains.work.service.reviseTask>[2],
  ) =>
    human((actor) =>
      fixture.domains.work.service.reviseTask(actor, request, inspect),
    );
  const start = (
    taskId: string,
    expectedRevision: number,
    prior?: PriorRuntimeObservation,
  ) =>
    human((actor) =>
      fixture.domains.work.service.requestTaskRun(
        actor,
        {
          commandId: randomUUID(),
          taskId,
          expectedRevision,
          sessionId: "session-test",
          intent: "合成验收",
          notBefore: "2026-09-26T12:00:00.000Z",
        },
        prior,
      ),
    );
  const confirm = async (
    admission: TaskRunAdmission,
    status: "dispatched" | "completed" = "dispatched",
  ) => {
    const runtime = {
      sessionId: admission.sessionId,
      scheduleId: admission.request.id,
      threadId: `thread-${admission.taskId}-${admission.runNumber}`,
    };
    await fixture.domains.content.platform.confirmTaskRun(
      admission.tenantId,
      admission.eventId,
      {
        schedule: {
          id: runtime.scheduleId,
          thread_id: runtime.threadId,
          revision: 1,
          status,
          not_before: admission.request.not_before,
          interval_seconds: null,
        },
        thread: {
          thread_id: runtime.threadId,
          session_id: runtime.sessionId,
          root_turn_id: `client-schedule-${runtime.scheduleId}`,
          lifecycle: "open",
        },
      },
    );
    return runtime;
  };
  const session = (bridge?: RuntimeBridge) =>
    new Application(fixture.transport, {
      platformWork: fixture.domains.work,
      platformDocuments: fixture.domains.content,
      platformTaskRuns: {
        authority: fixture.domains.work.authority,
        store: fixture.domains.content.platform,
        ...(bridge ? { runtimeStatus: bridge.taskRunStatusReader() } : {}),
      },
      ...(bridge ? { runtime: bridge } : {}),
    }).session(localAccess);
  return {
    ...fixture,
    human,
    version,
    create,
    revise,
    start,
    confirm,
    session,
    get domains() {
      return fixture.domains;
    },
  };
}

test("顺序就是优先级：部分排序保留未列出的事项，Human 与 Agent 共享 CAS 和幂等回执", async () => {
  const f = await arrangementFixture();
  try {
    const a = await f.create(),
      b = await f.create(),
      c = await f.create();
    const tasks = () =>
      f.human((actor) =>
        f.domains.work.service.listTasks(actor, { projectId: f.projectId }),
      );
    const original = (await tasks()).map((t) => t.id),
      selected = original.slice(0, 2).reverse();
    const order = await f.human((actor) =>
      f.domains.work.service.taskOrder(actor),
    );
    const request = {
      commandId: randomUUID(),
      taskIds: selected,
      expectedOrderRevision: order.revision,
    };
    const reorder = () =>
      f.human((actor) =>
        f.domains.work.service.reorderTaskSelection(actor, request),
      );
    const result = await reorder();
    assert.deepEqual(await reorder(), result);
    assert.deepEqual(
      (await tasks()).map((t) => t.id),
      [...selected, original[2]],
    );
    assert.ok((await tasks()).every((t) => t.revision === 1));
    await assert.rejects(
      f.withAgent((actor) =>
        f.domains.work.service.reorderTask(actor, {
          commandId: randomUUID(),
          projectId: f.projectId,
          taskId: a,
          beforeTaskId: b,
          expectedOrderRevision: order.revision,
        }),
      ),
      /顺序已变化/,
    );
    await f.human((actor) =>
      f.domains.work.service.reorderTaskSelection(actor, {
        commandId: randomUUID(),
        taskIds: [c, b, a],
        expectedOrderRevision: order.revision + 1,
        move: { taskId: a, expectedRevision: 1, execution: "active" },
      }),
    );
    assert.equal((await f.version(a)).execution, "active");
    assert.deepEqual(
      (await tasks()).map((t) => t.id),
      [c, b, a],
    );
    assert.equal(f.transport.runtimeState(), null, "排序不会生成 Runtime 消息");
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("就地安排：同一对象移动项目、撤销、无项目，历史与原始项目不改写；拒绝跨权限与断开关联", async () => {
  const f = await arrangementFixture();
  try {
    const id = await f.create(),
      original = await f.version(id, 1);
    const spaces = await f.human((actor) =>
      f.domains.work.service.ensurePersonalSpaces(actor),
    );
    const request = {
      commandId: randomUUID(),
      taskId: id,
      expectedRevision: 1,
      projectId: spaces.inboxId,
      dueDate: "2026-09-17",
    };
    const receipt = await f.revise(request);
    assert.deepEqual(await f.revise(request), receipt);
    assert.equal((await f.version(id)).projectId, spaces.inboxId);
    assert.deepEqual(await f.version(id, 1), original);
    // Task creation no longer manufactures a conversation. Movement must not
    // create or rewrite Runtime messages/sessions either.
    assert.equal(f.transport.runtimeState(), null);
    await assert.rejects(
      f.revise({ ...request, commandId: randomUUID(), dueDate: "2026-09-18" }),
      /已变化/,
    );
    await f.revise({
      commandId: randomUUID(),
      taskId: id,
      expectedRevision: 2,
      projectId: f.projectId,
      dueDate: null,
    });
    const task = await f.version(id);
    assert.equal(task.taskId, id);
    assert.equal(task.revision, 3);
    assert.equal(task.projectId, f.projectId);
    await f.create({ dependsOnIds: [id] });
    await assert.rejects(
      f.revise({ ...request, commandId: randomUUID(), expectedRevision: 3 }),
      /关联/,
    );
    assert.equal((await f.version(id)).revision, 3);
    await assert.rejects(
      f.revise({
        ...request,
        commandId: randomUUID(),
        expectedRevision: 3,
        projectId: "missing",
      }),
      /不存在|无权/,
    );
    await f.reopen();
    assert.deepEqual(await f.version(id, 1), original);
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("指派不会启动 Agent；禁止手工伪造 Agent 看板状态，执行请求幂等，尚未准备投递可撤回", async () => {
  const f = await arrangementFixture();
  try {
    const prerequisite = await f.create(),
      id = await f.create({ dependsOnIds: [prerequisite] });
    await f.revise({
      commandId: randomUUID(),
      taskId: id,
      expectedRevision: 1,
      assigneeId: "morphz-agent",
    });
    assert.equal((await f.version(id)).runRequested, 0);
    assert.equal(f.transport.runtimeState(), null);
    await assert.rejects(
      f.revise({
        commandId: randomUUID(),
        taskId: id,
        expectedRevision: 2,
        execution: "active",
      }),
      /实际执行/,
    );
    const request = {
      commandId: randomUUID(),
      taskId: id,
      expectedRevision: 2,
      sessionId: "session-test",
      intent: "合成验收",
      notBefore: "2026-09-26T12:00:00.000Z",
    };
    const start = () =>
      f.human((actor) => f.domains.work.service.requestTaskRun(actor, request));
    const admission = await start();
    assert.deepEqual(await start(), admission);
    await assert.rejects(f.start(id, 3), /上一轮|结束|重复启动/);
    await assert.rejects(
      f.revise({
        commandId: randomUUID(),
        taskId: id,
        expectedRevision: 3,
        assigneeId: "local-human",
      }),
      /先停止|执行.*结束/,
    );
    await f.human((actor) =>
      f.domains.work.service.controlTaskRun(actor, {
        taskId: id,
        runNumber: 1,
        controlRevision: 1,
        action: "stop",
      }),
    );
    assert.equal(
      (
        await f.human((actor) =>
          f.domains.content.platform.taskRunPrerequisites(actor, id, 1),
        )
      ).withdrawn,
      true,
    );
    await f.revise({
      commandId: randomUUID(),
      taskId: id,
      expectedRevision: 4,
      assigneeId: "local-human",
    });
    const task = await f.version(id);
    assert.equal(task.execution, "planned");
    assert.equal(task.runRequested, 0);
    assert.equal(
      (await f.version(id, admission.taskRevision)).runRequested,
      1,
      "撤回不重写历史准入",
    );
    assert.equal(f.transport.runtimeState(), null);
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("真实 Thread 仍开放时，不能改派、撤回或重复启动；终态来源必须实时核对", async () => {
  const f = await arrangementFixture();
  try {
    const id = await f.create({ assigneeId: "morphz-agent" }),
      admission = await f.start(id, 1),
      runtime = await f.confirm(admission, "completed");
    const open: PriorRuntimeObservation = {
      source: "runtime",
      runtime,
      schedule: { status: "completed" },
      thread: { lifecycle: "open" },
    };
    const request = {
      commandId: randomUUID(),
      taskId: id,
      expectedRevision: 2,
      assigneeId: "local-human",
    };
    await assert.rejects(
      f.revise(request, async () => open),
      /先停止|执行.*结束/,
    );
    await assert.rejects(f.start(id, 2, open), /结束/);
    await assert.rejects(
      f.revise({
        commandId: randomUUID(),
        taskId: id,
        expectedRevision: 2,
        execution: "cancelled",
      }),
      /先停止/,
    );
    assert.equal((await f.version(id)).revision, 2);
    await assert.rejects(
      f.revise(request),
      /先停止|执行.*结束/,
      "持久观察 completed 不替代真实 Runtime 终态",
    );
    const reader = new RuntimeTaskRunStatusReader(async (path, access) => {
      assert.deepEqual(access, localAccess);
      if (path.endsWith(`/schedules/${runtime.scheduleId}`))
        return {
          id: runtime.scheduleId,
          thread_id: runtime.threadId,
          revision: 2,
          status: "completed",
          not_before: null,
          interval_seconds: null,
        };
      if (path.endsWith(`/turns/client-schedule-${runtime.scheduleId}/thread`))
        return {
          thread_id: runtime.threadId,
          session_id: runtime.sessionId,
          root_turn_id: `client-schedule-${runtime.scheduleId}`,
          revision: 5,
          lifecycle: "completed",
        };
      throw Error(`Unexpected authenticated Runtime read: ${path}`);
    });
    const session = new Application(f.transport, {
      platformWork: f.domains.work,
      platformTaskRuns: {
        authority: f.domains.work.authority,
        store: f.domains.content.platform,
        runtimeStatus: reader,
      },
    }).session(localAccess);
    await session.revisePlatformTask(request);
    assert.equal((await f.version(id)).assigneeId, "local-human");
    assert.deepEqual(
      await f.revise(request, async () => {
        throw Error("幂等重放不得再次联网");
      }),
      id,
    );
    await session.revisePlatformTask({
      commandId: randomUUID(),
      taskId: id,
      expectedRevision: 3,
      assigneeId: "morphz-agent",
    });
    await f.reopen();
    const rerun = {
      commandId: randomUUID(),
      taskId: id,
      expectedRevision: 4,
      sessionId: "session-test",
      intent: "重新指派后的验收",
      notBefore: "2026-09-26T12:00:00.000Z",
    };
    const next = await f.human((actor) =>
      f.domains.work.service.requestTaskRun(actor, rerun),
    );
    assert.equal(next.runNumber, 2, "改派不允许重用历史执行序号");
    assert.notEqual(next.eventId, admission.eventId);
    assert.notEqual(next.request.id, admission.request.id);
    assert.deepEqual(
      await f.human((actor) =>
        f.domains.work.service.requestTaskRun(actor, rerun),
      ),
      next,
    );
    await f.reopen();
    assert.deepEqual(
      await f.human((actor) =>
        f.domains.work.service.requestTaskRun(actor, rerun),
      ),
      next,
    );
    assert.equal((await f.version(id)).runRequested, 2);
    assert.equal((await f.version(id, admission.taskRevision)).runRequested, 1);
    const raced = await f.create({ assigneeId: "morphz-agent" }),
      racedAdmission = await f.start(raced, 1),
      racedRef = await f.confirm(racedAdmission, "completed");
    const racedRequest = {
      commandId: randomUUID(),
      taskId: raced,
      expectedRevision: 2,
      assigneeId: "local-human",
    };
    await assert.rejects(
      f.revise(racedRequest, async () => ({
        source: "runtime",
        runtime: { ...racedRef, threadId: "wrong-thread" },
        schedule: { status: "completed" },
        thread: { lifecycle: "completed" },
      })),
      /先停止|执行.*结束/,
    );
    await assert.rejects(
      f.revise(racedRequest, async () => {
        await f.human((actor) =>
          f.domains.work.service.controlTaskRun(actor, {
            taskId: raced,
            runNumber: 1,
            controlRevision: 1,
            action: "stop",
          }),
        );
        return {
          source: "runtime",
          runtime: racedRef,
          schedule: { status: "completed" },
          thread: { lifecycle: "completed" },
        };
      }),
      /核对期间.*变化/,
    );
    assert.equal((await f.version(raced)).assigneeId, "morphz-agent");
    assert.equal((await f.version(raced)).revision, 2);
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("修改日期不使已提交的人工答复失效；重新打开后即使手工完成也需要新答复", async () => {
  const f = await arrangementFixture();
  try {
    const id = await f.create();
    await f.human((actor) =>
      f.domains.work.service.respondTask(actor, {
        commandId: randomUUID(),
        taskId: id,
        expectedRevision: 1,
        body: "确认",
      }),
    );
    await f.revise({
      commandId: randomUUID(),
      taskId: id,
      expectedRevision: 2,
      dueDate: "2026-09-14",
    });
    const response = async () => {
      const versions = await f.human((actor) =>
        f.domains.work.service.listTaskVersions(actor, { taskId: id }),
      );
      const replies = await f.human((actor) =>
        f.domains.work.service.listTaskResponses(actor, { taskId: id }),
      );
      // Only renderer response selection is projected. All versions/replies
      // above were committed and queried from the real Platform authority.
      const projection = viewModelFixture();
      const artifact = projection.seedArtifact({
        id,
        projectId: "first-project",
        title: "TEST 安排",
        content: content(),
      });
      artifact.revision = versions[0]!.revision;
      const body = (v: (typeof versions)[number]) =>
        content({
          description: v.description,
          assigneeId: v.assigneeId,
          dueDate: v.dueDate,
          assignment: v.assignment,
          execution: v.execution,
          delivery: v.delivery,
          runRequested: v.runRequested,
        });
      artifact.content = body(versions[0]!);
      artifact.versions = [...versions].reverse().map((v) => ({
        revision: v.revision,
        title: v.title,
        content: body(v),
        createdAt: v.createdAt,
        author: {
          principalId: v.authorPrincipalId,
          actantId: v.authorActantId,
        },
      }));
      projection.state.taskResponses = replies.map((r) => ({
        id: r.id,
        taskId: r.taskId,
        taskRevision: r.taskRevision,
        body: r.body,
        createdAt: r.createdAt,
        author: {
          principalId: r.authorPrincipalId,
          actantId: r.authorActantId,
        },
      }));
      return currentTaskResponse(projection.state, artifact);
    };
    assert.equal((await response())?.body, "确认");
    await f.revise({
      commandId: randomUUID(),
      taskId: id,
      expectedRevision: 3,
      execution: "planned",
    });
    await f.revise({
      commandId: randomUUID(),
      taskId: id,
      expectedRevision: 4,
      execution: "completed",
    });
    assert.equal(await response(), undefined);
    await f.reopen();
    assert.equal(await response(), undefined);
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("实际执行优先于对象声明，失败可以显式重试而不丢失成果", async () => {
  const f = await arrangementFixture();
  try {
    const id = await f.create({ assigneeId: "morphz-agent" }),
      admission = await f.start(id, 1),
      ref = await f.confirm(admission, "completed");
    const runtime = taskRuntimeSchema.parse({
      runs: [
        {
          run: 1,
          artifactRevision: 2,
          record: {
            revision: 1,
            status: "dispatched",
            thread_id: ref.threadId,
            interval_seconds: null,
          },
          controlRevision: 1,
          threadState: "open",
        },
      ],
    });
    const declaredDone = content({
      assigneeId: "morphz-agent",
      runRequested: 1,
      execution: "completed",
    });
    assert.equal(
      taskPresentation(declaredDone, false, runtime).state,
      "active",
    );
    runtime.runs[0]!.threadState = "failed";
    assert.equal(
      taskPresentation(declaredDone, false, runtime).label,
      "执行失败",
    );
    assert.equal(
      taskPresentation(declaredDone, false, runtime).state,
      "planned",
    );
    assert.equal(taskRunBusy(declaredDone, runtime), false);
    await f.start(id, 2, {
      source: "runtime",
      runtime: ref,
      schedule: { status: "completed" },
      thread: { lifecycle: "failed" },
    });
    assert.equal((await f.version(id)).runRequested, 2);
    assert.equal(
      (
        await f.human((actor) =>
          f.domains.work.service.listTaskVersions(actor, { taskId: id }),
        )
      ).length,
      3,
    );
    await f.reopen();
    assert.equal((await f.version(id)).runRequested, 2);
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("等待仅表达前置条件或确认；失败、执行结束和连接异常不进入等待列", () => {
  const task = content({ assigneeId: "morphz-agent", runRequested: 1 });
  const runtime = taskRuntimeSchema.parse({
    runs: [
      {
        run: 1,
        artifactRevision: 1,
        controlRevision: 1,
        threadState: "completed",
        record: {
          revision: 1,
          thread_id: "thread-1",
          status: "completed",
          interval_seconds: null,
        },
      },
    ],
  });
  assert.equal(taskPresentation(task, false, runtime).state, "planned");
  assert.match(taskPresentation(task, false, runtime).label, /事项未完成/);
  runtime.runs[0]!.threadState = "open";
  runtime.approvalCount = 1;
  assert.equal(taskPresentation(task, false, runtime).label, "等待你的确认");
  runtime.runs[0]!.stopRequested = true;
  assert.deepEqual(taskPresentation(task, false, runtime), {
    state: "active",
    label: "停止待确认",
    reason: "已请求停止，等待执行结果确认。",
  });
  assert.equal(taskRunBusy(task, runtime), true);
  assert.equal(
    taskPresentation(
      task,
      false,
      taskRuntimeSchema.parse({ error: "连接异常，日志里也可能包含依赖二字" }),
    ).state,
    "planned",
  );
  assert.match(
    taskPresentation(content({ execution: "waiting" }), false).label,
    /未说明原因/,
  );
  const queued = taskRuntimeSchema.parse({
    approvalCount: 0,
    runs: [
      {
        run: 1,
        artifactRevision: 1,
        controlRevision: 1,
        threadState: "open",
        record: { revision: 1, status: "queued", interval_seconds: null },
      },
    ],
    blockers: [
      {
        taskId: "prerequisite",
        title: "前置结果",
        assigneeName: "你",
        reason: "response",
      },
    ],
  });
  assert.equal(
    taskPresentation(task, false, queued).state,
    "waiting",
    "已建 Thread 但排队等待不能标成执行中",
  );
  queued.blockers = [];
  assert.equal(taskPresentation(task, false, queued).label, "已排队");
  queued.runs[0]!.record = null;
  queued.runs[0]!.threadState = null;
  queued.runs[0]!.sourceStopped = true;
  assert.equal(taskPresentation(task, false, queued).label, "已停止");
});

test("等待快照来自真实前置事项与有效答复，不以 completed 字段或错误文案猜测", async () => {
  const f = await arrangementFixture();
  try {
    const prerequisite = await f.create(),
      taskId = await f.create({
        assigneeId: "morphz-agent",
        dependsOnIds: [prerequisite],
      });
    await f.start(taskId, 1);
    const runtime = await f.session().taskSnapshot(taskId);
    assert.equal(runtime.blockers![0]!.reason, "response");
    assert.equal(runtime.blockers![0]!.taskId, prerequisite);
    assert.match(
      taskPresentation(
        content({ assigneeId: "morphz-agent", runRequested: 1 }),
        false,
        runtime,
      ).label,
      /提交结果：TEST 安排/,
    );
    await f.human((actor) =>
      f.domains.work.service.respondTask(actor, {
        commandId: randomUUID(),
        taskId: prerequisite,
        expectedRevision: 1,
        body: "合成验证已完成，可以继续。",
      }),
    );
    assert.equal((await f.session().taskSnapshot(taskId)).blockers!.length, 0);
    await f.revise({
      commandId: randomUUID(),
      taskId: prerequisite,
      expectedRevision: 2,
      execution: "planned",
    });
    assert.equal(
      (await f.session().taskSnapshot(taskId)).blockers![0]!.reason,
      "response",
    );
    await assert.rejects(
      new Application(f.transport, {
        platformTaskRuns: {
          authority: f.domains.work.authority,
          store: f.domains.content.platform,
        },
      })
        .session({ principalId: "outside", actantId: "outside" })
        .taskSnapshot(taskId),
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("停止针对真实 Thread，丢回执后恢复核对；确认停止前不允许改派或重复执行", async () => {
  const f = await arrangementFixture(),
    namespace = randomUUID();
  let protocol: (
    path: string,
    method: string,
    body: unknown,
  ) => unknown = () => {
    throw Error("尚未配置合成 RPC");
  };
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString())
        : undefined;
      const result = protocol(request.url!, request.method!, body);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(result));
    } catch {
      response.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const bridge = new RuntimeBridge(
    f.transport,
    {
      url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      token: "test",
      namespace,
    },
    undefined,
    false,
  );
  let lifecycle: "open" | "cancelled" = "open",
    threadRevision = 4,
    lost = true,
    cancels = 0;
  let dispatcher: PlatformTaskRunDispatcher | undefined;
  try {
    const id = await f.create({ assigneeId: "morphz-agent" }),
      admission = await f.start(id, 1),
      ref = await f.confirm(admission);
    const record = {
      id: ref.scheduleId,
      revision: 1,
      thread_id: ref.threadId,
      status: "dispatched",
      not_before: admission.request.not_before,
      interval_seconds: null,
    };
    // Control only RPC observations. RuntimeBridge performs real protocol,
    // scope/CAS and re-read; Platform persists admission/control/recovery.
    protocol = (path, method, body) => {
      if (path === `/api/sessions/${ref.sessionId}`)
        return { id: ref.sessionId, context_id: `mw-context-${namespace}` };
      if (path.endsWith(`/schedules/${ref.scheduleId}`)) return { ...record };
      if (path.endsWith(`/turns/client-schedule-${ref.scheduleId}/thread`))
        return {
          thread_id: ref.threadId,
          session_id: ref.sessionId,
          root_turn_id: `client-schedule-${ref.scheduleId}`,
          revision: threadRevision,
          lifecycle,
        };
      if (path.endsWith(`/threads/${ref.threadId}`) && method === "POST") {
        const data = body as { action: string; expected_revision: number };
        assert.equal(data.action, "cancel");
        assert.equal(data.expected_revision, threadRevision);
        lifecycle = "cancelled";
        threadRevision++;
        cancels++;
        if (lost) {
          lost = false;
          throw Error("lost reply");
        }
        return { updated: true };
      }
      throw Error(`Unexpected Runtime RPC: ${method} ${path}`);
    };
    const errors: unknown[] = [];
    const makeDispatcher = () =>
      new PlatformTaskRunDispatcher(
        f.domains.content.platform,
        admission.tenantId,
        bridge,
        async (current) => {
          assert.equal(current.eventId, admission.eventId);
          return localAccess;
        },
        async (current) =>
          f.human((actor) =>
            f.domains.content.platform.prepareTaskRun(
              actor,
              current.eventId,
              (runtime) =>
                bridge.taskRunStatusReader().inspect(runtime, localAccess),
            ),
          ),
        (error) => errors.push(error),
      );
    const run = await f.human((actor) =>
      f.domains.work.service.listTaskRuns(actor, { taskId: id }),
    );
    assert.equal(run[0]!.observed.threadStatus, "open");
    await f.human((actor) =>
      f.domains.work.service.controlTaskRun(actor, {
        taskId: id,
        runNumber: 1,
        controlRevision: run[0]!.bridge.controlRevision,
        action: "stop",
      }),
    );
    dispatcher = makeDispatcher();
    await dispatcher.drain();
    assert.match(String(errors[0]), /无法连接 Morphz Runtime/);
    assert.equal(
      (
        await f.human((actor) =>
          f.domains.work.service.listTaskRuns(actor, { taskId: id }),
        )
      )[0]!.bridge.stopRequested,
      true,
    );
    const stoppingView = await f.session(bridge).taskSnapshot(id);
    const stoppingTask = content({
      assigneeId: "morphz-agent",
      runRequested: 1,
      execution: (await f.version(id)).execution,
    });
    assert.deepEqual(taskPresentation(stoppingTask, false, stoppingView), {
      state: "active",
      label: "停止待确认",
      reason: "已请求停止，等待执行结果确认。",
    });
    assert.equal(taskRunBusy(stoppingTask, stoppingView), true);
    await assert.rejects(
      f.session(bridge).revisePlatformTask({
        commandId: randomUUID(),
        taskId: id,
        expectedRevision: 2,
        assigneeId: "local-human",
      }),
      /先停止|执行.*结束/,
    );
    await assert.rejects(
      f.start(id, 2, {
        source: "runtime",
        runtime: ref,
        schedule: { status: "completed" },
        thread: { lifecycle: "cancelled" },
      }),
      /结束/,
    );
    await dispatcher.stop();
    await f.reopen();
    dispatcher = makeDispatcher();
    await dispatcher.drain();
    const view = await f.session(bridge).taskSnapshot(id),
      task = content({
        assigneeId: "morphz-agent",
        runRequested: 1,
        execution: (await f.version(id)).execution,
      });
    assert.equal(view.runs[0]!.threadState, "cancelled");
    assert.equal(view.runs[0]!.stopRequested, false);
    assert.equal(cancels, 1);
    assert.equal(taskRunBusy(task, view), false);
    assert.equal(taskPresentation(task, false, view).label, "已停止");
    await f.session(bridge).revisePlatformTask({
      commandId: randomUUID(),
      taskId: id,
      expectedRevision: 2,
      assigneeId: "local-human",
    });
    assert.equal((await f.version(id)).assigneeId, "local-human");
    f.assertNoLegacyData();
  } finally {
    await dispatcher?.stop();
    await bridge.stop();
    await f.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
