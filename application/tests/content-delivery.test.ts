import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  AgentTools,
  workToolDefinitions,
} from "../packages/application/src/agent-tools.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { emptyInteractive } from "../packages/core/src/interactive.js";
import { localAccess } from "../packages/core/src/model.js";

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

test("真实工具仍可交付 Markdown 报告与表格；旧统计布局、人改版本和重试保护保持", () => {
  const store = new WorkspaceStore(":memory:");
  const tools = new AgentTools(store, "test-token", () => ({
    projectId: "first-project",
    access: { principalId: "morphz-service", actantId: "morphz-agent" },
  }));
  const envelope = (args: unknown) => ({
    protocol: 1 as const,
    tool: "host_morphz",
    invocation: {
      job_id: randomUUID(),
      tool_call_id: randomUUID(),
      session_id: "s",
      context_id: "c",
      principal_id: "p",
      agent_id: "a",
      target_id: "local",
      thread_id: "t",
    },
    arguments: args,
  });
  const read = (id: string) =>
    store.snapshot().artifacts.find((a) => a.id === id)!;
  try {
    const markdown =
      "# 报价分析\n\n| 供应商 | 报价 |\n| --- | --- |\n| 甲 | 120 |\n| 乙 | 150 |\n\n甲比乙低 30；这只是报价比较。";
    const report = tools.call(
      envelope({
        action: "create-document",
        title: "报价分析报告",
        markdown,
      }),
    ) as { artifactId: string };
    assert.equal(read(report.artifactId).content.kind, "document");
    assert.deepEqual(read(report.artifactId).content, {
      kind: "document",
      markdown,
    });
    const table = {
      ...structuredClone(emptyInteractive),
      layout: "report" as const,
      rows: [{ id: "r1", cells: { name: "甲", value: 120 } }],
    };
    const created = tools.call(
      envelope({
        action: "create-interactive",
        title: "持续维护的报价",
        interactive: table,
      }),
    ) as { artifactId: string };
    const original = read(created.artifactId);
    store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "revise-artifact",
          artifactId: original.id,
          expectedRevision: 1,
          title: original.title,
          content: {
            ...table,
            rows: [{ id: "r1", cells: { name: "甲", value: 110 } }],
          },
        },
      },
      localAccess,
    );
    assert.throws(
      () =>
        tools.call(
          envelope({
            action: "revise-interactive",
            artifactId: original.id,
            revision: 1,
            title: original.title,
            interactive: table,
          }),
        ),
      /新版本/,
    );
    const current = read(original.id);
    const update = envelope({
      action: "revise-interactive",
      artifactId: original.id,
      revision: 2,
      title: original.title,
      interactive: { ...current.content, layout: "form" },
    });
    assert.deepEqual(tools.call(update), tools.call(update));
    const result = read(original.id);
    assert.equal(result.revision, 3);
    assert.deepEqual(result.versions[0], original.versions[0]);
    assert.deepEqual(result.content, { ...current.content, layout: "form" });
    assert.equal(store.snapshot().artifacts.length, 2);
  } finally {
    store.close();
  }
});
