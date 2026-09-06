import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { conversationEventKind, conversationEventLane, newestConversationEventsForLane } from '../src/app/presentation.ts'
import { createLiveModelState, modelStreamReducer } from '../src/modelStream.ts'

const payload = {
  text: 'Provider authentication is invalid. Waiting for recovery.',
  runtime_failure_error: "Agent 'default-agent' has no Provider Account binding",
  runtime_failure_kind: 'authentication',
}

test('a saved failure stays in dialogue after a failed live attempt is reconciled or retried', () => {
  const saved = { id: 'failure-notice', timestamp: '2026-09-06T14:20:07Z', topic: 'chat/progress', payload }
  let live = createLiveModelState('session')
  for (const [state, terminal] of [['queued', false], ['failed', true]] as const) {
    live = modelStreamReducer(live, { type: 'attempt_state', sessionId: 'session', nowMs: 1,
      item: { attemptId: 'first', activationId: 'first', threadKind: 'dialogue_turn', state, terminal,
        timestamp: saved.timestamp, detail: payload.runtime_failure_error } })
  }
  live = modelStreamReducer(live, { type: 'reconcile', sessionId: 'session', activeActivationIds: [], cutoffMs: 100 })
  assert.deepEqual(live.attempts, {})
  live = modelStreamReducer(live, { type: 'attempt_state', sessionId: 'session', nowMs: 101,
    item: { attemptId: 'retry', activationId: 'retry', threadKind: 'dialogue_turn', state: 'queued', terminal: false,
      timestamp: saved.timestamp } })
  assert.ok(live.attempts.retry)
  for (const lane of ['dialogue', 'merged'] as const) {
    assert.deepEqual(newestConversationEventsForLane([saved], lane, 50), [saved])
    // The same persisted JSON reconstructs the notice after page reload.
    assert.deepEqual(newestConversationEventsForLane(JSON.parse(JSON.stringify([saved])), lane, 50), [saved])
  }
  assert.equal(conversationEventKind(saved.topic, payload), 'system')
  assert.equal(conversationEventLane(saved.topic, payload), 'dialogue')
  assert.equal(conversationEventKind('chat/progress', { text: 'Working' }), 'progress')
})

test('saved error details are readable by default and wired into both message renderers', () => {
  const component = readFileSync(new URL('../src/components/RuntimeFailureDetails.tsx', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(component, /runtime_failure_error/)
  assert.match(component, /<details[^>]+open>/)
  assert.match(component, /<pre>\{error\}<\/pre>/)
  assert.match(component, /payload\.text\.includes\(error\)/)
  assert.equal(app.match(/<RuntimeFailureDetails payload=\{event\.payload\}/g)?.length, 2)
  for (const locale of ['zh', 'en']) {
    const translations = JSON.parse(readFileSync(new URL(`../src/i18n/locales/${locale}.json`, import.meta.url), 'utf8'))
    assert.ok(translations.conversation.failureDetails)
  }
})
