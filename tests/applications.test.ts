import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorkspaceStore } from "../apps/service/src/store.js";
import {
  localAccess,
  contentSchema,
  type Operation,
} from "../packages/core/src/model.js";
import {
  applicationManifestSchema,
  objectsApplication,
} from "../packages/core/src/applications.js";
import { workspaceFor } from "../apps/service/src/identity.js";

const app = applicationManifestSchema.parse({
  format: "morphz-work-app/v1",
  id: "test.notes",
  version: "1.0.0",
  title: "测试应用",
  description: "仅验证宿主协议",
  icon: "book",
  permissions: ["artifacts.read", "artifacts.write", "input.compose"],
  harness: { id: "test-harness", version: "1.0.0" },
  ui: { type: "sandbox", html: "<!doctype html><p>App</p>" },
});
test("应用实例和原对话随工作台原子保存为项目，重启、关闭和重开都不复制内容", () => {
  const directory = mkdtempSync(join(tmpdir(), "mw-apps-")),
    path = join(directory, "workspace.sqlite");
  let store = new WorkspaceStore(path);
  const run = (operation: Operation, applicationInstanceId?: string) =>
    store.execute(
      { commandId: randomUUID(), operation, applicationInstanceId },
      localAccess,
    ).entityId;
  try {
    const space = store.snapshot().projects.find((p) => p.kind === "desk")!;
    const object = run({
      type: "create-artifact",
      projectId: space.id,
      title: "第一章",
      content: { kind: "document", markdown: "不能丢失的正文" },
    });
    run({ type: "install-application", manifest: app });
    const first = run({
      type: "launch-application",
      workspaceId: space.id,
      applicationId: app.id,
      applicationVersion: app.version,
    });
    const second = run({
      type: "launch-application",
      workspaceId: space.id,
      applicationId: objectsApplication.id,
      applicationVersion: objectsApplication.version,
      artifactId: object,
    });
    run({
      type: "set-application-state",
      instanceId: first,
      expectedRevision: 1,
      state: { chapter: 4, panel: "outline" },
    });
    run({
      type: "record-input",
      projectId: space.id,
      artifactId: object,
      artifactRevision: 1,
      selection: "",
      body: "继续第一章",
      targetActantId: "morphz-agent",
      applicationInstanceId: first,
    });
    const before = store.snapshot();
    const save = {
      commandId: randomUUID(),
      operation: {
        type: "save-workspace-as-project" as const,
        workspaceId: space.id,
        title: "长篇小说",
      },
    };
    assert.equal(store.execute(save, localAccess).entityId, space.id);
    store.execute(save, localAccess);
    const after = store.snapshot();
    assert.deepEqual(after.artifacts, before.artifacts);
    assert.deepEqual(after.inputs, before.inputs);
    assert.deepEqual(after.applicationInstances, before.applicationInstances);
    assert.equal(after.projects.filter((p) => p.kind === "desk").length, 1);
    assert.notEqual(
      after.projects.find((p) => p.kind === "desk")!.id,
      space.id,
    );
    assert.equal(
      after.projects.find((p) => p.id === space.id)!.title,
      "长篇小说",
    );
    assert.deepEqual(after.inputs[0]!.application?.harness, app.harness);
    assert.throws(
      () => run({ ...save.operation, title: "不能再保存一次" }),
      /当前工作台/,
    );
    run({ type: "close-application", instanceId: first, expectedRevision: 2 });
    store.close();
    store = new WorkspaceStore(path);
    assert.equal(
      run({
        type: "launch-application",
        workspaceId: space.id,
        applicationId: app.id,
        applicationVersion: app.version,
      }),
      first,
    );
    assert.deepEqual(
      store.snapshot().applicationInstances.find((i) => i.id === first)!.state,
      { chapter: 4, panel: "outline" },
    );
    assert.equal(
      store.snapshot().applicationInstances.find((i) => i.id === second)!.state
        .artifactId,
      object,
    );
    assert.throws(
      () =>
        run({
          type: "set-application-state",
          instanceId: first,
          expectedRevision: 1,
          state: {},
        }),
      /状态已变化/,
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true });
  }
});

