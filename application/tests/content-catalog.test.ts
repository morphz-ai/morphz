import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { AgentTools } from "../packages/application/src/agent-tools.js";
import { localAccess, type Operation } from "../packages/core/src/model.js";
import {
  compareContent,
  contentOrigin,
  relatedContentTasks,
} from "../apps/web/src/content-catalog.js";
const agent = { principalId: "morphz-service", actantId: "morphz-agent" };
const run = (s: WorkspaceStore, operation: Operation, access = localAccess) =>
  s.execute({ commandId: randomUUID(), operation }, access).entityId;
const doc = (s: WorkspaceStore, projectId = "first-project", access = agent) =>
  run(
    s,
    {
      type: "create-artifact",
      projectId,
      title: "原始名称",
      content: { kind: "document", markdown: "唯一正文词 合成资料" },
    },
    access,
  );

test("内容整理同一对象：CAS、幂等、可撤销归属，正文/旧版本/输入不改写，索引沿用来源", () => {
  const s = new WorkspaceStore(":memory:");
  try {
    const source = s.snapshot().projects.find((p) => p.kind === "dialogue")!;
    const id = doc(s, source.id),
      before = s.snapshot();
    const original = before.artifacts.find((a) => a.id === id)!;
    const operation = {
      type: "organize-content" as const,
      artifactId: id,
      expectedRevision: 1,
      changes: { title: "改名但不是新文件", projectId: "first-project" },
    };
    const command = { commandId: randomUUID(), operation };
    const receipt = s.execute(command, localAccess);
    assert.deepEqual(s.execute(command, localAccess), receipt);
    const renamed = s.snapshot().artifacts.find((a) => a.id === id)!;
    assert.deepEqual(renamed.content, original.content);
    assert.deepEqual(renamed.createdBy, original.createdBy);
    assert.deepEqual(renamed.versions[0], original.versions[0]);
    assert.equal(renamed.originProjectId, source.id);
    assert.equal(renamed.revision, 2);
    assert.equal(
      s.search({ query: "唯一正文词" }, localAccess).hits[0]?.revision,
      2,
    );
    assert.throws(() => run(s, operation), /已变化/);
    run(s, {
      ...operation,
      expectedRevision: 2,
      changes: { title: original.title, projectId: source.id },
    });
    assert.equal(
      s.snapshot().artifacts.find((a) => a.id === id)?.projectId,
      source.id,
    );
    assert.deepEqual(s.snapshot().inputs, before.inputs);
    assert.equal(s.snapshot().artifacts.length, before.artifacts.length);
    const imported = run(s, {
      type: "import-document",
      projectId: "first-project",
      relativePath: "外部.md",
      text: "外部不索引",
    });
    run(s, {
      ...operation,
      artifactId: imported,
      changes: { title: "仍是外部副本" },
    });
    assert.equal(s.search({ query: "外部不索引" }, localAccess).total, 0);
    assert.equal(contentOrigin(renamed, s.snapshot().actants), "Morphz生成");
  } finally {
    s.close();
  }
});

test("整理不越过成员与对象关联边界，失败不改写；目录不猜测事项关系", () => {
  const s = new WorkspaceStore(":memory:");
  try {
    const id = doc(s),
      other = run(s, { type: "create-project", title: "相同成员" });
    const op = {
      type: "organize-content" as const,
      artifactId: id,
      expectedRevision: 1,
      changes: { projectId: other },
    };
    s.provisionMembers([
      {
        principalId: "other",
        actantId: "other-human",
        name: "Other",
        enabled: true,
        projectIds: [other],
      },
    ]);
    const before = s.snapshot();
    assert.throws(() => run(s, op), /成员不同/);
    assert.deepEqual(s.snapshot(), before);
    assert.throws(
      () => run(s, op, { principalId: "other", actantId: "other-human" }),
      /访问|权限|成员/,
    );
    const related = doc(s);
    run(s, {
      type: "link-artifacts",
      fromId: id,
      toId: related,
      relation: "references",
    });
    const desk = s.snapshot().projects.find((p) => p.kind === "desk")!;
    assert.throws(
      () => run(s, { ...op, changes: { projectId: desk.id } }),
      /关联/,
    );
    run(s, { ...op, changes: { title: "有关联仍可重命名" } });
    assert.equal(
      relatedContentTasks(
        s.snapshot().artifacts.find((a) => a.id === id)!,
        s.snapshot().artifacts,
        s.snapshot().relations,
      ).length,
      0,
    );
  } finally {
    s.close();
  }
});

test("Agent 与 Human 共用内容整理命令、稳定回执和排序；工具不能扩大项目授权", () => {
  const s = new WorkspaceStore(":memory:");
  try {
    const id = doc(s),
      tools = new AgentTools(s, "token", () => ({
        projectId: "first-project",
        access: agent,
      }));
    const envelope = (args: unknown) => ({
      protocol: 1,
      tool: "host_morphz_work",
      invocation: {
        job_id: randomUUID(),
        tool_call_id: "call",
        session_id: "session",
        context_id: "context",
        principal_id: "principal",
        agent_id: "agent",
        target_id: "local",
        thread_id: "thread",
      },
      arguments: args,
    });
    const command = envelope({
      action: "organize-content",
      artifactId: id,
      revision: 1,
      metadata: { title: "Agent 改名" },
    });
    const receipt = tools.call(command);
    assert.deepEqual(tools.call(command), receipt);
    assert.equal(s.snapshot().artifacts.find((a) => a.id === id)?.revision, 2);
    assert.throws(
      () =>
        tools.call(
          envelope({
            action: "organize-content",
            artifactId: id,
            revision: 2,
            metadata: { projectId: "local-desk" },
          }),
        ),
      /跨项目/,
    );
    assert.throws(
      () =>
        tools.call(
          envelope({
            action: "organize-content",
            artifactId: id,
            revision: 1,
            metadata: { title: "冲突" },
          }),
        ),
      /已变化/,
    );
    const result = tools.call(
      envelope({ action: "list", contentOnly: true, sort: "title", limit: 50 }),
    ) as {
      artifacts: {
        artifactId: string;
        title: string;
        kind: string;
        createdBy: string;
      }[];
    };
    assert.ok(result.artifacts.every((a) => a.kind !== "task"));
    assert.equal(
      result.artifacts.find((a) => a.artifactId === id)?.createdBy,
      "Morphz",
    );
    const actual = s
      .snapshot()
      .artifacts.filter(
        (a) => a.projectId === "first-project" && a.content.kind !== "task",
      )
      .sort((a, b) => compareContent("title", a, b));
    assert.deepEqual(
      result.artifacts.map((a) => a.artifactId),
      actual.map((a) => a.id),
    );
  } finally {
    s.close();
  }
});
