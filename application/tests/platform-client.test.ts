import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  PlatformClient,
  type PlatformHistory,
} from "../apps/web/src/platform-client.js";
import {
  mergePlatformHistories,
  readPlatformWorkspace,
  selectedHistoryScope,
} from "../apps/web/src/platform-workspace-view.js";
import {
  executePlatformOperation,
  operationMayCommitBeforeError,
  type Boot,
} from "../apps/web/src/client.js";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import {
  readerApplication,
  objectsApplication,
} from "../packages/core/src/applications.js";
import { emptyInteractive } from "../packages/core/src/interactive.js";
import {
  defaultScriptExportTemplate,
  emptyScriptBrief,
  emptyScriptDraft,
} from "../packages/core/src/script-studio.js";
import type {
  ApplicationCaller,
  ApplicationMethod,
} from "../packages/core/src/application-api.js";
import {
  taskContentSchema,
  applicationFor,
  type Operation,
} from "../packages/core/src/model.js";

test("旧消息合并保留首次位置、最新正文及原分页游标", () => {
  const old = {
    id: "reply-one",
    sequence: 1,
    projectId: "project",
    conversationId: "project",
    artifactId: null,
    inputId: "input-one",
    rootId: "root-one",
    text: "流式前缀",
    createdAt: "2026-09-28T00:00:02.000Z",
    kind: "reply" as const,
  };
  const older: PlatformHistory = {
    inputs: [],
    scriptOutputs: [],
    nextCursor: { createdAt: "2026-09-28T00:00:01.000Z", id: "input-one" },
    runtime: { ...disconnectedRuntime, messages: [old] },
  };
  const latest: PlatformHistory = {
    inputs: [],
    scriptOutputs: [],
    nextCursor: { createdAt: "2026-09-28T00:00:02.000Z", id: "reply-one" },
    runtime: {
      ...disconnectedRuntime,
      messages: [
        { ...old, sequence: 2, text: "完整回复" },
        {
          ...old,
          id: "reply-two",
          sequence: 3,
          createdAt: "2026-09-28T00:00:03.000Z",
        },
      ],
    },
  };
  const merged = mergePlatformHistories(latest, older);
  assert.deepEqual(
    merged.runtime.messages.map((message) => message.id),
    ["reply-one", "reply-two"],
  );
  assert.equal(merged.runtime.messages[0]?.text, "完整回复");
  assert.deepEqual(merged.nextCursor, older.nextCursor);
});

test("批量审阅跨历史页合并时保留同一命令的每条审阅", () => {
  const review = (reviewId: string) => ({
    commandId: "batch-review",
    inputId: "input-one",
    projectId: "project-one",
    productionId: "production-one",
    kind: "review" as const,
    productionTitle: "同一剧本",
    itemKind: "episode" as const,
    itemId: "episode-one",
    reviewId,
    title: "第一集",
    revision: 1,
    createdAt: "2026-09-28T00:00:00.000Z",
  });
  const older: PlatformHistory = {
    inputs: [],
    scriptOutputs: [review("review-one"), review("review-two")],
    nextCursor: null,
    runtime: disconnectedRuntime,
  };
  const latest: PlatformHistory = {
    ...older,
    scriptOutputs: [review("review-two")],
  };
  assert.deepEqual(
    mergePlatformHistories(latest, older).scriptOutputs.map(
      (output) => output.reviewId,
    ),
    ["review-one", "review-two"],
  );
});

test("应用原件先于目录提交时保留命令 ID 以便可靠重试", () => {
  const operation = (type: string, kind?: string) =>
    ({
      type,
      ...(kind ? { content: { kind } } : {}),
    }) as Operation;
  assert.equal(
    operationMayCommitBeforeError(operation("script-command")),
    true,
  );
  assert.equal(
    operationMayCommitBeforeError(operation("import-document")),
    true,
  );
  assert.equal(
    operationMayCommitBeforeError(operation("create-artifact", "document")),
    true,
  );
  assert.equal(
    operationMayCommitBeforeError(operation("revise-artifact", "document")),
    true,
  );
  assert.equal(
    operationMayCommitBeforeError(operation("create-artifact", "interactive")),
    true,
  );
  assert.equal(
    operationMayCommitBeforeError(operation("revise-artifact", "interactive")),
    true,
  );
  assert.equal(
    operationMayCommitBeforeError(operation("create-artifact", "task")),
    false,
  );
  assert.equal(
    operationMayCommitBeforeError(operation("update-project")),
    false,
  );
});

test("原交互表格编辑走应用原件命令，保持创建 ID 和确切修订版本", async () => {
  const calls: unknown[] = [];
  const source = {
    createInteractive: async (request: unknown) => {
      calls.push({ method: "create", request });
      return { contentId: "table-content" };
    },
    reviseInteractive: async (request: unknown) => {
      calls.push({ method: "revise", request });
      return { contentId: "table-content" };
    },
  } as unknown as PlatformClient;
  const identity = { workspace: { revision: 5 } } as Boot;
  const createId = randomUUID();
  const reviseId = randomUUID();
  const created = await executePlatformOperation(
    source,
    identity,
    {
      commandId: createId,
      operation: {
        type: "create-artifact",
        projectId: "project-one",
        title: "待办表",
        content: emptyInteractive,
      },
    },
    false,
  );
  assert.equal(created.entityId, "table-content");
  const revised = await executePlatformOperation(
    source,
    identity,
    {
      commandId: reviseId,
      operation: {
        type: "revise-artifact",
        artifactId: "table-content",
        expectedRevision: 1,
        title: "待办表第二版",
        content: { ...emptyInteractive, description: "调整后" },
      },
    },
    false,
  );
  assert.equal(revised.entityId, "table-content");
  assert.deepEqual(calls, [
    {
      method: "create",
      request: {
        commandId: createId,
        objectId: createId,
        projectId: "project-one",
        title: "待办表",
        content: emptyInteractive,
      },
    },
    {
      method: "revise",
      request: {
        commandId: reviseId,
        contentId: "table-content",
        expectedRevision: 1,
        title: "待办表第二版",
        content: { ...emptyInteractive, description: "调整后" },
      },
    },
  ]);
});

test("剧本概览保留元数据 CAS，不把活动修订用作编辑前提", async () => {
  const writes: unknown[] = [];
  const source = await PlatformClient.connect({
    async call(method, params) {
      if (method === "platform.bootstrap")
        return {
          centerId: randomUUID(),
          csrfToken: "generation-one",
          principalId: "human",
          actantId: "human-actant",
          displayName: "我",
          capabilities: {
            runtime: true,
            teamAuthentication: false,
            directedInput: false,
            localFiles: false,
            browserBookmarks: false,
            modelSettings: false,
          },
        };
      if (method === "scripts.read")
        return {
          contentId: "script-content",
          productionId: "script-one",
          projectId: "project-one",
          title: "剧本",
          metadataRevision: 2,
          activityRevision: 9,
          updatedAt: "2026-09-30T00:00:00.000Z",
          brief: emptyScriptBrief,
          progress: { episodes: 1, scenes: 0, pendingCandidates: 2 },
        };
      assert.equal(method, "scripts.update");
      writes.push(params);
      return { metadataRevision: 3 };
    },
  });
  const overview = await source.readScript("script-content");
  assert.equal(overview.metadataRevision, 2);
  assert.equal(overview.activityRevision, 9);
  await source.updateScript({
    commandId: randomUUID(),
    contentId: overview.contentId,
    expectedRevision: overview.metadataRevision,
    title: "修订标题",
    brief: overview.brief,
    reviewerPrincipalIds: ["human"],
    template: defaultScriptExportTemplate,
  });
  assert.equal((writes[0] as { expectedRevision: number }).expectedRevision, 2);
});

test("明确内容引用按 50 项分批读取并保留输入次序", async () => {
  const now = "2026-09-27T00:00:00.000Z";
  const batches: string[][] = [];
  const source = await PlatformClient.connect({
    async call(method, params) {
      if (method === "platform.bootstrap")
        return {
          centerId: randomUUID(),
          csrfToken: "generation-one",
          principalId: "human",
          actantId: "human-actant",
          displayName: "我",
          capabilities: {
            runtime: true,
            teamAuthentication: false,
            directedInput: false,
            localFiles: false,
            browserBookmarks: true,
            modelSettings: false,
          },
        };
      assert.equal(method, "content.list");
      const ids = (params as { contentIds: string[] }).contentIds;
      batches.push(ids);
      return ids
        .filter((id) => id !== "item-3")
        .reverse()
        .map((id) => ({
          id,
          appId: "morphz.objects",
          instanceId: "objects-one",
          providerRevision: 1,
          appObjectId: id,
          projectId: "project-one",
          kind: "document",
          title: id,
          observedVersionRef: "1",
          availability: "available",
          revision: 1,
          createdAt: now,
          updatedAt: now,
        }));
    },
  });
  const ids = Array.from({ length: 53 }, (_, index) => `item-${index}`);
  const entries = await source.contentByIds([ids[0]!, ...ids, ids[0]!]);
  assert.deepEqual(
    entries.map((entry) => entry.id),
    ids.filter((id) => id !== "item-3"),
  );
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [50, 3],
  );
  await assert.rejects(
    source.contentByIds(
      Array.from({ length: 201 }, (_, index) => `excess-${index}`),
    ),
    /单次读取的内容引用过多/,
  );
});

