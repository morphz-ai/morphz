export interface SessionReferenceCandidate {
  id: string
  agent_id: string
  context_id: string
  title: string
  status: 'active' | 'archived'
  last_activity_at: string
}

export interface SessionMentionRange {
  start: number
  end: number
  query: string
}

export function sessionMentionAt(text: string, cursor: number): SessionMentionRange | null {
  const safeCursor = Math.max(0, Math.min(cursor, text.length))
  const prefix = text.slice(0, safeCursor)
  const match = prefix.match(/(?:^|\s)@([^\s@]*)$/u)
  if (!match) return null
  const query = match[1] ?? ''
  return {
    start: safeCursor - query.length - 1,
    end: safeCursor,
    query,
  }
}

export function rankSessionReferenceCandidates(
  sessions: SessionReferenceCandidate[],
  agentId: string,
  currentContextId: string,
  currentSessionId: string,
  query: string,
): SessionReferenceCandidate[] {
  const normalized = query.trim().toLocaleLowerCase()
  return sessions
    .filter(session => (
      session.agent_id === agentId
      && session.status === 'active'
      && session.id !== currentSessionId
      && (!normalized
        || session.title.toLocaleLowerCase().includes(normalized)
        || session.id.toLocaleLowerCase().includes(normalized))
    ))
    .sort((left, right) => {
      const leftContext = left.context_id === currentContextId ? 0 : 1
      const rightContext = right.context_id === currentContextId ? 0 : 1
      if (leftContext !== rightContext) return leftContext - rightContext
      const activity = right.last_activity_at.localeCompare(left.last_activity_at)
      if (activity !== 0) return activity
      const title = left.title.localeCompare(right.title)
      return title !== 0 ? title : left.id.localeCompare(right.id)
    })
}

export function insertSessionMention(
  text: string,
  range: SessionMentionRange,
  title: string,
): { text: string; cursor: number } {
  const mention = `@${title}`
  const suffix = text.slice(range.end)
  const spacer = suffix.startsWith(' ') || suffix.startsWith('\n') ? '' : ' '
  const existingSeparator = spacer === '' && suffix.length > 0 ? 1 : 0
  const next = `${text.slice(0, range.start)}${mention}${spacer}${suffix}`
  return {
    text: next,
    cursor: range.start + mention.length + spacer.length + existingSeparator,
  }
}
