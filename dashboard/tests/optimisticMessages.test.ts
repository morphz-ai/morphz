import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildOptimisticMessageRequest,
  isOptimisticMessagePending,
  matchesAuthoritativeMessage,
  reconcileOptimisticMessages,
} from '../src/app/optimisticMessages.ts'

test('a retry reuses the exact idempotent request identity and body', () => {
  const optimistic = {
    clientMessageId: 'client-1',
    text: 'hello',
    attachments: [{ stageId: 'stage-1', name: 'note.txt', mediaType: 'text/plain' }],
    references: [{ sessionId: 'session-2' }],
    dispatchMode: 'parallel' as const,
  }

  const initial = buildOptimisticMessageRequest(optimistic)
  const retry = buildOptimisticMessageRequest(optimistic)

  assert.deepEqual(retry, initial)
  assert.equal(retry.client_message_id, 'client-1')
  assert.equal(retry.dispatch_mode, 'parallel')
  assert.deepEqual(retry.staged_attachment_ids, ['stage-1'])
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

test('an acknowledged first message cannot reappear after history pagination or a Session round trip', () => {
  const original = [{ sessionId: 'session-1', clientMessageId: 'client-1', eventId: 'event-1', status: 'accepted' }]
  let pending = reconcileOptimisticMessages(original, 'session-1', [
    { id: 'event-1', payload: { client_message_id: 'client-1' } },
  ])
  assert.deepEqual(pending, [])
  assert.equal(original.length, 1, 'reconciliation must not mutate the previous state')

  // A later 250-Event page no longer contains the original user message.
  const laterPage = Array.from({ length: 250 }, (_, index) => ({ id: `later-${index}`, payload: {} }))
  pending = reconcileOptimisticMessages(pending, 'session-1', laterPage)
  pending = reconcileOptimisticMessages(pending, 'session-2', [])
  pending = reconcileOptimisticMessages(pending, 'session-1', laterPage)
  assert.deepEqual(pending, [], 'the old placeholder must not be appended after the final reply')
})

test('a live Event before the POST receipt permanently retires the sending placeholder', () => {
  const original = [{ sessionId: 'session-1', clientMessageId: 'client-1', status: 'sending' }]
  const pending = reconcileOptimisticMessages(original, 'session-1', [
    { id: 'event-1', payload: { client_message_id: 'client-1' } },
  ])
  // Delivery callbacks update existing entries only, including late error paths.
  for (const status of ['accepted', 'failed']) {
    const afterLateCallback = pending.map(message => ({ ...message, status, eventId: 'event-1' }))
    assert.deepEqual(reconcileOptimisticMessages(afterLateCallback, 'session-1', []), [])
  }
})

test('a POST receipt alone does not hide a message before its authoritative Event arrives', () => {
  const accepted = [{ sessionId: 'session-1', clientMessageId: 'client-1', eventId: 'event-1', status: 'accepted' }]
  assert.strictEqual(reconcileOptimisticMessages(accepted, 'session-1', []), accepted)
  assert.deepEqual(reconcileOptimisticMessages(accepted, 'session-1', [
    { id: 'event-1', payload: {} },
  ]), [])
})

test('a late receipt can reconcile an already loaded Event by its durable ID', () => {
  const sending = [{ sessionId: 'session-1', clientMessageId: 'client-1', status: 'sending' }]
  const events = [{ id: 'event-1', payload: {} }]
  assert.strictEqual(reconcileOptimisticMessages(sending, 'session-1', events), sending)
  const accepted = sending.map(message => ({ ...message, status: 'accepted', eventId: 'event-1' }))
  assert.deepEqual(reconcileOptimisticMessages(accepted, 'session-1', events), [])
})

test('reconciliation retains unrelated in-flight and failed messages and isolates Sessions', () => {
  const confirmed = { sessionId: 'session-1', clientMessageId: 'confirmed', status: 'accepted' }
  const sending = { sessionId: 'session-1', clientMessageId: 'sending', status: 'sending' }
  const failed = { sessionId: 'session-1', clientMessageId: 'failed', status: 'failed' }
  const otherSession = { sessionId: 'session-2', clientMessageId: 'confirmed', status: 'accepted' }
  const messages = [confirmed, sending, failed, otherSession]
  const events = [{ id: 'confirmed-event', payload: { client_message_id: 'confirmed' } }]
  const pending = reconcileOptimisticMessages(messages, 'session-1', events)
  assert.deepEqual(pending, [sending, failed, otherSession])
  assert.strictEqual(reconcileOptimisticMessages(pending, 'session-1', events), pending)
  assert.strictEqual(reconcileOptimisticMessages(pending, 'session-1', []), pending)
  assert.strictEqual(reconcileOptimisticMessages(pending, '', events), pending)
})

test('an authoritative Event retires a failed placeholder without retrying its already delivered request', () => {
  const failed = [{ sessionId: 'session-1', clientMessageId: 'client-1', status: 'failed' }]
  const events = [{ id: 'event-1', payload: { client_message_id: 'client-1' } }]
  assert.deepEqual(reconcileOptimisticMessages(failed, 'session-1', events), [])
})

test('matching message text is not proof of delivery', () => {
  const messages = [{ sessionId: 'session-1', clientMessageId: 'client-1', text: 'hello' }]
  const events = [{ id: 'unrelated-event', payload: { text: 'hello', client_message_id: 'other-client' } }]
  assert.strictEqual(reconcileOptimisticMessages(messages, 'session-1', events), messages)
})
