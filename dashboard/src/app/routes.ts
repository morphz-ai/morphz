export type DashboardView = 'overview' | 'dialogue' | 'scheduler' | 'cognition' | 'ledger' | 'runtime' | 'credentials' | 'providers'

export type CognitionView = 'mind' | 'attention' | 'encoding' | 'prompt' | 'recall'

export interface DashboardRoute {
  view: DashboardView
  providerSetup?: boolean
  contextId?: string
  sessionId?: string
  threadId?: string
  cognitionView?: CognitionView
}

export function observesExactModelRequests(
  view: DashboardView,
  cognitionView: CognitionView,
): boolean {
  return view === 'cognition' && cognitionView === 'encoding'
}

const cognitionViews = new Set<CognitionView>(['mind', 'attention', 'encoding', 'prompt', 'recall'])

function decoded(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function parseDashboardRoute(pathname: string): DashboardRoute {
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length === 0) return { view: 'overview' }
  if (segments[0] === 'runtime') return { view: 'runtime' }
  if (segments[0] === 'credentials') return { view: 'credentials' }
  if (segments[0] === 'providers') {
    return segments[1] === 'setup'
      ? { view: 'providers', providerSetup: true }
      : { view: 'providers' }
  }
  if (segments[0] !== 'contexts' || !segments[1]) return { view: 'overview' }

  const contextId = decoded(segments[1])
  switch (segments[2]) {
    case 'dialogue':
      return { view: 'dialogue', contextId, sessionId: decoded(segments[3]) }
    case 'scheduler':
      return { view: 'scheduler', contextId }
    case 'threads':
      return { view: 'scheduler', contextId, threadId: decoded(segments[3]) }
    case 'cognition': {
      const candidate = decoded(segments[3]) as CognitionView | undefined
      return {
        view: 'cognition',
        contextId,
        cognitionView: candidate && cognitionViews.has(candidate) ? candidate : 'mind',
      }
    }
    case 'ledger':
      return { view: 'ledger', contextId }
    case 'overview':
    default:
      return { view: 'overview', contextId }
  }
}

export function threadPath(contextId: string, threadId: string): string {
  return `/contexts/${encodeURIComponent(contextId)}/threads/${encodeURIComponent(threadId)}`
}

export function dashboardPath(
  view: DashboardView,
  contextId?: string,
  sessionId?: string,
  cognitionView: CognitionView = 'mind',
): string {
  if (view === 'runtime') return '/runtime'
  if (view === 'credentials') return '/credentials'
  if (view === 'providers') return '/providers'
  if (!contextId) return '/'
  const context = encodeURIComponent(contextId)
  switch (view) {
    case 'dialogue':
      return sessionId
        ? `/contexts/${context}/dialogue/${encodeURIComponent(sessionId)}`
        : `/contexts/${context}/overview`
    case 'scheduler':
      return `/contexts/${context}/scheduler`
    case 'cognition':
      return `/contexts/${context}/cognition/${cognitionView}`
    case 'ledger':
      return `/contexts/${context}/ledger`
    case 'overview':
    default:
      return `/contexts/${context}/overview`
  }
}
