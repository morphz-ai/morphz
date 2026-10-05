import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";
import { acceptedRuntimeInput } from "./runtime-http-evidence.js";
import {
  RuntimeBridge,
  type RuntimeConfig,
} from "../packages/application/src/runtime.js";
import { IdentityCenter } from "../packages/application/src/identity.js";
import { localAccess, type AccessContext } from "../packages/core/src/model.js";

/** Real Human ingress / Host SQLite ledger; controlled Runtime HTTP facts.
 * This is not a Rust execution, model call, or a user's center. */
async function cancelledRootFixture() {
  const calls: Array<{ method: string; path: string; principal?: string }> = [];
  const sessions = new Map<string, Record<string, unknown>>();
  let accepted: ReturnType<typeof acceptedRuntimeInput> | undefined;
  let lifecycle = "open";
  let revision = 2;
  let generation = 1;
  let cancellationThread = "root-thread";
  let cancelGeneration = 1;
  let cancelTopic = "runtime/thread_cancelled";
  let parentThread: string | null = null;
  let pages = false;
  let wireCancel = false;
  let denied = false;
  let mutateRoot = false;
  let finalRevisionChanged = false;
  let turnReads = 0;
  let holdPath: string | undefined;
  let reached: (() => void) | undefined;
  let release: (() => void) | undefined;
  let barrier: Promise<void> | undefined;
  let pageUntil = 0;
  let repeatPage = false;
  let mutation:
    "body" | "metadata" | "activation" | "command" | "delivery" | undefined;
  let upgrades = 0;
  const socketErrors: string[] = [];
  let upgradeObserver: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : null;
    const url = new URL(req.url!, "http://fixture.invalid");
    calls.push({
      method: req.method!,
      path: url.pathname + url.search,
      ...(req.headers["x-morphz-principal"]
        ? { principal: String(req.headers["x-morphz-principal"]) }
        : {}),
    });
    assert.ok(
      ["Bearer cancellation-fixture", "Bearer replacement-credential"].includes(
        String(req.headers.authorization),
      ),
    );
    const sid = url.pathname.split("/")[3]!;
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === "/api/status")
      return send(200, { model: "controlled" });
    if (url.pathname === "/api/runtime/inference")
      return send(200, { model: "controlled", models: [] });
    if (url.pathname === "/api/session-io/capabilities")
      return send(200, { enabled: true, client_metadata: true });
    if (url.pathname === "/api/approvals") return send(200, { approvals: [] });
    if (url.pathname.endsWith("/timeline"))
      return send(200, { entries: [], next_before: null });
    if (url.pathname === "/api/sessions" && req.method === "GET")
      return send(200, [...sessions.values()]);
    if (url.pathname === "/api/sessions" && req.method === "POST") {
      const session = { id: body.id, context_id: body.mount.context_id };
      sessions.set(body.id, session);
      return send(201, session);
    }
    const session = sessions.get(sid);
    if (!session) return send(404, {});
    if (
      denied &&
      (url.pathname.includes("by-client-id") ||
        url.pathname.includes("/turns/") ||
        url.searchParams.has("root_turn_id"))
    )
      return send(403, {});
    if (holdPath && (url.pathname + url.search).includes(holdPath)) {
      holdPath = undefined;
      reached!();
      await barrier;
    }
    if (url.pathname.endsWith("/principal"))
      return send(200, {
        principal_id: "controlled-human",
        session_id: sid,
        context_id: session.context_id,
        capabilities: ["session_turn_control"],
      });
    if (url.pathname.endsWith("/messages") && req.method === "POST") {
      assert.equal(accepted, undefined, "one physical input only");
      accepted = acceptedRuntimeInput(body, sid, "accepted-root", 1);
      // Rust Activation serializes these absent Option fields as null (not
      // skip_serializing_if). Keep the original submitted Host bytes intact.
      const acceptedRequest = (
        accepted.payload.session_io as {
          request: {
            activation: Record<string, unknown>;
            delivery: Record<string, unknown>;
          };
        }
      ).request;
      acceptedRequest.activation = {
        dispatch_mode: null,
        model_alias: null,
        reasoning_effort: null,
        target_id: null,
        harness: null,
        input_destination: null,
        ...acceptedRequest.activation,
      };
      acceptedRequest.delivery = {
        required_formats: [],
        require_schema: false,
        ...acceptedRequest.delivery,
      };
      Object.assign(accepted, {
        actor: "Session-Client",
        type: "session_message",
      });
      return send(200, { accepted: true, event_id: accepted.id });
    }
    if (url.pathname.includes("/messages/by-client-id/") && mutation) {
      const wrong = structuredClone(accepted!);
      const io = (
        wrong.payload.session_io as {
          request: {
            client_message_id: string;
            client_metadata: { value: Record<string, unknown> };
            activation: Record<string, unknown>;
            delivery: Record<string, unknown>;
            message: { content: { value: { value: Record<string, unknown> } } };
          };
        }
      ).request;
      if (mutation === "body")
        io.message.content.value.value.text = {
          type: "string",
          value: "different text",
        };
      if (mutation === "metadata")
        io.client_metadata.value.kind = {
          type: "string",
          value: "foreign-input",
        };
      if (mutation === "activation")
        io.activation.target_id = "different-target";
      if (mutation === "command") io.client_message_id = "different-command";
      if (mutation === "delivery") io.delivery.require_schema = true;
      return send(200, { event: wrong });
    }
    if (url.pathname.includes("/messages/by-client-id/"))
      return send(200, {
        event: mutateRoot ? { ...accepted, topic: "chat/steering" } : accepted,
      });
    if (url.pathname.endsWith("/turns/accepted-root/thread")) {
      turnReads++;
      return send(200, {
        thread_id: "root-thread",
        session_id: sid,
        root_turn_id: "accepted-root",
        revision:
          finalRevisionChanged && turnReads > 1 ? revision + 1 : revision,
        lifecycle,
      });
    }
    if (url.pathname.endsWith("/threads/root-thread/family"))
      return send(200, {
        session_id: sid,
        context_id: session.context_id,
        selected_thread_id: "root-thread",
        generated_at: new Date().toISOString(),
        limit: 1,
        has_more: false,
        threads: [
          {
            id: "root-thread",
            session_id: sid,
            context_id: session.context_id,
            root_turn_id: "accepted-root",
            parent_thread_id: parentThread,
            revision,
            generation,
          },
        ],
      });
    if (url.pathname.endsWith("/events")) {
      const events =
        url.searchParams.has("root_turn_id") ||
        (wireCancel && Number(url.searchParams.get("after_sequence")) < 101)
          ? [
              {
                id: `thread_cancelled_${cancellationThread}_g${cancelGeneration}`,
                sequence: wireCancel ? 101 : 12,
                timestamp: new Date().toISOString(),
                actor: "Runtime",
                type: "runtime_control",
                topic: cancelTopic,
                payload: {
                  session_id: sid,
                  context_id: session.context_id,
                  root_turn_id: "accepted-root",
                  thread_id: cancellationThread,
                  thread_generation: cancelGeneration,
                  terminal_kind: "cancelled",
                  disposition: "no_reply",
                  runtime_failure_kind: "thread_cancelled",
                  wake_policy: "none",
                  text: "not a chat response",
                },
              },
            ]
          : [];
      return send(200, {
        events:
          pages ||
          (pageUntil &&
            Number(url.searchParams.get("before_sequence") || 400) >
              400 - (pageUntil - 1) * 100)
            ? []
            : events,
        latest_sequence: 100,
        next_before_sequence: repeatPage
          ? 300
          : pageUntil &&
              Number(url.searchParams.get("before_sequence") || 400) >
                400 - (pageUntil - 1) * 100
            ? Number(url.searchParams.get("before_sequence") || 400) - 100
            : pages
              ? (Number(url.searchParams.get("before_sequence")) || 1000) - 1
              : null,
      });
    }
    if (req.method === "PATCH") Object.assign(session, body);
    return send(200, session);
  });
  server.on("upgrade", (_req, socket) => {
    socket.on("error", (error: NodeJS.ErrnoException) => {
      socketErrors.push(error.code ?? error.name);
    });
    upgrades++;
    upgradeObserver?.();
    socket.end(
      "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const host = await platformRuntimeHostFixture({
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    namespace: randomUUID(),
    token: "cancellation-fixture",
  });
  try {
    await host.session().platformMessage({
      commandId: randomUUID(),
      operation: {
        type: "record-input",
        projectId: host.projectId,
        artifactId: null,
        artifactRevision: null,
        selection: "",
        body: "保留原输入，不重发",
        targetActantId: "morphz-agent",
      },
    });
    await host.enableDispatch();
    await host.runtime.tick();
    assert.ok(accepted, JSON.stringify(host.store.runtimeState()));
    await host.runtime.stop();
    const baseline = structuredClone(host.store.runtimeState()) as {
      sessions: Record<string, { cursor: number; events: unknown[] }>;
      deliveries: Array<Record<string, unknown>>;
    };
    for (const session of Object.values(baseline.sessions))
      session.cursor = 100;
    host.store.saveRuntimeState(baseline);
    lifecycle = "cancelled";
    revision = 3;
    generation = 2;
    calls.length = 0;
    return {
      host,
      calls,
      baseline,
      alter(value: {
        thread?: string;
        generation?: number;
        topic?: string;
        lifecycle?: string;
        parent?: string;
        pages?: boolean;
        wireCancel?: boolean;
        denied?: boolean;
        mutateRoot?: boolean;
        finalRevisionChanged?: boolean;
        pageUntil?: number;
        repeatPage?: boolean;
        mutation?: typeof mutation;
      }) {
        cancellationThread = value.thread ?? cancellationThread;
        cancelGeneration = value.generation ?? cancelGeneration;
        cancelTopic = value.topic ?? cancelTopic;
        lifecycle = value.lifecycle ?? lifecycle;
        parentThread = value.parent ?? parentThread;
        pages = value.pages ?? pages;
        wireCancel = value.wireCancel ?? wireCancel;
        denied = value.denied ?? denied;
        mutateRoot = value.mutateRoot ?? mutateRoot;
        finalRevisionChanged =
          value.finalRevisionChanged ?? finalRevisionChanged;
        pageUntil = value.pageUntil ?? pageUntil;
        repeatPage = value.repeatPage ?? repeatPage;
        mutation = value.mutation ?? mutation;
      },
      hold(path: string) {
        holdPath = path;
        const enteredEvent = new Promise<void>((resolve) => {
          reached = resolve;
        });
        let deadline: ReturnType<typeof setTimeout>;
        const entered = Promise.race([
          enteredEvent,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(
              () =>
                reject(
                  new Error("controlled HTTP proof barrier was not reached"),
                ),
              12000,
            );
          }),
        ]).finally(() => clearTimeout(deadline));
        barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        return { entered, release: () => release!() };
      },
      async run() {
        await host.enableDispatch();
        await host.runtime.tick();
      },
      seedHistoricalProjection() {
        // A pre-existing controlled legacy Host row, not a newly published
        // model result. The repair must preserve its exact stored bytes.
        for (const session of Object.values(baseline.sessions))
          session.events.push({
            id: "retained-legacy-reply",
            sequence: 90,
            timestamp: "2026-10-01T00:00:00.123456Z",
            topic: "chat/reply",
            payload: {
              root_turn_id: "unrelated-earlier-root",
              text: "retained historical bytes",
            },
          });
        host.store.saveRuntimeState(baseline);
      },
      gateway() {
        // Controlled gateway-admission representation of the same real Host
        // input: namespace / request / source / command remain unchanged.
        // The peer owns canonical principal and Context wire facts, not a
        // newly privileged Operator endpoint or a second business ingress.
        const stored = structuredClone(baseline) as typeof baseline & {
          namespace: string;
          endpoint: string;
          identityMode?: "trusted_gateway";
          sessions: Record<string, Record<string, unknown>>;
        };
        stored.identityMode = "trusted_gateway";
        for (const [sid, session] of sessions) {
          session.context_id = `mw-context-${stored.namespace}-${createHash("sha256").update(host.projectId).digest("hex").slice(0, 24)}`;
          stored.sessions[sid]!.runtimePrincipalId = `mw-${createHash("sha256")
            .update(stored.namespace + ":morphz-service")
            .digest("hex")}`;
        }
        const config: RuntimeConfig = {
          url: stored.endpoint,
          namespace: stored.namespace,
          token: "cancellation-fixture",
          identityMode: "trusted_gateway",
        };
        const member = {
          principalId: localAccess.principalId,
          actantId: localAccess.actantId,
          loginTokenHash: "a".repeat(64),
          enabled: true,
        };
        const identity = new IdentityCenter(host.store, {
          version: 1,
          members: [member],
        });
        host.store.saveRuntimeState(stored);
        const runtime = new RuntimeBridge(host.store, config, identity, false);
        accepted!.payload.principal_id = runtime.principalId(
          localAccess.principalId,
        );
        const authorizer = (
          host.runtime as unknown as {
            authorizePlatformRead: (
              scope: { projectId: string; conversationId: string },
              access: AccessContext,
            ) => Promise<{ personalDefault: boolean; projectIds: string[] }>;
          }
        ).authorizePlatformRead;
        runtime.bindPlatformReadAuthority(authorizer);
        return {
          runtime,
          identity,
          config,
          authorizer,
          retireHuman() {
            // Controlled live identity revocation; the production IdentityCenter
            // predicate itself is used on both sides of the held HTTP boundary.
            (
              identity as unknown as {
                config: { members: Array<typeof member> };
              }
            ).config.members[0]!.enabled = false;
          },
        };
      },
      repeatedSocketFailure() {
        let timer: ReturnType<typeof setTimeout>;
        const failures = new Promise<void>((resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("real WebSocket retry was not observed")),
            10000,
          );
          upgradeObserver = () => {
            if (upgrades >= 2) resolve();
          };
        });
        return failures.finally(() => {
          clearTimeout(timer);
          upgradeObserver = undefined;
          assert.ok(
            socketErrors.every((code) => code === "ECONNRESET"),
            "controlled 403 closure has no unrelated native socket failures",
          );
        });
      },
      async close() {
        release?.();
        try {
          await host.close();
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      },
    };
  } catch (error) {
    try {
      await host.close();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    throw error;
  }
}

