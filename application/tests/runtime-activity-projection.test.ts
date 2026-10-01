import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { localAccess } from "../packages/core/src/model.js";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";

type Source = {
  projectId: string;
  conversationId: string;
  sharedDefault: boolean;
  body: string;
  author: { principalId: string; actantId: string };
};
type Internals = {
  state: {
    connected: boolean;
    directedInput: boolean;
    activity: any;
    sessions: Record<string, any>;
    deliveries: Array<{
      inputId: string;
      rootId: string | null;
      sessionId: string;
      platformSource: Source;
      request: any;
    }>;
  };
  request(path: string): Promise<unknown>;
  refreshActivity(): Promise<void>;
};
const now = "2026-10-01T12:00:00.000Z";
const data = (value: any): any =>
  value === null
    ? { type: "null" }
    : Array.isArray(value)
      ? { type: "array", value: value.map(data) }
      : typeof value === "object"
        ? {
            type: "object",
            value: Object.fromEntries(
              Object.entries(value).map(([key, item]) => [key, data(item)]),
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
      body: "原始输入，不是短标题",
      targetActantId: "morphz-agent",
    },
  });
  const internal = f.runtime as unknown as Internals;
  const delivery = internal.state.deliveries[0]!;
  delivery.rootId = "root-input";
  internal.state.connected = true;
  internal.state.directedInput = true;
  const contextId = `mw-context-${(f.store.runtimeState() as { namespace: string }).namespace}`;
  const thread = (
    id: string,
    lifecycle = "open",
    rootId = delivery.rootId!,
  ) => ({
    intent: `工作意图 ${id}`,
    phase: lifecycle === "open" ? "running" : "idle",
    thread: {
      id,
      kind: "execution",
      session_id: delivery.sessionId,
      context_id: contextId,
      root_turn_id: rootId,
      lifecycle,
      control_state: "active",
      generation: 1,
      executor_kind: "self",
      revision: 1,
      created_at: now,
      updated_at: now,
      supervision: {
        supervisor_kind: "objective",
        supervisor_id: "objective-1",
        generation: 1,
        origin_evaluation_id: null,
        parent_thread_id: null,
      },
    },
    outcome:
      lifecycle === "open"
        ? null
        : {
            terminal_kind: lifecycle,
            disposition: "no_reply",
            summary: "真实执行结果",
            created_at: now,
          },
  });
  const bounds = {
    limit: 200,
    has_more_threads: false,
    has_more_objectives: false,
  };
  const objective = {
    readiness: { state: "runnable" },
    objective: {
      id: "objective-1",
      context_id: contextId,
      coordinator_session_id: delivery.sessionId,
      source_event_id: delivery.rootId,
      stated_objective: "真实持久目标",
      status: "active",
      status_reason: null,
      parent_objective_id: null,
      updated_at: now,
    },
  };
  return { f, internal, delivery, thread, bounds, objective, contextId };
}

