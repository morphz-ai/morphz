export interface AuthoritativeMessageEvent {
  id: string
  payload: Record<string, unknown>
}

export interface OptimisticMessageIdentity {
  clientMessageId: string
  eventId?: string
}

export interface OptimisticMessageRequestSource extends OptimisticMessageIdentity {
  text: string
  attachments: Array<{
    name: string
    mediaType: string
    dataBase64: string
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
    attachments: message.attachments.map(attachment => ({
      name: attachment.name,
      media_type: attachment.mediaType,
      data_base64: attachment.dataBase64,
    })),
    references: message.references.map(reference => ({
      kind: 'session' as const,
      session_id: reference.sessionId,
    })),
    ...(dispatchMode ? { dispatch_mode: dispatchMode } : {}),
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