test("controlled HTTP root cancellation repairs accepted Host SQLite delivery beyond its cursor without replay", async () => {
  const f = await cancelledRootFixture();
  try {
    await f.run();
    const after = f.host.store.runtimeState() as typeof f.baseline;
    assert.equal(after.deliveries[0]!.state, "cancelled");
    const strip = (d: Record<string, unknown>) => {
      const {
        state: _state,
        cancelRequested: _cancel,
        error: _error,
        ...frozen
      } = d;
      return frozen;
    };
    assert.deepEqual(
      after.deliveries.map(strip),
      f.baseline.deliveries.map(strip),
    );
    assert.equal(after.deliveries[0]!.cancelRequested, false);
    assert.equal(after.deliveries[0]!.error, null);
    assert.equal(
      JSON.stringify(after.deliveries[0]!.request),
      JSON.stringify(f.baseline.deliveries[0]!.request),
      "submitted request key order and opaque input bytes are not rewritten",
    );
    assert.deepEqual(
      after.sessions,
      f.baseline.sessions,
      "cursor/history/session identity stay frozen",
    );
    assert.deepEqual(
      f.calls.filter((call) => call.method !== "GET"),
      [],
      "reconciliation is read-only, even principal claims",
    );
    assert.ok(
      f.calls.some((call) => call.path.includes("root_turn_id=accepted-root")),
    );
  } finally {
    await f.close();
  }
});

