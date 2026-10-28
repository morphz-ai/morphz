import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import {
  mkdtemp,
  writeFile,
  mkdir,
  chmod,
  symlink,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const {
  createLocalFileOpener,
} = require("../apps/desktop/local-file-links.cjs");

test("native file opening validates the trusted click and real local target without granting or executing", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "morphz-resource-links-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "TEST 中文 100% #?.md");
  await writeFile(file, "TEST resource, no Agent input");
  const events: string[][] = [];
  const sender = {};
  let local = true;
  let failure = "";
  const open = createLocalFileOpener({
    requireMain: (event: object) => {
      if (event !== sender) throw new Error("untrusted frame");
    },
    isLocal: () => local,
    shell: {
      openPath: async (path: string) => {
        events.push(["open", path]);
        return failure;
      },
      showItemInFolder: (path: string) => events.push(["reveal", path]),
    },
  });
  assert.deepEqual(await open(sender, file), { action: "opened" });
  assert.equal(events.length, 1);
  assert.equal(events[0]![0], "open");
  assert.ok(events[0]![1]!.endsWith("TEST 中文 100% #?.md"));
  assert.deepEqual(await open(sender, directory), { action: "opened" });
  const launchable = join(directory, "TEST.command");
  await writeFile(launchable, "exit 99");
  assert.deepEqual(await open(sender, launchable), { action: "revealed" });
  const bundle = join(directory, "TEST.app");
  await mkdir(bundle);
  assert.deepEqual(await open(sender, bundle), { action: "revealed" });
  if (process.platform !== "win32") {
    const executable = join(directory, "TEST-no-extension");
    await writeFile(executable, "#!/bin/sh\nexit 99");
    await chmod(executable, 0o755);
    assert.deepEqual(await open(sender, executable), { action: "revealed" });
    const link = join(directory, "TEST-disguised.txt");
    await symlink(launchable, link);
    assert.deepEqual(await open(sender, link), { action: "revealed" });
  }
  const count = events.length;
  await assert.rejects(open({}, file), /untrusted frame/);
  local = false;
  await assert.rejects(open(sender, file), /远端工作空间/);
  local = true;
  for (const path of [
    null,
    {},
    "../file",
    "https://example.org",
    "file:///tmp/test",
    "//server/share",
    "/tmp/a\0b",
    "a".repeat(5000),
  ])
    await assert.rejects(open(sender, path), /本地文件地址无效/);
  await assert.rejects(
    open(sender, join(directory, "missing")),
    /文件不存在或已移动/,
  );
  assert.equal(events.length, count, "rejected requests do not reach the OS");
  failure = "no default handler";
  await assert.rejects(open(sender, file), /默认应用/);
});

test("native file open rechecks the trusted frame and connection after filesystem awaits", async () => {
  let checks = 0;
  const open = createLocalFileOpener({
    requireMain: () => {
      if (++checks > 1) throw new Error("frame retired");
    },
    isLocal: () => true,
    shell: {
      openPath: () => assert.fail("retired frame must not open"),
      showItemInFolder: () => assert.fail("retired frame must not reveal"),
    },
  });
  await assert.rejects(open({}, process.cwd()), /frame retired/);
  let localChecks = 0;
  const changed = createLocalFileOpener({
    requireMain: () => {},
    isLocal: () => ++localChecks === 1,
    shell: {
      openPath: () => assert.fail("changed connection must not open"),
      showItemInFolder: () => assert.fail("changed connection must not reveal"),
    },
  });
  await assert.rejects(changed({}, process.cwd()), /连接已变化/);
});
