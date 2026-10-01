import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { localAccess } from "../packages/core/src/model.js";
import { activitySchema } from "../packages/core/src/conversation.js";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";

type Internals = {
  state: {
    connected: boolean;
    activity: any;
    sessions: Record<string, { platform?: unknown }>;
    threadBindings: Record<string, any>;
    deliveries: Array<{
      inputId: string;
      rootId: string | null;
      sessionId: string;
      platformSource: any;
      request: any;
    }>;
  };
  request(path: string): Promise<unknown>;
  refreshActivity(): Promise<void>;
};
const now = "2026-10-01T12:00:00.000Z";
const bounds = {
  limit: 200,
  has_more_threads: false,
  has_more_objectives: false,
};
const encoded = (value: any): any =>
  value === null
    ? { type: "null" }
    : Array.isArray(value)
      ? { type: "array", value: value.map(encoded) }
      : typeof value === "object"
        ? {
            type: "object",
            value: Object.fromEntries(
              Object.entries(value).map(([key, item]) => [key, encoded(item)]),
            ),
          }
        : {
            type: typeof value,
            value: typeof value === "number" ? String(value) : value,
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
      body: "TEST 当前工作覆盖",
      targetActantId: "morphz-agent",
    },
  });
  const internal = f.runtime as unknown as Internals;
  const delivery = internal.state.deliveries[0]!;
  delivery.rootId = "coverage-local-root";
  internal.state.connected = true;
  const contextId = `mw-context-${(f.store.runtimeState() as { namespace: string }).namespace}`;
  const thread = (
    id: string,
    lifecycle = "open",
    rootId = delivery.rootId!,
  ) => ({
    intent: `TEST ${id}`,
    phase: lifecycle === "open" ? "running" : "idle",
    thread: {
      id,
      kind: "execution",
      session_id: delivery.sessionId,
      context_id: contextId,
      root_turn_id: rootId,
      lifecycle,
      revision: 1,
      updated_at: now,
    },
  });
  const objective = (
    id: string,
    rootId = delivery.rootId!,
    status = "active",
  ) => ({
    readiness: { state: "runnable" },
    objective: {
      id,
      context_id: contextId,
      coordinator_session_id: delivery.sessionId,
      source_event_id: rootId,
      stated_objective: `TEST ${id}`,
      status,
      status_reason: null,
      parent_objective_id: null,
      updated_at: now,
    },
  });
  const remoteRoot = (rootId: string) => {
    const inputId = `${rootId}-input`;
    const request = structuredClone(delivery.request);
    request.client_message_id = inputId;
    request.client_metadata.source = {
      ...delivery.platformSource,
      body: `TEST 来自其他 Host 的 ${rootId}`,
    };
    request.message.content.value.input_id = inputId;
    return {
      event: {
        id: rootId,
        topic: "chat/user_message",
        sequence: 3,
        timestamp: now,
        payload: {
          session_id: delivery.sessionId,
          client_message_id: inputId,
          root_turn_id: rootId,
          session_io: {
            request: {
              ...request,
              client_metadata: encoded(request.client_metadata),
              message: {
                ...request.message,
                content: {
                  encoding: "json",
                  value: encoded(request.message.content.value),
                },
              },
            },
          },
        },
      },
    };
  };
  const read = () =>
    f.runtime.platformNavigationSnapshot(localAccess, [f.projectId]).runtime
      .activity!;
  return {
    f,
    internal,
    delivery,
    contextId,
    thread,
    objective,
    remoteRoot,
    read,
  };
}

test("空Host工作域无需scheduler请求即可完整为空，仍保留独立断线守门", async () => {
  const f = await platformRuntimeHostFixture();
  try {
    const internal = f.runtime as unknown as Internals;
    assert.equal(
      Object.values(internal.state.sessions).filter(
        (session) => session.platform,
      ).length,
      0,
    );
    let requests = 0;
    internal.request = async () => {
      requests++;
      throw new Error("空工作域不应读取scheduler");
    };
    internal.state.connected = true;
    await internal.refreshActivity();
    const connected = f.runtime.platformNavigationSnapshot(localAccess, [
      f.projectId,
    ]).runtime;
    assert.equal(requests, 0);
    assert.equal(connected.connected, true);
    assert.equal(connected.activity?.available, true);
    assert.equal(connected.activity?.openWorkComplete, true);
    assert.deepEqual(connected.activity?.threads, []);
    assert.deepEqual(connected.activity?.objectives, []);
    internal.state.connected = false;
    const disconnected = f.runtime.platformNavigationSnapshot(localAccess, [
      f.projectId,
    ]).runtime;
    // Coverage describes the bounded Host domain, never network availability.
    // The consumer must still use this independent connection guard.
    assert.equal(disconnected.connected, false);
    assert.equal(requests, 0);
  } finally {
    await f.close();
  }
});

