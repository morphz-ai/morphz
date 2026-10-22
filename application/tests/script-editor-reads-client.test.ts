import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer as portProbe } from "node:http";
import {
  ActualMountedClient,
  mountedClientWebRoot,
  authenticatedHttp,
} from "./fixtures/actual-mounted-client-test.js";
import { platformContentSchema } from "../apps/web/src/platform-client.js";
import { createAppServer } from "../apps/service/src/http.js";
import {
  Application,
  invokeApplication,
} from "../packages/application/src/application.js";
import { ApplicationRequestError } from "../packages/core/src/http-application-client.js";
import type { ApplicationMethod } from "../packages/core/src/application-api.js";
import { localAccess } from "../packages/core/src/model.js";
import { emptyScriptDraft } from "../packages/core/src/script-studio.js";
import type { ScriptEditorProduction } from "../apps/web/src/script-editor-reader.js";
import type { LiveScriptDraft } from "../packages/script-studio/src/store.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";

const reader = {
  principalId: "script-reader",
  actantId: "script-reader-human",
};
const tokenFor = (human: { principalId: string }) =>
  createHash("sha256")
    .update(`script-client-${human.principalId}`)
    .digest("hex");
const titles = ["实际第一稿", "实际第二稿", "实际第三稿"];
const texts = ["实际第一稿正文😀", "实际第二稿正文😀", "实际第三稿正文😀"];

type Read = { path: string; method: string; params: unknown; status: number };
type Hold = Awaited<ReturnType<ActualMountedClient["holdWhere"]>>;

async function reachedBeforeCompletion<T>(hold: Hold, pending: Promise<T>) {
  await Promise.race([
    hold.reached(),
    pending.then(() => {
      assert.fail(
        "the real delayed HTTP receipt must be reached before completion",
      );
    }),
  ]);
}

