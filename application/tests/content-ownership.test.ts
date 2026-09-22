import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { WorkspaceStore } from "../packages/application/src/store.js";
import {
  localAccess,
  commandSchema,
  type Operation,
} from "../packages/core/src/model.js";
import { contentEntries } from "../packages/core/src/content.js";
import { emptyScriptDraft } from "../packages/core/src/script-studio.js";
import { scriptSourceText } from "../packages/core/src/script-studio-commands.js";
import { migrateContentLocalState } from "../apps/web/src/content-local-migration.js";
import { applicationStoragePrefix } from "../packages/core/src/application-names.js";

const run = (s: WorkspaceStore, operation: Operation) =>
  s.execute({ commandId: randomUUID(), operation }, localAccess).entityId;
const script = (s: WorkspaceStore, title: string) =>
  run(s, {
    type: "script-command",
    command: {
      action: "create-production",
      projectId: "local-worktable",
      title,
    },
  });

test("统一成果目录：剧本与文档只有一份，选择加入项目不搬走工作台、其他成果或交流", () => {
  const s = new WorkspaceStore(":memory:");
  try {
    const a = script(s, "废火"),
      b = script(s, "第二部");
    run(s, {
      type: "script-command",
      command: {
        action: "create-item",
        productionId: a,
        kind: "episode",
        draft: { ...emptyScriptDraft("第一集"), text: "原文保持" },
      },
    });
    const document = run(s, {
      type: "create-artifact",
      projectId: "local-worktable",
      title: "原作",
      content: { kind: "document", markdown: "原作正文" },
    });
    const before = s.snapshot();
    const cmd = {
      commandId: randomUUID(),
      operation: {
        type: "organize-content" as const,
        target: { kind: "script" as const, id: a },
        expectedRevision: 1,
        changes: { newProjectTitle: "短剧项目" },
      },
    };
    const receipt = s.execute(cmd, localAccess);
    assert.deepEqual(s.execute(cmd, localAccess), receipt);
    let after = s.snapshot();
    assert.equal(
      after.scriptProductions.find((p) => p.id === a)!.projectId,
      cmd.commandId,
    );
    assert.deepEqual(
      after.scriptProductions.find((p) => p.id === a)!.items,
      before.scriptProductions[0]!.items,
    );
    assert.equal(
      after.scriptProductions.find((p) => p.id === b)!.projectId,
      "local-worktable",
    );
    assert.equal(
      after.artifacts.find((p) => p.id === document)!.projectId,
      "local-worktable",
    );
    assert.deepEqual(after.inputs, before.inputs);
    assert.deepEqual(
      after.conversations.filter((c) => c.projectId !== cmd.commandId),
      before.conversations,
    );
    assert.equal(
      after.projects.find((p) => p.id === "local-worktable")!.kind,
      "desk",
    );
    assert.equal(contentEntries(after).length, 3);
    run(s, {
      ...cmd.operation,
      target: { kind: "script", id: b },
      changes: { projectId: cmd.commandId },
    });
    after = s.snapshot();
    assert.equal(
      contentEntries(after).filter((e) => e.value.projectId === cmd.commandId)
        .length,
      2,
    );
    assert.equal(new Set(contentEntries(after).map((e) => e.value.id)).size, 3);
    assert.throws(
      () => s.execute({ ...cmd, commandId: randomUUID() }, localAccess),
      /已变化/,
    );
    assert.equal(s.snapshot().projects.length, after.projects.length);
  } finally {
    s.close();
  }
});

test("删除错误创建路径和工作台转换操作，不保留别名；项目与未归项目是内容仅有的归属", () => {
  const s = new WorkspaceStore(":memory:");
  try {
    for (const projectId of ["local-dialogue", "local-inbox"]) {
      assert.throws(
        () =>
          run(s, {
            type: "create-artifact",
            projectId,
            title: "不应写入",
            content: { kind: "document", markdown: "内容" },
          }),
        /不能存入对话或事项/,
      );
      assert.throws(
        () =>
          run(s, {
            type: "script-command",
            command: {
              action: "create-production",
              projectId,
              title: "不应写入",
            },
          }),
        /不能存入对话或事项/,
      );
    }
    assert.equal(
      commandSchema.safeParse({
        commandId: randomUUID(),
        operation: {
          type: "save-workspace-as-project",
          workspaceId: "local-worktable",
          title: "旧操作",
        },
      }).success,
      false,
    );
    assert.equal(
      commandSchema.safeParse({
        commandId: randomUUID(),
        operation: {
          type: "organize-content",
          artifactId: "old",
          expectedRevision: 1,
          changes: { title: "旧签名" },
        },
      }).success,
      false,
    );
  } finally {
    s.close();
  }
});

