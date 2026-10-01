import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { Application } from "../packages/application/src/application.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import { dataDirectory } from "../apps/service/src/paths.js";
import { localAccess } from "../packages/core/src/model.js";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";

const fixture = () => platformRuntimeHostFixture({
  url: "http://127.0.0.1:1", token: "isolated-test", namespace: randomUUID(),
});
const create = () => ({
  commandId: randomUUID(), objectId: randomUUID(), projectId: "first-project",
  title: "持久保存", markdown: "重启后仍然存在",
});

test("真实 Objects 原件重启恢复，Platform 目录只保留引用；幂等与冲突不丢数据", async () => {
  const f = await fixture();
  try {
    const request = create();
    const receipt = await f.session().createPlatformDocument(request);
    assert.deepEqual(await f.session().createPlatformDocument(request), receipt);
    const contents = await f.session().listPlatformContent({projectId: f.projectId});
    assert.equal(contents.length, 1);
    assert.equal(contents[0]!.appObjectId, request.objectId);
    await f.reopen();
    const document = await f.session().readPlatformDocument({contentId: receipt.contentId});
    assert.equal(document.title, "持久保存");
    assert.equal(document.markdown, "重启后仍然存在");
    assert.deepEqual(await f.session().createPlatformDocument(request), receipt);
    await assert.rejects(f.session().createPlatformDocument({...request, title: "复用错误"}), /复用|内容|参数/);
    assert.equal((await f.session().readPlatformDocument({contentId: receipt.contentId})).revision, 1);
    assert.equal(statSync(join(f.directory, "transport.sqlite")).mode & 0o777, 0o600);
    f.assertNoLegacyData();
  } finally { await f.close(); }
});

test("独立 Host 投递库绑定显式中心身份，错绑不覆盖状态", () => {
  const dir = mkdtempSync(join(tmpdir(), "morphz-host-tenant-test-"));
  const tenantId = randomUUID(), path = join(dir, "transport.sqlite");
  try {
    const first = new WorkspaceStore(path, {tenantId, mode: "transport"});
    const request = {commandId: randomUUID(), inputId: randomUUID()};
    first.saveServiceState("test-delivery", request);
    first.close();
    assert.throws(() => new WorkspaceStore(path, {tenantId: randomUUID(), mode: "transport"}), /绑定了另一个中心/);
    const reopened = new WorkspaceStore(path, {tenantId, mode: "transport"});
    assert.equal(reopened.identity(), tenantId);
    assert.deepEqual(reopened.serviceState("test-delivery"), request);
    reopened.close();
    const independent = new WorkspaceStore(join(dir, "other-host.sqlite"), {tenantId, mode: "transport"});
    assert.equal(independent.identity(), tenantId);
    assert.equal(independent.serviceState("test-delivery"), null);
    independent.close();
    assert.throws(() => new WorkspaceStore(join(dir, "invalid.sqlite"), {tenantId: "not-uuid", mode: "transport"}), /uuid|UUID|Invalid/i);
    assert.equal(existsSync(join(dir, "invalid.sqlite")), false);
  } finally { rmSync(dir, {recursive: true}); }
});

