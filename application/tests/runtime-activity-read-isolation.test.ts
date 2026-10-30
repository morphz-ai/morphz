import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DomainError, localAccess } from "../packages/core/src/model.js";
import { activitySchema } from "../packages/core/src/conversation.js";
import { hostFailureDiagnostic } from "../packages/application/src/host-diagnostics.js";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";

const at = "2026-10-24T03:00:00.000Z";
const bounds = {
  limit: 200,
  has_more_threads: false,
  has_more_objectives: false,
  has_more_schedules: false,
};

async function fixture() {
  const f = await platformRuntimeHostFixture();
  const { dialogueId } = await f.session().ensurePlatformSpaces();
  await f.session().platformMessage({
    commandId: randomUUID(),
    operation: {
      type: "record-input",
      projectId: f.projectId,
      conversationId: dialogueId,
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body: "TEST isolated activity read",
      targetActantId: "morphz-agent",
    },
  });
  const internal = f.runtime as any;
  internal.state.connected = true;
  const delivery = internal.state.deliveries[0];
  delivery.rootId = "TEST-read-root";
  const contextId = internal.contextId(f.projectId) as string;
  const thread = (id: string, lifecycle = "open", revision = 1) => ({
    source: {
      event_id: delivery.rootId,
      context_id: contextId,
      session_id: delivery.sessionId,
      root_turn_id: delivery.rootId,
      activation_id: null,
    },
    phase: lifecycle === "open" ? "running" : "idle",
    intent: `TEST ${id}`,
    thread: {
      id,
      kind: "execution",
      session_id: delivery.sessionId,
      context_id: contextId,
      root_turn_id: delivery.rootId,
      lifecycle,
      control_state: "active",
      revision,
      updated_at: at,
    },
  });
  const view = (threads: unknown[] = []) => ({
    context_id: contextId,
    detail_bounds: bounds,
    objectives: [],
    schedules: [],
    threads,
  });
  const diagnostics: Array<ReturnType<typeof hostFailureDiagnostic>> = [];
  internal.host.reportFailure = (operation: string, error: unknown) =>
    diagnostics.push(hostFailureDiagnostic(operation, error));
  const read = () => activitySchema.parse(internal.state.activity);
  const request = internal.request.bind(internal);
  const route = (active: unknown, history: unknown) => {
    internal.request = async (path: string) => {
      if (path.startsWith("/api/delegations?"))
        return { delegations: [], has_more: false };
      const value = path.includes("include_terminal=false") ? active : history;
      if (value instanceof Error) throw value;
      return value;
    };
  };
  return {
    f,
    internal,
    delivery,
    contextId,
    thread,
    view,
    read,
    route,
    diagnostics,
    request,
  };
}

test("history timeout cannot erase a valid current inventory or claim stale open work is live", async () => {
  const x = await fixture();
  try {
    x.route(
      x.view([x.thread("old-open")]),
      x.view([x.thread("old-open"), x.thread("finished", "completed")]),
    );
    await x.internal.refreshActivity();
    x.route(
      x.view([x.thread("new-open", "open", 2)]),
      new DOMException("SECRET history body Bearer token", "TimeoutError"),
    );
    await x.internal.refreshActivity();
    const activity = x.read();
    assert.equal(activity.available, true);
    assert.equal(activity.openWorkComplete, true);
    assert.equal(activity.truncated, true);
    assert.equal(activity.objectivesTruncated, true);
    assert.deepEqual(activity.readScopes, [
      {
        contextId: x.contextId,
        currentAvailable: true,
        historyAvailable: false,
      },
    ]);
    assert.deepEqual(activity.threads.map((t) => t.id).sort(), [
      "finished",
      "new-open",
    ]);
    assert.equal(
      activity.threads.find((t) => t.id === "new-open")?.revision,
      2,
    );
    assert.equal(x.diagnostics.length, 1);
    assert.match(x.diagnostics[0]!.operation, /runtime\.activity\.history/);
    assert.match(x.diagnostics[0]!.operation, /timeout/);
    assert.doesNotMatch(
      JSON.stringify(x.diagnostics),
      /SECRET|Bearer|TEST-read-root|TEST isolated/,
    );
    assert.equal(
      x.internal.state.deliveries.length,
      1,
      "A read never creates or replays input",
    );
  } finally {
    await x.f.close();
  }
});

