import { createHash } from "node:crypto";
import {
  PlatformStore,
  type ApplicationProviderRoute,
  type PlatformActor,
} from "../../platform/src/store.js";
import { ObjectsStore } from "../../objects/src/store.js";
import { ScriptStudioStore } from "../../script-studio/src/store.js";
import type {
  LiveScriptDraft,
  ScriptStudioAuthority,
} from "../../script-studio/src/store.js";
import { contentIdForAppObject } from "./content-id.js";
import type { ScriptWorkflowReport } from "../../core/src/script-tool.js";

const stableId = (prefix: string, values: string[]) =>
  `${prefix}_${createHash("sha256")
    .update(JSON.stringify(values))
    .digest("hex")
    .slice(0, 40)}`;

export function platformScriptStudioAuthority(
  platform: PlatformStore,
  instanceId: string,
  provider: () => ApplicationProviderRoute,
  source?: { objects: ObjectsStore; instanceId: string },
  execution?: Pick<ScriptStudioAuthority, "assertInputActive">,
): ScriptStudioAuthority {
  return {
    ...execution,
    async verifyReviewers({ credential, projectId, principalIds }) {
      const project = await platform.getProject({ credential }, projectId);
      return principalIds.every((id) =>
        project.member_principal_ids.includes(id),
      );
    },
    ...(source
      ? {
          verifySourceVersion: objectsScriptSourceVerifier(
            platform,
            source.objects,
            source.instanceId,
          ),
        }
      : {}),
    async authorizeCreate({ credential, projectId }) {
      return platform.authorizeContentProject(
        { credential },
        instanceId,
        "morphz.script-studio",
        projectId,
        provider(),
      );
    },
    async authorizeProjectRead({ credential, projectId }) {
      return platform.authorizeApplicationProject(
        { credential },
        instanceId,
        "morphz.script-studio",
        projectId,
        provider(),
      );
    },
    async authorizeObject({ credential, productionId, operation }) {
      return platform.authorizeApplicationObject(
        { credential },
        instanceId,
        "morphz.script-studio",
        productionId,
        operation,
        provider(),
      );
    },
  };
}

/** Script Studio verifies citations through the Objects original, then asks
 * Platform whether a moved, already-pinned source still has the same audience.
 * The same credential is resolved independently by both domains.
 */
export function objectsScriptSourceVerifier(
  platform: PlatformStore,
  objects: ObjectsStore,
  objectsInstanceId: string,
): NonNullable<ScriptStudioAuthority["verifySourceVersion"]> {
  return async (request) => {
    if (
      request.appId !== "morphz.objects" ||
      request.instanceId !== objectsInstanceId ||
      !/^[1-9][0-9]*$/.test(request.versionRef)
    )
      return false;
    const revision = Number(request.versionRef);
    if (!Number.isSafeInteger(revision)) return false;
    const source = await objects.verifyQuotedVersion({
      credential: request.credential,
      objectId: request.objectId,
      revision,
      quote: request.quote,
    });
    if (
      source.tenantId !== request.tenantId ||
      source.principalId !== request.principalId ||
      source.actantId !== request.actantId ||
      source.kind !== request.kind ||
      source.runtimeInputId !== request.runtimeInputId ||
      source.runtimeTaskRunEventId !== (request.runtimeTaskRunEventId ?? null)
    )
      return false;
    const historicalProjectId = source.historicalProjectId ?? source.projectId;
    if (
      source.projectId === request.productionProjectId &&
      historicalProjectId === request.productionProjectId
    )
      return true;
    if (!request.alreadyPinned) return false;
    return platform.projectAudiencesEqual({ credential: request.credential }, [
      request.productionProjectId,
      source.projectId,
      historicalProjectId,
    ]);
  };
}

/** One live cross-domain command, with no cross-database transaction claim.
 * The app receipt is authoritative for the original; retry only projects the
 * same committed result into Platform, never creates another production.
 */