test("应用对象批量定位拒绝跨实例同名歧义", async () => {
  const now = "2026-09-27T00:00:00.000Z";
  const source = await PlatformClient.connect({
    async call(method, params) {
      if (method === "platform.bootstrap")
        return {
          centerId: randomUUID(),
          csrfToken: "generation-one",
          principalId: "human",
          actantId: "human-actant",
          displayName: "我",
          capabilities: {
            runtime: true,
            teamAuthentication: false,
            directedInput: false,
            localFiles: false,
            browserBookmarks: true,
            modelSettings: false,
          },
        };
      assert.equal(method, "content.list");
      const options = params as { appId: string; appObjectIds: string[] };
      assert.equal(options.appId, "morphz.objects");
      return options.appObjectIds.flatMap((objectId) =>
        (objectId === "ambiguous" ? ["first", "second"] : ["first"]).map(
          (instanceId) => ({
            id: `${instanceId}-${objectId}`,
            appId: "morphz.objects",
            instanceId,
            providerRevision: 1,
            appObjectId: objectId,
            projectId: "project-one",
            kind: "document",
            title: objectId,
            observedVersionRef: "1",
            availability: "available",
            revision: 1,
            createdAt: now,
            updatedAt: now,
          }),
        ),
      );
    },
  });
  const found = await source.contentByAppObjectIds("morphz.objects", ["one"]);
  assert.equal(found.get("one")?.id, "first-one");
  await assert.rejects(
    source.contentByAppObjectIds("morphz.objects", ["ambiguous"]),
    /多个实例/,
  );
});

test("正式事项编辑保存模型和执行安排，不更改界面结构", async () => {
  const content = taskContentSchema.parse({
    kind: "task",
    description: "交付工作",
    assigneeId: "morphz-agent",
    model: null,
    dueDate: null,
    assignment: "proposed",
    execution: "planned",
    delivery: "none",
    resultIds: [],
    runRequested: 0,
  });
  const writes: unknown[] = [];
  const source = {
    taskVersion: async () => ({
      taskId: "task-one",
      revision: 2,
      description: content.description,
      assigneeId: content.assigneeId,
      modelId: content.model,
      reasoningEffort: content.reasoningEffort ?? null,
      dueDate: content.dueDate,
      assignment: content.assignment,
      execution: content.execution,
      delivery: content.delivery,
      resultIds: content.resultIds,
      runRequested: content.runRequested,
      notBefore: content.notBefore,
      everySeconds: content.everySeconds,
      dependsOnIds: content.dependsOnIds,
      watchSourceIds: content.watchSourceIds,
    }),
    reviseTask: async (value: unknown) => {
      writes.push(value);
    },
  } as unknown as PlatformClient;
  const identity = {
    workspace: {
      revision: 4,
      artifacts: [],
    },
  } as unknown as Boot;
  const commandId = randomUUID();
  await executePlatformOperation(
    source,
    identity,
    {
      commandId,
      operation: {
        type: "revise-artifact",
        artifactId: "task-one",
        expectedRevision: 2,
        title: "安排 Agent",
        content: {
          ...content,
          model: "selected-model",
          reasoningEffort: "high",
          notBefore: "2026-10-02T12:00:00.000Z",
          everySeconds: 3600,
        },
      },
    },
    false,
  );
  assert.deepEqual(writes, [
    {
      commandId,
      taskId: "task-one",
      expectedRevision: 2,
      title: "安排 Agent",
      description: "交付工作",
      dueDate: null,
      assigneeId: "morphz-agent",
      execution: "planned",
      modelId: "selected-model",
      reasoningEffort: "high",
      notBefore: "2026-10-02T12:00:00.000Z",
      everySeconds: 3600,
    },
  ]);
  const referenceCommandId = randomUUID();
  await executePlatformOperation(
    source,
    identity,
    {
      commandId: referenceCommandId,
      operation: {
        type: "revise-artifact",
        artifactId: "task-one",
        expectedRevision: 2,
        title: "安排 Agent",
        content: {
          ...content,
          resultIds: ["deliverable-one"],
          dependsOnIds: ["task-two"],
          watchSourceIds: ["source-one"],
        },
      },
    },
    false,
  );
  assert.deepEqual(writes[1], {
    commandId: referenceCommandId,
    taskId: "task-one",
    expectedRevision: 2,
    title: "安排 Agent",
    description: "交付工作",
    dueDate: null,
    assigneeId: "morphz-agent",
    execution: "planned",
    modelId: null,
    reasoningEffort: null,
    notBefore: null,
    everySeconds: null,
    resultIds: ["deliverable-one"],
    dependsOnIds: ["task-two"],
    watchSourceIds: ["source-one"],
  });
});

test("正式事项编辑可保存分派状态，换负责人时保留待接受且不复用执行轮次", async () => {
  const content = taskContentSchema.parse({
    kind: "task",
    description: "交付工作",
    assigneeId: "morphz-agent",
    model: null,
    dueDate: null,
    assignment: "accepted",
    execution: "planned",
    delivery: "none",
    resultIds: [],
    runRequested: 1,
  });
  const writes: unknown[] = [];
  const source = {
    taskVersion: async () => ({
      revision: 2,
      description: content.description,
      assigneeId: content.assigneeId,
      modelId: content.model,
      reasoningEffort: content.reasoningEffort ?? null,
      dueDate: content.dueDate,
      assignment: content.assignment,
      execution: content.execution,
      delivery: content.delivery,
      resultIds: content.resultIds,
      runRequested: content.runRequested,
      notBefore: content.notBefore,
      everySeconds: content.everySeconds,
      dependsOnIds: content.dependsOnIds,
      watchSourceIds: content.watchSourceIds,
    }),
    reviseTask: async (value: unknown) => {
      writes.push(value);
    },
  } as unknown as PlatformClient;
  const identity = { workspace: { revision: 4 } } as Boot;
  const revision = 2;
  await executePlatformOperation(
    source,
    identity,
    {
      commandId: "task-decline",
      operation: {
        type: "revise-artifact",
        artifactId: "task-one",
        expectedRevision: revision,
        title: "交付工作",
        content: { ...content, assignment: "declined" },
      },
    },
    false,
  );
  assert.equal((writes[0] as { assignment: string }).assignment, "declined");
  await executePlatformOperation(
    source,
    identity,
    {
      commandId: "task-reassign",
      operation: {
        type: "revise-artifact",
        artifactId: "task-one",
        expectedRevision: revision,
        title: "交付工作",
        content: {
          ...content,
          assigneeId: "alice",
          assignment: "proposed",
          runRequested: 0,
        },
      },
    },
    false,
  );
  assert.equal((writes[1] as { assignment: string }).assignment, "proposed");
  assert.equal((writes[1] as { assigneeId: string }).assigneeId, "alice");
  await assert.rejects(
    executePlatformOperation(
      source,
      identity,
      {
        commandId: "task-invalid-run",
        operation: {
          type: "revise-artifact",
          artifactId: "task-one",
          expectedRevision: revision,
          title: "交付工作",
          content: { ...content, runRequested: 2 },
        },
      },
      false,
    ),
    /执行轮次/,
  );
  assert.equal(writes.length, 2);
});

