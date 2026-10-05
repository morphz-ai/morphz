import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { IdentityCenter } from "../packages/application/src/identity.js";
import { RuntimeBridge } from "../packages/application/src/runtime.js";
import {
  resolveRuntimeInputEvidence,
  runtimeHttpInputEvidenceReader,
} from "../packages/application/src/runtime-input-evidence.js";
import { bindIdentityTestPlatform } from "./identity-platform-fixture.js";

test("gateway evidence uses exact Session routes and carries the original Runtime principal", async () => {
  const requests: Array<{ path: string; principal?: string }> = [];
  const reader = runtimeHttpInputEvidenceReader(
    async (path, principal) => {
      requests.push({ path, principal });
      return { event: { id: "event-1" } };
    },
    { sessionScoped: true },
  );
  await reader.readThread(
    "session/one",
    "thread?one",
    "context/one",
    "runtime-alice",
  );
  await reader.readSessionEvent("session/one", "event?one", "runtime-alice");
  await reader.readSessionSchedule!(
    "session/one",
    "schedule?one",
    "runtime-alice",
  );
  assert.deepEqual(requests, [
    {
      path: "/api/sessions/session%2Fone/threads/thread%3Fone",
      principal: "runtime-alice",
    },
    {
      path: "/api/sessions/session%2Fone/events/event%3Fone",
      principal: "runtime-alice",
    },
    {
      path: "/api/sessions/session%2Fone/schedules/schedule%3Fone",
      principal: "runtime-alice",
    },
  ]);
});

