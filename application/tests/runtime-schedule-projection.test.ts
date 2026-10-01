import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { localAccess } from "../packages/core/src/model.js";
import type { ExecutionActivity } from "../packages/core/src/conversation.js";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { createAppServer } from "../apps/service/src/http.js";
import { createServer } from "node:net";

const stamp = "2026-10-01T12:00:00.000Z";
const due = "2026-10-03T05:30:00.000Z";
type Internals = {
  state: {
    connected: boolean;
    activity?: ExecutionActivity;
    deliveries: Array<{
      inputId: string;
      rootId: string | null;
      sessionId: string;
      platformSource: {
        projectId: string;
        conversationId: string;
        sharedDefault: boolean;
        author: { principalId: string; actantId: string };
      };
    }>;
  };
  request(path: string, method?: string): Promise<unknown>;
  refreshActivity(): Promise<void>;
  save(): void;
};

async function fixture() {
  const f = await platformRuntimeHostFixture();
  const { dialogueId } = await f.session().ensurePlatformSpaces();
  const recordInput = async (projectId: string, body: string) =>
    f.session().platformMessage({
      commandId: randomUUID(),
      operation: {
        type: "record-input",
        projectId,
        conversationId: dialogueId,
        artifactId: null,
        artifactRevision: null,
        selection: "",
        body,
        targetActantId: "morphz-agent",
      },
    });
  await recordInput(f.projectId, "TEST 独立提醒来源");
  const internal = f.runtime as unknown as Internals;
  const delivery = internal.state.deliveries[0]!;
  delivery.rootId = "human-input-root";
  internal.state.connected = true;
  const contextId = `mw-context-${(f.store.runtimeState() as { namespace: string }).namespace}`;
  const thread = (id = "reminder-thread", root = "scheduled-root") => ({
    intent: "TEST 等待提醒",
    phase: "waiting",
    thread: {
      id,
      kind: "execution",
      session_id: delivery.sessionId,
      context_id: contextId,
      root_turn_id: root,
      lifecycle: "open",
      control_state: "active",
      revision: 1,
      updated_at: stamp,
    },
  });
  const schedule = (
    id = "reminder-schedule",
    threadId = "reminder-thread",
    source = delivery.rootId!,
  ) => ({
    id,
    thread_id: threadId,
    source_turn_id: source,
    intent: "TEST 明天下午提醒",
    status: "queued",
    revision: 1,
    not_before: due,
    interval_seconds: null,
    dependency_thread_ids: [],
    updated_at: stamp,
  });
  const bounds = {
    limit: 200,
    has_more_threads: false,
    has_more_objectives: false,
    has_more_schedules: false,
  };
  const snapshot = (threads = [thread()], schedules = [schedule()]) => ({
    detail_bounds: bounds,
    threads,
    schedules,
    objectives: [],
  });
  const read = (projects = [f.projectId], access = localAccess) =>
    f.runtime.platformNavigationSnapshot(access, projects).runtime.activity!;
  return {
    f,
    internal,
    delivery,
    contextId,
    thread,
    schedule,
    snapshot,
    bounds,
    read,
    recordInput,
  };
}

test("原生提醒无Platform事项也投影实际时间、等待状态及确切输入来源；不新增读写或持久安排副本", async () => {
  const x = await fixture();
  try {
    const calls: Array<[string, string | undefined]> = [];
    x.internal.request = async (path, method) => {
      calls.push([path, method]);
      return x.snapshot();
    };
    await x.internal.refreshActivity();
    const activity = x.read();
    assert.equal(calls.length, 2);
    assert.ok(
      calls.every(([path, method]) => path.includes("/scheduler?") && !method),
    );
    assert.equal(activity.schedulesAvailable, true);
    assert.equal(activity.schedulesTruncated, false);
    assert.deepEqual(activity.schedules, [
      {
        scheduleId: "reminder-schedule",
        threadId: "reminder-thread",
        sessionId: x.delivery.sessionId,
        contextId: x.contextId,
        rootId: "scheduled-root",
        inputId: x.delivery.inputId,
        sourceTurnId: "human-input-root",
        sourceRootId: "human-input-root",
        projectId: x.f.projectId,
        conversationId: x.delivery.platformSource.conversationId,
        status: "queued",
        revision: 1,
        notBefore: due,
        intervalSeconds: null,
        dependencyThreadIds: [],
        intent: "TEST 明天下午提醒",
        updatedAt: stamp,
      },
    ]);
    assert.equal(activity.threads[0]?.phase, "waiting");
    x.internal.save();
    const saved = x.f.store.runtimeState() as { activity: ExecutionActivity };
    assert.equal(saved.activity.schedules, undefined);
    assert.equal(saved.activity.schedulesAvailable, undefined);
  } finally {
    await x.f.close();
  }
});

