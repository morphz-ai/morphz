import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { workInputRequest } from "../packages/application/src/session-io.js";
import { ExecutionControls } from "../packages/application/src/execution.js";
import {
  activityAnnotationFields,
  jobsWithRuntimeAnnotations,
  scopedRuntimeResponseAnnotations,
} from "../packages/application/src/response-annotations.js";
import {
  localAccess,
  DomainError,
  type RecordedInput,
} from "../packages/core/src/model.js";
import { jobSchema } from "../packages/core/src/execution.js";
import {
  taskRunAdmissionSchema,
  prepareTaskAdmission,
} from "../packages/platform/src/task-run-admission.js";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";
import {
  taskSourceEventSchema,
  taskSourceRequest,
} from "../packages/platform/src/task-run-source.js";
import { acceptedRuntimeInput } from "./runtime-http-evidence.js";

const now = "2026-10-02T12:00:00.000Z";
const annotations = (overrides: Record<string, unknown> = {}) => ({
  protocol: "v1",
  scope: { execution_id: "thread-one", generation: 1 },
  title: "检查运行环境",
  progress: "已确认平台，继续检查架构",
  result: "已确认平台与架构",
  steps: [
    { job_id: "job-one", intent: "读取系统类型", result: "系统是 macOS" },
  ],
  source_count: 2,
  truncated: false,
  ...overrides,
});
const thread = { id: "thread-one", generation: 1, lifecycle: "open" };
const job = jobSchema.parse({
  id: "job-one",
  revision: 3,
  session_id: "session-one",
  context_id: "context-one",
  tool_name: "exec",
  target_id: "local",
  thread_id: "thread-one",
  status: "succeeded",
  created_at: now,
  updated_at: now,
  request: { command: "uname -s" },
  result_event_id: "result-one",
});
const input: RecordedInput = {
  id: "input-one",
  projectId: "project-one",
  artifactId: null,
  artifactRevision: null,
  selection: "",
  body: "检查环境",
  author: localAccess,
  targetActantId: "morphz-agent",
  status: "recorded",
  createdAt: now,
};

function sourceObservation(protocol: "off" | "v1" | "v2" | undefined) {
  const admission = taskRunAdmissionSchema.parse({
    eventId: `task_run_${"a".repeat(40)}`,
    tenantId: "source-tenant",
    taskId: "source-task",
    projectId: "first-project",
    runNumber: 1,
    taskRevision: 2,
    principalId: localAccess.principalId,
    humanActantId: localAccess.actantId,
    sourceInputId: null,
    sessionId: "source-session",
    request: {
      id: `task_${"a".repeat(40)}`,
      intent: "关注指定原件",
      model_alias: "exact-model",
      reasoning_effort: "high",
      ...(protocol !== undefined ? { response_annotations: protocol } : {}),
      not_before: now,
      interval_seconds: null,
      dependency_thread_ids: [],
    },
    sourceSignature: "original-signature",
    watchSourceIds: ["source-content"],
  });
  return {
    eventId: `task_source_${"b".repeat(40)}`,
    admissionEventId: admission.eventId,
    tenantId: admission.tenantId,
    taskId: admission.taskId,
    runNumber: 1,
    controlRevision: 3,
    previousSignature: "original-signature",
    sourceSignature: "exact-signature-v2",
    sourceCommandIds: ["app-revision-command"],
    sources: [
      {
        kind: "content" as const,
        sourceId: "source-content",
        projectId: admission.projectId,
        versionRef: "2",
      },
    ],
    destination: {
      kind: "follow-up" as const,
      principalId: localAccess.principalId,
      targetId: "original-target",
    },
    admission,
  };
}

test("source follow-up inherits frozen V2/V1/off/omission, while a live Thread never overrides its protocol", () => {
  for (const protocol of [undefined, "off", "v1", "v2"] as const) {
    const observation = sourceObservation(protocol);
    const original = JSON.stringify(observation.admission);
    const followUp = taskSourceRequest(observation);
    assert.equal(followUp.activation.response_annotations, protocol);
    assert.equal(
      "response_annotations" in followUp.activation,
      protocol !== undefined,
    );
    const directed = taskSourceRequest({
      ...observation,
      destination: {
        kind: "thread",
        threadId: "original-thread",
        generation: 2,
        principalId: localAccess.principalId,
      },
    });
    assert.equal("response_annotations" in directed.activation, false);
    assert.deepEqual(directed.activation.input_destination, {
      kind: "thread",
      thread_id: "original-thread",
      generation: 2,
    });
    assert.equal(JSON.stringify(observation.admission), original);
  }
});