test("正式事项创建保留 Agent 模型、时间和现有关联", async () => {
  const content = taskContentSchema.parse({
    kind: "task",
    description: "按时复查",
    assigneeId: "morphz-agent",
    model: "selected-model",
    reasoningEffort: "high",
    dueDate: null,
    assignment: "proposed",
    execution: "planned",
    delivery: "none",
    resultIds: [],
    notBefore: "2026-10-02T12:00:00.000Z",
    everySeconds: 3600,
  });
  const writes: unknown[] = [];
  const source = {
    createTask: async (value: unknown) => {
      writes.push(value);
    },
  } as unknown as PlatformClient;
  const commandId = randomUUID();
  await executePlatformOperation(
    source,
    { workspace: { revision: 1, artifacts: [] } } as unknown as Boot,
    {
      commandId,
      operation: {
        type: "create-artifact",
        projectId: "project-one",
        title: "定时复查",
        content,
      },
    },
    false,
  );
  assert.deepEqual(writes, [
    {
      commandId,
      taskId: commandId,
      projectId: "project-one",
      title: "定时复查",
      description: "按时复查",
      assigneeId: "morphz-agent",
      modelId: "selected-model",
      reasoningEffort: "high",
      notBefore: "2026-10-02T12:00:00.000Z",
      everySeconds: 3600,
      resultIds: [],
      dependsOnIds: [],
      watchSourceIds: [],
    },
  ]);
  const linkedId = randomUUID();
  await executePlatformOperation(
    source,
    { workspace: { revision: 1, artifacts: [] } } as unknown as Boot,
    {
      commandId: linkedId,
      operation: {
        type: "create-artifact",
        projectId: "project-one",
        title: "带关联的事项",
        content: { ...content, dependsOnIds: ["another-task"] },
      },
    },
    false,
  );
  assert.deepEqual(writes[1], {
    ...(writes[0] as Record<string, unknown>),
    commandId: linkedId,
    taskId: linkedId,
    title: "带关联的事项",
    dependsOnIds: ["another-task"],
  });
});

test("原界面的保存批注按 ID 授权定位首屏外内容，并沿确切版本写入应用私库", async () => {
  const writes: unknown[] = [];
  const source = {
    getContent: async (contentId: string) => ({
      id: contentId,
      appId: "morphz.objects",
      availability: "available",
    }),
    annotateObject: async (value: unknown) => {
      writes.push(value);
    },
  } as unknown as PlatformClient;
  const commandId = randomUUID();
  const receipt = await executePlatformOperation(
    source,
    {
      workspace: {
        revision: 7,
        artifacts: [],
      },
    } as unknown as Boot,
    {
      commandId,
      operation: {
        type: "annotate",
        artifactId: "content-one",
        artifactRevision: 2,
        quote: "确切原文",
        body: "批注正文",
      },
    },
    false,
  );
  assert.equal(receipt.entityId, commandId);
  assert.deepEqual(writes, [
    {
      commandId,
      contentId: "content-one",
      revision: 2,
      quote: "确切原文",
      body: "批注正文",
    },
  ]);
});

test("保存批注拒绝其他应用或已撤下的内容，不写入私库", async () => {
  const writes: unknown[] = [];
  const source = {
    getContent: async () => ({
      id: "content-one",
      appId: "morphz.reader",
      availability: "available",
    }),
    annotateObject: async (value: unknown) => writes.push(value),
  } as unknown as PlatformClient;
  await assert.rejects(
    executePlatformOperation(
      source,
      { workspace: { revision: 7, artifacts: [] } } as unknown as Boot,
      {
        commandId: randomUUID(),
        operation: {
          type: "annotate",
          artifactId: "content-one",
          artifactRevision: 2,
          quote: "确切原文",
          body: "批注正文",
        },
      },
      false,
    ),
    /不是可批注的原件/,
  );
  assert.deepEqual(writes, []);
});

test("事项回应按授权领域接口分页读取，详情不依赖旧 workspace", async () => {
  const centerId = randomUUID();
  const now = "2026-09-27T00:00:00.000Z";
  const calls: Array<{
    method: ApplicationMethod;
    params: unknown;
    generation?: string;
  }> = [];
  const source = await PlatformClient.connect({
    async call(method, params, options) {
      calls.push({ method, params, generation: options?.identityGeneration });
      if (method === "platform.bootstrap")
        return {
          centerId,
          csrfToken: "generation-one",
          principalId: "human",
          actantId: "human-actant",
          displayName: "我",
          capabilities: {
            runtime: true,
            teamAuthentication: false,
            directedInput: false,
            localFiles: false,
            browserBookmarks: true,
            modelSettings: false,
          },
        };
      assert.equal(method, "tasks.responses");
      const after = (params as { after?: { responseId: string } }).after;
      const offset = after ? Number(after.responseId.slice(9)) : 0;
      return Array.from({ length: after ? 1 : 100 }, (_, index) => ({
        id: `response-${offset + index + 1}`,
        taskId: "task-one",
        taskRevision: 1,
        body: "处理完成",
        authorPrincipalId: "human",
        authorActantId: "human-actant",
        createdAt: now,
      }));
    },
  });
  const responses = await source.allTaskResponses("task-one");
  assert.equal(responses.length, 101);
  assert.equal(responses.at(-1)?.id, "response-101");
  assert.deepEqual(
    calls.slice(1).map((call) => call.method),
    ["tasks.responses", "tasks.responses"],
  );
  assert.ok(
    calls.slice(1).every((call) => call.generation === "generation-one"),
  );
});

test("原事项排序仅调整当前选中项，交给 Platform 保留未列出事项的位置", async () => {
  const writes: unknown[] = [];
  const source = {
    reorderTaskSelection: async (value: unknown) => {
      writes.push(value);
    },
  } as unknown as PlatformClient;
  const identity = { workspace: { revision: 3 } } as Boot;
  const commandId = randomUUID();
  const receipt = await executePlatformOperation(
    source,
    identity,
    {
      commandId,
      operation: {
        type: "reorder-tasks",
        taskIds: ["task-three", "task-one"],
        expectedOrderRevision: 7,
      },
    },
    false,
  );
  assert.equal(receipt.entityId, "task-three");
  assert.deepEqual(writes, [
    {
      commandId,
      taskIds: ["task-three", "task-one"],
      expectedOrderRevision: 7,
    },
  ]);
});

test("原看板跨状态拖动把排序与状态作为同一 Platform 命令", async () => {
  const writes: unknown[] = [];
  const source = {
    reorderTaskSelection: async (value: unknown) => {
      writes.push(value);
    },
  } as unknown as PlatformClient;
  const commandId = randomUUID();
  const receipt = await executePlatformOperation(
    source,
    { workspace: { revision: 4 } } as Boot,
    {
      commandId,
      operation: {
        type: "reorder-tasks",
        taskIds: ["task-one", "task-two"],
        expectedOrderRevision: 8,
        move: { taskId: "task-two", expectedRevision: 3, execution: "active" },
      },
    },
    false,
  );
  assert.equal(receipt.entityId, "task-two");
  assert.deepEqual(writes, [
    {
      commandId,
      taskIds: ["task-one", "task-two"],
      expectedOrderRevision: 8,
      move: { taskId: "task-two", expectedRevision: 3, execution: "active" },
    },
  ]);
});

test("原内容设置项目使用目录修订，不把剧本或文档正文版本当成目录版本", async () => {
  const writes: unknown[] = [];
  const newProjects: unknown[] = [];
  const renames: unknown[] = [];
  const scriptRenames: unknown[] = [];
  const source = {
    resolveContent: async () => ({
      id: "script-content",
      appId: "morphz.script-studio",
      appObjectId: "script-one",
      availability: "available",
    }),
    getContent: async () => ({
      id: "document-content",
      appId: "morphz.objects",
      availability: "available",
    }),
    moveContent: async (value: unknown) => {
      writes.push(value);
    },
    createProjectForContent: async (value: unknown) => {
      newProjects.push(value);
    },
    renameObject: async (value: unknown) => {
      renames.push(value);
    },
    renameScript: async (value: unknown) => {
      scriptRenames.push(value);
    },
  } as unknown as PlatformClient;
  const identity = {
    workspace: {
      revision: 8,
      scriptProductions: [],
      artifacts: [],
    },
  } as unknown as Boot;
  const scriptCommand = randomUUID();
  const documentCommand = randomUUID();
  await executePlatformOperation(
    source,
    identity,
    {
      commandId: scriptCommand,
      operation: {
        type: "organize-content",
        target: { kind: "script", id: "script-one" },
        expectedRevision: 2,
        changes: { projectId: "project-two" },
      },
    },
    false,
  );
  await executePlatformOperation(
    source,
    identity,
    {
      commandId: documentCommand,
      operation: {
        type: "organize-content",
        target: { kind: "artifact", id: "document-content" },
        expectedRevision: 3,
        changes: { projectId: "project-two" },
      },
    },
    false,
  );
  assert.deepEqual(writes, [
    {
      commandId: scriptCommand,
      contentId: "script-content",
      targetProjectId: "project-two",
      expectedRevision: 2,
    },
    {
      commandId: documentCommand,
      contentId: "document-content",
      targetProjectId: "project-two",
      expectedRevision: 3,
    },
  ]);
  const newProjectCommand = randomUUID();
  await executePlatformOperation(
    source,
    identity,
    {
      commandId: newProjectCommand,
      operation: {
        type: "organize-content",
        target: { kind: "script", id: "script-one" },
        expectedRevision: 2,
        changes: { newProjectTitle: "新剧本项目" },
      },
    },
    false,
  );
  assert.deepEqual(newProjects, [
    {
      commandId: newProjectCommand,
      projectId: newProjectCommand,
      title: "新剧本项目",
      contentId: "script-content",
      expectedRevision: 2,
    },
  ]);
  const scriptRenameCommand = randomUUID();
  await executePlatformOperation(
    source,
    identity,
    {
      commandId: scriptRenameCommand,
      operation: {
        type: "organize-content",
        target: { kind: "script", id: "script-one" },
        expectedRevision: 2,
        changes: { title: "改名" },
      },
    },
    false,
  );
  assert.deepEqual(scriptRenames, [
    {
      commandId: scriptRenameCommand,
      contentId: "script-content",
      expectedCatalogRevision: 2,
      title: "改名",
    },
  ]);
  const renameCommand = randomUUID();
  await executePlatformOperation(
    source,
    identity,
    {
      commandId: renameCommand,
      operation: {
        type: "organize-content",
        target: { kind: "artifact", id: "document-content" },
        expectedRevision: 3,
        changes: { title: "新标题" },
      },
    },
    false,
  );
  assert.deepEqual(renames, [
    {
      commandId: renameCommand,
      contentId: "document-content",
      expectedCatalogRevision: 3,
      title: "新标题",
    },
  ]);
  assert.equal(writes.length, 2);
  await assert.rejects(
    executePlatformOperation(
      source,
      identity,
      {
        commandId: randomUUID(),
        operation: {
          type: "organize-content",
          target: { kind: "artifact", id: "document-content" },
          expectedRevision: 3,
          changes: { title: "改名", projectId: "project-two" },
        },
      },
      false,
    ),
    /一次只能修改名称或所属项目/,
  );
  assert.equal(writes.length, 2);
  assert.equal(renames.length, 1);
  assert.equal(newProjects.length, 1);
});

