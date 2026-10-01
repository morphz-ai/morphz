import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { SqlQuery, SqlScalar } from "../../storage/src/sql.js";

type BackupTable = {
  name: string;
  columns: readonly string[];
  keys: readonly string[];
};

/** Fixed table and column allow-list. Backup data is never interpolated as SQL.
 * store_usage is derived and rebuilt on restore.
 */
export const backupTables: readonly BackupTable[] = [
  {
    name: "blobs",
    columns: ["sha256", "byte_length", "state", "verified_at"],
    keys: ["sha256"],
  },
  {
    name: "blob_chunks",
    columns: ["sha256", "ordinal", "chunk_sha256", "byte_length"],
    keys: ["sha256", "ordinal"],
  },
  {
    name: "artifacts",
    columns: [
      "artifact_id",
      "owner_tenant_id",
      "owner_principal_id",
      "head_revision",
      "created_at",
      "deleted_at",
    ],
    keys: ["artifact_id"],
  },
  {
    name: "artifact_versions",
    columns: [
      "artifact_id",
      "revision",
      "sha256",
      "mime",
      "byte_length",
      "created_at",
    ],
    keys: ["artifact_id", "revision"],
  },
  {
    name: "store_command_receipts",
    columns: [
      "command_id",
      "request_hash",
      "operation",
      "artifact_id",
      "revision",
      "sha256",
      "committed_at",
    ],
    keys: ["command_id"],
  },
];

export type BackupRow = Record<string, SqlScalar>;

export async function* snapshotRows(q: SqlQuery) {
  for (const table of backupTables) {
    let cursor: SqlScalar[] | undefined;
    for (;;) {
      const condition = cursor
        ? ` WHERE (${table.keys.join(",")}) > (${table.keys.map(() => "?").join(",")})`
        : "";
      const rows = await q.all<BackupRow>(
        `SELECT ${table.columns.join(",")} FROM ${table.name}${condition} ORDER BY ${table.keys.join(",")} LIMIT ?`,
        [...(cursor ?? []), 500],
      );
      if (!rows.length) break;
      for (const row of rows) yield { table, row };
      cursor = table.keys.map((key) => rows.at(-1)![key]!);
      if (rows.length < 500) break;
    }
  }
}

export function validateBackupRow(table: BackupTable, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Store 备份记录无效。");
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== table.columns.length ||
    table.columns.some(
      (column) =>
        !Object.hasOwn(row, column) ||
        (!["string", "number"].includes(typeof row[column]) &&
          row[column] !== null),
    )
  )
    throw new Error("Store 备份字段与存储模型不一致。");
  if (table.keys.some((key) => row[key] === null || row[key] === undefined))
    throw new Error("Store 备份主键无效。");
  return row as BackupRow;
}

export function insertBackupSql(table: BackupTable) {
  return `INSERT INTO ${table.name}(${table.columns.join(",")}) VALUES(${table.columns.map(() => "?").join(",")})`;
}

/** Read a private NDJSON manifest without loading the whole Store into RAM. */
export async function readBackupRows(
  path: string,
  onRow: (table: BackupTable, row: BackupRow) => Promise<void>,
) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash("sha256");
  let pending = Buffer.alloc(0);
  let count = 0;
  let lastTable = 0;
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Store 备份 manifest 不是普通文件。");
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const newline = pending.indexOf(10);
        if (newline < 0) break;
        const line = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        if (!line.length || line.length > 1024 * 1024)
          throw new Error("Store 备份记录长度无效。");
        const parsed = JSON.parse(line.toString("utf8")) as {
          table?: unknown;
          row?: unknown;
        };
        const index = backupTables.findIndex(
          (table) => table.name === parsed.table,
        );
        if (index < lastTable || index < 0)
          throw new Error("Store 备份表顺序无效。");
        lastTable = index;
        const table = backupTables[index]!;
        await onRow(table, validateBackupRow(table, parsed.row));
        count++;
      }
      if (pending.length > 1024 * 1024)
        throw new Error("Store 备份记录长度无效。");
    }
    if (pending.length) throw new Error("Store 备份 manifest 未完整结束。");
    return { sha256: hash.digest("hex"), rows: count };
  } finally {
    await file.close();
  }
}

/** Copy bytes using no-follow file handles and verify the recorded digest. */
export async function copyVerifiedBlob(
  sourcePath: string,
  destinationPath: string,
  expectedSha: string,
  expectedLength: number,
) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha))
    throw new Error("Store 备份 Blob 摘要无效。");
  if (!Number.isSafeInteger(expectedLength) || expectedLength < 0)
    throw new Error("Store 备份 Blob 长度无效。");
  await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
  const source = await open(
    sourcePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let destination;
  let complete = false;
  const chunkBytes = Buffer.allocUnsafe(1024 * 1024);
  let chunkFill = 0;
  const chunks: { sha256: string; byteLength: number }[] = [];
  const finishChunk = () => {
    if (!chunkFill) return;
    chunks.push({
      sha256: createHash("sha256")
        .update(chunkBytes.subarray(0, chunkFill))
        .digest("hex"),
      byteLength: chunkFill,
    });
    chunkFill = 0;
  };
  try {
    const stat = await source.stat();
    if (!stat.isFile() || stat.size !== expectedLength)
      throw new Error("Store 备份源字节缺失或长度损坏。");
    destination = await open(
      destinationPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of source.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      size += chunk.length;
      let cursor = 0;
      while (cursor < chunk.length) {
        const take = Math.min(
          chunkBytes.length - chunkFill,
          chunk.length - cursor,
        );
        chunkBytes.set(chunk.subarray(cursor, cursor + take), chunkFill);
        chunkFill += take;
        cursor += take;
        if (chunkFill === chunkBytes.length) finishChunk();
      }
      await destination.writeFile(chunk);
    }
    finishChunk();
    if (size !== expectedLength || hash.digest("hex") !== expectedSha)
      throw new Error("Store 备份源字节摘要损坏。");
    await destination.sync();
    complete = true;
  } finally {
    await destination?.close();
    await source.close();
    if (!complete && destination)
      await unlink(destinationPath).catch(() => undefined);
  }
  return chunks;
}
