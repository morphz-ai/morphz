import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer as portProbe } from "node:http";
import { platformContentSchema } from "../apps/web/src/platform-client.js";
import { createAppServer } from "../apps/service/src/http.js";
import {
  Application,
  invokeApplication,
} from "../packages/application/src/application.js";
import type { ApplicationMethod } from "../packages/core/src/application-api.js";
import { localAccess } from "../packages/core/src/model.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import {
  ActualMountedClient,
  mountedClientWebRoot,
} from "./fixtures/actual-mounted-client-test.js";

const reader = {
  principalId: "content-query-reader",
  actantId: "content-query-reader-human",
};
const tokenFor = (human: { principalId: string }) =>
  createHash("sha256")
    .update("content-query-" + human.principalId)
    .digest("hex");
type Read = { url: URL; method: string; status: number };
async function withClient(
  run: (context: {
    client: ActualMountedClient;
    contentId: string;
    objectId: string;
    reads(): Promise<Read[]>;
    ownerCall(method: ApplicationMethod, params: unknown): Promise<unknown>;
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
    cognitiveApps: fixture.domains.cognitiveApps,
    workspaceChanges: fixture.domains.workspaceChanges,
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
  let web: Awaited<ReturnType<typeof mountedClientWebRoot>> | undefined;
  let server: ReturnType<typeof createAppServer> | undefined;
  let client: ActualMountedClient | undefined;
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
    web = await mountedClientWebRoot();
    const probe = portProbe();
    await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((done) => probe.close(() => done()));
    server = createAppServer(fixture.transport, {
      ...options,
      port,
      webRoot: web.directory,
    });
    await new Promise<void>((done) => server!.listen(port, "127.0.0.1", done));
    client = await ActualMountedClient.open("http://127.0.0.1:" + port);
    await client.call("login", [tokenFor(reader)]);
    await client.waitReady(reader.principalId);
    await client.call("refresh");
    assert.equal(
      (await client.snapshot())!.workspace.artifacts.some(
        (value) => value.id === contentId,
      ),
      false,
      "cold catalog does not hydrate unopened originals",
    );
    const mounted = client;
    await run({
      client,
      contentId,
      objectId,
      ownerCall,
      reads: async () =>
        (await mounted.control("reads")).map(
          (row: { url: string; method: string; status: number }) => ({
            ...row,
            url: new URL(row.url),
          }),
        ),
    });
    fixture.assertNoLegacyData();
  } finally {
    try {
      await client?.close();
    } finally {
      try {
        if (server) {
          server.closeAllConnections();
          await new Promise<void>((done, reject) =>
            server!.close((error) => (error ? reject(error) : done())),
          );
        }
      } finally {
        try {
          web?.close();
        } finally {
          await fixture.close();
        }
      }
    }
  }
}

test("actual mounted Client HTTP/SQLite keeps head and exact historic bytes, version union and live-directory-only fast reuse", async () => {
  await withClient(async ({ client, contentId, objectId, reads }) => {
    await client.control("clearReads");
    const first = await client.call("resolveArtifact", [contentId, 1], "first");
    assert.ok(first);
    assert.equal(first.id, contentId);
    assert.equal(first.revision, 3);
    assert.equal(
      first.content.kind === "document" && first.content.markdown,
      "原件第3版正文",
    );
    assert.equal(
      first.versions.find((value: any) => value.revision === 1)?.content.kind,
      "document",
    );
    const initial = first.versions.find((value: any) => value.revision === 1)!;
    assert.equal(
      initial.content.kind === "document" && initial.content.markdown,
      "原件第一版正文",
    );
    assert.equal(
      await client.control("artifactIdentity", contentId, "first"),
      true,
      "the actual browser Boot retains the exact returned Artifact reference",
    );
    const body = (row: Read) =>
      row.url.pathname === "/api/platform/objects/" + contentId;
    let ledger = await reads();
    assert.deepEqual(
      ledger.filter(body).map((row) => row.url.searchParams.get("revision")),
      [null, "1"],
    );
    assert.ok(
      ledger.every((row) => row.method === "GET" && row.status === 200),
    );
    const second = await client.call(
      "resolveArtifact",
      [contentId, 2],
      "second",
    );
    assert.deepEqual(
      second?.versions.map((value: any) => value.revision),
      [1, 2, 3],
    );
    const historical = second.versions.find(
      (value: any) => value.revision === 2,
    )!;
    assert.equal(
      historical.content.kind === "document" && historical.content.markdown,
      "原件第2版正文",
    );
    await client.snapshot("before");
    await client.control("clearReads");
    await client.call("resolveArtifact", [contentId, 3], "reused");
    assert.equal(
      await client.control("sameSnapshot", "before"),
      true,
      "fast reuse does not republish the actual browser Boot",
    );
    assert.equal(
      await client.control("sameResult", "reused", "second"),
      false,
      "original fast path returns a metadata copy, measured in the browser realm",
    );
    assert.equal(await client.control("sameContent", "reused", "second"), true);
    ledger = await reads();
    assert.equal(ledger.filter(body).length, 0);
    assert.equal(
      ledger.length,
      1,
      "explicit reuse still performs its one live directory get",
    );
    const entry = platformContentSchema.parse(
      await client.call("resolveCatalogContent", [contentId]),
    );
    assert.equal(entry.appObjectId, objectId);
    await assert.rejects(
      client.call("resolveArtifact", [contentId, 99]),
      /指定版本尚未进入内容目录/,
    );
    assert.equal(
      await client.call("resolveCatalogContent", [randomUUID()]),
      null,
    );
  });
});

test("actual mounted authorized body delayed behind a newer catalog read cannot fill Boot, without identity/permission change", async () => {
  await withClient(async ({ client, contentId, ownerCall }) => {
    const csrf = (await client.snapshot())!.csrfToken;
    const hold = await client.hold("/api/platform/objects/" + contentId);
    const id = await client.start("resolveArtifact", [contentId]);
    const pending = client.finish(id).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    try {
      const held = await Promise.race([
        hold.reached(),
        pending.then((result) =>
          assert.fail(
            "authorized held body was not reached: " + String(result.error),
          ),
        ),
      ]);
      assert.equal(
        held.status,
        200,
        "delay a truly authorized original, not a synthetic receipt",
      );
      assert.equal(held.value.revision, 3);
      assert.equal(held.value.content.markdown, "原件第3版正文");
      await ownerCall("documents.revise", {
        commandId: randomUUID(),
        contentId,
        expectedRevision: 3,
        title: "TEST actual content v4",
        markdown: "较新的第四版正文",
      });
      const latest = await client.call("resolveCatalogContent", [contentId]);
      assert.equal(latest?.observedVersionRef, "4");
      const before = await client.snapshot("before");
      assert.equal(before!.csrfToken, csrf);
      await hold.release();
      const stale = await pending;
      assert.equal(stale.value, undefined);
      assert.match(String(stale.error), /内容目录已变化，请重试打开/);
      assert.equal(
        await client.control("sameSnapshot", "before"),
        true,
        "late body cannot replace the actual browser Boot reference",
      );
      assert.equal(
        before!.workspace.artifacts.some((value) => value.id === contentId),
        false,
      );
      const fresh = await client.call("resolveArtifact", [contentId]);
      assert.equal(fresh?.revision, 4);
      assert.equal(
        fresh?.content.kind === "document" && fresh.content.markdown,
        "较新的第四版正文",
      );
      assert.equal((await client.snapshot())!.csrfToken, csrf);
    } finally {
      await hold.release();
    }
  });
});