test("归属修改保留固定原作引用，权限边界一旦改变则停止读取；不能借整理扩大共享", () => {
  const s = new WorkspaceStore(":memory:");
  try {
    const a = script(s, "改编");
    const sourceId = run(s, {
      type: "create-artifact",
      projectId: "local-worktable",
      title: "原作",
      content: { kind: "document", markdown: "准确原文" },
    });
    const ref = { artifactId: sourceId, revision: 1, quote: "准确原文" };
    run(s, {
      type: "script-command",
      command: {
        action: "create-item",
        productionId: a,
        kind: "source",
        draft: { ...emptyScriptDraft("原作"), sources: [ref] },
      },
    });
    const move = {
      type: "organize-content" as const,
      target: { kind: "script" as const, id: a },
      expectedRevision: 1,
      changes: { newProjectTitle: "改编项目" },
    };
    run(s, move);
    let state = s.snapshot(),
      production = state.scriptProductions[0]!;
    assert.equal(scriptSourceText(state, production, ref).text, "准确原文");
    s.provisionMembers([
      {
        principalId: "other",
        actantId: "other-human",
        name: "其他人",
        enabled: true,
        projectIds: [production.projectId],
      },
    ]);
    state = s.snapshot();
    production = state.scriptProductions[0]!;
    assert.throws(() => scriptSourceText(state, production, ref), /原作版本/);
    assert.throws(
      () =>
        run(s, {
          ...move,
          expectedRevision: 2,
          changes: { projectId: "first-project" },
        }),
      /成员不同/,
    );
  } finally {
    s.close();
  }
});

test("一次性迁移个人成果归属：正文/候选/输入/会话/回执不重放，重开只使用新归属", () => {
  const dir = mkdtempSync(join(tmpdir(), "morphz-content-ownership-")),
    path = join(dir, "workspace.sqlite");
  let s = new WorkspaceStore(path);
  try {
    const p = script(s, "旧对话里创建的剧本");
    run(s, {
      type: "script-command",
      command: {
        action: "create-item",
        productionId: p,
        kind: "episode",
        draft: { ...emptyScriptDraft("第一集"), text: "历史正文" },
      },
    });
    const inputId = run(s, {
      type: "record-input",
      projectId: "local-worktable",
      conversationId: "local-dialogue",
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body: "已完成的历史输入",
      targetActantId: "morphz-agent",
    });
    const a = run(s, {
      type: "create-artifact",
      projectId: "local-worktable",
      title: "旧内容",
      content: { kind: "document", markdown: "逐字保留" },
    });
    const old = s.snapshot();
    old.scriptProductions.find((x) => x.id === p)!.projectId = "local-dialogue";
    old.inputs.find((i) => i.id === inputId)!.projectId = "local-dialogue";
    old.artifacts.find((x) => x.id === a)!.projectId = "local-inbox";
    s.close();
    const db = new DatabaseSync(path);
    db.prepare("UPDATE workspace SET body=? WHERE id=1").run(
      JSON.stringify(old),
    );
    db.exec("PRAGMA user_version=13");
    const pending = { deliveries: [{ inputId, state: "running" }] };
    db.prepare("INSERT OR REPLACE INTO runtime_state(id,body) VALUES(1,?)").run(
      JSON.stringify(pending),
    );
    assert.throws(() => new WorkspaceStore(path), /执行结束后升级/);
    assert.deepEqual(
      JSON.parse(
        (db.prepare("SELECT body FROM workspace").get() as { body: string })
          .body,
      ),
      old,
    );
    assert.equal(
      (db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
      13,
    );
    pending.deliveries[0]!.state = "completed";
    db.prepare("UPDATE runtime_state SET body=?").run(JSON.stringify(pending));
    db.close();
    s = new WorkspaceStore(path);
    const next = s.snapshot();
    assert.equal(next.scriptProductions[0]!.projectId, "local-worktable");
    assert.equal(next.artifacts[0]!.projectId, "local-worktable");
    assert.deepEqual(next.inputs, old.inputs);
    assert.deepEqual(next.conversations, old.conversations);
    assert.deepEqual(
      next.scriptProductions[0]!.items,
      old.scriptProductions[0]!.items,
    );
    assert.deepEqual(next.artifacts[0]!.content, old.artifacts[0]!.content);
    s.close();
    s = new WorkspaceStore(path);
    assert.deepEqual(s.snapshot(), next);
  } finally {
    s.close();
    rmSync(dir, { recursive: true });
  }
});

test("剧本草稿一次性采用稳定内容 ID，改变项目不会重建草稿或回退到旧键", () => {
  const prefix = `${applicationStoragePrefix}center:owner:`;
  const old = prefix + "draft:window:script:old-project:production:item:v1";
  const next = prefix + "draft:window:script:production:item:v1";
  const values = new Map([
    [old, '{"text":"未保存原文"}'],
    [old.replace(/v1$/, "base"), "1"],
    [
      `${applicationStoragePrefix}other:owner:draft:window:script:private:production:item:v1`,
      "私有草稿",
    ],
  ]);
  const storage = {
    get length() {
      return values.size;
    },
    key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
  };
  migrateContentLocalState(storage, "center", "owner");
  assert.equal(values.get(next), values.get(old));
  assert.equal(values.get(next.replace(/v1$/, "base")), "1");
  values.set(next, "最新草稿");
  values.set(old, "旧记录不能再覆盖");
  migrateContentLocalState(storage, "center", "owner");
  assert.equal(values.get(next), "最新草稿");
  assert.equal(
    values.has(
      `${applicationStoragePrefix}other:owner:draft:window:script:production:item:v1`,
    ),
    false,
  );
});
