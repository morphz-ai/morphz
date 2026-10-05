import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer as portProbe } from "node:net";
import test from "node:test";
import type { Boot } from "../apps/web/src/client.js";
import { createAppServer } from "../apps/service/src/http.js";
import { localAccess, type Operation } from "../packages/core/src/model.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import {
  ActualMountedClient,
  mountedClientWebRoot,
} from "./fixtures/actual-mounted-client-test.js";

const human = {
  principalId: "local-delivery-human",
  actantId: "local-delivery-actant",
};
const tokenFor = (who: { principalId: string }) =>
  createHash("sha256")
    .update("local-delivery-test-login-" + who.principalId)
    .digest("hex");
const scope = (identity: Boot) =>
  `${identity.centerId}:${identity.principalId}:${identity.actantId}`;
type Request = { path: string; method: string; status: number; body: unknown };
async function withClient(
  run: (context: {
    client: ActualMountedClient;
    projectId: string;
    requests(): Promise<Request[]>;
  }) => Promise<void>,
) {
  const fixture = await agentDomainFixture({
    additionalHumans: [human],
    loginTokenForHuman: tokenFor,
  });
  const options = {
    identity: fixture.identity,
    platformWork: fixture.domains.work,
    platformDocuments: fixture.domains.content,
    platformScripts: fixture.domains.content,
    platformReader: fixture.domains.reader,
    messageAttachments: fixture.domains.messageAttachments,
    bookmarkDomain: fixture.domains.browser,
    uiPackages: fixture.domains.uiPackages,
    notifications: fixture.domains.notifications,
    platformTaskRuns: fixture.domains.taskRuns(),
    cognitiveApps: fixture.domains.cognitiveApps,
    workspaceChanges: fixture.domains.workspaceChanges,
  };
  let web: Awaited<ReturnType<typeof mountedClientWebRoot>> | undefined;
  let server: ReturnType<typeof createAppServer> | undefined;
  let client: ActualMountedClient | undefined;
  try {
    await fixture.domains.content.platform.reconcileOperatorMembers(
      fixture.transport.identity(),
      [
        { ...localAccess, enabled: true, projectIds: [] },
        { ...human, enabled: true, projectIds: [fixture.projectId] },
      ],
    );
    web = await mountedClientWebRoot();
    const probe = portProbe();
    await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((done) => probe.close(() => done()));
    assert.notEqual(port, 65421);
    server = createAppServer(fixture.transport, {
      ...options,
      port,
      webRoot: web.directory,
    });
    await new Promise<void>((done) => server!.listen(port, "127.0.0.1", done));
    client = await ActualMountedClient.open("http://127.0.0.1:" + port);
    await client.call("login", [tokenFor(human)]);
    await client.waitReady(human.principalId);
    await client.call("refresh");
    assert.equal((await client.snapshot())?.principalId, human.principalId);
    assert.ok(
      (await client.snapshot())?.workspace.projects.find(
        (project) => project.id === fixture.projectId,
      ),
    );
    const mounted = client;
    await run({
      client,
      projectId: fixture.projectId,
      requests: () => mounted.control("reads"),
    });
    await client.call("refresh");
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
const operation = (
  projectId: string,
): Extract<Operation, { type: "record-input" }> => ({
  type: "record-input",
  projectId,
  conversationId: projectId,
  artifactId: null,
  artifactRevision: null,
  selection: "",
  body: "TEST preserved local payload",
  targetActantId: "morphz-agent",
});

test("actual mounted Client saves without network delivery, reopens the same identity-scoped input and never auto-replays", async () => {
  await withClient(async ({ client, projectId, requests }) => {
    const identity = (await client.snapshot())!,
      id = randomUUID(),
      before = (await requests()).length;
    const pending = await client.control(
      "stagedExecute",
      [operation(projectId), false, undefined, id],
      "staged",
    );
    const receipt = await client.finish(pending);
    assert.equal(receipt.entityId, id);
    assert.equal(await client.control("staged", "staged"), id);
    assert.equal((await requests()).length, before);
    const frozen = await client.control("saved", scope(identity));
    const frozenStorage = await client.control("storage");
    assert.equal(frozen.length, 1);
    assert.equal(frozen[0].commandId, id);
    assert.equal(frozen[0].operation.dispatchMode, "interrupt");
    assert.deepEqual((await client.snapshot())!.localSavedInputIds, [id]);
    assert.deepEqual(
      (await client.snapshot())!.workspace.inputs.find(
        (input) => input.id === id,
      )?.author,
      human,
    );
    await client.control("remount");
    await client.waitReady(identity.principalId);
    await client.call("refresh");
    assert.equal((await client.snapshot())?.principalId, identity.principalId);
    assert.deepEqual(await client.control("saved", scope(identity)), frozen);
    assert.deepEqual(
      await client.control("storage"),
      frozenStorage,
      "same-origin actual remount keeps the original persisted bytes",
    );
    assert.ok((await client.snapshot())!.localSavedInputIds.includes(id));
    assert.equal(
      (await requests()).filter(
        (request) => request.path === "/api/platform/messages",
      ).length,
      0,
    );
    const beforeRetry = (await requests()).length;
    await assert.rejects(
      client.call("dispatchInput", [id]),
      /连接 Agent 后才能发送/,
    );
    assert.equal((await requests()).length, beforeRetry);
    assert.deepEqual(await client.control("saved", scope(identity)), frozen);
  });
});

test("actual mounted Client stages exact frozen bytes before real rejected POST and retains the failed input", async () => {
  await withClient(async ({ client, projectId, requests }) => {
    const identity = (await client.snapshot())!,
      id = randomUUID();
    await client.call("execute", [operation(projectId), false, undefined, id]);
    const frozen = (await client.control("saved", scope(identity)))[0];
    const held = await client.hold("/api/platform/messages");
    const invocation = await client.control(
      "stagedExecute",
      [frozen.operation, true, undefined, id],
      "staged",
    );
    const pending = client.finish(invocation);
    const rejected = assert.rejects(
      pending,
      (error: unknown) =>
        error instanceof Error && "status" in error && error.status === 503,
    );
    try {
      assert.equal(await client.control("staged", "staged"), id);
      assert.equal(
        (await client.snapshot())!.localInputSubmissions[id]?.state,
        "sending",
      );
      const response = await held.reached();
      assert.equal(
        response.status,
        503,
        "the actual Host lacks Runtime; no invented accepted delivery",
      );
      const post = (await requests()).filter(
        (request) => request.path === "/api/platform/messages",
      );
      assert.equal(post.length, 1);
      assert.equal(post[0]!.method, "POST");
      assert.equal(post[0]!.status, 503);
      assert.deepEqual(post[0]!.body, {
        commandId: id,
        operation: frozen.operation,
      });
      await held.release();
      await rejected;
      await client.call("refresh");
      const saved = await client.control("saved", scope(identity));
      assert.equal(saved[0].submission?.state, "failed");
      assert.deepEqual(saved[0].operation, frozen.operation);
      assert.equal(saved[0].createdAt, frozen.createdAt);
      assert.equal(
        (await client.snapshot())!.localInputSubmissions[id]?.state,
        "failed",
      );
      assert.equal(
        (await client.snapshot())!.workspace.inputs.filter(
          (input) => input.id === id,
        ).length,
        1,
      );
    } finally {
      await held.release();
    }
  });
});

test("actual mounted late rejected delivery after logout cannot publish old identity into the new Boot", async () => {
  await withClient(async ({ client, projectId, requests }) => {
    const identity = (await client.snapshot())!,
      id = randomUUID();
    await client.call("execute", [operation(projectId), false, undefined, id]);
    const frozen = (await client.control("saved", scope(identity)))[0];
    const held = await client.hold("/api/platform/messages");
    const invocation = await client.start("execute", [
      frozen.operation,
      true,
      undefined,
      id,
    ]);
    const rejected = assert.rejects(
      client.finish(invocation),
      /身份已切换，旧响应已丢弃/,
    );
    try {
      assert.equal((await held.reached()).status, 503);
      await client.call("logout");
      assert.equal(await client.snapshot(), null);
      await client.call("login", [tokenFor(localAccess)]);
      await client.waitReady(localAccess.principalId);
      const latest = (await client.snapshot("latest"))!;
      assert.notEqual(latest.principalId, identity.principalId);
      assert.notEqual(latest.csrfToken, identity.csrfToken);
      await held.release();
      await rejected;
      assert.equal(
        await client.control("sameSnapshot", "latest"),
        true,
        "late old error cannot replace the actual new browser Boot reference",
      );
      assert.equal(
        latest.workspace.inputs.some((input) => input.id === id),
        false,
      );
      assert.equal(latest.localSavedInputIds.includes(id), false);
      assert.equal(
        (await client.control("saved", scope(identity)))[0]?.submission?.state,
        "failed",
      );
      assert.equal(
        (await requests()).filter(
          (request) => request.path === "/api/platform/messages",
        ).length,
        1,
      );
    } finally {
      await held.release();
    }
  });
});