export async function createScriptProduction(request: {
  platform: PlatformStore;
  studio: ScriptStudioStore;
  actor: PlatformActor;
  instanceId: string;
  commandId: string;
  productionId: string;
  projectId: string;
  title: string;
}) {
  const original = await request.studio.createProduction({
    credential: request.actor.credential,
    commandId: request.commandId,
    productionId: request.productionId,
    requestedProjectId: request.projectId,
    title: request.title,
  });
  const contentId = contentIdForAppObject(
    original.tenantId,
    request.instanceId,
    original.productionId,
  );
  await request.platform.recordContent(
    request.actor,
    { instanceId: request.instanceId, proof: original.receiptId },
    {
      commandId: stableId("catalog", [
        original.tenantId,
        request.instanceId,
        original.receiptId,
      ]),
      appReceiptId: original.receiptId,
      contentId,
      objectId: original.productionId,
      projectId: original.requestedProjectId,
      kind: "script",
      title: original.title,
      observedVersionRef: original.versionRef,
    },
  );
  await request.studio.markDirectoryProjected(
    original.tenantId,
    original.eventId,
  );
  return { original, contentId };
}

export async function updateScriptProduction(request: {
  platform: PlatformStore;
  studio: ScriptStudioStore;
  actor: PlatformActor;
  instanceId: string;
  commandId: string;
  productionId: string;
  expectedRevision: number;
  title: string;
  brief: import("../../core/src/script-studio.js").ScriptProduction["brief"];
  reviewerPrincipalIds: string[];
  template: import("../../core/src/script-studio.js").ScriptProduction["template"];
}) {
  const original = await request.studio.updateProduction({
    credential: request.actor.credential,
    commandId: request.commandId,
    productionId: request.productionId,
    expectedRevision: request.expectedRevision,
    title: request.title,
    brief: request.brief,
    reviewerPrincipalIds: request.reviewerPrincipalIds,
    template: request.template,
  });
  if (original.eventId) {
    const projected = await projectCommittedScriptItem(request, {
      ...original,
      eventId: original.eventId,
    });
    return { original, contentId: projected.contentId };
  }
  return {
    original,
    contentId: contentIdForAppObject(
      original.tenantId,
      request.instanceId,
      original.productionId,
    ),
  };
}

export async function renameScriptProduction(request: {
  platform: PlatformStore;
  studio: ScriptStudioStore;
  actor: PlatformActor;
  instanceId: string;
  commandId: string;
  productionId: string;
  expectedCatalogRevision: number;
  expectedActivityRevision: number;
  currentCatalogRevision: number;
  title: string;
}) {
  const original = await request.studio.renameProduction({
    credential: request.actor.credential,
    commandId: request.commandId,
    productionId: request.productionId,
    expectedCatalogRevision: request.expectedCatalogRevision,
    expectedActivityRevision: request.expectedActivityRevision,
    currentCatalogRevision: request.currentCatalogRevision,
    title: request.title,
  });
  return projectCommittedScriptItem(request, {
    ...original,
    eventId: original.eventId!,
  });
}

/** The decision commits in Script Studio first. The directory is a versioned
 * projection; a retry can only replay the same domain receipt, not re-adopt a
 * candidate or ask the model to regenerate the draft.
 */
export async function decideScriptCandidate(request: {
  platform: PlatformStore;
  studio: ScriptStudioStore;
  actor: PlatformActor;
  instanceId: string;
  commandId: string;
  productionId: string;
  candidateId: string;
  expectedRevision: number;
  decision: "accept" | "reject";
}) {
  const original = await request.studio.decideCandidate({
    credential: request.actor.credential,
    commandId: request.commandId,
    productionId: request.productionId,
    candidateId: request.candidateId,
    expectedRevision: request.expectedRevision,
    decision: request.decision,
  });
  return projectCommittedScriptItem(request, original);
}