test("controlled HTTP cancellation repair preserves pre-existing legacy Host history and frozen submission bytes", async () => {
  const f = await cancelledRootFixture();
  try {
    f.seedHistoricalProjection();
    const history = JSON.stringify(f.baseline.sessions);
    const request = JSON.stringify(f.baseline.deliveries[0]!.request);
    await f.run();
    const after = f.host.store.runtimeState() as typeof f.baseline;
    assert.equal(after.deliveries[0]!.state, "cancelled");
    assert.equal(JSON.stringify(after.sessions), history);
    assert.equal(JSON.stringify(after.deliveries[0]!.request), request);
    assert.equal(after.deliveries[0]!.rootId, f.baseline.deliveries[0]!.rootId);
    assert.equal(
      after.deliveries[0]!.inputId,
      f.baseline.deliveries[0]!.inputId,
    );
    assert.deepEqual(
      f.calls.filter((call) => call.method !== "GET"),
      [],
    );
  } finally {
    await f.close();
  }
});

for (const [name, patch] of [
  ["child cancellation", { thread: "child-thread" }],
  ["parent-rerouted terminal barrier", { topic: "runtime/thread_terminal" }],
  ["tool child barrier", { topic: "chat/thread_terminal" }],
  ["current generation is not cancelled old generation", { generation: 2 }],
  ["old cancelled generation is not current root outcome", { generation: 0 }],
  ["root remains open", { lifecycle: "open" }],
  ["future queued schedule remains nonterminal", { lifecycle: "queued" }],
  ["selected Thread is not a root", { parent: "supervisor" }],
  ["steering accepted receipt is not an ordinary root", { mutateRoot: true }],
  ["Runtime Human read authority denied", { denied: true }],
  [
    "root revision changes before the final read",
    { finalRevisionChanged: true },
  ],
  ["bounded pagination is insufficient", { pages: true }],
  ["accepted body differs", { mutation: "body" }],
  ["accepted metadata differs", { mutation: "metadata" }],
  ["accepted activation differs", { mutation: "activation" }],
  ["accepted command differs", { mutation: "command" }],
  ["accepted delivery contract differs", { mutation: "delivery" }],
] as const) {
  test(`controlled HTTP cancellation reconciliation refuses ${name}`, async () => {
    const f = await cancelledRootFixture();
    try {
      f.alter(patch);
      await f.run();
      const after = f.host.store.runtimeState() as typeof f.baseline;
      assert.deepEqual(after.deliveries, f.baseline.deliveries);
      assert.deepEqual(after.sessions, f.baseline.sessions);
      assert.deepEqual(
        f.calls.filter((call) => call.method !== "GET"),
        [],
      );
      assert.ok(
        f.calls.filter((call) => call.path.includes("root_turn_id=")).length <=
          4,
      );
      const reads = f.calls.filter((call) =>
        call.path.includes("by-client-id"),
      ).length;
      await f.host.runtime.tick();
      assert.equal(
        f.calls.filter((call) => call.path.includes("by-client-id")).length,
        reads,
        "unknown evidence does not become per-tick polling/retry",
      );
    } finally {
      await f.close();
    }
  });
}

