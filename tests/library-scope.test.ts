import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { workspaceFor } from "../apps/service/src/identity.js";
import { localAccess, type Command } from "../packages/core/src/model.js";
import { ObjectCollection } from "../apps/web/src/ObjectCollection.js";
import { contentSchema } from "../packages/core/src/model.js";

test("全部资料仅使用已授权快照，不展示其他 Principal 的空间和文档", () => {
  const store = new WorkspaceStore(":memory:");
  try {
    const execute = (operation: Command["operation"]) =>
      store.execute({ commandId: randomUUID(), operation }, localAccess);
    const privateSpace = execute({
      type: "create-project",
      title: "不可见的私有空间",
    }).entityId;
    execute({
      type: "create-artifact",
      projectId: privateSpace,
      title: "不可见的私有文档",
      content: { kind: "document", markdown: "私有正文不会进入资料列表" },
    });
    execute({
      type: "create-artifact",
      projectId: "first-project",
      title: "共享文档",
      content: { kind: "document", markdown: "可以阅读的共享正文" },
    });
    execute({
      type: "create-artifact",
      projectId: "first-project",
      title: "不进入内容目录的事项",
      content: contentSchema.parse({
        kind: "task",
        description: "只在事项视图中显示",
        assigneeId: "local-human",
        model: null,
        priority: "normal",
        dueDate: null,
        assignment: "accepted",
        execution: "planned",
        delivery: "none",
        resultIds: [],
      }),
    });
    const access = {
      principalId: "library-reader",
      actantId: "library-reader-human",
    };
    store.provisionMembers([
      {
        ...access,
        name: "资料读者",
        projectIds: ["first-project"],
        enabled: true,
      },
    ]);
    const authorized = workspaceFor(store.snapshot(), access);
    const html = renderToStaticMarkup(
      createElement(ObjectCollection, {
        project: authorized.projects.find((p) => p.id === "first-project")!,
        projects: authorized.projects,
        objects: authorized.artifacts,
        onOpen() {},
        onCreate() {},
        onWrite() {},
        onImport() {},
        importing: false,
        catalog: true,
      }),
    );
    assert.match(html, /全部工作空间/);
    assert.match(html, /共享文档/);
    assert.match(html, /可以阅读的共享正文/);
    assert.doesNotMatch(
      html,
      /不进入内容目录的事项|只在事项视图中显示|新建事项/,
    );
    assert.doesNotMatch(
      html,
      /不可见的私有空间|不可见的私有文档|私有正文不会进入资料列表/,
    );
  } finally {
    store.close();
  }
});