export async function submitScriptCandidate(request: {
  platform: PlatformStore;
  studio: ScriptStudioStore;
  actor: PlatformActor;
  instanceId: string;
  commandId: string;
  productionId: string;
  inputId: string;
  targetId?: string;
  draft: LiveScriptDraft;
  explanation: string;
  workflowReport?: ScriptWorkflowReport;
}) {
  const original = await request.studio.submitCandidate({
    credential: request.actor.credential,
    commandId: request.commandId,
    productionId: request.productionId,
    inputId: request.inputId,
    ...(request.targetId === undefined ? {} : { targetId: request.targetId }),
    draft: request.draft,
    explanation: request.explanation,
    workflowReport: request.workflowReport,
  });
  return projectCommittedScriptItem(request, original);
}

/** Item creation is an app-domain commit. Platform only observes the next
 * production revision; if projection fails, the same command reuses the
 * original item and its immutable first draft.
 */
export async function createScriptItem(request: {
  platform: PlatformStore;
  studio: ScriptStudioStore;
  actor: PlatformActor;
  instanceId: string;
  commandId: string;
  productionId: string;
  itemId: string;
  expectedActivityRevision: number;
  kind: "source" | "setting" | "character" | "outline" | "episode" | "scene";
  draft: LiveScriptDraft;
}) {
  const original = await request.studio.createItem({
    credential: request.actor.credential,
    commandId: request.commandId,
    productionId: request.productionId,
    itemId: request.itemId,
    expectedActivityRevision: request.expectedActivityRevision,
    kind: request.kind,
    draft: request.draft,
  });
  return projectCommittedScriptItem(request, original);
}

/** Human editing uses the same committed-original then verified-directory
 * projection as item creation. No cross-database transaction is assumed.
 */
export async function reviseScriptItem(request: {
  platform: PlatformStore;
  studio: ScriptStudioStore;
  actor: PlatformActor;
  instanceId: string;
  commandId: string;
  productionId: string;
  itemId: string;
  expectedRevision: number;
  draft: LiveScriptDraft;
  restoreRevision?: number;
}) {
  const original = await request.studio.reviseItem({
    credential: request.actor.credential,
    commandId: request.commandId,
    productionId: request.productionId,
    itemId: request.itemId,
    expectedRevision: request.expectedRevision,
    draft: request.draft,
    ...(request.restoreRevision === undefined
      ? {}
      : { restoreRevision: request.restoreRevision }),
  });
  return projectCommittedScriptItem(request, original);
}

/** Restore creates a new head from an immutable historical draft. The old
 * version remains readable; reviseItem performs the same CAS and source checks
 * as an ordinary human edit. */
export async function restoreScriptItem(request: {
  platform: PlatformStore;
  studio: ScriptStudioStore;
  actor: PlatformActor;
  instanceId: string;
  commandId: string;
  productionId: string;
  itemId: string;
  expectedRevision: number;
  restoreRevision: number;
}) {
  const original = await request.studio.readItemVersion({
    credential: request.actor.credential,
    productionId: request.productionId,
    itemId: request.itemId,
    revision: request.restoreRevision,
  });
  if (request.restoreRevision >= request.expectedRevision)
    throw new Error("只能恢复早于当前正文的历史版本。");
  return reviseScriptItem({ ...request, draft: original.draft });
}

export async function recordScriptExport(request: {
  platform: PlatformStore;
  studio: ScriptStudioStore;
  actor: PlatformActor;
  instanceId: string;
  commandId: string;
  productionId: string;
  expectedRevision: number;
  items: Array<{ itemId: string; revision: number }>;
  template: import("../../core/src/script-studio.js").ScriptProduction["template"];
  workingCopy?: true;
}) {
  const original = await request.studio.recordExport({
    credential: request.actor.credential,
    commandId: request.commandId,
    productionId: request.productionId,
    expectedRevision: request.expectedRevision,
    items: request.items,
    template: request.template,
    ...(request.workingCopy ? { workingCopy: true as const } : {}),
  });
  return projectCommittedScriptItem(request, original);
}