test("malformed history is locally diagnosed; a valid current-only Objective keeps its real Context", async () => {
  const x = await fixture();
  try {
    const active = x.view([x.thread("current")]);
    active.objectives = [
      {
        source: x.thread("current").source,
        readiness: { state: "runnable" },
        objective: {
          id: "TEST-current-goal",
          context_id: x.contextId,
          coordinator_session_id: x.delivery.sessionId,
          source_event_id: x.delivery.rootId,
          stated_objective: "TEST goal",
          status: "active",
          revision: 1,
          status_reason: null,
          parent_objective_id: null,
          updated_at: at,
        },
      },
    ] as never[];
    x.route(active, { threads: ["SECRET malformed payload"] });
    await x.internal.refreshActivity();
    const activity = x.read();
    assert.equal(activity.available, true);
    assert.equal(activity.openWorkComplete, true);
    assert.equal(activity.objectives?.[0]?.contextId, x.contextId);
    assert.equal(activity.objectives?.[0]?.id, "TEST-current-goal");
    assert.match(x.diagnostics[0]!.operation, /history.*schema/);
    assert.doesNotMatch(
      JSON.stringify(x.diagnostics),
      /SECRET|malformed payload/,
    );
  } finally {
    await x.f.close();
  }
});

test("a failed current read remains unknown despite a successful history read, and recovers on actual new facts", async () => {
  const x = await fixture();
  try {
    x.route(
      x.view([x.thread("known")]),
      x.view([x.thread("finished", "completed")]),
    );
    await x.internal.refreshActivity();
    x.route(
      new Error("SECRET current read unavailable"),
      x.view([x.thread("finished", "completed")]),
    );
    await x.internal.refreshActivity();
    const unavailable = x.read();
    assert.equal(unavailable.available, false);
    assert.equal(unavailable.openWorkComplete, false);
    assert.deepEqual(unavailable.readScopes, [
      {
        contextId: x.contextId,
        currentAvailable: false,
        historyAvailable: true,
      },
    ]);
    assert.ok(
      unavailable.threads.some((t) => t.id === "known"),
      "Retain scoped last-known data only as stale",
    );
    x.route(x.view([x.thread("known", "open", 3)]), x.view());
    await x.internal.refreshActivity();
    assert.equal(x.read().available, true);
    assert.equal(x.read().threads[0]?.revision, 3);
  } finally {
    await x.f.close();
  }
});

test("HTTP403/404 and a changed Session registry cannot resurrect cached activity", async () => {
  const x = await fixture();
  try {
    for (const status of [403, 404]) {
      x.route(
        x.view([x.thread("known")]),
        x.view([x.thread("finished", "completed")]),
      );
      await x.internal.refreshActivity();
      x.internal.request = x.request;
      x.internal.host.request = async () =>
        new Response("SECRET denied body", { status });
      await x.internal.refreshActivity();
      assert.equal(x.read().available, false);
      assert.deepEqual(x.read().threads, []);
    }
    x.route(
      x.view([x.thread("known")]),
      x.view([x.thread("finished", "completed")]),
    );
    await x.internal.refreshActivity();
    const session = x.internal.state.sessions[x.delivery.sessionId];
    delete x.internal.state.sessions[x.delivery.sessionId];
    await x.internal.refreshActivity();
    x.internal.state.sessions[x.delivery.sessionId] = session;
    x.route(new Error("unavailable"), new Error("unavailable"));
    await x.internal.refreshActivity();
    assert.deepEqual(x.read().threads, []);
    assert.doesNotMatch(JSON.stringify(x.diagnostics), /SECRET|denied body/);
  } finally {
    await x.f.close();
  }
});

test("principal-scoped cache never crosses an actor change", async () => {
  const x = await fixture();
  try {
    x.route(
      x.view([x.thread("known")]),
      x.view([x.thread("finished", "completed")]),
    );
    await x.internal.refreshActivity();
    x.route(new Error("unavailable"), new Error("unavailable"));
    await x.internal.as(
      { principalId: "TEST-other", actantId: "TEST-other-human" },
      () => x.internal.refreshActivity(),
    );
    assert.equal(x.read().available, false);
    assert.deepEqual(x.read().threads, []);
    assert.equal(localAccess.principalId, "local-owner");
  } finally {
    await x.f.close();
  }
});

test("a successful current response followed by history401/403/404 fails that authority domain closed", async () => {
  const x = await fixture();
  try {
    for (const status of [401, 403, 404]) {
      x.route(
        x.view([x.thread("known")]),
        x.view([x.thread("finished", "completed")]),
      );
      await x.internal.refreshActivity();
      x.internal.request = x.request;
      x.internal.host.request = async (input: string) =>
        String(input).includes("include_terminal=true")
          ? new Response("SECRET denied history", { status })
          : Response.json(x.view([x.thread("new-current", "open", 2)]));
      await x.internal.refreshActivity();
      const activity = x.read();
      assert.equal(activity.available, false);
      assert.equal(activity.openWorkComplete, false);
      assert.deepEqual(activity.threads, []);
      assert.deepEqual(activity.readScopes, [
        {
          contextId: x.contextId,
          currentAvailable: false,
          historyAvailable: false,
        },
      ]);
      assert.equal(x.internal.activitySnapshotCache.size, 0);
    }
    assert.doesNotMatch(JSON.stringify(x.diagnostics), /SECRET|denied history/);
  } finally {
    await x.f.close();
  }
});

