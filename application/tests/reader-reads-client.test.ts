import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer as portProbe } from "node:http";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { useWorkspace, type WorkspaceClient } from "../apps/web/src/client.js";
import { createAppServer } from "../apps/service/src/http.js";
import {
  Application,
  invokeApplication,
} from "../packages/application/src/application.js";
import { applicationTokenHeader } from "../packages/core/src/application-names.js";
import type { ApplicationMethod } from "../packages/core/src/application-api.js";
import { localAccess } from "../packages/core/src/model.js";
import type { ReadingSection } from "../packages/core/src/reader.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";

const reader = {
  principalId: "reader-query-human",
  actantId: "reader-query-actant",
};
const tokenFor = (human: { principalId: string }) =>
  createHash("sha256")
    .update("reader-query-" + human.principalId)
    .digest("hex");
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}
function actualClient() {
  let client: WorkspaceClient | undefined;
  function Probe() {
    client = useWorkspace();
    return createElement("span");
  }
  // Actual Client refs/functions, not a fake Client. SSR does not run effects;
  // this proves HTTP/SQLite reads, not mounted UI, Electron or model behavior.
  renderToString(createElement(Probe));
  assert.ok(client);
  return client;
}
type Hold = { reached: Promise<void>; release(): void };
type Read = { url: URL; method: string; status: number; headers: Headers };
async function withActualReader(
  run: (context: {
    client: WorkspaceClient;
    contentId: string;
    section: ReadingSection;
    markId: string;
    reads: Read[];
    hold(path: string): Hold;
    access(enabled: boolean): Promise<void>;
  }) => Promise<void>,
) {
  const fixture = await agentDomainFixture({
    additionalHumans: [reader],
    loginTokenForHuman: tokenFor,
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
  const call = (
    who: typeof localAccess,
    method: ApplicationMethod,
    params: unknown,
  ) =>
    invokeApplication(
      app.session(who),
      method,
      params,
      "reader-query-test-human",
      new AbortController().signal,
    );
  const nativeFetch = globalThis.fetch;
  const globals = new Map(
    ["window", "location", "localStorage", "sessionStorage"].map(
      (name) =>
        [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
    ),
  );
  const holds: Hold[] = [];
  let server: ReturnType<typeof createAppServer> | undefined;
  try {
    const created = (await call(localAccess, "documents.create", {
      commandId: randomUUID(),
      objectId: randomUUID(),
      projectId: fixture.projectId,
      title: "TEST Reader query exact original",
      markdown: "# 章节\n\n真实 Reader 原文与私有位置标注。",
    })) as { contentId: string };
    const contentId = created.contentId;
    const access = async (enabled: boolean) => {
      await fixture.domains.content.platform.reconcileOperatorMembers(
        fixture.transport.identity(),
        [
          { ...localAccess, enabled: true, projectIds: [] },
          {
            ...reader,
            enabled: true,
            projectIds: enabled ? [fixture.projectId] : [],
          },
        ],
      );
    };
    await access(true);
    const contents = (await call(reader, "reader.contents", {
      artifactId: contentId,
      revision: 1,
    })) as Array<{ id: string }>;
    const section = (await call(reader, "reader.read", {
      artifactId: contentId,
      revision: 1,
      sectionId: contents[0]!.id,
    })) as ReadingSection;
    const start = section.text.indexOf("真实 Reader 原文");
    assert.ok(start >= 0);
    const location = {
      sourceId: section.sourceId,
      sectionId: section.id,
      start,
      end: start + 7,
    };
    const marked = (await call(reader, "reader.command", {
      commandId: randomUUID(),
      artifactId: contentId,
      revision: 1,
      command: {
        action: "mark-add",
        artifactId: contentId,
        artifactRevision: 1,
        location,
        quote: section.text.slice(location.start, location.end),
        kind: "note",
        color: "green",
        note: "真实私库批注",
      },
    })) as { id: string };
    await call(reader, "reader.command", {
      commandId: randomUUID(),
      artifactId: contentId,
      revision: 1,
      command: {
        action: "save-position",
        artifactId: contentId,
        artifactRevision: 1,
        location,
        preferences: { fontSize: 22, font: "sans", theme: "paper" },
        expectedRevision: 0,
      },
    });
    const probe = portProbe();
    await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((done) => probe.close(() => done()));
    assert.notEqual(port, 65421, "never the shared application service");
    const origin = "http://127.0.0.1:" + port;
    server = createAppServer(fixture.transport, {
      ...options,
      port,
      webRoot: "/nonexistent",
    });
    await new Promise<void>((done) => server!.listen(port, "127.0.0.1", done));
    const reads: Read[] = [];
    let cookies = "",
      interception:
        { path: string; reached(): void; pending: Promise<void> } | undefined;
    globalThis.fetch = async (input, init) => {
      assert.equal(typeof input, "string");
      const url = new URL(input as string, origin);
      assert.equal(
        url.origin,
        origin,
        "only isolated real HTTP/SQLite host, never Runtime/model or remote service",
      );
      const headers = new Headers(init?.headers);
      if (cookies) headers.set("Cookie", cookies);
      if (init?.method === "POST") headers.set("Origin", origin);
      const response = await nativeFetch(url, { ...init, headers });
      const cookie = response.headers.get("set-cookie");
      if (cookie) cookies = cookie.split(";")[0]!;
      reads.push({
        url,
        method: init?.method ?? "GET",
        status: response.status,
        headers,
      });
      if (interception?.path === url.pathname) {
        const held = interception;
        interception = undefined;
        assert.equal(
          response.status,
          200,
          "hold an actually authorized read, not a fabricated response",
        );
        held.reached();
        await held.pending;
      }
      return response;
    };
    for (const [name, value] of Object.entries({
      window: {},
      location: { origin },
      localStorage: memoryStorage(),
      sessionStorage: memoryStorage(),
    }))
      Object.defineProperty(globalThis, name, { configurable: true, value });
    const client = actualClient();
    assert.equal(reads.length, 0, "Client/family construction is inert");
    await client.login(tokenFor(reader));
    const hold = (path: string): Hold => {
      assert.equal(interception, undefined);
      let reached!: () => void, release!: () => void;
      const reachedPromise = new Promise<void>((done) => {
        reached = done;
      });
      const pending = new Promise<void>((done) => {
        release = done;
      });
      interception = { path, reached, pending };
      const held = { reached: reachedPromise, release };
      holds.push(held);
      return held;
    };
    await run({
      client,
      contentId,
      section,
      markId: marked.id,
      reads,
      hold,
      access,
    });
    fixture.assertNoLegacyData();
  } finally {
    for (const hold of holds) hold.release();
    globalThis.fetch = nativeFetch;
    for (const [name, descriptor] of globals) {
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
test("actual Client four Reader methods reach original authorized HTTP routes and normalize exact-version private facts", async () => {
  await withActualReader(
    async ({ client, contentId, section, markId, reads }) => {
      reads.length = 0;
      const before = client.getSnapshot(),
        signal = new AbortController().signal;
      assert.ok(before);
      const contents = await client.readingContents(contentId, 1, signal);
      assert.equal(contents[0]!.id, section.id);
      const actual = await client.readReading(contentId, 1, section.id, signal);
      assert.equal(actual.text, section.text);
      const state = await client.readingState(contentId, 1, signal);
      assert.equal(state.position?.ownerPrincipalId, reader.principalId);
      assert.equal(state.position?.artifactId, contentId);
      assert.equal(state.position?.artifactRevision, 1);
      assert.equal(state.position?.preferences.fontSize, 22);
      const marks = await client.readingMarks(
        {
          artifactId: contentId,
          revision: 1,
          sectionId: section.id,
          start: 0,
          end: section.text.length,
          limit: 50,
        },
        signal,
      );
      assert.deepEqual(
        marks.marks.map((mark) => [
          mark.id,
          mark.artifactId,
          mark.artifactRevision,
          mark.ownerPrincipalId,
        ]),
        [[markId, contentId, 1, reader.principalId]],
      );
      assert.deepEqual([marks.nextCursor, marks.hasMore], [null, false]);
      assert.deepEqual(
        reads.map((read) => [read.method, read.url.pathname, read.status]),
        [
          ["GET", "/api/reader/contents", 200],
          ["GET", "/api/reader/section", 200],
          ["GET", "/api/reader/state", 200],
          ["GET", "/api/reader/marks", 200],
        ],
      );
      for (const read of reads) {
        assert.equal(read.url.searchParams.get("artifactId"), contentId);
        assert.equal(read.url.searchParams.get("revision"), "1");
        assert.equal(
          read.headers.get(applicationTokenHeader),
          before.csrfToken,
        );
      }
      assert.equal(
        client.getSnapshot(),
        before,
        "none of the four queries publishes Boot/current",
      );
    },
  );
});
test("actual shared transport cancels all four Reader methods before dispatch and after an authorized response", async () => {
  await withActualReader(
    async ({ client, contentId, section, reads, hold }) => {
      const methods = [
        [
          "/api/reader/contents",
          (signal: AbortSignal) => client.readingContents(contentId, 1, signal),
        ],
        [
          "/api/reader/section",
          (signal: AbortSignal) =>
            client.readReading(contentId, 1, section.id, signal),
        ],
        [
          "/api/reader/state",
          (signal: AbortSignal) => client.readingState(contentId, 1, signal),
        ],
        [
          "/api/reader/marks",
          (signal: AbortSignal) =>
            client.readingMarks({ artifactId: contentId, revision: 1 }, signal),
        ],
      ] as const;
      for (const [path, invoke] of methods) {
        reads.length = 0;
        const alreadyAborted = new AbortController();
        alreadyAborted.abort();
        await assert.rejects(
          invoke(alreadyAborted.signal),
          (error: unknown) =>
            error instanceof Error && error.name === "AbortError",
        );
        assert.equal(reads.length, 0);
        const abort = new AbortController(),
          held = hold(path),
          snapshot = client.getSnapshot();
        const outcome = invoke(abort.signal).then(
          (value) => ({ value, error: undefined }),
          (error: unknown) => ({ value: undefined, error }),
        );
        await Promise.race([
          held.reached,
          outcome.then((value) => {
            throw new Error("authorized read did not reach hold", {
              cause: value.error,
            });
          }),
        ]);
        abort.abort();
        held.release();
        const result = await outcome;
        assert.equal(result.value, undefined);
        assert.ok(
          result.error instanceof Error && result.error.name === "AbortError",
        );
        assert.equal(client.getSnapshot(), snapshot);
        assert.deepEqual(
          reads.map((read) => [read.url.pathname, read.status]),
          [[path, 200]],
        );
      }
    },
  );
});
test("actual Client section/state reads reject same-CSRF revoke/regrant completion without publishing old facts", async () => {
  await withActualReader(
    async ({ client, contentId, section, hold, access }) => {
      for (const [path, invoke] of [
        [
          "/api/reader/section",
          () => client.readReading(contentId, 1, section.id),
        ],
        ["/api/reader/state", () => client.readingState(contentId, 1)],
      ] as const) {
        const csrf = client.getSnapshot()!.csrfToken,
          held = hold(path);
        const outcome = invoke().then(
          (value) => ({ value, error: undefined }),
          (error: unknown) => ({ value: undefined, error }),
        );
        await Promise.race([
          held.reached,
          outcome.then((value) => {
            throw new Error("authorized read did not reach hold", {
              cause: value.error,
            });
          }),
        ]);
        await access(false);
        assert.equal(await client.refresh(), true);
        assert.equal(client.getSnapshot()!.csrfToken, csrf);
        await access(true);
        assert.equal(await client.refresh(), true);
        const snapshot = client.getSnapshot();
        held.release();
        const result = await outcome;
        assert.equal(result.value, undefined);
        assert.ok(result.error instanceof Error);
        assert.match(result.error.message, /阅读权限已变化/);
        assert.equal(client.getSnapshot(), snapshot);
        assert.equal(client.getSnapshot()!.csrfToken, csrf);
      }
    },
  );
});
