import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorkspaceStore } from "../packages/application/src/store.js";
import {
  AgentTools,
  workToolDefinitions,
} from "../packages/application/src/agent-tools.js";
import { stableId } from "../packages/application/src/collaboration.js";
import {
  localAccess,
  isContentArtifact,
  type Command,
} from "../packages/core/src/model.js";
import {
  readArtifact,
  searchArtifacts,
} from "../packages/core/src/retrieval.js";
import { seedLegacyWebsite } from "./legacy-website-fixture.js";
const agent = { principalId: "morphz-service", actantId: "morphz-agent" };
const route = {
  job_id: "legacy-website-job",
  tool_call_id: "call-1",
  session_id: "s",
  context_id: "c",
  principal_id: "p",
  agent_id: "a",
  target_id: "local",
  thread_id: "t",
};
const envelope = (args: unknown, tool = "host_morphz", invocation = route) => ({
  protocol: 1,
  tool,
  invocation,
  arguments: args,
});
const website = {
  kind: "website" as const,
  url: "https://example.com/",
  description: "旧网页说明",
};

test("网站创建从工具清单撤下；新旧 Host 和通用命令均不能再新建或转成网站", () => {
  const store = new WorkspaceStore(":memory:");
  try {
    const tools = new AgentTools(store, "token", () => ({
      projectId: "first-project",
      access: agent,
    }));
    const before = store.snapshot();
    for (const definition of workToolDefinitions) {
      const schema = definition.parameters as any;
      assert.ok(!schema.properties.action.enum.includes("create-website"));
      assert.equal(schema.properties.url, undefined);
      assert.ok(schema.properties.action.enum.includes("browser"));
      assert.throws(
        () =>
          tools.call(
            envelope(
              { action: "create-website", title: "新收藏", url: website.url },
              definition.name,
            ),
          ),
        /停止新建网页收藏/,
      );
    }
    for (const access of [localAccess, agent])
      assert.throws(
        () =>
          store.execute(
            {
              commandId: randomUUID(),
              operation: {
                type: "create-artifact",
                projectId: "first-project",
                title: "新收藏",
                content: website,
              },
            },
            access,
          ),
        /停止新建网页收藏/,
      );
    assert.deepEqual(store.snapshot(), before);
    const doc = store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "create-artifact",
          projectId: "first-project",
          title: "包含网页链接的文档",
          content: {
            kind: "document",
            markdown: "[参考](https://example.com/)",
          },
        },
      },
      localAccess,
    ).entityId;
    const saved = store.snapshot();
    assert.throws(
      () =>
        store.execute(
          {
            commandId: randomUUID(),
            operation: {
              type: "revise-artifact",
              artifactId: doc,
              expectedRevision: 1,
              title: "转换绕过",
              content: website,
            },
          },
          localAccess,
        ),
      /停止新建网页收藏/,
    );
    assert.deepEqual(store.snapshot(), saved);
  } finally {
    store.close();
  }
});

