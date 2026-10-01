import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  defaultScriptExportTemplate,
  emptyScriptBrief,
  emptyScriptDraft,
} from "../packages/core/src/script-studio.js";
import {
  PlatformStore,
  type PlatformAuthorityVerifier,
} from "../packages/platform/src/store.js";
import {
  ScriptStudioStore,
  type LiveScriptDraft,
  type ScriptStudioAuthority,
} from "../packages/script-studio/src/store.js";
import { ObjectsStore } from "../packages/objects/src/store.js";
import { platformObjectsAuthority } from "../packages/application/src/document-service.js";
import {
  decideScriptCandidate,
  objectsScriptSourceVerifier,
  platformScriptStudioAuthority,
  projectPendingScriptCandidateDecisions,
} from "../packages/application/src/script-production-service.js";

const alice = { principalId: "alice", actantId: "alice" };
const agent = { principalId: "alice", actantId: "agent-one" };
const episode = { ...emptyScriptDraft("第一集"), text: "夜里到达渡口。" };
const scene = {
  ...emptyScriptDraft("渡口"),
  parentId: "episode-one",
  dependencies: [{ itemId: "episode-one", revision: 1 }],
  text: "小明不敢上船。",
};
const revisedScene = { ...scene, text: "小明还是上了船。" };
const nextScene = {
  ...emptyScriptDraft("对岸"),
  parentId: "episode-one",
  dependencies: [
    { itemId: "episode-one", revision: 1 },
    { itemId: "scene-one", revision: 1 },
  ],
  text: "船抵达对岸。",
};

const productionContentId = "content-production-one";
type CandidateSeed = {
  id: string;
  sources?: LiveScriptDraft["sources"];
  expectedError?: RegExp;
};

/** Build current immutable state through the same domain commits as Clients,
 * never by inserting a whole old production or forged projection receipt. */
