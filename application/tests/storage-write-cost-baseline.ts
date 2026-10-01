/** Opt-in SQL/WAL write-cost evidence, not *.test.ts or physical-device I/O.
 * MORPHZ_TEST_POSTGRES_URL=... npx tsx tests/storage-write-cost-baseline.ts
 * --backends sqlite,postgres
 * Real Human Application writes; tiny isolated stores, no model/HTTP server.
 * SQL observers are test-process-only and restored even on failed workloads.
 */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { Client, Pool, type QueryResult } from "pg";
import { Application } from "../packages/application/src/application.js";
import { emptyInteractive } from "../packages/core/src/interactive.js";
import { localAccess } from "../packages/core/src/model.js";
import { ObjectsConflictError } from "../packages/objects/src/store.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";

const { values } = parseArgs({
  options: {
    backends: { type: "string", default: "sqlite,postgres" },
    "pg-waldump": { type: "string", default: "pg_waldump" },
  },
  strict: true,
});
const backends = values.backends!.split(",");
assert.ok(backends.length && new Set(backends).size === backends.length);
assert.ok(backends.every((value) => ["sqlite", "postgres"].includes(value)));
const postgresUrl = process.env.MORPHZ_TEST_POSTGRES_URL;
if (backends.includes("postgres") && !postgresUrl)
  throw new Error("Actual PostgreSQL URL required; no simulated backend/skip.");
const print = (type: string, value: object) =>
  process.stdout.write(JSON.stringify({ type, ...value }) + "\n");
const utf8 = (value: unknown): number => {
  assert.ok(
    value === null || ["string", "number", "boolean"].includes(typeof value),
  );
  return value === null ? 0 : Buffer.byteLength(String(value), "utf8");
};
type Cost = {
  operation: string;
  dmlCalls: number;
  failedDmlCalls: number;
  directAffectedRows: number;
  submittedDmlBindingBytes: number;
  successfulDmlBindingBytes: number;
  commits: number;
  writeCommits: number;
  rollbacks: number;
  committedDirectRows: number;
  committedDmlBindingBytes: number;
  rolledBackDirectRows: number;
  groups: Record<string, { calls: number; rows: number; bindingBytes: number }>;
  sqliteWalTransactions: Record<string, unknown>[];
  postgresTransactionIds: string[];
};
const operation = new AsyncLocalStorage<Cost>();
const cost = (name: string): Cost => ({
  operation: name,
  dmlCalls: 0,
  failedDmlCalls: 0,
  directAffectedRows: 0,
  submittedDmlBindingBytes: 0,
  successfulDmlBindingBytes: 0,
  commits: 0,
  writeCommits: 0,
  rollbacks: 0,
  committedDirectRows: 0,
  committedDmlBindingBytes: 0,
  rolledBackDirectRows: 0,
  groups: {},
  sqliteWalTransactions: [],
  postgresTransactionIds: [],
});

/** SQLite's WAL checksum is over 32-bit words, not stat(file).size. Only the
 * consecutive salt/checksum-valid prefix counts; stale allocated tails do not.
 */
