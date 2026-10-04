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
import {
  HttpApplicationClient,
  ApplicationRequestError,
} from "../packages/core/src/http-application-client.js";
import type { ApplicationMethod } from "../packages/core/src/application-api.js";
import { localAccess } from "../packages/core/src/model.js";
import { emptyScriptDraft } from "../packages/core/src/script-studio.js";
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
  // Actual React SSR initializes production refs and methods; effects do not
  // run. This checks real Client/HTTP/domain behavior, not a mounted Host UI.
  renderToString(createElement(Probe));
  assert.ok(client);
  return client;
}

type Read = { path: string; method: string; params: unknown; status: number };
type Hold = {
  reached: Promise<void>;
  release(): void;
};

async function reachedBeforeCompletion<T>(hold: Hold, pending: Promise<T>) {
  await Promise.race([
    hold.reached,
    pending.then(() => {
      assert.fail(
        "the real delayed HTTP receipt must be reached before completion",
      );
    }),
  ]);
}

async function withRealClient(
  run: (fixture: {
    client: WorkspaceClient;
    reads: Read[];
    productionId: string;
    contentId: string;
    itemId: string;
    sourceObjectId: string;
    hold(match: (url: URL) => boolean, verify: (value: unknown) => void): Hold;
    grant(allowed: boolean): Promise<void>;
    denied(): Promise<void>;
  }) => Promise<void>,
  withSource = false,
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
  const ownerCall = (method: ApplicationMethod, params: unknown) =>
    invokeApplication(
      application.session(localAccess),
      method,
      params,
      "script-client-real-human-setup",
      new AbortController().signal,
    );
  let server: ReturnType<typeof createAppServer> | undefined;
  const nativeFetch = globalThis.fetch;
  const globals = new Map(
    ["window", "location", "localStorage", "sessionStorage"].map(
      (name) =>
        [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
    ),
  );
  const holds: Hold[] = [];
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
    const sources = [];
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
      webRoot: "/nonexistent",
    });
    await new Promise<void>((done) => server!.listen(port, "127.0.0.1", done));
    const reads: Read[] = [];
    let cookies = "";
    let interception:
      | {
          match: (url: URL) => boolean;
          verify: (value: unknown) => void;
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
        "only this isolated real HTTP Host is allowed",
      );
      const headers = new Headers(init?.headers);
      if (cookies) headers.set("Cookie", cookies);
      if (init?.method === "POST") headers.set("Origin", origin);
      const response = await nativeFetch(url, { ...init, headers });
      const cookie = response.headers.get("set-cookie");
      if (cookie) cookies = cookie.split(";")[0]!;
      reads.push({
        path: url.pathname + url.search,
        method: init?.method ?? "GET",
        params:
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        status: response.status,
      });
      const current = interception;
      if (current?.match(url)) {
        interception = undefined;
        assert.equal(
          response.status,
          200,
          "hold only an actually authorized receipt",
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
      "creating the Client does not eagerly read script data",
    );
    await client.login(tokenFor(reader));
    assert.ok(
      client
        .getSnapshot()
        ?.scriptLibrary.some((entry) => entry.id === productionId),
    );
    const remote = new HttpApplicationClient(origin);
    const hold = (
      match: (url: URL) => boolean,
      verify: (value: unknown) => void,
    ) => {
      assert.equal(interception, undefined);
      let release!: () => void, reached!: () => void;
      const pending = new Promise<void>((done) => {
        release = done;
      });
      const receipt = {
        release,
        reached: new Promise<void>((done) => {
          reached = done;
        }),
      };
      interception = { match, verify, reached, pending };
      holds.push(receipt);
      return receipt;
    };
    await run({
      client,
      reads,
      productionId,
      contentId,
      itemId,
      sourceObjectId,
      hold,
      grant,
      denied: async () => {
        await assert.rejects(
          remote.call(
            "scripts.editor.head",
            { contentId },
            {
              identityGeneration: client.getSnapshot()!.csrfToken,
            },
          ),
          (error: unknown) =>
            error instanceof ApplicationRequestError && error.status === 404,
        );
      },
    });
    fixture.assertNoLegacyData();
  } finally {
    holds.forEach((hold) => hold.release());
    globalThis.fetch = nativeFetch;
    for (const [name, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    if (server) {
      server.closeStreams();
      server.closeAllConnections();
      await new Promise<void>((done) => server!.close(() => done()));
    }
    await fixture.close();
  }
}

const scriptCalls = (reads: Read[]) =>
  reads.filter(
    (read) =>
      read.path.startsWith("/api/platform/scripts") ||
      read.path.startsWith("/api/platform/content/"),
  );

test("actual SSR Client: editor warm reuse, getters and body/title shared cache keep original HTTP reads", async () => {
  await withRealClient(
    async ({ client, reads, productionId, contentId, itemId }) => {
      reads.length = 0;
      assert.equal(client.getScriptEditor(productionId), undefined);
      assert.equal(
        client.scriptVersionTitle(productionId, itemId, 1),
        undefined,
      );
      assert.equal(reads.length, 0);
      const model = await client.readScriptEditor(productionId);
      assert.equal(client.getScriptEditor(productionId), model);
      assert.equal(model.items[0]!.title, titles[2]);
      assert.equal("draft" in model.items[0]!, false);
      assert.deepEqual(
        scriptCalls(reads).map(
          (read) => new URL(read.path, "http://fixture").pathname,
        ),
        [
          "/api/platform/content/resolve",
          "/api/platform/scripts/editor/head",
          "/api/platform/scripts/editor/page",
          `/api/platform/content/${contentId}`,
        ],
      );
      reads.length = 0;
      assert.equal(await client.readScriptEditor(productionId), model);
      assert.deepEqual(
        scriptCalls(reads).map(
          (read) => new URL(read.path, "http://fixture").pathname,
        ),
        ["/api/platform/content/resolve", "/api/platform/scripts/editor/head"],
      );
      reads.length = 0;
      const original = await client.readScriptVersion(model, itemId, 1);
      assert.equal(original.draft.text, texts[0]);
      assert.equal(
        client.scriptVersionTitle(productionId, itemId, 1),
        titles[0],
      );
      assert.equal(
        await client.readScriptVersionTitle(model, itemId, 1),
        titles[0],
      );
      assert.deepEqual(
        scriptCalls(reads).map((read) => read.path),
        [`/api/platform/scripts/${contentId}/items/${itemId}?revision=1`],
      );
      reads.length = 0;
      assert.equal(
        await client.readScriptVersionTitle(model, itemId, 2),
        titles[1],
      );
      assert.equal(
        client.scriptVersionTitle(productionId, itemId, 2),
        titles[1],
      );
      assert.equal(
        await client.readScriptVersionTitle(model, itemId, 2),
        titles[1],
      );
      assert.deepEqual(scriptCalls(reads), [
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

test("actual SSR Client: real login/logout do not expose the previous script models or titles", async () => {
  await withRealClient(async ({ client, reads, productionId, itemId }) => {
    const old = await client.readScriptEditor(productionId);
    await client.readScriptVersion(old, itemId, 1);
    const generation = client.getSnapshot()!.csrfToken;
    await client.login(tokenFor(reader));
    assert.notEqual(client.getSnapshot()!.csrfToken, generation);
    reads.length = 0;
    assert.equal(client.getScriptEditor(productionId), undefined);
    assert.equal(client.scriptVersionTitle(productionId, itemId, 1), undefined);
    assert.equal(reads.length, 0);
    const current = await client.readScriptEditor(productionId);
    assert.notEqual(current, old);
    await client.readScriptVersion(current, itemId, 1);
    await client.logout();
    reads.length = 0;
    assert.equal(client.getSnapshot(), null);
    assert.equal(client.getScriptEditor(productionId), undefined);
    assert.equal(client.scriptVersionTitle(productionId, itemId, 1), undefined);
    await assert.rejects(client.readScriptEditor(productionId), /身份已变化/);
    await assert.rejects(
      client.readScriptVersionTitle(current, itemId, 1),
      /身份已变化/,
    );
    assert.equal(reads.length, 0);
  });
});

for (const regrant of [false, true])
  test(`actual SSR Client: authorized exact body released ${regrant ? "after same-CSRF regrant" : "during revocation"} cannot republish or refill titles`, async () => {
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
        const model = await client.readScriptEditor(productionId);
        await client.readScriptVersion(model, itemId, 1);
        const generation = client.getSnapshot()!.csrfToken;
        const gate = hold(
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
        const pending = client.readScriptVersion(model, itemId, 2).then(
          (value) => ({ value, error: undefined }),
          (error: unknown) => ({ value: undefined, error }),
        );
        await reachedBeforeCompletion(gate, pending);
        await grant(false);
        await denied();
        assert.equal(await client.refresh(), true);
        assert.equal(client.getSnapshot()!.csrfToken, generation);
        assert.equal(client.getScriptEditor(productionId), undefined);
        assert.equal(
          client.scriptVersionTitle(productionId, itemId, 1),
          undefined,
        );
        let fresh;
        if (regrant) {
          await grant(true);
          assert.equal(await client.refresh(), true);
          assert.equal(client.getSnapshot()!.csrfToken, generation);
          // Same identity and unchanged app/catalog revisions expose a missing
          // synchronous cache clear: neither public getter may revive old data.
          assert.equal(client.getScriptEditor(productionId), undefined);
          assert.equal(
            client.scriptVersionTitle(productionId, itemId, 1),
            undefined,
          );
          fresh = await client.readScriptEditor(productionId);
          assert.notEqual(fresh, model);
          await client.readScriptVersion(fresh, itemId, 3);
        }
        const snapshot = client.getSnapshot();
        reads.length = 0;
        gate.release();
        const stale = await pending;
        assert.equal(stale.value, undefined);
        assert.match(String(stale.error), /身份或访问范围已变化/);
        assert.equal(client.getSnapshot(), snapshot);
        assert.equal(client.getScriptEditor(productionId), fresh);
        assert.equal(
          client.scriptVersionTitle(productionId, itemId, 2),
          undefined,
        );
        assert.equal(
          client.scriptVersionTitle(productionId, itemId, 3),
          regrant ? titles[2] : undefined,
        );
        assert.equal(
          reads.length,
          0,
          "release does not add a retry or another request",
        );
      },
    );
  });

test("actual SSR Client: an authorized source resolve that finishes parsing after scope invalidation cannot refill title cache", async () => {
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
      const model = await client.readScriptEditor(productionId);
      const gate = hold(
        (url) =>
          url.pathname === "/api/platform/content/resolve" &&
          url.searchParams.get("appObjectId") === sourceObjectId,
        (value) =>
          assert.equal(
            (value as { appObjectId: string }).appObjectId,
            sourceObjectId,
          ),
      );
      const pending = client.readScriptVersion(model, itemId, 1).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      await reachedBeforeCompletion(gate, pending);
      await grant(false);
      await denied();
      assert.equal(await client.refresh(), true);
      await grant(true);
      assert.equal(await client.refresh(), true);
      const snapshot = client.getSnapshot();
      reads.length = 0;
      gate.release();
      const stale = await pending;
      assert.equal(stale.value, undefined);
      assert.match(String(stale.error), /身份或访问范围已变化/);
      assert.equal(client.getSnapshot(), snapshot);
      assert.equal(
        client.scriptVersionTitle(productionId, itemId, 1),
        undefined,
      );
      assert.equal(client.getScriptEditor(productionId), undefined);
      assert.equal(reads.length, 0);
    },
    true,
  );
});
