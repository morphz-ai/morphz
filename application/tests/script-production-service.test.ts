import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { emptyScriptDraft } from "../packages/core/src/script-studio.js";
import {
  Application,
  type ApplicationOptions,
} from "../packages/application/src/application.js";
import type { RuntimeBridge } from "../packages/application/src/runtime.js";
import { AgentTools } from "../packages/application/src/agent-tools.js";
import { PlatformAgentTools } from "../packages/application/src/platform-agent-tools.js";
import { PlatformWorkService } from "../packages/application/src/platform-work-service.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import type {
  AgentToolArguments,
  HostInvocation,
  ToolScope,
} from "../packages/application/src/agent-tools.js";
import type { PlatformAgentDomain } from "../packages/application/src/platform-agent-tools.js";
import {
  createScriptItem,
  createScriptProduction,
  reviseScriptItem,
  restoreScriptItem,
  recordScriptExport,
  transitionScriptWorkflow,
  changeScriptReview,
  updateScriptProduction,
  renameScriptProduction,
  platformScriptStudioAuthority,
  projectPendingScriptItems,
  projectPendingScriptSettings,
  projectPendingScriptDirectory,
  projectPendingScriptExports,
  projectPendingScriptWorkflow,
  projectPendingScriptReviews,
} from "../packages/application/src/script-production-service.js";
import {
  PlatformStore,
  type PlatformAuthorityVerifier,
} from "../packages/platform/src/store.js";
import {
  ScriptStudioStore,
  type LiveScriptDraft,
} from "../packages/script-studio/src/store.js";

function emptyItemDraft(title: string): LiveScriptDraft {
  const { sources: _legacySources, ...draft } = emptyScriptDraft(title);
  return { ...draft, sources: [] };
}

function fixtureAuthority(
  studio: () => ScriptStudioStore,
  proofReady: () => boolean = () => true,
  credentialReady: () => boolean = () => true,
): PlatformAuthorityVerifier {
  return {
    async resolveActor({ credential }) {
      if (!credentialReady()) return null;
      if (credential === "alice")
        return {
          tenantId: "tenant-one",
          principalId: "alice",
          actantId: "alice",
          kind: "human",
          runtimeInputId: null,
        };
      if (credential === "agent-input")
        return {
          tenantId: "tenant-one",
          principalId: "alice",
          actantId: "agent-one",
          kind: "agent",
          runtimeInputId: "input-one",
          scopeProjectId: "project-one",
        };
      if (credential === "agent-review-input")
        return {
          tenantId: "tenant-one",
          principalId: "alice",
          actantId: "agent-one",
          kind: "agent",
          runtimeInputId: "input-review",
          scopeProjectId: "project-one",
        };
      if (credential === "agent-rename-input")
        return {
          tenantId: "tenant-one",
          principalId: "alice",
          actantId: "agent-one",
          kind: "agent",
          runtimeInputId: "input-rename",
          scopeProjectId: "project-one",
        };
      if (credential === "agent-without-input")
        return {
          tenantId: "tenant-one",
          principalId: "alice",
          actantId: "agent-one",
          kind: "agent",
          runtimeInputId: null,
          scopeProjectId: "project-one",
        };
      if (credential === "bob")
        return {
          tenantId: "tenant-one",
          principalId: "bob",
          actantId: "bob",
          kind: "human",
          runtimeInputId: null,
        };
      return null;
    },
    async resolveActant({ actantId }) {
      return actantId === "agent-one"
        ? { principalId: "morphz-service", kind: "agent" }
        : null;
    },
    async resolveProjectAgent() {
      return { principalId: "morphz-service", actantId: "agent-one" };
    },
    async verifyApplicationObject(request) {
      if (
        !proofReady() ||
        request.instanceId !== "studio-one" ||
        request.kind !== "script" ||
        request.proof !== request.receiptId
      )
        return false;
      if (
        await studio().verifyCommittedProduction({
          tenantId: request.tenantId,
          principalId: request.principalId,
          actantId: request.actantId,
          runtimeInputId: request.runtimeInputId,
          runtimeTaskRunEventId: request.runtimeTaskRunEventId,
          productionId: request.objectId,
          projectId: request.projectId,
          title: request.title,
          versionRef: request.versionRef,
          receiptId: request.receiptId,
        })
      )
        return true;
      if (
        await studio().verifyCommittedProductionUpdate({
          tenantId: request.tenantId,
          principalId: request.principalId,
          actantId: request.actantId,
          runtimeInputId: request.runtimeInputId,
          runtimeTaskRunEventId: request.runtimeTaskRunEventId,
          productionId: request.objectId,
          title: request.title,
          versionRef: request.versionRef,
          receiptId: request.receiptId,
        })
      )
        return true;
      if (
        await studio().verifyCommittedProductionRename({
          tenantId: request.tenantId,
          principalId: request.principalId,
          actantId: request.actantId,
          runtimeInputId: request.runtimeInputId,
          runtimeTaskRunEventId: request.runtimeTaskRunEventId,
          productionId: request.objectId,
          title: request.title,
          versionRef: request.versionRef,
          receiptId: request.receiptId,
        })
      )
        return true;
      if (
        await studio().verifyCommittedItemCreation({
          tenantId: request.tenantId,
          principalId: request.principalId,
          actantId: request.actantId,
          runtimeInputId: request.runtimeInputId,
          runtimeTaskRunEventId: request.runtimeTaskRunEventId,
          productionId: request.objectId,
          title: request.title,
          versionRef: request.versionRef,
          receiptId: request.receiptId,
        })
      )
        return true;
      if (
        await studio().verifyCommittedCandidateSubmission({
          tenantId: request.tenantId,
          principalId: request.principalId,
          actantId: request.actantId,
          runtimeInputId: request.runtimeInputId,
          runtimeTaskRunEventId: request.runtimeTaskRunEventId,
          productionId: request.objectId,
          title: request.title,
          versionRef: request.versionRef,
          receiptId: request.receiptId,
        })
      )
        return true;
      if (
        await studio().verifyCommittedExport({
          tenantId: request.tenantId,
          principalId: request.principalId,
          actantId: request.actantId,
          runtimeInputId: request.runtimeInputId,
          runtimeTaskRunEventId: request.runtimeTaskRunEventId,
          productionId: request.objectId,
          title: request.title,
          versionRef: request.versionRef,
          receiptId: request.receiptId,
        })
      )
        return true;
      if (
        await studio().verifyCommittedWorkflow({
          tenantId: request.tenantId,
          principalId: request.principalId,
          actantId: request.actantId,
          runtimeInputId: request.runtimeInputId,
          runtimeTaskRunEventId: request.runtimeTaskRunEventId,
          productionId: request.objectId,
          title: request.title,
          versionRef: request.versionRef,
          receiptId: request.receiptId,
        })
      )
        return true;
      if (
        await studio().verifyCommittedReview({
          tenantId: request.tenantId,
          principalId: request.principalId,
          actantId: request.actantId,
          runtimeInputId: request.runtimeInputId,
          runtimeTaskRunEventId: request.runtimeTaskRunEventId,
          productionId: request.objectId,
          title: request.title,
          versionRef: request.versionRef,
          receiptId: request.receiptId,
        })
      )
        return true;
      return studio().verifyCommittedItemRevision({
        tenantId: request.tenantId,
        principalId: request.principalId,
        actantId: request.actantId,
        runtimeInputId: request.runtimeInputId,
        runtimeTaskRunEventId: request.runtimeTaskRunEventId,
        productionId: request.objectId,
        title: request.title,
        versionRef: request.versionRef,
        receiptId: request.receiptId,
      });
    },
  };
}

