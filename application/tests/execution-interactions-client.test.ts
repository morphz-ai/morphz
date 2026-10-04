import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer as portProbe } from "node:net";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { useWorkspace, type WorkspaceClient } from "../apps/web/src/client.js";
import { createAppServer } from "../apps/service/src/http.js";
import type {
  ExecutionControl,
  ExecutionScope,
} from "../packages/core/src/execution.js";
import { localAccess } from "../packages/core/src/model.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";

const human = {
  principalId: "execution-client-human",
  actantId: "execution-client-actant",
};
const tokenFor = (who: { principalId: string }) =>
  createHash("sha256")
    .update("execution-client-" + who.principalId)
    .digest("hex");
function storage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => {
      entries.delete(key);
    },
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
}
function actualClient() {
  let client: WorkspaceClient | undefined;
  function Probe() {
    client = useWorkspace();
    return createElement("span");
  }
  // Production refs and methods, not mounted effects, UI or native scheduling.
  renderToString(createElement(Probe));
  assert.ok(client);
  return client;
}
type Request = {
  url: URL;
  method: string;
  status: number;
  headers: Headers;
  body: unknown;
};
type Hold = { reached: Promise<void>; release(): void };
async function withClient(
  run: (context: {
    client: WorkspaceClient;
    scope: ExecutionScope;
    requests: Request[];
    holdControl(): Hold;
  }) => Promise<void>,
) {
  const fixture = await agentDomainFixture({
    additionalHumans: [human],
    loginTokenForHuman: tokenFor,
  });
  const nativeFetch = globalThis.fetch;
  const globals = new Map(
    ["window", "location", "localStorage", "sessionStorage"].map(
      (name) =>
        [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
    ),
  );
  let server: ReturnType<typeof createAppServer> | undefined;
  const holds: Hold[] = [];
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
      assert.equal(url.origin, origin, "this isolated real Host only");
      const headers = new Headers(init?.headers);
      if (cookie) headers.set("Cookie", cookie);
      if (init?.method === "POST") headers.set("Origin", origin);
      const response = await nativeFetch(url, { ...init, headers });
      const received = response.headers.get("set-cookie");
      if (received) cookie = received.split(";")[0]!;
      requests.push({
        url,
        method: init?.method ?? "GET",
        status: response.status,
        headers,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.pathname === "/api/executions/control" && hold) {
        const held = hold;
        hold = undefined;
        assert.equal(
          response.status,
          503,
          "real unconfigured Runtime refusal, not invented success",
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
    assert.equal(requests.length, 0);
    await client.login(tokenFor(human));
    assert.equal(client.getSnapshot()?.principalId, human.principalId);
    await run({
      client,
      scope: {
        projectId: fixture.projectId,
        artifactId: null,
        conversationId: fixture.projectId,
        inputId: randomUUID(),
        threadId: randomUUID(),
      },
      requests,
      holdControl() {
        assert.equal(hold, undefined);
        let reached!: () => void, release!: () => void;
        const seen = new Promise<void>((done) => {
            reached = done;
          }),
          pending = new Promise<void>((done) => {
            release = done;
          });
        hold = { reached, pending };
        const result = { reached: seen, release };
        holds.push(result);
        return result;
      },
    });
    fixture.assertNoLegacyData();
  } finally {
    for (const hold of holds) hold.release();
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
const unavailable = (error: unknown) =>
  error instanceof Error && "status" in error && error.status === 503;
const decision = (
  scope: ExecutionScope,
  fingerprint = "frozen-fingerprint",
): ExecutionControl => ({
  scope,
  action: { type: "allow-once", approvalId: "approval-id", fingerprint },
});

test("actual Client preserves exact snapshot/result/cancel routes and real refusal without success refresh", async () => {
  await withClient(async ({ client, scope, requests }) => {
    const before = requests.length,
      jobId = randomUUID(),
      inputId = randomUUID();
    await assert.rejects(client.executionSnapshot(scope), unavailable);
    await assert.rejects(client.executionResult(scope, jobId), unavailable);
    await assert.rejects(client.cancelInput(inputId), unavailable);
    const sent = requests.slice(before);
    assert.equal(
      sent.length,
      3,
      "no success refresh after the actual cancel rejection",
    );
    assert.deepEqual(
      sent.map((request) => [
        request.url.pathname,
        request.method,
        request.status,
      ]),
      [
        ["/api/executions", "GET", 503],
        ["/api/executions/result", "GET", 503],
        ["/api/inputs/" + inputId + "/cancel", "POST", 503],
      ],
    );
    for (const request of sent.slice(0, 2))
      for (const [name, value] of Object.entries(scope))
        assert.equal(
          request.url.searchParams.get(name),
          value === null ? null : String(value),
        );
    assert.equal(sent[1]!.url.searchParams.get("jobId"), jobId);
  });
});
test("actual shared approval record locks before real control failure and rejects repeats without transport", async () => {
  await withClient(async ({ client, scope, requests }) => {
    const command = decision(scope),
      before = requests.length;
    assert.equal(
      client.approvalSubmitted("approval-id", "frozen-fingerprint"),
      false,
    );
    const pending = client.controlExecution(command);
    assert.equal(
      client.approvalSubmitted("approval-id", "frozen-fingerprint"),
      true,
    );
    await assert.rejects(pending, unavailable);
    assert.equal(
      client.approvalSubmitted("approval-id", "frozen-fingerprint"),
      true,
    );
    await assert.rejects(
      client.controlExecution({
        scope,
        action: {
          type: "deny",
          approvalId: "approval-id",
          fingerprint: "frozen-fingerprint",
        },
      }),
      /本次审批已提交/,
    );
    assert.equal(requests.length, before + 1);
    assert.deepEqual(requests.at(-1)?.body, command);
    assert.equal(requests.at(-1)?.url.pathname, "/api/executions/control");
    await assert.rejects(
      client.controlExecution(decision(scope, "new-fingerprint")),
      unavailable,
    );
    assert.equal(
      client.approvalSubmitted("approval-id", "new-fingerprint"),
      true,
    );
    const ordinary: ExecutionControl = {
      scope,
      action: { type: "cancel-job", jobId: randomUUID(), revision: 1 },
    };
    await assert.rejects(client.controlExecution(ordinary), unavailable);
    assert.equal(requests.length, before + 3);
    assert.deepEqual(requests.at(-1)?.body, ordinary);
    assert.equal(requests.at(-1)?.status, 503);
  });
});
test("actual old approval response after logout cannot return or mark the new login identity", async () => {
  await withClient(async ({ client, scope, requests, holdControl }) => {
    const command = decision(scope),
      held = holdControl();
    const pending = client.controlExecution(command);
    const rejected = assert.rejects(pending, /身份已切换，旧响应已丢弃/);
    await held.reached;
    await client.logout();
    assert.equal(client.getSnapshot(), null);
    await client.login(tokenFor(localAccess));
    const latest = client.getSnapshot()!;
    assert.equal(latest.principalId, localAccess.principalId);
    assert.equal(
      client.approvalSubmitted("approval-id", "frozen-fingerprint"),
      false,
    );
    held.release();
    await rejected;
    assert.equal(client.getSnapshot(), latest);
    assert.equal(
      client.approvalSubmitted("approval-id", "frozen-fingerprint"),
      false,
    );
    assert.equal(
      requests.filter(
        (request) => request.url.pathname === "/api/executions/control",
      ).length,
      1,
    );
  });
});