test("分页之外的剧本仍能按应用对象 ID 定位并设置项目", async () => {
  const lookups: unknown[] = [];
  const moves: unknown[] = [];
  const source = {
    resolveContent: async (request: unknown) => {
      lookups.push(request);
      return {
        id: "script-content",
        appId: "morphz.script-studio",
        appObjectId: "script-one",
        availability: "available",
      };
    },
    moveContent: async (request: unknown) => {
      moves.push(request);
    },
  } as unknown as PlatformClient;
  const commandId = randomUUID();
  await executePlatformOperation(
    source,
    {
      workspace: { revision: 1, scriptProductions: [], artifacts: [] },
      scriptLibrary: [],
    } as unknown as Boot,
    {
      commandId,
      operation: {
        type: "organize-content",
        target: { kind: "script", id: "script-one" },
        expectedRevision: 3,
        changes: { projectId: "project-two" },
      },
    },
    false,
  );
  assert.deepEqual(lookups, [
    { appId: "morphz.script-studio", appObjectId: "script-one" },
  ]);
  assert.deepEqual(moves, [
    {
      commandId,
      contentId: "script-content",
      targetProjectId: "project-two",
      expectedRevision: 3,
    },
  ]);
});

test("Platform Client 只读取按领域分页数据，不请求整工作区", async () => {
  const calls: Array<{
    method: ApplicationMethod;
    params: unknown;
    generation?: string;
  }> = [];
  const caller: ApplicationCaller = {
    async call(method, params, options) {
      calls.push({ method, params, generation: options?.identityGeneration });
      if (method === "platform.bootstrap")
        return {
          centerId: randomUUID(),
          csrfToken: "identity-generation",
          principalId: "human",
          actantId: "human-actant",
          displayName: "我",
          capabilities: {
            runtime: true,
            teamAuthentication: false,
            directedInput: false,
            localFiles: false,
            browserBookmarks: true,
            modelSettings: false,
          },
        };
      if (method === "projects.list")
        return [
          {
            id: "project-one",
            kind: "project",
            ownerPrincipalId: "human",
            memberPrincipalIds: ["human"],
            title: "项目",
            revision: 1,
            createdAt: "2026-09-27T00:00:00.000Z",
            updatedAt: "2026-09-27T00:00:00.000Z",
            archivedAt: null,
            deletedAt: null,
          },
        ];
      if (method === "platform.message")
        return {
          commandId: (params as { commandId: string }).commandId,
          entityId: "input-one",
        };
      throw new Error(`意外调用 ${method}`);
    },
  };
  const client = await PlatformClient.connect(caller);
  const projects = await client.projects({ limit: 1 });
  assert.deepEqual(projects.nextCursor, {
    updatedAt: "2026-09-27T00:00:00.000Z",
    projectId: "project-one",
  });
  const commandId = randomUUID();
  const quote = {
    id: randomUUID(),
    source: {
      kind: "message" as const,
      projectId: "project-one",
      conversationId: "project-one",
      messageId: "message-one",
      inputId: "input-one",
      title: "Morphz",
      createdAt: "2026-09-27T00:00:00.000Z",
    },
    text: "引用原话",
    comment: "请解释",
  };
  await client.sendMessage({
    commandId,
    projectId: "project-one",
    body: "继续工作",
    textQuotes: [quote],
  });
  assert.deepEqual(
    calls.map(({ method }) => method),
    ["platform.bootstrap", "projects.list", "platform.message"],
  );
  assert.equal(calls[1]!.generation, "identity-generation");
  assert.equal(calls[2]!.generation, "identity-generation");
  assert.deepEqual(calls[2]!.params, {
    commandId,
    operation: {
      type: "record-input",
      projectId: "project-one",
      body: "继续工作",
      textQuotes: [quote],
      dispatchMode: "interrupt",
      artifactId: null,
      artifactRevision: null,
      selection: "",
      targetActantId: "morphz-agent",
    },
  });
});

test("原导航可从 Platform 游标完整读取项目且不回落旧 workspace", async () => {
  const calls: Array<{ method: ApplicationMethod; after?: unknown }> = [];
  const now = "2026-09-27T00:00:00.000Z";
  const caller: ApplicationCaller = {
    async call(method, params) {
      calls.push({
        method,
        after: (params as { after?: unknown } | undefined)?.after,
      });
      if (method === "platform.bootstrap")
        return {
          centerId: randomUUID(),
          csrfToken: "generation",
          principalId: "human",
          actantId: "human-actant",
          displayName: "我",
          capabilities: {
            runtime: true,
            teamAuthentication: false,
            directedInput: false,
            localFiles: false,
            browserBookmarks: false,
            modelSettings: false,
          },
        };
      if (method !== "projects.list") throw new Error(`意外调用 ${method}`);
      const after = (params as { after?: { projectId: string } }).after;
      const first = after === undefined;
      return Array.from({ length: first ? 100 : 1 }, (_, index) => ({
        id: `project-${first ? index : 100}`,
        kind: "project",
        ownerPrincipalId: "human",
        memberPrincipalIds: ["human"],
        title: `项目 ${first ? index : 100}`,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        deletedAt: null,
      }));
    },
  };
  const client = await PlatformClient.connect(caller);
  const projects = await client.allProjects();
  assert.equal(projects.length, 101);
  assert.deepEqual(
    calls.map(({ method }) => method),
    ["platform.bootstrap", "projects.list", "projects.list"],
  );
  assert.deepEqual(calls[2]?.after, {
    updatedAt: now,
    projectId: "project-99",
  });
});

