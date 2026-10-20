import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer as portProbe } from "node:http";
import test from "node:test";
import {
  ActualMountedClient,
  mountedClientWebRoot,
} from "./fixtures/actual-mounted-client-test.js";
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
type Hold = Awaited<ReturnType<ActualMountedClient["hold"]>>;
type Read = { url: URL; method: string; status: number; headers: Headers };
async function withActualReader(
  run: (context: {
    client: ActualMountedClient;
    contentId: string;
    section: ReadingSection;
    markId: string;
    reads(): Promise<Read[]>;
    hold(path: string): Promise<Hold>;
    access(enabled: boolean): Promise<void>;
  }) => Promise<void>,
) {
  const web = await mountedClientWebRoot();
  const fixture = await agentDomainFixture({
    additionalHumans: [reader],
    loginTokenForHuman: tokenFor,
  }).catch((error) => {
    web.close();
    throw error;
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
    cognitiveApps: fixture.domains.cognitiveApps,
    workspaceChanges: fixture.domains.workspaceChanges,
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
  let client: ActualMountedClient | undefined;
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
      webRoot: web.directory,
    });
    await new Promise<void>((done) => server!.listen(port, "127.0.0.1", done));
    client = await ActualMountedClient.open(origin);
    const reads = async (): Promise<Read[]> =>
      (await client!.control("reads")).map(
        (row: {
          url: string;
          method: string;
          status: number;
          headers: Array<[string, string]>;
        }) => ({
          ...row,
          url: new URL(row.url),
          headers: new Headers(row.headers),
        }),
      );
    await client.call("login", [tokenFor(reader)]);
    await client.waitReady(reader.principalId);
    const hold = (path: string) => client!.hold(path);
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
    try {
      await client?.close();
    } finally {
      try {
        if (server) {
          server.closeAllConnections();
          await new Promise<void>((done) => server!.close(() => done()));
        }
      } finally {
        try {
          await fixture.close();
        } finally {
          web.close();
        }
      }
    }
  }
}

test("actual Client four Reader methods reach original authorized HTTP routes and normalize exact-version private facts", async () => {
  await withActualReader(
    async ({ client, contentId, section, markId, reads }) => {
      await client.control("clearReads");
      const before = await client.snapshot("before"),
        signal = new AbortController().signal;
      assert.ok(before);
      const contents = await client.call("readingContents", [
        contentId,
        1,
        signal,
      ]);
      assert.equal(contents[0]!.id, section.id);
      const actual = await client.call("readReading", [
        contentId,
        1,
        section.id,
        signal,
      ]);
      assert.equal(actual.text, section.text);
      const state = await client.call("readingState", [contentId, 1, signal]);
      assert.equal(state.position?.ownerPrincipalId, reader.principalId);
      assert.equal(state.position?.artifactId, contentId);
      assert.equal(state.position?.artifactRevision, 1);
      assert.equal(state.position?.preferences.fontSize, 22);
      const marks = await client.call("readingMarks", [
        {
          artifactId: contentId,
          revision: 1,
          sectionId: section.id,
          start: 0,
          end: section.text.length,
          limit: 50,
        },
        signal,
      ]);
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
        (await reads()).map((read) => [
          read.method,
          read.url.pathname,
          read.status,
        ]),
        [
          ["GET", "/api/reader/contents", 200],
          ["GET", "/api/reader/section", 200],
          ["GET", "/api/reader/state", 200],
          ["GET", "/api/reader/marks", 200],
        ],
      );
      for (const read of await reads()) {
        assert.equal(read.url.searchParams.get("artifactId"), contentId);
        assert.equal(read.url.searchParams.get("revision"), "1");
        assert.equal(
          read.headers.get(applicationTokenHeader),
          before.csrfToken,
        );
      }
      assert.equal(
        await client.control("sameSnapshot", "before"),
        true,
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
          (signal: AbortSignal) =>
            client.call("readingContents", [contentId, 1, signal]),
        ],
        [
          "/api/reader/section",
          (signal: AbortSignal) =>
            client.call("readReading", [contentId, 1, section.id, signal]),
        ],
        [
          "/api/reader/state",
          (signal: AbortSignal) =>
            client.call("readingState", [contentId, 1, signal]),
        ],
        [
          "/api/reader/marks",
          (signal: AbortSignal) =>
            client.call("readingMarks", [
              { artifactId: contentId, revision: 1 },
              signal,
            ]),
        ],
      ] as const;
      for (const [path, invoke] of methods) {
        await client.control("clearReads");
        const alreadyAborted = new AbortController();
        alreadyAborted.abort();
        await assert.rejects(
          invoke(alreadyAborted.signal),
          (error: unknown) =>
            error instanceof Error && error.name === "AbortError",
        );
        assert.equal((await reads()).length, 0);
        const abort = new AbortController(),
          held = await hold(path);
        await client.snapshot("snapshot");
        const outcome = invoke(abort.signal).then(
          (value) => ({ value, error: undefined }),
          (error: unknown) => ({ value: undefined, error }),
        );
        await Promise.race([
          held.reached(),
          outcome.then((value) => {
            throw new Error("authorized read did not reach hold", {
              cause: value.error,
            });
          }),
        ]);
        abort.abort();
        await held.release();
        const result = await outcome;
        assert.equal(result.value, undefined);
        assert.ok(
          result.error instanceof Error && result.error.name === "AbortError",
        );
        assert.equal(await client.control("sameSnapshot", "snapshot"), true);
        assert.deepEqual(
          (await reads()).map((read) => [read.url.pathname, read.status]),
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
          () => client.call("readReading", [contentId, 1, section.id]),
        ],
        [
          "/api/reader/state",
          () => client.call("readingState", [contentId, 1]),
        ],
      ] as const) {
        const csrf = (await client.snapshot())!.csrfToken,
          held = await hold(path);
        const outcome = invoke().then(
          (value) => ({ value, error: undefined }),
          (error: unknown) => ({ value: undefined, error }),
        );
        await Promise.race([
          held.reached(),
          outcome.then((value) => {
            throw new Error("authorized read did not reach hold", {
              cause: value.error,
            });
          }),
        ]);
        await access(false);
        assert.equal(await client.call("refresh", []), true);
        assert.equal((await client.snapshot())!.csrfToken, csrf);
        await access(true);
        assert.equal(await client.call("refresh", []), true);
        await client.snapshot("snapshot");
        await held.release();
        const result = await outcome;
        assert.equal(result.value, undefined);
        assert.ok(result.error instanceof Error);
        assert.match(result.error.message, /阅读权限已变化/);
        assert.equal(await client.control("sameSnapshot", "snapshot"), true);
        assert.equal((await client.snapshot())!.csrfToken, csrf);
      }
    },
  );
});
