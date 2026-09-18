import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  applyCommand,
  commandSchema,
  initialWorkspace,
  localAccess,
  inboxFor,
  type Command,
  type Operation,
  type TaskContent,
} from "../packages/core/src/model.js";
const command = (operation: Operation): Command => ({
  commandId: randomUUID(),
  operation,
});
const doc = (title = "文章"): Operation => ({
  type: "create-artifact",
  projectId: "first-project",
  title,
  content: { kind: "document", markdown: "原文内容\n\n第二段" },
});
const task: TaskContent = {
  kind: "task",
  description: "确认文章",
  assigneeId: "local-human",
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
};
test("对象修订保留不可变历史；旧修订不覆盖新内容", () => {
  const first = applyCommand(initialWorkspace(), command(doc()), localAccess),
    id = first.receipt.entityId;
  const operation: Operation = {
    type: "revise-artifact",
    artifactId: id,
    expectedRevision: 1,
    title: "新标题",
    content: { kind: "document", markdown: "新内容" },
  };
  const second = applyCommand(first.state, command(operation), localAccess);
  assert.equal(second.state.artifacts[0]!.revision, 2);
  assert.equal(second.state.artifacts[0]!.versions[0]!.title, "文章");
  assert.equal(first.state.artifacts[0]!.revision, 1);
  assert.throws(
    () => applyCommand(second.state, command(operation), localAccess),
    /已有新版本/,
  );
});
test("批注锚定历史版本，并拒绝不存在的引文", () => {
  const first = applyCommand(initialWorkspace(), command(doc()), localAccess),
    id = first.receipt.entityId;
  const second = applyCommand(
    first.state,
    command({
      type: "revise-artifact",
      artifactId: id,
      expectedRevision: 1,
      title: "文章",
      content: { kind: "document", markdown: "完全替换" },
    }),
    localAccess,
  );
  const annotation: Operation = {
    type: "annotate",
    artifactId: id,
    artifactRevision: 1,
    quote: "原文内容",
    body: "保留这个判断",
  };
  const third = applyCommand(second.state, command(annotation), localAccess);
  assert.equal(third.state.annotations[0]!.artifactRevision, 1);
  assert.throws(
    () =>
      applyCommand(
        second.state,
        command({ ...annotation, artifactRevision: 2 }),
        localAccess,
      ),
    /原文或版本无效/,
  );
});
test("Human 与 Agent 走同一命令边界；身份不是可伪造的命令字段", () => {
  const state = initialWorkspace(),
    agent = { principalId: "morphz-service", actantId: "morphz-agent" };
  const result = applyCommand(state, command(doc()), agent);
  assert.deepEqual(result.state.artifacts[0]!.createdBy, agent);
  assert.throws(
    () =>
      applyCommand(state, command(doc()), {
        principalId: "local-owner",
        actantId: "morphz-agent",
      }),
    /不匹配/,
  );
  assert.equal(
    commandSchema.safeParse({
      ...command(doc()),
      principalId: "morphz-service",
    }).success,
    false,
  );
  state.projects[0]!.members = ["local-owner"];
  assert.throws(() => applyCommand(state, command(doc()), agent), /没有访问/);
});
test("Inbox 从负责人投影，不复制任务；改模型不改身份", () => {
  const first = applyCommand(
    initialWorkspace(),
    command({
      type: "create-artifact",
      projectId: "first-project",
      title: "检查",
      content: task,
    }),
    localAccess,
  );
  assert.equal(inboxFor(first.state, "local-owner").length, 1);
  const second = applyCommand(
    first.state,
    command({
      type: "revise-artifact",
      artifactId: first.receipt.entityId,
      expectedRevision: 1,
      title: "检查",
      content: { ...task, assigneeId: "morphz-agent", model: "example-model" },
    }),
    localAccess,
  );
  assert.equal(inboxFor(second.state, "local-owner").length, 0);
  assert.equal(
    inboxFor(second.state, "morphz-service")[0]!.id,
    first.receipt.entityId,
  );
  assert.throws(
    () =>
      applyCommand(
        initialWorkspace(),
        command({
          type: "create-artifact",
          projectId: "first-project",
          title: "错误",
          content: { ...task, model: "not-for-humans" },
        }),
        localAccess,
      ),
    /人工事项/,
  );
});
test("事项优先级和截止时间都参与 Inbox 排序", () => {
  let state = initialWorkspace();
  for (const [title, priority, dueDate] of [
    ["低", "low", "2026-09-07"],
    ["较晚", "high", "2026-09-10"],
    ["较早", "high", "2026-09-08"],
  ] as const)
    state = applyCommand(
      state,
      command({
        type: "create-artifact",
        projectId: "first-project",
        title,
        content: { ...task, priority, dueDate },
      }),
      localAccess,
    ).state;
  assert.deepEqual(
    inboxFor(state, "local-owner").map((a) => a.title),
    ["较早", "较晚", "低"],
  );
});
test("关联引用真实对象且不能跨未授权项目；交付需有效产物", () => {
  let first = applyCommand(initialWorkspace(), command(doc()), localAccess),
    second = applyCommand(first.state, command(doc("图片说明")), localAccess);
  const operation: Operation = {
    type: "link-artifacts",
    fromId: first.receipt.entityId,
    toId: second.receipt.entityId,
    relation: "references",
  };
  const linked = applyCommand(second.state, command(operation), localAccess);
  assert.equal(linked.state.relations.length, 1);
  assert.equal(
    applyCommand(linked.state, command(operation), localAccess).state.relations
      .length,
    1,
  );
  assert.throws(
    () =>
      applyCommand(
        second.state,
        command({ ...operation, toId: operation.fromId }),
        localAccess,
      ),
    /另一个对象/,
  );
  assert.throws(
    () =>
      applyCommand(
        second.state,
        command({
          type: "create-artifact",
          projectId: "first-project",
          title: "交付",
          content: { ...task, delivery: "ready" },
        }),
        localAccess,
      ),
    /需要关联产物/,
  );
});
test("输入保存对象版本而不是假报 Agent 执行，且拒绝跨项目关联", () => {
  const first = applyCommand(initialWorkspace(), command(doc()), localAccess);
  const op: Operation = {
    type: "record-input",
    projectId: "first-project",
    artifactId: first.receipt.entityId,
    artifactRevision: 1,
    selection: "原文内容",
    body: "继续",
    targetActantId: "morphz-agent",
  };
  const result = applyCommand(first.state, command(op), localAccess);
  assert.equal(result.state.inputs[0]!.status, "recorded");
  assert.equal(result.state.inputs[0]!.artifactRevision, 1);
  assert.throws(
    () =>
      applyCommand(
        first.state,
        command({ ...op, artifactRevision: 99 }),
        localAccess,
      ),
    /有效的对象版本/,
  );
  assert.equal(
    commandSchema.safeParse(command({ ...op, body: "  " })).success,
    false,
  );
});
