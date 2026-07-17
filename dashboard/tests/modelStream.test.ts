import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createLiveModelState,
  findReasoningSummaryForPayload,
  modelStreamReducer,
  readReasoningSummaryPreference,
  selectDurableReasoningSummaries,
  visibleLiveModelAttempts,
  type ModelStreamBatchItem,
} from '../src/modelStream.ts'

function stream(
  attemptId: string,
  activationId: string,
  kind: ModelStreamBatchItem['stream'],
): ModelStreamBatchItem {
  return {
    attemptId,
    activationId,
    threadKind: activationId.startsWith('work') ? 'execution' : 'dialogue_turn',
    timestamp: '2026-07-17T00:00:00Z',
    stream: kind,
  }
}

test('reasoning summaries are hidden by default', () => {
  assert.equal(readReasoningSummaryPreference(), false)
  assert.equal(readReasoningSummaryPreference({ getItem: () => null }), false)
  assert.equal(readReasoningSummaryPreference({ getItem: () => 'true' }), true)
})

test('stream attempts are bucketed independently by attempt id', () => {
  let state = createLiveModelState('session-a')
  state = modelStreamReducer(state, {
    type: 'stream_batch',
    sessionId: 'session-a',
    nowMs: 1,
    items: [
      stream('attempt-a', 'dialogue-a', { kind: 'started' }),
      stream('attempt-b', 'work-b', { kind: 'started' }),
      stream('attempt-a', 'dialogue-a', { kind: 'text_delta', text: 'hello' }),
      stream('attempt-b', 'work-b', { kind: 'text_delta', text: 'internal' }),
    ],
  })

  assert.deepEqual(Object.keys(state.attempts).sort(), ['attempt-a', 'attempt-b'])
  assert.equal(state.attempts['attempt-a'].text, 'hello')
  assert.equal(state.attempts['attempt-b'].text, 'internal')
  assert.equal(state.attempts['attempt-b'].threadKind, 'execution')
})

test('reasoning summary deltas never enter public response text', () => {
  let state = createLiveModelState('session-a')
  state = modelStreamReducer(state, {
    type: 'stream_batch',
    sessionId: 'session-a',
    nowMs: 2,
    items: [
      stream('attempt-a', 'dialogue-a', { kind: 'started' }),
      stream('attempt-a', 'dialogue-a', { kind: 'reasoning_summary_delta', text: 'plan first' }),
      stream('attempt-a', 'dialogue-a', { kind: 'text_delta', text: 'final answer' }),
    ],
  })

  assert.equal(state.attempts['attempt-a'].reasoningSummary, 'plan first')
  assert.equal(state.attempts['attempt-a'].text, 'final answer')
})

test('resolve before persistence keeps a summary-only shell, then persistence clears it', () => {
  let state = createLiveModelState('session-a')
  state = modelStreamReducer(state, {
    type: 'stream_batch',
    sessionId: 'session-a',
    nowMs: 3,
    items: [
      stream('text-only', 'dialogue-text', { kind: 'started' }),
      stream('text-only', 'dialogue-text', { kind: 'text_delta', text: 'reply' }),
      stream('with-summary', 'dialogue-summary', { kind: 'started' }),
      stream('with-summary', 'dialogue-summary', { kind: 'reasoning_summary_delta', text: 'summary' }),
      stream('with-summary', 'dialogue-summary', { kind: 'text_delta', text: 'reply' }),
    ],
  })
  state = modelStreamReducer(state, {
    type: 'resolve',
    sessionId: 'session-a',
    causalId: 'dialogue-text',
    nowMs: 4,
  })
  state = modelStreamReducer(state, {
    type: 'resolve',
    sessionId: 'session-a',
    causalId: 'dialogue-summary',
    nowMs: 4,
  })

  assert.equal(state.attempts['text-only'], undefined)
  assert.equal(state.attempts['with-summary'].text, '')
  assert.equal(state.attempts['with-summary'].reasoningSummary, 'summary')
  assert.equal(state.attempts['with-summary'].responseResolved, true)

  state = modelStreamReducer(state, {
    type: 'persisted',
    sessionId: 'session-a',
    causalId: 'with-summary',
  })
  assert.equal(state.attempts['with-summary'], undefined)
})