test("旧网站、版本、关联和原命令回执保留；重试不新建，变参重试仍拒绝", () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-content-retirement-"));
  const filename = join(directory, "workspace.sqlite");
  let store = new WorkspaceStore(filename);
  const command: Command = {
    commandId: stableId("host-website", route.job_id, route.tool_call_id),
    operation: {
      type: "create-artifact",
      projectId: "first-project",
      title: "旧收藏",
      content: website,
    },
  };
  store.close();
  const receipt = seedLegacyWebsite(filename, command, agent);
  store = new WorkspaceStore(filename);
  try {
    const before = store.snapshot();
    const tools = new AgentTools(store, "token", () => ({
      projectId: "first-project",
      access: agent,
    }));
    for (const name of ["host_morphz", "host_morphz_work"])
      assert.deepEqual(
        (
          tools.call(
            envelope(
              {
                action: "create-website",
                title: "旧收藏",
                url: website.url,
                body: website.description,
              },
              name,
            ),
          ) as any
        ).receipt,
        receipt,
      );
    assert.deepEqual(store.execute(command, agent), receipt);
    assert.deepEqual(store.snapshot(), before);
    assert.throws(
      () =>
        tools.call(
          envelope({
            action: "create-website",
            title: "变参",
            url: website.url,
          }),
        ),
      /另一项请求/,
    );
    const document = store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "create-artifact",
          projectId: "first-project",
          title: "原参考文档",
          content: { kind: "document", markdown: "保留链接" },
        },
      },
      localAccess,
    ).entityId;
    store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "link-artifacts",
          fromId: document,
          toId: receipt.entityId,
          relation: "references",
        },
      },
      localAccess,
    );
    store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "revise-artifact",
          artifactId: receipt.entityId,
          expectedRevision: 1,
          title: "旧收藏",
          content: { ...website, description: "更新说明" },
        },
      },
      localAccess,
    );
    const saved = store.snapshot();
    store.close();
    store = new WorkspaceStore(filename);
    assert.deepEqual(store.snapshot(), saved);
    const legacy = store
      .snapshot()
      .artifacts.find((a) => a.id === receipt.entityId)!;
    assert.deepEqual(legacy.versions[0], before.artifacts[0]!.versions[0]);
    assert.ok(isContentArtifact(legacy));
    assert.ok(readArtifact(store.snapshot(), legacy.id, localAccess, 1));
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("公开理解退出内容列表和成果搜索；原记录、历史阅读和检查器数据不删除", () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-content-state-"));
  const filename = join(directory, "workspace.sqlite");
  let store = new WorkspaceStore(filename);
  try {
    const create = (title: string, content: any) =>
      store.execute(
        {
          commandId: randomUUID(),
          operation: {
            type: "create-artifact",
            projectId: "first-project",
            title,
            content,
          },
        },
        agent,
      ).entityId;
    const summaryId = create("公开理解验收", {
      kind: "document",
      markdown: "状态专用检索词",
      understanding: {
        frameId: "f",
        frameRevision: 1,
        mindVersion: 1,
        sources: [],
      },
    });
    const ordinaryId = create("当前理解", {
      kind: "document",
      markdown: "用户自己命名的普通文档",
    });
    const before = store.snapshot();
    const tools = new AgentTools(store, "token", () => ({
      projectId: "first-project",
      access: agent,
    }));
    const list = tools.call(
      envelope({ action: "list", contentOnly: true, offset: 0, limit: 1 }),
    ) as any;
    assert.equal(list.total, 1);
    assert.equal(list.hasMore, false);
    assert.equal(list.artifacts[0].artifactId, ordinaryId);
    assert.equal((tools.call(envelope({ action: "list" })) as any).total, 2);
    assert.equal(
      store.search({ query: "状态专用检索词" }, localAccess).total,
      0,
    );
    assert.equal(
      searchArtifacts(before, { query: "状态专用检索词" }, localAccess).total,
      0,
    );
    assert.equal(before.artifacts.filter(isContentArtifact).length, 1);
    assert.ok(readArtifact(before, summaryId, localAccess, 1));
    // Simulate an old index row, then run the normal upgrade/reindex path.
    const db = new DatabaseSync(filename);
    db.prepare(
      "INSERT INTO search_object(id,project,revision,title,title_fold,body,body_fold,meta) VALUES(?,?,?,?,?,?,?,?)",
    ).run(
      summaryId,
      "first-project",
      1,
      "公开理解验收",
      "公开理解验收",
      "状态专用检索词",
      "状态专用检索词",
      JSON.stringify({ kind: "document", updatedAt: new Date().toISOString() }),
    );
    db.close();
    store.close();
    store = new WorkspaceStore(filename);
    assert.equal(
      store.search({ query: "状态专用检索词" }, localAccess).total,
      0,
    );
    assert.deepEqual(store.snapshot(), before);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
