import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Application } from "../packages/application/src/application.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import { localAccess } from "../packages/core/src/model.js";
import {
  emptyInteractive,
  interactiveSchema,
  interactiveDraftSchema,
  interactiveSummary,
} from "../packages/core/src/interactive.js";
test("交互产物的数据、版本、引用和检索共用对象规则；不执行脚本", async () => {
  const fixture = await agentDomainFixture();
  const session = () =>
    new Application(fixture.transport, {
      platformWork: fixture.domains.work,
      platformDocuments: fixture.domains.content,
    }).session(localAccess);
  try {
    const content = {
      ...emptyInteractive,
      rows: [
        { id: "a", cells: { name: "合成资料", value: 4, done: true } },
        {
          id: "b",
          cells: {
            name: "<script>fetch('/api/workspace')</script>",
            value: 6,
            done: false,
          },
        },
      ],
    };
    const receipt = await fixture.call<{ contentId: string }>({
      action: "create-interactive",
      title: "进度记录",
      interactive: content,
    });
    assert.equal(interactiveSummary(content)[0]!.mean, 5);
    assert.equal((await session().search({ query: "合成资料" })).total, 1);
    const command = {
      commandId: randomUUID(),
      contentId: receipt.contentId,
      expectedRevision: 1,
      title: "进度记录",
      content: { ...content, layout: "report" as const },
    };
    await session().revisePlatformInteractive(command);
    assert.deepEqual(
      await session().revisePlatformInteractive(command),
      await session().revisePlatformInteractive(command),
    );
    await assert.rejects(
      session().revisePlatformInteractive({
        ...command,
        commandId: randomUUID(),
      }),
      /已变化|版本/,
    );
    assert.equal(
      (
        await session().readPlatformObject({
          contentId: receipt.contentId,
          revision: 1,
        })
      ).content.kind,
      "interactive",
    );
    await session().annotatePlatformObject({
      commandId: randomUUID(),
      contentId: receipt.contentId,
      revision: 1,
      quote: "合成资料",
      body: "请补充来源",
    });
    assert.equal(
      (
        await session().listPlatformObjectAnnotations({
          contentId: receipt.contentId,
        })
      )[0]!.annotation.artifactRevision,
      1,
    );
    await fixture.reopen();
    assert.equal(
      (
        await session().readPlatformObject({
          contentId: receipt.contentId,
          revision: 1,
        })
      ).content.kind,
      "interactive",
    );
    assert.equal(
      (
        await session().listPlatformObjectAnnotations({
          contentId: receipt.contentId,
        })
      )[0]!.annotation.artifactRevision,
      1,
    );
    fixture.assertNoLegacyData();
  } finally {
    await fixture.close();
  }
});
test("表单验证字段类型与必填项，不完整草稿可恢复但不能提交", () => {
  const draft = { ...emptyInteractive, rows: [{ id: "a", cells: {} }] };
  assert.equal(interactiveDraftSchema.safeParse(draft).success, true);
  assert.equal(interactiveSchema.safeParse(draft).success, false);
  for (const cells of [
    { name: "记录", value: "不是数字" },
    { name: "记录", done: 2 },
    { name: "记录", secret: "未知字段" },
  ])
    assert.equal(
      interactiveSchema.safeParse({
        ...emptyInteractive,
        rows: [{ id: "a", cells }],
      }).success,
      false,
    );
  assert.equal(
    interactiveSchema.safeParse({ ...emptyInteractive, script: "alert(1)" })
      .success,
    false,
  );
});
