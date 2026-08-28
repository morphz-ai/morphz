import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createLiveModelState,
  findReasoningSummaryChainForPayload,
  findReasoningSummaryForPayload,
  groupReasoningSummariesByActivation,
  liveReasoningSummaryText,
  modelStreamReducer,
  readReasoningSummaryPreference,
  selectDurableReasoningSummaries,
  selectReasoningContinuationSummaries,
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

test('live attempts retain direct Thread and Objective routes from the first stream event', () => {
  let state = createLiveModelState('session-a')
  state = modelStreamReducer(state, {
    type: 'stream_batch',
    sessionId: 'session-a',
    nowMs: 1,
    items: [{
      ...stream('attempt-a', 'activation-a', { kind: 'started' }),
      threadId: 'thread-a',
      rootTurnId: 'root-a',
      objectiveId: 'objective-a',
    }],
  })

  assert.equal(state.attempts['attempt-a'].threadId, 'thread-a')
  assert.equal(state.attempts['attempt-a'].rootTurnId, 'root-a')
  assert.equal(state.attempts['attempt-a'].objectiveId, 'objective-a')
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

test('reasoning completion is distinct from final response completion', () => {
  let state = createLiveModelState('session-a')
  state = modelStreamReducer(state, {
    type: 'stream_batch',
    sessionId: 'session-a',
    nowMs: 2,
    items: [
      stream('attempt-a', 'dialogue-a', { kind: 'started' }),
      stream('attempt-a', 'dialogue-a', { kind: 'reasoning_summary_delta', text: 'done thinking' }),
      stream('attempt-a', 'dialogue-a', { kind: 'reasoning_summary_completed' }),
    ],
  })

  assert.equal(state.attempts['attempt-a'].runtimeState, 'waiting_final_output')
  assert.equal(state.attempts['attempt-a'].status, 'settling')
  assert.equal(state.attempts['attempt-a'].text, '')
})

test('incomplete terminal continues settling without presenting a stream failure', () => {
  let state = createLiveModelState('session-a')
  state = modelStreamReducer(state, {
    type: 'stream_batch',
    sessionId: 'session-a',
    nowMs: 3,
    items: [
      stream('attempt-a', 'dialogue-a', { kind: 'started' }),
      stream('attempt-a', 'dialogue-a', { kind: 'reasoning_summary_delta', text: 'more work remains' }),
      stream('attempt-a', 'dialogue-a', { kind: 'incomplete', reason: 'max_output_tokens' }),
    ],
  })

  assert.equal(state.attempts['attempt-a'].runtimeState, 'settling')
  assert.equal(state.attempts['attempt-a'].status, 'settling')
  assert.equal(state.attempts['attempt-a'].error, undefined)
  assert.equal(state.attempts['attempt-a'].reasoningSummary, 'more work remains')
  assert.equal(state.attempts['attempt-a'].continuationPending, true)
})

test('incomplete physical attempts hand off as one live logical response', () => {
  let state = createLiveModelState('session-a')
  state = modelStreamReducer(state, {
    type: 'stream_batch',
    sessionId: 'session-a',
    nowMs: 3,
    items: [
      stream('attempt-a', 'dialogue-a', { kind: 'started' }),
      stream('attempt-a', 'dialogue-a', { kind: 'reasoning_summary_delta', text: 'first thought ' }),
      stream('attempt-a', 'dialogue-a', { kind: 'text_delta', text: 'first ' }),
      stream('attempt-a', 'dialogue-a', { kind: 'incomplete', reason: 'max_output_tokens' }),
      stream('attempt-b', 'dialogue-a', { kind: 'started' }),
      stream('attempt-b', 'dialogue-a', { kind: 'reasoning_summary_delta', text: 'second thought' }),
      stream('attempt-b', 'dialogue-a', { kind: 'text_delta', text: 'second' }),
    ],
  })

  const visible = Object.values(visibleLiveModelAttempts(state, 'session-a'))
  assert.equal(visible.length, 1)
  assert.equal(visible[0].attemptId, 'attempt-b')
  assert.equal(visible[0].text, 'first second')
  assert.equal(visible[0].reasoningSummary, 'first thought second thought')
  assert.deepEqual(visible[0].absorbedAttemptIds, ['attempt-a'])
  assert.equal(liveReasoningSummaryText([
    {
      eventId: 'summary-a',
      attemptId: 'attempt-a',
      activationId: 'dialogue-a',
      threadKind: 'dialogue_turn',
      text: 'first thought ',
      complete: false,
      timestamp: '2026-07-17T00:00:00Z',
    },
  ], visible[0]), 'first thought second thought')
})

test('completed physical attempts are not folded across ordinary model-loop steps', () => {
  let state = createLiveModelState('session-a')
  state = modelStreamReducer(state, {
    type: 'stream_batch',
    sessionId: 'session-a',
    nowMs: 3,
    items: [
      stream('attempt-a', 'dialogue-a', { kind: 'started' }),
      stream('attempt-a', 'dialogue-a', { kind: 'text_delta', text: 'before tool' }),
      stream('attempt-a', 'dialogue-a', { kind: 'completed' }),
      stream('attempt-b', 'dialogue-a', { kind: 'started' }),
    ],
  })

  assert.equal(Object.keys(visibleLiveModelAttempts(state, 'session-a')).length, 2)
})

test('snapshot preserves an explicit incomplete continuation across reconnect', () => {
  let state = createLiveModelState('session-a')
  state = modelStreamReducer(state, {
    type: 'snapshot',
    sessionId: 'session-a',
    nowMs: 3,
    items: [{
      attemptId: 'attempt-a',
      activationId: 'dialogue-a',
      threadKind: 'dialogue_turn',
      state: 'settling',
      terminal: false,
      continuationPending: true,
      timestamp: '2026-07-17T00:00:00Z',
    }],
  })
  state = modelStreamReducer(state, {
    type: 'stream_batch',
    sessionId: 'session-a',
    nowMs: 4,
    items: [stream('attempt-b', 'dialogue-a', { kind: 'started' })],
  })

  assert.deepEqual(Object.keys(state.attempts), ['attempt-b'])
  assert.deepEqual(state.attempts['attempt-b'].absorbedAttemptIds, ['attempt-a'])
})

test('snapshot does not infer continuation from an ordinary completed settling state', () => {
  let state = createLiveModelState('session-a')
  state = modelStreamReducer(state, {
    type: 'snapshot',
    sessionId: 'session-a',
    nowMs: 3,
    items: [{
      attemptId: 'attempt-a',
      activationId: 'dialogue-a',
      threadKind: 'dialogue_turn',
      state: 'settling',
      terminal: false,
      continuationPending: false,
      timestamp: '2026-07-17T00:00:00Z',
    }],
  })
  state = modelStreamReducer(state, {
    type: 'stream_batch',
    sessionId: 'session-a',
    nowMs: 4,
    items: [stream('attempt-b', 'dialogue-a', { kind: 'started' })],
  })

  assert.deepEqual(Object.keys(state.attempts).sort(), ['attempt-a', 'attempt-b'])
})

test('physical terminal state keeps the draft until a durable semantic outcome resolves it', () => {
  let state = createLiveModelState('session-a')
  state = modelStreamReducer(state, {
    type: 'snapshot',
    sessionId: 'session-a',
    nowMs: 8,
    items: [{
      attemptId: 'attempt-a',
      activationId: 'dialogue-a',
      threadKind: 'dialogue_turn',
      state: 'waiting_final_output',
      terminal: false,
      timestamp: '2026-07-17T00:00:00Z',
    }],
  })
  assert.equal(state.attempts['attempt-a'].runtimeState, 'waiting_final_output')

  state = modelStreamReducer(state, {
    type: 'stream_batch',
    sessionId: 'session-a',
    nowMs: 8,
    items: [stream('attempt-a', 'dialogue-a', { kind: 'text_delta', text: 'durable soon' })],
  })

  state = modelStreamReducer(state, {
    type: 'attempt_state',
    sessionId: 'session-a',
    nowMs: 9,
    item: {
      attemptId: 'attempt-a',
      activationId: 'dialogue-a',
      threadKind: 'dialogue_turn',
      state: 'completed',
      terminal: true,
      timestamp: '2026-07-17T00:00:01Z',
    },
  })
  assert.equal(state.attempts['attempt-a'].text, 'durable soon')
  assert.equal(state.attempts['attempt-a'].status, 'settling')

  state = modelStreamReducer(state, {
    type: 'resolve',
    sessionId: 'session-a',
    causalId: 'dialogue-a',
    nowMs: 10,
  })
  assert.equal(state.attempts['attempt-a'], undefined)
})

test('authoritative reconciliation removes a terminal physical attempt once its Activation is inactive', () => {
  let state = createLiveModelState('session-a')
  state = modelStreamReducer(state, {
    type: 'stream_batch',
    sessionId: 'session-a',
    nowMs: 100,
    items: [stream('attempt-a', 'work-a', { kind: 'started' })],
  })
  state = modelStreamReducer(state, {
    type: 'attempt_state',
    sessionId: 'session-a',
    nowMs: 110,
    item: {
      attemptId: 'attempt-a',
      activationId: 'work-a',
      threadKind: 'execution',
      state: 'completed',
      terminal: true,
      timestamp: '2026-07-17T00:00:01Z',
    },
  })

  // The attempt is deliberately recent. Terminal state, rather than the
  // age cutoff, must decide whether a stale "generating" indicator survives.
  state = modelStreamReducer(state, {
    type: 'reconcile',
    sessionId: 'session-a',
    activeActivationIds: [],
    cutoffMs: 0,
  })
  assert.equal(state.attempts['attempt-a'], undefined)
})

test('cancelled Activation immediately removes its draft and rejects late stream chunks', () => {
  let state = createLiveModelState('session-a')
  state = modelStreamReducer(state, {
    type: 'stream_batch',
    sessionId: 'session-a',
    nowMs: 100,
    items: [
      stream('attempt-old', 'dialogue-old', { kind: 'started' }),
      stream('attempt-new', 'dialogue-new', { kind: 'started' }),
    ],
  })
  state = modelStreamReducer(state, {
    type: 'attempt_state',
    sessionId: 'session-a',
    nowMs: 110,
    item: {
      attemptId: 'attempt-old',
      activationId: 'dialogue-old',
      threadKind: 'dialogue_turn',
      state: 'cancelled',
      terminal: true,
      timestamp: '2026-07-17T00:00:01Z',
      detail: 'superseded by a newer user message',
    },
  })

  assert.deepEqual(Object.keys(state.attempts), ['attempt-new'])

  // The Provider stream and its WebSocket batch are independent async paths.
  // A chunk already buffered before cancellation must not resurrect the old
  // "generating" card after the terminal state has removed it.
  state = modelStreamReducer(state, {
    type: 'stream_batch',
    sessionId: 'session-a',
    nowMs: 120,
    items: [
      stream('attempt-old', 'dialogue-old', { kind: 'started' }),
      stream('attempt-old', 'dialogue-old', { kind: 'text_delta', text: 'late' }),
    ],
  })
  assert.deepEqual(Object.keys(state.attempts), ['attempt-new'])
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

test('reasoning-only physical attempts render as one continuous reasoning stream', () => {
  const events = [
    {
      id: 'summary',
      timestamp: '2026-07-17T00:00:00Z',
      topic: 'runtime/model_reasoning_summary',
      payload: {
        attempt_id: 'attempt-a',
        activation_id: 'dialogue-a',
        thread_kind: 'dialogue_turn',
        text: 'first segment ',
        complete: false,
      },
    },
    {
      id: 'continuation',
      timestamp: '2026-07-17T00:00:01Z',
      topic: 'runtime/reasoning_continuation',
      payload: {
        attempt_id: 'attempt-a',
        activation_id: 'dialogue-a',
        response_state: 'reasoning_only',
      },
    },
    {
      id: 'summary-retry',
      timestamp: '2026-07-17T00:00:02Z',
      topic: 'runtime/model_reasoning_summary',
      payload: {
        attempt_id: 'attempt-b',
        activation_id: 'dialogue-a',
        thread_kind: 'dialogue_turn',
        text: 'second segment ',
        complete: false,
      },
    },
    {
      id: 'continuation-retry',
      timestamp: '2026-07-17T00:00:03Z',
      topic: 'runtime/reasoning_continuation',
      payload: {
        attempt_id: 'attempt-b',
        activation_id: 'dialogue-a',
        response_state: 'reasoning_only',
      },
    },
    {
      id: 'summary-terminal',
      timestamp: '2026-07-17T00:00:04Z',
      topic: 'runtime/model_reasoning_summary',
      payload: {
        attempt_id: 'attempt-c',
        activation_id: 'dialogue-a',
        thread_kind: 'dialogue_turn',
        text: 'final thought',
        complete: true,
      },
    },
  ]
  const summaries = selectDurableReasoningSummaries(events)
  const continuations = selectReasoningContinuationSummaries(events)

  let state = createLiveModelState('session-a')
  state = modelStreamReducer(state, {
    type: 'stream_batch',
    sessionId: 'session-a',
    nowMs: 5,
    items: [
      stream('attempt-c', 'dialogue-a', { kind: 'started' }),
      stream('attempt-c', 'dialogue-a', { kind: 'reasoning_summary_delta', text: 'live tail' }),
    ],
  })

  assert.equal(
    liveReasoningSummaryText(continuations, state.attempts['attempt-c']),
    'first segment second segment live tail',
  )
  assert.equal(
    findReasoningSummaryChainForPayload(summaries, continuations, {
      model_attempt_id: 'attempt-c',
      activation_id: 'dialogue-a',
    }).map(summary => summary.text).join(''),
    'first segment second segment final thought',
  )
  assert.equal(
    findReasoningSummaryChainForPayload(summaries, continuations, {
      attempt_id: 'attempt-a',
      activation_id: 'dialogue-a',
    }).map(summary => summary.text).join(''),
    'first segment second segment final thought',
  )
  assert.equal(groupReasoningSummariesByActivation(summaries)[0].text, 'first segment second segment final thought')
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
