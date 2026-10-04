import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer as portProbe } from "node:net";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  useWorkspace,
  type Boot,
  type WorkspaceClient,
} from "../apps/web/src/client.js";
import { readSavedInputs } from "../apps/web/src/local-saved-inputs.js";
import { createAppServer } from "../apps/service/src/http.js";
import { localAccess, type Operation } from "../packages/core/src/model.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";

const human = {
  principalId: "local-delivery-human",
  actantId: "local-delivery-actant",
};
const tokenFor = (who: { principalId: string }) =>
  createHash("sha256")
    .update("local-delivery-test-login-" + who.principalId)
    .digest("hex");
const token = tokenFor(human);
const scope = (identity: Boot) =>
  `${identity.centerId}:${identity.principalId}:${identity.actantId}`;
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
  // SSR establishes the actual original refs/methods without mounting effects.
  // Real HTTP/SQLite identity below is not a native window or model proof.
  renderToString(createElement(Probe));
  assert.ok(client);
  return client;
}
type Request = {
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
    projectId: string;
    requests: Request[];
    storage: Storage;
    holdMessage(): Hold;
    reopen(): Promise<WorkspaceClient>;
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
  const descriptors = new Map(
    ["window", "location", "localStorage", "sessionStorage"].map(
      (name) =>
        [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
    ),
  );
  const nativeFetch = globalThis.fetch,
    device = storage(),
    holds: Hold[] = [];
  let server: ReturnType<typeof createAppServer> | undefined;
  let client: WorkspaceClient | undefined;
  try {
    await fixture.domains.content.platform.reconcileOperatorMembers(
      fixture.transport.identity(),
      [
        { ...localAccess, enabled: true, projectIds: [] },
        { ...human, enabled: true, projectIds: [fixture.projectId] },
      ],
    );
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
    const requests: Request[] = [];
    let cookie = "",
      hold: { reached(): void; pending: Promise<void> } | undefined;
    globalThis.fetch = async (input, init) => {
      assert.equal(typeof input, "string");
      const url = new URL(input as string, origin);
      assert.equal(url.origin, origin, "only this isolated real Host");
      const headers = new Headers(init?.headers);
      if (cookie) headers.set("Cookie", cookie);
      if (init?.method === "POST") headers.set("Origin", origin);
      const response = await nativeFetch(url, { ...init, headers });
      const received = response.headers.get("set-cookie");
      if (received) cookie = received.split(";")[0]!;
      requests.push({
        path: url.pathname,
        method: init?.method ?? "GET",
        status: response.status,
        headers,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.pathname === "/api/platform/messages" && hold) {
        const held = hold;
        hold = undefined;
        assert.equal(
          response.status,
          503,
          "real Host lacks Runtime; no invented accepted delivery",
        );
        held.reached();
        await held.pending;
      }
      return response;
    };
    for (const [name, value] of Object.entries({
      window: {},
      location: { origin },
      localStorage: device,
      sessionStorage: storage(),
    }))
      Object.defineProperty(globalThis, name, { configurable: true, value });
    client = actualClient();
    assert.equal(requests.length, 0, "construction performs no I/O");
    await client.login(token);
    assert.equal(client.getSnapshot()?.principalId, human.principalId);
    assert.ok(
      client
        .getSnapshot()
        ?.workspace.projects.find(
          (project) => project.id === fixture.projectId,
        ),
    );
    await run({
      client,
      projectId: fixture.projectId,
      requests,
      storage: device,
      holdMessage() {
        assert.equal(hold, undefined);
        let reached!: () => void, release!: () => void;
        const seen = new Promise<void>((done) => {
            reached = done;
          }),
          pending = new Promise<void>((done) => {
            release = done;
          });
        hold = { reached, pending };
        const value = { reached: seen, release };
        holds.push(value);
        return value;
      },
      async reopen() {
        const reloaded = actualClient();
        await reloaded.refresh();
        client = reloaded;
        return reloaded;
      },
    });
    await client.refresh(); // Drain only this actual Client's background refresh.
    fixture.assertNoLegacyData();
  } finally {
    for (const hold of holds) hold.release();
    globalThis.fetch = nativeFetch;
    for (const [name, descriptor] of descriptors) {
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
test("actual Client saves without network delivery, reopens the same identity-scoped input and never auto-replays", async () => {
  await withClient(async ({ client, projectId, requests, storage, reopen }) => {
    const identity = client.getSnapshot()!,
      id = randomUUID(),
      before = requests.length;
    let staged = "";
    const receipt = await client.execute(
      operation(projectId),
      false,
      undefined,
      id,
      (value) => {
        staged = value;
      },
    );
    assert.equal(receipt.entityId, id);
    assert.equal(staged, id);
    assert.equal(requests.length, before);
    const frozen = readSavedInputs(storage, scope(identity));
    assert.equal(frozen.length, 1);
    assert.equal(frozen[0]!.commandId, id);
    assert.equal(frozen[0]!.operation.dispatchMode, "interrupt");
    assert.deepEqual(client.getSnapshot()!.localSavedInputIds, [id]);
    assert.deepEqual(
      client.getSnapshot()!.workspace.inputs.find((input) => input.id === id)
        ?.author,
      human,
    );
    const reloaded = await reopen();
    assert.equal(reloaded.getSnapshot()?.principalId, identity.principalId);
    assert.deepEqual(readSavedInputs(storage, scope(identity)), frozen);
    assert.ok(reloaded.getSnapshot()!.localSavedInputIds.includes(id));
    assert.equal(
      requests.filter((request) => request.path === "/api/platform/messages")
        .length,
      0,
    );
    const beforeRetry = requests.length;
    await assert.rejects(reloaded.dispatchInput(id), /连接 Agent 后才能发送/);
    assert.equal(requests.length, beforeRetry);
    assert.deepEqual(readSavedInputs(storage, scope(identity)), frozen);
  });
});
test("actual Client stages exact frozen bytes before real rejected POST and retains the failed input", async () => {
  await withClient(
    async ({ client, projectId, requests, storage, holdMessage }) => {
      const identity = client.getSnapshot()!,
        id = randomUUID();
      await client.execute(operation(projectId), false, undefined, id);
      const frozen = readSavedInputs(storage, scope(identity))[0]!,
        held = holdMessage();
      let staged = "";
      const pending = client.execute(
        frozen.operation,
        true,
        undefined,
        id,
        (value) => {
          staged = value;
        },
      );
      const rejected = assert.rejects(
        pending,
        (error: unknown) =>
          error instanceof Error && "status" in error && error.status === 503,
      );
      assert.equal(staged, id);
      assert.equal(
        client.getSnapshot()!.localInputSubmissions[id]?.state,
        "sending",
      );
      await held.reached;
      const post = requests.filter(
        (request) => request.path === "/api/platform/messages",
      );
      assert.equal(post.length, 1);
      assert.equal(post[0]!.method, "POST");
      assert.equal(post[0]!.status, 503);
      assert.deepEqual(post[0]!.body, {
        commandId: id,
        operation: frozen.operation,
      });
      held.release();
      await rejected;
      await client.refresh();
      const saved = readSavedInputs(storage, scope(identity));
      assert.equal(saved[0]!.submission?.state, "failed");
      assert.deepEqual(saved[0]!.operation, frozen.operation);
      assert.equal(saved[0]!.createdAt, frozen.createdAt);
      assert.equal(
        client.getSnapshot()!.localInputSubmissions[id]?.state,
        "failed",
      );
      assert.equal(
        client
          .getSnapshot()!
          .workspace.inputs.filter((input) => input.id === id).length,
        1,
      );
    },
  );
});
test("actual late rejected delivery after logout cannot publish old identity into the new Boot", async () => {
  await withClient(
    async ({ client, projectId, requests, storage, holdMessage }) => {
      const identity = client.getSnapshot()!,
        id = randomUUID();
      await client.execute(operation(projectId), false, undefined, id);
      const frozen = readSavedInputs(storage, scope(identity))[0]!,
        held = holdMessage();
      const pending = client.execute(frozen.operation, true, undefined, id);
      const rejected = assert.rejects(pending, /身份已切换，旧响应已丢弃/);
      await held.reached;
      await client.logout();
      assert.equal(client.getSnapshot(), null);
      await client.login(tokenFor(localAccess));
      const latest = client.getSnapshot()!;
      assert.notEqual(latest.principalId, identity.principalId);
      assert.notEqual(latest.csrfToken, identity.csrfToken);
      held.release();
      await rejected;
      assert.equal(client.getSnapshot(), latest);
      assert.equal(
        latest.workspace.inputs.some((input) => input.id === id),
        false,
      );
      assert.equal(latest.localSavedInputIds.includes(id), false);
      assert.equal(
        readSavedInputs(storage, scope(identity))[0]?.submission?.state,
        "failed",
      );
      assert.equal(
        requests.filter((request) => request.path === "/api/platform/messages")
          .length,
        1,
      );
    },
  );
});
