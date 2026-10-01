import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import { viewModelFixture } from "./view-model-fixture.js";
import { localAccess } from "../packages/core/src/model.js";
import { searchContent } from "../packages/application/src/content-search-service.js";
import {
  createDocument,
  renameObject,
} from "../packages/application/src/document-service.js";
import {
  contentOrigin,
  relatedContentTasks,
} from "../apps/web/src/content-catalog.js";
test("Agent 代表 Human 创作时来源显示 Agent，不误认另一位 Human", () => {
  const actors = viewModelFixture().state.actants;
  assert.equal(
    contentOrigin(
      { createdBy: { principalId: "local-owner", actantId: "morphz-agent" } },
      actors,
    ),
    "Morphz生成",
  );
  assert.equal(
    contentOrigin(
      { createdBy: { principalId: "other", actantId: "local-human" } },
      actors,
    ),
    "作者未知",
  );
});

test("内容整理同一对象：CAS、幂等、可撤销归属，正文/旧版本/输入不改写，索引沿用来源", async () => {
  const f = await agentDomainFixture();
  try {
    const { deskId } = await f.withHuman((actor) =>
      f.domains.work.service.ensurePersonalSpaces(actor),
    );
    const route = f.input(deskId);
    const { contentId: id } = await f.call<{ contentId: string }>(
      {
        action: "create-document",
        title: "原始名称",
        markdown: "唯一正文词 合成资料",
      },
      route,
    );
    const entry = await f.withHuman((actor) =>
      f.domains.content.platform.content(actor, id),
    );
    const original = await f.withHuman((actor) =>
      f.domains.content.objects.readObject({
        credential: actor.credential,
        objectId: entry.app_object_id,
        revision: 1,
      }),
    );
    const before = structuredClone(f.transport.runtimeState());
    const command = f.envelope(
      {
        action: "organize-content",
        content: { kind: "artifact", id },
        revision: 1,
        metadata: { title: "改名但不是新文件" },
      },
      route,
    );
    const receipt = await f.tools.call(command);
    assert.deepEqual(await f.tools.call(command), receipt);
    const move = {
      commandId: randomUUID(),
      contentId: id,
      targetProjectId: f.projectId,
      expectedRevision: 2,
    };
    await f.withHuman((actor) =>
      f.domains.work.service.moveContent(actor, move),
    );
    const renamed = await f.withHuman((actor) =>
      f.domains.content.platform.content(actor, id),
    );
    assert.equal(renamed.revision, 3);
    assert.equal(renamed.app_object_id, entry.app_object_id);
    const version = await f.withHuman((actor) =>
      f.domains.content.objects.readObject({
        credential: actor.credential,
        objectId: entry.app_object_id,
        revision: 1,
      }),
    );
    assert.deepEqual(version.content, original.content);
    assert.deepEqual(version.author, original.author);
    assert.equal(version.title, original.title);
    assert.equal(version.createdAt, original.createdAt);
    assert.equal(version.revision, 1);
    assert.equal(version.headRevision, 2);
    assert.equal(version.projectId, f.projectId);
    const searched = await f.withHuman((actor) =>
      searchContent(
        {
          platform: f.domains.content.platform,
          objects: f.domains.content.objects,
          work: f.domains.work.service,
          objectsInstanceId: f.domains.content.instanceIds.objects,
          provider: f.domains.content.provider,
        },
        actor,
        { query: "唯一正文词" },
      ),
    );
    // Body search names the app's immutable version, not a directory move.
    assert.equal(searched.hits[0]?.revision, 2);
    assert.equal(searched.hits[0]?.projectId, f.projectId);
    await assert.rejects(
      f.withHuman((actor) =>
        f.domains.work.service.moveContent(actor, {
          ...move,
          commandId: randomUUID(),
          expectedRevision: 1,
        }),
      ),
      /已变化/,
    );
    await f.withHuman((actor) =>
      renameObject({
        platform: f.domains.content.platform,
        objects: f.domains.content.objects,
        actor,
        instanceId: f.domains.content.instanceIds.objects,
        commandId: randomUUID(),
        objectId: entry.app_object_id,
        expectedCatalogRevision: 3,
        title: original.title,
      }),
    );
    await f.withHuman((actor) =>
      f.domains.work.service.moveContent(actor, {
        commandId: randomUUID(),
        contentId: id,
        targetProjectId: deskId,
        expectedRevision: 4,
      }),
    );
    assert.equal(
      (
        await f.withHuman((actor) =>
          f.domains.content.platform.content(actor, id),
        )
      ).project_id,
      deskId,
    );
    assert.deepEqual(f.transport.runtimeState(), before);
    assert.equal(
      (
        await f.withHuman((actor) =>
          f.domains.work.service.listContent(actor, { limit: 50 }),
        )
      ).length,
      1,
    );
    const imported = await f.withHuman((actor) =>
      createDocument({
        platform: f.domains.content.platform,
        objects: f.domains.content.objects,
        actor,
        instanceId: f.domains.content.instanceIds.objects,
        commandId: randomUUID(),
        objectId: randomUUID(),
        projectId: f.projectId,
        relativePath: "外部.md",
        title: "外部副本",
        markdown: "外部不索引",
      }),
    );
    await f.withHuman((actor) =>
      renameObject({
        platform: f.domains.content.platform,
        objects: f.domains.content.objects,
        actor,
        instanceId: f.domains.content.instanceIds.objects,
        commandId: randomUUID(),
        objectId: imported.original.objectId,
        expectedCatalogRevision: 1,
        title: "仍是外部副本",
      }),
    );
    const importedSearch = await f.withHuman((actor) =>
      searchContent(
        {
          platform: f.domains.content.platform,
          objects: f.domains.content.objects,
          work: f.domains.work.service,
          objectsInstanceId: f.domains.content.instanceIds.objects,
          provider: f.domains.content.provider,
        },
        actor,
        { query: "外部不索引" },
      ),
    );
    assert.equal(importedSearch.total, 0);
    assert.equal(
      contentOrigin(
        { createdBy: original.author },
        viewModelFixture().state.actants,
      ),
      "Morphz生成",
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("整理不越过成员与对象关联边界，失败不改写；目录不猜测事项关系", async () => {
  const other = { principalId: "other", actantId: "other-human" };
  const f = await agentDomainFixture({ additionalHumans: [other] });
  try {
    const { contentId: id } = await f.call<{ contentId: string }>({
      action: "create-document",
      title: "原始名称",
      markdown: "原文",
    });
    const targetProjectId = "different-audience";
    await f.withHuman((actor) =>
      f.domains.work.service.createProject(actor, {
        commandId: randomUUID(),
        projectId: targetProjectId,
        title: "不同成员",
      }),
    );
    await f.identity!.replaceConfiguration(
      {
        version: 1,
        members: [localAccess, other].map((human) => ({
          ...human,
          loginTokenHash: createHash("sha256")
            .update(`synthetic-login-${human.principalId}`)
            .digest("hex"),
          enabled: true,
        })),
      },
      [
        {
          ...localAccess,
          enabled: true,
          projectIds: [f.projectId, targetProjectId],
        },
        { ...other, enabled: true, projectIds: [targetProjectId] },
      ],
    );
    const before = await f.withHuman((actor) =>
      f.domains.content.platform.content(actor, id),
    );
    const move = {
      commandId: randomUUID(),
      contentId: id,
      targetProjectId,
      expectedRevision: 1,
    };
    await assert.rejects(
      f.withHuman((actor) => f.domains.work.service.moveContent(actor, move)),
      /成员不同/,
    );
    assert.deepEqual(
      await f.withHuman((actor) =>
        f.domains.content.platform.content(actor, id),
      ),
      before,
    );
    await assert.rejects(
      f.domains.work.authority.withSession(
        other,
        () => {},
        (actor) => f.domains.work.service.moveContent(actor, move),
      ),
      /访问|权限|成员/,
    );
    const { contentId: related } = await f.call<{ contentId: string }>({
      action: "create-document",
      title: "被引用文档",
      markdown: "关联",
    });
    await f.withHuman((actor) =>
      f.domains.work.service.linkWork(actor, {
        commandId: randomUUID(),
        fromId: id,
        toId: related,
        kind: "references",
      }),
    );
    const { deskId } = await f.withHuman((actor) =>
      f.domains.work.service.ensurePersonalSpaces(actor),
    );
    await assert.rejects(
      f.withHuman((actor) =>
        f.domains.work.service.moveContent(actor, {
          ...move,
          commandId: randomUUID(),
          targetProjectId: deskId,
        }),
      ),
      /关联/,
    );
    await f.call({
      action: "organize-content",
      content: { kind: "artifact", id },
      revision: 1,
      metadata: { title: "有关联仍可重命名" },
    });
    // Pure render projection: a references edge never becomes a produces task.
    const view = viewModelFixture();
    const a = view.seedArtifact({
      projectId: "first-project",
      title: "原文",
      content: { kind: "document", markdown: "原文" },
    }).id;
    const b = view.seedArtifact({
      projectId: "first-project",
      title: "引用",
      content: { kind: "document", markdown: "引用" },
    }).id;
    view.seedRelation({
      fromId: a,
      toId: b,
      type: "references",
    });
    assert.equal(
      relatedContentTasks(
        view.state.artifacts.find((entry) => entry.id === a)!,
        view.state.artifacts,
        view.state.relations,
      ).length,
      0,
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("Agent 与 Human 共用真实内容整理、稳定回执和游标排序；工具不能扩大项目授权", async () => {
  const f = await agentDomainFixture();
  try {
    const created = await f.call<{ contentId: string }>({
      action: "create-document",
      title: "原始名称",
      markdown: "唯一正文词 合成资料",
    });
    const id = created.contentId;
    const command = f.envelope({
      action: "organize-content",
      content: { kind: "artifact", id },
      revision: 1,
      metadata: { title: "Agent 改名" },
    });
    const receipt = await f.tools.call(command);
    assert.deepEqual(await f.tools.call(command), receipt);
    const entry = await f.withHuman((actor) =>
      f.domains.content.platform.content(actor, id),
    );
    assert.equal(entry.revision, 2);
    const original = await f.withHuman((actor) =>
      f.domains.content.objects.readObject({
        credential: actor.credential,
        objectId: entry.app_object_id,
        revision: 1,
      }),
    );
    assert.deepEqual(original.content, {
      kind: "document",
      markdown: "唯一正文词 合成资料",
    });
    assert.equal(original.author.actantId, "morphz-agent");
    await assert.rejects(
      f.call({
        action: "organize-content",
        content: { kind: "artifact", id },
        revision: 2,
        metadata: { projectId: "ungranted-project" },
      }),
      /无权访问这个项目/,
    );
    await assert.rejects(
      f.call({
        action: "organize-content",
        content: { kind: "artifact", id },
        revision: 1,
        metadata: { title: "冲突" },
      }),
      /已变化/,
    );
    await f.call({
      action: "create-document",
      title: "第二份",
      markdown: "新正文",
    });
    type Page = {
      items: { id: string; title: string; kind: string; revision: number }[];
      nextCursor: unknown;
    };
    const first = await f.call<Page>({ action: "list", limit: 1 });
    assert.ok(first.nextCursor);
    const second = await f.call<Page>({
      action: "list",
      limit: 1,
      cursor: first.nextCursor,
    });
    const actual = await f.withHuman((actor) =>
      f.domains.work.service.listContent(actor, {
        projectId: f.projectId,
        limit: 50,
      }),
    );
    assert.deepEqual(
      [...first.items, ...second.items].map((a) => a.id),
      actual.map((a) => a.id),
    );
    assert.ok(actual.every((a) => a.kind !== "task"));
    assert.equal(second.items[0]!.title, "Agent 改名");
    assert.equal(second.items[0]!.revision, 2);
    await f.reopen();
    assert.deepEqual(await f.tools.call(command), receipt);
    assert.equal(
      (await f.call<Page>({ action: "list", limit: 50 })).items.length,
      2,
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});
