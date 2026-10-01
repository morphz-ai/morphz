import test from "node:test";
import assert from "node:assert/strict";
import {
  activitySchema,
  runtimeScheduleSchema,
} from "../packages/core/src/conversation.js";
import {
  runtimeArrangements,
  runtimeArrangementLabel,
} from "../apps/web/src/subject-schedules-model.js";

const schedule = (id = "schedule-1") =>
  runtimeScheduleSchema.parse({
    scheduleId: id,
    threadId: "thread-1",
    sessionId: "session-1",
    contextId: "context-1",
    rootId: "scheduled-root",
    inputId: "input-1",
    sourceTurnId: "human-root",
    sourceRootId: "human-root",
    projectId: "project-1",
    conversationId: "conversation-1",
    status: "queued",
    revision: 1,
    notBefore: "2026-10-03T05:30:00.000Z",
    intervalSeconds: null,
    dependencyThreadIds: [],
    intent: "TEST 未来提醒",
    updatedAt: "2026-10-01T12:00:00.000Z",
  });
const activity = () =>
  activitySchema.parse({
    available: true,
    truncated: false,
    schedulesAvailable: true,
    schedulesTruncated: false,
    schedules: [schedule()],
    threads: [],
  });

test("无Task的真实未来安排显示等待及准确时间，不标正在执行", () => {
  const rows = runtimeArrangements(activity(), true, new Set());
  assert.equal(rows.length, 1);
  const label = runtimeArrangementLabel(rows[0]!);
  assert.match(label, /等待触发/);
  assert.match(label, /2026/);
  assert.doesNotMatch(label, /正在执行|进行中/);
});
test("只按确切scheduleId与平台去重，不能按Thread或同名标题去掉不同安排", () => {
  const value = activity();
  value.schedules!.push(schedule("second-id"), { ...schedule(), revision: 2 });
  assert.deepEqual(
    runtimeArrangements(value, true, new Set(["schedule-1"])).map(
      (row) => row.scheduleId,
    ),
    ["second-id"],
  );
  const rows = runtimeArrangements(value, true, new Set());
  assert.equal(rows.length, 2);
  assert.equal(
    rows.find((row) => row.scheduleId === "schedule-1")?.revision,
    2,
  );
});
test("断线和读取失败不把缓存安排当新鲜；终态不作为未来安排", () => {
  assert.deepEqual(runtimeArrangements(activity(), false, new Set()), []);
  assert.deepEqual(
    runtimeArrangements({ ...activity(), available: false }, true, new Set()),
    [],
  );
  assert.deepEqual(
    runtimeArrangements(
      { ...activity(), schedulesAvailable: false },
      true,
      new Set(),
    ),
    [],
  );
  const value = activity();
  value.schedules![0]!.status = "cancelled";
  assert.deepEqual(runtimeArrangements(value, true, new Set()), []);
});
test("暂停、依赖和真实重复间隔保留，不四舍五入秒数或猜下一次触发", () => {
  assert.match(
    runtimeArrangementLabel({ ...schedule(), status: "paused" }),
    /已暂停/,
  );
  assert.match(
    runtimeArrangementLabel({
      ...schedule(),
      dependencyThreadIds: ["dependency"],
    }),
    /等待前置工作/,
  );
  const label = runtimeArrangementLabel({ ...schedule(), intervalSeconds: 90 });
  assert.match(label, /每 90 秒/);
  assert.doesNotMatch(label, /下一次|进行中/);
});
