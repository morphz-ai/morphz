import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import {
  BrowserStore,
  type BrowserBookmarkAuthority,
} from "../packages/browser/src/store.js";
import { browserSchemaSql } from "../packages/browser/src/schema.js";

const authority: BrowserBookmarkAuthority = {
  async authorize({ credential, originInputId }) {
    if (credential === "alice")
      return {
        tenantId: "tenant_a",
        ownerPrincipalId: "alice",
        principalId: "alice",
        actantId: "actant_alice",
        kind: "human",
        runtimeInputId: null,
      };
    if (credential === "bob")
      return {
        tenantId: "tenant_a",
        ownerPrincipalId: "bob",
        principalId: "bob",
        actantId: "actant_bob",
        kind: "human",
        runtimeInputId: null,
      };
    if (credential === "agent")
      return {
        tenantId: "tenant_a",
        ownerPrincipalId: "alice",
        principalId: "morphz",
        actantId: "agent_one",
        kind: "agent",
        runtimeInputId:
          originInputId === "input_verified" ? originInputId : null,
      };
    return null;
  },
};

test("Browser 生产 schema 与评审 SQL 相同", () => {
  assert.equal(
    browserSchemaSql.trim(),
    readFileSync(
      new URL("../docs/storage-model-v1/browser.sql", import.meta.url),
      "utf8",
    ).trim(),
  );
});

async function exercise(store: BrowserStore) {
  const alice = await store.command({
    credential: "alice",
    commandId: "seed_alice",
    operation: {
      type: "bookmark-add",
      title: "收藏 alice",
      url: "https://example.com/bookmark_old",
    },
  });
  const removed = await store.command({
    credential: "alice",
    commandId: "seed_removed",
    operation: {
      type: "bookmark-add",
      title: "收藏 deleted",
      url: "https://example.com/bookmark_deleted",
    },
  });
  await store.command({
    credential: "alice",
    commandId: "seed_delete",
    operation: {
      type: "bookmark-remove",
      bookmarkId: removed.bookmarkId,
      expectedRevision: 1,
    },
  });
  const bob = await store.command({
    credential: "bob",
    commandId: "seed_bob",
    operation: {
      type: "bookmark-add",
      title: "收藏 bob",
      url: "https://example.com/bookmark_bob",
    },
  });
  assert.deepEqual(
    (await store.listBookmarks({ credential: "alice" })).map(
      (value) => value.id,
    ),
    [alice.bookmarkId],
  );
  assert.deepEqual(
    (await store.listBookmarks({ credential: "alice", deleted: true })).map(
      (value) => value.id,
    ),
    [removed.bookmarkId],
  );
  assert.deepEqual(
    (await store.listBookmarks({ credential: "bob" })).map((value) => value.id),
    [bob.bookmarkId],
  );
  await assert.rejects(
    store.listBookmarks({ credential: "agent" }),
    /发起输入/,
  );
  assert.deepEqual(
    (
      await store.listBookmarks({
        credential: "agent",
        originInputId: "input_verified",
      })
    ).map((value) => value.id),
    [alice.bookmarkId],
  );

  const add = {
    credential: "alice",
    commandId: "command_add",
    operation: {
      type: "bookmark-add" as const,
      title: "新收藏",
      url: "https://example.com/new",
    },
  };
  const created = await store.command(add);
  assert.equal(created.ownerPrincipalId, "alice");
  assert.equal(created.revision, 1);
  assert.deepEqual(await store.command(add), created);
  await assert.rejects(
    store.command({
      ...add,
      operation: { ...add.operation, title: "偷换" },
    }),
    /不同收藏操作/,
  );
  const duplicateUrl = await store.command({
    ...add,
    commandId: "command_duplicate",
  });
  assert.equal(duplicateUrl.bookmarkId, created.bookmarkId);
  assert.equal(duplicateUrl.revision, 1);
  const agent = await store.command({
    credential: "agent",
    originInputId: "input_verified",
    commandId: "command_agent",
    operation: {
      type: "bookmark-add",
      title: "Agent 收藏",
      url: "https://example.com/agent",
    },
  });
  assert.equal(agent.ownerPrincipalId, "alice");
  await assert.rejects(
    store.command({
      credential: "bob",
      commandId: "command_foreign",
      operation: {
        type: "bookmark-update",
        bookmarkId: created.bookmarkId,
        expectedRevision: 1,
        title: "越权",
        url: "https://example.com/new",
      },
    }),
    /不可访问/,
  );

  const removedReceipt = await store.command({
    credential: "alice",
    commandId: "command_remove",
    operation: {
      type: "bookmark-remove",
      bookmarkId: created.bookmarkId,
      expectedRevision: 1,
    },
  });
  assert.equal(removedReceipt.revision, 2);
  await assert.rejects(
    store.command({
      credential: "alice",
      commandId: "command_stale",
      operation: {
        type: "bookmark-remove",
        bookmarkId: created.bookmarkId,
        expectedRevision: 1,
      },
    }),
    /已被修改/,
  );
  const replacement = await store.command({
    ...add,
    commandId: "command_replacement",
  });
  assert.notEqual(replacement.bookmarkId, created.bookmarkId);
  await assert.rejects(
    store.command({
      credential: "alice",
      commandId: "command_restore_collision",
      operation: {
        type: "bookmark-restore",
        bookmarkId: created.bookmarkId,
        expectedRevision: 2,
      },
    }),
  );
  assert.equal(
    (await store.listBookmarks({ credential: "alice", deleted: true })).find(
      (value) => value.id === created.bookmarkId,
    )?.revision,
    2,
  );
  await store.command({
    credential: "alice",
    commandId: "command_remove_replacement",
    operation: {
      type: "bookmark-remove",
      bookmarkId: replacement.bookmarkId,
      expectedRevision: 1,
    },
  });
  const restored = await store.command({
    credential: "alice",
    commandId: "command_restore",
    operation: {
      type: "bookmark-restore",
      bookmarkId: created.bookmarkId,
      expectedRevision: 2,
    },
  });
  assert.equal(restored.revision, 3);
  assert.ok(
    (
      await store.listBookmarks({
        credential: "alice",
        query: "example.com/new",
      })
    ).some((value) => value.id === created.bookmarkId),
  );
  await assert.rejects(
    store.listBookmarks({ credential: "unknown" }),
    /没有访问/,
  );
}

