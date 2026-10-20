import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer as portProbe } from "node:net";
import test from "node:test";
import { platformTaskSchema } from "../apps/web/src/platform-client.js";
import { createAppServer } from "../apps/service/src/http.js";
import {
  Application,
  invokeApplication,
} from "../packages/application/src/application.js";
import type { ApplicationMethod } from "../packages/core/src/application-api.js";
import { applicationTokenHeader } from "../packages/core/src/application-names.js";
import { localAccess } from "../packages/core/src/model.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import {
  ActualMountedClient,
  mountedClientWebRoot,
} from "./fixtures/actual-mounted-client-test.js";

const human = {
  principalId: "task-interaction-human",
  actantId: "task-interaction-actant",
};
const tokenFor = (who: { principalId: string }) =>
  createHash("sha256")
    .update("task-interaction-" + who.principalId)
    .digest("hex");
type Read = {
  path: string;
  method: string;
  status: number;
  headers: [string, string][];
  body: unknown;
};
async function withClient(
  run: (context: {
    client: ActualMountedClient;
    taskId: string;
    reads(): Promise<Read[]>;
    hold(path: string): ReturnType<ActualMountedClient["hold"]>;
    access(enabled: boolean): Promise<void>;
    revise(): Promise<void>;
  }) => Promise<void>,
) {
  const web = await mountedClientWebRoot();
  let fixture: Awaited<ReturnType<typeof agentDomainFixture>>;
  try {
    fixture = await agentDomainFixture({
      additionalHumans: [human],
      loginTokenForHuman: tokenFor,
    });
  } catch (error) {
    web.close();
    throw error;
  }
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
    cognitiveApps: fixture.domains.cognitiveApps,
    platformTaskRuns: fixture.domains.taskRuns(),
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
      "task-interaction-test-human",
      new AbortController().signal,
    );
  const taskId = randomUUID();
  let server: ReturnType<typeof createAppServer> | undefined;
  let client: ActualMountedClient | undefined;
  try {
    const access = async (enabled: boolean) => {
      await fixture.domains.content.platform.reconcileOperatorMembers(
        fixture.transport.identity(),
        [
          { ...localAccess, enabled: true, projectIds: [] },
          {
            ...human,
            enabled: true,
            projectIds: enabled ? [fixture.projectId] : [],
          },
        ],
      );
    };
    await access(true);
    await call(localAccess, "tasks.create", {
      commandId: randomUUID(),
      taskId,
      projectId: fixture.projectId,
      title: "TEST actual task interaction",
      assigneeId: human.actantId,
    });
    await call(human, "tasks.respond", {
      commandId: randomUUID(),
      taskId,
      expectedRevision: 1,
      body: "真实持久回应",
    });
    const probe = portProbe();
    await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((done) => probe.close(() => done()));
    assert.notEqual(port, 65421);
    const origin = "http://127.0.0.1:" + port;
    server = createAppServer(fixture.transport, {
      ...options,
      port,
      webRoot: web.directory,
    });
    await new Promise<void>((done) => server!.listen(port, "127.0.0.1", done));
    client = await ActualMountedClient.open(origin);
    await client.call("login", [tokenFor(human)]);
    await client.waitReady(human.principalId);
    const artifact = await client.call("resolveArtifact", [taskId]);
    assert.equal(artifact?.projectId, fixture.projectId);
    await run({
      client,
      taskId,
      reads: () => client!.control("reads") as Promise<Read[]>,
      hold: (path) => client!.hold(path),
      access,
      revise: async () => {
        const head = platformTaskSchema.parse(
          await call(localAccess, "tasks.get", { taskId }),
        );
        await call(localAccess, "tasks.revise", {
          commandId: randomUUID(),
          taskId,
          expectedRevision: head.headVersion.revision,
          title: "TEST revised task interaction",
        });
      },
    });
    fixture.assertNoLegacyData();
  } finally {
    await client?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((done, reject) =>
        server!.close((error) => (error ? reject(error) : done())),
      );
    }
    await fixture.close();
    web.close();
  }
}
test("actual Client reaches task-head/snapshot/responses and control; real SQLite provenance and server rejection are retained", async () => {
  await withClient(async ({ client, taskId, reads }) => {
    await client.control("clearReads");
    const before = (await client.snapshot())!;
    await client.call("verifyArtifact", [taskId]);
    const view = await client.call("taskRuntime", [taskId]);
    assert.deepEqual(
      view.runs,
      [],
      "real unrequested task, no fabricated Runtime run",
    );
    assert.deepEqual((await client.snapshot())!.taskRuns[taskId], view);
    const responses = await client.call("taskResponses", [taskId]);
    assert.deepEqual(
      responses.map((item) => [item.taskId, item.body, item.author]),
      [[taskId, "真实持久回应", human]],
    );
    await assert.rejects(
      client.call("taskRuntime", [
        taskId,
        { run: 1, revision: 1, action: "cancel" },
      ]),
      /尚未接入新存储/,
    );
    assert.deepEqual(
      (await reads()).map((read) => [read.method, read.path, read.status]),
      [
        ["GET", "/api/platform/tasks/" + taskId, 200],
        ["GET", "/api/tasks/" + taskId + "/runtime", 200],
        ["GET", "/api/platform/tasks/" + taskId + "/responses", 200],
        ["POST", "/api/tasks/" + taskId + "/runtime", 503],
      ],
    );
    assert.deepEqual((await reads()).at(-1)!.body, {
      run: 1,
      revision: 1,
      action: "cancel",
    });
    for (const read of await reads())
      assert.equal(
        new Headers(read.headers).get(applicationTokenHeader),
        before.csrfToken,
      );
  });
});
test("actual Client returns an authorized late snapshot but refuses Boot publication after task version changes", async () => {
  await withClient(async ({ client, taskId, hold, revise }) => {
    const version = (await client.snapshot())!.workspace.artifacts.find(
      (a) => a.id === taskId,
    )!.revision;
    const held = await hold("/api/tasks/" + taskId + "/runtime");
    const pending = await client.start("taskRuntime", [taskId]);
    await held.reached;
    await revise();
    await client.call("refresh");
    await client.call("resolveArtifact", [taskId]);
    await client.waitReady(human.principalId);
    const current = (await client.snapshot("current-task"))!;
    assert.ok(
      current.workspace.artifacts.find((a) => a.id === taskId)!.revision >
        version,
      "real catalog refresh establishes changed task binding",
    );
    await held.release();
    assert.deepEqual((await client.finish(pending)).runs, []);
    assert.equal(
      await client.control("sameSnapshot", "current-task"),
      true,
      "no late current/React publication",
    );
  });
});
test("actual server rejects all three reads after membership revoke; already-aborted Runtime observation never dispatches", async () => {
  await withClient(async ({ client, taskId, reads, access }) => {
    await client.control("clearReads");
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      client.call("taskRuntime", [taskId, undefined, { signal: abort.signal }]),
      { name: "AbortError" },
    );
    assert.equal((await reads()).length, 0);
    await access(false);
    for (const invoke of [
      () => client.call("verifyArtifact", [taskId]),
      () => client.call("taskRuntime", [taskId]),
      () => client.call("taskResponses", [taskId]),
    ])
      await assert.rejects(
        invoke(),
        (error: unknown) =>
          error instanceof Error &&
          "status" in error &&
          [403, 404].includes(Number(error.status)),
      );
    assert.equal((await reads()).length, 3);
    assert.ok(
      (await reads()).every((read) => [403, 404].includes(read.status)),
    );
  });
});
