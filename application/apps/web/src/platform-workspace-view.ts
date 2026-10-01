import { z } from "zod";
import {
  artifactSchema,
  contentSchema,
  morphzAgentAccess,
  stateSchema,
  type Artifact,
  type Workspace,
} from "../../../packages/core/src/model.js";
import {
  browserApplication,
  readerApplication,
  scriptStudioApplication,
} from "../../../packages/core/src/applications.js";
import {
  conversationRuntimeSchema,
  type ConversationRuntime,
} from "../../../packages/core/src/conversation.js";
import type {
  PlatformClient,
  PlatformContent,
  PlatformContentDelivery,
  PlatformContentCount,
  PlatformHistory,
  PlatformConversation,
  PlatformProject,
  PlatformTask,
  PlatformTaskCount,
  PlatformTaskVersion,
  ScriptLibraryEntry,
  ScriptOverview,
  UiPackageSummary,
} from "./platform-client.js";
import {
} from "../../../packages/core/src/script-studio.js";
import { scriptOutputKey } from "../../../packages/core/src/script-delivery.js";
import { RequestError } from "./application-transport.js";
import type { NavigationRevisions } from "../../../packages/core/src/application-api.js";

const objectVersionSchema = z.object({
  objectId: z.string(),
  contentId: z.string(),
  projectId: z.string(),
  revision: z.number().int().positive(),
  headRevision: z.number().int().positive(),
  title: z.string(),
  content: contentSchema,
  source: artifactSchema.shape.source,
  author: z.object({ principalId: z.string(), actantId: z.string() }),
  createdAt: z.string().datetime(),
});

export type HistoryScope = { projectId: string; conversationId: string };
export type HistorySelection = {
  scope?: HistoryScope | null;
  recentContentIds?: string[];
  preferences?: {
    view?: string;
    projectId?: string;
    projectOpen?: boolean;
    artifactId?: string | null;
    artifactRevision?: number | null;
    selectedConversations?: Record<string, string>;
    contentScope?: string;
    scriptLocation?: { productionId: string } | null;
  };
};
export type CachedHistory = {
  scope: HistoryScope;
  version: string;
  value: PlatformHistory;
};
/** Merge adjacent history windows without moving late replies under their
 * source input. The first argument owns the current connection/attention
 * state; only timeline rows are retained from the older window.
 */
export function mergePlatformHistories(
  latest: PlatformHistory,
  older: PlatformHistory,
  nextCursor = older.nextCursor,
): PlatformHistory {
  const byId = <T extends { id: string; createdAt: string }>(
    previous: T[],
    current: T[],
  ) =>
    [
      ...new Map(
        [...previous, ...current].map((item) => [item.id, item]),
      ).values(),
    ].sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  return {
    inputs: byId(older.inputs, latest.inputs),
    scriptOutputs: [
      ...new Map(
        [...older.scriptOutputs, ...latest.scriptOutputs].map((output) => [
          scriptOutputKey(output),
          output,
        ]),
      ).values(),
    ].sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) ||
        a.commandId.localeCompare(b.commandId),
    ),
    nextCursor,
    runtime: {
      ...latest.runtime,
      deliveries: [
        ...new Map(
          [...older.runtime.deliveries, ...latest.runtime.deliveries].map(
            (delivery) => [delivery.inputId, delivery],
          ),
        ).values(),
      ],
      messages: byId(older.runtime.messages, latest.runtime.messages),
    },
  };
}
function overlappingHistory(left: PlatformHistory, right: PlatformHistory) {
  const known = new Set([
    ...right.inputs.map((input) => input.id),
    ...right.runtime.messages.map((message) => message.id),
  ]);
  return (
    left.inputs.some((input) => known.has(input.id)) ||
    left.runtime.messages.some((message) => known.has(message.id))
  );
}
export type PlatformWorkspaceCatalog = {
  personal: { deskId: string; inboxId: string; dialogueId: string };
  projects: PlatformProject[];
  conversations: PlatformConversation[];
  tasks: PlatformTask[];
  tasksLoaded: boolean;
  taskCounts: PlatformTaskCount[];
  headContents: PlatformContent[];
  contents: PlatformContent[];
  contentCounts: PlatformContentCount[];
  scriptLibrary: ScriptLibraryEntry[];
  taskOrderRevision: number;
  uiPackages: UiPackageSummary[];
  versionTitles?: ContentVersionTitle[];
};

export type PlatformNavigationCache = {
  version: number;
  revisions: NavigationRevisions;
  value: PlatformWorkspaceCatalog;
};

export function navigationReadStillCurrent(
  before: { catalogVersion: number; revisions: NavigationRevisions },
  after: { catalogVersion: number; revisions: NavigationRevisions },
) {
  return (
    before.catalogVersion === after.catalogVersion &&
    before.revisions.access === after.revisions.access &&
    before.revisions.projects === after.revisions.projects &&
    before.revisions.conversations === after.revisions.conversations &&
    before.revisions.tasks === after.revisions.tasks
  );
}