async function createDecisionFixture(
  studio: ScriptStudioStore,
  platform?: PlatformStore,
  options: {
    approve?: boolean;
    sceneSources?: LiveScriptDraft["sources"];
    referenceSources?: LiveScriptDraft["sources"];
    candidates?: CandidateSeed[];
  } = {},
) {
  const created = await studio.createProduction({
    credential: "alice",
    commandId: "fixture-production-created",
    productionId: "production-one",
    requestedProjectId: "project-one",
    title: "渡河",
  });
  if (platform)
    await platform.recordContent(
      { credential: "alice" },
      { instanceId: "studio-one", proof: created.receiptId },
      {
        commandId: "fixture-production-catalog",
        appReceiptId: created.receiptId,
        contentId: productionContentId,
        objectId: "production-one",
        projectId: "project-one",
        kind: "script",
        title: created.title,
        observedVersionRef: created.versionRef,
      },
    );
  await studio.markDirectoryProjected(created.tenantId, created.eventId);
  async function project(
    receipt: {
      tenantId: string;
      eventId: string;
      receiptId: string;
      title: string;
      versionRef: string;
    },
    credential = "alice",
  ) {
    if (platform) {
      const catalog = await platform.content(
        { credential },
        productionContentId,
      );
      await platform.refreshContent(
        { credential },
        { instanceId: "studio-one", proof: receipt.receiptId },
        {
          commandId: `fixture-project-${receipt.receiptId}`,
          appReceiptId: receipt.receiptId,
          contentId: productionContentId,
          expectedCatalogRevision: catalog.revision,
          title: receipt.title,
          observedVersionRef: receipt.versionRef,
        },
      );
    }
    await studio.markDirectoryProjected(receipt.tenantId, receipt.eventId);
  }
  const metadata = await studio.updateProduction({
    credential: "alice",
    commandId: "fixture-model-permission",
    productionId: "production-one",
    expectedRevision: 1,
    title: "渡河",
    brief: { ...emptyScriptBrief, modelProcessingAllowed: true },
    reviewerPrincipalIds: ["alice"],
    template: defaultScriptExportTemplate,
  });
  assert.ok(metadata.eventId);
  await project({ ...metadata, eventId: metadata.eventId });
  for (const [itemId, kind, draft] of [
    ["episode-one", "episode", episode],
    ["scene-one", "scene", scene],
    ["scene-two", "scene", nextScene],
  ] as const) {
    const head = await studio.readProductionOverview({
      credential: "alice",
      productionId: "production-one",
    });
    const receipt = await studio.createItem({
      credential: "alice",
      commandId: `fixture-create-${itemId}`,
      productionId: "production-one",
      itemId,
      kind,
      expectedActivityRevision: head.activityRevision,
      draft: {
        ...draft,
        sources: itemId === "scene-one" ? (options.sceneSources ?? []) : [],
      },
    });
    await project(receipt);
  }
  if (options.referenceSources?.length) {
    const head = await studio.readProductionOverview({
      credential: "alice",
      productionId: "production-one",
    });
    await project(
      await studio.createItem({
        credential: "alice",
        commandId: "fixture-source-item",
        productionId: "production-one",
        itemId: "source-one",
        kind: "source",
        expectedActivityRevision: head.activityRevision,
        draft: {
          ...emptyScriptDraft("获准原作片段"),
          text: "真实引文。另一段引文。",
          sources: options.referenceSources,
        },
      }),
    );
  }
  if (options.approve !== false)
    for (const itemId of ["episode-one", "scene-one", "scene-two"]) {
      const submitted = await studio.transitionWorkflow({
        credential: "alice",
        commandId: `fixture-submit-${itemId}`,
        productionId: "production-one",
        itemId,
        expectedRevision: 1,
        expectedWorkflowRevision: 1,
        action: "submit-review",
      });
      await project(submitted);
      const approved = await studio.transitionWorkflow({
        credential: "alice",
        commandId: `fixture-approve-${itemId}`,
        productionId: "production-one",
        itemId,
        expectedRevision: 1,
        expectedWorkflowRevision: 2,
        action: "review-decision",
        decision: "approve",
        note: "可以继续",
      });
      await project(approved);
    }
  const candidates: CandidateSeed[] =
    options.candidates ??
    ["candidate-one", "candidate-two", "candidate-three"].map((id) => ({ id }));
  if (candidates.length) {
    await studio.prepareGeneration({
      credential: "agent",
      commandId: "fixture-prepare",
      productionId: "production-one",
      inputId: "input-one",
      generation: {
        productionId: "production-one",
        targetId: "scene-one",
        baseRevision: 1,
        contextRevision: metadata.metadataRevision,
        purpose: "rewrite",
        references: [
          { itemId: "episode-one", revision: 1 },
          ...(options.referenceSources?.length
            ? [{ itemId: "source-one", revision: 1 }]
            : []),
        ],
        maxCandidates: 3,
        maxOutputCharacters: 8000,
        maxReviewPasses: 0,
      },
    });
    for (const candidate of candidates) {
      const command = {
        credential: "agent",
        commandId: candidate.id,
        productionId: "production-one",
        inputId: "input-one",
        draft: { ...revisedScene, sources: candidate.sources ?? [] },
        explanation: `动作更明确：${candidate.id}`,
      };
      if (candidate.expectedError)
        await assert.rejects(
          studio.submitCandidate(command),
          candidate.expectedError,
        );
      else await project(await studio.submitCandidate(command), "agent");
    }
  }
  return studio.readProductionOverview({
    credential: "alice",
    productionId: "production-one",
  });
}

const storageAuthority: ScriptStudioAuthority = {
  async authorizeCreate({ credential, projectId }) {
    if (projectId !== "project-one") return null;
    if (credential === "alice")
      return {
        tenantId: "tenant-one",
        ...alice,
        kind: "human",
        runtimeInputId: null,
      };
    if (credential === "agent")
      return {
        tenantId: "tenant-one",
        ...agent,
        kind: "agent",
        runtimeInputId: "input-one",
      };
    return null;
  },
  async authorizeObject(request) {
    const actor = await this.authorizeCreate({
      credential: request.credential,
      projectId: "project-one",
    });
    return actor && request.productionId === "production-one"
      ? { ...actor, projectId: "project-one", objectKind: "script" }
      : null;
  },
  async verifyReviewers({ principalIds }) {
    return principalIds.every((id) => id === "alice");
  },
};

