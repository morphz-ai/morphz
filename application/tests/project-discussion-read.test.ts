import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import { createDocument } from "../packages/application/src/document-service.js";

test("项目讨论读取真实项目名、Human 目录与按需正文，不把文件注入原输入或越过项目", async () => {
  const f = await agentDomainFixture();
  try {
    const original = await f.readAcceptedInput(f.route);
    await f.withHuman((actor) =>
      f.domains.work.service.renameProject(actor, {
        commandId: randomUUID(),
        projectId: f.projectId,
        expectedRevision: 1,
        title: "TEST 深海科普计划",
      }),
    );
    const originalText =
      "本项目面向中学生讲解深海生态。\n" + "仅在读取正文时出现。".repeat(100);
    const document = await f.withHuman((actor) =>
      createDocument({
        actor,
        platform: f.domains.content.platform,
        objects: f.domains.content.objects,
        instanceId: f.domains.content.instanceIds.objects,
        commandId: randomUUID(),
        objectId: randomUUID(),
        projectId: f.projectId,
        title: "项目说明",
        markdown: originalText,
      }),
    );
    const input = await f.call<{
      input: unknown;
      project: { id: string; title: string; revision: number };
    }>({ action: "read-input" });
    assert.deepEqual(input.input, original);
    assert.deepEqual(input.project, {
      id: f.projectId,
      title: "TEST 深海科普计划",
      revision: 2,
    });
    const workflow = await f.call<{ project: unknown; body: string }>({
      action: "script",
      script: { action: "read-workflow" },
    });
    assert.deepEqual(workflow.project, input.project);
    assert.equal(workflow.body, original.text);
    const catalog = await f.call<{
      items: { id: string; title: string; versionRef: string }[];
    }>({ action: "list", limit: 1 });
    assert.equal(catalog.items.length, 1);
    assert.equal(catalog.items[0]!.title, "项目说明");
    assert.doesNotMatch(
      JSON.stringify({ input, workflow, catalog }),
      /仅在读取正文时出现/,
    );
    const read = await f.call<{ text: string; hasMore: boolean }>({
      action: "read",
      artifactId: catalog.items[0]!.id,
      revision: 1,
      offset: 0,
      limit: 24,
    });
    assert.equal(read.text, originalText.slice(0, 24));
    assert.equal(read.hasMore, true);
    const otherId = randomUUID();
    await f.withHuman((actor) =>
      f.domains.work.service.createProject(actor, {
        commandId: randomUUID(),
        projectId: otherId,
        title: "另一个项目",
      }),
    );
    await assert.rejects(
      f.call(
        { action: "read", artifactId: catalog.items[0]!.id, revision: 1 },
        f.input(otherId),
      ),
      /项目|范围|访问/,
    );
    assert.equal(
      (await f.call<{ items: unknown[] }>({ action: "list" })).items.length,
      1,
    );
    assert.ok(document);
  } finally {
    await f.close();
  }
});
