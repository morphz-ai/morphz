/** Acceptance-only native SQL backup/restore for a freshly owned Runtime.
 * This is not a production backup API or a filesystem relocation mechanism.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { Client, type QueryResult } from "pg";

const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

function run(program: string, args: string[]) {
  const env = { ...process.env };
  const safeArgs = args.map((value) => {
    if (!/^postgres(?:ql)?:\/\//.test(value)) return value;
    const url = new URL(value);
    if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
    url.password = "";
    return url.href;
  });
  const result = spawnSync(program, safeArgs, {
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error)
    throw new Error(
      `${program} could not execute (${result.error.name}); command arguments withheld`,
    );
  const stderr = args.reduce(
    (message, value) =>
      /^postgres(?:ql)?:\/\//.test(value)
        ? message.replaceAll(value, "<postgres-url>")
        : message,
    result.stderr,
  );
  assert.equal(result.status, 0, `${program} failed: ${stderr}`);
  return result.stdout;
}

function sqliteManifest(filename: string) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    assert.equal(
      db.prepare("PRAGMA integrity_check").get()?.integrity_check,
      "ok",
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    const schema = db
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name",
      )
      .all();
    const tables = schema
      .filter((row) => row.type === "table")
      .map((row) => {
        const statement = db.prepare(
          `SELECT * FROM ${identifier(String(row.name))}`,
        );
        statement.setReadBigInts(true);
        const rows = statement
          .all()
          .map((record) =>
            JSON.stringify(record, (_key, value) =>
              typeof value === "bigint"
                ? { integer: value.toString() }
                : value instanceof Uint8Array
                  ? { bytes: Buffer.from(value).toString("hex") }
                  : value,
            ),
          );
        return {
          name: row.name,
          rows: rows.length,
          sha256: digest(JSON.stringify(rows.sort())),
        };
      });
    return { schemaSha256: digest(JSON.stringify(schema)), tables };
  } finally {
    db.close();
  }
}

/** Only copies files in paths freshly created by the enclosing fixture. */
export class RuntimeBackupFixture {
  readonly evidenceDirectory = mkdtempSync(
    join(tmpdir(), "morphz-runtime-backup-evidence-"),
  );
  readonly schema = `runtime_backup_${randomUUID().replaceAll("-", "")}`;
  readonly retiredSchema = `${this.schema}_retired`;
  readonly postgresURL: string | undefined;
  private admin: Client | undefined;
  private readonly ownedSchemaOids = new Map<string, number>();
  private restored = false;

  private constructor(
    private readonly root: string,
    private readonly home: string,
    private readonly configFile: string,
    private readonly basePostgresURL?: string,
  ) {
    assert.ok(basename(root).startsWith("morphz-platform-message-runtime-"));
    assert.equal(home, join(root, "runtime"));
    assert.equal(configFile, join(root, "morphz.toml"));
    if (basePostgresURL) {
      const scoped = new URL(basePostgresURL);
      scoped.searchParams.set(
        "options",
        `-csearch_path=${this.schema},pg_catalog`,
      );
      this.postgresURL = scoped.href;
    }
  }

  static async create(
    root: string,
    home: string,
    configFile: string,
    postgresURL?: string,
  ) {
    const fixture = new RuntimeBackupFixture(
      root,
      home,
      configFile,
      postgresURL,
    );
    if (postgresURL) {
      fixture.admin = new Client({ connectionString: postgresURL });
      await fixture.admin.connect();
      await fixture.admin.query(`CREATE SCHEMA ${identifier(fixture.schema)}`);
      const created = await fixture.admin.query<{ oid: number }>(
        "SELECT oid FROM pg_namespace WHERE nspname=$1",
        [fixture.schema],
      );
      fixture.ownedSchemaOids.set(fixture.schema, created.rows[0]!.oid);
    }
    return fixture;
  }

