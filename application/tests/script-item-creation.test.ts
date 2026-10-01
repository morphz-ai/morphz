import test from "node:test";
import assert from "node:assert/strict";
import { emptyScriptDraft } from "../packages/core/src/script-studio.js";
import { ScriptStudioStore } from "../packages/script-studio/src/store.js";

test("剧本首次条目提交：来源需在提交前复核，失败回滚且回执可恢复", async () => {
  let sourceChecks = 0;
  let revokeOnSecondCheck = true;
  const studio = await ScriptStudioStore.sqlite(":memory:", {
    async authorizeCreate() {
      return {
        tenantId: "tenant-one",
        principalId: "alice",
        actantId: "alice",
        kind: "human",
        runtimeInputId: null,
      };
    },
    async authorizeObject() {
      return {
        tenantId: "tenant-one",
        principalId: "alice",
        actantId: "alice",
        kind: "human",
        runtimeInputId: null,
        projectId: "project-one",
        objectKind: "script",
      };
    },
    async verifySourceVersion(request) {
      assert.equal(request.productionProjectId, "project-one");
      assert.equal(request.appId, "morphz.objects");
      assert.equal(request.instanceId, "objects-one");
      assert.equal(request.objectId, "original-one");
      assert.equal(request.versionRef, "7");
      assert.equal(request.quote, "固定引文");
      assert.equal(request.alreadyPinned, false);
      sourceChecks++;
      return !(revokeOnSecondCheck && sourceChecks === 2);
    },
  });
  try {
    const production = await studio.createProduction({
      credential: "alice",
      commandId: "production-command",
      productionId: "production-one",
      requestedProjectId: "project-one",
      title: "改编剧本",
    });
    await studio.markDirectoryProjected(
      production.tenantId,
      production.eventId,
    );
    const { sources: _legacySources, ...baseDraft } =
      emptyScriptDraft("原作线索");
    const command = {
      credential: "alice",
      commandId: "item-command",
      productionId: "production-one",
      itemId: "source-item",
      expectedActivityRevision: 1,
      kind: "source" as const,
      draft: {
        ...baseDraft,
        sources: [
          {
            appId: "morphz.objects",
            instanceId: "objects-one",
            objectId: "original-one",
            versionRef: "7",
            quote: "固定引文",
          },
        ],
      },
    };
    await assert.rejects(
      studio.createItem(command),
      /来源权限或引文在创建期间已变化/,
    );
    assert.equal(
      (
        await studio.readProductionOverview({
          credential: "alice",
          productionId: "production-one",
        })
      ).activityRevision,
      1,
    );
    assert.deepEqual(
      (
        await studio.listItems({
          credential: "alice",
          productionId: "production-one",
          parentId: null,
        })
      ).items,
      [],
    );
    assert.deepEqual(await studio.pendingItemDirectoryEvents("tenant-one"), []);
    revokeOnSecondCheck = false;
    const committed = await studio.createItem(command);
    assert.equal(committed.activityRevision, 2);
    assert.deepEqual(
      (
        await studio.readItemVersion({
          credential: "alice",
          productionId: "production-one",
          itemId: "source-item",
        })
      ).draft.sources,
      command.draft.sources,
    );
    const checksBeforeReplay = sourceChecks;
    assert.deepEqual(await studio.createItem(command), committed);
    assert.equal(sourceChecks, checksBeforeReplay);
  } finally {
    await studio.close();
  }
});
