import assert from 'node:assert/strict'
import test from 'node:test'

import { selectOperatorReturnSession } from '../src/principalScope.ts'

const sessions = [
  {
    id: 'session-default-old',
    context_id: 'context-default',
    status: 'active' as const,
    last_activity_at: '2026-08-20T00:00:00Z',
  },
  {
    id: 'session-wechat-new',
    context_id: 'context-wechat',
    status: 'active' as const,
    last_activity_at: '2026-08-30T00:00:00Z',
  },
  {
    id: 'session-default-new',
    context_id: 'context-default',
    status: 'active' as const,
    last_activity_at: '2026-08-25T00:00:00Z',
  },
]

test('leaving Principal observation returns to the exact prior operator Session', () => {
  assert.equal(selectOperatorReturnSession(
    sessions,
    { sessionId: 'session-default-old', contextId: 'context-default' },
    'context-default',
  )?.id, 'session-default-old')
})

test('a missing prior Session falls back inside the Runtime default Context', () => {
  assert.equal(selectOperatorReturnSession(
    sessions,
    { sessionId: 'session-missing', contextId: 'context-default' },
    'context-default',
  )?.id, 'session-default-new')
})

test('the fallback does not let a newer ingress Session replace the default Context', () => {
  assert.equal(selectOperatorReturnSession(sessions, null, 'context-default')?.id,
    'session-default-new')
})
