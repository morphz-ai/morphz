import test from "node:test";
import assert from "node:assert/strict";
import { PlatformAgentTools } from "../packages/application/src/platform-agent-tools.js";
import type {
  HostInvocation,
  ToolScope,
  AgentToolArguments,
} from "../packages/application/src/agent-tools.js";
import type { PlatformAgentDomain } from "../packages/application/src/platform-agent-tools.js";
import { contentIdForAppObject } from "../packages/application/src/content-id.js";
import { stableId } from "../packages/application/src/stable-id.js";

test("正式 Agent 当前理解只发布 Runtime 已提交帧并读取 Platform 公开视图", async () => {
  const reads: unknown[] = [];
  const publications: unknown[] = [];
  const verifiedVersions: unknown[] = [];
  const sourceContentId = contentIdForAppObject(
    "tenant-one",
    "objects-instance",
    "document-one",
  );
  const current = {
    projectId: "project-one",
    revision: 1,
    frameId: "mw-public-project-one",
    frameRevision: 2,
    mindVersion: 4,
    body: "已确认的目标。",
    sources: [],
  };
  const tools = new PlatformAgentTools({
    authority: {
      withInvocation: async (
        _route: unknown,
        action: (
          actor: unknown,
          source: unknown,
          identity: unknown,
        ) => Promise<unknown>,
      ) =>
        action(
          { credential: "verified-agent" },
          { projectId: "project-one", inputId: "input-one" },
          {
            tenantId: "tenant-one",
            principalId: "human",
            humanActantId: "human-actant",
            agentActantId: "agent-actant",
          },
        ),
    },
    work: {},
    readUnderstanding: async (
      route: unknown,
      scope: unknown,
      revision: number,
    ) => {
      reads.push({ route, scope, revision });
      return {
        body: "已确认的目标。",
        frameId: "mw-public-project-one",
        frameRevision: 2,
        mindVersion: 4,
      };
    },
    content: {
      platform: {
        getProjectUnderstanding: async () => current,
        replayProjectUnderstanding: async () => null,
        content: async () => ({
          content_id: sourceContentId,
          project_id: "project-one",
          availability: "available",
          app_id: "morphz.objects",
          instance_id: "objects-instance",
          kind: "document",
          app_object_id: "document-one",
        }),
        publishProjectUnderstanding: async (
          _actor: unknown,
          request: unknown,
        ) => {
          publications.push(request);
          return current;
        },
      },
      objects: {
        verifyDocumentVersion: async (request: unknown) => {
          verifiedVersions.push(request);
        },
      },
      instanceIds: { objects: "objects-instance" },
    },
  } as unknown as PlatformAgentDomain);
  const route = {
    context_id: "context-one",
    job_id: "job-one",
    tool_call_id: "publish-one",
  } as HostInvocation;
  const scope = {
    platform: true,
    platformSource: "input",
    projectId: "project-one",
    inputId: "input-one",
    access: { principalId: "morphz-service", actantId: "agent-actant" },
  } as ToolScope;
  assert.deepEqual(
    await tools.call(route, scope, {
      action: "read-understanding",
    } as AgentToolArguments),
    { ok: true, understanding: current },
  );
  const result = await tools.call(route, scope, {
    action: "publish-understanding",
    frameRevision: 2,
    revision: 0,
    contentSources: [],
  } as AgentToolArguments);
  assert.deepEqual(reads, [{ route, scope, revision: 2 }]);
  assert.equal(publications.length, 1);
  assert.deepEqual(publications[0], {
    commandId: stableId(
      "platform-agent-command",
      route.context_id,
      route.job_id,
      route.tool_call_id,
    ),
    projectId: "project-one",
    expectedRevision: 0,
    frameId: "mw-public-project-one",
    frameRevision: 2,
    mindVersion: 4,
    body: "已确认的目标。",
    sources: [],
  });
  assert.equal(
    (result as { understanding: { revision: number } }).understanding.revision,
    1,
  );
  await tools.call({ ...route, tool_call_id: "publish-with-source" }, scope, {
    action: "publish-understanding",
    frameRevision: 2,
    revision: 1,
    contentSources: [{ contentId: sourceContentId, versionRef: "3" }],
  } as AgentToolArguments);
  assert.deepEqual(verifiedVersions, [
    { tenantId: "tenant-one", objectId: "document-one", revision: 3 },
  ]);
  assert.deepEqual((publications[1] as { sources: unknown }).sources, [
    { contentId: sourceContentId, versionRef: "3" },
  ]);
  await assert.rejects(
    tools.call(route, scope, {
      action: "publish-understanding",
      frameRevision: 2,
      sources: [{ artifactId: "old-artifact", revision: 1 }],
    } as AgentToolArguments),
    /来源使用内容 ID/,
  );
  assert.equal(publications.length, 2);
});

