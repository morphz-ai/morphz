import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { authorizedExecutionThreadTree } from "../packages/application/src/execution-thread-tree.js";
import { ExecutionControls } from "../packages/application/src/execution.js";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";
import { localAccess } from "../packages/core/src/model.js";
import {
  executionActivityRoots,
  executionActivityDescendants,
  executionActivityGroupStatus,
  type ActivityThread,
} from "../apps/web/src/execution-activity.js";
import { executionThreadGroups } from "../apps/web/src/execution-thread-groups.js";
import { jobSchema } from "../packages/core/src/execution.js";

const stamp = "2026-10-03T00:00:00Z";
const binding = {
  sessionId: "TEST-session",
  contextId: "TEST-context",
  inputRootId: "TEST-input-root",
  threadId: "TEST-main",
};
const rawThread = (
  id: string,
  root = "TEST-root-" + id,
  parent: string | null = null,
  extra: Record<string, unknown> = {},
) => ({
  intent: "TEST " + id,
  phase: "running",
  thread: {
    id,
    session_id: binding.sessionId,
    context_id: binding.contextId,
    root_turn_id: root,
    generation: 0,
    lifecycle: "open",
    revision: 1,
    created_at: stamp,
    updated_at: stamp,
    supervision: { parent_thread_id: parent },
    ...extra,
  },
});
function peer(values: ReturnType<typeof rawThread>[]) {
  const calls: string[] = [];
  return {
    calls,
    request: async (path: string) => {
      calls.push(path);
      if (path.includes("/scheduler?"))
        return {
          threads: values,
          detail_bounds: { limit: 200, has_more_threads: false },
        };
      const id = decodeURIComponent(path.split("/").at(-1)!);
      const snapshot = values.find((value) => value.thread.id === id);
      assert.ok(snapshot, "Unexpected missing controlled Thread " + id);
      return { snapshot };
    },
  };
}
test("子Thread按真实父链追溯原input root，聚合多个child及孙Thread，不纳入同input兄弟/异Session/异Context", async () => {
  const f = peer([
    rawThread("TEST-main", binding.inputRootId),
    rawThread("TEST-one", undefined, "TEST-main"),
    rawThread("TEST-two", undefined, "TEST-main"),
    rawThread("TEST-grandchild", undefined, "TEST-one"),
    rawThread("TEST-sibling", binding.inputRootId),
    rawThread("TEST-private", undefined, "TEST-main", {
      context_id: "TEST-private-context",
    }),
    rawThread("TEST-session", undefined, "TEST-main", {
      session_id: "TEST-private-session",
    }),
  ]);
  const tree = await authorizedExecutionThreadTree(f.request, binding, true);
  assert.deepEqual(
    new Set(tree.threads.map((t) => t.id)),
    new Set(["TEST-main", "TEST-one", "TEST-two", "TEST-grandchild"]),
  );
  assert.equal(tree.truncated, false);
  const child = await authorizedExecutionThreadTree(
    f.request,
    { ...binding, threadId: "TEST-one" },
    true,
  );
  assert.deepEqual(
    child.threads.map((t) => t.id),
    ["TEST-one", "TEST-grandchild"],
  );
  assert.ok(
    f.calls.some((p) => p.endsWith("/TEST-main")),
    "Child root was authorized through a real ancestor read",
  );
  assert.notEqual(child.selected.rootId, binding.inputRootId);
});

test("不能只放宽child root equality；无父锚点、循环、跨Context父链和伪装ID全部拒绝", async () => {
  for (const values of [
    [rawThread("TEST-one")],
    [
      rawThread("TEST-one", undefined, "TEST-two"),
      rawThread("TEST-two", undefined, "TEST-one"),
    ],
    [
      rawThread("TEST-one", undefined, "TEST-main"),
      rawThread("TEST-main", binding.inputRootId, null, {
        context_id: "private",
      }),
    ],
  ])
    await assert.rejects(
      authorizedExecutionThreadTree(
        peer(values).request,
        { ...binding, threadId: "TEST-one" },
        false,
      ),
      /来源|不属于/,
    );
  await assert.rejects(
    authorizedExecutionThreadTree(
      async () => ({ snapshot: rawThread("forged", binding.inputRootId) }),
      binding,
      false,
    ),
    /不属于/,
  );
});

