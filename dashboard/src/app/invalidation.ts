export type AuthoritativeQuery = 'catalog' | 'session' | 'overview' | 'scheduler' | 'events' | 'thread' | 'mind-transactions' | 'execution-jobs'

const ephemeralTopics = new Set([
  'runtime/model_stream',
  'runtime/model_attempt_snapshot',
  'runtime/model_request_snapshot',
])

/**
 * WebSocket events are notifications, not a second Projection. Durable events
 * invalidate shared query models; exact streaming/inspect events remain local
 * browser state and never trigger a database read on every delta.
 */
export function invalidatedQueriesForTopic(topic: string): AuthoritativeQuery[] {
  if (ephemeralTopics.has(topic)) return []
  const queries: AuthoritativeQuery[] = ['session', 'overview', 'scheduler', 'events']
  if (
    topic === 'runtime/context_seeded'
    || topic === 'runtime/session_restored'
    || topic === 'runtime/delegation_result'
    || topic === 'runtime/delegation_failed'
    || topic === 'runtime/context_archived'
    || topic === 'runtime/session_archived'
  ) {
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
    queries.push('thread')
  }
  if (topic.startsWith('runtime/execution') || topic === 'chat/tool_output') {
    queries.push('execution-jobs')
  }
  return queries
}
