import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionControls } from "../packages/application/src/execution.js";
import { executionSnapshotSchema } from "../packages/core/src/execution.js";
import { executionActivityStatus } from "../apps/web/src/execution-activity.js";
import { randomUUID } from "node:crypto";
import { localAccess } from "../packages/core/src/model.js";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";

const stamp = "2026-10-24T01:00:00Z";
function fixture() {
  const thread = (id: string, parent: string | null = null) => ({
    id,
    session_id: "TEST-session",
    context_id: "TEST-context",
    root_turn_id: `TEST-root-${id}`,
    parent_thread_id: parent,
    generation: 1,
    revision: 2,
    lifecycle: "open",
    control_state: "active",
    phase: "idle",
    created_at: stamp,
    updated_at: stamp,
    intent: `TEST ${id}`,
  });
  const records = {
    session_id: "TEST-session",
    context_id: "TEST-context",
    selected_thread_id: "primary",
    source_root_id: "TEST-input",
    limit: 100,
    has_more_jobs: false,
    threads_truncated: false,
    jobs: [],
    threads: [thread("primary"), thread("child", "primary")],
  };
  const scheduler = {
    context_id: "TEST-context",
    detail_bounds: {
      limit: 200,
      has_more_threads: false,
      has_more_objectives: false,
    },
    threads: records.threads.map((t) => ({
      thread: {
        ...t,
        kind: "execution",
        executor_kind: "self",
        supervision: {
          supervisor_kind: "objective",
          supervisor_id: "TEST-objective",
          generation: 1,
          // A same-objective child is deliberately origin-less: parent link
          // still makes it an ordinary child, not the primary coordinator.
          origin_evaluation_id: null as string | null,
          parent_thread_id: t.parent_thread_id,
        },
      },
      phase: t.phase,
      schedules: [] as Array<{
        thread_id: string;
        status: string;
        not_before: string;
      }>,
      activations: [] as Array<{
        jobs: Array<{
          job: {
            thread_id: string;
            session_id: string;
            context_id: string;
            status: string;
          };
        }>;
      }>,
    })),
    objectives: [
      {
        objective: {
          id: "TEST-objective",
          generation: 1,
          context_id: "TEST-context",
          coordinator_session_id: "TEST-session",
        },
        readiness: { state: "waiting", dependency_ids: ["TEST-edge"] },
        dependencies: [
          {
            id: "TEST-edge",
            owner_kind: "objective",
            owner_id: "TEST-objective",
            owner_generation: 1,
            dependency_kind: "thread_group",
            required: true,
            status: "pending",
          },
        ],
      },
    ],
  };
  const reads: string[] = [];
  let permission = true;
  const controls = new ExecutionControls(
    async (path, method, body) => {
      assert.ok(!method || method === "GET");
      assert.equal(body, undefined);
      reads.push(path);
      assert.equal(
        path,
        "/api/contexts/TEST-context/scheduler?include_terminal=false&limit=200",
      );
      if (!permission) throw new Error("TEST permission revoked");
      return scheduler;
    },
    () => ({
      sessionId: records.session_id,
      contextId: records.context_id,
      threadId: "primary",
      rootId: records.threads[0]!.root_turn_id,
      records,
      additionalRoot: async (root, id) =>
        records.threads.some((t) => t.id === id && t.root_turn_id === root),
    }),
  );
  const read = async () =>
    executionSnapshotSchema.parse(
      await controls.snapshot(
        {
          runtime: { sessionId: "TEST-session", contextId: "TEST-context" },
          threadId: "primary",
          artifactId: null,
        },
        false,
      ),
    );
  return {
    records,
    scheduler,
    reads,
    read,
    revoke: () => {
      permission = false;
    },
  };
}

test("direct read-only execution detail carries current primary wait through its transport schema, without an overview", async () => {
  const f = fixture();
  const snapshot = await f.read();
  assert.deepEqual(snapshot.threads![0]!.waitKinds, ["thread_group"]);
  assert.equal(
    executionActivityStatus(snapshot.threads![0]!, true).label,
    "等待子任务结果",
  );
  assert.equal(snapshot.threads![1]!.waitKinds, undefined);
  assert.equal(
    executionActivityStatus(snapshot.threads![1]!, true).label,
    "等待中（未提供具体原因）",
  );
  assert.equal(f.reads.length, 1, "one bounded read, not one per child");
});