test("有界Thread历史与截断不伪造完整性，annotation必须属于每个Thread自己的generation", async () => {
  const own = rawThread("TEST-main", binding.inputRootId),
    child = rawThread("TEST-child", undefined, "TEST-main");
  Object.assign(own, {
    response_annotations: {
      protocol: "v2",
      scope: { execution_id: own.thread.id, generation: 0 },
      title: "主工作",
      progress: "父线程进度",
      steps: [],
      source_count: 1,
      truncated: false,
    },
  });
  Object.assign(child, {
    response_annotations: {
      protocol: "v2",
      scope: { execution_id: own.thread.id, generation: 0 },
      title: "不许套到child",
      progress: "父进度不许复制",
      steps: [],
      source_count: 1,
      truncated: false,
    },
  });
  const f = peer([own, child]);
  const tree = await authorizedExecutionThreadTree(
    async (path) =>
      path.includes("/scheduler?")
        ? {
            threads: [own, child],
            detail_bounds: { limit: 2, has_more_threads: false },
          }
        : f.request(path),
    binding,
    true,
  );
  assert.equal(tree.truncated, true);
  assert.equal(tree.selected.title, "主工作");
  assert.equal(tree.threads[1]!.title, child.intent);
  assert.equal(tree.threads[1]!.summary, undefined);
});

const job = (id: string, threadId: string) =>
  jobSchema.parse({
    id,
    revision: 1,
    session_id: binding.sessionId,
    context_id: binding.contextId,
    thread_id: threadId,
    tool_name: "read",
    target_id: "local",
    status: "running",
    request: { path: "TEST.txt" },
    created_at: stamp,
    updated_at: stamp,
  });
test("聚合read不扩展cancel/approval：明确选child scope才能控制它，并保持同input sibling拒绝", async () => {
  let writes = 0;
  const f = peer([
    rawThread("TEST-main", binding.inputRootId),
    rawThread("TEST-child", "TEST-child-root", "TEST-main"),
  ]);
  const jobs = [
    job("main-job", "TEST-main"),
    job("child-job", "TEST-child"),
    job("sibling-job", "TEST-sibling"),
  ];
  const approval = {
    requested_at: stamp,
    request: {
      approval_id: "approve-child",
      session_id: binding.sessionId,
      context_id: binding.contextId,
      root_turn_id: "TEST-child-root",
      thread_id: "TEST-child",
      justification: "TEST 精确子任务批准",
      action: {},
      requested: {},
    },
  };
  const controls = new ExecutionControls(
    async (path, method) => {
      if (method === "POST") {
        writes++;
        if (path.includes("/api/approvals/")) return { accepted: true };
        return { ...jobs[1], revision: 2, cancel_requested_at: stamp };
      }
      if (path === "/api/approvals") return { approvals: [approval] };
      if (path.includes("/threads/")) return f.request(path);
      if (path.includes("?"))
        return {
          jobs: jobs.filter(
            (j) =>
              j.thread_id ===
              new URL(path, "http://test.invalid").searchParams.get(
                "thread_id",
              ),
          ),
        };
      return jobs.find((j) => path.endsWith(j.id));
    },
    (scope) => ({
      sessionId: binding.sessionId,
      contextId: binding.contextId,
      rootId:
        scope.threadId === "TEST-child"
          ? "TEST-child-root"
          : binding.inputRootId,
      threadId: scope.threadId ?? "TEST-main",
      threadIds: async () => ["TEST-main", "TEST-child"],
      additionalRoot: async (root, id) =>
        id === "TEST-child" && root === "TEST-child-root",
    }),
  );
  assert.equal(
    (
      await controls.snapshot({
        projectId: "p",
        artifactId: null,
        threadId: "TEST-main",
      })
    ).jobs.length,
    2,
  );
  await assert.rejects(
    controls.control({
      scope: { projectId: "p", artifactId: null, threadId: "TEST-main" },
      action: { type: "cancel-job", jobId: "child-job", revision: 1 },
    }),
    /不一致/,
  );
  assert.equal(writes, 0);
  const childApproval = (
    await controls.snapshot({
      projectId: "p",
      artifactId: null,
      threadId: "TEST-main",
    })
  ).approvals[0]!;
  await assert.rejects(
    controls.control({
      scope: { projectId: "p", artifactId: null, threadId: "TEST-main" },
      action: {
        type: "allow-once",
        approvalId: "approve-child",
        fingerprint: childApproval.fingerprint,
      },
    }),
    /不一致/,
  );
  assert.equal(writes, 0);
  await controls.control({
    scope: { projectId: "p", artifactId: null, threadId: "TEST-child" },
    action: { type: "cancel-job", jobId: "child-job", revision: 1 },
  });
  await controls.control({
    scope: { projectId: "p", artifactId: null, threadId: "TEST-child" },
    action: {
      type: "allow-once",
      approvalId: "approve-child",
      fingerprint: childApproval.fingerprint,
    },
  });
  assert.equal(writes, 2);
});

