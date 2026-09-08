import { DatabaseSync, backup } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { dataDirectory } from "../dist/service/apps/service/src/paths.js";

// SQLite's backup API includes committed WAL data; never copy a live .sqlite alone.
const directory = dataDirectory();
const source = join(directory, "workspace.sqlite");
if (!existsSync(source)) throw new Error("中心数据库不存在，未创建备份。");
const destination = join(directory, "backups");
mkdirSync(destination, { recursive: true, mode: 0o700 });
const filename = join(
  destination,
  `workspace-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.sqlite`,
);
const database = new DatabaseSync(source, { readOnly: true });
try {
  if (
    !database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='workspace'",
      )
      .get()
  )
    throw new Error("指定数据库不是 MorphzWork 中心，未创建备份。");
  await backup(database, filename);
  chmodSync(filename, 0o600);
  console.log(`中心数据库备份完成：${filename}`);
} finally {
  database.close();
}