/** This is only an in-memory display cache. The read callback still uses the
 * owning application's live authorization. Clearing protected projections
 * also advances the generation, so an already-authorized but late response
 * cannot repopulate a revoked view or remove a newer request with the same key. */
export async function readCachedScriptOverview(
  key: string,
  values: Map<string, ScriptOverview>,
  pending: Map<string, Promise<ScriptOverview>>,
  generation: { readonly current: number },
  read: () => Promise<ScriptOverview>,
  validate: (overview: ScriptOverview) => void,
): Promise<ScriptOverview> {
  const requestedGeneration = generation.current;
  const cached = values.get(key);
  if (cached) return cached;
  const waiting = pending.get(key);
  if (waiting) return waiting;
  const request = read().then((overview) => {
    if (generation.current !== requestedGeneration)
      throw new Error("访问状态已变化，请重试读取剧本。");
    validate(overview);
    values.set(key, overview);
    if (values.size > 128) values.delete(values.keys().next().value!);
    return overview;
  });
  pending.set(key, request);
  try {
    return await request;
  } finally {
    if (pending.get(key) === request) pending.delete(key);
  }
}

/** Reuse only the list whose authoritative revision is unchanged. All
 * reused fields were read under this identity; access changes invalidate
 * every protected projection, even if its business revision is unchanged. */
export function reusableNavigationCatalog(
  cache: PlatformNavigationCache | null,
  version: number,
  revisions: NavigationRevisions,
): Partial<PlatformWorkspaceCatalog> | undefined {
  if (!cache || cache.revisions.access !== revisions.access) return;
  const value: Partial<PlatformWorkspaceCatalog> = {
    ...(cache.version === version ? cache.value : {}),
    personal: cache.value.personal,
  };
  if (cache.revisions.projects === revisions.projects)
    value.projects = cache.value.projects;
  else delete value.projects;
  if (cache.revisions.conversations === revisions.conversations)
    value.conversations = cache.value.conversations;
  else delete value.conversations;
  if (cache.revisions.tasks === revisions.tasks) {
    value.tasks = cache.value.tasks;
    value.tasksLoaded = cache.value.tasksLoaded;
    value.taskCounts = cache.value.taskCounts;
    value.taskOrderRevision = cache.value.taskOrderRevision;
  } else {
    delete value.tasks;
    delete value.tasksLoaded;
    delete value.taskCounts;
    delete value.taskOrderRevision;
  }
  return value;
}

export type ContentVersionTitle = {
  contentId: string;
  appObjectId: string;
  providerRevision: number;
  revision: number;
  title: string;
};

/** Historical labels belong to the app version, not the current catalog
 * title. Resolve only visible references and never fetch original bodies.
 * The cache is a bounded, identity-scoped renderer projection; the current
 * authorized catalog and provider binding must still match before reuse. */
export async function readContentVersionTitles(
  client: PlatformClient,
  contents: readonly PlatformContent[],
  references: readonly {
    artifactId?: string | null;
    artifactRevision?: number | null;
  }[],
  previous: readonly ContentVersionTitle[] = [],
  signal?: AbortSignal,
): Promise<ContentVersionTitle[]> {
  const byId = new Map(contents.map((entry) => [entry.id, entry]));
  const key = (id: string, revision: number) => `${id}:${revision}`;
  const cached = new Map(
    previous.map((value) => [key(value.contentId, value.revision), value]),
  );
  const wanted = [
    ...new Map(
      references
        .filter(
          (ref) =>
            !!ref.artifactId &&
            Number.isSafeInteger(ref.artifactRevision) &&
            ref.artifactRevision! > 0,
        )
        .map((ref) => [key(ref.artifactId!, ref.artifactRevision!), ref]),
    ).values(),
  ].slice(-100);
  const read = limitConcurrentReads(8, signal);
  const values = await Promise.all(
    wanted.map(async (ref): Promise<ContentVersionTitle | null> => {
      const entry = byId.get(ref.artifactId!);
      const revision = ref.artifactRevision!;
      if (
        !entry ||
        entry.availability !== "available" ||
        !["morphz.objects", "morphz.reader"].includes(entry.appId)
      )
        return null;
      // The directory label is valid only for its observed head version.
      if (String(revision) === entry.observedVersionRef) return null;
      const prior = cached.get(key(entry.id, revision));
      if (
        prior?.appObjectId === entry.appObjectId &&
        prior.providerRevision === entry.providerRevision
      )
        return prior;
      return read(async () => {
        try {
          let title: string;
          if (entry.appId === "morphz.objects") {
            const page = z
              .object({
                objectId: z.string(),
                contentId: z.string(),
                versions: z.array(
                  z.object({
                    revision: z.number().int().positive(),
                    title: z.string(),
                  }),
                ),
              })
              .parse(
                await client.objectVersions(
                  entry.id,
                  { beforeRevision: revision + 1, limit: 1 },
                  signal,
                ),
              );
            if (
              page.contentId !== entry.id ||
              page.objectId !== entry.appObjectId
            )
              throw new Error("引用内容与应用原件不一致，请重试。");
            const version = page.versions.find(
              (value) => value.revision === revision,
            );
            if (!version) return null;
            title = version.title;
          } else {
            const overview = z
              .object({
                bookId: z.string(),
                revision: z.number().int().positive(),
                title: z.string(),
              })
              .parse(await client.readReaderBook(entry.id, revision, signal));
            if (
              overview.bookId !== entry.appObjectId ||
              overview.revision !== revision
            )
              throw new Error("引用书籍与阅读器原件不一致，请重试。");
            title = overview.title;
          }
          return {
            contentId: entry.id,
            appObjectId: entry.appObjectId,
            providerRevision: entry.providerRevision,
            revision,
            title,
          };
        } catch (error) {
          if (
            error instanceof RequestError &&
            [403, 404].includes(error.status)
          )
            return null;
          throw error;
        }
      });
    }),
  );
  return values.filter((value): value is ContentVersionTitle => value !== null);
}

