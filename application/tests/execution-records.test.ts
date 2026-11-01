import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizedExecutionThreadTree,
  readExecutionRecords,
} from "../packages/application/src/execution-thread-tree.js";
import { ExecutionControls } from "../packages/application/src/execution.js";

const binding = {
  sessionId: "session,opaque",
  contextId: "context-1",
  inputRootId: "input,opaque",
  threadId: "parent,opaque",
};
const threads = Array.from({ length: 13 }, (_, index) => ({
  id: index ? `child-${index}` : binding.threadId,
  session_id: binding.sessionId,
  context_id: binding.contextId,
  root_turn_id: index ? `root-${index}` : "goal-synthetic-root",
  parent_thread_id: index ? binding.threadId : null,
  generation: 1,
  revision: 2,
  lifecycle: "open",
  control_state: "active",
  phase: "running",
  created_at: "2026-10-13T01:00:00Z",
  updated_at: "2026-10-13T02:00:00Z",
  intent: "真实执行意图",
  response_annotations: null,
}));
const jobs = Array.from({ length: 100 }, (_, index) => ({
  id: `job-${String(100 - index).padStart(3, "0")}`,
  revision: 1,
  thread_id: threads[index % 13]!.id,
  session_id: binding.sessionId,
  context_id: binding.contextId,
  status: "running",
  tool_name: "read",
  target_id: "target-default",
  request: { path: "controlled.md" },
  created_at: "2026-10-13T01:00:00Z",
  updated_at: "2026-10-13T02:00:00Z",
  claim_token: "private-worker-capability",
}));
const page = () => ({
  session_id: binding.sessionId,
  context_id: binding.contextId,
  selected_thread_id: binding.threadId,
  source_root_id: binding.inputRootId,
  limit: 100,
  threads_truncated: false,
  has_more_jobs: true,
  threads,
  jobs,
});

test("one bounded native projection feeds 13 branches/100 Jobs without full Thread or per-branch history reads", async () => {
  const reads: string[] = [];
  const request = async (path: string, method?: string) => {
    assert.ok(
      !method || method === "GET",
      "inspector cannot submit or stop a task",
    );
    reads.push(path);
    if (path.split("?")[0] === "/api/approvals") return { approvals: [] };
    const url = new URL(path, "http://controlled.invalid");
    assert.equal(
      url.pathname,
      `/api/sessions/${encodeURIComponent(binding.sessionId)}/execution-records`,
    );
    assert.deepEqual(
      JSON.parse(url.searchParams.get("root_turn_ids")!),
      [binding.inputRootId],
      "opaque comma IDs remain one ID",
    );
    assert.equal(url.searchParams.get("thread_id"), binding.threadId);
    const full = page();
    return url.searchParams.has("metadata_only")
      ? { ...full, jobs: [], threads: [threads[0]] }
      : full;
  };
  await authorizedExecutionThreadTree(request, binding, false);
  const tree = await authorizedExecutionThreadTree(request, binding, true);
  const controls = new ExecutionControls(request, () => ({
    sessionId: binding.sessionId,
    contextId: binding.contextId,
    threadId: binding.threadId,
    rootId: tree.selected.rootId,
    records: tree.records,
    threadIds: async () => tree.threads.map((thread) => thread.id),
    additionalRoot: async (root, id) =>
      tree.threads.some((thread) => thread.id === id && thread.rootId === root),
  }));
  const snapshot = await controls.snapshot({
    projectId: "p",
    artifactId: null,
    threadId: binding.threadId,
  });
  await authorizedExecutionThreadTree(request, binding, false);
  assert.equal(snapshot.jobs.length, 100);
  assert.equal(snapshot.threads?.length, 13);
  assert.equal(
    reads.length,
    4,
    "two fresh compact provenance fences, one bounded page and approvals",
  );
  assert.equal(
    reads.filter((path) => path.includes("metadata_only")).length,
    2,
  );
  assert.equal(
    reads.filter(
      (path) =>
        path.includes("execution-records") && !path.includes("metadata_only"),
    ).length,
    1,
  );
  assert.ok(!JSON.stringify(snapshot).includes("private-worker-capability"));
});

test("native projection refuses foreign scope, malformed topology, duplicate Threads and over-bound pages", async () => {
  const invalid = [
    { ...page(), session_id: "foreign" },
    { ...page(), source_root_id: "foreign-input" },
    { ...page(), threads: [threads[1], threads[0]] },
    { ...page(), threads: [threads[0], threads[0]] },
    {
      ...page(),
      threads: [
        threads[0],
        { ...threads[1], parent_thread_id: "not-returned" },
      ],
    },
    { ...page(), jobs: [...jobs, jobs[0]] },
    { ...page(), jobs: [{ ...jobs[0], context_id: "foreign" }] },
    { ...page(), jobs: [{ ...jobs[0], thread_id: "not-returned" }] },
  ];
  for (const wire of invalid)
    await assert.rejects(
      readExecutionRecords(async () => wire, {
        ...binding,
        rootIds: [binding.inputRootId],
        includeDescendants: true,
      }),
      /不属于|归属|核验/,
    );
  await assert.rejects(
    readExecutionRecords(async () => page(), {
      ...binding,
      rootIds: [binding.inputRootId],
      metadataOnly: true,
    }),
    /不属于|核验/,
  );
});

test("approval continuation reads one native page without reopening Jobs and retires foreign scopes", async () => {
  const paths: string[] = [];
  const source = {
    contextId: "approval-context",
    sessionId: "approval-session",
  };
  const request = async (path: string) => {
    paths.push(path);
    const url = new URL(path, "http://test.invalid");
    if (url.pathname.endsWith("/execution-records"))
      return {
        session_id: source.sessionId,
        context_id: source.contextId,
        selected_thread_id: null,
        source_root_id: null,
        limit: 100,
        has_more_jobs: false,
        threads_truncated: false,
        threads: [],
        jobs: [],
      };
    assert.equal(url.pathname, "/api/approvals");
    assert.equal(url.searchParams.get("limit"), "50");
    const second = url.searchParams.get("cursor") === "native-approval-next";
    return {
      approvals: Array.from({ length: second ? 1 : 50 }, (_, i) => ({
        requested_at: "2026-11-01T00:00:00Z",
        request: {
          approval_id: `a-${second ? 50 : i}`,
          session_id: source.sessionId,
          context_id: source.contextId,
          justification: "TEST",
          action: {},
          requested: {},
        },
      })),
      has_more: !second,
      next_cursor: second ? null : "native-approval-next",
    };
  };
  const scope = { projectId: "project", artifactId: null };
  const controls = new ExecutionControls(request, () => source);
  const head = await controls.snapshot(scope);
  assert.equal(head.approvals.length, 50);
  assert.ok(head.nextApprovalCursor);
  assert.equal(paths.filter((p) => p.includes("execution-records")).length, 1);
  const tail = await controls.snapshot({
    ...scope,
    approvalCursor: head.nextApprovalCursor,
  });
  assert.equal(tail.approvals.length, 1);
  assert.equal(tail.nextApprovalCursor, undefined);
  assert.equal(
    paths.filter((p) => p.includes("execution-records")).length,
    1,
    "only the requested child collection reads on More",
  );
  const before = paths.length;
  await assert.rejects(
    new ExecutionControls(request, () => ({
      ...source,
      contextId: "other",
    })).snapshot({ ...scope, approvalCursor: head.nextApprovalCursor }),
    /范围已变化/,
  );
  assert.equal(paths.length, before);
});
