import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  artifactSchema,
  initialWorkspace,
  taskContentSchema,
} from "../packages/core/src/model.js";
import {
  taskPresentation,
  taskRunBusy,
  taskRuntimeSchema,
} from "../packages/core/src/task-runtime.js";
import { TaskRunPanel } from "../apps/web/src/TaskRunPanel.js";
import type { WorkspaceClient } from "../apps/web/src/client.js";
import {
  retainTaskRuntimeProjections,
  taskRuntimeResponseStillCurrent,
} from "../apps/web/src/task-runtime-projection.js";

const content = taskContentSchema.parse({
  kind: "task",
  description: "",
  assigneeId: "morphz-agent",
  model: null,
  dueDate: null,
  assignment: "accepted",
  execution: "active",
  delivery: "none",
  resultIds: [],
  runRequested: 1,
});
const task = artifactSchema.parse({
  id: "task",
  projectId: "project",
  title: "TEST 执行摘要",
  revision: 1,
  content,
  createdBy: { principalId: "human", actantId: "human" },
  createdAt: "2026-09-30T00:00:00.000Z",
  updatedAt: "2026-09-30T00:00:00.000Z",
  versions: [
    {
      revision: 1,
      projectId: "project",
      title: "TEST 执行摘要",
      content,
      author: { principalId: "human", actantId: "human" },
      createdAt: "2026-09-30T00:00:00.000Z",
    },
  ],
  source: null,
});
const view = taskRuntimeSchema.parse({
  approvalCount: 1,
  runs: [
    {
      run: 1,
      artifactRevision: 1,
      controlRevision: 1,
      threadState: "open",
      record: {
        revision: 1,
        thread_id: "thread",
        status: "dispatched",
        interval_seconds: null,
      },
    },
  ],
});
const origin = {
  centerId: "center",
  principalId: "human",
  actantId: "human",
  csrfToken: "identity-generation",
  workspace: { artifacts: [task] },
  taskRuns: { task: view },
};

test("重新读取目录仍保留同一身份、事项版本和执行的只读摘要", () => {
  const next = structuredClone(origin);
  assert.deepEqual(retainTaskRuntimeProjections(origin, next), { task: view });
  assert.equal(taskRuntimeResponseStillCurrent(origin, next, task.id), true);
  assert.deepEqual(origin.taskRuns, { task: view });
});

test("切换中心、Human、Actant 或身份代次后不复用执行摘要", () => {
  for (const key of [
    "centerId",
    "principalId",
    "actantId",
    "csrfToken",
  ] as const) {
    const next = { ...origin, [key]: "other" };
    assert.deepEqual(retainTaskRuntimeProjections(origin, next), {});
    assert.equal(taskRuntimeResponseStillCurrent(origin, next, task.id), false);
  }
});

test("事项移项目、修改版本、重执行或改负责人会清除摘要及迟到响应", () => {
  for (const changed of [
    { ...task, projectId: "other-project" },
    { ...task, revision: 2 },
    { ...task, content: { ...content, runRequested: 2 } },
    { ...task, content: { ...content, assigneeId: "other" } },
  ]) {
    const next = { ...origin, workspace: { artifacts: [changed] } };
    assert.deepEqual(retainTaskRuntimeProjections(origin, next), {});
    assert.equal(taskRuntimeResponseStillCurrent(origin, next, task.id), false);
  }
});

test("事项离开授权投影或身份已注销时，旧执行摘要不可显示", () => {
  const next = { ...origin, workspace: { artifacts: [] } };
  assert.deepEqual(retainTaskRuntimeProjections(origin, next), {});
  assert.deepEqual(retainTaskRuntimeProjections(null, origin), {});
  assert.equal(taskRuntimeResponseStillCurrent(origin, next, task.id), false);
  assert.equal(taskRuntimeResponseStillCurrent(origin, null, task.id), false);
});

test("正式事项面板与核心投影统一显示停止待确认，终态观测不能替代停止回执", () => {
  // Renderer-only projection: the persisted stop/retry/CAS lifecycle is tested
  // by task-arrangement and the real Platform task-run tests, not this DTO.
  const state = initialWorkspace();
  state.artifacts = [task];
  for (const lifecycle of ["open", "completed", "cancelled"] as const) {
    const stopping = taskRuntimeSchema.parse({
      ...view,
      runs: [
        {
          ...view.runs[0]!,
          stopRequested: true,
          threadState: lifecycle,
        },
      ],
    });
    const presentation = taskPresentation(content, false, stopping);
    assert.deepEqual(presentation, {
      state: "active",
      label: "停止待确认",
      reason: "已请求停止，等待执行结果确认。",
    });
    assert.equal(taskRunBusy(content, stopping), true);
    const html = renderToStaticMarkup(
      createElement(TaskRunPanel, {
        artifact: task,
        state,
        client: {
          online: true,
          boot: {
            taskRuns: { [task.id]: stopping },
            capabilities: { runtime: true },
            runtime: { activity: { threads: [] } },
          },
        } as unknown as WorkspaceClient,
        runtimeObserved: true,
        onRespond() {},
      }),
    );
    assert.match(html, /<button disabled="">停止待确认<\/button>/);
    assert.ok(html.includes(presentation.reason));
    assert.doesNotMatch(html, /正在停止|已停止|已完成|重新执行|重试/);
  }
});
