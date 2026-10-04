import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer as probePort } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  useWorkspace,
  type WorkspaceClient,
} from "../../apps/web/src/client.js";
import { createAppServer } from "../../apps/service/src/http.js";
import {
  Application,
  invokeApplication,
} from "../../packages/application/src/application.js";
import type { ApplicationMethod } from "../../packages/core/src/application-api.js";
import { localAccess } from "../../packages/core/src/model.js";
import type { ReadingSection } from "../../packages/core/src/reader.js";
import { agentDomainFixture } from "../agent-domain-fixture.js";

export const readerActor = {
  principalId: "reader-interaction-human",
  actantId: "reader-interaction-actant",
};
export const otherReader = {
  principalId: "reader-interaction-other",
  actantId: "reader-interaction-other-actant",
};
const token = (who: { principalId: string }) =>
  createHash("sha256")
    .update("reader-interaction-" + who.principalId)
    .digest("hex");
export type ReaderHttpRead = {
  path: string;
  method: string;
  status: number;
  headers: Headers;
  body: unknown;
  response: unknown;
};
function storage(): Storage {
  const rows = new Map<string, string>();
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
      rows.set(key, value);
    },
    removeItem(key) {
      rows.delete(key);
    },
  };
}
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

// Actual Client refs and actual HTTP/Platform/Reader SQLite. Only transport
// receipt loss/holds are injected after genuine server replies. No Runtime or
// OCR provider is executed, and no production center/profile is opened.
export async function withReaderInteractions(
  run: (context: {
    client: WorkspaceClient;
    contentId: string;
    section: ReadingSection;
    reads: ReaderHttpRead[];
    login(other?: boolean): Promise<void>;
    access(enabled: boolean): Promise<void>;
    loseNext(path: string): void;
    holdNext(path: string): { reached: Promise<void>; release(): void };
    receiptCount(kind: "import" | "command", commandId: string): number;
  }) => Promise<void>,
) {
  const fixture = await agentDomainFixture({
    additionalHumans: [readerActor, otherReader],
    loginTokenForHuman: token,
  });
  const options = {
    identity: fixture.identity,
    platformWork: fixture.domains.work,
    platformDocuments: fixture.domains.content,
    platformScripts: fixture.domains.content,
    platformReader: fixture.domains.reader,
    bookmarkDomain: fixture.domains.browser,
    messageAttachments: fixture.domains.messageAttachments,
    uiPackages: fixture.domains.uiPackages,
    notifications: fixture.domains.notifications,
  };
  const app = new Application(fixture.transport, options);
  const call = (method: ApplicationMethod, params: unknown) =>
    invokeApplication(
      app.session(localAccess),
      method,
      params,
      "reader-interaction-test",
      new AbortController().signal,
    );
  const nativeFetch = globalThis.fetch,
    descriptors = new Map(
      ["window", "location", "localStorage", "sessionStorage"].map(
        (name) =>
          [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
      ),
    );
  let server: ReturnType<typeof createAppServer> | undefined,
    intercept:
      | {
          path: string;
          loss?: boolean;
          reached?: () => void;
          pending?: Promise<void>;
        }
      | undefined;
  const releases: (() => void)[] = [];
  try {
    const created = (await call("documents.create", {
      commandId: randomUUID(),
      objectId: randomUUID(),
      projectId: fixture.projectId,
      title: "TEST Reader real interactions",
      markdown: "# 原章节\n\n真实私有阅读位置与精确标注。",
    })) as { contentId: string };
    const access = async (enabled: boolean) =>
      fixture.domains.content.platform.reconcileOperatorMembers(
        fixture.transport.identity(),
        [
          { ...localAccess, enabled: true, projectIds: [] },
          {
            ...readerActor,
            enabled: true,
            projectIds: enabled ? [fixture.projectId] : [],
          },
          { ...otherReader, enabled: true, projectIds: [fixture.projectId] },
        ],
      );
    await access(true);
    const probe = probePort();
    await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((done) => probe.close(() => done()));
    assert.notEqual(port, 65421);
    const origin = "http://127.0.0.1:" + port;
    server = createAppServer(fixture.transport, {
      ...options,
      port,
      webRoot: "/nonexistent",
    });
    await new Promise<void>((done) => server!.listen(port, "127.0.0.1", done));
    const reads: ReaderHttpRead[] = [];
    let cookies = "";
    globalThis.fetch = async (input, init) => {
      assert.equal(typeof input, "string");
      const url = new URL(input as string, origin);
      assert.equal(url.origin, origin, "only test-owned HTTP/SQLite host");
      const headers = new Headers(init?.headers);
      if (cookies) headers.set("Cookie", cookies);
      if (init?.method === "POST") headers.set("Origin", origin);
      const response = await nativeFetch(url, { ...init, headers });
      const cookie = response.headers.get("set-cookie");
      if (cookie) cookies = cookie.split(";")[0]!;
      let body: unknown = null;
      if (typeof init?.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      let value: unknown = null;
      try {
        value = await response.clone().json();
      } catch {
        /* Binary is not a receipt. */
      }
      reads.push({
        path: url.pathname,
        method: init?.method ?? "GET",
        status: response.status,
        headers,
        body,
        response: value,
      });
      if (intercept?.path === url.pathname) {
        const held = intercept;
        intercept = undefined;
        assert.equal(
          response.status,
          url.pathname === "/api/import/reading" ? 201 : 200,
          "inject only after the genuine authorized endpoint receipt",
        );
        held.reached?.();
        if (held.pending) await held.pending;
        if (held.loss) throw Error("TEST lost authorized receipt");
      }
      return response;
    };
    for (const [name, value] of Object.entries({
      window: {},
      location: { origin },
      localStorage: storage(),
      sessionStorage: storage(),
    }))
      Object.defineProperty(globalThis, name, { configurable: true, value });
    const client = actualClient();
    assert.equal(reads.length, 0, "actual Client construction is inert");
    const login = async (other = false) => {
      if (client.getSnapshot()) await client.logout();
      await client.login(token(other ? otherReader : readerActor));
    };
    await login();
    const contents = await client.readingContents(created.contentId, 1);
    const section = await client.readReading(
      created.contentId,
      1,
      contents[0]!.id,
    );
    await run({
      client,
      contentId: created.contentId,
      section,
      reads,
      login,
      access: async (enabled) => {
        await access(enabled);
      },
      loseNext(path) {
        assert.equal(intercept, undefined);
        intercept = { path, loss: true };
      },
      holdNext(path) {
        assert.equal(intercept, undefined);
        let reached!: () => void, release!: () => void;
        const reachedPromise = new Promise<void>((done) => {
            reached = done;
          }),
          pending = new Promise<void>((done) => {
            release = done;
          });
        intercept = { path, reached, pending };
        releases.push(release);
        return { reached: reachedPromise, release };
      },
      receiptCount(kind, commandId) {
        const database = new DatabaseSync(
          join(fixture.directory, "reader.sqlite"),
          {
            readOnly: true,
          },
        );
        try {
          const table =
            kind === "import"
              ? "reader_book_events"
              : "reader_command_receipts";
          return Number(
            database
              .prepare(
                `SELECT count(*) AS count FROM ${table} WHERE command_id=?`,
              )
              .get(commandId)!.count,
          );
        } finally {
          database.close();
        }
      },
    });
    fixture.assertNoLegacyData();
  } finally {
    for (const release of releases) release();
    globalThis.fetch = nativeFetch;
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    if (server) {
      server.closeIdleConnections();
      await new Promise<void>((done, reject) =>
        server!.close((error) => (error ? reject(error) : done())),
      );
    }
    await fixture.close();
  }
}
