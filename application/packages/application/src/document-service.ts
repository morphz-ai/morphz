import { createHash } from "node:crypto";
import {
  ObjectsStore,
  type ObjectsAuthority,
  type ObjectsByteReference,
  type DocumentCommit,
} from "../../objects/src/store.js";
import type { InteractiveContent } from "../../core/src/interactive.js";
import type { InteractiveRowOperation } from "../../core/src/interactive.js";
import {
  PlatformStore,
  type ApplicationProviderRoute,
  type PlatformActor,
} from "../../platform/src/store.js";
import { contentIdForAppObject } from "./content-id.js";

const stableId = (prefix: string, values: string[]) =>
  `${prefix}_${createHash("sha256")
    .update(JSON.stringify(values))
    .digest("hex")
    .slice(0, 40)}`;

export function platformObjectsAuthority(
  platform: PlatformStore,
  instanceId: string,
  provider: () => ApplicationProviderRoute,
): ObjectsAuthority {
  const authorizeRead: ObjectsAuthority["authorizeObjectRead"] = ({
    credential,
    objectId,
  }) =>
    platform.authorizeApplicationObject(
      { credential },
      instanceId,
      "morphz.objects",
      objectId,
      "read",
      provider(),
    );
  return {
    authorizeCreate: ({ credential, projectId }) =>
      platform.authorizeContentProject(
        { credential },
        instanceId,
        "morphz.objects",
        projectId,
        provider(),
      ),
    authorizeDocumentRevision: ({ credential, objectId }) =>
      platform.authorizeApplicationObject(
        { credential },
        instanceId,
        "morphz.objects",
        objectId,
        "write",
        provider(),
      ),
    authorizeObjectRead: authorizeRead,
    authorizeByteRead: authorizeRead,
  };
}

export function readDocument(request: {
  objects: ObjectsStore;
  actor: PlatformActor;
  objectId: string;
  revision?: number;
}) {
  return request.objects.readDocument({
    credential: request.actor.credential,
    objectId: request.objectId,
    ...(request.revision === undefined ? {} : { revision: request.revision }),
  });
}

export function listObjectVersions(request: {
  objects: ObjectsStore;
  actor: PlatformActor;
  objectId: string;
  limit?: number;
  beforeRevision?: number;
}) {
  return request.objects.listObjectVersions({
    credential: request.actor.credential,
    objectId: request.objectId,
    ...(request.limit === undefined ? {} : { limit: request.limit }),
    ...(request.beforeRevision === undefined
      ? {}
      : { beforeRevision: request.beforeRevision }),
  });
}

function catalogCommandId(
  tenantId: string,
  instanceId: string,
  receiptId: string,
) {
  return stableId("catalog", [tenantId, instanceId, receiptId]);
}

async function commitCreatedObject(request: {
  platform: PlatformStore;
  objects: ObjectsStore;
  actor: PlatformActor;
  instanceId: string;
  kind: "document" | "image" | "interactive";
  original: DocumentCommit;
}) {
  const { actor, instanceId, kind, objects, original, platform } = request;
  const contentId = contentIdForAppObject(
    original.tenantId,
    instanceId,
    original.objectId,
  );
  await platform.recordContent(
    actor,
    { instanceId, proof: original.receiptId },
    {
      commandId: catalogCommandId(
        original.tenantId,
        instanceId,
        original.receiptId,
      ),
      appReceiptId: original.receiptId,
      contentId,
      objectId: original.objectId,
      projectId: original.projectId,
      kind,
      title: original.title,
      observedVersionRef: original.versionRef,
    },
  );
  await objects.markDirectoryProjected(original.tenantId, original.eventId);
  return { original, contentId };
}

async function commitRevisedObject(request: {
  platform: PlatformStore;
  objects: ObjectsStore;
  actor: PlatformActor;
  instanceId: string;
  kind: "document" | "image" | "interactive";
  original: DocumentCommit;
}) {
  const { actor, instanceId, kind, objects, original, platform } = request;
  if (!original.contentId || !original.expectedCatalogRevision)
    throw new Error("内容修订缺少已提交的目录基线。");
  const observed = await platform.content(actor, original.contentId);
  if (
    observed.instance_id === instanceId &&
    observed.app_object_id === original.objectId &&
    observed.kind === kind &&
    observed.observed_version_ref === original.versionRef &&
    observed.title === original.title
  ) {
    await objects.markDirectoryProjected(original.tenantId, original.eventId);
    return { original, contentId: original.contentId };
  }
  await platform.refreshContent(
    actor,
    { instanceId, proof: original.receiptId },
    {
      commandId: catalogCommandId(
        original.tenantId,
        instanceId,
        original.receiptId,
      ),
      appReceiptId: original.receiptId,
      contentId: original.contentId,
      expectedCatalogRevision: original.expectedCatalogRevision,
      title: original.title,
      observedVersionRef: original.versionRef,
    },
  );
  await objects.markDirectoryProjected(original.tenantId, original.eventId);
  return { original, contentId: original.contentId };
}