test("historyHTTP503 retains fresh current facts without widening or replaying their source", async () => {
  const x = await fixture();
  try {
    x.route(
      x.view([x.thread("old-open")]),
      x.view([x.thread("finished", "completed")]),
    );
    await x.internal.refreshActivity();
    x.internal.request = x.request;
    x.internal.host.request = async (input: string) => {
      if (String(input).includes("/api/delegations?"))
        return Response.json({ delegations: [], has_more: false });
      return String(input).includes("include_terminal=true")
        ? new Response("SECRET upstream body", { status: 503 })
        : Response.json(x.view([x.thread("new-current", "open", 2)]));
    };
    await x.internal.refreshActivity();
    const activity = x.read();
    assert.equal(activity.available, true);
    assert.equal(activity.openWorkComplete, true);
    assert.deepEqual(activity.threads.map((t) => t.id).sort(), [
      "finished",
      "new-current",
    ]);
    assert.equal(
      activity.threads.find((t) => t.id === "new-current")?.sessionId,
      x.delivery.sessionId,
    );
    assert.equal(
      activity.threads.find((t) => t.id === "new-current")?.inputId,
      x.delivery.inputId,
    );
    assert.match(x.diagnostics[0]!.operation, /history.*http-503/);
    assert.doesNotMatch(JSON.stringify(x.diagnostics), /SECRET|upstream body/);
    assert.equal(x.internal.state.deliveries.length, 1);
  } finally {
    await x.f.close();
  }
});

/** Controlled registered-Session domains, not a new business authorization
 * implementation. The original source validation and canonical Session ID
 * function still execute for every projected fixture row. */
function addContext(x: Awaited<ReturnType<typeof fixture>>, index: number) {
  const projectId = `TEST-context-project-${index}`;
  const conversationId = `TEST-context-conversation-${index}`;
  const contextId = `TEST-context-${index}`;
  const previousContextId = x.internal.contextId.bind(x.internal);
  x.internal.contextId = (project: string) =>
    project === projectId ? contextId : previousContextId(project);
  const sessionId = x.internal.objectSessionId(
    projectId,
    conversationId,
    false,
  );
  const source = {
    ...x.delivery.platformSource,
    projectId,
    conversationId,
    sharedDefault: false,
  };
  const delivery = {
    ...x.delivery,
    inputId: `TEST-input-${index}`,
    rootId: `TEST-root-${index}`,
    sessionId,
    platformSource: source,
  };
  x.internal.state.sessions[sessionId] = {
    ...x.internal.state.sessions[x.delivery.sessionId],
    id: sessionId,
    projectId,
    conversationId,
    sharedDefault: false,
  };
  x.internal.state.deliveries.push(delivery);
  const thread = (revision = 1) => {
    const value = x.thread(`TEST-branch-${index}`, "open", revision);
    value.source = {
      ...value.source,
      event_id: delivery.rootId,
      context_id: contextId,
      session_id: sessionId,
      root_turn_id: delivery.rootId,
    };
    value.thread = {
      ...value.thread,
      context_id: contextId,
      session_id: sessionId,
      root_turn_id: delivery.rootId,
    };
    return value;
  };
  return {
    contextId,
    sessionId,
    projectId,
    conversationId,
    delivery,
    thread,
    view: (revision = 1) => ({
      ...x.view([thread(revision)]),
      context_id: contextId,
    }),
  };
}

