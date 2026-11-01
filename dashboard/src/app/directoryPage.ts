import type { DashboardApiClient } from '../api/client.ts'

export type DirectoryKind = 'agents' | 'contexts' | 'sessions'
export type DirectoryScope = { principalId?: string; contextId?: string; agentId?: string }
export type DirectoryPage<T> = { items: T[]; hasMore: boolean; nextCursor: string | null }
export const DIRECTORY_PAGE_SIZE = 50

/** Exactly one requested page or metadata point. Never drain continuation
 * cursors to populate a picker, and never attach seed/Mind payload requests. */
export async function readDirectoryPage<T extends { id: string }>(
  api: Pick<DashboardApiClient, 'get'>,
  kind: DirectoryKind,
  scope: DirectoryScope = {},
  selection: { cursor?: string; id?: string; ids?: readonly string[] } = {},
): Promise<DirectoryPage<T>> {
  if (kind !== 'sessions' && (scope.principalId || scope.contextId))
    throw new Error('Session scope cannot authorize a different directory')
  if (kind === 'agents' && scope.agentId) throw new Error('Invalid Agent directory scope')
  const points = selection.id ? [selection.id] : selection.ids
  if (points && (points.length > DIRECTORY_PAGE_SIZE || selection.cursor
    || points.some(id => !id || id.length > 512))) throw new Error('Invalid metadata point selection')
  if (points && !points.length) return {items: [], hasMore: false, nextCursor: null}
  const path = kind === 'sessions' && scope.principalId
    ? `/api/operator/principals/${encodeURIComponent(scope.principalId)}/sessions`
    : `/api/${kind}`
  const params = new URLSearchParams({ include_archived: points ? 'true' : 'false', limit: String(selection.id ? 1 : DIRECTORY_PAGE_SIZE) })
  if (scope.contextId) params.set('context_id', scope.contextId)
  if (scope.agentId) params.set('agent_id', scope.agentId)
  if (selection.cursor) params.set('cursor', selection.cursor)
  if (points) params.set('ids', JSON.stringify(points))
  const page = await api.get<Record<string, unknown>>(`${path}?${params}`)
  const rows = page[kind]
  if (!Array.isArray(rows) || rows.length > (selection.id ? 1 : DIRECTORY_PAGE_SIZE)
    || typeof page.has_more !== 'boolean'
    || !(page.next_cursor === null || typeof page.next_cursor === 'string'))
    throw new Error('Invalid bounded directory page')
  const ids = new Set<string>()
  for (const row of rows) {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id || ids.has(row.id)
      || (points && !points.includes(row.id))
      || (scope.contextId && row.context_id !== scope.contextId)
      || (scope.agentId && row.agent_id !== scope.agentId))
      throw new Error('Directory page identity or scope changed')
    ids.add(row.id)
  }
  if (page.has_more && (!rows.length || typeof page.next_cursor !== 'string' || !page.next_cursor || page.next_cursor.length > 2048
    || page.next_cursor === selection.cursor))
    throw new Error('Directory continuation did not advance')
  if (!page.has_more && page.next_cursor !== null)
    throw new Error('Complete directory page returned a continuation')
  return { items: rows as T[], hasMore: page.has_more, nextCursor: page.next_cursor }
}

/** Navigation reads metadata for the selected identity and one page of its
 * actual directory. It never loads jobs, leases, histories or every Context
 * in order to rediscover an already supplied selection. */
export async function readNavigationHead<
  A extends {id: string},
  C extends {id: string; agent_id: string; status: string},
  S extends {id: string; context_id: string; status: string},
>(api: Pick<DashboardApiClient, 'get'>, scope: {
  contextId: string; sessionId: string; defaultContextId: string; defaultAgentId: string; principalId?: string; contextsOpen?: boolean; sessionsOpen?: boolean
}) {
  const wantedContext = scope.contextId || scope.defaultContextId
  const selected = wantedContext
    ? await readDirectoryPage<C>(api, 'contexts', {}, {id: wantedContext})
    : {items: [], hasMore: false, nextCursor: null}
  const selectedContext = selected.items[0]
  const agentId = selectedContext?.agent_id || scope.defaultAgentId
  const [agents, contexts] = await Promise.all([
    agentId ? readDirectoryPage<A>(api, 'agents', {}, {id: agentId}) : readDirectoryPage<A>(api, 'agents'),
    scope.contextsOpen || !selectedContext
      ? readDirectoryPage<C>(api, 'contexts', agentId ? {agentId} : {})
      : Promise.resolve({items: [] as C[], hasMore: false, nextCursor: null}),
  ])
  const contextId = selectedContext?.id || contexts.items.find(row => row.status === 'active')?.id || ''
  const sessionScope = {contextId, principalId: scope.principalId}
  const exact = contextId && scope.sessionId
    ? await readDirectoryPage<S>(api, 'sessions', sessionScope, {id: scope.sessionId})
    : {items: [] as S[], hasMore: false, nextCursor: null}
  if (scope.sessionId && !exact.items.length) throw new Error('Selected Session metadata is unavailable')
  const sessions = contextId && (scope.sessionsOpen || !exact.items.length)
    ? await readDirectoryPage<S>(api, 'sessions', sessionScope)
    : {items: [] as S[], hasMore: false, nextCursor: null}
  return {
    agentId, contextId, agents: agents.items,
    contexts: mergeDirectoryPage(contexts.items, selectedContext ? [selectedContext] : []),
    sessions: mergeDirectoryPage(sessions.items, exact.items),
    readHeads: {contexts: scope.contextsOpen || !selectedContext, sessions: scope.sessionsOpen || !exact.items.length},
    cursors: {contexts: contexts.nextCursor, sessions: sessions.nextCursor},
  }
}

export function mergeDirectoryPage<T extends { id: string }>(before: readonly T[], page: readonly T[]): T[] {
  const rows = new Map(before.map(row => [row.id, row]))
  for (const row of page) rows.set(row.id, row)
  return [...rows.values()]
}
