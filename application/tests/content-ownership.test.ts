import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { localAccess, commandSchema } from "../packages/core/src/model.js";
import { emptyScriptDraft } from "../packages/core/src/script-studio.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import {
  createDocument,
  reviseDocument,
} from "../packages/application/src/document-service.js";
import {
  createScriptItem,
  createScriptProduction,
  objectsScriptSourceVerifier,
} from "../packages/application/src/script-production-service.js";
import type { LiveScriptDraft } from "../packages/script-studio/src/store.js";
import { migrateContentLocalState } from "../apps/web/src/content-local-migration.js";
import { applicationStoragePrefix } from "../packages/core/src/application-names.js";

function draft(title: string, text = ""): LiveScriptDraft {
  const { sources: _sources, ...value } = emptyScriptDraft(title);
  return { ...value, text, sources: [] };
}
type Fixture = Awaited<ReturnType<typeof agentDomainFixture>>;
const script = (f: Fixture, projectId: string, title: string) =>
  f.withHuman((actor) =>
    createScriptProduction({
      platform: f.domains.content.platform,
      studio: f.domains.content.studio,
      actor,
      instanceId: f.domains.content.instanceIds.scriptStudio,
      commandId: randomUUID(),
      productionId: randomUUID(),
      projectId,
      title,
    }),
  );
const document = (f: Fixture, projectId: string, markdown = "原作正文") =>
  f.withHuman((actor) =>
    createDocument({
      platform: f.domains.content.platform,
      objects: f.domains.content.objects,
      actor,
      instanceId: f.domains.content.instanceIds.objects,
      commandId: randomUUID(),
      objectId: randomUUID(),
      projectId,
      title: "原作",
      markdown,
    }),
  );
const item = (
  f: Fixture,
  productionId: string,
  value: LiveScriptDraft,
  kind: "episode" | "source" = "episode",
) =>
  f.withHuman((actor) =>
    createScriptItem({
      platform: f.domains.content.platform,
      studio: f.domains.content.studio,
      actor,
      instanceId: f.domains.content.instanceIds.scriptStudio,
      commandId: randomUUID(),
      productionId,
      itemId: randomUUID(),
      expectedActivityRevision: 1,
      kind,
      draft: value,
    }),
  );

