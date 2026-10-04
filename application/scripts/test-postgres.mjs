import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  appendFile,
  chmod,
  mkdtemp,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";

const execute = promisify(execFile);
const own = (env, key) => Object.hasOwn(env, key);
const failure = (message) =>
  new Error(`PostgreSQL test preparation: ${message}`);
const nonblank = (env, key) => {
  if (own(env, key) && !env[key]?.trim())
    throw failure(`${key} must not be blank`);
  return env[key];
};
const executable = async (path) => {
  try {
    return (
      (await stat(path)).isFile() &&
      (await access(
        path,
        process.platform === "win32" ? constants.F_OK : constants.X_OK,
      ),
      true)
    );
  } catch {
    return false;
  }
};
const interrupted = (signal) => {
  if (signal?.aborted) throw failure("interrupted");
};

async function tools(env, server) {
  const override = nonblank(env, "MORPHZ_TEST_POSTGRES_BIN_DIR");
  const directories = override
    ? [resolve(override)]
    : (env.PATH ?? "").split(delimiter).filter(Boolean);
  if (!override)
    for (const parent of [
      "/opt/homebrew/opt",
      "/usr/local/opt",
      "/usr/lib/postgresql",
    ]) {
      const entries = await readdir(parent).catch(() => []);
      for (const name of entries.sort().reverse())
        if (
          parent.endsWith("postgresql")
            ? /^\d+$/.test(name)
            : /^postgresql(?:@\d+)?$/.test(name)
        )
          directories.push(join(parent, name, "bin"));
    }
  const names = server
    ? ["initdb", "pg_ctl", "pg_dump", "pg_restore"]
    : ["pg_dump", "pg_restore"];
  for (const directory of [...new Set(directories)]) {
    const found = Object.fromEntries(
      names.map((name) => [
        name,
        join(directory, `${name}${process.platform === "win32" ? ".exe" : ""}`),
      ]),
    );
    if (
      (await Promise.all(Object.values(found).map(executable))).every(Boolean)
    )
      return found;
  }
  if (override || server)
    throw failure(
      "required PostgreSQL tools are unavailable; install them or set MORPHZ_TEST_POSTGRES_BIN_DIR",
    );
}

async function query(connectionString, sql, signal) {
  interrupted(signal);
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw failure("invalid MORPHZ_TEST_POSTGRES_URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    url.pathname.length < 2
  )
    throw failure("test URL must identify a PostgreSQL host and database");
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 3000,
    query_timeout: 3000,
  });
  // Never discover credentials in the user's .pgpass. Only the supplied URL
  // supplies the password; trust-authenticated owned clusters need none.
  client.password = () => decodeURIComponent(url.password);
  const abort = () => void client.end().catch(() => {});
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await client.connect();
    interrupted(signal);
    return (await client.query(sql)).rows;
  } finally {
    signal?.removeEventListener("abort", abort);
    await client.end().catch(() => {});
  }
}

async function freePort() {
  const server = createServer();
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const port = server.address().port;
  await new Promise((accept, reject) =>
    server.close((error) => (error ? reject(error) : accept())),
  );
  return port;
}

/** Prepare only test infrastructure. Explicit URLs are never replaced or mutated. */
export async function prepareTestPostgres({ env = process.env, signal } = {}) {
  interrupted(signal);
  const childEnv = { ...env };
  const explicit = nonblank(env, "MORPHZ_TEST_POSTGRES_URL");
  const dump = nonblank(env, "MORPHZ_TEST_PG_DUMP"),
    restore = nonblank(env, "MORPHZ_TEST_PG_RESTORE");
  for (const path of [dump, restore])
    if (path && !(await executable(path)))
      throw failure("a provided PostgreSQL client tool is not executable");
  const found = await tools(env, !explicit);
  if (!dump && found) childEnv.MORPHZ_TEST_PG_DUMP = found.pg_dump;
  if (!restore && found) childEnv.MORPHZ_TEST_PG_RESTORE = found.pg_restore;
  if (explicit) {
    try {
      await query(explicit, "SELECT 1 AS ready", signal);
    } catch {
      throw failure(
        signal?.aborted
          ? "interrupted"
          : "explicit test connection failed its SELECT preflight (URL and credentials withheld)",
      );
    }
    interrupted(signal);
    return { env: childEnv, mode: "explicit", close: async () => {} };
  }
  if (process.getuid?.() === 0)
    throw failure("temporary initdb must run as a non-root user");
  interrupted(signal);
  const directory = await mkdtemp(join(tmpdir(), "morphz-test-postgres-"));
  const data = join(directory, "data"),
    log = join(directory, "postgres.log");
  let closing;
  const close = () =>
    (closing ??= (async () => {
      if (
        await access(join(data, "postmaster.pid")).then(
          () => true,
          () => false,
        )
      ) {
        try {
          await execute(
            found.pg_ctl,
            ["-D", data, "-m", "fast", "-w", "-t", "15", "stop"],
            { timeout: 20_000 },
          );
        } catch {
          throw failure(
            "owned temporary server could not stop; its directory was retained",
          );
        }
      }
      await rm(directory, { recursive: true, force: true });
    })());
  try {
    await chmod(directory, 0o700);
    const port = await freePort();
    await execute(
      found.initdb,
      [
        "-D",
        data,
        "--username=morphz_test",
        "--auth=trust",
        "--encoding=UTF8",
        "--locale=C",
        "--no-instructions",
      ],
      { env: childEnv, signal, timeout: 20_000 },
    );
    await appendFile(
      join(data, "postgresql.conf"),
      `\nlisten_addresses = '127.0.0.1'\nport = ${port}\nunix_socket_directories = ''\n`,
    );
    await execute(
      found.pg_ctl,
      ["-D", data, "-l", log, "-w", "-t", "15", "start"],
      { env: childEnv, signal, timeout: 20_000 },
    );
    const base = `postgresql://morphz_test@127.0.0.1:${port}/`;
    const rows = await query(
      `${base}postgres?sslmode=disable`,
      "SELECT current_setting('data_directory') AS directory, current_user AS role",
      signal,
    );
    if (rows[0]?.directory !== data || rows[0]?.role !== "morphz_test")
      throw failure("temporary server ownership check failed");
    await query(
      `${base}postgres?sslmode=disable`,
      "CREATE DATABASE morphz_test",
      signal,
    );
    childEnv.MORPHZ_TEST_POSTGRES_URL = `${base}morphz_test?sslmode=disable`;
    await query(childEnv.MORPHZ_TEST_POSTGRES_URL, "SELECT 1 AS ready", signal);
    interrupted(signal);
    return { env: childEnv, mode: "ephemeral", directory, close };
  } catch {
    await close();
    throw failure(
      signal?.aborted
        ? "interrupted"
        : "temporary cluster initialization/start/query failed (tool output withheld)",
    );
  }
}