test("共享Session逐安排按输入项目及精确Human principal和actant过滤", async () => {
  const x = await fixture();
  try {
    const project = "second-schedule-project";
    await x.f.session().createPlatformProject({
      commandId: randomUUID(),
      projectId: project,
      title: "TEST 另一项目",
    });
    await x.recordInput(project, "TEST 另一个提醒");
    const second = x.internal.state.deliveries[1]!;
    second.rootId = "second-human-root";
    assert.equal(second.sessionId, x.delivery.sessionId);
    x.internal.request = async () =>
      x.snapshot(
        [x.thread(), x.thread("second-thread", "second-scheduled-root")],
        [
          x.schedule(),
          x.schedule("second-schedule", "second-thread", second.rootId!),
        ],
      );
    await x.internal.refreshActivity();
    assert.deepEqual(
      x.read().schedules?.map((row) => row.scheduleId),
      ["reminder-schedule"],
    );
    assert.deepEqual(
      x.read([project]).schedules?.map((row) => row.scheduleId),
      ["second-schedule"],
    );
    assert.deepEqual(x.read([], localAccess).schedules, []);
    assert.deepEqual(
      x.read([x.f.projectId], { principalId: "other", actantId: "other" })
        .schedules,
      [],
    );
    assert.deepEqual(
      x.read([x.f.projectId], { ...localAccess, actantId: "another-actant" })
        .schedules,
      [],
    );
  } finally {
    await x.f.close();
  }
});

test("Objective创建事件的synthetic来源由持久parent Thread恢复，未来安排优先于有界终态查源", async () => {
  const x = await fixture();
  try {
    const calls: string[] = [];
    x.internal.request = async (path) => {
      calls.push(path);
      if (path.endsWith("/objective-created-event"))
        return {
          event: {
            id: "objective-created-event",
            topic: "objective/scheduled_created",
            timestamp: stamp,
            sequence: 1,
            payload: {
              session_id: x.delivery.sessionId,
              context_id: x.contextId,
              objective_id: "reminder-objective",
              source_thread_id: "source-thread",
              source_evaluation_id: "source-evaluation",
            },
          },
        };
      if (path.includes("/events/")) throw new Error("unknown historical root");
      const active = x.snapshot(
        [x.thread()],
        [x.schedule("timer", "reminder-thread", "objective-created-event")],
      );
      return {
        ...active,
        threads: path.includes("include_terminal=true")
          ? [
              x.thread("source-thread", x.delivery.rootId!),
              ...Array.from({ length: 30 }, (_, index) => {
                const row = x.thread(
                  `old-${index}`,
                  `missing-old-root-${index}`,
                );
                row.thread.lifecycle = "completed";
                return row;
              }),
            ]
          : active.threads,
        objectives: [
          {
            readiness: { state: "waiting" },
            objective: {
              id: "reminder-objective",
              context_id: x.contextId,
              coordinator_session_id: x.delivery.sessionId,
              source_event_id: "objective-created-event",
              stated_objective: "TEST 提醒目标",
              status: "active",
              status_reason: null,
              parent_objective_id: null,
              updated_at: stamp,
            },
          },
        ],
      };
    };
    await x.internal.refreshActivity();
    assert.equal(x.read().schedules?.length, 1);
    assert.equal(x.read().schedules?.[0]?.sourceRootId, x.delivery.rootId);
    assert.equal(
      x.read().schedules?.[0]?.sourceTurnId,
      "objective-created-event",
    );
    const eventCalls = calls.filter((path) => path.includes("/events/"));
    assert.ok(eventCalls.length <= 16);
    assert.ok(eventCalls[0]?.endsWith("/objective-created-event"));
    assert.equal(
      calls.filter((path) => path.includes("/scheduler?")).length,
      2,
    );
  } finally {
    await x.f.close();
  }
});

test("未验证来源、未知Thread及跨Context不能用Session或当前项目猜出安排", async () => {
  const x = await fixture();
  try {
    let eventReads = 0;
    x.internal.request = async (path) => {
      if (path.includes("/events/")) {
        eventReads++;
        throw new Error("missing source");
      }
      const cross = x.thread("cross-context", "cross-root");
      cross.thread.context_id = "foreign-context";
      return x.snapshot(
        [x.thread(), cross],
        [
          x.schedule("missing-root", "reminder-thread", "missing-input-root"),
          x.schedule("missing-thread", "unknown-thread"),
          x.schedule("cross-schedule", "cross-context"),
        ],
      );
    };
    await x.internal.refreshActivity();
    assert.equal(x.read().schedulesAvailable, true);
    assert.equal(x.read().schedulesTruncated, true);
    assert.deepEqual(x.read().schedules, []);
    assert.ok(eventReads <= 16);
  } finally {
    await x.f.close();
  }
});

test("仅按scheduleId去重并取真实新revision，同Thread的不同安排保留", async () => {
  const x = await fixture();
  try {
    x.internal.request = async (path) => {
      const raw = x.snapshot();
      if (path.includes("include_terminal=true")) return raw;
      const latest = {
        ...x.schedule(),
        revision: 3,
        not_before: "2026-10-04T05:30:00.000Z",
      };
      return {
        ...raw,
        schedules: [
          { ...x.schedule(), revision: 2 },
          x.schedule("second-timer"),
        ],
        threads: [{ ...x.thread(), schedules: [latest] }],
      };
    };
    await x.internal.refreshActivity();
    const rows = x.read().schedules!;
    assert.equal(rows.length, 2);
    assert.equal(
      rows.find((row) => row.scheduleId === "reminder-schedule")?.revision,
      3,
    );
    assert.equal(
      rows.find((row) => row.scheduleId === "reminder-schedule")?.notBefore,
      "2026-10-04T05:30:00.000Z",
    );
    assert.equal(
      rows.find((row) => row.scheduleId === "second-timer")?.threadId,
      "reminder-thread",
    );
  } finally {
    await x.f.close();
  }
});

