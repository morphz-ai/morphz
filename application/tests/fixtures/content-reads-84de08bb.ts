// Fixed from Git 84de08bbe1f84d0842f3ae8c80ac23c3fca92b2d, Client's six original functions.
// This fixture does not import the new content owner or duplicate its port callbacks.
import type { Artifact, Workspace } from "../../packages/core/src/model.js";
import type {
  PlatformClient,
  PlatformContent,
} from "../../apps/web/src/platform-client.js";
import {
  readContentArtifact,
  readTaskArtifact,
  scriptLibraryEntryFromContent,
  type PlatformNavigationCache,
} from "../../apps/web/src/platform-workspace-view.js";
import { RequestError } from "../../apps/web/src/application-transport.js";

type Projection = { csrfToken: string; workspace: Workspace };
export type FixedContentReadBindings<P extends Projection> = {
  platform: { current: PlatformClient | null };
  current: { current: P | null };
  protectedReadGeneration: { current: number };
  catalogCache: { current: PlatformNavigationCache | null };
  setContentCatalog: (entries: PlatformContent[]) => void;
  setBoot: (projection: P) => void;
  refresh: () => Promise<boolean>;
};
export function createFixedContentReads<P extends Projection>(
  options: FixedContentReadBindings<P>,
) {
  const {
    platform,
    current,
    protectedReadGeneration,
    catalogCache,
    setContentCatalog,
    setBoot,
    refresh,
  } = options;
  async function listContentPage(
    options: Parameters<PlatformClient["content"]>[0],
    signal?: AbortSignal,
  ) {
    const source = platform.current;
    if (!source) throw new Error("内容目录暂不可用，请稍后重试。");
    return source.content(options, signal);
  }
  async function countContent(
    options: Parameters<PlatformClient["contentCounts"]>[0],
    signal?: AbortSignal,
  ) {
    const source = platform.current;
    if (!source) throw new Error("内容目录暂不可用，请稍后重试。");
    return source.contentCounts(options, signal);
  }
  async function readProjectUnderstanding(
    projectId: string,
    revision?: number,
    signal?: AbortSignal,
  ) {
    const source = platform.current;
    if (!source) throw new Error("当前理解暂不可用，请稍后重试。");
    return source.projectUnderstanding(projectId, revision, signal);
  }
  function rememberContent(
    entry: import("../../apps/web/src/platform-client.js").PlatformContent,
    generation: string,
  ) {
    if (current.current?.csrfToken !== generation) return;
    const cache = catalogCache.current;
    if (!cache) return;
    const existing = cache.value.contents.find((item) => item.id === entry.id);
    if (
      existing?.revision === entry.revision &&
      existing.projectId === entry.projectId &&
      existing.title === entry.title &&
      existing.observedVersionRef === entry.observedVersionRef
    )
      return;
    const headContents = cache.value.headContents.map((item) =>
      item.id === entry.id ? entry : item,
    );
    const headIds = new Set(headContents.map((item) => item.id));
    const references = cache.value.contents
      .filter((item) => !headIds.has(item.id) && item.id !== entry.id)
      .slice(-149);
    if (!headIds.has(entry.id)) references.push(entry);
    const contents = [...headContents, ...references];
    cache.value = {
      ...cache.value,
      headContents,
      contents,
      scriptLibrary: contents
        .filter(
          (item) =>
            item.appId === "morphz.script-studio" &&
            item.kind === "script" &&
            item.availability === "available",
        )
        .map(scriptLibraryEntryFromContent),
    };
    setContentCatalog(contents);
  }
  async function resolveArtifact(id: string, revision?: number) {
    const readGeneration = protectedReadGeneration.current;
    const readIdentity = current.current?.csrfToken;
    const checkRead = () => {
      if (
        protectedReadGeneration.current !== readGeneration ||
        current.current?.csrfToken !== readIdentity
      )
        throw new Error("身份或访问范围已变化，内容未读取。");
    };
    const task = catalogCache.current?.value.tasks.find(
      (item) => item.id === id,
    );
    const existing = current.current?.workspace.artifacts.find(
      (artifact) => artifact.id === id,
    );
    if (
      task &&
      existing?.content.kind === "task" &&
      existing.revision === task.revision &&
      existing.versions.length < task.revision
    ) {
      const identity = current.current;
      const source = platform.current;
      if (!identity || !source || source.boot.csrfToken !== identity.csrfToken)
        throw new Error("身份已变化，事项未读取。");
      const full = await readTaskArtifact(
        source,
        task,
        true,
        AbortSignal.timeout(15000),
      );
      checkRead();
      const latest = current.current;
      if (!latest || latest.csrfToken !== identity.csrfToken)
        throw new Error("身份已变化，事项未读取。");
      const currentTask = latest.workspace.artifacts.find(
        (artifact) => artifact.id === id,
      );
      if (
        currentTask?.revision !== full.revision ||
        currentTask.projectId !== full.projectId ||
        currentTask.updatedAt !== task.updatedAt
      ) {
        await refresh();
        checkRead();
        return current.current?.workspace.artifacts.find(
          (artifact) => artifact.id === id,
        );
      }
      const updated = {
        ...latest,
        workspace: {
          ...latest.workspace,
          revision: latest.workspace.revision + 1,
          artifacts: latest.workspace.artifacts.map((artifact) =>
            artifact.id === id ? full : artifact,
          ),
        },
      };
      current.current = updated;
      setBoot(updated);
      return full;
    }
    if (task && existing) {
      checkRead();
      return existing;
    }
    const identity = current.current;
    const source = platform.current;
    if (identity && source && source.boot.csrfToken === identity.csrfToken) {
      // Explicit opens must consult the current authorized directory, even
      // when a previously opened object is cached in the presentation model.
      let entry;
      try {
        entry = await source.getContent(id);
        checkRead();
      } catch (error) {
        checkRead();
        if (!(error instanceof RequestError) || error.status !== 404)
          throw error;
        // Tasks are Platform objects, not entries in the content catalog.
        // A message link can open one without loading the entire task list.
        const head = await source.taskHead(id);
        checkRead();
        const full = await readTaskArtifact(
          source,
          head,
          true,
          AbortSignal.timeout(15000),
        );
        checkRead();
        if (revision && revision > full.revision)
          throw new Error("指定版本尚未进入事项目录，请稍后重试。");
        const latest = current.current;
        if (!latest || latest.csrfToken !== identity.csrfToken)
          throw new Error("身份已变化，事项未读取。");
        const cache = catalogCache.current;
        if (cache)
          cache.value = {
            ...cache.value,
            tasks: [
              ...cache.value.tasks.filter((task) => task.id !== id),
              head,
            ],
          };
        const updated = {
          ...latest,
          workspace: {
            ...latest.workspace,
            revision: latest.workspace.revision + 1,
            artifacts: [
              ...latest.workspace.artifacts.filter(
                (artifact) => artifact.id !== id,
              ),
              full,
            ],
          },
        };
        current.current = updated;
        setBoot(updated);
        return full;
      }
      checkRead();
      rememberContent(entry, identity.csrfToken);
      if (entry && entry.availability !== "available")
        throw new Error("内容原件当前不可用，请稍后重试。");
      if (entry && ["morphz.objects", "morphz.reader"].includes(entry.appId)) {
        const sameOriginal =
          existing?.content.kind !== "task" &&
          existing?.revision.toString() === entry.observedVersionRef;
        const currentArtifact = sameOriginal
          ? {
              ...existing,
              projectId: entry.projectId,
              catalogRevision: entry.revision,
              title: entry.title,
              updatedAt: entry.updatedAt,
            }
          : await readContentArtifact(
              source,
              entry,
              AbortSignal.timeout(15000),
            );
        checkRead();
        if (!currentArtifact)
          throw new Error("内容原件暂时不可用，请稍后重试。");
        if (revision && revision > currentArtifact.revision)
          throw new Error("指定版本尚未进入内容目录，请稍后重试。");
        const hasRequestedVersion =
          !revision ||
          revision === currentArtifact.revision ||
          currentArtifact.versions.some(
            (version) => version.revision === revision,
          );
        if (
          sameOriginal &&
          existing?.catalogRevision === entry.revision &&
          existing.projectId === entry.projectId &&
          existing.title === entry.title &&
          existing.updatedAt === entry.updatedAt &&
          hasRequestedVersion
        )
          return currentArtifact;
        const historical =
          revision && !hasRequestedVersion
            ? await readContentArtifact(
                source,
                entry,
                AbortSignal.timeout(15000),
                revision,
              )
            : null;
        checkRead();
        if (revision && !hasRequestedVersion && !historical)
          throw new Error("指定版本暂时不可用，请稍后重试。");
        const latest = current.current;
        if (!latest || latest.csrfToken !== identity.csrfToken)
          throw new Error("身份已变化，内容未读取。");
        const latestEntry = catalogCache.current?.value.contents.find(
          (item) => item.id === id,
        );
        if (
          latestEntry &&
          (latestEntry.revision > entry.revision ||
            (latestEntry.revision === entry.revision &&
              (latestEntry.projectId !== entry.projectId ||
                latestEntry.observedVersionRef !== entry.observedVersionRef)))
        )
          throw new Error("内容目录已变化，请重试打开。");
        const latestArtifact = latest.workspace.artifacts.find(
          (artifact) => artifact.id === id,
        );
        if (
          latestArtifact &&
          existing &&
          (latestArtifact.revision !== existing.revision ||
            latestArtifact.projectId !== existing.projectId)
        )
          throw new Error("内容已变化，请重试打开。");
        const versions = new Map(
          [
            ...(latestArtifact?.versions ?? []),
            ...currentArtifact.versions,
            ...(historical?.versions ?? []),
          ].map((version) => [version.revision, version]),
        );
        const resolved: Artifact = {
          ...currentArtifact,
          versions: [...versions.values()].sort(
            (a, b) => a.revision - b.revision,
          ),
        };
        const updated = {
          ...latest,
          workspace: {
            ...latest.workspace,
            revision: latest.workspace.revision + 1,
            artifacts: [
              ...latest.workspace.artifacts.filter(
                (artifact) => artifact.id !== id,
              ),
              resolved,
            ],
          },
        };
        current.current = updated;
        setBoot(updated);
        return resolved;
      }
    }
    if (!current.current?.workspace.artifacts.some((a) => a.id === id)) {
      await refresh();
      checkRead();
      // An in-flight poll may predate the object returned by search.
      if (!current.current?.workspace.artifacts.some((a) => a.id === id)) {
        await refresh();
        checkRead();
      }
    }
    checkRead();
    return current.current?.workspace.artifacts.find((a) => a.id === id);
  }
  async function resolveCatalogContent(contentId: string) {
    const readGeneration = protectedReadGeneration.current;
    const identity = current.current;
    const source = platform.current;
    if (!identity || !source || source.boot.csrfToken !== identity.csrfToken)
      throw new Error("身份已变化，内容未读取。");
    try {
      const entry = await source.getContent(contentId);
      if (
        current.current?.csrfToken !== identity.csrfToken ||
        protectedReadGeneration.current !== readGeneration
      )
        throw new Error("身份已变化，内容未读取。");
      rememberContent(entry, identity.csrfToken);
      return entry;
    } catch (error) {
      if (error instanceof RequestError && error.status === 404) return null;
      throw error;
    }
  }
  return {
    listContentPage,
    countContent,
    readProjectUnderstanding,
    rememberContent,
    resolveArtifact,
    resolveCatalogContent,
  };
}