test("source delivery lost-response retry reuses frozen request bytes, including pre-upgrade omitted choices", async () => {
  for (const protocol of [
    undefined,
    "off",
    "v1",
    "v2",
    "pre-upgrade",
  ] as const) {
    const observation = sourceObservation(
      protocol === "pre-upgrade" ? "v1" : protocol,
    );
    const request = taskSourceRequest(observation);
    // This event was persisted before follow-up inheritance was added. Its
    // existing request remains authoritative even if the admission has V1.
    if (protocol === "pre-upgrade")
      delete request.activation.response_annotations;
    const event = taskSourceEventSchema.parse({ ...observation, request });
    const frozenBytes = JSON.stringify(event.request);
    const posts: string[] = [];
    let accepted: ReturnType<typeof acceptedRuntimeInput> | undefined;
    const server = createServer(async (req, res) => {
      const parts: Buffer[] = [];
      for await (const part of req) parts.push(part);
      const send = (status: number, value: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.method === "POST") {
        const body = JSON.parse(Buffer.concat(parts).toString());
        posts.push(JSON.stringify(body));
        accepted = acceptedRuntimeInput(
          body,
          observation.admission.sessionId,
          "source-root",
        );
        Object.assign(accepted, {
          actor: "Session-Client",
          type: "session_message",
        });
        Object.assign(accepted.payload, {
          principal_id: observation.destination.principalId,
          root_turn_id: accepted.id,
        });
        return send(503, { error: "response lost after durable acceptance" });
      }
      if (req.url?.endsWith("/thread"))
        return send(200, {
          thread_id: "source-followup-thread",
          session_id: observation.admission.sessionId,
          root_turn_id: "source-root",
        });
      return send(accepted ? 200 : 404, accepted ? { event: accepted } : {});
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const f = await platformRuntimeHostFixture({
      url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      namespace: randomUUID(),
      token: "source-annotation-fixture",
    });
    try {
      await assert.rejects(
        f.runtime.deliverTaskSource(event, event.admission, localAccess),
      );
      assert.deepEqual(
        await f.runtime.deliverTaskSource(event, event.admission, localAccess),
        {
          eventId: "source-root",
          rootId: "source-root",
          threadId: "source-followup-thread",
        },
      );
      assert.deepEqual(posts, [frozenBytes]);
      assert.equal(JSON.stringify(event.request), frozenBytes);
    } finally {
      await f.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});

test("new ordinary/follow-up inputs opt into V2; a directed supplement has no protocol override", () => {
  const ordinary = workInputRequest(input, "fixture-model");
  assert.ok("response_annotations" in ordinary.activation);
  assert.equal(ordinary.activation.response_annotations, "v2");
  assert.equal(ordinary.activation.dispatch_mode, "interrupt");
  assert.equal(ordinary.activation.model_alias, "fixture-model");
  const followUp = workInputRequest({
    ...input,
    continuation: {
      mode: "follow-up",
      inputId: "original-input",
      threadId: "thread-original",
      generation: 2,
    },
  });
  assert.ok("response_annotations" in followUp.activation);
  assert.equal(followUp.activation.response_annotations, "v2");
  const supplement = workInputRequest(
    {
      ...input,
      continuation: {
        mode: "supplement",
        inputId: "original-input",
        threadId: "thread-original",
        generation: 2,
      },
    },
    "must-not-override",
  );
  assert.equal("response_annotations" in supplement.activation, false);
  assert.equal(supplement.activation.model_alias, undefined);
  assert.equal(supplement.activation.dispatch_mode, "parallel");
  assert.ok("input_destination" in supplement.activation);
  assert.deepEqual(supplement.activation.input_destination, {
    kind: "thread",
    thread_id: "thread-original",
    generation: 2,
  });
});

test("display projection follows exact generation and actual terminal facts, never model status", () => {
  assert.equal(
    activityAnnotationFields(annotations({ protocol: "v2" }), thread)
      ?.annotationProtocol,
    "v2",
  );
  assert.deepEqual(activityAnnotationFields(annotations(), thread), {
    title: "检查运行环境",
    summary: "已确认平台，继续检查架构",
    annotationProtocol: "v1",
    annotationsTruncated: false,
  });
  assert.equal(
    activityAnnotationFields(annotations({ status: "completed" }), thread)
      ?.summary,
    "已确认平台，继续检查架构",
  );
  for (const lifecycle of ["completed", "failed"])
    assert.equal(
      activityAnnotationFields(annotations(), { ...thread, lifecycle })
        ?.summary,
      "已确认平台与架构",
    );
  const cancelled = activityAnnotationFields(annotations(), {
    ...thread,
    lifecycle: "cancelled",
  })!;
  assert.equal(cancelled.summary, undefined);
  assert.equal(cancelled.title, "检查运行环境");
  const bounded = activityAnnotationFields(
    annotations({ truncated: true }),
    thread,
  )!;
  assert.equal(bounded.title, undefined);
  assert.equal(bounded.annotationsTruncated, true);
});

test("bad optional metadata fails closed, including cross-thread, stale generation and missing proof", () => {
  for (const value of [
    null,
    {},
    annotations({ protocol: "off" }),
    annotations({ protocol: "v3" }),
    annotations({ scope: { execution_id: "other", generation: 1 } }),
    annotations({ scope: { execution_id: "thread-one", generation: 2 } }),
    annotations({ title: "x".repeat(257) }),
    annotations({ steps: [{ job_id: "a" }, { job_id: "a" }] }),
  ])
    assert.equal(
      scopedRuntimeResponseAnnotations(value, {
        threadId: thread.id,
        generation: thread.generation,
      }),
      null,
    );
  assert.equal(
    scopedRuntimeResponseAnnotations(annotations(), { threadId: thread.id }),
    null,
  );
});

test("Job display text maps only verified Job IDs and genuine result references", () => {
  const scope = {
    threadId: thread.id,
    generation: thread.generation,
    sessionId: job.session_id,
    contextId: job.context_id,
  };
  const decorated = jobsWithRuntimeAnnotations([job], annotations(), scope)[0]!;
  assert.deepEqual(decorated.annotation, {
    intent: "读取系统类型",
    result: "系统是 macOS",
  });
  const { annotation: _metadata, ...facts } = decorated;
  assert.deepEqual(facts, job);
  for (const changed of [
    { ...job, id: "other-job" },
    { ...job, thread_id: "other-thread" },
    { ...job, session_id: "other-session" },
    { ...job, context_id: "other-context" },
  ])
    assert.equal(
      jobsWithRuntimeAnnotations([changed], annotations(), scope)[0]!
        .annotation,
      undefined,
    );
  assert.deepEqual(
    jobsWithRuntimeAnnotations(
      [{ ...job, result_event_id: null }],
      annotations(),
      scope,
    )[0]!.annotation,
    { intent: "读取系统类型" },
  );
  assert.equal(
    jobsWithRuntimeAnnotations(
      [{ ...job, annotation: { intent: "unverified" } }],
      null,
      scope,
    )[0]!.annotation,
    undefined,
  );
});

type Internal = {
  state: any;
  request(path: string, method?: string, body?: unknown): Promise<unknown>;
  refreshActivity(): Promise<void>;
  save(delivery?: unknown): void;
};
async function recordedFixture() {
  const f = await platformRuntimeHostFixture();
  const receipt = await f.session().platformMessage({
    commandId: randomUUID(),
    operation: {
      type: "record-input",
      projectId: f.projectId,
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body: "原始用户输入，不是活动短标题",
      targetActantId: "morphz-agent",
    },
  });
  const internal = f.runtime as unknown as Internal;
  const delivery = internal.state.deliveries.find(
    (item: any) => item.inputId === receipt.entityId,
  );
  const original: RecordedInput = {
    ...input,
    id: delivery.inputId,
    ...delivery.platformSource,
  };
  const contextId = `mw-context-${internal.state.namespace}`;
  return { f, internal, delivery, original, contextId };
}

for (const protocol of [undefined, "off", "v1", "v2"] as const)
  test(`a retained typed admission keeps exact ${protocol ?? "omitted"} annotation choice on re-admission and restart`, async () => {
    const { f, original } = await recordedFixture();
    try {
      const saved = f.store.runtimeState() as any;
      const delivery = saved.deliveries[0];
      if (protocol === undefined)
        delete delivery.request.activation.response_annotations;
      else delivery.request.activation.response_annotations = protocol;
      delivery.state = "failed";
      const bytes = JSON.stringify(delivery.request);
      f.store.saveRuntimeState(saved);
      await f.reopen();
      await f.runtime.retryPlatformInput(original.id);
      assert.equal(
        JSON.stringify((f.store.runtimeState() as any).deliveries[0].request),
        bytes,
      );
      await f.runtime.as(localAccess, () =>
        f.runtime.enqueuePlatformInput(original),
      );
      assert.equal(
        JSON.stringify((f.store.runtimeState() as any).deliveries[0].request),
        bytes,
      );
      assert.equal((f.store.runtimeState() as any).deliveries.length, 1);
      f.assertNoLegacyData();
    } finally {
      await f.close();
    }
  });

test("actual Host activity refresh consumes trusted projection and same-Thread title updates, retaining fallback and read scopes", async () => {
  const { f, internal, delivery, contextId } = await recordedFixture();
  try {
    delivery.rootId = "root-one";
    internal.state.connected = true;
    let title = "检查运行环境";
    let lifecycle = "open";
    let metadata: unknown = annotations();
    let reads = 0;
    const answer = () => ({
      detail_bounds: {
        limit: 200,
        has_more_threads: false,
        has_more_objectives: false,
        has_more_schedules: false,
      },
      objectives: [],
      schedules: [],
      threads: [
        {
          intent: "既有执行意图",
          phase: lifecycle === "open" ? "running" : "idle",
          response_annotations:
            metadata && typeof metadata === "object"
              ? { ...metadata, title }
              : metadata,
          thread: {
            ...thread,
            kind: "execution",
            session_id: delivery.sessionId,
            context_id: contextId,
            root_turn_id: "root-one",
            lifecycle,
            revision: 3,
            created_at: now,
            updated_at: now,
          },
        },
      ],
    });
    internal.request = async (path) => {
      assert.ok(path.includes("/scheduler?"));
      reads++;
      return answer();
    };
    const visible = () =>
      f.runtime.platformNavigationSnapshot(localAccess, [f.projectId]).runtime
        .activity!;
    await internal.refreshActivity();
    assert.equal(reads, 2, "embedded projection requires no per-Thread HTTP");
    assert.equal(visible().threads[0]!.title, title);
    assert.equal(visible().threads[0]!.summary, "已确认平台，继续检查架构");
    title = "检查运行环境并核对内存";
    await internal.refreshActivity();
    assert.equal(visible().threads[0]!.id, "thread-one");
    assert.equal(visible().threads[0]!.title, title);
    lifecycle = "completed";
    await internal.refreshActivity();
    assert.equal(visible().threads[0]!.summary, "已确认平台与架构");
    lifecycle = "cancelled";
    await internal.refreshActivity();
    assert.equal(visible().threads[0]!.summary, undefined);
    assert.equal(visible().threads[0]!.lifecycle, "cancelled");
    for (const bad of [
      null,
      annotations({ scope: { execution_id: "foreign", generation: 1 } }),
      annotations({ scope: { execution_id: "thread-one", generation: 2 } }),
      annotations({ truncated: true }),
    ]) {
      metadata = bad;
      await internal.refreshActivity();
      assert.equal(visible().available, true);
      assert.equal(visible().threads[0]!.title, "既有执行意图");
    }
    assert.deepEqual(
      f.runtime.platformNavigationSnapshot(localAccess, []).runtime.activity!
        .threads,
      [],
    );
    assert.deepEqual(
      f.runtime.platformNavigationSnapshot(
        { principalId: "stranger", actantId: "stranger" },
        [f.projectId],
      ).runtime.activity!.threads,
      [],
    );
    lifecycle = "completed";
    metadata = annotations();
    await internal.refreshActivity();
    internal.save(delivery);
    await f.reopen();
    const reopened = f.runtime as unknown as Internal;
    assert.equal(reopened.state.activity.threads[0].title, title);
    assert.equal(
      reopened.state.activity.threads[0].summary,
      "已确认平台与架构",
    );
    reopened.request = internal.request;
    await reopened.refreshActivity();
    assert.equal(reopened.state.activity.threads[0].id, "thread-one");
    assert.equal(
      reopened.state.deliveries.length,
      1,
      "refresh never adds work",
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("actual inspector enriches only proven roots; optional endpoint failure/Off/stale generation preserve physical facts", async () => {
  const reads: string[] = [];
  let metadata: unknown = annotations();
  let fail = false;
  const controls = new ExecutionControls(
    async (path) => {
      reads.push(path);
      if (path === "/api/approvals") return { approvals: [] };
      if (path.endsWith("/annotations")) {
        if (fail) throw new Error("old Runtime 404");
        return metadata;
      }
      if (path.includes("/threads/"))
        return {
          snapshot: {
            thread: {
              ...thread,
              id: path.split("/").at(-1),
              session_id: job.session_id,
              context_id: job.context_id,
              root_turn_id: path.endsWith("foreign")
                ? "root-other"
                : "root-one",
            },
          },
        };
      return {
        jobs: [job, { ...job, id: "foreign-job", thread_id: "foreign" }],
      };
    },
    () => ({
      sessionId: job.session_id,
      contextId: job.context_id,
      rootId: "root-one",
    }),
  );
  const scope = { projectId: "project-one", artifactId: null };
  const good = await controls.snapshot(scope);
  assert.equal(good.jobs.length, 1);
  assert.deepEqual(good.jobs[0]!.annotation, {
    intent: "读取系统类型",
    result: "系统是 macOS",
  });
  assert.deepEqual(
    reads.filter((path) => path.endsWith("/annotations")),
    ["/api/sessions/session-one/threads/thread-one/annotations"],
  );
  for (const bad of [
    null,
    { invalid: "metadata" },
    annotations({ scope: { execution_id: "thread-one", generation: 2 } }),
  ]) {
    metadata = bad;
    const view = await controls.snapshot(scope);
    assert.deepEqual(view.jobs, [job]);
  }
  fail = true;
  assert.deepEqual((await controls.snapshot(scope)).jobs, [job]);
});

test("Platform rechecks read authority after annotation fetch, not just before the inspector opens", async () => {
  const { f, internal, delivery, contextId } = await recordedFixture();
  try {
    delivery.rootId = "root-one";
    let allowed = true;
    f.runtime.bindPlatformReadAuthority(async () => {
      if (!allowed) throw new DomainError("forbidden", "读取权限已撤销");
      return {
        personalDefault: delivery.platformSource.sharedDefault,
        projectIds: [f.projectId],
      };
    });
    internal.request = async (path) => {
      if (path === "/api/approvals") return { approvals: [] };
      if (path.endsWith("/annotations")) {
        allowed = false;
        return annotations();
      }
      if (path.includes("/threads/"))
        return {
          snapshot: {
            thread: {
              ...thread,
              session_id: delivery.sessionId,
              context_id: contextId,
              root_turn_id: "root-one",
            },
          },
        };
      return {
        jobs: [
          { ...job, session_id: delivery.sessionId, context_id: contextId },
        ],
      };
    };
    const controls = await f.runtime.platformExecutionControls(
      {
        projectId: f.projectId,
        conversationId: delivery.platformSource.conversationId,
        inputId: delivery.inputId,
        artifactId: null,
      },
      localAccess,
    );
    await assert.rejects(controls.snapshot(), /读取权限已撤销/);
  } finally {
    await f.close();
  }
});

test("new durable task admissions freeze V2; old omitted/off/V1 schedules deliver their original bytes", async () => {
  const { f, internal, contextId } = await recordedFixture();
  try {
    const tasks = f.domains.taskRuns();
    const taskId = randomUUID();
    const commandId = randomUUID();
    const start = () =>
      tasks.authority.withSession(
        localAccess,
        () => {},
        (actor) =>
          tasks.store.requestTaskRun(actor, {
            commandId,
            taskId,
            expectedRevision: 1,
            sessionId: "task-session",
            intent: "执行原始事项",
            notBefore: now,
          }),
      );
    await tasks.authority.withSession(
      localAccess,
      () => {},
      (actor) =>
        tasks.store.createTask(actor, {
          commandId: randomUUID(),
          taskId,
          projectId: f.projectId,
          title: "注解准入测试",
          assigneeId: "morphz-agent",
        }),
    );
    const admission = await start();
    assert.equal(admission.request.response_annotations, "v2");
    assert.deepEqual(await start(), admission);
    assert.equal(
      prepareTaskAdmission(admission, []).request.response_annotations,
      "v2",
    );
    for (const protocol of [undefined, "off", "v1"] as const) {
      const legacy = structuredClone(admission);
      if (protocol === undefined) delete legacy.request.response_annotations;
      else legacy.request.response_annotations = protocol;
      const parsed = taskRunAdmissionSchema.parse(legacy);
      assert.equal(JSON.stringify(parsed), JSON.stringify(legacy));
      assert.equal(
        JSON.stringify(prepareTaskAdmission(parsed, []).request),
        JSON.stringify(legacy.request),
      );
      const sent: unknown[] = [];
      internal.request = async (path, method, body) => {
        if (method === "POST") {
          sent.push(body);
          return {
            id: legacy.request.id,
            thread_id: "task-thread",
            source_turn_id: `client-schedule-${legacy.request.id}`,
            revision: 1,
            status: "queued",
            not_before: now,
            interval_seconds: null,
          };
        }
        if (path.endsWith("/thread"))
          return {
            thread_id: "task-thread",
            session_id: legacy.sessionId,
            root_turn_id: `client-schedule-${legacy.request.id}`,
            lifecycle: "open",
          };
        return {
          id: legacy.sessionId,
          context_id: contextId,
          permission_mode: "request_approval",
        };
      };
      await f.runtime.deliverTaskRun(legacy, localAccess);
      assert.deepEqual(sent, [legacy.request]);
    }
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});
