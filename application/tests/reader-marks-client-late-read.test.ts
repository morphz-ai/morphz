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
import type {
  ReadingSection,
  ReaderMarksRead,
} from "../packages/core/src/reader.js";

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
  // Real hook refs and production methods, without effects, polling or a fake Client.
  renderToString(createElement(Probe));
  assert.ok(client);
  return client;
}

for (const regrantBeforeRelease of [false, true]) {
  test(`真实 Reader Client 同 CSRF 撤权：已授权旧标注页${regrantBeforeRelease ? "晚于重新授权的新标注" : "在权限仍撤销时"}到达不能返回或污染 current`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "morphz-reader-client-late-"));
    const store = new WorkspaceStore(join(directory, "workspace.sqlite"), {
      mode: "transport",
    });
    const owner = { principalId: "marks-owner", actantId: "marks-owner-human" };
    const reader = {
      principalId: "marks-reader",
      actantId: "marks-reader-human",
    };
    const token = "d".repeat(64);
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
            .update(index ? token : "c".repeat(64))
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
    const call = (
      who: typeof owner,
      method: ApplicationMethod,
      params: unknown,
    ) =>
      invokeApplication(
        app.session(who),
        method,
        params,
        "actual-reader-client-setup",
        new AbortController().signal,
      );
    const projectIds = [randomUUID(), randomUUID()];
    const contentIds: string[] = [];
    for (const [index, projectId] of projectIds.entries()) {
      await call(owner, "projects.create", {
        commandId: randomUUID(),
        projectId,
        title: `TEST 阅读权限项目 ${index}`,
      });
      const created = (await call(owner, "documents.create", {
        commandId: randomUUID(),
        objectId: randomUUID(),
        projectId,
        title: `TEST 阅读权限正文 ${index}`,
        markdown: `# 章节\n\n真实授权原文 ${index}，标注只属于当前读者。`,
      })) as { contentId: string };
      contentIds.push(created.contentId);
    }
    const grants = [members[0]!, { ...members[1]!, projectIds }];
    await domains.content.platform.reconcileOperatorMembers(
      store.identity(),
      grants,
    );
    const markIds: string[] = [];
    for (const [index, artifactId] of contentIds.entries()) {
      const contents = (await call(reader, "reader.contents", {
        artifactId,
        revision: 1,
      })) as Array<{ id: string }>;
      const section = (await call(reader, "reader.read", {
        artifactId,
        revision: 1,
        sectionId: contents[0]!.id,
      })) as ReadingSection;
      const start = section.text.indexOf("真实授权原文");
      assert.ok(start >= 0);
      const receipt = (await call(reader, "reader.command", {
        commandId: randomUUID(),
        artifactId,
        revision: 1,
        command: {
          action: "mark-add",
          artifactId,
          artifactRevision: 1,
          location: {
            sourceId: section.sourceId,
            sectionId: section.id,
            start,
            end: start + 6,
          },
          quote: section.text.slice(start, start + 6),
          kind: "note",
          color: "yellow",
          note: `已授权真实批注 ${index}`,
        },
      })) as { id: string; revision: number };
      markIds.push(receipt.id);
    }
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
    globalThis.fetch = async (input, init) => {
      assert.equal(typeof input, "string");
      const url = new URL(input as string, origin);
      assert.equal(
        url.origin,
        origin,
        "only the actual isolated Host is accessed",
      );
      const headers = new Headers(init?.headers);
      if (cookies) headers.set("Cookie", cookies);
      if (init?.method === "POST") headers.set("Origin", origin);
      const response = await nativeFetch(url, { ...init, headers });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) cookies = setCookie.split(";")[0]!;
      if (
        url.pathname === "/api/reader/marks" &&
        url.searchParams.get("artifactId") === contentIds[0] &&
        !heldRead &&
        response.ok
      ) {
        heldRead = true;
        const actual = (await response.clone().json()) as {
          marks: Array<{ id: string; note: string; revision: number }>;
        };
        assert.deepEqual(
          actual.marks.map((mark) => [mark.id, mark.note, mark.revision]),
          [[markIds[0], "已授权真实批注 0", 1]],
        );
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
    const client = actualWorkspaceClient();
    const remote = new HttpApplicationClient(origin);
    try {
      await client.login(token);
      const csrf = client.getSnapshot()?.csrfToken;
      assert.ok(csrf);
      const query: ReaderMarksRead = {
        artifactId: contentIds[0]!,
        revision: 1,
        limit: 50,
      };
      const staleRead = client.readingMarks(query).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      await Promise.race([
        started,
        staleRead.then((value) => {
          throw new Error("实际授权标注请求未到达迟到门槛", {
            cause: value.error,
          });
        }),
      ]);
      // An in-flight caller cannot mutate the query and rebind returned marks to another book.
      query.artifactId = contentIds[1]!;
      await domains.content.platform.reconcileOperatorMembers(
        store.identity(),
        [grants[0]!, { ...grants[1]!, projectIds: [projectIds[1]!] }],
      );
      await assert.rejects(
        remote.call(
          "reader.marks",
          { artifactId: contentIds[0], revision: 1, limit: 50 },
          { identityGeneration: csrf },
        ),
        (error: unknown) =>
          error instanceof ApplicationRequestError && error.status === 404,
      );
      assert.equal(await client.refresh(), true);
      assert.equal(client.getSnapshot()?.csrfToken, csrf);
      const allowed = await client.readingMarks({
        artifactId: contentIds[1]!,
        revision: 1,
        limit: 50,
      });
      assert.deepEqual(
        allowed.marks.map((mark) => [
          mark.id,
          mark.note,
          mark.artifactId,
          mark.ownerPrincipalId,
        ]),
        [[markIds[1], "已授权真实批注 1", contentIds[1], reader.principalId]],
      );
      await client.resolveArtifact(contentIds[1]!);
      if (regrantBeforeRelease) {
        await domains.content.platform.reconcileOperatorMembers(
          store.identity(),
          grants,
        );
        await call(reader, "reader.command", {
          commandId: randomUUID(),
          artifactId: contentIds[0],
          revision: 1,
          command: {
            action: "mark-update",
            markId: markIds[0],
            expectedRevision: 1,
            color: "green",
            note: "重新授权后的真实新批注",
          },
        });
        assert.equal(await client.refresh(), true);
        const fresh = await client.readingMarks({
          artifactId: contentIds[0]!,
          revision: 1,
          limit: 50,
        });
        assert.deepEqual(
          fresh.marks.map((mark) => [mark.id, mark.note, mark.revision]),
          [[markIds[0], "重新授权后的真实新批注", 2]],
        );
        await client.resolveArtifact(contentIds[1]!);
      }
      const beforeRelease = client.getSnapshot();
      release();
      const stale = await staleRead;
      assert.equal(
        stale.value,
        undefined,
        "the production method itself rejects the previously authorized page, not merely the DOM",
      );
      assert.match(String(stale.error), /阅读权限已变化/);
      assert.equal(
        client.getSnapshot(),
        beforeRelease,
        "the protected current ref is unchanged by the obsolete page",
      );
      assert.equal(client.getSnapshot()?.csrfToken, csrf);
      assert.equal(
        client
          .getSnapshot()
          ?.workspace.artifacts.some((item) => item.id === contentIds[0]),
        false,
      );
      assert.equal(
        client
          .getSnapshot()
          ?.workspace.artifacts.some((item) => item.id === contentIds[1]),
        true,
      );
      const remaining = await client.readingMarks({
        artifactId: contentIds[1]!,
        revision: 1,
        limit: 50,
      });
      assert.deepEqual(remaining.marks, allowed.marks);
      if (regrantBeforeRelease) {
        const fresh = await client.readingMarks({
          artifactId: contentIds[0]!,
          revision: 1,
          limit: 50,
        });
        assert.equal(fresh.marks[0]?.note, "重新授权后的真实新批注");
        assert.equal(fresh.marks[0]?.revision, 2);
      }
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
