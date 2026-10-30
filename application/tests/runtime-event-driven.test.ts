import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeBridge } from "../packages/application/src/runtime.js";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";
import {
  runtimeChangeFixture,
  pause,
  until,
  deferred,
} from "./runtime-change-fixture.js";

test("started Host reconciles committed changes without UI listeners or healthy polling, and coalesces changes received while busy", async () => {
  const peer = await runtimeChangeFixture(["session-one", "session-two"]);
  const f = await platformRuntimeHostFixture(
    { url: peer.origin, token: peer.token, namespace: "event-host" },
    { paused: false },
  );
  const runtime = f.runtime as RuntimeBridge & { [key: string]: any };
  const internal = runtime as any;
  const contextId = internal.contextId(f.projectId);
  for (const id of ["session-one", "session-two"])
    internal.state.sessions[id] = {
      id,
      projectId: f.projectId,
      conversationId: f.projectId,
      artifactId: null,
      scope: "workspace",
      sharedDefault: false,
      platform: true,
      cursor: 0,
      events: [],
      runtimePrincipalId: null,
      turnControl: false,
      schedules: false,
      hasWork: true,
    };
  let block = false,
    entered = false,
    failDelta = false;
  const held = deferred();
  peer.intercept(async (path) => {
    if (
      failDelta &&
      path.startsWith("/api/sessions/session-one/events?after_sequence=")
    ) {
      failDelta = false;
      return {
        status: 503,
        body: { error: "controlled single Session read failure" },
      };
    }
    if (path === "/api/status") {
      if (block) {
        entered = true;
        await held.promise;
        block = false;
      }
      return { body: { model: "fixture" } };
    }
    if (path === "/api/session-io/capabilities")
      return { body: { enabled: true } };
    if (path === "/api/approvals") return { body: { approvals: [] } };
    if (path.includes("/scheduler?"))
      return {
        body: {
          context_id: contextId,
          threads: [],
          objectives: [],
          schedules: [],
        },
      };
    if (path.startsWith("/api/delegations?"))
      return { body: { delegations: [], has_more: false } };
  });
  try {
    runtime.start();
    await until(
      () => peer.opens.length === 2,
      "Host did not establish its own invalidation owner",
    );
    await until(
      () => internal.state.connected && !internal.busy && !internal.wakeTimer,
      "startup did not settle",
    );
    await pause(150);
    const idle = peer.requests.length;
    await pause(3300);
    assert.equal(
      peer.requests.length,
      idle,
      "there must be no 1.2s Host status/activity/event scanner",
    );
    const off = runtime.observeWorkspaceChanges(() => {});
    off(); // UI lifetime is not the background outbox lifetime.
    const other = peer.requests.filter((r) =>
      r.path.startsWith("/api/sessions/session-two/events"),
    ).length;
    block = true;
    peer.append("session-one", "chat/progress");
    await until(
      () => entered,
      "committed event did not wake health/reconciliation",
    );
    for (let i = 0; i < 20; i++) peer.append("session-one", "chat/progress");
    await pause(150);
    held.resolve();
    await until(
      () =>
        internal.state.sessions["session-one"].cursor === 21 &&
        !internal.busy &&
        !internal.wakeTimer,
      "event received during a busy pass was lost",
    );
    assert.equal(
      peer.requests.filter((r) =>
        r.path.startsWith("/api/sessions/session-two/events"),
      ).length,
      other,
      "a changed Session must not reread unrelated Session deltas",
    );
    const settled = peer.requests.length;
    await pause(3300);
    assert.equal(
      peer.requests.length,
      settled,
      "successful event reconciliation leaves no idle read timer",
    );
    // A disconnected/missed interval larger than one bounded work pass must
    // finish without relying on the deleted periodic ticker.
    for (let n = 0; n < 2500; n++)
      peer.append("session-one", "chat/progress", {}, false);
    peer.append("session-one", "runtime/thread_completed");
    await until(
      () =>
        internal.state.sessions["session-one"].cursor === 2522 &&
        !internal.busy,
      "bounded missed-page recovery stopped before its accepted frontier",
    );
    failDelta = true;
    peer.append("session-one", "runtime/thread_completed");
    await until(
      () => internal.failedSessionReads.has("session-one"),
      "controlled data failure not retained",
    );
    assert.equal(
      internal.state.connected,
      true,
      "one failed delta cannot erase health",
    );
    await until(
      () =>
        internal.state.sessions["session-one"].cursor === 2523 &&
        !internal.busy,
      "the failed final delta was not retried without another event",
      6000,
    );
    assert.equal(
      peer.requests.filter((r) =>
        r.path.startsWith("/api/sessions/session-two/events"),
      ).length,
      other,
      "failed-data recovery retries only the affected Session",
    );
    const recovered = peer.requests.length;
    await pause(3300);
    assert.equal(
      peer.requests.length,
      recovered,
      "failure recovery returns to zero idle reads",
    );
    // Real EventBus hints may omit the physical sequence. The Host's accepted
    // HTTP delta must still advance reconnect, not replay hours of old hints.
    const unsequenced = peer.append(
      "session-one",
      "runtime/thread_completed",
      {},
      false,
    );
    const { sequence: _sequence, ...hint } = unsequenced;
    peer.send("session-one", hint);
    await until(
      () =>
        internal.state.sessions["session-one"].cursor === 2524 &&
        !internal.busy,
      "unsequenced hint did not reconcile the actual HTTP frontier",
    );
    const beforeReconnect = peer.requests.length;
    peer.disconnect("session-one");
    await until(() => peer.opens.length === 3, "no affected Session reconnect");
    await internal.executionObserver.sync();
    await until(
      () => !internal.busy && !internal.wakeTimer,
      "reconnect did not settle",
    );
    const replay = peer.requests
      .slice(beforeReconnect)
      .filter((r) => r.path.includes("/events?after_sequence="));
    assert.ok(replay.length > 0);
    assert.ok(
      replay.every((r) => r.path.includes("after_sequence=2524")),
      "reconnect must use the durable HTTP frontier, not the unsequenced stream's old head",
    );
  } finally {
    held.resolve();
    await f.close();
    await peer.close();
  }
});
