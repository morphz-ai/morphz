import assert from 'node:assert/strict'
import test from 'node:test'

import {
  insertSessionMention,
  rankSessionReferenceCandidates,
  sessionMentionAt,
} from '../src/app/sessionReferences.ts'

const sessions = [
  { id: 'session-current', agent_id: 'agent-a', context_id: 'context-a', title: 'Current', status: 'active' as const, last_activity_at: '2026-08-17T01:00:00Z' },
  { id: 'session-dev', agent_id: 'agent-a', context_id: 'context-a', title: 'Development', status: 'active' as const, last_activity_at: '2026-08-17T02:00:00Z' },
  { id: 'session-roadshow', agent_id: 'agent-a', context_id: 'context-b', title: 'Roadshow', status: 'active' as const, last_activity_at: '2026-08-17T03:00:00Z' },
  { id: 'session-archived', agent_id: 'agent-a', context_id: 'context-a', title: 'Archived', status: 'archived' as const, last_activity_at: '2026-08-17T04:00:00Z' },
  { id: 'session-foreign', agent_id: 'agent-b', context_id: 'context-a', title: 'Foreign', status: 'active' as const, last_activity_at: '2026-08-17T05:00:00Z' },
]

test('Session mention detection follows the caret and inserts display text', () => {
  const text = 'Sync this with @dev before launch'
  const range = sessionMentionAt(text, 'Sync this with @dev'.length)
  assert.deepEqual(range, { start: 15, end: 19, query: 'dev' })
  assert.deepEqual(
    insertSessionMention(text, range!, 'Development'),
    { text: 'Sync this with @Development before launch', cursor: 28 },
  )
})

test('Session candidates are authorized by Agent and prefer the current Context', () => {
  assert.deepEqual(
    rankSessionReferenceCandidates(
      sessions,
      'agent-a',
      'context-a',
      'session-current',
      '',
    ).map(session => session.id),
    ['session-dev', 'session-roadshow'],
  )
  assert.deepEqual(
    rankSessionReferenceCandidates(
      sessions,
      'agent-a',
      'context-a',
      'session-current',
      'road',
    ).map(session => session.id),
    ['session-roadshow'],
  )
})