test("Agent 从个人对话查项目并以确切 ID 创建事项", async () => {
  const projectQueries: unknown[] = [];
  const taskWrites: unknown[] = [];
  const tools = new PlatformAgentTools({
    authority: {
      withInvocation: async (
        _route: unknown,
        action: (
          actor: unknown,
          source: unknown,
          identity: unknown,
        ) => Promise<unknown>,
      ) =>
        action(
          { credential: "verified-agent" },
          { projectId: "personal-desk", inputId: "input-one" },
          {
            principalId: "human",
            humanActantId: "human-actant",
            agentActantId: "agent-actant",
          },
        ),
    },
    work: {
      listProjects: async (_actor: unknown, request: unknown) => {
        projectQueries.push(request);
        return [
          { id: "target-project", title: "目标项目" },
          { id: "next-project", title: "下一页项目" },
        ];
      },
      createTask: async (_actor: unknown, request: unknown) => {
        taskWrites.push(request);
        return (request as { taskId: string }).taskId;
      },
      taskVersion: async (_actor: unknown, request: { taskId: string }) => ({
        id: request.taskId,
        projectId: "target-project",
      }),
    },
  } as unknown as PlatformAgentDomain);
  const route = {
    context_id: "context-one",
    job_id: "job-one",
    tool_call_id: "query-projects",
  } as HostInvocation;
  const scope = {
    platform: true,
    projectId: "personal-desk",
    inputId: "input-one",
  } as ToolScope;
  assert.deepEqual(
    await tools.call(route, scope, {
      action: "projects",
      management: {
        action: "list",
        status: "active",
        query: "目标",
        offset: 5,
        limit: 1,
      },
    } as AgentToolArguments),
    {
      ok: true,
      hasMore: true,
      nextOffset: 6,
      items: [{ id: "target-project", title: "目标项目" }],
    },
  );
  assert.deepEqual(projectQueries, [
    { status: "active", query: "目标", offset: 5, limit: 2 },
  ]);
  const created = (await tools.call(
    { ...route, tool_call_id: "create-task" },
    scope,
    {
      action: "work-task",
      workTask: {
        action: "create",
        projectId: "target-project",
        title: "目标项目事项",
        description: "",
        assignee: "me",
      },
    } as AgentToolArguments,
  )) as { task: { projectId: string } };
  assert.equal(created.task.projectId, "target-project");
  assert.equal(
    (taskWrites[0] as { projectId: string }).projectId,
    "target-project",
  );
});

