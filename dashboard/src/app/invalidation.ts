export type AuthoritativeQuery = 'catalog' | 'session' | 'overview' | 'scheduler' | 'events' | 'thread' | 'mind-transactions' | 'execution-jobs'

/**
 * App currently obtains Scheduler detail as part of the authoritative Session
 * snapshot. A Scheduler-only invalidation must therefore refresh that snapshot
 * too; otherwise a newly persisted human approval stays invisible until the
 * polling interval happens to run.
 */
export function invalidationsRequireSessionRefresh(queries: readonly AuthoritativeQuery[]): boolean {
  return queries.includes('session') || queries.includes('scheduler')
}

const ephemeralTopics = new Set([
  'runtime/model_stream',
  'runtime/model_attempt_snapshot',
  'runtime/model_request_snapshot',
])

const sessionProjectionTopics = new Set([
  'chat/steering',
  'chat/reply',
  'chat/no_reply',
  'chat/cancelled',
  'chat/runtime_error',
  'runtime/session_restored',
])

const catalogTopics = new Set([
  'runtime/context_seeded',
  'runtime/session_restored',
  'runtime/delegation_result',
  'runtime/delegation_failed',
  'runtime/context_archived',
  'runtime/session_archived',
])

/**
 * WebSocket events are notifications, not a second Projection. Durable events
 * invalidate shared query models; exact streaming/inspect events remain local
 * browser state and never trigger a database read on every delta.
 */
export function invalidatedQueriesForTopic(topic: string): AuthoritativeQuery[] {
  if (ephemeralTopics.has(topic)) return []
  const queries: AuthoritativeQuery[] = []
  if (sessionProjectionTopics.has(topic) || topic === 'chat/context_tx_committed') {
    queries.push('session', 'overview', 'scheduler')
  }
  if (catalogTopics.has(topic)) {
    queries.push('catalog')
  }
  if (topic === 'chat/context_tx_committed' || topic === 'runtime/context_seeded') {
    queries.push('mind-transactions')
  }
  if (
    topic.startsWith('runtime/thread')
    || topic.startsWith('runtime/execution')
    || topic.startsWith('runtime/approval')
    || topic.startsWith('runtime/schedule')
    || topic.startsWith('runtime/model_attempt')
    || topic === 'runtime/model_reasoning_summary'
    || topic === 'chat/tool_output'
  ) {
    if (!queries.includes('scheduler')) queries.push('scheduler')
    queries.push('thread')
  }
  if (topic.startsWith('runtime/execution') || topic === 'chat/tool_output') {
    queries.push('execution-jobs')
  }
  return queries
}
