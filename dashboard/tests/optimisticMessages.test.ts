import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildOptimisticMessageRequest,
  isOptimisticMessagePending,
  matchesAuthoritativeMessage,
} from '../src/app/optimisticMessages.ts'

test('a retry reuses the exact idempotent request identity and body', () => {
  const optimistic = {
    clientMessageId: 'client-1',
    text: 'hello',
    attachments: [{ name: 'note.txt', mediaType: 'text/plain', dataBase64: 'aGVsbG8=' }],
    references: [{ sessionId: 'session-2' }],
    dispatchMode: 'parallel' as const,
  }

  const initial = buildOptimisticMessageRequest(optimistic)
  const retry = buildOptimisticMessageRequest(optimistic)

  assert.deepEqual(retry, initial)
  assert.equal(retry.client_message_id, 'client-1')
  assert.equal(retry.dispatch_mode, 'parallel')
})

test('reconciles an optimistic message by client message id before the receipt arrives', () => {
  const optimistic = { clientMessageId: 'client-1' }
  const event = { id: 'event-1', payload: { client_message_id: 'client-1' } }

  assert.equal(matchesAuthoritativeMessage(optimistic, event), true)
  assert.equal(isOptimisticMessagePending(optimistic, [event]), false)
})

test('reconciles an accepted optimistic message by authoritative event id', () => {
  const optimistic = { clientMessageId: 'client-1', eventId: 'event-1' }
  const event = { id: 'event-1', payload: {} }

  assert.equal(matchesAuthoritativeMessage(optimistic, event), true)
})

test('keeps an unrelated optimistic message visible', () => {
  const optimistic = { clientMessageId: 'client-1', eventId: 'event-1' }
  const events = [{ id: 'event-2', payload: { client_message_id: 'client-2' } }]

  assert.equal(isOptimisticMessagePending(optimistic, events), true)
})
