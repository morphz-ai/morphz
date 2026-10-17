import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer as createPortProbe } from "node:net";
import { localAccess, initialWorkspace } from "../packages/core/src/model.js";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";
import { executionActivityScope } from "../apps/web/src/execution-activity.js";
import { executionControlSchema } from "../packages/core/src/execution.js";
import { createAppServer } from "../apps/service/src/http.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";

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
    source: {
      event_id: rootId,
      context_id: contextId,
      session_id: delivery.sessionId,
      root_turn_id: rootId,
      activation_id: null,
    },
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
    source: {
      event_id: delivery.rootId,
      context_id: contextId,
      session_id: delivery.sessionId,
      root_turn_id: delivery.rootId,
      activation_id: null,
    },
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

test("infer 使用已校验注解，不复制原输入或暴露求值提示词，旧执行事实仍保留", async () => {
  const { f, internal, delivery, thread, bounds } = await fixture();
  try {
    const prompt =
      "This is an internal model-owned Yao Evaluation, not a user message.";
    const inference = thread("inference", "completed");
    Object.assign(inference.thread, { executor_kind: "plan_infer" });
    inference.intent = prompt;
    inference.thread.root_turn_id = "synthetic-inference-root";
    const authored = thread("authored", "completed");
    Object.assign(authored.thread, { executor_kind: "self" });
    authored.intent = prompt;
    internal.request = async () => ({
      detail_bounds: bounds,
      threads: [inference, authored],
      objectives: [],
    });
    await internal.refreshActivity();
    const activity = f.runtime.platformNavigationSnapshot(localAccess, [
      f.projectId,
    ]).runtime.activity!;
    const projected = activity.threads.find((t) => t.id === "inference")!;
    assert.equal(projected.title, "");
    assert.equal(projected.inputId, delivery.inputId);
    assert.equal(projected.rootId, "synthetic-inference-root");
    assert.equal(projected.lifecycle, "completed");
    assert.equal(projected.outcome?.summary, "真实执行结果");
    assert.equal(activity.threads.length, 2);
    // The executor fact, not a substring match, selects presentation.
    assert.equal(
      activity.threads.find((t) => t.id === "authored")!.title,
      prompt,
    );
    assert.equal(inference.intent, prompt);
    delivery.platformSource.body = " \n ";
    await internal.refreshActivity();
    assert.equal(
      internal.state.activity.threads.find((t: any) => t.id === "inference")
        .title,
      "",
    );
    delivery.platformSource.body = "项目".repeat(70);
    await internal.refreshActivity();
    assert.equal(
      internal.state.activity.threads.find((t: any) => t.id === "inference")
        .title,
      "",
    );
    (inference as any).response_annotations = {
      protocol: "on",
      scope: { execution_id: "inference", generation: 1 },
      title: "核对项目资料",
      result: "已读取目录和一段资料",
      steps: [],
      source_count: 1,
      truncated: false,
    };
    await internal.refreshActivity();
    const annotated = internal.state.activity.threads.find(
      (t: any) => t.id === "inference",
    );
    assert.equal(annotated.title, "核对项目资料");
    assert.equal(annotated.summary, "已读取目录和一段资料");
    assert.equal(annotated.inputId, delivery.inputId);
    assert.equal(annotated.lifecycle, "completed");
  } finally {
    await f.close();
  }
});

