import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  compareDirectoryContent,
  directoryCursor,
  readContentSearchPage,
  type ContentSearchPage,
} from "../apps/web/src/content-search-page.js";
import type { WorkspaceClient } from "../apps/web/src/client.js";
import {
  platformContentSchema,
  type PlatformContent,
} from "../apps/web/src/platform-client.js";
import { searchDomainFixture } from "./search-domain-fixture.js";

function directoryAdapter(f: Awaited<ReturnType<typeof searchDomainFixture>>) {
  const pages: NonNullable<
    Parameters<WorkspaceClient["listContentPage"]>[0]
  >[] = [];
  const api: Pick<
    WorkspaceClient,
    "listContentPage" | "countContent" | "search"
  > = {
    async listContentPage(options, signal) {
      signal?.throwIfAborted();
      pages.push(options ?? {});
      const items = (await f.session().listPlatformContent(options)).map(
        (item) => platformContentSchema.parse(item),
      );
      return { items, nextCursor: null };
    },
    async countContent(options, signal) {
      signal?.throwIfAborted();
      return f.session().listPlatformContentCounts(options);
    },
    async search(request, signal) {
      signal?.throwIfAborted();
      return f.search(request);
    },
  };
  return { api, pages };
}

test("实际领域搜索分页归并：首屏外正文可达，三种排序和数量一致，不重复/全库 hydrate", async () => {
  const f = await searchDomainFixture();
  try {
    const query = `needle_${randomUUID()}`;
    const ids: string[] = [];
    for (let index = 0; index < 55; index++) {
      ids.push(
        (await f.createAgent(`正文产物 ${index}`, `${query} 原文 ${index}`))
          .contentId,
      );
      ids.push(
        (
          await f.createHuman(
            `${query} 标题 ${index}`,
            "人工正文不进入全文索引",
          )
        ).contentId,
      );
    }
    // These are intentionally opposite under UTF-16 and UTF-8/codepoint ordering.
    ids.push((await f.createAgent("\uE000 私用标题", query)).contentId);
    ids.push((await f.createAgent("\u{1F600} 表情标题", query)).contentId);
    const imported = await f.import(query);
    assert.ok(!ids.includes(imported.contentId));
    const expected: PlatformContent[] = [];
    for (let offset = 0; offset < ids.length; offset += 50)
      expected.push(
        ...(
          await f.session().listPlatformContent({
            contentIds: ids.slice(offset, offset + 50),
            limit: 50,
          })
        ).map((item) => platformContentSchema.parse(item)),
      );
    for (const sort of ["updated", "created", "title"] as const) {
      const { api, pages } = directoryAdapter(f);
      let cursor: ContentSearchPage | undefined;
      const actual: PlatformContent[] = [];
      const matches: string[] = [];
      let more = true;
      while (more) {
        const page = await readContentSearchPage(
          api,
          {
            query,
            sort,
            projectId: f.projectId,
            appIds: ["morphz.objects", "morphz.reader", "morphz.script-studio"],
          },
          AbortSignal.timeout(15000),
          cursor,
        );
        assert.equal(page.state.searchError, "");
        assert.equal(page.count, ids.length);
        assert.ok(page.items.length <= 50);
        actual.push(...page.items);
        matches.push(...page.matches.map((hit) => hit.artifactId));
        cursor = page.state;
        more = page.hasMore;
      }
      const sorted = expected.toSorted((a, b) =>
        compareDirectoryContent(a, b, sort),
      );
      assert.deepEqual(
        actual.map((item) => item.id),
        sorted.map((item) => item.id),
      );
      assert.equal(new Set(actual.map((item) => item.id)).size, ids.length);
      assert.equal(matches.length, 57);
      assert.ok(pages.every((page) => (page.limit ?? 50) <= 51));
      assert.ok(
        pages.every((page) => page.query === query || !!page.contentIds),
      );
      assert.ok(
        pages.every((page) => !page.contentIds || page.contentIds.length <= 50),
      );
      // The independent SQL order, not just the comparator, agrees at every boundary.
      const all = await f.session().listPlatformContent({
        contentIds: actual.slice(0, 50).map((item) => item.id),
        sort,
        limit: 50,
      });
      assert.deepEqual(
        all.map((item) => item.id),
        actual.slice(0, 50).map((item) => item.id),
      );
      assert.deepEqual(
        directoryCursor(actual.at(-1)!, sort).contentId,
        actual.at(-1)!.id,
      );
    }
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("正文读取失败保留实际标题结果、显示失败，而非零结果或扫描原件", async () => {
  const f = await searchDomainFixture();
  try {
    const query = `title_${randomUUID()}`;
    const named = await f.createHuman(query, "正文");
    const { api } = directoryAdapter(f);
    api.search = async () => {
      throw new Error("controlled transport failure");
    };
    const page = await readContentSearchPage(
      api,
      { query, sort: "title", projectId: f.projectId },
      AbortSignal.timeout(5000),
    );
    assert.deepEqual(
      page.items.map((item) => item.id),
      [named.contentId],
    );
    assert.equal(page.count, 1);
    assert.match(page.state.searchError, /正文搜索暂不可用/);
    assert.equal(page.hasMore, false);
  } finally {
    await f.close();
  }
});

test("实际原件在搜索与目录读取之间被修订：旧引用摘要不进入列表", async () => {
  const f = await searchDomainFixture();
  try {
    const query = `body_${randomUUID()}`;
    const original = await f.createAgent("准确版本", query);
    const { api } = directoryAdapter(f);
    const search = api.search;
    api.search = async (request, signal) => {
      const result = await search(request, signal);
      await f.session().revisePlatformDocument({
        commandId: randomUUID(),
        contentId: original.contentId,
        expectedRevision: 1,
        title: "准确版本",
        markdown: "修订后的原文",
      });
      return result;
    };
    const page = await readContentSearchPage(
      api,
      { query, sort: "updated", projectId: f.projectId },
      AbortSignal.timeout(5000),
    );
    assert.equal(page.items.length, 0);
    assert.equal(page.matches.length, 0);
    assert.match(page.state.searchError, /正文搜索暂不可用/);
  } finally {
    await f.close();
  }
});
