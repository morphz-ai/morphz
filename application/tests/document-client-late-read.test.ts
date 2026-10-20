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
      cognitiveApps: domains.cognitiveApps,
      workspaceChanges: domains.workspaceChanges,
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
    const web = await mountedClientWebRoot();
    const server = createAppServer(store, {
      ...options,
      port,
      webRoot: web.directory,
    });
    await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
    const client = await ActualMountedClient.open(origin);
    const remote = authenticatedHttp(client);
    const gate = await client.hold(`/api/platform/objects/${contentIds[0]}`);
    const started = gate.reached().then((report) => {
      assert.equal(report.status, 200, "hold a real authorized response");
      assert.equal(report.value.revision, 1);
      assert.equal(report.value.content.markdown, markdowns[0]);
    });
    const release = () => gate.release();
    try {
      await client.call("login", [token]);
      await client.waitReady(reader.principalId);
      const csrfToken = (await client.snapshot())?.csrfToken;
      assert.ok(csrfToken);
      assert.deepEqual((await client.snapshot())?.workspace.artifacts, []);
      const oldRead = client.call("resolveArtifact", [contentIds[0]!]).then(
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
      assert.equal(await client.call("refresh", []), true);
      assert.equal((await client.snapshot())?.csrfToken, csrfToken);
      assert.equal(
        (await client.snapshot())?.workspace.projects.some(
          (project) => project.id === projectIds[0],
        ),
        false,
      );
      assert.equal(
        (await client.snapshot())?.workspace.artifacts.some(
          (artifact) => artifact.id === contentIds[0],
        ),
        false,
      );
      const allowed = await client.call("resolveArtifact", [contentIds[1]!]);
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
        assert.equal(await client.call("refresh", []), true);
        assert.equal((await client.snapshot())?.csrfToken, csrfToken);
        const fresh = await client.call("resolveArtifact", [contentIds[0]!]);
        assert.equal(fresh?.revision, 2);
        assert.equal(
          fresh?.content.kind === "document" && fresh.content.markdown,
          "重新授权后实际保存的新正文",
        );
        await client.call("resolveArtifact", [contentIds[1]!]);
      }
      const beforeRelease = await client.snapshot("beforeRelease");
      assert.ok(beforeRelease);
      await release();
      const stale = await oldRead;
      assert.equal(stale.value, undefined);
      assert.match(String(stale.error), /身份或访问范围已变化/);
      // Inspect the actual private current ref through the production
      // getSnapshot method, before any regrant or refresh could clear it.
      assert.equal(await client.control("sameSnapshot", "beforeRelease"), true);
      const originals = (await client.snapshot())!.workspace.artifacts;
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