test("idle Objective primary retains supplement via exact original input and exposes current pending Human reason", async () => {
  const { f, internal, delivery, thread, bounds, objective } = await fixture();
  try {
    const primary = thread("primary");
    primary.thread.root_turn_id = "synthetic-objective-root";
    primary.phase = "idle";
    const waiting = {
      ...objective,
      objective: { ...objective.objective, generation: 1 },
      readiness: { state: "waiting", dependency_ids: ["human-edge"] },
      dependencies: [
        {
          id: "human-edge",
          owner_kind: "objective",
          owner_id: "objective-1",
          owner_generation: 1,
          dependency_kind: "user_input",
          required: true,
          status: "pending",
        },
      ],
    };
    internal.request = async () => ({
      detail_bounds: bounds,
      threads: [primary],
      objectives: [waiting],
    });
    await internal.refreshActivity();
    const activity = f.runtime.platformNavigationSnapshot(localAccess, [
      f.projectId,
    ]).runtime.activity!;
    assert.equal(activity.threads[0]!.rootId, "synthetic-objective-root");
    assert.equal(activity.threads[0]!.continuation?.inputId, delivery.inputId);
    assert.deepEqual(activity.threads[0]!.continuation?.objective, {
      id: "objective-1",
      generation: 1,
    });
    assert.deepEqual(activity.threads[0]!.waitKinds, ["user_input"]);
    assert.deepEqual(activity.objectives![0]!.waitKinds, ["user_input"]);
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
    assert.equal(
      activity.truncated,
      false,
      "unresolved association is not truncated execution history",
    );
    await internal.refreshActivity();
    assert.equal(lookups, 2);
  } finally {
    await f.close();
  }
});

test("source-null executions retain ownership/facts in global inventory without inventing project or control authority", async () => {
  const { f, internal, thread, bounds } = await fixture();
  try {
    const values = ["ordinary", "infer", "objective", "schedule", "system"].map(
      (kind, i) => {
        const value = thread(
          kind,
          ["open", "completed", "failed"][i % 3],
          `unassociated-${kind}`,
        );
        Object.assign(value, { source: null });
        Object.assign(value.thread, {
          initiating_principal_id: localAccess.principalId,
          executor_kind: kind === "infer" ? "plan_infer" : "self",
        });
        return value;
      },
    );
    const foreign = thread("foreign", "open");
    Object.assign(foreign, { source: null });
    Object.assign(foreign.thread, {
      initiating_principal_id: "another-principal",
    });
    const missingOwner = thread("missing-owner", "open");
    Object.assign(missingOwner, { source: null });
    internal.request = async () => ({
      detail_bounds: bounds,
      objectives: [],
      threads: [...values, foreign, missingOwner],
    });
    await internal.refreshActivity();
    const activity = f.runtime.platformNavigationSnapshot(localAccess, [])
      .runtime.activity!;
    assert.deepEqual(
      activity.threads.map((t) => t.id),
      values.map((t) => t.thread.id),
    );
    assert.equal(activity.truncated, false);
    assert.ok(
      activity.threads.every(
        (t) =>
          t.projectId === null &&
          t.conversationId === null &&
          t.inputId === null &&
          t.continuation === undefined,
      ),
    );
    assert.equal(
      f.runtime.platformNavigationSnapshot(
        { principalId: "different", actantId: "different" },
        [],
      ).runtime.activity!.threads.length,
      0,
    );
    // Raw cache facts are not a renderer permission or a domain-tool binding.
    assert.equal(internal.state.activity.threads.length, values.length + 2);
    const selected = activity.threads[0]!;
    const scope = executionActivityScope(selected, initialWorkspace(now));
    assert.ok("runtime" in scope);
    assert.equal(
      executionControlSchema.safeParse({
        scope,
        action: {
          type: "cancel-thread",
          threadId: selected.id,
          revision: selected.revision,
        },
      }).success,
      false,
    );
  } finally {
    await f.close();
  }
});

