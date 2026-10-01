import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { localAccess } from "../packages/core/src/model.js";
import { documentImportIssue } from "../packages/core/src/sources.js";
import { searchDomainFixture } from "./search-domain-fixture.js";

test("实际资料导入：来源、幂等、修订和历史原文保持一致", async () => {
  const f = await searchDomainFixture();
  try {
    const text = "这是可检索的资料。共享上下文保持来源可追溯。";
    const commandId = randomUUID(),
      objectId = randomUUID();
    const receipt = await f.import(text, "docs/notes.md", commandId, objectId);
    assert.deepEqual(
      await f.import(text, "docs/notes.md", commandId, objectId),
      receipt,
    );
    assert.equal(
      (await f.session().listPlatformContent({ projectId: f.projectId }))
        .length,
      1,
    );
    const original = await f.readOriginal(objectId);
    assert.equal(original.source?.relativePath, "docs/notes.md");
    assert.equal(original.source?.mode, "copy");
    assert.equal(
      (await f.search({ query: "共享上下文" })).total,
      0,
      "导入正文不进入 Agent 成果索引",
    );
    assert.equal(original.content.kind, "document");
    assert.equal(
      original.content.kind === "document" && original.content.markdown,
      text,
    );
    await f
      .session()
      .revisePlatformDocument({
        commandId: randomUUID(),
        contentId: receipt.contentId,
        expectedRevision: 1,
        title: "编辑后的文章",
        markdown: "完全不同的新内容",
      });
    assert.equal((await f.search({ query: "共享上下文" })).total, 0);
    assert.equal(
      (
        await f
          .session()
          .readPlatformDocument({ contentId: receipt.contentId, revision: 1 })
      ).markdown,
      text,
    );
    assert.equal((await f.readOriginal(objectId)).source?.importedRevision, 1);
    await f.reopen();
    assert.equal(
      (
        await f
          .session()
          .readPlatformDocument({ contentId: receipt.contentId, revision: 1 })
      ).markdown,
      text,
    );
    assert.equal(
      (await f.session().readPlatformDocument({ contentId: receipt.contentId }))
        .revision,
      2,
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("未授权结果、计数、正文和历史版本均不可读取；Actor 不得伪造", async () => {
  const f = await searchDomainFixture();
  try {
    const receipt = await f.createAgent("私有资料", "私有 needle 原文");
    const guest = { principalId: "guest", actantId: "guest-human" };
    await assert.rejects(
      f.search({ query: "needle" }, guest),
      (error: any) => error.code === "forbidden",
    );
    await assert.rejects(
      f.search({ query: "needle", projectId: f.projectId }, guest),
      (error: any) => error.code === "forbidden",
    );
    await assert.rejects(
      f
        .session(guest)
        .readPlatformDocument({ contentId: receipt.contentId, revision: 1 }),
      (error: any) => error.code === "forbidden",
    );
    await assert.rejects(
      f.search(
        { query: "needle" },
        { ...localAccess, actantId: "guest-human" },
      ),
      (error: any) => error.code === "forbidden",
    );
    assert.equal((await f.search({ query: "needle" })).total, 1);
    assert.equal(
      (
        await f
          .session()
          .readPlatformDocument({ contentId: receipt.contentId, revision: 1 })
      ).markdown,
      "私有 needle 原文",
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("正式导入拒绝隐藏文件、越界路径、凭据、二进制、私钥和超限文本", async () => {
  const paths = [
    ".env",
    "docs/.env.md",
    "a/../secret.md",
    "/tmp/a.md",
    "C:\\a.md",
    "docs/secrets.txt",
    "node_modules/a.md",
    "dist/a.md",
    "target/a.txt",
    ".git/a.md",
    "a.sqlite",
    "a.md\0.txt",
  ];
  for (const path of paths) assert.ok(documentImportIssue(path), path);
  assert.equal(documentImportIssue("文档/设计说明.md"), null);
  const f = await searchDomainFixture();
  try {
    for (const text of [
      "hello\0world",
      "-----BEGIN RSA PRIVATE KEY-----",
      "中".repeat(2000001),
    ])
      await assert.rejects(async () => f.import(text));
    for (const path of paths)
      await assert.rejects(async () => f.import("不能保存", path));
    assert.deepEqual(
      await f.session().listPlatformContent({ projectId: f.projectId }),
      [],
    );
    assert.equal(
      (
        await f.host.withHuman((actor) =>
          f.host.domains.content.platform.listContent(actor),
        )
      ).length,
      0,
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("实际索引分页稳定，支持中英文和字面符号，不执行查询语法", async () => {
  const f = await searchDomainFixture();
  try {
    for (let i = 0; i < 23; i++)
      await f.createAgent("Agent 成果", 'PrefixCache 与引用 %_"OR*');
    const first = await f.search({ query: "prefixcache", limit: 20 });
    const second = await f.search({ query: "prefixcache", offset: 20 });
    assert.equal(first.total, 23);
    assert.equal(first.hits.length, 20);
    assert.equal(second.hits.length, 3);
    assert.equal(
      new Set([...first.hits, ...second.hits].map((h) => h.artifactId)).size,
      23,
    );
    assert.equal((await f.search({ query: '%_"OR*' })).total, 23);
    await assert.rejects(async () => f.search({ query: "" }));
    await assert.rejects(async () => f.search({ query: "a", limit: 1000000 }));
    await f.reopen();
    assert.equal((await f.search({ query: "prefixcache" })).total, 23);
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

// Whole-workspace source-field migrations were an unreleased development
// model, not a supported data format. Exact original/history persistence is
// covered above; future/corrupt authority refusal is in storage.test.ts.
