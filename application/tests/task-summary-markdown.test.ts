import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseFragment, serialize, type DefaultTreeAdapterTypes } from "parse5";
import { TaskSummary } from "../apps/web/src/TaskSummary.js";
import { SafeMarkdown } from "../apps/web/src/SafeMarkdown.js";
import { MarkdownTable } from "../apps/web/src/MarkdownTable.js";
import {
  artifactSchema,
  initialWorkspace,
  taskContentSchema,
} from "../packages/core/src/model.js";

const now = "2026-10-03T00:00:00.000Z";

function taskDescription(markdown: string) {
  const state = initialWorkspace(now);
  const content = taskContentSchema.parse({
    kind: "task",
    description: markdown,
    assigneeId: "local-human",
    model: null,
    dueDate: null,
    assignment: "accepted",
    execution: "planned",
    delivery: "none",
    resultIds: [],
  });
  const author = { principalId: "local-owner", actantId: "local-human" };
  const artifact = artifactSchema.parse({
    id: "markdown-task",
    projectId: "first-project",
    title: "TEST 事项 Markdown",
    revision: 1,
    content,
    createdBy: author,
    createdAt: now,
    updatedAt: now,
    versions: [
      {
        revision: 1,
        title: "TEST 事项 Markdown",
        content,
        author,
        createdAt: now,
      },
    ],
  });
  state.artifacts.push(artifact);
  const before = structuredClone(state);
  const html = renderToStaticMarkup(
    createElement(TaskSummary, {
      value: content,
      artifact,
      state,
      revision: 1,
      onOpen() {
        assert.fail("SSR must not navigate or open content");
      },
    }),
  );
  assert.deepEqual(
    state,
    before,
    "Rendering must not mutate the task or its versions",
  );
  assert.equal(content.description, markdown);
  const findDescription = (
    node: DefaultTreeAdapterTypes.Node,
  ): DefaultTreeAdapterTypes.Element | undefined => {
    if (
      "attrs" in node &&
      node.attrs.some(
        (attr) => attr.name === "aria-label" && attr.value === "事项说明",
      )
    )
      return node;
    if ("childNodes" in node)
      for (const child of node.childNodes) {
        const found = findDescription(child);
        if (found) return found;
      }
    return undefined;
  };
  const description = findDescription(parseFragment(html));
  assert.ok(
    description,
    "Use the real TaskSummary description, not its properties or metadata",
  );
  return serialize(description);
}

function sharedDescription(markdown: string) {
  return renderToStaticMarkup(
    createElement(SafeMarkdown, {
      children: markdown,
      state: initialWorkspace(now),
      onOpen() {
        assert.fail("SSR must not navigate or open content");
      },
    }),
  );
}

test("actual TaskSummary parses GFM tables like chat/document Markdown", () => {
  const source =
    "| 项目 | 状态 |\n| --- | --- |\n| 检查 | 完成 |\n| 验证 | 待处理 |";
  const reference = sharedDescription(source);
  assert.match(reference, /<table>/);
  const actual = taskDescription(source);
  assert.match(
    actual,
    /<div class="markdown-table-scroll" role="region" aria-label="表格" tabindex="0"><table>/,
  );
  assert.match(actual, /<table>/);
  assert.equal((actual.match(/<tr>/g) ?? []).length, 3);
  assert.match(actual, /<td>待处理<\/td>/);
  assert.doesNotMatch(actual, /\| 项目 \|/);
  // Both real renderers use the same keyboard-accessible bounded region.
  assert.equal(actual, serialize(parseFragment(reference)));
});

test("shared Markdown table keeps the original accessible wrapper and cell content", () => {
  const actual = renderToStaticMarkup(
    createElement(
      MarkdownTable,
      null,
      createElement(
        "tbody",
        null,
        createElement("tr", null, createElement("td", null, "宽表正文")),
      ),
    ),
  );
  assert.equal(
    serialize(parseFragment(actual)),
    '<div class="markdown-table-scroll" role="region" aria-label="表格" tabindex="0"><table><tbody><tr><td>宽表正文</td></tr></tbody></table></div>',
  );
});

test("actual TaskSummary parses GFM task lists without making task state editable", () => {
  const source = "- [x] 已核对\n- [ ] 仍待验证";
  assert.equal(
    (sharedDescription(source).match(/type="checkbox"/g) ?? []).length,
    2,
  );
  const actual = taskDescription(source);
  const boxes = actual.match(/<input[^>]*>/g) ?? [];
  assert.equal(boxes.length, 2);
  assert.ok(
    boxes.every(
      (box) => /type="checkbox"/.test(box) && /disabled=""/.test(box),
    ),
  );
  assert.equal(boxes.filter((box) => /checked=""/.test(box)).length, 1);
  assert.doesNotMatch(actual, /\[x\]|\[ \]/);
});

test("actual TaskSummary parses CJK punctuation emphasis like chat/document Markdown", () => {
  const source =
    "是的，截图里**「截图输入」弹窗和灰色遮罩挡住了 PDF**，同时继续。\n\n当天 **上午 9:30（北京时间）**在本会话提醒。";
  for (const render of [sharedDescription, taskDescription]) {
    const actual = render(source);
    assert.match(
      actual,
      /<strong>「截图输入」弹窗和灰色遮罩挡住了 PDF<\/strong>/,
    );
    assert.match(actual, /<strong>上午 9:30（北京时间）<\/strong>/);
    assert.doesNotMatch(actual, /\*\*/);
  }
});

test("actual TaskSummary preserves soft/hard breaks and literal code without changing source", () => {
  for (const newline of ["\n", "\r\n", "\r"]) {
    const source = ["第一行", "第二行", "第三行"].join(newline);
    assert.equal(taskDescription(source), "<p>第一行<br>第二行<br>第三行</p>");
  }
  assert.equal(taskDescription("A  \nB\nC"), "<p>A<br>B<br>C</p>");
  const source =
    "`中文**「原样」**保留`\n\n```txt\n- [x] 原样代码\n    下一行\n```";
  const actual = taskDescription(source);
  assert.match(actual, /<code>中文\*\*「原样」\*\*保留<\/code>/);
  assert.match(
    actual,
    /<pre><code class="language-txt">- \[x\] 原样代码\n    下一行\n<\/code><\/pre>/,
  );
  assert.doesNotMatch(actual, /<input/);
});

test("actual TaskSummary retains inert links, image placeholders and skipped HTML", () => {
  const source = [
    "[外部地址](https://example.invalid/path)",
    "<https://example.invalid/autolink>",
    "GFM 裸地址 https://example.invalid/bare 与 test@example.invalid",
    "[对象](morphz://artifact/hidden)",
    "[危险地址](javascript:alert(1))",
    "![远程图片](https://example.invalid/private.png)",
    "<script>window.TEST_SCRIPT_EXECUTED = true</script>",
    '<iframe src="https://example.invalid/frame"></iframe>',
  ].join("\n\n");
  const actual = taskDescription(source);
  assert.match(actual, /<span>外部地址<\/span>/);
  assert.match(actual, /<span>https:\/\/example.invalid\/autolink<\/span>/);
  assert.match(actual, /<span>https:\/\/example.invalid\/bare<\/span>/);
  assert.match(actual, /<span>test@example.invalid<\/span>/);
  assert.match(actual, /<span>对象<\/span>/);
  assert.match(actual, /<span>危险地址<\/span>/);
  assert.match(actual, /\[图片：远程图片\]/);
  assert.doesNotMatch(
    actual,
    /<(?:a|img|script|iframe|button)\b|href=|src=|TEST_SCRIPT_EXECUTED/,
  );
});