  private async postgresManifest() {
    assert.ok(this.admin && this.basePostgresURL);
    const schema = run("pg_dump", [
      "--schema-only",
      "--no-owner",
      "--no-privileges",
      "--schema",
      this.schema,
      "--dbname",
      this.basePostgresURL,
    ]).replace(/^\\(?:un)?restrict .*\n/gm, "");
    const names = await this.admin.query<{ name: string }>(
      "SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p','m') ORDER BY c.relname",
      [this.schema],
    );
    const tables = [];
    for (const { name } of names.rows) {
      const rows = await this.admin.query<{ body: string }>(
        `SELECT to_jsonb(t)::text AS body FROM ${identifier(this.schema)}.${identifier(name)} t`,
      );
      tables.push({
        name,
        rows: rows.rowCount,
        sha256: digest(JSON.stringify(rows.rows.map((row) => row.body).sort())),
      });
    }
    const namesOfSequences = await this.admin.query<{ name: string }>(
      "SELECT sequencename AS name FROM pg_sequences WHERE schemaname=$1 ORDER BY sequencename",
      [this.schema],
    );
    const sequences = [];
    for (const { name } of namesOfSequences.rows) {
      const value = await this.admin.query(
        `SELECT last_value::text,is_called FROM ${identifier(this.schema)}.${identifier(name)}`,
      );
      sequences.push({ name, ...value.rows[0] });
    }
    return { schemaSha256: digest(schema), tables, sequences };
  }

