import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { RequestError } from "../apps/web/src/application-transport.js";
import { draftKey } from "../apps/web/src/local-preferences.js";
import type { WorkspaceClient } from "../apps/web/src/client.js";
import type { BookmarkOperation } from "../packages/core/src/bookmarks.js";
import type { BookmarkCommandReceipt } from "../packages/browser/src/store.js";
import {
  bookmarkHuman,
  otherBookmarkHuman,
  withBookmarkHttp,
  type BookmarkHttpRead,
  type SavedBookmarkCommand,
} from "./fixtures/bookmark-interactions-http.js";

const add = (title: string, page = title): BookmarkOperation => ({
  type: "bookmark-add",
  title,
  url: "https://example.com/" + encodeURIComponent(page),
});
const commands = (reads: BookmarkHttpRead[]) =>
  reads.filter((r) => r.path === "/api/bookmarks/commands");
const bodyOf = (read: BookmarkHttpRead) => read.body as SavedBookmarkCommand;
const keyOf = (client: WorkspaceClient, operation: BookmarkOperation) => {
  const identity = client.getSnapshot()!;
  return (
    `morphz:${identity.centerId}:${identity.principalId}:${identity.actantId}:` +
    draftKey(
      "pending:bookmark:" +
        createHash("sha256").update(JSON.stringify(operation)).digest("hex"),
    )
  );
};
const receipt = (value: unknown) => {
  const result = value as { source: string; receipt: BookmarkCommandReceipt };
  assert.equal(result.source, "browser");
  assert(result.receipt);
  return result.receipt;
};
const status = (expected: number) => (error: unknown) =>
  error instanceof RequestError && error.status === expected;

test(
  "actual bookmark Client CRUD/off-head URL/filter/pagination/cold SQLite reopen; no content or automatic refresh",
  { timeout: 30000 },
  async () => {
    await withBookmarkHttp("crud", async (context) => {
      const { reads, sql } = context;
      const originalSnapshot = context.client.getSnapshot();
      reads.length = 0;
      for (let i = 0; i < 53; i++)
        await context.client.bookmarkCommand(
          add("page " + String(i).padStart(2, "0")),
        );
      const first = await context.client.bookmarkList({ limit: 50 });
      const next = await context.client.bookmarkList({ offset: 50, limit: 50 });
      assert.equal(first.length, 50);
      assert.equal(next.length, 3);
      assert.equal(new Set([...first, ...next].map((r) => r.id)).size, 53);
      const target = first[1]!; // Deliberately not the returned head.
      assert.notEqual(target.url, first[0]!.url);
      assert.deepEqual(
        await context.client.bookmarkList({ url: target.url, limit: 1 }),
        [target],
      );
      assert.deepEqual(
        await context.client.bookmarkList({
          url: "https://example.com/not-saved",
          limit: 1,
        }),
        [],
      );
      assert.equal(
        new URLSearchParams(reads.at(-2)!.query).get("url"),
        target.url,
      );
      await assert.rejects(
        context.client.bookmarkList({ url: "not-a-url", limit: 1 }),
        status(400),
      );
      assert.equal(
        context.client.getSnapshot(),
        originalSnapshot,
        "bookmark writes do not publish Boot or refresh",
      );
      assert.equal(
        reads.every((r) => r.path.startsWith("/api/bookmarks")),
        true,
      );
      assert.equal(sql().bookmarks.length, 53);
      await context.reopen();
      assert.deepEqual(
        await context.client.bookmarkList({ url: target.url, limit: 1 }),
        [target],
      );
      const update = receipt(
        await context.client.bookmarkCommand({
          type: "bookmark-update",
          bookmarkId: target.id,
          expectedRevision: 1,
          title: "独立修订 独特检索",
          url: target.url,
        }),
      );
      assert.equal(update.revision, 2);
      const query = await context.client.bookmarkList({
        query: "独立修订 独特检索",
      });
      assert.equal(query.length, 1);
      assert.equal(query[0]!.id, target.id);
      const removed = receipt(
        await context.client.bookmarkCommand({
          type: "bookmark-remove",
          bookmarkId: target.id,
          expectedRevision: 2,
        }),
      );
      assert.equal(removed.revision, 3);
      assert.deepEqual(
        await context.client.bookmarkList({ url: target.url }),
        [],
      );
      const deleted = await context.client.bookmarkList({
        deleted: true,
        url: target.url,
      });
      assert.equal(deleted.length, 1);
      assert.equal(deleted[0]!.revision, 3);
      assert(deleted[0]!.deletedAt);
      const restored = receipt(
        await context.client.bookmarkCommand({
          type: "bookmark-restore",
          bookmarkId: target.id,
          expectedRevision: 3,
        }),
      );
      assert.equal(restored.revision, 4);
      const restoredRow = (
        await context.client.bookmarkList({ url: target.url })
      )[0]!;
      assert.equal(restoredRow.id, target.id);
      assert.equal(restoredRow.title, "独立修订 独特检索");
      assert.equal(restoredRow.deletedAt, null);
      assert.equal(restoredRow.ownerPrincipalId, bookmarkHuman.principalId);
      assert.equal(sql().bookmarks.length, 53);
      assert.equal(sql().receipts.length, 56);
      assert.deepEqual(context.client.getSnapshot()!.workspace.artifacts, []);
    });
  },
);