test("原界面刷新仅重读变化的应用原件，不重复读取未变版本", async () => {
  const now = "2026-09-27T00:00:00.000Z";
  const centerId = randomUUID();
  let observedVersionRef = "1";
  let catalogRevision = 1;
  let providerRevision = 1;
  let objectReads = 0;
  let creationReads = 0;
  const source = {
    boot: {
      centerId,
      principalId: "human",
      actantId: "human-actant",
      displayName: "我",
    },
    ensurePersonalSpaces: async () => ({
      deskId: "desk",
      inboxId: "inbox",
      dialogueId: "dialogue",
    }),
    allProjects: async () => [
      {
        id: "project-one",
        kind: "project",
        ownerPrincipalId: "human",
        memberPrincipalIds: ["human"],
        title: "项目",
        revision: 1,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        deletedAt: null,
      },
    ],
    allNavigationConversations: async () => [],
    allTasks: async () => [],
    taskCounts: async () => [],
    contentCounts: async () => [
      { projectId: "project-one", count: 1, latestActivityAt: now },
    ],
    content: async () => ({
      items: [
        {
          id: "content-one",
          appId: "morphz.objects",
          instanceId: "objects-one",
          providerRevision,
          appObjectId: "content-one",
          projectId: "project-one",
          kind: "document",
          title: "文档",
          observedVersionRef,
          availability: "available",
          revision: catalogRevision,
          updatedAt: now,
        },
      ],
      nextCursor: null,
    }),
    readObject: async () => {
      objectReads++;
      return {
        objectId: "content-one",
        contentId: "content-one",
        projectId: "project-one",
        revision: Number(observedVersionRef),
        headRevision: Number(observedVersionRef),
        title: "文档",
        content: {
          kind: "document",
          markdown: `${providerRevision}:${observedVersionRef}`,
        },
        author: { principalId: "human", actantId: "human-actant" },
        createdAt: now,
      };
    },
    objectVersions: async (contentId: string, options: unknown) => {
      creationReads++;
      assert.equal(contentId, "content-one");
      assert.deepEqual(options, { beforeRevision: 2, limit: 1 });
      return {
        objectId: "content-one",
        contentId,
        versions: [
          {
            revision: 1,
            author: { principalId: "human", actantId: "human-actant" },
            createdAt: now,
          },
        ],
      };
    },
    uiPackages: async () => [],
    taskOrder: async () => ({ revision: 0 }),
  } as unknown as PlatformClient;
  const selection = { preferences: { artifactId: "content-one" } };
  const first = await readPlatformWorkspace(
    source,
    [],
    1,
    disconnectedRuntime,
    undefined,
    undefined,
    selection,
  );
  const second = await readPlatformWorkspace(
    source,
    [],
    2,
    disconnectedRuntime,
    undefined,
    first.workspace,
    selection,
  );
  assert.equal(objectReads, 1);
  assert.equal(second.workspace.artifacts[0]?.revision, 1);
  assert.equal(second.workspace.artifacts[0]?.catalogRevision, 1);
  providerRevision = 2;
  const rerouted = await readPlatformWorkspace(
    source,
    [],
    3,
    disconnectedRuntime,
    undefined,
    second.workspace,
    selection,
  );
  assert.equal(objectReads, 2);
  assert.equal(rerouted.workspace.artifacts[0]?.providerRevision, 2);
  assert.deepEqual(rerouted.workspace.artifacts[0]?.content, {
    kind: "document",
    markdown: "2:1",
  });
  catalogRevision = 2;
  const moved = await readPlatformWorkspace(
    source,
    [],
    4,
    disconnectedRuntime,
    undefined,
    rerouted.workspace,
    selection,
  );
  assert.equal(moved.workspace.artifacts[0]?.revision, 1);
  assert.equal(moved.workspace.artifacts[0]?.catalogRevision, 2);
  assert.equal(objectReads, 2);
  observedVersionRef = "2";
  catalogRevision = 3;
  const third = await readPlatformWorkspace(
    source,
    [],
    5,
    disconnectedRuntime,
    undefined,
    moved.workspace,
    selection,
  );
  assert.equal(objectReads, 3);
  assert.equal(creationReads, 1);
  assert.equal(third.workspace.artifacts[0]?.revision, 2);
  assert.equal(third.workspace.artifacts[0]?.catalogRevision, 3);
  assert.deepEqual(
    third.workspace.artifacts[0]?.versions.map((version) =>
      version.content.kind === "document" ? version.content.markdown : null,
    ),
    ["2:1", "2:2"],
  );
  const unchanged = await readPlatformWorkspace(
    source,
    [],
    6,
    disconnectedRuntime,
    undefined,
    third.workspace,
    selection,
  );
  assert.equal(objectReads, 3);
  assert.equal(creationReads, 1);
  assert.deepEqual(unchanged.workspace.artifacts[0]?.createdBy, {
    principalId: "human",
    actantId: "human-actant",
  });
  providerRevision = 3;
  observedVersionRef = "1";
  catalogRevision = 4;
  const replaced = await readPlatformWorkspace(
    source,
    [],
    7,
    disconnectedRuntime,
    undefined,
    unchanged.workspace,
    selection,
  );
  assert.equal(objectReads, 4);
  assert.equal(replaced.workspace.artifacts[0]?.providerRevision, 3);
  assert.deepEqual(
    replaced.workspace.artifacts[0]?.versions.map((version) =>
      version.content.kind === "document" ? version.content.markdown : null,
    ),
    ["3:1"],
  );
});

test("恢复选中的历史正文时按目录原件读取指定版本，不拿当前正文冒充旧版", async () => {
  const now = "2026-09-27T00:00:00.000Z";
  const reads: Array<number | undefined> = [];
  const source = {
    boot: {
      centerId: randomUUID(),
      principalId: "human",
      actantId: "human-actant",
      displayName: "我",
    },
    ensurePersonalSpaces: async () => ({
      deskId: "desk",
      inboxId: "inbox",
      dialogueId: "dialogue",
    }),
    allProjects: async () => [
      {
        id: "project-one",
        kind: "project",
        ownerPrincipalId: "human",
        memberPrincipalIds: ["human"],
        title: "项目",
        revision: 1,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        deletedAt: null,
      },
    ],
    allNavigationConversations: async () => [],
    allTasks: async () => [],
    taskCounts: async () => [],
    contentCounts: async () => [
      { projectId: "project-one", count: 1, latestActivityAt: now },
    ],
    content: async () => ({
      items: [
        {
          id: "content-one",
          appId: "morphz.objects",
          instanceId: "objects-one",
          appObjectId: "object-one",
          projectId: "project-one",
          kind: "document",
          title: "文档",
          observedVersionRef: "3",
          availability: "available",
          revision: 3,
          updatedAt: now,
        },
      ],
      nextCursor: null,
    }),
    readObject: async (_contentId: string, revision?: number) => {
      reads.push(revision);
      const exact = revision ?? 3;
      return {
        objectId: "object-one",
        contentId: "content-one",
        projectId: "project-one",
        revision: exact,
        headRevision: 3,
        title: "文档",
        content: { kind: "document", markdown: `第 ${exact} 版` },
        author: { principalId: "human", actantId: "human-actant" },
        createdAt: now,
      };
    },
    objectVersions: async (contentId: string, options: unknown) => {
      assert.equal(contentId, "content-one");
      assert.deepEqual(options, { beforeRevision: 2, limit: 1 });
      return {
        objectId: "object-one",
        contentId,
        versions: [
          {
            revision: 1,
            author: { principalId: "human", actantId: "human-actant" },
            createdAt: now,
          },
        ],
      };
    },
    uiPackages: async () => [],
    taskOrder: async () => ({ revision: 0 }),
  } as unknown as PlatformClient;
  const first = await readPlatformWorkspace(
    source,
    [],
    1,
    disconnectedRuntime,
    undefined,
    undefined,
    { preferences: { artifactId: "content-one", artifactRevision: 1 } },
  );
  assert.deepEqual(reads, [undefined, 1]);
  assert.equal(first.workspace.artifacts[0]?.revision, 3);
  assert.deepEqual(
    first.workspace.artifacts[0]?.versions.map((version) => [
      version.revision,
      version.content.kind === "document" ? version.content.markdown : "",
    ]),
    [
      [1, "第 1 版"],
      [3, "第 3 版"],
    ],
  );
});