/** Application original commits first. Platform only receives an exact,
 * verified directory reference. Failed projection is replayed from the same
 * app receipt, never by creating a second original.
 */
export async function createDocument(request: {
  platform: PlatformStore;
  objects: ObjectsStore;
  actor: PlatformActor;
  instanceId: string;
  commandId: string;
  objectId: string;
  projectId: string;
  title: string;
  markdown: string;
  relativePath?: string;
}) {
  const original = await request.objects.createDocument({
    credential: request.actor.credential,
    commandId: request.commandId,
    objectId: request.objectId,
    requestedProjectId: request.projectId,
    title: request.title,
    markdown: request.markdown,
    ...(request.relativePath ? { relativePath: request.relativePath } : {}),
  });
  return commitCreatedObject({ ...request, kind: "document", original });
}

export async function createImage(request: {
  platform: PlatformStore;
  objects: ObjectsStore;
  actor: PlatformActor;
  instanceId: string;
  commandId: string;
  objectId: string;
  projectId: string;
  title: string;
  assetId: string;
  alt: string;
  reference: ObjectsByteReference;
}) {
  const original = await request.objects.createImage({
    credential: request.actor.credential,
    commandId: request.commandId,
    objectId: request.objectId,
    requestedProjectId: request.projectId,
    title: request.title,
    assetId: request.assetId,
    alt: request.alt,
    reference: request.reference,
  });
  return commitCreatedObject({ ...request, kind: "image", original });
}

export async function createInteractive(request: {
  platform: PlatformStore;
  objects: ObjectsStore;
  actor: PlatformActor;
  instanceId: string;
  commandId: string;
  objectId: string;
  projectId: string;
  title: string;
  content: InteractiveContent;
}) {
  const original = await request.objects.createInteractive({
    credential: request.actor.credential,
    commandId: request.commandId,
    objectId: request.objectId,
    requestedProjectId: request.projectId,
    title: request.title,
    content: request.content,
  });
  return commitCreatedObject({ ...request, kind: "interactive", original });
}

export async function reviseDocument(request: {
  platform: PlatformStore;
  objects: ObjectsStore;
  actor: PlatformActor;
  instanceId: string;
  commandId: string;
  objectId: string;
  expectedRevision: number;
  title: string;
  markdown: string;
}) {
  const original = await request.objects.reviseDocument({
    credential: request.actor.credential,
    commandId: request.commandId,
    objectId: request.objectId,
    expectedRevision: request.expectedRevision,
    title: request.title,
    markdown: request.markdown,
  });
  return commitRevisedObject({ ...request, kind: "document", original });
}

export async function reviseImage(request: {
  platform: PlatformStore;
  objects: ObjectsStore;
  actor: PlatformActor;
  instanceId: string;
  commandId: string;
  objectId: string;
  expectedRevision: number;
  title: string;
  assetId: string;
  alt: string;
  reference: ObjectsByteReference;
}) {
  const original = await request.objects.reviseImage({
    credential: request.actor.credential,
    commandId: request.commandId,
    objectId: request.objectId,
    expectedRevision: request.expectedRevision,
    title: request.title,
    assetId: request.assetId,
    alt: request.alt,
    reference: request.reference,
  });
  return commitRevisedObject({ ...request, kind: "image", original });
}

export async function reviseInteractive(request: {
  platform: PlatformStore;
  objects: ObjectsStore;
  actor: PlatformActor;
  instanceId: string;
  commandId: string;
  objectId: string;
  expectedRevision: number;
  title: string;
  content: InteractiveContent;
}) {
  const original = await request.objects.reviseInteractive({
    credential: request.actor.credential,
    commandId: request.commandId,
    objectId: request.objectId,
    expectedRevision: request.expectedRevision,
    title: request.title,
    content: request.content,
  });
  return commitRevisedObject({ ...request, kind: "interactive", original });
}

