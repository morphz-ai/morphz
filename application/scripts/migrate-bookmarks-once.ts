import { randomUUID } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { backup, DatabaseSync } from "node:sqlite";
import { BrowserStore } from "../packages/browser/src/store.js";
import { stateSchema, type Workspace } from "../packages/core/src/model.js";
import { embeddedApplicationInstanceIds } from "../packages/application/src/embedded-application-identity.js";

type Bookmark = Workspace["bookmarks"][number];
const columns = [
  "tenant_id",
  "bookmark_id",
  "owner_principal_id",
  "title",
  "url",
  "revision",
  "created_at",
  "updated_at",
  "created_by_principal_id",
  "created_by_actant_id",
  "updated_by_principal_id",
  "updated_by_actant_id",
  "deleted_at",
] as const;

function values(tenantId: string, bookmark: Bookmark) {
  return [
    tenantId,
    bookmark.id,
    bookmark.ownerPrincipalId,
    bookmark.title,
    bookmark.url,
    bookmark.revision,
    bookmark.createdAt,
    bookmark.updatedAt,
    bookmark.createdBy.principalId,
    bookmark.createdBy.actantId,
    bookmark.updatedBy.principalId,
    bookmark.updatedBy.actantId,
    bookmark.deletedAt,
  ];
}

function exactRow(row: Record<string, unknown>, expected: unknown[]) {
  return columns.every((column, index) => row[column] === expected[index]);
}

/** Cold, one-time development cutover. It is not a runtime compatibility path.
 * A crash after the Browser commit but before clearing the old snapshot can be
 * retried: existing rows must match byte-for-byte or the migration aborts.
 */
export async function migrateBookmarksOnce(directory: string) {
  if (!isAbsolute(directory)) throw new Error("需要明确的绝对中心目录。");
  const workspaceFile = join(directory, "workspace.sqlite");
  const browserFile = join(directory, "browser.sqlite");
  if (!existsSync(workspaceFile)) throw new Error("旧工作区数据库不存在。");
  const source = new DatabaseSync(workspaceFile, { readOnly: true });
  let originalBody: string;
  let tenantId: string;
  let raw: Record<string, unknown>;
  let bookmarks: Bookmark[];
  let backupFile: string;
  try {
    originalBody = (
      source.prepare("SELECT body FROM workspace WHERE id=1").get() as {
        body: string;
      }
    ).body;
    tenantId = (
      source
        .prepare("SELECT identity FROM center_metadata WHERE id=1")
        .get() as {
        identity: string;
      }
    ).identity;
    raw = JSON.parse(originalBody) as Record<string, unknown>;
    bookmarks = stateSchema.parse(raw).bookmarks;
    if (!bookmarks.length) return { migrated: 0, backupFile: null };
    const runtimeState = source
      .prepare("SELECT body FROM runtime_state WHERE id=1")
      .get() as { body: string } | undefined;
    if (runtimeState) {
      const runtime = JSON.parse(runtimeState.body) as {
        deliveries?: { state?: string }[];
      };
      if (
        runtime.deliveries?.some((item) =>
          ["sending", "running"].includes(item.state ?? ""),
        )
      )
        throw new Error("仍有在途输入；先完成或停止执行，不迁移收藏。");
    }
    backupFile = join(
      directory,
      `workspace-before-bookmarks-${randomUUID()}.sqlite`,
    );
    await backup(source, backupFile);
    chmodSync(backupFile, 0o600);
  } finally {
    source.close();
  }

  // Establish the deployment identity before creating the first app-private
  // database. The Host completes the four-domain seal before publishing routes.
  embeddedApplicationInstanceIds(directory, tenantId);
  const browser = await BrowserStore.sqlite(browserFile);
  await browser.close();
  const target = new DatabaseSync(browserFile);
  try {
    target.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
    try {
      const read = target.prepare(
        `SELECT ${columns.join(",")} FROM bookmarks WHERE tenant_id=? AND bookmark_id=?`,
      );
      const insert = target.prepare(
        `INSERT INTO bookmarks(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
      );
      for (const bookmark of bookmarks) {
        const expected = values(tenantId, bookmark);
        const existing = read.get(tenantId, bookmark.id) as
          Record<string, unknown> | undefined;
        if (existing && !exactRow(existing, expected))
          throw new Error(`独立库中同 ID 收藏内容不同：${bookmark.id}`);
        if (!existing) insert.run(...expected);
      }
      target.exec("COMMIT");
    } catch (error) {
      target.exec("ROLLBACK");
      throw error;
    }
  } finally {
    target.close();
  }

  const verified = new DatabaseSync(browserFile, { readOnly: true });
  try {
    const read = verified.prepare(
      `SELECT ${columns.join(",")} FROM bookmarks WHERE tenant_id=? AND bookmark_id=?`,
    );
    for (const bookmark of bookmarks) {
      const row = read.get(tenantId, bookmark.id) as
        Record<string, unknown> | undefined;
      if (!row || !exactRow(row, values(tenantId, bookmark)))
        throw new Error("独立收藏库校验失败；旧收藏未清空。");
    }
  } finally {
    verified.close();
  }

  const old = new DatabaseSync(workspaceFile);
  try {
    old.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
    try {
      const current = old
        .prepare("SELECT body FROM workspace WHERE id=1")
        .get() as {
        body: string;
      };
      if (current.body !== originalBody)
        throw new Error(
          "迁入期间旧工作区发生了变化；保留两侧数据，拒绝清空旧收藏。",
        );
      const next = {
        ...raw,
        bookmarks: [],
        revision: Number(raw.revision) + 1,
      };
      stateSchema.parse(next);
      const result = old
        .prepare("UPDATE workspace SET body=? WHERE id=1 AND body=?")
        .run(JSON.stringify(next), originalBody);
      if (result.changes !== 1)
        throw new Error("旧工作区发生并发变化；保留旧收藏。");
      old.exec("COMMIT");
    } catch (error) {
      old.exec("ROLLBACK");
      throw error;
    }
  } finally {
    old.close();
  }
  return { migrated: bookmarks.length, backupFile };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const directory = process.argv[2];
  if (!directory || process.argv.length !== 3)
    throw new Error(
      "用法：tsx scripts/migrate-bookmarks-once.ts <已停止服务的中心绝对目录>",
    );
  const result = await migrateBookmarksOnce(directory);
  console.log(
    `已迁入 ${result.migrated} 条收藏；备份：${result.backupFile ?? "无"}`,
  );
}