async function exercise(
  platform: PlatformStore,
  studio: ScriptStudioStore,
  setProofReady: (ready: boolean) => void,
  setCredentialReady: (ready: boolean) => void,
) {
  await platform.provisionTenant("tenant-one");
  await platform.createProject(
    { credential: "alice" },
    {
      commandId: "create-project-one",
      projectId: "project-one",
      title: "创作项目",
    },
  );
  await assert.rejects(
    createScriptProduction({
      platform,
      studio,
      actor: { credential: "alice" },
      instanceId: "studio-one",
      commandId: "uninstalled-script",
      productionId: "uninstalled-production",
      projectId: "project-one",
      title: "未安装应用不得创建",
    }),
    /应用实例不可用/,
  );
  assert.deepEqual(await studio.pendingDirectoryEvents("tenant-one"), []);
  await platform.registerApplication("tenant-one", {
    appId: "morphz.script-studio",
    installationId: "install-studio-one",
    instanceId: "studio-one",
    routeKind: "service",
    routeRef: "test:studio-one",
  });
  await assert.rejects(
    platform.authorizeApplicationProject(
      { credential: "alice" },
      "studio-one",
      "morphz.objects",
      "project-one",
    ),
    /应用实例与应用类型不符/,
  );
  await platform.createProject(
    { credential: "alice" },
    {
      commandId: "create-project-two",
      projectId: "project-two",
      title: "另一个项目",
    },
  );
  const create = {
    platform,
    studio,
    actor: { credential: "alice" },
    instanceId: "studio-one",
    commandId: "script-command-one",
    productionId: "production-one",
    projectId: "project-one",
    title: "渡河",
  };

  // The app commits once. A transient Platform proof failure leaves an outbox
  // event; retry may only project that same production.
  await assert.rejects(createScriptProduction(create), /应用未确认/);
  const pending = await studio.pendingDirectoryEvents("tenant-one");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.event_id, create.commandId);
  assert.equal(pending[0]!.requested_project_id, "project-one");
  assert.equal(
    await studio.verifyCommittedProduction({
      tenantId: "tenant-one",
      principalId: "alice",
      actantId: "alice",
      runtimeInputId: null,
      productionId: create.productionId,
      projectId: "project-two",
      title: create.title,
      versionRef: "1",
      receiptId: create.commandId,
    }),
    false,
  );
  setProofReady(true);
  await assert.rejects(
    platform.recordContent(
      { credential: "alice" },
      { instanceId: "studio-one", proof: create.commandId },
      {
        commandId: "wrong-project-catalog",
        appReceiptId: create.commandId,
        contentId: "wrong-project-content",
        objectId: create.productionId,
        projectId: "project-two",
        kind: "script",
        title: create.title,
        observedVersionRef: "1",
      },
    ),
    /应用未确认此对象/,
  );
  const [first, concurrentRetry] = await Promise.all([
    createScriptProduction(create),
    createScriptProduction(create),
  ]);
  assert.deepEqual(concurrentRetry, first);
  assert.equal(first.original.productionId, create.productionId);
  assert.equal(first.original.versionRef, "1");
  const directory = await platform.content(
    { credential: "alice" },
    first.contentId,
  );
  assert.equal(directory.project_id, "project-one");
  assert.equal(directory.app_object_id, "production-one");
  assert.equal(directory.instance_id, "studio-one");
  assert.deepEqual(await studio.pendingDirectoryEvents("tenant-one"), []);
  assert.deepEqual(await createScriptProduction(create), first);
  await assert.rejects(
    createScriptProduction({ ...create, title: "另一本剧本" }),
    /相同命令 ID/,
  );
  await assert.rejects(
    createScriptProduction({
      ...create,
      actor: { credential: "bob" },
      commandId: "bob-script",
      productionId: "bob-production",
    }),
    /无权访问这个项目/,
  );
  await assert.rejects(
    createScriptProduction({
      ...create,
      actor: { credential: "agent-without-input" },
      commandId: "unbound-agent-script",
      productionId: "unbound-production",
    }),
    /已持久化的发起来源/,
  );
  const agent = await createScriptProduction({
    ...create,
    actor: { credential: "agent-input" },
    commandId: "agent-script",
    productionId: "agent-production",
    title: "Agent 创作",
  });
  assert.equal(
    (await platform.content({ credential: "alice" }, agent.contentId))
      .app_object_id,
    "agent-production",
  );
  assert.deepEqual(await studio.pendingDirectoryEvents("tenant-one"), []);

  const work = new PlatformWorkService(platform, "single-host");
  const observedListQueries: Array<Parameters<typeof work.listContent>[1]> = [];
  const listContent = work.listContent.bind(work);
  work.listContent = async (actor, query) => {
    observedListQueries.push(query);
    return listContent(actor, query);
  };
  const agentTools = new PlatformAgentTools({
    authority: {
      withInvocation: async (
        _route: unknown,
        action: (
          actor: unknown,
          source: unknown,
          identity: unknown,
        ) => Promise<unknown>,
      ) =>
        action(
          { credential: "agent-input" },
          { projectId: "project-one", inputId: "input-one" },
          {
            tenantId: "tenant-one",
            principalId: "alice",
            humanActantId: "alice",
            agentActantId: "agent-one",
          },
        ),
    },
    work,
    content: {
      platform,
      studio,
      instanceIds: { objects: "objects-one", scriptStudio: "studio-one" },
    },
  } as unknown as PlatformAgentDomain);
  const scope = {
    platform: true,
    projectId: "project-one",
    inputId: "input-one",
  } as ToolScope;
  const scriptRoute = {
    context_id: "context-one",
    job_id: "job-one",
    tool_call_id: "create-script",
  } as HostInvocation;
  const createScriptArgs = {
    action: "script",
    script: {
      action: "command",
      command: {
        action: "create-production",
        projectId: "project-one",
        title: "聊天创建剧本",
      },
    },
  } as AgentToolArguments;
  const createdByTool = (await agentTools.call(
    scriptRoute,
    scope,
    createScriptArgs,
  )) as {
    productionId: string;
    contentId: string;
    receipt: { commandId: string };
  };
  assert.equal(
    (
      (await agentTools.call(scriptRoute, scope, createScriptArgs)) as {
        productionId: string;
      }
    ).productionId,
    createdByTool.productionId,
  );
  const scriptFilter = {
    appId: "morphz.script-studio",
    kind: "script",
    availability: "available",
  };
  const expectedScripts = await work.listContent(
    { credential: "agent-input" },
    { ...scriptFilter, limit: 50 },
  );
  observedListQueries.length = 0;
  const scriptPage = (await agentTools.call(scriptRoute, scope, {
    action: "script",
    script: { action: "list", offset: 1, limit: 1 },
  } as AgentToolArguments)) as {
    total: number;
    hasMore: boolean;
    items: Array<{ id: string; contentId: string; title: string }>;
  };
  assert.equal(scriptPage.total, expectedScripts.length);
  assert.equal(scriptPage.hasMore, expectedScripts.length > 2);
  assert.deepEqual(scriptPage.items, [
    {
      id: expectedScripts[1]!.appObjectId,
      contentId: expectedScripts[1]!.id,
      title: expectedScripts[1]!.title,
      projectId: "project-one",
    },
  ]);
  assert.deepEqual(observedListQueries, [
    { ...scriptFilter, query: "", limit: 2 },
  ]);
  observedListQueries.length = 0;
  const searchedScripts = (await agentTools.call(scriptRoute, scope, {
    action: "script",
    script: { action: "list", query: "聊天", offset: 0, limit: 1 },
  } as AgentToolArguments)) as {
    total: number;
    items: Array<{ id: string }>;
  };
  assert.equal(searchedScripts.total, 1);
  assert.equal(searchedScripts.items[0]?.id, createdByTool.productionId);
  assert.deepEqual(observedListQueries, [
    { ...scriptFilter, query: "聊天", limit: 1 },
  ]);
  observedListQueries.length = 0;
  const beyondEnd = (await agentTools.call(scriptRoute, scope, {
    action: "script",
    script: { action: "list", offset: 50, limit: 1 },
  } as AgentToolArguments)) as { total: number; items: unknown[] };
  assert.equal(beyondEnd.total, expectedScripts.length);
  assert.deepEqual(beyondEnd.items, []);
  assert.deepEqual(observedListQueries, []);
  const overview = (await agentTools.call(scriptRoute, scope, {
    action: "script",
    script: {
      action: "read-production",
      productionId: createdByTool.productionId,
      offset: 0,
      limit: 20,
    },
  } as AgentToolArguments)) as { title: string; activityRevision: number };
  assert.equal(overview.title, "聊天创建剧本");
  assert.equal(overview.activityRevision, 1);
  const itemRoute = {
    ...scriptRoute,
    tool_call_id: "create-item",
  } as HostInvocation;
  const createItemArgs = {
    action: "script",
    script: {
      action: "command",
      command: {
        action: "create-item",
        productionId: createdByTool.productionId,
        expectedActivityRevision: 1,
        kind: "episode",
        draft: emptyScriptDraft("第一集"),
      },
    },
  } as AgentToolArguments;
  const toolItem = (await agentTools.call(
    itemRoute,
    scope,
    createItemArgs,
  )) as { itemId: string; activityRevision: number };
  assert.equal(toolItem.activityRevision, 2);
  assert.equal(
    (
      (await agentTools.call(itemRoute, scope, createItemArgs)) as {
        itemId: string;
      }
    ).itemId,
    toolItem.itemId,
  );
  const itemPage = (await agentTools.call(itemRoute, scope, {
    action: "script",
    script: {
      action: "read-production",
      productionId: createdByTool.productionId,
      offset: 0,
      limit: 20,
    },
  } as AgentToolArguments)) as {
    activityRevision: number;
    items: Array<{ id: string }>;
    nextCursor: unknown;
  };
  assert.equal(itemPage.activityRevision, 2);
  assert.equal(itemPage.items[0]?.id, toolItem.itemId);
  assert.equal(itemPage.nextCursor, null);
  const another = (await agentTools.call(
    { ...itemRoute, tool_call_id: "create-second-item" },
    scope,
    {
      action: "script",
      script: {
        action: "command",
        command: {
          action: "create-item",
          productionId: createdByTool.productionId,
          expectedActivityRevision: 2,
          kind: "episode",
          draft: emptyScriptDraft("第二集"),
        },
      },
    } as AgentToolArguments,
  )) as { itemId: string };
  const firstPage = (await agentTools.call(itemRoute, scope, {
    action: "script",
    script: {
      action: "read-production",
      productionId: createdByTool.productionId,
      offset: 0,
      limit: 1,
    },
  } as AgentToolArguments)) as {
    items: Array<{ id: string }>;
    nextCursor: { ordinal: number; itemId: string } | null;
  };
  assert.equal(firstPage.items[0]?.id, toolItem.itemId);
  assert.ok(firstPage.nextCursor);
  const secondPage = (await agentTools.call(itemRoute, scope, {
    action: "script",
    script: {
      action: "read-production",
      productionId: createdByTool.productionId,
      offset: 0,
      limit: 1,
      cursor: firstPage.nextCursor,
    },
  } as AgentToolArguments)) as {
    items: Array<{ id: string }>;
    nextCursor: unknown;
  };
  assert.equal(secondPage.items[0]?.id, another.itemId);
  assert.equal(secondPage.nextCursor, null);
  const toolDraft = (await agentTools.call(itemRoute, scope, {
    action: "script",
    script: {
      action: "read-item",
      productionId: createdByTool.productionId,
      itemId: toolItem.itemId,
      revision: 1,
      offset: 0,
      limit: 24_000,
    },
  } as AgentToolArguments)) as {
    format: string;
    draftJson: string;
    hasMore: boolean;
  };
  assert.equal(toolDraft.format, "script-draft-json");
  assert.equal(JSON.parse(toolDraft.draftJson).title, "第一集");
  assert.equal(toolDraft.hasMore, false);
  await assert.rejects(
    agentTools.call({ ...scriptRoute, tool_call_id: "cross-project" }, scope, {
      action: "script",
      script: {
        action: "command",
        command: {
          action: "create-production",
          projectId: "project-two",
          title: "越界剧本",
        },
      },
    } as AgentToolArguments),
    /输入范围外/,
  );
  await assert.rejects(
    agentTools.call({ ...itemRoute, tool_call_id: "body" }, scope, {
      action: "script",
      script: {
        action: "command",
        command: {
          action: "create-item",
          productionId: createdByTool.productionId,
          expectedActivityRevision: 2,
          kind: "episode",
          draft: { ...emptyScriptDraft("第二集"), text: "Agent 直接写正文" },
        },
      },
    } as AgentToolArguments),
    /只能建立空条目/,
  );

  const itemCommand = {
    platform,
    studio,
    actor: { credential: "alice" },
    instanceId: "studio-one",
    commandId: "item-command-one",
    productionId: "production-one",
    itemId: "episode-one",
    expectedActivityRevision: 1,
    kind: "episode" as const,
    draft: { ...emptyItemDraft("第一集"), text: "渡口停电。" },
  };
  setProofReady(false);
  await assert.rejects(createScriptItem(itemCommand), /应用未确认/);
  assert.equal(
    (await studio.pendingItemDirectoryEvents("tenant-one")).length,
    1,
  );
  assert.equal(
    (
      await studio.readItemVersion({
        credential: "alice",
        productionId: "production-one",
        itemId: "episode-one",
      })
    ).draft.text,
    "渡口停电。",
  );
  const unavailable = await projectPendingScriptItems({
    platform,
    studio,
    tenantId: "tenant-one",
    instanceId: "studio-one",
  });
  assert.equal(unavailable.examined, 1);
  assert.equal(unavailable.projected, 0);
  assert.deepEqual(unavailable.unresolved, ["item-command-one"]);
  assert.equal(unavailable.nextCursor?.eventId, "item-command-one");
  setProofReady(true);
  setCredentialReady(false);
  const recovered = await projectPendingScriptItems({
    platform,
    studio,
    tenantId: "tenant-one",
    instanceId: "studio-one",
  });
  assert.equal(recovered.projected, 1);
  setCredentialReady(true);
  assert.deepEqual(recovered.unresolved, []);
  assert.deepEqual(await studio.pendingItemDirectoryEvents("tenant-one"), []);
  const firstItem = await createScriptItem(itemCommand);
  assert.equal(firstItem.original.activityRevision, 2);
  const live = await studio.readProduction({
    credential: "alice",
    productionId: "production-one",
  });
  assert.equal(live.activityRevision, 2);
  assert.equal(live.items[0]?.versions[0]?.draft.text, "渡口停电。");
  await assert.rejects(
    studio.readProduction({
      credential: "bob",
      productionId: "production-one",
    }),
    /无权|权限/,
  );
  assert.equal(
    (await platform.content({ credential: "alice" }, first.contentId))
      .observed_version_ref,
    "2",
  );
  await assert.rejects(
    createScriptItem({
      ...itemCommand,
      draft: { ...itemCommand.draft, text: "改写" },
    }),
    /相同命令 ID/,
  );
  await assert.rejects(
    createScriptItem({
      ...itemCommand,
      actor: { credential: "bob" },
      commandId: "item-bob",
      itemId: "item-bob",
    }),
    /无权|权限/,
  );
  const sceneDraft = {
    ...emptyItemDraft("分场一"),
    parentId: "episode-one",
    dependencies: [{ itemId: "episode-one", revision: 1 }],
  };
  await assert.rejects(
    createScriptItem({
      ...itemCommand,
      actor: { credential: "agent-input" },
      commandId: "item-agent-body",
      itemId: "scene-invalid",
      expectedActivityRevision: 2,
      kind: "scene",
      draft: { ...sceneDraft, text: "不能直接写正文" },
    }),
    /只能建立空条目/,
  );
  const scene = await createScriptItem({
    ...itemCommand,
    actor: { credential: "agent-input" },
    commandId: "item-agent-scene",
    itemId: "scene-one",
    expectedActivityRevision: 2,
    kind: "scene",
    draft: sceneDraft,
  });
  assert.equal(scene.original.activityRevision, 3);
  const createdFromInput = await studio.inputDeliveryProductions("tenant-one", [
    "input-one",
  ]);
  const itemDeliveries = await studio.listInputDeliveries({
    credential: "alice",
    inputIds: ["input-one"],
    productionIds: createdFromInput,
  });
  assert.equal(itemDeliveries.length, 3);
  assert.equal(
    new Set(itemDeliveries.map((output) => output.commandId)).size,
    3,
  );
  assert.ok(
    itemDeliveries.every(
      (output) => output.kind === "item" && output.revision === 1,
    ),
  );
  assert.ok(itemDeliveries.some((output) => output.itemId === toolItem.itemId));
  assert.ok(
    itemDeliveries.some(
      (output) =>
        output.commandId === "item-agent-scene" &&
        output.itemId === "scene-one",
    ),
  );
  await assert.rejects(
    studio.listInputDeliveries({
      credential: "bob",
      inputIds: ["input-one"],
      productionIds: createdFromInput,
    }),
    /无权|权限/,
  );
  assert.equal(
    (await createScriptItem(itemCommand)).original.itemId,
    "episode-one",
  );
  await assert.rejects(
    createScriptItem({
      ...itemCommand,
      commandId: "item-stale",
      itemId: "stale-episode",
    }),
    /剧本已变化/,
  );
  await assert.rejects(
    createScriptItem({
      ...itemCommand,
      commandId: "item-unverified-source",
      itemId: "unverified-source",
      expectedActivityRevision: 3,
      draft: {
        ...emptyItemDraft("改编依据"),
        sources: [
          {
            appId: "morphz.objects",
            instanceId: "objects-one",
            objectId: "source-one",
            versionRef: "1",
            quote: "原文",
          },
        ],
      },
    }),
    /原件版本和引文尚未由所属应用核验/,
  );
  await assert.rejects(
    createScriptItem({
      ...itemCommand,
      commandId: "item-no-parent",
      itemId: "scene-no-parent",
      expectedActivityRevision: 3,
      kind: "scene",
      draft: emptyItemDraft("没有所属集"),
    }),
    /只有分场必须且可以指定所属集/,
  );
  const children = await studio.listItems({
    credential: "alice",
    productionId: "production-one",
    parentId: "episode-one",
  });
  assert.deepEqual(
    children.items.map((item) => item.itemId),
    ["scene-one"],
  );
  assert.equal(children.items[0]!.status, "draft");
  const revise = {
    platform,
    studio,
    actor: { credential: "alice" },
    instanceId: "studio-one",
    commandId: "revise-episode-one",
    productionId: "production-one",
    itemId: "episode-one",
    expectedRevision: 1,
    draft: { ...itemCommand.draft, text: "渡口恢复了供电。" },
  };
  setProofReady(false);
  await assert.rejects(reviseScriptItem(revise), /应用未确认/);
  assert.equal(
    (await studio.pendingItemDirectoryEvents("tenant-one"))[0]?.event_id,
    revise.commandId,
  );
  assert.equal(
    (
      await studio.readItemVersion({
        credential: "alice",
        productionId: "production-one",
        itemId: "episode-one",
      })
    ).draft.text,
    "渡口恢复了供电。",
  );
  setProofReady(true);
  setCredentialReady(false);
  assert.equal(
    (
      await projectPendingScriptItems({
        platform,
        studio,
        tenantId: "tenant-one",
        instanceId: "studio-one",
      })
    ).projected,
    1,
  );
  setCredentialReady(true);
  assert.equal((await reviseScriptItem(revise)).original.itemRevision, 2);
  assert.equal(
    (await platform.content({ credential: "alice" }, first.contentId))
      .observed_version_ref,
    "4",
  );
  const revised = await studio.readProduction({
    credential: "alice",
    productionId: "production-one",
  });
  assert.equal(
    revised.items.find((item) => item.id === "episode-one")?.revision,
    2,
  );
  assert.equal(
    revised.items.find((item) => item.id === "scene-one")?.workflowRevision,
    2,
  );
  await assert.rejects(
    reviseScriptItem({ ...revise, commandId: "revise-stale" }),
    /新版本/,
  );
  await assert.rejects(
    reviseScriptItem({
      ...revise,
      actor: { credential: "bob" },
      commandId: "revise-bob",
    }),
    /权限|获授权|无权/,
  );
  await assert.rejects(
    reviseScriptItem({
      ...revise,
      actor: { credential: "agent-input" },
      commandId: "revise-agent",
    }),
    /只有获授权的本人/,
  );
  await assert.rejects(
    reviseScriptItem({
      ...revise,
      commandId: "revise-cycle",
      expectedRevision: 2,
      draft: {
        ...revise.draft,
        dependencies: [{ itemId: "scene-one", revision: 1 }],
      },
    }),
    /形成循环/,
  );
  const settings = {
    platform,
    studio,
    actor: { credential: "alice" },
    instanceId: "studio-one",
    commandId: "settings-production-one",
    productionId: "production-one",
    expectedRevision: revised.revision,
    title: "渡河 · 新版",
    brief: { ...revised.brief, modelProcessingAllowed: true },
    reviewerPrincipalIds: revised.reviewerPrincipalIds,
    template: revised.template,
  };
  setProofReady(false);
  await assert.rejects(updateScriptProduction(settings), /应用未确认/);
  assert.equal(
    (await studio.pendingProductionUpdates("tenant-one"))[0]?.event_id,
    settings.commandId,
  );
  setProofReady(true);
  setCredentialReady(false);
  assert.equal(
    (
      await projectPendingScriptSettings({
        platform,
        studio,
        tenantId: "tenant-one",
        instanceId: "studio-one",
      })
    ).projected,
    1,
  );
  setCredentialReady(true);
  const updated = await updateScriptProduction(settings);
  assert.equal(updated.original.metadataRevision, 2);
  assert.equal(updated.original.activityRevision, 5);
  assert.equal(
    (await platform.content({ credential: "alice" }, first.contentId)).title,
    "渡河 · 新版",
  );
  assert.equal(
    (
      await studio.readProduction({
        credential: "alice",
        productionId: "production-one",
      })
    ).brief.modelProcessingAllowed,
    true,
  );
  assert.deepEqual(await studio.pendingProductionUpdates("tenant-one"), []);
  const generation = {
    productionId: "production-one",
    targetId: "episode-one",
    baseRevision: 2,
    contextRevision: 2,
    purpose: "rewrite" as const,
    references: [],
    maxCandidates: 1,
    maxOutputCharacters: 2000,
    maxReviewPasses: 1,
  };
  await studio.prepareGeneration({
    credential: "alice",
    commandId: "input-one",
    productionId: "production-one",
    inputId: "input-one",
    generation,
  });
  const generationTools = new PlatformAgentTools({
    authority: {
      withInvocation: async (
        _route: unknown,
        action: (
          actor: unknown,
          source: unknown,
          identity: unknown,
        ) => Promise<unknown>,
      ) =>
        action(
          { credential: "agent-input" },
          { projectId: "project-one", inputId: "input-one" },
          {
            principalId: "alice",
            humanActantId: "alice",
            agentActantId: "agent-one",
          },
        ),
    },
    inputForInvocation: async () => ({
      text: "改写第一集",
      scriptGeneration: generation,
    }),
    content: {
      platform,
      studio,
      instanceIds: { objects: "objects-one", scriptStudio: "studio-one" },
    },
  } as unknown as PlatformAgentDomain);
  const workflow = (await generationTools.call(scriptRoute, scope, {
    action: "script",
    script: { action: "read-workflow" },
  } as AgentToolArguments)) as {
    generating: boolean;
    target: { draft: { text: string } };
  };
  assert.equal(workflow.generating, true);
  assert.equal(workflow.target.draft.text, "渡口恢复了供电。");
  const candidateRoute = {
    ...scriptRoute,
    tool_call_id: "candidate-from-agent",
  } as HostInvocation;
  const submitted = (await generationTools.call(candidateRoute, scope, {
    action: "script",
    script: {
      action: "submit-workflow",
      payload: { ...emptyItemDraft("第一集"), text: "渡口再一次停电。" },
      explanation: "改写完成",
      checks: [
        { performed: true, revise: false, blocked: false, notes: "已核对" },
        { performed: false, revise: false, blocked: false, notes: "" },
      ],
    },
  } as AgentToolArguments)) as { candidateId: string; kind: string };
  assert.equal(submitted.kind, "candidate");
  assert.equal(
    (
      await studio.readProductionOverview({
        credential: "alice",
        productionId: "production-one",
      })
    ).progress.pendingCandidates,
    1,
  );
  const results = (await generationTools.call(
    { ...scriptRoute, tool_call_id: "read-results" },
    scope,
    {
      action: "script",
      script: { action: "read-results", offset: 0, limit: 20 },
    } as AgentToolArguments,
  )) as { total: number; results: Array<{ id: string }> };
  assert.equal(results.total, 1);
  assert.equal(results.results[0]?.id, submitted.candidateId);
  const result = (await generationTools.call(
    { ...scriptRoute, tool_call_id: "read-result" },
    scope,
    {
      action: "script",
      script: {
        action: "read-result",
        resultId: submitted.candidateId,
        offset: 0,
        limit: 24_000,
      },
    } as AgentToolArguments,
  )) as { resultJson: string };
  assert.equal(JSON.parse(result.resultJson).draft.text, "渡口再一次停电。");
  // Exercise the Runtime-facing Host router, not just the app-domain method:
  // a completed workflow must remain discoverable for idempotent recovery.
  const hostTools = new AgentTools({
    token: "test-token",
    resolveScope: () => scope,
    platformAgent: generationTools,
  });
  const invocation = {
    ...scriptRoute,
    session_id: "session-one",
    principal_id: "alice",
    agent_id: "agent-one",
    thread_id: "thread-one",
    target_id: "target-one",
  };
  const callHost = (arguments_: object) =>
    hostTools.call({
      protocol: 1,
      tool: "host_morphz",
      invocation,
      arguments: arguments_,
    });
  const discovered = (await callHost({
    action: "operations",
    operations: { action: "list", domain: "script" },
  })) as { operations: Array<{ id: string }> };
  assert.ok(
    discovered.operations.some((op) => op.id === "script.read-workflow"),
  );
  assert.ok(
    discovered.operations.some((op) => op.id === "script.read-results"),
  );
  assert.ok(discovered.operations.some((op) => op.id === "script.read-result"));
  const routedWorkflow = (await callHost({
    action: "operations",
    operations: {
      action: "invoke",
      operationId: "script.read-workflow",
      parameters: {},
    },
  })) as { generating: boolean; target: { draft: { text: string } } };
  assert.equal(routedWorkflow.generating, true);
  assert.equal(routedWorkflow.target.draft.text, "渡口恢复了供电。");
  const hostRecovered = (await callHost({
    action: "operations",
    operations: {
      action: "invoke",
      operationId: "script.read-results",
      parameters: { offset: 0, limit: 20 },
    },
  })) as { total: number; results: Array<{ id: string }> };
  assert.equal(hostRecovered.total, 1);
  assert.equal(hostRecovered.results[0]?.id, submitted.candidateId);
  const recoveredResult = (await callHost({
    action: "operations",
    operations: {
      action: "invoke",
      operationId: "script.read-result",
      parameters: {
        resultId: submitted.candidateId,
        offset: 0,
        limit: 24_000,
      },
    },
  })) as { resultJson: string };
  assert.equal(
    JSON.parse(recoveredResult.resultJson).draft.text,
    "渡口再一次停电。",
  );
  assert.equal(
    (
      await studio.readItemVersion({
        credential: "alice",
        productionId: "production-one",
        itemId: "episode-one",
      })
    ).draft.text,
    "渡口恢复了供电。",
  );
  const restored = await restoreScriptItem({
    platform,
    studio,
    actor: { credential: "alice" },
    instanceId: "studio-one",
    commandId: "restore-episode-one",
    productionId: "production-one",
    itemId: "episode-one",
    expectedRevision: 2,
    restoreRevision: 1,
  });
  assert.equal(restored.original.itemRevision, 3);
  assert.equal(
    (
      await studio.readItemVersion({
        credential: "alice",
        productionId: "production-one",
        itemId: "episode-one",
      })
    ).draft.text,
    "渡口停电。",
  );
  assert.deepEqual(
    await restoreScriptItem({
      platform,
      studio,
      actor: { credential: "alice" },
      instanceId: "studio-one",
      commandId: "restore-episode-one",
      productionId: "production-one",
      itemId: "episode-one",
      expectedRevision: 2,
      restoreRevision: 1,
    }),
    restored,
  );
  await assert.rejects(
    restoreScriptItem({
      platform,
      studio,
      actor: { credential: "alice" },
      instanceId: "studio-one",
      commandId: "restore-stale",
      productionId: "production-one",
      itemId: "episode-one",
      expectedRevision: 2,
      restoreRevision: 1,
    }),
    /新版本/,
  );
  const workflowSnapshot = await studio.readProduction({
    credential: "alice",
    productionId: "production-one",
  });
  const workflowItem = workflowSnapshot.items.find(
    (item) => item.id === "episode-one",
  )!;
  const workflowBase = {
    platform,
    studio,
    actor: { credential: "alice" },
    instanceId: "studio-one",
    productionId: "production-one",
    itemId: "episode-one",
    expectedRevision: 3,
    expectedWorkflowRevision: workflowItem.workflowRevision,
  };
  const submitReview = {
    ...workflowBase,
    commandId: "submit-review-one",
    action: "submit-review" as const,
  };
  setProofReady(false);
  await assert.rejects(transitionScriptWorkflow(submitReview), /应用未确认/);
  assert.equal(
    (await studio.pendingWorkflowDirectoryEvents("tenant-one"))[0]?.event_id,
    "submit-review-one",
  );
  setProofReady(true);
  setCredentialReady(false);
  assert.equal(
    (
      await projectPendingScriptWorkflow({
        platform,
        studio,
        tenantId: "tenant-one",
        instanceId: "studio-one",
      })
    ).projected,
    1,
  );
  setCredentialReady(true);
  const submittedReview = await transitionScriptWorkflow(submitReview);
  assert.deepEqual(
    await transitionScriptWorkflow(submitReview),
    submittedReview,
  );
  assert.equal(
    (
      await studio.readProduction({
        credential: "alice",
        productionId: "production-one",
      })
    ).items.find((item) => item.id === "episode-one")?.status,
    "in-review",
  );
  await assert.rejects(
    transitionScriptWorkflow({
      ...workflowBase,
      commandId: "review-agent",
      actor: { credential: "agent-input" },
      action: "review-decision",
      decision: "approve",
      expectedWorkflowRevision: workflowItem.workflowRevision + 1,
    }),
    /只有获授权的本人/,
  );
  const approved = await transitionScriptWorkflow({
    ...workflowBase,
    commandId: "review-approve-one",
    action: "review-decision",
    decision: "approve",
    expectedWorkflowRevision: workflowItem.workflowRevision + 1,
  });
  assert.equal(
    approved.original.activityRevision,
    submittedReview.original.activityRevision + 1,
  );
  await transitionScriptWorkflow({
    ...workflowBase,
    commandId: "lock-one",
    action: "lock-item",
    expectedWorkflowRevision: workflowItem.workflowRevision + 2,
  });
  assert.equal(
    (
      await studio.readProduction({
        credential: "alice",
        productionId: "production-one",
      })
    ).items.find((item) => item.id === "episode-one")?.status,
    "locked",
  );
  await assert.rejects(
    transitionScriptWorkflow({
      ...workflowBase,
      commandId: "unlock-no-reason",
      action: "unlock-item",
      expectedWorkflowRevision: workflowItem.workflowRevision + 3,
    }),
    /审阅操作或说明无效/,
  );
  await transitionScriptWorkflow({
    ...workflowBase,
    commandId: "unlock-one",
    action: "unlock-item",
    note: "继续修订",
    expectedWorkflowRevision: workflowItem.workflowRevision + 3,
  });
  const unlocked = await studio.readProduction({
    credential: "alice",
    productionId: "production-one",
  });
  assert.equal(
    unlocked.items.find((item) => item.id === "episode-one")?.status,
    "draft",
  );
  assert.equal(
    unlocked.items.find((item) => item.id === "scene-one")?.workflowRevision,
    workflowSnapshot.items.find((item) => item.id === "scene-one")!
      .workflowRevision + 1,
  );
  await transitionScriptWorkflow({
    ...workflowBase,
    commandId: "submit-review-two",
    action: "submit-review",
    expectedWorkflowRevision: workflowItem.workflowRevision + 4,
  });
  await transitionScriptWorkflow({
    ...workflowBase,
    commandId: "review-return-two",
    action: "review-decision",
    decision: "request-changes",
    note: "请调整节奏",
    expectedWorkflowRevision: workflowItem.workflowRevision + 5,
  });
  assert.equal(
    (
      await studio.readProduction({
        credential: "alice",
        productionId: "production-one",
      })
    ).items.find((item) => item.id === "episode-one")?.status,
    "draft",
  );
  const addReview = {
    platform,
    studio,
    actor: { credential: "alice" },
    instanceId: "studio-one",
    commandId: "review-add-one",
    productionId: "production-one",
    action: "add-review" as const,
    itemId: "episode-one",
    itemRevision: 3,
    quote: "渡口停电",
    body: "需要核对时间线",
    severity: "blocking" as const,
  };
  setProofReady(false);
  await assert.rejects(changeScriptReview(addReview), /应用未确认/);
  assert.equal(
    (await studio.pendingReviewDirectoryEvents("tenant-one"))[0]?.event_id,
    "review-add-one",
  );
  setProofReady(true);
  setCredentialReady(false);
  assert.equal(
    (
      await projectPendingScriptReviews({
        platform,
        studio,
        tenantId: "tenant-one",
        instanceId: "studio-one",
      })
    ).projected,
    1,
  );
  setCredentialReady(true);
  const reviewReceipt = await changeScriptReview(addReview);
  assert.deepEqual(await changeScriptReview(addReview), reviewReceipt);
  assert.equal(
    (
      await studio.readProduction({
        credential: "alice",
        productionId: "production-one",
      })
    ).reviews.find((review) => review.id === "review-add-one")?.body,
    "需要核对时间线",
  );
  await assert.rejects(
    changeScriptReview({
      ...addReview,
      commandId: "review-add-bad",
      itemRevision: 2,
      quote: "不存在的引文",
    }),
    /锚定有效正文版本/,
  );
  const resolveReview = {
    platform,
    studio,
    actor: { credential: "alice" },
    instanceId: "studio-one",
    commandId: "review-resolve-one",
    productionId: "production-one",
    action: "resolve-review" as const,
    reviewId: "review-add-one",
    expectedRevision: 1,
    resolution: "时间线已核对",
  };
  await changeScriptReview(resolveReview);
  assert.equal(
    (
      await studio.readProduction({
        credential: "alice",
        productionId: "production-one",
      })
    ).reviews.find((review) => review.id === "review-add-one")?.resolution,
    "时间线已核对",
  );
  await assert.rejects(
    changeScriptReview({ ...resolveReview, commandId: "review-resolve-stale" }),
    /已变化或已处理/,
  );
  const reviewGeneration = {
    productionId: "production-one",
    targetId: "episode-one",
    baseRevision: 3,
    contextRevision: 2,
    purpose: "continuity" as const,
    references: [],
    maxCandidates: 1,
    maxOutputCharacters: 2000,
    maxReviewPasses: 1,
  };
  await studio.prepareGeneration({
    credential: "alice",
    commandId: "input-review",
    productionId: "production-one",
    inputId: "input-review",
    generation: reviewGeneration,
  });
  const reviewAgentTools = new PlatformAgentTools({
    authority: {
      withInvocation: async (
        _route: unknown,
        action: (
          actor: unknown,
          source: unknown,
          identity: unknown,
        ) => Promise<unknown>,
      ) =>
        action(
          { credential: "agent-review-input" },
          { projectId: "project-one", inputId: "input-review" },
          {
            principalId: "alice",
            humanActantId: "alice",
            agentActantId: "agent-one",
          },
        ),
    },
    inputForInvocation: async () => ({
      text: "检查连续性",
      scriptGeneration: reviewGeneration,
    }),
    content: {
      platform,
      studio,
      instanceIds: { objects: "objects-one", scriptStudio: "studio-one" },
    },
  } as unknown as PlatformAgentDomain);
  const reviewScope = { ...scope, inputId: "input-review" } as ToolScope;
  const reviewRoute = {
    ...scriptRoute,
    tool_call_id: "batch-review",
  } as HostInvocation;
  const reviewPayload = [
    {
      action: "add-review",
      productionId: "production-one",
      itemId: "episode-one",
      itemRevision: 3,
      quote: "渡口停电",
      body: "连续性符合设定",
      severity: "note",
    },
    {
      action: "add-review",
      productionId: "production-one",
      itemId: "episode-one",
      itemRevision: 3,
      quote: "停电",
      body: "留意后续呼应",
      severity: "warning",
    },
  ];
  await assert.rejects(
    reviewAgentTools.call(reviewRoute, reviewScope, {
      action: "script",
      script: {
        action: "submit-workflow",
        payload: [
          ...reviewPayload.slice(0, 1),
          { ...reviewPayload[1], quote: "不存在" },
        ],
        explanation: "已核对",
        checks: [
          { performed: true, revise: false, blocked: false, notes: "已检查" },
          { performed: false, revise: false, blocked: false, notes: "" },
        ],
      },
    } as AgentToolArguments),
    /锚定有效正文版本/,
  );
  assert.equal(
    (
      await studio.readProduction({
        credential: "alice",
        productionId: "production-one",
      })
    ).reviews.length,
    1,
  );
  const agentReviewRequest = {
    action: "script",
    script: {
      action: "submit-workflow",
      payload: reviewPayload,
      explanation: "已核对",
      checks: [
        { performed: true, revise: false, blocked: false, notes: "已检查" },
        { performed: false, revise: false, blocked: false, notes: "" },
      ],
    },
  } as AgentToolArguments;
  setProofReady(false);
  await assert.rejects(
    reviewAgentTools.call(reviewRoute, reviewScope, agentReviewRequest),
    /应用未确认/,
  );
  assert.equal(
    (await studio.pendingReviewDirectoryEvents("tenant-one")).length,
    1,
  );
  setProofReady(true);
  setCredentialReady(false);
  assert.equal(
    (
      await projectPendingScriptReviews({
        platform,
        studio,
        tenantId: "tenant-one",
        instanceId: "studio-one",
      })
    ).projected,
    1,
  );
  setCredentialReady(true);
  const agentReviewResult = (await reviewAgentTools.call(
    reviewRoute,
    reviewScope,
    agentReviewRequest,
  )) as { kind: string; reviewIds: string[] };
  assert.equal(agentReviewResult.kind, "review");
  assert.equal(agentReviewResult.reviewIds.length, 2);
  const reviewDeliveries = await studio.listInputDeliveries({
    credential: "alice",
    inputIds: ["input-review"],
    productionIds: await studio.inputDeliveryProductions("tenant-one", [
      "input-review",
    ]),
  });
  assert.deepEqual(
    reviewDeliveries.map((output) => ({
      kind: output.kind,
      reviewId: output.reviewId,
      itemId: output.itemId,
    })),
    agentReviewResult.reviewIds.map((reviewId) => ({
      kind: "review",
      reviewId,
      itemId: "episode-one",
    })),
  );
  const deliveryStore = new WorkspaceStore(":memory:", { mode: "transport" });
  try {
    let visibleInputIds = ["input-review"];
    const runtime = {
      teamIdentity: false,
      async platformConversationHistory() {
        return {
          inputs: visibleInputIds.map((id) => ({ id })),
          nextCursor: null,
          runtime: {
            configured: true,
            connected: true,
            messages: [],
            deliveries: [],
          },
        };
      },
    } as unknown as RuntimeBridge;
    const scriptDomain = {
      authority: {
        tenantId: "tenant-one",
        withSession<T>(
          _access: unknown,
          _assertActive: () => void,
          action: (actor: { credential: string }) => Promise<T>,
        ) {
          return action({ credential: "alice" });
        },
      },
      platform,
      studio,
      instanceIds: { scriptStudio: "studio-one" },
    } as unknown as NonNullable<ApplicationOptions["platformScripts"]>;
    const history = () =>
      new Application(deliveryStore, {
        runtime,
        platformScripts: scriptDomain,
      })
        .session({ principalId: "alice", actantId: "alice" })
        .platformConversationHistory({
          projectId: "project-one",
          conversationId: "project-one",
        });
    assert.deepEqual(
      (await history()).scriptOutputs.map((output) => output.reviewId),
      agentReviewResult.reviewIds,
      "正式消息入口从当前 Runtime 可见输入和应用回执恢复每条审阅",
    );
    visibleInputIds = ["input-one"];
    assert.deepEqual(
      (await history()).scriptOutputs,
      await studio.listInputDeliveries({
        credential: "alice",
        inputIds: ["input-one"],
        productionIds: await studio.inputDeliveryProductions("tenant-one", [
          "input-one",
        ]),
      }),
    );
    visibleInputIds = ["other-input"];
    assert.deepEqual((await history()).scriptOutputs, []);
  } finally {
    deliveryStore.close();
  }
  assert.deepEqual(
    await reviewAgentTools.call(reviewRoute, reviewScope, agentReviewRequest),
    agentReviewResult,
  );
  assert.equal(
    (
      await studio.readProduction({
        credential: "alice",
        productionId: "production-one",
      })
    ).reviews.length,
    3,
  );
  const exportRequest = {
    platform,
    studio,
    actor: { credential: "alice" },
    instanceId: "studio-one",
    commandId: "export-one",
    productionId: "production-one",
    expectedRevision: 2,
    items: [{ itemId: "episode-one", revision: 3 }],
    template: revised.template,
    workingCopy: true as const,
  };
  setProofReady(false);
  await assert.rejects(recordScriptExport(exportRequest), /应用未确认/);
  assert.equal(
    (await studio.pendingExportDirectoryEvents("tenant-one"))[0]?.event_id,
    "export-one",
  );
  setProofReady(true);
  setCredentialReady(false);
  assert.equal(
    (
      await projectPendingScriptExports({
        platform,
        studio,
        tenantId: "tenant-one",
        instanceId: "studio-one",
      })
    ).projected,
    1,
  );
  setCredentialReady(true);
  const exportReceipt = await recordScriptExport(exportRequest);
  assert.equal(exportReceipt.original.exportId, "export-one");
  assert.deepEqual(await recordScriptExport(exportRequest), exportReceipt);
  assert.equal(
    (await platform.content({ credential: "alice" }, first.contentId))
      .observed_version_ref,
    exportReceipt.original.versionRef,
  );
  const beforeRename = await platform.content(
    { credential: "alice" },
    first.contentId,
  );
  const originalOverview = await studio.readProductionOverview({
    credential: "alice",
    productionId: "production-one",
  });
  const rename = {
    platform,
    studio,
    actor: { credential: "alice" },
    instanceId: "studio-one",
    commandId: "rename-production-one",
    productionId: "production-one",
    expectedCatalogRevision: beforeRename.revision,
    currentCatalogRevision: beforeRename.revision,
    expectedActivityRevision: Number(beforeRename.observed_version_ref),
    title: "渡河 · 改名",
  };
  setProofReady(false);
  await assert.rejects(renameScriptProduction(rename), /应用未确认/);
  const renamedOverview = await studio.readProductionOverview({
    credential: "alice",
    productionId: "production-one",
  });
  assert.equal(renamedOverview.title, rename.title);
  assert.equal(renamedOverview.creativeEpoch, originalOverview.creativeEpoch);
  assert.deepEqual(renamedOverview.brief, originalOverview.brief);
  assert.deepEqual(renamedOverview.template, originalOverview.template);
  assert.deepEqual(
    renamedOverview.reviewerPrincipalIds,
    originalOverview.reviewerPrincipalIds,
  );
  assert.equal(
    renamedOverview.metadataRevision,
    originalOverview.metadataRevision + 1,
  );
  setProofReady(true);
  setCredentialReady(false);
  assert.equal(
    (
      await projectPendingScriptSettings({
        platform,
        studio,
        tenantId: "tenant-one",
        instanceId: "studio-one",
      })
    ).projected,
    1,
  );
  setCredentialReady(true);
  const renamed = await renameScriptProduction({
    ...rename,
    currentCatalogRevision: beforeRename.revision + 1,
    expectedActivityRevision: rename.expectedActivityRevision + 1,
  });
  assert.equal(
    renamed.original.versionRef,
    String(rename.expectedActivityRevision + 1),
  );
  assert.equal(
    (await platform.content({ credential: "alice" }, first.contentId)).title,
    rename.title,
  );
  await assert.rejects(
    renameScriptProduction({
      ...rename,
      commandId: "stale-rename-production",
      currentCatalogRevision: beforeRename.revision + 1,
    }),
    /目录已变化/,
  );
  const currentCatalog = await platform.content(
    { credential: "alice" },
    first.contentId,
  );
  const renameTools = new PlatformAgentTools({
    authority: {
      withInvocation: async (
        _route: unknown,
        action: (
          actor: unknown,
          source: unknown,
          identity: unknown,
        ) => Promise<unknown>,
      ) =>
        action(
          { credential: "agent-rename-input" },
          { projectId: "project-one", inputId: "input-rename" },
          {
            tenantId: "tenant-one",
            principalId: "alice",
            humanActantId: "alice",
            agentActantId: "agent-one",
          },
        ),
    },
    content: {
      platform,
      studio,
      instanceIds: { objects: "objects-one", scriptStudio: "studio-one" },
    },
  } as unknown as PlatformAgentDomain);
  const agentRename = (await renameTools.call(
    { ...scriptRoute, tool_call_id: "agent-rename-script" },
    { ...scope, inputId: "input-rename" },
    {
      action: "organize-content",
      content: { kind: "script", id: "production-one" },
      revision: currentCatalog.revision,
      metadata: { title: "聊天改名后的剧本" },
    } as AgentToolArguments,
  )) as { contentId: string; catalogRevision: number };
  assert.equal(agentRename.contentId, first.contentId);
  assert.equal(agentRename.catalogRevision, currentCatalog.revision + 1);
  assert.equal(
    (await platform.content({ credential: "alice" }, first.contentId)).title,
    "聊天改名后的剧本",
  );
}

