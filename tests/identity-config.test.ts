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
test("中心成员配置只从私有控制文件加载，拒绝符号链接、公开权限和静默降级", () => {
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
          projectIds: ["first-project"],
          enabled: true,
          loginTokenHash: createHash("sha256").update(token).digest("hex"),
        },
      ],
    };
  try {
    assert.equal(loadIdentity(store, directory), undefined);
    writeFileSync(filename, JSON.stringify(config), { mode: 0o600 });
    const identity = loadIdentity(store, directory)!;
    const cookie = `${identity.cookieName}=${identity.login(token, "test")}`;
    assert.equal(identity.authenticate(cookie)?.access.principalId, "alpha");
    config.members[0]!.enabled = false;
    writeFileSync(filename, JSON.stringify(config));
    loadIdentity(store, directory, identity);
    assert.equal(identity.authenticate(cookie), null);
    chmodSync(filename, 0o644);
    assert.throws(() => loadIdentity(store, directory));
    rmSync(filename);
    assert.throws(() => loadIdentity(store, directory, identity), /不允许回退/);
    assert.throws(() => loadIdentity(store, directory), /不允许回退/);
    const other = join(directory, "source.json");
    writeFileSync(other, JSON.stringify(config), { mode: 0o600 });
    symlinkSync(other, filename);
    assert.throws(() => loadIdentity(store, directory));
  } finally {
    store.close();
    rmSync(directory, { recursive: true });
  }
});
test("团队中心重启丢失配置时拒绝监听；旧版会话记录也不允许匿名启动", () => {
  const directory = mkdtempSync(join(tmpdir(), "work-identity-restart-")),
    database = join(directory, "workspace.sqlite");
  let store = new WorkspaceStore(database);
  try {
    // Earlier versions persisted this even if there were no active logins.
    store.saveServiceState("identity-sessions", []);
    store.close();
    store = new WorkspaceStore(database);
    assert.throws(() => loadIdentity(store, directory), /不允许回退/);
    assert.throws(
      () => createAppServer(store, { port: 65421, webRoot: "/nonexistent" }),
      /缺失身份配置/,
    );
    store.saveServiceState("identity-sessions", null);
    store.saveServiceState("identity-mode", "team");
    store.close();
    store = new WorkspaceStore(database);
    assert.throws(() => loadIdentity(store, directory), /不允许回退/);
    assert.throws(
      () => createAppServer(store, { port: 65421, webRoot: "/nonexistent" }),
      /缺失身份配置/,
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true });
  }
});