  async restoreFromNativeBackup(hostToolsFile: string) {
    assert.ok(
      !relative(this.root, hostToolsFile).startsWith(".."),
      "only the current fixture's Host configuration may be copied",
    );
    const sqlPath = join(this.home, "runtime.sqlite");
    const before = this.admin
      ? await this.postgresManifest()
      : sqliteManifest(sqlPath);
    const parts = [
      { name: "home", path: this.home },
      { name: "configuration", path: this.configFile },
      { name: "host-tool-configuration", path: hostToolsFile },
      {
        name: "workspace-attachments",
        path: join(this.root, ".morphz", "attachments"),
      },
    ].filter((part) => existsSync(part.path));
    const files = (
      base: string,
      prefix: string,
    ): Array<{ name: string; bytes: number; mode: number; sha256: string }> => {
      const stat = lstatSync(base);
      assert.ok(
        !stat.isSymbolicLink(),
        "fixture backup must not follow external symlinks",
      );
      if (stat.isDirectory())
        return readdirSync(base)
          .sort()
          .flatMap((name) => files(join(base, name), `${prefix}/${name}`));
      assert.ok(stat.isFile(), "unexpected non-file Runtime fixture state");
      if (
        prefix === "home/runtime.sqlite" ||
        /^home\/runtime\.sqlite-(?:wal|shm)$/.test(prefix)
      )
        return [];
      return [
        {
          name: prefix,
          bytes: stat.size,
          mode: stat.mode & 0o777,
          sha256: digest(readFileSync(base)),
        },
      ];
    };
    const originalFiles = parts.flatMap((part) => files(part.path, part.name));
    const resolveFile = (name: string) => {
      const part = parts.find(
        (part) => name === part.name || name.startsWith(`${part.name}/`),
      );
      assert.ok(part);
      return name === part.name
        ? part.path
        : join(part.path, name.slice(part.name.length + 1));
    };
    const originalFileIdentities = new Map(
      originalFiles.map((file) => {
        const stat = lstatSync(resolveFile(file.name));
        return [file.name, `${stat.dev}:${stat.ino}`];
      }),
    );
    assert.ok(
      originalFiles.some(
        (file) =>
          file.name.startsWith("home/artifacts/message-inputs-v2/") &&
          file.bytes > 0,
      ),
      "restore sample must contain actual Runtime attachment bytes",
    );
    const archiveFiles = join(this.evidenceDirectory, "files");
    mkdirSync(archiveFiles);
    for (const part of parts)
      cpSync(part.path, join(archiveFiles, part.name), {
        recursive: true,
        preserveTimestamps: true,
      });
    const archive = join(
      this.evidenceDirectory,
      this.admin ? "runtime.dump" : "runtime.sqlite",
    );
    let sourceOID: number | undefined;
    if (this.admin) {
      assert.ok(this.basePostgresURL);
      sourceOID = (
        await this.admin.query<{ oid: number }>(
          "SELECT oid FROM pg_namespace WHERE nspname=$1",
          [this.schema],
        )
      ).rows[0]!.oid;
      assert.equal(
        sourceOID,
        this.ownedSchemaOids.get(this.schema),
        "the source namespace must still be the exact schema created by this fixture",
      );
      run("pg_dump", [
        "--format=custom",
        "--schema",
        this.schema,
        "--file",
        archive,
        "--dbname",
        this.basePostgresURL,
      ]);
      await this.admin.query(
        `ALTER SCHEMA ${identifier(this.schema)} RENAME TO ${identifier(this.retiredSchema)}`,
      );
      const quarantined = await this.admin.query<{ oid: number }>(
        "SELECT oid FROM pg_namespace WHERE nspname=$1",
        [this.retiredSchema],
      );
      assert.equal(quarantined.rows[0]?.oid, sourceOID);
      this.ownedSchemaOids.delete(this.schema);
      this.ownedSchemaOids.set(this.retiredSchema, sourceOID);
      try {
        run("pg_restore", [
          "--exit-on-error",
          "--dbname",
          this.basePostgresURL,
          archive,
        ]);
      } finally {
        const restored = await this.admin.query<{ oid: number }>(
          "SELECT oid FROM pg_namespace WHERE nspname=$1",
          [this.schema],
        );
        if (restored.rows[0]) {
          assert.notEqual(restored.rows[0].oid, sourceOID);
          this.ownedSchemaOids.set(this.schema, restored.rows[0].oid);
        }
      }
    } else {
      const db = new DatabaseSync(sqlPath, { readOnly: true });
      try {
        await backup(db, archive);
      } finally {
        db.close();
      }
      cpSync(archive, join(archiveFiles, "home", "runtime.sqlite"));
      for (const suffix of ["-wal", "-shm"])
        rmSync(join(archiveFiles, "home", `runtime.sqlite${suffix}`), {
          force: true,
        });
    }
    const sourceArtifact = originalFiles.find((file) =>
      file.name.startsWith("home/artifacts/message-inputs-v2/"),
    )!;
    const artifactRelative = relative("home", sourceArtifact.name);
    const sourceArtifactInode = lstatSync(
      join(this.home, artifactRelative),
    ).ino;
    const sourceDatabaseInode = this.admin ? undefined : lstatSync(sqlPath).ino;
    // Retain the originals in a quarantined path. The restored Runtime has no
    // fallback path to them: all immutable Event paths still name the fresh copy.
    for (const part of parts) {
      renameSync(part.path, `${part.path}.backup-source-quarantine`);
      cpSync(join(archiveFiles, part.name), part.path, {
        recursive: true,
        preserveTimestamps: true,
      });
    }
    const restoredFiles = parts.flatMap((part) => files(part.path, part.name));
    assert.deepEqual(
      restoredFiles,
      originalFiles,
      "all Runtime-owned non-SQL files must restore exactly",
    );
    for (const file of restoredFiles) {
      const stat = lstatSync(resolveFile(file.name));
      assert.notEqual(
        `${stat.dev}:${stat.ino}`,
        originalFileIdentities.get(file.name),
        "no restored file may remain a hardlink to a quarantined original",
      );
    }
    assert.notEqual(
      lstatSync(join(this.home, artifactRelative)).ino,
      sourceArtifactInode,
    );
    if (sourceDatabaseInode !== undefined)
      assert.notEqual(lstatSync(sqlPath).ino, sourceDatabaseInode);
    const restoredOID = this.admin
      ? (
          await this.admin.query<{ oid: number }>(
            "SELECT oid FROM pg_namespace WHERE nspname=$1",
            [this.schema],
          )
        ).rows[0]!.oid
      : undefined;
    if (sourceOID !== undefined)
      assert.notEqual(
        restoredOID,
        sourceOID,
        "restore must create a new PostgreSQL namespace, not reuse the original",
      );
    const after = this.admin
      ? await this.postgresManifest()
      : sqliteManifest(sqlPath);
    assert.deepEqual(
      after,
      before,
      "full SQL schema, every row and sequence state must survive independent restore before Runtime starts",
    );
    this.restored = true;
    const report = {
      type: "runtime_native_backup_restore",
      backend: this.admin ? "postgres" : "sqlite",
      schemaName: this.admin ? this.schema : undefined,
      quarantinedSchemaName: this.admin ? this.retiredSchema : undefined,
      evidenceDirectory: this.evidenceDirectory,
      backupSha256: digest(readFileSync(archive)),
      sourceOID,
      restoredOID,
      sourceDatabaseInode,
      restoredDatabaseInode: this.admin ? undefined : lstatSync(sqlPath).ino,
      sourceArtifactInode,
      restoredArtifactInode: lstatSync(join(this.home, artifactRelative)).ino,
      pathPreservingRestore: true,
      sourceSqlManifestSha256: digest(JSON.stringify(before)),
      restoredSqlManifestSha256: digest(JSON.stringify(after)),
      sourceFilesManifestSha256: digest(JSON.stringify(originalFiles)),
      restoredFilesManifestSha256: digest(JSON.stringify(restoredFiles)),
      fullSqlAndFilesVerifiedEqual: true,
      sql: after,
      files: restoredFiles,
      independentlyCopiedFiles: restoredFiles.length,
      fileIdentities: restoredFiles.map((file) => {
        const stat = lstatSync(resolveFile(file.name));
        return {
          name: file.name,
          source: originalFileIdentities.get(file.name),
          restored: `${stat.dev}:${stat.ino}`,
        };
      }),
      domainSampleRows: Object.fromEntries(
        [
          "sessions",
          "events",
          "threads",
          "principals",
          "session_principal_bindings",
          "schedules",
          "execution_nodes",
          "execution_targets",
          "execution_jobs",
          "plan_executions",
          "approval_requests",
          "action_groups",
          "capability_leases",
          "experimental_contextdb_contexts",
          "experimental_contextdb_runtime_heads",
          "experimental_contextdb_nodes",
          "experimental_contextdb_receipts",
        ].map((name) => [
          name,
          after.tables.find((table) => table.name === name)?.rows ?? null,
        ]),
      ),
      limitations: [
        "synthetic environment credential; OS keyring not backed up",
        "Node user files and third-party stores outside this Runtime fixture are not backed up",
        "no arbitrary filesystem relocation or online cross-store snapshot claim",
      ],
    };
    writeFileSync(
      join(this.evidenceDirectory, "manifest.json"),
      JSON.stringify(report, null, 2),
      { mode: 0o600 },
    );
    console.log(JSON.stringify(report));
  }

