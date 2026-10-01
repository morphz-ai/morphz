import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Application } from "../packages/application/src/application.js";
import { localAccess, initialWorkspace } from "../packages/core/src/model.js";
import { emptyScriptDraft } from "../packages/core/src/script-studio.js";
import {
  scriptStudioApplication,
  objectsApplication,
} from "../packages/core/src/applications.js";
import {
  scriptOutputLocation,
  resolveScriptLocation,
} from "../packages/core/src/script-delivery.js";
import { replyReceipts } from "../apps/web/src/conversation-read.js";
import {
  reviseScriptItem,
  createScriptProduction,
  createScriptItem,
} from "../packages/application/src/script-production-service.js";
import { agentDomainFixture } from "./agent-domain-fixture.js";

test("剧本与条目交付来自真实领域回执；重启、精确重试和历史版本保持", async () => {
  const host = await agentDomainFixture();
  try {
    const inputId = (await host.readAcceptedInput(host.route)).input_id;
    const create = host.envelope({
      action: "script",
      script: {
        action: "command",
        command: {
          action: "create-production",
          projectId: host.projectId,
          title: "TEST 废火",
        },
      },
    });
    const production = (await host.tools.call(create)) as any;
    assert.deepEqual(await host.tools.call(create), production);
    const shared = () => ({
      platform: host.domains.content.platform,
      studio: host.domains.content.studio!,
      instanceId: host.domains.content.instanceIds.scriptStudio,
      productionId: production.productionId,
    });
    const overview = () =>
      host.withHuman((actor) =>
        shared().studio.readProductionOverview({
          credential: actor.credential,
          productionId: production.productionId,
        }),
      );
    const itemCommand = host.envelope({
      action: "script",
      script: {
        action: "command",
        command: {
          action: "create-item",
          productionId: production.productionId,
          expectedActivityRevision: (await overview()).activityRevision,
          kind: "episode",
          draft: emptyScriptDraft("第一集"),
        },
      },
    });
    const item = (await host.tools.call(itemCommand)) as any;
    const deliveries = () =>
      host.withHuman(async (actor) => ({
        catalog: await host.domains.work.service.contentDeliveries(actor, {
          inputIds: [inputId],
        }),
        items: await shared().studio.listInputDeliveries({
          credential: actor.credential,
          inputIds: [inputId],
          productionIds: [production.productionId],
        }),
      }));
    const outputs = await deliveries();
    assert.equal(
      outputs.catalog.filter(
        (output) => output.appObjectId === production.productionId,
      ).length,
      2,
    );
    assert.equal(outputs.items.length, 1);
    assert.equal(outputs.items[0]!.itemId, item.itemId);
    assert.ok(outputs.items.every((output) => output.inputId === inputId));
    assert.equal(replyReceipts([], [], outputs.items).length, 1);
    const { sources: _legacy, ...draft } = emptyScriptDraft("人工改名");
    await host.withHuman((actor) =>
      reviseScriptItem({
        ...shared(),
        actor,
        commandId: randomUUID(),
        itemId: item.itemId,
        expectedRevision: 1,
        draft: { ...draft, text: "后来保存的正文", sources: [] },
      }),
    );
    host.setInputExecution("completed");
    assert.deepEqual(await host.tools.call(itemCommand), item);
    assert.deepEqual(
      await deliveries(),
      outputs,
      "重试保留原交付版本，而不是把当前正文当成当时的交付",
    );
    assert.equal(
      (
        await host.withHuman((actor) =>
          shared().studio.readItemVersion({
            credential: actor.credential,
            productionId: production.productionId,
            itemId: item.itemId,
            revision: 1,
          }),
        )
      ).draft.title,
      "第一集",
    );
    assert.equal(
      (
        await host.withHuman((actor) =>
          shared().studio.readItemVersion({
            credential: actor.credential,
            productionId: production.productionId,
            itemId: item.itemId,
          }),
        )
      ).draft.text,
      "后来保存的正文",
    );
    await assert.rejects(
      host.domains.work.authority.withSession(
        { principalId: "outsider", actantId: "outsider" },
        () => {},
        (actor) =>
          shared().studio.listInputDeliveries({
            credential: actor.credential,
            inputIds: [inputId],
            productionIds: [production.productionId],
          }),
      ),
    );
    const other = host.input();
    await assert.rejects(
      async () =>
        host.tools.call({
          ...itemCommand,
          invocation: { ...itemCommand.invocation, ...other },
        }),
      /剧本已变化/,
    );
    await host.reopen();
    assert.deepEqual(await host.tools.call(itemCommand), item);
    assert.deepEqual(await deliveries(), outputs);
    assert.equal((await overview()).progress.episodes, 1);
    assert.equal(
      (
        await host.withHuman((actor) =>
          host.domains.work.service.listContent(actor, {}),
        )
      ).length,
      1,
    );
    // The immutable receipt is authoritative. A retry must not replay app
    // mutations to manufacture a missing historical delivery event.
    const db = new DatabaseSync(join(host.directory, "script-studio.sqlite"));
    try {
      db.prepare("DELETE FROM script_outbox WHERE event_id=?").run(
        item.receipt.commandId,
      );
    } finally {
      db.close();
    }
    assert.equal((await deliveries()).items.length, 0);
    await assert.rejects(
      async () => host.tools.call(itemCommand),
      /回执与已提交原件不一致/,
    );
    assert.equal((await deliveries()).items.length, 0);
    assert.equal(
      (
        await host.withHuman((actor) =>
          shared().studio.readItemVersion({
            credential: actor.credential,
            productionId: production.productionId,
            itemId: item.itemId,
          }),
        )
      ).headRevision,
      2,
    );
    host.assertNoLegacyData();
  } finally {
    await host.close();
  }
});

