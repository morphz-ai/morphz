import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { localAccess, type Content } from "../packages/core/src/model.js";
import { searchArtifacts } from "../packages/core/src/retrieval.js";
const agent = { principalId: "morphz-service", actantId: "morphz-agent" };

test("重开清除旧外部全文投影，不改原对象、版本和附件可见性", () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-index-boundary-"));
  const file = join(directory, "workspace.sqlite");
  let store = new WorkspaceStore(file);
  try {
    const generated = create(store, "保留 Agent 搜索产物");
    const imported = store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "import-document",
          projectId: "first-project",
          relativePath: "external.md",
          text: "旧外部全文",
        },
      },
      localAccess,
    );
    const pdf = store.addPdf(
      readFileSync(new URL("./fixtures/reader.pdf", import.meta.url)),
      ["retained PDF"],
      localAccess,
    );
    store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "import-pdf",
          projectId: "first-project",
          relativePath: "reader.pdf",
          content: pdf,
        },
      },
      localAccess,
    );
    const before = store.snapshot();
    store.close();
    const db = new DatabaseSync(file);
    // Recreate an index row left by the former all-artifact policy.
    db.prepare(
      "INSERT INTO search_object(id,project,revision,title,title_fold,body,body_fold,meta) SELECT ?,project,revision,title,title_fold,body,body_fold,meta FROM search_object WHERE id=?",
    ).run(imported.entityId, generated.entityId);
    db.close();
    store = new WorkspaceStore(file);
    assert.deepEqual(store.snapshot(), before);
    const projection = new DatabaseSync(file, { readOnly: true });
    assert.deepEqual(
      projection
        .prepare("SELECT id FROM search_object")
        .all()
        .map((r) => r.id),
      [generated.entityId],
    );
    assert.ok(
      projection
        .prepare("SELECT 1 FROM asset_project WHERE asset=?")
        .get(pdf.assetId),
    );
    projection.close();
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("只索引 Agent 原生产物：旧导入与人工文档仍可读取，人工后续编辑不改变产物来源", () => {
  const store = new WorkspaceStore(":memory:");
  try {
    const artifact = create(store, "共同词 Agent 成果");
    const imported = store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "import-document",
          projectId: "first-project",
          relativePath: "共同词.md",
          text: "共同词 外部材料",
        },
      },
      localAccess,
    );
    const human = store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "create-artifact",
          projectId: "first-project",
          title: "共同词 人工文档",
          content: { kind: "document", markdown: "共同词" },
        },
      },
      localAccess,
    );
    store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "revise-artifact",
          artifactId: artifact.entityId,
          expectedRevision: 1,
          title: "共同词 已人工编辑",
          content: { kind: "document", markdown: "共同词 保留来源" },
        },
      },
      localAccess,
    );
    assert.deepEqual(
      store
        .search({ query: "共同词" }, localAccess)
        .hits.map((h) => h.artifactId),
      [artifact.entityId],
    );
    assert.deepEqual(
      store.search({ query: "共同词" }, localAccess),
      searchArtifacts(store.snapshot(), { query: "共同词" }, localAccess),
    );
    assert.ok(
      store.snapshot().artifacts.find((a) => a.id === imported.entityId),
    );
    assert.ok(store.snapshot().artifacts.find((a) => a.id === human.entityId));
  } finally {
    store.close();
  }
});

function create(
  store: WorkspaceStore,
  title: string,
  content: Content = { kind: "document", markdown: title },
) {
  return store.execute(
    {
      commandId: randomUUID(),
      operation: {
        type: "create-artifact",
        projectId: "first-project",
        title,
        content,
      },
    },
    agent,
  );
}
test("持久索引与领域检索一致，短中文和查询符号不变成 FTS 表达式", () => {
  const store = new WorkspaceStore(":memory:");
  try {
    for (const body of [
      "蝴蝶上下文资料 文档 Alpha",
      'quote "arrow" 100% _ [] OR AND NEAR',
      "École ĀSTRA uppercase ASPEN",
      "multi\nline",
      "a bb ccc",
      "中🙂文🙂字",
      "无匹配",
    ])
      create(store, "索引资料", { kind: "document", markdown: body });
    const state = store.snapshot();
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
      assert.deepEqual(
        store.search({ query, limit: 1 }, localAccess),
        searchArtifacts(state, { query, limit: 1 }, localAccess),
        query,
      );
    }
    store.snapshot = () => {
      throw new Error("Search must not deserialize workspace");
    };
    assert.equal(store.search({ query: "上下文" }, localAccess).total, 1);
  } finally {
    store.close();
  }
});

