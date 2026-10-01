import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { localAccess } from "../packages/core/src/model.js";
import { searchArtifacts } from "../packages/core/src/retrieval.js";
import { searchDomainFixture } from "./search-domain-fixture.js";
import { viewModelFixture } from "./view-model-fixture.js";

const forbidden = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "forbidden";

test("实际索引重开只保留 Agent 正文；导入原件、来源和历史不受搜索策略影响", async () => {
  const f = await searchDomainFixture();
  try {
    const generated = await f.createAgent("生成笔记", "共同词 Agent 搜索产物");
    const imported = await f.import("共同词 外部全文");
    const original = await f.readOriginal(imported.objectId);
    await f.assertIndexOnly([generated.objectId]);
    await f.reopen();
    assert.deepEqual(await f.readOriginal(imported.objectId), original);
    await f.assertIndexOnly([generated.objectId]);
    assert.deepEqual(
      (await f.search({ query: "共同词" })).hits.map((hit) => hit.artifactId),
      [generated.contentId],
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("只索引 Agent 原创正文；人工及导入可按目录标题查找，人工编辑不改来源", async () => {
  const f = await searchDomainFixture();
  try {
    const generated = await f.createAgent(
      "共同词 Agent 成果",
      "共同词 正文needle",
    );
    const imported = await f.import("共同词 正文needle 外部材料", "共同词.md");
    const human = await f.createHuman("共同词 人工文档", "共同词 正文needle");
    await f.session().revisePlatformDocument({
      commandId: randomUUID(),
      contentId: generated.contentId,
      expectedRevision: 1,
      title: "共同词 已人工编辑",
      markdown: "共同词 正文needle 保留来源",
    });
    assert.deepEqual(
      (await f.search({ query: "正文needle" })).hits.map(
        (hit) => hit.artifactId,
      ),
      [generated.contentId],
    );
    await f.assertIndexOnly([generated.objectId]);
    assert.deepEqual(
      new Set(
        (await f.search({ query: "共同词" })).hits.map((hit) => hit.artifactId),
      ),
      new Set([generated.contentId, imported.contentId, human.contentId]),
    );
    assert.equal(
      (await f.readOriginal(imported.objectId)).content.kind,
      "document",
    );
    assert.equal(
      (await f.readOriginal(human.objectId)).content.kind,
      "document",
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("实际持久索引按字面字符查询；短中文、Unicode与符号不变成 FTS 表达式", async () => {
  const f = await searchDomainFixture();
  try {
    const bodies = [
      "蝴蝶上下文资料 文档 Alpha",
      'quote "arrow" 100% _ [] OR AND NEAR',
      "École ĀSTRA uppercase ASPEN",
      "multi\nline",
      "a bb ccc",
      "中🙂文🙂字",
      "无匹配",
    ];
    const references: Array<{ contentId: string }> = [];
    for (const body of bodies)
      references.push(await f.createAgent("索引资料", body));
    // Expected matches are calculated from literal terms, not a second index or SQL store.
    for (const query of [
      "蝴蝶",
      "上下文",
      "alpha",
      '"arrow"',
      "%",
      "[] OR",
      "_ []",
      "OR AND",
      "école",
      "āstra",
      "multi\nline",
      "🙂",
      "中🙂文",
      "ccc",
      "missing",
    ]) {
      const terms = query.toLocaleLowerCase().trim().split(/\s+/u);
      const expected = references
        .filter((_, i) =>
          terms.every((term) => bodies[i]!.toLocaleLowerCase().includes(term)),
        )
        .map((entry) => entry.contentId);
      const actual = await f.search({ query, limit: 1 });
      assert.equal(actual.total, expected.length, query);
      assert.ok(
        actual.hits.every((hit) => expected.includes(hit.artifactId)),
        query,
      );
      assert.equal(actual.hits.length, Math.min(1, expected.length), query);
    }
    Object.defineProperty(f.host.transport, "snapshot", {
      value: () => {
        throw new Error("Search must not deserialize workspace");
      },
    });
    assert.equal((await f.search({ query: "上下文" })).total, 1);
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("实际多关键词按 AND 跨标题和正文匹配，分页无重复，摘录来自确切正文", async () => {
  const f = await searchDomainFixture();
  try {
    const title = await f.createAgent("交互验收报告", "完成桌面检查。");
    const mixedText =
      "前言。".repeat(150) + "验收结果：Alpha 与上下文一起保留。";
    const mixed = await f.createAgent("交互记录", mixedText);
    const body = await f.createAgent(
      "只有正文命中",
      "验收完成后，继续交互检查。",
    );
    await f.createAgent("交互但没有另一关键词");
    const literal = await f.createAgent(
      "符号原文",
      'Alpha 引号 "arrow" 100% _ [] OR AND NEAR',
    );
    const expected = new Set([
      title.contentId,
      mixed.contentId,
      body.contentId,
    ]);
    for (const query of [
      "交互 验收",
      "验收 交互",
      "  交互\t验收\n交互  ",
      "交互　验收",
    ])
      assert.deepEqual(
        new Set((await f.search({ query })).hits.map((hit) => hit.artifactId)),
        expected,
        query,
      );
    for (const [query, expectedId] of [
      ["交互 Alpha", mixed.contentId],
      ["上下文 alpha", mixed.contentId],
      ['ALPHA "arrow"', literal.contentId],
      ['"arrow" [] OR', literal.contentId],
      ["100% AND _", literal.contentId],
    ])
      assert.deepEqual(
        (await f.search({ query: query! })).hits.map((hit) => hit.artifactId),
        [expectedId],
        query,
      );
    const hits = (await f.search({ query: "交互 验收" })).hits;
    assert.equal(hits[0]!.artifactId, title.contentId, "目录标题匹配优先");
    const excerpt = hits.find((hit) => hit.artifactId === mixed.contentId)!;
    assert.match(excerpt.excerpt, /验收结果/);
    assert.ok(mixedText.includes(excerpt.quote));
    assert.equal((await f.search({ query: "交互 不存在的词" })).total, 0);
    const first = await f.search({ query: "交互 验收", limit: 2 });
    const second = await f.search({ query: "交互 验收", limit: 2, offset: 2 });
    assert.equal(first.total, 3);
    assert.equal(first.hasMore, true);
    assert.equal(second.hits.length, 1);
    assert.deepEqual(
      new Set([...first.hits, ...second.hits].map((hit) => hit.artifactId)),
      expected,
    );
    assert.equal(
      (await f.search({ query: "交互 验收", projectId: f.projectId })).total,
      3,
    );
  } finally {
    await f.close();
  }
});

test("PDF 多词及跨页引用的纯文本匹配规则不拼接单词；不冒充 PDF 存储或搜索接线", () => {
  const fixture = viewModelFixture();
  const pages = ["第一页的 alpha 和边界甲", "乙边界及 beta 的检查结果"];
  fixture.seedArtifact({
    projectId: "first-project",
    title: "多词检索",
    content: { kind: "pdf", assetId: "a".repeat(64), pages },
    createdBy: { principalId: "morphz-service", actantId: "morphz-agent" },
  });
  for (const query of [
    "alpha beta",
    "多词检索 beta",
    "甲乙",
    "alpha missing",
  ]) {
    const actual = searchArtifacts(fixture.state, { query }, localAccess);
    for (const hit of actual.hits) {
      assert.ok(pages[hit.page! - 1]!.includes(hit.quote));
      assert.ok(hit.quote.length <= 260);
    }
  }
  assert.equal(
    searchArtifacts(fixture.state, { query: "alpha beta" }, localAccess).total,
    1,
  );
  assert.equal(
    searchArtifacts(fixture.state, { query: "多词检索 beta" }, localAccess)
      .hits[0]!.page,
    2,
  );
  assert.equal(
    searchArtifacts(fixture.state, { query: "甲乙" }, localAccess).total,
    0,
  );
});

test("实际索引和正文修订同事务；冲突、幂等和冷重开不留过期或重复命中", async () => {
  const f = await searchDomainFixture();
  try {
    const original = await f.createAgent("索引", "before-content");
    const command = {
      commandId: randomUUID(),
      contentId: original.contentId,
      expectedRevision: 1,
      title: "索引",
      markdown: "after-content",
    };
    const receipt = await f.session().revisePlatformDocument(command);
    assert.deepEqual(
      await f.session().revisePlatformDocument(command),
      receipt,
    );
    await assert.rejects(
      f
        .session()
        .revisePlatformDocument({ ...command, commandId: randomUUID() }),
      /版本|冲突|变化/,
    );
    assert.equal((await f.search({ query: "before" })).total, 0);
    assert.equal((await f.search({ query: "after" })).hits[0]!.revision, 2);
    await f.reopen();
    assert.equal((await f.search({ query: "after" })).total, 1);
    assert.equal(
      (
        await f
          .session()
          .readPlatformDocument({ contentId: original.contentId, revision: 1 })
      ).markdown,
      "before-content",
    );
    assert.deepEqual(
      await f.session().revisePlatformDocument(command),
      receipt,
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("真实未授权身份不能取得搜索计数、正文、历史或未关联图片字节", async () => {
  const other = { principalId: "other", actantId: "other-human" };
  const f = await searchDomainFixture({ additionalHumans: [other] });
  try {
    const original = await f.createAgent(
      "私有目录标题",
      "only-secret hidden-body",
    );
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGmQAAAAASUVORK5CYII=",
      "base64",
    );
    const { assetId } = await f.session().addAsset(png);
    await assert.rejects(
      f.session().asset(assetId),
      /不存在|权限|无权|不可读取/,
    );
    const image = await f.session().createPlatformImage({
      commandId: randomUUID(),
      objectId: randomUUID(),
      projectId: f.projectId,
      title: "私有图片",
      assetId,
      alt: "原始图片",
    });
    assert.deepEqual((await f.session().asset(assetId))!.bytes, png);
    assert.equal((await f.search({ query: "hidden" }, other)).total, 0);
    assert.equal(
      (await f.search({ query: "only-secret hidden" }, other)).total,
      0,
    );
    await assert.rejects(
      f
        .session(other)
        .readPlatformDocument({ contentId: original.contentId, revision: 1 }),
      /不存在|权限|无权|不可用/,
    );
    await assert.rejects(
      f.session(other).asset(assetId),
      /不存在|权限|无权|不可读取/,
    );
    await assert.rejects(
      f.search({ query: "hidden", projectId: f.projectId }, other),
      forbidden,
    );
    await assert.rejects(
      f.search(
        { query: "hidden" },
        { ...localAccess, actantId: other.actantId },
      ),
      forbidden,
    );
    assert.equal((await f.search({ query: "hidden" })).total, 1);
    assert.equal(
      (await f.session().getPlatformContent({ contentId: image.contentId }))
        .appObjectId,
      image.objectId,
    );
    await f.reopen();
    assert.equal((await f.search({ query: "hidden" }, other)).total, 0);
    assert.deepEqual((await f.session().asset(assetId))!.bytes, png);
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});
