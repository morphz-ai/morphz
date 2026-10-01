import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { createAppServer } from "../apps/service/src/http.js";
import { IdentityCenter, workspaceFor } from "../apps/service/src/identity.js";
import { localAccess, morphzAgentAccess } from "../packages/core/src/model.js";
import { bindIdentityTestPlatform } from "./identity-platform-fixture.js";
import { viewModelFixture } from "./view-model-fixture.js";
const secret = "a".repeat(64),
  hash = createHash("sha256").update(secret).digest("hex");
const config = {
  version: 1,
  members: [{ ...localAccess, loginTokenHash: hash, enabled: true }],
};
test("中心登录身份由高熵凭据绑定，持久会话、过期、退出和撤销均有效", async () => {
  const store = new WorkspaceStore(":memory:", { mode: "transport" });
  let now = 1000;
  const identities = new IdentityCenter(store, config, () => now);
  const platform = await bindIdentityTestPlatform(store, identities);
  const identityCookie = identities.cookieName;
  assert.equal(identities.authenticate(undefined), null);
  await assert.rejects(() => identities.login("wrong", "test"), /无效/);
  const credential = await identities.login(secret, "test"),
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
  assert.equal(store.serviceState("identity-sessions"), null);
  assert.ok(!JSON.stringify(current).includes(credential));
  const restarted = new IdentityCenter(store, config, () => now);
  await bindIdentityTestPlatform(store, restarted, platform);
  assert.equal(
    (await restarted.authenticateShared(cookie))?.csrf,
    current.csrf,
  );
  assert.equal(await restarted.authenticateShared(cookie + ";" + cookie), null);
  await restarted.logout(current.sessionHash);
  assert.equal(await identities.authenticateShared(cookie), null);
  assert.equal(await restarted.authenticateShared(legacyCookie), null);
  const second = identityCookie + "=" + (await restarted.login(secret, "test"));
  await restarted.replaceConfiguration({
    ...config,
    members: [{ ...config.members[0], enabled: false }],
  });
  assert.equal(await restarted.authenticateShared(second), null);
  await restarted.replaceConfiguration(config);
  assert.equal(await restarted.authenticateShared(second), null); // revoke is not undone by re-enabling
  const expired =
    identityCookie + "=" + (await restarted.login(secret, "test"));
  now += 24 * 60 * 60 * 1000;
  assert.equal(await restarted.authenticateShared(expired), null);
  await platform.close();
  store.close();
});
test("两个 Host 共用 Platform 登录权威，配置重载不重放成员写入", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-team-identity-hosts-"));
  const filename = join(directory, "platform.sqlite");
  const tenantId = randomUUID();
  const firstWorkspace = new WorkspaceStore(":memory:", {
    mode: "transport",
    tenantId,
  });
  const secondWorkspace = new WorkspaceStore(":memory:", {
    mode: "transport",
    tenantId,
  });
  const operatorMembers = [
    { ...localAccess, projectIds: [] as string[], enabled: true },
  ];
  const first = new IdentityCenter(
    firstWorkspace,
    config,
    Date.now,
    operatorMembers,
  );
  const second = new IdentityCenter(
    secondWorkspace,
    config,
    Date.now,
    operatorMembers,
  );
  let firstPlatform:
    Awaited<ReturnType<typeof bindIdentityTestPlatform>> | undefined;
  let secondPlatform:
    Awaited<ReturnType<typeof bindIdentityTestPlatform>> | undefined;
  try {
    firstPlatform = await bindIdentityTestPlatform(
      firstWorkspace,
      first,
      undefined,
      filename,
    );
    secondPlatform = await bindIdentityTestPlatform(
      secondWorkspace,
      second,
      undefined,
      filename,
    );
    const firstCookie = `${first.cookieName}=${await first.login(secret, "host-a")}`;
    assert.deepEqual(
      (await second.authenticateShared(firstCookie))?.access,
      localAccess,
    );
    const bobToken = "b".repeat(64);
    const bob = { principalId: "bob", actantId: "bob-human" };
    const expanded = {
      version: 1 as const,
      members: [
        config.members[0]!,
        {
          ...bob,
          loginTokenHash: createHash("sha256").update(bobToken).digest("hex"),
          enabled: true,
        },
      ],
    };
    const expandedMembers = [
      operatorMembers[0]!,
      { ...bob, projectIds: [], enabled: true },
    ];
    await first.replaceConfiguration(expanded, expandedMembers);
    assert.equal(await second.authenticateShared(firstCookie), null);
    await second.replaceConfiguration(expanded, expandedMembers);
    assert.deepEqual(
      (await second.authenticateShared(firstCookie))?.access,
      localAccess,
    );
    const bobCookie = `${second.cookieName}=${await second.login(bobToken, "host-b")}`;
    assert.deepEqual((await first.authenticateShared(bobCookie))?.access, bob);
    const bobSessionHash = first.authenticate(bobCookie)!.sessionHash;
    await second.logout(bobSessionHash);
    assert.equal(await first.authenticateShared(bobCookie), null);
    const secondBobCookie = `${second.cookieName}=${await second.login(bobToken, "host-b")}`;
    await first.replaceConfiguration(config, operatorMembers);
    assert.equal(await second.authenticateShared(secondBobCookie), null);
    await second.replaceConfiguration(config, operatorMembers);
    assert.equal(await second.authenticateShared(secondBobCookie), null);
    assert.deepEqual(
      (await second.authenticateShared(firstCookie))?.access,
      localAccess,
    );
  } finally {
    await firstPlatform?.close();
    await secondPlatform?.close();
    firstWorkspace.close();
    secondWorkspace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test("两个 HTTP Host 用同一 Platform 会话登录，跨 Host 退出立即拒绝旧 Cookie", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-team-http-hosts-"));
  const tenantId = randomUUID();
  const firstWorkspace = new WorkspaceStore(":memory:", {
    mode: "transport",
    tenantId,
  });
  const secondWorkspace = new WorkspaceStore(":memory:", {
    mode: "transport",
    tenantId,
  });
  const first = new IdentityCenter(firstWorkspace, config);
  const second = new IdentityCenter(secondWorkspace, config);
  const platformFile = join(directory, "platform.sqlite");
  let firstPlatform:
    Awaited<ReturnType<typeof bindIdentityTestPlatform>> | undefined;
  let secondPlatform:
    Awaited<ReturnType<typeof bindIdentityTestPlatform>> | undefined;
  let firstServer: ReturnType<typeof createAppServer> | undefined;
  let secondServer: ReturnType<typeof createAppServer> | undefined;
  const listen = async (
    workspace: WorkspaceStore,
    identity: IdentityCenter,
  ) => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const server = createAppServer(workspace, {
      port,
      webRoot: "/nonexistent",
      identity,
    });
    await new Promise<void>((resolve) =>
      server.listen(port, "127.0.0.1", resolve),
    );
    return { server, origin: `http://127.0.0.1:${port}` };
  };
  try {
    firstPlatform = await bindIdentityTestPlatform(
      firstWorkspace,
      first,
      undefined,
      platformFile,
    );
    secondPlatform = await bindIdentityTestPlatform(
      secondWorkspace,
      second,
      undefined,
      platformFile,
    );
    const a = await listen(firstWorkspace, first);
    const b = await listen(secondWorkspace, second);
    firstServer = a.server;
    secondServer = b.server;
    const login = await fetch(a.origin + "/api/identity/login", {
      method: "POST",
      headers: { Origin: a.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ token: secret }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const remote = await fetch(b.origin + "/api/platform/bootstrap", {
      headers: { Cookie: cookie },
    });
    assert.equal(remote.status, 200);
    const boot = (await remote.json()) as {
      csrfToken: string;
      principalId: string;
    };
    assert.equal(boot.principalId, localAccess.principalId);
    const logout = await fetch(b.origin + "/api/identity/logout", {
      method: "POST",
      headers: {
        Origin: b.origin,
        Cookie: cookie,
        "X-Morphz-Token": boot.csrfToken,
      },
    });
    assert.equal(logout.status, 200);
    assert.equal(
      (
        await fetch(a.origin + "/api/platform/bootstrap", {
          headers: { Cookie: cookie },
        })
      ).status,
      401,
    );
  } finally {
    if (firstServer)
      await new Promise<void>((resolve) => firstServer!.close(() => resolve()));
    if (secondServer)
      await new Promise<void>((resolve) =>
        secondServer!.close(() => resolve()),
      );
    await firstPlatform?.close();
    await secondPlatform?.close();
    firstWorkspace.close();
    secondWorkspace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test("本机旧登录会话迁入中断后可重试，不覆盖 Platform 原会话", async () => {
  const store = new WorkspaceStore(":memory:", { mode: "transport" });
  const now = 1000;
  const cookieSecret = "c".repeat(64);
  const legacySession = {
    hash: createHash("sha256").update(cookieSecret).digest("hex"),
    csrf: "d".repeat(64),
    principalId: localAccess.principalId,
    actantId: localAccess.actantId,
    credentialHash: hash,
    expiresAt: 2000,
  };
  store.saveServiceState("identity-sessions", [legacySession]);
  const first = new IdentityCenter(store, config, () => now);
  const platform = await bindIdentityTestPlatform(store, first);
  try {
    const cookie = `${first.cookieName}=${cookieSecret}`;
    assert.deepEqual(
      (await first.authenticateShared(cookie))?.access,
      localAccess,
    );
    // Crash after the Platform commit but before clearing the old local row.
    store.saveServiceState("identity-sessions", [legacySession]);
    const restarted = new IdentityCenter(store, config, () => now);
    await bindIdentityTestPlatform(store, restarted, platform);
    assert.equal(store.serviceState("identity-sessions"), null);
    assert.deepEqual(
      (await restarted.authenticateShared(cookie))?.access,
      localAccess,
    );
  } finally {
    await platform.close();
    store.close();
  }
});
test("Human 登录配置不能冒用 Morphz Agent 身份", () => {
  const store = new WorkspaceStore(":memory:", { mode: "transport" });
  try {
    for (const member of [
      { ...localAccess, principalId: morphzAgentAccess.principalId },
      { ...localAccess, actantId: morphzAgentAccess.actantId },
    ])
      assert.throws(
        () =>
          new IdentityCenter(store, {
            version: 1,
            members: [{ ...member, loginTokenHash: hash, enabled: true }],
          }),
        /Human 身份配置不能使用 Morphz Agent 身份/,
      );
  } finally {
    store.close();
  }
});
test("项目投影不暴露未授权对象、成员、历史、图关系或输入", () => {
  const fixture = viewModelFixture();
  fixture.seedArtifact({
    projectId: "first-project",
    title: "私有",
    content: { kind: "document", markdown: "不可见正文" },
  });
  const other = workspaceFor(fixture.state, {
    principalId: "other",
    actantId: "other-human",
  });
  assert.equal(other.projects.length, 0);
  assert.equal(other.artifacts.length, 0);
  assert.equal(other.principals.length, 0);
  assert.equal(other.actants.length, 0);
  assert.ok(!JSON.stringify(other).includes("不可见正文"));
  assert.equal(workspaceFor(fixture.state, localAccess).artifacts.length, 1);
});