test("多关键词按 AND 跨标题和正文匹配，空白、次序、重复与字面符号保持一致", () => {
  const store = new WorkspaceStore(":memory:");
  try {
    const titleHit = create(store, "交互验收报告", {
      kind: "document",
      markdown: "完成桌面检查。",
    });
    const mixedHit = create(store, "交互记录", {
      kind: "document",
      markdown: "前言。".repeat(150) + "验收结果：Alpha 与上下文一起保留。",
    });
    const bodyHit = create(store, "只有正文命中", {
      kind: "document",
      markdown: "验收完成后，继续交互检查。",
    });
    create(store, "交互但没有另一关键词");
    const literal = create(store, "符号原文", {
      kind: "document",
      markdown: 'Alpha 引号 "arrow" 100% _ [] OR AND NEAR',
    });
    const state = store.snapshot();
    const searches = [
      "交互 验收",
      "验收 交互",
      "  交互\t验收\n交互  ",
      "交互　验收",
      "交互 Alpha",
      "上下文 alpha",
      'ALPHA "arrow"',
      '"arrow" [] OR',
      "100% AND _",
      "交互 不存在的词",
    ];
    for (const query of searches) {
      assert.deepEqual(
        store.search({ query }, localAccess),
        searchArtifacts(state, { query }, localAccess),
        query,
      );
    }
    const hits = store.search({ query: "交互 验收" }, localAccess).hits;
    assert.deepEqual(
      new Set(hits.map((hit) => hit.artifactId)),
      new Set([titleHit.entityId, mixedHit.entityId, bodyHit.entityId]),
    );
    assert.equal(hits.at(-1)!.artifactId, bodyHit.entityId);
    const mixed = hits.find((hit) => hit.artifactId === mixedHit.entityId)!;
    assert.match(mixed.excerpt, /验收结果/);
    assert.ok(
      state.artifacts.find((item) => item.id === mixed.artifactId)!.content
        .kind === "document",
    );
    assert.equal(
      store.search({ query: 'ALPHA "arrow"' }, localAccess).hits[0]!.artifactId,
      literal.entityId,
    );
    assert.equal(
      store.search({ query: "交互 不存在的词" }, localAccess).total,
      0,
    );
    const first = store.search({ query: "交互 验收", limit: 2 }, localAccess);
    const second = store.search(
      { query: "交互 验收", limit: 2, offset: 2 },
      localAccess,
    );
    assert.equal(first.total, 3);
    assert.equal(first.hasMore, true);
    assert.equal(second.hits.length, 1);
    assert.equal(
      new Set([...first.hits, ...second.hits].map((hit) => hit.artifactId))
        .size,
      3,
    );
    assert.equal(
      store.search(
        { query: "交互 验收", projectId: "first-project" },
        localAccess,
      ).total,
      3,
    );
  } finally {
    store.close();
  }
});

