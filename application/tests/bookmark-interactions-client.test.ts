import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  authenticatedHttp,
  type ActualMountedClient,
} from "./fixtures/actual-mounted-client-test.js";
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
const keyOf = (
  client: ActualMountedClient,
  operation: BookmarkOperation,
): Promise<string> =>
  client.control(
    "bookmarkKey",
    createHash("sha256").update(JSON.stringify(operation)).digest("hex"),
  );
const receipt = (value: unknown) => {
  const result = value as { source: string; receipt: BookmarkCommandReceipt };
  assert.equal(result.source, "browser");
  assert(result.receipt);
  return result.receipt;
};
const status = (expected: number) => (error: unknown) =>
  error instanceof Error && (error as { status?: number }).status === expected;

test(
  "actual mounted bookmark CRUD/off-head URL/filter/pagination/cold SQLite reopen; change hints preserve Boot and create no content",
  { timeout: 30000 },
  async () => {
    await withBookmarkHttp("crud", async (context) => {
      const { reads, sql } = context;
      await context.client.snapshot("original");
      await context.client.control("clearReads");
      for (let i = 0; i < 53; i++)
        await context.client.call("bookmarkCommand", [
          add("page " + String(i).padStart(2, "0")),
        ]);
      const first = await context.client.call("bookmarkList", [{ limit: 50 }]);
      const next = await context.client.call("bookmarkList", [
        { offset: 50, limit: 50 },
      ]);
      assert.equal(first.length, 50);
      assert.equal(next.length, 3);
      assert.equal(new Set([...first, ...next].map((r) => r.id)).size, 53);
      const target = first[1]!; // Deliberately not the returned head.
      assert.notEqual(target.url, first[0]!.url);
      assert.deepEqual(
        await context.client.call("bookmarkList", [
          { url: target.url, limit: 1 },
        ]),
        [target],
      );
      // Unrelated reads can interleave with the two URL lookups (including
      // authority revalidation after a bookmark change). Exercise that order
      // explicitly rather than assuming these are the last two HTTP receipts.
      assert.equal(
        (await context.client.call("bookmarkList", [{ limit: 1 }])).length,
        1,
      );
      assert.deepEqual(
        await context.client.call("bookmarkList", [
          {
            url: "https://example.com/not-saved",
            limit: 1,
          },
        ]),
        [],
      );
      assert.deepEqual(
        (await reads())
          .filter(
            (read) => read.method === "GET" && read.path === "/api/bookmarks",
          )
          .map((read) => new URLSearchParams(read.query).get("url"))
          .filter((url) => url !== null),
        [target.url, "https://example.com/not-saved"],
      );
      await assert.rejects(
        context.client.call("bookmarkList", [{ url: "not-a-url", limit: 1 }]),
        status(400),
      );
      assert.equal(
        await context.client.control("sameSnapshot", "original"),
        true,
        "bookmark hints may revalidate authority but cannot replace unchanged Boot",
      );
      assert.equal(
        (await reads()).every(
          (r) =>
            r.path.startsWith("/api/bookmarks") ||
            (r.method === "GET" &&
              [
                "/api/platform/bootstrap",
                "/api/platform/app-views",
                "/api/platform/runtime-navigation",
              ].includes(r.path)),
        ),
        true,
        "mounted workspace change hints only revalidate authority/navigation; no content loads or new business writes",
      );
      assert.equal(sql().bookmarks.length, 53);
      await context.reopen();
      assert.deepEqual(
        await context.client.call("bookmarkList", [
          { url: target.url, limit: 1 },
        ]),
        [target],
      );
      const update = receipt(
        await context.client.call("bookmarkCommand", [
          {
            type: "bookmark-update",
            bookmarkId: target.id,
            expectedRevision: 1,
            title: "独立修订 独特检索",
            url: target.url,
          },
        ]),
      );
      assert.equal(update.revision, 2);
      const query = await context.client.call("bookmarkList", [
        {
          query: "独立修订 独特检索",
        },
      ]);
      assert.equal(query.length, 1);
      assert.equal(query[0]!.id, target.id);
      const removed = receipt(
        await context.client.call("bookmarkCommand", [
          {
            type: "bookmark-remove",
            bookmarkId: target.id,
            expectedRevision: 2,
          },
        ]),
      );
      assert.equal(removed.revision, 3);
      assert.deepEqual(
        await context.client.call("bookmarkList", [{ url: target.url }]),
        [],
      );
      const deleted = await context.client.call("bookmarkList", [
        {
          deleted: true,
          url: target.url,
        },
      ]);
      assert.equal(deleted.length, 1);
      assert.equal(deleted[0]!.revision, 3);
      assert(deleted[0]!.deletedAt);
      const restored = receipt(
        await context.client.call("bookmarkCommand", [
          {
            type: "bookmark-restore",
            bookmarkId: target.id,
            expectedRevision: 3,
          },
        ]),
      );
      assert.equal(restored.revision, 4);
      const restoredRow = (
        await context.client.call("bookmarkList", [{ url: target.url }])
      )[0]!;
      assert.equal(restoredRow.id, target.id);
      assert.equal(restoredRow.title, "独立修订 独特检索");
      assert.equal(restoredRow.deletedAt, null);
      assert.equal(restoredRow.ownerPrincipalId, bookmarkHuman.principalId);
      assert.equal(sql().bookmarks.length, 53);
      assert.equal(sql().receipts.length, 56);
      assert.deepEqual(
        (await context.client.snapshot())!.workspace.artifacts,
        [],
      );
    });
  },
);