test("冷启动只读目录；多个已打开原件使用全局并发上限", async () => {
  const now = "2026-09-27T00:00:00.000Z";
  let active = 0;
  let peak = 0;
  let reads = 0;
  const source = {
    boot: {
      centerId: randomUUID(),
      principalId: "human",
      actantId: "human-actant",
      displayName: "我",
    },
    ensurePersonalSpaces: async () => ({
      deskId: "desk",
      inboxId: "inbox",
      dialogueId: "dialogue",
    }),
    allProjects: async () => [
      {
        id: "project-one",
        kind: "project",
        ownerPrincipalId: "human",
        memberPrincipalIds: ["human"],
        title: "项目",
        revision: 1,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        deletedAt: null,
      },
    ],
    allNavigationConversations: async () => [],
    allTasks: async () => [],
    taskCounts: async () => [],
    contentCounts: async () => [
      { projectId: "project-one", count: 24, latestActivityAt: now },
    ],
    content: async () => ({
      items: Array.from({ length: 24 }, (_, index) => ({
        id: `content-${index}`,
        appId: "morphz.objects",
        instanceId: "objects-one",
        appObjectId: `object-${index}`,
        projectId: "project-one",
        kind: "document",
        title: `文档 ${index}`,
        observedVersionRef: "1",
        availability: "available",
        revision: 1,
        updatedAt: now,
      })),
      nextCursor: null,
    }),
    readObject: async (contentId: string) => {
      active++;
      peak = Math.max(peak, active);
      reads++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      const index = Number(contentId.slice("content-".length));
      return {
        objectId: `object-${index}`,
        contentId,
        projectId: "project-one",
        revision: 1,
        headRevision: 1,
        title: `文档 ${index}`,
        content: { kind: "document", markdown: `正文 ${index}` },
        author: { principalId: "human", actantId: "human-actant" },
        createdAt: now,
      };
    },
    uiPackages: async () => [],
    taskOrder: async () => ({ revision: 0 }),
  } as unknown as PlatformClient;
  const cold = await readPlatformWorkspace(source, [], 1, disconnectedRuntime);
  assert.equal(reads, 0);
  assert.equal(cold.workspace.artifacts.length, 0);
  assert.equal(cold.catalog.contents.length, 24);
  assert.deepEqual(
    cold.workspace.applications.map((application) => application.id).sort(),
    ["morphz.browser", "morphz.reader", "morphz.script-studio"],
    "The content catalog is navigation, not another launchable application",
  );
  assert.deepEqual(
    applicationFor(
      cold.workspace,
      objectsApplication.id,
      objectsApplication.version,
    ),
    objectsApplication,
    "Opening existing content still resolves its internal Objects renderer",
  );
  const instances = Array.from({ length: 24 }, (_, index) => ({
    id: `instance-${index}`,
    workspaceId: "project-one",
    applicationId: "morphz.objects",
    applicationVersion: "1.0.0",
    revision: 1,
    state: { artifactId: `content-${index}` },
    status: "open" as const,
    createdAt: now,
    updatedAt: now,
  }));
  const result = await readPlatformWorkspace(
    source,
    instances,
    2,
    disconnectedRuntime,
    undefined,
    cold.workspace,
  );
  assert.equal(reads, 24);
  assert.equal(peak, 8);
  assert.equal(result.workspace.artifacts.length, 24);
  assert.equal(result.workspace.artifacts[23]?.content.kind, "document");
});

