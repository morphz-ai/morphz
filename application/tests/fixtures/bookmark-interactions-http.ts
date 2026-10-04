import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer as probePort } from "node:http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  useWorkspace,
  type WorkspaceClient,
} from "../../apps/web/src/client.js";
import { draftOwner } from "../../apps/web/src/local-preferences.js";
import { applicationWindowKey } from "../../packages/core/src/application-names.js";
import { createAppServer } from "../../apps/service/src/http.js";
import { localAccess } from "../../packages/core/src/model.js";
import { agentDomainFixture } from "../agent-domain-fixture.js";

export const bookmarkHuman = {
  principalId: "bookmark-test-human",
  actantId: "bookmark-test-actant",
};
export const otherBookmarkHuman = {
  principalId: "bookmark-test-other",
  actantId: "bookmark-test-other-actant",
};
const token = (who: { principalId: string }) =>
  createHash("sha256")
    .update("bookmark-interactions:" + who.principalId)
    .digest("hex");
export type BookmarkHttpRead = {
  path: string;
  query: string;
  method: string;
  status: number;
  body: unknown;
  response: unknown;
  headers: Record<string, string>;
};
export type SavedBookmarkCommand = { commandId: string; operation: unknown };
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
function storage(
  rows: Map<string, string>,
  shouldFail: (value: string) => boolean,
): Storage {
  return {
    get length() {
      return rows.size;
    },
    clear() {
      rows.clear();
    },
    key(i) {
      return [...rows.keys()][i] ?? null;
    },
    getItem(key) {
      return rows.get(key) ?? null;
    },
    setItem(key, value) {
      if (shouldFail(value)) throw Error("TEST success clear storage failure");
      rows.set(key, value);
    },
    removeItem(key) {
      rows.delete(key);
    },
  };
}