test("满200条终态历史和丢失旧来源不阻止证明当前开放工作为空", async () => {
  const { f, internal, thread, read } = await fixture();
  try {
    let schedulerReads = 0;
    let rootReads = 0;
    internal.request = async (path) => {
      if (path.includes("/events/")) {
        rootReads++;
        throw new Error("旧来源不存在");
      }
      schedulerReads++;
      return {
        detail_bounds: bounds,
        objectives: [],
        threads: path.includes("include_terminal=true")
          ? Array.from({ length: 200 }, (_, i) =>
              thread(`ended-${i}`, "completed", `unavailable-old-root-${i}`),
            )
          : [],
      };
    };
    await internal.refreshActivity();
    const activity = read();
    assert.equal(activity.available, true);
    assert.equal(activity.truncated, true);
    assert.equal(activity.openWorkComplete, true);
    assert.deepEqual(activity.threads, []);
    assert.equal(schedulerReads, 2);
    assert.equal(rootReads, 16);
  } finally {
    await f.close();
  }
});

test("先核验开放线程和目标来源，200条历史不抢占原16次来源读取预算", async () => {
  const { f, internal, thread, objective, remoteRoot, read } = await fixture();
  try {
    const roots: string[] = [];
    let schedulerReads = 0;
    internal.request = async (path) => {
      if (path.includes("/events/")) {
        const rootId = path.split("/").at(-1)!;
        roots.push(rootId);
        if (["open-remote-root", "goal-remote-root"].includes(rootId))
          return remoteRoot(rootId);
        throw new Error("旧来源不存在");
      }
      schedulerReads++;
      return path.includes("include_terminal=false")
        ? {
            detail_bounds: bounds,
            threads: [thread("open-remote", "open", "open-remote-root")],
            objectives: [objective("open-goal", "goal-remote-root")],
          }
        : {
            detail_bounds: { ...bounds, has_more_objectives: true },
            threads: Array.from({ length: 200 }, (_, i) =>
              thread(`ended-${i}`, "completed", `old-root-${i}`),
            ),
            objectives: [],
          };
    };
    await internal.refreshActivity();
    const activity = read();
    assert.equal(activity.openWorkComplete, true);
    assert.equal(activity.truncated, true);
    assert.equal(activity.objectivesTruncated, true);
    assert.deepEqual(roots.slice(0, 2), [
      "open-remote-root",
      "goal-remote-root",
    ]);
    assert.equal(roots.length, 16);
    assert.equal(schedulerReads, 2);
    assert.equal(activity.threads[0]?.inputId, "open-remote-root-input");
    assert.equal(activity.objectives?.[0]?.inputId, "goal-remote-root-input");
    const hidden = f.runtime.platformNavigationSnapshot(localAccess, []).runtime
      .activity!;
    assert.deepEqual(hidden.threads, []);
    assert.deepEqual(hidden.objectives, []);
    const other = f.runtime.platformNavigationSnapshot(
      { principalId: "other-human", actantId: "other" },
      [f.projectId],
    ).runtime.activity!;
    assert.deepEqual(other.threads, []);
    assert.deepEqual(other.objectives, []);
  } finally {
    await f.close();
  }
});

test("缺当前目标、缺或截断当前bounds、开放来源失效与预算耗尽都不能证明完整", async () => {
  const { f, internal, thread, objective, read } = await fixture();
  try {
    const cases = [
      { detail_bounds: bounds, threads: [] },
      { objectives: [], threads: [] },
      {
        detail_bounds: { ...bounds, has_more_threads: true },
        objectives: [],
        threads: [],
      },
      {
        detail_bounds: { ...bounds, has_more_objectives: true },
        objectives: [],
        threads: [],
      },
      {
        detail_bounds: { limit: 200, has_more_threads: false },
        objectives: [],
        threads: [],
      },
      {
        detail_bounds: bounds,
        objectives: [],
        threads: [thread("unattributed", "open", "missing-open-root")],
      },
      {
        detail_bounds: bounds,
        objectives: [objective("unattributed-goal", "missing-goal-root")],
        threads: [],
      },
      {
        detail_bounds: bounds,
        objectives: [],
        threads: Array.from({ length: 17 }, (_, i) =>
          thread(`open-${i}`, "open", `open-budget-root-${i}`),
        ),
      },
    ];
    for (const active of cases) {
      let roots = 0;
      internal.request = async (path) => {
        if (path.includes("/events/")) {
          roots++;
          throw new Error("无法核验来源");
        }
        return path.includes("include_terminal=false")
          ? active
          : { detail_bounds: bounds, objectives: [], threads: [] };
      };
      await internal.refreshActivity();
      assert.equal(read().available, true);
      assert.equal(read().openWorkComplete, false);
      assert.ok(roots <= 16);
    }
    internal.request = async () => {
      throw new Error("读取失败");
    };
    await internal.refreshActivity();
    assert.equal(read().available, false);
    assert.equal(read().openWorkComplete, false);
  } finally {
    await f.close();
  }
});

