import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { localAccess, morphzAgentAccess } from "../packages/core/src/model.js";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import {
  applicationManifestSchema,
  applicationDescription,
  parseApplicationViewState,
  objectsApplication,
} from "../packages/core/src/applications.js";
import { emptyScriptDraft } from "../packages/core/src/script-studio.js";

const app = applicationManifestSchema.parse({
  format: "morphz-app/v1",
  id: "test.notes",
  version: "1.0.0",
  title: "测试应用",
  description: "仅验证宿主协议",
  icon: "book",
  permissions: ["artifacts.read", "artifacts.write", "input.compose"],
  harness: { id: "test-harness", version: "1.0.0" },
  ui: { type: "sandbox", html: "<!doctype html><p>App</p>" },
});
test("旧便笺的启动台说明使用日常语言，不改包、状态或第三方应用说明", () => {
  const description = "宿主协议示例：独立界面、状态恢复、保存对象与协作输入。";
  const legacy = {
    ...app,
    format: "morphz-work-app/v1" as const,
    id: "example.scratchpad",
    description,
  };
  const before = JSON.stringify(legacy);
  assert.equal(
    applicationDescription(legacy),
    "记下想法，保存为文档，或交给 Morphz 继续整理。",
  );
  assert.equal(JSON.stringify(legacy), before);
  assert.equal(applicationDescription({ ...app, description }), description);
  assert.equal(
    applicationDescription({ ...legacy, description: "自定义说明" }),
    "自定义说明",
  );
});
test("第三方窗口状态只保存导航，不接管应用正文和草稿", () => {
  assert.deepEqual(
    parseApplicationViewState("test.notes", {
      view: "outline",
      artifactId: "doc-1",
    }),
    { view: "outline", artifactId: "doc-1" },
  );
  assert.deepEqual(
    parseApplicationViewState("test.notes", { artifactId: null }),
    {
      artifactId: null,
    },
  );
  assert.deepEqual(
    parseApplicationViewState(objectsApplication.id, { artifactId: null }),
    {
      artifactId: null,
    },
  );
  assert.throws(() =>
    parseApplicationViewState("test.notes", { note: "私有便笺" }),
  );
  assert.throws(() =>
    parseApplicationViewState("morphz.reader", { body: "书籍正文" }),
  );
  assert.deepEqual(
    parseApplicationViewState("morphz.script-studio", {
      view: "editor",
      scriptTarget: { productionId: "script-1", itemId: "scene-1" },
    }),
    {
      view: "editor",
      scriptTarget: { productionId: "script-1", itemId: "scene-1" },
    },
  );
});
test("便笺示例的内嵌脚本可以运行", () => {
  const source = readFileSync(
    new URL("../examples/applications/scratchpad.json", import.meta.url),
    "utf8",
  );
  const manifest = applicationManifestSchema.parse(JSON.parse(source));
  assert.equal(manifest.ui.type, "sandbox");
  if (manifest.ui.type !== "sandbox") return;
  const script = manifest.ui.html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Script(script));
});
test("显式内容列表与应用恢复分开；原窗口、其他导航状态、权限和重试保持", async () => {
  const f = await platformRuntimeHostFixture();
  try {
    const spaces = await f.session().ensurePlatformSpaces();
    const document = await f.session().createPlatformDocument({
      commandId: randomUUID(),
      objectId: "list-document",
      projectId: spaces.deskId,
      title: "TEST 列表入口",
      markdown: "原文不变",
    });
    const launch = (state: Record<string, unknown>) => ({
      commandId: randomUUID(),
      projectId: spaces.deskId,
      appId: objectsApplication.id,
      packageVersion: objectsApplication.version,
      state,
    });
    const view = await f
      .session()
      .launchPlatformAppView(launch({ artifactId: document.contentId }));
    const saved = await f.session().savePlatformAppView({
      commandId: randomUUID(),
      viewId: view.id,
      expectedRevision: view.revision,
      state: { artifactId: document.contentId, navigationId: "page-3" },
    });
    const reopened = await f.session().launchPlatformAppView(launch({}));
    assert.equal(reopened.id, view.id);
    assert.deepEqual(reopened.state, {
      artifactId: document.contentId,
      navigationId: "page-3",
    });
    const request = launch({ artifactId: null });
    const cleared = await f.session().launchPlatformAppView(request);
    assert.deepEqual(await f.session().launchPlatformAppView(request), cleared);
    assert.deepEqual(cleared.state, {
      artifactId: null,
      navigationId: "page-3",
    });
    await f.session().closePlatformAppView({
      commandId: randomUUID(),
      viewId: view.id,
      expectedRevision: cleared.revision,
    });
    const active = await f
      .session()
      .launchPlatformAppView(launch({ artifactId: null }));
    assert.equal(active.id, view.id);
    assert.equal(active.status, "open");
    assert.deepEqual(active.state, {
      artifactId: null,
      navigationId: "page-3",
    });
    assert.equal((await f.session().listPlatformAppViews()).length, 1);
    assert.equal(
      (
        await f
          .session()
          .readPlatformDocument({ contentId: document.contentId, revision: 1 })
      ).markdown,
      "原文不变",
    );
    assert.equal((await f.session().listPlatformContent({})).length, 1);
    await assert.rejects(
      f
        .session({ principalId: "not-a-member", actantId: "not-a-member" })
        .launchPlatformAppView(launch({ artifactId: null })),
      { code: "forbidden" },
    );
    await assert.rejects(
      f.session().savePlatformAppView({
        commandId: randomUUID(),
        viewId: view.id,
        expectedRevision: saved.revision,
        state: {},
      }),
      /已变化/,
    );
    await f.reopen();
    assert.deepEqual(
      (await f.session().listPlatformAppViews())[0]!.state,
      active.state,
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("将选中剧本归入新项目，只改目录归属；其他原件与窗口不移动，重启不复制", async () => {
  const f = await platformRuntimeHostFixture();
  try {
    const spaces = await f.session().ensurePlatformSpaces();
    const document = await f.session().createPlatformDocument({
      commandId: randomUUID(),
      objectId: "unrelated-document",
      projectId: spaces.deskId,
      title: "第一章",
      markdown: "不能丢失的正文",
    });
    const view = await f.session().launchPlatformAppView({
      commandId: randomUUID(),
      projectId: spaces.deskId,
      appId: objectsApplication.id,
      packageVersion: objectsApplication.version,
      state: { artifactId: document.contentId, navigationId: "page-4" },
    });
    const productions = [];
    for (const title of ["雨中的电台", "远方的来信"]) {
      const script = await f.session().createPlatformScript({
        commandId: randomUUID(),
        productionId: `script_${randomUUID().replaceAll("-", "")}`,
        projectId: spaces.deskId,
        title,
      });
      const overview = await f
        .session()
        .readPlatformScript({ contentId: script.contentId });
      const { sources: _legacy, ...draft } = emptyScriptDraft("第一集");
      await f.session().createPlatformScriptItem({
        commandId: randomUUID(),
        contentId: script.contentId,
        itemId: `episode_${randomUUID().replaceAll("-", "")}`,
        expectedActivityRevision: overview.activityRevision,
        kind: "episode",
        draft: { ...draft, sources: [], text: `${title}的原文` },
      });
      productions.push(script);
    }
    const original = await f
      .session()
      .readPlatformScriptSnapshot({ contentId: productions[0]!.contentId });
    const unrelated = await f
      .session()
      .readPlatformScriptSnapshot({ contentId: productions[1]!.contentId });
    const entry = await f
      .session()
      .getPlatformContent({ contentId: productions[0]!.contentId });
    const request = {
      commandId: randomUUID(),
      projectId: "created-for-content",
      title: "长篇小说",
      contentId: productions[0]!.contentId,
      expectedRevision: entry.revision,
    };
    await f.session().createPlatformProjectForContent(request);
    await f.session().createPlatformProjectForContent(request);
    assert.equal(
      (
        await f
          .session()
          .getPlatformContent({ contentId: productions[0]!.contentId })
      ).projectId,
      request.projectId,
    );
    assert.deepEqual(
      (
        await f
          .session()
          .readPlatformScriptSnapshot({ contentId: productions[0]!.contentId })
      ).items,
      original.items,
    );
    assert.deepEqual(
      await f
        .session()
        .readPlatformScriptSnapshot({ contentId: productions[1]!.contentId }),
      unrelated,
    );
    assert.deepEqual((await f.session().listPlatformAppViews())[0], view);
    assert.equal(
      (
        await f
          .session()
          .readPlatformDocument({ contentId: document.contentId })
      ).markdown,
      "不能丢失的正文",
    );
    await assert.rejects(
      f.session().createPlatformProjectForContent({
        ...request,
        commandId: randomUUID(),
        projectId: "stale-project",
      }),
      /已变化/,
    );
    await f.reopen();
    assert.equal((await f.session().listPlatformContent({})).length, 3);
    assert.deepEqual(
      (
        await f
          .session()
          .readPlatformScriptSnapshot({ contentId: productions[0]!.contentId })
      ).items,
      original.items,
    );
    assert.deepEqual(
      await f
        .session()
        .readPlatformScriptSnapshot({ contentId: productions[1]!.contentId }),
      unrelated,
    );
    assert.deepEqual((await f.session().listPlatformAppViews())[0], view);
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("自定义 UI 包不接管专业数据，不能代发消息、覆盖包版本或提升 Agent 安装权限", async () => {
  const f = await platformRuntimeHostFixture();
  try {
    const installation = { commandId: randomUUID(), manifest: app };
    assert.equal(
      await f.session().installUiPackage(installation),
      `${app.id}@${app.version}`,
    );
    assert.equal(
      await f.session().installUiPackage(installation),
      `${app.id}@${app.version}`,
    );
    const view = await f.session().launchPlatformAppView({
      commandId: randomUUID(),
      projectId: f.projectId,
      appId: app.id,
      packageVersion: app.version,
      state: { view: "outline", artifactId: null },
    });
    await assert.rejects(
      f.session().savePlatformAppView({
        commandId: randomUUID(),
        viewId: view.id,
        expectedRevision: view.revision,
        state: { note: "私有便笺" },
      }),
      /导航|正文|草稿/,
    );
    assert.equal((await f.session().listPlatformContent({})).length, 0);
    const source = {
      commandId: randomUUID(),
      applicationInstanceId: view.id,
      operation: {
        type: "record-input",
        projectId: f.projectId,
        artifactId: null,
        artifactRevision: null,
        selection: "",
        body: "直接发给 Agent",
        targetActantId: "morphz-agent",
      },
    };
    await assert.rejects(
      f.session().platformMessage(source),
      /消息入口只接受输入/,
    );
    for (const operation of [
      {
        type: "create-artifact",
        projectId: f.projectId,
        title: "不准暗写",
        content: { kind: "document", markdown: "正文" },
      },
      { type: "request-task-run", taskId: "unknown", expectedRevision: 1 },
      { type: "install-application", manifest: { ...app, version: "1.0.1" } },
    ])
      await assert.rejects(
        f
          .session()
          .platformMessage({ ...source, commandId: randomUUID(), operation }),
        /消息入口只接受输入/,
      );
    await assert.rejects(
      f.session().installUiPackage({
        commandId: randomUUID(),
        manifest: { ...app, description: "篡改固定版本" },
      }),
      /已安装|不同|不可覆盖|版本/,
    );
    await assert.rejects(
      f.session(morphzAgentAccess).installUiPackage({
        commandId: randomUUID(),
        manifest: { ...app, version: "1.0.1" },
      }),
      { code: "forbidden" },
    );
    await assert.rejects(
      f
        .session({ principalId: "stranger", actantId: "stranger" })
        .listUiPackages(),
      { code: "forbidden" },
    );
    await f.session().closePlatformAppView({
      commandId: randomUUID(),
      viewId: view.id,
      expectedRevision: view.revision,
    });
    await assert.rejects(
      f.session().savePlatformAppView({
        commandId: randomUUID(),
        viewId: view.id,
        expectedRevision: view.revision,
        state: { view: "closed" },
      }),
      /关闭|变化/,
    );
    assert.equal((await f.session().listPlatformContent({})).length, 0);
    assert.deepEqual(f.store.serviceState("runtime"), null);
    await f.reopen();
    assert.match(
      await f.session().applicationView(`${app.id}@${app.version}`),
      /App/,
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("每个 Human 的个人空间由 Platform 持久化；重启不重复创建，不迁移旧工作区快照", async () => {
  const other = { principalId: "alice", actantId: "alice-human" };
  const f = await agentDomainFixture({ additionalHumans: [other] });
  const spaces = (access = localAccess) =>
    f.domains.work.authority.withSession(
      access,
      () => {},
      (actor) => f.domains.work.service.ensurePersonalSpaces(actor),
    );
  const projects = (access = localAccess) =>
    f.domains.work.authority.withSession(
      access,
      () => {},
      (actor) => f.domains.work.service.listProjects(actor, {}),
    );
  try {
    const owner = await spaces();
    const alice = await spaces(other);
    assert.notEqual(owner.deskId, alice.deskId);
    assert.notEqual(owner.inboxId, alice.inboxId);
    assert.notEqual(owner.dialogueId, alice.dialogueId);
    assert.deepEqual(await spaces(other), alice);
    const ownProjects = await projects(other);
    assert.equal(
      ownProjects.filter((project) => project.kind !== "project").length,
      3,
    );
    assert.ok(
      ownProjects.every(
        (project) => project.ownerPrincipalId === other.principalId,
      ),
    );
    f.transport.saveServiceState("runtime-route-test", {
      immutableSession: "existing-session",
    });
    await f.reopen();
    assert.deepEqual(await spaces(), owner);
    assert.deepEqual(await spaces(other), alice);
    assert.deepEqual(f.transport.serviceState("runtime-route-test"), {
      immutableSession: "existing-session",
    });
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});