test("SQLite：剧本原件与 Platform 目录跨库失败后同命令恢复", async () => {
  let studio!: ScriptStudioStore;
  let proofReady = false;
  let credentialReady = true;
  const platform = await PlatformStore.sqlite(
    ":memory:",
    fixtureAuthority(
      () => studio,
      () => proofReady,
      () => credentialReady,
    ),
  );
  try {
    studio = await ScriptStudioStore.sqlite(
      ":memory:",
      platformScriptStudioAuthority(platform, "studio-one", () => ({
        routeKind: "service",
        routeRef: "test:studio-one",
      })),
    );
    try {
      await exercise(
        platform,
        studio,
        (ready) => {
          proofReady = ready;
        },
        (ready) => {
          credentialReady = ready;
        },
      );
    } finally {
      await studio.close();
    }
  } finally {
    await platform.close();
  }
});

test("SQLite：待投影剧本逐页恢复，不凭事件冒充授权或重复创建", async () => {
  let studio!: ScriptStudioStore;
  let proofReady = false;
  const platform = await PlatformStore.sqlite(
    ":memory:",
    fixtureAuthority(
      () => studio,
      () => proofReady,
    ),
  );
  try {
    studio = await ScriptStudioStore.sqlite(
      ":memory:",
      platformScriptStudioAuthority(platform, "studio-one", () => ({
        routeKind: "service",
        routeRef: "test:studio-one",
      })),
    );
    await platform.provisionTenant("tenant-one");
    await platform.createProject(
      { credential: "alice" },
      {
        commandId: "recovery-project",
        projectId: "project-one",
        title: "恢复目录",
      },
    );
    await platform.registerApplication("tenant-one", {
      appId: "morphz.script-studio",
      installationId: "install-studio-one",
      instanceId: "studio-one",
      routeKind: "service",
      routeRef: "test:studio-one",
    });
    for (const suffix of ["one", "two"]) {
      await assert.rejects(
        createScriptProduction({
          platform,
          studio,
          actor: { credential: "alice" },
          instanceId: "studio-one",
          commandId: `recovery-script-${suffix}`,
          productionId: `recovery-production-${suffix}`,
          projectId: "project-one",
          title: `剧本 ${suffix}`,
        }),
        /应用未确认/,
      );
    }
    const request = {
      platform,
      studio,
      tenantId: "tenant-one",
      instanceId: "studio-one",
      limit: 1,
    };
    const withoutProof = await projectPendingScriptDirectory(request);
    assert.equal(withoutProof.examined, 1);
    assert.equal(withoutProof.projected, 0);
    assert.equal(withoutProof.unresolved.length, 1);
    assert.equal((await studio.pendingDirectoryEvents("tenant-one")).length, 2);

    proofReady = true;
    await assert.rejects(
      platform.recordCommittedContent(
        {
          tenantId: "tenant-one",
          principalId: "bob",
          actantId: "bob",
          runtimeInputId: null,
          instanceId: "studio-one",
          receiptId: "recovery-script-one",
        },
        {
          objectId: "recovery-production-one",
          projectId: "project-one",
          kind: "script",
          title: "剧本 one",
          observedVersionRef: "1",
        },
      ),
      /应用未确认/,
    );
    assert.equal((await studio.pendingDirectoryEvents("tenant-one")).length, 2);

    const first = await projectPendingScriptDirectory(request);
    assert.equal(first.projected, 1);
    assert.deepEqual(first.unresolved, []);
    assert.ok(first.nextCursor);
    const second = await projectPendingScriptDirectory({
      ...request,
      after: first.nextCursor!,
    });
    assert.equal(second.projected, 1);
    assert.deepEqual(await studio.pendingDirectoryEvents("tenant-one"), []);
    for (const suffix of ["one", "two"]) {
      const result = await createScriptProduction({
        platform,
        studio,
        actor: { credential: "alice" },
        instanceId: "studio-one",
        commandId: `recovery-script-${suffix}`,
        productionId: `recovery-production-${suffix}`,
        projectId: "project-one",
        title: `剧本 ${suffix}`,
      });
      assert.equal(
        (await platform.content({ credential: "alice" }, result.contentId))
          .app_object_id,
        `recovery-production-${suffix}`,
      );
    }
  } finally {
    await studio?.close().catch(() => undefined);
    await platform.close();
  }
});

