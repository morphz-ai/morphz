import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { conversationEventKind, conversationEventLane, newestConversationEventsForLane } from '../src/app/presentation.ts'
import { createLiveModelState, modelStreamReducer } from '../src/modelStream.ts'

test('steering replaces streamed text with a durable draft without losing it to scheduler reconciliation or reload', () => {
  const saved = {
    id: 'steering_draft_old', timestamp: '2026-09-12T09:24:17Z', topic: 'chat/progress',
    payload: { text: 'Already visible answer', disposition: 'steering_draft', activation_id: 'old', model_attempt_id: 'old' },
  }
  let live = createLiveModelState('session')
  live = modelStreamReducer(live, { type: 'stream_batch', sessionId: 'session', nowMs: 0,
    items: [{ attemptId: 'old', activationId: 'old', threadKind: 'execution', timestamp: saved.timestamp,
      stream: { kind: 'started' } }] })
  live = modelStreamReducer(live, { type: 'stream_batch', sessionId: 'session', nowMs: 1,
    items: [{ attemptId: 'old', activationId: 'old', threadKind: 'execution', timestamp: saved.timestamp,
      stream: { kind: 'text_delta', text: saved.payload.text } }] })
  assert.equal(live.attempts.old.text, saved.payload.text)
  // App merges the persisted progress Event before resolving the transient draft.
  live = modelStreamReducer(live, { type: 'resolve', sessionId: 'session', causalId: saved.payload.activation_id, nowMs: 2 })
  live = modelStreamReducer(live, { type: 'attempt_state', sessionId: 'session', nowMs: 3,
    item: { attemptId: 'old', activationId: 'old', threadKind: 'execution', state: 'completed', terminal: true,
      timestamp: saved.timestamp } })
  live = modelStreamReducer(live, { type: 'reconcile', sessionId: 'session', activeActivationIds: ['steer'], cutoffMs: 4 })
  assert.deepEqual(live.attempts, {})
  for (const lane of ['dialogue', 'merged'] as const) {
    assert.deepEqual(newestConversationEventsForLane([saved], lane, 50), [saved])
    assert.deepEqual(newestConversationEventsForLane(JSON.parse(JSON.stringify([saved])), lane, 50), [saved])
  }
  assert.equal(conversationEventKind(saved.topic, saved.payload), 'progress')
  assert.equal(conversationEventLane(saved.topic, saved.payload), 'dialogue')
  assert.equal(conversationEventLane('chat/progress', { text: 'Working' }), 'execution_output')
})

test('both progress renderers label a preserved steering draft as non-final', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.equal(app.match(/t\('conversation.steeringDraft'\)/g)?.length, 2)
  for (const locale of ['zh', 'en']) {
    const translations = JSON.parse(readFileSync(new URL(`../src/i18n/locales/${locale}.json`, import.meta.url), 'utf8'))
    assert.ok(translations.conversation.steeringDraft)
  }
})
