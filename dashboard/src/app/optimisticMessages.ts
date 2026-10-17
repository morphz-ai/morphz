export interface AuthoritativeMessageEvent {
  id: string
  payload: Record<string, unknown>
}

export interface OptimisticMessageIdentity {
  clientMessageId: string
  eventId?: string
}

export interface ConversationTimelineEvent extends AuthoritativeMessageEvent {
  timestamp: string
  sequence?: number
}

export interface OptimisticMessagePosition extends OptimisticMessageIdentity {
  createdAt: string
  afterSequence?: number
}

export type ConversationTimelineEntry<E, M> =
  | { kind: 'event'; event: E }
  | { kind: 'optimistic'; message: M }

/** Place local sends in history, never in a separate, permanently trailing lane. */
export function mergeConversationTimeline<
  E extends ConversationTimelineEvent,
  M extends OptimisticMessagePosition,
>(events: readonly E[], messages: readonly M[]): ConversationTimelineEntry<E, M>[] {
  const slots = new Map<number, M[]>()
  const sequenced = events.every(event => event.sequence !== undefined)
  for (const message of messages) {
    let position: number
    if (message.afterSequence !== undefined && sequenced) {
      // Runtime sequence is authoritative even when the browser clock differs
      // or the anchor has left the resident page. Retrying keeps this position.
      let low = 0
      let high = events.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if (events[middle].sequence! <= message.afterSequence) low = middle + 1
        else high = middle
      }
      position = low
    } else {
      // A new/empty Session may not have a sequenced Event when sending starts.
      // Compare instants, not RFC3339 strings with different offsets/precision.
      const sentAt = Date.parse(message.createdAt)
      const next = events.findIndex(event => Date.parse(event.timestamp) >= sentAt)
      position = next < 0 ? events.length : next
    }
    const pending = slots.get(position) ?? []
    pending.push(message)
    slots.set(position, pending)
  }
  const timeline: ConversationTimelineEntry<E, M>[] = []
  for (let index = 0; index <= events.length; index += 1) {
    for (const message of slots.get(index) ?? []) timeline.push({ kind: 'optimistic', message })
    if (index < events.length) timeline.push({ kind: 'event', event: events[index] })
  }
  return timeline
}

export interface OptimisticMessageRequestSource extends OptimisticMessageIdentity {
  inputDestination?: import('./steering.ts').InputDestination
  text: string
  attachments: Array<{
    stageId: string
    name: string
    mediaType: string
  }>
  references: Array<{
    sessionId: string
  }>
  dispatchMode?: 'interrupt' | 'parallel' | 'follow_up'
}

export function buildOptimisticMessageRequest(message: OptimisticMessageRequestSource) {
  const dispatchMode = message.dispatchMode
  return {
    text: message.text,
    client_message_id: message.clientMessageId,
    staged_attachment_ids: message.attachments.map(attachment => attachment.stageId),
    references: message.references.map(reference => ({
      kind: 'session' as const,
      session_id: reference.sessionId,
    })),
    ...(dispatchMode ? { dispatch_mode: dispatchMode } : {}),
    ...(message.inputDestination ? { input_destination: message.inputDestination } : {}),
  }
}

export function matchesAuthoritativeMessage(
  optimistic: OptimisticMessageIdentity,
  event: AuthoritativeMessageEvent,
): boolean {
  return Boolean(optimistic.eventId && event.id === optimistic.eventId)
    || event.payload.client_message_id === optimistic.clientMessageId
}

export function isOptimisticMessagePending(
  optimistic: OptimisticMessageIdentity,
  events: readonly AuthoritativeMessageEvent[],
): boolean {
  return !events.some(event => matchesAuthoritativeMessage(optimistic, event))
}

/** Retire acknowledged placeholders permanently, independently of history pagination. */
export function reconcileOptimisticMessages<T extends OptimisticMessageIdentity & { sessionId: string }>(
  messages: T[],
  sessionId: string,
  events: readonly AuthoritativeMessageEvent[],
): T[] {
  if (!sessionId || events.length === 0 || messages.length === 0) return messages
  const pending = messages.filter(message => (
    message.sessionId !== sessionId || isOptimisticMessagePending(message, events)
  ))
  // Preserve identity at the fixed point so callers can reconcile state without
  // scheduling another render when no new acknowledgement has arrived.
  return pending.length === messages.length ? messages : pending
}
