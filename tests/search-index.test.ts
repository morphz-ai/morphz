import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { localAccess, type Content } from "../packages/core/src/model.js";
import { searchArtifacts } from "../packages/core/src/retrieval.js";

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
    localAccess,
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
test("索引更新与修订原子提交，冲突和重启不会留下过期或重复结果", () => {
  const dir = mkdtempSync(join(tmpdir(), "morphzwork-index-")),
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
  const dir = mkdtempSync(join(tmpdir(), "morphzwork-index-access-")),
    path = join(dir, "db");
  try {
    const store = new WorkspaceStore(path);
    const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGmQAAAAASUVORK5CYII=",
        "base64",
      ),
      { assetId } = store.addAsset(png);
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
    assert.ok(reopened.visibleAsset(assetId, other));
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});
