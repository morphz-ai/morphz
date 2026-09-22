import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorkspaceStore } from "../apps/service/src/store.js";
import {
  initialWorkspace,
  localAccess,
  type Workspace,
} from "../packages/core/src/model.js";
import { documentImportIssue } from "../packages/core/src/sources.js";
import {
  readArtifact,
  searchArtifacts,
} from "../packages/core/src/retrieval.js";

const importCommand = (
  text = "这是可检索的资料。共享上下文保持来源可追溯。",
) => ({
  commandId: randomUUID(),
  operation: {
    type: "import-document",
    projectId: "first-project",
    relativePath: "docs/notes.md",
    text,
  },
});

test("资料导入：来源、幂等、修订和引用原文保持一致", () => {
  const store = new WorkspaceStore(":memory:");
  try {
    const command = importCommand();
    const receipt = store.execute(command, localAccess);
    assert.deepEqual(store.execute(command, localAccess), receipt);
    const state = store.snapshot(),
      artifact = state.artifacts[0]!;
    assert.equal(state.artifacts.length, 1);
    assert.equal(artifact.source?.relativePath, "docs/notes.md");
    assert.equal(artifact.source?.mode, "copy");
    const results = searchArtifacts(
      state,
      { query: "共享上下文" },
      localAccess,
    );
    assert.equal(results.total, 0, "外部资料不进入 Agent 成果索引");
    assert.deepEqual(
      readArtifact(state, artifact.id, localAccess).content,
      artifact.content,
    );
    store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "revise-artifact",
          artifactId: artifact.id,
          expectedRevision: 1,
          title: "编辑后的文章",
          content: { kind: "document", markdown: "完全不同的新内容" },
        },
      },
      localAccess,
    );
    assert.equal(
      searchArtifacts(store.snapshot(), { query: "共享上下文" }, localAccess)
        .total,
      0,
    );
    const previous = readArtifact(
      store.snapshot(),
      artifact.id,
      localAccess,
      1,
    );
    assert.equal(
      previous.content.kind === "document" && previous.content.markdown,
      command.operation.text,
    );
    assert.equal(store.snapshot().artifacts[0]!.source?.importedRevision, 1);
  } finally {
    store.close();
  }
});

test("未授权结果、计数、正文和历史版本均不可读取；Actor 不得伪造", () => {
  const store = new WorkspaceStore(":memory:");
  try {
    store.execute(importCommand("私有资料 needle"), localAccess);
    const state = store.snapshot();
    state.principals.push({ id: "guest", name: "访客" });
    state.actants.push({
      id: "guest-human",
      name: "访客",
      kind: "human",
      principalId: "guest",
    });
    const guest = { principalId: "guest", actantId: "guest-human" };
    assert.equal(searchArtifacts(state, { query: "needle" }, guest).total, 0);
    assert.throws(
      () =>
        searchArtifacts(
          state,
          { query: "needle", projectId: "first-project" },
          guest,
        ),
      /没有访问/,
    );
    assert.throws(
      () => readArtifact(state, state.artifacts[0]!.id, guest, 1),
      /没有访问/,
    );
    assert.throws(
      () =>
        searchArtifacts(
          state,
          { query: "needle" },
          { principalId: "local-owner", actantId: "guest-human" },
        ),
      /主体不匹配/,
    );
  } finally {
    store.close();
  }
});

test("导入拒绝隐藏文件、越界路径、凭据、二进制、私钥和超限文本", () => {
  for (const path of [
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
  ])
    assert.ok(documentImportIssue(path), path);
  assert.equal(documentImportIssue("文档/设计说明.md"), null);
  const store = new WorkspaceStore(":memory:");
  try {
    for (const text of [
      "hello\0world",
      "-----BEGIN RSA PRIVATE KEY-----",
      "中".repeat(2000001),
    ])
      assert.throws(() => store.execute(importCommand(text), localAccess));
    const command = importCommand();
    assert.throws(() =>
      store.execute(
        {
          ...command,
          operation: { ...command.operation, relativePath: "../a.md" },
        },
        localAccess,
      ),
    );
    assert.equal(store.snapshot().artifacts.length, 0);
  } finally {
    store.close();
  }
});

test("旧数据库无来源字段可升级，保留原对象，旧版本不能重新打开新库", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "morphz-application-migration-"),
  );
  const path = join(directory, "workspace.sqlite");
  try {
    const store = new WorkspaceStore(path);
    store.execute(importCommand(), localAccess);
    store.close();
    const legacy = new DatabaseSync(path);
    const state = JSON.parse(
      (
        legacy.prepare("SELECT body FROM workspace WHERE id=1").get() as {
          body: string;
        }
      ).body,
    );
    delete state.artifacts[0].source;
    legacy.prepare("UPDATE workspace SET body=?").run(JSON.stringify(state));
    legacy.exec("PRAGMA user_version=1");
    legacy.close();
    const migrated = new WorkspaceStore(path);
    assert.equal(migrated.snapshot().artifacts.length, 1);
    assert.equal(migrated.snapshot().artifacts[0]!.source, null);
    migrated.close();
    const db = new DatabaseSync(path);
    assert.equal(
      (db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
      15,
    );
    db.close();
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("搜索分页稳定，支持中英文和字面符号，不执行查询语法", () => {
  const state: Workspace = initialWorkspace();
  const store = new WorkspaceStore(":memory:");
  try {
    for (let i = 0; i < 23; i++)
      store.execute(
        {
          commandId: randomUUID(),
          operation: {
            type: "create-artifact",
            projectId: "first-project",
            title: "Agent 成果",
            content: {
              kind: "document",
              markdown: 'PrefixCache 与引用 %_"OR*',
            },
          },
        },
        { principalId: "morphz-service", actantId: "morphz-agent" },
      );
    Object.assign(state, store.snapshot());
    const first = searchArtifacts(
      state,
      { query: "prefixcache", limit: 20 },
      localAccess,
    );
    const second = searchArtifacts(
      state,
      { query: "prefixcache", offset: 20 },
      localAccess,
    );
    assert.equal(first.total, 23);
    assert.equal(first.hits.length, 20);
    assert.equal(second.hits.length, 3);
    assert.equal(
      new Set([...first.hits, ...second.hits].map((h) => h.artifactId)).size,
      23,
    );
    assert.equal(
      searchArtifacts(state, { query: '%_"OR*' }, localAccess).total,
      23,
    );
    assert.throws(() => searchArtifacts(state, { query: "" }, localAccess));
    assert.throws(() =>
      searchArtifacts(state, { query: "a", limit: 1000000 }, localAccess),
    );
  } finally {
    store.close();
  }
});
