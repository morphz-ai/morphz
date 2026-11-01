import type { AuthoritativeQuery } from './invalidation'

export type VisibleReadScope = {
  view: string
  cognitionView: string
  globalOverview: boolean
  hasSession: boolean
  hasContext: boolean
  eventHistoryBeforeSequence: string
  threadId?: string
  dialogueActivityOpen: boolean
  expandedDialogueThreadId: string
}

/** Invalidation is permission to refresh a visible projection, not every page.
 * Historical pages remain frozen until their reader explicitly requests them. */
export function visibleReads(scope: VisibleReadScope, invalidated: readonly AuthoritativeQuery[]) {
  const queries = new Set(invalidated)
  const workPage = scope.view === 'dialogue' || scope.view === 'scheduler'
  const sessionPage = workPage || scope.view === 'cognition' || scope.view === 'overview'
  const workChanged = queries.has('scheduler') || queries.has('session')
  return {
    catalog: queries.has('catalog'),
    session: scope.hasContext && scope.hasSession && sessionPage && !scope.globalOverview && (workChanged || queries.has('model-usage') || queries.has('delegations')),
    overview: scope.hasContext && scope.view === 'overview' && !scope.globalOverview
      && !scope.hasSession && (queries.has('overview') || workChanged),
    runtimeOverview: (scope.view === 'runtime' || scope.globalOverview)
      && (queries.has('overview') || workChanged),
    executionJobs: scope.view === 'runtime' && queries.has('execution-jobs'),
    contextProjection: scope.view === 'cognition' && scope.hasContext && scope.hasSession && queries.has('session'),
    eventHistory: scope.view === 'events' && scope.hasContext
      && !scope.eventHistoryBeforeSequence && queries.has('events'),
    mindTransactions: scope.view === 'cognition' && scope.cognitionView === 'mind'
      && scope.hasContext && queries.has('mind-transactions'),
    thread: scope.view === 'scheduler' && scope.hasContext && !!scope.threadId && queries.has('thread'),
    dialogueThread: scope.view === 'dialogue' && scope.dialogueActivityOpen
      && scope.hasContext && !!scope.expandedDialogueThreadId && queries.has('thread'),
  }
}