function authority(
  studio: () => ScriptStudioStore,
  projectionAllowed: () => boolean,
  objects?: () => ObjectsStore,
): PlatformAuthorityVerifier {
  return {
    async resolveActor({ credential }) {
      if (credential === "alice")
        return {
          tenantId: "tenant-one",
          ...alice,
          kind: "human" as const,
          runtimeInputId: null,
        };
      if (credential === "bob")
        return {
          tenantId: "tenant-one",
          principalId: "bob",
          actantId: "bob",
          kind: "human" as const,
          runtimeInputId: null,
        };
      if (credential === "agent")
        return {
          tenantId: "tenant-one",
          ...agent,
          kind: "agent" as const,
          runtimeInputId: "input-one",
          scopeProjectId: "project-one",
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
        request.instanceId === "objects-one" &&
        objects &&
        request.kind === "document"
      )
        return objects().verifyCommittedDocument(request);
      if (
        request.instanceId !== "studio-one" ||
        request.objectId !== "production-one" ||
        request.kind !== "script"
      )
        return false;
      const proof = { ...request, productionId: request.objectId };
      for (const verify of [
        () => studio().verifyCommittedProduction(proof),
        () => studio().verifyCommittedProductionUpdate(proof),
        () => studio().verifyCommittedItemCreation(proof),
        () => studio().verifyCommittedItemRevision(proof),
        () => studio().verifyCommittedWorkflow(proof),
        () => studio().verifyCommittedCandidateSubmission(proof),
      ])
        if (await verify()) return true;
      return (
        projectionAllowed() &&
        studio().verifyCommittedCandidateDecision({
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
      );
    },
  };
}

async function exercise(
  platform: PlatformStore,
  studio: ScriptStudioStore,
  setProjectionAllowed: (allowed: boolean) => void,
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
  await platform.createProject(
    { credential: "alice" },
    {
      commandId: "create-project-two",
      projectId: "project-two",
      title: "新归属",
    },
  );
  await platform.registerApplication("tenant-one", {
    appId: "morphz.script-studio",
    installationId: "install-studio-one",
    instanceId: "studio-one",
    routeKind: "service",
    routeRef: "test:studio-one",
  });
  const initial = await createDecisionFixture(studio, platform);
  const overview = await studio.readProductionOverview({
    credential: "alice",
    productionId: "production-one",
  });
  assert.equal(overview.projectId, "project-one");
  assert.equal(overview.title, "渡河");
  assert.equal(overview.metadataRevision, 2);
  assert.deepEqual(overview.reviewerPrincipalIds, ["alice"]);
  await assert.rejects(
    studio.readProductionOverview({
      credential: "bob",
      productionId: "production-one",
    }),
    /无权访问|读取权限/,
  );
  const roots = await studio.listItems({
    credential: "alice",
    productionId: "production-one",
    parentId: null,
  });
  assert.deepEqual(
    roots.items.map((item) => item.itemId),
    ["episode-one"],
  );
  const firstChild = await studio.listItems({
    credential: "alice",
    productionId: "production-one",
    parentId: "episode-one",
    limit: 1,
    expectedActivityRevision: roots.activityRevision,
  });
  assert.deepEqual(
    firstChild.items.map((item) => item.itemId),
    ["scene-one"],
  );
  assert.ok(firstChild.nextCursor);
  const secondChild = await studio.listItems({
    credential: "alice",
    productionId: "production-one",
    parentId: "episode-one",
    limit: 1,
    after: firstChild.nextCursor!,
    expectedActivityRevision: roots.activityRevision,
  });
  assert.deepEqual(
    secondChild.items.map((item) => item.itemId),
    ["scene-two"],
  );
  assert.equal(secondChild.nextCursor, null);
  assert.equal(
    (
      await studio.readItemVersion({
        credential: "alice",
        productionId: "production-one",
        itemId: "scene-one",
      })
    ).draft.text,
    scene.text,
  );
  const base = {
    platform,
    studio,
    actor: { credential: "alice" },
    instanceId: "studio-one",
    commandId: "accept-one",
    productionId: "production-one",
    candidateId: "candidate-one",
    expectedRevision: 1,
    decision: "accept" as const,
  };
  await assert.rejects(
    decideScriptCandidate({ ...base, actor: { credential: "bob" } }),
    /无权访问|获授权/,
  );
  await assert.rejects(
    decideScriptCandidate({ ...base, actor: { credential: "agent" } }),
    /人工/,
  );
  await assert.rejects(
    decideScriptCandidate({ ...base, expectedRevision: 2 }),
    /已有决定|变化/,
  );
  const rejected = await decideScriptCandidate({
    ...base,
    commandId: "reject-two",
    candidateId: "candidate-two",
    decision: "reject",
  });
  assert.equal(rejected.original.adoptedItemRevision, null);
  await assert.rejects(
    studio.listItems({
      credential: "alice",
      productionId: "production-one",
      parentId: "episode-one",
      expectedActivityRevision: roots.activityRevision,
    }),
    /分页期间已更新/,
  );
  assert.equal(
    (await platform.content({ credential: "alice" }, "content-production-one"))
      .observed_version_ref,
    String(initial.activityRevision + 1),
  );
  assert.deepEqual(
    await decideScriptCandidate({
      ...base,
      commandId: "reject-two",
      candidateId: "candidate-two",
      decision: "reject",
    }),
    rejected,
  );
  await assert.rejects(
    decideScriptCandidate({ ...base, commandId: "reject-two" }),
    /相同命令 ID/,
  );
  setProjectionAllowed(false);
  await assert.rejects(decideScriptCandidate(base), /应用未确认/);
  assert.equal(
    (await studio.pendingCandidateDirectoryEvents("tenant-one")).length,
    1,
  );
  const beforeMove = await platform.content(
    { credential: "alice" },
    "content-production-one",
  );
  await platform.moveContent(
    { credential: "alice" },
    {
      commandId: "move-production-one",
      contentId: "content-production-one",
      targetProjectId: "project-two",
      expectedRevision: beforeMove.revision,
    },
  );
  await assert.rejects(
    decideScriptCandidate({
      ...base,
      commandId: "accept-three",
      candidateId: "candidate-three",
    }),
    /目录更新尚未完成/,
  );
  setProjectionAllowed(true);
  const pendingDecision = (
    await studio.pendingCandidateDirectoryEvents("tenant-one")
  )[0]!;
  await assert.rejects(
    platform.refreshCommittedContent(
      {
        tenantId: "tenant-one",
        principalId: "bob",
        actantId: "bob",
        runtimeInputId: null,
        instanceId: "studio-one",
        receiptId: pendingDecision.event_id,
      },
      {
        objectId: "production-one",
        previousVersionRef: String(Number(pendingDecision.version_ref) - 1),
        title: pendingDecision.title,
        observedVersionRef: pendingDecision.version_ref,
      },
    ),
    /应用未确认/,
  );
  const recovered = await projectPendingScriptCandidateDecisions({
    platform,
    studio,
    tenantId: "tenant-one",
    instanceId: "studio-one",
  });
  assert.equal(recovered.projected, 1);
  assert.deepEqual(
    await studio.pendingCandidateDirectoryEvents("tenant-one"),
    [],
  );
  assert.equal(
    (await platform.content({ credential: "alice" }, "content-production-one"))
      .project_id,
    "project-two",
  );
  assert.equal(
    (
      await studio.readProductionOverview({
        credential: "alice",
        productionId: "production-one",
      })
    ).projectId,
    "project-two",
  );
  const accepted = await decideScriptCandidate(base);
  assert.equal(accepted.original.adoptedItemId, "scene-one");
  assert.equal(accepted.original.adoptedItemRevision, 2);
  assert.deepEqual(await decideScriptCandidate(base), accepted);
  assert.equal(
    (await platform.content({ credential: "alice" }, "content-production-one"))
      .observed_version_ref,
    String(initial.activityRevision + 2),
  );
  await assert.rejects(
    decideScriptCandidate({
      ...base,
      commandId: "accept-three",
      candidateId: "candidate-three",
    }),
    /过期/,
  );
  const result = await studio.readProduction({
    credential: "alice",
    productionId: "production-one",
  });
  const target = result.items.find((item) => item.id === "scene-one")!;
  assert.equal(target.revision, 2);
  assert.equal(target.versions[1]?.draft.text, revisedScene.text);
  assert.equal(target.versions[1]?.candidateId, "candidate-one");
  assert.equal(target.versions[1]?.author.actantId, "alice");
  const acceptedVersion = await studio.readItemVersion({
    credential: "alice",
    productionId: "production-one",
    itemId: "scene-one",
  });
  assert.equal(acceptedVersion.revision, 2);
  assert.equal(acceptedVersion.draft.text, revisedScene.text);
  assert.equal(acceptedVersion.candidateId, "candidate-one");
  assert.equal(
    (
      await studio.readItemVersion({
        credential: "alice",
        productionId: "production-one",
        itemId: "scene-one",
        revision: 1,
      })
    ).draft.text,
    scene.text,
  );
  const downstream = result.items.find((item) => item.id === "scene-two")!;
  assert.equal(downstream.status, "draft");
  assert.equal(downstream.approval, null);
  assert.equal(downstream.workflowRevision, 4);
  assert.equal(downstream.events.at(-1)?.action, "invalidate");
  assert.equal(
    result.candidates.find((item) => item.id === "candidate-one")?.status,
    "accepted",
  );
  assert.equal(
    result.candidates.find((item) => item.id === "candidate-two")?.status,
    "rejected",
  );
  assert.equal(
    result.candidates.find((item) => item.id === "candidate-three")?.status,
    "pending",
  );
}

test("SQLite：候选采纳与下游失效在剧本域内一次提交", async () => {
  let studio!: ScriptStudioStore;
  let projectionAllowed = true;
  const platform = await PlatformStore.sqlite(
    ":memory:",
    authority(
      () => studio,
      () => projectionAllowed,
    ),
  );
  studio = await ScriptStudioStore.sqlite(
    ":memory:",
    platformScriptStudioAuthority(platform, "studio-one", () => ({
      routeKind: "service",
      routeRef: "test:studio-one",
    })),
  );
  try {
    await exercise(platform, studio, (allowed) => {
      projectionAllowed = allowed;
    });
  } finally {
    await studio.close();
    await platform.close();
  }
});

test("剧本读取期间撤销目录权限不会返回已取出的正文", async () => {
  let allow = true,
    calls = 0,
    armed = false;
  const studio = await ScriptStudioStore.sqlite(":memory:", {
    ...storageAuthority,
    async authorizeObject(request) {
      if (!armed) return storageAuthority.authorizeObject(request);
      assert.equal(request.operation, "read");
      calls++;
      const granted = allow;
      allow = false;
      return granted ? storageAuthority.authorizeObject(request) : null;
    },
  });
  try {
    await createDecisionFixture(studio, undefined, {
      approve: false,
      candidates: [],
    });
    armed = true;
    await assert.rejects(
      studio.readItemVersion({
        credential: "alice",
        productionId: "production-one",
        itemId: "scene-one",
      }),
      /读取期间权限/,
    );
    assert.equal(calls, 2);
  } finally {
    await studio.close();
  }
});

test("SQLite：提交前撤权回滚采纳；未核实来源不能写入候选", async () => {
  let authorizationCalls = 0,
    denySecondCheck = false;
  const studio = await ScriptStudioStore.sqlite(":memory:", {
    ...storageAuthority,
    async authorizeObject(request) {
      const actor = await storageAuthority.authorizeObject(request);
      if (request.operation === "write" && denySecondCheck) {
        authorizationCalls++;
        if (authorizationCalls % 2 === 0) return null;
      }
      return actor;
    },
  });
  try {
    await createDecisionFixture(studio);
    denySecondCheck = true;
    const command = {
      credential: "alice",
      commandId: "accept-one",
      productionId: "production-one",
      candidateId: "candidate-one",
      expectedRevision: 1,
      decision: "accept" as const,
    };
    await assert.rejects(studio.decideCandidate(command), /权限.*变化/);
    const unchanged = await studio.readProduction({
      credential: "alice",
      productionId: "production-one",
    });
    assert.equal(
      unchanged.items.find((item) => item.id === "scene-one")?.revision,
      1,
    );
    assert.equal(
      unchanged.items.find((item) => item.id === "scene-two")?.status,
      "approved",
    );
    assert.equal(unchanged.candidates[0]?.status, "pending");
    assert.deepEqual(
      await studio.pendingCandidateDirectoryEvents("tenant-one"),
      [],
    );
    denySecondCheck = false;
    assert.equal(
      (await studio.decideCandidate(command)).adoptedItemRevision,
      2,
    );
  } finally {
    await studio.close();
  }

  // Current producers reject an unverifiable citation before persistence.
  // An old import could seed such an impossible candidate; do not preserve
  // that bypass merely to exercise the later adoption check.
  const sourceStudio = await ScriptStudioStore.sqlite(
    ":memory:",
    storageAuthority,
  );
  try {
    const initial = await createDecisionFixture(sourceStudio, undefined, {
      approve: false,
      candidates: [],
    });
    await sourceStudio.prepareGeneration({
      credential: "agent",
      commandId: "prepare-unverified-source",
      productionId: "production-one",
      inputId: "input-one",
      generation: {
        productionId: "production-one",
        targetId: "scene-one",
        baseRevision: 1,
        contextRevision: initial.metadataRevision,
        purpose: "rewrite",
        references: [{ itemId: "episode-one", revision: 1 }],
        maxCandidates: 1,
        maxOutputCharacters: 8000,
        maxReviewPasses: 0,
      },
    });
    await assert.rejects(
      sourceStudio.submitCandidate({
        credential: "agent",
        commandId: "candidate-unverified-source",
        productionId: "production-one",
        inputId: "input-one",
        explanation: "未经原件确认",
        draft: {
          ...revisedScene,
          sources: [
            {
              appId: "morphz.objects",
              instanceId: "objects-one",
              objectId: "source-book",
              versionRef: "1",
              quote: "真实引文",
            },
          ],
        },
      }),
      /候选原作引用超出本次固定资料/,
    );
    const unchanged = await sourceStudio.readProduction({
      credential: "alice",
      productionId: "production-one",
    });
    assert.deepEqual(unchanged.candidates, []);
    assert.equal(unchanged.activityRevision, initial.activityRevision);
    assert.equal(
      unchanged.items.find((item) => item.id === "scene-one")?.revision,
      1,
    );
    assert.deepEqual(
      await sourceStudio.pendingCandidateDirectoryEvents("tenant-one"),
      [],
    );
  } finally {
    await sourceStudio.close();
  }
});

async function exerciseVerifiedSources(
  platform: PlatformStore,
  objects: ObjectsStore,
  studio: ScriptStudioStore,
) {
  await platform.provisionTenant("tenant-one");
  for (const projectId of ["project-one", "project-two"])
    await platform.createProject(
      { credential: "alice" },
      {
        commandId: `create-${projectId}`,
        projectId,
        title: projectId,
      },
    );
  await platform.createProject(
    { credential: "bob" },
    {
      commandId: "create-project-bob",
      projectId: "project-bob",
      title: "不同成员的项目",
    },
  );
  await platform.registerApplication("tenant-one", {
    appId: "morphz.objects",
    installationId: "install-objects-one",
    instanceId: "objects-one",
    routeKind: "service",
    routeRef: "test:objects-one",
  });
  await platform.registerApplication("tenant-one", {
    appId: "morphz.script-studio",
    installationId: "install-studio-one",
    instanceId: "studio-one",
    routeKind: "service",
    routeRef: "test:studio-one",
  });
  for (const [objectId, contentId, credential, projectId] of [
    ["source-book", "content-source", "alice", "project-one"],
    ["source-other", "content-other-source", "bob", "project-bob"],
  ] as const) {
    const receipt = await objects.createDocument({
      credential,
      commandId: `create-${objectId}`,
      objectId,
      requestedProjectId: projectId,
      title: "原作",
      markdown: "真实引文。另一段引文。尚未固定的引文。",
    });
    await platform.recordContent(
      { credential },
      { instanceId: "objects-one", proof: receipt.receiptId },
      {
        commandId: `record-${objectId}`,
        appReceiptId: receipt.receiptId,
        contentId,
        objectId,
        projectId,
        kind: "document",
        title: receipt.title,
        observedVersionRef: receipt.versionRef,
      },
    );
    await objects.markDirectoryProjected(receipt.tenantId, receipt.eventId);
  }
  const pinned = {
    appId: "morphz.objects",
    instanceId: "objects-one",
    objectId: "source-book",
    versionRef: "1",
    quote: "真实引文",
  };
  await createDecisionFixture(studio, platform, {
    sceneSources: [pinned],
    referenceSources: [pinned, { ...pinned, quote: "另一段引文" }],
    candidates: [
      { id: "candidate-one", sources: [pinned] },
      {
        id: "candidate-two",
        sources: [{ ...pinned, quote: "伪造引文" }],
        expectedError: /候选原作引用超出本次固定资料/,
      },
      {
        id: "candidate-three",
        sources: [{ ...pinned, versionRef: "2" }],
        expectedError: /候选原作引用超出本次固定资料/,
      },
      { id: "candidate-four", sources: [{ ...pinned, quote: "另一段引文" }] },
    ],
  });
  assert.deepEqual(
    (
      await studio.readItemVersion({
        credential: "alice",
        productionId: "production-one",
        itemId: "scene-one",
      })
    ).draft.sources,
    [
      {
        appId: "morphz.objects",
        instanceId: "objects-one",
        objectId: "source-book",
        versionRef: "1",
        quote: "真实引文",
      },
    ],
  );
  const verifier = objectsScriptSourceVerifier(
    platform,
    objects,
    "objects-one",
  );
  const check = {
    credential: "alice",
    tenantId: "tenant-one",
    principalId: "alice",
    actantId: "alice",
    kind: "human" as const,
    runtimeInputId: null,
    productionProjectId: "project-one",
    alreadyPinned: false,
    appId: "morphz.objects",
    instanceId: "objects-one",
    objectId: "source-book",
    versionRef: "1",
    quote: "真实引文",
  };
  assert.equal(await verifier(check), true);
  assert.equal(await verifier({ ...check, versionRef: "01" }), false);
  assert.equal(await verifier({ ...check, appId: "other.app" }), false);
  assert.equal(
    await verifier({ ...check, instanceId: "objects-other" }),
    false,
  );
  await assert.rejects(verifier({ ...check, quote: "伪造引文" }), /引文/);
  await assert.rejects(verifier({ ...check, versionRef: "2" }), /版本/);
  await assert.rejects(verifier({ ...check, credential: "bob" }), /无权访问/);
  const currentSource = await platform.content(
    { credential: "alice" },
    "content-source",
  );
  await platform.moveContent(
    { credential: "alice" },
    {
      commandId: "move-source",
      contentId: "content-source",
      targetProjectId: "project-two",
      expectedRevision: currentSource.revision,
    },
  );
  assert.equal(await verifier(check), false);
  assert.equal(await verifier({ ...check, quote: "尚未固定的引文" }), false);
  assert.equal(await verifier({ ...check, alreadyPinned: true }), true);
  await assert.rejects(
    verifier({ ...check, objectId: "source-other", alreadyPinned: true }),
    /无权访问/,
  );
  assert.equal(
    await platform.projectAudiencesEqual({ credential: "alice" }, [
      "project-one",
      "project-two",
    ]),
    true,
  );
  const base = {
    platform,
    studio,
    actor: { credential: "alice" },
    instanceId: "studio-one",
    productionId: "production-one",
    expectedRevision: 1,
    decision: "accept" as const,
  };
  // Both valid candidates already cite the immutable sources admitted in the
  // actual preparation. New citations after the move must be rejected at the
  // formal write boundary, not seeded into an impossible candidate by import.
  await assert.rejects(
    studio.reviseItem({
      credential: "alice",
      commandId: "add-new-citation-after-source-move",
      productionId: "production-one",
      itemId: "scene-one",
      expectedRevision: 1,
      draft: {
        ...revisedScene,
        sources: [{ ...pinned, quote: "尚未固定的引文" }],
      },
    }),
    /原件版本和引文尚未由所属应用核验/,
  );
  const unchanged = await studio.readProduction({
    credential: "alice",
    productionId: "production-one",
  });
  assert.equal(
    unchanged.items.find((item) => item.id === "scene-one")?.revision,
    1,
  );
  assert.ok(
    unchanged.candidates.every((candidate) => candidate.status === "pending"),
  );
  assert.deepEqual(
    unchanged.candidates.map((candidate) => candidate.id),
    ["candidate-one", "candidate-four"],
  );
  const adopted = await decideScriptCandidate({
    ...base,
    commandId: "accept-pinned",
    candidateId: "candidate-one",
  });
  assert.equal(adopted.original.adoptedItemRevision, 2);
}

test("SQLite：剧本采纳核验 Objects 精确来源，并限制跨项目新引文", async () => {
  let studio!: ScriptStudioStore;
  let objects!: ObjectsStore;
  const platform = await PlatformStore.sqlite(
    ":memory:",
    authority(
      () => studio,
      () => true,
      () => objects,
    ),
  );
  objects = await ObjectsStore.sqlite(
    ":memory:",
    platformObjectsAuthority(platform, "objects-one", () => ({
      routeKind: "service",
      routeRef: "test:objects-one",
    })),
  );
  studio = await ScriptStudioStore.sqlite(
    ":memory:",
    platformScriptStudioAuthority(
      platform,
      "studio-one",
      () => ({ routeKind: "service", routeRef: "test:studio-one" }),
      {
        objects,
        instanceId: "objects-one",
      },
    ),
  );
  try {
    await exerciseVerifiedSources(platform, objects, studio);
  } finally {
    await studio.close();
    await objects.close();
    await platform.close();
  }
});

test(
  "PostgreSQL：候选采纳与下游失效在独立 schema 内一次提交",
  {
    skip: !process.env.MORPHZ_TEST_POSTGRES_URL,
  },
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
    let projectionAllowed = true;
    try {
      await client.query(`CREATE SCHEMA "${platformSchema}"`);
      await client.query(`CREATE SCHEMA "${studioSchema}"`);
      platform = await PlatformStore.postgres(
        {
          connectionString: process.env.MORPHZ_TEST_POSTGRES_URL!,
          schema: platformSchema,
        },
        authority(
          () => studio!,
          () => projectionAllowed,
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
      await exercise(platform, studio, (allowed) => {
        projectionAllowed = allowed;
      });
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

test(
  "PostgreSQL：跨 Platform、Objects、剧本独立 schema 核验来源",
  { skip: !process.env.MORPHZ_TEST_POSTGRES_URL },
  async () => {
    const connectionString = process.env.MORPHZ_TEST_POSTGRES_URL!;
    const pool = new Pool({ connectionString });
    const suffix = randomUUID().replaceAll("-", "");
    const platformSchema = `morphz_platform_${suffix}`;
    const objectsSchema = `morphz_objects_${suffix}`;
    const studioSchema = `morphz_studio_${suffix}`;
    const client = await pool.connect();
    let platform: PlatformStore | undefined;
    let objects: ObjectsStore | undefined;
    let studio: ScriptStudioStore | undefined;
    try {
      for (const schema of [platformSchema, objectsSchema, studioSchema])
        await client.query(`CREATE SCHEMA "${schema}"`);
      platform = await PlatformStore.postgres(
        { connectionString, schema: platformSchema },
        authority(
          () => studio!,
          () => true,
          () => objects!,
        ),
      );
      objects = await ObjectsStore.postgres({
        connectionString,
        schema: objectsSchema,
        authority: platformObjectsAuthority(platform, "objects-one", () => ({
          routeKind: "service",
          routeRef: "test:objects-one",
        })),
      });
      studio = await ScriptStudioStore.postgres({
        connectionString,
        schema: studioSchema,
        authority: platformScriptStudioAuthority(
          platform,
          "studio-one",
          () => ({ routeKind: "service", routeRef: "test:studio-one" }),
          {
            objects,
            instanceId: "objects-one",
          },
        ),
      });
      await exerciseVerifiedSources(platform, objects, studio);
    } finally {
      await studio?.close();
      await objects?.close();
      await platform?.close();
      for (const schema of [studioSchema, objectsSchema, platformSchema])
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      client.release();
      await pool.end();
    }
  },
);