test("Agent 的对象关联读写绑定当前输入项目，与 UI 共用 Platform 操作", async () => {
  const writes: unknown[] = [];
  const reads: unknown[] = [];
  const tools = new PlatformAgentTools({
    authority: {
      withInvocation: async (
        _route: unknown,
        action: (
          actor: unknown,
          source: unknown,
          identity: unknown,
        ) => Promise<unknown>,
      ) =>
        action(
          { credential: "verified-agent" },
          { projectId: "project-one", inputId: "input-one" },
          { principalId: "human", humanActantId: "human-actant" },
        ),
    },
    work: {
      linkWork: async (_actor: unknown, request: unknown) => {
        writes.push(request);
        return "relation-one";
      },
      listWorkRelations: async (_actor: unknown, request: unknown) => {
        reads.push(request);
        return [
          {
            id: "relation-one",
            fromId: "object-one",
            toId: "task-one",
            type: "references",
          },
        ];
      },
    },
  } as unknown as PlatformAgentDomain);
  const route = {
    context_id: "context-one",
    job_id: "job-one",
    tool_call_id: "link-one",
  } as HostInvocation;
  const scope = {
    platform: true,
    projectId: "project-one",
    inputId: "input-one",
  } as ToolScope;
  assert.deepEqual(
    await tools.call(route, scope, {
      action: "link",
      artifactId: "object-one",
      toId: "task-one",
      relation: "references",
    } as AgentToolArguments),
    {
      ok: true,
      relationId: "relation-one",
      fromId: "object-one",
      toId: "task-one",
    },
  );
  assert.equal(
    (writes[0] as { expectedProjectId: string }).expectedProjectId,
    "project-one",
  );
  assert.deepEqual(
    await tools.call(route, scope, {
      action: "relations",
      artifactId: "object-one",
      limit: 10,
    } as AgentToolArguments),
    {
      ok: true,
      relations: [
        {
          id: "relation-one",
          fromId: "object-one",
          toId: "task-one",
          type: "references",
        },
      ],
      nextCursor: null,
    },
  );
  assert.deepEqual(reads, [
    { objectId: "object-one", expectedProjectId: "project-one", limit: 11 },
  ]);
});

test("Agent 事项修改使用 Platform 修订，跨项目移动返回回执而不越界重读", async () => {
  const writes: unknown[] = [];
  const tools = new PlatformAgentTools({
    authority: {
      withInvocation: async (
        _route: unknown,
        action: (
          actor: unknown,
          source: unknown,
          identity: unknown,
        ) => Promise<unknown>,
      ) =>
        action(
          { credential: "verified-agent" },
          { projectId: "project-one", inputId: "input-one" },
          {
            principalId: "human",
            humanActantId: "human-actant",
            agentActantId: "agent-actant",
          },
        ),
    },
    work: {
      reviseTask: async (_actor: unknown, request: unknown) => {
        writes.push(request);
        return "task-one";
      },
      taskVersion: async () => {
        throw new Error("不能用原输入权限重读目标项目");
      },
    },
  } as unknown as PlatformAgentDomain);
  const route = {
    context_id: "context-one",
    job_id: "job-one",
    tool_call_id: "move-task-one",
  } as HostInvocation;
  const scope = {
    platform: true,
    projectId: "project-one",
    inputId: "input-one",
  } as ToolScope;
  const result = (await tools.call(route, scope, {
    action: "work-task",
    workTask: {
      action: "revise",
      taskId: "task-one",
      revision: 2,
      projectId: "project-two",
      assignee: "agent",
      assignment: "proposed",
      modelId: "selected-model",
      reasoningEffort: "high",
      notBefore: "2026-10-02T12:00:00.000Z",
      everySeconds: 3600,
    },
  } as AgentToolArguments)) as {
    ok: boolean;
    moved: { projectId: string; revision: number };
  };
  assert.equal(result.ok, true);
  assert.deepEqual(result.moved, {
    taskId: "task-one",
    projectId: "project-two",
    revision: 3,
  });
  assert.deepEqual(writes, [
    {
      commandId: (writes[0] as { commandId: string }).commandId,
      taskId: "task-one",
      expectedRevision: 2,
      assigneeId: "agent-actant",
      assignment: "proposed",
      projectId: "project-two",
      modelId: "selected-model",
      reasoningEffort: "high",
      notBefore: "2026-10-02T12:00:00.000Z",
      everySeconds: 3600,
    },
  ]);
});