test("unassociated inspector reads bounded real commands and receipts, rejects foreign identity and never reads approvals or mutates", async () => {
  const { f, internal, thread, bounds, contextId, delivery } = await fixture();
  try {
    const raw = thread("unassociated", "completed", "unassociated-root");
    Object.assign(raw, { source: null });
    Object.assign(raw.thread, {
      initiating_principal_id: localAccess.principalId,
    });
    const calls: string[] = [];
    const job = {
      id: "record-job",
      revision: 1,
      session_id: delivery.sessionId,
      context_id: contextId,
      thread_id: raw.thread.id,
      tool_name: "exec",
      target_id: "local",
      status: "succeeded",
      request: { command: "pwd" },
      created_at: now,
      updated_at: now,
      result_event_id: "record-result",
    };
    let owner = localAccess.principalId;
    internal.request = async (path) => {
      calls.push(path);
      if (path.includes("/scheduler?"))
        return { detail_bounds: bounds, objectives: [], threads: [raw] };
      if (path.includes("/execution-records?")) {
        const query = new URL(path, "http://isolated.invalid").searchParams;
        assert.equal(query.get("limit"), "100");
        assert.equal(
          query.has("root_turn_ids"),
          false,
          "source is not a read permission",
        );
        return {
          session_id: delivery.sessionId,
          context_id: contextId,
          selected_thread_id: raw.thread.id,
          source_root_id: null,
          limit: 100,
          has_more_jobs: false,
          threads_truncated: false,
          jobs: [job],
          threads: [
            {
              ...raw.thread,
              initiating_principal_id: owner,
              parent_thread_id: null,
              intent: raw.intent,
              phase: raw.phase,
            },
          ],
        };
      }
      if (path.endsWith("/record-job/result"))
        return {
          job_id: job.id,
          event: {
            id: "record-result",
            payload: {
              session_id: delivery.sessionId,
              context_id: contextId,
              text: "/actual/workspace",
            },
          },
        };
      if (path.endsWith("/record-job")) return job;
      if (path.endsWith("/threads/unassociated"))
        return { snapshot: { thread: raw.thread } };
      throw new Error(`Unexpected read: ${path}`);
    };
    await internal.refreshActivity();
    const selected = f.runtime.platformNavigationSnapshot(localAccess, [])
      .runtime.activity!.threads[0]!;
    const scope = executionActivityScope(selected, initialWorkspace(now));
    const snapshot = await f.session().executionSnapshot(scope);
    assert.deepEqual(snapshot.jobs[0]!.request, { command: "pwd" });
    assert.equal(snapshot.threads?.[0]?.id, selected.id);
    assert.deepEqual(snapshot.approvals, []);
    assert.equal(
      calls.filter((p) => p.includes("execution-records")).length,
      1,
    );
    const probe = createPortProbe();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const server = createAppServer(f.store, {
      port,
      webRoot: "/nonexistent",
      runtime: f.runtime,
      platformWork: f.domains.work,
    });
    await new Promise<void>((resolve) =>
      server.listen(port, "127.0.0.1", resolve),
    );
    try {
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const remote = new HttpApplicationClient(origin);
      assert.deepEqual(
        await remote.call("execution.snapshot", scope),
        snapshot,
      );
      const receipt = await remote.call("execution.result", {
        scope,
        jobId: job.id,
      });
      assert.equal((receipt as { text: string }).text, "/actual/workspace");
      const invalid = await fetch(
        `${origin}/api/executions?runtime=broken&threadId=${raw.thread.id}`,
      );
      assert.equal(invalid.status, 400);
      const mixed = await fetch(
        `${origin}/api/executions?${new URLSearchParams({
          runtime: JSON.stringify((scope as { runtime: unknown }).runtime),
          threadId: raw.thread.id,
          projectId: f.projectId,
        })}`,
      );
      assert.equal(mixed.status, 400);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
    const result = await f.session().executionResult({ scope, jobId: job.id });
    assert.equal(result.text, "/actual/workspace");
    assert.ok(!calls.some((p) => p === "/api/approvals"));
    await assert.rejects(
      f.session().executionControl({
        scope,
        action: {
          type: "cancel-thread",
          threadId: selected.id,
          revision: 1,
        },
      }),
    );
    for (const bad of [
      { ...scope, threadId: "other-thread" },
      {
        ...scope,
        runtime: { sessionId: delivery.sessionId, contextId: "other-context" },
      },
      { ...scope, runtime: { sessionId: "other-session", contextId } },
    ])
      await assert.rejects(f.session().executionSnapshot(bad));
    owner = "foreign-principal";
    await assert.rejects(f.session().executionSnapshot(scope), /所属身份/);
    owner = localAccess.principalId;
    // A bounded list changing while reading cannot revoke a real execution.
    const request = internal.request;
    internal.request = async (path) => {
      const value = await request(path);
      if (path.includes("execution-records"))
        internal.state.activity.threads.length = 0;
      return value;
    };
    assert.equal(
      (await f.session().executionSnapshot(scope)).jobs[0]!.id,
      job.id,
    );
    // The real Session authority changing must still fence the asynchronous read.
    internal.request = async (path) => {
      const value = await request(path);
      if (path.includes("execution-records"))
        delete internal.state.sessions[delivery.sessionId];
      return value;
    };
    await assert.rejects(f.session().executionSnapshot(scope), /无权读取/);
  } finally {
    await f.close();
  }
});

test("cold Host reopens preserve nullable input bindings and unassociated execution facts without replay", async () => {
  const { f, delivery, contextId } = await fixture();
  try {
    const state = f.store.runtimeBridgeState() as Record<string, any>;
    const fact = {
      id: "historical",
      kind: "execution",
      projectId: f.projectId,
      conversationId: delivery.platformSource.conversationId,
      inputId: null,
      rootId: "historical-root",
      sessionId: delivery.sessionId,
      contextId,
      title: "历史执行",
      phase: "idle",
      lifecycle: "completed",
      revision: 1,
      updatedAt: now,
    };
    state.threadBindings = { historical: fact };
    state.activity = {
      available: true,
      truncated: false,
      threads: [
        {
          ...fact,
          id: "unassociated",
          projectId: null,
          conversationId: null,
          initiatingPrincipalId: localAccess.principalId,
        },
      ],
    };
    f.store.saveRuntimeBridgeState(state);
    const deliveries = JSON.stringify(state.deliveries);
    await f.reopen();
    const restored = f.store.runtimeBridgeState() as Record<string, any>;
    assert.equal(restored.threadBindings.historical.inputId, null);
    assert.equal(JSON.stringify(restored.deliveries), deliveries);
    const visible = f.runtime.platformNavigationSnapshot(localAccess, [])
      .runtime.activity!.threads;
    assert.equal(visible[0]!.id, "unassociated");
    assert.equal(visible[0]!.projectId, null);
  } finally {
    await f.close();
  }
});

test("a read-only execution reference cannot bypass known project revocation, including after the physical read", async () => {
  const { f, internal, thread, bounds, delivery, contextId } = await fixture();
  try {
    const raw = thread("associated", "completed");
    Object.assign(raw.thread, {
      initiating_principal_id: localAccess.principalId,
    });
    let revoked = false;
    const bridge = f.runtime as unknown as {
      authorizePlatformRead: (...args: any[]) => Promise<any>;
    };
    const authorize = bridge.authorizePlatformRead;
    bridge.authorizePlatformRead = async (...args) => {
      if (revoked) throw new Error("project grant revoked");
      return authorize(...args);
    };
    let revokeDuringRead = false;
    internal.request = async (path) => {
      if (path.includes("/scheduler?"))
        return { detail_bounds: bounds, objectives: [], threads: [raw] };
      assert.ok(path.includes("/execution-records?"));
      if (revokeDuringRead) revoked = true;
      return {
        session_id: delivery.sessionId,
        context_id: contextId,
        selected_thread_id: raw.thread.id,
        source_root_id: delivery.rootId,
        limit: 100,
        has_more_jobs: false,
        threads_truncated: false,
        jobs: [],
        threads: [
          {
            ...raw.thread,
            parent_thread_id: null,
            intent: raw.intent,
            phase: raw.phase,
          },
        ],
      };
    };
    await internal.refreshActivity();
    const scope = {
      runtime: { sessionId: delivery.sessionId, contextId },
      threadId: raw.thread.id,
      artifactId: null,
    };
    assert.equal(
      (await f.session().executionSnapshot(scope)).threads?.[0]?.id,
      raw.thread.id,
    );
    revoked = true;
    await assert.rejects(
      f.session().executionSnapshot(scope),
      /project grant revoked/,
    );
    revoked = false;
    revokeDuringRead = true;
    await assert.rejects(
      f.session().executionSnapshot(scope),
      /project grant revoked/,
    );
  } finally {
    await f.close();
  }
});

test("a missing source cannot remove a known project fence from the global inventory", async () => {
  const { f, internal, thread, bounds } = await fixture();
  try {
    const raw = thread("known-project", "completed");
    Object.assign(raw.thread, {
      initiating_principal_id: localAccess.principalId,
    });
    internal.request = async () => ({
      detail_bounds: bounds,
      objectives: [],
      threads: [raw],
    });
    await internal.refreshActivity();
    Object.assign(raw, { source: null });
    internal.state.deliveries.length = 0;
    await internal.refreshActivity();
    assert.equal(internal.state.activity.threads.length, 1);
    assert.equal(internal.state.activity.threads[0]!.projectId, null);
    assert.equal(
      f.runtime.platformNavigationSnapshot(localAccess, [f.projectId]).runtime
        .activity!.threads.length,
      1,
      "current project access still permits the actual execution fact",
    );
    assert.equal(
      f.runtime.platformNavigationSnapshot(localAccess, []).runtime.activity!
        .threads.length,
      0,
      "source null is not a way around the known project's current read grant",
    );
    assert.equal(internal.state.activity.threads.length, 1);
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
    await f.session().createPlatformProject({
      commandId: randomUUID(),
      projectId: secondProject,
      title: "另一个项目",
    });
    await f.session().platformMessage({
      commandId: randomUUID(),
      operation: {
        type: "record-input",
        projectId: secondProject,
        conversationId: delivery.platformSource.conversationId,
        artifactId: null,
        artifactRevision: null,
        selection: "",
        body: "另一个项目的工作",
        targetActantId: "morphz-agent",
      },
    });
    const second = internal.state.deliveries[1]!;
    assert.equal(second.sessionId, delivery.sessionId);
    second.rootId = "second-root";
    internal.request = async () => ({
      detail_bounds: bounds,
      threads: [thread("first"), thread("second", "completed", second.rootId!)],
      objectives: [
        objective,
        {
          ...objective,
          source: {
            ...objective.source,
            event_id: second.rootId,
            root_turn_id: second.rootId,
          },
          objective: {
            ...objective.objective,
            id: "second-objective",
            source_event_id: second.rootId,
          },
        },
      ],
    });
    await internal.refreshActivity();
    const firstOnly = f.runtime.platformNavigationSnapshot(localAccess, [
      f.projectId,
    ]).runtime.activity!;
    assert.deepEqual(
      firstOnly.threads.map((t) => t.id),
      ["first"],
    );
    assert.deepEqual(
      firstOnly.objectives!.map((o) => o.id),
      ["objective-1"],
    );
    const secondOnly = f.runtime.platformNavigationSnapshot(localAccess, [
      secondProject,
    ]).runtime.activity!;
    assert.deepEqual(
      secondOnly.threads.map((t) => t.id),
      ["second"],
    );
    assert.deepEqual(
      secondOnly.objectives!.map((o) => o.id),
      ["second-objective"],
    );
  } finally {
    await f.close();
  }
});

test("满历史页保持有界披露，未知roots每次刷新最多16次读取", async () => {
  const { f, internal, thread, bounds } = await fixture();
  try {
    let lookups = 0;
    internal.request = async (path) => {
      if (path.includes("/events/")) {
        lookups++;
        throw new Error("unknown");
      }
      return {
        detail_bounds: bounds,
        objectives: [],
        threads: Array.from({ length: 200 }, (_, index) =>
          thread(`thread-${index}`, "completed"),
        ),
      };
    };
    await internal.refreshActivity();
    assert.equal(internal.state.activity.truncated, true);
    assert.equal(lookups, 0);
    internal.request = async (path) => {
      if (path.includes("/events/")) {
        lookups++;
        throw new Error("unknown");
      }
      return {
        detail_bounds: bounds,
        objectives: [],
        threads: Array.from({ length: 40 }, (_, index) =>
          thread(`unknown-${index}`, "completed", `unknown-root-${index}`),
        ),
      };
    };
    await internal.refreshActivity();
    assert.equal(lookups, 16);
    assert.equal(
      internal.state.activity.threads.length,
      40,
      "missing associations retain execution facts",
    );
    assert.equal(
      f.runtime.platformNavigationSnapshot(localAccess, [f.projectId]).runtime
        .activity!.threads.length,
      0,
      "missing execution owner still cannot fabricate a read grant",
    );
  } finally {
    await f.close();
  }
});
