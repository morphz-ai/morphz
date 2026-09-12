import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { IdentityCenter, workspaceFor } from "../apps/service/src/identity.js";
import { localAccess } from "../packages/core/src/model.js";
const secret = "a".repeat(64),
  hash = createHash("sha256").update(secret).digest("hex");
const config = {
  version: 1,
  members: [{ ...localAccess, loginTokenHash: hash, enabled: true }],
};
test("中心登录身份由高熵凭据绑定，持久会话、过期、退出和撤销均有效", () => {
  const store = new WorkspaceStore(":memory:");
  let now = 1000;
  const identities = new IdentityCenter(store, config, () => now);
  const identityCookie = identities.cookieName;
  assert.equal(identities.authenticate(undefined), null);
  assert.throws(() => identities.login("wrong", "test"), /无效/);
  const credential = identities.login(secret, "test"),
    cookie = identityCookie + "=" + credential;
  const current = identities.authenticate(cookie)!;
  const legacyCookie = identities.legacyCookieName + "=" + credential;
  assert.deepEqual(identities.authenticate(legacyCookie), current);
  assert.equal(
    identities.authenticate(identityCookie + "=invalid;" + legacyCookie),
    null,
  );
  assert.equal(
    identities.authenticate(legacyCookie + ";" + legacyCookie),
    null,
  );
  assert.deepEqual(current.access, localAccess);
  assert.ok(
    !JSON.stringify(store.serviceState("identity-sessions")).includes(
      credential,
    ),
  );
  assert.ok(
    !JSON.stringify(store.serviceState("identity-sessions")).includes(secret),
  );
  const restarted = new IdentityCenter(store, config, () => now);
  assert.equal(restarted.authenticate(cookie)?.csrf, current.csrf);
  assert.equal(restarted.authenticate(cookie + ";" + cookie), null);
  restarted.logout(current.sessionHash);
  assert.equal(restarted.authenticate(cookie), null);
  assert.equal(restarted.authenticate(legacyCookie), null);
  const second = identityCookie + "=" + restarted.login(secret, "test");
  restarted.replaceConfiguration({
    ...config,
    members: [{ ...config.members[0], enabled: false }],
  });
  assert.equal(restarted.authenticate(second), null);
  restarted.replaceConfiguration(config);
  assert.equal(restarted.authenticate(second), null); // revoke is not undone by re-enabling
  const expired = identityCookie + "=" + restarted.login(secret, "test");
  now += 24 * 60 * 60 * 1000;
  assert.equal(restarted.authenticate(expired), null);
  store.close();
});
test("项目投影不暴露未授权对象、成员、历史、图关系或输入", () => {
  const store = new WorkspaceStore(":memory:");
  store.execute(
    {
      commandId: randomUUID(),
      operation: {
        type: "create-artifact",
        projectId: "first-project",
        title: "私有",
        content: { kind: "document", markdown: "不可见正文" },
      },
    },
    localAccess,
  );
  const other = workspaceFor(store.snapshot(), {
    principalId: "other",
    actantId: "other-human",
  });
  assert.equal(other.projects.length, 0);
  assert.equal(other.artifacts.length, 0);
  assert.equal(other.principals.length, 0);
  assert.equal(other.actants.length, 0);
  assert.ok(!JSON.stringify(other).includes("不可见正文"));
  assert.equal(workspaceFor(store.snapshot(), localAccess).artifacts.length, 1);
  store.close();
});