test("统一成果目录：剧本与文档只有一份，选择加入项目不搬走工作台、其他成果或交流", async () => {
  const f = await agentDomainFixture();
  try {
    const { deskId } = await f.withHuman((actor) =>
      f.domains.work.service.ensurePersonalSpaces(actor),
    );
    const a = await script(f, deskId, "废火"),
      b = await script(f, deskId, "第二部");
    const episode = await item(
      f,
      a.original.productionId,
      draft("第一集", "原文保持"),
    );
    const doc = await document(f, deskId);
    const before = await f.withHuman((actor) =>
      f.domains.content.studio.readItemVersion({
        credential: actor.credential,
        productionId: a.original.productionId,
        itemId: episode.original.itemId,
      }),
    );
    const messages = structuredClone(f.transport.runtimeState());
    const conversations = await f.withHuman((actor) =>
      f.domains.work.service.listConversations(actor, { projectId: deskId }),
    );
    const cmd = {
      commandId: randomUUID(),
      projectId: "script-owned-project",
      title: "短剧项目",
      contentId: a.contentId,
      expectedRevision: 2,
    };
    const receipt = await f.withHuman((actor) =>
      f.domains.work.service.createProjectForContent(actor, cmd),
    );
    assert.deepEqual(
      await f.withHuman((actor) =>
        f.domains.work.service.createProjectForContent(actor, cmd),
      ),
      receipt,
    );
    const head = await f.withHuman((actor) =>
      f.domains.content.studio.readProductionOverview({
        credential: actor.credential,
        productionId: a.original.productionId,
      }),
    );
    assert.equal(head.projectId, cmd.projectId);
    assert.equal(head.activityRevision, 2);
    assert.deepEqual(
      await f.withHuman((actor) =>
        f.domains.content.studio.readItemVersion({
          credential: actor.credential,
          productionId: a.original.productionId,
          itemId: episode.original.itemId,
        }),
      ),
      before,
    );
    assert.equal(
      (
        await f.withHuman((actor) =>
          f.domains.content.platform.content(actor, b.contentId),
        )
      ).project_id,
      deskId,
    );
    assert.equal(
      (
        await f.withHuman((actor) =>
          f.domains.content.platform.content(actor, doc.contentId),
        )
      ).project_id,
      deskId,
    );
    assert.deepEqual(f.transport.runtimeState(), messages);
    assert.deepEqual(
      await f.withHuman((actor) =>
        f.domains.work.service.listConversations(actor, { projectId: deskId }),
      ),
      conversations,
    );
    assert.equal(
      (
        await f.withHuman((actor) =>
          f.domains.work.service.getProject(actor, { projectId: deskId }),
        )
      ).kind,
      "desk",
    );
    assert.equal(
      (
        await f.withHuman((actor) =>
          f.domains.work.service.listContent(actor, { limit: 50 }),
        )
      ).length,
      3,
    );
    await f.withHuman((actor) =>
      f.domains.work.service.moveContent(actor, {
        commandId: randomUUID(),
        contentId: b.contentId,
        expectedRevision: 1,
        targetProjectId: cmd.projectId,
      }),
    );
    const after = await f.withHuman((actor) =>
      f.domains.work.service.listContent(actor, { limit: 50 }),
    );
    assert.equal(
      after.filter((entry) => entry.projectId === cmd.projectId).length,
      2,
    );
    assert.equal(new Set(after.map((entry) => entry.id)).size, 3);
    await assert.rejects(
      f.withHuman((actor) =>
        f.domains.work.service.createProjectForContent(actor, {
          ...cmd,
          commandId: randomUUID(),
          projectId: "must-not-be-created",
        }),
      ),
      /已变化/,
    );
    await assert.rejects(
      f.withHuman((actor) =>
        f.domains.work.service.getProject(actor, {
          projectId: "must-not-be-created",
        }),
      ),
      /不存在|访问/,
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("删除错误创建路径和工作台转换操作，不保留别名；项目与未归项目是内容仅有的归属", async () => {
  const f = await agentDomainFixture();
  try {
    const { dialogueId, inboxId } = await f.withHuman((actor) =>
      f.domains.work.service.ensurePersonalSpaces(actor),
    );
    for (const projectId of [dialogueId, inboxId]) {
      await assert.rejects(
        document(f, projectId),
        /不能存入对话或事项|内容只能/,
      );
      await assert.rejects(
        script(f, projectId, "不应写入"),
        /不能存入对话或事项|内容只能/,
      );
    }
    assert.equal(
      commandSchema.safeParse({
        commandId: randomUUID(),
        operation: {
          type: "save-workspace-as-project",
          workspaceId: "obsolete-desk",
          title: "旧操作",
        },
      }).success,
      false,
    );
    assert.equal(
      commandSchema.safeParse({
        commandId: randomUUID(),
        operation: {
          type: "organize-content",
          artifactId: "old",
          expectedRevision: 1,
          changes: { title: "旧签名" },
        },
      }).success,
      false,
    );
  } finally {
    await f.close();
  }
});

test("归属修改保留固定原作引用，权限边界一旦改变则停止读取；不能借整理扩大共享", async () => {
  const other = { principalId: "other", actantId: "other-human" };
  const f = await agentDomainFixture({ additionalHumans: [other] });
  try {
    const { deskId } = await f.withHuman((actor) =>
      f.domains.work.service.ensurePersonalSpaces(actor),
    );
    const a = await script(f, deskId, "改编");
    const source = await document(f, deskId, "准确原文");
    const ref = {
      appId: "morphz.objects",
      instanceId: f.domains.content.instanceIds.objects,
      objectId: source.original.objectId,
      versionRef: "1",
      quote: "准确原文",
    };
    const original = await item(
      f,
      a.original.productionId,
      { ...draft("原作"), sources: [ref] },
      "source",
    );
    const move = {
      commandId: randomUUID(),
      projectId: "adaptation-project",
      title: "改编项目",
      contentId: a.contentId,
      expectedRevision: 2,
    };
    await f.withHuman((actor) =>
      f.domains.work.service.createProjectForContent(actor, move),
    );
    const read = () =>
      f.withHuman((actor) =>
        f.domains.content.studio.readItemVersion({
          credential: actor.credential,
          productionId: a.original.productionId,
          itemId: original.original.itemId,
        }),
      );
    assert.deepEqual((await read()).draft.sources, [ref]);
    const verifier = objectsScriptSourceVerifier(
      f.domains.content.platform,
      f.domains.content.objects,
      f.domains.content.instanceIds.objects,
    );
    const verify = () =>
      f.withHuman(async (actor) => {
        const grant =
          await f.domains.content.platform.authorizeApplicationObject(
            actor,
            f.domains.content.instanceIds.scriptStudio,
            "morphz.script-studio",
            a.original.productionId,
            "read",
          );
        return verifier({
          credential: actor.credential,
          tenantId: grant.tenantId,
          principalId: grant.principalId,
          actantId: grant.actantId,
          kind: grant.kind,
          runtimeInputId: grant.runtimeInputId,
          runtimeTaskRunEventId: grant.runtimeTaskRunEventId,
          productionProjectId: grant.projectId,
          alreadyPinned: true,
          ...ref,
        });
      });
    assert.equal(await verify(), true);
    await f.withHuman((actor) =>
      reviseDocument({
        platform: f.domains.content.platform,
        objects: f.domains.content.objects,
        actor,
        instanceId: f.domains.content.instanceIds.objects,
        commandId: randomUUID(),
        objectId: source.original.objectId,
        expectedRevision: 1,
        title: "原作",
        markdown: "最新正文不能冒充固定引用",
      }),
    );
    assert.equal(await verify(), true);
    assert.equal((await read()).draft.sources[0]!.versionRef, "1");
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
          projectIds: [f.projectId, move.projectId],
        },
        { ...other, enabled: true, projectIds: [move.projectId] },
      ],
    );
    assert.equal(await verify(), false);
    await assert.rejects(
      f.withHuman((actor) =>
        f.domains.work.service.moveContent(actor, {
          commandId: randomUUID(),
          contentId: a.contentId,
          expectedRevision: 3,
          targetProjectId: f.projectId,
        }),
      ),
      /成员不同/,
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("成果归属重启保持：正文/版本/输入/会话/回执不重放，重开只使用已提交归属", async () => {
  const f = await agentDomainFixture();
  try {
    const { deskId } = await f.withHuman((actor) =>
      f.domains.work.service.ensurePersonalSpaces(actor),
    );
    const p = await script(f, deskId, "持久剧本");
    const episode = await item(
      f,
      p.original.productionId,
      draft("第一集", "历史正文"),
    );
    const a = await document(f, deskId, "逐字保留");
    const move = {
      commandId: randomUUID(),
      contentId: p.contentId,
      targetProjectId: f.projectId,
      expectedRevision: 2,
    };
    const receipt = await f.withHuman((actor) =>
      f.domains.work.service.moveContent(actor, move),
    );
    const read = () =>
      f.withHuman(async (actor) => ({
        catalog: await f.domains.work.service.listContent(actor, { limit: 50 }),
        draft: await f.domains.content.studio.readItemVersion({
          credential: actor.credential,
          productionId: p.original.productionId,
          itemId: episode.original.itemId,
        }),
        original: await f.domains.content.objects.readDocument({
          credential: actor.credential,
          objectId: a.original.objectId,
          revision: 1,
        }),
        conversations: await f.domains.work.service.listConversations(actor, {
          projectId: f.projectId,
        }),
      }));
    const before = await read();
    const pendingInputEvidence = structuredClone(
      f.transport.serviceState("fixture-input-execution"),
    );
    await f.reopen();
    assert.deepEqual(await read(), before);
    assert.deepEqual(
      f.transport.serviceState("fixture-input-execution"),
      pendingInputEvidence,
    );
    assert.equal(
      await f.withHuman((actor) =>
        f.domains.work.service.moveContent(actor, move),
      ),
      receipt,
    );
    await f.reopen();
    assert.deepEqual(await read(), before);
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("剧本草稿一次性采用稳定内容 ID，改变项目不会重建草稿或回退到旧键", () => {
  const prefix = `${applicationStoragePrefix}center:owner:`;
  const old = prefix + "draft:window:script:old-project:production:item:v1";
  const next = prefix + "draft:window:script:production:item:v1";
  const values = new Map([
    [old, '{"text":"未保存原文"}'],
    [old.replace(/v1$/, "base"), "1"],
    [
      `${applicationStoragePrefix}other:owner:draft:window:script:private:production:item:v1`,
      "私有草稿",
    ],
  ]);
  const storage = {
    get length() {
      return values.size;
    },
    key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
  };
  migrateContentLocalState(storage, "center", "owner");
  assert.equal(values.get(next), values.get(old));
  assert.equal(values.get(next.replace(/v1$/, "base")), "1");
  values.set(next, "最新草稿");
  values.set(old, "旧记录不能再覆盖");
  migrateContentLocalState(storage, "center", "owner");
  assert.equal(values.get(next), "最新草稿");
  assert.equal(
    values.has(
      `${applicationStoragePrefix}other:owner:draft:window:script:production:item:v1`,
    ),
    false,
  );
});
