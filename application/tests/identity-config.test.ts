import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { loadIdentity } from "../apps/service/src/identity-config.js";
import { createAppServer } from "../apps/service/src/http.js";
import { bindIdentityTestPlatform } from "./identity-platform-fixture.js";
import { Application } from "../packages/application/src/application.js";
import { PlatformStore } from "../packages/platform/src/store.js";
test("中心成员配置只从私有控制文件加载，拒绝符号链接、公开权限和静默降级", async () => {
  const directory = mkdtempSync(join(tmpdir(), "work-identity-config-")),
    filename = join(directory, "members.json"),
    store = new WorkspaceStore(":memory:");
  const token = "a".repeat(64),
    config = {
      version: 1,
      members: [
        {
          principalId: "alpha",
          actantId: "alpha-human",
          name: "甲",
          projectIds: [],
          enabled: true,
          loginTokenHash: createHash("sha256").update(token).digest("hex"),
        },
      ],
    };
  let platform:
    Awaited<ReturnType<typeof bindIdentityTestPlatform>> | undefined;
  try {
    assert.equal(await loadIdentity(store, directory), undefined);
    writeFileSync(filename, JSON.stringify(config), { mode: 0o600 });
    const identity = (await loadIdentity(store, directory))!;
    platform = await PlatformStore.sqlite(":memory:", {
      resolveActor: async () => null,
      resolveActant: async ({ tenantId, actantId }) =>
        tenantId === store.identity()
          ? identity.resolveHumanActant(actantId)
          : null,
      resolveProjectAgent: async () => null,
      verifyApplicationObject: async () => false,
    });
    await bindIdentityTestPlatform(store, identity, platform);
    const cookie = `${identity.cookieName}=${await identity.login(token, "test")}`;
    assert.equal(identity.authenticate(cookie)?.access.principalId, "alpha");
    const access = identity.authenticate(cookie)!.access;
    const session = new Application(store, { identity }).session(access);
    assert.equal(
      session.platformBootstrap("test-generation").displayName,
      "甲",
    );
    const csrf = identity.authenticate(cookie)!.csrf;
    config.members[0]!.name = "甲的新名称";
    writeFileSync(filename, JSON.stringify(config));
    await loadIdentity(store, directory, identity);
    assert.equal(
      session.platformBootstrap("test-generation").displayName,
      "甲的新名称",
    );
    assert.equal(identity.authenticate(cookie)!.csrf, csrf);
    const bootstrap = JSON.stringify(
      session.platformBootstrap("test-generation"),
    );
    assert.ok(!bootstrap.includes(token));
    assert.ok(!bootstrap.includes(config.members[0]!.loginTokenHash));
    assert.throws(
      () =>
        new Application(store, { identity })
          .session({
            principalId: "other",
            actantId: "other-human",
          })
          .platformBootstrap("test-generation"),
      /身份已失效/,
    );
    config.members[0]!.enabled = false;
    writeFileSync(filename, JSON.stringify(config));
    await loadIdentity(store, directory, identity);
    assert.equal(identity.authenticate(cookie), null);
    assert.throws(
      () => session.platformBootstrap("test-generation"),
      /身份已失效/,
    );
    chmodSync(filename, 0o644);
    await assert.rejects(() => loadIdentity(store, directory));
    rmSync(filename);
    await assert.rejects(
      () => loadIdentity(store, directory, identity),
      /不允许回退/,
    );
    await assert.rejects(() => loadIdentity(store, directory), /不允许回退/);
    const other = join(directory, "source.json");
    writeFileSync(other, JSON.stringify(config), { mode: 0o600 });
    symlinkSync(other, filename);
    await assert.rejects(() => loadIdentity(store, directory));
  } finally {
    await platform?.close();
    store.close();
    rmSync(directory, { recursive: true });
  }
});
test("团队中心重启丢失配置时拒绝监听；旧版会话记录也不允许匿名启动", async () => {
  const directory = mkdtempSync(join(tmpdir(), "work-identity-restart-")),
    database = join(directory, "workspace.sqlite");
  let store = new WorkspaceStore(database);
  try {
    // Earlier versions persisted this even if there were no active logins.
    store.saveServiceState("identity-sessions", []);
    store.close();
    store = new WorkspaceStore(database);
    await assert.rejects(() => loadIdentity(store, directory), /不允许回退/);
    assert.throws(
      () => createAppServer(store, { port: 65421, webRoot: "/nonexistent" }),
      /缺失身份配置/,
    );
    store.saveServiceState("identity-sessions", null);
    store.saveServiceState("identity-mode", "team");
    store.close();
    store = new WorkspaceStore(database);
    await assert.rejects(() => loadIdentity(store, directory), /不允许回退/);
    assert.throws(
      () => createAppServer(store, { port: 65421, webRoot: "/nonexistent" }),
      /缺失身份配置/,
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true });
  }
});