test("one failed Context does not discard another Context's fresh facts, while global coverage remains unknown", async () => {
  const x = await fixture();
  try {
    const other = addContext(x, 2);
    let failOther = false;
    x.internal.request = async (path: string) => {
      if (path.startsWith("/api/delegations?"))
        return { delegations: [], has_more: false };
      if (path.includes(other.contextId)) {
        if (failOther && path.includes("include_terminal=false"))
          throw new Error("SECRET other Context unavailable");
        return other.view();
      }
      return x.view([x.thread("current", "open", failOther ? 2 : 1)]);
    };
    await x.internal.refreshActivity();
    failOther = true;
    await x.internal.refreshActivity();
    const activity = x.read();
    assert.equal(activity.available, false);
    assert.equal(activity.openWorkComplete, false);
    assert.deepEqual(activity.readScopes, [
      {
        contextId: x.contextId,
        currentAvailable: true,
        historyAvailable: true,
      },
      {
        contextId: other.contextId,
        currentAvailable: false,
        historyAvailable: true,
      },
    ]);
    assert.equal(
      activity.threads.find((t) => t.contextId === x.contextId)?.revision,
      2,
    );
    assert.equal(
      activity.threads.find((t) => t.contextId === other.contextId)?.revision,
      1,
    );
    assert.equal(
      activity.threads.find((t) => t.contextId === other.contextId)?.sessionId,
      other.sessionId,
    );
    assert.doesNotMatch(
      JSON.stringify(x.diagnostics),
      /SECRET|other Context unavailable/,
    );
  } finally {
    await x.f.close();
  }
});

test("a Session registry change during reads rejects both results and old fallback", async () => {
  const x = await fixture();
  try {
    x.route(
      x.view([x.thread("known")]),
      x.view([x.thread("finished", "completed")]),
    );
    await x.internal.refreshActivity();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    x.internal.request = async (path: string) => {
      if (path.includes("include_terminal=false")) await held;
      return x.view([x.thread("must-not-publish")]);
    };
    const reading = x.internal.refreshActivity();
    delete x.internal.state.sessions[x.delivery.sessionId];
    release();
    await reading;
    assert.equal(x.read().available, false);
    assert.deepEqual(x.read().threads, []);
    assert.equal(x.internal.activitySnapshotCache.size, 0);
    assert.match(x.diagnostics[0]!.operation, /current.*forbidden/);
  } finally {
    await x.f.close();
  }
});

test("read evidence cache is private, bounded and not a persisted execution store", async () => {
  const x = await fixture();
  try {
    const contexts = Array.from({ length: 20 }, (_, i) => addContext(x, i + 2));
    x.internal.request = async (path: string) => {
      if (path.startsWith("/api/delegations?"))
        return { delegations: [], has_more: false };
      return (
        contexts
          .find((value) => path.includes(`${value.contextId}/`))
          ?.view() ?? x.view([x.thread("first")])
      );
    };
    await x.internal.refreshActivity();
    assert.equal(x.read().available, true);
    assert.equal(x.read().readScopes?.length, 21);
    assert.equal(x.internal.activitySnapshotCache.size, 16);
    assert.ok(
      [...x.internal.activitySnapshotCache.keys()].every((key) =>
        /^[a-f0-9]{64}$/.test(key),
      ),
    );
    assert.equal(
      Object.hasOwn(
        x.f.store.runtimeState() as object,
        "activitySnapshotCache",
      ),
      false,
    );
  } finally {
    await x.f.close();
  }
});

test("later Context reads cannot publish an earlier Context after its Session was removed", async () => {
  const x = await fixture();
  try {
    const other = addContext(x, 2);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const readingOther = new Promise<void>((resolve) => {
      entered = resolve;
    });
    x.internal.request = async (path: string) => {
      if (path.startsWith("/api/delegations?"))
        return { delegations: [], has_more: false };
      if (path.includes(other.contextId)) {
        if (path.includes("include_terminal=false")) {
          entered();
          await held;
        }
        return other.view();
      }
      return x.view([x.thread("must-not-outlive-registration")]);
    };
    const reading = x.internal.refreshActivity();
    await readingOther;
    delete x.internal.state.sessions[x.delivery.sessionId];
    release();
    await reading;
    const activity = x.read();
    assert.equal(activity.available, false);
    assert.equal(activity.openWorkComplete, false);
    assert.equal(
      activity.readScopes?.find((scope) => scope.contextId === x.contextId)
        ?.currentAvailable,
      false,
    );
    assert.equal(
      activity.readScopes?.find((scope) => scope.contextId === other.contextId)
        ?.currentAvailable,
      true,
    );
    assert.deepEqual(
      activity.threads.map((thread) => thread.id),
      ["TEST-branch-2"],
    );
  } finally {
    await x.f.close();
  }
});

test("a newly registered Context stays explicitly unread until a subsequent actual refresh", async () => {
  const x = await fixture();
  try {
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    x.internal.request = async (path: string) => {
      if (path.startsWith("/api/delegations?"))
        return { delegations: [], has_more: false };
      if (path.includes("include_terminal=false")) {
        entered();
        await held;
      }
      return x.view([x.thread("current")]);
    };
    const reading = x.internal.refreshActivity();
    await started;
    const other = addContext(x, 2);
    release();
    await reading;
    const activity = x.read();
    assert.equal(activity.available, false);
    assert.equal(activity.openWorkComplete, false);
    assert.deepEqual(activity.readScopes, [
      {
        contextId: x.contextId,
        currentAvailable: true,
        historyAvailable: true,
      },
      {
        contextId: other.contextId,
        currentAvailable: false,
        historyAvailable: false,
      },
    ]);
    assert.deepEqual(
      activity.threads.map((thread) => thread.id),
      ["current"],
    );
  } finally {
    await x.f.close();
  }
});