  async close() {
    if (!this.admin) return;
    try {
      const dropped = [];
      for (const [schema, expectedOID] of this.ownedSchemaOids) {
        assert.ok(/^runtime_backup_[a-f0-9]{32}$/.test(this.schema));
        assert.ok(schema === this.schema || schema === this.retiredSchema);
        const actual: QueryResult<{ oid: number }> = await this.admin.query<{
          oid: number;
        }>("SELECT oid FROM pg_namespace WHERE nspname=$1", [schema]);
        assert.equal(
          actual.rows[0]?.oid,
          expectedOID,
          "cleanup must never drop a namespace that was not created and OID-verified by this fixture",
        );
        await this.admin.query(`DROP SCHEMA ${identifier(schema)} CASCADE`);
        dropped.push({ schema, oid: expectedOID });
      }
      console.log(
        JSON.stringify({
          type: "runtime_backup_fixture_cleanup",
          oidVerifiedSchemasDropped: dropped,
        }),
      );
    } finally {
      await this.admin.end();
    }
  }

  assertVerified() {
    assert.ok(
      this.restored,
      "native backup restoration must finish before the resumed Runtime acceptance",
    );
    console.log(
      `PASS: independent Runtime native backup restore plus unchanged HTTP/source/bytes/idempotency assertions; evidence ${this.evidenceDirectory}`,
    );
  }
}
