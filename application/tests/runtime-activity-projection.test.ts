import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer as createPortProbe } from "node:net";
import { createServer } from "node:http";
import type { RuntimeConfig } from "../packages/application/src/runtime.js";
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
  request(path: string, method?: string, body?: unknown): Promise<unknown>;
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

async function fixture(config?: RuntimeConfig) {
  const f = await platformRuntimeHostFixture(config);
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
      revision: 1,
      generation: 1,
      status_reason: null,
      parent_objective_id: null,
      updated_at: now,
    },
  };
  return { f, internal, delivery, thread, bounds, objective, contextId };
}

/** Real HTTP status at the Runtime boundary, using only synthetic input. */
async function logicalRootSource() {
  let source: unknown;
  let direct: number | "malformed" = 404;
  let fallbackReads = 0;
  const server = createServer((request, response) => {
    const path = new URL(request.url!, "http://127.0.0.1").pathname;
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.method !== "GET") return send(405, {});
    if (path === "/api/status") return send(200, { model: "isolated-model" });
    if (path === "/api/runtime/inference")
      return send(200, { model: "isolated-model", models: ["isolated-model"] });
    if (path.endsWith("/events/root-input"))
      return direct === "malformed"
        ? send(200, { event: {} })
        : send(direct, {});
    if (path.endsWith("/turns/root-input/source")) {
      fallbackReads++;
      return send(200, { input_event: source });
    }
    return send(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    config: {
      url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      token: "isolated-delegation-source",
      namespace: randomUUID(),
    },
    source(value: unknown) {
      source = value;
    },
    direct(value: number | "malformed") {
      direct = value;
    },
    get fallbackReads() {
      return fallbackReads;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

async function assertDelegatedSource(rootKind: "event" | "logical-turn") {
  const rootHTTP =
    rootKind === "logical-turn" ? await logicalRootSource() : null;
  const { f, internal, delivery, thread, bounds, contextId } = await fixture(
    rootHTTP?.config,
  ).catch(async (error) => {
    await rootHTTP?.close();
    throw error;
  });
  const source = internal as unknown as {
    authorizePlatformRead: (...args: any[]) => Promise<any>;
  };
  const authorize = source.authorizePlatformRead;
  let revoked = false;
  try {
    const principal = "TEST-runtime-initiator";
    const record = {
      id: "TEST-delegation",
      parent_context_id: contextId,
      parent_session_id: delivery.sessionId,
      child_context_id: "TEST-child-context",
      child_session_id: "TEST-child-session",
      initiating_principal_id: principal,
      task: "TEST 验证子任务真实回执",
      status: "running",
      created_at: now,
      updated_at: now,
    };
    const event = {
      id: "TEST-delegate-request",
      actor: "Runtime",
      type: "agent_call",
      topic: "chat/delegate",
      timestamp: now,
      sequence: 4,
      payload: {
        delegation_id: record.id,
        parent_context_id: contextId,
        context_id: contextId,
        parent_session_id: delivery.sessionId,
        session_id: delivery.sessionId,
        child_context_id: record.child_context_id,
        child_session_id: record.child_session_id,
        principal_id: principal,
        thread_id: "TEST-parent",
        root_turn_id: delivery.rootId,
      },
    };
    const root = {
      id: rootHTTP ? "TEST-original-input-event" : delivery.rootId,
      actor: "Human",
      type: "session_message",
      topic: "chat/user_message",
      timestamp: now,
      sequence: 1,
      payload: {
        session_id: delivery.sessionId,
        client_message_id: delivery.inputId,
        root_turn_id: delivery.rootId,
        session_io: {
          request: {
            ...delivery.request,
            client_metadata: data(delivery.request.client_metadata),
            message: {
              ...delivery.request.message,
              content: {
                encoding: "json",
                value: data(delivery.request.message.content.value),
              },
            },
          },
        },
      },
    };
    rootHTTP?.source(root);
    const actualRequest = internal.request.bind(internal);
    const parent = thread("TEST-parent");
    parent.phase = "waiting";
    const child = thread("TEST-child", "open", "TEST-child-root");
    Object.assign(child.thread, {
      context_id: record.child_context_id,
      session_id: record.child_session_id,
      initiating_principal_id: principal,
    });
    const writes: string[] = [];
    let wrongOwner = false;
    internal.request = async (path, method = "GET") => {
      if (method !== "GET") writes.push(path);
      if (path.startsWith("/api/delegations?"))
        return { delegations: [record], has_more: false };
      if (path === `/api/delegations/${record.id}`) return record;
      if (path.startsWith(`/api/contexts/${contextId}/events?`))
        return {
          context_id: contextId,
          events: [event],
          scan_exhaustive: true,
        };
      if (path.endsWith(`/events/${event.id}`)) return { event };
      if (path.endsWith(`/events/${delivery.rootId}`))
        return rootHTTP ? actualRequest(path, method) : { event: root };
      if (path.endsWith(`/turns/${delivery.rootId}/source`) && rootHTTP)
        return actualRequest(path, method);
      if (path.includes("/execution-records?"))
        return {
          session_id: record.child_session_id,
          context_id: record.child_context_id,
          selected_thread_id: child.thread.id,
          source_root_id: child.thread.root_turn_id,
          limit: 100,
          has_more_jobs: false,
          threads_truncated: false,
          jobs: [],
          threads: [
            {
              ...child.thread,
              parent_thread_id: null,
              phase: child.phase,
              intent: child.intent,
              initiating_principal_id: wrongOwner ? "foreign" : principal,
            },
          ],
        };
      if (
        path.startsWith(`/api/contexts/${record.child_context_id}/scheduler?`)
      )
        return {
          context_id: record.child_context_id,
          detail_bounds: bounds,
          threads: [
            {
              ...child,
              schedules: [
                {
                  thread_id: child.thread.id,
                  status: "queued",
                  not_before: "2099-10-24T02:00:00Z",
                },
              ],
            },
          ],
        };
      if (path.startsWith(`/api/contexts/${contextId}/scheduler?`))
        return {
          detail_bounds: bounds,
          threads: [parent],
          objectives: [],
        };
      throw new Error(`unexpected read ${path}`);
    };
    source.authorizePlatformRead = (...args) => {
      if (revoked) throw new Error("TEST 撤权");
      return authorize(...args);
    };
    const sessionsBefore = Object.keys(internal.state.sessions);
    await internal.refreshActivity();
    const activity = f.runtime.platformNavigationSnapshot(localAccess, [
      f.projectId,
    ]).runtime.activity!;
    assert.equal(activity.delegationsAvailable, true);
    if (rootHTTP)
      assert.ok(
        rootHTTP.fallbackReads > 0,
        "a real root-event HTTP 404 reaches the existing exact turn source",
      );
    const projected = activity.threads.find((t) => t.id === child.thread.id)!;
    assert.ok(projected);
    assert.equal(projected.inputId, delivery.inputId);
    assert.equal(projected.sessionId, record.child_session_id);
    assert.equal(projected.contextId, record.child_context_id);
    assert.equal(projected.continuation, undefined);
    assert.ok(
      activity.threads
        .find((t) => t.id === parent.thread.id)
        ?.waitKinds?.includes("delegation"),
    );
    assert.deepEqual(
      Object.keys(internal.state.sessions),
      sessionsBefore,
      "reading a delegate never registers or claims a child Session",
    );
    assert.equal(
      f.runtime.platformNavigationSnapshot(localAccess, []).runtime.activity!
        .threads.length,
      0,
    );
    const scope = executionActivityScope(projected, initialWorkspace());
    assert.ok("runtime" in scope);
    const viewer = await f.runtime.platformExecutionRead(
      scope as any,
      localAccess,
      () => {},
    );
    assert.deepEqual(
      (await viewer.snapshot()).threads?.map((t) => t.id),
      [child.thread.id],
    );
    assert.deepEqual((await viewer.snapshot()).approvals, []);
    child.phase = "idle";
    const waitingViewer = await f.runtime.platformExecutionRead(
      scope as any,
      localAccess,
      () => {},
    );
    const waitingDetail = await waitingViewer.snapshot();
    assert.deepEqual(
      waitingDetail.threads?.[0]?.waitKinds,
      ["timer"],
      "delegated read-only wrapper must not overwrite the enriched family",
    );
    assert.equal(waitingDetail.threads?.[0]?.waitUntil, "2099-10-24T02:00:00Z");
    if (rootHTTP) {
      for (const failure of [401, 403, 503, "malformed"] as const) {
        const beforeFallback: number = rootHTTP.fallbackReads;
        rootHTTP.direct(failure);
        await assert.rejects(
          f.runtime.platformExecutionRead(scope as any, localAccess, () => {}),
          (error: any) =>
            failure === "malformed"
              ? error.name === "ZodError"
              : error.status === failure,
          "only an actual root-event 404 may use turns/source",
        );
        assert.equal(rootHTTP.fallbackReads, beforeFallback);
      }
      rootHTTP.direct(404);
      rootHTTP.source({
        ...root,
        payload: { ...root.payload, session_id: "TEST-foreign-session" },
      });
      await assert.rejects(
        f.runtime.platformExecutionRead(scope as any, localAccess, () => {}),
        /原始输入/,
        "the fallback does not relax the exact originating Session/source proof",
      );
      rootHTTP.source(root);
    }
    wrongOwner = true;
    await assert.rejects(
      f.runtime.platformExecutionRead(scope as any, localAccess, () => {}),
      /身份/,
    );
    wrongOwner = false;
    event.payload.child_context_id = "unrelated-context";
    await assert.rejects(
      f.runtime.platformExecutionRead(scope as any, localAccess, () => {}),
      /委派/,
    );
    event.payload.child_context_id = record.child_context_id;
    revoked = true;
    await assert.rejects(viewer.snapshot(), /撤权/);
    revoked = false;
    for (const status of ["completed", "failed", "cancelled"]) {
      record.status = status;
      child.thread.lifecycle = status;
      child.phase = "idle";
      await internal.refreshActivity();
      const next = f.runtime.platformNavigationSnapshot(localAccess, [
        f.projectId,
      ]).runtime.activity!;
      assert.equal(
        next.threads.find((t) => t.id === child.thread.id)?.lifecycle,
        status,
      );
      assert.ok(
        !next.threads
          .find((t) => t.id === parent.thread.id)
          ?.waitKinds?.includes("delegation"),
      );
    }
    assert.deepEqual(
      writes,
      [],
      "activity, details and all rejection paths remain read-only",
    );
  } finally {
    try {
      await f.close();
    } finally {
      await rootHTTP?.close();
    }
  }
}

test("跨 Session delegate 保留父输入与真实子执行，精确只读、撤权和篡改不扩大权限", () =>
  assertDelegatedSource("event"));
test("delegate 的逻辑回合根事件真实 HTTP 404 时只读核验 turns/source，其他错误不降级", () =>
  assertDelegatedSource("logical-turn"));

test("活动由真实线程投影，保留终态事实、原intent、目标和运行线程", async () => {
  const { f, internal, delivery, thread, bounds, objective } = await fixture();
  try {
    const calls: string[] = [];
    internal.request = async (path) => {
      calls.push(path);
      if (path.startsWith("/api/delegations?"))
        return { delegations: [], has_more: false };
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
    assert.equal(
      calls.filter((path) => path.includes("/scheduler?")).length,
      2,
    );
    assert.equal(
      calls.filter((path) => path.startsWith("/api/delegations?")).length,
      2,
    );
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

test("线程自己的定时和审批原因透传到活动，不被父目标的等待覆盖或触发额外读取", async () => {
  const { f, internal, delivery, thread, bounds, objective, contextId } =
    await fixture();
  try {
    const timer = {
      ...thread("timer"),
      phase: "waiting",
      schedules: [
        {
          id: "own-schedule",
          thread_id: "timer",
          source_turn_id: delivery.rootId,
          status: "queued",
          not_before: "2026-10-23T01:00:00Z",
        },
      ],
    };
    const approval = {
      ...thread("approval"),
      phase: "waiting",
      activations: [
        {
          jobs: [
            {
              job: {
                thread_id: "approval",
                session_id: delivery.sessionId,
                context_id: contextId,
                status: "waiting_approval",
              },
            },
          ],
        },
      ],
    };
    const waiting = {
      ...objective,
      objective: { ...objective.objective, generation: 1 },
      readiness: { state: "waiting", dependency_ids: ["human-edge"] },
      dependencies: [
        {
          id: "human-edge",
          owner_kind: "objective",
          owner_id: objective.objective.id,
          owner_generation: 1,
          required: true,
          status: "pending",
          dependency_kind: "user_input",
        },
      ],
    };
    const calls: string[] = [];
    internal.request = async (path) => {
      calls.push(path);
      if (path.startsWith("/api/delegations?"))
        return { delegations: [], has_more: false };
      return {
        detail_bounds: bounds,
        threads: [timer, approval],
        objectives: [waiting],
      };
    };
    await internal.refreshActivity();
    const activity = f.runtime.platformNavigationSnapshot(localAccess, [
      f.projectId,
    ]).runtime.activity!;
    assert.equal(
      calls.filter((path) => path.includes("/scheduler?")).length,
      2,
    );
    assert.equal(
      calls.filter((path) => path.startsWith("/api/delegations?")).length,
      2,
    );
    assert.equal(
      calls.length,
      4,
      "timer/approval state adds no per-Thread reads beyond the bounded Context inventories",
    );
    assert.deepEqual(activity.threads[0]!.waitKinds, ["timer"]);
    assert.equal(activity.threads[0]!.waitUntil, "2026-10-23T01:00:00Z");
    assert.deepEqual(activity.threads[1]!.waitKinds, ["permission"]);
    assert.equal(activity.threads[1]!.waitUntil, undefined);
    assert.deepEqual(activity.objectives![0]!.waitKinds, ["user_input"]);
  } finally {
    await f.close();
  }
});

test("目标控制共用 Runtime 的暂停恢复删除协议，校验真实来源和修订号，不创建线程或输入", async () => {
  const { f, internal, delivery, bounds, objective } = await fixture();
  const mutations: { path: string; method: string; body: any }[] = [];
  const request = (
    action: "pause" | "resume" | "delete",
    revision = objective.objective.revision,
  ) => ({
    objectiveId: objective.objective.id,
    projectId: delivery.platformSource.projectId,
    conversationId: delivery.platformSource.conversationId,
    revision,
    action,
  });
  try {
    internal.request = async (path, method = "GET", raw) => {
      if (method === "GET")
        return { detail_bounds: bounds, threads: [], objectives: [objective] };
      const body = raw as { expected_revision: number };
      mutations.push({ path, method, body });
      assert.equal(body.expected_revision, objective.objective.revision);
      objective.objective.revision++;
      if (method === "DELETE") {
        objective.objective.status = "cancelled";
        return {
          deleted: true,
          objective_id: objective.objective.id,
          terminal_status: "cancelled",
        };
      }
      const paused = path.endsWith("/pause");
      objective.objective.status = paused ? "paused" : "active";
      return {
        [paused ? "paused" : "resumed"]: true,
        objective: { ...objective.objective },
      };
    };
    await internal.refreshActivity();
    const read = () =>
      f.runtime.platformNavigationSnapshot(localAccess, [f.projectId]).runtime
        .activity!.objectives![0]!;
    assert.equal(read().controlAllowed, true);
    assert.equal(read().revision, 1);
    await f.session().objectiveControl(request("pause"));
    assert.equal(read().status, "paused");
    await assert.rejects(
      f.session().objectiveControl(request("resume", 1)),
      /目标已发生变化/,
    );
    assert.equal(mutations.length, 1);
    await f.session().objectiveControl(request("resume"));
    assert.equal(read().status, "active");
    await assert.rejects(
      f
        .session()
        .objectiveControl({ ...request("pause"), objectiveId: "foreign-goal" }),
      /不属于/,
    );
    await assert.rejects(
      f
        .session({ principalId: "foreign-human", actantId: "foreign" })
        .objectiveControl(request("pause")),
    );
    assert.equal(mutations.length, 2);
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
      const remote = new HttpApplicationClient(`http://127.0.0.1:${port}`);
      const boot = (await remote.call("platform.bootstrap")) as {
        csrfToken: string;
      };
      await remote.call("objective.control", request("delete"), {
        identityGeneration: boot.csrfToken,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    assert.equal(read().status, "cancelled");
    assert.deepEqual(
      mutations.map((value) => [
        value.path,
        value.method,
        value.body.expected_revision,
      ]),
      [
        ["/api/objectives/objective-1/pause", "POST", 1],
        ["/api/objectives/objective-1/resume", "POST", 2],
        ["/api/objectives/objective-1", "DELETE", 3],
      ],
    );
    assert.equal(internal.state.deliveries.length, 1);
  } finally {
    await f.close();
  }
});

test("编辑目标复用同一权限和修订栅栏，以 PATCH 确认原文，不恢复暂停或创建执行", async () => {
  const { f, internal, delivery, bounds, objective } = await fixture();
  const mutations: { path: string; method: string; body: any }[] = [];
  const request = (text: string, revision = objective.objective.revision) => ({
    objectiveId: objective.objective.id,
    projectId: delivery.platformSource.projectId,
    conversationId: delivery.platformSource.conversationId,
    revision,
    action: "edit",
    statedObjective: text,
  });
  let wrongReceipt = false;
  try {
    objective.objective.status = "paused";
    internal.request = async (path, method = "GET", raw) => {
      if (method === "GET")
        return { detail_bounds: bounds, threads: [], objectives: [objective] };
      const body = raw as {
        expected_revision: number;
        stated_objective: string;
      };
      mutations.push({ path, method, body });
      assert.equal(body.expected_revision, objective.objective.revision);
      objective.objective.revision++;
      objective.objective.stated_objective = body.stated_objective;
      return {
        edited: true,
        objective: {
          ...objective.objective,
          ...(wrongReceipt ? { stated_objective: "unconfirmed" } : {}),
        },
      };
    };
    await internal.refreshActivity();
    const edited = "修改后的完整目标\n\n保留原有执行和暂停状态。";
    await f.session().objectiveControl(request(`  ${edited}  `));
    assert.equal(objective.objective.stated_objective, edited);
    assert.equal(objective.objective.status, "paused");
    assert.equal(mutations[0]!.method, "PATCH");
    assert.equal(mutations[0]!.path, "/api/objectives/objective-1");
    assert.deepEqual(mutations[0]!.body, {
      expected_revision: 1,
      stated_objective: edited,
    });
    await assert.rejects(
      f.session().objectiveControl(request("stale", 1)),
      /变化/,
    );
    await assert.rejects(f.session().objectiveControl(request("   ")));
    await assert.rejects(
      f.session().objectiveControl(request("长".repeat(32001))),
    );
    await assert.rejects(
      f
        .session({ principalId: "foreign-human", actantId: "foreign" })
        .objectiveControl(request("forbidden")),
    );
    assert.equal(mutations.length, 1);
    wrongReceipt = true;
    await assert.rejects(
      f.session().objectiveControl(request("回执必须逐字一致")),
      /回执/,
    );
    assert.equal(
      mutations.length,
      2,
      "uncertain edit is never automatically retried",
    );
    assert.equal(internal.state.deliveries.length, 1);
  } finally {
    await f.close();
  }
});

test("目标操作在异步读取期间撤权时拒绝，不能把可读误当可控制", async () => {
  const { f, internal, bounds, objective } = await fixture();
  const source = internal as unknown as {
    authorizePlatformRead: (...args: any[]) => Promise<any>;
  };
  const authorize = source.authorizePlatformRead;
  let revoked = false,
    writes = 0;
  try {
    source.authorizePlatformRead = async (...args) => {
      if (revoked) throw new Error("TEST 已撤销权限");
      return authorize(...args);
    };
    internal.request = async (_path, method = "GET") => {
      if (method !== "GET") writes++;
      revoked = true;
      return { detail_bounds: bounds, threads: [], objectives: [objective] };
    };
    await assert.rejects(
      f.session().objectiveControl({
        objectiveId: objective.objective.id,
        projectId: f.projectId,
        conversationId:
          internal.state.deliveries[0]!.platformSource.conversationId,
        action: "pause",
        revision: 1,
      }),
      /撤销权限/,
    );
    assert.equal(writes, 0);
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
