import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  linkSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LocalFiles } from "../packages/application/src/local-files.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { localAccess } from "../packages/core/src/model.js";
import { workInputRequest } from "../packages/application/src/session-io.js";
import type { DirectoryRequest } from "../packages/core/src/local-files.js";
import {
  assertNoLocalBusinessData,
  localInputFixture,
} from "./platform-local-input-fixture.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "morphz-directory-test-"));
  const root = join(dir, "repo");
  mkdirSync(root);
  writeFileSync(join(root, "main.ts"), "export const value = 1;\n");
  const store = new WorkspaceStore(join(dir, "transport.sqlite"), {
    mode: "transport",
  });
  const config = join(dir, "grants.json");
  const files = new LocalFiles(config, store.identity());
  const ref = files.authorizeDirectory(
    root,
    "first-project",
    "first-project",
    localAccess,
  );
  return { dir, root, store, config, files, ref };
}

test("目录权限独立于附件/打开文件，按身份、工作空间和对话授权；旧只读授权不升级", () => {
  const f = fixture();
  try {
    assert.equal(
      f.files.directories("first-project", "other-conversation", localAccess)
        .length,
      0,
    );
    assert.throws(
      () =>
        f.files.validateDirectory(
          f.ref,
          "first-project",
          "other-conversation",
          localAccess,
        ),
      /对话/,
    );
    assert.throws(() =>
      f.files.validateDirectory(f.ref, "first-project", "first-project", {
        principalId: "other",
        actantId: "owner",
      }),
    );
    assert.throws(() =>
      f.files.validateDirectory(
        { ...f.ref, path: "/tmp/other" },
        "first-project",
        "first-project",
        localAccess,
      ),
    );
    const old = f.files.select(f.root, "first-project", localAccess);
    assert.notEqual(old.reference.grantId, f.ref.grantId);
    assert.throws(() =>
      f.files.validateDirectory(
        { ...f.ref, grantId: old.reference.grantId },
        "first-project",
        "first-project",
        localAccess,
      ),
    );
    assertNoLocalBusinessData(f.dir);
    assert.deepEqual(
      (f.store.runtimeState() as { deliveries?: unknown[] } | null)
        ?.deliveries ?? [],
      [],
    );
    assert.doesNotMatch(readFileSync(f.config, "utf8"), /export const/);
    assert.deepEqual(
      new LocalFiles(f.config, f.store.identity()).directories(
        "first-project",
        "first-project",
        localAccess,
      ),
      [f.ref],
    );
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("目录工具原位读写、版本冲突、幂等重试、路径和链接边界、撤销均由 Host 执行", async () => {
  const f = fixture();
  const invoke = (
    request: Omit<DirectoryRequest, "grantId">,
    key = randomUUID(),
    files = f.files,
  ) =>
    files.directoryForAgent(
      f.ref,
      "first-project",
      "first-project",
      localAccess,
      { ...request, grantId: f.ref.grantId },
      key,
    );
  try {
    const original = (await invoke({ operation: "read", path: "main.ts" })) as {
      reference: { version: string };
      text: string;
    };
    const args = {
      operation: "write" as const,
      path: "main.ts",
      expectedVersion: original.reference.version,
      text: "export const value = 2;\n",
    };
    const key = randomUUID();
    const receipt = await invoke(args, key);
    assert.equal(readFileSync(join(f.root, "main.ts"), "utf8"), args.text);
    const reopened = new LocalFiles(f.config, f.store.identity());
    assert.deepEqual(await invoke(args, key, reopened), receipt);
    writeFileSync(join(f.root, "main.ts"), "human edit\n");
    assert.deepEqual(
      await invoke(args, key, reopened),
      receipt,
      "retry is a receipt, not a second overwrite",
    );
    assert.equal(readFileSync(join(f.root, "main.ts"), "utf8"), "human edit\n");
    await assert.rejects(invoke(args), /修改/);
    await assert.rejects(
      invoke({ ...args, text: "changed tool args" }, key),
      /相同工具调用/,
    );
    const create = {
      operation: "write" as const,
      path: "new.ts",
      expectedVersion: null,
      text: "new file\n",
    };
    await invoke(create);
    await assert.rejects(invoke(create), /已存在/);
    for (const path of [
      "../escape.ts",
      "/tmp/escape.ts",
      "a/../../escape.ts",
      ".env",
      ".git/config",
      "x.key",
    ])
      await assert.rejects(invoke({ ...create, path }));
    writeFileSync(join(f.dir, "outside.ts"), "outside");
    symlinkSync(f.dir, join(f.root, "linked"));
    symlinkSync(join(f.dir, "outside.ts"), join(f.root, "linked.ts"));
    linkSync(join(f.dir, "outside.ts"), join(f.root, "hard.ts"));
    for (const path of ["linked/new.ts", "linked.ts", "hard.ts"])
      await assert.rejects(invoke({ ...create, path }));
    assert.equal(readFileSync(join(f.dir, "outside.ts"), "utf8"), "outside");
    assertNoLocalBusinessData(f.dir);
    f.files.revoke(f.ref.grantId, "first-project", localAccess);
    await assert.rejects(
      invoke({ operation: "read", path: "main.ts" }),
      /未获授权/,
    );
    await assert.rejects(invoke(create), /未获授权/);
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("持久输入固定目录授权，Agent 不可利用另一会话或旧输入获取新增权限", async () => {
  const f = fixture();
  let inputFixture: Awaited<ReturnType<typeof localInputFixture>> | undefined;
  try {
    inputFixture = await localInputFixture(f.dir, f.store, f.files);
    const app = inputFixture.app;
    const operation = {
      type: "record-input" as const,
      projectId: "first-project",
      conversationId: "first-project",
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body: "修改目录内的代码",
      targetActantId: "morphz-agent",
      directories: [f.ref],
    };
    const command = { commandId: randomUUID(), operation };
    const receipt = await inputFixture.send(command);
    const input = inputFixture.input(receipt.entityId);
    assert.equal(workInputRequest(input).message.format.version, "3");
    let activeInput = input.id;
    const agent = inputFixture.tools(() => activeInput);
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
      arguments: {
        action: "directory" as const,
        directory: {
          grantId: f.ref.grantId,
          operation: "read" as const,
          path: "main.ts",
        },
      },
    };
    assert.match(
      ((await agent.call(envelope)) as { text: string }).text,
      /value = 1/,
    );
    const noDirectories = await inputFixture.send({
      commandId: randomUUID(),
      operation: { ...operation, directories: undefined },
    });
    activeInput = noDirectories.entityId;
    await assert.rejects(
      Promise.resolve().then(() => agent.call(envelope)),
      /本次输入没有此目录的读写授权/,
    );
    await assert.rejects(
      app.platformMessage({
        commandId: randomUUID(),
        operation: { ...operation, conversationId: "other" },
      }),
      /对话/,
    );
    activeInput = input.id;
    await app.directories(
      {
        projectId: "first-project",
        conversationId: "first-project",
        grantId: f.ref.grantId,
      },
      true,
    );
    await assert.rejects(
      Promise.resolve().then(() => agent.call(envelope)),
      /未获授权/,
    );
    assert.deepEqual(await app.platformMessage(command), receipt);
    await assert.rejects(
      app.platformMessage({
        ...command,
        operation: { ...operation, body: "another request" },
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
    renameSync(f.root, f.root + "-moved");
    assert.equal(
      f.files.directories("first-project", "first-project", localAccess).length,
      0,
    );
  } finally {
    await inputFixture?.close();
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