export async function transitionScriptWorkflow(request: {
  platform: PlatformStore;
  studio: ScriptStudioStore;
  actor: PlatformActor;
  instanceId: string;
  commandId: string;
  productionId: string;
  itemId: string;
  expectedRevision: number;
  expectedWorkflowRevision: number;
  action: "submit-review" | "review-decision" | "lock-item" | "unlock-item";
  decision?: "approve" | "request-changes";
  note?: string;
}) {
  const original = await request.studio.transitionWorkflow({
    credential: request.actor.credential,
    commandId: request.commandId,
    productionId: request.productionId,
    itemId: request.itemId,
    expectedRevision: request.expectedRevision,
    expectedWorkflowRevision: request.expectedWorkflowRevision,
    action: request.action,
    ...(request.decision ? { decision: request.decision } : {}),
    ...(request.note !== undefined ? { note: request.note } : {}),
  });
  return projectCommittedScriptItem(request, original);
}

export async function changeScriptReview(request: {
  platform: PlatformStore;
  studio: ScriptStudioStore;
  actor: PlatformActor;
  instanceId: string;
  commandId: string;
  productionId: string;
  action: "add-review" | "resolve-review";
  itemId?: string;
  itemRevision?: number;
  quote?: string;
  body?: string;
  severity?: "note" | "warning" | "blocking";
  reviewId?: string;
  expectedRevision?: number;
  resolution?: string;
}) {
  const original = await request.studio.changeReview({
    credential: request.actor.credential,
    commandId: request.commandId,
    productionId: request.productionId,
    action: request.action,
    ...(request.itemId ? { itemId: request.itemId } : {}),
    ...(request.itemRevision !== undefined
      ? { itemRevision: request.itemRevision }
      : {}),
    ...(request.quote !== undefined ? { quote: request.quote } : {}),
    ...(request.body !== undefined ? { body: request.body } : {}),
    ...(request.severity ? { severity: request.severity } : {}),
    ...(request.reviewId ? { reviewId: request.reviewId } : {}),
    ...(request.expectedRevision !== undefined
      ? { expectedRevision: request.expectedRevision }
      : {}),
    ...(request.resolution !== undefined
      ? { resolution: request.resolution }
      : {}),
  });
  return projectCommittedScriptItem(request, original);
}

export async function submitScriptReviewBatch(request: {
  platform: PlatformStore;
  studio: ScriptStudioStore;
  actor: PlatformActor;
  instanceId: string;
  commandId: string;
  productionId: string;
  inputId: string;
  workflowReport?: ScriptWorkflowReport;
  reviews: Array<{
    itemId: string;
    itemRevision: number;
    quote: string;
    body: string;
    severity: "note" | "warning" | "blocking";
  }>;
}) {
  const original = await request.studio.submitReviewBatch({
    credential: request.actor.credential,
    commandId: request.commandId,
    productionId: request.productionId,
    inputId: request.inputId,
    reviews: request.reviews,
    workflowReport: request.workflowReport,
  });
  return projectCommittedScriptItem(request, original);
}

async function projectCommittedScriptItem<
  T extends {
    tenantId: string;
    productionId: string;
    activityRevision: number;
    versionRef: string;
    title: string;
    receiptId: string;
    eventId: string;
  },
>(
  request: {
    platform: PlatformStore;
    studio: ScriptStudioStore;
    actor: PlatformActor;
    instanceId: string;
  },
  original: T,
): Promise<{ original: T; contentId: string }> {
  const directory = await request.platform.authorizeApplicationObject(
    request.actor,
    request.instanceId,
    "morphz.script-studio",
    original.productionId,
    "write",
  );
  if (directory.objectKind !== "script")
    throw new Error("剧本目录类型与应用原件不一致。");
  if (directory.observedVersionRef !== original.versionRef) {
    const observed = Number(directory.observedVersionRef);
    if (
      Number.isSafeInteger(observed) &&
      observed > original.activityRevision &&
      (await request.studio.directoryEventProjected(
        original.tenantId,
        original.eventId,
      ))
    )
      return { original, contentId: directory.contentId };
    if (directory.observedVersionRef !== String(original.activityRevision - 1))
      throw new Error("剧本目录不是本次修改所依据的版本，拒绝越过未投影修改。");
    await request.platform.refreshContent(
      request.actor,
      { instanceId: request.instanceId, proof: original.receiptId },
      {
        commandId: stableId("catalog", [
          original.tenantId,
          request.instanceId,
          original.receiptId,
        ]),
        appReceiptId: original.receiptId,
        contentId: directory.contentId,
        expectedCatalogRevision: directory.catalogRevision,
        title: original.title,
        observedVersionRef: original.versionRef,
      },
    );
  }
  await request.studio.markDirectoryProjected(
    original.tenantId,
    original.eventId,
  );
  return { original, contentId: directory.contentId };
}