async function withRealClient(
  run: (fixture: {
    client: ActualMountedClient;
    reads(): Promise<Read[]>;
    productionId: string;
    contentId: string;
    itemId: string;
    sourceObjectId: string;
    hold(
      match: (url: URL) => boolean,
      verify: (value: unknown) => void,
    ): Promise<Hold>;
    grant(allowed: boolean): Promise<void>;
    denied(): Promise<void>;
    revise(): Promise<{ revision: number; title: string }>;
    mutateOther(): Promise<void>;
  }) => Promise<void>,
  withSource = false,
  offHead = false,
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
  const application = new Application(fixture.transport, options);
  const ownerCall = (method: ApplicationMethod, params: unknown) =>
    invokeApplication(
      application.session(localAccess),
      method,
      params,
      "script-client-real-human-setup",
      new AbortController().signal,
    );
  let server: ReturnType<typeof createAppServer> | undefined;
  let client: ActualMountedClient | undefined;
  try {
    const productionId = randomUUID(),
      itemId = randomUUID();
    const created = (await ownerCall("scripts.create", {
      commandId: randomUUID(),
      productionId,
      projectId: fixture.projectId,
      title: "TEST actual Client script reads",
    })) as { contentId: string };
    const contentId = created.contentId;
    const sourceObjectId = randomUUID();
    const sources: LiveScriptDraft["sources"] = [];
    if (withSource) {
      await ownerCall("documents.create", {
        commandId: randomUUID(),
        objectId: sourceObjectId,
        projectId: fixture.projectId,
        title: "TEST 原作",
        markdown: "实际来源原文",
      });
      const source = platformContentSchema.parse(
        await ownerCall("content.resolve", {
          appId: "morphz.objects",
          appObjectId: sourceObjectId,
        }),
      );
      sources.push({
        appId: "morphz.objects",
        instanceId: source.instanceId,
        objectId: sourceObjectId,
        versionRef: "1",
        quote: "实际来源原文",
      });
    }
    const head = (await ownerCall("scripts.editor.head", { contentId })) as {
      activityRevision: number;
    };
    await ownerCall("scripts.item.create", {
      commandId: randomUUID(),
      contentId,
      itemId,
      kind: "episode",
      expectedActivityRevision: head.activityRevision,
      draft: { ...emptyScriptDraft(titles[0]!), sources, text: texts[0] },
    });
    for (const revision of [1, 2])
      await ownerCall("scripts.item.revise", {
        commandId: randomUUID(),
        contentId,
        itemId,
        expectedRevision: revision,
        draft: {
          ...emptyScriptDraft(titles[revision]!),
          sources,
          text: texts[revision],
        },
      });
    let itemRevision = 3;
    const revise = async () => {
      assert.ok(itemRevision < 5, "at most two real fixture revisions");
      const revision = itemRevision + 1;
      const title = `TEST 实际修订第${revision}稿`;
      await ownerCall("scripts.item.revise", {
        commandId: randomUUID(),
        contentId,
        itemId,
        expectedRevision: itemRevision,
        draft: {
          ...emptyScriptDraft(title),
          sources,
          text: `TEST 实际修订第${revision}稿正文`,
        },
      });
      itemRevision = revision;
      return { revision, title };
    };
    let otherMutations = 0;
    const mutateOther = async () => {
      assert.equal(otherMutations++, 0, "one non-target fixture mutation");
      await ownerCall("documents.create", {
        commandId: randomUUID(),
        objectId: randomUUID(),
        projectId: fixture.projectId,
        title: "TEST 非目标目录变更",
        markdown: "只改变真实目录版本，使后续刷新不能复用旧目录。",
      });
    };
    if (offHead)
      for (let index = 0; index < 55; index++)
        await ownerCall("documents.create", {
          commandId: randomUUID(),
          objectId: randomUUID(),
          projectId: fixture.projectId,
          title: `TEST 首屏之外的真实剧本 ${index}`,
          markdown: "真实后建文档使目标剧本落在目录首屏之外。",
        });
    const grant = (allowed: boolean) =>
      fixture.domains.content.platform.reconcileOperatorMembers(
        fixture.transport.identity(),
        [
          { ...localAccess, enabled: true, projectIds: [] },
          {
            ...reader,
            enabled: true,
            projectIds: allowed ? [fixture.projectId] : [],
          },
        ],
      );
    await grant(true);

    const probe = portProbe();
    await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((done) => probe.close(() => done()));
    const origin = `http://127.0.0.1:${port}`;
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
          path: string;
          query: string;
          method: string;
          status: number;
          body: unknown;
        }) => ({
          path: row.path + row.query,
          method: row.method,
          status: row.status,
          params: row.body,
        }),
      );
    await client.call("login", [tokenFor(reader)]);
    await client.waitReady(reader.principalId);
    const authorizedGeneration = (await client.snapshot())!.csrfToken;
    if (offHead)
      assert.equal(
        (await client.snapshot())?.scriptLibrary.some(
          (entry) => entry.id === productionId,
        ),
        false,
        "55 real newer documents must leave the script outside the initial head",
      );
    else
      assert.ok(
        (await client.snapshot())?.scriptLibrary.some(
          (entry) => entry.id === productionId,
        ),
      );
    const remote = authenticatedHttp(client);
    const hold = (
      match: (url: URL) => boolean,
      verify: (value: unknown) => void,
    ) => client!.holdWhere(match, verify);
    await run({
      client,
      reads,
      productionId,
      contentId,
      itemId,
      sourceObjectId,
      hold,
      grant,
      revise,
      mutateOther,
      denied: async () => {
        await assert.rejects(
          remote.call(
            "scripts.editor.head",
            { contentId },
            {
              identityGeneration: authorizedGeneration,
            },
          ),
          (error: unknown) =>
            error instanceof ApplicationRequestError && error.status === 404,
        );
      },
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

const scriptCalls = (reads: Read[]) =>
  reads.filter(
    (read) =>
      read.path.startsWith("/api/platform/scripts") ||
      read.path.startsWith("/api/platform/content/"),
  );

function scriptWitness(
  value: Pick<
    ScriptEditorProduction,
    "id" | "contentId" | "projectId" | "catalogRevision" | "activityRevision"
  >,
) {
  return {
    id: value.id,
    contentId: value.contentId,
    projectId: value.projectId,
    catalogRevision: value.catalogRevision,
    activityRevision: value.activityRevision,
  };
}

test("actual mounted Client: a real revised script read synchronizes its authorized navigation witness and editor cache before resolving", async () => {
  await withRealClient(
    async ({ client, reads, productionId, contentId, itemId, revise }) => {
      const initial = (await client.snapshot())!;
      const before = initial.scriptLibrary.find(
        (entry) => entry.id === productionId,
      )!;
      await client.call("readScriptEditor", [productionId], "old");
      assert.equal(
        await client.control("editorMatches", productionId, "old"),
        true,
      );
      const revision = await revise();
      const current = await client.call(
        "readScriptEditor",
        [productionId],
        "current",
      );
      assert.ok(current.activityRevision > before.activityRevision);
      assert.equal(current.contentId, contentId);
      assert.equal(current.items[0]!.revision, revision.revision);
      assert.equal(current.items[0]!.title, revision.title);
      const resolved = await client.call(
        "resolveScriptLocation",
        [
          {
            productionId,
            itemId,
          },
        ],
        "resolved",
      );
      assert.ok(resolved);
      assert.equal(
        await client.control(
          "sameNestedResult",
          "resolved",
          "production",
          "current",
        ),
        true,
      );
      const snapshot = (await client.snapshot())!;
      assert.equal(snapshot.csrfToken === initial.csrfToken, true);
      assert.equal(snapshot.centerId, initial.centerId);
      assert.equal(snapshot.principalId, reader.principalId);
      const entry = snapshot.scriptLibrary.find(
        (value) => value.id === productionId,
      );
      assert.ok(entry, "the same authorized original remains navigable");
      assert.deepEqual(
        scriptWitness(entry),
        scriptWitness(current),
        "the actual read must publish the exact navigation witness before it resolves",
      );
      assert.equal(
        await client.control("editorMatches", productionId, "current"),
        true,
      );
      assert.equal(
        (await reads()).some((read) =>
          /\/(inputs|messages|infer)(\/|$)/.test(read.path),
        ),
        false,
        "reading never submits input or invokes a model",
      );
    },
  );
});

test("actual mounted Client: a delayed old final navigation receipt cannot roll back a newer real script resolve and the same refresh drains the invalidation", async () => {
  await withRealClient(
    async ({
      client,
      reads,
      productionId,
      itemId,
      hold,
      revise,
      mutateOther,
    }) => {
      const initial = (await client.snapshot())!;
      const old = await client.call("readScriptEditor", [productionId], "old");
      // Settle the original projection before arming this test's next read.
      // The mutation publishes a real SSE hint: its automatic refresh must
      // not consume the changed catalog before the final-receipt hold exists.
      await client.call("refresh", []);
      await client.control("clearReads");
      let navigationReceipts = 0;
      const gate = await hold(
        (url) =>
          url.pathname === "/api/platform/runtime-navigation" &&
          ++navigationReceipts === 2,
        (value) => {
          const receipt = value as {
            catalogVersion: number;
            revisions: { access: number };
          };
          assert.ok(Number.isSafeInteger(receipt.catalogVersion));
          assert.ok(Number.isSafeInteger(receipt.revisions.access));
        },
      );
      const pending = mutateOther().then(() => client.call("refresh", []));
      let current: ScriptEditorProduction | undefined;
      try {
        await reachedBeforeCompletion(gate, pending);
        assert.equal(navigationReceipts, 2);
        assert.ok(
          (await reads()).some((read) =>
            read.path.startsWith("/api/platform/content?"),
          ),
          "the non-target real mutation must force a catalog read before the held final receipt",
        );
        const revision = await revise();
        const resolved = await client.call(
          "resolveScriptLocation",
          [
            {
              productionId,
              itemId,
            },
          ],
          "resolved",
        );
        assert.ok(resolved);
        current = resolved.production;
        assert.ok(current.activityRevision > old.activityRevision);
        assert.equal(current.items[0]!.revision, revision.revision);
        assert.equal(current.items[0]!.title, revision.title);
      } catch (error) {
        console.error(
          "[script delayed navigation fixture]",
          JSON.stringify({ navigationReceipts, reads: await reads() }),
        );
        throw error;
      } finally {
        // Release even when the intended regression assertion is red. Await
        // this exact requester's Promise before restoring fetch or its stores.
        await gate.release();
        await pending;
      }
      assert.equal(await pending, true);
      assert.ok(current);
      const snapshot = (await client.snapshot())!;
      assert.equal(snapshot.csrfToken === initial.csrfToken, true);
      assert.equal(snapshot.centerId, initial.centerId);
      assert.equal(snapshot.principalId, reader.principalId);
      const entry = snapshot.scriptLibrary.find(
        (value) => value.id === productionId,
      );
      assert.ok(
        entry,
        "a delayed authorized receipt cannot remove the original",
      );
      assert.deepEqual(
        scriptWitness(entry),
        scriptWitness(current),
        "awaiting the same refresh must retain the newer real script witness",
      );
      assert.equal(
        await client.control(
          "editorMatches",
          productionId,
          "resolved",
          "production",
        ),
        true,
      );
      assert.ok(
        (await reads()).filter(
          (read) =>
            new URL(read.path, "http://fixture").pathname ===
            "/api/platform/runtime-navigation",
        ).length >= 4,
        "the original refresh Promise must await a second authoritative read",
      );
      assert.equal(
        (await reads()).some((read) =>
          /\/(inputs|messages|infer)(\/|$)/.test(read.path),
        ),
        false,
        "the drain never submits input or invokes a model",
      );
    },
  );
});

test("actual mounted Client: a confirmed off-head script survives a later real refresh while its exact historical body is held", async () => {
  await withRealClient(
    async ({
      client,
      reads,
      productionId,
      contentId,
      itemId,
      hold,
      mutateOther,
    }) => {
      const initial = (await client.snapshot())!;
      assert.equal(
        initial.scriptLibrary.some((entry) => entry.id === productionId),
        false,
      );
      const gate = await hold(
        (url) =>
          url.pathname ===
            `/api/platform/scripts/${contentId}/items/${itemId}` &&
          url.searchParams.get("revision") === "1",
        (value) => {
          const receipt = value as {
            productionId: string;
            itemId: string;
            revision: number;
            draft: { text: string };
          };
          assert.equal(receipt.productionId, productionId);
          assert.equal(receipt.itemId, itemId);
          assert.equal(receipt.revision, 1);
          assert.equal(receipt.draft.text, texts[0]);
        },
      );
      const pending = client.call(
        "resolveScriptLocation",
        [
          {
            productionId,
            itemId,
            revision: 1,
          },
        ],
        "resolved",
      );
      let resolved: Awaited<typeof pending> | undefined;
      try {
        await reachedBeforeCompletion(gate, pending);
        assert.ok(
          (await reads()).some(
            (read) =>
              read.path === `/api/platform/content/${contentId}` &&
              read.status === 200,
          ),
          "the real metadata confirmation precedes the held historical body",
        );
        // This read starts after the original was confirmed and remembered.
        // No instance, saved location or recency pins the off-head original.
        await mutateOther();
        assert.equal(await client.call("refresh", []), true);
      } finally {
        await gate.release();
        resolved = await pending;
      }
      assert.ok(resolved);
      assert.equal(resolved.production.id, productionId);
      assert.equal(resolved.production.contentId, contentId);
      assert.equal(resolved.item!.id, itemId);
      assert.equal(
        await client.call("scriptVersionTitle", [productionId, itemId, 1]),
        titles[0],
      );
      const version = await client.call("readScriptVersion", [
        resolved.production,
        itemId,
        1,
      ]);
      assert.equal(version.productionId, productionId);
      assert.equal(version.itemId, itemId);
      assert.equal(version.revision, 1);
      assert.equal(version.draft.title, titles[0]);
      assert.equal(version.draft.text, texts[0]);
      const snapshot = (await client.snapshot())!;
      assert.equal(snapshot.csrfToken === initial.csrfToken, true);
      assert.equal(snapshot.centerId, initial.centerId);
      assert.equal(snapshot.principalId, reader.principalId);
      const entry = snapshot.scriptLibrary.find(
        (value) => value.id === productionId,
      );
      assert.ok(
        entry,
        "a confirmed authorized off-head original must survive the later refresh",
      );
      assert.deepEqual(
        scriptWitness(entry),
        scriptWitness(resolved.production),
      );
      assert.equal(
        await client.control(
          "editorMatches",
          productionId,
          "resolved",
          "production",
        ),
        true,
      );
      assert.equal(
        (await reads()).some((read) =>
          /\/(inputs|messages|infer)(\/|$)/.test(read.path),
        ),
        false,
      );
    },
    false,
    true,
  );
});

test("actual mounted Client: editor warm reuse, getters and body/title shared cache keep original HTTP reads", async () => {
  await withRealClient(
    async ({ client, reads, productionId, contentId, itemId }) => {
      await client.control("clearReads");
      assert.equal(
        await client.call("getScriptEditor", [productionId]),
        undefined,
      );
      assert.equal(
        await client.call("scriptVersionTitle", [productionId, itemId, 1]),
        undefined,
      );
      assert.equal((await reads()).length, 0);
      const model = await client.call(
        "readScriptEditor",
        [productionId],
        "model",
      );
      assert.equal(
        await client.control("editorMatches", productionId, "model"),
        true,
      );
      assert.equal(model.items[0]!.title, titles[2]);
      assert.equal("draft" in model.items[0]!, false);
      assert.deepEqual(
        scriptCalls(await reads()).map(
          (read) => new URL(read.path, "http://fixture").pathname,
        ),
        [
          "/api/platform/content/resolve",
          "/api/platform/scripts/editor/head",
          "/api/platform/scripts/editor/page",
          `/api/platform/content/${contentId}`,
        ],
      );
      await client.control("clearReads");
      await client.call("readScriptEditor", [productionId], "warm");
      assert.equal(await client.control("sameResult", "warm", "model"), true);
      assert.deepEqual(
        scriptCalls(await reads()).map(
          (read) => new URL(read.path, "http://fixture").pathname,
        ),
        ["/api/platform/content/resolve", "/api/platform/scripts/editor/head"],
      );
      await client.control("clearReads");
      const original = await client.call("readScriptVersion", [
        model,
        itemId,
        1,
      ]);
      assert.equal(original.draft.text, texts[0]);
      assert.equal(
        await client.call("scriptVersionTitle", [productionId, itemId, 1]),
        titles[0],
      );
      assert.equal(
        await client.call("readScriptVersionTitle", [model, itemId, 1]),
        titles[0],
      );
      assert.deepEqual(
        scriptCalls(await reads()).map((read) => read.path),
        [`/api/platform/scripts/${contentId}/items/${itemId}?revision=1`],
      );
      await client.control("clearReads");
      assert.equal(
        await client.call("readScriptVersionTitle", [model, itemId, 2]),
        titles[1],
      );
      assert.equal(
        await client.call("scriptVersionTitle", [productionId, itemId, 2]),
        titles[1],
      );
      assert.equal(
        await client.call("readScriptVersionTitle", [model, itemId, 2]),
        titles[1],
      );
      assert.deepEqual(scriptCalls(await reads()), [
        {
          path: "/api/platform/scripts/editor/detail",
          method: "POST",
          status: 200,
          params: {
            contentId,
            kind: "item-version-title",
            objectId: itemId,
            revision: 2,
          },
        },
      ]);
    },
  );
});

test("actual mounted Client: real login/logout do not expose the previous script models or titles", async () => {
  await withRealClient(async ({ client, reads, productionId, itemId }) => {
    const old = await client.call("readScriptEditor", [productionId], "old");
    await client.call("readScriptVersion", [old, itemId, 1]);
    const generation = (await client.snapshot())!.csrfToken;
    await client.call("login", [tokenFor(reader)]);
    assert.notEqual((await client.snapshot())!.csrfToken, generation);
    await client.control("clearReads");
    assert.equal(
      await client.call("getScriptEditor", [productionId]),
      undefined,
    );
    assert.equal(
      await client.call("scriptVersionTitle", [productionId, itemId, 1]),
      undefined,
    );
    assert.equal((await reads()).length, 0);
    const current = await client.call(
      "readScriptEditor",
      [productionId],
      "current",
    );
    assert.equal(await client.control("sameResult", "current", "old"), false);
    await client.call("readScriptVersion", [current, itemId, 1]);
    await client.call("logout", []);
    await client.control("clearReads");
    assert.equal(await client.snapshot(), null);
    assert.equal(
      await client.call("getScriptEditor", [productionId]),
      undefined,
    );
    assert.equal(
      await client.call("scriptVersionTitle", [productionId, itemId, 1]),
      undefined,
    );
    await assert.rejects(
      client.call("readScriptEditor", [productionId]),
      /身份已变化/,
    );
    await assert.rejects(
      client.call("readScriptVersionTitle", [current, itemId, 1]),
      /身份已变化/,
    );
    assert.equal((await reads()).length, 0);
  });
});

for (const regrant of [false, true])
  test(`actual mounted Client: authorized exact body released ${regrant ? "after same-CSRF regrant" : "during revocation"} cannot republish or refill titles`, async () => {
    await withRealClient(
      async ({
        client,
        reads,
        productionId,
        contentId,
        itemId,
        hold,
        grant,
        denied,
      }) => {
        const model = await client.call(
          "readScriptEditor",
          [productionId],
          "model",
        );
        await client.call("readScriptVersion", [model, itemId, 1]);
        const generation = (await client.snapshot())!.csrfToken;
        const gate = await hold(
          (url) =>
            url.pathname ===
            `/api/platform/scripts/${contentId}/items/${itemId}`,
          (value) => {
            const receipt = value as {
              revision: number;
              draft: { text: string };
            };
            assert.equal(receipt.revision, 2);
            assert.equal(receipt.draft.text, texts[1]);
          },
        );
        const pending = client
          .call("readScriptVersion", [model, itemId, 2])
          .then(
            (value) => ({ value, error: undefined }),
            (error: unknown) => ({ value: undefined, error }),
          );
        await reachedBeforeCompletion(gate, pending);
        await grant(false);
        await denied();
        assert.equal(await client.call("refresh", []), true);
        assert.equal((await client.snapshot())!.csrfToken, generation);
        assert.equal(
          await client.call("getScriptEditor", [productionId]),
          undefined,
        );
        assert.equal(
          await client.call("scriptVersionTitle", [productionId, itemId, 1]),
          undefined,
        );
        let fresh;
        if (regrant) {
          await grant(true);
          assert.equal(await client.call("refresh", []), true);
          assert.equal((await client.snapshot())!.csrfToken, generation);
          // Same identity and unchanged app/catalog revisions expose a missing
          // synchronous cache clear: neither public getter may revive old data.
          assert.equal(
            await client.call("getScriptEditor", [productionId]),
            undefined,
          );
          assert.equal(
            await client.call("scriptVersionTitle", [productionId, itemId, 1]),
            undefined,
          );
          fresh = await client.call(
            "readScriptEditor",
            [productionId],
            "fresh",
          );
          assert.equal(
            await client.control("sameResult", "fresh", "model"),
            false,
          );
          await client.call("readScriptVersion", [fresh, itemId, 3]);
        }
        await client.snapshot("beforeRelease");
        await client.control("clearReads");
        await gate.release();
        const stale = await pending;
        assert.equal(stale.value, undefined);
        assert.match(String(stale.error), /身份或访问范围已变化/);
        assert.equal(
          await client.control("sameSnapshot", "beforeRelease"),
          true,
        );
        assert.equal(
          await client.control("editorMatches", productionId, "fresh"),
          true,
        );
        assert.equal(
          await client.call("scriptVersionTitle", [productionId, itemId, 2]),
          undefined,
        );
        assert.equal(
          await client.call("scriptVersionTitle", [productionId, itemId, 3]),
          regrant ? titles[2] : undefined,
        );
        assert.equal(
          (await reads()).length,
          0,
          "release does not add a retry or another request",
        );
      },
    );
  });

test("actual mounted Client: an authorized source resolve that finishes parsing after scope invalidation cannot refill title cache", async () => {
  await withRealClient(
    async ({
      client,
      reads,
      productionId,
      itemId,
      sourceObjectId,
      hold,
      grant,
      denied,
    }) => {
      const model = await client.call(
        "readScriptEditor",
        [productionId],
        "model",
      );
      const gate = await hold(
        (url) =>
          url.pathname === "/api/platform/content/resolve" &&
          url.searchParams.get("appObjectId") === sourceObjectId,
        (value) =>
          assert.equal(
            (value as { appObjectId: string }).appObjectId,
            sourceObjectId,
          ),
      );
      const pending = client.call("readScriptVersion", [model, itemId, 1]).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      await reachedBeforeCompletion(gate, pending);
      await grant(false);
      await denied();
      assert.equal(await client.call("refresh", []), true);
      await grant(true);
      assert.equal(await client.call("refresh", []), true);
      await client.snapshot("beforeRelease");
      await client.control("clearReads");
      await gate.release();
      const stale = await pending;
      assert.equal(stale.value, undefined);
      assert.match(String(stale.error), /身份或访问范围已变化/);
      assert.equal(await client.control("sameSnapshot", "beforeRelease"), true);
      assert.equal(
        await client.call("scriptVersionTitle", [productionId, itemId, 1]),
        undefined,
      );
      assert.equal(
        await client.call("getScriptEditor", [productionId]),
        undefined,
      );
      assert.equal((await reads()).length, 0);
    },
    true,
  );
});