test("current thread-local approval/timer facts take precedence over an Objective wait", async () => {
  const f = fixture();
  const until = "2026-10-24T02:00:00Z";
  f.scheduler.threads[0]!.schedules = [
    { thread_id: "primary", status: "queued", not_before: until },
  ];
  f.scheduler.threads[1]!.activations = [
    {
      jobs: [
        {
          job: {
            thread_id: "child",
            session_id: "TEST-session",
            context_id: "TEST-context",
            status: "waiting_approval",
          },
        },
      ],
    },
  ];
  const snapshot = await f.read();
  assert.deepEqual(snapshot.threads![0]!.waitKinds, ["timer"]);
  assert.equal(snapshot.threads![0]!.waitUntil, until);
  assert.deepEqual(snapshot.threads![1]!.waitKinds, ["permission"]);
  assert.equal(f.reads.length, 1);
});

test("foreign or stale scheduler identity, generation and incomplete dependencies cannot supply a wait", async () => {
  const mutations: Array<(f: ReturnType<typeof fixture>) => void> = [
    (f) => {
      f.scheduler.context_id = "foreign";
    },
    (f) => {
      f.scheduler.threads[0]!.thread.session_id = "foreign";
    },
    (f) => {
      f.scheduler.threads[0]!.thread.context_id = "foreign";
    },
    (f) => {
      f.scheduler.threads[0]!.thread.root_turn_id = "foreign";
    },
    (f) => {
      f.scheduler.threads[0]!.thread.generation++;
    },
    (f) => {
      f.scheduler.threads[0]!.thread.revision++;
    },
    (f) => {
      f.scheduler.threads[0]!.thread.kind = "delivery";
    },
    (f) => {
      f.scheduler.threads[0]!.thread.lifecycle = "completed";
    },
    (f) => {
      f.scheduler.threads[0]!.thread.control_state = "paused";
    },
    (f) => {
      f.scheduler.threads[0]!.phase = "running";
    },
    (f) => {
      f.scheduler.threads[0]!.thread.supervision.generation++;
    },
    (f) => {
      f.scheduler.threads[0]!.thread.supervision.origin_evaluation_id =
        "evaluation";
    },
    (f) => {
      f.scheduler.threads[0]!.thread.supervision.parent_thread_id =
        "other-parent";
    },
    (f) => {
      f.scheduler.objectives[0]!.objective.coordinator_session_id = "foreign";
    },
    (f) => {
      f.scheduler.objectives[0]!.objective.context_id = "foreign";
    },
    (f) => {
      f.scheduler.objectives[0]!.objective.generation++;
    },
    (f) => {
      f.scheduler.objectives[0]!.dependencies[0]!.owner_generation++;
    },
    (f) => {
      f.scheduler.objectives[0]!.dependencies[0]!.required = false;
    },
    (f) => {
      f.scheduler.objectives[0]!.dependencies[0]!.status = "satisfied";
    },
    (f) => {
      f.scheduler.objectives[0]!.readiness.dependency_ids.push("missing-edge");
    },
    (f) => {
      f.scheduler.threads = [];
    },
    (f) => {
      f.scheduler.threads.push(structuredClone(f.scheduler.threads[0]!));
    },
    (f) => {
      f.scheduler.objectives.push(structuredClone(f.scheduler.objectives[0]!));
    },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    const snapshot = await f.read();
    assert.ok(!snapshot.threads![0]!.waitKinds?.length, mutate.toString());
  }
});

test("running, runnable, paused and terminal execution states are not rewritten as waits", async () => {
  for (const [lifecycle, phase, controlState, label] of [
    ["open", "running", "active", "执行中"],
    ["open", "runnable", "active", "待执行"],
    ["open", "idle", "paused", "已暂停"],
    ["completed", "idle", "active", "已结束"],
    ["failed", "idle", "active", "执行失败"],
    ["cancelled", "idle", "active", "已取消"],
  ]) {
    const f = fixture();
    for (const record of f.records.threads) {
      record.lifecycle = lifecycle!;
      record.phase = phase!;
      record.control_state = controlState!;
    }
    const snapshot = await f.read();
    assert.equal(
      executionActivityStatus(snapshot.threads![0]!, true).label,
      label,
    );
    assert.equal(f.reads.length, 0, "no new read for non-waiting states");
  }
});

test("a revoked read is not converted to cached/invented wait data", async () => {
  const f = fixture();
  f.revoke();
  await assert.rejects(f.read(), /permission revoked/);
});

test("unrelated bounded scheduler history cannot erase present exact target evidence", async () => {
  const f = fixture();
  f.scheduler.detail_bounds.has_more_threads = true;
  f.scheduler.detail_bounds.has_more_objectives = true;
  // An unrelated legacy/malformed row is not evidence for this target, nor a
  // reason to discard its complete current identity/dependency proof.
  (f.scheduler.threads as unknown[]).push({ thread: { id: "unrelated" } });
  (f.scheduler.objectives as unknown[]).push({
    objective: { id: "unrelated" },
  });
  assert.deepEqual((await f.read()).threads![0]!.waitKinds, ["thread_group"]);
  f.scheduler.objectives = [];
  assert.equal((await f.read()).threads![0]!.waitKinds, undefined);
});