test("Agent 请求执行使用已保存的 Platform 模型和时间安排", async () => {
  const validations: unknown[] = [];
  const writes: unknown[] = [];
  const tools = new PlatformAgentTools({
    authority: {
      withInvocation: async (
        _route: unknown,
        action: (
          actor: unknown,
          source: unknown,
          identity: unknown,
        ) => Promise<unknown>,
      ) =>
        action(
          { credential: "verified-agent" },
          { projectId: "project-one", inputId: "input-one" },
          {
            principalId: "human",
            humanActantId: "human-actant",
            agentActantId: "agent-actant",
          },
        ),
    },
    work: {
      taskVersion: async () => ({
        taskId: "task-one",
        projectId: "project-one",
        title: "检查交付",
        description: "检查新资料",
        runRequested: 0,
        modelId: "selected-model",
        reasoningEffort: "high",
        notBefore: "2026-10-02T12:00:00.000Z",
        everySeconds: 3600,
        createdAt: "2026-09-28T12:00:00.000Z",
      }),
      requestTaskRun: async (_actor: unknown, request: unknown) => {
        writes.push(request);
        return { taskId: "task-one", runNumber: 1, eventId: "event-one" };
      },
    },
    prepareTaskSession: async () => "host-task-session",
    validateTaskInference: async (
      access: unknown,
      model: unknown,
      effort: unknown,
    ) => {
      validations.push([access, model, effort]);
    },
  } as unknown as PlatformAgentDomain);
  const result = await tools.call(
    {
      context_id: "context-one",
      job_id: "job-one",
      tool_call_id: "start-one",
    } as HostInvocation,
    {
      platform: true,
      projectId: "project-one",
      inputId: "input-one",
    } as ToolScope,
    {
      action: "work-task",
      workTask: { action: "start", taskId: "task-one", revision: 2 },
    } as AgentToolArguments,
  );
  assert.equal((result as { eventId: string }).eventId, "event-one");
  assert.deepEqual(validations, [
    [
      { principalId: "human", actantId: "human-actant" },
      "selected-model",
      "high",
    ],
  ]);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], {
    commandId: (writes[0] as { commandId: string }).commandId,
    taskId: "task-one",
    expectedRevision: 2,
    sessionId: "host-task-session",
    intent: "检查交付\n\n检查新资料",
    modelAlias: "selected-model",
    reasoningEffort: "high",
    notBefore: "2026-10-02T12:00:00.000Z",
    intervalSeconds: 3600,
  });
});

test("Agent 修改对话调用与 UI 相同的 Platform 领域操作且不能改绑项目", async () => {
  const writes: unknown[] = [];
  const tools = new PlatformAgentTools({
    authority: {
      withInvocation: async (
        _route: unknown,
        action: (
          actor: unknown,
          source: unknown,
          identity: unknown,
        ) => Promise<unknown>,
      ) =>
        action(
          { credential: "verified-agent" },
          { projectId: "project-one", inputId: "input-one" },
          {
            principalId: "human",
            humanActantId: "human-actant",
          },
        ),
    },
    work: {
      updateConversation: async (_actor: unknown, request: unknown) => {
        writes.push(request);
        return "conversation-one";
      },
    },
  } as unknown as PlatformAgentDomain);
  const route = {
    context_id: "context-one",
    job_id: "job-one",
    tool_call_id: "call-one",
  } as HostInvocation;
  const scope = {
    platform: true,
    projectId: "project-one",
    inputId: "input-one",
  } as ToolScope;
  const management = {
    action: "archive",
    conversationId: "conversation-one",
    revision: 2,
    status: "active",
    query: "",
    offset: 0,
    limit: 50,
  } as const;
  const result = (await tools.call(route, scope, {
    action: "conversations",
    management,
  } as AgentToolArguments)) as { ok: boolean; receipt: { entityId: string } };
  assert.equal(result.ok, true);
  assert.equal(result.receipt.entityId, "conversation-one");
  assert.match(
    (writes[0] as { commandId: string }).commandId,
    /^[-a-zA-Z0-9_]+$/,
  );
  assert.deepEqual(writes, [
    {
      commandId: (writes[0] as { commandId: string }).commandId,
      conversationId: "conversation-one",
      expectedRevision: 2,
      archived: true,
    },
  ]);
  await assert.rejects(
    tools.call(route, scope, {
      action: "conversations",
      management: { ...management, projectId: "project-two" },
    } as AgentToolArguments),
    /另一项目/,
  );
  assert.equal(writes.length, 1);
});