test("剧本交付定位验证原件与确切版本；窗口复用且手动创建不冒充消息交付", async () => {
  const host = await agentDomainFixture();
  const app = () =>
    new Application(host.transport, {
      platformWork: host.domains.work,
      platformScripts: host.domains.content,
    }).session(localAccess);
  try {
    const productionId = `script_${randomUUID().replaceAll("-", "")}`;
    const itemId = `item_${randomUUID().replaceAll("-", "")}`;
    const shared = () => ({
      platform: host.domains.content.platform,
      studio: host.domains.content.studio!,
      instanceId: host.domains.content.instanceIds.scriptStudio,
      productionId,
    });
    const production = await host.withHuman((actor) =>
      createScriptProduction({
        ...shared(),
        actor,
        commandId: randomUUID(),
        productionId,
        projectId: host.projectId,
        title: "TEST 入口",
      }),
    );
    const current = await host.withHuman((actor) =>
      shared().studio.readProductionOverview({
        credential: actor.credential,
        productionId,
      }),
    );
    const { sources: _legacy, ...draft } = emptyScriptDraft("第一集");
    await host.withHuman((actor) =>
      createScriptItem({
        ...shared(),
        actor,
        commandId: randomUUID(),
        itemId,
        expectedActivityRevision: current.activityRevision,
        kind: "episode",
        draft: { ...draft, sources: [] },
      }),
    );
    const target = scriptOutputLocation({
      commandId: "test",
      inputId: "test",
      projectId: host.projectId,
      productionId,
      itemId,
      kind: "item",
      title: "第一集",
      productionTitle: "TEST 入口",
      itemKind: "episode",
      isEmpty: true,
      revision: 1,
      createdAt: new Date().toISOString(),
    });
    const request = {
      commandId: randomUUID(),
      projectId: host.projectId,
      appId: scriptStudioApplication.id,
      packageVersion: scriptStudioApplication.version,
      state: { scriptTarget: target },
    };
    const view = await app().launchPlatformAppView(request);
    assert.equal(
      (
        await app().launchPlatformAppView({
          ...request,
          commandId: randomUUID(),
        })
      ).id,
      view.id,
    );
    assert.deepEqual(
      (await app().listPlatformAppViews())[0]!.state.scriptTarget,
      target,
    );
    assert.equal(
      (
        await app().readPlatformScriptItem({
          contentId: production.contentId,
          itemId,
          revision: 1,
        })
      ).draft.title,
      "第一集",
    );
    await assert.rejects(
      app().readPlatformScriptItem({
        contentId: production.contentId,
        itemId: "missing",
        revision: 1,
      }),
      /不存在|不可用/,
    );
    await assert.rejects(
      app().readPlatformScriptItem({
        contentId: production.contentId,
        itemId,
        revision: 999,
      }),
      /不存在|不可用/,
    );
    assert.deepEqual(
      await host.withHuman((actor) =>
        shared().studio.listInputDeliveries({
          credential: actor.credential,
          inputIds: [host.route.thread_id.replace("thread_", "")],
          productionIds: [productionId],
        }),
      ),
      [],
    );
    // This is a UI projection check, built from the actual app-owned original.
    // No model command or second persistence authority is used.
    const state = initialWorkspace();
    state.scriptProductions = [
      await app().readPlatformScriptSnapshot({
        contentId: production.contentId,
      }),
    ];
    assert.ok(resolveScriptLocation(state, target));
    assert.equal(
      resolveScriptLocation(state, { ...target, itemId: "missing" }),
      null,
    );
    assert.equal(
      resolveScriptLocation(state, { ...target, revision: 999 }),
      null,
    );
    await assert.rejects(
      app().launchPlatformAppView({
        ...request,
        commandId: randomUUID(),
        appId: objectsApplication.id,
      }),
      /状态|scriptTarget|导航|不属于/,
    );
    await host.reopen();
    assert.equal((await app().listPlatformAppViews())[0]!.id, view.id);
    host.assertNoLegacyData();
  } finally {
    await host.close();
  }
});
