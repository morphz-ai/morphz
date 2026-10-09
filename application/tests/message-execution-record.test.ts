import test from "node:test";
import assert from "node:assert/strict";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import { inputExecutionRecordStatus } from "../apps/web/src/message-execution-record.js";
import type { ActivityThread } from "../apps/web/src/execution-activity.js";

const input = {
  id: "input-one",
  projectId: "project-one",
  conversationId: "conversation-one",
};
const stamp = "2026-10-09T00:00:00Z";
function thread(overrides: Partial<ActivityThread> = {}): ActivityThread {
  return {
    ...input,
    id: "thread-one",
    inputId: input.id,
    kind: "execution",
    rootId: "root-one",
    sessionId: "session-one",
    lifecycle: "completed",
    phase: "idle",
    title: "原活动",
    revision: 2,
    updatedAt: stamp,
    ...overrides,
  };
}
function runtime(threads: ActivityThread[], connected = true) {
  return {
    ...disconnectedRuntime,
    connected,
    activity: { available: connected, truncated: true, threads },
  };
}
test("结束／失败／取消的真实执行记录离线仍可辨认；completed 不冒充成功", () => {
  for (const [lifecycle, kind, label] of [
    ["completed", "ended", "已结束"],
    ["failed", "failed", "执行失败"],
    ["cancelled", "cancelled", "已取消"],
  ]) {
    for (const connected of [true, false])
      for (const online of [true, false])
        assert.deepEqual(
          inputExecutionRecordStatus(
            runtime([thread({ lifecycle })], connected),
            input,
            online,
          ),
          { kind, label },
        );
  }
});
test("仅有精确 input、project、conversation 与已声明 execution 身份才显示", () => {
  for (const value of [
    thread({ inputId: "another-input" }),
    thread({ projectId: "foreign" }),
    thread({ conversationId: "foreign" }),
    thread({ inputId: null }),
    thread({ kind: "dialogue_turn" }),
    thread({ kind: "delivery" }),
    thread({ kind: undefined }),
  ])
    assert.equal(
      inputExecutionRecordStatus(runtime([value]), input, true),
      undefined,
    );
  assert.equal(inputExecutionRecordStatus(runtime([]), input, true), undefined);
  assert.equal(
    inputExecutionRecordStatus(runtime([thread()]), null, true),
    undefined,
  );
  assert.equal(
    inputExecutionRecordStatus(
      {
        ...runtime([]),
        deliveries: [
          {
            inputId: input.id,
            state: "completed",
            retryable: false,
            error: null,
          },
        ],
      },
      input,
      true,
    ),
    undefined,
  );
});
test("多分支优先开放工作；断线／未知状态不冒充已结束，失败及取消不被正常结束掩盖", () => {
  assert.equal(
    inputExecutionRecordStatus(
      runtime([
        thread(),
        thread({ id: "child", lifecycle: "open", phase: "running" }),
      ]),
      input,
      true,
    )?.kind,
    "running",
  );
  assert.equal(
    inputExecutionRecordStatus(
      runtime([thread({ lifecycle: "open", phase: "running" })], false),
      input,
      true,
    )?.kind,
    "unknown",
  );
  for (const [lifecycle, kind] of [
    ["failed", "failed"],
    ["cancelled", "cancelled"],
    ["future-state", "unknown"],
  ])
    assert.equal(
      inputExecutionRecordStatus(
        runtime([thread(), thread({ id: "child", lifecycle })]),
        input,
        true,
      )?.kind,
      kind,
    );
});
test("重连乱序采用同一 Thread 最新 revision；纯投影不修改权威快照", () => {
  const rt = runtime([
    thread({ lifecycle: "open", phase: "running", revision: 1 }),
    thread(),
  ]);
  const before = structuredClone(rt);
  for (const t of rt.activity.threads) Object.freeze(t);
  Object.freeze(rt.activity.threads);
  Object.freeze(rt.activity);
  Object.freeze(rt);
  assert.equal(inputExecutionRecordStatus(rt, input, true)?.kind, "ended");
  assert.deepEqual(rt, before);
});

test("同 revision 的乱序快照按真实时刻比较，不按时区字符串误选旧运行态", () => {
  const older = thread({
    lifecycle: "open",
    phase: "running",
    updatedAt: "2026-10-09T10:00:00+08:00",
  });
  const newer = thread({ updatedAt: "2026-10-09T03:00:00Z" });
  for (const threads of [
    [older, newer],
    [newer, older],
  ])
    assert.equal(
      inputExecutionRecordStatus(runtime(threads), input, true)?.kind,
      "ended",
    );
});
