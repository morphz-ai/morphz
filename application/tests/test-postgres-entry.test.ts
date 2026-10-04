import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

type Prepared = {
  env: NodeJS.ProcessEnv;
  mode: "explicit" | "ephemeral";
  directory?: string;
  close(): Promise<void>;
};
const require = createRequire(import.meta.url);
const {
  prepareTestPostgres,
}: {
  prepareTestPostgres(options?: {
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  }): Promise<Prepared>;
} = require("../scripts/test-postgres.mjs");
const {
  testSelection,
}: {
  testSelection(
    args?: string[],
  ): Promise<{ files: string[]; options: string[] }>;
} = require("../scripts/run-tests.mjs");
const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = "tests/fixtures/test-postgres-entry/child.test.ts";
function automaticEnv(extra: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MORPHZ_TEST_REQUIRED_CAPABILITIES: "postgres",
    ...extra,
  };
  delete env.MORPHZ_TEST_POSTGRES_URL;
  delete env.MORPHZ_TEST_PG_DUMP;
  delete env.MORPHZ_TEST_PG_RESTORE;
  return env;
}
async function sql(url: string, statement: string) {
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 1000,
  });
  try {
    await client.connect();
    return (await client.query(statement)).rows;
  } finally {
    await client.end().catch(() => {});
  }
}
function child(mode: string, extra: NodeJS.ProcessEnv = {}) {
  const process = spawn(
    globalThis.process.execPath,
    ["scripts/run-tests.mjs", fixture],
    {
      cwd: root,
      env: automaticEnv({ ...extra, MORPHZ_TEST_ENTRY_FIXTURE_MODE: mode }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  let readyResolve: (value: { directory: string; pid: number }) => void;
  const ready = new Promise<{ directory: string; pid: number }>((accept) => {
    readyResolve = accept;
  });
  for (const stream of [process.stdout, process.stderr])
    stream.on("data", (value) => {
      output += value.toString();
      const match = /MORPHZ_TEST_ENTRY_READY ([^\n]+)/.exec(output);
      if (match) readyResolve(JSON.parse(match[1]!));
    });
  const completion = new Promise<{
    code: number | null;
    signal: string | null;
    output: string;
  }>((accept, reject) => {
    process.once("error", reject);
    process.once("exit", (code, signal) => accept({ code, signal, output }));
  });
  return { process, ready, completion };
}

test("safe test selection preserves original default inventory and cannot replace owned reporters or escape tests", async () => {
  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  assert.equal(manifest.scripts.test, "node scripts/run-tests.mjs");
  const selected = await testSelection([
    "tests/platform-storage.test.ts",
    "--test-name-pattern",
    "SQLite",
  ]);
  assert.deepEqual(selected, {
    files: ["tests/platform-storage.test.ts"],
    options: ["--test-name-pattern", "SQLite"],
  });
  assert.ok(
    (await testSelection()).files.includes("tests/test-postgres-entry.test.ts"),
  );
  for (const argument of [
    "--eval=1",
    "--require=anything",
    "--test-reporter=dot",
    "--test-skip-pattern=PostgreSQL",
  ])
    await assert.rejects(testSelection([argument]), /only \.test\.ts/);
  await assert.rejects(
    testSelection(["tests/credential-secret-not-found.test.ts"]),
    (error: Error) => !error.message.includes("credential-secret"),
  );
  const outside = await mkdtemp(join(tmpdir(), "morphz-test-selection-"));
  try {
    const file = join(outside, "outside.test.ts");
    await writeFile(file, "");
    await assert.rejects(testSelection([file]), /must belong/);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test(
  "test PostgreSQL entry uses real isolated SQL, honors explicit input and cleans owned clusters on all exits",
  { timeout: 150_000 },
  async (context) => {
    const prepared = await prepareTestPostgres({ env: automaticEnv() });
    const directory = prepared.directory!;
    const url = prepared.env.MORPHZ_TEST_POSTGRES_URL!;
    const bin = dirname(prepared.env.MORPHZ_TEST_PG_DUMP!);
    try {
      await context.test(
        "automatic database has owned 0700 paths, fixed role/database and fresh loopback port",
        async () => {
          assert.equal(prepared.mode, "ephemeral");
          assert.equal((await stat(directory)).mode & 0o777, 0o700);
          assert.equal(new URL(url).hostname, "127.0.0.1");
          assert.notEqual(new URL(url).port, "5432");
          assert.equal(dirname(prepared.env.MORPHZ_TEST_PG_RESTORE!), bin);
          const rows = await sql(
            url,
            "SELECT current_database() AS database, current_user AS role, current_setting('data_directory') AS directory",
          );
          assert.deepEqual(rows[0], {
            database: "morphz_test",
            role: "morphz_test",
            directory: join(directory, "data"),
          });
          await sql(
            url,
            "CREATE TABLE entry_owned(value integer); INSERT INTO entry_owned VALUES (42)",
          );
          assert.equal(
            (await sql(url, "SELECT value FROM entry_owned"))[0].value,
            42,
          );
        },
      );
      await context.test(
        "explicit connection gets real SELECT preflight without replacement, ownership or cleanup mutations",
        async () => {
          const env = {
            ...prepared.env,
            MORPHZ_TEST_POSTGRES_URL: url,
            OTHER_PRESERVED: "unchanged",
          };
          const explicit = await prepareTestPostgres({ env });
          try {
            assert.equal(explicit.mode, "explicit");
            assert.equal(explicit.directory, undefined);
            assert.deepEqual(explicit.env, env);
          } finally {
            await explicit.close();
            await explicit.close();
          }
          assert.equal(
            (await sql(url, "SELECT value FROM entry_owned"))[0].value,
            42,
          );
          assert.ok(existsSync(directory));
          const clientTools = await mkdtemp(
            join(tmpdir(), "morphz-pg-client-only-"),
          );
          try {
            for (const name of ["pg_dump", "pg_restore"])
              await symlink(join(bin, name), join(clientTools, name));
            const clientOnly = await prepareTestPostgres({
              env: { ...env, MORPHZ_TEST_POSTGRES_BIN_DIR: clientTools },
            });
            await clientOnly.close();
            assert.equal(clientOnly.env.MORPHZ_TEST_POSTGRES_URL, url);
            assert.equal(
              existsSync(join(clientTools, "initdb")),
              false,
              "an explicit verified URL never requires server tools",
            );
          } finally {
            await rm(clientTools, { recursive: true, force: true });
          }
        },
      );
      await context.test(
        "blank URL/tool override, unreachable credentials and already aborted preparation fail before any business child",
        async () => {
          for (const [key, value] of [
            ["MORPHZ_TEST_POSTGRES_URL", " "],
            ["MORPHZ_TEST_POSTGRES_BIN_DIR", ""],
            ["MORPHZ_TEST_PG_DUMP", " "],
          ] as const)
            await assert.rejects(
              prepareTestPostgres({ env: { ...automaticEnv(), [key]: value } }),
              /must not be blank/,
            );
          const secret = "never-print-this-password";
          await assert.rejects(
            prepareTestPostgres({
              env: {
                ...automaticEnv(),
                MORPHZ_TEST_POSTGRES_URL: `postgresql://private:${secret}@127.0.0.1:1/nope`,
              },
            }),
            (error: Error) =>
              error.message.includes("preflight") &&
              !error.message.includes(secret) &&
              !error.message.includes("postgresql://"),
          );
          await assert.rejects(
            prepareTestPostgres({
              env: {
                ...automaticEnv(),
                MORPHZ_TEST_POSTGRES_BIN_DIR: "/not-present/private-tools",
              },
            }),
            /tools are unavailable/,
          );
          await assert.rejects(
            prepareTestPostgres({
              env: { ...prepared.env, MORPHZ_TEST_PG_DUMP: directory },
            }),
            /not executable/,
          );
          const abort = new AbortController();
          abort.abort();
          await assert.rejects(
            prepareTestPostgres({ env: prepared.env, signal: abort.signal }),
            /interrupted/,
          );
        },
      );
      for (const stage of ["initdb", "start", "query"] as const)
        await context.test(
          `failed ${stage} keeps tool output private and removes only its own fresh cluster`,
          async () => {
            const tools = await mkdtemp(
              join(tmpdir(), "morphz-pg-tool-failure-"),
            );
            const record = join(tools, "owned-data.json");
            try {
              for (const name of ["initdb", "pg_ctl", "pg_dump", "pg_restore"])
                await symlink(join(bin, name), join(tools, name));
              const tool = stage === "initdb" ? "initdb" : "pg_ctl";
              await rm(join(tools, tool));
              const code = `#!${process.execPath}\nimport {writeFileSync,mkdirSync} from 'node:fs'; import {spawnSync} from 'node:child_process'; const args=process.argv.slice(2),data=args[args.indexOf('-D')+1]; writeFileSync(${JSON.stringify(record)},JSON.stringify(data)); ${stage === "initdb" ? `mkdirSync(data,{recursive:true}); console.error('private-tool-output'); process.exit(1);` : stage === "start" ? `console.error('private-tool-output'); process.exit(1);` : `const result=spawnSync(${JSON.stringify(join(bin, "pg_ctl"))},args,{stdio:'ignore'}); if(args.includes('start') && result.status===0) spawnSync(${JSON.stringify(join(bin, "pg_ctl"))},['-D',data,'-m','fast','-w','stop'],{stdio:'ignore'}); process.exit(result.status??1);`}\n`;
              await writeFile(join(tools, tool), code);
              await chmod(join(tools, tool), 0o700);
              await assert.rejects(
                prepareTestPostgres({
                  env: automaticEnv({ MORPHZ_TEST_POSTGRES_BIN_DIR: tools }),
                }),
                (error: Error) =>
                  error.message.includes("initialization/start/query failed") &&
                  !error.message.includes("private-tool-output"),
              );
              const data = JSON.parse(await readFile(record, "utf8")) as string;
              assert.equal(existsSync(dirname(data)), false);
              assert.ok(
                existsSync(directory),
                "the unrelated live owned fixture survives",
              );
            } finally {
              await rm(tools, { recursive: true, force: true });
            }
          },
        );
      for (const mode of ["pass", "fail", "skip"])
        await context.test(
          `real runner ${mode} propagates child/audit status and removes its actual SQL cluster`,
          async () => {
            const run = child(mode, {
              MORPHZ_APP_ENV_FILE: "/do-not-read-production.env",
            });
            const result = await run.completion;
            assert.equal(result.signal, null, result.output);
            assert.equal(result.code, mode === "pass" ? 0 : 1, result.output);
            if (mode !== "skip") {
              const match = /MORPHZ_TEST_ENTRY_READY ([^\n]+)/.exec(
                result.output,
              );
              assert.ok(match, `fixture did not execute: ${result.output}`);
              const record = JSON.parse(match[1]!) as {
                directory: string;
                pid: number;
              };
              assert.equal(existsSync(dirname(record.directory)), false);
              assert.throws(() => process.kill(record.pid, 0), /ESRCH/);
            } else
              assert.match(
                result.output,
                /unexpected|unknown|not permitted|unregistered/i,
              );
          },
        );
      for (const signal of ["SIGINT", "SIGTERM"] as const)
        await context.test(
          `${signal} stops owned test workers (even ignored TERM) before PostgreSQL cleanup`,
          async () => {
            const run = child("hold");
            const record = await Promise.race([
              run.ready,
              run.completion.then((result) => {
                throw new Error(result.output);
              }),
            ]);
            assert.equal(run.process.kill(signal), true);
            const result = await run.completion;
            assert.equal(
              result.code,
              signal === "SIGTERM" ? 143 : 130,
              result.output,
            );
            assert.throws(() => process.kill(record.pid, 0), /ESRCH/);
            assert.equal(existsSync(dirname(record.directory)), false);
          },
        );
      await context.test(
        "failed preflight cannot reach the business fixture or expose credentials",
        async () => {
          const run = spawn(
            process.execPath,
            ["scripts/run-tests.mjs", fixture],
            {
              cwd: root,
              env: {
                ...automaticEnv(),
                MORPHZ_TEST_POSTGRES_URL:
                  "postgresql://private:never-print-this-password@127.0.0.1:1/nope",
              },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let output = "";
          for (const stream of [run.stdout, run.stderr])
            stream.on("data", (value) => {
              output += value.toString();
            });
          const code = await new Promise((accept) => run.once("exit", accept));
          assert.equal(code, 1);
          assert.match(output, /preflight/);
          assert.doesNotMatch(
            output,
            /never-print-this-password|MORPHZ_TEST_ENTRY_READY/,
          );
        },
      );
    } finally {
      await prepared.close();
      await prepared.close();
    }
    assert.equal(existsSync(directory), false);
  },
);
