import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { dataDirectory } from "../apps/service/src/paths.js";
import { localAccess, type Command } from "../packages/core/src/model.js";
const create = (): Command => ({
  commandId: randomUUID(),
  operation: {
    type: "create-artifact",
    projectId: "first-project",
    title: "持久保存",
    content: { kind: "document", markdown: "重启后仍然存在" },
  },
});
test("重启恢复、幂等请求与冲突不会静默丢数据", () => {
  const dir = mkdtempSync(join(tmpdir(), "morphzwork-store-test-")),
    path = join(dir, "workspace.sqlite");
  try {
    const first = new WorkspaceStore(path),
      request = create(),
      receipt = first.execute(request, localAccess);
    assert.deepEqual(first.execute(request, localAccess), receipt);
    assert.equal(first.snapshot().artifacts.length, 1);
    first.close();
    const second = new WorkspaceStore(path);
    assert.equal(second.snapshot().artifacts[0]!.title, "持久保存");
    assert.deepEqual(second.execute(request, localAccess), receipt);
    assert.throws(() =>
      second.execute(
        {
          ...request,
          operation: {
            ...request.operation,
            type: "create-project",
            title: "复用错误",
          },
        },
        localAccess,
      ),
    );
    assert.equal(second.snapshot().revision, 1);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    second.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});
test("两个存储连接使用同一版本权威", () => {
  const dir = mkdtempSync(join(tmpdir(), "morphzwork-concurrency-test-")),
    a = new WorkspaceStore(join(dir, "db")),
    b = new WorkspaceStore(join(dir, "db"));
  try {
    const r = a.execute(create(), localAccess),
      op = {
        type: "revise-artifact" as const,
        artifactId: r.entityId,
        expectedRevision: 1,
        title: "A 的修改",
        content: { kind: "document" as const, markdown: "A" },
      };
    a.execute({ commandId: randomUUID(), operation: op }, localAccess);
    assert.throws(
      () =>
        b.execute(
          { commandId: randomUUID(), operation: { ...op, title: "B 的修改" } },
          localAccess,
        ),
      /已有新版本/,
    );
    assert.equal(b.snapshot().artifacts[0]!.title, "A 的修改");
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true });
  }
});
test("未来数据库版本与损坏记录不得自动重置", () => {
  const dir = mkdtempSync(join(tmpdir(), "morphzwork-version-test-")),
    path = join(dir, "db");
  try {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA user_version=99");
    db.close();
    assert.throws(() => new WorkspaceStore(path), /版本高于/);
    const check = new DatabaseSync(path);
    assert.equal(
      (check.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
      99,
    );
    check.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});
test("图片去重且不接受 SVG 或任意文件", () => {
  const store = new WorkspaceStore(":memory:");
  try {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGmQAAAAASUVORK5CYII=",
      "base64",
    );
    const asset = store.addAsset(png);
    assert.deepEqual(store.addAsset(png), asset);
    assert.equal(store.asset(asset.assetId)?.mime, "image/png");
    assert.throws(
      () => store.addAsset(Buffer.from("<svg><script/></svg>")),
      /支持 PNG/,
    );
  } finally {
    store.close();
  }
});
test("默认数据位置不依赖当前目录；显式路径必须绝对", () => {
  assert.equal(
    dataDirectory({}, "darwin", "/users/test"),
    "/users/test/Library/Application Support/Morphz/application",
  );
  assert.equal(
    dataDirectory({}, "linux", "/users/test"),
    "/users/test/.local/share/morphz/application",
  );
  assert.equal(
    dataDirectory({ XDG_DATA_HOME: "/data" }, "linux", "/users/test"),
    "/data/morphz/application",
  );
  assert.equal(
    dataDirectory({ XDG_DATA_HOME: "relative" }, "linux", "/users/test"),
    "/users/test/.local/share/morphz/application",
  );
  assert.throws(
    () => dataDirectory({ MORPHZWORK_DATA_DIR: "data" }),
    /绝对路径/,
  );
  assert.equal(
    dataDirectory({ LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" }, "win32"),
    "C:\\Users\\test\\AppData\\Local\\Morphz\\application",
  );
  assert.throws(
    () => dataDirectory({ LOCALAPPDATA: "relative" }, "win32"),
    /LOCALAPPDATA/,
  );
});
