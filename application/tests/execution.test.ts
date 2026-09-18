import test from "node:test";
import assert from "node:assert/strict";
import { ExecutionControls } from "../apps/service/src/execution.js";
const scope = { projectId: "first-project", artifactId: null };
const binding = { sessionId: "session-1", contextId: "context-1" };

test("单个分支的查看和停止不包含同根的其他分支，停止须核对版本", async () => {
  const scoped = { ...scope, threadId: "thread-1" };
  const writes: unknown[] = [];
  const controls = new ExecutionControls(
    async (path, method, body) => {
      if (method === "POST") {
        writes.push(body);
        return {
          updated: true,
          thread: { id: "thread-1", lifecycle: "cancelled" },
        };
      }
      if (path === "/api/approvals")
        return {
          approvals: ["thread-1", "thread-2"].map((thread_id) => ({
            ...approval,
            request: { ...approval.request, thread_id, root_turn_id: "root-1" },
          })),
        };
      if (path.includes("/threads/"))
        return {
          snapshot: {
            thread: {
              id: path.split("/").at(-1),
              context_id: binding.contextId,
              session_id: binding.sessionId,
              root_turn_id: "root-1",
              revision: 7,
            },
          },
        };
      if (path.includes("?"))
        return {
          jobs: [job, { ...job, id: "sibling", thread_id: "thread-2" }],
        };
      return { ...job, id: "sibling", thread_id: "thread-2" };
    },
    () => ({ ...binding, rootId: "root-1", threadId: "thread-1" }),
  );
  const snapshot = await controls.snapshot(scoped);
  assert.deepEqual(
    snapshot.jobs.map((j) => j.id),
    [job.id],
  );
  assert.equal(snapshot.approvals.length, 1);
  await assert.rejects(controls.result(scoped, "sibling"), /不属于/);
  await assert.rejects(
    controls.control({
      scope: scoped,
      action: { type: "cancel-thread", threadId: "thread-2", revision: 7 },
    }),
    /不一致/,
  );
  await assert.rejects(
    controls.control({
      scope: scoped,
      action: { type: "cancel-thread", threadId: "thread-1", revision: 6 },
    }),
    /已变化/,
  );
  assert.equal(writes.length, 0);
  await controls.control({
    scope: scoped,
    action: { type: "cancel-thread", threadId: "thread-1", revision: 7 },
  });
  assert.deepEqual(writes, [
    {
      action: "cancel",
      expected_revision: 7,
      reason: "用户在 Morphz 停止此执行分支",
    },
  ]);
});