test("自定义应用写入只能在授权空间，不能代发消息、安装代码、访问其他项目或覆盖固定版本", () => {
  const store = new WorkspaceStore(":memory:");
  const run = (operation: Operation, applicationInstanceId?: string) =>
    store.execute(
      { commandId: randomUUID(), operation, applicationInstanceId },
      localAccess,
    ).entityId;
  try {
    run({ type: "install-application", manifest: app });
    const instance = run({
      type: "launch-application",
      workspaceId: "local-worktable",
      applicationId: app.id,
      applicationVersion: app.version,
    });
    const other = run({
      type: "create-artifact",
      projectId: "first-project",
      title: "其他项目",
      content: { kind: "document", markdown: "秘密" },
    });
    const create = {
      type: "create-artifact" as const,
      projectId: "local-worktable",
      title: "应用产物",
      content: { kind: "document" as const, markdown: "正文" },
    };
    const owned = run(create, instance);
    const task = contentSchema.parse({
      kind: "task",
      description: "请用户确认再开始",
      assigneeId: "morphz-agent",
      model: null,
      priority: "normal",
      dueDate: null,
      assignment: "proposed",
      execution: "planned",
      delivery: "none",
      resultIds: [],
    });
    assert.ok(task.kind === "task");
    const prepared = run({ ...create, content: task }, instance);
    assert.throws(
      () => run({ ...create, content: { ...task, runRequested: 1 } }, instance),
      /启动或更改执行安排/,
    );
    assert.throws(
      () =>
        run(
          {
            type: "revise-artifact",
            artifactId: prepared,
            expectedRevision: 1,
            title: "启动",
            content: { ...task, runRequested: 1 },
          },
          instance,
        ),
      /启动或更改执行安排/,
    );
    run({ type: "request-task-run", taskId: prepared, expectedRevision: 1 });
    assert.throws(
      () =>
        run(
          {
            type: "revise-artifact",
            artifactId: prepared,
            expectedRevision: 2,
            title: "改变任务",
            content: task,
          },
          instance,
        ),
      /启动或更改执行安排/,
    );
    assert.throws(
      () => run({ ...create, projectId: "first-project" }, instance),
      /其他工作空间/,
    );
    assert.throws(
      () =>
        run(
          {
            type: "revise-artifact",
            artifactId: other,
            expectedRevision: 1,
            title: "坏",
            content: create.content,
          },
          instance,
        ),
      /其他工作空间/,
    );
    assert.throws(
      () =>
        run(
          {
            type: "link-artifacts",
            fromId: owned,
            toId: other,
            relation: "uses",
          },
          instance,
        ),
      /其他工作空间/,
    );
    assert.throws(
      () =>
        run(
          {
            type: "record-input",
            projectId: "local-worktable",
            artifactId: null,
            artifactRevision: null,
            selection: "",
            body: "直接发给 Agent",
            targetActantId: "morphz-agent",
          },
          instance,
        ),
      /权限/,
    );
    assert.throws(
      () =>
        run({
          type: "install-application",
          manifest: { ...app, description: "篡改" },
        }),
      /已安装/,
    );
    const privateProjection = workspaceFor(store.snapshot(), {
      principalId: "stranger",
      actantId: "stranger",
    });
    assert.equal(privateProjection.applications.length, 0);
    assert.equal(privateProjection.applicationInstances.length, 0);
    run({
      type: "close-application",
      instanceId: instance,
      expectedRevision: 1,
    });
    assert.throws(() => run(create, instance), /已关闭/);
    assert.throws(
      () =>
        store.execute(
          {
            commandId: randomUUID(),
            operation: {
              type: "install-application",
              manifest: { ...app, version: "1.0.1" },
            },
          },
          { principalId: "morphz-service", actantId: "morphz-agent" },
        ),
      /仅人类/,
    );
  } finally {
    store.close();
  }
});

test("旧中心迁移一次性保留对象、旧命令和 Runtime 路由；每个 Human 有自己的事项和工作台", () => {
  const directory = mkdtempSync(join(tmpdir(), "mw-app-migration-")),
    path = join(directory, "workspace.sqlite");
  let store = new WorkspaceStore(path);
  try {
    const old = store.snapshot();
    old.projects = old.projects.filter((p) => !p.kind);
    store.saveRuntimeState({ legacy: "untouched" });
    store.close();
    const db = new DatabaseSync(path);
    const raw: Record<string, unknown> = { ...old };
    delete raw.applications;
    delete raw.applicationInstances;
    db.prepare("UPDATE workspace SET body=?").run(JSON.stringify(raw));
    db.exec("PRAGMA user_version=10");
    db.close();
    store = new WorkspaceStore(path);
    assert.equal(store.snapshot().projects.length, 3);
    assert.deepEqual(store.runtimeState(), { legacy: "untouched" });
    const ids = store.snapshot().projects.map((p) => p.id);
    store.close();
    store = new WorkspaceStore(path);
    assert.deepEqual(
      store.snapshot().projects.map((p) => p.id),
      ids,
    );
    store.provisionMembers([
      {
        principalId: "alice",
        actantId: "alice-human",
        name: "Alice",
        projectIds: ["first-project"],
        enabled: true,
      },
    ]);
    const alice = workspaceFor(store.snapshot(), {
      principalId: "alice",
      actantId: "alice-human",
    });
    assert.equal(alice.projects.filter((p) => p.kind).length, 2);
    assert.ok(
      alice.projects
        .filter((p) => p.kind)
        .every((p) => p.ownerPrincipalId === "alice"),
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true });
  }
});
