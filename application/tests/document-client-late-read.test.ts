import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { useWorkspace, type WorkspaceClient } from "../apps/web/src/client.js";
import { createAppServer } from "../apps/service/src/http.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { IdentityCenter } from "../packages/application/src/identity.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import {
  Application,
  invokeApplication,
} from "../packages/application/src/application.js";
import {
  HttpApplicationClient,
  ApplicationRequestError,
} from "../packages/core/src/http-application-client.js";
import type { ApplicationMethod } from "../packages/core/src/application-api.js";

function memoryPreferences(): Storage {
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

function actualWorkspaceClient(): WorkspaceClient {
  let client: WorkspaceClient | undefined;
  function Probe() {
    client = useWorkspace();
    return createElement("span");
  }
  // React's real server renderer creates the actual hook's refs and methods.
  // Effects do not run, so no polling, DOM facade or test-only client is used.
  renderToString(createElement(Probe));
  assert.ok(client);
  return client;
}

for (const releaseAfterRegrant of [false, true]) {
  test(`真实 Client 同 CSRF 撤权：旧正文释放${releaseAfterRegrant ? "晚于新授权正文" : "时仍未重新授权"}不能写回 current`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "morphz-client-late-read-"));
    const store = new WorkspaceStore(join(directory, "workspace.sqlite"), {
      mode: "transport",
    });
    const owner = {
      principalId: "client-owner",
      actantId: "client-owner-human",
    };
    const reader = {
      principalId: "client-reader",
      actantId: "client-reader-human",
    };
    const token = "b".repeat(64);
    const members = [owner, reader].map((member) => ({
      ...member,
      projectIds: [] as string[],
      enabled: true,
    }));
    const identity = new IdentityCenter(
      store,
      {
        version: 1,
        members: [owner, reader].map((member, index) => ({
          ...member,
          enabled: true,
          loginTokenHash: createHash("sha256")
            .update(index === 1 ? token : "a".repeat(64))
            .digest("hex"),
        })),
      },
      Date.now,
      members,
    );
    const domains = await openApplicationDomainsHost(
      directory,
      store,
      identity,
    );
    const options = {
      identity,
      platformWork: domains.work,
      platformDocuments: domains.content,
      platformScripts: domains.content,
      platformReader: domains.reader,
      bookmarkDomain: domains.browser,
      messageAttachments: domains.messageAttachments,
      images: domains.images,
      uiPackages: domains.uiPackages,
      notifications: domains.notifications,
      platformTaskRuns: domains.taskRuns(),
    };
    const app = new Application(store, options);
    const ownerCall = (method: ApplicationMethod, params: unknown) =>
      invokeApplication(
        app.session(owner),
        method,
        params,
        "actual-human-client-setup",
        new AbortController().signal,
      );
    const projectIds = [randomUUID(), randomUUID()];
    const markdowns = ["撤权前已实际授权的原文", "仍有权限项目的正文"];
    const contentIds: string[] = [];
    for (const [index, projectId] of projectIds.entries()) {
      await ownerCall("projects.create", {
        projectId,
        commandId: randomUUID(),
        title: `TEST 客户端项目 ${index}`,
      });
      const result = (await ownerCall("documents.create", {
        objectId: randomUUID(),
        commandId: randomUUID(),
        projectId,
        title: `TEST 客户端正文 ${index}`,
        markdown: markdowns[index],
      })) as { contentId: string };
      contentIds.push(result.contentId);
    }
    const grants = [members[0]!, { ...members[1]!, projectIds }];
    await domains.content.platform.reconcileOperatorMembers(
      store.identity(),
      grants,
    );
    const probe = createServer();
    await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((done) => probe.close(() => done()));
    const origin = `http://127.0.0.1:${port}`;
    const server = createAppServer(store, {
      ...options,
      port,
      webRoot: resolve("dist/web"),
    });
    await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
    const nativeFetch = globalThis.fetch;
    const originalGlobals = new Map(
      ["window", "location", "localStorage", "sessionStorage"].map((name) => [
        name,
        Object.getOwnPropertyDescriptor(globalThis, name),
      ]),
    );
    let cookies = "";
    let reached!: () => void;
    const started = new Promise<void>((done) => {
      reached = done;
    });
    let release!: () => void;
    const held = new Promise<void>((done) => {
      release = done;
    });
    let heldRead = false;
    const objectPath = `/api/platform/objects/${contentIds[0]}`;
    const browserFetch: typeof fetch = async (input, init) => {
      assert.equal(typeof input, "string");
      const url = new URL(input as string, origin);
      assert.equal(url.origin, origin, "no model or external service is used");
      const headers = new Headers(init?.headers);
      if (cookies) headers.set("Cookie", cookies);
      if (init?.method === "POST") headers.set("Origin", origin);
      const response = await nativeFetch(url, { ...init, headers });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) cookies = setCookie.split(";")[0]!;
      if (url.pathname === objectPath && !heldRead && response.ok) {
        heldRead = true;
        const original = (await response.clone().json()) as {
          revision: number;
          content: { markdown: string };
        };
        assert.equal(original.revision, 1);
        assert.equal(original.content.markdown, markdowns[0]);
        reached();
        await held;
      }
      return response;
    };
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { origin },
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: memoryPreferences(),
    });
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: memoryPreferences(),
    });
    globalThis.fetch = browserFetch;
    const client = actualWorkspaceClient();
    const remote = new HttpApplicationClient(origin);
    try {
      await client.login(token);
      const csrfToken = client.getSnapshot()?.csrfToken;
      assert.ok(csrfToken);
      assert.deepEqual(client.getSnapshot()?.workspace.artifacts, []);
      const oldRead = client.resolveArtifact(contentIds[0]!).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      await Promise.race([
        started,
        oldRead.then((result) => {
          throw new Error("实际原件请求未到达授权正文门槛。", {
            cause: result.error,
          });
        }),
      ]);
      await domains.content.platform.reconcileOperatorMembers(
        store.identity(),
        [grants[0]!, { ...grants[1]!, projectIds: [projectIds[1]!] }],
      );
      await assert.rejects(
        remote.call(
          "objects.read",
          { contentId: contentIds[0] },
          { identityGeneration: csrfToken },
        ),
        (error: unknown) =>
          error instanceof ApplicationRequestError && error.status === 404,
      );
      assert.equal(await client.refresh(), true);
      assert.equal(client.getSnapshot()?.csrfToken, csrfToken);
      assert.equal(
        client
          .getSnapshot()
          ?.workspace.projects.some((project) => project.id === projectIds[0]),
        false,
      );
      assert.equal(
        client
          .getSnapshot()
          ?.workspace.artifacts.some(
            (artifact) => artifact.id === contentIds[0],
          ),
        false,
      );
      const allowed = await client.resolveArtifact(contentIds[1]!);
      assert.equal(allowed?.content.kind, "document");
      assert.equal(
        allowed?.content.kind === "document" && allowed.content.markdown,
        markdowns[1],
      );
      if (releaseAfterRegrant) {
        await domains.content.platform.reconcileOperatorMembers(
          store.identity(),
          grants,
        );
        await ownerCall("documents.revise", {
          commandId: randomUUID(),
          contentId: contentIds[0],
          expectedRevision: 1,
          title: "TEST 重新授权后的第二版",
          markdown: "重新授权后实际保存的新正文",
        });
        assert.equal(await client.refresh(), true);
        assert.equal(client.getSnapshot()?.csrfToken, csrfToken);
        const fresh = await client.resolveArtifact(contentIds[0]!);
        assert.equal(fresh?.revision, 2);
        assert.equal(
          fresh?.content.kind === "document" && fresh.content.markdown,
          "重新授权后实际保存的新正文",
        );
        await client.resolveArtifact(contentIds[1]!);
      }
      const beforeRelease = client.getSnapshot();
      assert.ok(beforeRelease);
      release();
      const stale = await oldRead;
      assert.equal(stale.value, undefined);
      assert.match(String(stale.error), /身份或访问范围已变化/);
      // Inspect the actual private current ref through the production
      // getSnapshot method, before any regrant or refresh could clear it.
      assert.equal(client.getSnapshot(), beforeRelease);
      const originals = client.getSnapshot()!.workspace.artifacts;
      assert.equal(
        originals.some(
          (artifact) =>
            artifact.content.kind === "document" &&
            artifact.content.markdown === markdowns[0],
        ),
        false,
      );
      assert.equal(
        originals.find((artifact) => artifact.id === contentIds[1])?.content
          .kind,
        "document",
      );
      if (releaseAfterRegrant) {
        const fresh = originals.find(
          (artifact) => artifact.id === contentIds[0],
        );
        assert.equal(fresh?.revision, 2);
        assert.equal(
          fresh?.content.kind === "document" && fresh.content.markdown,
          "重新授权后实际保存的新正文",
        );
      } else
        assert.equal(
          originals.some((artifact) => artifact.id === contentIds[0]),
          false,
        );
    } finally {
      release();
      globalThis.fetch = nativeFetch;
      for (const [name, descriptor] of originalGlobals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      server.closeStreams();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await domains.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
