import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceStore } from "../packages/application/src/store.js";
import {
  AgentTools,
  workToolDefinitions,
} from "../packages/application/src/agent-tools.js";
import { workspaceFor } from "../packages/application/src/identity.js";
import {
  applyCommand,
  initialWorkspace,
  localAccess,
  type Operation,
} from "../packages/core/src/model.js";
import { findBookmarks } from "../packages/core/src/bookmarks.js";

const agent = { principalId: "morphz-service", actantId: "morphz-agent" };
const route = {
  job_id: "bookmark-job",
  tool_call_id: "bookmark-call",
  session_id: "s",
  context_id: "c",
  principal_id: "untrusted",
  agent_id: "a",
  target_id: "local",
  thread_id: "t",
};
function input(store: WorkspaceStore) {
  return store.execute(
    {
      commandId: randomUUID(),
      operation: {
        type: "record-input",
        projectId: "first-project",
        artifactId: null,
        artifactRevision: null,
        selection: "",
        body: "收藏这个网址 https://example.com/",
        targetActantId: agent.actantId,
      },
    },
    localAccess,
  ).entityId;
}

test("浏览器收藏独立保存：规范化去重、版本冲突、删除撤销和重开，不生成内容或索引", () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-bookmarks-"));
  const filename = join(directory, "workspace.sqlite");
  let store = new WorkspaceStore(filename);
  const execute = (operation: Operation) =>
    store.execute({ commandId: randomUUID(), operation }, localAccess);
  try {
    const command = {
      commandId: randomUUID(),
      operation: {
        type: "bookmark-add",
        title: "示例",
        url: "https://EXAMPLE.com",
      },
    };
    const receipt = store.execute(command, localAccess);
    assert.deepEqual(store.execute(command, localAccess), receipt);
    assert.equal(
      execute({
        type: "bookmark-add",
        title: "不会覆盖名称",
        url: "https://example.com/",
      }).entityId,
      receipt.entityId,
    );
    assert.equal(store.snapshot().bookmarks.length, 1);
    assert.equal(store.snapshot().bookmarks[0]!.title, "示例");
    execute({
      type: "bookmark-update",
      bookmarkId: receipt.entityId,
      expectedRevision: 1,
      title: "新名称",
      url: "https://example.com/path#section",
    });
    assert.throws(
      () =>
        execute({
          type: "bookmark-remove",
          bookmarkId: receipt.entityId,
          expectedRevision: 1,
        }),
      /已被修改/,
    );
    execute({
      type: "bookmark-remove",
      bookmarkId: receipt.entityId,
      expectedRevision: 2,
    });
    assert.equal(findBookmarks(store.snapshot().bookmarks).length, 0);
    execute({
      type: "bookmark-restore",
      bookmarkId: receipt.entityId,
      expectedRevision: 3,
    });
    assert.equal(
      findBookmarks(store.snapshot().bookmarks, "新名称 section").length,
      1,
    );
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://u:p@example.com/",
    ])
      assert.throws(() =>
        execute({ type: "bookmark-add", title: "无效", url }),
      );
    assert.equal(store.snapshot().artifacts.length, 0);
    assert.equal(store.snapshot().inputs.length, 0);
    assert.equal(store.search({ query: "新名称" }, localAccess).total, 0);
    const saved = store.snapshot().bookmarks;
    store.close();
    store = new WorkspaceStore(filename);
    assert.deepEqual(store.snapshot().bookmarks, saved);
    assert.deepEqual(store.execute(command, localAccess), receipt);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("智能体通过真实输入管理用户的同一收藏，两个 Host 均可用且不需要浏览器授权", () => {
  const store = new WorkspaceStore(":memory:");
  try {
    const inputId = input(store);
    const scope = { projectId: "first-project", access: agent, inputId };
    const tools = new AgentTools(store, "token", () => scope);
    function call(
      bookmarks: unknown,
      tool = "host_morphz",
      tool_call_id: string = randomUUID(),
    ) {
      return tools.call({
        protocol: 1,
        tool,
        invocation: { ...route, tool_call_id },
        arguments: { action: "bookmarks", bookmarks },
      }) as any;
    }
    for (const definition of workToolDefinitions) {
      assert.ok(
        (definition.parameters as any).properties.action.enum.includes(
          "bookmarks",
        ),
      );
      assert.match(definition.description, /initiating human/);
    }
    const added = call(
      { action: "add", title: "智能体收藏", url: "https://example.com" },
      "host_morphz",
      "same-call",
    );
    assert.deepEqual(
      call(
        { action: "add", title: "智能体收藏", url: "https://example.com" },
        "host_morphz",
        "same-call",
      ),
      added,
    );
    assert.equal(added.bookmark.ownerPrincipalId, localAccess.principalId);
    assert.deepEqual(added.bookmark.createdBy, agent);
    assert.equal(
      workspaceFor(store.snapshot(), localAccess).bookmarks[0]!.id,
      added.bookmark.id,
    );
    assert.equal(workspaceFor(store.snapshot(), agent).bookmarks.length, 0);
    const listed = call(
      { action: "list", query: "智能体" },
      "host_morphz_work",
    );
    assert.equal(listed.total, 1);
    call({
      action: "update",
      bookmarkId: added.bookmark.id,
      revision: 1,
      title: "共同编辑",
      url: added.bookmark.url,
    });
    assert.throws(
      () =>
        call({ action: "remove", bookmarkId: added.bookmark.id, revision: 1 }),
      /已被修改/,
    );
    call({ action: "remove", bookmarkId: added.bookmark.id, revision: 2 });
    assert.equal(call({ action: "list" }).total, 0);
    assert.equal(call({ action: "list", deleted: true }).total, 1);
    call({ action: "restore", bookmarkId: added.bookmark.id, revision: 3 });
    assert.equal(call({ action: "list" }).total, 1);
    assert.equal(store.snapshot().artifacts.length, 0);
    assert.equal(store.artifactOutputs(localAccess).length, 0);
    scope.inputId = "missing";
    assert.throws(() => call({ action: "list" }), /实际输入/);
  } finally {
    store.close();
  }
});