function sqliteWal(path: string) {
  if (!existsSync(path) || statSync(path).size === 0) return null;
  const buffer = readFileSync(path);
  assert.ok(buffer.length >= 32);
  const magic = buffer.readUInt32BE(0);
  assert.ok(magic === 0x377f0682 || magic === 0x377f0683);
  const word = (b: Buffer, i: number) =>
    magic === 0x377f0682 ? b.readUInt32LE(i) : b.readUInt32BE(i);
  let c0 = 0,
    c1 = 0;
  function checksum(b: Buffer) {
    assert.equal(b.length % 8, 0);
    for (let i = 0; i < b.length; i += 8) {
      c0 = (c0 + word(b, i) + c1) >>> 0;
      c1 = (c1 + word(b, i + 4) + c0) >>> 0;
    }
  }
  checksum(buffer.subarray(0, 24));
  assert.equal(c0, buffer.readUInt32BE(24));
  assert.equal(c1, buffer.readUInt32BE(28));
  const pageSize = buffer.readUInt32BE(8),
    salt = buffer.subarray(16, 24).toString("hex");
  assert.ok(
    pageSize >= 512 && pageSize <= 65536 && (pageSize & (pageSize - 1)) === 0,
  );
  let frames = 0,
    committedFrames = 0;
  for (
    let offset = 32;
    offset + 24 + pageSize <= buffer.length;
    offset += 24 + pageSize
  ) {
    if (buffer.subarray(offset + 8, offset + 16).toString("hex") !== salt)
      break;
    checksum(buffer.subarray(offset, offset + 8));
    checksum(buffer.subarray(offset + 24, offset + 24 + pageSize));
    if (
      c0 !== buffer.readUInt32BE(offset + 16) ||
      c1 !== buffer.readUInt32BE(offset + 20)
    )
      break;
    frames++;
    if (buffer.readUInt32BE(offset + 4) !== 0) committedFrames = frames;
  }
  return { pageSize, salt, frames, committedFrames };
}
function sqliteWalDelta(
  before: ReturnType<typeof sqliteWal>,
  after: ReturnType<typeof sqliteWal>,
  committed: boolean,
) {
  if (!after)
    return before
      ? {
          measured: false,
          reason:
            "WAL disappeared/truncated during transaction; generated bytes cannot be inferred",
        }
      : {
          measured: true,
          frames: 0,
          walBytes: 0,
          headerBytes: 0,
          reset: false,
        };
  const reset = !before || before.salt !== after.salt;
  if (
    !reset &&
    (before!.pageSize !== after.pageSize ||
      after.committedFrames < before!.committedFrames)
  )
    return {
      measured: false,
      reason: "WAL page size/commit prefix changed unexpectedly",
    };
  // Rollback spill is attributable only with a clean pre-transaction tail.
  if (!committed && before && before.frames !== before.committedFrames)
    return {
      measured: false,
      reason:
        "Pre-existing uncommitted WAL tail prevents rollback-spill attribution",
    };
  const end = committed ? after.committedFrames : after.frames;
  const frames = end - (reset ? 0 : before!.committedFrames);
  assert.ok(frames >= 0);
  return {
    measured: true,
    frames,
    pageSize: after.pageSize,
    headerBytes: reset ? 32 : 0,
    walBytes: frames * (after.pageSize + 24) + (reset ? 32 : 0),
    reset,
  };
}

/** The global LSN span is only a read bound. Attribution uses actual XIDs
 * captured on each connection before COMMIT/ROLLBACK, never the span size.
 */
