import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActualMountedClient,
  mountedClientWebRoot,
  authenticatedHttp,
} from "./fixtures/actual-mounted-client-test.js";
import { createAppServer } from "../apps/service/src/http.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { IdentityCenter } from "../packages/application/src/identity.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import {
  Application,
  invokeApplication,
} from "../packages/application/src/application.js";
import { ApplicationRequestError } from "../packages/core/src/http-application-client.js";
import type { ApplicationMethod } from "../packages/core/src/application-api.js";
import type {
  ReadingSection,
  ReaderMarksRead,
} from "../packages/core/src/reader.js";

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
      cognitiveApps: domains.cognitiveApps,
      workspaceChanges: domains.workspaceChanges,
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
    const web = await mountedClientWebRoot();
    const server = createAppServer(store, {
      ...options,
      port,
      webRoot: web.directory,
    });
    await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
    const client = await ActualMountedClient.open(origin);
    const remote = authenticatedHttp(client);
    const gate = await client.hold("/api/reader/marks");
    const started = gate.reached().then((report) => {
      assert.equal(report.status, 200, "hold a real authorized response");
      assert.deepEqual(
        report.value.marks.map(
          (mark: { id: string; note: string; revision: number }) => [
            mark.id,
            mark.note,
            mark.revision,
          ],
        ),
        [[markIds[0], "已授权真实批注 0", 1]],
      );
    });
    const release = () => gate.release();
    try {
      await client.call("login", [token]);
      await client.waitReady(reader.principalId);
      const csrf = (await client.snapshot())?.csrfToken;
      assert.ok(csrf);
      const query: ReaderMarksRead = {
        artifactId: contentIds[0]!,
        revision: 1,
        limit: 50,
      };
      const pendingId = await client.control(
        "startWithArgs",
        "readingMarks",
        [query],
        "mutable-query",
      );
      const staleRead = client.finish(pendingId).then(
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
      await client.control(
        "mutateArgument",
        "mutable-query",
        0,
        "artifactId",
        contentIds[1]!,
      );
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
      assert.equal(await client.call("refresh", []), true);
      assert.equal((await client.snapshot())?.csrfToken, csrf);
      const allowed = await client.call("readingMarks", [
        {
          artifactId: contentIds[1]!,
          revision: 1,
          limit: 50,
        },
      ]);
      assert.deepEqual(
        allowed.marks.map((mark) => [
          mark.id,
          mark.note,
          mark.artifactId,
          mark.ownerPrincipalId,
        ]),
        [[markIds[1], "已授权真实批注 1", contentIds[1], reader.principalId]],
      );
      await client.call("resolveArtifact", [contentIds[1]!]);
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
        assert.equal(await client.call("refresh", []), true);
        const fresh = await client.call("readingMarks", [
          {
            artifactId: contentIds[0]!,
            revision: 1,
            limit: 50,
          },
        ]);
        assert.deepEqual(
          fresh.marks.map((mark) => [mark.id, mark.note, mark.revision]),
          [[markIds[0], "重新授权后的真实新批注", 2]],
        );
        await client.call("resolveArtifact", [contentIds[1]!]);
      }
      await client.snapshot("beforeRelease");
      await release();
      const stale = await staleRead;
      assert.equal(
        stale.value,
        undefined,
        "the production method itself rejects the previously authorized page, not merely the DOM",
      );
      assert.match(String(stale.error), /阅读权限已变化/);
      assert.equal(
        await client.control("sameSnapshot", "beforeRelease"),
        true,
        "the protected current ref is unchanged by the obsolete page",
      );
      assert.equal((await client.snapshot())?.csrfToken, csrf);
      assert.equal(
        (await client.snapshot())?.workspace.artifacts.some(
          (item) => item.id === contentIds[0],
        ),
        false,
      );
      assert.equal(
        (await client.snapshot())?.workspace.artifacts.some(
          (item) => item.id === contentIds[1],
        ),
        true,
      );
      const remaining = await client.call("readingMarks", [
        {
          artifactId: contentIds[1]!,
          revision: 1,
          limit: 50,
        },
      ]);
      assert.deepEqual(remaining.marks, allowed.marks);
      if (regrantBeforeRelease) {
        const fresh = await client.call("readingMarks", [
          {
            artifactId: contentIds[0]!,
            revision: 1,
            limit: 50,
          },
        ]);
        assert.equal(fresh.marks[0]?.note, "重新授权后的真实新批注");
        assert.equal(fresh.marks[0]?.revision, 2);
      }
    } finally {
      await release();
      await client.close();
      web.close();
      server.closeStreams();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await domains.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