export function contentVersionTitle(
  contentId: string,
  revision: number | undefined,
  artifacts: readonly Artifact[],
  contents: readonly PlatformContent[],
  titles: readonly ContentVersionTitle[] = [],
): string | undefined {
  const entry = contents.find((value) => value.id === contentId);
  const artifact = artifacts.find((value) => value.id === contentId);
  if (
    artifact &&
    (artifact.content.kind === "task" ||
      (entry?.availability === "available" &&
        artifact.providerRevision === entry.providerRevision))
  ) {
    const exact = artifact.versions.find(
      (value) => value.revision === revision,
    );
    if (exact) return exact.title;
    if (revision === undefined) return artifact.title;
  }
  if (!entry || entry.availability !== "available") return undefined;
  if (revision === undefined || String(revision) === entry.observedVersionRef)
    return entry.title;
  return titles.find(
    (value) =>
      value.contentId === contentId &&
      value.revision === revision &&
      value.appObjectId === entry.appObjectId &&
      value.providerRevision === entry.providerRevision,
  )?.title;
}

export function scriptLibraryEntryFromContent(
  entry: PlatformContent,
): ScriptLibraryEntry {
  if (
    entry.appId !== "morphz.script-studio" ||
    entry.kind !== "script" ||
    entry.availability !== "available"
  )
    throw new Error("剧本原件当前不可用，请稍后重试。");
  const activityRevision = Number(entry.observedVersionRef);
  if (!Number.isSafeInteger(activityRevision) || activityRevision < 1)
    throw new Error("剧本目录版本无效，请重试。");
  return {
    id: entry.appObjectId,
    contentId: entry.id,
    projectId: entry.projectId,
    title: entry.title,
    updatedAt: entry.updatedAt,
    catalogRevision: entry.revision,
    activityRevision,
  };
}

/** Resolve the same navigation target as the visible UI before requesting
 * any message body. A draft has no persisted conversation yet. */
export function selectedHistoryScope(
  projects: PlatformProject[],
  conversations: PlatformConversation[],
  personal: { deskId: string; inboxId: string; dialogueId: string },
  teamAuthentication: boolean,
  selection: HistorySelection = {},
): HistoryScope | null {
  const exact = (scope?: HistoryScope | null) => {
    if (!scope) return null;
    const found = conversations.find(
      (conversation) =>
        conversation.id === scope.conversationId &&
        conversation.projectId === scope.projectId,
    );
    return found
      ? { projectId: found.projectId, conversationId: found.id }
      : null;
  };
  if (selection.scope) return exact(selection.scope);
  const prefs = selection.preferences;
  const project =
    prefs?.view === "projects" && prefs.projectOpen
      ? (projects.find(
          (item) => item.id === prefs.projectId && item.kind === "project",
        ) ?? projects.find((item) => item.kind === "project"))
      : null;
  const navigationProjectId =
    project?.id ??
    (prefs?.view === "inbox"
      ? personal.inboxId
      : prefs?.view === "dialogue"
        ? personal.dialogueId
        : prefs?.view === "content" &&
            prefs.contentScope &&
            projects.some((item) => item.id === prefs.contentScope)
          ? prefs.contentScope
          : personal.deskId);
  const chosen = project && prefs?.selectedConversations?.[project.id];
  const named = chosen
    ? exact({ projectId: project.id, conversationId: chosen })
    : null;
  if (named) return named;
  const defaultId = teamAuthentication
    ? navigationProjectId
    : personal.dialogueId;
  return exact({ projectId: defaultId, conversationId: defaultId });
}

/** A renderer presentation model. Each source is read through its owning
 * domain; no persisted workspace snapshot or client database is involved.
 * The old UI still needs this shape until its screens move to scoped queries.
 */
