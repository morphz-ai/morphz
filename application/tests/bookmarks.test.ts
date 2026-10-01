import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  AgentTools,
  workToolDefinitions,
} from "../packages/application/src/agent-tools.js";
import { localAccess, type Operation } from "../packages/core/src/model.js";
import type { PlatformActor } from "../packages/platform/src/store.js";
import { findBookmarks } from "../packages/core/src/bookmarks.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";

test("浏览器收藏独立保存：规范化去重、版本冲突、删除撤销和重开，不生成内容或索引", async () => {
  const host = await agentDomainFixture();
  const execute = (operation: Operation, commandId = randomUUID()) =>
    host.withHuman((actor) =>
      host.domains.browser.service.command(actor, { commandId, operation }),
    );
  const bookmarks = () =>
    host.withHuman((actor) => host.domains.browser.service.list(actor));
  try {
    const commandId = randomUUID();
    const operation = {
      type: "bookmark-add" as const,
      title: "示例",
      url: "https://EXAMPLE.com",
    };
    const receipt = await execute(operation, commandId);
    assert.deepEqual(await execute(operation, commandId), receipt);
    assert.equal(
      (
        await execute({
          type: "bookmark-add",
          title: "不会覆盖名称",
          url: "https://example.com/",
        })
      ).receipt.bookmarkId,
      receipt.receipt.bookmarkId,
    );
    assert.equal((await bookmarks()).length, 1);
    assert.equal((await bookmarks())[0]!.title, "示例");
    const bookmarkId = receipt.receipt.bookmarkId;
    await execute({
      type: "bookmark-update",
      bookmarkId,
      expectedRevision: 1,
      title: "新名称",
      url: "https://example.com/path#section",
    });
    await assert.rejects(
      execute({ type: "bookmark-remove", bookmarkId, expectedRevision: 1 }),
      /已被修改/,
    );
    await execute({ type: "bookmark-remove", bookmarkId, expectedRevision: 2 });
    assert.equal(findBookmarks(await bookmarks()).length, 0);
    await execute({
      type: "bookmark-restore",
      bookmarkId,
      expectedRevision: 3,
    });
    assert.equal(findBookmarks(await bookmarks(), "新名称 section").length, 1);
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://u:p@example.com/",
    ])
      await assert.rejects(
        execute({ type: "bookmark-add", title: "无效", url }),
      );
    assert.deepEqual(
      await host.withHuman((actor) =>
        host.domains.work.service.listContent(actor, {}),
      ),
      [],
    );
    assert.equal(
      (
        await host.withHuman((actor) =>
          host.domains.work.service.searchContentTitles(actor, {
            query: "新名称",
          }),
        )
      ).total,
      0,
    );
    const saved = await bookmarks();
    await host.reopen();
    assert.deepEqual(await bookmarks(), saved);
    assert.deepEqual(await execute(operation, commandId), receipt);
    host.assertNoLegacyData();
  } finally {
    await host.close();
  }
});

test("未接 Browser 领域服务的 Agent Host 拒绝收藏操作，不回落旧工作区", () => {
  const tools = new AgentTools({
    token: "token",
    resolveScope: () => {
      throw new Error("不得读取旧工作区范围");
    },
  });
  for (const definition of workToolDefinitions) {
    assert.ok(
      (definition.parameters as any).properties.action.enum.includes(
        "bookmarks",
      ),
    );
    assert.match(definition.description, /initiating human/);
  }
  assert.throws(
    () =>
      tools.call({
        protocol: 1,
        tool: "host_morphz",
        invocation: {
          job_id: "bookmark-job",
          tool_call_id: "bookmark-call",
          session_id: "s",
          context_id: "c",
          principal_id: "untrusted",
          agent_id: "a",
          target_id: "local",
          thread_id: "t",
        },
        arguments: { action: "bookmarks", bookmarks: { action: "list" } },
      }),
    /浏览器收藏服务不可用/,
  );
});

test("个人收藏不会因项目泄露；智能体不能自选所有者或绕过实际输入", async () => {
  const other = { principalId: "other-owner", actantId: "other-human" };
  const host = await agentDomainFixture({ additionalHumans: [other] });
  try {
    const created = await host.withHuman((actor) =>
      host.domains.browser.service.command(actor, {
        commandId: randomUUID(),
        operation: {
          type: "bookmark-add",
          title: "私有",
          url: "https://example.com/",
        },
      }),
    );
    const withOther = <T>(work: (actor: PlatformActor) => Promise<T>) =>
      host.domains.work.authority.withSession(other, () => {}, work);
    assert.deepEqual(
      await withOther((actor) => host.domains.browser.service.list(actor)),
      [],
    );
    await assert.rejects(
      withOther((actor) =>
        host.domains.browser.service.command(actor, {
          commandId: randomUUID(),
          operation: {
            type: "bookmark-remove",
            bookmarkId: created.receipt.bookmarkId,
            expectedRevision: 1,
          },
        }),
      ),
      /不可访问/,
    );
    await assert.rejects(
      host.call({
        action: "bookmarks",
        bookmarks: {
          action: "add",
          title: "冒用",
          url: "https://example.org/",
          ownerPrincipalId: other.principalId,
        },
      }),
    );
    const reply = await host.call<any>({
      action: "bookmarks",
      bookmarks: {
        action: "add",
        title: "Agent 收藏",
        url: "https://example.org/",
      },
    });
    assert.equal(reply.ok, true);
    assert.deepEqual(
      await withOther((actor) => host.domains.browser.service.list(actor)),
      [],
    );
    const unbound = host.input();
    host.forgetInput(unbound);
    await assert.rejects(
      host.call(
        { action: "bookmarks", bookmarks: { action: "list" } },
        unbound,
      ),
      /Unknown fixture thread|实际|输入|不存在/,
    );
    const owner = await host.withHuman((actor) =>
      host.domains.browser.service.list(actor),
    );
    assert.equal(owner.length, 2);
    assert.ok(
      owner.every((b) => b.ownerPrincipalId === localAccess.principalId),
    );
    host.assertNoLegacyData();
  } finally {
    await host.close();
  }
});