function postgresWal(
  path: string,
  start: string,
  end: string,
  ids: string[],
  ownedRelations: Set<string>,
  negativeControl?: { prefix: string; emittedLsn: string },
) {
  if (start === end) {
    assert.equal(
      negativeControl,
      undefined,
      "Noise control must grow WAL span",
    );
    return {
      measured: true,
      records: 0,
      recordBytes: 0,
      fullPageImageBytes: 0,
      totalRecordBytes: 0,
      backgroundRecordsExcluded: 0,
      unattributedOwnedRelationRecords: 0,
      transactionIds: ids,
      start,
      end,
    };
  }
  const text = execFileSync(
    values["pg-waldump"]!,
    ["--path", path, "--start", start, "--end", end, "--bkp-details"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const transactions = new Set(ids);
  let records = 0,
    recordBytes = 0,
    fullPageImageBytes = 0,
    backgroundRecordsExcluded = 0,
    backgroundRecordBytesExcluded = 0,
    controlRecordsExcluded = 0,
    controlRecordBytesExcluded = 0,
    unattributedOwnedRelationRecords = 0;
  const managers: Record<string, number> = {};
  const entries = text
    .trim()
    .split(/\n(?=rmgr:)/)
    .filter(Boolean);
  for (const entry of entries) {
    const match = entry.match(
      /^rmgr:\s+(.+?)\s+len \(rec\/tot\):\s*(\d+)\/\s*(\d+),\s+tx:\s*(\d+),/,
    );
    assert.ok(
      match,
      "Unrecognized pg_waldump record; do not invent WAL totals",
    );
    if (!transactions.has(match[4]!)) {
      backgroundRecordsExcluded++;
      backgroundRecordBytesExcluded += Number(match[3]);
      if (negativeControl && entry.includes(negativeControl.prefix)) {
        assert.equal(match[1]!.trim(), "LogicalMessage");
        assert.equal(match[4], "0", "Nontransactional control must have xid 0");
        controlRecordsExcluded++;
        controlRecordBytesExcluded += Number(match[3]);
      }
      if (
        [...entry.matchAll(/\brel\s+(\d+\/\d+\/\d+)\b/g)].some((relation) =>
          ownedRelations.has(relation[1]!),
        )
      )
        unattributedOwnedRelationRecords++;
      continue;
    }
    const main = Number(match[2]),
      total = Number(match[3]);
    assert.ok(total >= main);
    records++;
    recordBytes += main;
    fullPageImageBytes += total - main;
    const manager = match[1]!.trim();
    managers[manager] = (managers[manager] ?? 0) + 1;
  }
  if (negativeControl) {
    assert.equal(controlRecordsExcluded, 1);
    assert.ok(controlRecordBytesExcluded > 0);
  }
  return {
    measured: unattributedOwnedRelationRecords === 0,
    records,
    recordBytes,
    fullPageImageBytes,
    totalRecordBytes: recordBytes + fullPageImageBytes,
    backgroundRecordsExcluded,
    backgroundRecordBytesExcluded,
    unattributedOwnedRelationRecords,
    managers,
    transactionIds: [...transactions],
    start,
    end,
    ...(negativeControl
      ? {
          negativeControl: {
            ...negativeControl,
            kind: "Independent nontransactional xid-0 LogicalMessage; not business seed",
            excludedRecords: controlRecordsExcluded,
            excludedRecordBytes: controlRecordBytesExcluded,
          },
        }
      : {}),
  };
}

function observeSql(directory: string) {
  const prepare = DatabaseSync.prototype.prepare,
    exec = DatabaseSync.prototype.exec;
  const queryDescriptor = Object.getOwnPropertyDescriptor(
    Client.prototype,
    "query",
  )!;
  const probe = new DatabaseSync(":memory:");
  const statementPrototype = Object.getPrototypeOf(probe.prepare("SELECT 1"));
  probe.close();
  const runDescriptor = Object.getOwnPropertyDescriptor(
    statementPrototype,
    "run",
  )!;
  const readDescriptors = ["all", "get"].map((method) => ({
    method,
    descriptor: Object.getOwnPropertyDescriptor(statementPrototype, method)!,
  }));
  const statements = new WeakMap<
    object,
    { database: DatabaseSync; sql: string }
  >();
  const transactions = new Map<
    object,
    {
      owner: Cost;
      write: boolean;
      rows: number;
      bytes: number;
      walBefore?: ReturnType<typeof sqliteWal>;
    }
  >();
  const dml = (sql: string) =>
    sql.trim().match(/^(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_]+)/i);
  function submitted(sql: string, bindings: unknown[]) {
    const owner = operation.getStore(),
      matched = dml(sql);
    if (owner && /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql))
      assert.ok(matched, "Unrecognized DML; measurement must not omit it");
    if (!owner || !matched) return;
    const bytes = bindings.reduce<number>(
      (total, value) => total + utf8(value),
      0,
    );
    owner.dmlCalls++;
    owner.submittedDmlBindingBytes += bytes;
    return {
      owner,
      bytes,
      group: `${matched[1]!.toUpperCase()}:${matched[2]}`,
    };
  }
  function success(
    connection: object,
    item: NonNullable<ReturnType<typeof submitted>>,
    rows: number,
  ) {
    assert.ok(Number.isSafeInteger(rows) && rows >= 0);
    const { owner, bytes, group } = item;
    owner.directAffectedRows += rows;
    owner.successfulDmlBindingBytes += bytes;
    const aggregate = (owner.groups[group] ??= {
      calls: 0,
      rows: 0,
      bindingBytes: 0,
    });
    aggregate.calls++;
    aggregate.rows += rows;
    aggregate.bindingBytes += bytes;
    const transaction = transactions.get(connection);
    if (transaction) {
      assert.equal(
        transaction.owner,
        owner,
        "Transaction crossed operation attribution",
      );
      transaction.rows += rows;
      transaction.bytes += bytes;
    } else {
      owner.committedDirectRows += rows;
      owner.committedDmlBindingBytes += bytes;
    }
  }
  function boundary(connection: object, sql: string, sqlite: boolean) {
    const owner = operation.getStore();
    if (!owner) return;
    const command = sql.trim().toUpperCase();
    if (/^BEGIN(?:\s|$)/.test(command)) {
      assert.equal(transactions.has(connection), false);
      transactions.set(connection, {
        owner,
        write: sqlite
          ? command.includes("IMMEDIATE")
          : !command.includes("READ ONLY"),
        rows: 0,
        bytes: 0,
        ...(sqlite && command.includes("IMMEDIATE")
          ? {
              walBefore: sqliteWal(
                (connection as DatabaseSync).location("main")! + "-wal",
              ),
            }
          : {}),
      });
    } else if (/^(COMMIT|ROLLBACK)(?:\s|$)/.test(command)) {
      const transaction = transactions.get(connection);
      assert.ok(transaction, "Unobserved transaction boundary");
      assert.equal(transaction.owner, owner);
      if (sqlite && transaction.write) {
        const path = (connection as DatabaseSync).location("main")!;
        assert.ok(
          path.startsWith(realpathSync(directory) + "/"),
          "WAL probe escaped generated fixture",
        );
        owner.sqliteWalTransactions.push({
          database: path.split("/").at(-1),
          outcome: command.startsWith("COMMIT") ? "commit" : "rollback",
          directAffectedRows: transaction.rows,
          ...sqliteWalDelta(
            transaction.walBefore ?? null,
            sqliteWal(path + "-wal"),
            command.startsWith("COMMIT"),
          ),
        });
      }
      transactions.delete(connection);
      if (command.startsWith("COMMIT")) {
        owner.commits++;
        if (transaction.write) owner.writeCommits++;
        owner.committedDirectRows += transaction.rows;
        owner.committedDmlBindingBytes += transaction.bytes;
      } else {
        owner.rollbacks++;
        owner.rolledBackDirectRows += transaction.rows;
      }
    }
  }
  DatabaseSync.prototype.prepare = function (sql: string) {
    const statement = Reflect.apply(prepare, this, [sql]);
    statements.set(statement, { database: this, sql });
    return statement;
  };
  DatabaseSync.prototype.exec = function (sql: string) {
    const result = Reflect.apply(exec, this, [sql]);
    if (operation.getStore()) {
      assert.ok(
        !dml(sql),
        "Unexpected direct exec DML; measurement must not omit it",
      );
      boundary(this, sql, true);
    }
    return result;
  };
  Object.defineProperty(statementPrototype, "run", {
    ...runDescriptor,
    value: function (...bindings: unknown[]) {
      const info = statements.get(this),
        item = info && submitted(info.sql, bindings);
      try {
        const result = Reflect.apply(runDescriptor.value, this, bindings);
        if (item)
          success(
            info!.database,
            item,
            Number((result as { changes: number | bigint }).changes),
          );
        return result;
      } catch (error) {
        if (item) item.owner.failedDmlCalls++;
        throw error;
      }
    },
  });
  for (const { method, descriptor } of readDescriptors)
    Object.defineProperty(statementPrototype, method, {
      ...descriptor,
      value: function (...bindings: unknown[]) {
        const info = statements.get(this);
        if (operation.getStore() && info)
          assert.ok(
            !/^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(info.sql),
            "Unexpected SQLite read-method DML; do not omit it",
          );
        return Reflect.apply(descriptor.value, this, bindings);
      },
    });
  Object.defineProperty(Client.prototype, "query", {
    ...queryDescriptor,
    value: function (this: Client, ...args: unknown[]) {
      const owner = operation.getStore();
      if (!owner) return Reflect.apply(queryDescriptor.value, this, args);
      assert.equal(
        typeof args[0],
        "string",
        "Unexpected PG query form; do not undercount",
      );
      const sql = args[0] as string,
        bindings = (args[1] ?? []) as unknown[];
      assert.ok(Array.isArray(bindings));
      const item = submitted(sql, bindings);
      // This read does not assign an XID or alter the production transaction.
      // Capture before COMMIT/ROLLBACK while the exact connection owns it.
      const finishing = /^(COMMIT|ROLLBACK)\s*;?\s*$/i.test(sql.trim());
      const id = finishing
        ? (Reflect.apply(queryDescriptor.value, this, [
            "SELECT txid_current_if_assigned()::text AS xid",
          ]) as Promise<QueryResult<{ xid: string | null }>>)
        : undefined;
      const result = id
        ? id.then((value) => {
            const xid = value.rows[0]!.xid;
            if (xid !== null)
              owner.postgresTransactionIds.push(
                String(BigInt(xid) % 4294967296n),
              );
            return Reflect.apply(
              queryDescriptor.value,
              this,
              args,
            ) as Promise<QueryResult>;
          })
        : (Reflect.apply(
            queryDescriptor.value,
            this,
            args,
          ) as Promise<QueryResult>);
      assert.ok(
        result && typeof result.then === "function",
        "Callback PG queries are not measured",
      );
      return result.then(
        (value) => {
          if (item) {
            assert.ok(["INSERT", "UPDATE", "DELETE"].includes(value.command));
            success(this, item, value.rowCount ?? 0);
          } else {
            assert.ok(
              !["INSERT", "UPDATE", "DELETE"].includes(value.command),
              "Unrecognized SQL DML",
            );
          }
          boundary(this, sql, false);
          return value;
        },
        (error: unknown) => {
          if (item) item.owner.failedDmlCalls++;
          throw error;
        },
      );
    },
  });
  return {
    assertSettled() {
      assert.equal(
        transactions.size,
        0,
        "Every measured transaction must settle",
      );
    },
    restore() {
      DatabaseSync.prototype.prepare = prepare;
      DatabaseSync.prototype.exec = exec;
      Object.defineProperty(statementPrototype, "run", runDescriptor);
      for (const { method, descriptor } of readDescriptors) {
        Object.defineProperty(statementPrototype, method, descriptor);
        assert.equal(statementPrototype[method], descriptor.value);
      }
      Object.defineProperty(Client.prototype, "query", queryDescriptor);
      assert.equal(DatabaseSync.prototype.prepare, prepare);
      assert.equal(DatabaseSync.prototype.exec, exec);
      assert.equal(statementPrototype.run, runDescriptor.value);
      assert.equal(Client.prototype.query, queryDescriptor.value);
    },
  };
}