export async function readPlatformWorkspace(
  client: PlatformClient,
  instances: Workspace["applicationInstances"],
  revision: number,
  runtimeSnapshot: ConversationRuntime,
  signal?: AbortSignal,
  previous?: Workspace,
  selection: HistorySelection = {},
  cachedHistory?: CachedHistory,
  cachedCatalog?: Partial<PlatformWorkspaceCatalog>,
  preparedPersonal?: PlatformWorkspaceCatalog["personal"],
  historyVersion?: string,
): Promise<{
  workspace: Workspace;
  runtime: ConversationRuntime;
  historyScope: HistoryScope | null;
  history: PlatformHistory | null;
  catalog: PlatformWorkspaceCatalog;
  contentDeliveries: PlatformContentDelivery[];
  scriptOutputs: PlatformHistory["scriptOutputs"];
}> {
  const wantsTaskList = selection.preferences?.view === "inbox";
  const baseCatalog: PlatformWorkspaceCatalog = await (async () => {
    const personal =
      cachedCatalog?.personal ??
      preparedPersonal ??
      (await client.ensurePersonalSpaces(signal));
    const [
      projects,
      conversations,
      tasks,
      taskCounts,
      contentPage,
      contentCounts,
      taskOrder,
      uiPackages,
    ] = await Promise.all([
      cachedCatalog?.projects ?? client.allProjects(signal),
      cachedCatalog?.conversations ?? client.allNavigationConversations(signal),
      cachedCatalog?.tasksLoaded
        ? cachedCatalog.tasks!
        : wantsTaskList
          ? client.allTasks({ owner: "all" }, signal)
          : (cachedCatalog?.tasks ?? []),
      cachedCatalog?.taskCounts ?? client.taskCounts(signal),
      cachedCatalog?.headContents
        ? { items: cachedCatalog.headContents }
        : client.content({ limit: 50 }, signal),
      cachedCatalog?.contentCounts ?? client.contentCounts({}, signal),
      cachedCatalog?.taskOrderRevision !== undefined
        ? { revision: cachedCatalog.taskOrderRevision }
        : client.taskOrder(undefined, signal),
      cachedCatalog?.uiPackages ?? client.uiPackages(signal),
    ]);
    return {
      personal,
      projects,
      conversations,
      tasks,
      tasksLoaded: !!cachedCatalog?.tasksLoaded || wantsTaskList,
      taskCounts,
      headContents: contentPage.items,
      contents: cachedCatalog?.contents ?? contentPage.items,
      contentCounts,
      scriptLibrary: [],
      taskOrderRevision: taskOrder.revision,
      uiPackages,
      versionTitles: cachedCatalog?.versionTitles,
    };
  })();
  const { personal, projects, conversations, tasks: headTasks } = baseCatalog;
  const priorArtifacts = new Map(
    previous?.artifacts.map((artifact) => [artifact.id, artifact]) ?? [],
  );
  const historyScope = selectedHistoryScope(
    projects,
    conversations,
    personal,
    client.boot.capabilities?.teamAuthentication ?? false,
    selection,
  );
  const openedArtifactIds = new Set(
    [
      selection.preferences?.artifactId,
      ...instances
        .filter((instance) => instance.status === "open")
        .map((instance) => instance.state.artifactId),
    ].filter((value): value is string => typeof value === "string" && !!value),
  );
  const openedScriptIds = new Set(
    [
      selection.preferences?.scriptLocation?.productionId,
      ...instances
        .filter(
          (instance) =>
            instance.status === "open" &&
            instance.applicationId === scriptStudioApplication.id &&
            instance.state.view === "editor",
        )
        .map((instance) => instance.state.productionId),
    ].filter((value): value is string => typeof value === "string" && !!value),
  );
  const matchingHistory =
    cachedHistory?.scope.projectId === historyScope?.projectId &&
    cachedHistory?.scope.conversationId === historyScope?.conversationId
      ? cachedHistory
      : undefined;
  const histories: PlatformHistory[] =
    runtimeSnapshot.configured && historyScope
      ? [
          matchingHistory && matchingHistory.version === historyVersion
            ? matchingHistory.value
            : await (async () => {
                const latest = await client.history(
                  historyScope.projectId,
                  historyScope.conversationId,
                  undefined,
                  signal,
                );
                // A new publication often changes historyVersion while the
                // reader is looking at an older page. Retain that page only
                // when the fresh window overlaps and no older delivery can
                // still change state. Otherwise restart from a known window.
                return matchingHistory &&
                  overlappingHistory(latest, matchingHistory.value) &&
                  !matchingHistory.value.runtime.deliveries.some((delivery) =>
                    ["queued", "sending", "running"].includes(delivery.state),
                  )
                  ? mergePlatformHistories(latest, matchingHistory.value)
                  : latest;
              })(),
        ]
      : [];
  const visibleInputIds = histories.flatMap((history) =>
    history.inputs.map((input) => input.id),
  );
  const contentDeliveries = visibleInputIds.length
    ? await client.contentDeliveries(visibleInputIds, signal)
    : [];
  const scriptOutputs = histories.flatMap((history) => history.scriptOutputs);
  // Message cards need the current authorized directory entry, not every
  // draft/version/candidate in the production. Only real editor targets below
  // participate in original hydration.
  const referencedScriptIds = new Set(openedScriptIds);
  for (const delivery of contentDeliveries)
    if (delivery.appId === scriptStudioApplication.id)
      referencedScriptIds.add(delivery.appObjectId);
  for (const output of scriptOutputs)
    referencedScriptIds.add(output.productionId);
  const historyIds = [
    ...histories.flatMap((history) =>
      history.inputs.map((input) => input.artifactId),
    ),
    ...histories.flatMap((history) =>
      history.runtime.messages.map((message) => message.artifactId),
    ),
    ...runtimeSnapshot.messages.map((message) => message.artifactId),
  ]
    .filter((value): value is string => typeof value === "string" && !!value)
    .slice(-50);
  const cachedById = new Map(
    baseCatalog.contents.map((entry) => [entry.id, entry]),
  );
  const taskIds = new Set(headTasks.map((task) => task.id));
  // Keep cold navigation bounded. Older message references are resolved on
  // explicit open; their absence from the first page never means deletion.
  const wantedIds = [
    ...new Set(
      [
        ...openedArtifactIds,
        ...contentDeliveries.map((delivery) => delivery.contentId),
        ...(selection.recentContentIds ?? []).slice(0, 100),
        ...historyIds,
      ].filter((id) => !taskIds.has(id)),
    ),
  ].slice(0, 200);
  const retainedContents = wantedIds.flatMap((id) => {
    const entry = cachedById.get(id);
    return entry ? [entry] : [];
  });
  const retainedScripts = baseCatalog.contents.filter(
    (entry) =>
      entry.appId === "morphz.script-studio" &&
      referencedScriptIds.has(entry.appObjectId),
  );
  const referenceIds = wantedIds.filter((id) => !cachedById.has(id));
  const referencedContents = referenceIds.length
    ? await client.contentByIds(referenceIds, signal)
    : [];
  const knownScriptObjects = new Set(
    [
      ...baseCatalog.headContents,
      ...retainedContents,
      ...retainedScripts,
      ...referencedContents,
    ]
      .filter((entry) => entry.appId === "morphz.script-studio")
      .map((entry) => entry.appObjectId),
  );
  const resolveScript = limitConcurrentReads(8, signal);
  const openedScripts = await Promise.all(
    [...referencedScriptIds]
      .filter((id) => !knownScriptObjects.has(id))
      .map((productionId) =>
        resolveScript(async () => {
          try {
            return await client.resolveContent(
              { appId: "morphz.script-studio", appObjectId: productionId },
              signal,
            );
          } catch (error) {
            if (error instanceof RequestError && error.status === 404)
              return null;
            throw error;
          }
        }),
      ),
  );
  const contents = [
    ...new Map(
      [
        ...baseCatalog.headContents,
        ...retainedContents,
        ...retainedScripts,
        ...referencedContents,
        ...openedScripts.filter((entry): entry is PlatformContent => !!entry),
      ].map((entry) => [entry.id, entry]),
    ).values(),
  ];
  const knownTaskIds = new Set(headTasks.map((task) => task.id));
  const contentIds = new Set(contents.map((entry) => entry.id));
  const resolveTask = limitConcurrentReads(8, signal);
  const openedTasks = await Promise.all(
    [...openedArtifactIds]
      .filter((id) => !knownTaskIds.has(id) && !contentIds.has(id))
      .map((id) =>
        resolveTask(async () => {
          try {
            return await client.taskHead(id, signal);
          } catch (error) {
            if (
              error instanceof RequestError &&
              [403, 404].includes(error.status)
            )
              return null;
            throw error;
          }
        }),
      ),
  );
  const tasks = [
    ...headTasks,
    ...openedTasks.filter((task): task is PlatformTask => !!task),
  ];
  const catalog: PlatformWorkspaceCatalog = {
    ...baseCatalog,
    tasks,
    contents,
    scriptLibrary: contents
      .filter(
        (entry) =>
          entry.appId === "morphz.script-studio" &&
          entry.kind === "script" &&
          entry.availability === "available",
      )
      .map(scriptLibraryEntryFromContent),
    versionTitles: await readContentVersionTitles(
      client,
      contents,
      [
        ...histories.flatMap((history) => history.inputs),
        ...contentDeliveries.map((delivery) => ({
          artifactId: delivery.contentId,
          artifactRevision: Number(delivery.versionRef),
        })),
      ],
      baseCatalog.versionTitles,
      signal,
    ),
  };
  // App-owned scripts have an independent paged editor read model. Only the
  // selected object originals are projected here; no script body is hydrated.
  const readOriginal = limitConcurrentReads(8, signal);
  const [taskArtifacts, contentArtifacts] =
    await Promise.all([
      Promise.all(
        tasks.map((task) => {
          const prior = priorArtifacts.get(task.id);
          const needsHistory = openedArtifactIds.has(task.id);
          return prior?.content.kind === "task" &&
            prior.revision === task.revision &&
            prior.projectId === task.projectId &&
            prior.title === task.title &&
            prior.updatedAt === task.updatedAt &&
            (!needsHistory || prior.versions.length === task.revision)
            ? Promise.resolve(prior)
            : needsHistory
              ? readOriginal(() => readTaskArtifact(client, task, true, signal))
              : Promise.resolve(taskArtifactFromHead(task));
        }),
      ),
      Promise.all(
        contents.map((entry): Promise<Artifact | null> => {
          const prior = priorArtifacts.get(entry.id);
          const requestedRevision =
            entry.id === selection.preferences?.artifactId &&
            selection.preferences.artifactRevision &&
            selection.preferences.artifactRevision <
              Number(entry.observedVersionRef)
              ? selection.preferences.artifactRevision
              : undefined;
          const sameOriginal =
            prior?.content.kind !== "task" &&
            prior?.revision.toString() === entry.observedVersionRef &&
            prior?.providerRevision === entry.providerRevision;
          if (
            !["morphz.objects", "morphz.reader"].includes(entry.appId) ||
            entry.availability !== "available"
          )
            return Promise.resolve(null);
          // Catalog browsing never materializes an app-owned original. A
          // previously opened matching version may remain cached in this
          // renderer; a changed unopened version waits until explicit open.
          if (!openedArtifactIds.has(entry.id) && !sameOriginal)
            return Promise.resolve(null);
          if (
            sameOriginal &&
            prior &&
            (!requestedRevision ||
              prior.versions.some(
                (version) => version.revision === requestedRevision,
              ))
          )
            return Promise.resolve({
              ...prior,
              projectId: entry.projectId,
              catalogRevision: entry.revision,
              title: entry.title,
              updatedAt: entry.updatedAt,
            });
          return readOriginal(async () => {
            const current = sameOriginal
              ? prior
              : await readContentArtifact(client, entry, signal);
            if (!current) return null;
            const historical = requestedRevision
              ? await readContentArtifact(
                  client,
                  entry,
                  signal,
                  requestedRevision,
                )
              : null;
            const versions = new Map(
              [
                ...(prior &&
                prior.content.kind !== "task" &&
                prior.providerRevision === entry.providerRevision
                  ? prior.versions
                  : []),
                ...current.versions,
                ...(historical?.versions ?? []),
              ].map((version) => [version.revision, version]),
            );
            return {
              ...current,
              projectId: entry.projectId,
              catalogRevision: entry.revision,
              title: entry.title,
              updatedAt: entry.updatedAt,
              versions: [...versions.values()].sort(
                (a, b) => a.revision - b.revision,
              ),
            };
          });
        }),
      ),

    ]);
  const principals = new Set<string>([
    client.boot.principalId,
    morphzAgentAccess.principalId,
    ...projects.flatMap((project) => project.memberPrincipalIds),
  ]);
  const inputs = new Map<string, Workspace["inputs"][number]>();
  for (const history of histories)
    for (const input of history.inputs)
      inputs.set(input.id, {
        ...input,
        artifactId: input.artifactId ?? null,
        artifactRevision: input.artifactRevision ?? null,
        selection: input.selection ?? "",
        targetActantId: input.targetActantId,
        status: "recorded",
      });
  const workspace = stateSchema.parse({
    schemaVersion: 1,
    id: client.boot.centerId,
    name: "我的工作空间",
    revision,
    principals: [...principals].map((id) => ({
      id,
      name:
        id === client.boot.principalId
          ? client.boot.displayName
          : id === morphzAgentAccess.principalId
            ? "Morphz"
            : id,
    })),
    actants: [
      {
        id: client.boot.actantId,
        kind: "human",
        name: client.boot.displayName,
        principalId: client.boot.principalId,
      },
      {
        id: morphzAgentAccess.actantId,
        kind: "agent",
        name: "Morphz",
        principalId: morphzAgentAccess.principalId,
      },
    ],
    projects: projects.map((project) => ({
      id: project.id,
      title: project.title,
      members: project.memberPrincipalIds,
      createdAt: project.createdAt,
      kind: project.kind,
      ...(project.ownerPrincipalId
        ? { ownerPrincipalId: project.ownerPrincipalId }
        : {}),
      revision: project.revision,
      updatedAt: project.updatedAt,
      archivedAt: project.archivedAt,
      deletedAt: project.deletedAt,
    })),
    conversations: conversations.map((conversation) => ({
      id: conversation.id,
      projectId: conversation.projectId,
      title: conversation.title,
      revision: conversation.revision,
      archivedAt: conversation.archivedAt,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    })),
    scriptProductions: [],
    scriptPreparations: [],
    artifacts: [
      ...taskArtifacts,
      ...contentArtifacts.filter((value): value is Artifact => value !== null),
    ],
    bookmarks: [],
    readingMarks: [],
    readingStates: [],
    taskOrder: [...tasks]
      .sort((a, b) => a.orderRank - b.orderRank)
      .map((task) => task.id),
    taskOrderRevision: catalog.taskOrderRevision,
    applications: [
      ...[browserApplication, readerApplication, scriptStudioApplication].map(
        (manifest) => ({
          ...manifest,
          installedBy: client.boot.principalId,
        }),
      ),
      ...catalog.uiPackages.map(({ header }) => ({
        ...header,
        installedBy: client.boot.principalId,
      })),
    ],
    applicationInstances: instances,
    relations: [],
    annotations: [],
    inputs: [...inputs.values()].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    ),
    taskResponses: [],
  });
  return {
    workspace,
    runtime: platformRuntime(runtimeSnapshot, histories),
    historyScope,
    history: histories[0] ?? null,
    catalog,
    contentDeliveries,
    scriptOutputs,
  };
}