test(
  "actual committed receipt loss survives same-window Client remount; whole retry one SQL receipt, new explicit ID and URL dedup",
  { timeout: 30000 },
  async () => {
    await withBookmarkHttp("retry", async (context) => {
      const { reads, rows, sql } = context;
      const operation = add("原始收藏", "stable-retry");
      const key = keyOf(context.client, operation);
      context.loseNext();
      await assert.rejects(
        context.client.bookmarkCommand(operation),
        /TEST lost authorized bookmark receipt/,
      );
      const initial = commands(reads)[0]!;
      assert.equal(initial.status, 200);
      const saved = JSON.parse(rows.get(key)!) as SavedBookmarkCommand;
      assert.deepEqual(saved, bodyOf(initial));
      const committed = receipt(initial.response);
      assert.equal(
        sql().receipts.filter((r) => r.command_id === saved.commandId).length,
        1,
      );
      await context.remount();
      assert.equal(
        keyOf(context.client, operation),
        key,
        "same original center/Human/actant/window key",
      );
      assert.deepEqual(
        await context.client.bookmarkCommand(operation),
        initial.response,
      );
      const retry = commands(reads)[1]!;
      assert.deepEqual(
        bodyOf(retry),
        bodyOf(initial),
        "exact stored whole command reused through actual Client",
      );
      assert.equal(
        sql().receipts.filter((r) => r.command_id === saved.commandId).length,
        1,
      );
      assert.equal(rows.get(key), "null");
      const fresh = receipt(await context.client.bookmarkCommand(operation));
      assert.notEqual(fresh.commandId, committed.commandId);
      assert.equal(fresh.bookmarkId, committed.bookmarkId);
      const dedup = receipt(
        await context.client.bookmarkCommand(
          add("不得隐式改名", "stable-retry"),
        ),
      );
      assert.notEqual(dedup.commandId, fresh.commandId);
      assert.equal(dedup.bookmarkId, committed.bookmarkId);
      const listed = await context.client.bookmarkList({
        url: operation.type === "bookmark-add" ? operation.url : "",
      });
      assert.equal(listed.length, 1);
      assert.equal(listed[0]!.title, "原始收藏");
      assert.equal(listed[0]!.revision, 1);
      assert.equal(sql().bookmarks.length, 1);
      assert.equal(sql().receipts.length, 3);
    });
  },
);

test(
  "actual two authenticated Humans keep personal ownership, cannot mutate each other's ID, and live revocation rejects",
  { timeout: 30000 },
  async () => {
    await withBookmarkHttp("privacy", async (context) => {
      const operation = add("A私有收藏", "private");
      const first = receipt(await context.client.bookmarkCommand(operation));
      await context.login(true);
      assert.equal(
        context.client.getSnapshot()!.principalId,
        otherBookmarkHuman.principalId,
      );
      assert.deepEqual(await context.client.bookmarkList({}), []);
      await assert.rejects(
        context.client.bookmarkCommand({
          type: "bookmark-remove",
          bookmarkId: first.bookmarkId,
          expectedRevision: 1,
        }),
        status(404),
      );
      const second = receipt(
        await context.client.bookmarkCommand(add("B私有收藏", "private")),
      );
      assert.notEqual(second.bookmarkId, first.bookmarkId);
      assert.equal(second.ownerPrincipalId, otherBookmarkHuman.principalId);
      const secondRows = await context.client.bookmarkList();
      assert.equal(secondRows.length, 1);
      assert.equal(secondRows[0]!.title, "B私有收藏");
      await context.login();
      const firstRows = await context.client.bookmarkList();
      assert.equal(firstRows.length, 1);
      assert.equal(firstRows[0]!.id, first.bookmarkId);
      await context.revoke();
      await assert.rejects(context.client.bookmarkList(), status(401));
      await assert.rejects(
        context.client.bookmarkCommand(add("撤销后禁止")),
        status(401),
      );
      assert.equal(context.sql().bookmarks.length, 2);
      assert.equal(context.sql().receipts.length, 2);
    });
  },
);