test(
  "actual committed receipt loss survives same-window Client remount; whole retry one SQL receipt, new explicit ID and URL dedup",
  { timeout: 30000 },
  async () => {
    await withBookmarkHttp("retry", async (context) => {
      const { reads, sql } = context;
      const operation = add("原始收藏", "stable-retry");
      const key = await keyOf(context.client, operation);
      await context.loseNext();
      await assert.rejects(
        context.client.call("bookmarkCommand", [operation]),
        /TEST lost authorized bookmark receipt/,
      );
      const initial = commands(await reads())[0]!;
      assert.equal(initial.status, 200);
      const saved = JSON.parse(
        (await context.rows())[key]!,
      ) as SavedBookmarkCommand;
      assert.deepEqual(saved, bodyOf(initial));
      const committed = receipt(initial.response);
      assert.equal(
        sql().receipts.filter((r) => r.command_id === saved.commandId).length,
        1,
      );
      await context.remount();
      assert.equal(
        await keyOf(context.client, operation),
        key,
        "same original center/Human/actant/window key",
      );
      assert.deepEqual(
        await context.client.call("bookmarkCommand", [operation]),
        initial.response,
      );
      const retry = commands(await reads())[1]!;
      assert.deepEqual(
        bodyOf(retry),
        bodyOf(initial),
        "exact stored whole command reused through actual Client",
      );
      assert.equal(
        sql().receipts.filter((r) => r.command_id === saved.commandId).length,
        1,
      );
      assert.equal((await context.rows())[key], "null");
      const fresh = receipt(
        await context.client.call("bookmarkCommand", [operation]),
      );
      assert.notEqual(fresh.commandId, committed.commandId);
      assert.equal(fresh.bookmarkId, committed.bookmarkId);
      const dedup = receipt(
        await context.client.call("bookmarkCommand", [
          add("不得隐式改名", "stable-retry"),
        ]),
      );
      assert.notEqual(dedup.commandId, fresh.commandId);
      assert.equal(dedup.bookmarkId, committed.bookmarkId);
      const listed = await context.client.call("bookmarkList", [
        {
          url: operation.type === "bookmark-add" ? operation.url : "",
        },
      ]);
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
      const first = receipt(
        await context.client.call("bookmarkCommand", [operation]),
      );
      await context.login(true);
      assert.equal(
        (await context.client.snapshot())!.principalId,
        otherBookmarkHuman.principalId,
      );
      assert.deepEqual(await context.client.call("bookmarkList", [{}]), []);
      await assert.rejects(
        context.client.call("bookmarkCommand", [
          {
            type: "bookmark-remove",
            bookmarkId: first.bookmarkId,
            expectedRevision: 1,
          },
        ]),
        status(404),
      );
      const second = receipt(
        await context.client.call("bookmarkCommand", [
          add("B私有收藏", "private"),
        ]),
      );
      assert.notEqual(second.bookmarkId, first.bookmarkId);
      assert.equal(second.ownerPrincipalId, otherBookmarkHuman.principalId);
      const secondRows = await context.client.call("bookmarkList", []);
      assert.equal(secondRows.length, 1);
      assert.equal(secondRows[0]!.title, "B私有收藏");
      await context.login();
      const firstRows = await context.client.call("bookmarkList", []);
      assert.equal(firstRows.length, 1);
      assert.equal(firstRows[0]!.id, first.bookmarkId);
      const csrfToken = (await context.client.snapshot())!.csrfToken;
      const remote = authenticatedHttp(context.client);
      await context.revoke();
      // Revocation now closes the live subscription and clears Client's
      // protected projection. Prove server ACL independently of which refresh
      // finishes first; do not require the renderer to keep a revoked identity.
      await assert.rejects(
        remote.call("bookmarks.list", {}, { identityGeneration: csrfToken }),
        status(401),
      );
      await assert.rejects(
        remote.call(
          "bookmarks.command",
          { commandId: randomUUID(), operation: add("撤销后禁止") },
          { identityGeneration: csrfToken },
        ),
        status(401),
      );
      await context.client.page.waitForFunction(
        () =>
          Reflect.get(window, "actualMountedClient").report().snapshot === null,
        undefined,
        { timeout: 8000 },
      );
      const requestsBefore = (await context.reads()).length;
      for (const operation of [
        () => context.client.call("bookmarkList", []),
        () => context.client.call("bookmarkCommand", [add("本地撤销后禁止")]),
      ])
        await assert.rejects(operation(), {
          message: "应用尚未就绪，请稍后重试。",
        });
      assert.equal(
        (await context.reads()).length,
        requestsBefore,
        "cleared mounted Client must not dispatch reads or writes with revoked credentials",
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
      const { reads, sql } = context;
      const first = receipt(
        await context.client.call("bookmarkCommand", [add("CAS原稿")]),
      );
      const stale: BookmarkOperation = {
        type: "bookmark-update",
        bookmarkId: first.bookmarkId,
        expectedRevision: 9,
        title: "过期CAS",
        url: "https://example.com/CAS",
      };
      await assert.rejects(
        context.client.call("bookmarkCommand", [stale]),
        status(409),
      );
      assert.equal(commands(await reads()).at(-1)!.status, 409);
      assert.equal(
        (await context.rows())[await keyOf(context.client, stale)],
        "null",
      );
      const invalid: BookmarkOperation = {
        type: "bookmark-add",
        title: "",
        url: "https://example.com/invalid",
      };
      await assert.rejects(
        context.client.call("bookmarkCommand", [invalid]),
        status(400),
      );
      assert.equal(commands(await reads()).at(-1)!.status, 400);
      assert.equal(
        (await context.rows())[await keyOf(context.client, invalid)],
        "null",
      );
      const operation = add("已提交但本地清理失败");
      await context.failClear(true);
      try {
        await assert.rejects(
          context.client.call("bookmarkCommand", [operation]),
          /TEST success clear storage failure/,
        );
      } finally {
        await context.failClear(false);
      }
      const committed = commands(await reads()).at(-1)!;
      assert.equal(committed.status, 200);
      const saved = JSON.parse(
        (await context.rows())[await keyOf(context.client, operation)]!,
      ) as SavedBookmarkCommand;
      assert.deepEqual(saved, bodyOf(committed));
      assert.equal(
        sql().receipts.filter((r) => r.command_id === saved.commandId).length,
        1,
      );
      assert.deepEqual(
        await context.client.call("bookmarkCommand", [operation]),
        committed.response,
      );
      assert.deepEqual(bodyOf(commands(await reads()).at(-1)!), saved);
      assert.equal(
        (await context.rows())[await keyOf(context.client, operation)],
        "null",
      );
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
      const originalKey = await keyOf(context.client, operation);
      const hold = await context.holdNext();
      const pending = context.client.call("bookmarkCommand", [operation]);
      const rejected = assert.rejects(
        pending,
        (error) =>
          error instanceof Error &&
          (error as { status?: number }).status === 408 &&
          error.message === "身份已切换，旧响应已丢弃。",
      );
      try {
        await hold.reached();
        const committed = commands(await context.reads()).at(-1)!;
        assert.equal(committed.status, 200);
        assert.equal(context.sql().bookmarks.length, 1);
        assert.equal(context.sql().receipts.length, 1);
        await context.login(true);
        const switched = await context.client.snapshot("switched");
        assert.equal(switched!.principalId, otherBookmarkHuman.principalId);
        const otherKey = await keyOf(context.client, operation);
        assert.notEqual(otherKey, originalKey);
        await hold.release();
        await rejected;
        assert.equal(
          await context.client.control("sameSnapshot", "switched"),
          true,
          "late old response cannot publish over the new identity",
        );
        assert.equal(
          (await context.rows())[otherKey],
          undefined,
          "no pending record in another Human's scope",
        );
        assert.notEqual(
          (await context.rows())[originalKey],
          "null",
          "uncertain old receipt remains retryable",
        );
        assert.deepEqual(await context.client.call("bookmarkList", []), []);
        await context.login();
        assert.deepEqual(
          await context.client.call("bookmarkCommand", [operation]),
          committed.response,
        );
        const all = commands(await context.reads());
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
        assert.equal((await context.rows())[originalKey], "null");
      } finally {
        await hold.release();
        await rejected;
      }
    });
  },
);