/** A pending item creation or revision is already committed in Script Studio.
 * Recovery projects its verified receipt, never replays the domain command.
 */
export async function projectPendingScriptItems(request: {
  platform: PlatformStore;
  studio: ScriptStudioStore;
  tenantId: string;
  instanceId: string;
  after?: { createdAt: string; eventId: string };
  limit?: number;
}) {
  const events = await request.studio.pendingItemDirectoryEvents(
    request.tenantId,
    request.limit ?? 100,
    request.after,
  );
  let projected = 0;
  const unresolved: string[] = [];
  for (const event of events) {
    try {
      const revision = Number(event.version_ref);
      if (!Number.isSafeInteger(revision) || revision < 2)
        throw new Error("条目目录事件版本无效。");
      await request.platform.refreshCommittedContent(
        {
          tenantId: request.tenantId,
          principalId: event.principal_id,
          actantId: event.actant_id,
          runtimeInputId: event.input_id,
          runtimeTaskRunEventId: event.task_run_event_id,
          instanceId: request.instanceId,
          receiptId: event.event_id,
        },
        {
          objectId: event.production_id,
          previousVersionRef: String(revision - 1),
          title: event.title,
          observedVersionRef: event.version_ref,
        },
      );
      await request.studio.markDirectoryProjected(
        request.tenantId,
        event.event_id,
      );
      projected++;
    } catch {
      unresolved.push(event.event_id);
    }
  }
  const last = events.at(-1);
  return {
    examined: events.length,
    projected,
    unresolved,
    nextCursor: last
      ? { createdAt: last.created_at, eventId: last.event_id }
      : null,
  };
}

export async function projectPendingScriptSettings(request: {
  platform: PlatformStore;
  studio: ScriptStudioStore;
  tenantId: string;
  instanceId: string;
  after?: { createdAt: string; eventId: string };
  limit?: number;
}) {
  const events = await request.studio.pendingProductionUpdates(
    request.tenantId,
    request.limit ?? 100,
    request.after,
  );
  let projected = 0;
  const unresolved: string[] = [];
  for (const event of events) {
    try {
      const revision = Number(event.version_ref);
      if (!Number.isSafeInteger(revision) || revision < 2)
        throw new Error("剧本设置目录事件版本无效。");
      await request.platform.refreshCommittedContent(
        {
          tenantId: request.tenantId,
          principalId: event.principal_id,
          actantId: event.actant_id,
          runtimeInputId: event.input_id,
          runtimeTaskRunEventId: event.task_run_event_id,
          instanceId: request.instanceId,
          receiptId: event.event_id,
        },
        {
          objectId: event.production_id,
          previousVersionRef: String(revision - 1),
          title: event.title,
          observedVersionRef: event.version_ref,
        },
      );
      await request.studio.markDirectoryProjected(
        request.tenantId,
        event.event_id,
      );
      projected++;
    } catch {
      unresolved.push(event.event_id);
    }
  }
  const last = events.at(-1);
  return {
    examined: events.length,
    projected,
    unresolved,
    nextCursor: last
      ? { createdAt: last.created_at, eventId: last.event_id }
      : null,
  };
}

