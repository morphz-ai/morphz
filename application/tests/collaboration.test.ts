import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { Collaboration } from "../apps/service/src/collaboration.js";
import {
  localAccess,
  contentSchema,
  type Operation,
  type AccessContext,
  type TaskContent,
} from "../packages/core/src/model.js";
const agent = { principalId: "morphz-service", actantId: "morphz-agent" };
const task = (overrides: Partial<TaskContent> = {}) =>
  contentSchema.parse({
    kind: "task",
    description: "安排测试",
    assigneeId: "morphz-agent",
    model: null,
    priority: "normal",
    dueDate: null,
    assignment: "accepted",
    execution: "planned",
    delivery: "none",
    resultIds: [],
    ...overrides,
  }) as TaskContent;
const execute = (
  s: WorkspaceStore,
  operation: Operation,
  access: AccessContext = localAccess,
) => s.execute({ commandId: randomUUID(), operation }, access);
const create = (s: WorkspaceStore, content: TaskContent) =>
  execute(s, {
    type: "create-artifact",
    projectId: "first-project",
    title: "事项",
    content,
  }).entityId;

test("Human 答复需要负责人身份、当前事项版本；Agent 不能替人答复，依赖不能成环", () => {
  const s = new WorkspaceStore(":memory:");
  try {
    const id = create(s, task({ assigneeId: "local-human" }));
    const op = {
      type: "respond-task" as const,
      taskId: id,
      expectedRevision: 1,
      body: "可以继续",
    };
    assert.throws(() => execute(s, op, agent), /负责人/);
    const cmd = { commandId: randomUUID(), operation: op };
    const receipt = s.execute(cmd, localAccess);
    assert.deepEqual(s.execute(cmd, localAccess), receipt);
    assert.equal(s.snapshot().taskResponses.length, 1);
    assert.throws(() => execute(s, op), /已变化/);
    const a = create(s, task()),
      b = create(s, task({ dependsOnIds: [a] }));
    assert.throws(
      () =>
        execute(s, {
          type: "revise-artifact",
          artifactId: a,
          expectedRevision: 1,
          title: "循环",
          content: task({ dependsOnIds: [b] }),
        }),
      /循环/,
    );
  } finally {
    s.close();
  }
});

