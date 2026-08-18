import type {
  RuntimeOverview,
  RuntimeOverviewContext,
  RuntimeOverviewSession,
  RuntimeOverviewSessionState,
} from './pages/RuntimeOverviewPage'

export type RuntimeMonitorFilter = 'live' | 'running' | 'waiting' | 'attention'

export interface RuntimeMonitorSession {
  context: RuntimeOverviewContext
  session: RuntimeOverviewSession
}

const RUNNING_STATES = new Set<RuntimeOverviewSessionState>(['running', 'queued'])
const WAITING_STATES = new Set<RuntimeOverviewSessionState>(['waiting', 'waiting_user', 'paused'])
const ATTENTION_STATES = new Set<RuntimeOverviewSessionState>(['needs_attention', 'waiting_user'])

export function isLiveRuntimeState(state: RuntimeOverviewSessionState): boolean {
  return state !== 'idle'
}

export function runtimeStateMatchesFilter(
  state: RuntimeOverviewSessionState,
  filter: RuntimeMonitorFilter,
): boolean {
  if (filter === 'running') return RUNNING_STATES.has(state)
  if (filter === 'waiting') return WAITING_STATES.has(state)
  if (filter === 'attention') return ATTENTION_STATES.has(state)
  return isLiveRuntimeState(state)
}

export function runtimeMonitorSessions(
  overview: RuntimeOverview | null,
  filter: RuntimeMonitorFilter,
  query: string,
): RuntimeMonitorSession[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const result: RuntimeMonitorSession[] = []
  for (const context of overview?.contexts ?? []) {
    for (const session of context.sessions) {
      if (!runtimeStateMatchesFilter(session.state, filter)) continue
      const searchable = [
        context.context.id,
        context.context.title,
        session.session.id,
        session.session.title,
        ...session.principal_ids,
        ...session.objectives.flatMap(objective => [objective.id, objective.stated_objective]),
        ...(session.execution_jobs ?? []).flatMap(job => [job.id, job.tool_name, job.target_id]),
        ...session.threads.flatMap(thread => [
          thread.id,
          thread.kind,
          thread.target_id,
          ...thread.execution_jobs.flatMap(job => [job.id, job.tool_name, job.target_id]),
        ]),
      ]
      if (normalizedQuery && !searchable.some(value => value?.toLocaleLowerCase().includes(normalizedQuery))) {
        continue
      }
      result.push({ context, session })
    }
  }
  return result.sort((left, right) => {
    const attention = Number(right.session.attention_required) - Number(left.session.attention_required)
    if (attention !== 0) return attention
    return right.session.session.last_activity_at.localeCompare(left.session.session.last_activity_at)
  })
}

export function runtimeMonitorCounts(overview: RuntimeOverview | null) {
  const sessions = runtimeMonitorSessions(overview, 'live', '')
  return {
    live: sessions.length,
    running: sessions.filter(item => RUNNING_STATES.has(item.session.state)).length,
    waiting: sessions.filter(item => WAITING_STATES.has(item.session.state)).length,
    attention: sessions.filter(item => ATTENTION_STATES.has(item.session.state)).length,
  }
}
