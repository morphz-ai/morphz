import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import {
  Application,
  applicationFailure,
  invokeApplication,
} from "../packages/application/src/application.js";
import { localAccess } from "../packages/core/src/model.js";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import { objectsApplication } from "../packages/core/src/applications.js";
import {
  ApplicationRequestError,
  type ApplicationMethod,
  type NavigationRevisions,
} from "../packages/core/src/application-api.js";
import {
  PlatformClient,
  type ScriptOverview,
} from "../apps/web/src/platform-client.js";
import {
  navigationReadStillCurrent,
  readPlatformWorkspace,
  reusableNavigationCatalog,
  readCachedScriptOverview,
  scriptLibraryEntryFromContent,
  type PlatformNavigationCache,
} from "../apps/web/src/platform-workspace-view.js";

const postgresUrl = process.env.MORPHZ_TEST_POSTGRES_URL;
const other = {
  principalId: "navigation-other",
  actantId: "navigation-other-actant",
};
type Host = Awaited<ReturnType<typeof agentDomainFixture>>;

async function fixture(backend: "sqlite" | "postgres") {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  const schemas = {
    objects: `no_${suffix}`,
    scriptStudio: `ns_${suffix}`,
    reader: `nr_${suffix}`,
    browser: `nb_${suffix}`,
  };
  const platformSchema = `np_${suffix}`;
  const uiSchema = `nu_${suffix}`;
  const admin =
    backend === "postgres" ? new Pool({ connectionString: postgresUrl }) : null;
  const uiRoot = admin
    ? mkdtempSync(join(tmpdir(), "morphz-navigation-ui-"))
    : null;
  try {
    if (admin)
      for (const schema of [
        platformSchema,
        uiSchema,
        ...Object.values(schemas),
      ])
        await admin.query(`CREATE SCHEMA "${schema}"`);
    const host = await agentDomainFixture({
      additionalHumans: [other],
      ...(admin
        ? {
            storage: {
              platform: {
                kind: "postgres" as const,
                connectionString: postgresUrl!,
                schema: platformSchema,
              },
              applications: {
                connectionStrings: {
                  objects: postgresUrl!,
                  scriptStudio: postgresUrl!,
                  reader: postgresUrl!,
                  browser: postgresUrl!,
                },
                deploymentId: `navigation_${suffix}`,
                schemas,
              },
              uiPackages: {
                root: uiRoot!,
                postgres: { connectionString: postgresUrl!, schema: uiSchema },
              },
            },
          }
        : {}),
    });
    return {
      host,
      async close() {
        try {
          await host.close();
        } finally {
          if (admin) {
            for (const schema of [
              platformSchema,
              uiSchema,
              ...Object.values(schemas),
            ])
              await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
            await admin.end();
          }
          if (uiRoot) rmSync(uiRoot, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    if (admin) {
      for (const schema of [
        platformSchema,
        uiSchema,
        ...Object.values(schemas),
      ])
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
    if (uiRoot) rmSync(uiRoot, { recursive: true, force: true });
    throw error;
  }
}

async function createColdScriptQuery() {
  const f = await fixture("sqlite");
  try {
    const { client, calls, intercept } = await clientFor(f.host);
    await client.ensurePersonalSpaces();
    const productionId = randomUUID();
    const made = (await client.createScript({
      commandId: randomUUID(),
      productionId,
      projectId: f.host.projectId,
      title: "已确认但尚未启动的冷剧本",
    })) as { contentId: string };
    const fillHead = async () => {
      for (let index = 0; index < 51; index++)
        await client.createDocument({
          commandId: randomUUID(),
          objectId: randomUUID(),
          projectId: f.host.projectId,
          title: `目录第一页填充${index}`,
          markdown: "仅用于真实目录分页，不打开原件。",
        });
    };
    await fillHead();
    const navigation = await client.navigationRuntime();
    const initial = await readPlatformWorkspace(
      client,
      [],
      1,
      disconnectedRuntime,
    );
    const entry = await client.getContent(made.contentId);
    assert.equal(entry.availability, "available");
    assert.equal(
      initial.catalog.headContents.some((value) => value.id === entry.id),
      false,
      "测试对象确实在真实SQL目录50项第一页之外",
    );
    // This is the existing bounded cache after a real authorized point read,
    // not recency, an application launch, or a persisted navigation preference.
    const cache: PlatformNavigationCache = {
      version: navigation.catalogVersion,
      revisions: navigation.revisions,
      value: {
        ...initial.catalog,
        contents: [...initial.catalog.contents, entry],
        scriptLibrary: [
          ...initial.catalog.scriptLibrary,
          scriptLibraryEntryFromContent(entry),
        ],
      },
    };
    return { ...f, client, calls, intercept, fillHead, entry, cache };
  } catch (error) {
    await f.close();
    throw error;
  }
}

test("sqlite: 已确认冷剧本在同目录与权限版本刷新中保留且不新增目录或原件读取", async () => {
  const f = await createColdScriptQuery();
  try {
    const navigation = await f.client.navigationRuntime();
    f.calls.clear();
    const selection = {
      preferences: { view: "workbench" },
      confirmedScriptContentIds: [f.entry.id, f.entry.id],
    };
    const result = await readPlatformWorkspace(
      f.client,
      [],
      2,
      disconnectedRuntime,
      undefined,
      undefined,
      selection,
      undefined,
      reusableNavigationCatalog(
        f.cache,
        navigation.catalogVersion,
        navigation.revisions,
      ),
    );
    assert.equal(
      result.catalog.contents.find((entry) => entry.id === f.entry.id),
      f.entry,
      "尚未成为editor/prefs/recent引用也不能丢掉已确认目录条目",
    );
    assert.deepEqual(
      result.catalog.scriptLibrary.find(
        (entry) => entry.id === f.entry.appObjectId,
      ),
      scriptLibraryEntryFromContent(f.entry),
    );
    assert.equal(f.calls.get("content.list") ?? 0, 0);
    assert.equal(f.calls.get("content.resolve") ?? 0, 0);
    assert.equal(f.calls.get("scripts.read") ?? 0, 0);
    assert.equal(f.calls.get("scripts.snapshot") ?? 0, 0);
  } finally {
    await f.close();
  }
});

test("sqlite: 冷剧本目录版本变化必须按内容ID重新授权读取，撤权和缺项不回填", async () => {
  const f = await createColdScriptQuery();
  try {
    const production = await f.client.readScriptSnapshot(f.entry.id);
    await f.client.updateScript({
      commandId: randomUUID(),
      contentId: f.entry.id,
      expectedRevision: production.revision,
      title: "目录版本变化后的真实剧本标题",
      brief: production.brief,
      reviewerPrincipalIds: production.reviewerPrincipalIds,
      template: production.template,
    });
    await f.fillHead();
    const navigation = await f.client.navigationRuntime();
    assert.ok(navigation.catalogVersion > f.cache.version);
    const references: string[][] = [];
    f.intercept(async (method, params) => {
      if (method !== "content.list") return;
      const request = params as { contentIds?: string[] };
      if (request.contentIds) references.push(request.contentIds);
    });
    const missingId = randomUUID();
    const selection = {
      preferences: { view: "workbench" },
      confirmedScriptContentIds: [f.entry.id, missingId],
    };
    const fresh = await readPlatformWorkspace(
      f.client,
      [],
      2,
      disconnectedRuntime,
      undefined,
      undefined,
      selection,
      undefined,
      reusableNavigationCatalog(
        f.cache,
        navigation.catalogVersion,
        navigation.revisions,
      ),
    );
    assert.deepEqual(references, [[f.entry.id, missingId]]);
    assert.equal(
      fresh.catalog.headContents.some((entry) => entry.id === f.entry.id),
      false,
    );
    const current = fresh.catalog.contents.find(
      (entry) => entry.id === f.entry.id,
    );
    assert.ok(current);
    assert.ok(current.revision > f.entry.revision);
    assert.equal(current.title, "目录版本变化后的真实剧本标题");
    assert.deepEqual(
      fresh.catalog.scriptLibrary.find(
        (entry) => entry.id === f.entry.appObjectId,
      ),
      scriptLibraryEntryFromContent(current),
    );
    assert.equal(
      fresh.catalog.contents.some((entry) => entry.id === missingId),
      false,
    );

    const members = [
      { ...localAccess, projectIds: [], enabled: true },
      { ...other, projectIds: [f.host.projectId], enabled: true },
    ];
    await f.host.domains.content.platform.reconcileOperatorMembers(
      f.host.transport.identity(),
      members,
    );
    const { client: bob, intercept } = await clientFor(f.host, other);
    await bob.ensurePersonalSpaces();
    const granted = await bob.navigationRuntime();
    const grantedRead = await readPlatformWorkspace(
      bob,
      [],
      1,
      disconnectedRuntime,
    );
    const grantedCache: PlatformNavigationCache = {
      version: granted.catalogVersion,
      revisions: granted.revisions,
      value: {
        ...grantedRead.catalog,
        contents: [...grantedRead.catalog.contents, current],
      },
    };
    await f.host.domains.content.platform.reconcileOperatorMembers(
      f.host.transport.identity(),
      [members[0]!, { ...members[1]!, projectIds: [] }],
    );
    const revoked = await bob.navigationRuntime();
    const permitted = reusableNavigationCatalog(
      grantedCache,
      revoked.catalogVersion,
      revoked.revisions,
    );
    assert.equal(permitted, undefined);
    const deniedReferences: string[][] = [];
    intercept(async (method, params) => {
      if (method !== "content.list") return;
      const request = params as { contentIds?: string[] };
      if (request.contentIds) deniedReferences.push(request.contentIds);
    });
    const denied = await readPlatformWorkspace(
      bob,
      [],
      2,
      disconnectedRuntime,
      undefined,
      undefined,
      selection,
      undefined,
      permitted,
    );
    assert.deepEqual(deniedReferences, [[f.entry.id, missingId]]);
    assert.equal(
      denied.catalog.contents.some((entry) => entry.id === f.entry.id),
      false,
    );
    assert.equal(
      denied.catalog.scriptLibrary.some(
        (entry) => entry.id === f.entry.appObjectId,
      ),
      false,
    );
    assert.equal(
      denied.catalog.contents.some((entry) => entry.id === missingId),
      false,
    );
  } finally {
    await f.close();
  }
});

test("sqlite: 活跃打开优先、已确认引用去重限150并共享原200项预算", async () => {
  const f = await fixture("sqlite");
  try {
    const { client, intercept } = await clientFor(f.host);
    await client.ensurePersonalSpaces();
    const confirmed: string[] = [];
    for (let index = 0; index < 151; index++) {
      const made = (await client.createScript({
        commandId: randomUUID(),
        productionId: randomUUID(),
        projectId: f.host.projectId,
        title: `实际冷剧本${index}`,
      })) as { contentId: string };
      confirmed.push(made.contentId);
    }
    const opened = (await client.createDocument({
      commandId: randomUUID(),
      objectId: randomUUID(),
      projectId: f.host.projectId,
      title: "实际打开的文档优先",
      markdown: "活跃对象不被冷引用挤掉。",
    })) as { contentId: string };
    const recent: string[] = [];
    for (let index = 0; index < 100; index++) {
      const made = (await client.createDocument({
        commandId: randomUUID(),
        objectId: randomUUID(),
        projectId: f.host.projectId,
        title: `既有最近内容引用${index}`,
        markdown: "测试原共享引用预算。",
      })) as { contentId: string };
      recent.push(made.contentId);
    }
    const referencePages: string[][] = [];
    intercept(async (method, params) => {
      if (method !== "content.list") return;
      const request = params as { contentIds?: string[] };
      if (request.contentIds) referencePages.push(request.contentIds);
    });
    const selection = {
      preferences: { artifactId: opened.contentId, view: "workbench" },
      confirmedScriptContentIds: confirmed.flatMap((id) => [id, id]),
      recentContentIds: recent,
    };
    const result = await readPlatformWorkspace(
      client,
      [],
      1,
      disconnectedRuntime,
      undefined,
      undefined,
      selection,
    );
    const expected = [
      opened.contentId,
      ...confirmed.slice(0, 150),
      ...recent.slice(0, 49),
    ];
    assert.deepEqual(
      referencePages.flat(),
      expected,
      "真实contentByIds四个50项页，既有200预算不扩大",
    );
    assert.equal(referencePages.length, 4);
    assert.ok(referencePages.every((ids) => ids.length === 50));
    assert.equal(
      result.workspace.artifacts.find(
        (artifact) => artifact.id === opened.contentId,
      )?.title,
      "实际打开的文档优先",
    );
    assert.deepEqual(
      result.catalog.contents
        .filter((entry) => entry.appId === "morphz.script-studio")
        .map((entry) => entry.id),
      confirmed.slice(0, 150),
    );
    assert.equal(
      result.catalog.contents.some((entry) => entry.id === confirmed[150]),
      false,
    );
  } finally {
    await f.close();
  }
});

test("sqlite: 超过50个真实打开视图与prefs占位仍保留最后确认目标，重复刷新不反转引用顺序", async () => {
  const f = await fixture("sqlite");
  try {
    const { client } = await clientFor(f.host);
    await client.ensurePersonalSpaces();
    const scriptIds: string[] = [];
    for (let index = 0; index < 150; index++) {
      const made = (await client.createScript({
        commandId: randomUUID(),
        productionId: randomUUID(),
        projectId: f.host.projectId,
        title: `已确认引用预算竞争${index}`,
      })) as { contentId: string };
      scriptIds.push(made.contentId);
    }
    const targetId = scriptIds[0]!;
    const openedIds: string[] = [];
    for (let index = 0; index < 60; index++) {
      const projectId = await client.createProject(
        `实际应用视图所属项目${index}`,
        randomUUID(),
        randomUUID(),
      );
      const made = (await client.createDocument({
        commandId: randomUUID(),
        objectId: randomUUID(),
        projectId,
        title: `实际打开文档${index}`,
        markdown: "同200项预算内先保留活跃对象。",
      })) as { contentId: string };
      openedIds.push(made.contentId);
      await client.launchAppView({
        commandId: randomUUID(),
        projectId,
        appId: objectsApplication.id,
        packageVersion: objectsApplication.version,
        state: { artifactId: made.contentId },
      });
    }
    const prefs = (await client.createDocument({
      commandId: randomUUID(),
      objectId: randomUUID(),
      projectId: f.host.projectId,
      title: "独立prefs活跃占位",
      markdown: "不同于60个真实打开视图。",
    })) as { contentId: string };
    const instances = await client.appViews();
    assert.equal(instances.length, 60);
    assert.ok(instances.every((instance) => instance.status === "open"));
    const navigation = await client.navigationRuntime();
    const selection = {
      preferences: { view: "workbench", artifactId: prefs.contentId },
    };
    const initial = await readPlatformWorkspace(
      client,
      instances,
      1,
      disconnectedRuntime,
      undefined,
      undefined,
      selection,
    );
    assert.equal(
      initial.catalog.headContents.some((entry) => entry.id === targetId),
      false,
    );
    const olderReferences = await client.contentByIds(scriptIds.slice(1));
    const target = await client.getContent(targetId);
    const remembered = [...olderReferences, target];
    assert.equal(remembered.length, 150);
    assert.equal(
      remembered.at(-1)!.id,
      targetId,
      "真实点读确认目标追加在既有bounded cache末尾",
    );
    let cache: PlatformNavigationCache = {
      version: navigation.catalogVersion,
      revisions: navigation.revisions,
      value: {
        ...initial.catalog,
        contents: [...initial.catalog.headContents, ...remembered],
        scriptLibrary: remembered.map(scriptLibraryEntryFromContent),
      },
    };
    let previous = initial.workspace;
    const expectedReferences = remembered.slice(11).map((entry) => entry.id);
    for (let pass = 0; pass < 2; pass++) {
      const current = await client.navigationRuntime();
      const confirmedScriptContentIds = cache.value.contents
        .filter(
          (entry) =>
            entry.appId === "morphz.script-studio" &&
            entry.kind === "script" &&
            entry.availability === "available" &&
            !cache.value.headContents.some((head) => head.id === entry.id),
        )
        .map((entry) => entry.id);
      const result = await readPlatformWorkspace(
        client,
        instances,
        pass + 2,
        disconnectedRuntime,
        undefined,
        previous,
        { ...selection, confirmedScriptContentIds },
        undefined,
        reusableNavigationCatalog(
          cache,
          current.catalogVersion,
          current.revisions,
        ),
      );
      assert.ok(
        result.catalog.scriptLibrary.some(
          (entry) => entry.contentId === targetId,
        ),
        "末尾刚确认的真实冷剧本不能被活跃视图预算挤出启动守门依据",
      );
      assert.deepEqual(
        result.catalog.contents
          .filter((entry) => entry.appId === "morphz.script-studio")
          .map((entry) => entry.id),
        expectedReferences,
        "61活跃占位后剩余139项按原顺序保留尾部，下一轮不能反转",
      );
      assert.equal(
        result.catalog.contents.length,
        200,
        "活跃对象和冷引用共享同一200预算",
      );
      for (const id of [prefs.contentId, ...openedIds])
        assert.ok(
          result.workspace.artifacts.some((artifact) => artifact.id === id),
          "每个真实活跃对象保持可见",
        );
      cache = {
        version: current.catalogVersion,
        revisions: current.revisions,
        value: result.catalog,
      };
      previous = result.workspace;
    }
  } finally {
    await f.close();
  }
});

/** Both Client and Agent use their real production entry points. No navigation
 * pages, revision values, authorization results or app originals are stubbed. */
async function clientFor(host: Host, access = localAccess) {
  const calls = new Map<ApplicationMethod, number>();
  let afterCall:
    ((method: ApplicationMethod, params: unknown) => Promise<void>) | undefined;
  const client = await PlatformClient.connect({
    async call(method, params, options) {
      calls.set(method, (calls.get(method) ?? 0) + 1);
      const app = new Application(host.transport, {
        identity: host.identity,
        platformWork: host.domains.work,
        platformDocuments: host.domains.content,
        platformScripts: {
          authority: host.domains.content.authority,
          platform: host.domains.content.platform,
          studio: host.domains.content.studio,
          instanceIds: host.domains.content.instanceIds,
        },
        platformReader: host.domains.reader,
        images: host.domains.images,
        uiPackages: host.domains.uiPackages,
      });
      try {
        const result = await invokeApplication(
          app.session(access),
          method,
          params,
          "navigation-test-generation",
          options?.signal ?? new AbortController().signal,
        );
        await afterCall?.(method, params);
        return result;
      } catch (error) {
        const failure = applicationFailure(error);
        throw new ApplicationRequestError(
          failure.status,
          failure.message,
          failure.code,
        );
      }
    },
  });
  return {
    client,
    calls,
    intercept(value: typeof afterCall) {
      afterCall = value;
    },
  };
}

const groupReads = (calls: Map<ApplicationMethod, number>) => ({
  projects: calls.get("projects.list") ?? 0,
  conversations: calls.get("conversations.navigation") ?? 0,
  tasks: calls.get("tasks.list") ?? 0,
  taskCounts: calls.get("tasks.counts") ?? 0,
  taskOrder: calls.get("tasks.order") ?? 0,
});
function difference(
  after: ReturnType<typeof groupReads>,
  before: ReturnType<typeof groupReads>,
) {
  return Object.fromEntries(
    Object.entries(after).map(([key, value]) => [
      key,
      value - before[key as keyof typeof before],
    ]),
  );
}
function changed(
  before: NavigationRevisions,
  after: NavigationRevisions,
  names: (keyof NavigationRevisions)[],
) {
  for (const name of ["projects", "conversations", "tasks", "access"] as const)
    assert.equal(
      after[name],
      before[name] + (names.includes(name) ? 1 : 0),
      `revision ${name}`,
    );
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: 文档修订不重读完整导航，项目/对话/事项分别失效且保留真实写入口`,
    { skip: backend === "postgres" && !postgresUrl },
    async () => {
      const f = await fixture(backend);
      try {
        const { host } = f;
        const { client, calls } = await clientFor(host);
        const first = await client.navigationRuntime();
        const spaces = await client.ensurePersonalSpaces();
        const initialized = await client.navigationRuntime();
        changed(first.revisions, initialized.revisions, [
          "projects",
          "conversations",
          "access",
        ]);
        await client.ensurePersonalSpaces();
        assert.deepEqual(
          (await client.navigationRuntime()).revisions,
          initialized.revisions,
        );
        let cache: PlatformNavigationCache | null = null;
        let previous:
          | Awaited<ReturnType<typeof readPlatformWorkspace>>["workspace"]
          | undefined;
        async function refresh() {
          const navigation = await client.navigationRuntime();
          const permitted = reusableNavigationCatalog(
            cache,
            navigation.catalogVersion,
            navigation.revisions,
          );
          const result = await readPlatformWorkspace(
            client,
            [],
            (previous?.revision ?? 0) + 1,
            disconnectedRuntime,
            undefined,
            permitted ? previous : undefined,
            { preferences: { view: "inbox" } },
            undefined,
            permitted,
            spaces,
          );
          const final = await client.navigationRuntime();
          assert.ok(
            navigationReadStillCurrent(navigation, final),
            "Only a stable complete read can become a cache",
          );
          cache = {
            version: navigation.catalogVersion,
            revisions: navigation.revisions,
            value: result.catalog,
          };
          previous = result.workspace;
          return result;
        }
        await refresh();
        assert.deepEqual(groupReads(calls), {
          projects: 1,
          conversations: 1,
          tasks: 1,
          taskCounts: 1,
          taskOrder: 1,
        });
        const made = (await client.createDocument({
          commandId: randomUUID(),
          objectId: randomUUID(),
          projectId: host.projectId,
          title: "导航正文",
          markdown: "第一版",
        })) as { contentId: string };
        let before = await client.navigationRuntime();
        const reads = groupReads(calls);
        for (let revision = 1; revision <= 3; revision++) {
          const route = host.input(host.projectId);
          await host.call(
            {
              action: "revise-document",
              artifactId: made.contentId,
              revision,
              title: "导航正文",
              markdown: `第${revision + 1}版`,
            },
            route,
          );
          const after = await client.navigationRuntime();
          changed(before.revisions, after.revisions, []);
          assert.ok(after.catalogVersion > before.catalogVersion);
          await refresh();
          before = after;
        }
        assert.deepEqual(
          groupReads(calls),
          reads,
          "连续真实 Agent 原件修订不得重读三个完整导航与事项聚合",
        );

        const renameReads = groupReads(calls);
        const rename = {
          commandId: randomUUID(),
          projectId: host.projectId,
          expectedRevision: 1,
          title: "只改项目标题",
        };
        await client.renameProject(
          rename.projectId,
          rename.title,
          rename.expectedRevision,
          rename.commandId,
        );
        let after = await client.navigationRuntime();
        changed(before.revisions, after.revisions, ["projects"]);
        const renamed = await refresh();
        assert.equal(
          renamed.catalog.projects.find((item) => item.id === host.projectId)
            ?.title,
          rename.title,
        );
        assert.deepEqual(difference(groupReads(calls), renameReads), {
          projects: 1,
          conversations: 0,
          tasks: 0,
          taskCounts: 0,
          taskOrder: 0,
        });
        await client.renameProject(
          rename.projectId,
          rename.title,
          rename.expectedRevision,
          rename.commandId,
        );
        assert.deepEqual(
          (await client.navigationRuntime()).revisions,
          after.revisions,
        );
        await assert.rejects(
          client.renameProject(
            rename.projectId,
            rename.title,
            rename.expectedRevision,
            randomUUID(),
          ),
          /更新|版本|修订/,
        );
        assert.deepEqual(
          (await client.navigationRuntime()).revisions,
          after.revisions,
        );

        before = after;
        const conversationId = randomUUID();
        await host.withHuman((actor) =>
          host.domains.work.service.startConversation(actor, {
            commandId: randomUUID(),
            conversationId,
            projectId: host.projectId,
            title: "已合法提交的对话导航",
            inputFingerprint: "a".repeat(64),
          }),
        );
        after = await client.navigationRuntime();
        changed(before.revisions, after.revisions, ["conversations"]);
        const conversationReads = groupReads(calls);
        const conversations = await refresh();
        assert.ok(
          conversations.catalog.conversations.some(
            (item) => item.id === conversationId,
          ),
        );
        assert.deepEqual(difference(groupReads(calls), conversationReads), {
          projects: 0,
          conversations: 1,
          tasks: 0,
          taskCounts: 0,
          taskOrder: 0,
        });
        before = after;
        await client.updateConversation({
          commandId: randomUUID(),
          conversationId,
          expectedRevision: 1,
          title: "改名",
          archived: true,
        });
        after = await client.navigationRuntime();
        changed(before.revisions, after.revisions, ["conversations"]);
        await refresh();

        before = after;
        const taskId = randomUUID();
        await client.createTask({
          commandId: randomUUID(),
          taskId,
          projectId: host.projectId,
          title: "只改事项",
          assigneeId: localAccess.actantId,
        });
        after = await client.navigationRuntime();
        changed(before.revisions, after.revisions, ["tasks"]);
        const taskReads = groupReads(calls);
        const tasks = await refresh();
        assert.ok(tasks.catalog.tasks.some((item) => item.id === taskId));
        assert.deepEqual(difference(groupReads(calls), taskReads), {
          projects: 0,
          conversations: 0,
          tasks: 1,
          taskCounts: 1,
          taskOrder: 1,
        });
        before = after;
        const order = await client.taskOrder();
        await client.reorderTask({
          commandId: randomUUID(),
          taskId,
          beforeTaskId: null,
          expectedOrderRevision: order.revision,
        });
        after = await client.navigationRuntime();
        changed(before.revisions, after.revisions, ["tasks"]);

        before = after;
        const entry = await client.contentByIds([made.contentId]);
        const projectId = randomUUID();
        await client.createProjectForContent({
          commandId: randomUUID(),
          projectId,
          title: "原子创建项目并关联内容",
          contentId: made.contentId,
          expectedRevision: entry[0]!.revision,
        });
        after = await client.navigationRuntime();
        changed(before.revisions, after.revisions, [
          "projects",
          "conversations",
        ]);
        const atomic = await refresh();
        assert.ok(
          atomic.catalog.projects.some((item) => item.id === projectId),
        );
        assert.ok(
          atomic.catalog.conversations.some((item) => item.id === projectId),
        );
        const snapshot = await client.navigationRuntime();
        await host.reopen();
        assert.deepEqual(
          await client.navigationRuntime(),
          snapshot,
          "冷重开保留权威计数，不从客户端重建",
        );
        host.assertNoLegacyData();
      } finally {
        await f.close();
      }
    },
  );

  test(
    `${backend}: 完整第二页、并发修订栅栏、真实成员撤权和配置失效清除缓存依据`,
    { skip: backend === "postgres" && !postgresUrl },
    async () => {
      const f = await fixture(backend);
      try {
        const { host } = f;
        const { client, calls, intercept } = await clientFor(host);
        await client.ensurePersonalSpaces();
        for (let index = 0; index < 108; index++)
          await client.createProject(
            `实际分页项目${index}`,
            randomUUID(),
            `nav_page_${index}`,
          );
        const before = await client.navigationRuntime();
        const reads = groupReads(calls);
        const all = await client.allProjects();
        assert.equal(all.length, 112, "108项目+既有项目+个人三空间全部读取");
        assert.equal(
          groupReads(calls).projects - reads.projects,
          2,
          "真实两个SQL分页请求",
        );
        assert.ok(all.some((item) => item.id === "nav_page_107"));
        let raced = false;
        intercept(async (method) => {
          if (method !== "projects.list" || raced) return;
          raced = true;
          await host.withHuman((actor) =>
            host.domains.work.service.renameProject(actor, {
              commandId: randomUUID(),
              projectId: "nav_page_0",
              expectedRevision: 1,
              title: "分页中改变顺序的项目",
            }),
          );
        });
        await client.allProjects();
        intercept(undefined);
        const after = await client.navigationRuntime();
        assert.equal(
          navigationReadStillCurrent(before, after),
          false,
          "分页中重排不能将混合页发布成原revision的完整缓存",
        );

        const tenantId = host.transport.identity();
        const operator = [
          { ...localAccess, projectIds: [], enabled: true },
          { ...other, projectIds: [host.projectId], enabled: true },
        ];
        await host.domains.content.platform.reconcileOperatorMembers(
          tenantId,
          operator,
        );
        const bob = (await clientFor(host, other)).client;
        await bob.ensurePersonalSpaces();
        const granted = await bob.navigationRuntime();
        const readable = await readPlatformWorkspace(
          bob,
          [],
          1,
          disconnectedRuntime,
        );
        assert.ok(
          readable.catalog.projects.some((item) => item.id === host.projectId),
        );
        const cache = {
          version: granted.catalogVersion,
          revisions: granted.revisions,
          value: readable.catalog,
        };
        await host.domains.content.platform.reconcileOperatorMembers(tenantId, [
          operator[0]!,
          { ...operator[1]!, projectIds: [] },
        ]);
        const revoked = await bob.navigationRuntime();
        changed(granted.revisions, revoked.revisions, ["projects", "access"]);
        assert.equal(
          reusableNavigationCatalog(
            cache,
            revoked.catalogVersion,
            revoked.revisions,
          ),
          undefined,
          "业务revision未变也不能复用已撤权项目/对话/事项/正文cache",
        );
        const fresh = await readPlatformWorkspace(
          bob,
          [],
          2,
          disconnectedRuntime,
        );
        assert.ok(
          !fresh.catalog.projects.some((item) => item.id === host.projectId),
        );
        await assert.rejects(
          bob.project(host.projectId),
          (error: unknown) =>
            error instanceof ApplicationRequestError && error.status === 403,
        );

        const bindings = (enabled: boolean, label: string) => ({
          version: 1,
          members: [localAccess, other].map((human) => ({
            ...human,
            loginTokenHash: createHash("sha256")
              .update(
                `synthetic-login-${human.principalId}${human.principalId === other.principalId ? label : ""}`,
              )
              .digest("hex"),
            enabled: human.principalId !== other.principalId || enabled,
          })),
        });
        const configBefore = await client.navigationRuntime();
        await host.identity!.replaceConfiguration(bindings(true, "轮换凭据"));
        const configAfter = await client.navigationRuntime();
        changed(configBefore.revisions, configAfter.revisions, ["access"]);
        const membersWithoutGrant = [
          operator[0]!,
          { ...operator[1]!, projectIds: [] },
        ];
        await host.identity!.replaceConfiguration(
          bindings(true, "再轮换凭据"),
          membersWithoutGrant,
        );
        const reconciled = await client.navigationRuntime();
        changed(configAfter.revisions, reconciled.revisions, ["access"]);
        await assert.rejects(
          host.identity!.replaceConfiguration(bindings(true, "错误配置"), [
            membersWithoutGrant[0]!,
            {
              ...membersWithoutGrant[1]!,
              projectIds: ["absent-navigation-project"],
            },
          ]),
          /不存在的项目/,
        );
        assert.deepEqual(
          await client.navigationRuntime(),
          reconciled,
          "失败的权限配置事务不留下提前递增的标记",
        );
        await host.identity!.replaceConfiguration(bindings(false, "已撤销"));
        await assert.rejects(
          bob.navigationRuntime(),
          (error: unknown) =>
            error instanceof ApplicationRequestError && error.status === 403,
        );
        host.assertNoLegacyData();
      } finally {
        await f.close();
      }
    },
  );

  test(
    `${backend}: 事项准入和未投递撤回只推进事项投影，重复/冲突/权限失败不推进`,
    { skip: backend === "postgres" && !postgresUrl },
    async () => {
      const f = await fixture(backend);
      try {
        const { host } = f;
        const { client } = await clientFor(host);
        await client.ensurePersonalSpaces();
        const prerequisite = randomUUID(),
          taskId = randomUUID();
        await client.createTask({
          commandId: randomUUID(),
          taskId: prerequisite,
          projectId: host.projectId,
          title: "未完成依赖",
          assigneeId: localAccess.actantId,
        });
        await client.createTask({
          commandId: randomUUID(),
          taskId,
          projectId: host.projectId,
          title: "可在准备前撤回",
          assigneeId: localAccess.actantId,
          dependsOnIds: [prerequisite],
        });
        let before = await client.navigationRuntime();
        await client.reviseTask({
          commandId: randomUUID(),
          taskId,
          expectedRevision: 1,
          assigneeId: "morphz-agent",
        });
        let after = await client.navigationRuntime();
        changed(before.revisions, after.revisions, ["tasks"]);
        before = after;
        const request = {
          commandId: randomUUID(),
          taskId,
          expectedRevision: 2,
          sessionId: "navigation-test-session",
          intent: "合成事项验收",
          notBefore: "2026-09-30T00:00:00.000Z",
        };
        const admission = await host.withHuman((actor) =>
          host.domains.work.service.requestTaskRun(actor, request),
        );
        after = await client.navigationRuntime();
        changed(before.revisions, after.revisions, ["tasks"]);
        assert.equal(
          await host.withHuman(
            async (actor) =>
              (
                await host.domains.content.platform.taskRunPrerequisites(
                  actor,
                  taskId,
                  1,
                )
              ).prepared,
          ),
          false,
        );
        assert.deepEqual(
          await host.withHuman((actor) =>
            host.domains.work.service.requestTaskRun(actor, request),
          ),
          admission,
        );
        assert.deepEqual(
          (await client.navigationRuntime()).revisions,
          after.revisions,
        );
        before = after;
        const stop = {
          taskId,
          runNumber: 1,
          controlRevision: 1,
          action: "stop",
        };
        await host.withHuman((actor) =>
          host.domains.work.service.controlTaskRun(actor, stop),
        );
        after = await client.navigationRuntime();
        changed(before.revisions, after.revisions, ["tasks"]);
        assert.equal(
          (await client.taskHead(taskId)).headVersion.execution,
          "planned",
        );
        await host.withHuman((actor) =>
          host.domains.work.service.controlTaskRun(actor, stop),
        );
        assert.deepEqual(
          (await client.navigationRuntime()).revisions,
          after.revisions,
        );

        before = after;
        await client.respondTask({
          commandId: randomUUID(),
          taskId: prerequisite,
          expectedRevision: 1,
          body: "真实领域回应",
        });
        after = await client.navigationRuntime();
        changed(before.revisions, after.revisions, ["tasks"]);
        const unchanged = await client.navigationRuntime();
        await assert.rejects(
          client.reviseTask({
            commandId: randomUUID(),
            taskId: prerequisite,
            expectedRevision: 1,
            title: "过期修订",
          }),
          (error: unknown) =>
            error instanceof ApplicationRequestError && error.status === 409,
        );
        const otherClient = (await clientFor(host, other)).client;
        await assert.rejects(
          otherClient.reviseTask({
            commandId: randomUUID(),
            taskId: prerequisite,
            expectedRevision: 2,
            title: "无权限",
          }),
          (error: unknown) =>
            error instanceof ApplicationRequestError && error.status === 403,
        );
        assert.deepEqual(
          await client.navigationRuntime(),
          unchanged,
          "失败不得提前推进导航权威",
        );
      } finally {
        await f.close();
      }
    },
  );
  test(
    `${backend}: 真正撤权后的迟到剧本响应不回填展示缓存，也不删除新请求`,
    { skip: backend === "postgres" && !postgresUrl },
    async () => {
      const f = await fixture(backend);
      const oldResponse = deferred(),
        newResponse = deferred(),
        oldRead = deferred(),
        newRead = deferred();
      try {
        const { host } = f;
        const owner = (await clientFor(host)).client;
        const created = (await owner.createScript({
          commandId: randomUUID(),
          productionId: randomUUID(),
          projectId: host.projectId,
          title: "迟到响应授权回归",
        })) as { contentId: string };
        const members = [
          { ...localAccess, projectIds: [], enabled: true },
          { ...other, projectIds: [host.projectId], enabled: true },
        ];
        const tenantId = host.transport.identity();
        await host.domains.content.platform.reconcileOperatorMembers(
          tenantId,
          members,
        );
        const { client: bob, intercept } = await clientFor(host, other);
        const before = await bob.navigationRuntime();
        const entry = await bob.getContent(created.contentId);
        const key = `${bob.boot.csrfToken}:${entry.id}:${entry.revision}:${entry.observedVersionRef}`;
        const values = new Map<string, ScriptOverview>();
        const pending = new Map<string, Promise<ScriptOverview>>();
        const generation = { current: 0 };
        let count = 0;
        intercept(async (method) => {
          if (method !== "scripts.read") return;
          count++;
          const started = count === 1 ? oldRead : newRead;
          const response = count === 1 ? oldResponse : newResponse;
          started.resolve();
          await response.promise;
        });
        const read = () =>
          readCachedScriptOverview(
            key,
            values,
            pending,
            generation,
            () => bob.readScript(entry.id),
            (overview) => {
              assert.equal(overview.contentId, entry.id);
              assert.equal(overview.productionId, entry.appObjectId);
              assert.equal(overview.projectId, host.projectId);
              assert.equal(overview.title, entry.title);
              assert.equal(
                String(overview.activityRevision),
                entry.observedVersionRef,
              );
            },
          );
        const stale = read();
        const rejectsStale = assert.rejects(stale, /访问状态已变化/);
        await oldRead.promise;
        assert.equal(count, 1, "旧响应确实已通过服务端实际授权读取");

        await host.domains.content.platform.reconcileOperatorMembers(tenantId, [
          members[0]!,
          { ...members[1]!, projectIds: [] },
        ]);
        const revoked = await bob.navigationRuntime();
        changed(before.revisions, revoked.revisions, ["projects", "access"]);
        generation.current++;
        values.clear();
        pending.clear();
        await assert.rejects(
          bob.readScript(entry.id),
          (error: unknown) =>
            error instanceof ApplicationRequestError &&
            error.status === 404 &&
            error.code === "not_found",
          "正式授权目录不泄露撤权对象存在性，后续原件读取被拒绝",
        );
        assert.equal(count, 1, "被拒绝的原件读取不会到达成功响应延迟层");

        // Regrant under the same Human/session key, then start a fresh read.
        // The old request must neither fill this view nor erase this pending.
        await host.domains.content.platform.reconcileOperatorMembers(
          tenantId,
          members,
        );
        await bob.navigationRuntime();
        generation.current++;
        values.clear();
        pending.clear();
        const fresh = read();
        await newRead.promise;
        const currentRequest = pending.get(key);
        assert.ok(currentRequest);
        oldResponse.resolve();
        await rejectsStale;
        assert.equal(values.size, 0, "迟到旧响应不能回填已清理的cache");
        assert.equal(
          pending.get(key),
          currentRequest,
          "旧请求finally不得删除同key的新promise",
        );
        newResponse.resolve();
        const overview = await fresh;
        assert.equal(values.get(key), overview);
        assert.equal(pending.size, 0);
        assert.equal(await read(), overview, "有效同代展示cache仍复用");
        assert.equal(count, 2, "cache复用不重复原件读取");
      } finally {
        oldResponse.resolve();
        newResponse.resolve();
        await f.close();
      }
    },
  );
}