/** One limit shared by task, object, reader and script reads. Queued requests
 * are not sent after navigation cancellation or a failed original read. */
function limitConcurrentReads(maxActive: number, signal?: AbortSignal) {
  type Pending = {
    run: () => void;
    reject: (reason: unknown) => void;
  };
  const queue: Pending[] = [];
  let active = 0;
  let failed: unknown;
  const pump = () => {
    while (active < maxActive && queue.length && !signal?.aborted && !failed) {
      active++;
      queue.shift()!.run();
    }
    const reason = failed || signal?.reason;
    if (reason) for (const item of queue.splice(0)) item.reject(reason);
  };
  signal?.addEventListener("abort", pump, { once: true });
  return <T>(read: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push({
        run: () => {
          Promise.resolve()
            .then(read)
            .then(resolve, (error) => {
              failed = error;
              reject(error);
            })
            .finally(() => {
              active--;
              pump();
            });
        },
        reject,
      });
      pump();
    });
}

function platformRuntime(
  snapshot: ConversationRuntime,
  histories: PlatformHistory[],
): ConversationRuntime {
  const deliveries = new Map<
    string,
    ConversationRuntime["deliveries"][number]
  >();
  const messages = new Map<string, ConversationRuntime["messages"][number]>();
  for (const delivery of snapshot.deliveries)
    deliveries.set(delivery.inputId, delivery);
  for (const { runtime } of histories) {
    for (const delivery of runtime.deliveries)
      deliveries.set(delivery.inputId, delivery);
    for (const message of runtime.messages) messages.set(message.id, message);
  }
  const activity =
    snapshot.activity ??
    histories.find((history) => history.runtime.activity)?.runtime.activity;
  return conversationRuntimeSchema.parse({
    ...snapshot,
    attention:
      snapshot.attention ??
      histories.find((history) => history.runtime.attention)?.runtime.attention,
    ...(activity ? { activity } : {}),
    deliveries: [...deliveries.values()],
    messages: [...messages.values()].sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    ),
  });
}