test("PDF 多词可跨页匹配，但单词不能跨页拼接；引用仍是某一页的原文", () => {
  const store = new WorkspaceStore(":memory:");
  try {
    const pages = ["第一页的 alpha 和边界甲", "乙边界及 beta 的检查结果"];
    const content = store.addPdf(
      readFileSync(new URL("./fixtures/reader.pdf", import.meta.url)),
      pages,
      agent,
    );
    store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "create-artifact",
          projectId: "first-project",
          title: "多词检索",
          content,
        },
      },
      agent,
    );
    const state = store.snapshot();
    for (const query of [
      "alpha beta",
      "多词检索 beta",
      "甲乙",
      "alpha missing",
    ]) {
      const actual = store.search({ query }, localAccess);
      assert.deepEqual(
        actual,
        searchArtifacts(state, { query }, localAccess),
        query,
      );
      if (actual.hits[0]) {
        const hit = actual.hits[0];
        assert.ok(pages[hit.page! - 1]!.includes(hit.quote));
        assert.ok(hit.quote.length <= 260);
      }
    }
    assert.equal(store.search({ query: "alpha beta" }, localAccess).total, 1);
    assert.equal(
      store.search({ query: "多词检索 beta" }, localAccess).hits[0]!.page,
      2,
    );
    assert.equal(store.search({ query: "甲乙" }, localAccess).total, 0);
  } finally {
    store.close();
  }
});
test("索引更新与修订原子提交，冲突和重启不会留下过期或重复结果", () => {
  const dir = mkdtempSync(join(tmpdir(), "morphz-application-index-")),
    path = join(dir, "db");
  try {
    const store = new WorkspaceStore(path);
    const { entityId } = create(store, "索引", {
      kind: "document",
      markdown: "before-content",
    });
    const command = {
      commandId: randomUUID(),
      operation: {
        type: "revise-artifact",
        artifactId: entityId,
        expectedRevision: 1,
        title: "索引",
        content: { kind: "document", markdown: "after-content" },
      },
    };
    store.execute(command, localAccess);
    store.execute(command, localAccess);
    assert.throws(
      () => store.execute({ ...command, commandId: randomUUID() }, localAccess),
      /已有新版本/,
    );
    assert.equal(store.search({ query: "before" }, localAccess).total, 0);
    assert.equal(
      store.search({ query: "after" }, localAccess).hits[0]!.revision,
      2,
    );
    store.close();
    const reopened = new WorkspaceStore(path);
    assert.equal(reopened.search({ query: "after" }, localAccess).total, 1);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});
test("检索计数、原文和原始文件在授权投影内过滤；未关联上传不可公开读取", () => {
  const dir = mkdtempSync(join(tmpdir(), "morphz-application-index-access-")),
    path = join(dir, "db");
  try {
    const store = new WorkspaceStore(path);
    const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGmQAAAAASUVORK5CYII=",
        "base64",
      ),
      { assetId } = store.addAsset(png, agent);
    assert.equal(store.visibleAsset(assetId, localAccess), undefined);
    create(store, "only-secret", {
      kind: "image",
      assetId,
      alt: "hidden-body",
    });
    assert.ok(store.visibleAsset(assetId, localAccess));
    store.close();
    // Fixtures deliberately emulate a different Principal's project, without a production bypass API.
    const db = new DatabaseSync(path),
      state = JSON.parse(
        (db.prepare("SELECT body FROM workspace").get() as { body: string })
          .body,
      );
    state.principals.push({ id: "other", name: "另一个身份" });
    state.actants.push({
      id: "other-human",
      principalId: "other",
      kind: "human",
      name: "另一个人",
    });
    state.projects[0].members = ["other"];
    db.prepare("UPDATE workspace SET body=?").run(JSON.stringify(state));
    db.close();
    const reopened = new WorkspaceStore(path);
    assert.equal(reopened.search({ query: "hidden" }, localAccess).total, 0);
    assert.equal(
      reopened.search({ query: "only-secret hidden" }, localAccess).total,
      0,
    );
    assert.equal(reopened.visibleAsset(assetId, localAccess), undefined);
    assert.throws(
      () =>
        reopened.search(
          { query: "hidden", projectId: "first-project" },
          localAccess,
        ),
      /没有访问/,
    );
    assert.throws(
      () =>
        reopened.search(
          { query: "hidden" },
          { ...localAccess, actantId: "other-human" },
        ),
      /不匹配/,
    );
    const other = { principalId: "other", actantId: "other-human" };
    assert.equal(reopened.search({ query: "hidden" }, other).total, 1);
    assert.equal(
      reopened.search({ query: "only-secret hidden" }, other).total,
      1,
    );
    assert.ok(reopened.visibleAsset(assetId, other));
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});
