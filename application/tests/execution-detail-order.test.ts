import test from "node:test";
import assert from "node:assert/strict";
import { jobSchema } from "../packages/core/src/execution.js";
import { ExecutionControls } from "../packages/application/src/execution.js";
import { executionJobsInReadingOrder } from "../apps/web/src/execution-presentation.js";

function job(id: string, createdAt: string, updatedAt = createdAt) {
  return jobSchema.parse({
    id,
    revision: 2,
    session_id: "TEST-session",
    context_id: "TEST-context",
    tool_name: "read",
    target_id: "local",
    thread_id: "TEST-thread",
    status: "succeeded",
    created_at: createdAt,
    updated_at: updatedAt,
    request: { path: "TEST-readme.md" },
  });
}

test("工具步骤按实际创建时刻升序，后完成或重试的早期步骤不被移到末尾", () => {
  const first = job(
    "TEST-first",
    "2026-10-02T12:00:01Z",
    "2026-10-02T12:59:00Z",
  );
  const second = job("TEST-second", "2026-10-02T12:00:02Z");
  const third = job("TEST-third", "2026-10-02T12:00:03Z");
  const source = [third, first, second];
  assert.deepEqual(
    executionJobsInReadingOrder(source).map(({ id }) => id),
    [first.id, second.id, third.id],
  );
  assert.deepEqual(source, [third, first, second]);
  assert.equal(executionJobsInReadingOrder(source)[0], first);
});

test("时区不同的时间字符串按真实时刻比较，不能靠字符串字典序", () => {
  const first = job("TEST-first", "2026-10-02T20:00:01+08:00");
  const later = job("TEST-later", "2026-10-02T13:00:00Z");
  assert.deepEqual(
    executionJobsInReadingOrder([later, first]).map(({ id }) => id),
    [first.id, later.id],
  );
});

test("Runtime纳秒创建时刻不被Date.parse的毫秒精度压成倒序ties", () => {
  const first = job("TEST-z-first", "2026-10-02T12:00:00.123456001Z");
  const next = job("TEST-a-next", "2026-10-02T20:00:00.123456002+08:00");
  assert.equal(Date.parse(first.created_at), Date.parse(next.created_at));
  assert.deepEqual(
    executionJobsInReadingOrder([next, first]).map(({ id }) => id),
    [first.id, next.id],
  );
});

test("完全同刻的并行步骤按不可变Job ID稳定，不因刷新返回数组换序", () => {
  const a = job("TEST-a", "2026-10-02T12:00:00.123456000Z");
  const b = job("TEST-b", "2026-10-02T20:00:00.123456+08:00");
  const expected = [a.id, b.id];
  for (const source of [
    [b, a],
    [a, b],
  ])
    assert.deepEqual(
      executionJobsInReadingOrder(source).map(({ id }) => id),
      expected,
    );
});

test("未知创建时间不伪造时刻，留在已知步骤后并保持确定顺序", () => {
  const actual = job("TEST-known", "2026-10-02T12:00:00Z");
  const a = job("TEST-a-unknown", "unknown");
  const b = job("TEST-b-unknown", "");
  assert.deepEqual(
    executionJobsInReadingOrder([b, actual, a]).map(({ id }) => id),
    [actual.id, a.id, b.id],
  );
});

test("真实Platform读取继续请求newest_first，只把返回的最近窗口改成顺序阅读", async () => {
  const recent = Array.from({ length: 103 }, (_, index) =>
    job(
      `TEST-${String(index).padStart(3, "0")}`,
      new Date(Date.UTC(2026, 9, 2, 12, 0, index)).toISOString(),
    ),
  ).reverse();
  let reads = 0;
  const controls = new ExecutionControls(
    async (path) => {
      if (path === "/api/approvals") return { approvals: [] };
      const query = new URL(path, "http://TEST-runtime").searchParams;
      assert.equal(query.get("newest_first"), "true");
      assert.equal(query.get("limit"), "100");
      reads++;
      return { jobs: recent };
    },
    () => ({ sessionId: "TEST-session", contextId: "TEST-context" }),
  );
  const snapshot = await controls.snapshot({
    projectId: "TEST-project",
    artifactId: null,
  });
  assert.equal(reads, 1);
  assert.equal(snapshot.limit, 100);
  assert.equal(snapshot.jobs.length, 100);
  assert.equal(snapshot.jobs[0]!.id, "TEST-102");
  const ordered = executionJobsInReadingOrder(snapshot.jobs);
  assert.equal(ordered[0]!.id, "TEST-003");
  assert.equal(ordered.at(-1)!.id, "TEST-102");
  assert.equal(
    ordered.some(({ id }) => id === "TEST-000"),
    false,
  );
});