test(
  "actual 409/400 rejection clears exact pending; committed success-clear failure retains durable whole command",
  { timeout: 30000 },
  async () => {
    await withBookmarkHttp("errors", async (context) => {
      const { rows, reads, sql } = context;
      const first = receipt(
        await context.client.bookmarkCommand(add("CAS原稿")),
      );
      const stale: BookmarkOperation = {
        type: "bookmark-update",
        bookmarkId: first.bookmarkId,
        expectedRevision: 9,
        title: "过期CAS",
        url: "https://example.com/CAS",
      };
      await assert.rejects(context.client.bookmarkCommand(stale), status(409));
      assert.equal(commands(reads).at(-1)!.status, 409);
      assert.equal(rows.get(keyOf(context.client, stale)), "null");
      const invalid: BookmarkOperation = {
        type: "bookmark-add",
        title: "",
        url: "https://example.com/invalid",
      };
      await assert.rejects(
        context.client.bookmarkCommand(invalid),
        status(400),
      );
      assert.equal(commands(reads).at(-1)!.status, 400);
      assert.equal(rows.get(keyOf(context.client, invalid)), "null");
      const operation = add("已提交但本地清理失败");
      context.failClear(true);
      try {
        await assert.rejects(
          context.client.bookmarkCommand(operation),
          /TEST success clear storage failure/,
        );
      } finally {
        context.failClear(false);
      }
      const committed = commands(reads).at(-1)!;
      assert.equal(committed.status, 200);
      const saved = JSON.parse(
        rows.get(keyOf(context.client, operation))!,
      ) as SavedBookmarkCommand;
      assert.deepEqual(saved, bodyOf(committed));
      assert.equal(
        sql().receipts.filter((r) => r.command_id === saved.commandId).length,
        1,
      );
      assert.deepEqual(
        await context.client.bookmarkCommand(operation),
        committed.response,
      );
      assert.deepEqual(bodyOf(commands(reads).at(-1)!), saved);
      assert.equal(rows.get(keyOf(context.client, operation)), "null");
      assert.equal(
        sql().receipts.filter((r) => r.command_id === saved.commandId).length,
        1,
      );
      assert.equal(sql().receipts.length, 2);
    });
  },
);

test(
  "actual held 200 late receipt is exact HTTP 408 after identity switch; original scope retry does not double-write",
  { timeout: 30000 },
  async () => {
    await withBookmarkHttp("late-identity", async (context) => {
      const operation = add("旧身份真实已提交", "late");
      const originalKey = keyOf(context.client, operation);
      const hold = context.holdNext();
      const pending = context.client.bookmarkCommand(operation);
      const rejected = assert.rejects(
        pending,
        (error) =>
          error instanceof RequestError &&
          error.status === 408 &&
          error.message === "身份已切换，旧响应已丢弃。",
      );
      try {
        await hold.reached;
        const committed = commands(context.reads).at(-1)!;
        assert.equal(committed.status, 200);
        assert.equal(context.sql().bookmarks.length, 1);
        assert.equal(context.sql().receipts.length, 1);
        await context.login(true);
        const switched = context.client.getSnapshot();
        assert.equal(switched!.principalId, otherBookmarkHuman.principalId);
        const otherKey = keyOf(context.client, operation);
        assert.notEqual(otherKey, originalKey);
        hold.release();
        await rejected;
        assert.equal(
          context.client.getSnapshot(),
          switched,
          "late old response cannot publish over the new identity",
        );
        assert.equal(
          context.rows.get(otherKey),
          undefined,
          "no pending record in another Human's scope",
        );
        assert.notEqual(
          context.rows.get(originalKey),
          "null",
          "uncertain old receipt remains retryable",
        );
        assert.deepEqual(await context.client.bookmarkList(), []);
        await context.login();
        assert.deepEqual(
          await context.client.bookmarkCommand(operation),
          committed.response,
        );
        const all = commands(context.reads);
        assert.equal(all.length, 2);
        assert.deepEqual(bodyOf(all[0]!), bodyOf(all[1]!));
        const command = bodyOf(all[0]!);
        assert.equal(
          context
            .sql()
            .receipts.filter((r) => r.command_id === command.commandId).length,
          1,
        );
        assert.equal(context.sql().bookmarks.length, 1);
        assert.equal(
          context.sql().bookmarks[0]!.owner_principal_id,
          bookmarkHuman.principalId,
        );
        assert.equal(context.rows.get(originalKey), "null");
      } finally {
        hold.release();
        await rejected;
      }
    });
  },
);
