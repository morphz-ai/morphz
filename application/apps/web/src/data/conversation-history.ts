import type { HistoryCursor, PlatformHistory } from "../platform-client.js";
import { scriptOutputKey } from "../../../../packages/core/src/script-delivery.js";

export type HistoryScope = { projectId: string; conversationId: string };
export type CachedHistory = {
  scope: HistoryScope;
  version: string;
  value: PlatformHistory;
};
type HistoryProjection = CachedHistory & { catalogVersion: number };
export type HistoryPageReader = (
  scope: HistoryScope,
  before?: HistoryCursor,
  signal?: AbortSignal,
) => Promise<PlatformHistory>;
export type HistoryConnection = {
  identityGeneration: string;
  readPage: HistoryPageReader;
};
export type HistoryHead =
  | { kind: "cached"; value: PlatformHistory }
  | { kind: "read"; pending: Promise<PlatformHistory> };

/** The latest window owns connection/attention state; older windows only
 * contribute timeline rows. These are authorized projections, not storage. */
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

/** A changed version only retains an older authorized window when the fresh
 * window overlaps and no retained delivery can still change state. */
export function readHistoryHead(
  readPage: HistoryPageReader,
  scope: HistoryScope,
  historyVersion: string | undefined,
  cachedHistory: CachedHistory | undefined,
  signal?: AbortSignal,
): HistoryHead {
  const matchingHistory =
    cachedHistory?.scope.projectId === scope.projectId &&
    cachedHistory.scope.conversationId === scope.conversationId
      ? cachedHistory
      : undefined;
  if (matchingHistory && matchingHistory.version === historyVersion)
    return { kind: "cached", value: matchingHistory.value };
  const pending = (async () => {
    const latest = await readPage(scope, undefined, signal);
    return matchingHistory &&
      overlappingHistory(latest, matchingHistory.value) &&
      !matchingHistory.value.runtime.deliveries.some((delivery) =>
        ["queued", "sending", "running"].includes(delivery.state),
      )
      ? mergePlatformHistories(latest, matchingHistory.value)
      : latest;
  })();
  return { kind: "read", pending };
}

/** One selected conversation's disposable head and explicitly loaded pages.
 * Workspace refresh/authentication still own publication and invalidation.
 * Construction performs no read, subscription, timer or persistence. */
export function createConversationHistory(ports: {
  connection: () => HistoryConnection | undefined;
  currentIdentity: () => string | undefined;
  pendingRefresh: () => Promise<boolean> | null;
  refreshProjection: () => Promise<boolean>;
  invalidateProjectionReuse: () => void;
}) {
  let selectedScope: HistoryScope | null = null;
  let cache: HistoryProjection | null = null;
  let loadingEarlier: Promise<void> | null = null;
  const stillCurrent = (
    captured: HistoryProjection,
    connection: HistoryConnection,
  ) =>
    cache === captured &&
    ports.currentIdentity() === connection.identityGeneration &&
    selectedScope?.projectId === captured.scope.projectId &&
    selectedScope.conversationId === captured.scope.conversationId;
  const assertCursorProgress = (
    before: HistoryCursor,
    older: PlatformHistory,
  ) => {
    if (
      older.nextCursor &&
      (older.nextCursor.createdAt > before.createdAt ||
        (older.nextCursor.createdAt === before.createdAt &&
          older.nextCursor.id >= before.id))
    )
      throw new Error("历史分页位置没有前进，请重试。");
  };
  async function selectScope(scope: HistoryScope) {
    if (
      selectedScope?.projectId === scope.projectId &&
      selectedScope.conversationId === scope.conversationId
    )
      return;
    selectedScope = scope;
    const refreshing = ports.pendingRefresh();
    if (refreshing) await refreshing;
    await ports.refreshProjection();
  }
  async function loadEarlier() {
    if (loadingEarlier) return loadingEarlier;
    loadingEarlier = (async () => {
      const refreshing = ports.pendingRefresh();
      if (refreshing) await refreshing;
      const captured = cache;
      const connection = ports.connection();
      let before = captured?.value.nextCursor;
      if (!captured || !connection || !before) return;
      let history = captured.value;
      const signal = AbortSignal.timeout(15000);
      // One click may cross four invisible server windows, on one budget.
      for (let window = 0; window < 4 && before; window++) {
        const older = await connection.readPage(captured.scope, before, signal);
        assertCursorProgress(before, older);
        if (!stillCurrent(captured, connection)) return;
        history = mergePlatformHistories(history, older, older.nextCursor);
        before = older.nextCursor;
        if (older.inputs.length || older.runtime.messages.length) break;
      }
      cache = { ...captured, value: history };
      ports.invalidateProjectionReuse();
      await ports.refreshProjection();
    })().finally(() => {
      // Preserve the existing single paging slot, including clear while a
      // request is pending. Clearing projections does not cancel this promise.
      loadingEarlier = null;
    });
    return loadingEarlier;
  }
  async function loadUntil(messageId: string): Promise<boolean> {
    if (loadingEarlier) await loadingEarlier;
    const captured = cache;
    const connection = ports.connection();
    if (!captured || !connection) return false;
    const contains = (history: PlatformHistory) =>
      history.inputs.some((input) => input.id === messageId) ||
      history.runtime.messages.some((message) => message.id === messageId);
    if (contains(captured.value)) return true;
    let found = false;
    loadingEarlier = (async () => {
      let history = captured.value;
      // Explicit source jumps have a separate 15s budget for each page.
      for (let page = 0; history.nextCursor && page < 200; page++) {
        const before = history.nextCursor;
        const older = await connection.readPage(
          captured.scope,
          before,
          AbortSignal.timeout(15000),
        );
        assertCursorProgress(before, older);
        if (!stillCurrent(captured, connection))
          throw new Error("对话已切换或更新，请重新打开引用。");
        history = mergePlatformHistories(history, older, older.nextCursor);
        found = contains(history);
        if (found) break;
      }
      cache = { ...captured, value: history };
      ports.invalidateProjectionReuse();
      await ports.refreshProjection();
      if (!found && history.nextCursor)
        throw new Error(
          "引用仍在更早的记录中；已加载旧消息，请再点一次查看原文。",
        );
    })().finally(() => {
      loadingEarlier = null;
    });
    await loadingEarlier;
    return found;
  }
  return {
    selectScope,
    loadEarlier,
    loadUntil,
    captureSelection: () => selectedScope,
    isSelectionCurrent: (captured: HistoryScope | null) =>
      selectedScope === captured,
    cachedForCatalog: (catalogVersion: number) =>
      cache?.catalogVersion === catalogVersion ? cache : undefined,
    commitProjection(
      resolvedScope: HistoryScope | null,
      history: PlatformHistory | null,
      historyVersion: string | undefined,
      catalogVersion: number,
    ) {
      selectedScope = resolvedScope;
      cache =
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
      return cache?.value.nextCursor ?? null;
    },
    clear() {
      selectedScope = null;
      cache = null;
    },
  };
}
export type ConversationHistory = ReturnType<typeof createConversationHistory>;
