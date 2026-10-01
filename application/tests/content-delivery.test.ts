import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { workToolDefinitions } from "../packages/application/src/agent-tools.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import { reviseInteractive } from "../packages/application/src/document-service.js";
import { emptyInteractive } from "../packages/core/src/interactive.js";

test("两种 Host 名称具有相同的交付边界；报告默认文档，表格统计不冒充分析或文件", () => {
  assert.equal(workToolDefinitions.length, 2);
  assert.ok(
    workToolDefinitions[1]!.description.endsWith(
      workToolDefinitions[0]!.description,
    ),
  );
  for (const { description } of workToolDefinitions) {
    assert.match(
      description,
      /Written reports, analysis, explanations and one-off comparisons default to create-document\/revise-document with Markdown/,
    );
    assert.match(description, /only for records that need ongoing maintenance/);
    assert.match(
      description,
      /report = numeric statistics.*NOT a written or analytical report/,
    );
    assert.match(
      description,
      /first verify that the available tools can actually produce it/,
    );
    assert.match(
      description,
      /Do not create separate artifacts for these views/,
    );
  }
});

test("真实 Agent 与 Human 共用 Objects 文档和表格；视图、人改版本、重开与幂等保护", async () => {
  const fixture = await agentDomainFixture();
  try {
    const markdown =
      "# 报价分析\n\n| 供应商 | 报价 |\n| --- | --- |\n| 甲 | 120 |\n| 乙 | 150 |\n\n甲比乙低 30；这只是报价比较。";
    const report = await fixture.call<{ contentId: string }>({
      action: "create-document",
      title: "报价分析报告",
      markdown,
    });
    const reportRead = await fixture.call<{ objectId: string }>({
      action: "read",
      artifactId: report.contentId,
    });
    const reportOriginal = await fixture.withHuman((actor) =>
      fixture.domains.content.objects.readObject({
        credential: actor.credential,
        objectId: reportRead.objectId,
      }),
    );
    assert.deepEqual(reportOriginal.content, { kind: "document", markdown });
    const table = {
      ...structuredClone(emptyInteractive),
      layout: "report" as const,
      rows: [{ id: "r1", cells: { name: "甲", value: 120 } }],
    };
    const created = await fixture.call<{ contentId: string }>({
      action: "create-interactive",
      title: "持续维护的报价",
      interactive: table,
    });
    const read = () =>
      fixture.call<{
        objectId: string;
        revision: number;
        title: string;
        interactive: typeof table;
      }>({ action: "read", artifactId: created.contentId });
    const original = await read();
    const humanTable = {
      ...table,
      rows: [{ id: "r1", cells: { name: "甲", value: 110 } }],
    };
    await fixture.withHuman((actor) =>
      reviseInteractive({
        ...fixture.domains.content,
        actor,
        instanceId: fixture.domains.content.instanceIds.objects,
        commandId: randomUUID(),
        objectId: original.objectId,
        expectedRevision: 1,
        title: original.title,
        content: humanTable,
      }),
    );
    await assert.rejects(
      fixture.call({
        action: "revise-interactive",
        artifactId: created.contentId,
        revision: 1,
        title: original.title,
        interactive: table,
      }),
      /版本|修订/,
    );
    const current = await read();
    assert.equal(current.revision, 2);
    assert.deepEqual(current.interactive, humanTable);
    const updated = { ...humanTable, layout: "form" as const };
    const update = fixture.envelope({
      action: "revise-interactive",
      artifactId: created.contentId,
      revision: 2,
      title: original.title,
      interactive: updated,
    });
    const receipt = await fixture.tools.call(update);
    assert.deepEqual(await fixture.tools.call(update), receipt);
    await fixture.reopen();
    assert.deepEqual(await fixture.tools.call(update), receipt);
    const result = await read();
    assert.equal(result.revision, 3);
    assert.deepEqual(result.interactive, updated);
    const first = await fixture.withHuman((actor) =>
      fixture.domains.content.objects.readObject({
        credential: actor.credential,
        objectId: original.objectId,
        revision: 1,
      }),
    );
    assert.deepEqual(first.content, table);
    const history = await fixture.withHuman((actor) =>
      fixture.domains.content.objects.listObjectVersions({
        credential: actor.credential,
        objectId: original.objectId,
      }),
    );
    assert.equal(history.versions.length, 3);
    assert.equal(
      (await fixture.call<{ items: unknown[] }>({ action: "list" })).items
        .length,
      2,
    );
    fixture.assertNoLegacyData();
  } finally {
    await fixture.close();
  }
});
