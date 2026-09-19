import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import {
  AgentTools,
  prepareHostTools,
  type HostInvocation,
} from "../apps/service/src/agent-tools.js";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { createAppServer } from "../apps/service/src/http.js";
import { localAccess, orderedTasks } from "../packages/core/src/model.js";
const agent = { principalId: "morphz-service", actantId: "morphz-agent" };
const route: HostInvocation = {
  job_id: "job-1",
  tool_call_id: "call-1",
  session_id: "session-1",
  context_id: "context-1",
  principal_id: "principal-1",
  agent_id: "agent-1",
  target_id: "local",
  thread_id: "thread-1",
};
const envelope = (args: unknown, job = randomUUID()) => ({
  protocol: 1,
  tool: "host_morphz",
  invocation: { ...route, job_id: job },
  arguments: args,
});
const scope = (invocation: HostInvocation) => {
  assert.equal(invocation.session_id, route.session_id);
  assert.equal(invocation.principal_id, route.principal_id);
  return { projectId: "first-project", access: agent };
};

test("Agent 直接读取、排序和安排同一事项；幂等回执、Human 排序冲突、跨项目与代确认保护", () => {
  const store = new WorkspaceStore(":memory:"),
    tools = new AgentTools(store, "token", scope);
  try {
    const task = {
      kind: "task",
      description: "合成测试",
      assigneeId: "local-human",
      model: null,
      dueDate: null,
      assignment: "proposed",
      execution: "planned",
      delivery: "none",
      resultIds: [],
    };
    const a = (
      tools.call(envelope({ action: "create-task", title: "A", task })) as {
        artifactId: string;
      }
    ).artifactId;
    const b = (
      tools.call(envelope({ action: "create-task", title: "B", task })) as {
        artifactId: string;
      }
    ).artifactId;
    const list = tools.call(envelope({ action: "list-tasks" })) as {
      orderRevision: number;
      tasks: { artifactId: string }[];
    };
    const requested = list.tasks.map((a) => a.artifactId).reverse();
    const reorder = envelope({
      action: "reorder-tasks",
      taskIds: requested,
      orderRevision: list.orderRevision,
    });
    const receipt = tools.call(reorder);
    assert.deepEqual(tools.call(reorder), receipt);
    assert.deepEqual(
      (receipt as { tasks: { artifactId: string }[] }).tasks.map(
        (t) => t.artifactId,
      ),
      requested,
    );
    assert.deepEqual(
      orderedTasks(store.snapshot()).map((a) => a.id),
      requested,
    );
    store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "reorder-tasks",
          taskIds: [a, b],
          expectedOrderRevision: 1,
        },
      },
      localAccess,
    );
    assert.throws(
      () =>
        tools.call(
          envelope({
            action: "reorder-tasks",
            taskIds: [b, a],
            orderRevision: 1,
          }),
        ),
      /顺序已变化/,
    );
    tools.call(
      envelope({
        action: "arrange-task",
        artifactId: a,
        revision: 1,
        changes: { dueDate: "2026-09-18", assigneeId: "morphz-agent" },
      }),
    );
    const status = tools.call(
      envelope({ action: "task-status", artifactId: a }),
    ) as {
      runRequested: number;
      revision: number;
      assigneeName: string;
      projectTitle: string;
      dueDate: string;
      display: { state: string; label: string };
    };
    assert.equal(status.runRequested, 0);
    assert.equal(status.revision, 2);
    assert.equal(status.assigneeName, "Morphz");
    assert.ok(status.projectTitle);
    assert.equal(status.dueDate, "2026-09-18");
    assert.equal(status.display.label, "待开始");
    assert.throws(
      () =>
        tools.call(
          envelope({
            action: "arrange-task",
            artifactId: a,
            revision: 2,
            changes: { projectId: "local-inbox" },
          }),
        ),
      /跨项目/,
    );
    assert.throws(
      () =>
        tools.call(
          envelope({
            action: "finish-task",
            artifactId: b,
            revision: 1,
            resultIds: [a],
          }),
        ),
      /Human/,
    );
    assert.equal(store.snapshot().taskResponses.length, 0);
  } finally {
    store.close();
  }
});

