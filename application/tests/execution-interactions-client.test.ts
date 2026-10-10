import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer as portProbe } from "node:net";
import test from "node:test";
import { createAppServer } from "../apps/service/src/http.js";
import type {
  ExecutionControl,
  ExecutionScope,
} from "../packages/core/src/execution.js";
import { localAccess } from "../packages/core/src/model.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import {
  ActualMountedClient,
  mountedClientWebRoot,
} from "./fixtures/actual-mounted-client-test.js";

const human = {
  principalId: "execution-client-human",
  actantId: "execution-client-actant",
};
const tokenFor = (who: { principalId: string }) =>
  createHash("sha256")
    .update("execution-client-" + who.principalId)
    .digest("hex");
type Request = {
  url: URL;
  method: string;
  status: number;
  headers: Headers;
  body: unknown;
};
async function withClient(
  run: (context: {
    client: ActualMountedClient;
    scope: ExecutionScope;
    requests(): Promise<Request[]>;
  }) => Promise<void>,
) {
  const fixture = await agentDomainFixture({
    additionalHumans: [human],
    loginTokenForHuman: tokenFor,
  });
  let server: ReturnType<typeof createAppServer> | undefined;
  let client: ActualMountedClient | undefined;
  const web = await mountedClientWebRoot();
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
      cognitiveApps: fixture.domains.cognitiveApps,
      port,
      webRoot: web.directory,
    });
    await new Promise<void>((done) => server!.listen(port, "127.0.0.1", done));
    // Real React effects own the Client. SSR is only construction, not a
    // mounted business owner; the shared fixture separately proves zero SSR I/O.
    // Browser cookies/fetch/identity stay real, including received HTTP failures.
    client = await ActualMountedClient.open(origin);
    await client.call("login", [tokenFor(human)]);
    await client.waitReady(human.principalId);
    assert.equal((await client.snapshot())?.principalId, human.principalId);
    const requests = async () => {
      const rows: Array<{
        url: string;
        method: string;
        status: number;
        headers: [string, string][];
        body: unknown;
      }> = await client!.control("reads");
      return rows.map(({ url, headers, ...row }) => {
        const parsed = new URL(url);
        assert.equal(parsed.origin, origin, "this isolated real Host only");
        return { ...row, url: parsed, headers: new Headers(headers) };
      });
    };
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
    });
    fixture.assertNoLegacyData();
  } finally {
    if (client) await client.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((done, reject) =>
        server!.close((error) => (error ? reject(error) : done())),
      );
    }
    web.close();
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
    const before = (await requests()).length,
      jobId = randomUUID(),
      inputId = randomUUID();
    await assert.rejects(
      client.call("executionSnapshot", [scope]),
      unavailable,
    );
    await assert.rejects(
      client.call("executionResult", [scope, jobId]),
      unavailable,
    );
    await assert.rejects(client.call("cancelInput", [inputId]), unavailable);
    const sent = (await requests()).slice(before);
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
      before = (await requests()).length;
    assert.equal(
      await client.call("approvalSubmitted", [
        "approval-id",
        "frozen-fingerprint",
      ]),
      false,
    );
    const pending = await client.start("controlExecution", [command]);
    assert.equal(
      await client.call("approvalSubmitted", [
        "approval-id",
        "frozen-fingerprint",
      ]),
      true,
    );
    await assert.rejects(client.finish(pending), unavailable);
    assert.equal(
      await client.call("approvalSubmitted", [
        "approval-id",
        "frozen-fingerprint",
      ]),
      true,
    );
    await assert.rejects(
      client.call("controlExecution", [
        {
          scope,
          action: {
            type: "deny",
            approvalId: "approval-id",
            fingerprint: "frozen-fingerprint",
          },
        },
      ]),
      /本次审批已提交/,
    );
    const submitted = await requests();
    assert.equal(submitted.length, before + 1);
    assert.deepEqual(submitted.at(-1)?.body, command);
    assert.equal(submitted.at(-1)?.url.pathname, "/api/executions/control");
    await assert.rejects(
      client.call("controlExecution", [decision(scope, "new-fingerprint")]),
      unavailable,
    );
    assert.equal(
      await client.call("approvalSubmitted", [
        "approval-id",
        "new-fingerprint",
      ]),
      true,
    );
    const ordinary: ExecutionControl = {
      scope,
      action: { type: "cancel-job", jobId: randomUUID(), revision: 1 },
    };
    await assert.rejects(
      client.call("controlExecution", [ordinary]),
      unavailable,
    );
    const sent = await requests();
    assert.equal(sent.length, before + 3);
    assert.deepEqual(sent.at(-1)?.body, ordinary);
    assert.equal(sent.at(-1)?.status, 503);
  });
});
test("actual old approval response after logout cannot return or mark the new login identity", async () => {
  await withClient(async ({ client, scope, requests }) => {
    const command = decision(scope),
      held = await client.hold("/api/executions/control");
    const pending = await client.start("controlExecution", [command]);
    const received = await held.reached();
    assert.equal(
      received.status,
      503,
      "real unconfigured Runtime refusal, not invented success",
    );
    await client.call("logout");
    assert.equal(await client.snapshot(), null);
    await client.call("login", [tokenFor(localAccess)]);
    await client.waitReady(localAccess.principalId);
    const latest = (await client.snapshot("new-login"))!;
    assert.equal(latest.principalId, localAccess.principalId);
    assert.equal(
      await client.call("approvalSubmitted", [
        "approval-id",
        "frozen-fingerprint",
      ]),
      false,
    );
    await held.release();
    await assert.rejects(client.finish(pending), /身份已切换，旧响应已丢弃/);
    assert.equal(
      await client.control("sameSnapshot", "new-login"),
      true,
      "exact object identity compared inside the actual browser realm",
    );
    assert.equal(
      await client.call("approvalSubmitted", [
        "approval-id",
        "frozen-fingerprint",
      ]),
      false,
    );
    assert.equal(
      (await requests()).filter(
        (request) => request.url.pathname === "/api/executions/control",
      ).length,
      1,
    );
  });
});
