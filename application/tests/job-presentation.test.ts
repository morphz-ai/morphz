import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  initialWorkspace,
  type Workspace,
} from "../packages/core/src/model.js";
import {
  jobSchema,
  type ExecutionSnapshot,
} from "../packages/core/src/execution.js";
import type { LiveMessage } from "../packages/core/src/live-conversation.js";
import {
  liveToolPresentation,
  executionSnapshotJobPresentation,
  executionJobPresentation,
  executionResultSummary,
} from "../apps/web/src/execution-presentation.js";
import {
  fixedJobMetadata,
  fixedJobSources,
  fixedLiveToolPresentation,
  fixedSnapshotJobPresentation,
} from "./fixtures/job-presentation-08215636-behavior.js";

const migration =
  process.env.MORPHZ_TEST_JOB_PRESENTATION_MIGRATION_EQUIVALENCE === "1";
const stamp = "2026-10-04T00:00:00.000Z";
type Tool = NonNullable<LiveMessage["tool"]>;
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const state = freeze(initialWorkspace(stamp));
const live = (tool: Tool, workspace: Workspace = state) => {
  const before = structuredClone(tool),
    result = liveToolPresentation(freeze(tool), workspace);
  if (migration)
    assert.deepEqual(result, fixedLiveToolPresentation(tool, workspace));
  assert.deepEqual(tool, before, "presentation does not mutate live source");
  return result;
};
function job(overrides: Partial<ExecutionSnapshot["jobs"][number]> = {}) {
  return freeze(
    jobSchema.parse({
      id: "job-original",
      revision: 2,
      session_id: "session-original",
      context_id: "context-original",
      thread_id: "thread-original",
      tool_name: "read",
      target_id: "local",
      request: { path: "README-original.md" },
      status: "running",
      created_at: stamp,
      updated_at: stamp,
      ...overrides,
    }),
  );
}
const snapshot = (
  value: ReturnType<typeof job>,
  workspace: Workspace = state,
) => {
  const before = structuredClone(value),
    result = executionSnapshotJobPresentation(value, workspace);
  if (migration)
    assert.deepEqual(result, fixedSnapshotJobPresentation(value, workspace));
  assert.deepEqual(
    value,
    before,
    "presentation does not mutate typed Job facts",
  );
  return result;
};

test("independent original Job archive has immutable source/span provenance without current neighbor locks", () => {
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  assert.equal(
    fixedJobMetadata.git,
    "0821563681516b78f63e2d79d1fc79bb782bb07d",
  );
  assert.equal(
    sha(fixedJobSources.pure),
    fixedJobMetadata.sources["execution-presentation.ts"].sha256,
  );
  for (const name of [
    "ToolMessage",
    "ExecutionDialog",
    "liveBody",
    "snapshotStatus",
    "jobRow",
  ] as const)
    assert.equal(
      sha(fixedJobSources[name]),
      fixedJobMetadata.spans[name].sha256,
      name,
    );
});

test("live twelve states and unknown/lost keep their own vocabulary rather than snapshot status meanings", () => {
  for (const [status, statusLabel] of Object.entries({
    generating: "正在生成参数",
    pending: "参数已生成",
    running: "执行中",
    queued: "排队中",
    waiting_approval: "等待审批",
    approval_required: "等待审批",
    success: "已完成",
    succeeded: "已完成",
    completed: "已完成",
    failed: "失败",
    error: "失败",
    cancelled: "已取消",
    lost: "lost",
    "future-runtime-phase": "future-runtime-phase",
    "": "",
  })) {
    assert.deepEqual(
      live({ name: "read", arguments: '{"path":"原件.md"}', status }),
      { title: "读取文件", detail: "原件.md", statusLabel },
    );
  }
});

test("live complete JSON/catch preserves partial, malformed and valid primitive distinctions and empty title", () => {
  for (const argumentsValue of ["", "{", '{"path":', "not JSON", "undefined"])
    assert.deepEqual(
      live({ name: "", arguments: argumentsValue, status: "generating" }),
      { title: "", detail: undefined, statusLabel: "正在生成参数" },
    );
  for (const argumentsValue of ["null", "false", "0", '"text"', "[]", "{}"])
    assert.deepEqual(
      live({ name: "read", arguments: argumentsValue, status: "pending" }),
      { title: "读取文件", detail: "", statusLabel: "参数已生成" },
    );
  assert.deepEqual(
    live({
      name: "read",
      arguments: '{"path":"  a\\n b  "}',
      status: "running",
    }),
    { title: "读取文件", detail: "a b", statusLabel: "执行中" },
  );
  // The original catch encloses parsing AND request presentation, not only JSON.parse.
  const throwing = new Proxy(state, {
    get(target, key) {
      if (key === "artifacts") throw new Error("original state read failed");
      return Reflect.get(target, key);
    },
  });
  assert.deepEqual(
    live(
      {
        name: "host_morphz",
        arguments: '{"action":"read"}',
        status: "running",
      },
      throwing,
    ),
    { title: "host_morphz", detail: undefined, statusLabel: "执行中" },
  );
});