test("事项列表使用页内当前版本，打开事项时才补齐版本历史", async () => {
  const now = "2026-09-27T00:00:00.000Z";
  const task = {
    id: "task-one",
    projectId: "project-one",
    title: "事项",
    description: "当前描述",
    assigneeId: "human-actant",
    execution: "planned",
    dueDate: null,
    orderRank: 1,
    revision: 8,
    updatedAt: now,
  };
  const version = (revision: number) => ({
    taskId: task.id,
    revision,
    projectId: task.projectId,
    title: task.title,
    description: `描述 ${revision}`,
    assigneeId: task.assigneeId,
    modelId: null,
    reasoningEffort: null,
    dueDate: null,
    assignment: "accepted",
    execution: "planned",
    delivery: "none",
    runRequested: 0,
    notBefore: null,
    everySeconds: null,
    authorPrincipalId: "human",
    authorActantId: "human-actant",
    createdAt: now,
    resultIds: [],
    dependsOnIds: [],
    watchSourceIds: [],
  });
  const taskRow = {
    ...task,
    createdAt: now,
    createdByPrincipalId: "human",
    createdByActantId: "human-actant",
    headVersion: version(8),
  };
  const exactReads: number[] = [];
  let taskListReads = 0;
  let taskHeadReads = 0;
  let historyReads = 0;
  const source = {
    boot: {
      centerId: randomUUID(),
      principalId: "human",
      actantId: "human-actant",
      displayName: "我",
    },
    ensurePersonalSpaces: async () => ({
      deskId: "desk",
      inboxId: "inbox",
      dialogueId: "dialogue",
    }),
    allProjects: async () => [
      {
        id: task.projectId,
        kind: "project",
        ownerPrincipalId: "human",
        memberPrincipalIds: ["human"],
        title: "项目",
        revision: 1,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        deletedAt: null,
      },
    ],
    allNavigationConversations: async () => [],
    allTasks: async () => {
      taskListReads++;
      return [taskRow];
    },
    taskCounts: async () => [
      {
        projectId: task.projectId,
        total: 1,
        pending: 1,
        mineOpen: 1,
        latestActivityAt: now,
      },
    ],
    taskHead: async () => {
      taskHeadReads++;
      return taskRow;
    },
    contentCounts: async () => [],
    content: async () => ({ items: [], nextCursor: null }),
    contentByIds: async () => [],
    uiPackages: async () => [],
    taskOrder: async () => ({ revision: 0 }),
    taskVersion: async (_id: string, revision: number) => {
      exactReads.push(revision);
      return version(revision);
    },
    allTaskVersions: async () => {
      historyReads++;
      return Array.from({ length: 8 }, (_, index) => version(8 - index));
    },
  } as unknown as PlatformClient;
  const first = await readPlatformWorkspace(source, [], 1, disconnectedRuntime);
  assert.deepEqual(exactReads, []);
  assert.equal(historyReads, 0);
  assert.equal(taskListReads, 0);
  assert.equal(first.workspace.artifacts.length, 0);
  const inbox = await readPlatformWorkspace(
    source,
    [],
    2,
    disconnectedRuntime,
    undefined,
    first.workspace,
    { preferences: { view: "inbox" } },
    undefined,
    first.catalog,
  );
  assert.equal(taskListReads, 1);
  assert.deepEqual(
    inbox.workspace.artifacts[0]?.versions.map((item) => item.revision),
    [8],
  );
  const opened = await readPlatformWorkspace(
    source,
    [],
    3,
    disconnectedRuntime,
    undefined,
    inbox.workspace,
    { preferences: { view: "inbox", artifactId: task.id } },
    undefined,
    inbox.catalog,
  );
  assert.equal(historyReads, 1);
  assert.deepEqual(
    opened.workspace.artifacts[0]?.versions.map((item) => item.revision),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  const linked = await readPlatformWorkspace(
    source,
    [],
    4,
    disconnectedRuntime,
    undefined,
    first.workspace,
    { preferences: { artifactId: task.id } },
    undefined,
    first.catalog,
  );
  assert.equal(taskListReads, 1);
  assert.equal(taskHeadReads, 1);
  assert.equal(linked.workspace.artifacts[0]?.id, task.id);
  assert.equal(linked.workspace.artifacts[0]?.versions.length, 8);
});

test("导航只读取当前会话正文，切换项目不拉取其他会话", async () => {
  const now = "2026-09-27T00:00:00.000Z";
  const projects = ["project-one", "project-two"].map((id) => ({
    id,
    kind: "project" as const,
    ownerPrincipalId: "human",
    memberPrincipalIds: ["human"],
    title: id,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
  }));
  const conversations = projects.map((project) => ({
    id: project.id,
    projectId: project.id,
    kind: "default" as const,
    title: project.title,
    revision: 1,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  }));
  const historyCalls: string[] = [];
  let catalogCalls = 0;
  const source = {
    boot: {
      centerId: randomUUID(),
      principalId: "human",
      actantId: "human-actant",
      displayName: "我",
      capabilities: { teamAuthentication: true },
    },
    ensurePersonalSpaces: async () => {
      catalogCalls++;
      return { deskId: "desk", inboxId: "inbox", dialogueId: "dialogue" };
    },
    allProjects: async () => {
      catalogCalls++;
      return projects;
    },
    allNavigationConversations: async () => {
      catalogCalls++;
      return conversations;
    },
    allTasks: async () => {
      catalogCalls++;
      return [];
    },
    taskCounts: async () => {
      catalogCalls++;
      return [];
    },
    contentCounts: async () => {
      catalogCalls++;
      return [];
    },
    content: async () => {
      catalogCalls++;
      return { items: [], nextCursor: null };
    },
    contentByIds: async () => [],
    contentDeliveries: async () => [],
    uiPackages: async () => [],
    taskOrder: async () => {
      catalogCalls++;
      return { revision: 0 };
    },
    history: async (projectId: string, conversationId: string) => {
      historyCalls.push(`${projectId}:${conversationId}`);
      return {
        inputs:
          projectId === "project-two"
            ? [
                {
                  id: "input-with-reading",
                  projectId,
                  conversationId,
                  author: {
                    principalId: "human",
                    actantId: "human-actant",
                  },
                  targetActantId: "morphz-agent",
                  body: "请看这里",
                  artifactId: "content-one",
                  artifactRevision: 2,
                  selection: "原文",
                  reading: {
                    book: {
                      title: "书",
                      author: "",
                      edition: "",
                      format: "markdown",
                    },
                    chapter: "正文",
                    location: {
                      sourceId: "content-one@2",
                      sectionId: "section-1",
                      start: 0,
                      end: 2,
                    },
                    quote: "原文",
                    before: "",
                    after: "",
                  },
                  createdAt: now,
                },
              ]
            : [],
        scriptOutputs: [],
        runtime: { ...disconnectedRuntime, configured: true },
      };
    },
  } as unknown as PlatformClient;
  const runtime = { ...disconnectedRuntime, configured: true };
  const first = await readPlatformWorkspace(
    source,
    [],
    1,
    runtime,
    undefined,
    undefined,
    {
      scope: { projectId: "project-two", conversationId: "project-two" },
    },
  );
  assert.deepEqual(historyCalls, ["project-two:project-two"]);
  assert.equal(catalogCalls, 7);
  assert.equal(first.historyScope?.projectId, "project-two");
  assert.equal(first.workspace.inputs[0]?.artifactId, "content-one");
  assert.equal(first.workspace.inputs[0]?.artifactRevision, 2);
  assert.equal(
    first.workspace.inputs[0]?.reading?.location.sourceId,
    "content-one@2",
  );
  const unchanged = await readPlatformWorkspace(
    source,
    [],
    2,
    runtime,
    undefined,
    first.workspace,
    {
      scope: { projectId: "project-two", conversationId: "project-two" },
    },
    { scope: first.historyScope!, version: "unchanged", value: first.history! },
    first.catalog,
    undefined,
    "unchanged",
  );
  assert.deepEqual(
    historyCalls,
    ["project-two:project-two"],
    "unchanged Runtime version can reuse the selected history instead of downloading it again",
  );
  assert.deepEqual(unchanged.history, first.history);
  assert.equal(catalogCalls, 7, "未变目录不重复读取任何分页或顺序");
  await readPlatformWorkspace(
    source,
    [],
    2,
    runtime,
    undefined,
    first.workspace,
    {
      scope: { projectId: "project-one", conversationId: "project-one" },
    },
    { scope: first.historyScope!, version: "unchanged", value: first.history! },
    first.catalog,
    undefined,
    "unchanged",
  );
  assert.deepEqual(historyCalls, [
    "project-two:project-two",
    "project-one:project-one",
  ]);
  assert.equal(catalogCalls, 7, "切换对话不应触发目录重载");
  assert.equal(
    selectedHistoryScope(
      projects,
      conversations,
      { deskId: "desk", inboxId: "inbox", dialogueId: "dialogue" },
      true,
      {
        scope: {
          projectId: "project-one",
          conversationId: "unpersisted-draft",
        },
      },
    ),
    null,
  );
});

test("原应用窗口操作走 Platform 领域接口，不再写浏览器本地实例", async () => {
  const values = new Map<string, string>();
  const calls: unknown[] = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  try {
    const identity = { workspace: { revision: 4 } } as Boot;
    const now = new Date().toISOString();
    const instance = {
      id: "view-one",
      workspaceId: "desk",
      applicationId: readerApplication.id,
      applicationVersion: readerApplication.version,
      revision: 1,
      state: {},
      status: "open" as const,
      createdAt: now,
      updatedAt: now,
    };
    const source = {
      launchAppView: async (request: unknown) => {
        calls.push({ method: "launch", request });
        return instance;
      },
      saveAppView: async (request: unknown) => {
        calls.push({ method: "save", request });
        return { ...instance, revision: 2, state: { view: "reader" } };
      },
      closeAppView: async (request: unknown) => {
        calls.push({ method: "close", request });
        return { ...instance, revision: 3, status: "closed" as const };
      },
    } as unknown as PlatformClient;
    const launchId = randomUUID();
    const saveId = randomUUID();
    const closeId = randomUUID();
    const first = await executePlatformOperation(
      source,
      identity,
      {
        commandId: launchId,
        operation: {
          type: "launch-application",
          workspaceId: "desk",
          applicationId: readerApplication.id,
          applicationVersion: readerApplication.version,
        },
      },
      false,
    );
    assert.equal(first.entityId, instance.id);
    await executePlatformOperation(
      source,
      identity,
      {
        commandId: saveId,
        operation: {
          type: "set-application-state",
          instanceId: instance.id,
          expectedRevision: 1,
          state: { view: "reader" },
        },
      },
      false,
    );
    await executePlatformOperation(
      source,
      identity,
      {
        commandId: closeId,
        operation: {
          type: "close-application",
          instanceId: instance.id,
          expectedRevision: 2,
        },
      },
      false,
    );
    assert.deepEqual(calls, [
      {
        method: "launch",
        request: {
          commandId: launchId,
          projectId: "desk",
          appId: readerApplication.id,
          packageVersion: readerApplication.version,
          state: {},
        },
      },
      {
        method: "save",
        request: {
          commandId: saveId,
          viewId: instance.id,
          expectedRevision: 1,
          state: { view: "reader" },
        },
      },
      {
        method: "close",
        request: {
          commandId: closeId,
          viewId: instance.id,
          expectedRevision: 2,
        },
      },
    ]);
    assert.equal(
      [...values.keys()].some((key) => key.endsWith(":application-instances")),
      false,
    );
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("原事项安排控件写入 Platform 同一修订命令", async () => {
  const writes: unknown[] = [];
  const source = {
    reviseTask: async (input: unknown) => {
      writes.push(input);
      return "task-one";
    },
  } as unknown as PlatformClient;
  const identity = {
    workspace: { revision: 4 },
  } as Boot;
  const commandId = randomUUID();
  const receipt = await executePlatformOperation(
    source,
    identity,
    {
      commandId,
      operation: {
        type: "arrange-task",
        taskId: "task-one",
        expectedRevision: 2,
        changes: { dueDate: null },
      },
    },
    false,
  );
  assert.deepEqual(writes, [
    {
      commandId,
      taskId: "task-one",
      expectedRevision: 2,
      dueDate: null,
    },
  ]);
  assert.equal(receipt.entityId, "task-one");
  const secondCommand = randomUUID();
  await executePlatformOperation(
    source,
    identity,
    {
      commandId: secondCommand,
      operation: {
        type: "arrange-task",
        taskId: "task-one",
        expectedRevision: 3,
        changes: { assigneeId: "morphz-agent" },
      },
    },
    false,
  );
  assert.deepEqual(writes[1], {
    commandId: secondCommand,
    taskId: "task-one",
    expectedRevision: 3,
    assigneeId: "morphz-agent",
  });
});

test("原对话菜单的改名和归档共用 Platform 版本与幂等命令", async () => {
  const writes: unknown[] = [];
  const source = {
    updateConversation: async (input: unknown) => {
      writes.push(input);
      return "conversation-one";
    },
  } as unknown as PlatformClient;
  const commandId = randomUUID();
  const receipt = await executePlatformOperation(
    source,
    {
      workspace: { revision: 9 },
    } as Boot,
    {
      commandId,
      operation: {
        type: "update-conversation",
        conversationId: "conversation-one",
        expectedRevision: 3,
        title: "新的标题",
        archived: true,
      },
    },
    false,
  );
  assert.equal(receipt.entityId, "conversation-one");
  assert.deepEqual(writes, [
    {
      commandId,
      conversationId: "conversation-one",
      expectedRevision: 3,
      title: "新的标题",
      archived: true,
    },
  ]);
});

test("剧本目录与打开定位始终只投影元数据，不预读正文和版本历史", async () => {
  const now = "2026-09-27T00:00:00.000Z";
  const centerId = randomUUID();
  let observedVersionRef = "1";
  let providerRevision = 1;
  let headHasScript = true;
  let exactLookups = 0;
  let overviewReads = 0;
  let snapshotReads = 0;
  let sourceLookups = 0;
  const source = {
    boot: {
      centerId,
      principalId: "human",
      actantId: "human-actant",
      displayName: "我",
    },
    ensurePersonalSpaces: async () => ({
      deskId: "desk",
      inboxId: "inbox",
      dialogueId: "dialogue",
    }),
    allProjects: async () => [
      {
        id: "project-one",
        kind: "project",
        ownerPrincipalId: "human",
        memberPrincipalIds: ["human"],
        title: "项目",
        revision: 1,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        deletedAt: null,
      },
    ],
    allNavigationConversations: async () => [],
    allTasks: async () => [],
    taskCounts: async () => [],
    contentCounts: async () => [
      { projectId: "project-one", count: 1, latestActivityAt: now },
    ],
    content: async () => ({
      items: headHasScript
        ? [
            {
              id: "script-content",
              appId: "morphz.script-studio",
              instanceId: "script-instance",
              providerRevision,
              appObjectId: "script-one",
              projectId: "project-one",
              kind: "script",
              title: "剧本",
              observedVersionRef,
              availability: "available",
              revision: Number(observedVersionRef),
              updatedAt: now,
            },
          ]
        : [],
      nextCursor: null,
    }),
    resolveContent: async (reference: {
      appId: string;
      appObjectId: string;
    }) => {
      exactLookups++;
      assert.deepEqual(reference, {
        appId: "morphz.script-studio",
        appObjectId: "script-one",
      });
      return {
        id: "script-content",
        appId: "morphz.script-studio",
        instanceId: "script-instance",
        providerRevision,
        appObjectId: "script-one",
        projectId: "project-one",
        kind: "script",
        title: "剧本",
        observedVersionRef,
        availability: "available",
        revision: Number(observedVersionRef),
        updatedAt: now,
      };
    },
    readScript: async () => {
      overviewReads++;
      return {
        contentId: "script-content",
        productionId: "script-one",
        projectId: "project-one",
        title: "剧本",
        metadataRevision: 1,
        activityRevision: Number(observedVersionRef),
        updatedAt: now,
        brief: emptyScriptBrief,
        progress: { episodes: 0, scenes: 0, pendingCandidates: 0 },
      };
    },
    contentByAppObjectIds: async (appId: string, ids: string[]) => {
      sourceLookups++;
      assert.equal(appId, "morphz.objects");
      assert.deepEqual(ids, ["source-object"]);
      return new Map([["source-object", { id: "source-content" }]]);
    },
    readScriptSnapshot: async () => {
      snapshotReads++;
      throw new Error("导航投影不能读取完整剧本。");
    },
    uiPackages: async () => [],
    taskOrder: async () => ({ revision: 0 }),
  } as unknown as PlatformClient;
  const first = await readPlatformWorkspace(source, [], 1, disconnectedRuntime);
  assert.equal(first.workspace.scriptProductions.length, 0);
  assert.equal(first.catalog.scriptLibrary[0]?.id, "script-one");
  assert.equal(overviewReads, 0);
  assert.equal(snapshotReads, 0);
  const second = await readPlatformWorkspace(
    source,
    [],
    2,
    disconnectedRuntime,
    undefined,
    first.workspace,
    {},
    undefined,
    first.catalog,
  );
  assert.equal(overviewReads, 0);
  assert.equal(snapshotReads, 0);
  const opened = await readPlatformWorkspace(
    source,
    [],
    3,
    disconnectedRuntime,
    undefined,
    second.workspace,
    { preferences: { scriptLocation: { productionId: "script-one" } } },
    undefined,
    second.catalog,
  );
  assert.deepEqual(opened.workspace.scriptProductions, []);
  assert.equal(opened.catalog.scriptLibrary[0]?.id, "script-one");
  assert.equal(snapshotReads, 0);
  assert.equal(sourceLookups, 0);
  const unchanged = await readPlatformWorkspace(
    source,
    [],
    4,
    disconnectedRuntime,
    undefined,
    opened.workspace,
    { preferences: { scriptLocation: { productionId: "script-one" } } },
    undefined,
    opened.catalog,
  );
  assert.equal(snapshotReads, 0);
  assert.equal(sourceLookups, 0);
  providerRevision = 2;
  const rerouted = await readPlatformWorkspace(
    source,
    [],
    5,
    disconnectedRuntime,
    undefined,
    unchanged.workspace,
    { preferences: { scriptLocation: { productionId: "script-one" } } },
  );
  assert.deepEqual(rerouted.workspace.scriptProductions, []);
  assert.equal(rerouted.catalog.contents[0]?.providerRevision, 2);
  assert.equal(snapshotReads, 0);
  observedVersionRef = "2";
  const third = await readPlatformWorkspace(
    source,
    [],
    6,
    disconnectedRuntime,
    undefined,
    rerouted.workspace,
    { preferences: { scriptLocation: { productionId: "script-one" } } },
  );
  assert.equal(overviewReads, 0);
  assert.equal(snapshotReads, 0);
  assert.equal(sourceLookups, 0);
  assert.deepEqual(third.workspace.scriptProductions, []);
  assert.equal(third.catalog.scriptLibrary[0]?.activityRevision, 2);
  assert.equal(third.catalog.scriptLibrary[0]?.contentId, "script-content");
  assert.equal(third.catalog.scriptLibrary[0]?.catalogRevision, 2);
  headHasScript = false;
  const reopenedBeyondHead = await readPlatformWorkspace(
    source,
    [],
    7,
    disconnectedRuntime,
    undefined,
    undefined,
    { preferences: { scriptLocation: { productionId: "script-one" } } },
  );
  assert.equal(exactLookups, 1);
  assert.deepEqual(reopenedBeyondHead.workspace.scriptProductions, []);
  assert.equal(snapshotReads, 0);
  assert.equal(sourceLookups, 0);
  assert.equal(reopenedBeyondHead.catalog.scriptLibrary[0]?.id, "script-one");
});

test("原剧本工作室新建通过应用原件与 Platform 目录，不写旧 workspace", async () => {
  const writes: Array<{ method: string; input: unknown }> = [];
  const source = {
    resolveContent: async () => ({
      id: "script-content",
      appId: "morphz.script-studio",
      appObjectId: "script-one",
      projectId: "project-one",
      kind: "script",
      title: "剧本",
      availability: "available",
      observedVersionRef: "4",
      updatedAt: "2026-09-28T00:00:00.000Z",
      revision: 1,
    }),
    createScript: async (input: unknown) => {
      writes.push({ method: "createScript", input });
    },
    getContent: async (contentId: string) => {
      assert.equal(contentId, "source-content");
      return {
        id: contentId,
        appId: "morphz.objects",
        instanceId: "objects-instance",
        appObjectId: "source-object",
        availability: "available",
      };
    },
    createScriptItem: async (input: unknown) => {
      writes.push({ method: "createScriptItem", input });
    },
  } as unknown as PlatformClient;
  const identity = {
    workspace: {
      revision: 3,
      scriptProductions: [],
    },
  } as unknown as Boot;
  const productionId = randomUUID();
  assert.equal(
    (
      await executePlatformOperation(
        source,
        identity,
        {
          commandId: productionId,
          operation: {
            type: "script-command",
            command: {
              action: "create-production",
              projectId: "project-one",
              title: "剧本",
            },
          },
        },
        false,
      )
    ).entityId,
    productionId,
  );
  const itemId = randomUUID();
  assert.equal(
    (
      await executePlatformOperation(
        source,
        identity,
        {
          commandId: itemId,
          operation: {
            type: "script-command",
            command: {
              action: "create-item",
              productionId: "script-one",
              kind: "episode",
              draft: {
                ...emptyScriptDraft("第一集"),
                sources: [
                  {
                    artifactId: "source-content",
                    revision: 2,
                    quote: "引用原文",
                  },
                ],
              },
            },
          },
        },
        false,
      )
    ).entityId,
    itemId,
  );
  assert.deepEqual(writes, [
    {
      method: "createScript",
      input: {
        commandId: productionId,
        productionId,
        projectId: "project-one",
        title: "剧本",
      },
    },
    {
      method: "createScriptItem",
      input: {
        commandId: itemId,
        contentId: "script-content",
        itemId,
        expectedActivityRevision: 4,
        kind: "episode",
        draft: {
          ...emptyScriptDraft("第一集"),
          sources: [
            {
              appId: "morphz.objects",
              instanceId: "objects-instance",
              objectId: "source-object",
              versionRef: "2",
              quote: "引用原文",
            },
          ],
        },
      },
    },
  ]);
});

test("原候选页决定通过剧本私库命令，不回写旧 workspace", async () => {
  const writes: unknown[] = [];
  const source = {
    resolveContent: async () => ({
      id: "script-content",
      appId: "morphz.script-studio",
      appObjectId: "script-one",
      projectId: "project-one",
      kind: "script",
      title: "剧本",
      availability: "available",
      observedVersionRef: "4",
      updatedAt: "2026-09-28T00:00:00.000Z",
      revision: 1,
    }),
    decideScriptCandidate: async (input: unknown) => {
      writes.push(input);
    },
  } as unknown as PlatformClient;
  const identity = {
    workspace: {
      revision: 6,
      scriptProductions: [],
    },
  } as unknown as Boot;
  const commandId = randomUUID();
  const receipt = await executePlatformOperation(
    source,
    identity,
    {
      commandId,
      operation: {
        type: "script-command",
        command: {
          action: "decide-candidate",
          productionId: "script-one",
          candidateId: "candidate-one",
          expectedRevision: 2,
          decision: "accept",
        },
      },
    },
    false,
  );
  assert.equal(receipt.entityId, "candidate-one");
  assert.deepEqual(writes, [
    {
      commandId,
      contentId: "script-content",
      candidateId: "candidate-one",
      expectedRevision: 2,
      decision: "accept",
    },
  ]);
});
