export interface RuntimeEventLike {
  id: string
  timestamp: string
  topic: string
  payload: Record<string, unknown>
}

const terminalTopics = new Set([
  'chat/reply',
  'chat/outbound_message',
  'chat/no_reply',
  'chat/cancelled',
  'chat/runtime_error',
  'runtime/response_protocol_fused',
])

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function directlyReferencesRoot(event: RuntimeEventLike, rootTurnId: string): boolean {
  return event.payload.root_turn_id === rootTurnId
    || event.payload.trigger_event_id === rootTurnId
    || event.payload.source_turn_id === rootTurnId
}

/**
 * Returns the terminal Runtime event that settles one Dashboard-submitted turn.
 *
 * Delivery evaluations intentionally have their own causal root. Their terminal
 * reply therefore points at the delivered Threads through `covers` instead
 * of repeating the original user-message root. Resolve that durable join rather
 * than guessing from timestamps or accepting an unrelated concurrent reply.
 */
export function findTurnSettlement(
  events: RuntimeEventLike[],
  rootTurnId: string | null,
): RuntimeEventLike | undefined {
  if (!rootTurnId) return undefined

  const threadRoots = new Map<string, string>()
  for (const event of events) {
    if (event.topic !== 'runtime/thread_result') continue
    const threadId = event.payload.thread_id
    const rootId = event.payload.root_turn_id
    if (typeof threadId === 'string' && typeof rootId === 'string') {
      threadRoots.set(threadId, rootId)
    }
  }

  return events.find(event => {
    if (!terminalTopics.has(event.topic)) return false
    if (directlyReferencesRoot(event, rootTurnId)) return true

    const coveredThreadIds = [
      ...strings(event.payload.covers),
      ...strings(event.payload.defer_covers),
    ]
    return coveredThreadIds.some(threadId => threadRoots.get(threadId) === rootTurnId)
  })
}