test("real Host direct read-only and selected-work detail preserve wait without overview, and recheck a revoked grant", async () => {
  const host = await platformRuntimeHostFixture();
  try {
    const { dialogueId } = await host.session().ensurePlatformSpaces();
    await host.session().platformMessage({
      commandId: randomUUID(),
      operation: {
        type: "record-input",
        projectId: host.projectId,
        conversationId: dialogueId,
        artifactId: null,
        artifactRevision: null,
        selection: "",
        body: "TEST current primary wait",
        targetActantId: "morphz-agent",
      },
    });
    const internal = host.runtime as unknown as {
      state: any;
      request(path: string, method?: string, body?: unknown): Promise<unknown>;
      authorizePlatformRead: (...args: any[]) => Promise<any>;
      refreshActivity(): Promise<void>;
    };
    internal.refreshActivity = async () => {
      throw new Error("TEST no overview allowed");
    };
    const delivery = internal.state.deliveries[0];
    delivery.rootId = "TEST-input";
    const sessionId = delivery.sessionId as string;
    const contextId = `mw-context-${(host.store.runtimeState() as { namespace: string }).namespace}`;
    const f = fixture();
    const records = {
      ...f.records,
      session_id: sessionId,
      context_id: contextId,
      threads: f.records.threads.map((thread) => ({
        ...thread,
        session_id: sessionId,
        context_id: contextId,
        initiating_principal_id: localAccess.principalId,
      })),
    };
    for (const thread of records.threads)
      internal.state.threadBindings[thread.id] = {
        id: thread.id,
        projectId: delivery.platformSource.projectId,
        conversationId: delivery.platformSource.conversationId,
        inputId: delivery.inputId,
        sessionId,
        rootId: thread.root_turn_id,
        title: thread.intent,
        phase: thread.phase,
        lifecycle: thread.lifecycle,
        revision: thread.revision,
        updatedAt: stamp,
      };
    const scheduler = {
      ...f.scheduler,
      context_id: contextId,
      threads: f.scheduler.threads.map((value) => ({
        ...value,
        thread: {
          ...value.thread,
          session_id: sessionId,
          context_id: contextId,
        },
      })),
      objectives: f.scheduler.objectives.map((value) => ({
        ...value,
        objective: {
          ...value.objective,
          coordinator_session_id: sessionId,
          context_id: contextId,
        },
      })),
    };
    let schedulerReads = 0,
      revokeAfterRead = false,
      revoked = false;
    const authority = internal.authorizePlatformRead.bind(host.runtime);
    host.runtime.bindPlatformReadAuthority(async (...args) => {
      assert.equal(revoked, false, "TEST grant revoked after scheduler read");
      return authority(...args);
    });
    internal.request = async (path, method, body) => {
      assert.ok(!method || method === "GET");
      assert.equal(body, undefined);
      if (path.includes("/execution-records?")) {
        const metadata = new URL(path, "http://test.invalid").searchParams.has(
          "metadata_only",
        );
        return metadata
          ? { ...records, threads: [records.threads[0]] }
          : records;
      }
      if (path === "/api/approvals") return { approvals: [] };
      assert.equal(
        path,
        `/api/contexts/${contextId}/scheduler?include_terminal=false&limit=200`,
      );
      schedulerReads++;
      if (revokeAfterRead) revoked = true;
      return scheduler;
    };
    const readOnlyScope = {
      runtime: { sessionId, contextId },
      threadId: "primary",
      artifactId: null,
    } as const;
    const viewer = await host.runtime.platformExecutionRead(
      readOnlyScope,
      localAccess,
      () => {},
    );
    const detail = executionSnapshotSchema.parse(await viewer.snapshot());
    assert.deepEqual(detail.threads![0]!.waitKinds, ["thread_group"]);
    assert.equal(detail.threads![1]!.waitKinds, undefined);
    assert.equal(schedulerReads, 1);
    const selected = await host.session().executionSnapshot({
      projectId: host.projectId,
      conversationId: dialogueId,
      artifactId: null,
      inputId: delivery.inputId,
      threadId: "primary",
    });
    assert.deepEqual(selected.threads![0]!.waitKinds, ["thread_group"]);
    assert.equal(schedulerReads, 2);
    revokeAfterRead = true;
    await assert.rejects(viewer.snapshot(), /grant revoked/);
  } finally {
    await host.close();
  }
});
