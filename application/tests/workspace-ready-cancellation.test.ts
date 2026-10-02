import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { Application } from "../packages/application/src/application.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { createAppServer } from "../apps/service/src/http.js";
import { postgresChangeSource } from "../packages/storage/src/commit-notifications.js";

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  const deadline = Date.now() + 1500;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error("isolated listener did not receive a connection");
    await pause(5);
  }
}

async function unavailablePostgres() {
  let attempts = 0;
  // A real socket failure before LISTEN readiness, not a mocked ready Promise.
  const listener = createServer((socket) => {
    attempts++;
    socket.destroy();
  });
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  const port = (listener.address() as { port: number }).port;
  const source = postgresChangeSource(
    { host: "127.0.0.1", port, user: "isolated", database: "isolated" },
    "isolated_ready",
  );
  return {
    source,
    attempts: () => attempts,
    close: () =>
      new Promise<void>((resolve) => listener.close(() => resolve())),
  };
}

test("native unsubscribe before initial PG LISTEN ready ends setup and stops reconnecting", async () => {
  const offline = await unavailablePostgres();
  const store = new WorkspaceStore(":memory:", { mode: "transport" });
  let reads = 0,
    closed = 0;
  const connection = new LocalApplicationConnection(
    new Application(store, {
      workspaceChanges: {
        sources: [offline.source],
        async readVersion() {
          reads++;
          return { version: "unused", accessVersion: "unused", projectIds: [] };
        },
      },
    }),
  );
  try {
    const boot = (await connection.call("platform.bootstrap")) as {
      csrfToken: string;
    };
    const id = randomUUID();
    const pending = connection.observe(
      id,
      { kind: "workspace" },
      boot.csrfToken,
      () => assert.fail("an unready subscription cannot publish"),
      () => closed++,
    );
    await until(() => offline.attempts() === 1);
    connection.unobserve(id);
    assert.equal(
      await Promise.race([
        pending.then(() => true),
        pause(1500).then(() => false),
      ]),
      true,
      "cancellation must release the pending setup, not wait for PG to return",
    );
    await pause(350);
    assert.equal(
      offline.attempts(),
      1,
      "cancelled setup must not keep reconnecting",
    );
    assert.equal(reads, 0);
    assert.equal(closed, 1);
  } finally {
    connection.close();
    await offline.close();
    store.close();
  }
});

test("HTTP SSE disconnect before initial PG LISTEN ready cancels its listener", async () => {
  const offline = await unavailablePostgres();
  const store = new WorkspaceStore(":memory:", { mode: "transport" });
  let reads = 0;
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const server = createAppServer(store, {
    port,
    webRoot: "/nonexistent",
    workspaceChanges: {
      sources: [offline.source],
      async readVersion() {
        reads++;
        return { version: "unused", accessVersion: "unused", projectIds: [] };
      },
    },
  });
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  const abort = new AbortController();
  try {
    const pending = fetch(
      `http://127.0.0.1:${port}/api/platform/workspace/stream`,
      { signal: abort.signal },
    ).catch(() => undefined);
    await until(() => offline.attempts() === 1);
    abort.abort();
    await pending;
    await pause(350);
    assert.equal(
      offline.attempts(),
      1,
      "a closed SSE response cannot retain a reconnecting PG listener",
    );
    assert.equal(reads, 0);
  } finally {
    abort.abort();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await offline.close();
    store.close();
  }
});
