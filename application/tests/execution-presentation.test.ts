import test from "node:test";
import assert from "node:assert/strict";
import { hostOperations } from "../packages/application/src/agent-tools.js";
import {
  artifactSchema,
  initialWorkspace,
} from "../packages/core/src/model.js";
import {
  executionPresentation,
  executionResultSummary,
  executionJobPresentation,
  liveToolPresentation,
} from "../apps/web/src/execution-presentation.js";

test("执行摘要显示真实动作和对象，不公开路由元数据或伪造完成结果", () => {
  const state = initialWorkspace();
  for (const tool of ["host_morphz"]) {
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

test("全部注册操作显示具体动作，不以内部路由或笼统操作充当摘要", () => {
  const state = initialWorkspace();
  const catalog = hostOperations.list();
  assert.ok(catalog.length >= 90);
  for (const operation of catalog) {
    const display = executionPresentation(
      "host_morphz",
      {
        action: "operations",
        operations: {
          action: "invoke",
          operationId: operation.id,
          parameters:
            operation.id === "files.directory"
              ? { directory: { operation: "list" } }
              : {},
        },
      },
      state,
    );
    assert.match(display.title, /[\u4e00-\u9fff]/, operation.id);
    assert.doesNotMatch(
      display.title,
      /工作对象|^操作|剧本 ·|operations|[a-z]+[.-][a-z]+/,
      operation.id,
    );
  }
});

function readingWorkspace() {
  const state = initialWorkspace();
  const author = { principalId: "reader", actantId: "reader" };
  const original = {
    revision: 1,
    title: "资治通鉴",
    author,
    createdAt: "2026-10-20T00:00:00Z",
    content: {
      kind: "publication",
      assetId: "a".repeat(64),
      format: "epub",
      author: "司马光",
      language: "zh",
      edition: "胡三省音注",
      sections: [
        {
          id: "section-17",
          title:
            "卷第十四【汉纪六】起阏逢困敦（甲子），尽重光协洽（辛未），凡八年。",
          characters: 17864,
        },
      ],
    },
  };
  state.artifacts.push(
    artifactSchema.parse({
      id: "book",
      projectId: "reading",
      title: "新版标题不可冒充旧版",
      revision: 2,
      content: {
        ...original.content,
        sections: [
          { id: "section-17", title: "新版章节不可冒充旧版", characters: 100 },
        ],
      },
      createdBy: author,
      createdAt: original.createdAt,
      updatedAt: original.createdAt,
      versions: [original],
    }),
  );
  return state;
}

test("operations 读取按真实版本、章节和请求范围展示，不需注解且不混淆连续两步", () => {
  const state = readingWorkspace();
  const request = (offset: number, limit: number, revision = 1) => ({
    action: "operations",
    _morphz_execution_route: { secret: "hidden" },
    operations: {
      action: "invoke",
      operationId: "reader.read",
      parameters: {
        artifactId: "book",
        revision,
        sectionId: "section-17",
        offset,
        limit,
      },
    },
  });
  assert.deepEqual(
    executionPresentation("host_morphz", request(8000, 8000), state),
    {
      title: "读取书籍原文",
      detail: "《资治通鉴》 · v1 · 卷第十四【汉纪六】 · 字符 8,001–16,000",
    },
  );
  assert.deepEqual(
    executionPresentation("host_morphz", request(15500, 4000), state),
    {
      title: "读取书籍原文",
      detail: "《资治通鉴》 · v1 · 卷第十四【汉纪六】 · 字符 15,501–17,864",
    },
  );
  assert.deepEqual(
    executionPresentation("host_morphz", request(0, 100, 3), state),
    {
      title: "读取书籍原文",
      detail: "book · v3 · section-17 · 字符 1–100",
    },
  );
  const job = {
    tool_name: "host_morphz",
    request: request(8000, 8000),
    result_event_id: "receipt",
  };
  assert.equal(executionJobPresentation(job as never, state).result, null);
  assert.equal(
    executionJobPresentation(
      {
        ...job,
        annotation: { intent: "核对贾谊上疏", result: "已取得原文" },
      } as never,
      state,
    ).title,
    "核对贾谊上疏",
  );
  assert.equal(
    liveToolPresentation(
      {
        name: "host_morphz",
        arguments: JSON.stringify(request(8000, 8000)),
        status: "running",
      } as never,
      state,
    ).title,
    "读取书籍原文",
  );
  assert.equal(JSON.stringify(request(0, 100)).includes("hidden"), true);
});

test("操作发现、目录、导入和其他注册领域不再泄漏 operations 路由名", () => {
  const state = readingWorkspace();
  const present = (operationId: string, parameters = {}) =>
    executionPresentation(
      "host_morphz",
      {
        action: "operations",
        operations: { action: "invoke", operationId, parameters },
      },
      state,
    );
  assert.deepEqual(
    present("reader.contents", { artifactId: "book", revision: 1 }),
    { title: "读取书籍目录", detail: "《资治通鉴》 · v1" },
  );
  assert.deepEqual(
    present("reader.import", {
      source: { kind: "workspace", path: "books/原文.epub" },
    }),
    { title: "导入书籍", detail: "books/原文.epub" },
  );
  assert.equal(present("reader.catalog").title, "查找书籍");
  assert.deepEqual(present("content.revise-document", { title: "报告" }), {
    title: "修改文档",
    detail: "报告",
  });
  assert.deepEqual(present("script.create-production", { title: "废火" }), {
    title: "新建剧本",
    detail: "废火",
  });
  assert.equal(
    present("applications.launch", { applicationId: "morphz.reader" }).title,
    "打开应用",
  );
  assert.equal(present("work-tasks.start").title, "请求执行事项");
  assert.equal(present("projects.list").title, "查看项目");
  assert.deepEqual(
    present("future.unknown", {
      token: "secret",
      title: "未经注册的参数不展示",
    }),
    { title: "future.unknown", detail: "" },
  );
  for (const action of ["list", "describe"]) {
    const result = executionPresentation(
      "host_morphz",
      {
        action: "operations",
        operations: { action, domain: "reader", operationId: "reader.read" },
      },
      state,
    );
    assert.equal(
      result.title,
      action === "list" ? "查找可用操作" : "查看操作说明",
    );
    assert.equal(result.detail, action === "list" ? "reader" : "reader.read");
  }
});