test("同scheduleId冲突归属不能择一猜测；取消及已派发一次性不复活", async () => {
  const x = await fixture();
  try {
    x.internal.request = async () => ({
      ...x.snapshot(),
      schedules: [
        x.schedule(),
        { ...x.schedule(), source_turn_id: "another-root", revision: 2 },
        { ...x.schedule("cancelled"), status: "cancelled" },
        { ...x.schedule("one-shot-ended"), status: "dispatched" },
      ],
    });
    await x.internal.refreshActivity();
    assert.deepEqual(x.read().schedules, []);
    assert.equal(x.read().schedulesTruncated, true);
  } finally {
    await x.f.close();
  }
});

test("读取失败保留缓存但明确不可用；缺安排能力和有界结果不伪报完整空目录", async () => {
  const x = await fixture();
  try {
    x.internal.request = async () => x.snapshot();
    await x.internal.refreshActivity();
    x.internal.request = async () => {
      throw new Error("scheduler disconnected");
    };
    await x.internal.refreshActivity();
    assert.equal(x.read().available, false);
    assert.equal(x.read().schedulesAvailable, false);
    assert.equal(x.read().schedules?.length, 1);
    x.internal.request = async () => ({
      threads: [],
      objectives: [],
      detail_bounds: x.bounds,
    });
    await x.internal.refreshActivity();
    assert.equal(x.read().schedulesAvailable, false);
    assert.equal(x.read().schedulesTruncated, true);
    x.internal.request = async () => ({
      ...x.snapshot([], []),
      detail_bounds: { ...x.bounds, has_more_schedules: true },
    });
    await x.internal.refreshActivity();
    assert.equal(x.read().schedulesAvailable, true);
    assert.equal(x.read().schedulesTruncated, true);
  } finally {
    await x.f.close();
  }
});

test("明确刷新才重读Runtime inventory；日常导航不增加poll，刷新不tick或投递输入", async () => {
  const x = await fixture();
  try {
    const calls: Array<[string, string | undefined]> = [];
    x.internal.request = async (path, method) => {
      calls.push([path, method]);
      return x.snapshot();
    };
    const before = JSON.stringify(x.internal.state.deliveries);
    await x.f.session().platformRuntimeNavigation();
    assert.equal(calls.length, 0);
    const fresh = await x.f
      .session()
      .platformRuntimeNavigation({ refreshActivity: true });
    assert.equal(calls.length, 2);
    assert.equal(fresh.runtime.activity?.schedules?.length, 1);
    assert.ok(
      calls.every(([path, method]) => path.includes("/scheduler?") && !method),
    );
    assert.equal(JSON.stringify(x.internal.state.deliveries), before);
    await Promise.all(
      Array.from({ length: 3 }, () => x.f.runtime.refreshPlatformActivity()),
    );
    assert.equal(
      calls.length,
      4,
      "in-flight explicit reads must share one snapshot pass",
    );
    await assert.rejects(
      x.f.session().platformRuntimeNavigation({
        refreshActivity: true,
        sessionId: "caller-chosen",
      }),
    );
    assert.equal(calls.length, 4);
  } finally {
    await x.f.close();
  }
});

test("runtime.navigation HTTP映射及真实GET支持strict只读刷新，scope/未知query不能扩大权限", async () => {
  const x = await fixture();
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const server = createAppServer(x.f.store, {
    ...x.f.application.options,
    port,
    webRoot: "/nonexistent",
  });
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  try {
    const calls: string[] = [];
    x.internal.request = async (path) => {
      calls.push(path);
      return x.snapshot();
    };
    const client = new HttpApplicationClient(`http://127.0.0.1:${port}`);
    const response = (await client.call("runtime.navigation", {
      refreshActivity: true,
    })) as { runtime: { activity: ExecutionActivity } };
    assert.equal(response.runtime.activity.schedules?.length, 1);
    assert.equal(calls.length, 2);
    const denied = await fetch(
      `http://127.0.0.1:${port}/api/platform/runtime-navigation?refreshActivity=true&sessionId=caller-chosen`,
    );
    assert.equal(denied.status, 400);
    assert.equal(calls.length, 2);
    const invalid = await fetch(
      `http://127.0.0.1:${port}/api/platform/runtime-navigation?refreshActivity=maybe`,
    );
    assert.equal(invalid.status, 400);
    assert.equal(calls.length, 2);
    await assert.rejects(
      client.call("runtime.navigation", {
        projectId: x.f.projectId,
        refreshActivity: true,
      }),
    );
    assert.equal(calls.length, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await x.f.close();
  }
});
