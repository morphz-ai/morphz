import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, lstatSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import {
  AgentTools,
  workToolDefinition,
  hostIdempotentRequests,
  prepareHostTools,
  type HostInvocation,
} from "../apps/service/src/agent-tools.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import { createAppServer } from "../apps/service/src/http.js";
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

test("文档局部修订复用原工具：只传替换片段，保留原文、历史、重开回执与冲突", async () => {
  const fixture = await agentDomainFixture();
  try {
    const markdown =
      "# 测试文章\r\n\r\n前文保持。\n菜贩剥下的老叶落在筐边。\n后文保持。\n" +
      "其他文字不改。".repeat(2000);
    const created = await fixture.call<{ contentId: string }>({
      action: "create-document",
      title: "TEST 精确局部修订",
      markdown,
    });
    const arguments_ = {
      action: "revise-document",
      artifactId: created.contentId,
      revision: 1,
      edits: [{ old_text: "剥下", new_text: "摘下" }],
    };
    const revise = fixture.envelope(arguments_);
    assert.ok(JSON.stringify(revise.arguments).length < 300);
    const revised = await fixture.tools.call(revise);
    assert.deepEqual(await fixture.tools.call(revise), revised);
    const current = await fixture.call<{
      objectId: string;
      text: string;
      title: string;
    }>({ action: "read", artifactId: created.contentId });
    const expected = markdown.replace("剥下", "摘下");
    assert.equal(current.text, expected.slice(0, current.text.length));
    assert.deepEqual(
      (
        await fixture.withHuman((actor) =>
          fixture.domains.content.objects.readObject({
            credential: actor.credential,
            objectId: current.objectId,
          }),
        )
      ).content,
      { kind: "document", markdown: expected },
    );
    const original = await fixture.withHuman((actor) =>
      fixture.domains.content.objects.readObject({
        credential: actor.credential,
        objectId: current.objectId,
        revision: 1,
      }),
    );
    assert.equal(original.title, "TEST 精确局部修订");
    assert.deepEqual(original.content, { kind: "document", markdown });
    await assert.rejects(fixture.call(revise.arguments), /版本|修订/);
    await assert.rejects(
      fixture.call({ ...arguments_, revision: 2, markdown: "不能混用" }),
      /不能|互斥|之一|同时/,
    );
    await assert.rejects(
      fixture.call({
        ...arguments_,
        revision: 2,
        edits: [{ old_text: "没有这段", new_text: "不能猜" }],
      }),
      /未找到|找不到/,
    );
    await assert.rejects(
      fixture.call({
        ...arguments_,
        revision: 2,
        edits: [{ old_text: "其他文字", new_text: "含糊" }],
      }),
      /多处|多次|唯一/,
    );
    assert.equal(
      (
        await fixture.call<{ text: string }>({
          action: "read",
          artifactId: created.contentId,
        })
      ).text,
      current.text,
    );
    const described = await fixture.call<{
      operation: { parameters: { properties: Record<string, unknown> } };
    }>({
      action: "operations",
      operations: {
        action: "describe",
        operationId: "content.revise-document",
      },
    });
    // Both direct calls and discovered operations must advertise and execute the same patch.
    assert.ok(JSON.stringify(described).includes('"edits"'));
    const viaDiscovery = fixture.envelope({
      action: "operations",
      operations: {
        action: "invoke",
        operationId: "content.revise-document",
        parameters: {
          artifactId: created.contentId,
          revision: 2,
          edits: [{ old_text: "前文保持。", new_text: "前文仍保持。" }],
        },
      },
    });
    await fixture.tools.call(viaDiscovery);
    await fixture.reopen();
    assert.deepEqual(await fixture.tools.call(revise), revised);
    const versions = await fixture.withHuman((actor) =>
      fixture.domains.content.objects.listObjectVersions({
        credential: actor.credential,
        objectId: current.objectId,
      }),
    );
    assert.equal(versions.versions.length, 3);
    assert.deepEqual(
      (
        await fixture.withHuman((actor) =>
          fixture.domains.content.objects.readObject({
            credential: actor.credential,
            objectId: current.objectId,
          }),
        )
      ).content,
      {
        kind: "document",
        markdown: expected.replace("前文保持。", "前文仍保持。"),
      },
    );
  } finally {
    await fixture.close();
  }
});