test("正式 Host 缺失投递库时不以新身份掩盖已有 Platform 数据", () => {
  const dir = mkdtempSync(join(tmpdir(), "morphz-host-identity-loss-"));
  const database = join(dir, "transport.sqlite"), platform = join(dir, "platform.sqlite");
  try {
    writeFileSync(platform, "existing-platform-data");
    assert.throws(() => new WorkspaceStore(database, {mode: "transport"}), /中心身份.*缺失/);
    assert.equal(existsSync(database), false);
    assert.equal(statSync(platform).size, "existing-platform-data".length);
    writeFileSync(database, "");
    assert.throws(() => new WorkspaceStore(database, {mode: "transport"}), /中心身份.*缺失/);
    assert.equal(statSync(database).size, 0);
    const incomplete = new DatabaseSync(database);
    incomplete.exec("CREATE TABLE unrelated(value TEXT)");
    incomplete.close();
    assert.throws(() => new WorkspaceStore(database, {mode: "transport"}), /中心身份记录缺失/);
    const after = new DatabaseSync(database, {readOnly: true});
    assert.equal(after.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='center_metadata'").get(), undefined);
    after.close();
  } finally { rmSync(dir, {recursive: true}); }
});

test("正式 Host 重开保留原身份且不创建 workspace 或 BLOB 表", () => {
  const dir = mkdtempSync(join(tmpdir(), "morphz-host-identity-reopen-"));
  const database = join(dir, "transport.sqlite");
  try {
    const first = new WorkspaceStore(database, {mode: "transport"});
    const centerId = first.identity();
    first.close();
    writeFileSync(join(dir, "platform.sqlite"), "existing-platform-data");
    const reopened = new WorkspaceStore(database, {mode: "transport"});
    assert.equal(reopened.identity(), centerId);
    reopened.close();
    const after = new DatabaseSync(database, {readOnly: true});
    assert.deepEqual(after.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workspace','commands','assets')").all(), []);
    after.close();
  } finally { rmSync(dir, {recursive: true}); }
});

test("两个真实 Host 连接共享 Objects 版本权威，陈旧写入不能覆盖正文", async () => {
  const f = await fixture();
  let secondStore: WorkspaceStore | undefined;
  let secondDomains: Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
  try {
    const receipt = await f.session().createPlatformDocument(create());
    secondStore = new WorkspaceStore(join(f.directory, "transport.sqlite"), {mode: "transport"});
    secondDomains = await openApplicationDomainsHost(f.directory, secondStore);
    const second = new Application(secondStore, {
      platformWork: secondDomains.work, platformDocuments: secondDomains.content,
    }).session(localAccess);
    const request = {contentId: receipt.contentId, expectedRevision: 1, title: "A 的修改", markdown: "A"};
    await f.session().revisePlatformDocument({commandId: randomUUID(), ...request});
    await assert.rejects(second.revisePlatformDocument({commandId: randomUUID(), ...request, title: "B 的修改", markdown: "B"}), /版本|变化|冲突/);
    const actual = await second.readPlatformDocument({contentId: receipt.contentId});
    assert.equal(actual.title, "A 的修改");
    assert.equal(actual.markdown, "A");
    assert.equal(actual.revision, 2);
    f.assertNoLegacyData();
  } finally { await secondDomains?.close(); secondStore?.close(); await f.close(); }
});

test("未来数据库版本与损坏记录不得自动重置", () => {
  const dir = mkdtempSync(join(tmpdir(), "morphz-application-version-test-")), path = join(dir, "db");
  try {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA user_version=99");
    db.close();
    assert.throws(() => new WorkspaceStore(path, {mode: "transport"}), /版本高于/);
    const check = new DatabaseSync(path);
    assert.equal((check.prepare("PRAGMA user_version").get() as {user_version: number}).user_version, 99);
    check.close();
  } finally { rmSync(dir, {recursive: true}); }
});

test("真实图片 Store 去重并保留字节；SVG 或任意文件不能冒充图片", async () => {
  const f = await fixture();
  try {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGmQAAAAASUVORK5CYII=", "base64");
    const asset = await f.session().addAsset(png);
    assert.deepEqual(await f.session().addAsset(png), asset);
    assert.deepEqual(await f.session().listPlatformContent({projectId: f.projectId}), []);
    await assert.rejects(f.session().asset(asset.assetId), /不存在或无权/);
    const image = await f.session().createPlatformImage({commandId: randomUUID(), objectId: randomUUID(), projectId: f.projectId, title: "已确认的图片", assetId: asset.assetId, alt: "合成 PNG"});
    const original = await f.session().asset(asset.assetId);
    assert.equal(original.mime, "image/png");
    assert.deepEqual(Buffer.from(original.bytes), png);
    await assert.rejects(f.session().addAsset(Buffer.from("<svg><script/></svg>")), /PNG|图片|格式/);
    assert.deepEqual((await f.session().listPlatformContent({projectId: f.projectId})).map((entry) => entry.id), [image.contentId]);
    await f.reopen();
    assert.deepEqual(Buffer.from((await f.session().asset(asset.assetId)).bytes), png);
    f.assertNoLegacyData();
  } finally { await f.close(); }
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
    () => dataDirectory({ MORPHZ_APP_DATA_DIR: "data" }),
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
