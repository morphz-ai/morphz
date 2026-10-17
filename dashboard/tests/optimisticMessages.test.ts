import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildOptimisticMessageRequest,
  isOptimisticMessagePending,
  matchesAuthoritativeMessage,
  mergeConversationTimeline,
  reconcileOptimisticMessages,
} from '../src/app/optimisticMessages.ts'

test('a retry reuses the exact idempotent request identity and body', () => {
  const optimistic = {
    clientMessageId: 'client-1',
    text: 'hello',
    attachments: [{ stageId: 'stage-1', name: 'note.txt', mediaType: 'text/plain' }],
    references: [{ sessionId: 'session-2' }],
    dispatchMode: 'parallel' as const,
    afterSequence: 15,
  }

  const initial = buildOptimisticMessageRequest(optimistic)
  const retry = buildOptimisticMessageRequest(optimistic)

  assert.deepEqual(retry, initial)
  assert.equal(retry.client_message_id, 'client-1')
  assert.equal(retry.dispatch_mode, 'parallel')
  assert.deepEqual(retry.staged_attachment_ids, ['stage-1'])
  assert.equal('afterSequence' in retry, false, 'a display anchor is not a Runtime request field')
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

function event(id: string, sequence: number, timestamp = `2026-10-17T08:00:${String(sequence).padStart(2, '0')}Z`) {
  return { id, sequence, timestamp, payload: {} }
}

function timelineIds(timeline: ReturnType<typeof mergeConversationTimeline>) {
  return timeline.map(item => item.kind === 'event' ? item.event.id : item.message.clientMessageId)
}

test('a rejected directed send remains at its original position as later replies arrive', () => {
  const failed = {
    sessionId: 'session-1', clientMessageId: 'failed', createdAt: '2026-10-17T08:00:01.500Z',
    afterSequence: 1, status: 'failed', error: 'Thread is closed',
    text: 'a directed supplement', attachments: [], references: [],
    inputDestination: { kind: 'thread' as const, thread_id: 'closed-thread', generation: 1 },
  }
  const history = [event('before', 1)]
  for (const status of ['sending', 'failed', 'sending', 'accepted']) {
    const originalPosition = { ...failed, status }
    assert.deepEqual(timelineIds(mergeConversationTimeline(history, [originalPosition])), ['before', 'failed'])
    assert.deepEqual(timelineIds(mergeConversationTimeline([...history, event('later', 2), event('latest', 3)], [originalPosition])),
      ['before', 'failed', 'later', 'latest'])
    assert.deepEqual(buildOptimisticMessageRequest(originalPosition).input_destination, failed.inputDestination)
  }
  assert.equal(failed.status, 'failed', 'presentation does not retry, acknowledge or mutate a failed send')
})

test('the observed Runtime position wins over a different browser clock and late history pages', () => {
  const failed = { clientMessageId: 'failed', afterSequence: 20, createdAt: '2030-01-01T00:00:00Z' }
  const resident = [event('later', 30), event('latest', 40)]
  assert.deepEqual(timelineIds(mergeConversationTimeline(resident, [failed])), ['failed', 'later', 'latest'])
  assert.deepEqual(timelineIds(mergeConversationTimeline([event('older', 10), event('anchor', 20), ...resident], [failed])),
    ['older', 'anchor', 'failed', 'later', 'latest'])
})

test('failed sends share the bounded history window and can be revealed without being deleted', () => {
  const failed = { clientMessageId: 'failed', afterSequence: 1, createdAt: '2026-10-17T08:00:01.500Z' }
  const history = Array.from({ length: 250 }, (_, index) => event(`event-${index + 1}`, index + 1))
  const timeline = mergeConversationTimeline(history, [failed])
  assert.equal(timeline.length, 251)
  assert.equal(timeline.slice(-100).some(item => item.kind === 'optimistic'), false)
  assert.equal(timeline.slice(-251)[1].kind, 'optimistic')
  assert.equal(failed.clientMessageId, 'failed')
})

test('multiple pending sends keep send order across status changes and exact retries', () => {
  const messages = ['failed-first', 'sending-second', 'failed-third'].map((clientMessageId, index) => ({
    clientMessageId, afterSequence: index === 2 ? 2 : 1,
    createdAt: '2026-10-17T08:00:01.500Z', status: index === 1 ? 'sending' : 'failed',
  }))
  const events = [event('one', 1), event('two', 2), event('three', 3)]
  assert.deepEqual(timelineIds(mergeConversationTimeline(events, messages)),
    ['one', 'failed-first', 'sending-second', 'two', 'failed-third', 'three'])
  assert.deepEqual(timelineIds(mergeConversationTimeline(events, messages.map(message => ({ ...message, status: 'sending' })))),
    ['one', 'failed-first', 'sending-second', 'two', 'failed-third', 'three'])
})

test('a send with no observed Event uses instants, not timestamp string ordering', () => {
  const message = { clientMessageId: 'first-send', createdAt: '2026-10-17T16:00:00.100+08:00' }
  assert.deepEqual(timelineIds(mergeConversationTimeline([
    event('older', 1, '2026-10-17T08:00:00.000000Z'),
    event('later', 2, '2026-10-17T08:00:00.200000Z'),
  ], [message])), ['older', 'first-send', 'later'])
  assert.deepEqual(timelineIds(mergeConversationTimeline([], [message])), ['first-send'])
})

test('authoritative acknowledgement replaces the local row without duplicating or resurrecting it', () => {
  const failed = { sessionId: 'one', clientMessageId: 'failed', afterSequence: 1, createdAt: '2026-10-17T08:00:01.500Z' }
  const events = [event('before', 1), { ...event('accepted', 2), payload: { client_message_id: 'failed' } }, event('later', 3)]
  const pending = reconcileOptimisticMessages([failed], 'one', events)
  assert.deepEqual(timelineIds(mergeConversationTimeline(events, pending)), ['before', 'accepted', 'later'])
  assert.deepEqual(timelineIds(mergeConversationTimeline([event('new-page', 4)], pending)), ['new-page'])
})