test("navigation and conversation history disclose freshness only inside each Principal's current grant", async () => {
  const x = await fixture();
  try {
    const other = addContext(x, 2);
    const otherAccess = {
      principalId: "TEST-second-principal",
      actantId: "TEST-second-human",
    };
    other.delivery.platformSource.author = otherAccess;
    const second = other.view();
    second.threads = [];
    second.objectives = [
      {
        source: other.thread().source,
        readiness: { state: "runnable" },
        objective: {
          id: "TEST-only-goal",
          context_id: other.contextId,
          coordinator_session_id: other.sessionId,
          source_event_id: other.delivery.rootId,
          stated_objective: "TEST second private goal",
          status: "active",
          revision: 1,
          status_reason: null,
          parent_objective_id: null,
          updated_at: at,
        },
      },
    ] as never[];
    x.internal.request = async (path: string) =>
      path.startsWith("/api/delegations?")
        ? { delegations: [], has_more: false }
        : path.includes(other.contextId)
          ? second
          : x.view([x.thread("first-only")]);
    await x.internal.refreshActivity();
    assert.equal(
      x.read().readScopes?.length,
      2,
      "The internal operator read covers both registered domains",
    );
    const first = x.f.runtime.platformNavigationSnapshot(localAccess, [
      x.f.projectId,
    ]).runtime.activity!;
    const secondPrincipal = x.f.runtime.platformNavigationSnapshot(
      otherAccess,
      [other.projectId],
    ).runtime.activity!;
    assert.deepEqual(
      first.readScopes?.map((scope) => scope.contextId),
      [x.contextId],
    );
    assert.deepEqual(
      secondPrincipal.readScopes?.map((scope) => scope.contextId),
      [other.contextId],
    );
    assert.deepEqual(secondPrincipal.threads, []);
    assert.equal(
      secondPrincipal.objectives?.[0]?.contextId,
      other.contextId,
      "An authorized Objective needs no loaded Thread to retain its own read Context",
    );
    assert.doesNotMatch(
      JSON.stringify(first.readScopes),
      new RegExp(other.contextId),
    );
    assert.doesNotMatch(
      JSON.stringify(secondPrincipal.readScopes),
      new RegExp(x.contextId),
    );
    assert.deepEqual(
      x.f.runtime.platformNavigationSnapshot(otherAccess, []).runtime.activity
        ?.readScopes,
      [],
    );
    x.internal.authorizePlatformRead = async (
      scope: { projectId: string },
      access: typeof localAccess,
    ) => {
      if (
        scope.projectId === x.f.projectId &&
        access.principalId === localAccess.principalId
      )
        return {
          personalDefault: x.delivery.platformSource.sharedDefault,
          projectIds: [x.f.projectId],
        };
      if (
        scope.projectId === other.projectId &&
        access.principalId === otherAccess.principalId
      )
        return { personalDefault: false, projectIds: [other.projectId] };
      throw new DomainError("forbidden", "TEST revoked project grant");
    };
    x.internal.request = async () => ({ entries: [], next_before: null });
    const firstHistory = await x.f.runtime.platformConversationHistory(
      {
        projectId: x.f.projectId,
        conversationId: x.delivery.platformSource.conversationId,
      },
      localAccess,
    );
    const otherHistory = await x.f.runtime.platformConversationHistory(
      { projectId: other.projectId, conversationId: other.conversationId },
      otherAccess,
    );
    assert.deepEqual(
      Object.hasOwn(firstHistory.runtime, "readScopes"),
      false,
      "Read scopes are part of activity, not a new global authority DTO",
    );
    assert.deepEqual(
      firstHistory.runtime.activity?.readScopes?.map(
        (scope) => scope.contextId,
      ),
      [x.contextId],
    );
    assert.deepEqual(
      otherHistory.runtime.activity?.readScopes?.map(
        (scope) => scope.contextId,
      ),
      [other.contextId],
    );
    await assert.rejects(
      x.f.runtime.platformConversationHistory(
        { projectId: other.projectId, conversationId: other.conversationId },
        localAccess,
      ),
      (error: unknown) =>
        error instanceof DomainError && error.code === "forbidden",
    );
  } finally {
    await x.f.close();
  }
});