export async function projectPendingScriptExports(request: {
  platform: PlatformStore;
  studio: ScriptStudioStore;
  tenantId: string;
  instanceId: string;
  after?: { createdAt: string; eventId: string };
  limit?: number;
}) {
  const events = await request.studio.pendingExportDirectoryEvents(
    request.tenantId,
    request.limit ?? 100,
    request.after,
  );
  let projected = 0;
  const unresolved: string[] = [];
  for (const event of events) {
    try {
      const revision = Number(event.version_ref);
      if (!Number.isSafeInteger(revision) || revision < 2)
        throw new Error("导出目录事件版本无效。");
      await request.platform.refreshCommittedContent(
        {
          tenantId: request.tenantId,
          principalId: event.principal_id,
          actantId: event.actant_id,
          runtimeInputId: event.input_id,
          runtimeTaskRunEventId: event.task_run_event_id,
          instanceId: request.instanceId,
          receiptId: event.event_id,
        },
        {
          objectId: event.production_id,
          previousVersionRef: String(revision - 1),
          title: event.title,
          observedVersionRef: event.version_ref,
        },
      );
      await request.studio.markDirectoryProjected(
        request.tenantId,
        event.event_id,
      );
      projected++;
    } catch {
      unresolved.push(event.event_id);
    }
  }
  const last = events.at(-1);
  return {
    examined: events.length,
    projected,
    unresolved,
    nextCursor: last
      ? { createdAt: last.created_at, eventId: last.event_id }
      : null,
  };
}

export async function projectPendingScriptWorkflow(request: {
  platform: PlatformStore;
  studio: ScriptStudioStore;
  tenantId: string;
  instanceId: string;
  after?: { createdAt: string; eventId: string };
  limit?: number;
}) {
  const events = await request.studio.pendingWorkflowDirectoryEvents(
    request.tenantId,
    request.limit ?? 100,
    request.after,
  );
  let projected = 0;
  const unresolved: string[] = [];
  for (const event of events) {
    try {
      const revision = Number(event.version_ref);
      if (!Number.isSafeInteger(revision) || revision < 2)
        throw new Error("审阅目录事件版本无效。");
      await request.platform.refreshCommittedContent(
        {
          tenantId: request.tenantId,
          principalId: event.principal_id,
          actantId: event.actant_id,
          runtimeInputId: event.input_id,
          runtimeTaskRunEventId: event.task_run_event_id,
          instanceId: request.instanceId,
          receiptId: event.event_id,
        },
        {
          objectId: event.production_id,
          previousVersionRef: String(revision - 1),
          title: event.title,
          observedVersionRef: event.version_ref,
        },
      );
      await request.studio.markDirectoryProjected(
        request.tenantId,
        event.event_id,
      );
      projected++;
    } catch {
      unresolved.push(event.event_id);
    }
  }
  const last = events.at(-1);
  return {
    examined: events.length,
    projected,
    unresolved,
    nextCursor: last
      ? { createdAt: last.created_at, eventId: last.event_id }
      : null,
  };
}

export async function projectPendingScriptReviews(request: {
  platform: PlatformStore;
  studio: ScriptStudioStore;
  tenantId: string;
  instanceId: string;
  after?: { createdAt: string; eventId: string };
  limit?: number;
}) {
  const events = await request.studio.pendingReviewDirectoryEvents(
    request.tenantId,
    request.limit ?? 100,
    request.after,
  );
  let projected = 0;
  const unresolved: string[] = [];
  for (const event of events) {
    try {
      const revision = Number(event.version_ref);
      if (!Number.isSafeInteger(revision) || revision < 2)
        throw new Error("审阅意见目录事件版本无效。");
      await request.platform.refreshCommittedContent(
        {
          tenantId: request.tenantId,
          principalId: event.principal_id,
          actantId: event.actant_id,
          runtimeInputId: event.input_id,
          runtimeTaskRunEventId: event.task_run_event_id,
          instanceId: request.instanceId,
          receiptId: event.event_id,
        },
        {
          objectId: event.production_id,
          previousVersionRef: String(revision - 1),
          title: event.title,
          observedVersionRef: event.version_ref,
        },
      );
      await request.studio.markDirectoryProjected(
        request.tenantId,
        event.event_id,
      );
      projected++;
    } catch {
      unresolved.push(event.event_id);
    }
  }
  const last = events.at(-1);
  return {
    examined: events.length,
    projected,
    unresolved,
    nextCursor: last
      ? { createdAt: last.created_at, eventId: last.event_id }
      : null,
  };
}