test("相同线程revision的当前phase优先于历史，当前目标不依赖历史页出现", async () => {
  const { f, internal, thread, objective, read } = await fixture();
  try {
    internal.request = async (path) =>
      path.includes("include_terminal=false")
        ? {
            detail_bounds: bounds,
            threads: [thread("same")],
            objectives: [objective("current-only")],
          }
        : {
            detail_bounds: bounds,
            threads: [{ ...thread("same"), phase: "waiting" }],
          };
    await internal.refreshActivity();
    const activity = read();
    assert.equal(activity.openWorkComplete, true);
    assert.equal(activity.objectivesTruncated, true);
    assert.equal(activity.threads[0]?.phase, "running");
    assert.equal(activity.objectives?.[0]?.id, "current-only");
    const parsed = activitySchema.parse(activity);
    assert.equal(parsed.openWorkComplete, true);
    assert.equal(
      activitySchema.parse({ available: true, threads: [] }).openWorkComplete,
      undefined,
    );
  } finally {
    await f.close();
  }
});

test("scheduled root不是Event时按真实Schedule源关联，保留运行root且不额外授予continuation", async () => {
  const { f, internal, delivery, thread, read } = await fixture();
  try {
    const child = {
      ...thread("scheduled-child", "open", "non-event-runtime-root"),
      phase: "waiting",
    };
    const schedule = {
      id: "exact-runtime-schedule",
      thread_id: child.thread.id,
      source_turn_id: delivery.rootId!,
    };
    let eventReads = 0;
    let schedulerReads = 0;
    internal.request = async (path) => {
      if (path.includes("/events/")) {
        eventReads++;
        throw new Error("合成运行root没有Event，真实原始输入已在Host中");
      }
      schedulerReads++;
      return path.includes("include_terminal=false")
        ? {
            detail_bounds: bounds,
            threads: [{ ...child, schedules: [schedule] }],
            schedules: [schedule],
            objectives: [],
          }
        : { detail_bounds: bounds, threads: [], objectives: [] };
    };
    await internal.refreshActivity();
    const activity = read();
    assert.equal(activity.openWorkComplete, true);
    assert.equal(activity.threads[0]?.phase, "waiting");
    assert.equal(activity.threads[0]?.rootId, "non-event-runtime-root");
    assert.equal(activity.threads[0]?.inputId, delivery.inputId);
    assert.equal(
      activity.threads[0]?.projectId,
      delivery.platformSource.projectId,
    );
    assert.equal(activity.threads[0]?.continuation, undefined);
    assert.equal(eventReads, 0);
    assert.equal(schedulerReads, 2);
    // A schedule referring to another Thread is not a causal link for this one.
    internal.request = async (path) =>
      path.includes("/events/")
        ? Promise.reject(new Error("404"))
        : {
            detail_bounds: bounds,
            threads: [
              {
                ...child,
                schedules: [{ ...schedule, thread_id: "different-thread" }],
              },
            ],
            objectives: [],
          };
    await internal.refreshActivity();
    assert.equal(read().openWorkComplete, false);
    assert.deepEqual(read().threads, []);
  } finally {
    await f.close();
  }
});