test("公开当前理解由已提交帧生成，保留来源和版本，Human 只能提出纠正", async () => {
  const store = new WorkspaceStore(":memory:");
  let revision = 1;
  const tools = new AgentTools(
    store,
    "token",
    scope,
    async (_route, _scope, requested) => {
      assert.equal(requested, revision);
      return {
        body: "# 目标\n只使用合成资料。",
        frameId: "mw-public-first-project",
        frameRevision: revision,
        mindVersion: revision + 10,
      };
    },
  );
  try {
    const call = envelope({
      action: "publish-understanding",
      frameRevision: 1,
    });
    const first = (await tools.call(call)) as { artifactId: string };
    assert.deepEqual(await tools.call(call), first);
    const a = store.snapshot().artifacts[0]!;
    assert.equal(a.content.kind, "document");
    assert.throws(
      () =>
        store.execute(
          {
            commandId: randomUUID(),
            operation: {
              type: "revise-artifact",
              artifactId: a.id,
              expectedRevision: 1,
              title: a.title,
              content: { kind: "document", markdown: "冒充更新" },
            },
          },
          localAccess,
        ),
      /纠正/,
    );
    assert.throws(
      () =>
        tools.call(
          envelope({
            action: "revise-document",
            artifactId: a.id,
            revision: 1,
            title: a.title,
            markdown: "冒充事务",
          }),
        ),
      /publish-understanding/,
    );
    revision = 2;
    await tools.call(
      envelope({
        action: "publish-understanding",
        artifactId: a.id,
        revision: 1,
        frameRevision: 2,
      }),
    );
    assert.equal(store.snapshot().artifacts[0]!.revision, 2);
  } finally {
    store.close();
  }
});

test("Agent 对象操作：创建幂等、批注后修订、旧版本与同项目关联", () => {
  const store = new WorkspaceStore(":memory:"),
    tools = new AgentTools(store, "test-token", scope);
  try {
    const create = envelope({
      action: "create-document",
      title: "测试文章",
      markdown: "第一段原文",
    });
    const created = tools.call(create) as { artifactId: string };
    assert.deepEqual(tools.call(create), created);
    assert.equal(store.snapshot().artifacts.length, 1);
    assert.deepEqual(store.snapshot().artifacts[0]!.createdBy, agent);
    assert.throws(
      () =>
        tools.call({
          ...create,
          arguments: { ...(create.arguments as object), markdown: "不是重试" },
        }),
      /操作标识/,
    );
    store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "annotate",
          artifactId: created.artifactId,
          artifactRevision: 1,
          quote: "原文",
          body: "请保留结论，补充细节",
        },
      },
      localAccess,
    );
    const read = tools.call(
      envelope({ action: "read", artifactId: created.artifactId }),
    ) as { text: string; annotations: unknown[] };
    assert.equal(read.annotations.length, 1);
    assert.equal(read.text, "第一段原文");
    const revise = envelope({
      action: "revise-document",
      artifactId: created.artifactId,
      revision: 1,
      title: "测试文章",
      markdown: "第一段原文，补充细节",
    });
    const revised = tools.call(revise);
    assert.deepEqual(tools.call(revise), revised);
    assert.throws(() => tools.call(envelope(revise.arguments)), /已有新版本/);
    assert.equal(
      (
        tools.call(
          envelope({
            action: "read",
            artifactId: created.artifactId,
            revision: 1,
          }),
        ) as { text: string }
      ).text,
      "第一段原文",
    );
    assert.equal(
      (
        tools.call(envelope({ action: "search", query: "细节" })) as {
          total: number;
        }
      ).total,
      1,
    );
    const other = tools.call(
      envelope({
        action: "create-document",
        title: "来源",
        markdown: "授权来源",
      }),
    ) as { artifactId: string };
    tools.call(
      envelope({
        action: "link",
        artifactId: created.artifactId,
        toId: other.artifactId,
        relation: "references",
      }),
    );
    assert.equal(store.snapshot().relations.length, 1);
  } finally {
    store.close();
  }
});

test("Agent 参数不能扩大项目范围或冒充身份；读取分页绑定版本", () => {
  const store = new WorkspaceStore(":memory:"),
    tools = new AgentTools(store, "secret", scope);
  try {
    const project = store.execute(
      {
        commandId: randomUUID(),
        operation: { type: "create-project", title: "另一项目" },
      },
      localAccess,
    );
    const other = store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "create-artifact",
          projectId: project.entityId,
          title: "隐私标题",
          content: { kind: "document", markdown: "另一项目内容" },
        },
      },
      localAccess,
    );
    assert.throws(
      () =>
        tools.call(envelope({ action: "read", artifactId: other.entityId })),
      /不属于/,
    );
    assert.equal(
      (tools.call(envelope({ action: "list" })) as { total: number }).total,
      0,
    );
    assert.equal(
      (
        tools.call(envelope({ action: "search", query: "隐私" })) as {
          total: number;
        }
      ).total,
      0,
    );
    for (const injection of [
      { projectId: project.entityId },
      { principalId: "local-owner" },
      { commandId: randomUUID() },
    ])
      assert.throws(() =>
        tools.call(envelope({ action: "list", ...injection })),
      );
    const created = tools.call(
      envelope({
        action: "create-document",
        title: "长文",
        markdown: "0123456789",
      }),
    ) as { artifactId: string };
    const read = tools.call(
      envelope({
        action: "read",
        artifactId: created.artifactId,
        offset: 2,
        limit: 4,
      }),
    ) as { text: string; hasMore: boolean; revision: number };
    assert.equal(read.text, "2345");
    assert.equal(read.hasMore, true);
    assert.equal(read.revision, 1);
  } finally {
    store.close();
  }
});

