import test from "node:test";
import assert from "node:assert/strict";
import { initialWorkspace } from "../packages/core/src/model.js";
import {
  executionPresentation,
  executionResultSummary,
} from "../apps/web/src/execution-presentation.js";

test("执行摘要显示真实动作和对象，不公开路由元数据或伪造完成结果", () => {
  const state = initialWorkspace();
  for (const tool of ["host_morphz", "host_morphz_work"]) {
    const name = tool;
    assert.deepEqual(
      executionPresentation(
        name,
        {
          action: "script",
          script: { action: "list", limit: 50 },
          _morphz_execution_route: { secret: "hidden" },
        },
        state,
      ),
      { title: "查看剧本列表", detail: "当前工作空间" },
    );
    assert.deepEqual(
      executionPresentation(
        name,
        {
          action: "script",
          script: {
            action: "command",
            command: { action: "create-production", title: "废火" },
          },
        },
        state,
      ),
      { title: "新建剧本", detail: "废火" },
    );
    assert.match(
      executionPresentation(
        name,
        {
          action: "script",
          script: {
            action: "command",
            command: {
              action: "create-item",
              kind: "episode",
              draft: { title: "第一集：废火破金甲", text: "不要复制整篇正文" },
            },
          },
        },
        state,
      ).detail,
      /^第一集/,
    );
    assert.deepEqual(
      executionPresentation(
        name,
        { action: "revise-document", title: "报告" },
        state,
      ),
      { title: "修改文档", detail: "报告" },
    );
  }
  assert.equal(
    executionPresentation("read", { path: "资料/说明.md" }, state).detail,
    "资料/说明.md",
  );
  assert.equal(
    executionPresentation(
      "exec",
      { command: "SECRET=abc command", cwd: "/workspace" },
      state,
    ).detail,
    "/workspace",
  );
  assert.equal(
    executionResultSummary('{"ok":true,"productions":[],"total":0}'),
    "找到 0 部剧本。",
  );
  assert.equal(
    executionResultSummary('{"ok":false,"error":"版本冲突"}'),
    "版本冲突",
  );
  assert.equal(executionResultSummary("unfinished output"), null);
});
