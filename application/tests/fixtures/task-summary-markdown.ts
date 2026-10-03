import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskSummary } from "../../apps/web/src/TaskSummary.js";
import { SafeMarkdown } from "../../apps/web/src/SafeMarkdown.js";
import {
  artifactSchema,
  initialWorkspace,
  taskContentSchema,
} from "../../packages/core/src/model.js";

const now = "2026-10-03T00:00:00.000Z";
const wide = [
  "| 项目 | 来源 | 内容 | 范围 | 结果 | 回执 | 日期 | 版本 |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  `| ${Array.from({ length: 8 }, (_, index) => `${index + 1}-${"WideCell".repeat(16)}`).join(" | ")} |`,
].join("\n");

function task(markdown: string, id: string) {
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
    id,
    projectId: "first-project",
    title: "TEST Markdown",
    revision: 1,
    content,
    createdBy: author,
    createdAt: now,
    updatedAt: now,
    versions: [
      { revision: 1, title: "TEST Markdown", content, author, createdAt: now },
    ],
  });
  state.artifacts.push(artifact);
  return createElement(TaskSummary, {
    value: content,
    artifact,
    state,
    revision: 1,
    onOpen() {
      throw new Error("This isolated reading fixture must not navigate");
    },
  });
}

// Synthetic rendering only; the Playwright harness serves this markup with the
// original CSS. No WorkspaceClient, Session, provider or external media is used.
process.stdout.write(
  renderToStaticMarkup(
    createElement(
      "main",
      {
        className: "app",
        "data-appearance": "light",
        style: {
          display: "block",
          height: "auto",
          minHeight: "100vh",
          overflow: "visible",
          padding: 16,
        },
      },
      ...(
        [
          ["task-wide", wide],
          ["task-ordinary", "| 项 | 状 |\n| --- | --- |\n| 甲 | 好 |"],
          ["task-checklist", "- [x] 已核对\n- [ ] 仍待验证"],
        ] as const
      ).map(([id, markdown]) =>
        createElement(
          "section",
          { key: id, "aria-label": id, className: "object-paper task-paper" },
          task(markdown, id),
        ),
      ),
      createElement(
        "section",
        { "aria-label": "shared-wide", className: "reply-content" },
        createElement(SafeMarkdown, {
          state: initialWorkspace(now),
          onOpen() {},
          children: wide,
        }),
      ),
    ),
  ),
);