test("新工具契约只公布已接入领域的操作，不再诱导 Agent 调用旧事项或工作区接口", () => {
  const schema = workToolDefinition.parameters as unknown as {
    properties: Record<string, { enum?: string[] }>;
  };
  const actions = schema.properties.action!.enum!;
  for (const retired of [
    "create-task",
    "revise-task",
    "list-tasks",
    "start-task",
    "finish-task",
    "list-applications",
    "launch-application",
    "create-website",
  ])
    assert.equal(actions.includes(retired), false);
  assert.ok(actions.includes("work-task"));
  assert.ok(actions.includes("operations"));
  assert.ok(actions.includes("applications"));
  for (const field of [
    "task",
    "taskIds",
    "changes",
    "control",
    "applicationId",
    "applicationVersion",
    "scriptTarget",
    "sources",
  ])
    assert.equal(schema.properties[field], undefined);
  assert.doesNotMatch(
    workToolDefinition.description,
    /create-task \(|revise-task \(|set runRequested=1|list-applications returns|launch-application\(/,
  );
});
test("Platform-sourced tools read bound input, and missing domain or unverified scope cannot restore legacy writes", async () => {
  const tools = new AgentTools({
    token: "token",
    resolveScope: () => ({
      projectId: "first-project",
      platform: true,
      inputId: "platform-input",
      access: agent,
    }),
    platformInput: async (invocation) => {
      assert.equal(invocation.session_id, route.session_id);
      return { text: "来自 Runtime 持久输入", input_id: "platform-input" };
    },
  });
  assert.deepEqual(await tools.call(envelope({ action: "read-input" })), {
    ok: true,
    input: { text: "来自 Runtime 持久输入", input_id: "platform-input" },
  });
  assert.throws(
    () =>
      tools.call(
        envelope({
          action: "create-document",
          title: "不得写入旧库",
          markdown: "内容",
        }),
      ),
    /不会写入旧工作区/,
  );
  const unverified = new AgentTools({
    token: "token",
    resolveScope: () => ({ projectId: "first-project", access: agent }),
  });
  assert.throws(
    () => unverified.call(envelope({ action: "list" })),
    /未通过 Platform 授权/,
  );
});

test("Agent 在真实 Platform 排序和安排事项；幂等、Human 版本冲突与代确认保护", async () => {
  const fixture = await agentDomainFixture();
  const task = (request: unknown) => ({
    action: "work-task",
    workTask: request,
  });
  try {
    const a = await fixture.call<{ task: { taskId: string } }>(
      task({
        action: "create",
        title: "A",
        description: "合成测试",
        assignee: "me",
      }),
    );
    const b = await fixture.call<{ task: { taskId: string } }>(
      task({
        action: "create",
        title: "B",
        description: "合成测试",
        assignee: "me",
      }),
    );
    const list = () =>
      fixture.call<{ items: { id: string }[] }>(task({ action: "list" }));
    assert.deepEqual(
      (await list()).items.map((entry) => entry.id),
      [a.task.taskId, b.task.taskId],
    );
    const order = await fixture.call<{ order: { revision: number } }>(
      task({ action: "order" }),
    );
    const reorder = fixture.envelope(
      task({
        action: "reorder",
        taskId: b.task.taskId,
        beforeTaskId: a.task.taskId,
        orderRevision: order.order.revision,
      }),
    );
    const receipt = await fixture.tools.call(reorder);
    assert.deepEqual(await fixture.tools.call(reorder), receipt);
    assert.deepEqual(
      (await list()).items.map((entry) => entry.id),
      [b.task.taskId, a.task.taskId],
    );
    const humanOrder = await fixture.withHuman((actor) =>
      fixture.domains.work.service.taskOrder(actor, {
        projectId: fixture.projectId,
      }),
    );
    await fixture.withHuman((actor) =>
      fixture.domains.work.service.reorderTask(actor, {
        commandId: randomUUID(),
        projectId: fixture.projectId,
        taskId: a.task.taskId,
        beforeTaskId: b.task.taskId,
        expectedOrderRevision: humanOrder.revision,
      }),
    );
    await assert.rejects(
      fixture.call(
        task({
          action: "reorder",
          taskId: b.task.taskId,
          beforeTaskId: a.task.taskId,
          orderRevision: humanOrder.revision,
        }),
      ),
      /顺序|修订|版本/,
    );
    const changed = await fixture.call<{
      task: {
        taskId: string;
        revision: number;
        runRequested: number;
        dueDate: string;
        assigneeId: string;
        projectId: string;
        execution: string;
      };
    }>(
      task({
        action: "revise",
        taskId: a.task.taskId,
        revision: 1,
        dueDate: "2026-09-18",
        assignee: "agent",
      }),
    );
    assert.equal(changed.task.revision, 2);
    assert.equal(changed.task.runRequested, 0);
    assert.equal(changed.task.assigneeId, fixture.agentAccess.actantId);
    assert.equal(changed.task.projectId, fixture.projectId);
    assert.equal(changed.task.dueDate, "2026-09-18");
    assert.equal(changed.task.execution, "planned");
    await assert.rejects(
      fixture.call(
        task({
          action: "revise",
          taskId: a.task.taskId,
          revision: 2,
          projectId: "ungranted-project",
        }),
      ),
      /权限|项目|不存在/,
    );
    await assert.rejects(
      fixture.withAgent((actor) =>
        fixture.domains.work.service.respondTask(actor, {
          commandId: randomUUID(),
          taskId: b.task.taskId,
          expectedRevision: 1,
          body: "代 Human 接受任务",
        }),
      ),
      /只有当前负责人/,
    );
    const responses = await fixture.withHuman((actor) =>
      fixture.domains.work.service.listTaskResponses(actor, {
        taskId: b.task.taskId,
      }),
    );
    assert.deepEqual(responses, []);
    fixture.assertNoLegacyData();
  } finally {
    await fixture.close();
  }
});

test("公开当前理解从已提交 Runtime 帧发布到 Platform；来源、修订和 Human 纠正边界保留", async () => {
  let frameRevision = 1;
  const fixture = await agentDomainFixture({
    readUnderstanding: async (_route, scope, requested) => {
      assert.equal(requested, frameRevision);
      return {
        body: `# 理解 ${frameRevision}`,
        frameId: `mw-public-${scope.projectId}`,
        frameRevision,
        mindVersion: frameRevision,
      };
    },
  });
  try {
    const source = await fixture.call<{ contentId: string }>({
      action: "create-document",
      title: "依据",
      markdown: "已确认事实",
    });
    const sources = [{ contentId: source.contentId, versionRef: "1" }];
    const publication = fixture.envelope({
      action: "publish-understanding",
      frameRevision: 1,
      contentSources: sources,
    });
    const first = (await fixture.tools.call(publication)) as {
      understanding: { revision: number; body: string; sources: unknown };
    };
    assert.deepEqual(await fixture.tools.call(publication), first);
    assert.equal(first.understanding.revision, 1);
    assert.equal(first.understanding.body, "# 理解 1");
    assert.deepEqual(first.understanding.sources, [
      { ...sources[0], title: "依据", appId: "morphz.objects" },
    ]);
    await assert.rejects(
      fixture.withHuman((actor) =>
        fixture.domains.content.platform.publishProjectUnderstanding(actor, {
          commandId: randomUUID(),
          projectId: fixture.projectId,
          expectedRevision: 1,
          frameId: `mw-public-${fixture.projectId}`,
          frameRevision: 2,
          mindVersion: 2,
          body: "冒充事务",
          sources: [],
        }),
      ),
      /Agent|智能体/,
    );
    await assert.rejects(
      fixture.call({
        action: "revise-document",
        artifactId: fixture.projectId,
        revision: 1,
        title: "当前理解",
        markdown: "冒充文档",
      }),
      /内容|不存在/,
    );
    frameRevision = 2;
    const second = await fixture.call<{ understanding: { revision: number } }>({
      action: "publish-understanding",
      revision: 1,
      frameRevision: 2,
      contentSources: sources,
    });
    assert.equal(second.understanding.revision, 2);
    assert.equal(
      (await fixture.call<{ items: unknown[] }>({ action: "list" })).items
        .length,
      1,
    );
    assert.equal(
      (
        await fixture.call<{ total: number }>({
          action: "search",
          query: "理解",
        })
      ).total,
      0,
    );
    await fixture.reopen();
    const restored = await fixture.call<{
      understanding: { revision: number; body: string };
    }>({
      action: "read-understanding",
    });
    assert.equal(restored.understanding.revision, 2);
    assert.equal(restored.understanding.body, "# 理解 2");
    fixture.assertNoLegacyData();
  } finally {
    await fixture.close();
  }
});

test("Agent 与 Human 操作同一 Objects 原件；批注、不可变版本、冲突、关联和重开幂等", async () => {
  const fixture = await agentDomainFixture();
  try {
    const create = fixture.envelope({
      action: "create-document",
      title: "测试文章",
      markdown: "第一段原文",
    });
    const created = (await fixture.tools.call(create)) as {
      contentId: string;
      versionRef: string;
    };
    assert.deepEqual(await fixture.tools.call(create), created);
    assert.equal(
      (await fixture.call<{ items: unknown[] }>({ action: "list" })).items
        .length,
      1,
    );
    const original = await fixture.call<{ objectId: string; text: string }>({
      action: "read",
      artifactId: created.contentId,
    });
    const version = await fixture.withHuman((actor) =>
      fixture.domains.content.objects.readObject({
        credential: actor.credential,
        objectId: original.objectId,
      }),
    );
    assert.deepEqual(version.author, {
      principalId: "local-owner",
      actantId: fixture.agentAccess.actantId,
    });
    await assert.rejects(
      Promise.resolve().then(() =>
        fixture.tools.call({
          ...create,
          arguments: { ...(create.arguments as object), markdown: "不是重试" },
        }),
      ),
      /命令|操作标识|重试/,
    );
    await fixture.withHuman((actor) =>
      fixture.domains.content.objects.annotateObject({
        credential: actor.credential,
        commandId: randomUUID(),
        objectId: original.objectId,
        revision: 1,
        quote: "原文",
        body: "请保留结论，补充细节",
      }),
    );
    const annotations = await fixture.withHuman((actor) =>
      fixture.domains.content.objects.listObjectAnnotations({
        credential: actor.credential,
        objectId: original.objectId,
      }),
    );
    assert.equal(annotations.length, 1);
    assert.equal(annotations[0]!.annotation.body, "请保留结论，补充细节");
    assert.equal(original.text, "第一段原文");
    const revise = fixture.envelope({
      action: "revise-document",
      artifactId: created.contentId,
      revision: 1,
      title: "测试文章",
      markdown: "第一段原文，补充细节",
    });
    const revised = await fixture.tools.call(revise);
    assert.deepEqual(await fixture.tools.call(revise), revised);
    await assert.rejects(fixture.call(revise.arguments), /新版本|版本|修订/);
    assert.equal(
      (
        await fixture.call<{ text: string }>({
          action: "read",
          artifactId: created.contentId,
          revision: 1,
        })
      ).text,
      "第一段原文",
    );
    assert.equal(
      (
        await fixture.call<{ total: number }>({
          action: "search",
          query: "细节",
        })
      ).total,
      1,
    );
    const other = await fixture.call<{ contentId: string }>({
      action: "create-document",
      title: "来源",
      markdown: "授权来源",
    });
    const relation = fixture.envelope({
      action: "link",
      artifactId: created.contentId,
      toId: other.contentId,
      relation: "references",
    });
    const linked = await fixture.tools.call(relation);
    assert.deepEqual(await fixture.tools.call(relation), linked);
    assert.equal(
      (
        await fixture.call<{ relations: unknown[] }>({
          action: "relations",
          artifactId: created.contentId,
        })
      ).relations.length,
      1,
    );
    await fixture.reopen();
    assert.deepEqual(await fixture.tools.call(create), created);
    assert.deepEqual(await fixture.tools.call(revise), revised);
    const versions = await fixture.withHuman((actor) =>
      fixture.domains.content.objects.listObjectVersions({
        credential: actor.credential,
        objectId: original.objectId,
      }),
    );
    assert.equal(versions.versions.length, 2);
    fixture.assertNoLegacyData();
  } finally {
    await fixture.close();
  }
});

test("真实 Runtime 来源固定项目；模型不能冒充身份或扩大范围，读取分页绑定版本", async () => {
  const fixture = await agentDomainFixture();
  try {
    const otherProjectId = "other-test-project";
    await fixture.withHuman((actor) =>
      fixture.domains.work.service.createProject(actor, {
        commandId: randomUUID(),
        projectId: otherProjectId,
        title: "另一项目",
      }),
    );
    const other = await fixture.call<{ contentId: string }>(
      {
        action: "create-document",
        title: "隐私标题",
        markdown: "另一项目内容",
      },
      fixture.input(otherProjectId),
    );
    await assert.rejects(
      fixture.call({ action: "read", artifactId: other.contentId }),
      /范围|项目/,
    );
    assert.deepEqual(
      (await fixture.call<{ items: unknown[] }>({ action: "list" })).items,
      [],
    );
    assert.equal(
      (
        await fixture.call<{ total: number }>({
          action: "search",
          query: "隐私",
        })
      ).total,
      0,
    );
    for (const injection of [
      { projectId: otherProjectId },
      { principalId: "local-owner" },
      { commandId: randomUUID() },
    ])
      assert.throws(() =>
        fixture.tools.call(fixture.envelope({ action: "list", ...injection })),
      );
    await assert.rejects(
      Promise.resolve().then(() =>
        fixture.tools.call({
          ...fixture.envelope({ action: "list" }),
          invocation: { ...fixture.route, principal_id: "forged-principal" },
        }),
      ),
      /Runtime 执行/,
    );
    const created = await fixture.call<{ contentId: string }>({
      action: "create-document",
      title: "长文",
      markdown: "0123456789",
    });
    const read = await fixture.call<{
      text: string;
      hasMore: boolean;
      revision: number;
    }>({
      action: "read",
      artifactId: created.contentId,
      offset: 2,
      limit: 4,
    });
    assert.equal(read.text, "2345");
    assert.equal(read.hasMore, true);
    assert.equal(read.revision, 1);
    fixture.assertNoLegacyData();
  } finally {
    await fixture.close();
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
    assert.ok(
      Buffer.byteLength(tool.definition.description, "utf8") <= 16000,
      `${tool.definition.name} exceeds Runtime's actual description budget`,
    );
    assert.deepEqual(tool.idempotent_requests, hostIdempotentRequests);
    assert.ok(lstatSync(first.path).size < 262144);
    assert.equal(
      JSON.stringify(tool.definition).includes("idempotent_requests"),
      false,
    );
  }
  assert.deepEqual(
    data.tools.map((t: any) => t.definition.name),
    ["host_morphz"],
  );
  const cached = structuredClone(data);
  cached.tools.push({
    ...cached.tools[0],
    definition: { ...cached.tools[0].definition, name: "host_morphz_work" },
  });
  writeFileSync(first.path, JSON.stringify(cached), { mode: 0o600 });
  const refreshed = prepareHostTools(directory, 65420, namespace);
  assert.equal(refreshed.token, first.token);
  const current = JSON.parse(readFileSync(refreshed.path, "utf8"));
  assert.deepEqual(
    current.tools.map((tool: any) => tool.definition.name),
    ["host_morphz"],
  );
  assert.deepEqual(current.tools[0].context_ids, cached.tools[0].context_ids);
  assert.deepEqual(
    data.formats.map((f: any) => [f.id, f.version]),
    [
      ["morphz.application.input", "14"],
      ["morphz.application.input", "13"],
      ["morphz.application.input", "12"],
      ["morphz.application.input", "11"],
      ["morphz.application.input", "10"],
      ["morphz.application.input", "9"],
      ["morphz.application.input", "8"],
      ["morphz.application.input", "5"],
      ["morphz.application.input", "4"],
      ["morphz.application.input", "3"],
      ["morphz.application.input", "2"],
      ["morphz.application.input", "1"],
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

test("Host HTTP rejects UI credentials, browser origins and missing service credentials", async () => {
  const listener = createServer();
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const fixture = await agentDomainFixture();
  const server = createAppServer(fixture.transport, {
    port,
    webRoot: "/nonexistent",
    agentTools: fixture.tools,
    platformWork: fixture.domains.work,
  });
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  const origin = `http://127.0.0.1:${port}`;
  try {
    const boot = (await (
      await fetch(origin + "/api/platform/bootstrap")
    ).json()) as { csrfToken: string };
    assert.ok(boot.csrfToken);
    assert.ok(!JSON.stringify(boot).includes("test-host-token"));
    const post = (headers: Record<string, string>, args = { action: "list" }) =>
      fetch(origin + "/api/host-tools/call", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(fixture.envelope(args)),
      });
    assert.equal((await post({})).status, 403);
    assert.equal(
      (await post({ "X-Morphz-Token": boot.csrfToken })).status,
      403,
    );
    assert.equal(
      (await post({ Authorization: "Bearer test-host-token", Origin: origin }))
        .status,
      403,
    );
    assert.equal(
      (
        await post({
          Authorization: "Bearer test-host-token",
          "Sec-Fetch-Site": "same-origin",
        })
      ).status,
      403,
    );
    const accepted = await post({ Authorization: "Bearer test-host-token" });
    assert.equal(accepted.status, 200);
    assert.equal(((await accepted.json()) as { ok: boolean }).ok, true);
    const retired = await fetch(origin + "/api/host-tools/call", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-host-token",
      },
      body: JSON.stringify({
        ...fixture.envelope({
          action: "create-document",
          title: "TEST 不得写入",
          markdown: "退役调用",
        }),
        tool: "host_morphz_work",
      }),
    });
    assert.equal(retired.status, 200);
    const rejected = (await retired.json()) as {
      ok: boolean;
      code: string;
      issues: { path: string[]; code: string }[];
    };
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, "invalid");
    assert.ok(rejected.issues.some((issue) => issue.path.join(".") === "tool"));
    assert.equal(
      (await fixture.call<{ items: unknown[] }>({ action: "list" })).items
        .length,
      0,
    );
    const invalid = await post(
      { Authorization: "Bearer test-host-token" },
      { action: "create-document" },
    );
    assert.equal(((await invalid.json()) as { code: string }).code, "invalid");
    fixture.assertNoLegacyData();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fixture.close();
  }
});
