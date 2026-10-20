import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer as probePort } from "node:http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createAppServer } from "../../apps/service/src/http.js";
import { localAccess } from "../../packages/core/src/model.js";
import { agentDomainFixture } from "../agent-domain-fixture.js";
import {
  ActualMountedClient,
  mountedClientWebRoot,
} from "./actual-mounted-client-test.js";

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
  headers: Array<[string, string]>;
};
export type SavedBookmarkCommand = { commandId: string; operation: unknown };

// Actual mounted React Client -> native browser HTTP/cookies/storage -> the
// real Application/Identity/Platform/Browser SQLite. No SSR business owner.
export async function withBookmarkHttp(
  name: string,
  run: (context: {
    readonly client: ActualMountedClient;
    reads(): Promise<BookmarkHttpRead[]>;
    rows(): Promise<Record<string, string>>;
    login(other?: boolean): Promise<void>;
    remount(): Promise<void>;
    reopen(): Promise<void>;
    revoke(): Promise<void>;
    failClear(enabled: boolean): Promise<void>;
    loseNext(): Promise<void>;
    holdNext(): ReturnType<ActualMountedClient["hold"]>;
    sql(): {
      bookmarks: Record<string, unknown>[];
      receipts: Record<string, unknown>[];
    };
  }) => Promise<void>,
) {
  const web = await mountedClientWebRoot();
  let fixture: Awaited<ReturnType<typeof agentDomainFixture>>;
  try {
    fixture = await agentDomainFixture({
      additionalHumans: [bookmarkHuman, otherBookmarkHuman],
      loginTokenForHuman: token,
    });
  } catch (error) {
    web.close();
    throw error;
  }
  let server: ReturnType<typeof createAppServer> | undefined;
  let client: ActualMountedClient | undefined;
  let port = 0;
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
      cognitiveApps: fixture.domains.cognitiveApps,
      workspaceChanges: fixture.domains.workspaceChanges,
      port,
      webRoot: web.directory,
    });
    await new Promise<void>((done) => server!.listen(port, "127.0.0.1", done));
  };
  const closeServer = async () => {
    if (!server) return;
    const owned = server;
    server = undefined;
    owned.closeAllConnections();
    await new Promise<void>((done, reject) =>
      owned.close((error) => (error ? reject(error) : done())),
    );
  };
  const login = async (other = false) => {
    assert(client);
    if (await client.snapshot()) await client.call("logout");
    const human = other ? otherBookmarkHuman : bookmarkHuman;
    await client.call("login", [token(human)]);
    await client.waitReady(human.principalId);
  };
  try {
    const probe = probePort();
    await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
    port = (probe.address() as { port: number }).port;
    await new Promise<void>((done) => probe.close(() => done()));
    await start();
    assert(server);
    const address = server.address();
    assert(address && typeof address !== "string");
    port = address.port;
    client = await ActualMountedClient.open("http://127.0.0.1:" + port);
    await login();
    const reads = async () =>
      client!.control("reads") as Promise<BookmarkHttpRead[]>;
    const rows = async () =>
      client!.control("storage") as Promise<Record<string, string>>;
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
        await client.control("remount");
        await client.waitReady(bookmarkHuman.principalId);
      },
      async reopen() {
        assert(client);
        await client.call("logout");
        await client.control("unmount");
        await closeServer();
        await fixture.reopen();
        // Reopen the SQLite owners on the same isolated origin; native
        // browser cookies/storage keep their real production semantics.
        await start();
        await client.control("mount");
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
      failClear: (enabled) => client!.control("failStorageClear", enabled),
      loseNext: () => client!.control("loseNext", "/api/bookmarks/commands"),
      holdNext: () => client!.hold("/api/bookmarks/commands"),
      sql,
    });
    fixture.assertNoLegacyData();
    assert.equal(
      fixture.transport.runtimeState(),
      null,
      "bookmarks do not start Runtime",
    );
    const ledger = { reads: await reads(), storage: await rows(), sql: sql() };
    const evidence = process.env.MORPHZ_TEST_BOOKMARK_EVIDENCE_DIR;
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      writeFileSync(
        join(evidence, name + "-http-ledger.json"),
        JSON.stringify(ledger, null, 2),
      );
    }
    console.log(
      JSON.stringify({
        bookmarkHttp: name,
        requests: ledger.reads.length,
        commands: ledger.reads.filter(
          (r) => r.path === "/api/bookmarks/commands",
        ).length,
        sqlReceipts: ledger.sql.receipts.length,
        ledgerSha256: createHash("sha256")
          .update(JSON.stringify(ledger))
          .digest("hex"),
      }),
    );
  } finally {
    try {
      await client?.close();
    } finally {
      try {
        await closeServer();
      } finally {
        try {
          await fixture.close();
        } finally {
          web.close();
        }
      }
    }
    assert.equal(
      existsSync(fixture.directory),
      false,
      "only owned SQLite directory removed",
    );
  }
}