test("scheduled_created目标沿同Session/Context的持久父线程到用户输入，不把控制事件当用户root", async () => {
  const { f, internal, delivery, contextId, objective, read } = await fixture();
  try {
    const sourceEventId = "runtime-objective-control-event";
    const goal = objective("scheduled-goal", sourceEventId);
    const parent = {
      id: "exact-parent-thread",
      sessionId: delivery.sessionId,
      rootId: delivery.rootId,
      projectId: delivery.platformSource.projectId,
    };
    internal.state.threadBindings[parent.id] = parent;
    const event = {
      id: sourceEventId,
      topic: "objective/scheduled_created",
      sequence: 3,
      timestamp: now,
      payload: {
        objective_id: goal.objective.id,
        session_id: delivery.sessionId,
        context_id: contextId,
        source_thread_id: parent.id,
        source_evaluation_id: "exact-runtime-evaluation",
      },
    };
    let eventReads = 0;
    internal.request = async (path) => {
      if (path.includes("/events/")) {
        eventReads++;
        assert.ok(path.endsWith("/" + sourceEventId));
        return { event };
      }
      return { detail_bounds: bounds, threads: [], objectives: [goal] };
    };
    await internal.refreshActivity();
    const activity = read();
    assert.equal(activity.openWorkComplete, true);
    assert.equal(activity.objectives?.[0]?.inputId, delivery.inputId);
    assert.equal(activity.objectives?.[0]?.rootId, delivery.rootId);
    assert.equal(
      activity.objectives?.[0]?.projectId,
      delivery.platformSource.projectId,
    );
    assert.equal(eventReads, 1);
    // Neither an absent parent nor a parent in another Session grants scope.
    for (const binding of [
      undefined,
      { ...parent, sessionId: "another-session" },
      { ...parent, projectId: "outside-context" },
    ]) {
      internal.state.threadBindings = binding ? { [parent.id]: binding } : {};
      const nextId = sourceEventId + String(eventReads);
      const nextGoal = {
        ...goal,
        objective: { ...goal.objective, source_event_id: nextId },
      };
      internal.request = async (path) => {
        if (path.includes("/events/")) {
          eventReads++;
          return { event: { ...event, id: nextId } };
        }
        return { detail_bounds: bounds, threads: [], objectives: [nextGoal] };
      };
      // A personal Context spans projects, so project names alone are not an
      // authorization test. A wrong root in that Context must fail as well.
      if (binding?.projectId === "outside-context")
        internal.state.threadBindings[parent.id]!.rootId =
          "unverifiable-parent-root";
      await internal.refreshActivity();
      assert.equal(read().openWorkComplete, false);
      assert.deepEqual(read().objectives, []);
    }
  } finally {
    await f.close();
  }
});

test("同一运行root的冲突来源与A→B→A持久来源环均有界拒绝", async () => {
  const { f, internal, delivery, thread, read } = await fixture();
  try {
    const a = thread("cycle-a", "open", "runtime-root-a");
    const b = thread("cycle-b", "open", "runtime-root-b");
    const schedule = (id: string, threadId: string, source: string) => ({
      id,
      thread_id: threadId,
      source_turn_id: source,
    });
    const cases = [
      [
        {
          ...a,
          schedules: [
            schedule("conflict-1", a.thread.id, delivery.rootId!),
            schedule("conflict-2", a.thread.id, "different-source-root"),
          ],
        },
      ],
      [
        {
          ...a,
          schedules: [
            schedule("cycle-a-b", a.thread.id, b.thread.root_turn_id),
          ],
        },
        {
          ...b,
          schedules: [
            schedule("cycle-b-a", b.thread.id, a.thread.root_turn_id),
          ],
        },
      ],
    ];
    for (const threads of cases) {
      let eventReads = 0;
      let schedulerReads = 0;
      internal.request = async (path) => {
        if (path.includes("/events/")) {
          eventReads++;
          throw new Error("冲突与环不应产生无界来源读取");
        }
        schedulerReads++;
        return path.includes("include_terminal=false")
          ? { detail_bounds: bounds, threads, objectives: [] }
          : { detail_bounds: bounds, threads: [], objectives: [] };
      };
      await internal.refreshActivity();
      assert.equal(read().openWorkComplete, false);
      assert.deepEqual(read().threads, []);
      assert.equal(schedulerReads, 2);
      assert.equal(eventReads, 0);
    }
  } finally {
    await f.close();
  }
});

test("已有真实root的已核验缓存优先于后来enqueue，不因冲突Schedule改归属", async () => {
  const { f, internal, delivery, thread, remoteRoot, read } = await fixture();
  try {
    const rootId = "verified-existing-event-root";
    const existing = thread("existing-thread", "open", rootId);
    let enqueue = false;
    let eventReads = 0;
    internal.request = async (path) => {
      if (path.includes("/events/")) {
        eventReads++;
        assert.ok(path.endsWith("/" + rootId));
        return remoteRoot(rootId);
      }
      return {
        detail_bounds: bounds,
        threads: [
          {
            ...existing,
            ...(enqueue
              ? {
                  schedules: [
                    {
                      id: "new-enqueue-1",
                      thread_id: existing.thread.id,
                      source_turn_id: delivery.rootId!,
                    },
                    {
                      id: "new-enqueue-2",
                      thread_id: existing.thread.id,
                      source_turn_id: "different-later-input",
                    },
                  ],
                }
              : {}),
          },
        ],
        objectives: [],
      };
    };
    await internal.refreshActivity();
    assert.equal(read().openWorkComplete, true);
    assert.equal(read().threads[0]?.inputId, rootId + "-input");
    assert.equal(eventReads, 1);
    enqueue = true;
    await internal.refreshActivity();
    assert.equal(read().openWorkComplete, true);
    assert.equal(read().threads[0]?.rootId, rootId);
    assert.equal(read().threads[0]?.inputId, rootId + "-input");
    assert.notEqual(read().threads[0]?.inputId, delivery.inputId);
    assert.equal(eventReads, 1);
  } finally {
    await f.close();
  }
});