for (const boundary of [
  "stop",
  "connection",
  "authority",
  "delivery",
] as const) {
  test(`controlled HTTP held cancellation proof cannot cross ${boundary} retirement`, async () => {
    const f = await cancelledRootFixture();
    const hold = f.hold("root_turn_id=");
    try {
      const operation = f.run();
      await hold.entered;
      let stopping: Promise<void> | undefined;
      if (boundary === "stop") stopping = f.host.runtime.stop();
      if (boundary === "connection")
        f.host.runtime.updateConnection({
          url: (f.baseline as unknown as { endpoint: string }).endpoint,
          namespace: (f.baseline as unknown as { namespace: string }).namespace,
          token: "replacement-credential",
        });
      if (boundary === "authority")
        f.host.runtime.bindPlatformReadAuthority(undefined);
      if (boundary === "delivery") {
        const state = (
          f.host.runtime as unknown as { state: typeof f.baseline }
        ).state;
        state.deliveries[0]!.error = "newer owner metadata";
      }
      hold.release();
      await operation;
      await stopping;
      const after = f.host.store.runtimeState() as typeof f.baseline;
      assert.equal(after.deliveries[0]!.state, "running");
      assert.equal(
        after.deliveries[0]!.rootId,
        f.baseline.deliveries[0]!.rootId,
      );
      assert.deepEqual(after.sessions, f.baseline.sessions);
      assert.deepEqual(
        f.calls.filter((call) => call.method !== "GET"),
        [],
      );
    } finally {
      hold.release();
      await f.close();
    }
  });
}