test("SQLite：应用提交后重启，目录补偿沿用原回执", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-script-cross-store-"));
  const platformFile = join(directory, "platform.sqlite");
  const studioFile = join(directory, "studio.sqlite");
  let studio!: ScriptStudioStore;
  let proofReady = false;
  let credentialReady = true;
  let platform = await PlatformStore.sqlite(
    platformFile,
    fixtureAuthority(
      () => studio,
      () => proofReady,
      () => credentialReady,
    ),
  );
  try {
    studio = await ScriptStudioStore.sqlite(
      studioFile,
      platformScriptStudioAuthority(platform, "studio-one", () => ({
        routeKind: "service",
        routeRef: "test:studio-one",
      })),
    );
    await platform.provisionTenant("tenant-one");
    await platform.createProject(
      { credential: "alice" },
      {
        commandId: "restart-project",
        projectId: "project-one",
        title: "重启测试",
      },
    );
    await platform.registerApplication("tenant-one", {
      appId: "morphz.script-studio",
      installationId: "install-studio-one",
      instanceId: "studio-one",
      routeKind: "service",
      routeRef: "test:studio-one",
    });
    const command = {
      platform,
      studio,
      actor: { credential: "alice" },
      instanceId: "studio-one",
      commandId: "restart-script",
      productionId: "restart-production",
      projectId: "project-one",
      title: "断点剧本",
    };
    await assert.rejects(createScriptProduction(command), /应用未确认/);
    await studio.close();
    await platform.close();

    platform = await PlatformStore.sqlite(
      platformFile,
      fixtureAuthority(
        () => studio,
        () => proofReady,
        () => credentialReady,
      ),
    );
    studio = await ScriptStudioStore.sqlite(
      studioFile,
      platformScriptStudioAuthority(platform, "studio-one", () => ({
        routeKind: "service",
        routeRef: "test:studio-one",
      })),
    );
    assert.equal((await studio.pendingDirectoryEvents("tenant-one")).length, 1);
    proofReady = true;
    credentialReady = false;
    const recovery = await projectPendingScriptDirectory({
      platform,
      studio,
      tenantId: "tenant-one",
      instanceId: "studio-one",
    });
    assert.equal(recovery.projected, 1);
    assert.deepEqual(recovery.unresolved, []);
    credentialReady = true;
    const result = await createScriptProduction({
      ...command,
      platform,
      studio,
    });
    assert.equal(
      (await platform.content({ credential: "alice" }, result.contentId))
        .app_object_id,
      "restart-production",
    );
    assert.deepEqual(await studio.pendingDirectoryEvents("tenant-one"), []);
  } finally {
    await studio?.close().catch(() => undefined);
    await platform?.close().catch(() => undefined);
    rmSync(directory, { recursive: true });
  }
});

