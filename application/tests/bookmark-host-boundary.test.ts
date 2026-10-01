import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createAppServer } from "../apps/service/src/http.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { Application } from "../packages/application/src/application.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";
import { HumanPlatformAuthority } from "../packages/application/src/human-platform-authority.js";
import { IdentityCenter } from "../packages/application/src/identity.js";
import {
  BrowserBookmarkService,
  platformBrowserBookmarkAuthority,
} from "../packages/application/src/browser-bookmark-service.js";
import { BrowserStore } from "../packages/browser/src/store.js";
import {
  PlatformStore,
  type PlatformAuthorityVerifier,
} from "../packages/platform/src/store.js";
import { localAccess, type AccessContext } from "../packages/core/src/model.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { bindIdentityTestPlatform } from "./identity-platform-fixture.js";

const noOtherAuthority: PlatformAuthorityVerifier = {
  async resolveActor() {
    return null;
  },
  async resolveActant() {
    return null;
  },
  async resolveProjectAgent() {
    return null;
  },
  async verifyApplicationObject() {
    return false;
  },
};

function verifyHuman(identity?: IdentityCenter) {
  return (access: AccessContext) =>
    identity
      ? identity.allows(access)
      : access.principalId === localAccess.principalId &&
        access.actantId === localAccess.actantId;
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("受信 Host Session 可操作独立收藏；旧工作区不能再写同一领域", async () => {
  const workspace = new WorkspaceStore(":memory:");
  const human = new HumanPlatformAuthority("tenant-one", verifyHuman());
  const platform = await PlatformStore.sqlite(
    ":memory:",
    human.verifier(noOtherAuthority),
  );
  const browser = await BrowserStore.sqlite(
    ":memory:",
    platformBrowserBookmarkAuthority(platform, "browser-one", () => ({
      routeKind: "service",
      routeRef: "test:browser-one",
    })),
  );
  try {
    await platform.provisionTenant("tenant-one");
    await platform.registerApplication("tenant-one", {
      appId: "morphz.browser",
      installationId: "install-browser-one",
      instanceId: "browser-one",
      routeKind: "service",
      routeRef: "test:browser-one",
    });
    const application = new Application(workspace, {
      bookmarkDomain: {
        authority: human,
        service: new BrowserBookmarkService(platform, browser),
      },
    });
    const connection = new LocalApplicationConnection(application);
    const boot = (await connection.call("platform.bootstrap")) as {
      csrfToken: string;
      capabilities: { browserBookmarks: boolean };
    };
    assert.equal(boot.capabilities.browserBookmarks, true);
    const command = {
      commandId: randomUUID(),
      operation: {
        type: "bookmark-add",
        title: "独立收藏",
        url: "https://example.com/new",
      },
    };
    const options = { identityGeneration: boot.csrfToken };
    const receipt = await connection.call(
      "bookmarks.command",
      command,
      options,
    );
    assert.deepEqual(
      await connection.call("bookmarks.command", command, options),
      receipt,
    );
    const list = (await connection.call(
      "bookmarks.list",
      {},
      options,
    )) as Array<{
      title: string;
    }>;
    assert.equal(list.length, 1);
    assert.equal(list[0]?.title, "独立收藏");
    assert.equal("snapshot" in workspace, false);
    assert.equal("execute" in workspace, false);
    await assert.rejects(
      connection.call(
        "bookmarks.command",
        {
          ...command,
          operation: { ...command.operation, title: "不同的请求" },
        },
        options,
      ),
      (error: unknown) =>
        error instanceof Error && "status" in error && error.status === 409,
    );
    const retiredCommand = await connection.invoke({
      id: randomUUID(),
      method: "command",
      params: { ...command, commandId: randomUUID() },
      identityGeneration: options.identityGeneration,
    });
    assert.equal(retiredCommand.ok, false);
    if (!retiredCommand.ok) assert.equal(retiredCommand.error.status, 400);
    await assert.rejects(
      connection.call("bookmarks.list", { credential: "forged" }, options),
      /请求格式无效/,
    );
    await assert.rejects(
      connection.call("bookmarks.list", {}, { identityGeneration: "stale" }),
      /身份已切换/,
    );

    const port = await freePort();
    const server = createAppServer(workspace, {
      port,
      webRoot: "/nonexistent",
      bookmarkDomain: application.options.bookmarkDomain,
    });
    await new Promise<void>((resolve) =>
      server.listen(port, "127.0.0.1", resolve),
    );
    try {
      const remote = new HttpApplicationClient(`http://127.0.0.1:${port}`);
      const remoteBoot = (await remote.call("platform.bootstrap")) as {
        csrfToken: string;
      };
      assert.equal(
        ((await remote.call("bookmarks.list", {})) as unknown[]).length,
        1,
      );
      await remote.call(
        "bookmarks.command",
        {
          commandId: randomUUID(),
          operation: {
            type: "bookmark-add",
            title: "Web 收藏",
            url: "https://example.com/web",
          },
        },
        { identityGeneration: remoteBoot.csrfToken },
      );
      assert.equal(
        ((await remote.call("bookmarks.list", {})) as unknown[]).length,
        2,
      );
      assert.equal(workspace.runtimeState(), null);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await browser.close();
    await platform.close();
    workspace.close();
  }
});

test("Human Host 凭据只在调用期间有效，撤销和伪造身份均拒绝", async () => {
  const workspace = new WorkspaceStore(":memory:");
  let now = 0;
  const authority = new HumanPlatformAuthority(
    "tenant-one",
    verifyHuman(),
    () => now,
  );
  const verifier = authority.verifier(noOtherAuthority);
  try {
    let captured = "";
    await authority.withSession(
      localAccess,
      () => {},
      async (actor) => {
        captured = actor.credential;
        assert.deepEqual(await verifier.resolveActor(actor), {
          tenantId: "tenant-one",
          principalId: localAccess.principalId,
          actantId: localAccess.actantId,
          kind: "human",
          runtimeInputId: null,
        });
        now = 60_000;
        assert.equal(await verifier.resolveActor(actor), null);
      },
    );
    assert.equal(await verifier.resolveActor({ credential: captured }), null);
    await assert.rejects(
      authority.withSession(
        { principalId: "another-user", actantId: "local-human" },
        () => {},
        async () => undefined,
      ),
      /当前用户身份已失效/,
    );
  } finally {
    workspace.close();
  }
});

test("团队 Host 身份切换与撤销后，不能沿用旧收藏权限", async () => {
  const workspace = new WorkspaceStore(":memory:");
  const other = { principalId: "other", actantId: "other-human" };
  const tokens = ["a".repeat(64), "b".repeat(64)];
  const configuration = {
    version: 1 as const,
    members: [localAccess, other].map((access, index) => ({
      ...access,
      loginTokenHash: createHash("sha256").update(tokens[index]!).digest("hex"),
      enabled: true,
    })),
  };
  const identity = new IdentityCenter(workspace, configuration);
  const identityPlatform = await bindIdentityTestPlatform(workspace, identity);
  const authority = new HumanPlatformAuthority(
    "tenant-one",
    verifyHuman(identity),
  );
  const platform = await PlatformStore.sqlite(
    ":memory:",
    authority.verifier(noOtherAuthority),
  );
  const browser = await BrowserStore.sqlite(
    ":memory:",
    platformBrowserBookmarkAuthority(platform, "browser-one", () => ({
      routeKind: "service",
      routeRef: "test:browser-one",
    })),
  );
  try {
    await platform.provisionTenant("tenant-one");
    await platform.registerApplication("tenant-one", {
      appId: "morphz.browser",
      installationId: "install-browser-one",
      instanceId: "browser-one",
      routeKind: "service",
      routeRef: "test:browser-one",
    });
    const application = new Application(workspace, {
      identity,
      bookmarkDomain: {
        authority,
        service: new BrowserBookmarkService(platform, browser),
      },
    });
    const connection = new LocalApplicationConnection(application);
    await connection.call("login", { token: tokens[0] });
    const alice = (await connection.call("platform.bootstrap")) as {
      csrfToken: string;
    };
    await connection.call(
      "bookmarks.command",
      {
        commandId: randomUUID(),
        operation: {
          type: "bookmark-add",
          title: "仅甲可见",
          url: "https://example.com/private",
        },
      },
      { identityGeneration: alice.csrfToken },
    );
    await connection.call("login", { token: tokens[1] });
    const bob = (await connection.call("platform.bootstrap")) as {
      csrfToken: string;
    };
    assert.deepEqual(
      await connection.call(
        "bookmarks.list",
        {},
        { identityGeneration: bob.csrfToken },
      ),
      [],
    );
    await assert.rejects(
      connection.call(
        "bookmarks.list",
        {},
        { identityGeneration: alice.csrfToken },
      ),
      /身份已切换/,
    );
    configuration.members[1]!.enabled = false;
    await identity.replaceConfiguration(configuration);
    await assert.rejects(
      connection.call(
        "bookmarks.list",
        {},
        { identityGeneration: bob.csrfToken },
      ),
      /登录后继续操作/,
    );
  } finally {
    await browser.close();
    await platform.close();
    await identityPlatform.close();
    workspace.close();
  }
});