test("controlled HTTP new committed cancellation repairs a running input after startup unknown, duplicate tick does not replay", async () => {
  const f = await cancelledRootFixture();
  try {
    f.alter({ lifecycle: "open" });
    await f.run();
    assert.equal(
      (f.host.store.runtimeState() as typeof f.baseline).deliveries[0]!.state,
      "running",
    );
    f.alter({ lifecycle: "cancelled", wireCancel: true });
    await f.host.runtime.tick();
    const after = f.host.store.runtimeState() as typeof f.baseline;
    assert.equal(after.deliveries[0]!.state, "cancelled");
    assert.equal(Object.values(after.sessions)[0]!.cursor, 101);
    assert.deepEqual(
      Object.values(after.sessions)[0]!.events,
      [],
      "private cancellation is not a chat result",
    );
    const reads = f.calls.filter((call) =>
      call.path.includes("by-client-id"),
    ).length;
    await f.host.runtime.tick();
    assert.equal(
      f.calls.filter((call) => call.path.includes("by-client-id")).length,
      reads,
    );
    assert.deepEqual(
      f.calls.filter((call) => call.method !== "GET"),
      [],
    );
  } finally {
    await f.close();
  }
});

for (const page of [2, 4] as const) {
  test(`controlled HTTP exact cancellation proof on backward page ${page} remains bounded`, async () => {
    const f = await cancelledRootFixture();
    try {
      f.alter({ pageUntil: page });
      await f.run();
      assert.equal(
        (f.host.store.runtimeState() as typeof f.baseline).deliveries[0]!.state,
        "cancelled",
      );
      assert.equal(
        f.calls.filter((call) => call.path.includes("root_turn_id=")).length,
        page,
      );
      assert.deepEqual(
        f.calls.filter((call) => call.method !== "GET"),
        [],
      );
    } finally {
      await f.close();
    }
  });
}