test("事项映射为 Runtime 持久安排：依赖人工答复、模型隔离、丢回执重启去重、来源事件与暂停", async () => {
  const s = new WorkspaceStore(":memory:");
  const records = new Map<
      string,
      {
        id: string;
        revision: number;
        thread_id: string;
        status: string;
        not_before: string;
        interval_seconds: number | null;
      }
    >(),
    requests = new Map<string, unknown>();
  const inputs = new Set<string>();
  let lost = true,
    lifecycle = "open";
  const port = {
    session: async (_p: string, id: string) => "session-" + id,
    enqueue: (id: string) => {
      inputs.add(id);
    },
    request: async (path: string, method = "GET", raw?: unknown) => {
      const body = raw as {
        id: string;
        not_before: string;
        interval_seconds: number | null;
        action: string;
        expected_revision: number;
      };
      if (path.endsWith("/schedules") && method === "POST") {
        if (records.has(body.id)) {
          assert.deepEqual(raw, requests.get(body.id));
          return records.get(body.id);
        }
        requests.set(body.id, raw);
        records.set(body.id, {
          id: body.id,
          revision: 1,
          thread_id: "thread-" + body.id,
          status: "queued",
          not_before: body.not_before,
          interval_seconds: body.interval_seconds,
        });
        if (lost) {
          lost = false;
          throw new Error("lost acknowledgement");
        }
        return records.get(body.id);
      }
      if (path.endsWith("/thread")) {
        const id = path.split("/turns/client-schedule-")[1]!.split("/")[0]!;
        return { thread_id: "thread-" + id, lifecycle };
      }
      const record = records.get(path.split("/").at(-1)!)!;
      assert.ok(record);
      if (method === "POST") {
        assert.equal(record.revision, body.expected_revision);
        record.revision++;
        record.status = (
          { pause: "paused", resume: "queued", cancel: "cancelled" } as Record<
            string,
            string
          >
        )[body.action]!;
      }
      return structuredClone(record);
    },
  };
  try {
    const human = create(s, task({ assigneeId: "local-human" }));
    const source = execute(s, {
      type: "create-artifact",
      projectId: "first-project",
      title: "来源",
      content: { kind: "document", markdown: "一" },
    }).entityId;
    const work = create(
      s,
      task({
        runRequested: 1,
        model: "exact-model",
        reasoningEffort: "high",
        dependsOnIds: [human],
        watchSourceIds: [source],
        everySeconds: 60,
      }),
    );
    let c = new Collaboration(s, port);
    await c.reconcile();
    assert.equal(records.size, 0);
    assert.match(c.snapshot(work).error, /等待/);
    execute(s, {
      type: "respond-task",
      taskId: human,
      expectedRevision: 1,
      body: "同意，可以推进",
    });
    await c.reconcile();
    assert.equal(records.size, 1);
    assert.match(c.snapshot(work).runs[0]!.error, /未确认/);
    c = new Collaboration(s, port);
    await c.reconcile();
    assert.equal(records.size, 1);
    assert.equal(c.snapshot(work).runs[0]!.error, "");
    const request = [...requests.values()][0] as {
      model_alias: string;
      reasoning_effort: string;
      intent: string;
    };
    assert.equal(request.model_alias, "exact-model");
    assert.equal(request.reasoning_effort, "high");
    assert.match(request.intent, /同意，可以推进/);
    execute(s, {
      type: "revise-artifact",
      artifactId: source,
      expectedRevision: 1,
      title: "来源",
      content: { kind: "document", markdown: "二" },
    });
    await c.reconcile();
    await c.reconcile();
    assert.equal(inputs.size, 1);
    let run = c.snapshot(work).runs[0]!;
    await c.control(work, 1, run.record!.revision, "pause");
    execute(s, {
      type: "revise-artifact",
      artifactId: source,
      expectedRevision: 2,
      title: "来源",
      content: { kind: "document", markdown: "三" },
    });
    c = new Collaboration(s, port);
    await c.reconcile();
    assert.equal(inputs.size, 1);
    run = c.snapshot(work).runs[0]!;
    await c.control(work, 1, run.record!.revision, "resume");
    await c.reconcile();
    assert.equal(inputs.size, 2);
    assert.equal(
      records.size,
      1,
      "source events do not create another timing scheduler",
    );
    const current = s.snapshot().artifacts.find((a) => a.id === work)!;
    const handoffOperation: Operation = {
      type: "revise-artifact",
      artifactId: work,
      expectedRevision: current.revision,
      title: current.title,
      content: {
        ...(current.content as TaskContent),
        assigneeId: "local-human",
        model: null,
        reasoningEffort: null,
        runRequested: 0,
        everySeconds: null,
      },
    };
    assert.throws(() => execute(s, handoffOperation), /先停止/);
    execute(s, handoffOperation, agent);
    c = new Collaboration(s, port);
    await c.reconcile();
    assert.equal(
      c.snapshot(work).runs[0]!.sourceStopped,
      true,
      "转交 Human 后旧 Agent 安排停止后续触发",
    );
    assert.equal([...records.values()][0]!.status, "cancelled");
    execute(s, {
      type: "revise-artifact",
      artifactId: source,
      expectedRevision: 3,
      title: "来源",
      content: { kind: "document", markdown: "四" },
    });
    await c.reconcile();
    assert.equal(inputs.size, 2, "转交后不继续生成来源输入");
    const handoff = s.snapshot().artifacts.find((a) => a.id === work)!;
    assert.throws(
      () =>
        execute(s, {
          type: "arrange-task",
          taskId: work,
          expectedRevision: handoff.revision,
          changes: { assigneeId: "morphz-agent" },
        }),
      /先停止/,
    );
    lifecycle = "completed";
    await c.reconcile();
    execute(s, {
      type: "revise-artifact",
      artifactId: work,
      expectedRevision: handoff.revision,
      title: handoff.title,
      content: {
        ...(handoff.content as TaskContent),
        assigneeId: "morphz-agent",
      },
    });
    execute(s, {
      type: "request-task-run",
      taskId: work,
      expectedRevision: handoff.revision + 1,
    });
    const resumed = s.snapshot().artifacts.find((a) => a.id === work)!;
    assert.equal(
      (resumed.content as TaskContent).runRequested,
      2,
      "重新转回 Agent 使用新的执行编号",
    );
  } finally {
    s.close();
  }
});
