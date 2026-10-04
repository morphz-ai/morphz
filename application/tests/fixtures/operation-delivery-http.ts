import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  useWorkspace,
  type WorkspaceClient,
} from "../../apps/web/src/client.js";
import { draftOwner } from "../../apps/web/src/local-preferences.js";
import { createAppServer } from "../../apps/service/src/http.js";
import { applicationWindowKey } from "../../packages/core/src/application-names.js";
import { agentDomainFixture } from "../agent-domain-fixture.js";

export const operationHuman = {
  principalId: "operation-human",
  actantId: "operation-actant",
};
export const otherOperationHuman = {
  principalId: "operation-other",
  actantId: "operation-other-actant",
};
const token = (who: { principalId: string }) =>
  createHash("sha256")
    .update("operation-delivery:" + who.principalId)
    .digest("hex");
export type OperationHttpRead = {
  path: string;
  query: string;
  method: string;
  status: number;
  returnedStatus?: number;
  body: unknown;
  response: unknown;
};
function actualClient() {
  let client: WorkspaceClient | undefined;
  function Probe() {
    client = useWorkspace();
    return createElement("span");
  }
  renderToString(createElement(Probe));
  assert(client);
  return client;
}
function storage(rows: Map<string, string>, fail: () => boolean): Storage {
  return {
    get length() {
      return rows.size;
    },
    key(n) {
      return [...rows.keys()][n] ?? null;
    },
    clear() {
      rows.clear();
    },
    getItem(key) {
      return rows.get(key) ?? null;
    },
    setItem(key, value) {
      if (value === "null" && fail())
        throw Error("TEST committed pending clear failed");
      rows.set(key, value);
    },
    removeItem(key) {
      rows.delete(key);
    },
  };
}
export async function withOperationHttp(
  name: string,
  run: (context: {
    readonly client: WorkspaceClient;
    reads: OperationHttpRead[];
    rows: Map<string, string>;
    login(other?: boolean): Promise<void>;
    remount(): Promise<void>;
    interceptNext(path: string, status?: number): void;
    holdNext(path: string): { reached: Promise<void>; release(): void };
    failNextClear(): void;
    sql(): {
      objects: Record<string, unknown>[];
      versions: Record<string, unknown>[];
      objectReceipts: Record<string, unknown>[];
      projects: Record<string, unknown>[];
      tasks: Record<string, unknown>[];
      taskVersions: Record<string, unknown>[];
      platformReceipts: Record<string, unknown>[];
      scriptReceipts: Record<string, unknown>[];
    };
  }) => Promise<void>,
) {
  // Actual private HTTP/Identity/Platform/Objects/Script and SQLite. Runtime
  // authority is the established fixture's controlled reads, never a process.
  const fixture = await agentDomainFixture({
    additionalHumans: [operationHuman, otherOperationHuman],
    loginTokenForHuman: token,
  });
  const originals = [
    "window",
    "location",
    "localStorage",
    "sessionStorage",
  ].map((name) => ({
    name,
    descriptor: Object.getOwnPropertyDescriptor(globalThis, name),
  }));
  const nativeFetch = globalThis.fetch,
    rows = new Map<string, string>(),
    reads: OperationHttpRead[] = [],
    releases: (() => void)[] = [];
  let client: WorkspaceClient | undefined,
    cookies = "",
    failClear = false,
    listening = false;
  let server: ReturnType<typeof createAppServer> | undefined;
  let intercept:
    | {
        path: string;
        status?: number;
        reached?: () => void;
        held?: Promise<void>;
      }
    | undefined;
  const sql = () => {
    const objects = new DatabaseSync(
        join(fixture.directory, "objects.sqlite"),
        { readOnly: true },
      ),
      platform = new DatabaseSync(join(fixture.directory, "platform.sqlite"), {
        readOnly: true,
      }),
      scripts = new DatabaseSync(
        join(fixture.directory, "script-studio.sqlite"),
        { readOnly: true },
      );
    try {
      const all = (db: DatabaseSync, table: string, order: string) =>
        db
          .prepare("SELECT * FROM " + table + " ORDER BY " + order)
          .all() as Record<string, unknown>[];
      return {
        objects: all(objects, "objects", "object_id"),
        versions: all(objects, "object_versions", "object_id,revision"),
        objectReceipts: all(objects, "object_command_receipts", "command_id"),
        projects: all(platform, "projects", "project_id"),
        tasks: all(platform, "tasks", "task_id"),
        taskVersions: all(platform, "task_versions", "task_id,revision"),
        platformReceipts: all(platform, "command_receipts", "command_id"),
        scriptReceipts: all(scripts, "script_command_receipts", "command_id"),
      };
    } finally {
      objects.close();
      platform.close();
      scripts.close();
    }
  };
  const login = async (other = false) => {
    assert(client);
    if (client.getSnapshot()) await client.logout();
    await client.login(token(other ? otherOperationHuman : operationHuman));
  };
  try {
    const probe = createServer();
    await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((done, reject) =>
      probe.close((error) => (error ? reject(error) : done())),
    );
    assert.notEqual(port, 65421);
    server = createAppServer(fixture.transport, {
      identity: fixture.identity,
      platformWork: fixture.domains.work,
      platformDocuments: fixture.domains.content,
      platformScripts: fixture.domains.content,
      platformReader: fixture.domains.reader,
      bookmarkDomain: fixture.domains.browser,
      messageAttachments: fixture.domains.messageAttachments,
      uiPackages: fixture.domains.uiPackages,
      notifications: fixture.domains.notifications,
      port,
      webRoot: "/nonexistent",
    });
    const ownedServer = server;
    await new Promise<void>((done) =>
      ownedServer.listen(port, "127.0.0.1", done),
    );
    listening = true;
    const origin = "http://127.0.0.1:" + port;
    globalThis.fetch = async (input, init) => {
      assert.equal(typeof input, "string");
      const url = new URL(input as string, origin);
      assert.equal(url.origin, origin, "only isolated owned HTTP origin");
      const headers = new Headers(init?.headers);
      if (cookies) headers.set("Cookie", cookies);
      if (init?.method === "POST") headers.set("Origin", origin);
      const response = await nativeFetch(url, { ...init, headers }),
        cookie = response.headers.get("set-cookie");
      if (cookie) cookies = cookie.split(";")[0]!;
      const value: unknown = await response.clone().json();
      reads.push({
        path: url.pathname,
        query: url.search,
        method: init?.method ?? "GET",
        status: response.status,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        response: value,
      });
      if (intercept?.path === url.pathname) {
        const current = intercept;
        intercept = undefined;
        assert.equal(
          response.status,
          200,
          "hold/loss is after actual authorized success/commit",
        );
        current.reached?.();
        if (current.held) await current.held;
        if (current.status !== undefined) {
          reads.at(-1)!.returnedStatus = current.status;
          return new Response(
            JSON.stringify({
              message: "TEST controlled reply after real commit",
              code: "test_after_commit",
            }),
            {
              status: current.status,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
      }
      return response;
    };
    for (const [key, value] of Object.entries({
      window: {},
      location: { origin },
      localStorage: storage(rows, () => {
        const value = failClear;
        failClear = false;
        return value;
      }),
      sessionStorage: storage(
        new Map([[applicationWindowKey, draftOwner]]),
        () => false,
      ),
    }))
      Object.defineProperty(globalThis, key, { configurable: true, value });
    client = actualClient();
    assert.equal(
      reads.length,
      0,
      "real SSR Client construction makes no HTTP call",
    );
    await login();
    await run({
      get client() {
        assert(client);
        return client;
      },
      reads,
      rows,
      login,
      async remount() {
        assert(client);
        await client.logout();
        client = actualClient();
        await login();
      },
      interceptNext(path, status = 500) {
        assert.equal(intercept, undefined);
        intercept = { path, status };
      },
      holdNext(path) {
        assert.equal(intercept, undefined);
        let reached!: () => void,
          release!: () => void,
          deadline!: ReturnType<typeof setTimeout>;
        const reachedPromise = new Promise<void>((done, reject) => {
          deadline = setTimeout(
            () =>
              reject(
                Error(
                  "TEST actual HTTP hold phase not reached: " +
                    path +
                    " last=" +
                    reads
                      .slice(-15)
                      .map((read) => read.path)
                      .join(","),
                ),
              ),
            5000,
          );
          reached = () => {
            clearTimeout(deadline);
            done();
          };
        });
        const held = new Promise<void>((done) => {
          release = () => {
            clearTimeout(deadline);
            done();
          };
        });
        intercept = { path, reached, held };
        releases.push(release);
        return { reached: reachedPromise, release };
      },
      failNextClear() {
        failClear = true;
      },
      sql,
    });
    fixture.assertNoLegacyData();
    assert.equal(
      fixture.transport.runtimeState(),
      null,
      "no actual Runtime or model started",
    );
    const evidence = process.env.MORPHZ_TEST_OPERATION_DELIVERY_EVIDENCE_DIR;
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      writeFileSync(
        join(evidence, name + "-http-ledger.json"),
        JSON.stringify({ reads, storage: [...rows], sql: sql() }, null, 2),
      );
    }
    console.log(
      JSON.stringify({
        operationHttp: name,
        requests: reads.length,
        objects: sql().objects.length,
        tasks: sql().tasks.length,
        ledgerSha256: createHash("sha256")
          .update(JSON.stringify({ reads, storage: [...rows], sql: sql() }))
          .digest("hex"),
      }),
    );
  } finally {
    releases.forEach((release) => release());
    globalThis.fetch = nativeFetch;
    originals.forEach(({ name, descriptor }) => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
    try {
      if (listening && server) {
        const listeningServer = server;
        listeningServer.closeIdleConnections();
        await new Promise<void>((done, reject) =>
          listeningServer.close((error) => (error ? reject(error) : done())),
        );
      }
    } finally {
      await fixture.close();
    }
    assert.equal(
      existsSync(fixture.directory),
      false,
      "only owned isolated SQL directory removed",
    );
  }
}