test("Agent 恢复项目使用与 UI 相同的修订及回执操作", async () => {
  const writes: unknown[] = [];
  const tools = new PlatformAgentTools({
    authority: {
      withInvocation: async (
        _route: unknown,
        action: (
          actor: unknown,
          source: unknown,
          identity: unknown,
        ) => Promise<unknown>,
      ) =>
        action(
          { credential: "verified-agent" },
          { projectId: "project-one", inputId: "input-one" },
          { principalId: "human", humanActantId: "human-actant" },
        ),
    },
    work: {
      changeProjectState: async (_actor: unknown, request: unknown) => {
        writes.push(request);
        return "project-one";
      },
      getProject: async () => ({
        id: "project-one",
        revision: 3,
        archivedAt: null,
      }),
    },
  } as unknown as PlatformAgentDomain);
  const result = (await tools.call(
    {
      context_id: "context-one",
      job_id: "job-one",
      tool_call_id: "restore-project",
    } as HostInvocation,
    {
      platform: true,
      projectId: "project-one",
      inputId: "input-one",
    } as ToolScope,
    {
      action: "projects",
      management: {
        action: "restore",
        projectId: "project-one",
        revision: 2,
        status: "active",
        query: "",
        offset: 0,
        limit: 50,
      },
    } as AgentToolArguments,
  )) as { receipt: { entityId: string } };
  assert.equal(result.receipt.entityId, "project-one");
  assert.deepEqual(writes, [
    {
      commandId: (writes[0] as { commandId: string }).commandId,
      projectId: "project-one",
      expectedRevision: 2,
      state: "active",
    },
  ]);
});

test("Agent 归入项目沿用目录事务，剧本原件 ID 不冒充内容 ID", async () => {
  const moves: unknown[] = [];
  const creations: unknown[] = [];
  const renames: unknown[] = [];
  let renamed = false;
  const tools = new PlatformAgentTools({
    authority: {
      withInvocation: async (
        _route: unknown,
        action: (
          actor: unknown,
          source: unknown,
          identity: unknown,
        ) => Promise<unknown>,
      ) =>
        action(
          { credential: "verified-agent" },
          { projectId: "project-one", inputId: "input-one" },
          {
            tenantId: "tenant-one",
            principalId: "human",
            humanActantId: "human-actant",
            agentActantId: "agent-actant",
          },
        ),
    },
    work: {
      moveContent: async (_actor: unknown, request: unknown) => {
        moves.push(request);
        return "content-one";
      },
      createProjectForContent: async (_actor: unknown, request: unknown) => {
        creations.push(request);
        return "new-project";
      },
    },
    content: {
      instanceIds: { objects: "objects-one", scriptStudio: "studio-one" },
      platform: {
        content: async () => ({
          project_id: "project-one",
          instance_id: "objects-one",
          app_object_id: "object-one",
          observed_version_ref: renamed ? "2" : "1",
          title: renamed ? "改名" : "原名",
          revision: renamed ? 2 : 1,
        }),
      },
      objects: {
        renameObject: async (request: { commandId: string; title: string }) => {
          renames.push(request);
          renamed = true;
          return {
            tenantId: "tenant-one",
            objectId: "object-one",
            projectId: "project-one",
            contentId: "content-one",
            title: request.title,
            versionRef: "2",
            receiptId: request.commandId,
            eventId: request.commandId,
            expectedCatalogRevision: 1,
          };
        },
        markDirectoryProjected: async () => {},
      },
    },
  } as unknown as PlatformAgentDomain);
  const route = {
    context_id: "context-one",
    job_id: "job-one",
    tool_call_id: "move-one",
  } as HostInvocation;
  const scope = {
    platform: true,
    projectId: "project-one",
    inputId: "input-one",
  } as ToolScope;
  const scriptId = "production-one";
  const expectedContentId = contentIdForAppObject(
    "tenant-one",
    "studio-one",
    scriptId,
  );
  const moved = (await tools.call(route, scope, {
    action: "organize-content",
    content: { kind: "script", id: scriptId },
    revision: 3,
    metadata: { projectId: "project-two" },
  } as AgentToolArguments)) as { contentId: string; catalogRevision: number };
  assert.equal(moved.contentId, expectedContentId);
  assert.equal(moved.catalogRevision, 4);
  assert.deepEqual(moves, [
    {
      commandId: (moves[0] as { commandId: string }).commandId,
      contentId: expectedContentId,
      targetProjectId: "project-two",
      expectedRevision: 3,
    },
  ]);
  await tools.call({ ...route, tool_call_id: "create-one" }, scope, {
    action: "organize-content",
    content: { kind: "artifact", id: "content-one" },
    revision: 1,
    metadata: { newProjectTitle: "新项目" },
  } as AgentToolArguments);
  assert.deepEqual(creations, [
    {
      commandId: (creations[0] as { commandId: string }).commandId,
      projectId: (creations[0] as { projectId: string }).projectId,
      title: "新项目",
      contentId: "content-one",
      expectedRevision: 1,
    },
  ]);
  const renamedResult = (await tools.call(route, scope, {
    action: "organize-content",
    content: { kind: "artifact", id: "content-one" },
    revision: 1,
    metadata: { title: "改名" },
  } as AgentToolArguments)) as {
    ok: boolean;
    contentId: string;
    catalogRevision: number;
  };
  assert.equal(renamedResult.ok, true);
  assert.equal(renamedResult.contentId, "content-one");
  assert.equal(renamedResult.catalogRevision, 2);
  assert.equal(renames.length, 1);
  assert.equal(moves.length, 1);
  assert.equal(creations.length, 1);
  await assert.rejects(
    tools.call({ ...route, tool_call_id: "mixed-change" }, scope, {
      action: "organize-content",
      content: { kind: "artifact", id: "content-one" },
      revision: 2,
      metadata: { title: "再改名", projectId: "project-two" },
    } as AgentToolArguments),
    /一次只能修改名称或所属项目/,
  );
  assert.equal(renames.length, 1);
  assert.equal(moves.length, 1);
  assert.equal(creations.length, 1);
});