// Full useWorkspace SSR Client -> real HTTP/Application/Identity/Platform/Browser
// SQLite. Holds/losses occur only after a genuine authorized 200 response. The
// domain fixture's controlled Runtime ports are never invoked by these tests.
export async function withBookmarkHttp(
  name: string,
  run: (context: {
    readonly client: WorkspaceClient;
    reads: BookmarkHttpRead[];
    rows: Map<string, string>;
    login(other?: boolean): Promise<void>;
    remount(): Promise<void>;
    reopen(): Promise<void>;
    revoke(): Promise<void>;
    failClear(enabled: boolean): void;
    loseNext(): void;
    holdNext(): { reached: Promise<void>; release(): void };
    sql(): {
      bookmarks: Record<string, unknown>[];
      receipts: Record<string, unknown>[];
    };
  }) => Promise<void>,
) {
  const fixture = await agentDomainFixture({
    additionalHumans: [bookmarkHuman, otherBookmarkHuman],
    loginTokenForHuman: token,
  });
  const descriptors = [
    "window",
    "location",
    "localStorage",
    "sessionStorage",
  ].map((name) => ({
    name,
    descriptor: Object.getOwnPropertyDescriptor(globalThis, name),
  }));
  const nativeFetch = globalThis.fetch;
  const reads: BookmarkHttpRead[] = [],
    rows = new Map<string, string>();
  const sessionRows = new Map([[applicationWindowKey, draftOwner]]);
  const releases: (() => void)[] = [];
  let server: ReturnType<typeof createAppServer> | undefined,
    client: WorkspaceClient | undefined,
    cookies = "",
    clearFailure = false,
    intercept:
      | { loss?: boolean; reached?: () => void; pending?: Promise<void> }
      | undefined;
  const sql = () => {
    const db = new DatabaseSync(join(fixture.directory, "browser.sqlite"), {
      readOnly: true,
    });
    try {
      return {
        bookmarks: db
          .prepare("SELECT * FROM bookmarks ORDER BY bookmark_id")
          .all() as Record<string, unknown>[],
        receipts: db
          .prepare(
            "SELECT * FROM bookmark_command_receipts ORDER BY command_id",
          )
          .all() as Record<string, unknown>[],
      };
    } finally {
      db.close();
    }
  };
  let port = 0;
  const start = async () => {
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
    await new Promise<void>((done) => server!.listen(port, "127.0.0.1", done));
  };
  const closeServer = async () => {
    if (!server) return;
    const owned = server;
    server = undefined;
    owned.closeIdleConnections();
    await new Promise<void>((done, reject) =>
      owned.close((error) => (error ? reject(error) : done())),
    );
  };
  const login = async (other = false) => {
    assert(client);
    if (client.getSnapshot()) await client.logout();
    await client.login(token(other ? otherBookmarkHuman : bookmarkHuman));
  };
  try {
    const probe = probePort();
    await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
    port = (probe.address() as { port: number }).port;
    await new Promise<void>((done) => probe.close(() => done()));
    assert.notEqual(port, 65421);
    let origin = "http://127.0.0.1:" + port;
    await start();
    globalThis.fetch = async (input, init) => {
      assert.equal(typeof input, "string");
      const url = new URL(input as string, origin);
      assert.equal(url.origin, origin, "no external or business HTTP requests");
      const headers = new Headers(init?.headers);
      if (cookies) headers.set("Cookie", cookies);
      if (init?.method === "POST") headers.set("Origin", origin);
      const response = await nativeFetch(url, { ...init, headers });
      const cookie = response.headers.get("set-cookie");
      if (cookie) cookies = cookie.split(";")[0]!;
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : null;
      const value: unknown = await response.clone().json();
      reads.push({
        path: url.pathname,
        query: url.search,
        method: init?.method ?? "GET",
        status: response.status,
        body,
        response: value,
        headers: Object.fromEntries(headers),
      });
      if (url.pathname === "/api/bookmarks/commands" && intercept) {
        const held = intercept;
        intercept = undefined;
        assert.equal(
          response.status,
          200,
          "receipt interception follows real server commit",
        );
        held.reached?.();
        if (held.pending) await held.pending;
        if (held.loss) throw Error("TEST lost authorized bookmark receipt");
      }
      return response;
    };
    for (const [name, value] of Object.entries({
      window: {},
      location: { origin },
      localStorage: storage(rows, (value) => clearFailure && value === "null"),
      sessionStorage: storage(sessionRows, () => false),
    }))
      Object.defineProperty(globalThis, name, { configurable: true, value });
    client = actualClient();
    assert.equal(reads.length, 0, "SSR construction does not issue requests");
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
      async reopen() {
        assert(client);
        await client.logout();
        await closeServer();
        await fixture.reopen();
        // A fresh owned origin avoids reusing an HTTP pool socket from the
        // closed server; the persisted center/Human/window scope is unchanged.
        const probe = probePort();
        await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
        port = (probe.address() as { port: number }).port;
        await new Promise<void>((done) => probe.close(() => done()));
        assert.notEqual(port, 65421);
        origin = "http://127.0.0.1:" + port;
        Object.defineProperty(globalThis, "location", {
          configurable: true,
          value: { origin },
        });
        cookies = "";
        await start();
        client = actualClient();
        await login();
      },
      async revoke() {
        assert(fixture.identity);
        await fixture.identity.replaceConfiguration({
          version: 1,
          members: [localAccess, bookmarkHuman, otherBookmarkHuman].map(
            (who) => ({
              ...who,
              enabled: who.principalId !== bookmarkHuman.principalId,
              loginTokenHash: createHash("sha256")
                .update(token(who))
                .digest("hex"),
            }),
          ),
        });
      },
      failClear(enabled) {
        clearFailure = enabled;
      },
      loseNext() {
        assert.equal(intercept, undefined);
        intercept = { loss: true };
      },
      holdNext() {
        assert.equal(intercept, undefined);
        let reached!: () => void, release!: () => void;
        let deadline!: ReturnType<typeof setTimeout>;
        const reachedPromise = new Promise<void>((done, reject) => {
          deadline = setTimeout(
            () => reject(Error("TEST HTTP commit phase not reached")),
            2500,
          );
          reached = () => {
            clearTimeout(deadline);
            done();
          };
        });
        const pending = new Promise<void>((done) => {
          release = () => {
            clearTimeout(deadline);
            done();
          };
        });
        intercept = { reached, pending };
        releases.push(release);
        return { reached: reachedPromise, release };
      },
      sql,
    });
    fixture.assertNoLegacyData();
    assert.equal(
      fixture.transport.runtimeState(),
      null,
      "bookmarks do not start Runtime",
    );
    const evidence = process.env.MORPHZ_TEST_BOOKMARK_EVIDENCE_DIR;
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      writeFileSync(
        join(evidence, name + "-http-ledger.json"),
        JSON.stringify(
          {
            reads,
            storage: [...rows],
            sessionStorage: [...sessionRows],
            sql: sql(),
          },
          null,
          2,
        ),
      );
    }
    console.log(
      JSON.stringify({
        bookmarkHttp: name,
        requests: reads.length,
        commands: reads.filter((r) => r.path === "/api/bookmarks/commands")
          .length,
        sqlReceipts: sql().receipts.length,
        ledgerSha256: createHash("sha256")
          .update(JSON.stringify({ reads, storage: [...rows], sql: sql() }))
          .digest("hex"),
      }),
    );
  } finally {
    for (const release of releases) release();
    globalThis.fetch = nativeFetch;
    for (const { name, descriptor } of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    try {
      await closeServer();
    } finally {
      await fixture.close();
    }
    assert.equal(
      existsSync(fixture.directory),
      false,
      "only owned SQLite directory removed",
    );
  }
}