export async function patchInteractiveRows(request: {
  platform: PlatformStore;
  objects: ObjectsStore;
  actor: PlatformActor;
  instanceId: string;
  commandId: string;
  objectId: string;
  expectedRevision: number;
  operations: InteractiveRowOperation[];
}) {
  const original = await request.objects.patchInteractiveRows({
    credential: request.actor.credential,
    commandId: request.commandId,
    objectId: request.objectId,
    expectedRevision: request.expectedRevision,
    operations: request.operations,
  });
  return commitRevisedObject({ ...request, kind: "interactive", original });
}

export async function renameObject(request: {
  platform: PlatformStore;
  objects: ObjectsStore;
  actor: PlatformActor;
  instanceId: string;
  commandId: string;
  objectId: string;
  expectedCatalogRevision: number;
  title: string;
}) {
  const original = await request.objects.renameObject({
    credential: request.actor.credential,
    commandId: request.commandId,
    objectId: request.objectId,
    expectedCatalogRevision: request.expectedCatalogRevision,
    title: request.title,
  });
  if (!original.contentId || !original.expectedCatalogRevision)
    throw new Error("内容改名缺少已提交的目录基线。");
  const observed = await request.platform.content(
    request.actor,
    original.contentId,
  );
  if (
    observed.instance_id === request.instanceId &&
    observed.app_object_id === original.objectId &&
    observed.observed_version_ref === original.versionRef &&
    observed.title === original.title
  ) {
    await request.objects.markDirectoryProjected(
      original.tenantId,
      original.eventId,
    );
    return { original, contentId: original.contentId };
  }
  await request.platform.refreshContent(
    request.actor,
    { instanceId: request.instanceId, proof: original.receiptId },
    {
      commandId: catalogCommandId(
        original.tenantId,
        request.instanceId,
        original.receiptId,
      ),
      appReceiptId: original.receiptId,
      contentId: original.contentId,
      expectedCatalogRevision: original.expectedCatalogRevision,
      title: original.title,
      observedVersionRef: original.versionRef,
    },
  );
  await request.objects.markDirectoryProjected(
    original.tenantId,
    original.eventId,
  );
  return { original, contentId: original.contentId };
}

/** Recover committed app writes without repeating model output. Platform
 * verifies each exact App receipt before projecting its directory reference.
 */
export async function projectPendingDocumentDirectory(request: {
  platform: PlatformStore;
  objects: ObjectsStore;
  tenantId: string;
  instanceId: string;
  after?: { createdAt: string; eventId: string };
  limit?: number;
}) {
  const events = await request.objects.pendingDirectoryEvents(
    request.tenantId,
    request.limit ?? 100,
    request.after,
  );
  let projected = 0;
  const unresolved: string[] = [];
  for (const event of events) {
    try {
      const origin = {
        tenantId: request.tenantId,
        principalId: event.principalId,
        actantId: event.actantId,
        runtimeInputId: event.runtimeInputId,
        runtimeTaskRunEventId: event.runtimeTaskRunEventId ?? null,
        instanceId: request.instanceId,
        receiptId: event.eventId,
      };
      if (
        (event.eventKind === "document.created" ||
          event.eventKind === "image.created" ||
          event.eventKind === "interactive.created") &&
        event.versionRef === "1" &&
        event.contentId === null &&
        event.expectedCatalogRevision === null
      ) {
        await request.platform.recordCommittedContent(origin, {
          objectId: event.objectId,
          projectId: event.projectId,
          kind: event.eventKind.slice(0, -".created".length),
          title: event.title,
          observedVersionRef: event.versionRef,
        });
      } else if (
        [
          "document",
          "image",
          "pdf",
          "publication",
          "website",
          "interactive",
        ].some((kind) => event.eventKind === `${kind}.revised`) &&
        event.contentId &&
        event.expectedCatalogRevision
      ) {
        const revision = Number(event.versionRef);
        if (!Number.isSafeInteger(revision) || revision < 2)
          throw new Error("文档目录事件版本无效。");
        await request.platform.refreshCommittedContent(origin, {
          contentId: event.contentId,
          objectId: event.objectId,
          previousVersionRef: String(revision - 1),
          title: event.title,
          observedVersionRef: event.versionRef,
        });
      } else {
        unresolved.push(event.eventId);
        continue;
      }
      await request.objects.markDirectoryProjected(
        request.tenantId,
        event.eventId,
      );
      projected++;
    } catch {
      unresolved.push(event.eventId);
    }
  }
  const last = events.at(-1);
  return {
    examined: events.length,
    projected,
    unresolved,
    nextCursor: last
      ? { createdAt: last.createdAt, eventId: last.eventId }
      : null,
  };
}