/** The candidate decision already committed in Script Studio. Its original
 * receipt is checked by Platform; no decision command is replayed.
 */
export async function projectPendingScriptCandidateDecisions(request: {
  platform: PlatformStore;
  studio: ScriptStudioStore;
  tenantId: string;
  instanceId: string;
  after?: { createdAt: string; eventId: string };
  limit?: number;
}) {
  const events = await request.studio.pendingCandidateDirectoryEvents(
    request.tenantId,
    request.limit ?? 100,
    request.after,
  );
  let projected = 0;
  const unresolved: string[] = [];
  for (const event of events) {
    if (
      ![
        "submit-candidate",
        "decide-candidate:accept",
        "decide-candidate:reject",
      ].includes(event.operation)
    ) {
      unresolved.push(event.event_id);
      continue;
    }
    try {
      const revision = Number(event.version_ref);
      if (!Number.isSafeInteger(revision) || revision < 2)
        throw new Error("候选决定目录事件版本无效。");
      await request.platform.refreshCommittedContent(
        {
          tenantId: request.tenantId,
          principalId: event.principal_id,
          actantId: event.actant_id,
          runtimeInputId: event.input_id,
          runtimeTaskRunEventId: event.task_run_event_id,
          instanceId: request.instanceId,
          receiptId: event.event_id,
        },
        {
          objectId: event.production_id,
          previousVersionRef: String(revision - 1),
          title: event.title,
          observedVersionRef: event.version_ref,
        },
      );
      await request.studio.markDirectoryProjected(
        request.tenantId,
        event.event_id,
      );
      projected++;
    } catch {
      unresolved.push(event.event_id);
    }
  }
  const last = events.at(-1);
  return {
    examined: events.length,
    projected,
    unresolved,
    nextCursor: last
      ? { createdAt: last.created_at, eventId: last.event_id }
      : null,
  };
}

/** Bounded outbox recovery from the app's immutable create receipt. */
export async function projectPendingScriptDirectory(request: {
  platform: PlatformStore;
  studio: ScriptStudioStore;
  tenantId: string;
  instanceId: string;
  after?: { createdAt: string; eventId: string };
  limit?: number;
}) {
  const events = await request.studio.pendingDirectoryEvents(
    request.tenantId,
    request.limit ?? 100,
    request.after,
  );
  let projected = 0;
  const unresolved: string[] = [];
  for (const event of events) {
    if (!event.requested_project_id || event.version_ref !== "1") {
      unresolved.push(event.event_id);
      continue;
    }
    try {
      await request.platform.recordCommittedContent(
        {
          tenantId: request.tenantId,
          principalId: event.owner_principal_id,
          actantId: event.created_by_actant_id,
          runtimeInputId: event.input_id,
          runtimeTaskRunEventId: event.task_run_event_id,
          instanceId: request.instanceId,
          receiptId: event.event_id,
        },
        {
          objectId: event.production_id,
          projectId: event.requested_project_id,
          kind: "script",
          title: event.title,
          observedVersionRef: event.version_ref,
        },
      );
      await request.studio.markDirectoryProjected(
        request.tenantId,
        event.event_id,
      );
      projected++;
    } catch {
      // Do not mark delivered or reassign to a different user/project.
      unresolved.push(event.event_id);
    }
  }
  const last = events.at(-1);
  return {
    examined: events.length,
    projected,
    unresolved,
    nextCursor: last
      ? { createdAt: last.created_at, eventId: last.event_id }
      : null,
  };
}