test("活动由真实线程投影，保留终态事实、原intent、目标和运行线程", async () => {
  const { f, internal, delivery, thread, bounds, objective } = await fixture();
  try {
    const calls: string[] = [];
    internal.request = async (path) => {
      calls.push(path);
      return {
        detail_bounds: bounds,
        threads: path.includes("include_terminal=true")
          ? [thread("ended", "completed")]
          : [thread("active")],
        objectives: [objective],
      };
    };
    await internal.refreshActivity();
    const activity = f.runtime.platformNavigationSnapshot(localAccess, [
      f.projectId,
    ]).runtime.activity!;
    assert.equal(calls.length, 2);
    assert.equal(activity.truncated, false);
    assert.equal(activity.objectivesTruncated, false);
    assert.deepEqual(
      activity.threads.map((t) => t.id),
      ["ended", "active"],
    );
    const ended = activity.threads[0]!;
    assert.equal(ended.title, "工作意图 ended");
    assert.equal(ended.inputId, delivery.inputId);
    assert.equal(ended.lifecycle, "completed");
    assert.equal(ended.phase, "idle");
    assert.equal(ended.outcome?.summary, "真实执行结果");
    assert.equal(ended.continuation, undefined);
    assert.ok(activity.threads[1]!.continuation);
    assert.deepEqual(activity.objectives?.[0]?.threadIds, ["ended", "active"]);
    assert.equal(
      f.runtime.platformNavigationSnapshot(localAccess, []).runtime.activity!
        .threads.length,
      0,
    );
    assert.equal(
      f.runtime.platformNavigationSnapshot(localAccess, []).runtime.activity!
        .objectives?.length,
      0,
    );
    assert.equal(
      f.runtime.platformNavigationSnapshot(
        { principalId: "other-human", actantId: "other" },
        [f.projectId],
      ).runtime.activity!.threads.length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("另一Host的来源取持久root且不猜共享Session的项目，查源有界并缓存", async () => {
  const { f, internal, delivery, thread, bounds } = await fixture();
  try {
    const remoteId = "remote-input";
    const remoteSource = {
      ...delivery.platformSource,
      body: "另一Host原始输入",
    };
    const request = structuredClone(delivery.request);
    request.client_message_id = remoteId;
    request.client_metadata.source = remoteSource;
    request.message.content.value.input_id = remoteId;
    const root = {
      id: "remote-root",
      topic: "chat/user_message",
      sequence: 3,
      timestamp: now,
      payload: {
        session_id: delivery.sessionId,
        client_message_id: remoteId,
        root_turn_id: "remote-root",
        session_io: {
          request: {
            ...request,
            client_metadata: data(request.client_metadata),
            message: {
              ...request.message,
              content: {
                encoding: "json",
                value: data(request.message.content.value),
              },
            },
          },
        },
      },
    };
    let lookups = 0;
    internal.request = async (path) => {
      if (path.endsWith("/remote-root")) {
        lookups++;
        return { event: root };
      }
      if (path.includes("/events/")) {
        lookups++;
        throw new Error("unknown root");
      }
      return {
        detail_bounds: bounds,
        objectives: [],
        threads: [
          thread("remote", "completed", "remote-root"),
          thread("unknown", "open", "unknown-root"),
        ],
      };
    };
    await internal.refreshActivity();
    const activity = f.runtime.platformNavigationSnapshot(localAccess, [
      f.projectId,
    ]).runtime.activity!;
    assert.deepEqual(
      activity.threads.map((t) => t.id),
      ["remote"],
    );
    assert.equal(activity.threads[0]!.inputId, remoteId);
    assert.equal(activity.threads[0]!.continuation, undefined);
    assert.equal(activity.truncated, true);
    await internal.refreshActivity();
    assert.equal(lookups, 2);
  } finally {
    await f.close();
  }
});

test("Runtime bounds 而非数组长度判完整性，缺目标能力不伪装完整空列表", async () => {
  const { f, internal, thread, bounds } = await fixture();
  try {
    internal.request = async () => ({
      detail_bounds: { ...bounds, has_more_threads: true },
      threads: [thread("bounded")],
    });
    await internal.refreshActivity();
    assert.equal(internal.state.activity.truncated, true);
    assert.equal(internal.state.activity.objectivesTruncated, true);
    internal.request = async () => {
      throw new Error("Runtime offline");
    };
    await internal.refreshActivity();
    assert.equal(internal.state.activity.available, false);
    assert.equal(internal.state.activity.threads.length, 1);
  } finally {
    await f.close();
  }
});

test("同一个共享Session内的线程和目标各自按持久输入项目授权", async () => {
  const { f, internal, delivery, thread, bounds, objective } = await fixture();
  try {
    const secondProject = "another-authorized-project";
    await f.session().createPlatformProject({ commandId: randomUUID(), projectId: secondProject, title: "另一个项目" });
    await f.session().platformMessage({ commandId: randomUUID(), operation: {
      type: "record-input", projectId: secondProject, conversationId: delivery.platformSource.conversationId,
      artifactId: null, artifactRevision: null, selection: "", body: "另一个项目的工作", targetActantId: "morphz-agent",
    } });
    const second = internal.state.deliveries[1]!;
    assert.equal(second.sessionId, delivery.sessionId);
    second.rootId = "second-root";
    internal.request = async () => ({ detail_bounds: bounds,
      threads: [thread("first"), thread("second", "completed", second.rootId!)],
      objectives: [objective, { ...objective, objective: { ...objective.objective, id: "second-objective", source_event_id: second.rootId } }],
    });
    await internal.refreshActivity();
    const firstOnly = f.runtime.platformNavigationSnapshot(localAccess, [f.projectId]).runtime.activity!;
    assert.deepEqual(firstOnly.threads.map((t) => t.id), ["first"]);
    assert.deepEqual(firstOnly.objectives!.map((o) => o.id), ["objective-1"]);
    const secondOnly = f.runtime.platformNavigationSnapshot(localAccess, [secondProject]).runtime.activity!;
    assert.deepEqual(secondOnly.threads.map((t) => t.id), ["second"]);
    assert.deepEqual(secondOnly.objectives!.map((o) => o.id), ["second-objective"]);
  } finally { await f.close(); }
});

test("满历史页保持有界披露，未知roots每次刷新最多16次读取", async () => {
  const { f, internal, thread, bounds } = await fixture();
  try {
    let lookups = 0;
    internal.request = async (path) => {
      if (path.includes("/events/")) { lookups++; throw new Error("unknown"); }
      return { detail_bounds: bounds, objectives: [], threads: Array.from({ length: 200 }, (_, index) => thread(`thread-${index}`, "completed")) };
    };
    await internal.refreshActivity();
    assert.equal(internal.state.activity.truncated, true);
    assert.equal(lookups, 0);
    internal.request = async (path) => {
      if (path.includes("/events/")) { lookups++; throw new Error("unknown"); }
      return { detail_bounds: bounds, objectives: [], threads: Array.from({ length: 40 }, (_, index) => thread(`unknown-${index}`, "completed", `unknown-root-${index}`)) };
    };
    await internal.refreshActivity();
    assert.equal(lookups, 16);
    assert.equal(internal.state.activity.threads.length, 0);
  } finally { await f.close(); }
});
