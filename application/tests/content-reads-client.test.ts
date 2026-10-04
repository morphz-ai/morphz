import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer as portProbe } from "node:http";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { useWorkspace, type WorkspaceClient } from "../apps/web/src/client.js";
import { platformContentSchema } from "../apps/web/src/platform-client.js";
import { createAppServer } from "../apps/service/src/http.js";
import {
  Application,
  invokeApplication,
} from "../packages/application/src/application.js";
import type { ApplicationMethod } from "../packages/core/src/application-api.js";
import { localAccess } from "../packages/core/src/model.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";

const reader = {
  principalId: "content-query-reader",
  actantId: "content-query-reader-human",
};
const tokenFor = (human: { principalId: string }) =>
  createHash("sha256")
    .update("content-query-" + human.principalId)
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
function actualClient(): WorkspaceClient {
  let client: WorkspaceClient | undefined;
  function Probe() {
    client = useWorkspace();
    return createElement("span");
  }
  // Actual React SSR initializes Client refs/methods only. This is not mounted
  // UI, effect, browser or native acceptance evidence.
  renderToString(createElement(Probe));
  assert.ok(client);
  return client;
}
type Hold = { reached: Promise<void>; release(): void };
type Read = { url: URL; method: string; status: number };
async function withClient(
  run: (context: {
    client: WorkspaceClient;
    contentId: string;
    objectId: string;
    reads: Read[];
    ownerCall(method: ApplicationMethod, params: unknown): Promise<unknown>;
    holdOriginal(verify: (value: unknown) => void): Hold;
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
  const application = new Application(fixture.transport, options);
  const ownerCall = async (method: ApplicationMethod, params: unknown) =>
    invokeApplication(
      application.session(localAccess),
      method,
      params,
      "content-query-test-human",
      new AbortController().signal,
    );
  const originalFetch = globalThis.fetch;
  const globals = new Map(
    ["window", "location", "localStorage", "sessionStorage"].map(
      (name) =>
        [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
    ),
  );
  const holds: Hold[] = [];
  let server: ReturnType<typeof createAppServer> | undefined;
  try {
    const objectId = randomUUID();
    const created = (await ownerCall("documents.create", {
      commandId: randomUUID(),
      objectId,
      projectId: fixture.projectId,
      title: "TEST actual content v1",
      markdown: "原件第一版正文",
    })) as { contentId: string };
    const contentId = created.contentId;
    for (const revision of [1, 2])
      await ownerCall("documents.revise", {
        commandId: randomUUID(),
        contentId,
        expectedRevision: revision,
        title: "TEST actual content v" + (revision + 1),
        markdown: "原件第" + (revision + 1) + "版正文",
      });
    await fixture.domains.content.platform.reconcileOperatorMembers(
      fixture.transport.identity(),
      [
        { ...localAccess, enabled: true, projectIds: [] },
        { ...reader, enabled: true, projectIds: [fixture.projectId] },
      ],
    );
    const probe = portProbe();
    await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((done) => probe.close(() => done()));
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
        | {
            verify(value: unknown): void;
            reached(): void;
            pending: Promise<void>;
          }
        | undefined;
    globalThis.fetch = async (input, init) => {
      assert.equal(typeof input, "string");
      const url = new URL(input as string, origin);
      assert.equal(
        url.origin,
        origin,
        "only this private test HTTP/SQLite Host, no model or remote service",
      );
      const headers = new Headers(init?.headers);
      if (cookies) headers.set("Cookie", cookies);
      if (init?.method === "POST") headers.set("Origin", origin);
      const response = await originalFetch(url, { ...init, headers });
      const cookie = response.headers.get("set-cookie");
      if (cookie) cookies = cookie.split(";")[0]!;
      reads.push({
        url,
        method: init?.method ?? "GET",
        status: response.status,
      });
      if (
        interception &&
        url.pathname === "/api/platform/objects/" + contentId
      ) {
        const current = interception;
        interception = undefined;
        assert.equal(
          response.status,
          200,
          "delay an actually authorized original, not a synthetic receipt",
        );
        current.verify(await response.clone().json());
        current.reached();
        await current.pending;
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
    assert.equal(
      reads.length,
      0,
      "constructing the Client does not read content",
    );
    await client.login(tokenFor(reader));
    assert.equal(
      client
        .getSnapshot()!
        .workspace.artifacts.some((value) => value.id === contentId),
      false,
      "cold catalog does not hydrate unopened originals",
    );
    const holdOriginal = (verify: (value: unknown) => void): Hold => {
      assert.equal(interception, undefined);
      let reached!: () => void, release!: () => void;
      const pending = new Promise<void>((done) => {
        release = done;
      });
      const hold = {
        reached: new Promise<void>((done) => {
          reached = done;
        }),
        release,
      };
      interception = { verify, pending, reached };
      holds.push(hold);
      return hold;
    };
    await run({ client, contentId, objectId, reads, ownerCall, holdOriginal });
    fixture.assertNoLegacyData();
  } finally {
    for (const hold of holds) hold.release();
    globalThis.fetch = originalFetch;
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

test("actual Client HTTP/SQLite keeps head and exact historic bytes, version union and live-directory-only fast reuse", async () => {
  await withClient(async ({ client, contentId, objectId, reads }) => {
    reads.length = 0;
    const first = await client.resolveArtifact(contentId, 1);
    assert.ok(first);
    assert.equal(first.id, contentId);
    assert.equal(first.revision, 3);
    assert.equal(
      first.content.kind === "document" && first.content.markdown,
      "原件第3版正文",
    );
    assert.equal(
      first.versions.find((value) => value.revision === 1)?.content.kind,
      "document",
    );
    const initial = first.versions.find((value) => value.revision === 1)!;
    assert.equal(
      initial.content.kind === "document" && initial.content.markdown,
      "原件第一版正文",
    );
    assert.equal(
      client
        .getSnapshot()!
        .workspace.artifacts.find((value) => value.id === contentId),
      first,
    );
    const body = (row: Read) =>
      row.url.pathname === "/api/platform/objects/" + contentId;
    assert.deepEqual(
      reads.filter(body).map((row) => row.url.searchParams.get("revision")),
      [null, "1"],
    );
    assert.ok(reads.every((row) => row.method === "GET" && row.status === 200));
    const second = await client.resolveArtifact(contentId, 2);
    assert.deepEqual(
      second?.versions.map((value) => value.revision),
      [1, 2, 3],
    );
    const historical = second!.versions.find((value) => value.revision === 2)!;
    assert.equal(
      historical.content.kind === "document" && historical.content.markdown,
      "原件第2版正文",
    );
    const before = client.getSnapshot();
    reads.length = 0;
    const reused = await client.resolveArtifact(contentId, 3);
    assert.equal(
      client.getSnapshot(),
      before,
      "fast reuse does not republish Boot",
    );
    assert.notEqual(
      reused,
      second,
      "original fast path returns a metadata copy",
    );
    assert.equal(reused?.content, second?.content);
    assert.equal(reads.filter(body).length, 0);
    assert.equal(
      reads.length,
      1,
      "explicit reuse still performs its one live directory get",
    );
    const entry = platformContentSchema.parse(
      await client.resolveCatalogContent(contentId),
    );
    assert.equal(entry.appObjectId, objectId);
    await assert.rejects(
      client.resolveArtifact(contentId, 99),
      /指定版本尚未进入内容目录/,
    );
    assert.equal(await client.resolveCatalogContent(randomUUID()), null);
  });
});

test("actual authorized body delayed behind a newer catalog read cannot fill Boot, without identity/permission change", async () => {
  await withClient(async ({ client, contentId, ownerCall, holdOriginal }) => {
    const csrf = client.getSnapshot()!.csrfToken;
    const hold = holdOriginal((value) => {
      const original = value as {
        revision: number;
        content: { markdown: string };
      };
      assert.equal(original.revision, 3);
      assert.equal(original.content.markdown, "原件第3版正文");
    });
    const pending = client.resolveArtifact(contentId).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    await Promise.race([
      hold.reached,
      pending.then((result) => {
        assert.fail(
          "authorized held body was not reached: " + String(result.error),
        );
      }),
    ]);
    await ownerCall("documents.revise", {
      commandId: randomUUID(),
      contentId,
      expectedRevision: 3,
      title: "TEST actual content v4",
      markdown: "较新的第四版正文",
    });
    const latest = await client.resolveCatalogContent(contentId);
    assert.equal(latest?.observedVersionRef, "4");
    const before = client.getSnapshot();
    assert.equal(before!.csrfToken, csrf);
    hold.release();
    const stale = await pending;
    assert.equal(stale.value, undefined);
    assert.match(String(stale.error), /内容目录已变化，请重试打开/);
    assert.equal(client.getSnapshot(), before);
    assert.equal(
      before!.workspace.artifacts.some((value) => value.id === contentId),
      false,
    );
    const fresh = await client.resolveArtifact(contentId);
    assert.equal(fresh?.revision, 4);
    assert.equal(
      fresh?.content.kind === "document" && fresh.content.markdown,
      "较新的第四版正文",
    );
    assert.equal(client.getSnapshot()!.csrfToken, csrf);
  });
});