test("Host 工具凭据保持稳定、只在主机文件中，不接受不同中心重绑定", () => {
  const directory = mkdtempSync(
      join(tmpdir(), "morphz-application-host-tools-"),
    ),
    namespace = randomUUID();
  const first = prepareHostTools(directory, 65420, namespace),
    second = prepareHostTools(directory, 65420, namespace);
  assert.equal(first.token, second.token);
  assert.equal(lstatSync(first.path).mode & 0o077, 0);
  const data = JSON.parse(readFileSync(first.path, "utf8"));
  for (const tool of data.tools) {
    assert.deepEqual(tool.idempotent_requests, [
      { "/action": "script", "/script/action": "read-workflow" },
      { "/action": "script", "/script/action": "submit-workflow" },
    ]);
    assert.equal(
      JSON.stringify(tool.definition).includes("idempotent_requests"),
      false,
    );
  }
  assert.deepEqual(
    data.tools.map((t: any) => t.definition.name),
    ["host_morphz", "host_morphz_work"],
  );
  assert.deepEqual(
    data.formats.map((f: any) => [f.id, f.version]),
    [
      ["morphz.application.input", "5"],
      ["morphz.application.input", "4"],
      ["morphz.application.input", "3"],
      ["morphz.application.input", "2"],
      ["morphz.application.input", "1"],
      ["morphzwork.input", "2"],
      ["morphzwork.input", "1"],
    ],
  );
  assert.equal(JSON.stringify(data.formats).includes(first.token), false);
  assert.equal(
    JSON.stringify(data.tools[0].definition).includes(first.token),
    false,
  );
  assert.throws(() => prepareHostTools(directory, 65422, namespace), /不匹配/);
  assert.throws(
    () => prepareHostTools(directory, 65420, randomUUID()),
    /不匹配/,
  );
  assert.throws(
    () => prepareHostTools(directory, 65420, namespace, true),
    /不匹配/,
  );
  const teamDirectory = mkdtempSync(
    join(tmpdir(), "morphz-application-team-tools-"),
  );
  const team = prepareHostTools(teamDirectory, 65420, namespace, true);
  assert.equal(
    prepareHostTools(teamDirectory, 65420, namespace, true).token,
    team.token,
  );
  const teamData = JSON.parse(readFileSync(team.path, "utf8"));
  assert.deepEqual(teamData.tools[0].context_ids, []);
  assert.deepEqual(teamData.tools[0].context_id_prefixes, [
    `mw-context-${namespace}-`,
  ]);
});

test("Host HTTP 不接受 UI 令牌、浏览器来源或缺少服务凭据的调用", async () => {
  const listener = createServer();
  await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((r) => listener.close(() => r()));
  const store = new WorkspaceStore(":memory:"),
    token = "test-host-private-token";
  const server = createAppServer(store, {
    port,
    webRoot: "/nonexistent",
    agentTools: new AgentTools(store, token, scope),
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${port}`;
  try {
    const snapshot = (await (
      await fetch(origin + "/api/workspace")
    ).json()) as { csrfToken: string };
    assert.ok(!JSON.stringify(snapshot).includes(token));
    const post = (headers: Record<string, string>, args = { action: "list" }) =>
      fetch(origin + "/api/host-tools/call", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(envelope(args)),
      });
    assert.equal((await post({})).status, 403);
    assert.equal(
      (await post({ "X-Morphz-Token": snapshot.csrfToken })).status,
      403,
    );
    assert.equal(
      (await post({ Authorization: `Bearer ${token}`, Origin: origin })).status,
      403,
    );
    assert.equal(
      (
        await post({
          Authorization: `Bearer ${token}`,
          "Sec-Fetch-Site": "same-origin",
        })
      ).status,
      403,
    );
    const accepted = await post({ Authorization: `Bearer ${token}` });
    assert.equal(accepted.status, 200);
    assert.equal(((await accepted.json()) as { ok: boolean }).ok, true);
    const invalid = await post(
      { Authorization: `Bearer ${token}` },
      { action: "create-document" },
    );
    assert.equal(((await invalid.json()) as { code: string }).code, "invalid");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});
