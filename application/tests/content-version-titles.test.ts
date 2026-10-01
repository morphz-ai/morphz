import test from "node:test";
import assert from "node:assert/strict";
import type {
  PlatformClient,
  PlatformContent,
} from "../apps/web/src/platform-client.js";
import { RequestError } from "../apps/web/src/application-transport.js";
import {
  contentVersionTitle,
  readContentVersionTitles,
} from "../apps/web/src/platform-workspace-view.js";

const content = (id = "content-one"): PlatformContent => ({
  id,
  appId: "morphz.objects",
  instanceId: "objects-one",
  providerRevision: 1,
  appObjectId: `original-${id}`,
  projectId: "project-one",
  kind: "document",
  title: "第二版标题",
  observedVersionRef: "2",
  availability: "available",
  revision: 2,
  createdAt: "2026-09-30T00:00:00.000Z",
  updatedAt: "2026-09-30T00:00:01.000Z",
});

test("历史消息标题只读精确版本元数据，不读取正文，重复引用合并且缓存复用", async () => {
  const entry = content();
  let reads = 0;
  const client = {
    objectVersions: async (id: string, options: unknown) => {
      reads++;
      assert.equal(id, entry.id);
      assert.deepEqual(options, { beforeRevision: 2, limit: 1 });
      return {
        contentId: entry.id,
        objectId: entry.appObjectId,
        versions: [{ revision: 1, title: "第一版标题" }],
      };
    },
    readObject: () => {
      throw new Error("不应读取正文");
    },
  } as unknown as PlatformClient;
  const references = [
    { artifactId: entry.id, artifactRevision: 1 },
    { artifactId: entry.id, artifactRevision: 1 },
    { artifactId: entry.id, artifactRevision: 2 },
  ];
  const titles = await readContentVersionTitles(client, [entry], references);
  assert.equal(reads, 1);
  assert.equal(
    contentVersionTitle(entry.id, 1, [], [entry], titles),
    "第一版标题",
  );
  assert.equal(
    contentVersionTitle(entry.id, 2, [], [entry], titles),
    "第二版标题",
  );
  assert.equal(contentVersionTitle(entry.id, 1, [], [entry]), undefined);
  assert.deepEqual(
    await readContentVersionTitles(client, [entry], references, titles),
    titles,
  );
  assert.equal(reads, 1);
});

test("历史版本不存在时不把相邻版本或当前目录冒充为原引用", async () => {
  const entry = { ...content(), observedVersionRef: "4" };
  const client = {
    objectVersions: async () => ({
      contentId: entry.id,
      objectId: entry.appObjectId,
      versions: [{ revision: 1, title: "相邻版本" }],
    }),
  } as unknown as PlatformClient;
  const titles = await readContentVersionTitles(
    client,
    [entry],
    [{ artifactId: entry.id, artifactRevision: 2 }],
  );
  assert.deepEqual(titles, []);
  assert.equal(
    contentVersionTitle(entry.id, 2, [], [entry], titles),
    undefined,
  );
});

test("引用缓存不跨应用原件或 provider 变更复用，无权限目录不读取也不显示旧标题", async () => {
  const entry = content();
  let reads = 0;
  const client = {
    objectVersions: async () => {
      reads++;
      return {
        contentId: entry.id,
        objectId: entry.appObjectId,
        versions: [{ revision: 1, title: "原标题" }],
      };
    },
  } as unknown as PlatformClient;
  const references = [{ artifactId: entry.id, artifactRevision: 1 }];
  const titles = await readContentVersionTitles(client, [entry], references);
  const rebound = { ...entry, providerRevision: 2 };
  assert.equal(
    contentVersionTitle(entry.id, 1, [], [rebound], titles),
    undefined,
  );
  await readContentVersionTitles(client, [rebound], references, titles);
  assert.equal(reads, 2);
  assert.deepEqual(
    await readContentVersionTitles(client, [], references, titles),
    [],
  );
  assert.deepEqual(
    await readContentVersionTitles(
      client,
      [{ ...entry, availability: "unavailable" }],
      references,
      titles,
    ),
    [],
  );
  assert.equal(
    contentVersionTitle(
      entry.id,
      1,
      [],
      [{ ...entry, availability: "unavailable" }],
      titles,
    ),
    undefined,
  );
  assert.equal(reads, 2);
});

test("历史标题读取最多 100 个引用、8 并发，未显示内容不做库扫描", async () => {
  const entries = Array.from({ length: 120 }, (_, i) =>
    content(`content-${i}`),
  );
  let active = 0;
  let peak = 0;
  const readIds: string[] = [];
  const client = {
    objectVersions: async (id: string) => {
      readIds.push(id);
      peak = Math.max(peak, ++active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active--;
      return {
        contentId: id,
        objectId: `original-${id}`,
        versions: [{ revision: 1, title: id }],
      };
    },
  } as unknown as PlatformClient;
  const titles = await readContentVersionTitles(
    client,
    entries,
    entries.map((entry) => ({ artifactId: entry.id, artifactRevision: 1 })),
  );
  assert.equal(titles.length, 100);
  assert.equal(readIds.length, 100);
  assert.equal(peak, 8);
  assert.equal(readIds.includes("content-0"), false);
  assert.equal(readIds.includes("content-119"), true);
});

test("原件身份错配必须报错；授权撤销只留下无标题的可重试引用", async () => {
  const entry = content();
  const references = [{ artifactId: entry.id, artifactRevision: 1 }];
  await assert.rejects(
    readContentVersionTitles(
      {
        objectVersions: async () => ({
          contentId: entry.id,
          objectId: "another-original",
          versions: [],
        }),
      } as unknown as PlatformClient,
      [entry],
      references,
    ),
    /原件不一致/,
  );
  assert.deepEqual(
    await readContentVersionTitles(
      {
        objectVersions: async () => {
          throw new RequestError(403, "授权已撤销");
        },
      } as unknown as PlatformClient,
      [entry],
      references,
    ),
    [],
  );
});

test("阅读器历史引用只读取指定版本概览，不读取章节或字节", async () => {
  const entry = { ...content(), appId: "morphz.reader", kind: "publication" };
  const client = {
    readReaderBook: async (id: string, revision: number) => {
      assert.equal(id, entry.id);
      assert.equal(revision, 1);
      return { bookId: entry.appObjectId, revision, title: "书籍第一版" };
    },
  } as unknown as PlatformClient;
  const titles = await readContentVersionTitles(
    client,
    [entry],
    [{ artifactId: entry.id, artifactRevision: 1 }],
  );
  assert.equal(
    contentVersionTitle(entry.id, 1, [], [entry], titles),
    "书籍第一版",
  );
});
