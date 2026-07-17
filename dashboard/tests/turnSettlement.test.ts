import assert from 'node:assert/strict'
import test from 'node:test'
import {
  findTurnSettlement,
  type RuntimeEventLike,
} from '../src/turnSettlement.ts'

function event(
  id: string,
  topic: string,
  payload: Record<string, unknown>,
): RuntimeEventLike {
  return { id, topic, payload, timestamp: '2026-07-17T08:43:57Z' }
}

test('a direct dialogue reply settles its user-message root', () => {
  const reply = event('reply-1', 'chat/reply', { root_turn_id: 'message-1' })
  assert.equal(findTurnSettlement([reply], 'message-1'), reply)
})

test('a delivery reply settles the original turn through its covered Work Thread', () => {
  const result = event('result-1', 'runtime/thread_result', {
    work_thread_id: 'thread-weather',
    root_turn_id: 'message-weather',
  })
  const reply = event('reply-delivery', 'chat/reply', {
    root_turn_id: 'delivery-ready-1',
    thread_kind: 'delivery',
    covers: ['thread-weather'],
  })

  assert.equal(findTurnSettlement([result, reply], 'message-weather'), reply)
})

test('a delivery no-reply settles roots explicitly covered for deferral', () => {
  const result = event('result-1', 'runtime/thread_result', {
    work_thread_id: 'thread-silent',
    root_turn_id: 'message-silent',
  })
  const noReply = event('no-reply-delivery', 'chat/no_reply', {
    root_turn_id: 'delivery-ready-2',
    defer_covers: ['thread-silent'],
  })

  assert.equal(findTurnSettlement([result, noReply], 'message-silent'), noReply)
})

test('an unrelated concurrent delivery cannot settle the pending turn', () => {
  const unrelatedResult = event('result-other', 'runtime/thread_result', {
    work_thread_id: 'thread-other',
    root_turn_id: 'message-other',
  })
  const unrelatedReply = event('reply-other', 'chat/reply', {
    root_turn_id: 'delivery-ready-other',
    covers: ['thread-other'],
  })

  assert.equal(
    findTurnSettlement([unrelatedResult, unrelatedReply], 'message-pending'),
    undefined,
  )
})

test('timestamps alone never settle a causally unrelated turn', () => {
  const unrelatedReply = event('reply-newer', 'chat/reply', {
    root_turn_id: 'message-other',
  })
  assert.equal(findTurnSettlement([unrelatedReply], 'message-pending'), undefined)
})