test("真实Platform read grant＋Host原始Input：child独立root可打开，聚合重读后撤权不会返回数据", async () => {
  const f = await platformRuntimeHostFixture();
  try {
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
        body: "TEST 原始父子工作",
        targetActantId: "morphz-agent",
      },
    });
    const internal = f.runtime as unknown as {
      state: any;
      request(path: string, method?: string): Promise<unknown>;
      authorizePlatformRead: (...args: any[]) => Promise<any>;
    };
    const delivery = internal.state.deliveries[0];
    delivery.rootId = binding.inputRootId;
    const contextId = `mw-context-${(f.store.runtimeState() as { namespace: string }).namespace}`;
    const source = delivery.platformSource;
    const values = [
      rawThread("TEST-main", binding.inputRootId),
      rawThread("TEST-child", "TEST-child-root", "TEST-main"),
    ].map((value) => ({
      ...value,
      thread: {
        ...value.thread,
        session_id: delivery.sessionId,
        context_id: contextId,
      },
    }));
    for (const value of values)
      internal.state.threadBindings[value.thread.id] = {
        id: value.thread.id,
        projectId: source.projectId,
        conversationId: source.conversationId,
        inputId: delivery.inputId,
        sessionId: delivery.sessionId,
        rootId: value.thread.root_turn_id,
        title: value.intent,
        phase: "running",
        lifecycle: "open",
        revision: 1,
        updatedAt: stamp,
      };
    let revoked = false,
      revokeAfterJobs = false,
      revokeAfterSingleJob = false,
      writes = 0;
    const authority = internal.authorizePlatformRead.bind(f.runtime);
    f.runtime.bindPlatformReadAuthority(async (...args) => {
      assert.equal(revoked, false, "TEST read authority revoked");
      return authority(...args);
    });
    internal.request = async (path, method) => {
      if (method === "POST") {
        writes++;
        throw new Error("TEST revoked grant must never write");
      }
      if (path.includes("/scheduler?"))
        return {
          threads: values,
          detail_bounds: { limit: 200, has_more_threads: false },
        };
      if (path === "/api/approvals") return { approvals: [] };
      if (path.includes("/threads/"))
        return { snapshot: values.find((v) => path.endsWith(v.thread.id)) };
      if (path.startsWith("/api/execution-jobs?")) {
        const thread = new URL(path, "http://test.invalid").searchParams.get(
          "thread_id",
        )!;
        if (revokeAfterJobs) revoked = true;
        return {
          jobs: [
            {
              ...job(thread + "-job", thread),
              session_id: delivery.sessionId,
              context_id: contextId,
            },
          ],
        };
      }
      if (path === "/api/execution-jobs/TEST-child-job") {
        if (revokeAfterSingleJob) revoked = true;
        return {
          ...job("TEST-child-job", "TEST-child"),
          session_id: delivery.sessionId,
          context_id: contextId,
        };
      }
      throw new Error("Unexpected " + path);
    };
    const scope = {
      projectId: source.projectId,
      conversationId: source.conversationId,
      artifactId: null,
      inputId: delivery.inputId,
      threadId: "TEST-child",
    };
    const view = await f.session().executionSnapshot(scope);
    assert.deepEqual(
      view.jobs.map((j) => j.thread_id),
      ["TEST-child"],
    );
    assert.equal(view.threads?.[0]?.rootId, "TEST-child-root");
    assert.equal(
      (await f.session().executionSnapshot({ ...scope, threadId: "TEST-main" }))
        .jobs.length,
      2,
    );
    await assert.rejects(
      f.runtime.platformExecutionControls(scope, {
        ...localAccess,
        principalId: "foreign",
      }),
      /权限|读取|不属于|身份/,
    );
    revokeAfterJobs = true;
    await assert.rejects(f.session().executionSnapshot(scope), /revoked/);
    revoked = false;
    revokeAfterJobs = false;
    revokeAfterSingleJob = true;
    await assert.rejects(
      f.session().executionControl({
        scope,
        action: { type: "cancel-job", jobId: "TEST-child-job", revision: 1 },
      }),
      /revoked/,
    );
    assert.equal(
      writes,
      0,
      "Revoked grant during physical reads must prevent the subsequent POST",
    );
  } finally {
    await f.close();
  }
});

