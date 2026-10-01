import test from "node:test";
import assert from "node:assert/strict";
import { runPendingFileImport } from "../apps/web/src/pending-file-import.js";

function storage(rows = new Map<string, unknown>()) {
  return {
    rows,
    readLocal<T>(key: string, fallback: T): T {
      return (rows.get(key) as T | undefined) ?? fallback;
    },
    writeLocal(key: string, value: unknown) {
      rows.set(key, value);
    },
    removeLocal(key: string) {
      rows.delete(key);
    },
  };
}

const file = {
  method: "reader.import" as const,
  projectId: "project-one",
  relativePath: "history.epub",
  bytes: new TextEncoder().encode("same book"),
};

test("书籍导入未收到回执时，重试复用命令 ID；确认后重新导入使用新 ID", async () => {
  const saved = storage();
  const sent: string[] = [];
  await assert.rejects(
    runPendingFileImport(
      file,
      saved,
      async (commandId) => {
        sent.push(commandId);
        throw new Error("响应丢失，提交结果不确定");
      },
      async () => {},
    ),
    /响应丢失/,
  );
  assert.equal(saved.rows.size, 1);
  const result = await runPendingFileImport(
    file,
    storage(saved.rows),
    async (commandId) => {
      sent.push(commandId);
      return { entityId: "original-one" };
    },
    async () => {},
  );
  assert.deepEqual(result, { entityId: "original-one" });
  assert.equal(sent[0], sent[1]);
  assert.equal(saved.rows.size, 0);
  await runPendingFileImport(
    file,
    saved,
    async (commandId) => {
      sent.push(commandId);
      return { entityId: "original-two" };
    },
    async () => {},
  );
  assert.notEqual(sent[2], sent[1]);
});

test("原件可能已提交但目录刷新失败时，PDF 重试仍用原命令 ID", async () => {
  const saved = storage();
  const request = { ...file, method: "pdf.import" as const };
  const sent: string[] = [];
  await assert.rejects(
    runPendingFileImport(
      request,
      saved,
      async (commandId) => {
        sent.push(commandId);
        return { entityId: "pdf-one" };
      },
      async () => {
        throw new Error("目录刷新失败");
      },
    ),
    /目录刷新失败/,
  );
  assert.equal(saved.rows.size, 1);
  await runPendingFileImport(
    request,
    saved,
    async (commandId) => {
      sent.push(commandId);
      return { entityId: "pdf-one" };
    },
    async () => {},
  );
  assert.equal(sent[0], sent[1]);
  assert.equal(saved.rows.size, 0);
});

test("文件字节、名称、项目或导入入口不同，不共用未确认命令", async () => {
  const saved = storage();
  const sent: string[] = [];
  for (const request of [
    file,
    { ...file, bytes: new TextEncoder().encode("other book") },
    { ...file, relativePath: "other.epub" },
    { ...file, projectId: "project-two" },
    { ...file, method: "pdf.import" as const },
  ]) {
    await assert.rejects(
      runPendingFileImport(
        request,
        saved,
        async (commandId) => {
          sent.push(commandId);
          throw new Error("结果未知");
        },
        async () => {},
      ),
      /结果未知/,
    );
  }
  assert.equal(new Set(sent).size, sent.length);
  assert.equal(saved.rows.size, sent.length);
});

test("本地重试标识不能保存时，不发起可能提交的导入", async () => {
  let sent = false;
  const unavailable = {
    ...storage(),
    writeLocal() {
      throw new Error("本地存储不可用");
    },
  };
  await assert.rejects(
    runPendingFileImport(
      file,
      unavailable,
      async () => {
        sent = true;
      },
      async () => {},
    ),
    /本地存储不可用/,
  );
  assert.equal(sent, false);
});
