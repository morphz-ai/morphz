import { _electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
const fixture = mkdtempSync(join(tmpdir(), "morphz-embedded-electron-"));
const directory = join(fixture, "data");
mkdirSync(directory);
const calls = [];
let bodyFailure = false;
let application;
const server = createServer((request, response) => {
  calls.push({
    method: request.method,
    path: request.url,
    cookie: request.headers.cookie,
  });
  assert.equal(request.headers.authorization, "Bearer fixture-only");
  response.setHeader("content-type", "application/json");
  if (bodyFailure && request.url === "/api/status") {
    response.writeHead(200);
    response.flushHeaders();
    setTimeout(() => response.destroy(), 25);
    return;
  }
  const value =
    request.url === "/api/status"
      ? {
          model: "fixture-model",
          agent_id: "agent-fixture",
          principal_id: "human-fixture",
        }
      : request.url === "/api/session-io/capabilities"
        ? { enabled: false }
        : request.url === "/api/approvals"
          ? { approvals: [] }
          : request.url === "/api/runtime/inference"
            ? { model: "fixture-model", models: ["fixture-model"] }
            : request.url === "/api/objectives"
              ? { objectives: [] }
              : null;
  if (value === null) response.writeHead(404);
  response.end(JSON.stringify(value ?? {}));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
writeFileSync(
  join(directory, "runtime.json"),
  JSON.stringify({
    url: `http://127.0.0.1:${server.address().port}`,
    token: "fixture-only",
    namespace: randomUUID(),
  }),
  { mode: 0o600 },
);
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !key.startsWith("MORPHZ") &&
      !["NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "DOUBAO_API_KEY"].includes(key),
  ),
);
function connected() {
  if (!existsSync(join(directory, "workspace.sqlite"))) return false;
  const db = new DatabaseSync(join(directory, "workspace.sqlite"), {
    readOnly: true,
  });
  try {
    if (
      !db
        .prepare("select name from sqlite_master where name='runtime_state'")
        .get()
    )
      return false;
    return (
      db
        .prepare(
          "select json_extract(body, '$.connected') connected from runtime_state",
        )
        .get()?.connected === 1
    );
  } finally {
    db.close();
  }
}
try {
  application = await _electron.launch({
    args: ["tests/fixtures/desktop-runtime-network-entry.cjs"],
    env: {
      ...env,
      MORPHZ_APP_EMBEDDED_FIXTURE: fixture,
      MORPHZ_APP_ENV_FILE: "",
    },
    timeout: 20000,
  });
  await expect.poll(() => connected(), { timeout: 20000 }).toBe(true);
  assert.equal(
    await application.evaluate(() => globalThis.__fixtureNodeFetchCalls),
    0,
  );
  bodyFailure = true;
  await expect.poll(() => connected(), { timeout: 20000 }).toBe(false);
  bodyFailure = false;
  await expect.poll(() => connected(), { timeout: 20000 }).toBe(true);
  assert.ok(calls.length > 3);
  assert.ok(calls.every((call) => call.method === "GET" && !call.cookie));
  assert.equal(
    await application.evaluate(() => globalThis.__fixtureNodeFetchCalls),
    0,
  );
  console.log(
    JSON.stringify({
      productionEntry: true,
      nodeBodyStallBypassed: true,
      bodyInterruptionRecovered: true,
      noMessagesOrWrites: true,
      noBrowsingCookies: true,
    }),
  );
} finally {
  if (application) {
    const child = application.process();
    let timeout;
    try {
      await Promise.race([
        application.close(),
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("Owned fixture did not quit normally"));
          }, 8000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(fixture, { recursive: true, force: true });
}
