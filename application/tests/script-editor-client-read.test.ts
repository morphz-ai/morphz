import test from "node:test";
import assert from "node:assert/strict";
import {
  collectEditorPage,
  editorDraftForClient,
  parseEditorVersion,
} from "../apps/web/src/script-editor-reader.js";
import type { PlatformClient } from "../apps/web/src/platform-client.js";
import { emptyScriptDraft } from "../packages/core/src/script-studio.js";
import { isScriptSnapshotEndpoint } from "./script-browser-read-proof.js";

test("浏览器整稿读取计数器匹配真实动态端点，不把空静态路径当作证明", () => {
  assert.equal(
    isScriptSnapshotEndpoint(
      "http://127.0.0.1:65421/api/platform/scripts/catalog_one/snapshot",
    ),
    true,
  );
  assert.equal(
    isScriptSnapshotEndpoint(
      "morphz://app/api/platform/scripts/catalog_two/snapshot?revision=1",
    ),
    true,
  );
  for (const path of [
    "/api/platform/scripts/snapshot",
    "/api/platform/scripts/editor/head",
    "/api/platform/scripts/editor/page",
    "/api/platform/scripts/catalog_one/items/scene_one",
    "/api/platform/scripts/catalog_one/snapshot/extra",
  ]) {
    assert.equal(
      isScriptSnapshotEndpoint(`http://127.0.0.1:65421${path}`),
      false,
    );
  }
});

const author = { principalId: "human", actantId: "human-actant" };
const date = "2026-09-30T00:00:00.000Z";
const production = {
  contentId: "content-one",
  id: "script-one",
  activityRevision: 9,
};
const header = (revision: number) => ({
  revision,
  title: `版本 ${revision}`,
  textCharacters: 10,
  author,
  createdAt: date,
  candidateId: null,
});
const versionsPage = (
  revisions: number[],
  nextCursor: string | null,
  total = 151,
) => ({
  productionId: production.id,
  activityRevision: 9,
  itemId: "scene-one",
  total,
  versions: revisions.map(header),
  nextCursor,
});

test("选中条目的历史通过有界页完整读取，超过100条不截断且不取正文", async () => {
  const requests: unknown[] = [];
  const result = await collectEditorPage(
    async (request) => {
      requests.push(request);
      return request.after
        ? versionsPage(
            Array.from({ length: 51 }, (_, at) => at + 101),
            null,
          )
        : versionsPage(
            Array.from({ length: 100 }, (_, at) => at + 1),
            "page-two",
          );
    },
    production,
    "versions",
    "scene-one",
  );
  assert.equal(result.versions.length, 151);
  assert.equal(result.total, 151);
  assert.equal(result.versions.at(-1)?.revision, 151);
  assert.ok(result.versions.every((version) => !("draft" in version)));
  assert.equal("nextCursor" in result, false);
  assert.deepEqual(requests, [
    {
      contentId: "content-one",
      panel: "versions",
      itemId: "scene-one",
      limit: 100,
      expectedActivityRevision: 9,
    },
    {
      contentId: "content-one",
      panel: "versions",
      itemId: "scene-one",
      limit: 100,
      expectedActivityRevision: 9,
      after: "page-two",
    },
  ]);
});

test("页式读取拒绝错误条目、活动变化、计数变化、缺页与不前进的游标", async () => {
  for (const changed of [
    { productionId: "other-script" },
    { itemId: "other-scene" },
    { activityRevision: 10 },
  ]) {
    await assert.rejects(
      collectEditorPage(
        async () => ({
          ...versionsPage([1], null, 1),
          ...changed,
        }),
        production,
        "versions",
        "scene-one",
      ),
      /剧本已变化/,
    );
  }
  await assert.rejects(
    collectEditorPage(
      async () => versionsPage([1], null, 2),
      production,
      "versions",
      "scene-one",
    ),
    /完整读取/,
  );
  await assert.rejects(
    collectEditorPage(
      async (request) =>
        versionsPage([1], request.after ? null : "next", request.after ? 3 : 2),
      production,
      "versions",
      "scene-one",
    ),
    /计数已变化/,
  );
  await assert.rejects(
    collectEditorPage(
      async () => versionsPage([1], "same", 2),
      production,
      "versions",
      "scene-one",
    ),
    /未向前推进/,
  );
});

const rawDraft = () => ({
  ...emptyScriptDraft("一场戏"),
  text: "当前选中的原稿",
  sources: [
    {
      appId: "morphz.objects",
      instanceId: "objects-instance",
      objectId: "source-object",
      versionRef: "1",
      quote: "原文",
    },
  ],
});

test("只对实际读取的精确版本解析来源，保留原引用版本、引文和目录身份", async () => {
  const lookups: unknown[] = [];
  const source = {
    resolveContent: async (reference: unknown) => {
      lookups.push(reference);
      return {
        id: "source-content",
        instanceId: "objects-instance",
        availability: "available",
        observedVersionRef: "7",
      };
    },
    readScriptSnapshot: async () => {
      throw new Error("不能预读全稿");
    },
  } as unknown as PlatformClient;
  const actual = await parseEditorVersion(source, {
    productionId: "script-one",
    itemId: "scene-one",
    kind: "scene",
    status: "draft",
    revision: 1,
    headRevision: 4,
    workflowRevision: 4,
    candidateId: null,
    author,
    createdAt: date,
    approvalForRequestedVersion: null,
    draft: rawDraft(),
  });
  assert.equal(actual.revision, 1);
  assert.equal(actual.headRevision, 4);
  assert.equal(actual.draft.text, "当前选中的原稿");
  assert.deepEqual(actual.draft.sources, [
    { artifactId: "source-content", revision: 1, quote: "原文" },
  ]);
  assert.deepEqual(lookups, [
    { appId: "morphz.objects", appObjectId: "source-object" },
  ]);
});

test("来源读取失败、实例变化或Objects非规范版本不能伪装为可用引用", async () => {
  const source = (
    instanceId = "objects-instance",
    availability = "available",
  ) =>
    ({
      resolveContent: async () => ({
        id: "source-content",
        instanceId,
        availability,
      }),
    }) as unknown as PlatformClient;
  for (const versionRef of ["v1", "01", "0", "1e2", "9007199254740992"]) {
    const draft = rawDraft();
    draft.sources[0]!.versionRef = versionRef;
    await assert.rejects(editorDraftForClient(source(), draft), /来源已变化/);
  }
  await assert.rejects(
    editorDraftForClient(source("other-instance"), rawDraft()),
    /来源已变化/,
  );
  await assert.rejects(
    editorDraftForClient(source("objects-instance", "unavailable"), rawDraft()),
    /来源已变化/,
  );
  await assert.rejects(
    editorDraftForClient(
      {
        resolveContent: async () => {
          throw new Error("权限已撤销");
        },
      } as unknown as PlatformClient,
      rawDraft(),
    ),
    /权限已撤销/,
  );
});