test('persistence before resolve keeps the public draft until its reply is durable', () => {
  let state = createLiveModelState('session-a')
  state = modelStreamReducer(state, {
    type: 'stream_batch',
    sessionId: 'session-a',
    nowMs: 3,
    items: [
      stream('attempt-a', 'dialogue-a', { kind: 'started' }),
      stream('attempt-a', 'dialogue-a', { kind: 'reasoning_summary_delta', text: 'summary' }),
      stream('attempt-a', 'dialogue-a', { kind: 'text_delta', text: 'reply draft' }),
    ],
  })
  state = modelStreamReducer(state, {
    type: 'persisted',
    sessionId: 'session-a',
    causalId: 'attempt-a',
  })

  assert.equal(state.attempts['attempt-a'].text, 'reply draft')
  assert.equal(state.attempts['attempt-a'].reasoningSummaryPersisted, true)
  assert.equal(state.attempts['attempt-a'].responseResolved, false)

  state = modelStreamReducer(state, {
    type: 'resolve',
    sessionId: 'session-a',
    causalId: 'dialogue-a',
    nowMs: 4,
  })
  assert.equal(state.attempts['attempt-a'], undefined)
})

test('session reset is immediate and stale stream batches cannot repopulate it', () => {
  let state = createLiveModelState('session-a')
  state = modelStreamReducer(state, {
    type: 'stream_batch',
    sessionId: 'session-a',
    nowMs: 5,
    items: [stream('attempt-a', 'dialogue-a', { kind: 'started' })],
  })
  state = modelStreamReducer(state, { type: 'reset_session', sessionId: 'session-b' })
  state = modelStreamReducer(state, {
    type: 'stream_batch',
    sessionId: 'session-a',
    nowMs: 6,
    items: [stream('stale', 'dialogue-stale', { kind: 'started' })],
  })

  assert.equal(state.sessionId, 'session-b')
  assert.deepEqual(state.attempts, {})
  assert.deepEqual(visibleLiveModelAttempts(state, 'session-a'), {})
  assert.deepEqual(visibleLiveModelAttempts(state, 'session-b'), {})
})

test('durable summaries are rebuilt from runtime events without becoming reply text', () => {
  const summaries = selectDurableReasoningSummaries([
    {
      id: 'ignored',
      timestamp: '2026-07-17T00:00:00Z',
      topic: 'chat/reply',
      payload: { text: 'public reply', attempt_id: 'attempt-a' },
    },
    {
      id: 'summary',
      timestamp: '2026-07-17T00:00:01Z',
      topic: 'runtime/model_reasoning_summary',
      payload: {
        attempt_id: 'attempt-a',
        activation_id: 'work-a',
        thread_kind: 'execution',
        text: 'durable summary',
        complete: true,
      },
    },
  ])

  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].text, 'durable summary')
  assert.equal(summaries[0].threadKind, 'execution')
})

test('reasoning summary prefers an exact attempt over a newer activation fallback', () => {
  const summaries = selectDurableReasoningSummaries([
    {
      id: 'exact-older',
      timestamp: '2026-07-17T00:00:00Z',
      topic: 'runtime/model_reasoning_summary',
      payload: {
        attempt_id: 'attempt-a',
        activation_id: 'work-shared',
        thread_kind: 'execution',
        text: 'exact attempt',
      },
    },
    {
      id: 'fallback-newer',
      timestamp: '2026-07-17T00:00:01Z',
      topic: 'runtime/model_reasoning_summary',
      payload: {
        attempt_id: 'attempt-b',
        activation_id: 'work-shared',
        thread_kind: 'execution',
        text: 'newer retry',
      },
    },
  ])

  assert.equal(
    findReasoningSummaryForPayload(summaries, {
      attempt_id: 'attempt-a',
      activation_id: 'work-shared',
    })?.text,
    'exact attempt',
  )
  assert.equal(
    findReasoningSummaryForPayload(summaries, {
      attempt_id: 'missing-attempt',
      activation_id: 'work-shared',
    })?.text,
    'newer retry',
  )
})

test('reasoning summary follows the exact terminal model attempt across protocol retries', () => {
  const summaries = selectDurableReasoningSummaries([
    {
      id: 'invalid-base',
      timestamp: '2026-07-17T00:00:00Z',
      topic: 'runtime/model_reasoning_summary',
      payload: {
        attempt_id: 'activation-a',
        activation_id: 'activation-a',
        thread_kind: 'dialogue_turn',
        text: 'summary from invalid response',
      },
    },
    {
      id: 'successful-retry',
      timestamp: '2026-07-17T00:00:01Z',
      topic: 'runtime/model_reasoning_summary',
      payload: {
        attempt_id: 'activation-a_response_retry_1',
        activation_id: 'activation-a',
        thread_kind: 'dialogue_turn',
        text: 'summary from terminal response',
      },
    },
  ])

  assert.equal(
    findReasoningSummaryForPayload(summaries, {
      attempt_id: 'activation-a',
      model_attempt_id: 'activation-a_response_retry_1',
      activation_id: 'activation-a',
    })?.text,
    'summary from terminal response',
  )
  assert.equal(
    findReasoningSummaryForPayload(summaries, {
      attempt_id: 'activation-a',
      model_attempt_id: 'activation-a_response_retry_2',
      activation_id: 'activation-a',
    }),
    undefined,
  )
})