test("Agent 阅读经已认证的 Platform 范围进入与 UI 相同的 Reader 领域服务", async () => {
  const calls: unknown[] = [];
  const catalogQueries: unknown[] = [];
  const tools = new PlatformAgentTools({
    authority: {
      withInvocation: async (
        _route: unknown,
        action: (
          actor: unknown,
          source: unknown,
          identity: unknown,
        ) => Promise<unknown>,
      ) =>
        action(
          { credential: "verified-agent" },
          { projectId: "reader-project", inputId: "input-one" },
          {
            principalId: "human",
            humanActantId: "human-actant",
            agentActantId: "agent-actant",
          },
        ),
    },
    work: {
      listContent: async (_actor: unknown, query: unknown) => {
        catalogQueries.push(query);
        return [
          {
            id: "content-one",
            projectId: "reader-project",
            appId: "morphz.objects",
            kind: "document",
            title: "正文",
            availability: "available",
            observedVersionRef: "2",
            updatedAt: "2026-09-27T00:00:00.000Z",
          },
        ];
      },
    },
    content: {
      platform: {
        content: async () => ({
          project_id: "reader-project",
          availability: "available",
          observed_version_ref: "2",
        }),
      },
    },
    reader: {
      contents: async (...args: unknown[]) => {
        calls.push(["contents", ...args]);
        return [{ id: "section-1", title: "第一章", characters: 3 }];
      },
      readSlice: async (...args: unknown[]) => {
        calls.push(["read", ...args]);
        return {
          title: "第一章",
          sourceLocatorId: "content-one@2",
          text: "原文",
          totalCharacters: 3,
        };
      },
      command: async (...args: unknown[]) => {
        calls.push(["command", ...args]);
        return { id: "mark-one", revision: 2 };
      },
    },
  } as unknown as PlatformAgentDomain);
  const route = {
    context_id: "context-one",
    job_id: "job-one",
    tool_call_id: "reader-one",
  } as HostInvocation;
  const scope = {
    platform: true,
    projectId: "reader-project",
    inputId: "input-one",
  } as ToolScope;
  const catalog = (await tools.call(route, scope, {
    action: "reader",
    reader: { action: "catalog", offset: 0, limit: 20 },
  } as AgentToolArguments)) as { books: Array<{ artifactId: string }> };
  assert.deepEqual(
    catalog.books.map((book) => book.artifactId),
    ["content-one"],
  );
  assert.deepEqual(catalogQueries, [
    {
      projectId: "reader-project",
      appIds: ["morphz.objects", "morphz.reader"],
      kinds: ["document", "publication"],
      availability: "available",
      limit: 100,
    },
  ]);
  const read = (await tools.call(route, scope, {
    action: "reader",
    reader: {
      action: "read",
      artifactId: "content-one",
      revision: 2,
      sectionId: "section-1",
      offset: 0,
      limit: 2,
    },
  } as AgentToolArguments)) as { text: string; location: { sourceId: string } };
  assert.equal(read.text, "原文");
  assert.equal(read.location.sourceId, "content-one@2");
  const marked = (await tools.call(route, scope, {
    action: "reader",
    reader: {
      action: "mark-remove",
      artifactId: "content-one",
      artifactRevision: 2,
      markId: "mark-one",
      expectedRevision: 1,
    },
  } as AgentToolArguments)) as { receipt: { entityId: string } };
  assert.equal(marked.receipt.entityId, "mark-one");
  const command = (calls.at(-1) as unknown[])[2] as {
    commandId: string;
    contentId: string;
    revision: number;
    command: unknown;
  };
  assert.match(command.commandId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(command, {
    commandId: command.commandId,
    contentId: "content-one",
    revision: 2,
    command: { action: "mark-remove", markId: "mark-one", expectedRevision: 1 },
  });
  await tools.call({ ...route, tool_call_id: "reader-add" }, scope, {
    action: "reader",
    reader: {
      action: "mark-add",
      artifactId: "content-one",
      artifactRevision: 2,
      location: {
        sourceId: "content-one@2",
        sectionId: "section-1",
        start: 0,
        end: 2,
      },
      quote: "原文",
      kind: "highlight",
      color: "yellow",
      note: "",
    },
  } as AgentToolArguments);
  assert.equal(
    ((calls.at(-1) as unknown[])[2] as { command: { artifactId: string } })
      .command.artifactId,
    "content-one",
  );
  await assert.rejects(
    tools.call(
      route,
      {
        ...scope,
        projectId: "other-project",
      },
      {
        action: "reader",
        reader: { action: "contents", artifactId: "content-one", revision: 2 },
      } as AgentToolArguments,
    ),
    /当前输入/,
  );
});

test("Agent OCR 后台步骤重新核验真实输入，不能沿用首次调用的临时身份", async () => {
  let inputId = "input-one";
  let checks = 0;
  let operationRan = false;
  const tools = new PlatformAgentTools({
    authority: {
      withInvocation: async (
        _route: unknown,
        action: (
          actor: unknown,
          source: unknown,
          identity: unknown,
        ) => Promise<unknown>,
      ) => {
        checks++;
        return action(
          { credential: `verified-agent-${checks}` },
          { projectId: "reader-project", inputId },
          {
            principalId: "human",
            humanActantId: "human-actant",
            agentActantId: "agent-actant",
          },
        );
      },
    },
    content: {
      platform: {
        content: async () => ({
          project_id: "reader-project",
          availability: "available",
          app_id: "morphz.reader",
          kind: "publication",
        }),
      },
    },
    reader: {},
    readerOcr: {
      callPlatform: async (
        _request: unknown,
        _actor: unknown,
        _reader: unknown,
        reauthorize: (
          operation: (actor: unknown) => Promise<unknown>,
        ) => Promise<unknown>,
      ) => {
        inputId = "another-input";
        await reauthorize(async () => {
          operationRan = true;
        });
      },
    },
  } as unknown as PlatformAgentDomain);
  const route = {
    context_id: "context-one",
    job_id: "job-one",
    tool_call_id: "reader-ocr",
  } as HostInvocation;
  const scope = {
    platform: true,
    projectId: "reader-project",
    inputId: "input-one",
  } as ToolScope;
  await assert.rejects(
    tools.call(route, scope, {
      action: "reader",
      reader: {
        action: "ocr",
        request: {
          operation: "status",
          artifactId: "book-one",
          revision: 1,
          page: 1,
        },
      },
    } as AgentToolArguments),
    /OCR 作业来源已变化/,
  );
  assert.equal(checks, 2);
  assert.equal(operationRan, false);
});