const countedTables = [
  "objects",
  "object_versions",
  "object_command_receipts",
  "object_outbox",
  "interactive_versions",
  "interactive_columns",
  "interactive_row_versions",
  "interactive_cells",
  "interactive_version_rows",
] as const;
function fileBytes(directory: string): number {
  return readdirSync(directory, { withFileTypes: true }).reduce(
    (total, entry) => {
      const path = join(directory, entry.name);
      return (
        total +
        (entry.isDirectory()
          ? fileBytes(path)
          : entry.isFile()
            ? statSync(path).size
            : 0)
      );
    },
    0,
  );
}

for (const backend of backends) {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  const schemas = {
    platform: `write_p_${suffix}`,
    objects: `write_o_${suffix}`,
    scriptStudio: `write_s_${suffix}`,
    reader: `write_r_${suffix}`,
    browser: `write_b_${suffix}`,
  };
  const admin =
    backend === "postgres"
      ? new Pool({ connectionString: postgresUrl })
      : undefined;
  let f: Awaited<ReturnType<typeof agentDomainFixture>> | undefined;
  let observer: ReturnType<typeof observeSql> | undefined;
  try {
    if (admin)
      for (const schema of Object.values(schemas))
        await admin.query(`CREATE SCHEMA "${schema}"`);
    f = await agentDomainFixture(
      admin
        ? {
            storage: {
              platform: {
                kind: "postgres",
                connectionString: postgresUrl!,
                schema: schemas.platform,
              },
              applications: {
                deploymentId: suffix,
                connectionStrings: {
                  objects: postgresUrl!,
                  scriptStudio: postgresUrl!,
                  reader: postgresUrl!,
                  browser: postgresUrl!,
                },
                schemas: {
                  objects: schemas.objects,
                  scriptStudio: schemas.scriptStudio,
                  reader: schemas.reader,
                  browser: schemas.browser,
                },
              },
            },
          }
        : {},
    );
    const host = f;
    const pgWal = admin
      ? (
          await admin.query<{ path: string; version: string }>(
            "SELECT current_setting('data_directory') AS path,current_setting('server_version') AS version",
          )
        ).rows[0]!
      : undefined;
    const ownedRelations = new Set<string>();
    if (admin) {
      const version = execFileSync(values["pg-waldump"]!, ["--version"], {
        encoding: "utf8",
      }).trim();
      assert.equal(
        version.match(/PostgreSQL\) (\d+)/)?.[1],
        pgWal!.version.match(/^(\d+)/)?.[1],
        "pg_waldump/server major versions must match",
      );
      const relationRows = (
        await admin.query<{ locator: string }>(
          `WITH roots AS (SELECT c.oid,c.reltoastrelid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[])), owned AS (SELECT oid FROM roots UNION SELECT reltoastrelid FROM roots WHERE reltoastrelid<>0 UNION SELECT i.indexrelid FROM pg_index i WHERE i.indrelid IN (SELECT reltoastrelid FROM roots WHERE reltoastrelid<>0)) SELECT coalesce(nullif(c.reltablespace,0),d.dattablespace)::text||'/'||d.oid::text||'/'||pg_relation_filenode(c.oid)::text AS locator FROM pg_class c JOIN owned o ON o.oid=c.oid CROSS JOIN pg_database d WHERE d.datname=current_database() AND pg_relation_filenode(c.oid) IS NOT NULL`,
          [Object.values(schemas)],
        )
      ).rows;
      for (const row of relationRows) ownedRelations.add(row.locator);
      assert.ok(ownedRelations.size > 0);
      print("postgres_wal_tool", {
        version,
        exactRelationLocators: ownedRelations.size,
      });
    }
    const session = () =>
      new Application(host.transport, {
        platformWork: host.domains.work,
        platformDocuments: host.domains.content,
      }).session(localAccess);
    async function rows(sql: string) {
      if (admin)
        return (
          await admin.query(sql.replaceAll("APP.", `"${schemas.objects}".`))
        ).rows as Record<string, unknown>[];
      const database = new DatabaseSync(
        join(host.directory, "objects.sqlite"),
        { readOnly: true },
      );
      try {
        return database.prepare(sql.replaceAll("APP.", "")).all() as Record<
          string,
          unknown
        >[];
      } finally {
        database.close();
      }
    }
    async function snapshot() {
      const counts: Record<string, number> = {};
      for (const table of countedTables)
        counts[table] = Number(
          (await rows(`SELECT COUNT(*) AS n FROM APP.${table}`))[0]!.n,
        );
      const versions = await rows(
        "SELECT object_id,revision,title,payload_body FROM APP.object_versions ORDER BY object_id,revision",
      );
      const cells = await rows(
        "SELECT text_value,number_value,boolean_value FROM APP.interactive_cells",
      );
      const originalValueBytes =
        versions.reduce((n, row) => n + utf8(row.payload_body), 0) +
        cells.reduce(
          (n, row) =>
            n +
            utf8(row.text_value) +
            utf8(row.number_value) +
            utf8(row.boolean_value),
          0,
        );
      const relationAndIndexBytes = admin
        ? Number(
            (
              await admin.query(
                "SELECT coalesce(sum(pg_total_relation_size(c.oid)),0)::text AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[]) AND c.relkind IN ('r','m')",
                [Object.values(schemas)],
              )
            ).rows[0].n,
          )
        : 0;
      return {
        counts,
        originalValueBytes,
        immutableVersions: versions.map((row) => ({
          objectId: row.object_id,
          revision: Number(row.revision),
          sha256: createHash("sha256")
            .update(JSON.stringify(row))
            .digest("hex"),
        })),
        allocated: {
          localFileBytes: fileBytes(host.directory),
          postgresRelationAndIndexBytes: relationAndIndexBytes,
        },
      };
    }
    observer = observeSql(host.directory);
    async function measured<T>(
      name: string,
      work: () => Promise<T>,
      noNewVersion = false,
    ) {
      const before = await snapshot(),
        stats = cost(name),
        started = performance.now();
      const walStart = admin
        ? (
            await admin.query<{ lsn: string }>(
              "SELECT pg_current_wal_insert_lsn()::text AS lsn",
            )
          ).rows[0]!.lsn
        : undefined;
      const value = await operation.run(stats, work);
      const apiElapsedMs = performance.now() - started;
      observer!.assertSettled();
      let negativeControl: { prefix: string; emittedLsn: string } | undefined;
      if (admin && name === "document.create.replay") {
        const prefix = `morphz-write-cost-noise-${randomUUID()}`;
        // This separate admin connection inserts no business rows/schema.
        // Emit outside ALS attribution but inside the global decoding span.
        const message = await admin.query<{ lsn: string }>(
          "SELECT pg_logical_emit_message(false,$1,$2)::text AS lsn",
          [prefix, "Independent WAL noise: exclude from exact operation XIDs"],
        );
        negativeControl = { prefix, emittedLsn: message.rows[0]!.lsn };
      }
      const walEnd = admin
        ? (
            await admin.query<{ lsn: string }>(
              "SELECT pg_current_wal_insert_lsn()::text AS lsn",
            )
          ).rows[0]!.lsn
        : undefined;
      let postgresWalCost: ReturnType<typeof postgresWal> | undefined;
      if (admin) {
        // A successful synchronous commit flushes its own records. The global
        // tail may include another transaction still in a WAL buffer; wait only
        // for our bounded read interval to be present, without forcing a flush.
        let written = false;
        for (let attempt = 0; attempt < 20; attempt++) {
          written = (
            await admin.query<{ ready: boolean }>(
              "SELECT pg_current_wal_lsn() >= $1::pg_lsn AS ready",
              [walEnd],
            )
          ).rows[0]!.ready;
          if (written) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.ok(
          written,
          "WAL window is not yet readable; never report buffered WAL as zero",
        );
        postgresWalCost = postgresWal(
          pgWal!.path,
          walStart!,
          walEnd!,
          stats.postgresTransactionIds,
          ownedRelations,
          negativeControl,
        );
        assert.equal(
          postgresWalCost.unattributedOwnedRelationRecords,
          0,
          "Some private-domain WAL cannot be attributed to captured XIDs",
        );
        if (negativeControl) {
          assert.notEqual(walStart, walEnd);
          assert.deepEqual(stats.postgresTransactionIds, []);
          assert.equal(postgresWalCost.totalRecordBytes, 0);
          assert.ok(postgresWalCost.backgroundRecordsExcluded >= 1);
        }
      }
      const after = await snapshot();
      for (const version of before.immutableVersions)
        assert.deepEqual(
          after.immutableVersions.find(
            (row) =>
              row.objectId === version.objectId &&
              row.revision === version.revision,
          ),
          version,
          "A write changed or removed an existing immutable original",
        );
      if (noNewVersion) {
        assert.deepEqual(after.counts, before.counts);
        assert.equal(after.originalValueBytes, before.originalValueBytes);
        assert.equal(stats.committedDirectRows, 0);
      }
      assert.ok(
        stats.commits > 0,
        "The SQL observer must see real transactions",
      );
      if (name === "document.stale-cas") assert.equal(stats.rollbacks, 1);
      if (name === "table.patch-one-row") {
        for (const [table, delta] of [
          ["interactive_row_versions", 1],
          ["interactive_cells", 3],
          ["interactive_version_rows", 10],
        ] as const)
          assert.equal(after.counts[table]! - before.counts[table]!, delta);
      }
      const increment = after.originalValueBytes - before.originalValueBytes;
      const sqliteWalMeasured = stats.sqliteWalTransactions.every(
        (sample) => sample.measured === true,
      );
      if (backend === "sqlite") {
        assert.equal(
          stats.sqliteWalTransactions.reduce(
            (rows, sample) => rows + Number(sample.directAffectedRows),
            0,
          ),
          stats.committedDirectRows + stats.rolledBackDirectRows,
          "Every directly changed row must have an observed WAL transaction",
        );
        assert.ok(
          sqliteWalMeasured,
          "One WAL transaction window is not attributable; do not report zero",
        );
      }
      const walBytes =
        backend === "sqlite"
          ? sqliteWalMeasured
            ? stats.sqliteWalTransactions.reduce(
                (bytes, sample) => bytes + Number(sample.walBytes),
                0,
              )
            : null
          : postgresWalCost?.measured
            ? postgresWalCost.totalRecordBytes
            : null;
      print("write_cost", {
        backend,
        apiElapsedMs,
        ...stats,
        ...(postgresWalCost ? { postgresWal: postgresWalCost } : {}),
        durableRowDelta: Object.fromEntries(
          countedTables.map((table) => [
            table,
            after.counts[table]! - before.counts[table]!,
          ]),
        ),
        durableOriginalValueByteDelta: increment,
        committedDmlBindingsPerNewOriginalValueByte:
          increment > 0 ? stats.committedDmlBindingBytes / increment : null,
        engineWal: {
          measured: walBytes !== null,
          bytes: walBytes,
          bytesPerNewOriginalValueByte:
            walBytes !== null && increment > 0 ? walBytes / increment : null,
          representation:
            backend === "sqlite"
              ? "Salt/checksum-valid transaction WAL frames incl. frame headers and rewritten WAL header, excluding checkpoints to main db"
              : "Actual captured-XID WAL records incl. FPI and COMMIT/ABORT, excluding WAL page headers/alignment/segment allocation",
        },
        allocated: { before: before.allocated, after: after.allocated },
      });
      return value;
    }
    const markdown = "# 正式写成本\n\n" + "精确原件与不可变历史。".repeat(64);
    const create = {
      commandId: randomUUID(),
      objectId: randomUUID(),
      projectId: host.projectId,
      title: "写成本文档",
      markdown,
    };
    const doc = await measured("document.create", () =>
      session().createPlatformDocument(create),
    );
    assert.deepEqual(
      await measured(
        "document.create.replay",
        () => session().createPlatformDocument(create),
        true,
      ),
      doc,
    );
    const revise = {
      commandId: randomUUID(),
      contentId: doc.contentId,
      expectedRevision: 1,
      title: "写成本文档",
      markdown: markdown + "\n修订第二版",
    };
    const updated = await measured("document.revise", () =>
      session().revisePlatformDocument(revise),
    );
    assert.equal(updated.versionRef, "2");
    assert.deepEqual(
      await measured(
        "document.revise.replay",
        () => session().revisePlatformDocument(revise),
        true,
      ),
      updated,
    );
    await measured(
      "document.stale-cas",
      async () => {
        await assert.rejects(
          session().revisePlatformDocument({
            ...revise,
            commandId: randomUUID(),
            markdown: "不应保存",
          }),
          (error: unknown) =>
            error instanceof ObjectsConflictError ||
            (error instanceof Error &&
              "code" in error &&
              error.code === "conflict"),
        );
      },
      true,
    );
    const table = await measured("table.create", () =>
      session().createPlatformInteractive({
        commandId: randomUUID(),
        objectId: randomUUID(),
        projectId: host.projectId,
        title: "单行写成本",
        content: {
          ...emptyInteractive,
          rows: Array.from({ length: 10 }, (_, index) => ({
            id: `r${index}`,
            cells: { name: `记录${index}`, value: index, done: false },
          })),
        },
      }),
    );
    const patch = {
      commandId: randomUUID(),
      contentId: table.contentId,
      expectedRevision: 1,
      operations: [
        { type: "update", rowId: "r5", cells: { name: "仅一行修改" } },
      ],
    };
    const patched = await measured("table.patch-one-row", () =>
      session().patchPlatformInteractiveRows(patch),
    );
    assert.equal(patched.versionRef, "2");
    assert.deepEqual(
      await measured(
        "table.patch.replay",
        () => session().patchPlatformInteractiveRows(patch),
        true,
      ),
      patched,
    );
    await host.reopen();
    const old = await session().readPlatformDocument({
      contentId: doc.contentId,
      revision: 1,
    });
    assert.equal(old.markdown, markdown);
    assert.equal(old.headRevision, 2);
    const current = await session().readPlatformDocument({
      contentId: doc.contentId,
      revision: 2,
    });
    assert.equal(current.markdown, revise.markdown);
    const originalRows = await session().queryPlatformInteractiveRows({
      contentId: table.contentId,
      revision: 1,
      limit: 10,
    });
    const revisedRows = await session().queryPlatformInteractiveRows({
      contentId: table.contentId,
      revision: 2,
      limit: 10,
    });
    assert.equal(originalRows.rows[5]!.cells.name, "记录5");
    assert.equal(revisedRows.rows[5]!.cells.name, "仅一行修改");
    assert.deepEqual(
      revisedRows.rows.filter((row) => row.id !== "r5"),
      originalRows.rows.filter((row) => row.id !== "r5"),
    );
    host.assertNoLegacyData();
    print("verified", {
      backend,
      operations: 8,
      recoveredExactDocumentVersions: [1, 2],
      recoveredTableVersions: [1, 2],
      unchangedRows: 9,
      physicalIoMeasured: false,
    });
  } finally {
    try {
      observer?.restore();
    } finally {
      try {
        await f?.close();
        if (f) assert.equal(existsSync(f.directory), false);
      } finally {
        if (admin) {
          try {
            for (const schema of Object.values(schemas))
              await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
            assert.deepEqual(
              (
                await admin.query(
                  "SELECT nspname FROM pg_namespace WHERE nspname=ANY($1::text[])",
                  [Object.values(schemas)],
                )
              ).rows,
              [],
            );
          } finally {
            await admin.end();
          }
        }
      }
    }
    print("cleanup", {
      backend,
      observersRestored: true,
      exactSchemasDropped: admin ? Object.values(schemas) : [],
      fixtureClosed: true,
    });
  }
}
print("measurement_boundary", {
  directSqlMeaning:
    "Actual run().changes / PG command rowCount; no engine-internal trigger/index/tuple byte claim. Counts include executed zero-row commands and WHERE/id binding costs. Transactions are attributed through AsyncLocalStorage and counted only after successful COMMIT/ROLLBACK.",
  ratioMeaning:
    "Committed DML UTF8 scalar-binding bytes / newly persisted object payload_body and cell scalar-value bytes. Null has zero UTF8 scalar bytes. Not semantic edit bytes, network encoding, tuple bytes, WAL bytes or physical write amplification. Zero durable increment returns null, not zero.",
  allocationMeaning:
    "Point-in-time generated fixture file sizes and isolated PG relation/index allocations, not cumulative writes. SQLite WAL reuse/checkpoint can reduce sampled allocation.",
  walMeaning:
    "SQLite reads the private WAL after acquiring BEGIN IMMEDIATE and synchronously after the real COMMIT/ROLLBACK; salt/reset and rolling checksums select valid transaction frames, not allocated tail. PG global LSNs only bound decoding: records are attributed by actual transaction IDs captured on the exact live connection; unrelated records are excluded, private relation records lacking captured XIDs fail attribution. Fresh-schema/checkpoint state affects WAL/FPI counts. API timings include observer overhead. Engine WAL generation is not SSD physical writes.",
  physicalIoMeasured: false,
  physicalWriteAmplification: null,
  unmeasured: [
    "SQLite checkpoint-main-db write bytes",
    "WAL page/segment/alignment overhead in PG",
    "SSD/device physical I/O",
    "approved performance SLO",
  ],
});