test("controlled HTTP nondecreasing backward cursor refuses cancellation without retry", async () => {
  const f = await cancelledRootFixture();
  try {
    f.alter({ pages: true, repeatPage: true });
    await f.run();
    assert.equal(
      (f.host.store.runtimeState() as typeof f.baseline).deliveries[0]!.state,
      "running",
    );
    assert.equal(
      f.calls.filter((call) => call.path.includes("root_turn_id=")).length,
      2,
    );
    assert.deepEqual(
      f.calls.filter((call) => call.method !== "GET"),
      [],
    );
  } finally {
    await f.close();
  }
});

test("controlled gateway root proof uses actual Human identity headers and does not reclaim, while ordinary reads still do", async () => {
  const f = await cancelledRootFixture();
  const gateway = f.gateway();
  try {
    await gateway.runtime.tick();
    const after = f.host.store.runtimeState() as typeof f.baseline;
    assert.equal(after.deliveries[0]!.state, "cancelled");
    assert.deepEqual(
      f.calls.filter((call) => call.method !== "GET"),
      [],
    );
    const exact = f.calls.filter(
      (call) =>
        call.path.includes("by-client-id") ||
        call.path.includes("/turns/") ||
        call.path.includes("/family?") ||
        call.path.includes("root_turn_id="),
    );
    assert.equal(exact.length, 5);
    assert.ok(
      exact.every(
        (call) =>
          call.principal ===
          gateway.runtime.principalId(localAccess.principalId),
      ),
      "never service/Operator authority for root reconciliation",
    );
    assert.equal(gateway.config.operatorToken, undefined);
    await gateway.runtime.platformConversationHistory(
      { projectId: f.host.projectId, conversationId: f.host.projectId },
      localAccess,
    );
    assert.ok(
      f.calls.some(
        (call) =>
          call.method === "POST" &&
          call.path.endsWith("/principal") &&
          call.principal ===
            gateway.runtime.principalId(localAccess.principalId),
      ),
      "private no-reclaim mode does not weaken normal read membership protocol",
    );
  } finally {
    await gateway.runtime.stop();
    await f.close();
  }
});