test(
  "PostgreSQL：剧本原件与 Platform 目录跨 schema 同命令恢复",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
    });
    const suffix = randomUUID().replaceAll("-", "");
    const platformSchema = `morphz_platform_${suffix}`;
    const studioSchema = `morphz_studio_${suffix}`;
    const client = await pool.connect();
    let platform: PlatformStore | undefined;
    let studio: ScriptStudioStore | undefined;
    let proofReady = false;
    let credentialReady = true;
    try {
      await client.query(`CREATE SCHEMA "${platformSchema}"`);
      await client.query(`CREATE SCHEMA "${studioSchema}"`);
      platform = await PlatformStore.postgres(
        {
          connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
          schema: platformSchema,
        },
        fixtureAuthority(
          () => studio!,
          () => proofReady,
          () => credentialReady,
        ),
      );
      studio = await ScriptStudioStore.postgres({
        connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
        schema: studioSchema,
        authority: platformScriptStudioAuthority(
          platform,
          "studio-one",
          () => ({ routeKind: "service", routeRef: "test:studio-one" }),
        ),
      });
      await exercise(
        platform,
        studio,
        (ready) => {
          proofReady = ready;
        },
        (ready) => {
          credentialReady = ready;
        },
      );
    } finally {
      await studio?.close();
      await platform?.close();
      await client.query(`DROP SCHEMA IF EXISTS "${studioSchema}" CASCADE`);
      await client.query(`DROP SCHEMA IF EXISTS "${platformSchema}" CASCADE`);
      client.release();
      await pool.end();
    }
  },
);

