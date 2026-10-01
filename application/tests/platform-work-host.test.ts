import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEmbeddedApplication } from "../apps/desktop/application-host.js";
import { createAppServer } from "../apps/service/src/http.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import { backupCenterStorage } from "../packages/application/src/center-backup.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { applicationTokenHeader } from "../packages/core/src/application-names.js";
import { localAccess, morphzAgentAccess } from "../packages/core/src/model.js";
import { Pool } from "pg";
import { PlatformClient } from "../apps/web/src/platform-client.js";
import { executePlatformOperation, type Boot } from "../apps/web/src/client.js";
import { emptyScriptDraft } from "../packages/core/src/script-studio.js";
import { assertNoLegacyBusinessTables } from "./host-transport-invariant.js";
import {
  PlatformStore,
  type PlatformAuthorityVerifier,
} from "../packages/platform/src/store.js";

test("Desktop 检查器通过正式项目接口读取公开理解，重启后保持版本", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-understanding-host-"));
  const profile = join(directory, "profile");
  mkdirSync(profile);
  let host: Awaited<ReturnType<typeof openEmbeddedApplication>> | undefined;
  try {
    host = await openEmbeddedApplication(directory, profile);
    const client = await PlatformClient.connect(host.connection);
    const projectId = `project_${randomUUID().replaceAll("-", "")}`;
    await client.createProject("公开理解测试项目", randomUUID(), projectId);
    assert.equal(await client.projectUnderstanding(projectId), null);
    const project = await client.project(projectId);
    const agentPrincipalId = project.memberPrincipalIds.find(
      (principalId) => principalId !== client.boot.principalId,
    );
    assert.ok(agentPrincipalId, "项目必须包含其真实 Morphz Agent 成员");
    const verifier: PlatformAuthorityVerifier = {
      resolveActor: async ({ credential }) =>
        credential === "test-agent"
          ? {
              tenantId: client.boot.centerId,
              principalId: client.boot.principalId,
              actantId: "test-agent-actant",
              kind: "agent" as const,
              runtimeInputId: "test-input",
              initiatingHumanActantId: client.boot.actantId,
              scopeProjectId: projectId,
            }
          : null,
      resolveActant: async ({ actantId }) =>
        actantId === "test-agent-actant"
          ? { principalId: agentPrincipalId, kind: "agent" as const }
          : null,
      resolveProjectAgent: async () => null,
      verifyApplicationObject: async () => false,
    };
    const fixture = await PlatformStore.sqlite(
      join(directory, "platform.sqlite"),
      verifier,
    );
    try {
      await fixture.publishProjectUnderstanding(
        { credential: "test-agent" },
        {
          commandId: "test-published-understanding",
          projectId,
          expectedRevision: 0,
          frameId: `mw-public-${projectId}`,
          frameRevision: 1,
          mindVersion: 1,
          body: "这是正式项目公开视图。",
          sources: [],
        },
      );
    } finally {
      await fixture.close();
    }
    const published = await client.projectUnderstanding(projectId);
    assert.equal(published?.body, "这是正式项目公开视图。");
    assert.equal(published?.revision, 1);
    await host.close();
    host = undefined;
    host = await openEmbeddedApplication(directory, profile);
    const recovered = await PlatformClient.connect(host.connection);
    assert.deepEqual(
      await recovered.projectUnderstanding(projectId),
      published,
    );
  } finally {
    await host?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Desktop 应用窗口通过 Platform 保存，重启可恢复且不写旧 workspace", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-app-view-host-"));
  const profile = join(directory, "profile");
  mkdirSync(profile);
  let host: Awaited<ReturnType<typeof openEmbeddedApplication>> | undefined;
  try {
    host = await openEmbeddedApplication(directory, profile);
    const client = await PlatformClient.connect(host.connection);
    const projectId = `project_${randomUUID().replaceAll("-", "")}`;
    await client.createProject("窗口测试项目", randomUUID(), projectId);
    const commandId = randomUUID();
    const opened = await client.launchAppView({
      commandId,
      projectId,
      appId: "morphz.reader",
      packageVersion: "1.0.0",
      state: { artifactId: "book-one" },
    });
    assert.equal(opened.id, commandId);
    assert.deepEqual(await client.appViews(), [opened]);
    const saved = await client.saveAppView({
      commandId: randomUUID(),
      viewId: opened.id,
      expectedRevision: opened.revision,
      state: { artifactId: "book-two" },
    });
    await host.close();
    host = undefined;
    host = await openEmbeddedApplication(directory, profile);
    const recovered = await PlatformClient.connect(host.connection);
    assert.deepEqual(await recovered.appViews(), [saved]);
    assertNoLegacyBusinessTables(join(directory, "workspace.sqlite"));
    await recovered.closeAppView({
      commandId: randomUUID(),
      viewId: opened.id,
      expectedRevision: saved.revision,
    });
    assert.deepEqual(await recovered.appViews(), []);
  } finally {
    await host?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("正式浏览器可登记只存在于 Platform 的项目，且每次交换重查授权", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-platform-browser-"));
  const profile = join(directory, "profile");
  mkdirSync(profile);
  const host = await openEmbeddedApplication(directory, profile);
  try {
    const boot = (await host.connection.call("platform.bootstrap")) as {
      csrfToken: string;
    };
    const options = { identityGeneration: boot.csrfToken };
    const retiredWorkspace = await host.connection.invoke({
      id: randomUUID(),
      method: "workspace",
    });
    assert.equal(retiredWorkspace.ok, false);
    if (!retiredWorkspace.ok) assert.equal(retiredWorkspace.error.status, 400);
    const search = (await host.connection.call(
      "search",
      { query: "旧数据" },
      options,
    )) as { total: number; hits: unknown[] };
    assert.equal(search.total, 0);
    assert.deepEqual(search.hits, []);
    const retiredObjectRead = await host.connection.invoke({
      id: randomUUID(),
      method: "artifact.read",
      params: { id: "old-object" },
      identityGeneration: boot.csrfToken,
    });
    assert.equal(retiredObjectRead.ok, false);
    if (!retiredObjectRead.ok)
      assert.equal(retiredObjectRead.error.status, 400);
    const projectId = `project_${randomUUID().replaceAll("-", "")}`;
    await host.connection.call(
      "projects.create",
      { commandId: randomUUID(), projectId, title: "仅 Platform 的浏览器项目" },
      options,
    );
    assertNoLegacyBusinessTables(join(directory, "workspace.sqlite"));
    const state = {
      pageId: randomUUID(),
      artifactId: null,
      projectId,
      epoch: randomUUID(),
      url: "https://example.com/",
      title: "测试页面",
      granted: false,
      visible: true,
    };
    const key = "a".repeat(64);
    assert.deepEqual(
      await host.connection.call(
        "browser.register",
        { key, data: state },
        options,
      ),
      { registered: true },
    );
    assert.deepEqual(
      await host.connection.call(
        "browser.exchange",
        { key, data: { state, receipts: [] } },
        options,
      ),
      { requests: [] },
    );
    await assert.rejects(
      host.connection.call(
        "browser.register",
        {
          key,
          data: {
            ...state,
            pageId: randomUUID(),
            projectId: "unknown-project",
          },
        },
        options,
      ),
      /项目不存在|无权访问/,
    );
    const document = (await host.connection.call(
      "documents.create",
      {
        commandId: randomUUID(),
        objectId: `document_${randomUUID().replaceAll("-", "")}`,
        projectId,
        title: "不可冒充网站的文档",
        markdown: "# 正文",
      },
      options,
    )) as { contentId: string };
    await assert.rejects(
      host.connection.call(
        "browser.register",
        {
          key,
          data: {
            ...state,
            pageId: randomUUID(),
            artifactId: document.contentId,
          },
        },
        options,
      ),
      /不是网站对象/,
    );
  } finally {
    await host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Desktop 的项目领域入口只写 Platform，幂等并可重启读取", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-platform-work-host-"));
  const profile = join(directory, "profile");
  mkdirSync(profile);
  let host: Awaited<ReturnType<typeof openEmbeddedApplication>> | undefined;
  try {
    host = await openEmbeddedApplication(directory, profile);
    assert.equal(existsSync(join(directory, "platform.sqlite")), true);
    const boot = (await host.connection.call("platform.bootstrap")) as {
      csrfToken: string;
    };
    const options = { identityGeneration: boot.csrfToken };
    const retiredMessage = await host.connection.invoke({
      id: randomUUID(),
      method: "message",
      params: {},
      identityGeneration: boot.csrfToken,
    });
    assert.equal(retiredMessage.ok, false);
    if (!retiredMessage.ok) assert.equal(retiredMessage.error.status, 400);
    await assert.rejects(
      host.connection.call("input.send", "legacy-input", options),
      /尚未连接 Morphz Runtime/,
    );
    const spaces = (await host.connection.call(
      "spaces.ensure",
      undefined,
      options,
    )) as { deskId: string; inboxId: string; dialogueId: string };
    assert.equal(new Set(Object.values(spaces)).size, 3);
    assert.deepEqual(
      await host.connection.call("spaces.ensure", undefined, options),
      spaces,
    );
    const request = {
      commandId: randomUUID(),
      projectId: `project_${randomUUID().replaceAll("-", "")}`,
      title: "正式项目",
    };
    assert.equal(
      await host.connection.call("projects.create", request, options),
      request.projectId,
    );
    assert.equal(
      await host.connection.call("projects.create", request, options),
      request.projectId,
    );
    const projects = (await host.connection.call(
      "projects.list",
      { status: "active" },
      options,
    )) as Array<{ id: string; revision: number; title: string }>;
    assert.equal(
      projects.find((row) => row.id === request.projectId)?.title,
      "正式项目",
    );
    assert.ok(
      Object.values(spaces).every((id) =>
        projects.some((row) => row.id === id),
      ),
    );
    const platformClient = await PlatformClient.connect(host.connection);
    const runtimeStatus = await platformClient.runtimeSnapshot();
    assert.equal(typeof runtimeStatus.configured, "boolean");
    assert.equal(Array.isArray(runtimeStatus.messages), true);
    const firstProjectPage = await platformClient.projects({
      status: "active",
      limit: 1,
    });
    assert.equal(firstProjectPage.items.length, 1);
    assert.ok(firstProjectPage.nextCursor);
    const secondProjectPage = await platformClient.projects({
      status: "active",
      limit: 1,
      after: firstProjectPage.nextCursor!,
    });
    assert.equal(secondProjectPage.items.length, 1);
    assert.notEqual(
      secondProjectPage.items[0]!.id,
      firstProjectPage.items[0]!.id,
    );
    const project = (await host.connection.call(
      "projects.get",
      { projectId: request.projectId },
      options,
    )) as { id: string; memberPrincipalIds: string[]; revision: number };
    assert.equal(project.id, request.projectId);
    assert.equal(project.revision, 1);
    assert.ok(project.memberPrincipalIds.includes(localAccess.principalId));
    const conversations = (await host.connection.call(
      "conversations.list",
      { projectId: request.projectId },
      options,
    )) as Array<{ id: string; projectId: string; kind: string }>;
    assert.deepEqual(
      conversations.map(({ id, projectId, kind }) => ({
        id,
        projectId,
        kind,
      })),
      [
        {
          id: request.projectId,
          projectId: request.projectId,
          kind: "default",
        },
      ],
    );
    assert.ok(!Object.hasOwn(conversations[0]!, "conversation_id"));
    const navigation = await platformClient.navigationConversations({
      limit: 1,
    });
    assert.equal(navigation.items.length, 1);
    assert.ok(navigation.nextCursor);
    const laterNavigation = await platformClient.navigationConversations({
      limit: 1,
      after: navigation.nextCursor!,
    });
    assert.equal(laterNavigation.items.length, 1);
    assert.notEqual(laterNavigation.items[0]!.id, navigation.items[0]!.id);
    await assert.rejects(
      host.connection.call(
        "projects.rename",
        {
          commandId: randomUUID(),
          projectId: request.projectId,
          expectedRevision: 7,
          title: "错误覆盖",
        },
        options,
      ),
      /项目已更新/,
    );
    await host.connection.call(
      "projects.rename",
      {
        commandId: randomUUID(),
        projectId: request.projectId,
        expectedRevision: 1,
        title: "已修订项目",
      },
      options,
    );
    const renamed = (await host.connection.call(
      "projects.get",
      { projectId: request.projectId },
      options,
    )) as { title: string; revision: number };
    assert.deepEqual(
      { title: renamed.title, revision: renamed.revision },
      { title: "已修订项目", revision: 2 },
    );
    await assert.rejects(
      host.connection.call(
        "projects.state",
        {
          commandId: randomUUID(),
          projectId: request.projectId,
          expectedRevision: 2,
          state: "archived",
        },
        options,
      ),
      /Runtime 暂不可用，项目没有归档或删除/,
    );
    const task = {
      commandId: randomUUID(),
      taskId: `task_${randomUUID().replaceAll("-", "")}`,
      projectId: request.projectId,
      title: "核对新存储",
      assigneeId: localAccess.actantId,
    };
    assert.equal(
      await host.connection.call("tasks.create", task, options),
      task.taskId,
    );
    assert.equal(
      await host.connection.call("tasks.create", task, options),
      task.taskId,
    );
    const tasks = (await host.connection.call(
      "tasks.list",
      { projectId: request.projectId },
      options,
    )) as Array<{ id: string; title: string }>;
    assert.deepEqual(
      tasks.map(({ id, title }) => ({ id, title })),
      [{ id: task.taskId, title: task.title }],
    );
    assert.deepEqual(
      (
        (await host.connection.call(
          "tasks.list",
          { owner: "mine", query: "核对 已修订项目" },
          options,
        )) as Array<{ id: string }>
      ).map(({ id }) => id),
      [task.taskId],
    );
    const initialVersion = (await host.connection.call(
      "tasks.version",
      { taskId: task.taskId },
      options,
    )) as { taskId: string; revision: number; title: string };
    assert.deepEqual(
      {
        taskId: initialVersion.taskId,
        revision: initialVersion.revision,
        title: initialVersion.title,
      },
      { taskId: task.taskId, revision: 1, title: task.title },
    );
    assert.ok(!Object.hasOwn(initialVersion, "legacy_priority"));
    const clientTask = await platformClient.taskVersion(task.taskId);
    assert.deepEqual(
      {
        taskId: clientTask.taskId,
        revision: clientTask.revision,
      },
      { taskId: task.taskId, revision: 1 },
    );
    const revise = {
      commandId: randomUUID(),
      taskId: task.taskId,
      expectedRevision: 1,
      title: "核对完成",
      description: "只改这一件事项",
      assignment: "accepted",
    };
    assert.equal(
      await host.connection.call("tasks.revise", revise, options),
      task.taskId,
    );
    assert.equal(
      await host.connection.call("tasks.revise", revise, options),
      task.taskId,
    );
    await assert.rejects(
      host.connection.call(
        "tasks.revise",
        { ...revise, commandId: randomUUID(), title: "过期覆盖" },
        options,
      ),
      /事项已变化/,
    );
    const revised = (await host.connection.call(
      "tasks.version",
      { taskId: task.taskId },
      options,
    )) as {
      revision: number;
      title: string;
      description: string;
      assignment: string;
    };
    assert.deepEqual(
      {
        revision: revised.revision,
        title: revised.title,
        description: revised.description,
        assignment: revised.assignment,
      },
      {
        revision: 2,
        title: "核对完成",
        description: "只改这一件事项",
        assignment: "accepted",
      },
    );
    const original = (await host.connection.call(
      "tasks.version",
      { taskId: task.taskId, revision: 1 },
      options,
    )) as { title: string };
    assert.equal(original.title, task.title);
    const latestPage = await platformClient.taskVersions(task.taskId, {
      limit: 1,
    });
    assert.deepEqual(
      latestPage.items.map((version) => version.revision),
      [2],
    );
    assert.equal(latestPage.nextCursor, 2);
    const olderPage = await platformClient.taskVersions(task.taskId, {
      limit: 1,
      beforeRevision: latestPage.nextCursor!,
    });
    assert.deepEqual(
      olderPage.items.map((version) => version.revision),
      [1],
    );
    assert.equal(olderPage.items[0]!.title, task.title);
    await assert.rejects(
      host.connection.call(
        "tasks.versions",
        { taskId: task.taskId, limit: 101 },
        options,
      ),
      /请求格式无效|事项版本查询参数无效/,
    );
    const response = {
      commandId: randomUUID(),
      taskId: task.taskId,
      expectedRevision: 2,
      body: "已经核对。",
    };
    assert.equal(
      await host.connection.call("tasks.respond", response, options),
      task.taskId,
    );
    assert.equal(
      await host.connection.call("tasks.respond", response, options),
      task.taskId,
    );
    const responses = (await host.connection.call(
      "tasks.responses",
      { taskId: task.taskId },
      options,
    )) as Array<{ id: string; taskRevision: number; body: string }>;
    assert.deepEqual(
      responses.map(({ id, taskRevision, body }) => ({
        id,
        taskRevision,
        body,
      })),
      [{ id: response.commandId, taskRevision: 2, body: response.body }],
    );
    assert.deepEqual(
      (await platformClient.taskResponses(task.taskId)).items.map(
        ({ id, taskRevision, body }) => ({ id, taskRevision, body }),
      ),
      [{ id: response.commandId, taskRevision: 2, body: response.body }],
    );
    const reopen = {
      commandId: randomUUID(),
      taskId: task.taskId,
      expectedRevision: 3,
      completed: false,
    };
    assert.equal(
      await host.connection.call("tasks.complete", reopen, options),
      task.taskId,
    );
    assert.equal(
      await host.connection.call("tasks.complete", reopen, options),
      task.taskId,
    );
    assert.equal(
      (
        (await host.connection.call(
          "tasks.version",
          { taskId: task.taskId },
          options,
        )) as { execution: string }
      ).execution,
      "planned",
    );
    const secondTask = {
      commandId: randomUUID(),
      taskId: `task_${randomUUID().replaceAll("-", "")}`,
      projectId: request.projectId,
      title: "第二项",
      assigneeId: localAccess.actantId,
    };
    await host.connection.call("tasks.create", secondTask, options);
    const order = (await host.connection.call(
      "tasks.order",
      { projectId: request.projectId },
      options,
    )) as { projectId: string; revision: number };
    assert.equal(order.projectId, request.projectId);
    const move = {
      commandId: randomUUID(),
      projectId: request.projectId,
      taskId: secondTask.taskId,
      beforeTaskId: task.taskId,
      expectedOrderRevision: order.revision,
    };
    assert.equal(
      await host.connection.call("tasks.reorder", move, options),
      secondTask.taskId,
    );
    assert.equal(
      await host.connection.call("tasks.reorder", move, options),
      secondTask.taskId,
    );
    await assert.rejects(
      host.connection.call(
        "tasks.reorder",
        { ...move, commandId: randomUUID() },
        options,
      ),
      /事项顺序已变化/,
    );
    const ordered = (await host.connection.call(
      "tasks.list",
      { projectId: request.projectId },
      options,
    )) as Array<{ id: string }>;
    assert.deepEqual(
      ordered.map((row) => row.id),
      [secondTask.taskId, task.taskId],
    );
    const document = (await host.connection.call(
      "documents.create",
      {
        commandId: randomUUID(),
        objectId: `desktop_document_${randomUUID().replaceAll("-", "")}`,
        projectId: request.projectId,
        title: "Desktop 原件",
        markdown: "持久正文",
      },
      options,
    )) as { contentId: string };
    const relationCommand = randomUUID();
    const linked = await platformClient.linkWork({
      commandId: relationCommand,
      fromId: document.contentId,
      toId: task.taskId,
      kind: "references",
    });
    assert.equal(
      await platformClient.linkWork({
        commandId: relationCommand,
        fromId: document.contentId,
        toId: task.taskId,
        kind: "references",
      }),
      linked,
    );
    assert.deepEqual(
      (await platformClient.workRelations(document.contentId)).items,
      [
        {
          id: linked,
          fromId: document.contentId,
          toId: task.taskId,
          type: "references",
        },
      ],
    );
    assert.deepEqual(
      (await platformClient.workRelations(task.taskId)).items.map(
        (row) => row.id,
      ),
      [linked],
    );
    const contentBeforeRestart = (await host.connection.call(
      "content.list",
      { projectId: request.projectId },
      options,
    )) as Array<{ id: string }>;
    assert.deepEqual(
      contentBeforeRestart.map((item) => item.id),
      [document.contentId],
    );
    await host.close();
    host = undefined;

    assertNoLegacyBusinessTables(join(directory, "workspace.sqlite"));

    host = await openEmbeddedApplication(directory, profile);
    const reopened = (await host.connection.call("platform.bootstrap")) as {
      csrfToken: string;
    };
    const restored = (await host.connection.call(
      "projects.list",
      {},
      {
        identityGeneration: reopened.csrfToken,
      },
    )) as Array<{
      id: string;
      title: string;
      revision: number;
    }>;
    assert.deepEqual(
      restored
        .filter((row) => row.id === request.projectId)
        .map(({ title, revision }) => ({ title, revision })),
      [{ title: "已修订项目", revision: 2 }],
    );
    assert.deepEqual(
      await host.connection.call("spaces.ensure", undefined, {
        identityGeneration: reopened.csrfToken,
      }),
      spaces,
    );
    const taskAfterRestart = (await host.connection.call(
      "tasks.version",
      { taskId: task.taskId },
      { identityGeneration: reopened.csrfToken },
    )) as { revision: number; execution: string };
    assert.deepEqual(
      {
        revision: taskAfterRestart.revision,
        execution: taskAfterRestart.execution,
      },
      { revision: 4, execution: "planned" },
    );
    const documentAfterRestart = (await host.connection.call(
      "documents.read",
      { contentId: document.contentId },
      { identityGeneration: reopened.csrfToken },
    )) as { title: string; markdown: string };
    assert.deepEqual(
      {
        title: documentAfterRestart.title,
        markdown: documentAfterRestart.markdown,
      },
      { title: "Desktop 原件", markdown: "持久正文" },
    );
  } finally {
    await host?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Desktop 正式事项命令持久化依赖与来源，不写旧 workspace", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-task-refs-host-"));
  const profile = join(directory, "profile");
  mkdirSync(profile);
  const host = await openEmbeddedApplication(directory, profile);
  try {
    const client = await PlatformClient.connect(host.connection);
    const projectId = `project_${randomUUID().replaceAll("-", "")}`;
    const sourceId = `task_${randomUUID().replaceAll("-", "")}`;
    const targetId = `task_${randomUUID().replaceAll("-", "")}`;
    await client.createProject("事项关联验收", randomUUID(), projectId);
    await client.createTask({
      commandId: randomUUID(),
      taskId: sourceId,
      projectId,
      title: "来源事项",
      assigneeId: localAccess.actantId,
    });
    await client.createTask({
      commandId: randomUUID(),
      taskId: targetId,
      projectId,
      title: "目标事项",
      assigneeId: localAccess.actantId,
      dependsOnIds: [sourceId],
      watchSourceIds: [sourceId],
    });
    assert.deepEqual((await client.taskVersion(targetId)).dependsOnIds, [
      sourceId,
    ]);
    await client.reviseTask({
      commandId: randomUUID(),
      taskId: targetId,
      expectedRevision: 1,
      resultIds: [sourceId],
    });
    const revised = await client.taskVersion(targetId);
    assert.deepEqual(
      [revised.dependsOnIds, revised.watchSourceIds, revised.resultIds],
      [[sourceId], [sourceId], [sourceId]],
    );
    assertNoLegacyBusinessTables(join(directory, "workspace.sqlite"));
  } finally {
    await host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Desktop 创建 Agent 事项的模型与时间在重启后仍属于首版", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-task-create-host-"));
  const profile = join(directory, "profile");
  mkdirSync(profile);
  let host: Awaited<ReturnType<typeof openEmbeddedApplication>> | undefined;
  try {
    host = await openEmbeddedApplication(directory, profile);
    const source = await PlatformClient.connect(host.connection);
    const projectId = `project_${randomUUID().replaceAll("-", "")}`;
    const taskId = `task_${randomUUID().replaceAll("-", "")}`;
    await source.createProject("安排工作", randomUUID(), projectId);
    await source.createTask({
      commandId: randomUUID(),
      taskId,
      projectId,
      title: "定时执行",
      assigneeId: morphzAgentAccess.actantId,
      modelId: "selected-model",
      reasoningEffort: "high",
      notBefore: "2026-10-02T12:00:00.000Z",
      everySeconds: 3600,
    });
    await host.close();
    host = undefined;
    host = await openEmbeddedApplication(directory, profile);
    const recovered = await PlatformClient.connect(host.connection);
    const version = await recovered.taskVersion(taskId);
    assert.deepEqual(
      [
        version.revision,
        version.modelId,
        version.reasoningEffort,
        version.notBefore,
        version.everySeconds,
      ],
      [1, "selected-model", "high", "2026-10-02T12:00:00.000Z", 3600],
    );
    assert.equal((await recovered.tasks({ projectId })).items[0]?.id, taskId);
  } finally {
    await host?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("HTTP 客户端与 Desktop 调用同一 Platform 项目操作", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-platform-work-http-"));
  const store = new WorkspaceStore(join(directory, "workspace.sqlite"));
  const domains = await openApplicationDomainsHost(directory, store);
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const server = createAppServer(store, {
    port,
    webRoot: "/nonexistent",
    platformWork: domains.work,
    platformDocuments: domains.content,
    platformScripts: domains.content,
  });
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  try {
    const client = new HttpApplicationClient(`http://127.0.0.1:${port}`);
    const boot = (await client.call("platform.bootstrap")) as {
      csrfToken: string;
    };
    const options = { identityGeneration: boot.csrfToken };
    assert.equal(
      (await fetch(`http://127.0.0.1:${port}/api/workspace`)).status,
      404,
    );
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${port}/api/commands`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: `http://127.0.0.1:${port}`,
            [applicationTokenHeader]: boot.csrfToken,
          },
          body: JSON.stringify({ commandId: randomUUID() }),
        })
      ).status,
      404,
    );
    const spaces = (await client.call("spaces.ensure", undefined, options)) as {
      deskId: string;
      inboxId: string;
      dialogueId: string;
    };
    assert.equal(new Set(Object.values(spaces)).size, 3);
    assert.deepEqual(
      await Promise.all(
        Array.from({ length: 4 }, () =>
          client.call("spaces.ensure", undefined, options),
        ),
      ),
      Array.from({ length: 4 }, () => spaces),
    );
    const request = {
      commandId: randomUUID(),
      projectId: `project_${randomUUID().replaceAll("-", "")}`,
      title: "HTTP 项目",
    };
    assert.equal(
      await client.call("projects.create", request, options),
      request.projectId,
    );
    const projectClient = await PlatformClient.connect(client);
    assert.equal(
      await projectClient.projectUnderstanding(request.projectId),
      null,
      "HTTP 入口与 Desktop 共用已授权的项目公开视图读取",
    );
    const openedView = await projectClient.launchAppView({
      commandId: randomUUID(),
      projectId: request.projectId,
      appId: "morphz.reader",
      packageVersion: "1.0.0",
      state: { artifactId: "http-book" },
    });
    assert.deepEqual(await projectClient.appViews(), [openedView]);
    const savedView = await projectClient.saveAppView({
      commandId: randomUUID(),
      viewId: openedView.id,
      expectedRevision: 1,
      state: { artifactId: "http-book-next" },
    });
    assert.deepEqual(await projectClient.appViews(), [savedView]);
    await projectClient.closeAppView({
      commandId: randomUUID(),
      viewId: openedView.id,
      expectedRevision: 2,
    });
    assert.deepEqual(await projectClient.appViews(), []);
    await assert.rejects(
      executePlatformOperation(
        projectClient,
        { workspace: { revision: 1 } } as Boot,
        {
          commandId: randomUUID(),
          operation: {
            type: "update-project",
            projectId: request.projectId,
            expectedRevision: 1,
            state: "archived",
          },
        },
        false,
      ),
      /Runtime 暂不可用，项目没有归档或删除/,
    );
    const document = {
      commandId: randomUUID(),
      objectId: `document_${randomUUID().replaceAll("-", "")}`,
      projectId: request.projectId,
      title: "HTTP 文档",
      markdown: "通过正式 Web Host 保存",
    };
    const createdDocument = (await client.call(
      "documents.create",
      document,
      options,
    )) as { contentId: string; versionRef: string };
    assert.equal(createdDocument.versionRef, "1");
    assert.equal(
      (
        (await client.call("content.get", {
          contentId: createdDocument.contentId,
        })) as { appObjectId: string }
      ).appObjectId,
      document.objectId,
    );
    assert.deepEqual(
      await client.call("documents.create", document, options),
      createdDocument,
    );
    const readDocument = (await client.call("documents.read", {
      contentId: createdDocument.contentId,
    })) as { markdown: string; revision: number };
    assert.equal(readDocument.markdown, document.markdown);
    assert.equal(readDocument.revision, 1);
    const documentRevision = (await client.call(
      "documents.revise",
      {
        commandId: randomUUID(),
        contentId: createdDocument.contentId,
        expectedRevision: 1,
        title: "HTTP 文档修订",
        markdown: "第二版",
      },
      options,
    )) as { versionRef: string };
    assert.equal(documentRevision.versionRef, "2");
    assert.equal(
      (
        (await client.call("documents.read", {
          contentId: createdDocument.contentId,
          revision: 1,
        })) as { markdown: string }
      ).markdown,
      document.markdown,
    );
    assert.deepEqual(
      (
        (await client.call("objects.versions", {
          contentId: createdDocument.contentId,
          limit: 1,
        })) as { versions: Array<{ revision: number }> }
      ).versions.map((version) => version.revision),
      [2],
    );
    const script = {
      commandId: randomUUID(),
      productionId: `script_${randomUUID().replaceAll("-", "")}`,
      projectId: request.projectId,
      title: "HTTP 剧本",
    };
    const createdScript = (await client.call(
      "scripts.create",
      script,
      options,
    )) as { contentId: string; versionRef: string };
    assert.equal(createdScript.versionRef, "1");
    assert.deepEqual(
      await client.call("scripts.create", script, options),
      createdScript,
    );
    assert.equal(
      (
        (await client.call("scripts.read", {
          contentId: createdScript.contentId,
        })) as { title: string }
      ).title,
      script.title,
    );
    assert.deepEqual(
      (
        (await client.call("scripts.items", {
          contentId: createdScript.contentId,
          parentId: null,
        })) as { items: unknown[] }
      ).items,
      [],
    );
    const { sources: _sources, ...scriptDraft } = emptyScriptDraft("第一集");
    const scriptItemRequest = {
      commandId: randomUUID(),
      contentId: createdScript.contentId,
      itemId: `episode_${randomUUID().replaceAll("-", "")}`,
      expectedActivityRevision: 1,
      kind: "episode",
      draft: { ...scriptDraft, sources: [] },
    };
    const createdItem = await client.call(
      "scripts.item.create",
      scriptItemRequest,
      options,
    );
    assert.deepEqual(
      await client.call("scripts.item.create", scriptItemRequest, options),
      createdItem,
    );
    assert.equal(
      (
        (await client.call("scripts.item", {
          contentId: createdScript.contentId,
          itemId: scriptItemRequest.itemId,
        })) as { draft: { title: string } }
      ).draft.title,
      "第一集",
    );
    const scriptSnapshot = (await client.call("scripts.snapshot", {
      contentId: createdScript.contentId,
    })) as {
      id: string;
      projectId: string;
      activityRevision: number;
      items: Array<{
        id: string;
        versions: Array<{ draft: { title: string } }>;
      }>;
    };
    assert.equal(scriptSnapshot.id, script.productionId);
    assert.equal(scriptSnapshot.projectId, request.projectId);
    assert.equal(scriptSnapshot.activityRevision, 2);
    assert.equal(scriptSnapshot.items[0]?.id, scriptItemRequest.itemId);
    assert.equal(scriptSnapshot.items[0]?.versions[0]?.draft.title, "第一集");
    const platformClient = await PlatformClient.connect(client);
    const secondItemId = randomUUID();
    const createdFromEditor = await executePlatformOperation(
      platformClient,
      {
        workspace: {
          revision: 2,
          scriptProductions: [
            {
              id: script.productionId,
              contentId: createdScript.contentId,
              activityRevision: 2,
            },
          ],
        },
      } as Boot,
      {
        commandId: secondItemId,
        operation: {
          type: "script-command",
          command: {
            action: "create-item",
            productionId: script.productionId,
            kind: "episode",
            draft: emptyScriptDraft("第二集"),
          },
        },
      },
      false,
    );
    assert.equal(createdFromEditor.entityId, secondItemId);
    assert.equal(
      (
        (await client.call("scripts.snapshot", {
          contentId: createdScript.contentId,
        })) as { activityRevision: number }
      ).activityRevision,
      3,
    );
    const editorIdentity = {
      workspace: {
        revision: 3,
        scriptProductions: [
          {
            id: script.productionId,
            contentId: createdScript.contentId,
            activityRevision: 3,
          },
        ],
      },
    } as Boot;
    const saveId = randomUUID();
    const save = {
      commandId: saveId,
      operation: {
        type: "script-command" as const,
        command: {
          action: "revise-item" as const,
          productionId: script.productionId,
          itemId: secondItemId,
          expectedRevision: 1,
          draft: { ...emptyScriptDraft("第二集"), text: "第二集正文" },
        },
      },
    };
    assert.equal(
      (
        await executePlatformOperation(
          platformClient,
          editorIdentity,
          save,
          false,
        )
      ).entityId,
      secondItemId,
    );
    assert.equal(
      (
        await executePlatformOperation(
          platformClient,
          editorIdentity,
          save,
          false,
        )
      ).entityId,
      secondItemId,
    );
    assert.equal(
      (
        (await client.call("scripts.item", {
          contentId: createdScript.contentId,
          itemId: secondItemId,
        })) as { draft: { text: string }; revision: number }
      ).draft.text,
      "第二集正文",
    );
    await assert.rejects(
      executePlatformOperation(
        platformClient,
        editorIdentity,
        {
          ...save,
          commandId: randomUUID(),
        },
        false,
      ),
      /正文已有新版本/,
    );
    assert.equal(
      (
        (await client.call("scripts.snapshot", {
          contentId: createdScript.contentId,
        })) as { activityRevision: number }
      ).activityRevision,
      4,
    );
    const list = (await client.call("projects.list", { limit: 100 })) as Array<{
      id: string;
    }>;
    assert.ok(list.some((row) => row.id === request.projectId));
    const project = (await client.call("projects.get", {
      projectId: request.projectId,
    })) as { id: string; title: string };
    assert.deepEqual(
      { id: project.id, title: project.title },
      {
        id: request.projectId,
        title: request.title,
      },
    );
    const conversations = (await client.call("conversations.list", {
      projectId: request.projectId,
    })) as Array<{ id: string; kind: string }>;
    assert.deepEqual(
      conversations.map(({ id, kind }) => ({ id, kind })),
      [{ id: request.projectId, kind: "default" }],
    );
    const renamedConversation = {
      commandId: randomUUID(),
      conversationId: request.projectId,
      expectedRevision: 1,
      title: "HTTP 对话",
    };
    assert.equal(
      await client.call("conversations.update", renamedConversation, options),
      request.projectId,
    );
    assert.equal(
      (
        (await client.call("conversations.list", {
          projectId: request.projectId,
        })) as Array<{ title: string }>
      )[0]?.title,
      "HTTP 对话",
    );
    assert.deepEqual(
      await client.call("conversations.list", {
        projectId: request.projectId,
        archived: true,
      }),
      [],
    );
    await assert.rejects(
      client.call("conversations.list", {
        projectId: request.projectId,
        archived: "sometimes",
      }),
      /布尔查询参数无效/,
    );
    await assert.rejects(
      client.call("projects.get", { projectId: "missing_project" }),
      /项目不存在/,
    );
    await assert.rejects(client.call("projects.get", {}), /项目标识无效/);
    await assert.rejects(
      client.call("conversations.list", { projectId: "../other" }),
      /项目标识无效/,
    );
    await assert.rejects(
      client.call("projects.list", {
        after: { updatedAt: "bad", projectId: request.projectId },
      }),
      /请求格式无效/,
    );
    const task = {
      commandId: randomUUID(),
      taskId: `task_${randomUUID().replaceAll("-", "")}`,
      projectId: request.projectId,
      title: "HTTP 事项",
      assigneeId: localAccess.actantId,
    };
    assert.equal(await client.call("tasks.create", task, options), task.taskId);
    const tasks = (await client.call("tasks.list", {
      projectId: request.projectId,
    })) as Array<{ id: string; updatedAt: string }>;
    assert.deepEqual(
      tasks.map((row) => row.id),
      [task.taskId],
    );
    assert.deepEqual(await client.call("tasks.counts"), [
      {
        projectId: request.projectId,
        total: 1,
        pending: 1,
        mineOpen: 1,
        latestActivityAt: tasks[0]!.updatedAt,
      },
    ]);
    assert.equal(
      (
        (await client.call("tasks.get", { taskId: task.taskId })) as {
          id: string;
        }
      ).id,
      task.taskId,
    );
    const version = (await client.call("tasks.version", {
      taskId: task.taskId,
    })) as { revision: number; title: string };
    assert.deepEqual(version.revision, 1);
    assert.equal(version.title, task.title);
    const initialVersions = (await client.call("tasks.versions", {
      taskId: task.taskId,
      limit: 1,
    })) as Array<{ revision: number }>;
    assert.deepEqual(
      initialVersions.map((entry) => entry.revision),
      [1],
    );
    await assert.rejects(
      client.call("tasks.version", { taskId: "../other" }),
      /事项标识无效/,
    );
    await assert.rejects(
      client.call("tasks.version", { taskId: task.taskId, revision: -1 }),
      /请求格式无效/,
    );
    await client.call(
      "tasks.revise",
      {
        commandId: randomUUID(),
        taskId: task.taskId,
        expectedRevision: 1,
        dueDate: "2026-09-30",
      },
      options,
    );
    const latestVersions = (await client.call("tasks.versions", {
      taskId: task.taskId,
      limit: 1,
    })) as Array<{ revision: number }>;
    assert.deepEqual(
      latestVersions.map((entry) => entry.revision),
      [2],
    );
    const olderVersions = (await client.call("tasks.versions", {
      taskId: task.taskId,
      limit: 1,
      beforeRevision: 2,
    })) as Array<{ revision: number }>;
    assert.deepEqual(
      olderVersions.map((entry) => entry.revision),
      [1],
    );
    assert.equal(
      (
        (await client.call("tasks.version", { taskId: task.taskId })) as {
          dueDate: string;
        }
      ).dueDate,
      "2026-09-30",
    );
    await client.call(
      "tasks.respond",
      {
        commandId: randomUUID(),
        taskId: task.taskId,
        expectedRevision: 2,
        body: "HTTP 回应",
      },
      options,
    );
    const responses = (await client.call("tasks.responses", {
      taskId: task.taskId,
    })) as Array<{ body: string; taskRevision: number }>;
    assert.deepEqual(
      responses.map(({ body, taskRevision }) => ({ body, taskRevision })),
      [{ body: "HTTP 回应", taskRevision: 2 }],
    );
    const order = (await client.call("tasks.order", {
      projectId: request.projectId,
    })) as { revision: number };
    assert.equal(Number.isSafeInteger(order.revision), true);
    const secondTask = {
      commandId: randomUUID(),
      taskId: `task_${randomUUID().replaceAll("-", "")}`,
      projectId: request.projectId,
      title: "HTTP 第二项",
      assigneeId: localAccess.actantId,
    };
    await client.call("tasks.create", secondTask, options);
    assert.deepEqual(
      (
        (await client.call("tasks.list", {
          owner: "mine",
          query: "HTTP 第二项",
        })) as Array<{ id: string }>
      ).map(({ id }) => id),
      [secondTask.taskId],
    );
    const currentOrder = (await client.call("tasks.order", {
      projectId: request.projectId,
    })) as { revision: number };
    await client.call(
      "tasks.reorder",
      {
        commandId: randomUUID(),
        projectId: request.projectId,
        taskId: secondTask.taskId,
        beforeTaskId: task.taskId,
        expectedOrderRevision: currentOrder.revision,
      },
      options,
    );
    assert.deepEqual(
      (
        (await client.call("tasks.list", {
          projectId: request.projectId,
        })) as Array<{ id: string }>
      ).map((row) => row.id),
      [secondTask.taskId, task.taskId],
    );
    const relationId = randomUUID();
    assert.equal(
      await client.call(
        "work.link",
        {
          commandId: relationId,
          fromId: task.taskId,
          toId: secondTask.taskId,
          kind: "uses",
        },
        options,
      ),
      relationId,
    );
    assert.deepEqual(
      await client.call("work.relations", { objectId: task.taskId, limit: 1 }),
      [
        {
          id: relationId,
          fromId: task.taskId,
          toId: secondTask.taskId,
          type: "uses",
        },
      ],
    );
    const otherProjectId = `project_${randomUUID().replaceAll("-", "")}`;
    const otherTaskId = `task_${randomUUID().replaceAll("-", "")}`;
    await client.call(
      "projects.create",
      {
        commandId: randomUUID(),
        projectId: otherProjectId,
        title: "另一个项目",
      },
      options,
    );
    await client.call(
      "tasks.create",
      {
        commandId: randomUUID(),
        taskId: otherTaskId,
        projectId: otherProjectId,
        title: "跨项目事项",
        assigneeId: localAccess.actantId,
      },
      options,
    );
    const selectionRevision = (await client.call("tasks.order", {})) as {
      revision: number;
    };
    const selection = {
      commandId: randomUUID(),
      taskIds: [task.taskId, secondTask.taskId],
      expectedOrderRevision: selectionRevision.revision,
    };
    await client.call("tasks.reorder-selection", selection, options);
    await client.call("tasks.reorder-selection", selection, options);
    assert.deepEqual(
      ((await client.call("tasks.list", {})) as Array<{ id: string }>).map(
        (row) => row.id,
      ),
      [task.taskId, secondTask.taskId, otherTaskId],
    );
    await client.call(
      "tasks.reorder-selection",
      {
        commandId: randomUUID(),
        taskIds: [secondTask.taskId, task.taskId],
        expectedOrderRevision: (
          (await client.call("tasks.order", {})) as { revision: number }
        ).revision,
      },
      options,
    );
    const boardDrag = {
      commandId: randomUUID(),
      taskIds: [secondTask.taskId, task.taskId],
      expectedOrderRevision: (
        (await client.call("tasks.order", {})) as { revision: number }
      ).revision,
      move: {
        taskId: secondTask.taskId,
        expectedRevision: 1,
        execution: "active",
      },
    };
    await client.call("tasks.reorder-selection", boardDrag, options);
    await client.call("tasks.reorder-selection", boardDrag, options);
    const movedTask = (await client.call("tasks.version", {
      taskId: secondTask.taskId,
    })) as { revision: number; execution: string };
    assert.equal(movedTask.revision, 2);
    assert.equal(movedTask.execution, "active");
    const globalOrder = (await client.call("tasks.order", {})) as {
      revision: number;
      projectId?: string;
    };
    assert.equal(globalOrder.projectId, undefined);
    await client.call(
      "tasks.reorder",
      {
        commandId: randomUUID(),
        taskId: otherTaskId,
        beforeTaskId: secondTask.taskId,
        expectedOrderRevision: globalOrder.revision,
      },
      options,
    );
    assert.deepEqual(
      ((await client.call("tasks.list", {})) as Array<{ id: string }>).map(
        (row) => row.id,
      ),
      [otherTaskId, secondTask.taskId, task.taskId],
    );
    await client.call(
      "tasks.complete",
      {
        commandId: randomUUID(),
        taskId: task.taskId,
        expectedRevision: 3,
        completed: false,
      },
      options,
    );
    assert.equal(
      (
        (await client.call("tasks.version", { taskId: task.taskId })) as {
          execution: string;
        }
      ).execution,
      "planned",
    );
    await assert.rejects(
      client.call("tasks.order", { projectId: "../other" }),
      /项目标识无效/,
    );
    const content = (await client.call("content.list", {
      projectId: request.projectId,
    })) as Array<{ id: string; title: string; observedVersionRef: string }>;
    assert.deepEqual(
      content.map(({ id, title, observedVersionRef }) => ({
        id,
        title,
        observedVersionRef,
      })),
      [
        {
          id: createdScript.contentId,
          title: script.title,
          observedVersionRef: "4",
        },
        {
          id: createdDocument.contentId,
          title: "HTTP 文档修订",
          observedVersionRef: "2",
        },
      ],
    );
    for (const sort of ["created", "title"] as const) {
      const first = await platformClient.content({
        projectId: request.projectId,
        sort,
        limit: 1,
      });
      assert.equal(first.items.length, 1);
      assert.ok(first.nextCursor);
      const second = await platformClient.content({
        projectId: request.projectId,
        sort,
        limit: 1,
        before: first.nextCursor!,
      });
      assert.deepEqual(
        new Set([...first.items, ...second.items].map(({ id }) => id)),
        new Set(content.map(({ id }) => id)),
      );
    }
    assert.deepEqual(
      (
        (await client.call("content.list", {
          projectId: request.projectId,
          appId: "morphz.script-studio",
          kind: "script",
          query: script.title,
          limit: 1,
        })) as Array<{ id: string }>
      ).map((entry) => entry.id),
      [createdScript.contentId],
    );
    assert.deepEqual(
      (
        await platformClient.content({
          projectId: request.projectId,
          appId: "morphz.script-studio",
          kind: "script",
          query: script.title,
          limit: 1,
        })
      ).items.map((entry) => entry.id),
      [createdScript.contentId],
    );
    assert.deepEqual(
      (
        await platformClient.content({
          projectId: request.projectId,
          appIds: ["morphz.objects", "morphz.script-studio"],
          kinds: ["script", "document"],
          availability: "available",
          query: script.title,
        })
      ).items.map((entry) => entry.id),
      [createdScript.contentId],
    );
    assert.deepEqual(
      (
        await platformClient.content({
          contentIds: [createdScript.contentId, "missing-content"],
        })
      ).items.map((entry) => entry.id),
      [createdScript.contentId],
    );
    const scriptUpdatedAt = (
      await platformClient.getContent(createdScript.contentId)
    ).updatedAt;
    assert.deepEqual(
      await platformClient.contentCounts({
        contentIds: [createdScript.contentId],
      }),
      [
        {
          projectId: request.projectId,
          count: 1,
          latestActivityAt: scriptUpdatedAt,
        },
      ],
    );
    assert.deepEqual(
      (
        await platformClient.content({
          appId: "morphz.script-studio",
          appObjectIds: [script.productionId],
        })
      ).items.map((entry) => entry.id),
      [createdScript.contentId],
    );
    assert.deepEqual(
      await platformClient.contentCounts({
        projectId: request.projectId,
        appId: "morphz.script-studio",
        kind: "script",
        query: script.title,
      }),
      [
        {
          projectId: request.projectId,
          count: 1,
          latestActivityAt: scriptUpdatedAt,
        },
      ],
    );
    assert.equal(
      (
        (await client.call("content.resolve", {
          appId: "morphz.script-studio",
          appObjectId: script.productionId,
        })) as { id: string }
      ).id,
      createdScript.contentId,
    );
    await assert.rejects(
      client.call("content.resolve", {
        appId: "morphz.script-studio",
        appObjectId: "missing-script",
      }),
      /不存在或无权访问/,
    );
    const moved = {
      commandId: randomUUID(),
      contentId: createdDocument.contentId,
      targetProjectId: spaces.deskId,
      expectedRevision: 2,
    };
    assert.equal(
      await client.call("content.move", moved, options),
      createdDocument.contentId,
    );
    assert.equal(
      await client.call("content.move", moved, options),
      createdDocument.contentId,
    );
    assert.equal(
      (
        (await client.call(
          "content.get",
          { contentId: createdDocument.contentId },
          options,
        )) as { projectId: string }
      ).projectId,
      spaces.deskId,
    );
    assert.equal(
      (
        (await client.call(
          "documents.read",
          { contentId: createdDocument.contentId },
          options,
        )) as { markdown: string }
      ).markdown,
      "第二版",
    );
    await assert.rejects(
      client.call(
        "content.move",
        { ...moved, commandId: randomUUID() },
        options,
      ),
      /内容已变化/,
    );
    const scriptDirectory = (await client.call(
      "content.get",
      {
        contentId: createdScript.contentId,
      },
      options,
    )) as { revision: number };
    await client.call(
      "content.move",
      {
        commandId: randomUUID(),
        contentId: createdScript.contentId,
        targetProjectId: spaces.deskId,
        expectedRevision: scriptDirectory.revision,
      },
      options,
    );
    const movedScript = (await client.call(
      "scripts.snapshot",
      {
        contentId: createdScript.contentId,
      },
      options,
    )) as { projectId: string; title: string; items: unknown[] };
    assert.equal(movedScript.projectId, spaces.deskId);
    assert.equal(movedScript.title, script.title);
    assert.equal(movedScript.items.length, 2);
    const newProject = {
      commandId: randomUUID(),
      projectId: `project_${randomUUID().replaceAll("-", "")}`,
      title: "从内容建立的项目",
      contentId: createdDocument.contentId,
      expectedRevision: 3,
    };
    assert.equal(
      await client.call("content.move-new-project", newProject, options),
      newProject.projectId,
    );
    assert.equal(
      await client.call("content.move-new-project", newProject, options),
      newProject.projectId,
    );
    assert.equal(
      (
        (await client.call(
          "content.get",
          { contentId: createdDocument.contentId },
          options,
        )) as { projectId: string }
      ).projectId,
      newProject.projectId,
    );
    assert.equal(
      (
        (await client.call(
          "documents.read",
          { contentId: createdDocument.contentId },
          options,
        )) as { markdown: string }
      ).markdown,
      "第二版",
    );
    const original = (await client.call(
      "objects.read",
      { contentId: createdDocument.contentId },
      options,
    )) as { title: string };
    assert.equal(original.title, "HTTP 文档修订");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await domains.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "Service Host 可将 Platform 放在 PostgreSQL，应用私库仍由应用保存",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const schema = `morphz_host_${randomUUID().replaceAll("-", "")}`;
    const directory = mkdtempSync(join(tmpdir(), "morphz-platform-pg-host-"));
    const workspace = new WorkspaceStore(join(directory, "workspace.sqlite"));
    let workspaceClosed = false;
    const admin = new Pool({ connectionString });
    let domains:
      Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
    let schemaCreated = false;
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      schemaCreated = true;
      const options = {
        platform: { kind: "postgres" as const, connectionString, schema },
      };
      domains = await openApplicationDomainsHost(
        directory,
        workspace,
        undefined,
        options,
      );
      const spaces = await domains.work.authority.withSession(
        localAccess,
        () => {},
        (actor) => domains!.work.service.ensurePersonalSpaces(actor),
      );
      assert.equal(new Set(Object.values(spaces)).size, 3);
      assert.equal(existsSync(join(directory, "platform.sqlite")), false);
      assert.equal(existsSync(join(directory, "objects.sqlite")), true);
      const projectId = `project_${randomUUID().replaceAll("-", "")}`;
      await domains.work.authority.withSession(
        localAccess,
        () => {},
        (actor) =>
          domains!.work.service.createProject(actor, {
            commandId: randomUUID(),
            projectId,
            title: "PostgreSQL Platform 项目",
          }),
      );
      await domains.work.authority.withSession(
        localAccess,
        () => {},
        async (actor) => {
          await assert.rejects(
            domains!.work.service.changeProjectState(actor, {
              commandId: randomUUID(),
              projectId,
              expectedRevision: 1,
              state: "archived",
            }),
            /跨 Host 的在途消息尚无法核验/,
          );
          assert.equal(
            (await domains!.work.service.getProject(actor, { projectId }))
              .revision,
            1,
          );
        },
      );
      const taskId = `task_${randomUUID().replaceAll("-", "")}`;
      const secondTaskId = `task_${randomUUID().replaceAll("-", "")}`;
      await domains.work.authority.withSession(
        localAccess,
        () => {},
        async (actor) => {
          await domains!.work.service.createTask(actor, {
            commandId: randomUUID(),
            taskId,
            projectId,
            title: "PostgreSQL 事项",
            assigneeId: localAccess.actantId,
          });
          await domains!.work.service.reviseTask(actor, {
            commandId: randomUUID(),
            taskId,
            expectedRevision: 1,
            title: "PostgreSQL 已修订事项",
          });
          await domains!.work.service.respondTask(actor, {
            commandId: randomUUID(),
            taskId,
            expectedRevision: 2,
            body: "PostgreSQL 回应",
          });
          await domains!.work.service.completeTask(actor, {
            commandId: randomUUID(),
            taskId,
            expectedRevision: 3,
            completed: false,
          });
          await domains!.work.service.createTask(actor, {
            commandId: randomUUID(),
            taskId: secondTaskId,
            projectId,
            title: "PostgreSQL 第二项",
            assigneeId: localAccess.actantId,
          });
          const order = await domains!.work.service.taskOrder(actor, {
            projectId,
          });
          await domains!.work.service.reorderTask(actor, {
            commandId: randomUUID(),
            projectId,
            taskId: secondTaskId,
            beforeTaskId: taskId,
            expectedOrderRevision: order.revision,
          });
        },
      );
      await domains.browser.authority.withSession(
        localAccess,
        () => {},
        (actor) =>
          domains!.browser.service.command(actor, {
            commandId: randomUUID(),
            operation: {
              type: "bookmark-add",
              title: "应用私库",
              url: "https://example.com/pg-host",
            },
          }),
      );
      await domains.close();
      domains = await openApplicationDomainsHost(
        directory,
        workspace,
        undefined,
        options,
      );
      assert.deepEqual(
        await domains.work.authority.withSession(
          localAccess,
          () => {},
          (actor) => domains!.work.service.ensurePersonalSpaces(actor),
        ),
        spaces,
      );
      const projects = await domains.work.authority.withSession(
        localAccess,
        () => {},
        (actor) => domains!.work.service.listProjects(actor),
      );
      assert.equal(
        projects.find((row) => row.id === projectId)?.title,
        "PostgreSQL Platform 项目",
      );
      const persistedTask = await domains.work.authority.withSession(
        localAccess,
        () => {},
        async (actor) => ({
          version: await domains!.work.service.taskVersion(actor, { taskId }),
          responses: await domains!.work.service.listTaskResponses(actor, {
            taskId,
          }),
          order: await domains!.work.service.listTasks(actor, { projectId }),
        }),
      );
      assert.deepEqual(
        {
          revision: persistedTask.version.revision,
          title: persistedTask.version.title,
          execution: persistedTask.version.execution,
          bodies: persistedTask.responses.map((row) => row.body),
          order: persistedTask.order.map((row) => row.id),
        },
        {
          revision: 4,
          title: "PostgreSQL 已修订事项",
          execution: "planned",
          bodies: ["PostgreSQL 回应"],
          order: [secondTaskId, taskId],
        },
      );
      const bookmarks = await domains.browser.authority.withSession(
        localAccess,
        () => {},
        (actor) => domains!.browser.service.list(actor),
      );
      assert.deepEqual(
        bookmarks.map((row) => row.title),
        ["应用私库"],
      );
      await domains.close();
      domains = undefined;
      workspace.close();
      workspaceClosed = true;
      await assert.rejects(
        backupCenterStorage({
          sourceDirectory: directory,
          backupDirectory: join(directory, "backups"),
          writersStopped: true,
        }),
        /不能备份 PostgreSQL/,
      );
    } finally {
      await domains?.close();
      if (!workspaceClosed) workspace.close();
      if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
