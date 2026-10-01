import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { BrowserStore } from "../packages/browser/src/store.js";
import {
  BrowserBookmarkService,
  platformBrowserBookmarkAuthority,
} from "../packages/application/src/browser-bookmark-service.js";
import {
  PlatformStore,
  type PlatformAuthorityVerifier,
} from "../packages/platform/src/store.js";

async function exercise(
  platform: PlatformStore,
  browser: BrowserStore,
  state: {
    agentPrincipal: string;
    mismatchedBrowserOwner: boolean;
  },
) {
  const service = new BrowserBookmarkService(platform, browser);
  const human = { credential: "human-alice" };
  await platform.provisionTenant("tenant-one");
  await platform.registerApplication("tenant-one", {
    appId: "morphz.browser",
    installationId: "install-browser-one",
    instanceId: "browser-one",
    routeKind: "service",
    routeRef: "test:browser-one",
  });
  const agent = { credential: "agent-input-one" };
  await platform.createProject(human, {
    commandId: "create-project-one",
    projectId: "project-one",
    title: "共同项目",
  });

  const initial = {
    commandId: randomUUID(),
    operation: {
      type: "bookmark-add" as const,
      title: "首个收藏",
      url: "https://example.com/old",
    },
  };
  const first = await service.command(human, initial);
  assert.equal(first.source, "browser");
  assert.deepEqual(await service.command(human, initial), first);
  assert.equal((await service.list(human)).length, 1);
  await assert.rejects(
    service.list(human, {
      credential: "human-bob",
      expectedActor: { ownerPrincipalId: "bob" },
    } as never),
  );
  await assert.rejects(
    service.command(human, {
      ...initial,
      operation: { ...initial.operation, title: "不同的请求" },
    }),
    /不同收藏操作/,
  );
  assert.equal((await service.list(human)).length, 1);

  const next = {
    commandId: randomUUID(),
    operation: {
      type: "bookmark-add" as const,
      title: "新收藏",
      url: "https://example.com/new",
    },
  };
  const created = await service.command(human, next);
  assert.equal(created.source, "browser");
  assert.deepEqual(await service.command(human, next), created);
  assert.equal((await service.list(human)).length, 2);
  assert.equal(
    (await service.list(human, { url: "https://example.com/old", limit: 1 }))[0]
      ?.id,
    first.receipt.bookmarkId,
  );
  assert.deepEqual(await service.page(human, { offset: 10, limit: 1 }), {
    total: 2,
    bookmarks: [],
  });
  assert.equal(
    (await service.read(human, first.receipt.bookmarkId))?.title,
    "首个收藏",
  );
  await assert.rejects(
    service.command(human, {
      ...next,
      operation: { ...next.operation, title: "偷换" },
    }),
    /不同收藏操作/,
  );

  const agentCommand = {
    commandId: randomUUID(),
    operation: {
      type: "bookmark-add" as const,
      title: "Agent 保存",
      url: "https://example.com/agent",
    },
  };
  const agentCreated = await service.command(agent, agentCommand);
  assert.deepEqual(await service.command(agent, agentCommand), agentCreated);
  assert.equal(agentCreated.source, "browser");
  assert.equal((await service.list(human)).length, 3);
  state.agentPrincipal = "revoked-agent";
  await assert.rejects(service.list(agent), /操作身份已失效/);
  state.agentPrincipal = "morphz-service";

  state.mismatchedBrowserOwner = true;
  await assert.rejects(
    service.command(human, {
      commandId: randomUUID(),
      operation: {
        type: "bookmark-add",
        title: "不能错写到 Bob",
        url: "https://example.com/wrong-owner",
      },
    }),
    /操作身份不一致/,
  );
  state.mismatchedBrowserOwner = false;
  assert.equal((await service.list(human)).length, 3);
  assert.deepEqual(await service.list({ credential: "human-bob" }), []);
}

function authorities(state: {
  agentPrincipal: string;
  mismatchedBrowserOwner: boolean;
}) {
  const platform: PlatformAuthorityVerifier = {
    async resolveActor({ credential }) {
      if (credential === "human-alice" || credential === "mismatched")
        return {
          tenantId: "tenant-one",
          principalId: "alice",
          actantId: "alice-human",
          kind: "human",
          runtimeInputId: null,
        };
      if (credential === "human-bob")
        return {
          tenantId: "tenant-one",
          principalId: "bob",
          actantId: "bob-human",
          kind: "human",
          runtimeInputId: null,
        };
      if (credential === "agent-input-one")
        return state.agentPrincipal === "morphz-service"
          ? {
              tenantId: "tenant-one",
              principalId: "alice",
              actantId: "morphz-agent",
              kind: "agent",
              runtimeInputId: "input-one",
              scopeProjectId: "project-one",
            }
          : null;
      return null;
    },
    async resolveActant({ actantId }) {
      if (actantId === "morphz-agent")
        return { principalId: state.agentPrincipal, kind: "agent" };
      return null;
    },
    async resolveProjectAgent() {
      return { principalId: "morphz-service", actantId: "morphz-agent" };
    },
    async verifyApplicationObject() {
      return false;
    },
  };
  return platform;
}

function browserAuthority(
  platform: PlatformStore,
  state: { mismatchedBrowserOwner: boolean },
) {
  const current = platformBrowserBookmarkAuthority(
    platform,
    "browser-one",
    () => ({ routeKind: "service", routeRef: "test:browser-one" }),
  );
  return {
    async authorize(request: Parameters<typeof current.authorize>[0]) {
      const actor = await current.authorize(request);
      return state.mismatchedBrowserOwner && actor
        ? { ...actor, ownerPrincipalId: "bob", principalId: "bob" }
        : actor;
    },
  };
}

test("Browser SQLite：UI／Agent 共用身份边界与幂等命令", async () => {
  const state = {
    agentPrincipal: "morphz-service",
    mismatchedBrowserOwner: false,
  };
  const platform = await PlatformStore.sqlite(":memory:", authorities(state));
  const browser = await BrowserStore.sqlite(
    ":memory:",
    browserAuthority(platform, state),
  );
  try {
    await exercise(platform, browser, state);
  } finally {
    await browser.close();
    await platform.close();
  }
});

test(
  "Browser PostgreSQL：幂等命令和 Agent 权限与 SQLite 同义",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const state = {
      agentPrincipal: "morphz-service",
      mismatchedBrowserOwner: false,
    };
    const authority = authorities(state);
    const pool = new Pool({
      connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
    });
    const platformSchema = `morphz_platform_${randomUUID().replaceAll("-", "")}`;
    const browserSchema = `morphz_browser_${randomUUID().replaceAll("-", "")}`;
    try {
      await pool.query(`CREATE SCHEMA "${platformSchema}"`);
      await pool.query(`CREATE SCHEMA "${browserSchema}"`);
      const platform = await PlatformStore.postgres(
        {
          connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
          schema: platformSchema,
        },
        authority,
      );
      const browser = await BrowserStore.postgres({
        connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
        schema: browserSchema,
        authority: browserAuthority(platform, state),
      });
      try {
        await exercise(platform, browser, state);
      } finally {
        await browser.close();
        await platform.close();
      }
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${browserSchema}" CASCADE`);
      await pool.query(`DROP SCHEMA IF EXISTS "${platformSchema}" CASCADE`);
      await pool.end();
    }
  },
);