test("列表一项主活动包含真实children；父已结束而child仍运行/失败不能冒充全部结束", () => {
  const activity = (
    id: string,
    parentThreadId: string | null,
    lifecycle = "open",
  ): ActivityThread => ({
    id,
    parentThreadId,
    sessionId: binding.sessionId,
    contextId: binding.contextId,
    rootId: "root-" + id,
    projectId: "p",
    conversationId: "p",
    inputId: "input",
    kind: "execution",
    title: id,
    phase: "running",
    lifecycle,
    revision: 1,
    updatedAt: stamp,
  });
  const main = activity("main", null, "completed"),
    child = activity("child", "main"),
    grandchild = activity("grand", "child", "completed"),
    sibling = activity("sibling", null),
    orphan = activity("orphan", "missing");
  const values = [main, child, grandchild, sibling, orphan];
  assert.deepEqual(
    executionActivityRoots(values).map((t) => t.id),
    ["main", "sibling", "orphan"],
  );
  assert.equal(executionActivityDescendants(main, values).length, 2);
  assert.equal(
    executionActivityGroupStatus(main, values, true).label,
    "子任务执行中",
  );
  assert.equal(
    executionActivityGroupStatus(main, values, false).kind,
    "unknown",
  );
  child.lifecycle = "failed";
  assert.equal(executionActivityGroupStatus(main, values, true).kind, "failed");
  const groups = executionThreadGroups({
    jobs: [
      job("grand-job", "grand"),
      job("main-job", "main"),
      job("child-job", "child"),
    ],
    approvals: [],
    limit: 100,
    threads: [main, child, grandchild].map((t) => ({
      ...t,
      contextId: binding.contextId,
      parentThreadId: t.parentThreadId ?? null,
    })),
  });
  assert.deepEqual(
    groups.map((g) => [g.id, g.depth, g.jobs.map((j) => j.id)]),
    [
      ["main", 0, ["main-job"]],
      ["child", 1, ["child-job"]],
      ["grand", 2, ["grand-job"]],
    ],
  );
});
