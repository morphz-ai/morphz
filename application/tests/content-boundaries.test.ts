import test from "node:test";
import assert from "node:assert/strict";
import { workToolDefinitions } from "../packages/application/src/agent-tools.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";

test("网站创建从工具清单撤下；正式 Host 不可新建或转换网站，链接文档仍可保存", async () => {
  const f = await agentDomainFixture();
  try {
    for (const definition of workToolDefinitions) {
      const schema = definition.parameters as any;
      assert.ok(!schema.properties.action.enum.includes("create-website"));
      assert.equal(schema.properties.url, undefined);
      assert.ok(schema.properties.action.enum.includes("browser"));
      await assert.rejects(
        async () =>
          f.tools.call({
            ...f.envelope({
              action: "create-website",
              title: "新收藏",
              url: "https://example.com/",
            }),
            tool: definition.name,
          }),
        /尚未接入 Platform/,
      );
    }
    assert.deepEqual(
      (await f.call<{ items: unknown[] }>({ action: "list" })).items,
      [],
    );
    const document = await f.call<{ contentId: string }>({
      action: "create-document",
      title: "包含网页链接的文档",
      markdown: "[参考](https://example.com/)",
    });
    const version = await f.call({
      action: "read",
      artifactId: document.contentId,
      revision: 1,
    });
    await assert.rejects(
      f.call({
        action: "revise",
        artifactId: document.contentId,
        revision: 1,
        title: "转换绕过",
        content: { kind: "website", url: "https://example.com/" },
      }),
    );
    assert.deepEqual(
      await f.call({
        action: "read",
        artifactId: document.contentId,
        revision: 1,
      }),
      version,
    );
    assert.equal(
      (await f.call<{ items: unknown[] }>({ action: "list" })).items.length,
      1,
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("网站旧调用不会恢复写路径；浏览器收藏只写个人领域，不制造内容原件", async () => {
  const f = await agentDomainFixture();
  try {
    // Retired development workspace/receipt replay is deliberately not a
    // supported storage authority. Immutable Runtime tool names may remain,
    // but neither protocol name grants the removed website capability.
    for (const name of ["host_morphz", "host_morphz_work"])
      await assert.rejects(
        async () =>
          f.tools.call({
            ...f.envelope({
              action: "create-website",
              title: "旧调用",
              url: "https://example.com/",
              body: "不得重建旧对象",
            }),
            tool: name,
          }),
        /尚未接入 Platform/,
      );
    const saved = await f.call<any>({
      action: "bookmarks",
      bookmarks: {
        action: "add",
        title: "真实收藏",
        url: "https://example.com/",
      },
    });
    assert.equal(saved.ok, true);
    assert.deepEqual(
      (await f.call<{ items: unknown[] }>({ action: "list" })).items,
      [],
    );
    await f.reopen();
    assert.equal(
      (await f.withHuman((actor) => f.domains.browser.service.list(actor)))[0]!
        .title,
      "真实收藏",
    );
    assert.deepEqual(
      (await f.call<{ items: unknown[] }>({ action: "list" })).items,
      [],
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("公开理解在 Platform 独立保存，不进入内容和成果搜索；普通同名文档仍是原件", async () => {
  let revision = 1;
  const f = await agentDomainFixture({
    readUnderstanding: async (_route, scope, requested) => {
      assert.equal(requested, revision);
      return {
        frameId: `mw-public-${scope.projectId}`,
        frameRevision: revision,
        mindVersion: revision,
        body: `状态专用检索词 v${revision}`,
      };
    },
  });
  try {
    const ordinary = await f.call<{ contentId: string }>({
      action: "create-document",
      title: "当前理解",
      markdown: "用户自己命名的普通文档",
    });
    const first = await f.call<{
      understanding: { revision: number; body: string };
    }>({
      action: "publish-understanding",
      frameRevision: 1,
    });
    assert.equal(first.understanding.body, "状态专用检索词 v1");
    const list = await f.call<{ items: { id: string }[]; hasMore: boolean }>({
      action: "list",
      limit: 1,
    });
    assert.equal(list.hasMore, false);
    assert.deepEqual(
      list.items.map((item) => item.id),
      [ordinary.contentId],
    );
    assert.equal(
      (
        await f.call<{ total: number }>({
          action: "search",
          query: "状态专用检索词",
        })
      ).total,
      0,
    );
    const original = await f.call<{ text: string; revision: number }>({
      action: "read",
      artifactId: ordinary.contentId,
      revision: 1,
    });
    assert.equal(original.text, "用户自己命名的普通文档");
    revision = 2;
    await f.call({
      action: "publish-understanding",
      revision: 1,
      frameRevision: 2,
    });
    const historical = await f.withHuman((actor) =>
      f.domains.content.platform.getProjectUnderstanding(actor, f.projectId, 1),
    );
    assert.deepEqual(historical, first.understanding);
    await f.reopen();
    const current = await f.call<typeof first>({
      action: "read-understanding",
    });
    assert.equal(current.understanding.revision, 2);
    assert.equal(current.understanding.body, "状态专用检索词 v2");
    assert.deepEqual(
      await f.withHuman((actor) =>
        f.domains.content.platform.getProjectUnderstanding(
          actor,
          f.projectId,
          1,
        ),
      ),
      historical,
    );
    assert.equal(
      (await f.call<{ items: unknown[] }>({ action: "list" })).items.length,
      1,
    );
    assert.equal(
      (
        await f.call<{ total: number }>({
          action: "search",
          query: "状态专用检索词",
        })
      ).total,
      0,
    );
    assert.deepEqual(
      await f.call({
        action: "read",
        artifactId: ordinary.contentId,
        revision: 1,
      }),
      original,
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});
