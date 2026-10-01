import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  renameSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { LocalFiles } from "../packages/application/src/local-files.js";
import { localAccess } from "../packages/core/src/model.js";
import {
  assertNoLocalBusinessData,
  localInputFixture,
} from "./platform-local-input-fixture.js";
import {
  workInputRequest,
  workInputFormat,
  localFileInputFormat,
} from "../packages/application/src/session-io.js";

const agent = { principalId: "morphz-service", actantId: "morphz-agent" };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "morphz-local-files-"));
  const store = new WorkspaceStore(join(dir, "transport.sqlite"), {
    mode: "transport",
  });
  const root = join(dir, "repo");
  mkdirSync(root);
  writeFileSync(join(root, "main.ts"), "export const original = 1;\n");
  writeFileSync(join(root, ".env"), "SECRET_DO_NOT_READ");
  mkdirSync(join(root, ".git"));
  const config = join(dir, "references.json");
  return {
    dir,
    store,
    root,
    config,
    files: new LocalFiles(config, store.identity()),
  };
}
test("原位打开目录和文件只保存引用；不生成 Artifact、索引、附件或同步副本", () => {
  const { dir, store, files, root, config } = fixture();
  try {
    const before = store.runtimeState();
    const directory = files.select(root, "first-project", localAccess);
    assert.deepEqual(
      directory.entries?.map((e) => e.name),
      ["main.ts"],
    );
    const file = files.read(
      directory.reference.grantId,
      "main.ts",
      "first-project",
      localAccess,
    );
    assert.match(file.text!, /original = 1/);
    assertNoLocalBusinessData(dir);
    assert.deepEqual(store.runtimeState(), before);
    assert.doesNotMatch(
      readFileSync(config, "utf8"),
      /export const|SECRET_DO_NOT_READ/,
    );
    const reopened = new LocalFiles(config, store.identity());
    assert.deepEqual(
      reopened.validate(file.reference, "first-project", localAccess),
      file,
    );
    writeFileSync(join(root, "main.ts"), "export const original = 2;\n");
    assert.throws(
      () => reopened.validate(file.reference, "first-project", localAccess),
      /已变化/,
    );
    assert.match(
      reopened.read(
        directory.reference.grantId,
        "main.ts",
        "first-project",
        localAccess,
      ).text!,
      /original = 2/,
    );
    assert.deepEqual(store.runtimeState(), before);
    assertNoLocalBusinessData(dir);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("拒绝跨目录、符号链接、凭据、跨项目和跨身份读取；原文件消失后仍可撤销", () => {
  const { dir, store, files, root } = fixture();
  try {
    const view = files.select(root, "first-project", localAccess),
      id = view.reference.grantId;
    for (const path of [
      "../outside.txt",
      "/etc/passwd",
      ".env",
      ".git/config",
      "../repo/main.ts",
    ])
      assert.throws(() => files.read(id, path, "first-project", localAccess));
    symlinkSync(join(root, "main.ts"), join(root, "link.ts"));
    assert.throws(
      () => files.read(id, "link.ts", "first-project", localAccess),
      /符号链接/,
    );
    assert.throws(
      () => files.read(id, "main.ts", "first-project", agent),
      /未获授权/,
    );
    const other = randomUUID();
    assert.throws(
      () => files.read(id, "main.ts", other, localAccess),
      /未获授权/,
    );
    const selected = files.select(
      join(root, "main.ts"),
      "first-project",
      localAccess,
    );
    unlinkSync(join(root, "main.ts"));
    files.revoke(selected.reference.grantId, "first-project", localAccess);
    assert.throws(
      () => files.validate(selected.reference, "first-project", localAccess),
      /未获授权/,
    );
    renameSync(root, root + "-moved");
    assert.throws(() => files.read(id, "", "first-project", localAccess));
    files.revoke(id, "first-project", localAccess);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("Agent 只按本次持久输入的原位引用读取；发送校验版本、引用和旧协议兼容", async () => {
  const { dir, store, files, root } = fixture();
  let inputFixture: Awaited<ReturnType<typeof localInputFixture>> | undefined;
  try {
    const view = files.select(root, "first-project", localAccess);
    inputFixture = await localInputFixture(dir, store, files);
    const app = inputFixture.app;
    const operation = {
      type: "record-input",
      projectId: "first-project",
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body: "检查这份代码",
      targetActantId: "morphz-agent",
      localFile: view.reference,
    } as const;
    const acceptedCommand = { commandId: randomUUID(), operation };
    const receipt = await inputFixture.send(acceptedCommand);
    const input = inputFixture.input(receipt.entityId);
    const tools = inputFixture.tools(() => input.id);
    const envelope = {
      protocol: 1,
      tool: "host_morphz",
      invocation: {
        job_id: "job",
        tool_call_id: "call",
        session_id: "session",
        context_id: "context",
        principal_id: "principal",
        agent_id: "agent",
        thread_id: "thread",
        target_id: "target",
      },
      arguments: { action: "local-file" as const, path: "main.ts", limit: 10 },
    };
    const result = (await tools.call(envelope)) as {
      text: string;
      hasMore: boolean;
    };
    assert.equal(result.text, "export con");
    assert.equal(result.hasMore, true);
    assert.equal(
      workInputRequest(input).message.format.version,
      localFileInputFormat.version,
    );
    const { localFile: _reference, ...oldInput } = input;
    assert.equal(
      workInputRequest(oldInput).message.format.version,
      workInputFormat.version,
    );
    assertNoLocalBusinessData(dir);
    const file = files.read(
      view.reference.grantId,
      "main.ts",
      "first-project",
      localAccess,
    );
    await assert.rejects(
      files.forAgent(file.reference, "first-project", localAccess, {
        path: "",
      }),
      /本次输入/,
    );
    await assert.rejects(
      app.platformMessage({
        commandId: randomUUID(),
        operation: {
          ...operation,
          localFile: file.reference,
          selection: "伪造原文",
        },
      }),
      /选区|应用来源/,
    );
    writeFileSync(join(root, "main.ts"), "changed");
    await assert.rejects(
      app.platformMessage({
        commandId: randomUUID(),
        operation: { ...operation, localFile: file.reference },
      }),
      /已变化/,
    );
    files.revoke(view.reference.grantId, "first-project", localAccess);
    assert.deepEqual(
      await app.platformMessage(acceptedCommand),
      receipt,
      "已经接受的命令在引用撤销后重试仍返回同一回执，不重复写入",
    );
    await assert.rejects(
      app.platformMessage({
        ...acceptedCommand,
        operation: { ...operation, body: "different request" },
      }),
      /操作标识已用于另一条输入/,
    );
    await assert.rejects(
      app.platformMessage({
        commandId: randomUUID(),
        operation,
      }),
      /未获授权/,
    );
    await assert.rejects(
      Promise.resolve().then(() => tools.call(envelope)),
      /未获授权/,
    );
  } finally {
    await inputFixture?.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
