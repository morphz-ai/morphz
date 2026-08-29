export interface PrincipalScopeLocation {
  sessionId: string
  contextId: string
}

export interface PrincipalScopeSession {
  id: string
  context_id: string
  status: 'active' | 'archived'
  last_activity_at: string
}

export function selectOperatorReturnSession<T extends PrincipalScopeSession>(
  sessions: T[],
  remembered: PrincipalScopeLocation | null,
  defaultContextId: string,
): T | undefined {
  if (remembered?.sessionId) {
    const previous = sessions.find(session => (
      session.id === remembered.sessionId
      && session.context_id === remembered.contextId
      && session.status === 'active'
    ))
    if (previous) return previous
  }

  const newestActive = (candidates: T[]) => candidates
    .filter(session => session.status === 'active')
    .sort((left, right) => right.last_activity_at.localeCompare(left.last_activity_at))[0]

  return newestActive(sessions.filter(session => session.context_id === defaultContextId))
    ?? newestActive(sessions)
}
