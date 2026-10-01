import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import * as viewModel from "../packages/core/src/model.js";
import {
  commandSchema,
  localAccess,
  morphzAgentAccess,
} from "../packages/core/src/model.js";
import { createDocument } from "../packages/application/src/document-service.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";

const document = {
  objectId: "original-document",
  title: "文章",
  markdown: "原文内容\n\n第二段",
};

// These contracts execute the current Host and private application databases.
// Pure view DTO fixtures cannot prove authorization, commits or immutable history.
test("核心展示契约不再导出退役的整工作区写入与鉴权处理器", () => {
  for (const retired of ["applyCommand", "bookmarkOwner", "inboxFor"])
    assert.equal(retired in viewModel, false);
  assert.equal(typeof viewModel.stateSchema.parse, "function");
  assert.equal(typeof viewModel.orderedTasks, "function");
  assert.equal(typeof viewModel.currentTaskResponse, "function");
});

test("正式对象修订保留不可变历史，CAS 拒绝旧修订，冷重开仍读取同一版本", async () => {
  const f = await platformRuntimeHostFixture();
  try {
    const first = await f.session().createPlatformDocument({
      ...document,
      projectId: f.projectId,
      commandId: randomUUID(),
    });
    const revision = {
      commandId: randomUUID(),
      contentId: first.contentId,
      expectedRevision: 1,
      title: "新标题",
      markdown: "新内容",
    };
    const second = await f.session().revisePlatformDocument(revision);
    assert.equal(second.versionRef, "2");
    assert.deepEqual(
      await f.session().revisePlatformDocument(revision),
      second,
    );
    await assert.rejects(
      f
        .session()
        .revisePlatformDocument({ ...revision, commandId: randomUUID() }),
      /版本|修订|变化/,
    );
    const original = await f.session().readPlatformDocument({
      contentId: first.contentId,
      revision: 1,
    });
    assert.equal(original.revision, 1);
    assert.equal(original.headRevision, 2);
    assert.equal(original.title, document.title);
    assert.equal(original.markdown, document.markdown);
    await f.reopen();
    assert.deepEqual(
      await f.session().readPlatformDocument({
        contentId: first.contentId,
        revision: 1,
      }),
      original,
    );
    assert.equal(
      (
        await f.session().readPlatformDocument({
          contentId: first.contentId,
        })
      ).markdown,
      "新内容",
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("正式批注锚定原件的历史版本，错误版本和伪造引文不能写入", async () => {
  const f = await platformRuntimeHostFixture();
  try {
    const created = await f.session().createPlatformDocument({
      ...document,
      projectId: f.projectId,
      commandId: randomUUID(),
    });
    await f.session().revisePlatformDocument({
      commandId: randomUUID(),
      contentId: created.contentId,
      expectedRevision: 1,
      title: document.title,
      markdown: "完全替换",
    });
    const note = {
      commandId: randomUUID(),
      contentId: created.contentId,
      revision: 1,
      quote: "原文内容",
      body: "保留这个判断",
    };
    const saved = await f.session().annotatePlatformObject(note);
    assert.equal(saved.artifactRevision, 1);
    assert.deepEqual(await f.session().annotatePlatformObject(note), saved);
    for (const revision of [2, 99])
      await assert.rejects(
        f.session().annotatePlatformObject({
          ...note,
          commandId: randomUUID(),
          revision,
        }),
        /引文|版本/,
      );
    await assert.rejects(
      f.session().annotatePlatformObject({
        ...note,
        commandId: randomUUID(),
        quote: "不存在的句子",
      }),
      /引文/,
    );
    await f.reopen();
    const notes = await f.session().listPlatformObjectAnnotations({
      contentId: created.contentId,
    });
    assert.deepEqual(
      notes.map((row) => row.annotation),
      [saved],
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("Human 与 Agent 共用原件提交边界，身份必须来自已授权发起输入", async () => {
  const f = await agentDomainFixture();
  try {
    const human = await f.withHuman((actor) =>
      createDocument({
        platform: f.domains.content.platform,
        objects: f.domains.content.objects,
        instanceId: f.domains.content.instanceIds.objects,
        actor,
        commandId: randomUUID(),
        objectId: "human-document",
        projectId: f.projectId,
        title: "Human 原件",
        markdown: "人工内容",
      }),
    );
    const agent = await f.call<{ contentId: string }>({
      action: "create-document",
      title: "Agent 原件",
      markdown: "执行结果",
    });
    const author = (contentId: string) =>
      f.withHuman(async (actor) => {
        const entry = await f.domains.content.platform.content(
          actor,
          contentId,
        );
        return (
          await f.domains.content.objects.readObject({
            credential: actor.credential,
            objectId: entry.app_object_id,
          })
        ).author;
      });
    assert.deepEqual(await author(human.contentId), localAccess);
    assert.deepEqual(await author(agent.contentId), {
      principalId: localAccess.principalId,
      actantId: morphzAgentAccess.actantId,
    });
    await assert.rejects(
      f.domains.work.authority.withSession(
        { principalId: "local-owner", actantId: "morphz-agent" },
        () => {},
        (actor) => f.domains.work.service.listProjects(actor),
      ),
      /参与者|主体|身份|授权|权限/,
    );
    await assert.rejects(
      f.call(
        {
          action: "create-document",
          title: "越权",
          markdown: "不能写入",
        },
        { ...f.route, thread_id: "missing-runtime-input" },
      ),
    );
    assert.equal(
      commandSchema.safeParse({
        commandId: randomUUID(),
        principalId: "morphz-service",
        operation: {
          type: "create-artifact",
          projectId: f.projectId,
          title: "伪造",
          content: { kind: "document", markdown: "" },
        },
      }).success,
      false,
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("事项负责人投影同一对象，执行模型不能改变身份或赋给人工事项", async () => {
  const f = await platformRuntimeHostFixture();
  try {
    const taskId = "assigned-task";
    await f.session().createPlatformTask({
      commandId: randomUUID(),
      taskId,
      projectId: f.projectId,
      title: "检查",
      description: "确认文章",
      assigneeId: localAccess.actantId,
    });
    assert.deepEqual(
      (await f.session().listPlatformTasks({ owner: "human" })).map(
        (task) => task.id,
      ),
      [taskId],
    );
    await f.session().revisePlatformTask({
      commandId: randomUUID(),
      taskId,
      expectedRevision: 1,
      assigneeId: morphzAgentAccess.actantId,
      modelId: "example-model",
    });
    assert.equal(
      (await f.session().listPlatformTasks({ owner: "human" })).length,
      0,
    );
    assert.deepEqual(
      (await f.session().listPlatformTasks({ owner: "agent" })).map(
        (task) => task.id,
      ),
      [taskId],
    );
    const version = await f.session().getPlatformTaskVersion({ taskId });
    assert.equal(version.assigneeId, morphzAgentAccess.actantId);
    assert.equal(version.modelId, "example-model");
    await assert.rejects(
      f.session().createPlatformTask({
        commandId: randomUUID(),
        taskId: "invalid-human-model",
        projectId: f.projectId,
        title: "错误",
        assigneeId: localAccess.actantId,
        modelId: "not-for-humans",
      }),
      /人工事项/,
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("事项使用持久顺序而非已退役的高低优先级，CAS 和冷重开保持同一顺序", async () => {
  const f = await platformRuntimeHostFixture();
  try {
    for (const taskId of ["first-task", "second-task", "third-task"])
      await f.session().createPlatformTask({
        commandId: randomUUID(),
        taskId,
        projectId: f.projectId,
        title: taskId,
        assigneeId: localAccess.actantId,
      });
    const human = <T>(
      work: Parameters<typeof f.domains.work.authority.withSession<T>>[2],
    ) => f.domains.work.authority.withSession(localAccess, () => {}, work);
    const order = await human((actor) =>
      f.domains.work.service.taskOrder(actor, { projectId: f.projectId }),
    );
    const request = {
      commandId: randomUUID(),
      projectId: f.projectId,
      taskId: "third-task",
      beforeTaskId: "first-task",
      expectedOrderRevision: order.revision,
    };
    const moved = await human((actor) =>
      f.domains.work.service.reorderTask(actor, request),
    );
    assert.deepEqual(
      await human((actor) =>
        f.domains.work.service.reorderTask(actor, request),
      ),
      moved,
    );
    await assert.rejects(
      human((actor) =>
        f.domains.work.service.reorderTask(actor, {
          ...request,
          commandId: randomUUID(),
          beforeTaskId: "second-task",
        }),
      ),
      /顺序|变化|修订/,
    );
    const expected = ["third-task", "first-task", "second-task"];
    assert.deepEqual(
      (await f.session().listPlatformTasks({})).map((task) => task.id),
      expected,
    );
    await f.reopen();
    assert.deepEqual(
      (await f.session().listPlatformTasks({})).map((task) => task.id),
      expected,
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("关联引用真实原件，重复提交不复制边，不能自指或跨未授权项目", async () => {
  const f = await platformRuntimeHostFixture();
  try {
    const first = await f.session().createPlatformDocument({
      ...document,
      commandId: randomUUID(),
      projectId: f.projectId,
    });
    const second = await f.session().createPlatformDocument({
      ...document,
      objectId: "second-document",
      title: "引用",
      commandId: randomUUID(),
      projectId: f.projectId,
    });
    const link = {
      commandId: randomUUID(),
      fromId: first.contentId,
      toId: second.contentId,
      kind: "references",
      expectedProjectId: f.projectId,
    };
    const human = <T>(
      work: Parameters<typeof f.domains.work.authority.withSession<T>>[2],
    ) => f.domains.work.authority.withSession(localAccess, () => {}, work);
    const linked = await human((actor) =>
      f.domains.work.service.linkWork(actor, link),
    );
    assert.equal(
      await human((actor) => f.domains.work.service.linkWork(actor, link)),
      linked,
    );
    assert.equal(
      (
        await human((actor) =>
          f.domains.work.service.listWorkRelations(actor, {
            objectId: first.contentId,
          }),
        )
      ).length,
      1,
    );
    for (const toId of [first.contentId, "ungranted-content"])
      await assert.rejects(
        human((actor) =>
          f.domains.work.service.linkWork(actor, {
            ...link,
            commandId: randomUUID(),
            toId,
          }),
        ),
      );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("正式输入固定原件版本且不假报执行，无效引用不会进入待投递记录", async () => {
  const f = await platformRuntimeHostFixture();
  try {
    const created = await f.session().createPlatformDocument({
      ...document,
      commandId: randomUUID(),
      projectId: f.projectId,
    });
    const operation = {
      type: "record-input" as const,
      projectId: f.projectId,
      artifactId: created.contentId,
      artifactRevision: 1,
      selection: "原文内容",
      body: "继续",
      targetActantId: "morphz-agent",
    };
    const commandId = randomUUID();
    await f.session().platformMessage({ commandId, operation });
    const deliveries = () =>
      z
        .object({
          deliveries: z.array(
            z.object({
              inputId: z.string(),
              state: z.string(),
              platformSource: z
                .object({
                  artifactId: z.string(),
                  artifactRevision: z.number(),
                  selection: z.string(),
                })
                .optional(),
            }),
          ),
        })
        .parse(f.store.runtimeState()).deliveries;
    const source = deliveries().find((d) => d.inputId === commandId)!;
    assert.equal(source.platformSource!.artifactRevision, 1);
    assert.equal(source.platformSource!.artifactId, created.contentId);
    assert.equal(source.platformSource!.selection, "原文内容");
    assert.equal(source.state, "queued");
    const count = deliveries().length;
    await assert.rejects(
      f.session().platformMessage({
        commandId: randomUUID(),
        operation: { ...operation, artifactRevision: 99 },
      }),
      /版本/,
    );
    assert.equal(deliveries().length, count);
    assert.equal(
      commandSchema.safeParse({
        commandId: randomUUID(),
        operation: { ...operation, body: "  " },
      }).success,
      false,
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});
