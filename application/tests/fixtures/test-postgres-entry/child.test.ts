import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";

const mode = process.env.MORPHZ_TEST_ENTRY_FIXTURE_MODE;
test(
  "PostgreSQL entry child fixture",
  { skip: mode === "skip" ? "entry audit counterexample" : false },
  async () => {
    assert.equal(
      process.env.MORPHZ_APP_ENV_FILE,
      "",
      "tests must not load a production env file",
    );
    const client = new Client({
      connectionString: process.env.MORPHZ_TEST_POSTGRES_URL,
    });
    try {
      await client.connect();
      if (mode === "hold") process.on("SIGTERM", () => {});
      const result = await client.query(
        "SELECT 1 AS ready, current_setting('data_directory') AS directory, current_database() AS database, current_user AS role",
      );
      assert.equal(result.rows[0].ready, 1);
      process.stdout.write(
        `MORPHZ_TEST_ENTRY_READY ${JSON.stringify({ ...result.rows[0], pid: process.pid })}\n`,
      );
      if (mode === "hold") {
        // Simulate a worker ignoring TERM; the runner owns this process group.
        await new Promise(() => {});
      }
      assert.notEqual(mode, "fail", "intentional child failure");
    } finally {
      await client.end();
    }
  },
);