export async function readTaskArtifact(
  client: PlatformClient,
  task: PlatformTask,
  fullHistory: boolean,
  signal?: AbortSignal,
): Promise<Artifact> {
  const versions =
    task.revision === 1
      ? [await client.taskVersion(task.id, 1, signal)]
      : fullHistory
        ? await client.allTaskVersions(task.id, signal)
        : await Promise.all([
            client.taskVersion(task.id, task.revision, signal),
            client.taskVersion(task.id, 1, signal),
          ]);
  const head = versions[0];
  if (!head || head.revision !== task.revision)
    throw new Error("事项目录与原件版本不一致，请重试。");
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    content: taskContentFor(head),
    revision: task.revision,
    createdBy: {
      principalId: versions.at(-1)!.authorPrincipalId,
      actantId: versions.at(-1)!.authorActantId,
    },
    createdAt: versions.at(-1)!.createdAt,
    updatedAt: task.updatedAt,
    versions: [...versions].reverse().map((version) => ({
      revision: version.revision,
      projectId: version.projectId ?? task.projectId,
      title: version.title,
      content: taskContentFor(version),
      author: {
        principalId: version.authorPrincipalId,
        actantId: version.authorActantId,
      },
      createdAt: version.createdAt,
    })),
    source: null,
  };
}

