import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../packages/application/src/application.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";
import { RuntimeBridge } from "../packages/application/src/runtime.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import {
  PlatformStore,
  type PlatformAuthorityVerifier,
} from "../packages/platform/src/store.js";
import { localAccess, type AccessContext } from "../packages/core/src/model.js";
import {
  workspaceChangeSchema,
  type WorkspaceChange,
} from "../packages/core/src/workspace-changes.js";
import {
  deferred,
  pause,
  runtimeChangeFixture,
  until,
} from "./runtime-change-fixture.js";

const authority: PlatformAuthorityVerifier = {
  async resolveActor({ credential }) {
    const [tenantId, principalId] = credential.split(":");
    if (!tenantId || !principalId) return null;
    return {
      tenantId,
      principalId,
      actantId: principalId,
      kind: "human",
      runtimeInputId: null,
    };
  },
  async resolveActant({ actantId }) {
    return { principalId: actantId, kind: "human" };
  },
  async resolveProjectAgent() {
    return { principalId: "morphz-service", actantId: "morphz-agent" };
  },
  async verifyApplicationObject() {
    return false;
  },
};

async function hostFixture() {
  const directory = mkdtempSync(join(tmpdir(), "morphz-runtime-change-host-"));
  const ids = [
    "visible-session",
    "task-isolated-session",
    "private-session",
    "own-shared-session",
    "foreign-shared-session",
  ];
  const peer = await runtimeChangeFixture([
    ...ids,
    "historical-unbound-session",
  ]);
  const platform = await PlatformStore.sqlite(
    join(directory, "platform.sqlite"),
    authority,
  );
  const store = new WorkspaceStore(":memory:", { mode: "transport" });
  await platform.provisionTenant("observer-tenant");
  const credential = (access: AccessContext) => ({
    credential: `observer-tenant:${access.principalId}`,
  });
  await platform.createProject(credential(localAccess), {
    commandId: "create-readable",
    projectId: "visible",
    title: "Readable project",
  });
  await platform.createProject(
    { credential: "observer-tenant:bob" },
    {
      commandId: "create-private",
      projectId: "private",
      title: "Private project",
    },
  );
  const namespace = randomUUID();
  const sessions = Object.fromEntries(
    [...ids, "historical-unbound-session"].map((id) => [
      id,
      {
        id,
        projectId: id === "private-session" ? "private" : "visible",
        conversationId: "visible",
        artifactId: null,
        cursor: 0,
        events: [],
        platform: id !== "historical-unbound-session",
        sharedDefault: id.includes("shared"),
      },
    ]),
  );
  const deliveries = [
    ["own-shared-session", localAccess],
    ["foreign-shared-session", { principalId: "bob", actantId: "bob" }],
  ].map(([sessionId, author], index) => ({
    inputId: `retained-input-${index}`,
    sessionId,
    rootId: `retained-root-${index}`,
    state: "completed",
    error: null,
    request: {},
    platformSource: {
      projectId: "visible",
      conversationId: "visible",
      targetActantId: "morphz-agent",
      author,
      createdAt: "2026-10-02T12:00:00.000Z",
      sharedDefault: true,
    },
  }));
  store.saveRuntimeState({
    namespace,
    endpoint: peer.origin,
    connected: false,
    model: "",
    error: "",
    sessions,
    deliveries,
  });
  const runtime = new RuntimeBridge(
    store,
    { url: peer.origin, token: peer.token, namespace },
    undefined,
    false,
  );
  let reads = 0;
  let hold: ReturnType<typeof deferred> | undefined;
  let held = false;
  const application = new Application(store, {
    runtime,
    workspaceChanges: {
      sources: [platform.changeSource()],
      async readVersion(access, assertActive) {
        reads++;
        assertActive();
        const version = await platform.workspaceChangeVersion(
          credential(access),
        );
        if (hold) {
          const current = hold;
          hold = undefined;
          held = true;
          await current.promise;
        }
        assertActive();
        return version;
      },
    },
  });
  return {
    peer,
    platform,
    store,
    runtime,
    application,
    ids,
    reads: () => reads,
    holdNextRead(gate: ReturnType<typeof deferred>) {
      hold = gate;
      held = false;
    },
    held: () => held,
    async settled() {
      await until(
        () => peer.opens.length >= ids.length,
        "shared Runtime subscriptions missing",
      );
      await until(
        () =>
          peer.requests.filter((request) => request.path.includes("/events?"))
            .length >= ids.length,
        "initial Runtime catchup incomplete",
      );
      await pause(100);
    },
    async close() {
      hold?.resolve();
      await runtime.stop();
      await peer.close();
      await platform.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("Runtime Bridge shares one real WS per confirmed platform Session across Host listeners; committed job/approval/schedule events invalidate without chat history", async () => {
  const x = await hostFixture();
  const framesA: WorkspaceChange[] = [],
    framesB: WorkspaceChange[] = [];
  let closeA = 0,
    closeB = 0;
  const observe = (frames: WorkspaceChange[], closed: () => void) =>
    x.application
      .session(localAccess, () => {})
      .observeWorkspaceChanges(
        (frame) => frames.push(workspaceChangeSchema.parse(frame)),
        closed,
      );
  const disposeA = await observe(framesA, () => closeA++);
  const disposeB = await observe(framesB, () => closeB++);
  let disposeAgain: (() => void) | undefined;
  try {
    await x.settled();
    assert.equal(
      x.peer.opens.length,
      5,
      "two Host listeners must not duplicate Runtime sockets",
    );
    assert.deepEqual(
      x.peer.opens.map((open) => open.sessionId).sort(),
      x.ids.toSorted(),
    );
    assert.equal(x.peer.active(), 5);
    assert.equal(
      x.peer.opens.some(
        (open) => open.sessionId === "historical-unbound-session",
      ),
      false,
    );
    assert.ok(framesA[0]?.reason === "resync");
    assert.ok(framesB[0]?.reason === "resync");
    const navigationBefore = x.runtime.platformNavigationSnapshot(localAccess, [
      "visible",
    ]);
    const platformBefore = await x.platform.workspaceChangeVersion({
      credential: "observer-tenant:local-owner",
    });
    const initialReadCount = x.reads(),
      initialRequests = x.peer.requests.length;
    await pause(3300);
    assert.equal(
      x.reads(),
      initialReadCount,
      "Host authorization proof has no healthy refresh clock",
    );
    assert.equal(
      x.peer.requests.length,
      initialRequests,
      "WS subscription has no healthy history read clock",
    );

    for (const [id, topic] of [
      ["visible-session", "runtime/execution_progress"],
      ["task-isolated-session", "runtime/approval_requested"],
      ["own-shared-session", "runtime/schedule_updated"],
    ]) {
      const a = framesA.length,
        b = framesB.length;
      x.peer.append(id!, topic!, {
        secret_detail: "never put this into a browser frame",
      });
      await until(
        () => framesA.length > a && framesB.length > b,
        `${topic} did not invalidate both Host views`,
      );
      await pause(30);
      assert.equal(framesA.length, a + 1);
      assert.equal(framesB.length, b + 1);
      assert.equal(framesA.at(-1)!.reason, "changed");
      assert.equal(framesA.at(-1)!.accessChanged, false);
    }
    assert.deepEqual(
      x.runtime.platformNavigationSnapshot(localAccess, ["visible"]),
      navigationBefore,
      "navigation/history stayed byte-equivalent; execution version alone must wake the view",
    );
    assert.deepEqual(
      await x.platform.workspaceChangeVersion({
        credential: "observer-tenant:local-owner",
      }),
      platformBefore,
      "no Platform write manufactures these changes",
    );
    assert.equal(navigationBefore.runtime.messages.length, 0);
    assert.equal(
      [...x.peer.events.values()]
        .flat()
        .some((event) => event.topic.startsWith("chat/")),
      false,
    );
    for (const frame of [...framesA, ...framesB])
      assert.deepEqual(Object.keys(frame).sort(), [
        "accessChanged",
        "kind",
        "reason",
        "sequence",
      ]);

    disposeA();
    assert.equal(closeA, 1);
    await pause(40);
    assert.equal(
      x.peer.active(),
      5,
      "one listener remains => retain shared subscriptions",
    );
    const a = framesA.length,
      b = framesB.length;
    x.peer.append("task-isolated-session", "runtime/thread_terminal");
    await until(
      () => framesB.length > b,
      "remaining listener stopped observing",
    );
    assert.equal(
      framesA.length,
      a,
      "disposed Host listener publishes no frame",
    );
    assert.equal(x.peer.opens.length, 5);

    disposeB();
    assert.equal(closeB, 1);
    await until(
      () => x.peer.active() === 0,
      "last Host listener did not close WS resources",
    );
    const reads = x.reads(),
      requests = x.peer.requests.length;
    x.peer.append("visible-session", "runtime/approval_decision");
    await pause(120);
    assert.equal(x.reads(), reads);
    assert.equal(x.peer.requests.length, requests);

    const reopened: WorkspaceChange[] = [];
    disposeAgain = await observe(reopened, () => {});
    await until(
      () => x.peer.opens.length === 10,
      "new Host listener did not establish exactly one replacement per Session",
    );
    await until(
      () => reopened.length > 0,
      "new listener lacks initial authoritative resync",
    );
    assert.equal(x.peer.active(), 5);
    assert.equal(
      x.peer.opens.filter((open) => open.sessionId === "task-isolated-session")
        .length,
      2,
    );
  } finally {
    disposeA();
    disposeB();
    disposeAgain?.();
    await x.close();
  }
});

test("actual Platform grants and retained shared-input author scope prevent foreign Runtime Session events from producing browser frames", async () => {
  const x = await hostFixture();
  const frames: WorkspaceChange[] = [];
  const dispose = await x.application
    .session(localAccess, () => {})
    .observeWorkspaceChanges(
      (frame) => frames.push(workspaceChangeSchema.parse(frame)),
      () => {},
    );
  try {
    await x.settled();
    assert.deepEqual(
      (
        await x.platform.workspaceChangeVersion({
          credential: "observer-tenant:local-owner",
        })
      ).projectIds,
      ["visible"],
      "private is a real project belonging only to another Human",
    );
    const versionBefore = x.runtime.platformExecutionChangeVersion(
      localAccess,
      ["visible"],
    );
    const baseline = frames.length;
    for (const id of ["private-session", "foreign-shared-session"]) {
      const reads = x.reads();
      x.peer.append(id, "runtime/approval_requested", {
        secret: "foreign data",
      });
      await until(
        () => x.reads() > reads,
        "Host did not recheck current grants on Runtime hint",
      );
      await pause(40);
      assert.equal(
        frames.length,
        baseline,
        `${id} leaked an unauthorized wake`,
      );
      assert.equal(
        x.runtime.platformExecutionChangeVersion(localAccess, ["visible"]),
        versionBefore,
      );
    }
    const events = x.peer.append("visible-session", "runtime/thread_terminal");
    await until(
      () => frames.length === baseline + 1,
      "authorized event failed after foreign events",
    );
    const reads = x.reads();
    x.peer.send("visible-session", events);
    x.peer.send("visible-session", {
      ...events,
      sequence: 100,
      payload: { session_id: "private-session" },
    });
    const { sequence: _sequence, ...transient } = events;
    x.peer.send("visible-session", {
      ...transient,
      topic: "runtime/model_stream",
    });
    await pause(100);
    assert.equal(frames.length, baseline + 1);
    assert.equal(
      x.reads(),
      reads,
      "duplicate/foreign/transient WS must not even reread authorization",
    );
    await x.platform.reconcileOperatorMembers("observer-tenant", [
      {
        principalId: localAccess.principalId,
        actantId: localAccess.principalId,
        projectIds: [],
        enabled: false,
      },
    ]);
    await until(
      () => frames.length === baseline + 2,
      "actual grant revocation did not invalidate the view",
    );
    assert.equal(frames.at(-1)!.accessChanged, true);
    assert.deepEqual(
      (
        await x.platform.workspaceChangeVersion({
          credential: "observer-tenant:local-owner",
        })
      ).projectIds,
      [],
    );
    const revokedReads = x.reads();
    x.peer.append("visible-session", "runtime/approval_requested");
    await until(
      () => x.reads() > revokedReads,
      "revoked grants were not checked after Runtime hint",
    );
    await pause(80);
    assert.equal(
      frames.length,
      baseline + 2,
      "formerly readable Session must not wake the revoked user",
    );
  } finally {
    dispose();
    await x.close();
  }
});

test("Local connection identity invalidation closes shared Runtime resources and discards an in-flight old-authority frame", async () => {
  const x = await hostFixture();
  const connection = new LocalApplicationConnection(x.application);
  const boot = (await connection.call("platform.bootstrap")) as {
    csrfToken: string;
  };
  const frames: WorkspaceChange[] = [];
  let closed = 0;
  const id = randomUUID();
  const gate = deferred();
  try {
    await connection.observe(
      id,
      { kind: "workspace" },
      boot.csrfToken,
      (frame) => frames.push(workspaceChangeSchema.parse(frame)),
      () => closed++,
    );
    await x.settled();
    const baseline = frames.length;
    x.holdNextRead(gate);
    x.peer.append("visible-session", "runtime/approval_requested");
    await until(x.held, "authorization query was not held");
    connection.invalidate();
    assert.equal(closed, 1);
    await until(
      () => x.peer.active() === 0,
      "identity invalidation left Runtime WS connected",
    );
    gate.resolve();
    await pause(100);
    assert.equal(
      frames.length,
      baseline,
      "in-flight old-authority frame must never publish",
    );
    const reads = x.reads();
    x.peer.append("visible-session", "runtime/approval_decision");
    await pause(80);
    assert.equal(x.reads(), reads);
    await assert.rejects(
      connection.observe(
        randomUUID(),
        { kind: "workspace" },
        boot.csrfToken,
        () => {},
        () => {},
      ),
      /身份已切换/,
      "old identity generation cannot open another subscription",
    );
    assert.equal(x.peer.opens.length, 5);
  } finally {
    gate.resolve();
    connection.close();
    await x.close();
  }
});