test("controlled gateway held canonical proof rejects actual IdentityCenter retirement", async () => {
  const f = await cancelledRootFixture();
  const gateway = f.gateway();
  const hold = f.hold("root_turn_id=");
  try {
    const operation = gateway.runtime.tick();
    await hold.entered;
    gateway.retireHuman();
    hold.release();
    await operation;
    assert.equal(
      (f.host.store.runtimeState() as typeof f.baseline).deliveries[0]!.state,
      "running",
    );
    assert.deepEqual(
      f.calls.filter((call) => call.method !== "GET"),
      [],
    );
    assert.equal(
      f.calls.filter((call) => call.path.includes("/turns/")).length,
      1,
      "no late final read under a retired Human",
    );
  } finally {
    hold.release();
    await gateway.runtime.stop();
    await f.close();
  }
});

test("controlled gateway final Platform read recheck refuses a retired grant after complete canonical proof", async () => {
  const f = await cancelledRootFixture();
  const gateway = f.gateway();
  let authorizations = 0;
  gateway.runtime.bindPlatformReadAuthority(async (scope, access) => {
    const grant = await gateway.authorizer(scope, access);
    authorizations++;
    return authorizations === 1 ? grant : { ...grant, projectIds: [] };
  });
  try {
    await gateway.runtime.tick();
    assert.equal(
      authorizations,
      2,
      "actual Platform authority executes before and after all proof reads",
    );
    assert.equal(
      f.calls.filter((call) => call.path.includes("/turns/")).length,
      2,
    );
    assert.equal(
      (f.host.store.runtimeState() as typeof f.baseline).deliveries[0]!.state,
      "running",
    );
    assert.deepEqual(
      f.calls.filter((call) => call.method !== "GET"),
      [],
    );
  } finally {
    await gateway.runtime.stop();
    await f.close();
  }
});

test("real observer denied WebSocket retries are not new cancellation evidence or per-wake root proof retries", async () => {
  const f = await cancelledRootFixture();
  let unsubscribe: (() => void) | undefined;
  try {
    f.alter({ lifecycle: "open" });
    await f.run();
    const reads = f.calls.filter((call) =>
      call.path.includes("by-client-id"),
    ).length;
    const failedConnections = f.repeatedSocketFailure();
    unsubscribe = f.host.runtime.observeWorkspaceChanges(() => {});
    await failedConnections;
    assert.equal(
      f.calls.filter((call) => call.path.includes("by-client-id")).length,
      reads,
      "startup unknown is not retried by socket failure/resync hints",
    );
    assert.equal(
      (f.host.store.runtimeState() as typeof f.baseline).deliveries[0]!.state,
      "running",
    );
    assert.deepEqual(
      f.calls.filter((call) => call.method !== "GET"),
      [],
    );
  } finally {
    unsubscribe?.();
    await f.close();
  }
});