function taskContentFor(version: PlatformTaskVersion) {
  return contentSchema.parse({
    kind: "task" as const,
    description: version.description,
    assigneeId: version.assigneeId,
    model: version.modelId,
    ...(version.reasoningEffort
      ? { reasoningEffort: version.reasoningEffort }
      : {}),
    priority: "normal" as const,
    dueDate: version.dueDate,
    assignment: version.assignment,
    execution: version.execution,
    delivery: version.delivery,
    resultIds: version.resultIds,
    runRequested: version.runRequested,
    notBefore: version.notBefore,
    everySeconds: version.everySeconds,
    dependsOnIds: version.dependsOnIds,
    watchSourceIds: version.watchSourceIds,
  });
}

function taskArtifactFromHead(task: PlatformTask): Artifact {
  const head = task.headVersion;
  if (
    head.taskId !== task.id ||
    head.revision !== task.revision ||
    head.title !== task.title ||
    (head.projectId !== null && head.projectId !== task.projectId)
  )
    throw new Error("事项目录与当前版本不一致，请重试。");
  const content = taskContentFor(head);
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    content,
    revision: task.revision,
    createdBy: {
      principalId: task.createdByPrincipalId,
      actantId: task.createdByActantId,
    },
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    versions: [
      {
        revision: head.revision,
        projectId: head.projectId ?? task.projectId,
        title: head.title,
        content,
        author: {
          principalId: head.authorPrincipalId,
          actantId: head.authorActantId,
        },
        createdAt: head.createdAt,
      },
    ],
    source: null,
  };
}