test("Agent 剧本目录跨页只读取所需的授权窗口", async () => {
  const records = Array.from({ length: 105 }, (_, index) => ({
    id: `content-${String(index).padStart(3, "0")}`,
    appObjectId: `script-${String(index).padStart(3, "0")}`,
    projectId: index % 2 === 0 ? "project-one" : "project-two",
    title: `合成剧本 ${index}`,
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  }));
  const pages: Array<{
    projectId?: string;
    appId: string;
    kind: string;
    availability: string;
    query: string;
    limit: number;
    before?: { key: string; contentId: string };
  }> = [];
  const tools = new PlatformAgentTools({
    authority: {
      withInvocation: async (
        _route: unknown,
        action: (
          actor: unknown,
          source: unknown,
          identity: unknown,
        ) => Promise<unknown>,
      ) =>
        action(
          { credential: "agent-input" },
          { projectId: "project-one", inputId: null },
          { tenantId: "tenant-one", principalId: "alice" },
        ),
    },
    work: {
      contentCounts: async (_actor: unknown, filter: unknown) => {
        assert.deepEqual(filter, {
          appId: "morphz.script-studio",
          kind: "script",
          availability: "available",
          query: "合成",
        });
        return [
          { projectId: "project-one", count: 53 },
          { projectId: "project-two", count: 52 },
        ];
      },
      listContent: async (_actor: unknown, options: (typeof pages)[number]) => {
        pages.push(options);
        const start = options.before
          ? Number(options.before.contentId.slice(-3)) + 1
          : 0;
        return records.slice(start, start + options.limit);
      },
    },
    content: {
      studio: {},
      instanceIds: { scriptStudio: "studio-one" },
    },
  } as unknown as PlatformAgentDomain);
  const result = (await tools.call(
    {} as HostInvocation,
    { platform: true, projectId: "project-one" } as ToolScope,
    {
      action: "script",
      script: { action: "list", query: "合成", offset: 99, limit: 5 },
    } as AgentToolArguments,
  )) as {
    total: number;
    hasMore: boolean;
    items: Array<{ id: string; projectId: string }>;
  };
  assert.equal(result.total, 105);
  assert.equal(result.hasMore, true);
  assert.deepEqual(
    result.items.map((item) => item.id),
    records.slice(99, 104).map((record) => record.appObjectId),
  );
  assert.deepEqual(
    pages.map((page) => page.limit),
    [100, 4],
  );
  assert.deepEqual(pages[1]?.before, {
    key: records[99]!.updatedAt,
    contentId: records[99]!.id,
  });
  assert.ok(pages.every((page) => page.projectId === undefined));
  assert.deepEqual(
    result.items.map((item) => item.projectId),
    records.slice(99, 104).map((record) => record.projectId),
  );
});
