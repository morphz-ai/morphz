import test from "node:test";
import assert from "node:assert/strict";
import { projectDisplayLabel } from "../apps/web/src/project-display-label.js";

test("desk 只在显示层称为无项目，不改持久标题或依赖旧标题拼写", () => {
  for (const title of ["未归项目", "旧工作台名", "已持久化的任意标题"]) {
    const project = Object.freeze({ kind: "desk" as const, title });
    assert.equal(projectDisplayLabel(project), "无项目");
    assert.equal(project.title, title);
  }
});

test("真实项目和历史无 kind 项目保留原名，恰好叫未归项目也不误改", () => {
  for (const title of ["TEST 真实项目", "未归项目", "  保留原始标题  "]) {
    assert.equal(projectDisplayLabel({ kind: "project", title }), title);
    assert.equal(projectDisplayLabel({ title }), title);
  }
});

test("事项与对话空间保留各自标题，缺失来源由调用处决定 fallback", () => {
  assert.equal(projectDisplayLabel({ kind: "inbox", title: "事项" }), "事项");
  assert.equal(
    projectDisplayLabel({ kind: "dialogue", title: "对话" }),
    "对话",
  );
  assert.equal(projectDisplayLabel(undefined), undefined);
  assert.equal(projectDisplayLabel(undefined) ?? "无项目", "无项目");
});