export async function readContentArtifact(
  client: PlatformClient,
  entry: PlatformContent,
  signal?: AbortSignal,
  exactRevision?: number,
): Promise<Artifact | null> {
  if (entry.appId === "morphz.reader" && entry.kind === "publication") {
    const overview = z
      .object({
        bookId: z.string(),
        title: z.string(),
        author: z.string(),
        edition: z.string(),
        format: z.enum([
          "epub",
          "pdf",
          "docx",
          "doc",
          "rtf",
          "html",
          "markdown",
          "text",
        ]),
        revision: z.number().int().positive(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        ownerPrincipalId: z.string(),
        authorActantId: z.string(),
        createdAt: z.string().datetime(),
        sections: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            characters: z.number().int(),
          }),
        ),
      })
      .parse(
        await client.readReaderBook(
          entry.id,
          exactRevision ?? Number(entry.observedVersionRef),
          signal,
        ),
      );
    if (
      overview.bookId !== entry.appObjectId ||
      overview.revision !==
        (exactRevision ?? Number(entry.observedVersionRef)) ||
      (!exactRevision && overview.title !== entry.title)
    )
      throw new Error("书籍目录与阅读器原件不一致，请重试。");
    const content = contentSchema.parse({
      kind: "publication",
      assetId: overview.sha256,
      format: overview.format,
      author: overview.author,
      edition: overview.edition,
      language: "",
      sections: overview.sections,
    });
    const author = {
      principalId: overview.ownerPrincipalId,
      actantId: overview.authorActantId,
    };
    return {
      id: entry.id,
      projectId: entry.projectId,
      catalogRevision: entry.revision,
      providerRevision: entry.providerRevision,
      title: overview.title,
      content,
      revision: overview.revision,
      createdBy: author,
      createdAt: overview.createdAt,
      updatedAt: entry.updatedAt,
      versions: [
        {
          revision: overview.revision,
          projectId: entry.projectId,
          title: overview.title,
          content,
          author,
          createdAt: overview.createdAt,
        },
      ],
      source: null,
    };
  }
  if (entry.appId !== "morphz.objects") return null;
  const version = objectVersionSchema.parse(
    await client.readObject(entry.id, exactRevision, signal),
  );
  if (
    version.objectId !== entry.appObjectId ||
    version.contentId !== entry.id ||
    (exactRevision !== undefined && version.revision !== exactRevision)
  )
    throw new Error("内容目录与应用原件不一致，请重试。");
  // Version author/time describe a revision, not creation of the original.
  // The existing metadata cursor selects only v1, without fetching its body
  // or walking history. Both calls recheck the current directory authorization.
  let creation = { author: version.author, createdAt: version.createdAt };
  if (version.revision > 1) {
    const firstPage = z
      .object({
        objectId: z.string(),
        contentId: z.string(),
        versions: z.array(
          objectVersionSchema.pick({
            revision: true,
            author: true,
            createdAt: true,
          }),
        ),
      })
      .parse(
        await client.objectVersions(
          entry.id,
          { beforeRevision: 2, limit: 1 },
          signal,
        ),
      );
    const first = firstPage.versions.find((item) => item.revision === 1);
    if (
      firstPage.objectId !== entry.appObjectId ||
      firstPage.contentId !== entry.id ||
      !first
    )
      throw new Error("内容创建信息与应用原件不一致，请重试。");
    creation = first;
  }
  return {
    id: entry.id,
    projectId: entry.projectId,
    catalogRevision: entry.revision,
    providerRevision: entry.providerRevision,
    title: version.title,
    content: version.content,
    revision: version.revision,
    createdBy: creation.author,
    createdAt: creation.createdAt,
    updatedAt: entry.updatedAt,
    versions: [
      {
        revision: version.revision,
        projectId: version.projectId,
        title: version.title,
        content: version.content,
        author: version.author,
        createdAt: version.createdAt,
      },
    ],
    source: version.source,
  };
}