test("Host maps only active provenance identities, reads with gateway token and never claims membership", async () => {
  const members = [
    {
      principalId: "alice",
      actantId: "alice-human",
      enabled: true,
      loginTokenHash: createHash("sha256").update("a".repeat(64)).digest("hex"),
    },
  ];
  const config = { version: 1, members };
  const store = new WorkspaceStore(":memory:", { mode: "transport" });
  const identity = new IdentityCenter(store, config);
  const platform = await bindIdentityTestPlatform(store, identity);
  const requests: Array<{
    method?: string;
    url?: string;
    principal?: string;
    authorization?: string;
  }> = [];
  const server = createServer((req, res) => {
    requests.push({
      method: req.method,
      url: req.url,
      principal: req.headers["x-morphz-principal"] as string,
      authorization: req.headers.authorization,
    });
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({ event: { id: "event-1" }, snapshot: { thread: {} } }),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const bridge = new RuntimeBridge(
    store,
    {
      url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      token: "synthetic-gateway-token",
      namespace: randomUUID(),
      identityMode: "trusted_gateway",
    },
    identity,
  );
  const reader = bridge.inputEvidenceReader();
  try {
    const principal = bridge.principalId("alice");
    await reader.readThread(
      "session-one",
      "thread-one",
      "context-one",
      principal,
    );
    await reader.readSessionEvent("session-one", "event-one", principal);
    assert.deepEqual(
      requests.map(({ method, url, principal: p, authorization }) => ({
        method,
        url,
        principal: p,
        authorization,
      })),
      [
        {
          method: "GET",
          url: "/api/sessions/session-one/threads/thread-one",
          principal,
          authorization: "Bearer synthetic-gateway-token",
        },
        {
          method: "GET",
          url: "/api/sessions/session-one/events/event-one",
          principal,
          authorization: "Bearer synthetic-gateway-token",
        },
      ],
    );
    const count = requests.length;
    await assert.rejects(
      reader.readThread(
        "session-one",
        "thread-one",
        "context-one",
        "forged-runtime-principal",
      ),
      /身份不可用或已撤销/,
    );
    await assert.rejects(
      reader.readThread("session-one", "thread-one", "context-one"),
      /身份不可用或已撤销/,
    );
    await identity.replaceConfiguration({
      version: 1,
      members: [{ ...members[0], enabled: false }],
    });
    await assert.rejects(
      reader.readSessionEvent("session-one", "event-one", principal),
      /身份不可用或已撤销/,
    );
    assert.equal(
      requests.length,
      count,
      "Unknown/absent/revoked identity must not reach Runtime",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await platform.close();
    store.close();
  }
});

/** Real Host identity/Platform authority with controlled Runtime HTTP, not an
 * executed Rust Runtime. The retained Session mapping makes a missing
 * readOnlySession guard observable as an actual /principal POST. */
async function viewerGatewayFixture(t: TestContext, viewerIsMember = true) {
  const members = [
    { principalId: "alice", actantId: "alice-human", enabled: true },
    { principalId: "bob", actantId: "bob-human", enabled: true },
  ].map((member, index) => ({
    ...member,
    loginTokenHash: createHash("sha256")
      .update((index ? "b" : "a").repeat(64))
      .digest("hex"),
  }));
  const configuration = { version: 1, members };
  const store = new WorkspaceStore(":memory:", { mode: "transport" });
  const identity = new IdentityCenter(store, configuration);
  const platform = await bindIdentityTestPlatform(store, identity);
  const namespace = randomUUID();
  const runtimePrincipal = (principal: string) =>
    "mw-" +
    createHash("sha256").update(`${namespace}:${principal}`).digest("hex");
  const alice = runtimePrincipal("alice"),
    bob = runtimePrincipal("bob");
  const memberships = new Set(viewerIsMember ? [alice, bob] : [alice]);
  const route = {
    job_id: "job-one",
    tool_call_id: "call-one",
    session_id: "session-one",
    context_id: "context-one",
    principal_id: alice,
    agent_id: "agent-one",
    thread_id: "thread-one",
    target_id: "target-one",
  };
  const thread = {
    id: route.thread_id,
    session_id: route.session_id,
    context_id: route.context_id,
    root_turn_id: "event-one",
    initiating_principal_id: alice,
    agent_id: route.agent_id,
    executor_kind: "agent",
    executor_id: null,
    supervision: { parent_thread_id: null },
  };
  const event = {
    id: thread.root_turn_id,
    actor: "Session-Client",
    type: "session_message",
    topic: "chat/user_message",
    payload: {
      session_id: route.session_id,
      context_id: route.context_id,
      principal_id: alice,
      client_message_id: "input-one",
      session_io: {
        request: {
          io_version: "1",
          client_message_id: "input-one",
          message: {
            format: { id: "morphz.application.input", version: "1" },
            content: {
              encoding: "json",
              value: {
                type: "object",
                value: {
                  input_id: { type: "string", value: "input-one" },
                  workspace_id: { type: "string", value: "project-one" },
                  author_actant_id: {
                    type: "string",
                    value: "alice-human",
                  },
                },
              },
            },
          },
        },
      },
    },
  };
  const requests: Array<{
    method?: string;
    path?: string;
    principal?: string;
    authorization?: string;
  }> = [];
  const server = createServer((request, response) => {
    const principal = request.headers["x-morphz-principal"] as string;
    requests.push({
      method: request.method,
      path: request.url,
      principal,
      authorization: request.headers.authorization,
    });
    response.setHeader("Content-Type", "application/json");
    if (request.headers.authorization !== "Bearer synthetic-viewer-gateway") {
      response.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (request.method === "POST" && request.url?.endsWith("/principal")) {
      memberships.add(principal);
      response.end(JSON.stringify({ principal_id: principal }));
      return;
    }
    if (!memberships.has(principal)) {
      response.writeHead(403).end(JSON.stringify({ error: "forbidden" }));
      return;
    }
    const value = request.url?.endsWith("/threads/thread-one")
      ? { snapshot: { thread } }
      : request.url?.endsWith("/events/event-one")
        ? { event }
        : {
            id: "schedule-one",
            thread_id: thread.id,
            source_turn_id: event.id,
          };
    response.end(JSON.stringify(value));
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await platform.close();
    store.close();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const config = {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    token: "synthetic-viewer-gateway",
    namespace,
    identityMode: "trusted_gateway" as const,
  };
  store.saveRuntimeState({
    namespace,
    endpoint: config.url,
    identityMode: config.identityMode,
    connected: false,
    model: "",
    error: "",
    sessions: {
      [route.session_id]: {
        id: route.session_id,
        projectId: "project-one",
        artifactId: null,
        cursor: 0,
        events: [],
        runtimePrincipalId: alice,
        platform: true,
      },
    },
    deliveries: [],
  });
  const bridge = new RuntimeBridge(store, config, identity);
  return {
    identity,
    configuration,
    platform,
    store,
    config,
    bridge,
    route,
    alice,
    bob,
    requests,
    memberships,
    viewer: { principalId: "bob", actantId: "bob-human" },
  };
}

test("controlled HTTP: Bob reads Alice provenance as Bob, including after Alice revocation, without rewriting origin", async (t) => {
  const f = await viewerGatewayFixture(t);
  const staleIdentity = new IdentityCenter(f.store, f.configuration);
  await staleIdentity.bindPlatform(f.platform, f.store.identity());
  const staleBridge = new RuntimeBridge(
    f.store,
    f.config,
    staleIdentity,
    false,
  );
  const reader = f.bridge.inputEvidenceReader(f.viewer);
  const origin = await resolveRuntimeInputEvidence(f.route, reader);
  assert.equal(origin.runtimePrincipalId, f.alice);
  assert.equal(origin.claimedActantId, "alice-human");
  await reader.readSessionSchedule!("session-one", "schedule-one", f.alice);
  assert.deepEqual(
    f.requests.map(({ method, path, principal, authorization }) => ({
      method,
      path,
      principal,
      authorization,
    })),
    [
      "/api/sessions/session-one/threads/thread-one",
      "/api/sessions/session-one/events/event-one",
      "/api/sessions/session-one/schedules/schedule-one",
    ].map((path) => ({
      method: "GET",
      path,
      principal: f.bob,
      authorization: "Bearer synthetic-viewer-gateway",
    })),
  );
  await f.identity.replaceConfiguration({
    version: 1,
    members: f.configuration.members.map((member) => ({
      ...member,
      enabled: member.principalId !== "alice",
    })),
  });
  assert.deepEqual(await resolveRuntimeInputEvidence(f.route, reader), origin);
  const count = f.requests.length;
  await assert.rejects(
    resolveRuntimeInputEvidence(f.route, f.bridge.inputEvidenceReader()),
    /身份不可用或已撤销/,
    "Agent factory must still reject its revoked initiating Human",
  );
  assert.ok(staleIdentity.allows(f.viewer));
  await assert.rejects(
    staleBridge
      .inputEvidenceReader(f.viewer)
      .readThread("session-one", "thread-one", "context-one", f.alice),
    /身份不可用或已撤销/,
    "A stale Host's active local member cannot bypass authoritative revision",
  );
  assert.equal(f.requests.length, count);
  await assert.rejects(
    resolveRuntimeInputEvidence({ ...f.route, principal_id: f.bob }, reader),
    /未绑定/,
    "Viewer read authority cannot rewrite the real initiating principal",
  );
  assert.ok(f.requests.every((request) => request.principal === f.bob));
  assert.ok(f.requests.every((request) => request.method === "GET"));
});

test("controlled HTTP: current viewer without Runtime Session membership gets 403 and never claims membership", async (t) => {
  const f = await viewerGatewayFixture(t, false);
  const reader = f.bridge.inputEvidenceReader(f.viewer);
  for (const read of [
    () =>
      reader.readThread("session-one", "thread-one", "context-one", f.alice),
    () => reader.readSessionEvent("session-one", "event-one", f.alice),
    () => reader.readSessionSchedule!("session-one", "schedule-one", f.alice),
  ])
    await assert.rejects(
      read(),
      (error: unknown) =>
        error instanceof Error && "status" in error && error.status === 403,
    );
  assert.equal(f.requests.length, 3);
  assert.ok(
    f.requests.every(
      (request) =>
        request.method === "GET" &&
        request.path?.startsWith("/api/sessions/session-one/") &&
        !request.path.endsWith("/principal") &&
        request.principal === f.bob,
    ),
    "A retained Host Session binding cannot turn evidence reads into claims",
  );
  assert.deepEqual([...f.memberships], [f.alice]);
});