test("Browser SQLite：Human／Agent 使用同一领域操作", async () => {
  const store = await BrowserStore.sqlite(":memory:", authority);
  try {
    await exercise(store);
  } finally {
    await store.close();
  }
});

test("Browser SQLite 重开后保留同一命令回执，不重复创建收藏", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-browser-reopen-"));
  const filename = join(directory, "browser.sqlite");
  const command = {
    credential: "alice",
    commandId: "durable_command",
    operation: {
      type: "bookmark-add" as const,
      title: "持久收藏",
      url: "https://example.com/durable",
    },
  };
  try {
    const first = await BrowserStore.sqlite(filename, authority);
    let receipt;
    try {
      receipt = await first.command(command);
    } finally {
      await first.close();
    }
    const reopened = await BrowserStore.sqlite(filename, authority);
    try {
      assert.deepEqual(await reopened.command(command), receipt);
      assert.equal(
        (await reopened.listBookmarks({ credential: "alice" })).length,
        1,
      );
      await assert.rejects(
        reopened.command({
          ...command,
          operation: { ...command.operation, title: "改变历史" },
        }),
        /不同收藏操作/,
      );
    } finally {
      await reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test(
  "Browser PostgreSQL：收藏、修订和身份边界与 SQLite 一致",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const schema = `morphz_test_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({
      connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
    });
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      const store = await BrowserStore.postgres({
        connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
        schema,
        authority,
      });
      try {
        await exercise(store);
      } finally {
        await store.close();
      }
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      client.release();
      await pool.end();
    }
  },
);
