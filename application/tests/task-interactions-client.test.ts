import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer as portProbe } from "node:net";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { useWorkspace, type WorkspaceClient } from "../apps/web/src/client.js";
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

const human = {
  principalId: "task-interaction-human",
  actantId: "task-interaction-actant",
};
const tokenFor = (who: { principalId: string }) =>
  createHash("sha256")
    .update("task-interaction-" + who.principalId)
    .digest("hex");
function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}
function actualClient() {
  let client: WorkspaceClient | undefined;
  function Probe() {
    client = useWorkspace();
    return createElement("span");
  }
  // The actual production Client refs and methods; SSR runs no effects. This is
  // HTTP/SQLite/Client proof, not a mounted page, subscription or native proof.
  renderToString(createElement(Probe));
  assert.ok(client);
  return client;
}
type Read = {
  path: string;
  method: string;
  status: number;
  headers: Headers;
  body: unknown;
};
type Hold = { reached: Promise<void>; release(): void };
async function withClient(
  run: (context: {
    client: WorkspaceClient;
    taskId: string;
    reads: Read[];
    hold(path: string): Hold;
    access(enabled: boolean): Promise<void>;
    revise(): Promise<void>;
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
  const taskId = randomUUID(),
    nativeFetch = globalThis.fetch;
  const globals = new Map(
    ["window", "location", "localStorage", "sessionStorage"].map(
      (name) =>
        [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
    ),
  );
  let server: ReturnType<typeof createAppServer> | undefined;
  const holds: Hold[] = [];
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
      webRoot: "/nonexistent",
    });
    await new Promise<void>((done) => server!.listen(port, "127.0.0.1", done));
    const reads: Read[] = [];
    let cookie = "",
      interception:
        { path: string; reached(): void; pending: Promise<void> } | undefined;
    globalThis.fetch = async (input, init) => {
      assert.equal(typeof input, "string");
      const url = new URL(input as string, origin);
      assert.equal(
        url.origin,
        origin,
        "only this isolated real Host, never shared/Runtime/model",
      );
      const headers = new Headers(init?.headers);
      if (cookie) headers.set("Cookie", cookie);
      if (init?.method === "POST") headers.set("Origin", origin);
      const response = await nativeFetch(url, { ...init, headers });
      const received = response.headers.get("set-cookie");
      if (received) cookie = received.split(";")[0]!;
      reads.push({
        path: url.pathname,
        method: init?.method ?? "GET",
        status: response.status,
        headers,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (interception?.path === url.pathname) {
        const held = interception;
        interception = undefined;
        assert.equal(
          response.status,
          200,
          "delay only a real authorized response",
        );
        held.reached();
        await held.pending;
      }
      return response;
    };
    for (const [name, value] of Object.entries({
      window: {},
      location: { origin },
      localStorage: storage(),
      sessionStorage: storage(),
    }))
      Object.defineProperty(globalThis, name, { configurable: true, value });
    const client = actualClient();
    assert.equal(reads.length, 0, "actual constructor does no I/O");
    await client.login(tokenFor(human));
    const artifact = await client.resolveArtifact(taskId);
    assert.equal(artifact?.projectId, fixture.projectId);
    const hold = (path: string): Hold => {
      assert.equal(interception, undefined);
      let reached!: () => void, release!: () => void;
      const seen = new Promise<void>((done) => {
          reached = done;
        }),
        pending = new Promise<void>((done) => {
          release = done;
        });
      interception = { path, reached, pending };
      const held = { reached: seen, release };
      holds.push(held);
      return held;
    };
    await run({
      client,
      taskId,
      reads,
      hold,
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
    for (const held of holds) held.release();
    globalThis.fetch = nativeFetch;
    for (const [name, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((done, reject) =>
        server!.close((error) => (error ? reject(error) : done())),
      );
    }
    await fixture.close();
  }
}
test("actual Client reaches task-head/snapshot/responses and control; real SQLite provenance and server rejection are retained", async () => {
  await withClient(async ({ client, taskId, reads }) => {
    reads.length = 0;
    const before = client.getSnapshot()!;
    await client.verifyArtifact(taskId);
    const view = await client.taskRuntime(taskId);
    assert.deepEqual(
      view.runs,
      [],
      "real unrequested task, no fabricated Runtime run",
    );
    assert.deepEqual(client.getSnapshot()!.taskRuns[taskId], view);
    const responses = await client.taskResponses(taskId);
    assert.deepEqual(
      responses.map((item) => [item.taskId, item.body, item.author]),
      [[taskId, "真实持久回应", human]],
    );
    await assert.rejects(
      client.taskRuntime(taskId, { run: 1, revision: 1, action: "cancel" }),
      /尚未接入新存储/,
    );
    assert.deepEqual(
      reads.map((read) => [read.method, read.path, read.status]),
      [
        ["GET", "/api/platform/tasks/" + taskId, 200],
        ["GET", "/api/tasks/" + taskId + "/runtime", 200],
        ["GET", "/api/platform/tasks/" + taskId + "/responses", 200],
        ["POST", "/api/tasks/" + taskId + "/runtime", 503],
      ],
    );
    assert.deepEqual(reads.at(-1)!.body, {
      run: 1,
      revision: 1,
      action: "cancel",
    });
    for (const read of reads)
      assert.equal(read.headers.get(applicationTokenHeader), before.csrfToken);
  });
});
test("actual Client returns an authorized late snapshot but refuses Boot publication after task version changes", async () => {
  await withClient(async ({ client, taskId, hold, revise }) => {
    const version = client
      .getSnapshot()!
      .workspace.artifacts.find((a) => a.id === taskId)!.revision;
    const held = hold("/api/tasks/" + taskId + "/runtime");
    const pending = client.taskRuntime(taskId);
    await held.reached;
    await revise();
    await client.refresh();
    await client.resolveArtifact(taskId);
    const current = client.getSnapshot()!;
    assert.ok(
      current.workspace.artifacts.find((a) => a.id === taskId)!.revision >
        version,
      "real catalog refresh establishes changed task binding",
    );
    held.release();
    assert.deepEqual((await pending).runs, []);
    assert.equal(
      client.getSnapshot(),
      current,
      "no late current/React publication",
    );
  });
});
test("actual server rejects all three reads after membership revoke; already-aborted Runtime observation never dispatches", async () => {
  await withClient(async ({ client, taskId, reads, access }) => {
    reads.length = 0;
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      client.taskRuntime(taskId, undefined, { signal: abort.signal }),
      { name: "AbortError" },
    );
    assert.equal(reads.length, 0);
    await access(false);
    for (const invoke of [
      () => client.verifyArtifact(taskId),
      () => client.taskRuntime(taskId),
      () => client.taskResponses(taskId),
    ])
      await assert.rejects(
        invoke(),
        (error: unknown) =>
          error instanceof Error &&
          "status" in error &&
          [403, 404].includes(Number(error.status)),
      );
    assert.equal(reads.length, 3);
    assert.ok(reads.every((read) => [403, 404].includes(read.status)));
  });
});
