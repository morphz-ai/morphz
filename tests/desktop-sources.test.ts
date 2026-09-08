import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  renameSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import {
  DesktopSources,
  inspectSource,
  readGrantedText,
} from "../apps/service/src/desktop-sources.js";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { createAppServer } from "../apps/service/src/http.js";
import { localAccess } from "../packages/core/src/model.js";

test("来源选择仅遍历明确范围，不进入隐藏/依赖目录，不读取链接或替换后的授权路径", async () => {
  const dir = mkdtempSync(join(tmpdir(), "morphzwork-source-bounds-")),
    library = join(dir, "library");
  mkdirSync(library);
  try {
    mkdirSync(join(library, "node_modules"));
    mkdirSync(join(library, ".private"));
    writeFileSync(join(library, "readme.md"), "正文");
    writeFileSync(join(library, "node_modules", "package.md"), "excluded");
    writeFileSync(join(library, ".private", "notes.md"), "excluded");
    writeFileSync(join(library, ".env"), "SECRET=excluded");
    writeFileSync(join(dir, "outside.txt"), "outside");
    symlinkSync(join(dir, "outside.txt"), join(library, "shortcut.txt"));
    const grant = await inspectSource(library);
    assert.deepEqual(grant.paths, ["readme.md"]);
    assert.equal(await readGrantedText(grant, "readme.md"), "正文");
    await assert.rejects(readGrantedText(grant, "shortcut.txt"), /符号链接/);
    await assert.rejects(readGrantedText(grant, "../outside.txt"));
    await assert.rejects(inspectSource(homedir()), /主目录/);
    await assert.rejects(inspectSource("/"), /系统盘/);
    renameSync(library, join(dir, "old-library"));
    mkdirSync(library);
    writeFileSync(join(library, "readme.md"), "replacement");
    await assert.rejects(readGrantedText(grant, "readme.md"), /替换/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
test("桌面来源真实 HTTP 同步、重启去重、暂停、文件删除保留版本，以及中心身份变更停发", async () => {
  const dir = mkdtempSync(join(tmpdir(), "morphzwork-source-flow-")),
    library = join(dir, "library"),
    config = join(dir, "profile", "grants.json");
  mkdirSync(library);
  const note = join(library, "note.md");
  writeFileSync(note, "initial source");
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const store = new WorkspaceStore(":memory:"),
    server = createAppServer(store, { port, webRoot: "/nonexistent" }),
    origin = `http://127.0.0.1:${port}`;
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  let loseReply = true,
    swappedCenter = false,
    writes = 0;
  const request: typeof fetch = async (url, options) => {
    const response = await fetch(url, options);
    if (options?.method === "POST") {
      writes++;
      if (loseReply) {
        loseReply = false;
        throw new Error("synthetic lost ack");
      }
    }
    if (swappedCenter && String(url).endsWith("/api/workspace")) {
      const data = await response.json();
      return Response.json({ ...data, centerId: randomUUID() });
    }
    return response;
  };
  try {
    let connector = new DesktopSources(config, origin, request);
    const selected = await connector.addSelection(library, "first-project"),
      id = selected[0]!.id;
    assert.equal(selected[0]!.enabled, false);
    assert.equal(store.snapshot().artifacts.length, 0);
    assert.equal(JSON.stringify(selected).includes(library), false);
    await connector.control(id, "resume");
    assert.equal(store.snapshot().artifacts.length, 1);
    assert.ok(connector.list()[0]!.error);
    assert.ok(readFileSync(config, "utf8").includes('"pending":{'));
    await connector.stop();
    connector = new DesktopSources(config, origin, request);
    await connector.tick();
    let artifact = store.snapshot().artifacts[0]!;
    assert.equal(artifact.revision, 1);
    assert.equal(store.snapshot().artifacts.length, 1);
    assert.equal(connector.list()[0]!.error, "");
    writeFileSync(note, "updated source");
    await connector.tick();
    artifact = store.snapshot().artifacts[0]!;
    assert.equal(artifact.revision, 2);
    assert.equal(artifact.versions.length, 2);
    assert.equal(store.search({ query: "initial" }, localAccess).total, 0);
    assert.equal(store.search({ query: "updated" }, localAccess).total, 1);
    assert.throws(
      () =>
        store.execute(
          {
            commandId: randomUUID(),
            operation: {
              type: "revise-artifact",
              artifactId: artifact.id,
              expectedRevision: 2,
              title: artifact.title,
              content: { kind: "document", markdown: "overwrite source" },
            },
          },
          localAccess,
        ),
      /只读版本/,
    );
    await connector.control(id, "pause");
    const pausedWrites = writes;
    writeFileSync(note, "paused change");
    await connector.tick();
    assert.equal(writes, pausedWrites);
    assert.equal(store.snapshot().artifacts[0]!.revision, 2);
    assert.equal(
      store.search({ query: "updated" }, localAccess).hits[0]!.source
        ?.connection?.status,
      "paused",
    );
    await connector.control(id, "resume");
    assert.equal(store.snapshot().artifacts[0]!.revision, 3);
    rmSync(note);
    await connector.tick();
    assert.equal(store.snapshot().artifacts[0]!.revision, 3);
    assert.equal(
      store.snapshot().artifacts[0]!.source?.connection?.status,
      "unavailable",
    );
    writeFileSync(note, "paused change");
    await connector.tick();
    assert.equal(
      store.snapshot().artifacts[0]!.source?.connection?.status,
      "current",
    );
    swappedCenter = true;
    const before = writes;
    writeFileSync(note, "must not leave machine");
    await connector.tick();
    assert.equal(writes, before);
    assert.match(connector.list()[0]!.error, /中心身份/);
    assert.equal(statSync(config).mode & 0o777, 0o600);
    swappedCenter = false;
    await connector.control(id, "remove");
    assert.equal(connector.list().length, 0);
    assert.equal(store.snapshot().artifacts.length, 1);
    await connector.stop();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    rmSync(dir, { recursive: true });
  }
});