test("共享 Session 的执行详情、结果与审批必须限定到原始工作根", async () => {
  const jobs = [
    { ...job, id: "job-a", thread_id: "thread-a" },
    { ...job, id: "job-b", thread_id: "thread-b" },
  ];
  let writes = 0;
  const controls = new ExecutionControls(
    async (path, method) => {
      if (method === "POST") writes++;
      if (path === "/api/approvals")
        return {
          approvals: ["a", "b"].map((key) => ({
            requested_at: "2026-09-09T00:00:00Z",
            request: {
              approval_id: "approve-" + key,
              session_id: binding.sessionId,
              context_id: binding.contextId,
              root_turn_id: "root-" + key,
              justification: key,
              action: {},
              requested: {},
            },
          })),
        };
      if (path.includes("/threads/"))
        return {
          snapshot: {
            thread: {
              id: path.endsWith("thread-a") ? "thread-a" : "thread-b",
              session_id: binding.sessionId,
              context_id: binding.contextId,
              root_turn_id: path.endsWith("thread-a") ? "root-a" : "root-b",
            },
          },
        };
      if (path.includes("?")) return { jobs };
      return jobs.find((j) => path.endsWith(j.id));
    },
    () => ({ ...binding, rootId: "root-a" }),
  );
  const value = await controls.snapshot(scope);
  assert.deepEqual(
    value.jobs.map((j) => j.id),
    ["job-a"],
  );
  assert.deepEqual(
    value.approvals.map((a) => a.request.approval_id),
    ["approve-a"],
  );
  await assert.rejects(controls.result(scope, "job-b"), /不属于/);
  await assert.rejects(
    controls.control({
      scope,
      action: { type: "cancel-job", jobId: "job-b", revision: job.revision },
    }),
    /不属于/,
  );
  assert.equal(writes, 0);
});
const job = {
  id: "job-1",
  revision: 7,
  session_id: "session-1",
  context_id: "context-1",
  tool_name: "host_morphz_work",
  target_id: "local",
  thread_id: "thread-1",
  status: "running",
  created_at: "2026-09-08T00:00:00Z",
  updated_at: "2026-09-08T00:00:00Z",
  request: { action: "read" },
  claim_token: "must-never-reach-renderer",
};
const approval = {
  requested_at: "2026-09-08T00:00:00Z",
  request: {
    approval_id: "approval-1",
    session_id: "session-1",
    context_id: "context-1",
    justification: "读取已选资料",
    action: { kind: "tool_operation", tool: "read", operation: "read" },
    requested: { read_roots: ["/fixture"], network: false },
  },
};
test("空间 Session 迁移后仍能读取和控制旧对象执行，不接纳其他空间", async () => {
  const legacy = {
    ...job,
    id: "legacy-job",
    session_id: "legacy-session",
    result_event_id: "legacy-result",
  };
  const queries: string[] = [];
  const controls = new ExecutionControls(
    async (path, method) => {
      queries.push(path);
      if (path === "/api/approvals")
        return {
          approvals: [
            approval,
            {
              ...approval,
              request: { ...approval.request, session_id: "legacy-session" },
            },
            {
              ...approval,
              request: { ...approval.request, session_id: "foreign" },
            },
          ],
        };
      if (path.endsWith("/result"))
        return {
          job_id: legacy.id,
          event: {
            id: "legacy-result",
            payload: {
              session_id: legacy.session_id,
              context_id: binding.contextId,
              text: "历史结果",
            },
          },
        };
      if (path.includes("?"))
        return {
          jobs: path.includes("legacy-session")
            ? [legacy, { ...legacy, id: "foreign", session_id: "foreign" }]
            : [job],
        };
      if (method === "POST")
        return {
          ...legacy,
          revision: 8,
          cancel_requested_at: "2026-09-08T00:00:02Z",
        };
      return legacy;
    },
    () => ({
      ...binding,
      legacySessionIds: [binding.sessionId, "legacy-session"],
    }),
  );
  const view = await controls.snapshot(scope);
  assert.equal(view.jobs.length, 2);
  assert.equal(view.approvals.length, 2);
  assert.equal(queries.filter((p) => p.includes("?")).length, 2);
  assert.equal((await controls.result(scope, legacy.id)).text, "历史结果");
  assert.equal(
    (
      await controls.control({
        scope,
        action: { type: "cancel-job", jobId: legacy.id, revision: 7 },
      })
    ).accepted,
    true,
  );
});
test("执行投影限定对话；移除 worker 凭据，空对话不查询全局历史", async () => {
  let queries = 0;
  const controls = new ExecutionControls(
    async (path) => {
      queries++;
      if (path === "/api/approvals")
        return {
          approvals: [
            approval,
            {
              ...approval,
              request: { ...approval.request, session_id: "other" },
            },
          ],
        };
      const params = new URL(path, "http://localhost").searchParams;
      assert.equal(params.get("session_id"), "session-1");
      assert.equal(params.get("context_id"), "context-1");
      return { jobs: [job, { ...job, id: "other-job", session_id: "other" }] };
    },
    () => binding,
  );
  const snapshot = await controls.snapshot(scope);
  assert.equal(snapshot.jobs.length, 1);
  assert.equal(snapshot.approvals.length, 1);
  assert.ok(!JSON.stringify(snapshot).includes("must-never-reach-renderer"));
  const empty = new ExecutionControls(
    async () => {
      throw Error("must not query");
    },
    () => null,
  );
  assert.deepEqual(await empty.snapshot(scope), {
    jobs: [],
    approvals: [],
    limit: 100,
  });
  assert.equal(queries, 2);
});
test("停止执行使用精确版本；不自动重试冲突、不取消无关任务", async () => {
  const mutations: unknown[] = [];
  let current = job;
  const controls = new ExecutionControls(
    async (path, method, body) => {
      if (method === "POST") {
        assert.equal(path, "/api/execution-jobs/job-1/cancel");
        mutations.push(body);
        return {
          ...current,
          revision: 8,
          cancel_requested_at: "2026-09-08T00:00:02Z",
        };
      }
      return current;
    },
    () => binding,
  );
  await assert.rejects(
    controls.control({
      scope,
      action: { type: "cancel-job", jobId: "job-1", revision: 6 },
    }),
    /状态已变化/,
  );
  assert.equal(mutations.length, 0);
  assert.deepEqual(
    await controls.control({
      scope,
      action: { type: "cancel-job", jobId: "job-1", revision: 7 },
    }),
    { accepted: true, status: "running", cancelRequested: true },
  );
  assert.equal(mutations.length, 1);
  current = { ...job, session_id: "other" };
  await assert.rejects(
    controls.control({
      scope,
      action: { type: "cancel-job", jobId: "job-1", revision: 7 },
    }),
    /不属于/,
  );
  assert.equal(mutations.length, 1);
});
test("审批重新核对原文指纹，只允许单次授权，不能提升到完整访问", async () => {
  let pending = [approval];
  const decisions: unknown[] = [];
  const controls = new ExecutionControls(
    async (path, method, body) => {
      if (method === "POST") {
        decisions.push(body);
        return { accepted: true };
      }
      return path === "/api/approvals" ? { approvals: pending } : { jobs: [] };
    },
    () => binding,
  );
  const snapshot = await controls.snapshot(scope),
    fingerprint = snapshot.approvals[0]!.fingerprint;
  pending = [
    {
      ...approval,
      request: { ...approval.request, justification: "修改了请求内容" },
    },
  ];
  await assert.rejects(
    controls.control({
      scope,
      action: { type: "allow-once", approvalId: "approval-1", fingerprint },
    }),
    /已结束或内容已变化/,
  );
  assert.equal(decisions.length, 0);
  pending = [approval];
  await controls.control({
    scope,
    action: { type: "allow-once", approvalId: "approval-1", fingerprint },
  });
  assert.equal((decisions[0] as { decision: string }).decision, "allow_once");
  await assert.rejects(
    controls.control({
      scope,
      action: { type: "full_access", approvalId: "approval-1", fingerprint },
    }),
  );
  pending = [];
  await assert.rejects(
    controls.control({
      scope,
      action: { type: "deny", approvalId: "approval-1", fingerprint },
    }),
    /已结束或内容已变化/,
  );
});
test("结果校验执行和事件归属；超长输出有明确截断标识", async () => {
  let event = {
    id: "event-1",
    payload: {
      session_id: "session-1",
      context_id: "context-1",
      text: "a".repeat(65000),
    },
  };
  const controls = new ExecutionControls(
    async (path) =>
      path.endsWith("/result")
        ? { job_id: "job-1", event }
        : { ...job, result_event_id: "event-1" },
    () => binding,
  );
  const result = await controls.result(scope, "job-1");
  assert.equal(result.text.length, 64000);
  assert.equal(result.truncated, true);
  event = { ...event, id: "event-other" };
  await assert.rejects(controls.result(scope, "job-1"), /结果已变化/);
  event = {
    ...event,
    id: "event-1",
    payload: { ...event.payload, session_id: "other" },
  };
  await assert.rejects(controls.result(scope, "job-1"));
});