test("original object/script and legacy tools preserve allowlisted detail limits and never summarize secrets or claimed outcomes", () => {
  for (const name of ["host_morphz", "host_morphz_work"]) {
    assert.deepEqual(
      live({
        name,
        arguments:
          '{"action":"script","script":{"action":"list"},"secret":"hidden","_morphz_execution_route":{"password":"hidden"}}',
        status: "running",
      }),
      { title: "查看剧本列表", detail: "当前工作空间", statusLabel: "执行中" },
    );
    assert.deepEqual(
      live({
        name,
        arguments: JSON.stringify({
          action: "script",
          script: {
            action: "command",
            command: {
              action: "create-item",
              kind: "episode",
              draft: { title: "原第一集", text: "not-a-summary" },
            },
          },
        }),
        status: "queued",
      }),
      { title: "新建分集", detail: "原第一集", statusLabel: "排队中" },
    );
    assert.deepEqual(
      live({
        name,
        arguments:
          '{"action":"revise-document","title":"原报告","annotation":{"intent":"fake title","result":"fake receipt"}}',
        status: "running",
      }),
      { title: "修改文档", detail: "原报告", statusLabel: "执行中" },
    );
  }
  const command = live({
    name: "exec_command",
    arguments: JSON.stringify({
      command: "SECRET=do-not-display shell",
      cwd: "/original-directory",
      secret: "hidden",
    }),
    status: "completed",
    result: '{"ok":false,"error":"original conflict"}',
  });
  assert.equal(command.detail, "/original-directory");
  assert.equal(command.title, "执行命令");
  assert.equal(
    Object.hasOwn(command, "result"),
    false,
    "raw live return does not become snapshot result prose",
  );
  assert.equal(
    live({
      name: "grep",
      arguments: JSON.stringify({ query: "a".repeat(200) }),
      status: "running",
    }).detail?.length,
    160,
  );
});

test("snapshot seven states × stop requests preserve active-only stopping priority and original typed fields", () => {
  const labels = {
    queued: "排队中",
    waiting_approval: "等待批准",
    running: "执行中",
    succeeded: "已完成",
    failed: "失败",
    cancelled: "已取消",
    lost: "需核对结果",
  } as const;
  for (const [status, ordinary] of Object.entries(labels) as [
    keyof typeof labels,
    string,
  ][])
    for (const cancel of [null, "", stamp]) {
      const input = job({ status, cancel_requested_at: cancel });
      const result = snapshot(input);
      assert.deepEqual(result, {
        title: "读取文件",
        detail: "README-original.md",
        result: null,
        statusLabel:
          cancel && ["queued", "waiting_approval", "running"].includes(status)
            ? "正在停止"
            : ordinary,
      });
      assert.deepEqual(
        executionJobPresentation(input, state),
        { title: "读取文件", detail: "README-original.md", result: null },
        "original export shape is not enlarged",
      );
    }
});

test("snapshot intent/result are typed exact-job metadata and result requires this Job's receipt", () => {
  for (const result_event_id of [null, "", "receipt-original"])
    for (const annotation of [
      undefined,
      { intent: "  ", result: "  " },
      { intent: " 原意图 ", result: " 原回执说明 " },
    ]) {
      const current = job({
        annotation,
        result_event_id,
        status: "failed",
        error: "原权限失败",
      });
      const result = snapshot(current);
      assert.equal(result.title, annotation?.intent.trim() || "读取文件");
      assert.equal(
        result.result,
        result_event_id ? annotation?.result.trim() || null : null,
      );
      assert.equal(
        result.statusLabel,
        "失败",
        "annotation does not override Runtime outcome",
      );
      assert.equal(current.error, "原权限失败");
    }
  assert.deepEqual(
    snapshot(
      job({
        request: {
          path: "original.md",
          annotation: { intent: "fake", result: "neighbor receipt" },
          _morphz_annotation: { intent: "fake" },
        },
        result_event_id: "real-receipt",
      }),
    ),
    {
      title: "读取文件",
      detail: "original.md",
      result: null,
      statusLabel: "执行中",
    },
  );
});

test("snapshot does not gain the live catch or confuse successful invocation with successful domain envelope", () => {
  const throwing = new Proxy(state, {
    get(target, key) {
      if (key === "artifacts") throw new Error("original state read failed");
      return Reflect.get(target, key);
    },
  });
  const input = job({ tool_name: "host_morphz", request: { action: "read" } });
  assert.throws(
    () => executionSnapshotJobPresentation(input, throwing),
    /original state read failed/,
  );
  if (migration)
    assert.throws(
      () => fixedSnapshotJobPresentation(input, throwing),
      /original state read failed/,
    );
  for (const value of ["", "null", "true", "{}", "{", '{"ok":"true"}'])
    assert.equal(executionResultSummary(value), null);
  assert.equal(
    executionResultSummary('{"ok":false,"error":"原版本冲突"}'),
    "原版本冲突",
  );
  assert.equal(
    executionResultSummary('{"ok":false}'),
    "操作未成功，请查看返回详情。",
  );
  assert.equal(
    executionResultSummary('{"ok":true,"receipt":{"entityId":"original"}}'),
    "已保存，操作回执已确认。",
  );
});