test("个人收藏不会因共享项目泄露；智能体不能自选所有者或绕过实际输入", () => {
  let state = initialWorkspace();
  const other = { principalId: "other-owner", actantId: "other-human" };
  state.principals.push({ id: other.principalId, name: "另一位" });
  state.actants.push({
    id: other.actantId,
    principalId: other.principalId,
    kind: "human",
    name: "另一位",
  });
  state.projects[0]!.members.push(other.principalId);
  const result = applyCommand(
    state,
    {
      commandId: randomUUID(),
      operation: {
        type: "bookmark-add",
        title: "私有",
        url: "https://example.com/",
      },
    },
    localAccess,
  );
  state = result.state;
  assert.equal(workspaceFor(state, other).bookmarks.length, 0);
  assert.throws(
    () =>
      applyCommand(
        state,
        {
          commandId: randomUUID(),
          operation: {
            type: "bookmark-remove",
            bookmarkId: result.receipt.entityId,
            expectedRevision: 1,
          },
        },
        other,
      ),
    /不可访问/,
  );
  assert.throws(
    () =>
      applyCommand(
        state,
        {
          commandId: randomUUID(),
          operation: {
            type: "bookmark-add",
            title: "冒用",
            url: "https://example.org/",
          },
        },
        agent,
      ),
    /实际输入/,
  );
  const store = new WorkspaceStore(":memory:");
  try {
    const inputId = input(store);
    const tools = new AgentTools(store, "token", () => ({
      projectId: "local-worktable",
      access: agent,
      inputId,
    }));
    assert.throws(
      () =>
        tools.call({
          protocol: 1,
          tool: "host_morphz",
          invocation: route,
          arguments: { action: "bookmarks", bookmarks: { action: "list" } },
        }),
      /实际输入/,
    );
  } finally {
    store.close();
  }
});
