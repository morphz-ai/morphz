// Fixed oracle: verbatim function bodies from 9ea571d03f4a57defc349d9d5bc46a59b416ad92.
// The adapter below only exposes old refs/ports; it never imports the new owner.
import type {
  HistoryCursor,
  PlatformHistory,
} from "../../apps/web/src/platform-client.js";
import { scriptOutputKey } from "../../packages/core/src/script-delivery.js";
export type HistoryScope = { projectId: string; conversationId: string };
export type CachedHistory = {
  scope: HistoryScope;
  version: string;
  value: PlatformHistory;
};
type Projection = CachedHistory & { catalogVersion: number };
type ReadPage = (
  scope: HistoryScope,
  before?: HistoryCursor,
  signal?: AbortSignal,
) => Promise<PlatformHistory>;
export type BaselinePorts = {
  connection: () =>
    { identityGeneration: string; readPage: ReadPage } | undefined;
  currentIdentity: () => string | undefined;
  pendingRefresh: () => Promise<boolean> | null;
  refreshProjection: () => Promise<boolean>;
  invalidateProjectionReuse: () => void;
};
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
export function createBaselineHistory(ports: BaselinePorts) {
  const historyScope: { current: HistoryScope | null } = { current: null };
  const historyCache: { current: Projection | null } = { current: null };
  const loadingEarlier: { current: Promise<void> | null } = { current: null };
  const refreshing = {
    get current() {
      return ports.pendingRefresh();
    },
  };
  const current = {
    get current() {
      const csrfToken = ports.currentIdentity();
      return csrfToken === undefined ? null : { csrfToken };
    },
  };
  const platform = {
    get current() {
      const connection = ports.connection();
      return connection
        ? {
            boot: { csrfToken: connection.identityGeneration },
            history(
              projectId: string,
              conversationId: string,
              before?: HistoryCursor,
              signal?: AbortSignal,
            ) {
              return connection.readPage(
                { projectId, conversationId },
                before,
                signal,
              );
            },
          }
        : null;
    },
  };
  const navigationCacheKey = {
    set current(_value: string) {
      ports.invalidateProjectionReuse();
    },
  };
  const refresh = () => ports.refreshProjection();
  async function selectHistoryScope(scope: HistoryScope) {
    if (
      historyScope.current?.projectId === scope.projectId &&
      historyScope.current.conversationId === scope.conversationId
    )
      return;
    historyScope.current = scope;
    if (refreshing.current) await refreshing.current;
    await refresh();
  }
  async function loadEarlierHistory() {
    if (loadingEarlier.current) return loadingEarlier.current;
    loadingEarlier.current = (async () => {
      if (refreshing.current) await refreshing.current;
      const cache = historyCache.current;
      const source = platform.current;
      let before = cache?.value.nextCursor;
      if (!cache || !source || !before) return;
      let history = cache.value;
      const signal = AbortSignal.timeout(15000);
      // A server window may contain only entries this reader cannot see.
      // Continue over a few empty windows so one click still reveals older
      // visible messages, while bounding both requests and total wait.
      for (let window = 0; window < 4 && before; window++) {
        const older = await source.history(
          cache.scope.projectId,
          cache.scope.conversationId,
          before,
          signal,
        );
        if (
          older.nextCursor &&
          (older.nextCursor.createdAt > before.createdAt ||
            (older.nextCursor.createdAt === before.createdAt &&
              older.nextCursor.id >= before.id))
        )
          throw new Error("历史分页位置没有前进，请重试。");
        if (
          historyCache.current !== cache ||
          current.current?.csrfToken !== source.boot.csrfToken ||
          historyScope.current?.projectId !== cache.scope.projectId ||
          historyScope.current?.conversationId !== cache.scope.conversationId
        )
          return;
        history = mergePlatformHistories(history, older, older.nextCursor);
        before = older.nextCursor;
        if (older.inputs.length || older.runtime.messages.length) break;
      }
      historyCache.current = {
        ...cache,
        value: history,
      };
      navigationCacheKey.current = "";
      await refresh();
    })().finally(() => {
      loadingEarlier.current = null;
    });
    return loadingEarlier.current;
  }
  async function loadHistoryUntil(messageId: string): Promise<boolean> {
    if (loadingEarlier.current) await loadingEarlier.current;
    const cache = historyCache.current;
    const source = platform.current;
    if (!cache || !source) return false;
    const contains = (
      history: import("../../apps/web/src/platform-client.js").PlatformHistory,
    ) =>
      history.inputs.some((input) => input.id === messageId) ||
      history.runtime.messages.some((message) => message.id === messageId);
    if (contains(cache.value)) return true;
    let found = false;
    loadingEarlier.current = (async () => {
      let history = cache.value;
      // A source jump is explicit. Read older authorized pages only on that
      // action, not during routine refresh or while the user scrolls.
      for (let page = 0; history.nextCursor && page < 200; page++) {
        const before = history.nextCursor;
        const older = await source.history(
          cache.scope.projectId,
          cache.scope.conversationId,
          before,
          AbortSignal.timeout(15000),
        );
        if (
          older.nextCursor &&
          (older.nextCursor.createdAt > before.createdAt ||
            (older.nextCursor.createdAt === before.createdAt &&
              older.nextCursor.id >= before.id))
        )
          throw new Error("历史分页位置没有前进，请重试。");
        if (
          historyCache.current !== cache ||
          current.current?.csrfToken !== source.boot.csrfToken ||
          historyScope.current?.projectId !== cache.scope.projectId ||
          historyScope.current?.conversationId !== cache.scope.conversationId
        )
          throw new Error("对话已切换或更新，请重新打开引用。");
        history = mergePlatformHistories(history, older, older.nextCursor);
        found = contains(history);
        if (found) break;
      }
      historyCache.current = { ...cache, value: history };
      navigationCacheKey.current = "";
      await refresh();
      if (!found && history.nextCursor)
        throw new Error(
          "引用仍在更早的记录中；已加载旧消息，请再点一次查看原文。",
        );
    })().finally(() => {
      loadingEarlier.current = null;
    });
    await loadingEarlier.current;
    return found;
  }

  return {
    selectScope: selectHistoryScope,
    loadEarlier: loadEarlierHistory,
    loadUntil: loadHistoryUntil,
    captureSelection: () => historyScope.current,
    isSelectionCurrent: (captured: HistoryScope | null) =>
      historyScope.current === captured,
    cachedForCatalog: (catalogVersion: number) =>
      historyCache.current?.catalogVersion === catalogVersion
        ? historyCache.current
        : undefined,
    commitProjection(
      resolvedScope: HistoryScope | null,
      history: PlatformHistory | null,
      historyVersion: string | undefined,
      catalogVersion: number,
    ) {
      historyScope.current = resolvedScope;
      historyCache.current =
        history && resolvedScope && historyVersion
          ? {
              version: historyVersion,
              catalogVersion,
              scope: resolvedScope,
              value: history,
            }
          : null;
    },
    get olderCursor() {
      return historyCache.current?.value.nextCursor ?? null;
    },
    clear() {
      historyScope.current = null;
      historyCache.current = null;
    },
  };
}
export async function baselineHistoryHead(
  readPage: ReadPage,
  historyScope: HistoryScope,
  historyVersion: string | undefined,
  cachedHistory: CachedHistory | undefined,
  signal: AbortSignal | undefined,
  composed: (value: PlatformHistory) => void,
) {
  const runtimeSnapshot = { configured: true };
  const client = {
    history: (
      projectId: string,
      conversationId: string,
      before?: HistoryCursor,
      signal?: AbortSignal,
    ) => readPage({ projectId, conversationId }, before, signal),
  };
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

  const value = histories[0]!;
  composed(value);
  return value;
}
